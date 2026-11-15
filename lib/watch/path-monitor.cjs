'use strict';

const { linearTrend, timeAlpha, wrapPi } = require('./stats.cjs');
const { isAnglePath, isSpeedPath, isTemperaturePath } = require('../signalk-units.cjs');

/**
 * Per-path learned behaviour and the checks that run on it.
 *
 * One plain, JSON-serialisable object per Signal K path, updated in O(1) per
 * sample, so the whole vessel's baseline can be saved to disk and survive a
 * restart without a fresh learning period. Nothing here knows about Signal K
 * deltas, notifications or time sources: the engine feeds it samples and asks
 * it questions.
 *
 * What it learns, per path:
 *   - how often the path updates (for dropout)
 *   - for a continuous number: a slow baseline mean and spread, a fast
 *     average, how often consecutive samples differ, the sensor's resolution
 *   - for a discrete value (string, boolean, small integer set): which values
 *     it takes and how often it switches between them
 *   - a minute-by-minute series for trend forecasts and incident evidence
 */

const FAST_HALF_LIFE_MS = 8 * 1000;
const SLOW_HALF_LIFE_MS = 30 * 60 * 1000;
// Samples needed before the path's kind (continuous vs discrete) is decided.
const KIND_DECISION_SAMPLES = 20;
const MAX_DISTINCT_FOR_DISCRETE = 4;
const MAX_TRACKED_STATES = 32;
// A winsorised update: one wild sample moves the baseline by at most this many
// standard deviations' worth, so a single glitch cannot desensitise the path
// for the next half hour.
const CLAMP_SIGMAS = 4;
const RECENT_BUCKET_MS = 10 * 1000;
const RECENT_BUCKETS = 60;
const MINUTE_BUCKET_MS = 60 * 1000;
const MINUTE_BUCKETS = 90;
// Transitions are counted per minute for the last hour, so the count is exact
// however fast a switch cycles; a capped list of timestamps undercounted a
// busy hour and let the excess leak into the "usual" rate.
const TRANSITION_BUCKET_MS = 60 * 1000;
// Step sizes remembered for confirming the sensor's resolution.
const RECENT_STEPS = 8;
const HOUR_MS = 60 * 60 * 1000;
// Long gaps in a row needed to take a slower update rate as the path's own,
// the same rule as the GNSS fix interval. Until then each gap counts as an
// outage and is left out of the usual interval.
const LONG_GAPS_FOR_RATE = 8;

/**
 * The smallest spread worth calling variation, in SI units, by what the path
 * measures. Without a floor a perfectly steady signal - a tank level that has
 * not moved all day - has zero spread, and the first 0.1% change would read as
 * infinitely many standard deviations.
 */
function unitNoiseFloor(path, units) {
  const unit = typeof units === 'string' ? units : undefined;
  if (unit === 'K' || (!unit && isTemperaturePath(path))) return 0.3;
  if (unit === 'rad' || (!unit && isAnglePath(path))) return 0.02;
  if (unit === 'm/s' || (!unit && isSpeedPath(path))) return 0.1;
  if (unit === 'V' || (!unit && /\.voltage$/.test(path))) return 0.05;
  if (unit === 'A' || (!unit && /\.current$/.test(path))) return 0.3;
  if (unit === 'W' || (!unit && /\.power$/.test(path))) return 5;
  if (unit === 'Pa' || (!unit && /[Pp]ressure$/.test(path))) return 30;
  if (unit === 'ratio' || (!unit && /\.(?:stateOfCharge|currentLevel|relativeHumidity|stateOfHealth)$/.test(path))) {
    return 0.005;
  }
  if (unit === 'Hz' || (!unit && /\.revolutions$/.test(path))) return 0.3;
  if (unit === 'm3/s') return 1e-7;
  if (unit === 'm') return 0.1;
  return undefined;
}

function createPathState(path, t) {
  return {
    path,
    kind: 'unknown',
    angle: isAnglePath(path),
    n: 0,
    firstAt: t,
    lastAt: t,
    acceptedAt: undefined,
    intervalMean: undefined,
    // A run of gaps too long to be the usual interval (see learnInterval()).
    longGaps: 0,
    longGapRun: undefined,
    source: undefined,
    units: undefined,
    displayName: undefined,
    zones: undefined,
    // continuous
    last: undefined,
    unwrapped: undefined,
    fast: undefined,
    mean: undefined,
    variance: 0,
    quantum: undefined,
    distinct: [],
    allInteger: true,
    monotonic: true,
    rose: false,
    rises: 0,
    recentSteps: [],
    changeRate: 0,
    runRate: 0,
    sameCount: 0,
    sameSince: t,
    relearnUntil: 0,
    relearnN: 0,
    excursionSince: undefined,
    accepted: 0,
    // discrete
    lastValue: undefined,
    seen: {},
    seenOverflow: false,
    transitionMinutes: [],
    transitionTotal: 0,
    newStateAt: undefined,
    newStateValue: undefined,
    // series
    minuteBucket: undefined,
    minutes: [],
    recentBucket: undefined,
    recent: []
  };
}

