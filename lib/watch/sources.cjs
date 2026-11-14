'use strict';

const { wrapPi } = require('./stats.cjs');

/**
 * Several sources for one path: which to believe, and whether they agree.
 *
 * Boats carry redundant sensors - two GNSS receivers, a compass in the
 * autopilot and another in the chartplotter, a depth sounder on each hull -
 * and Signal K delivers each one's updates for the same path. Fed to one
 * baseline, two sources that differ by a calibration offset look like a noisy
 * signal, or like a step every time the stream switches between them.
 *
 * So one source is primary and only its samples feed the path's baseline. The
 * others are compared against it, which turns redundancy into evidence:
 *
 *   disagree   the gap between two sources is far outside the gap they
 *              normally have (a learned offset is fine; a change in it is not)
 *   failover   the primary went quiet and another source took over, which a
 *              plain dropout check would never see because the path kept
 *              updating
 */

const MAX_SOURCES = 8;
const FAILOVER_MIN_MS = 10000;
const FRESH_MIN_MS = 5000;
const DISAGREE_MIN_SAMPLES = 30;
const MAX_PAIRS = 16;

function createSourceState() {
  return {
    primary: undefined,
    entries: {},
    // The usual gap is learned per primary/secondary pair. Shared statistics
    // let one source's normal calibration offset hide another's new fault:
    // with A and B equal and C a volt high, the "usual gap" was half a volt,
    // so B drifting a volt off scored as ordinary.
    pairs: {},
    failover: undefined
  };
}

/**
 * One primary/secondary pair's learned offset: `mean` is the signed
 * secondary-minus-primary difference, `variance` its spread around it.
 * `signed` marks the statistics as signed; saves from before it learned the
 * mean of |difference|, which cannot be turned back into an offset.
 */
function createPair(primary, secondary) {
  return { primary, secondary, mean: 0, variance: 0, n: 0, signed: true, last: undefined };
}

function resetPair(pair) {
  pair.mean = 0;
  pair.variance = 0;
  pair.n = 0;
  pair.signed = true;
  pair.last = undefined;
}

/**
 * A saved pair table, made safe to use: pairs saved before the offset was
 * learned signed start learning again (30 comparisons), and the last
 * comparison is dropped (the plugin was down).
 */
function migratePairs(pairs) {
  if (!pairs || typeof pairs !== 'object') return {};
  for (const [key, pair] of Object.entries(pairs)) {
    if (!pair || typeof pair !== 'object') {
      delete pairs[key];
      continue;
    }
    if (pair.signed !== true || !Number.isFinite(pair.mean) || !Number.isFinite(pair.variance)) resetPair(pair);
    pair.last = undefined;
  }
  return pairs;
}

/**
 * Record one sample. Returns true when it comes from the primary source and
 * should feed the path's own baseline.
 *
 * `scaleOf()` gives the path's current noise scale; it is only called when
 * two numeric sources are compared.
 */
