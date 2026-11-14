'use strict';

const { METRES_PER_SECOND_IN_KNOT, haversineMetres, offsetPosition, toPosition } = require('./stats.cjs');

/**
 * GNSS integrity: is the position the vessel is reporting one it can trust?
 *
 * Jamming and spoofing do not announce themselves. A jammed receiver loses
 * satellites and its fix degrades or freezes; a spoofed one keeps a perfectly
 * healthy-looking fix that is simply somewhere else. Neither trips a limit, so
 * no zone or threshold catches them. What does catch them is evidence the
 * GNSS receiver does not control:
 *
 *   jump              consecutive fixes imply a speed the vessel cannot make
 *   dead-reckoning    heading + speed through water put the vessel somewhere
 *                     the fix disagrees with (both are independent of GNSS)
 *   sources-disagree  two receivers on the same boat are far apart
 *   quality           satellite count or dilution collapsed
 *   frozen            the fix stopped moving while the log says the boat is
 *   clock             GNSS time jumped against the server's clock
 *
 * One indicator is a warning; two at once are an alert. None of them say "you
 * are being spoofed" - they say the position is not corroborated, which is the
 * thing a navigator needs to know.
 */

const GNSS_PATHS = new Set([
  'navigation.position',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.magneticVariation',
  'navigation.speedThroughWater',
  'navigation.speedOverGround',
  'navigation.gnss.satellites',
  'navigation.gnss.horizontalDilution',
  'navigation.datetime'
]);

const FRESH_MS = 5000;
const LONG_GAPS_FOR_RATE = 5;
// A gap this many usual intervals long is an outage, and a silence this long
// is a lost receiver.
const OUTAGE_FACTOR = 5;
const SOURCES_WINDOW_MS = 10000;
const DR_REANCHOR_MS = 10 * 60 * 1000;
const DR_BASE_ALLOWANCE_M = 150;
const DR_DISTANCE_FRACTION = 0.25;

function isGnssPath(path) {
  return GNSS_PATHS.has(path);
}

function createGnssState() {
  return {
    fixes: {},
    lastFix: undefined,
    heading: undefined,
    headingMagnetic: undefined,
    variation: undefined,
    stw: undefined,
    sog: undefined,
    satellites: undefined,
    hdop: undefined,
    satellitesGoodCount: 0,
    hdopGoodCount: 0,
    clockOffset: undefined,
    clockSamples: 0,
    clockJump: undefined,
    jump: undefined,
    dr: undefined,
    stillSince: undefined
  };
}

function reading(value, t) {
  return typeof value === 'number' && Number.isFinite(value) ? { value, at: t } : undefined;
}

function fresh(entry, t) {
  return entry && t - entry.at <= FRESH_MS ? entry.value : undefined;
}

function trueHeading(state, t) {
  const heading = fresh(state.heading, t);
  if (heading !== undefined) {
    return heading;
  }
  const magnetic = fresh(state.headingMagnetic, t);
  const variation = state.variation ? state.variation.value : undefined;
  return magnetic !== undefined && variation !== undefined ? magnetic + variation : undefined;
}

/** Carry dead reckoning forward to `t` using heading and speed through water. */
function advanceDeadReckoning(state, t) {
  const dr = state.dr;
  if (!dr) {
    return;
  }
  const heading = trueHeading(state, t);
  const stw = fresh(state.stw, t);
  if (heading === undefined || stw === undefined) {
    // Without both, dead reckoning is guesswork; drop it rather than carry a
    // stale estimate into a false alarm.
    state.dr = undefined;
    return;
  }
  const dtSeconds = Math.max(0, (t - dr.at) / 1000);
  const distance = stw * dtSeconds;
  dr.position = offsetPosition(dr.position, heading, distance);
  dr.travelled += distance;
  dr.at = t;
}