function pushBucket(state, bucketKey, seriesKey, bucketMs, limit, t, value) {
  const start = Math.floor(t / bucketMs) * bucketMs;
  const bucket = state[bucketKey];
  if (bucket && bucket.start === start) {
    bucket.sum += value;
    bucket.count += 1;
    return;
  }
  if (bucket && bucket.count > 0) {
    state[seriesKey].push([bucket.start + bucketMs / 2, bucket.sum / bucket.count]);
    if (state[seriesKey].length > limit) {
      state[seriesKey].splice(0, state[seriesKey].length - limit);
    }
  }
  state[bucketKey] = { start, sum: value, count: 1 };
}

/** The series including the still-open bucket, oldest first. */
function seriesWithOpen(state, seriesKey, bucketKey, bucketMs) {
  const bucket = state[bucketKey];
  const series = state[seriesKey].slice();
  if (bucket && bucket.count > 0) {
    series.push([bucket.start + bucketMs / 2, bucket.sum / bucket.count]);
  }
  return series;
}

function classifyValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? 'number' : 'invalid';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return 'discrete';
  }
  if (value === null) {
    return 'discrete';
  }
  return 'invalid';
}

/**
 * Continuous or discrete, for a numeric path. Re-decided on every sample, but
 * it can only move one way: a small integer set (a pump state of 0/1, an
 * engine at 0 rpm) is discrete until it takes a fifth value or a fraction,
 * and from then on it is continuous for good.
 */
function decideKind(state, t) {
  if (state.kind === 'continuous') {
    return;
  }
  if (state.distinct === null || !state.allInteger) {
    state.kind = 'continuous';
    endRedecision(state);
    return;
  }
  // Samples since the kind was last open to decision (a re-decision after
  // the counter listing changed starts this over; n does not).
  if ((state.kindN ?? state.n) >= KIND_DECISION_SAMPLES) {
    state.kind = 'discrete';
    if (state.redecideFrom !== undefined) {
      becameDiscreteAgain(state, t);
    }
  }
}

/**
 * A re-decided path has just turned out discrete. What it learned as a
 * continuous path says nothing about how it switches, so the switching
 * history starts here, and the values it took while being decided are its
 * known states. States first seen in the next while are learned without a
 * finding, from now - not from the restart, which for a path that changes
 * once in ten minutes is hours before its kind is known.
 */
function becameDiscreteAgain(state, t) {
  if (Number.isFinite(t)) {
    if (state.redecideFrom !== 'discrete') {
      state.transitionsSince = t;
      state.transitionTotal = 0;
      state.transitionMinutes = [];
    }
    if (Number.isFinite(state.redecideQuietMs)) {
      state.newStateQuietUntil = Math.max(state.newStateQuietUntil || 0, t + state.redecideQuietMs);
    }
  }
  for (const value of state.distinct || []) {
    const key = String(value);
    if (!(key in state.seen) && Object.keys(state.seen).length < MAX_TRACKED_STATES) {
      state.seen[key] = 1;
    }
  }
  endRedecision(state);
}

function endRedecision(state) {
  state.redecideFrom = undefined;
  state.redecideQuietMs = undefined;
}

function recordDiscrete(state, key, t, ready) {
  if (state.lastValue !== undefined && state.lastValue !== key) {
    const minute = Math.floor(t / TRANSITION_BUCKET_MS) * TRANSITION_BUCKET_MS;
    const buckets = state.transitionMinutes;
    const latest = buckets[buckets.length - 1];
    if (latest && latest[0] === minute) {
      latest[1] += 1;
    } else {
      buckets.push([minute, 1]);
    }
    while (buckets.length > 0 && buckets[0][0] <= t - HOUR_MS - TRANSITION_BUCKET_MS) {
      buckets.shift();
    }
    state.transitionTotal += 1;
    // After a re-decision of the kind, states seen meanwhile are learned
    // quietly for a while: only the new-state check waits, not the baseline.
    const quiet = Number.isFinite(state.newStateQuietUntil) && t < state.newStateQuietUntil;
    if (ready && !quiet && !state.seenOverflow && !(key in state.seen)) {
      state.newStateAt = t;
      state.newStateValue = key;
    }
  }
  if (key in state.seen) {
    state.seen[key] += 1;
  } else if (Object.keys(state.seen).length < MAX_TRACKED_STATES) {
    state.seen[key] = 1;
  } else {
    state.seenOverflow = true;
  }
  state.lastValue = key;
}

/**
 * Learn how often the path updates from one gap between accepted samples.
 *
 * An outage is not the path's rate. A gap long enough to be a dropout is left
 * not counted in the usual interval when it follows regular samples, or one
 * hour of silence would stretch a 30 s sensor's "usual" past the regularity
 * limit and its next outage would go unreported. Long gaps one after another
 * count, up to the dropout limit (below). A path that really slowed down (or a slower source taking over)
 * shows as a run of long gaps of about one size: eight in a row, each within
 * half of the run's mean so far, are its new rate (their mean). Scattered or
 * growing gaps stay outages. The same rule as the GNSS fix interval.
 */
