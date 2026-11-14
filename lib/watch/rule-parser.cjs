'use strict';

const { dimensionOf, fromDisplay, parseOperatorUnit } = require('./format.cjs');
const { NUMERIC_OPS, measuredValueError, stateAlias } = require('./rules.cjs');

/**
 * Plain language -> watch rule, without a language model.
 *
 * Most of what an operator asks for has the same shape - a thing, a
 * comparison, a number with a unit, maybe a duration and a "while" - and a
 * parser handles that shape exactly, instantly and on any hardware. Only
 * what it cannot parse goes to a model (rule-assist.cjs), and only if the
 * operator has allowed that. The vocabulary below is for picking the path:
 * the operator says "coolant" and "fridge", the data says
 * `propulsion.main.temperature` and `environment.inside.refrigerator.temperature`.
 */

const SYNONYMS = {
  // Not 'engine': that would tie coolant with the engine-room air sensor.
  coolant: ['temperature', 'propulsion', 'coolant'],
  engine: ['propulsion', 'engine'],
  motor: ['propulsion', 'engine'],
  genset: ['generator'],
  temp: ['temperature'],
  hot: ['temperature'],
  warm: ['temperature'],
  cold: ['temperature'],
  fridge: ['refrigerator', 'fridge'],
  battery: ['batteries', 'battery'],
  batt: ['batteries', 'battery'],
  volt: ['voltage'],
  amp: ['current'],
  soc: ['stateofcharge'],
  charge: ['stateofcharge'],
  rpm: ['revolutions'],
  rev: ['revolutions'],
  tank: ['tanks'],
  fresh: ['freshwater'],
  level: ['currentlevel'],
  depth: ['depth', 'belowtransducer', 'belowkeel', 'belowsurface'],
  sog: ['speedoverground'],
  stw: ['speedthroughwater'],
  log: ['speedthroughwater'],
  sea: ['water'],
  cabin: ['inside'],
  saloon: ['inside'],
  salon: ['inside'],
  ambient: ['outside'],
  air: ['outside'],
  baro: ['outside', 'pressure'],
  barometer: ['outside', 'pressure'],
  humid: ['relativehumidity', 'humidity'],
  humidity: ['relativehumidity'],
  alternator: ['alternators', 'alternator'],
  inverter: ['inverters', 'inverter'],
  charger: ['chargers', 'charger'],
  shore: ['shore', 'ac'],
  gps: ['position', 'gnss'],
  wind: ['wind'],
  boat: [],
  vessel: []
};

const FILLER = new Set([
  'the', 'my', 'our', 'a', 'an', 'of', 'in', 'on', 'at', 'is', 'are', 'gets', 'get', 'goes', 'go', 'reads',
  'stays', 'becomes', 'value', 'reading', 'please', 'me', 'us', 'know', 'tell', 'warn', 'alert', 'notify',
  'let', 'if', 'when', 'whenever', 'watch', 'monitor', 'for', 'it', 'there', 'than', 'to', 'and', 'any',
  'rises', 'climbs', 'drops', 'falls', 'too', 'very', 'ever', 'something', 'happens', 'alarm', 'urgent',
  // Urgency and delivery words (the urgency is read from the whole request)
  // and harmless adverbs: said after a comparison, they add no condition.
  'critical', 'emergency', 'immediately', 'now', 'right', 'away', 'asap', 'again', 'then', 'send', 'sound',
  'raise', 'notification', 'notifications', 'message', 'quickly', 'straight', 'continuously', 'thanks',
  'thank', 'you', 'all', 'up'
]);

// The unit is whatever word follows the number; whether it is a unit the
// watch can convert is decided after the match (parseClause), so an unknown
// one ("30 cm") is refused rather than read as no unit at all.
const NUMERIC_COMPARATOR =
  /(?:^|\s)(?:is|are|gets|goes|rises|climbs|drops|falls|reads|stays|becomes|runs)?\s*(at least|at most|no less than|no more than|not less than|not more than|above|over|higher than|more than|greater than|exceeds?|exceeding|hotter than|warmer than|faster than|below|under|lower than|less than|colder than|cooler than|slower than|>=|<=|≥|≤|>|<)\s*(-?\d+(?:[.,]\d+)?)\s*([°º]\s*(?:celsius|fahrenheit|[cf]\b)|deg(?:rees)?(?:\s*(?:celsius|fahrenheit|[cf]\b))?|nautical\s+miles?|per\s+cent|[a-z%/]+)?/;

