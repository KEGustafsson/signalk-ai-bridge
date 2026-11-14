'use strict';

const { createTimedFetch, resolveFetch } = require('../http-utils.cjs');
const { fromDisplay, displayUnit } = require('./format.cjs');
const { NUMERIC_OPS, OPS } = require('./rules.cjs');

/**
 * A language model as a last resort for writing a watch rule.
 *
 * Only reached when the parser could not read the request, and only when the
 * operator allowed it (`watchRuleAssist`). The job is kept small enough for
 * the smallest model that can do it:
 *
 *   - the model picks from a short list of real paths, ranked by the parser,
 *     never from the whole vessel
 *   - its output is constrained by a JSON schema (Ollama's `format`), with
 *     the paths and operators as enums, so it cannot name a path that does
 *     not exist or answer in prose
 *   - it answers in the units the panel shows, and the plugin converts
 *   - the result is validated like any other rule and read back to the
 *     operator in plain words before anything is stored
 *
 * A 0.6B-class model is enough for that shape of task, and the configured
 * main model, already resident, costs no extra memory at all.
 */

const MAX_CANDIDATES = 25;
const ASSIST_TIMEOUT_MS = 60000;
// How long an error reply's body may take: it is only a detail for the
// message. The timed fetch releases its own deadline on a non-2xx status, so
// without this a backend that sends "500" and then stalls would hold the rule
// compilation open for good.
const ERROR_BODY_TIMEOUT_MS = 2000;
const ERROR_DETAIL_CHARS = 160;

/** The start of an error reply's body, read within `timeoutMs`, or ''. */
async function readErrorDetail(response, timeoutMs) {
  const body = response && response.body;
  if (!body || typeof body.getReader !== 'function') return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    while (text.length < ERROR_DETAIL_CHARS) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // A body that fails to read leaves only the status to report.
  } finally {
    clearTimeout(timer);
    // Release the connection whether or not the body finished.
    reader.cancel().catch(() => {});
  }
  return text.trim();
}

function unitLabel(candidate) {
  return displayUnit(candidate.path, candidate.units).label || 'no unit';
}

function buildSchema(paths) {
  const pathEnum = [...paths, ''];
  const value = { type: ['number', 'string', 'boolean', 'null'] };
  return {
    type: 'object',
    properties: {
      path: { type: 'string', enum: pathEnum },
      op: { type: 'string', enum: OPS },
      value,
      forSeconds: { type: 'number' },
      severity: { type: 'string', enum: ['warn', 'alert'] },
      whenPath: { type: 'string', enum: pathEnum },
      whenOp: { type: 'string', enum: [...OPS.filter((op) => op !== 'changes'), ''] },
      whenValue: value
    },
    required: ['path', 'op', 'value', 'forSeconds', 'severity', 'whenPath', 'whenOp', 'whenValue']
  };
}

function buildMessages(text, candidates) {
  const list = candidates
    .map((candidate) => `- ${candidate.path}${candidate.displayName ? ` (${candidate.displayName})` : ''} [${unitLabel(candidate)}]`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You turn a boat operator\'s request into one watch rule as JSON. Use only paths from the list. ' +
        'op is one of: above, below, atLeast, atMost (numbers; atLeast and atMost include the value itself), ' +
        'equals, notEquals (on/off, true/false, a word or a number), changes. ' +
        'Give numbers in the unit shown in brackets for the path. forSeconds is how long the condition must hold (0 if not said). ' +
        'severity is alert only if the request sounds urgent. Use whenPath/whenOp/whenValue only for a "while" or "only when" ' +
        'condition, otherwise empty strings and null. If no listed path fits, set path to "".'
    },
    { role: 'user', content: `Request: ${text}\nPaths:\n${list}` }
  ];
}

/**
 * Ask the model for a rule. Resolves to `{ ok, rule?, message?, model }`;
 * never rejects for a model failure, which is the operator's to see.
 */
async function assistRule(text, candidates, options, dependencies = {}) {
  const { baseUrl, model, keepAlive } = options;
  if (options.backend && options.backend !== 'ollama') {
    return { ok: false, message: 'Interpreting a request with a model needs the Ollama backend; write it in the form the parser reads.' };
  }
  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  if (shortlist.length === 0) {
    return { ok: false, message: 'No published path resembles that request.' };
  }
  let fetchImpl;
  try {
    fetchImpl = createTimedFetch(resolveFetch(dependencies), ASSIST_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'No fetch available.' };
  }

  let content;
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: keepAlive,
        format: buildSchema(shortlist.map((candidate) => candidate.path)),
        messages: buildMessages(text, shortlist),
        // Deterministic, short, and a small window: the whole prompt is a
        // request and a list of at most 25 paths.
        options: { temperature: 0, num_predict: 160, num_ctx: 2048 },
        think: false
      })
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response, dependencies.errorBodyTimeoutMs || ERROR_BODY_TIMEOUT_MS);
      return {
        ok: false,
        model,
        message: `The model could not be asked (HTTP ${response.status}${detail ? `: ${detail.slice(0, ERROR_DETAIL_CHARS)}` : ''}).`
      };
    }
    const payload = await response.json();
    content = payload && payload.message && payload.message.content;
  } catch (error) {
    return { ok: false, model, message: `The model could not be asked (${error instanceof Error ? error.message : error}).` };
  }

  let answer;
  try {
    answer = JSON.parse(String(content || ''));
  } catch {
    return { ok: false, model, message: 'The model did not answer with a rule.' };
  }
  // Valid JSON that is not an object ("null", a number, a list) is no rule
  // either, and reading its fields would throw past this contract.
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return { ok: false, model, message: 'The model did not answer with a rule.' };
  }
  const infoFor = (path) => shortlist.find((candidate) => candidate.path === path);
  const main = infoFor(answer.path);
  if (!main) {
    return { ok: false, model, message: 'The model found no path on this vessel that fits the request.' };
  }

  // Every number the model gives is in the unit shown for the path, whatever
  // the operator: "equals 90" on a coolant temperature is 90 °C, stored in K.
  // A word or a flag is a state and stays as it is.
  const toSI = (path, op, value) => {
    if (op === 'changes') return value;
    const number = typeof value === 'string' && NUMERIC_OPS.has(op) ? Number(value) : value;
    if (typeof number !== 'number') return value;
    return fromDisplay(path, infoFor(path) && infoFor(path).units, number);
  };
  const rule = {
    text,
    path: main.path,
    op: answer.op,
    value: toSI(main.path, answer.op, answer.value),
    forSeconds: Number(answer.forSeconds) || 0,
    severity: answer.severity === 'alert' ? 'alert' : 'warn',
    source: 'model'
  };
  if (answer.whenPath && infoFor(answer.whenPath) && answer.whenOp) {
    rule.when = { path: answer.whenPath, op: answer.whenOp, value: toSI(answer.whenPath, answer.whenOp, answer.whenValue) };
  }
  return { ok: true, model, rule };
}

module.exports = { assistRule, buildSchema };