function learnInterval(state, dt, options) {
  const limit = Math.max(options.dropoutMinMs ?? 30000, (options.dropoutFactor ?? 10) * (state.intervalMean ?? 0));
  const outage = state.intervalMean !== undefined && dt > limit;
  if (!outage) {
    state.longGaps = 0;
    state.longGapRun = undefined;
    state.intervalMean = state.intervalMean === undefined ? dt : state.intervalMean + 0.1 * (dt - state.intervalMean);
    // A settled regular stretch: from now on outages are the sensor
    // failing, never a rhythm (below).
    state.regularRun = (state.regularRun || 0) + 1;
    if (state.regularRun > (options.minSamples ?? 30)) state.settled = true;
    // A burst between outages of a repeating cycle (below).
    if (state.cycleOutages > 0) {
      state.sinceOutage += 1;
      state.cycleTime += dt;
      state.cycleGaps += 1;
      if (state.sinceOutage > (options.minSamples ?? 30)) state.cycleOutages = 0;
    }
    return;
  }
  state.regularRun = 0;
  if (!state.settled) learnCycle(state, dt, options);
  // An outage after regular samples is not learned, so a flaky sensor (a
  // few samples between outages) keeps its interval and every outage is
  // reported. Outages right after one another - a sender that reports on
  // change and is quiet at night, or one that really slowed down - are that
  // sender's rhythm: each counts up to the dropout limit, so the night is
  // not reported gap by gap.
  if (state.longGaps > 0) {
    state.intervalMean += 0.1 * (limit - state.intervalMean);
  }
  const run = state.longGapRun;
  if (run === undefined || !(state.longGaps > 0) || Math.abs(dt - run) > 0.5 * run) {
    state.longGapRun = dt;
    state.longGaps = 1;
  } else {
    state.longGaps += 1;
    state.longGapRun = run + (dt - run) / state.longGaps;
  }
  if (state.longGaps >= LONG_GAPS_FOR_RATE) {
    state.intervalMean = state.longGapRun;
    state.longGaps = 0;
    state.longGapRun = undefined;
  }
}

/**
 * A sender whose outages come between short bursts, again and again - a
 * pair of readings every five minutes, a sensor that wakes to report - has
 * that cycle for its rhythm. Eight outages of about one size (each within
 * half of their mean), each after fewer regular samples than a path needs
 * to settle, make the cycle's mean gap its interval, as eight long gaps in a
 * row do. Only on a path that has never had a settled regular stretch (more
 * regular gaps in a row than a path needs to settle): once it has, outages
 * are the sensor failing, and each is reported, however regular they are.
 */
function learnCycle(state, dt, options) {
  const run = state.cycleRun;
  const continues =
    state.cycleOutages > 0 && state.sinceOutage <= (options.minSamples ?? 30) && Number.isFinite(run) && Math.abs(dt - run) <= 0.5 * run;
  if (continues) {
    state.cycleOutages += 1;
    state.cycleRun = run + (dt - run) / state.cycleOutages;
  } else {
    state.cycleOutages = 1;
    state.cycleRun = dt;
    state.cycleTime = 0;
    state.cycleGaps = 0;
  }
  state.cycleTime += dt;
  state.cycleGaps += 1;
  state.sinceOutage = 0;
  if (state.cycleOutages >= LONG_GAPS_FOR_RATE) {
    state.intervalMean = state.cycleTime / state.cycleGaps;
    state.cycleOutages = 0;
  }
}

/**
 * Feed one sample. Returns false when the sample was ignored (throttled,
 * unusable), true when it was taken.
 */
