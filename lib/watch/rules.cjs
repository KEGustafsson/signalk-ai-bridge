'use strict';

const { describePath, dimensionOf, formatValue } = require('./format.cjs');

/**
 * Operator watch rules: "tell me if the fridge gets warm while we are on
 * shore power", stored as data and evaluated deterministically.
 *
 * However a rule was written - by the parser, by a model, or by hand - what
 * runs is this small structure, checked here before it is stored and
 * evaluated here on every tick. A model never decides at run time whether a
 * rule fires; at most it helped write the rule once, and the operator
 * confirmed the plain-language reading of it.
 *
 *   { id, text, path, op, value?, forSeconds, when?: { path, op, value },
 *     severity, createdAt, source }
 *
 * `value` is in SI, like the data it is compared with.
 */

// `atLeast` / `atMost` are the inclusive forms (">=", "<="): "at least 12 V"
// holds at exactly 12 V, where "above 12 V" does not.
const OPS = ['above', 'below', 'atLeast', 'atMost', 'equals', 'notEquals', 'changes'];
const NUMERIC_OPS = new Set(['above', 'below', 'atLeast', 'atMost']);
const MAX_RULES = 50;
const MAX_TEXT = 300;
const STALE_MS = 5 * 60 * 1000;
const CHANGE_HOLD_MS = 10 * 60 * 1000;
// A "changes" rule with a duration needs the change held for at least that
// long, or it would expire before the engine's persistence let it fire: the
// hold is the duration plus this margin (a tick and the rule's own minimum
// persistence fit in it many times over), never less than CHANGE_HOLD_MS.
const CHANGE_HOLD_MARGIN_MS = 60 * 1000;

/** How long a change keeps a "changes" rule active. */
function changeHoldMs(rule) {
  return Math.max(CHANGE_HOLD_MS, (Number(rule && rule.forSeconds) || 0) * 1000 + CHANGE_HOLD_MARGIN_MS);
}

// Words a state is published or typed as, read the same as on and off: the
// parser stores "is running" as true, so a path publishing "running" (or
// "started", as propulsion.*.state does) must compare equal to it.
const TRUE_STATES = new Set(['true', 'on', 'running', 'started']);
const FALSE_STATES = new Set(['false', 'off', 'stopped']);

/** A typed or published state word as the boolean it stands for, or undefined. */
function stateAlias(word) {
  if (typeof word !== 'string') return undefined;
  const lower = word.trim().toLowerCase();
  if (TRUE_STATES.has(lower)) return true;
  if (FALSE_STATES.has(lower)) return false;
  return undefined;
}
const PATH_PATTERN = /^[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$:-]+)*$/;

function ruleError(message) {
  const error = new Error(message);
  error.code = 'validation-failed';
  return error;
}

function normalizeValue(op, value) {
  if (op === 'changes') return undefined;
  if (NUMERIC_OPS.has(op)) {
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw ruleError(`"${op}" needs a number to compare with.`);
    }
    return number;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 80) return value;
  if (value === null) return null;
  throw ruleError(`"${op}" needs a value to compare with.`);
}

function normalizeCondition(input, label) {
  if (!input || typeof input !== 'object') throw ruleError(`The ${label} is missing.`);
  const path = String(input.path || '').trim();
  if (!PATH_PATTERN.test(path) || path.length > 200 || path.startsWith('notifications')) {
    throw ruleError(`The ${label} needs a Signal K path.`);
  }
  const op = String(input.op || '');
  if (!OPS.includes(op)) throw ruleError(`The ${label} needs one of: ${OPS.join(', ')}.`);
  return { path, op, value: normalizeValue(op, input.value) };
}

function hasValidId(input) {
  return Boolean(input) && typeof input.id === 'string' && /^r-[a-z0-9-]{1,40}$/.test(input.id);
}

/** FNV-1a of a string, in base 36: short, stable, and not a secret. */
function contentHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** A rule as it will be stored and run, or a validation-failed error. */
function normalizeRule(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw ruleError('A rule must be an object.');
  const main = normalizeCondition(input, 'rule');
  const when = input.when ? normalizeCondition(input.when, 'condition after "while"') : undefined;
  if (when && when.op === 'changes') throw ruleError('A "while" condition cannot be "changes".');
  const forSeconds = Math.round(Math.min(24 * 3600, Math.max(0, Number(input.forSeconds) || 0)));
  // A rule without a valid id (hand-edited options, a restored backup) gets
  // one derived from what it says, so it is the same id every time it is
  // read - and can be removed by the id the panel showed.
  const id =
    typeof input.id === 'string' && /^r-[a-z0-9-]{1,40}$/.test(input.id)
      ? input.id
      : `r-${contentHash(
          JSON.stringify([main, when || null, input.text || '', input.severity || '', forSeconds, input.source || ''])
        )}`;
  return {
    id,
    text: String(input.text || '').slice(0, MAX_TEXT),
    ...main,
    forSeconds,
    ...(when ? { when } : {}),
    severity: input.severity === 'alert' ? 'alert' : 'warn',
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    source: ['parser', 'model', 'manual'].includes(input.source) ? input.source : 'manual'
  };
}

