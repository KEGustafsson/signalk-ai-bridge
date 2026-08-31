'use strict';

const { buildAiMessages, queryAiModel, streamAiModel } = require('./ai-service.cjs');
const { collectHistoryContext } = require('./history-service.cjs');
const { convertAiValueForPath } = require('./signalk-units.cjs');

const MAX_AUDIT_ENTRIES = 100;

function toApiError(message, code = 'unknown') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unwrapPathValue(value) {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return value.value;
  }

  return value;
}

function normalizeAiDataPaths(config) {
  const configured = Array.isArray(config && config.aiDataPaths) ? config.aiDataPaths : [];
  const normalized = configured
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  if (normalized.length > 0) {
    return [...new Set(normalized)];
  }

  return [
    'navigation.position',
    'navigation.speedOverGround',
    'navigation.courseOverGroundTrue',
    'notifications'
  ];
}

// Signal K data comes from other plugins and NMEA sources, so it can be deeper
// or more self-referential than anything this plugin produces. Unbounded
// recursion here turned a malformed source into "Maximum call stack size
// exceeded" on every request, and a very wide object into a multi-megabyte
// prompt.
const MAX_FLATTEN_DEPTH = 12;
const MAX_FLATTEN_KEYS = 2000;

/** A Signal K data leaf: `{ value, timestamp, $source, meta, values }`. */
function isLeafEnvelope(node) {
  return typeof node === 'object' && node !== null && !Array.isArray(node) && 'value' in node;
}

function flattenObject(input, prefix = '', state = { keys: 0, seen: new WeakSet() }, depth = 0) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return prefix ? { [prefix]: input } : {};
  }

  if (depth >= MAX_FLATTEN_DEPTH || state.seen.has(input)) {
    return prefix ? { [prefix]: '[unreadable]' } : {};
  }
  state.seen.add(input);

  // Stop at a leaf and unwrap it, the same way an exact path does. Recursing
  // through the envelope instead produced keys like "…bearingTrackTrue.value"
  // - which meant the angle heuristic never fired for a wildcard selection, so
  // those leaves reached the model in radians - and dragged `meta`, `$source`
  // and one copy per conflicting source into the prompt alongside them.
  if (isLeafEnvelope(input)) {
    const unwrapped = input.value;
    const staleness = typeof input.timestamp === 'string' ? { [`${prefix}@`]: input.timestamp } : {};

    if (typeof unwrapped === 'object' && unwrapped !== null && !Array.isArray(unwrapped)) {
      return { ...flattenObject(unwrapped, prefix, state, depth + 1), ...staleness };
    }

    state.keys += 1;
    return { [prefix]: unwrapped, ...staleness };
  }

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (state.keys >= MAX_FLATTEN_KEYS) {
      break;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flattenObject(value, path, state, depth + 1));
    } else {
      state.keys += 1;
      out[path] = value;
    }
  }

  return out;
}

/**
 * Notification plumbing that answers no operator question.
 *
 * A Signal K notification flattens to about ten leaves, of which two - `state`
 * and `message` - are the alarm. The rest describe what a notification UI may
 * do with it: a UUID, the methods to raise it by, and five booleans saying
 * which buttons to draw. Measured on this vessel: `notifications.*` alone came
 * to 150 leaves and 12,385 characters, the entire prompt context budget, so
 * propulsion, electrical and control were dropped from every question in
 * favour of `canSilence` repeated fifteen times.
 *
 * `silenced` and `acknowledged` are deliberately kept: "the bilge alarm is
 * active and nobody has acknowledged it" is a different answer from "the bilge
 * alarm is active".
 */
const NOTIFICATION_NOISE_LEAF = /(?:^|\.)(?:id|method|status\.can[A-Za-z]+)$/;

function isPromptNoise(path) {
  return path.startsWith('notifications.') && NOTIFICATION_NOISE_LEAF.test(path);
}

function flattenSelectedValue(path, value) {
  const resolved = unwrapPathValue(value);
  if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) {
    return path ? { [path]: convertAiValueForPath(path, resolved) } : {};
  }

  const flattened = flattenObject(resolved, path);
  if (Object.keys(flattened).length > 0) {
    return Object.fromEntries(
      Object.entries(flattened)
        .filter(([entryPath]) => !isPromptNoise(entryPath))
        .map(([entryPath, entryValue]) => [entryPath, convertAiValueForPath(entryPath, entryValue)])
    );
  }

  return { [path]: resolved };
}

