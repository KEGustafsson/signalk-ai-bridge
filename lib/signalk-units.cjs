'use strict';

/**
 * Unit handling shared by every path that puts Signal K values in a prompt.
 *
 * Live values (bridge-service) and historical series (history-service) have to
 * agree: a speed over ground of 5.4 m/s and a course of 180 degrees in the same
 * JSON blob, where one of them silently stayed in radians, is worse than having
 * no history at all.
 */

function radiansToDegrees(value) {
  return Number((value * (180 / Math.PI)).toFixed(6));
}

// Signal K carries angles in radians, so these leaves are converted to degrees
// for the model. Matching is on the LAST segment only, and on a fixed list.
//
// The previous pattern matched any segment *starting with* one of these words,
// which under /i also matched a following "." - so every leaf beneath
// navigation.courseGreatCircle.* was treated as an angle. A nextPoint.distance
// of 1852 m was handed to the model as 106111.783658, and a latitude already in
// degrees was multiplied again. Anything ending in a non-angle unit is now
// excluded explicitly, because Signal K nests real angles under course* too
// (navigation.courseGreatCircle.bearingTrackTrue is radians; .distance is not).
const ANGLE_LEAF = new RegExp(
  '^(?:' +
    [
      'angle[A-Za-z0-9_]*',
      'heading[A-Za-z0-9_]*',
      'bearing[A-Za-z0-9_]*',
      'course[A-Za-z0-9_]*',
      'track[A-Za-z0-9_]*',
      'directionTrue',
      'directionMagnetic',
      'rateOfTurn',
      'roll',
      'pitch',
      'yaw',
      'set'
    ].join('|') +
    ')$'
);

// Leaves that live under an angle-ish parent but are emphatically not angles.
const NON_ANGLE_LEAF = /^(?:distance|velocityMadeGood|speed[A-Za-z0-9_]*|time[A-Za-z0-9_]*|latitude|longitude|altitude|crossTrackError|position)$/;

// An angle word is not always the first word of a camelCase leaf. Measured on
// this vessel: `sensors.headingHold.fusedHeading` is radians like every other
// heading, but ANGLE_LEAF anchors the word at the start, so 1.517299 rad
// reached the model unconverted and was reported as "1.517299 degrees" - a
// heading of 87 degrees read out as very nearly due north, in the same answer
// as a live snapshot that said 86.8.
//
// The word has to begin a camelCase segment (the preceding character is
// lower-case or a digit), so this matches fusedHeading, desiredHeading and
// targetBearing without matching a word that merely contains the letters.
// NON_ANGLE_LEAF is still consulted first, which is what keeps crossTrackError
// - a distance whose leaf ends in "TrackError" - out.
const ANGLE_SUFFIX_LEAF =
  /[a-z0-9](?:Angle|Heading|Bearing|Course|Track|Direction|Roll|Pitch|Yaw)[A-Za-z0-9_]*$/;

function isAnglePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }

  const leaf = path.slice(path.lastIndexOf('.') + 1);
  if (NON_ANGLE_LEAF.test(leaf)) {
    return false;
  }

  return ANGLE_LEAF.test(leaf) || ANGLE_SUFFIX_LEAF.test(leaf);
}

// Signal K carries temperatures in kelvin and speeds in metres per second, and
// neither is what an operator reads off a boat. They used to reach the model
// raw, with the system prompt asking it to convert - which it did, at the cost
// of tokens, and inconsistently: the same prompt also told it to convert
// radians to degrees, so it re-converted the attitude values this module had
// ALREADY converted and reported a yaw of 86.5 degrees as 495. Converting here
// makes the prompt's units a statement of fact rather than an instruction, and
// the model has no arithmetic left to get wrong.
const TEMPERATURE_LEAF = /^(?:[A-Za-z0-9_]*[Tt]emperature|dewPoint)$/;

// NON_ANGLE_LEAF already keeps every one of these off the angle path, so the
// two lists cannot both claim a leaf.
const SPEED_LEAF = /^(?:speed[A-Za-z0-9_]*|velocityMadeGood|gust)$/;

const KELVIN_OFFSET = 273.15;
const METRES_PER_SECOND_IN_KNOT = 0.514444;

function leafOf(path) {
  return typeof path === 'string' ? path.slice(path.lastIndexOf('.') + 1) : '';
}

function isTemperaturePath(path) {
  return TEMPERATURE_LEAF.test(leafOf(path));
}

function isSpeedPath(path) {
  return SPEED_LEAF.test(leafOf(path));
}

function convertAiValueForPath(path, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return value;
  }

  if (isAnglePath(path)) {
    return radiansToDegrees(value);
  }
  if (isTemperaturePath(path)) {
    return Number((value - KELVIN_OFFSET).toFixed(2));
  }
  if (isSpeedPath(path)) {
    return Number((value / METRES_PER_SECOND_IN_KNOT).toFixed(3));
  }

  return value;
}

/**
 * Mean of a set of directions, in degrees on [0, 360).
 *
 * The arithmetic mean of 350 and 10 is 180 - due south, for two headings a
 * few degrees either side of north. Directions live on a circle, so the mean
 * is taken there: each angle becomes a unit vector, the vectors are summed,
 * and the sum's direction is the answer (0 and 20 average to 10; 350 and 10
 * to 0). Returns undefined when the directions cancel out (e.g. 0 and 180),
 * where no single mean direction exists.
 */
function circularMeanDegrees(degrees) {
  let sumSin = 0;
  let sumCos = 0;
  for (const value of degrees) {
    const radians = value * (Math.PI / 180);
    sumSin += Math.sin(radians);
    sumCos += Math.cos(radians);
  }

  // Near-zero resultant: the directions are spread evenly around the circle
  // and atan2 would return noise dressed up as a bearing.
  if (Math.hypot(sumSin, sumCos) < 1e-9 * degrees.length) {
    return undefined;
  }

  const mean = Math.atan2(sumSin, sumCos) * (180 / Math.PI);
  return (mean + 360) % 360;
}

module.exports = {
  circularMeanDegrees,
  convertAiValueForPath,
  isAnglePath,
  isSpeedPath,
  isTemperaturePath,
  radiansToDegrees
};
