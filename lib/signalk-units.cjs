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

function isAnglePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }

  const leaf = path.slice(path.lastIndexOf('.') + 1);
  if (NON_ANGLE_LEAF.test(leaf)) {
    return false;
  }

  return ANGLE_LEAF.test(leaf);
}

function convertAiValueForPath(path, value) {
  if (!isAnglePath(path)) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return radiansToDegrees(value);
  }

  return value;
}

module.exports = {
  convertAiValueForPath,
  isAnglePath,
  radiansToDegrees
};