/** Stored rules, keeping the valid ones. */
function normalizeRules(list) {
  if (!Array.isArray(list)) return [];
  // Two passes, so the result does not depend on the order: ids that were
  // given are reserved first (a later duplicate becomes -2, -3 - two rules
  // sharing an id would share one finding and one memory, and one of them
  // would never be reported), then derived ids are numbered around them.
  const normalized = [];
  for (const item of list.slice(0, MAX_RULES)) {
    try {
      const rule = normalizeRule(item, Number.isFinite(item && item.createdAt) ? item.createdAt : Date.now());
      normalized.push({ rule, given: hasValidId(item) });
    } catch {
      // A rule that no longer validates is dropped rather than run wrongly.
    }
  }
  const ids = new Set();
  const take = (rule) => {
    let id = rule.id;
    for (let copy = 2; ids.has(id); copy += 1) id = `${rule.id.slice(0, 36)}-${copy}`;
    ids.add(id);
    return id === rule.id ? rule : { ...rule, id };
  };
  const out = new Array(normalized.length);
  normalized.forEach((entry, index) => {
    if (entry.given) out[index] = take(entry.rule);
  });
  normalized.forEach((entry, index) => {
    if (!entry.given) out[index] = take(entry.rule);
  });
  return out;
}

function compare(op, actual, expected) {
  switch (op) {
    case 'above':
      return typeof actual === 'number' && actual > expected;
    case 'below':
      return typeof actual === 'number' && actual < expected;
    case 'atLeast':
      return typeof actual === 'number' && actual >= expected;
    case 'atMost':
      return typeof actual === 'number' && actual <= expected;
    case 'equals':
      return looseEquals(actual, expected);
    case 'notEquals':
      return !looseEquals(actual, expected);
    default:
      return false;
  }
}

// "pump is on" stored as true, data published as 1, "on" or "running": all
// the same - the same aliases the parser reads (stateAlias).
function looseEquals(actual, expected) {
  const norm = (value) => {
    if (value === true || value === 1) return 'true';
    if (value === false || value === 0) return 'false';
    if (typeof value !== 'string') return value;
    const alias = stateAlias(value);
    return alias === undefined ? value.toLowerCase() : String(alias);
  };
  return norm(actual) === norm(expected);
}

/**
 * The rule's condition right now, for the engine's tracker: active or not,
 * or null when it cannot be judged (no data yet, data stale, guard unmet).
 * `latest(path)` returns `{ value, at }` or undefined; `memory` is the rule's
 * own state between ticks.
 */
function evaluateRule(rule, latest, t, memory) {
  const current = latest(rule.path);
  if (!current || t - current.at > STALE_MS) return null;
  if (rule.when) {
    const guard = latest(rule.when.path);
    // No guard data, or none for five minutes: the condition is unknown, not
    // false. Nothing is judged and nothing is forgotten, so a change made
    // meanwhile is still reported once the guard is heard from again (a guard
    // published only when it changes may be quiet for hours).
    if (!guard || t - guard.at > STALE_MS) {
      // A change already reported is done with: the null closes its finding,
      // and the guard coming back must not open it a second time.
      if (memory.reported !== undefined && memory.reported === memory.changedAt) {
        memory.changedAt = undefined;
      }
      // A change not yet reported waits for the guard: its hold does not run
      // while the guard is unheard from, however long that is.
      if (memory.changedAt !== undefined && memory.pausedAt === undefined) {
        memory.pausedAt = t;
      }
      return null;
    }
    if (memory.pausedAt !== undefined) {
      if (memory.changedAt !== undefined) memory.changedAt += t - memory.pausedAt;
      memory.pausedAt = undefined;
    }
    if (!compare(rule.when.op, guard.value, rule.when.value)) {
      // The guard is known to be false: the rule keeps up with the value, so
      // a change made while it did not apply is not reported later as new.
      if (rule.op === 'changes') {
        memory.last = current.value;
        memory.seen = current.changes;
        memory.changedAt = undefined;
      }
      return null;
    }
  }
  let active;
  if (rule.op === 'changes') {
    // `changes` counts the transitions the engine saw on ingest: a value that
    // went false -> true -> false between two ticks looks unchanged here, but
    // it did change. Without a count (a plain `{ value, at }`), the values
    // decide.
    const counted = Number.isFinite(current.changes) && Number.isFinite(memory.seen);
    const changed =
      memory.last !== undefined &&
      (!looseEquals(memory.last, current.value) || (counted && current.changes !== memory.seen));
    if (changed) {
      memory.changedAt = t;
      memory.from = memory.last;
    }
    memory.last = current.value;
    memory.seen = current.changes;
    active = memory.changedAt !== undefined && t - memory.changedAt < changeHoldMs(rule);
  } else {
    active = compare(rule.op, current.value, rule.value);
  }
  return {
    active,
    severity: rule.severity,
    evidence: { value: current.value, from: memory.from, rule }
  };
}