function observe(state, value, t, options) {
  const type = classifyValue(value);
  if (type === 'invalid') {
    return false;
  }

  const key = type === 'number' ? value : String(value);
  const changed = state.n === 0 ? true : type === 'number' ? value !== state.last : key !== state.lastValue;

  // A discrete change is always taken - a bilge pump that ran for half a
  // second is exactly the event worth seeing - but repeats are throttled.
  if (
    state.acceptedAt !== undefined &&
    t - state.acceptedAt < options.minIntervalMs &&
    !(changed && (type === 'discrete' || state.kind === 'discrete'))
  ) {
    state.lastAt = Math.max(state.lastAt, t);
    return false;
  }

  const dt = state.acceptedAt === undefined ? 0 : t - state.acceptedAt;
  if (dt < 0) {
    // Out of order: keep the newest, ignore the straggler.
    return false;
  }
  if (dt > 0) {
    learnInterval(state, dt, options);
  }
  state.acceptedAt = t;
  state.lastAt = t;
  state.n += 1;
  state.kindN = (state.kindN ?? state.n - 1) + 1;

  const ready = isReady(state, t, options);

  if (type === 'discrete') {
    state.kind = 'discrete';
    state.distinct = null;
    // A word or a flag settles any pending re-decision: its kind is known.
    endRedecision(state);
    recordDiscrete(state, key, t, ready);
    return true;
  }

  // Numbers: track enough to decide continuous vs discrete. A listed counter
  // is never discrete, however few values it has had: twelve engine starts
  // going to thirteen is a count, not a new state. Under a pattern, a path
  // named as a state code (chargerState, inverterMode) still classifies
  // itself, so it keeps its new-state check beside the counters.
  if (counterListing(state) !== 'self') {
    state.distinct = null;
  }
  if (!Number.isInteger(value)) {
    state.allInteger = false;
  }
  if (state.distinct !== null) {
    if (!state.distinct.includes(value)) {
      state.distinct.push(value);
      if (state.distinct.length > MAX_DISTINCT_FOR_DISCRETE) {
        state.distinct = null;
      }
    }
  }
  decideKind(state, t);

  if (state.kind === 'discrete') {
    recordDiscrete(state, String(value), t, ready);
  }

  // Unwrap angles so a heading crossing north is a two-degree change, not a
  // 358-degree one.
  let x = value;
  if (state.angle && state.unwrapped !== undefined && state.last !== undefined) {
    x = state.unwrapped + wrapPi(value - state.last);
  }

  if (state.last !== undefined) {
    const signed = x - (state.unwrapped === undefined ? state.last : state.unwrapped);
    const step = Math.abs(signed);
    // The sensor's resolution is a step size seen more than once. A single
    // step is not evidence of resolution: a tank that sat at 80 % and then
    // dropped to 20 % would otherwise have "learned" a 60-point resolution,
    // and the noise floor that follows from it would hide the drop itself.
    if (step > 0) {
      state.recentSteps.push(signed);
      if (state.recentSteps.length > RECENT_STEPS) state.recentSteps.shift();
      if (stepOccurrences(state.recentSteps, step) >= 3 && (state.quantum === undefined || step < state.quantum)) {
        state.quantum = step;
      }
    }
    if (value < state.last) {
      // A named counter that drops to (nearly) zero was reset - a daily
      // yield at midnight, a trip log cleared - and is still a counter.
      const reset = state.last > 0 && value <= 0.01 * state.last && COUNTER_LEAF.test(state.path);
      if (!reset) state.monotonic = false;
    } else if (value > state.last) {
      state.rose = true;
      state.rises += 1;
    }
  }

  if (changed) {
    if (state.sameCount > 0) {
      state.sameCount = 0;
    }
    state.sameSince = t;
  } else {
    if (state.sameCount === 0) {
      // The rate of change as it was when this run of identical values began,
      // so a frozen sensor cannot talk the frozen check out of itself.
      state.runRate = state.changeRate;
    }
    state.sameCount += 1;
  }
  if (state.sameCount <= 3) {
    state.changeRate += 0.02 * ((changed ? 1 : 0) - state.changeRate);
  }

  applyPendingRestore(state, t);

  // Baseline update. Every number feeds it, whatever its kind, so a path that
  // turns out to be continuous already has a baseline when it does.
  if (state.mean === undefined) {
    state.mean = x;
    state.fast = x;
    state.variance = 0;
  } else {
    const relearning = t < state.relearnUntil;
    if (relearning) {
      state.relearnN += 1;
    }
    const countAlpha = 1 / (relearning ? state.relearnN + 1 : state.n);
    const slowAlpha = Math.max(timeAlpha(dt, SLOW_HALF_LIFE_MS), countAlpha);
    const fastAlpha = Math.max(timeAlpha(dt, FAST_HALF_LIFE_MS), 1 / state.n);
    state.fast += fastAlpha * (x - state.fast);

    const scale = Math.max(Math.sqrt(state.variance), noiseFloor(state));
    const settled = state.n > KIND_DECISION_SAMPLES && !relearning;
    // While the path is away from its baseline, the baseline must not learn
    // the excursion as normal variation: a spread updated from a sustained
    // departure grows until the departure no longer stands out, and the alert
    // talks itself out of existing. So during an excursion the spread is held
    // and the mean creeps by at most one spread-width's worth per sample.
    const excursion = settled && Math.abs(state.fast - state.mean) / scale >= options.zClear;
    if (excursion) {
      state.excursionSince = state.excursionSince === undefined ? t : state.excursionSince;
    } else {
      state.excursionSince = undefined;
    }
    const limit = settled ? (excursion ? 1 : CLAMP_SIGMAS) * scale : Infinity;
    const diff = Math.max(-limit, Math.min(limit, x - state.mean));
    const increment = slowAlpha * diff;
    state.mean += increment;
    if (!excursion) {
      state.variance = (1 - slowAlpha) * (state.variance + diff * increment);
    }
    // An excursion that has lasted this long is the new normal - a
    // different sea temperature, a re-plumbed sensor. Learn it afresh rather
    // than alert about it forever.
    if (excursion && t - state.excursionSince >= options.acceptExcursionMs) {
      beginRelearn(state, t, options.relearnMs);
      state.excursionSince = undefined;
      state.accepted = (state.accepted || 0) + 1;
    }
  }

  state.last = value;
  state.unwrapped = x;
  pushBucket(state, 'recentBucket', 'recent', RECENT_BUCKET_MS, RECENT_BUCKETS, t, x);
  pushBucket(state, 'minuteBucket', 'minutes', MINUTE_BUCKET_MS, MINUTE_BUCKETS, t, x);
  return true;
}

/**
 * How many times a step of this size occurs among the recent (signed) steps,
 * counting a step that goes straight back the way the one before it came -
 * a glitch out and back - as one occurrence, not two. A sensor flickering
 * between two levels still adds an occurrence for every out-and-back pair;
 * one glitch followed by a real drop of the same size makes two, not three.
 */
function stepOccurrences(steps, step) {
  const matches = (value) => Math.abs(Math.abs(value) - step) <= 0.1 * Math.max(Math.abs(value), step);
  let count = 0;
  let paired = false;
  for (let index = 0; index < steps.length; index += 1) {
    const value = steps[index];
    if (!matches(value)) {
      paired = false;
      continue;
    }
    const previous = steps[index - 1];
    if (!paired && previous !== undefined && matches(previous) && Math.sign(previous) !== Math.sign(value)) {
      paired = true;
      continue;
    }
    count += 1;
    paired = false;
  }
  return count;
}