function createAuditId() {
  return `audit-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function appendAuditEntry(state, toolId, outcome, message) {
  const entry = {
    id: createAuditId(),
    at: new Date().toISOString(),
    toolId,
    outcome,
    message
  };

  state.auditLog = [entry, ...state.auditLog].slice(0, MAX_AUDIT_ENTRIES);
}

function readSelfPath(app, path) {
  if (!app || typeof app.getSelfPath !== 'function') {
    throw toApiError('Signal K plugin host does not provide `getSelfPath`.', 'unknown');
  }

  try {
    return app.getSelfPath(path);
  } catch (error) {
    if (error instanceof Error) {
      throw toApiError(error.message, 'unknown');
    }
    throw toApiError(`Failed to read Signal K path \`${path}\`.`, 'unknown');
  }
}

function tryReadSelfPath(app, path) {
  try {
    return readSelfPath(app, path);
  } catch {
    return undefined;
  }
}

/**
 * Copy a value with the same depth, breadth and cycle limits as flattenObject.
 *
 * An exact (non-wildcard) path assigns whatever the data model holds straight
 * into the prompt. That is usually a scalar or a small object, but nothing
 * guarantees it: a 300k-key value from another plugin produced a multi-megabyte
 * prompt and response, and a self-referential one made JSON.stringify throw.
 */
function boundValue(value, state = { keys: 0, seen: new WeakSet() }, depth = 0) {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_FLATTEN_DEPTH || state.seen.has(value)) {
    return '[unreadable]';
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (state.keys >= MAX_FLATTEN_KEYS) {
        break;
      }
      state.keys += 1;
      out.push(boundValue(item, state, depth + 1));
    }
    return out;
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (state.keys >= MAX_FLATTEN_KEYS) {
      break;
    }
    state.keys += 1;
    out[key] = boundValue(item, state, depth + 1);
  }
  return out;
}

// Top-level Signal K branches, for the panel's picker. `getSelfPath('')` is
// not part of the documented plugin API and returns different things across
// server versions, so the tree is reached one branch at a time through the
// same call the snapshot uses.
const SELF_BRANCHES = [
  'navigation',
  'environment',
  'electrical',
  'propulsion',
  'tanks',
  'sensors',
  'steering',
  'performance',
  'notifications',
  'design',
  'sails',
  'communication',
  'networking',
  'resources',
  'vision',
  'control'
];

// A picker listing every leaf of a busy vessel is a scrolling wall, and the
// prompt budget cannot take them all anyway. Well past what any sane selection
// needs, and bounded so a misbehaving source cannot hang the panel.
const MAX_PICKER_PATHS = 600;

/**
 * The live Signal K paths this vessel currently publishes, for the panel's
 * picker.
 *
 * Two granularities, because both are legitimate selections and the difference
 * matters: a branch wildcard (`navigation.*`) is flattened, unit-converted and
 * budgeted leaf by leaf, while a leaf path is read exactly. Branches with no
 * data are left out entirely - offering a path the vessel does not publish is
 * how an operator ends up with an "unavailable" note instead of data.
 */
function listSelfPaths(app) {
  if (!app || typeof app.getSelfPath !== 'function') {
    return { paths: [], branches: [], message: 'Signal K plugin host does not provide `getSelfPath`.' };
  }

  const paths = [];
  const branches = [];
  let truncated = false;

  for (const branch of SELF_BRANCHES) {
    const value = tryReadSelfPath(app, branch);
    if (value === undefined || value === null) {
      continue;
    }

    // Reuses the snapshot's own flattening, so what the picker offers is
    // exactly what a wildcard selection would produce.
    const flattened =
      typeof value === 'object' && !Array.isArray(value) ? flattenObject(value, branch) : { [branch]: value };
    const leaves = Object.keys(flattened)
      // The staleness keys flattenObject adds are prompt decoration, not
      // selectable paths.
      .filter((path) => !path.endsWith('@'))
      .sort();

    if (leaves.length === 0) {
      continue;
    }

    branches.push({ path: `${branch}.*`, leafCount: leaves.length });
    for (const leaf of leaves) {
      if (paths.length >= MAX_PICKER_PATHS) {
        truncated = true;
        break;
      }
      paths.push(leaf);
    }
  }

  return {
    paths,
    branches,
    ...(truncated
      ? {
          message: `Only the first ${MAX_PICKER_PATHS} paths are listed; use a branch wildcard for the rest.`
        }
      : {})
  };
}