/**
 * Why a condition can never be met, or undefined. A word or on/off is a value
 * only on a path that has states: "becomes warm" or "switches on" on a
 * temperature would store an equality the number never meets - a watch that
 * never fires. A path whose data is already a word or a flag has states,
 * whatever its name suggests.
 */
function measuredValueError(condition, units, currentValue) {
  if (condition.op !== 'equals' && condition.op !== 'notEquals') return undefined;
  if (typeof condition.value !== 'string' && typeof condition.value !== 'boolean') return undefined;
  // A flag is on or off: any other word never matches it, so a watch for
  // "is high" on one would never fire (or always, for "is not").
  if (typeof currentValue === 'boolean' && typeof condition.value === 'string' && stateAlias(condition.value) === undefined) {
    return `${condition.path} is on or off, so "${condition.value}" is not one of its values. Say "is on" or "is off".`;
  }
  // A word or a flag already seen on the path: it has states. (An object or
  // array value says nothing either way; the name decides, as without data.)
  if (typeof currentValue === 'string' || typeof currentValue === 'boolean') return undefined;
  // A .state/.mode/.status leaf has states whatever its units say.
  if (/\.(?:state|mode|status)$/i.test(String(condition.path))) return undefined;
  if (dimensionOf(condition.path, units) === 'number') return undefined;
  const word = typeof condition.value === 'boolean' ? (condition.value ? 'on' : 'off') : condition.value;
  return (
    `${condition.path} is a measurement, so "${word}" is not one of its values. ` +
    'Give a number, for example "above 8 °C" or "below 12.2 V". Unusual values are already watched without a rule.'
  );
}

const OP_WORDS = {
  above: 'is above',
  below: 'is below',
  atLeast: 'is at least',
  atMost: 'is at most',
  equals: 'is',
  notEquals: 'is not',
  changes: 'changes'
};

function describeValue(path, value, info) {
  if (typeof value === 'number') return formatValue(path, value, info && info.units);
  if (value === true) return 'on';
  if (value === false) return 'off';
  return `"${value}"`;
}

function describeCondition(condition, infoFor) {
  const info = infoFor(condition.path) || {};
  const name = describePath(condition.path, info.displayName);
  const value = condition.op === 'changes' ? '' : ` ${describeValue(condition.path, condition.value, info)}`;
  return `${name} ${OP_WORDS[condition.op]}${value}`;
}

/**
 * The rule read back in plain words, for the operator to confirm before it
 * is stored: "Alert when Main engine temperature is above 95.0 °C for 1 min,
 * only while Main engine revolutions is above 0 rpm".
 */
function describeRule(rule, infoFor = () => undefined) {
  const duration =
    rule.forSeconds >= 120
      ? ` for ${Math.round(rule.forSeconds / 60)} min`
      : rule.forSeconds > 0
        ? ` for ${rule.forSeconds} s`
        : '';
  const guard = rule.when ? `, only while ${describeCondition(rule.when, infoFor)}` : '';
  return `${rule.severity === 'alert' ? 'Alert' : 'Warn'} when ${describeCondition(rule, infoFor)}${duration}${guard}`;
}

module.exports = {
  MAX_RULES,
  NUMERIC_OPS,
  OPS,
  changeHoldMs,
  compare,
  describeRule,
  describeValue,
  evaluateRule,
  hasValidId,
  measuredValueError,
  looseEquals,
  normalizeRule,
  normalizeRules,
  stateAlias
};