// The coarsest resolution real senders of a unit have, as a noise floor:
// pressure senders on a J1939 gateway report in 4 kPa steps and 1 psi ones
// in 6.9 kPa. Tanks are deliberately not here: an eighths sender would get a
// floor of a quarter, and then even full to empty scores below a warning.
// Their floor stays at ten times the unit's (0.05), which already keeps one
// eighth step quiet. Elsewhere ten times the unit's floor is coarser than any
// real sensor.
const COARSEST_FLOOR = { Pa: 16000 };

function noiseFloor(state) {
  const unitFloor = unitNoiseFloor(state.path, state.units);
  const quantumFloor = state.quantum === undefined ? 0 : 2 * state.quantum;
  const relative = state.mean === undefined ? 0 : 0.005 * Math.abs(state.mean);
  // A learned resolution can raise the floor, but only so far: no real
  // sensor reports in steps coarser than the coarsest senders of its unit
  // (or than 5 % of its value), so a resolution beyond that is a run of
  // glitches, and letting it through would hide real departures.
  if (unitFloor !== undefined) {
    const unit = state.units || (/[Pp]ressure$/.test(state.path) ? 'Pa' : undefined);
    return Math.max(unitFloor, Math.min(quantumFloor, Math.max(10 * unitFloor, COARSEST_FLOOR[unit] || 0)));
  }
  // Without a unit: 5 % of the value, but a whole-number path always keeps
  // its counting resolution - one count is never a large departure.
  const cap = Math.max(10 * relative || quantumFloor, state.allInteger ? 2 : 0);
  return Math.max(relative, Math.min(quantumFloor, cap), 1e-9);
}

function isReady(state, t, options) {
  return (
    state.n >= options.minSamples &&
    t - state.firstAt >= options.learningMs &&
    t >= state.relearnUntil
  );
}

// A path that has only ever gone up - engine hours, a trip log - is a
// counter, and a counter's steady climb is not a departure from anything.
// "Never went down" alone is not enough - a voltage that sat still and then
// jumped, or one climbing steadily on a charger, has never gone down either.
// A counter is a number that is
//   - listed by the operator in watchCounterPaths under its exact path,
//     whatever it does; or
//   - covered by a pattern there, or named as a counter (runTime, fuel.used,
//     lifetimeDischarge, energy, log...), and not a measurement - no
//     measurement in its name, no unit of one. Named ones must also never
//     have gone down (a reset to zero aside).
// Nothing else is guessed to be a counter from how it behaves: a voltage
// published under an unknown name and without units can climb for hours
// without a dip too, and taking it for a counter would switch off the very
// checks that should report it. A pattern cannot do that either: under
// "plugins.example" the counters are counters and the batteryVoltage beside
// them is still judged.
const COUNTER_SAMPLES = 30;
const COUNTER_LEAF =
  /(?:^|\.)(?:runTime|[a-zA-Z]*[Hh]ours|[a-zA-Z]*[Cc]ount|cumulative[A-Za-z]*|[a-zA-Z]*Total|total[A-Za-z]*|energy[A-Za-z]*|lifetime(?:Discharge|Recharge|Charge|Energy)|[a-zA-Z]*[Cc]onsumed|[a-zA-Z]*Today|yield[A-Za-z]*|used|odometer|log|trip)$/;
// Units of a measurement, which a count never has. Anything else - SI or not
// (s, m3, J, C, m; h, Ah, kWh from a plugin) - can be a running total.
const MEASUREMENT_UNITS = new Set(['V', 'A', 'W', 'K', 'Pa', 'ratio', 'Hz', 'm/s', 'rad', 'rad/s', 'm3/s', 'deg']);
// The last name of a measurement, which no counter-like word in it overrides:
// totalPower, energyStored, currentVolume and satellitesInView.count go up
// and down.
const MEASUREMENT_LEAF =
  /(?:[Vv]oltage|[Cc]urrent|[Tt]emperature|[Ll]evel|[Vv]olume|[Pp]ressure|[Dd]epth|[Ss]peed|[Vv]elocity|[Aa]ngle|[Hh]eading|[Pp]ower|[Rr]atio|stateOfCharge|[Hh]umidity|[Rr]evolutions|[Rr]ate|[Ff]low|[Ff]requency|[Dd]istance|[Aa]ltitude|[Pp]osition|[Ss]tored|[Rr]emaining|[Cc]apacity|[Aa]vailable)$/;

function leafOf(path) {
  return path.slice(path.lastIndexOf('.') + 1);
}

// A leaf naming a state code rather than a count: a whole `state` or `mode`
// (switch banks, device states) or a name ending in one (chargerState,
// relay1State, inverterACMode, errorCode, chargePhase, gpsSource, and flags
// such as engineInAlarm). Time or pulses in a state or since an error
// (timeInState, secondsSinceLastError, pulsesInCurrentMode) are counts again:
// a time or count word, then In or Since.
const STATE_CODE_LEAF =
  /(?:^|[A-Za-z0-9])(?:[Ss]tate|[Mm]ode|[Ss]tatus|[Tt]ype|[Cc]ode|[Pp]hase|[Ff]ault|[Ee]rror|[Aa]larm|[Nn]ame|[Ss]ource|[Rr]eference|[Mm]ethod|[Ll]abel)$/;