/**
 * A normal notification says the same three things every time.
 *
 * `message` is "Value is within normal range", `silenced` is false and
 * `acknowledged` is false — constants, and therefore pure prompt cost. On a
 * working vessel there are a lot of them: 43 normal notifications measured
 * aboard, flattening to 14,730 characters, more than the whole context budget
 * on its own. That is how a question about environment alarms reached the
 * model with every `notifications.environment.*` leaf dropped, and came back
 * with a confident "environment alarms are normal" about 64 paths the model
 * had never been shown — the one kind of answer this plugin must not give.
 *
 * An abnormal notification keeps everything: which alarm, what it says, and
 * whether anyone has silenced or acknowledged it are all the operator's
 * business. A normal one keeps its `state`, so "this monitor exists and is
 * fine" still reaches the model and the absence of an alarm stays provable.
 * A notification with no `state` at all is left alone: unknown is not normal.
 */
const NORMAL_NOTIFICATION_LEAF = /\.(?:message|status\.(?:silenced|acknowledged))$/;

/**
 * Whether a configured path selects notifications, at any depth.
 *
 * Notifications are flattened whatever shape the selection takes. An exact
 * path stores its subtree whole, which for `notifications` - the bare branch
 * name in the plugin's own default selection - put every alarm behind a single
 * key. Three things then went wrong at once: the pruning below never saw a
 * flat key to trim, so a normal notification kept its constants; the budget
 * could only drop the entry entire, taking live alarms with it; and the
 * "no notification data" note fired against a key named `notifications` rather
 * than `notifications.…`, telling the model alarm status was unknown while a
 * bilge alarm sat in the same prompt. Flattening is what the wildcard form
 * already did, and it is the only form in which alarms degrade one leaf at a
 * time instead of all at once.
 */
function isNotificationPath(path) {
  return path === 'notifications' || path.startsWith('notifications.');
}

function pruneNormalNotifications(selectedData) {
  const pruned = {};

  for (const [path, value] of Object.entries(selectedData)) {
    if (path.startsWith('notifications.') && NORMAL_NOTIFICATION_LEAF.test(path)) {
      const root = path.replace(NORMAL_NOTIFICATION_LEAF, '');
      if (selectedData[`${root}.state`] === 'normal') {
        continue;
      }
    }
    pruned[path] = value;
  }

  return pruned;
}

function collectSelectedAiData(app, config) {
  const selectedData = {};

  for (const configuredPath of normalizeAiDataPaths(config)) {
    if (configuredPath.endsWith('.*')) {
      const basePath = configuredPath.slice(0, -2);
      const rawValue = tryReadSelfPath(app, basePath);
      if (rawValue !== undefined) {
        Object.assign(selectedData, flattenSelectedValue(basePath, rawValue));
      }
      continue;
    }

    const rawValue = tryReadSelfPath(app, configuredPath);
    if (rawValue === undefined) {
      continue;
    }

    if (isNotificationPath(configuredPath)) {
      Object.assign(selectedData, flattenSelectedValue(configuredPath, rawValue));
      continue;
    }

    selectedData[configuredPath] = boundValue(
      convertAiValueForPath(configuredPath, unwrapPathValue(rawValue))
    );
  }

  // Applied to the assembled snapshot rather than per configured path: a
  // notification's `state` and its `message` can arrive from two different
  // entries in the selection, so the decision needs all of them in hand.
  return pruneNormalNotifications(selectedData);
}

/**
 * The vessel context for one question: the live snapshot, plus the historical
 * series when the operator has turned the History API on.
 *
 * The history read is awaited rather than raced with the model call because the
 * prompt cannot be built without it. It is bounded by its own short timeout and
 * can only ever resolve, so the worst case it adds to a question is that
 * timeout - measured against a local server, a one-hour window of a dozen paths
 * comes back in a few milliseconds.
 */
