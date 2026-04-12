'use strict';

const { buildAiMessages, queryAiModel } = require('./ai-service.cjs');

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

function radiansToDegrees(value) {
  return Number((value * (180 / Math.PI)).toFixed(6));
}

function isAnglePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }

  return /(^|\.)(angle|heading|course|bearing|track)[A-Z.]|(^|\.)(angle|heading|course|bearing|track)($|\.)/i.test(path);
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

function flattenObject(input, prefix = '') {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return prefix ? { [prefix]: input } : {};
  }

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flattenObject(value, path));
    } else {
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
      selectedData[configuredPath] = convertAiValueForPath(configuredPath, unwrapPathValue(rawValue));
    }
  }

  return selectedData;
}

function collectAiBridgeContext(app, state, config) {
  return {
    serverId: typeof app.selfId === 'string' ? app.selfId : undefined,
    aiDataPaths: normalizeAiDataPaths(config),
    selectedData: collectSelectedAiData(app, config)
  };
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
    auditLog: []
  };

  return {
    reset() {
      state.auditLog = [];
    },

    async executeTool(request, config) {
      const toolId = request && request.toolId;

      try {
        switch (toolId) {
          case 'ask-vessel-ai': {
            const prompt = typeof request.prompt === 'string' ? request.prompt : '';
            const context = collectAiBridgeContext(app, state, config);
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

    async buildAiPayload(body, config) {
      return {
        ...(body && typeof body === 'object' ? body : {}),
        context: collectAiBridgeContext(app, state, config)
      };
    }
  };
}

module.exports = {
  createBridgeService
};