function observeFix(state, position, t, source, options) {
  const key = source || 'default';
  const previous = state.fixes[key];

  if (previous && t > previous.at) {
    const distance = haversineMetres(previous.position, position);
    const seconds = (t - previous.at) / 1000;
    const impliedKnots = distance / seconds / METRES_PER_SECOND_IN_KNOT;
    if (distance > options.gnssJumpMinMetres && impliedKnots > options.gnssMaxSpeedKn) {
      state.jump = { at: t, distance, impliedKnots, source: key };
    }

    // A fix that does not move while the log says the boat does. Any fix
    // without that evidence - it moved, or the log is stale, missing or reads
    // under 1 m/s - ends the candidate, so a boat that slows down and stops
    // is not later reported as a frozen receiver.
    const stw = fresh(state.stw, t);
    // Consecutive fixes only: across a gap in the feed, "has not moved since"
    // the old fix is not evidence of anything. "Consecutive" is relative to
    // how often this receiver reports, so one that sends a fix every 10 s
    // keeps the check.
    const usualGap = state.fixInterval === undefined ? 0 : 3 * state.fixInterval;
    const consecutive = t - previous.at <= Math.max(FRESH_MS, usualGap);
    if (consecutive && distance < 0.5 && stw !== undefined && stw > 1) {
      state.stillSince = state.stillSince === undefined ? previous.at : state.stillSince;
    } else {
      state.stillSince = undefined;
    }

    // How often fixes arrive, so a receiver that goes quiet can be told apart
    // from one that only reports now and then.
    const gap = t - previous.at;
    // An outage is not the receiver's rate. Gaps far beyond the usual
    // interval are left out of it, or one outage would stretch "usual" until
    // the next outage went unreported.
    // A receiver that really slowed down (or a slower one taking over) shows
    // as a run of long gaps of about one size: five in a row, each within half
    // of the run's mean so far, are its new rate (their mean). A receiver
    // dropping out now and then (under jamming, say) gives scattered or
    // growing gaps, which stay outages.
    const outage = state.fixInterval !== undefined && gap > Math.max(FRESH_MS, OUTAGE_FACTOR * state.fixInterval);
    if (!outage) {
      state.longGaps = 0;
      state.longGapRun = undefined;
      state.fixInterval = state.fixInterval === undefined ? gap : state.fixInterval + 0.1 * (gap - state.fixInterval);
    } else {
      const steady = state.longGapRun !== undefined && Math.abs(gap - state.longGapRun) <= 0.5 * state.longGapRun;
      if (!steady) {
        state.longGapRun = gap;
        state.longGaps = 1;
      } else {
        state.longGaps = (state.longGaps || 0) + 1;
        state.longGapRun += (gap - state.longGapRun) / state.longGaps;
      }
      if (state.longGaps >= LONG_GAPS_FOR_RATE) {
        state.fixInterval = state.longGapRun;
        state.longGaps = 0;
        state.longGapRun = undefined;
      }
    }
  }
  state.fixCount = (state.fixCount || 0) + 1;
  state.fixes[key] = { position, at: t };
  state.lastFix = { position, at: t, source: key };

  // Dead reckoning is anchored to a fix and compared against later ones.
  advanceDeadReckoning(state, t);
  if (!state.dr) {
    if (trueHeading(state, t) !== undefined && fresh(state.stw, t) !== undefined) {
      state.dr = { anchor: position, anchorAt: t, position: { ...position }, at: t, travelled: 0, divergence: 0, allowed: DR_BASE_ALLOWANCE_M };
    }
    return;
  }
  const dr = state.dr;
  dr.divergence = haversineMetres(dr.position, position);
  // When an independent check last looked at the fix, for the watch report.
  state.crossCheckedAt = t;
  const elapsedSeconds = (t - dr.anchorAt) / 1000;
  dr.allowed =
    DR_BASE_ALLOWANCE_M +
    DR_DISTANCE_FRACTION * dr.travelled +
    options.gnssCurrentAllowanceKn * METRES_PER_SECOND_IN_KNOT * elapsedSeconds;
  const consistent = dr.divergence <= (dr.suspect ? 0.5 : 1) * dr.allowed;
  dr.suspect = !consistent;
  // Re-anchor only on a fix that agrees, so a spoofed position never becomes
  // the reference it is judged against.
  if (consistent && t - dr.anchorAt >= DR_REANCHOR_MS) {
    state.dr = { anchor: position, anchorAt: t, position: { ...position }, at: t, travelled: 0, divergence: 0, allowed: DR_BASE_ALLOWANCE_M };
  }
}