const STATE_COMPARATOR =
  /(?:^|\s)(?:(is not|isn't|is no longer)|(?:is|turns|switches|goes|becomes|changes to|equals|=|==|runs|starts|stops))\s*(on|off|true|false|running|stopped|"[^"]+"|'[^']+')?(?=\s|$)/;

// Verbs that name the state they lead to, so any one word may follow:
// "switches to standby", "changes to fault", "becomes charging".
const TARGET_COMPARATOR =
  /(?:^|\s)(?:(is not|isn't|is no longer)\s+)?(?:changes to|switches to|turns to|becomes|equals|==|=)\s*("[^"]+"|'[^']+'|[a-z][a-z0-9_-]*)(?=\s|$)/;

// The longer forms first, or "changes" would match and leave "state" over.
const CHANGE_COMPARATOR =
  /(?:^|\s)((?:changes|switches)\s+(?:its\s+)?(?:state|mode|status|value)|changes|switches|toggles|flips)(?=\s|$)/;

const GUARD_SPLIT = /\s*,?\s*\b(?:(?:(?:and|but)\s+)?only\s+(?:while|whilst|when|if)|(?:and|but)\s+(?:while|whilst|when|if)|as long as|while|whilst|when|if)\b\s*/;

// "On the house bank", "in the main engine": words after the comparison that
// narrow the subject rather than add a condition. They are tried as part of
// the subject, and the path picked must answer to at least one of them.
const QUALIFIER = /^(?:on|in|at|of|for|from)\s+\S/;

function stem(word) {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function splitWords(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The words a path answers to: its segments, camelCase parts, joined forms and display name. */
function pathTokens(path, displayName) {
  const tokens = new Set();
  for (const segment of String(path).split('.')) {
    const lower = segment.toLowerCase();
    tokens.add(stem(lower));
    for (const word of splitWords(segment)) tokens.add(stem(word));
  }
  for (const word of splitWords(displayName)) tokens.add(stem(word));
  return tokens;
}

/** The subject's words, each with its synonyms, filler removed. */
function subjectTerms(subject) {
  const terms = [];
  for (const raw of splitWords(subject)) {
    const word = stem(raw);
    if (FILLER.has(raw) || FILLER.has(word)) continue;
    const synonyms = SYNONYMS[word] || SYNONYMS[raw];
    terms.push({ word, alternatives: [word, ...(synonyms || []).map(stem)] });
  }
  return terms;
}

/**
 * Candidate paths for a subject, best first: `{ path, score, coverage }`.
 * `dimension`, when the operator typed a unit, rules out paths that cannot
 * carry it - "above 95 °C" cannot be a voltage.
 */
function rankPaths(subject, candidates, dimension) {
  const terms = subjectTerms(subject);
  if (terms.length === 0) return [];
  const ranked = [];
  for (const candidate of candidates) {
    const pathDimension = dimensionOf(candidate.path, candidate.units);
    if (dimension && pathDimension !== 'number' && pathDimension !== dimension) continue;
    const tokens = pathTokens(candidate.path, candidate.displayName);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      // The best single match counts in full, each further synonym it also
      // matches adds a little: "coolant" fits a path that is both engine and
      // temperature better than one that is only engine.
      const hits = [];
      term.alternatives.forEach((alternative, index) => {
        if (tokens.has(alternative)) {
          hits.push(index === 0 ? 2 : 1.5);
        } else if (alternative.length >= 4) {
          for (const token of tokens) {
            if (token.length >= 4 && (token.startsWith(alternative) || alternative.startsWith(token))) {
              hits.push(1);
              break;
            }
          }
        }
      });
      if (hits.length === 0) continue;
      hits.sort((a, b) => b - a);
      matched += 1;
      score += hits[0] + 0.75 * (new Set(hits.slice(1)).size > 0 ? Math.min(2, hits.length - 1) : 0);
    }
    if (score === 0) continue;
    if (dimension && pathDimension === dimension) score += 1.5;
    if (candidate.role === 'watching' || candidate.role === 'learning') score += 0.3;
    // Prefer the path that says the least beyond what was asked: every
    // segment after the root that no word of the request accounts for costs
    // a little, so "cabin temp" is the cabin and not the fridge in the cabin.
    const asked = new Set(terms.flatMap((term) => term.alternatives));
    const unexplained = String(candidate.path)
      .split('.')
      .slice(1)
      .filter((segment) => !splitWords(segment).some((word) => asked.has(stem(word))) && !asked.has(stem(segment.toLowerCase())));
    score -= 0.5 * unexplained.length;
    ranked.push({ path: candidate.path, score: Number(score.toFixed(2)), coverage: matched / terms.length });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return ranked;
}

function pickPath(subject, candidates, dimension) {
  const ranked = rankPaths(subject, candidates, dimension);
  const [best, second] = ranked;
  // A short subject ("rpm") scores low but can still be unambiguous: every
  // word of it matched and nothing else comes close.
  const strong = best && (best.score >= 2 ? best.coverage >= 0.5 : best.score >= 1 && best.coverage === 1);
  const confident = strong && (!second || best.score - second.score >= 0.5);
  return { path: confident ? best.path : undefined, alternatives: ranked.slice(0, 6) };
}

function parseNumber(text) {
  return Number(String(text).replace(',', '.'));
}

const AT_LEAST = /^(?:at least|no less than|not less than|>=|≥)$/;
const AT_MOST = /^(?:at most|no more than|not more than|<=|≤)$/;
const ABOVE = /^(?:above|over|higher than|more than|greater than|exceeds?|exceeding|hotter than|warmer than|faster than|>)$/;

function numericOp(word) {
  if (AT_LEAST.test(word)) return 'atLeast';
  if (AT_MOST.test(word)) return 'atMost';
  return ABOVE.test(word) ? 'above' : 'below';
}

// Words that join two conditions in one clause. A rule compares one thing
// (plus one "while"), so "coolant above 95 °C and battery below 12 V" is
// refused, not stored as the coolant half.
const JOINER = /\s+(and|or|but)\s+/;

/**
 * One clause -> `{ subject, op, value?, unit? }`, `{ error, terminal? }` for
 * a clause that says more than a rule can hold, or undefined.
 */
function parseClause(input) {
  // Punctuation is not part of a comparison ("switches on, please" read as a
  // bare "switches" before): commas, semicolons and stops become spaces,
  // except inside a number ("12,2 V", "13.5 V").
  // A quoted state is taken as it is written ("a.b").
  const clause = String(input)
    .split(/("[^"]*"|'[^']*')/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/(?<!\d)[,;!?]+|[,;!?]+(?!\d)/g, ' ').replace(/\.(?!\d)/g, ' ')
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  // "Switches on and off", "turns off or on", "starts and stops": both
  // states named, so the operator means any change, not one of them. Read
  // before the joiners, which would otherwise split it into two conditions.
  const both =
    /(?:^|\s)(?:(?:switches|turns|goes|cycles)\s+(?:on\s*(?:\s(?:and|or)\s|\/)\s*off|off\s*(?:\s(?:and|or)\s|\/)\s*on)|starts\s+(?:and|or|then)\s+stops|stops\s+(?:and|or|then)\s+starts)(?=\s|$)/.exec(
      clause
    );
  if (both) {
    return leftoverOf(clause, both) || { subject: clause.slice(0, both.index), op: 'changes' };
  }
  if (JOINER.test(clause)) {
    const joiner = JOINER.exec(clause)[1];
    const parts = clause.split(JOINER).filter((part, index) => index % 2 === 0);
    const readParts = parts.map((part) => ({ part, parsed: parseClause(part) })).filter((item) => item.parsed && !item.parsed.error);
    const read = readParts.map((item) => item.part);
    // "Coolant above 95 °C and the shore power is on": a condition and
    // another thing's state is what "while" holds. Not read as that here -
    // the operator may have meant two watches - but not refused for good
    // either: the hint says how, and a model may read it.
    if (
      joiner === 'and' &&
      parts.length === 2 &&
      readParts.length === 2 &&
      subjectTerms(readParts[0].parsed.subject || '').length > 0 &&
      subjectTerms(readParts[1].parsed.subject || '').length > 0
    ) {
      return {
        andParts: read,
        error:
          `A watch checks one condition, plus at most one "while"; this joins two with "and". ` +
          `To watch the first only while the second holds, say "${read[0].trim()} while ${read[1].trim()}"; ` +
          'for either of them, add a separate watch for each.'
      };
    }
    if (read.length > 1) {
      return {
        // Terminal: a model would have to drop one of them too.
        terminal: true,
        error:
          `A watch checks one condition, plus at most one "while"; this joins ${read.length} with "${joiner}" ` +
          `(${read.map((part) => `"${part.trim()}"`).join(', ')}). Add a separate watch for each.`
      };
    }
  }
  const numeric = NUMERIC_COMPARATOR.exec(clause);
  if (numeric) {
    const typed = numeric[3];
    const known = typed && parseOperatorUnit(typed) ? typed : undefined;
    // Everything after the comparison must be accounted for: an unknown unit
    // or further words are refused, not dropped.
    const end = numeric.index + numeric[0].length - (typed && !known ? typed.length : 0);
    const rest = clause.slice(end).trim();
    const result = {
      subject: clause.slice(0, numeric.index),
      op: numericOp(numeric[1]),
      number: parseNumber(numeric[2]),
      unit: known
    };
    if (rest && subjectTerms(rest).length > 0) {
      // A lone unknown word after the number is taken for a unit ("30 cm").
      if (typed && !known && rest === typed) {
        return {
          error:
            `Could not read "${typed}" after "${numeric[2]}": it is not a unit the watch can convert. Use one it knows (°C, °F, K, V, A, W, kW, %, ` +
            'kn, m/s, rpm, Hz, hPa, mbar, kPa, bar, psi, Pa, m, ft, nm, L, L/h), or leave the unit out to use the one shown for the path.'
        };
      }
      if (!typed || known) {
        if (QUALIFIER.test(rest)) return { ...result, qualifier: rest };
      }
      const comparison = `${numeric[1]} ${numeric[2]}${known ? ` ${known.trim()}` : ''}`;
      return { error: `Could not read "${rest}" after "${comparison}". A watch compares one value; say only what it should be.` };
    }
    return result;
  }
  // States and changes, like numbers, must account for the whole clause:
  // "switches on during rough weather" is refused, not stored as "switches on".
  const leftover = (match) => leftoverOf(clause, match);
  // A named target state comes before the bare "changes": "switches on" and
  // "changes to fault" say which state, and reading them as "changes" lost it.
  // A leftover qualifier ("on the house bank") is kept with the clause.
  const withRest = (match, clauseResult) => {
    const rest = leftover(match);
    if (!rest) return clauseResult;
    return rest.qualifier ? { ...clauseResult, qualifier: rest.qualifier } : rest;
  };
  const target = TARGET_COMPARATOR.exec(clause);
  if (target) {
    return withRest(target, toStateClause(clause.slice(0, target.index), Boolean(target[1]), target[2]));
  }
  const state = STATE_COMPARATOR.exec(clause);
  if (state && state[2]) {
    return withRest(state, toStateClause(clause.slice(0, state.index), Boolean(state[1]), state[2]));
  }
  const change = CHANGE_COMPARATOR.exec(clause);
  if (change) {
    return withRest(change, { subject: clause.slice(0, change.index), op: 'changes' });
  }
  if (state) {
    // "the bilge pump runs", "the generator starts"
    const verb = state[0].trim().split(/\s+/)[0];
    const raw = verb === 'runs' || verb === 'starts' ? 'on' : verb === 'stops' ? 'off' : undefined;
    if (raw) return withRest(state, toStateClause(clause.slice(0, state.index), Boolean(state[1]), raw));
  }
  return undefined;
}

/**
 * What follows a state or change in `clause`: undefined for nothing (or only
 * filler), `{ qualifier }` for words that may narrow the subject, else an
 * error naming the words.
 */
function leftoverOf(clause, match) {
  const rest = clause.slice(match.index + match[0].length).trim();
  if (!rest || subjectTerms(rest).length === 0) return undefined;
  if (QUALIFIER.test(rest)) return { qualifier: rest };
  return {
    error: `Could not read "${rest}" after "${match[0].trim()}". A watch checks one state or change; say only what it should be.`
  };
}

// Words that say what kind of thing the qualifier names, not which one:
// "the house bank", "the port side unit".
const GENERIC_QUALIFIER = new Set(['bank', 'side', 'unit', 'system', 'circuit', 'sensor', 'one']);

/** Whether the path answers to every word of the qualifier that names something. */
function qualifierMatches(qualifier, path, candidates) {
  const info = candidates.find((candidate) => candidate.path === path) || {};
  const tokens = pathTokens(path, info.displayName);
  const terms = subjectTerms(qualifier).filter((term) => !GENERIC_QUALIFIER.has(term.word));
  return terms.length > 0 && terms.every((term) => term.alternatives.some((word) => tokens.has(word)));
}

/** `{ subject, op: equals|notEquals, value }` for a state named in words. */
function toStateClause(subject, negated, raw) {
  const unquoted = raw.replace(/^["']|["']$/g, '').trim();
  // The same aliases the comparison reads (rules.cjs), so "is running" stored
  // as true matches a path that publishes "running".
  const alias = stateAlias(unquoted);
  const value = alias === undefined ? unquoted : alias;
  return { subject, op: negated ? 'notEquals' : 'equals', value };
}

/**
 * Parse one request against the paths this vessel publishes.
 *
 * Returns `{ ok: true, rule }` with values in SI, or `{ ok: false, reason,
 * alternatives? }` explaining what it could not settle - which is also what
 * the model, if allowed, is asked to settle. `forcePath` pins the main
 * subject to a path the operator picked from the alternatives.
 */
function parseRule(text, candidates, options = {}) {
  const original = String(text || '').trim();
  // A quoted state is one value, whatever it holds: "fault, low", "low
  // while charging". Each is set aside while the request is read - so
  // neither its punctuation nor a "while" or "and" inside it is taken as
  // part of the sentence - and put back in the result as written.
  const quoted = [];
  const masked = original.replace(/"[^"]*"|'[^']*'/g, (span) => {
    quoted.push(span);
    return `"${QUOTE_MARK}${quoted.length - 1}${QUOTE_MARK}"`;
  });
  if (quoted.length === 0) return parseRuleText(original, original, candidates, options);
  const inner = (span) => span.slice(1, -1).trim();
  const restoreText = (value) =>
    value
      .replace(QUOTED_PLACEHOLDER, (all, index) => quoted[Number(index)])
      .replace(BARE_PLACEHOLDER, (all, index) => inner(quoted[Number(index)]));
  const restoreValue = (value) => {
    if (typeof value !== 'string') return value;
    const whole = new RegExp(`^${QUOTE_MARK}(\\d+)${QUOTE_MARK}$`).exec(value);
    if (!whole) return restoreText(value);
    const unquoted = inner(quoted[Number(whole[1])]);
    const alias = stateAlias(unquoted);
    return alias === undefined ? unquoted : alias;
  };
  const result = parseRuleText(masked, original, candidates, options);
  if (typeof result.reason === 'string') result.reason = restoreText(result.reason);
  if (typeof result.unparsedGuard === 'string') result.unparsedGuard = restoreText(result.unparsedGuard);
  if (result.rule) {
    result.rule.value = restoreValue(result.rule.value);
    if (result.rule.when) result.rule.when = { ...result.rule.when, value: restoreValue(result.rule.when.value) };
  }
  return result;
}

// Private-use characters: nobody types them, so they cannot clash.
const QUOTE_MARK = '\uE000';
const QUOTED_PLACEHOLDER = /"\uE000(\d+)\uE000"/g;
const BARE_PLACEHOLDER = /\uE000(\d+)\uE000/g;

function parseRuleText(masked, original, candidates, { forcePath } = {}) {
  if (!original) return { ok: false, reason: 'Say what to watch for.' };
  const unpunctuated = masked
    .toLowerCase()
    .split(/("[^"]*"|'[^']*')/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[!?;]/g, ' ')))
    .join('');
  let clean = ` ${unpunctuated.replace(/\s+/g, ' ')} `;

  const severity = /\b(?:alarm|alert|urgent|critical|emergency|immediately)\b/.test(clean) ? 'alert' : 'warn';

  let forSeconds = 0;
  const duration =
    /\bfor (?:more than |over |at least |longer than )?(\d+(?:[.,]\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b(?:\s+(?:or (?:more|longer)|straight|in a row|continuously|non-?stop))?/.exec(
      clean
    );
  if (duration) {
    const amount = parseNumber(duration[1]);
    const unit = duration[2];
    forSeconds = Math.round(unit.startsWith('h') ? amount * 3600 : unit.startsWith('m') ? amount * 60 : amount);
    clean = clean.replace(duration[0], ' ');
  }

  clean = clean
    .replace(/^\s*(?:please\s+)?(?:(?:tell|warn|alert|notify|alarm)(?:\s+(?:me|us))?|let\s+(?:me|us)\s+know|watch\s+for|watch|monitor)\s*(?:if|when|whenever)?\s*/, ' ')
    .trim();

  const segments = clean.split(GUARD_SPLIT).map((part) => part.trim()).filter(Boolean);
  const parsed = segments.map((segment) => ({ segment, clause: parseClause(segment) }));
  const broken = parsed.find((item) => item.clause && item.clause.error);
  if (broken && broken.clause.andParts && parsed.length > 1) {
    // "...while A and B": the "while" is taken, so "and" cannot become one.
    const parts = broken.clause.andParts;
    return {
      ok: false,
      terminal: true,
      reason:
        `A watch checks one condition, plus at most one "while"; this joins ${parts.length} with "and" ` +
        `(${parts.map((part) => `"${part.trim()}"`).join(', ')}). Add a separate watch for each.`
    };
  }
  if (broken) {
    return { ok: false, reason: broken.clause.error, ...(broken.clause.terminal ? { terminal: true } : {}) };
  }
  const mainIndex = parsed.findIndex((item) => item.clause);
  if (mainIndex < 0) {
    return {
      ok: false,
      reason:
        'No comparison found. Say what should happen, for example "above 95 °C", "below 12.2 V", "is on" or "changes". ' +
        'Unusual values are already watched automatically without a rule.'
    };
  }
  const main = parsed[mainIndex].clause;
  // A segment of nothing but filler ("alert", "please") is not a condition.
  const guards = parsed.filter(
    (item, index) => index !== mainIndex && (item.clause || subjectTerms(item.segment).length > 0)
  );
  const readGuards = guards.filter((item) => item.clause);
  // A rule has one "while". Two conditions the parser could read are refused
  // outright - a model could only keep one of them too. A segment it could
  // not read ("if possible", "while on shore power") is not counted here: it
  // may be filler, so it is reported as unreadable below - naming the other
  // condition, if there is one - and may still go to the model, whose reading
  // the operator checks before adding.
  if (readGuards.length > 1) {
    const guards = readGuards;
    return {
      ok: false,
      // Terminal: a model would have to drop a condition too, since a rule
      // holds one guard, so this is not passed on for interpretation.
      terminal: true,
      reason: `A watch can have one "while" condition; this has ${guards.length} (${guards.map((item) => `"${item.segment}"`).join(', ')}). Keep the one that matters most.`
    };
  }
  const unreadGuard = guards.find((item) => !item.clause);
  if (unreadGuard) {
    // One read and one not: say so. The model may still read the request,
    // but it too can keep only one condition, and the operator checks which.
    const also = readGuards.length > 0 ? ` A watch has one "while" condition, and this also has "${readGuards[0].segment}": the reading will keep only one.` : '';
    return { ok: false, reason: `Could not read the condition "${unreadGuard.segment}".${also}`, unparsedGuard: unreadGuard.segment };
  }
  const guardItem = readGuards[0];

  const subjectOf = (clause) => `${clause.subject} ${clause.qualifier || ''}`.trim();
  const resolve = (clause, force) => {
    const dimension = clause.unit ? parseOperatorUnit(clause.unit).dimension : undefined;
    if (force) return { path: force, alternatives: [] };
    const narrowed = pickPath(subjectOf(clause), candidates, dimension);
    if (narrowed.path || !clause.qualifier) return narrowed;
    // Words that name nothing here ("on the port side" of a boat with one
    // engine) leave the subject itself: if it alone is clear, the qualifier
    // is refused below, by name, rather than asked about.
    const plain = pickPath(clause.subject, candidates, dimension);
    return plain.path ? plain : narrowed;
  };
  // Words after the comparison are kept only if they narrow the subject:
  // "at anchor" is not a path, and dropping it would watch at all times.
  const qualifierError = (clause, path) =>
    clause.qualifier && !qualifierMatches(clause.qualifier, path, candidates)
      ? `Could not read "${clause.qualifier}": it does not name ${path}. A watch compares one value; say only what it should be.`
      : undefined;

  const mainPick = resolve(main, forcePath);
  if (!mainPick.path) {
    return {
      ok: false,
      reason: mainPick.alternatives.length > 0 ? `Which "${subjectOf(main)}" do you mean?` : `No path on this vessel matches "${subjectOf(main)}".`,
      alternatives: mainPick.alternatives
    };
  }
  const mainQualifier = qualifierError(main, mainPick.path);
  if (mainQualifier) return { ok: false, reason: mainQualifier };

  const toRuleCondition = (clause, path) => {
    const info = candidates.find((candidate) => candidate.path === path) || {};
    if (NUMERIC_OPS.has(clause.op)) {
      const value = fromDisplay(path, info.units, clause.number, clause.unit);
      if (value === undefined) return { error: `"${clause.unit}" does not fit ${path}.` };
      return { path, op: clause.op, value };
    }
    // Data already seen as a word or a flag has states, whatever its name.
    const seen = info.valueType === 'boolean' ? true : info.valueType === 'string' ? '' : undefined;
    const measured = measuredValueError({ path, op: clause.op, value: clause.value }, info.units, seen);
    if (measured) return { error: measured, terminal: true };
    return { path, op: clause.op, value: clause.value };
  };

  const mainCondition = toRuleCondition(main, mainPick.path);
  if (mainCondition.error) return { ok: false, reason: mainCondition.error, ...(mainCondition.terminal ? { terminal: true } : {}) };

  let when;
  if (guardItem) {
    const guardPick = resolve(guardItem.clause);
    if (!guardPick.path) {
      return {
        ok: false,
        reason: `Which "${subjectOf(guardItem.clause)}" do you mean in "${guardItem.segment}"?`,
        alternatives: guardPick.alternatives,
        unparsedGuard: guardItem.segment
      };
    }
    const guardQualifier = qualifierError(guardItem.clause, guardPick.path);
    if (guardQualifier) return { ok: false, reason: guardQualifier, unparsedGuard: guardItem.segment };
    when = toRuleCondition(guardItem.clause, guardPick.path);
    if (when.error) return { ok: false, reason: when.error, ...(when.terminal ? { terminal: true } : {}) };
  }

  return {
    ok: true,
    rule: { text: original, ...mainCondition, forSeconds, ...(when ? { when } : {}), severity, source: 'parser' }
  };
}

module.exports = { parseRule, rankPaths };