// The time or count word, then In or Since. A long word may follow a
// lowercase letter (runtimeInState, uptimeSinceFault); a short one only
// starts the leaf or a word of it (msSinceError, relay1SecondsInState), so
// "systemsInAlarm" is not "ms in alarm".
const LONG_COUNT_WORDS = ['time', 'seconds', 'minutes', 'hours', 'duration', 'elapsed', 'period', 'dwell', 'pulses', 'count', 'counts', 'events', 'cycles', 'starts', 'trips'];
const SHORT_COUNT_WORDS = ['ms', 'secs', 'mins', 'days', 'age'];
const capitalised = (words) => words.map((word) => word[0].toUpperCase() + word.slice(1));
const COUNT_OF_STATE_LEAF = new RegExp(
  `(?:(?:^|[a-z])(?:${LONG_COUNT_WORDS.join('|')})|^(?:${SHORT_COUNT_WORDS.join('|')})|(?:${capitalised([...LONG_COUNT_WORDS, ...SHORT_COUNT_WORDS]).join('|')}))` +
    '(?:In|Since)[A-Za-z0-9]*?(?:State|Status|Mode|Phase|Fault|Error|Alarm|Code)$'
);

function isStateCodeLeaf(path) {
  const leaf = leafOf(path);
  return STATE_CODE_LEAF.test(leaf) && !COUNT_OF_STATE_LEAF.test(leaf);
}

/**
 * What the counter listing does to a path: 'exact' (listed by its own path:
 * a counter whatever it does), 'forced' (under a pattern and not a state
 * code: a counter, never discrete), or 'self' (not listed, or a state code
 * under a pattern: it classifies itself). `listedBy` is the matching entry,
 * or true for a save that kept only a flag.
 */
function counterListingFor(path, listedBy) {
  if (!listedBy) return 'self';
  if (listedBy === path) return 'exact';
  return isStateCodeLeaf(path) ? 'self' : 'forced';
}

function counterListing(state) {
  return counterListingFor(state.path, state.counterOptIn);
}

function isMeasurement(state) {
  return (
    MEASUREMENT_LEAF.test(leafOf(state.path)) ||
    /\.satellites/.test(state.path) ||
    (typeof state.units === 'string' && MEASUREMENT_UNITS.has(state.units))
  );
}

function isCounter(state) {
  if (state.kind === 'discrete') {
    return false;
  }
  if (state.counterOptIn === state.path) {
    return true;
  }
  if (isMeasurement(state)) {
    return false;
  }
  if (counterListing(state) === 'forced') {
    return true;
  }
  if (!state.monotonic || !state.rose || state.n < COUNTER_SAMPLES) {
    return false;
  }
  return COUNTER_LEAF.test(state.path);
}

/**
 * Rate of change over the last minute and a half, in SI units per minute.
 * Short on purpose: it describes whether the value is *still* moving, so a
 * step that has levelled off is not reported as "changing 4 °C/min".
 */
function recentSlopePerMinute(state, windowMs = 90 * 1000) {
  const series = seriesWithOpen(state, 'recent', 'recentBucket', RECENT_BUCKET_MS);
  if (series.length < 3) {
    return undefined;
  }
  const end = series[series.length - 1][0];
  const points = series.filter(([at]) => at >= end - windowMs);
  const trend = linearTrend(points);
  return trend ? trend.slope * 60 * 1000 : undefined;
}

/**
 * A sustained departure from the learned baseline: a step, or a ramp faster
 * than the baseline can follow. One check covers both, because a ramp keeps
 * the fast average pulling away from the slow one.
 */
function evaluateShift(state, t, options, isOpen) {
  if (state.kind !== 'continuous' || !isReady(state, t, options) || isCounter(state)) {
    return null;
  }
  const std = Math.sqrt(state.variance);
  const scale = Math.max(std, noiseFloor(state));
  const delta = state.fast - state.mean;
  const z = delta / scale;
  const threshold = isOpen ? options.zClear : options.zWarn;
  const slope = recentSlopePerMinute(state);
  return {
    active: Math.abs(z) >= threshold,
    severity: Math.abs(z) >= options.zAlert ? 'alert' : 'warn',
    evidence: {
      value: state.last,
      baseline: state.mean,
      spread: std,
      z,
      delta,
      // Only a rate that is itself beyond the noise is worth saying.
      slopePerMinute: slope !== undefined && Math.abs(slope) >= scale ? slope : undefined
    }
  };
}

/** No update for far longer than this path normally goes between updates. */
function evaluateDropout(state, t, options) {
  if (state.n < options.minSamples || state.intervalMean === undefined || state.intervalMean > options.maxRegularIntervalMs) {
    return null;
  }
  const limit = Math.max(options.dropoutMinMs, options.dropoutFactor * state.intervalMean);
  const silentFor = t - state.lastAt;
  return {
    active: silentFor > limit,
    severity: 'warn',
    evidence: { silentFor, intervalMean: state.intervalMean, lastAt: state.lastAt, source: state.source }
  };
}

/** A normally lively number repeating the exact same value. */
function evaluateFrozen(state, t, options) {
  if (state.kind !== 'continuous' || state.n < options.frozenMinSamples || isCounter(state)) {
    return null;
  }
  const frozenFor = state.sameCount > 0 ? t - state.sameSince : 0;
  const lively = (state.sameCount > 0 ? state.runRate : state.changeRate) >= 0.5;
  // Exactly zero is a machine that is off (0 rpm, 0 A), not a sensor that is
  // stuck; and a path re-learning after an operating change is expected to
  // behave differently from before.
  const plausible = state.last !== 0 && t >= state.relearnUntil;
  return {
    active: plausible && lively && state.sameCount >= options.frozenMinRepeats && frozenFor >= options.frozenMs,
    severity: 'warn',
    evidence: { value: state.last, frozenFor, repeats: state.sameCount }
  };
}