function routeSample(sources, source, value, t, { intervalMean, angle, scaleOf, zClear }) {
  const key = source || 'default';
  let entry = sources.entries[key];
  if (!entry) {
    if (Object.keys(sources.entries).length >= MAX_SOURCES) {
      return key === sources.primary;
    }
    entry = { n: 0, value: undefined, at: undefined };
    sources.entries[key] = entry;
  }
  entry.value = value;
  entry.at = t;
  entry.n += 1;

  if (sources.primary === undefined) {
    sources.primary = key;
  }
  if (key === sources.primary) {
    return true;
  }

  const primary = sources.entries[sources.primary];
  const interval = Number.isFinite(intervalMean) ? intervalMean : 1000;
  if (!primary || primary.at === undefined || t - primary.at > Math.max(FAILOVER_MIN_MS, 5 * interval)) {
    // An established primary that went quiet is news; a source that was only
    // ever seen once at start-up is not.
    if (primary && primary.n >= DISAGREE_MIN_SAMPLES) {
      sources.failover = { at: t, from: sources.primary, to: key };
    }
    sources.primary = key;
    return true;
  }

  if (t - primary.at <= Math.max(FRESH_MIN_MS, 2 * interval) && typeof value === 'number' && typeof primary.value === 'number') {
    const raw = value - primary.value;
    const diff = angle ? wrapPi(raw) : raw;
    const pairKey = `${sources.primary}|${key}`;
    // A baseline saved before per-pair statistics has no table: start one.
    if (!sources.pairs || typeof sources.pairs !== 'object') sources.pairs = {};
    let pair = sources.pairs[pairKey];
    if (!pair) {
      if (Object.keys(sources.pairs).length >= MAX_PAIRS) {
        // Full: make room by forgetting a pair learned under a former primary,
        // least recently compared first. Pairs of the current primary are
        // never given up for this, so repeated failovers cannot leave the
        // current sources unchecked.
        const stale = Object.entries(sources.pairs)
          .filter(([, item]) => item.primary !== sources.primary)
          .sort(([, a], [, b]) => (a.last ? a.last.at : 0) - (b.last ? b.last.at : 0))[0];
        if (!stale) return false;
        delete sources.pairs[stale[0]];
      }
      pair = createPair(sources.primary, key);
      sources.pairs[pairKey] = pair;
    }
    if (pair.signed !== true) resetPair(pair);
    // The departure from the learned offset, signed: B reading a volt above
    // A and then a volt below it is a two-volt change, not none.
    const residual = angle ? wrapPi(diff - pair.mean) : diff - pair.mean;
    pair.last = { at: t, diff, residual, source: key, value, primaryValue: primary.value, primary: sources.primary };
    // Learn the usual offset - a fixed calibration offset between two
    // compasses is normal - but not from an excursion, or the excursion
    // becomes normal.
    const scale = Math.max(Math.sqrt(pair.variance), scaleOf());
    const excursion = pair.n >= DISAGREE_MIN_SAMPLES && Math.abs(residual) / scale >= zClear;
    if (!excursion) {
      pair.n += 1;
      const alpha = Math.max(1 / pair.n, 0.01);
      pair.mean += alpha * residual;
      if (angle) pair.mean = wrapPi(pair.mean);
      pair.variance = (1 - alpha) * (pair.variance + alpha * residual * residual);
    }
  }
  return false;
}

/** Two sources further apart than they normally are. */
/**
 * The pair furthest beyond its own usual gap, among pairs with the current
 * primary. Pairs learned under an earlier primary are kept but not judged:
 * their gaps were measured against a different reference.
 */
function evaluateDisagree(sources, t, { scale, zWarn, zClear, zAlert, isOpen }) {
  let worst;
  for (const pair of Object.values(sources.pairs || {})) {
    if (pair.primary !== sources.primary || pair.n < DISAGREE_MIN_SAMPLES || !pair.last) continue;
    const spread = Math.max(Math.sqrt(pair.variance), scale);
    const departure = Math.abs(Number.isFinite(pair.last.residual) ? pair.last.residual : pair.last.diff - pair.mean);
    const z = departure / spread;
    const fresh = t - pair.last.at <= 30000;
    const candidate = { pair, z, fresh, departure };
    if (!worst || (candidate.fresh && (!worst.fresh || candidate.z > worst.z))) worst = candidate;
  }
  if (!worst) {
    return null;
  }
  const { pair, z, fresh, departure } = worst;
  return {
    active: fresh && z >= (isOpen ? zClear : zWarn) && departure >= 3 * scale,
    severity: z >= zAlert ? 'alert' : 'warn',
    evidence: { ...pair.last, usualGap: Math.abs(pair.mean), usualOffset: pair.mean, z }
  };
}

/** The primary went quiet and another source took over, held for a while. */
function evaluateFailover(sources, t, holdMs) {
  if (!sources.failover) {
    return null;
  }
  return {
    active: t - sources.failover.at < holdMs,
    severity: 'warn',
    evidence: { ...sources.failover }
  };
}

function sourceSummary(sources, t) {
  if (!sources) return undefined;
  return Object.entries(sources.entries).map(([name, entry]) => ({
    name,
    primary: name === sources.primary,
    samples: entry.n,
    lastSeenMsAgo: entry.at === undefined ? undefined : Math.max(0, t - entry.at)
  }));
}

module.exports = {
  createSourceState,
  evaluateDisagree,
  evaluateFailover,
  migratePairs,
  routeSample,
  sourceSummary
};