function observeGnss(state, path, value, t, source, options) {
  switch (path) {
    case 'navigation.position': {
      const position = toPosition(value);
      if (position) {
        observeFix(state, position, t, source, options);
      }
      return;
    }
    case 'navigation.headingTrue':
      advanceDeadReckoning(state, t);
      state.heading = reading(value, t);
      return;
    case 'navigation.headingMagnetic':
      advanceDeadReckoning(state, t);
      state.headingMagnetic = reading(value, t);
      return;
    case 'navigation.magneticVariation':
      state.variation = reading(value, t);
      return;
    case 'navigation.speedThroughWater':
      advanceDeadReckoning(state, t);
      // The log had gone quiet: the motion evidence behind any frozen-fix
      // candidate lapsed, so it starts over from the next pair of fixes.
      if (!state.stw || t - state.stw.at > FRESH_MS) state.stillSince = undefined;
      state.stw = reading(value, t);
      // The log no longer shows motion: whatever the fixes do next, they are
      // not a frozen fix on a moving boat.
      if (!(typeof value === 'number' && value > 1)) state.stillSince = undefined;
      return;
    case 'navigation.speedOverGround':
      state.sog = reading(value, t);
      return;
    case 'navigation.gnss.satellites':
      state.satellites = reading(value, t);
      if (typeof value === 'number' && value >= 6) {
        state.satellitesGoodCount += 1;
      }
      return;
    case 'navigation.gnss.horizontalDilution':
      state.hdop = reading(value, t);
      if (typeof value === 'number' && value > 0 && value < 2) {
        state.hdopGoodCount += 1;
      }
      return;
    case 'navigation.datetime': {
      const at = typeof value === 'string' ? Date.parse(value) : NaN;
      if (!Number.isFinite(at)) {
        return;
      }
      const offset = at - t;
      if (state.clockOffset !== undefined && state.clockSamples >= 10 && Math.abs(offset - state.clockOffset) > options.gnssClockJumpMs) {
        state.clockJump = { at: t, jumpMs: offset - state.clockOffset };
      }
      state.clockOffset = state.clockOffset === undefined ? offset : state.clockOffset + 0.05 * (offset - state.clockOffset);
      state.clockSamples += 1;
      return;
    }
    default:
  }
}

function formatMetres(metres) {
  return metres >= 1852 ? `${(metres / 1852).toFixed(1)} nm` : `${Math.round(metres)} m`;
}

/**
 * The indicators as conditions for the engine's tracker: each is
 * `{ active, severity, evidence, message }`, or null when it cannot be judged
 * (no data for it on this vessel).
 */