/** A discrete value the path has never taken before, held for a while. */
function evaluateNewState(state, t, options) {
  if (state.kind !== 'discrete' || state.newStateAt === undefined) {
    return null;
  }
  return {
    active: t - state.newStateAt < options.eventHoldMs,
    severity: 'warn',
    evidence: { value: state.newStateValue, at: state.newStateAt, known: Object.keys(state.seen).filter((k) => k !== state.newStateValue) }
  };
}

/** Switching far more often in the last hour than it has on average. */
function evaluateCycling(state, t, options) {
  // Since the switching history began: a path re-decided as discrete starts
  // it again, because its time as a continuous path held no switches.
  const since = Number.isFinite(state.transitionsSince) ? state.transitionsSince : state.firstAt;
  if (state.kind !== 'discrete' || t - since < options.cyclingLearningMs) {
    return null;
  }
  // Counted to the minute: the minute buckets that start inside the last
  // hour. The oldest partial minute is left out rather than counted whole,
  // so the window is 59-60 minutes and never reaches past the hour; what is
  // left out stays in the historical rate, which uses the same split.
  const lastHour = state.transitionMinutes
    .filter(([minute]) => minute >= t - HOUR_MS)
    .reduce((sum, [, count]) => sum + count, 0);
  const observedHours = Math.max(1, (t - since - HOUR_MS) / HOUR_MS);
  const baselinePerHour = Math.max(0, state.transitionTotal - lastHour) / observedHours;
  const threshold = Math.max(options.cyclingMinPerHour, Math.ceil(3 * baselinePerHour + 2));
  return {
    active: lastHour >= threshold,
    severity: lastHour >= 2 * threshold ? 'alert' : 'warn',
    evidence: { lastHour, baselinePerHour, threshold }
  };
}

// Where a tank or battery runs out is worth a warning hours before it does.
// Waste tanks fill instead of empty, so their limit is at the top.
const DEPLETION_TARGETS = [
  { pattern: /^tanks\.(?:fuel|freshWater|lubrication|gas)\.[^.]+\.currentLevel$/, limit: 0.1, direction: -1, horizonMs: 3 * HOUR_MS, label: '10 %' },
  { pattern: /^tanks\.(?:wasteWater|blackWater)\.[^.]+\.currentLevel$/, limit: 0.9, direction: 1, horizonMs: 3 * HOUR_MS, label: '90 %' },
  { pattern: /^electrical\.batteries\.[^.]+\.(?:stateOfCharge|capacity\.stateOfCharge)$/, limit: 0.2, direction: -1, horizonMs: 2 * HOUR_MS, label: '20 %' }
];

const ALERTING_ZONE_STATES = new Set(['warn', 'alert', 'alarm', 'emergency']);

/** Limits this path is heading toward: from meta.zones, and the built-in depletion targets. */
function forecastLimits(state) {
  const limits = [];
  for (const target of DEPLETION_TARGETS) {
    if (target.pattern.test(state.path)) {
      limits.push({ value: target.limit, direction: target.direction, horizonMs: target.horizonMs, zone: 'low', label: target.label });
    }
  }
  if (Array.isArray(state.zones)) {
    for (const zone of state.zones) {
      if (!zone || !ALERTING_ZONE_STATES.has(zone.state)) {
        continue;
      }
      const lower = Number.isFinite(zone.lower) ? zone.lower : undefined;
      const upper = Number.isFinite(zone.upper) ? zone.upper : undefined;
      if (lower !== undefined) {
        limits.push({ value: lower, direction: 1, horizonMs: 30 * 60 * 1000, zone: zone.state });
      }
      if (upper !== undefined) {
        limits.push({ value: upper, direction: -1, horizonMs: 30 * 60 * 1000, zone: zone.state });
      }
    }
  }
  return limits;
}

/** When the minute-by-minute trend will cross a limit, if that is soon. */
function evaluateForecast(state, t, options) {
  if (state.kind !== 'continuous' || !isReady(state, t, options) || state.angle) {
    return null;
  }
  const limits = forecastLimits(state);
  if (limits.length === 0) {
    return null;
  }
  const series = seriesWithOpen(state, 'minutes', 'minuteBucket', MINUTE_BUCKET_MS);
  let best;
  for (const limit of limits) {
    const windowMs = limit.horizonMs >= HOUR_MS ? 60 * 60 * 1000 : 15 * 60 * 1000;
    const points = series.filter(([at]) => at >= t - windowMs);
    if (points.length < (windowMs >= HOUR_MS ? 10 : 5)) {
      continue;
    }
    const trend = linearTrend(points);
    if (!trend || trend.r2 < 0.6 || Math.sign(trend.slope) !== limit.direction) {
      continue;
    }
    const current = state.fast;
    const remaining = limit.value - current;
    if (Math.sign(remaining) !== limit.direction) {
      // Already past the limit: that is the zone's own alarm, not a forecast.
      continue;
    }
    const etaMs = remaining / trend.slope;
    if (etaMs > 0 && etaMs <= limit.horizonMs && (!best || etaMs < best.etaMs)) {
      best = { etaMs, limit: limit.value, zone: limit.zone, label: limit.label, slopePerMinute: trend.slope * 60 * 1000, r2: trend.r2 };
    }
  }
  return {
    active: Boolean(best),
    severity: 'warn',
    evidence: best ? { value: state.last, ...best } : { value: state.last }
  };
}

