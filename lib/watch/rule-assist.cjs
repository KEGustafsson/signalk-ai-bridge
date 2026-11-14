'use strict';

const { createTimedFetch, resolveFetch } = require('../http-utils.cjs');
const { fromDisplay, displayUnit } = require('./format.cjs');
const { OPS } = require('./rules.cjs');

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
        'op is one of: above, below (numbers), equals, notEquals (on/off, true/false or a word), changes. ' +
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
      const detail = await response.text().catch(() => '');
      return { ok: false, model, message: `The model could not be asked (HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}).` };
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
  const infoFor = (path) => shortlist.find((candidate) => candidate.path === path);
  const main = infoFor(answer.path);
  if (!main) {
    return { ok: false, model, message: 'The model found no path on this vessel that fits the request.' };
  }

  const toSI = (path, op, value) => {
    if (op !== 'above' && op !== 'below') return value;
    const number = typeof value === 'string' ? Number(value) : value;
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
