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

function flattenSelectedValue(path, value) {
  const resolved = unwrapPathValue(value);
  if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) {
    return path ? { [path]: convertAiValueForPath(path, resolved) } : {};
  }

  const flattened = flattenObject(resolved, path);
  if (Object.keys(flattened).length > 0) {
    return Object.fromEntries(
      Object.entries(flattened).map(([entryPath, entryValue]) => [entryPath, convertAiValueForPath(entryPath, entryValue)])
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
    if (rawValue !== undefined) {
      selectedData[configuredPath] = boundValue(
        convertAiValueForPath(configuredPath, unwrapPathValue(rawValue))
      );
    }
  }

  return selectedData;
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

  const history = await collectHistoryContext(app, config, dependencies, options);
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
  createBridgeService
};