async function collectAiBridgeContext(app, state, config, dependencies, options = {}) {
  const context = {
    serverId: typeof app.selfId === 'string' ? app.selfId : undefined,
    aiDataPaths: normalizeAiDataPaths(config),
    selectedData: collectSelectedAiData(app, config)
  };

  // History sees the paths the snapshot actually used, not the raw config:
  // with `aiDataPaths` left unset the snapshot falls back to the default list,
  // and "leave history paths empty to reuse the live paths" has to reuse that
  // same fallback or a default install gets no history at all - with a message
  // claiming no live paths existed while the snapshot above was full of them.
  const history = await collectHistoryContext(
    app,
    { ...config, aiDataPaths: context.aiDataPaths },
    dependencies,
    options
  );
  if (!history) {
    return context;
  }

  // What /ai/status reports, so an operator can tell a provider that is not
  // installed from one that simply has no data yet - without the status route
  // making a history request of its own on every poll.
  state.lastHistory = {
    at: new Date().toISOString(),
    ok: typeof history.message !== 'string',
    requestedPaths: history.requestedPaths,
    seriesCount: history.series ? Object.keys(history.series).length : 0,
    message: history.message
  };

  return { ...context, history };
}

function toToolErrorResult(error) {
  const code =
    typeof error === 'object' && error !== null && typeof error.code === 'string'
      ? error.code
      : 'unknown';
  const message = error instanceof Error ? error.message : 'Unknown runtime error.';

  return {
    type: 'error',
    error: {
      code,
      message
    }
  };
}

function createBridgeService(app, dependencies = {}) {
  const state = {
    auditLog: [],
    lastHistory: undefined
  };

  return {
    reset() {
      state.auditLog = [];
      state.lastHistory = undefined;
    },

    /** The outcome of the most recent history read, for /ai/status. */
    getHistoryStatus() {
      return state.lastHistory;
    },

    async executeTool(request, config, options = {}) {
      const toolId = request && request.toolId;

      try {
        switch (toolId) {
          case 'ask-vessel-ai': {
            const prompt = typeof request.prompt === 'string' ? request.prompt : '';
            const context = await collectAiBridgeContext(app, state, config, dependencies, options);
            const requestMessages = buildAiMessages(prompt, context, config);
            const response = await queryAiModel(
              {
                prompt,
                context
              },
              config,
              dependencies
            );

            const result = {
              type: 'ask-vessel-ai-result',
              prompt,
              context,
              requestMessages,
              response
            };
            appendAuditEntry(state, toolId, 'allowed');
            return result;
          }

          default:
            throw toApiError('Unknown tool id.', 'validation-failed');
        }
      } catch (error) {
        appendAuditEntry(
          state,
          typeof toolId === 'string' ? toolId : 'unknown-tool',
          error && error.code === 'unauthorized' ? 'denied' : 'error',
          error instanceof Error ? error.message : 'Unknown runtime error.'
        );
        return toToolErrorResult(error);
      }
    },

    /**
     * Same contract as executeTool's ask-vessel-ai case, but fragments are
     * handed to `onToken` as the model produces them. The resolved value is
     * still the complete result, so callers never have to reassemble it.
     */
    async streamTool(request, config, onToken, signal, options = {}) {
      const toolId = request && request.toolId;

      try {
        if (toolId !== 'ask-vessel-ai') {
          throw toApiError('Unknown tool id.', 'validation-failed');
        }

        const prompt = typeof request.prompt === 'string' ? request.prompt : '';
        const context = await collectAiBridgeContext(app, state, config, dependencies, { ...options, signal });
        const requestMessages = buildAiMessages(prompt, context, config);
        const response = await streamAiModel({ prompt, context, signal }, config, dependencies, onToken);

        appendAuditEntry(state, toolId, 'allowed');
        return {
          type: 'ask-vessel-ai-result',
          prompt,
          context,
          requestMessages,
          response
        };
      } catch (error) {
        appendAuditEntry(
          state,
          typeof toolId === 'string' ? toolId : 'unknown-tool',
          error && error.code === 'unauthorized' ? 'denied' : 'error',
          error instanceof Error ? error.message : 'Unknown runtime error.'
        );
        return toToolErrorResult(error);
      }
    },

    async buildAiPayload(body, config, options = {}) {
      return {
        ...(body && typeof body === 'object' ? body : {}),
        context: await collectAiBridgeContext(app, state, config, dependencies, options)
      };
    }
  };
}

module.exports = {
  createBridgeService,
  listSelfPaths,
  normalizeAiDataPaths
};
