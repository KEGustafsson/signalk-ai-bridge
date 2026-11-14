'use strict';

/**
 * Small numeric helpers for the watch detectors.
 *
 * Everything here is O(1) per sample and allocation-free on the hot path: the
 * detectors run on every Signal K update for every watched path, on a board
 * whose CPU is also feeding the GPU.
 */

const LN2 = Math.LN2;
const EARTH_RADIUS_M = 6371008.8;
const METRES_PER_SECOND_IN_KNOT = 0.514444;

/**
 * Smoothing factor for an exponentially weighted average over irregular time.
 *
 * A fixed alpha assumes a fixed sample rate, and Signal K paths update at
 * anything from 10 Hz to once a minute. Deriving alpha from the elapsed time
 * and a half-life makes "the last 30 minutes" mean 30 minutes on every path.
 */
function timeAlpha(dtMs, halfLifeMs) {
  if (!(dtMs > 0) || !(halfLifeMs > 0)) {
    return 0;
  }
  return 1 - Math.exp((-dtMs * LN2) / halfLifeMs);
}

/** Wrap an angle in radians onto (-PI, PI]. */
function wrapPi(radians) {
  let value = radians % (2 * Math.PI);
  if (value <= -Math.PI) {
    value += 2 * Math.PI;
  } else if (value > Math.PI) {
    value -= 2 * Math.PI;
  }
  return value;
}

/** Great-circle distance in metres between two { latitude, longitude } in degrees. */
function haversineMetres(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Move a position by a distance along a true bearing (radians). Flat-earth is
 * plenty for the few kilometres dead reckoning is ever carried here.
 */
function offsetPosition(position, bearingRad, distanceM) {
  const north = distanceM * Math.cos(bearingRad);
  const east = distanceM * Math.sin(bearingRad);
  const latitude = position.latitude + (north / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.cos(position.latitude * (Math.PI / 180));
  const longitude =
    position.longitude + (Math.abs(cosLat) < 1e-9 ? 0 : (east / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI));
  return { latitude, longitude };
}

/**
 * Least-squares slope (units per millisecond) and R² of [t, v] points.
 * Returns undefined for fewer than three points or no spread in time.
 */
function linearTrend(points) {
  const n = points.length;
  if (n < 3) {
    return undefined;
  }
  let sumT = 0;
  let sumV = 0;
  for (const [t, v] of points) {
    sumT += t;
    sumV += v;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [t, v] of points) {
    const dt = t - meanT;
    const dv = v - meanV;
    sxx += dt * dt;
    sxy += dt * dv;
    syy += dv * dv;
  }
  if (sxx === 0) {
    return undefined;
  }
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2, intercept: meanV - slope * meanT, meanT };
}

/** A position from the shapes Signal K and history providers use, or undefined. */
function toPosition(value) {
  if (Array.isArray(value) && value.length >= 2) {
    // History providers commonly return GeoJSON order: [longitude, latitude].
    return toPosition({ longitude: value[0], latitude: value[1] });
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  // Number(null) and Number('') are 0: a receiver that loses its fix and
  // publishes nulls would otherwise be at 0° 0°, a "jump" across the planet.
  const isCoordinate = (component) =>
    (typeof component === 'number' && Number.isFinite(component)) ||
    (typeof component === 'string' && component.trim() !== '' && Number.isFinite(Number(component)));
  if (!isCoordinate(value.latitude) || !isCoordinate(value.longitude)) {
    return undefined;
  }
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return undefined;
  }
  return { latitude, longitude };
}

module.exports = {
  METRES_PER_SECOND_IN_KNOT,
  haversineMetres,
  linearTrend,
  offsetPosition,
  timeAlpha,
  toPosition,
  wrapPi
};
