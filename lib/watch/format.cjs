'use strict';

const { isAnglePath, isSpeedPath, isTemperaturePath } = require('../signalk-units.cjs');

/**
 * Operator-unit formatting for watch messages.
 *
 * Incident text is built from templates, not generated: every number in it is
 * the number the detector measured, so there is nothing for a model to get
 * wrong and nothing to verify. The unit comes from the path's own `meta.units`
 * when the server knows it, and from the same leaf-name rules the prompt uses
 * when it does not.
 */

const KELVIN_OFFSET = 273.15;

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The display unit for a path: a function from SI to display value, and its label. */
/**
 * The Signal K unit a leaf name implies, for paths whose source published no
 * metadata. Signal K fixes the unit per path in its specification, so the
 * leaf name is a reliable guess for the common ones.
 */
function inferUnits(leaf) {
  if (leaf === 'voltage') return 'V';
  if (leaf === 'current') return 'A';
  if (leaf === 'power') return 'W';
  if (/[Pp]ressure$/.test(leaf)) return 'Pa';
  if (leaf === 'revolutions') return 'Hz';
  if (leaf === 'fuelRate' || leaf === 'rate') return 'm3/s';
  return undefined;
}

function displayUnit(path, units) {
  const leaf = String(path || '').slice(String(path || '').lastIndexOf('.') + 1);
  const unit = typeof units === 'string' ? units : inferUnits(leaf);

  if (unit === 'rad' || (!unit && isAnglePath(path))) {
    if (leaf === 'rateOfTurn') {
      return { convert: (v) => v * (180 / Math.PI) * 60, label: '°/min', decimals: 1, delta: (v) => v * (180 / Math.PI) * 60 };
    }
    return { convert: (v) => v * (180 / Math.PI), label: '°', decimals: 1, delta: (v) => v * (180 / Math.PI) };
  }
  if (unit === 'K' || (!unit && isTemperaturePath(path))) {
    return { convert: (v) => v - KELVIN_OFFSET, label: '°C', decimals: 1, delta: (v) => v };
  }
  if (unit === 'm/s' || (!unit && isSpeedPath(path))) {
    return { convert: (v) => v / 0.514444, label: 'kn', decimals: 2, delta: (v) => v / 0.514444 };
  }
  if (unit === 'Pa') {
    return { convert: (v) => v / 100, label: 'hPa', decimals: 1, delta: (v) => v / 100 };
  }
  if (unit === 'ratio' || (!unit && /^(?:stateOfCharge|currentLevel|relativeHumidity|stateOfHealth)$/.test(leaf))) {
    return { convert: (v) => v * 100, label: '%', decimals: 1, delta: (v) => v * 100 };
  }
  if (unit === 'Hz' && leaf === 'revolutions') {
    return { convert: (v) => v * 60, label: 'rpm', decimals: 0, delta: (v) => v * 60 };
  }
  if (unit === 'm3/s') {
    return { convert: (v) => v * 3.6e6, label: 'L/h', decimals: 1, delta: (v) => v * 3.6e6 };
  }
  if (unit === 'm3') {
    return { convert: (v) => v * 1000, label: 'L', decimals: 0, delta: (v) => v * 1000 };
  }
  if (unit) {
    return { convert: (v) => v, label: unit, decimals: 2, delta: (v) => v };
  }
  return { convert: (v) => v, label: '', decimals: 3, delta: (v) => v };
}

/** `92.0 °C`, `13.2 V`, `41 %`: a value on a path in the operator's unit. */
function formatValue(path, value, units) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }
  const unit = displayUnit(path, units);
  let display = unit.convert(value);
  if (unit.label === '°' && !/rateOfTurn$/.test(path)) {
    display = ((display % 360) + 360) % 360;
  }
  const text = roundTo(display, unit.decimals).toFixed(unit.decimals);
  return unit.label ? `${text} ${unit.label}` : text;
}

/** A difference on a path (no offset applied), e.g. `+3.2 °C`. */
function formatDelta(path, delta, units, { signed = true } = {}) {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    return String(delta);
  }
  const unit = displayUnit(path, units);
  const display = unit.delta(delta);
  const text = roundTo(Math.abs(display), unit.decimals).toFixed(unit.decimals);
  const sign = signed ? (display >= 0 ? '+' : '−') : '';
  return unit.label ? `${sign}${text} ${unit.label}` : `${sign}${text}`;
}

/** `12 s`, `4 min`, `2.5 h`. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'unknown';
  }
  const seconds = ms / 1000;
  if (seconds < 90) {
    return `${Math.round(seconds)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 90) {
    return `${Math.round(minutes)} min`;
  }
  const hours = minutes / 60;
  if (hours < 48) {
    return `${roundTo(hours, 1)} h`;
  }
  return `${roundTo(hours / 24, 1)} d`;
}

function words(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s.]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

// The Signal K branches with an instance id in a fixed place, and the noun an
// operator would use for one: `electrical.batteries.house.voltage` reads as
// "House battery voltage", not "Electrical batteries house voltage".
const NAMED_INSTANCES = [
  [/^electrical\.batteries\.([^.]+)\.(.+)$/, 'battery'],
  [/^electrical\.alternators\.([^.]+)\.(.+)$/, 'alternator'],
  [/^electrical\.chargers\.([^.]+)\.(.+)$/, 'charger'],
  [/^electrical\.inverters\.([^.]+)\.(.+)$/, 'inverter'],
  [/^electrical\.solar\.([^.]+)\.(.+)$/, 'solar'],
  [/^propulsion\.([^.]+)\.(.+)$/, 'engine'],
  [/^tanks\.([^.]+)\.([^.]+)\.(.+)$/, 'tank'],
  [/^environment\.inside\.([^.]+)\.(.+)$/, ''],
  [/^environment\.(outside|water)\.(.+)$/, '']
];

/**
 * `electrical.batteries.house.voltage` -> `House battery voltage`, or the
 * path's own meta.displayName when its source published one.
 */
function describePath(path, displayName) {
  if (typeof displayName === 'string' && displayName.trim().length > 0) {
    return displayName.trim();
  }
  const text = String(path || '');
  let parts;
  for (const [pattern, noun] of NAMED_INSTANCES) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (noun === 'tank') {
      // tanks.freshWater.main.currentLevel -> "Fresh water tank main current level"
      const instance = /^\d+$/.test(match[2]) || match[2] === 'main' || match[2] === 'default' ? [] : words(match[2]);
      parts = [...words(match[1]), 'tank', ...instance, ...words(match[3])];
    } else {
      const instance = /^\d+$/.test(match[1]) ? [noun, match[1]] : [...words(match[1]), ...(noun ? [noun] : [])];
      parts = [...instance, ...words(match[2])];
    }
    break;
  }
  if (!parts) {
    parts = words(text);
  }
  if (parts.length === 0) {
    return text;
  }
  const joined = parts.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

module.exports = {
  describePath,
  displayUnit,
  formatDelta,
  formatDuration,
  formatValue
};