function evaluateGnss(state, t, options) {
  const out = {};

  out.jump = state.jump
    ? {
        active: t - state.jump.at < options.eventHoldMs,
        severity: state.jump.distance > 5000 ? 'alert' : 'warn',
        evidence: state.jump,
        message: `Position jumped ${formatMetres(state.jump.distance)} between fixes (${Math.round(state.jump.impliedKnots)} kn implied)`
      }
    : null;

  out.deadReckoning = state.dr
    ? {
        active: Boolean(state.dr.suspect) && state.lastFix !== undefined && t - state.lastFix.at < 30000,
        severity: 'warn',
        evidence: { divergence: state.dr.divergence, allowed: state.dr.allowed, since: state.dr.anchorAt },
        message: `Fix is ${formatMetres(state.dr.divergence)} from dead reckoning (heading + log); up to ${formatMetres(state.dr.allowed)} is explainable by current and leeway`
      }
    : null;

  const recent = Object.entries(state.fixes).filter(([, fix]) => t - fix.at <= SOURCES_WINDOW_MS);
  if (recent.length >= 2) {
    let worst = { distance: 0 };
    for (let i = 0; i < recent.length; i += 1) {
      for (let j = i + 1; j < recent.length; j += 1) {
        const distance = haversineMetres(recent[i][1].position, recent[j][1].position);
        if (distance > worst.distance) {
          worst = { distance, sources: [recent[i][0], recent[j][0]] };
        }
      }
    }
    state.crossCheckedAt = t;
    out.sourcesDisagree = {
      active: worst.distance > options.gnssSourceDisagreeMetres,
      severity: 'warn',
      evidence: worst,
      message: `Position sources ${(worst.sources || []).join(' and ')} disagree by ${formatMetres(worst.distance)}`
    };
  } else {
    out.sourcesDisagree = null;
  }

  // Quality is reported less often than position on many receivers.
  const satellites = state.satellites && t - state.satellites.at <= 30000 ? state.satellites.value : undefined;
  const hdop = state.hdop && t - state.hdop.at <= 30000 ? state.hdop.value : undefined;
  const lostSatellites = state.satellitesGoodCount >= 20 && satellites !== undefined && satellites < 4;
  const badDilution = state.hdopGoodCount >= 20 && hdop !== undefined && hdop > 5;
  out.quality =
    state.satellitesGoodCount >= 20 || state.hdopGoodCount >= 20
      ? {
          active: lostSatellites || badDilution,
          severity: 'warn',
          evidence: { satellites, hdop },
          message: [
            lostSatellites ? `only ${satellites} satellites in use` : undefined,
            badDilution ? `horizontal dilution ${hdop.toFixed(1)}` : undefined
          ]
            .filter(Boolean)
            .join(', ')
            .replace(/^./, (c) => c.toUpperCase()) || 'Fix quality degraded'
        }
      : null;

  // Frozen needs current evidence at evaluation time too: a recent fix and a
  // log still reading speed. Stale evidence is not a frozen fix.
  const stwNow = fresh(state.stw, t);
  // As fresh as consecutive fixes have to be: no fix inside the window means
  // the "not moving" evidence is out of date.
  const fixWindow = Math.max(FRESH_MS, 3 * (state.fixInterval || 0));
  const fixFresh = state.lastFix !== undefined && t - state.lastFix.at <= fixWindow;
  out.frozen =
    state.stillSince !== undefined
      ? {
          active: fixFresh && stwNow !== undefined && stwNow > 1 && t - state.stillSince >= options.gnssFrozenMs,
          severity: 'warn',
          evidence: { since: state.stillSince },
          message: `Fix has not moved for ${Math.round((t - state.stillSince) / 1000)} s while the log reads ${((fresh(state.stw, t) || 0) / METRES_PER_SECOND_IN_KNOT).toFixed(1)} kn`
        }
      : null;

  // Fixes that stopped arriving altogether. Position is not on the per-path
  // dropout check (it is excluded as fast-changing), so without this a lost
  // receiver left the GNSS status reading "ok" on its last fix for ever.
  if (state.lastFix && (state.fixCount || 0) >= 30 && state.fixInterval !== undefined) {
    // Five missed fixes at the receiver's own rate - the same gap that counts
    // as an outage, so a gap is never both "lost" and a normal one - and never
    // under the configured minimum.
    const limit = Math.max(options.gnssLostMs, OUTAGE_FACTOR * state.fixInterval);
    const silent = t - state.lastFix.at;
    out.lost = {
      active: silent > limit,
      severity: 'warn',
      evidence: { silentFor: silent, interval: state.fixInterval },
      message: `No position fix for ${Math.round(silent / 1000)} s; fixes normally arrive every ${Math.max(1, Math.round(state.fixInterval / 1000))} s`
    };
  } else {
    out.lost = null;
  }

  out.clock = state.clockJump
    ? {
        active: t - state.clockJump.at < options.eventHoldMs,
        severity: 'warn',
        evidence: state.clockJump,
        message: `GNSS time jumped ${Math.round(Math.abs(state.clockJump.jumpMs) / 1000)} s against the server clock`
      }
    : null;

  return out;
}

module.exports = {
  createGnssState,
  evaluateGnss,
  isGnssPath,
  observeGnss
};