const MAX_REGIMES = 6;
// How long a baseline must have been settled to be worth filing under its
// operating state: a few minutes of a transition is not "how it runs".
const MIN_SETTLED_FOR_REGIME_MS = 10 * 60 * 1000;

/** File the current baseline under the operating state the path is leaving. */
function saveRegimeBaseline(state, key, t, options) {
  if (state.kind !== 'continuous' || state.mean === undefined || !isReady(state, t, options)) {
    return false;
  }
  const settledSince = Math.max(state.firstAt + options.learningMs, state.relearnUntil);
  if (t - settledSince < MIN_SETTLED_FOR_REGIME_MS) {
    return false;
  }
  if (!state.regimes) state.regimes = {};
  state.regimes[key] = { mean: state.mean, variance: state.variance, savedAt: t };
  const keys = Object.keys(state.regimes);
  if (keys.length > MAX_REGIMES) {
    keys.sort((a, b) => state.regimes[a].savedAt - state.regimes[b].savedAt);
    delete state.regimes[keys[0]];
  }
  return true;
}

/** Arrange for the baseline learned in `key` to come back once the transition settles. */
function planRegimeRestore(state, key) {
  const saved = state.regimes && state.regimes[key];
  state.restoreOnSettle = saved ? { key, mean: saved.mean, variance: saved.variance } : undefined;
  return Boolean(saved);
}

/** Apply a planned restore once the settling period has passed. */
function applyPendingRestore(state, t) {
  if (!state.restoreOnSettle || t < state.relearnUntil) {
    return false;
  }
  state.mean = state.restoreOnSettle.mean;
  state.variance = state.restoreOnSettle.variance;
  state.restoredRegime = state.restoreOnSettle.key;
  state.restoreOnSettle = undefined;
  state.excursionSince = undefined;
  return true;
}

/**
 * Open the path's kind to decision again, as for a new path (its baseline is
 * kept, and keeps learning as before): the counter listing it was decided
 * under has changed.
 */
function redecideKind(state, t, quietMs) {
  // A measurement (by name or unit) that was continuous stays continuous:
  // the listing never made it one, and a whole-number reading (coolant in
  // whole kelvin) decided again would turn discrete and absorb a real shift.
  if (state.kind === 'continuous' && isMeasurement(state)) {
    return;
  }
  // A second re-decision before the first is settled keeps the kind the
  // path had before both: still 'unknown' is not what it was.
  if (state.redecideFrom === undefined || state.kind !== 'unknown') {
    state.redecideFrom = state.kind;
  }
  state.redecideQuietMs = Number.isFinite(quietMs) ? quietMs : undefined;
  state.kind = 'unknown';
  state.distinct = [];
  state.allInteger = true;
  state.kindN = 0;
  // States already seen stay known, and a pending new state is dropped.
  // States first seen in the next while are learned without a finding (from
  // here, and again from when the kind is known, if it turns out discrete);
  // the baseline and every other check carry on as they were.
  state.newStateAt = undefined;
  state.newStateValue = undefined;
  if (Number.isFinite(t) && Number.isFinite(quietMs)) {
    state.newStateQuietUntil = Math.max(state.newStateQuietUntil || 0, t + quietMs);
  }
}

/** Restart the baseline: an operating-state change has made the old one wrong. */
function beginRelearn(state, t, durationMs) {
  state.relearnUntil = Math.max(state.relearnUntil, t + durationMs);
  state.relearnN = 0;
}

/** The compact form saved to disk. */
function exportPathState(state) {
  const { recent, recentBucket, newStateAt, newStateValue, ...rest } = state;
  return rest;
}

function importPathState(saved, now) {
  if (!saved || typeof saved.path !== 'string') {
    return undefined;
  }
  const state = { ...createPathState(saved.path, now), ...saved };
  // A restart is not a dropout: give every path its normal chance to report.
  state.lastAt = now;
  state.acceptedAt = undefined;
  state.sameSince = now;
  state.sameCount = 0;
  state.recent = [];
  state.recentBucket = undefined;
  state.transitionMinutes = Array.isArray(saved.transitionMinutes) ? saved.transitionMinutes.slice(-61) : [];
  state.recentSteps = Array.isArray(saved.recentSteps) ? saved.recentSteps.slice(-RECENT_STEPS) : [];
  state.rises = Number.isFinite(saved.rises) ? saved.rises : 0;
  // Set from the current settings by the engine, not from the save.
  state.counterOptIn = undefined;
  delete state.riseHours;
  state.minutes = Array.isArray(saved.minutes) ? saved.minutes.slice(-MINUTE_BUCKETS) : [];
  return state;
}

function hasDepletionTarget(path) {
  return DEPLETION_TARGETS.some((target) => target.pattern.test(path));
}

module.exports = {
  HOUR_MS,
  applyPendingRestore,
  planRegimeRestore,
  saveRegimeBaseline,
  hasDepletionTarget,
  isCounterState: isCounter,
  counterListingFor,
  redecideKind,
  beginRelearn,
  createPathState,
  evaluateCycling,
  evaluateDropout,
  evaluateForecast,
  evaluateFrozen,
  evaluateNewState,
  evaluateShift,
  exportPathState,
  importPathState,
  isReady,
  noiseFloor,
  observe,
  seriesWithOpen
};
