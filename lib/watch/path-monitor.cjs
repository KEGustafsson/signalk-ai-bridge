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
function decideKind(state) {
  if (state.kind === 'continuous') {
    return;
  }
  if (state.distinct === null || !state.allInteger) {
    state.kind = 'continuous';
    return;
  }
  if (state.n >= KIND_DECISION_SAMPLES) {
    state.kind = 'discrete';
  }
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
    if (ready && !state.seenOverflow && !(key in state.seen)) {
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
    state.intervalMean = state.intervalMean === undefined ? dt : state.intervalMean + 0.1 * (dt - state.intervalMean);
  }
  state.acceptedAt = t;
  state.lastAt = t;
  state.n += 1;

  const ready = isReady(state, t, options);

  if (type === 'discrete') {
    state.kind = 'discrete';
    state.distinct = null;
    recordDiscrete(state, key, t, ready);
    return true;
  }

  // Numbers: track enough to decide continuous vs discrete.
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
  decideKind(state);

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
    const step = Math.abs(x - (state.unwrapped === undefined ? state.last : state.unwrapped));
    // The sensor's resolution is a step size seen more than once. A single
    // step is not evidence of resolution: a tank that sat at 80 % and then
    // dropped to 20 % would otherwise have "learned" a 60-point resolution,
    // and the noise floor that follows from it would hide the drop itself.
    if (step > 0) {
      const confirmed = state.recentSteps.some((seen) => Math.abs(seen - step) <= 0.1 * Math.max(seen, step));
      if (confirmed && (state.quantum === undefined || step < state.quantum)) {
        state.quantum = step;
      }
      state.recentSteps.push(step);
      if (state.recentSteps.length > RECENT_STEPS) state.recentSteps.shift();
    }
    if (value < state.last) {
      state.monotonic = false;
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

function noiseFloor(state) {
  const unitFloor = unitNoiseFloor(state.path, state.units);
  const quantumFloor = state.quantum === undefined ? 0 : 2 * state.quantum;
  if (unitFloor !== undefined) {
    return Math.max(unitFloor, quantumFloor);
  }
  const relative = state.mean === undefined ? 0 : 0.005 * Math.abs(state.mean);
  return Math.max(relative, quantumFloor, 1e-9);
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
// "Never went down" alone is not enough: a voltage that sat still through
// learning and then jumped has also never gone down. A counter is either
// named as one, or has climbed on a good share of its updates.
const COUNTER_SAMPLES = 30;
const COUNTER_LEAF = /(?:^|\.)(?:runTime|[a-zA-Z]*[Hh]ours|[a-zA-Z]*[Cc]ount|cumulative[A-Za-z]*|[a-zA-Z]*Total|total[A-Za-z]*|energy[A-Za-z]*|log|trip)$/;

function isCounter(state) {
  if (!state.monotonic || !state.rose || state.n < COUNTER_SAMPLES) {
    return false;
  }
  return COUNTER_LEAF.test(state.path) || state.rises >= Math.max(10, 0.2 * state.n);
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
  if (state.kind !== 'discrete' || t - state.firstAt < options.cyclingLearningMs) {
    return null;
  }
  const lastHour = state.transitionMinutes
    .filter(([minute]) => minute > t - HOUR_MS - TRANSITION_BUCKET_MS)
    .reduce((sum, [, count]) => sum + count, 0);
  const observedHours = Math.max(1, (t - state.firstAt - HOUR_MS) / HOUR_MS);
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
