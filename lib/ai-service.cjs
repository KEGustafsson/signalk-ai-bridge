'use strict';

const { Ollama } = require('ollama');

const DEFAULT_AI_BASE_URL = 'http://localhost:11434';
const DEFAULT_AI_MODEL = 'gemma4';
const DEFAULT_SYSTEM_PROMPT =
  'You are Signal K AI Bridge, a maritime assistant for vessel operators. ' +
  'Use only the provided Signal K context. ' +
  'Be explicit when context is missing or stale. ' +
  'Do not claim to have executed vessel commands or changed vessel state. ' +
  'Finish the full response before stopping. ' +
  'Do not end with an empty heading, unfinished bullet, or partial sentence. ' +
  'If you start a section, complete it.';
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_MAX_TOKENS = 131072;
const MAX_PROMPT_LENGTH = 4000;
const MAX_DELTA_ITEMS = 20;
const MODEL_TAG_SEPARATOR = ':';

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return fallback;
}

function normalizeBaseUrl(value) {
  const normalized = String(value || DEFAULT_AI_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/chat$/, '')
    .replace(/\/api$/, '');

  return normalized.length > 0 ? normalized : DEFAULT_AI_BASE_URL;
}

function normalizeAiConfig(options = {}, env = process.env) {
  const enabled = normalizeBoolean(options.enabled ?? env.SIGNALK_AI_BRIDGE_ENABLED, true);
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || env.AI_MODEL_URL || env.SIGNALK_AI_BRIDGE_BASE_URL || DEFAULT_AI_BASE_URL
  );
  const model = String(
    options.model || env.AI_MODEL_NAME || env.SIGNALK_AI_BRIDGE_MODEL || DEFAULT_AI_MODEL
  ).trim();
  const systemPrompt = String(options.systemPrompt || env.SIGNALK_AI_BRIDGE_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT).trim();

  return {
    enabled,
    baseUrl,
    model: model.length > 0 ? model : DEFAULT_AI_MODEL,
    systemPrompt: systemPrompt.length > 0 ? systemPrompt : DEFAULT_SYSTEM_PROMPT,
    requestTimeoutMs: Math.min(
      300000,
      toNonNegativeInteger(options.requestTimeoutMs ?? env.SIGNALK_AI_BRIDGE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
    ),
    temperature: Math.max(0, Math.min(2, toNumber(options.temperature, DEFAULT_TEMPERATURE))),
    topP: Math.max(0, Math.min(1, toNumber(options.topP, DEFAULT_TOP_P))),
    maxTokens: Math.max(64, Math.min(131072, toInteger(options.maxTokens, DEFAULT_MAX_TOKENS)))
  };
}

function normalizePrompt(prompt) {
  return String(prompt || '').trim();
}

function pruneContext(context = {}) {
  return {
    serverId: typeof context.serverId === 'string' ? context.serverId : undefined,
    aiDataPaths: Array.isArray(context.aiDataPaths) ? context.aiDataPaths : [],
    selectedData: typeof context.selectedData === 'object' && context.selectedData !== null ? context.selectedData : {},
  };
}

function buildAiMessages(prompt, context, config) {
  const normalizedPrompt = normalizePrompt(prompt);
  const normalizedContext = pruneContext(context);

  return [
    {
      role: 'system',
      content: config.systemPrompt
    },
    {
      role: 'user',
      content:
        `Operator request:\n${normalizedPrompt}\n\n` +
        `Signal K context:\n${JSON.stringify(normalizedContext, null, 2)}\n\n` +
        'Response requirements:\n' +
        '- Complete every section you begin.\n' +
        '- End with a short final summary.\n' +
        '- Do not stop mid-list or mid-sentence.'
    }
  ];
}

function extractTextContent(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part === 'object' && part !== null && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('\n')
    .trim();
}

function toIsoTimestamp(createdAt) {
  if (createdAt instanceof Date && Number.isFinite(createdAt.getTime())) {
    return createdAt.toISOString();
  }
  if (typeof createdAt === 'string' && createdAt.trim().length > 0) {
    const parsed = new Date(createdAt);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

function parseUsage(response) {
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }

  const promptTokens = Number(response.prompt_eval_count);
  const completionTokens = Number(response.eval_count);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) {
    return undefined;
  }

  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : undefined,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
    totalTokens:
      Number.isFinite(promptTokens) || Number.isFinite(completionTokens)
        ? (Number.isFinite(promptTokens) ? promptTokens : 0) +
          (Number.isFinite(completionTokens) ? completionTokens : 0)
        : undefined
  };
}

function isAbortError(error) {
  return (typeof DOMException === 'function' && error instanceof DOMException)
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function createTimeoutError(timeoutMs) {
  const timeoutError = new Error(`AI backend request timed out after ${timeoutMs} ms.`);
  timeoutError.code = 'timeout';
  return timeoutError;
}

function createTimedFetch(fetchImpl, timeoutMs) {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const externalSignal = init.signal;

    let removeAbortListener = null;
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        const onAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
      }
    }

    const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      return await fetchImpl(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error) && !(externalSignal && externalSignal.aborted)) {
        throw createTimeoutError(timeoutMs);
      }
      throw error;
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      if (typeof removeAbortListener === 'function') {
        removeAbortListener();
      }
    }
  };
}

function normalizeModelName(value) {
  return String(value || '').trim();
}

function isMissingModelError(error, requestedModel) {
  const model = normalizeModelName(requestedModel);
  const message =
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : '';

  return model.length > 0 && /not found/i.test(message) && message.includes(model);
}

async function fetchInstalledModels(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return [];
  }

  const response = await createTimedFetch(fetchImpl, config.requestTimeoutMs)(`${config.baseUrl}/api/tags`, {
    method: 'GET'
  });

  if (!response.ok) {
    const error = new Error(`Failed to list Ollama models (${response.status}).`);
    error.code = response.status === 408 ? 'timeout' : 'unknown';
    error.statusCode = response.status;
    throw error;
  }

  const payload = await response.json();
  return Array.isArray(payload && payload.models) ? payload.models : [];
}

function resolveInstalledModel(requestedModel, installedModels) {
  const normalizedRequested = normalizeModelName(requestedModel);
  if (normalizedRequested.length === 0) {
    return undefined;
  }

  const exactMatch = installedModels.find((entry) => normalizeModelName(entry && entry.name) === normalizedRequested);
  if (exactMatch && typeof exactMatch.name === 'string') {
    return exactMatch.name;
  }

  if (!normalizedRequested.includes(MODEL_TAG_SEPARATOR)) {
    const taggedMatch = installedModels.find((entry) => {
      const name = normalizeModelName(entry && entry.name);
      return name.startsWith(`${normalizedRequested}${MODEL_TAG_SEPARATOR}`);
    });
    if (taggedMatch && typeof taggedMatch.name === 'string') {
      return taggedMatch.name;
    }
  }

  const familyMatch = installedModels.find((entry) => {
    const details = entry && typeof entry === 'object' ? entry.details : undefined;
    const family = normalizeModelName(details && details.family);
    const families = Array.isArray(details && details.families)
      ? details.families.map((item) => normalizeModelName(item)).filter(Boolean)
      : [];

    return family === normalizedRequested || families.includes(normalizedRequested);
  });

  return familyMatch && typeof familyMatch.name === 'string' ? familyMatch.name : undefined;
}

async function resolveChatModel(requestedModel, config, dependencies = {}) {
  try {
    const installedModels = await fetchInstalledModels(config, dependencies);
    return resolveInstalledModel(requestedModel, installedModels) || normalizeModelName(requestedModel);
  } catch {
    return normalizeModelName(requestedModel);
  }
}

async function getAiAvailability(config, dependencies = {}) {
  if (!config.enabled) {
    return {
      available: false,
      backendReachable: false,
      modelAvailable: false,
      resolvedModel: undefined,
      message: 'AI pipeline is disabled in plugin configuration.'
    };
  }

  try {
    const installedModels = await fetchInstalledModels(config, dependencies);
    const resolvedModel = resolveInstalledModel(config.model, installedModels);

    if (resolvedModel) {
      return {
        available: true,
        backendReachable: true,
        modelAvailable: true,
        resolvedModel,
        message: `Ollama is reachable and model ${resolvedModel} is available.`
      };
    }

    return {
      available: false,
      backendReachable: true,
      modelAvailable: false,
      resolvedModel: undefined,
      message: `Ollama is reachable, but model ${normalizeModelName(config.model) || DEFAULT_AI_MODEL} is not installed.`
    };
  } catch (error) {
    const message =
      error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
        ? error.message.trim()
        : 'Could not reach Ollama.';

    const isNetworkFailure =
      /fetch failed/i.test(message) ||
      /failed to fetch/i.test(message) ||
      /ECONNREFUSED/i.test(message) ||
      /ENOTFOUND/i.test(message) ||
      /network/i.test(message);

    return {
      available: false,
      backendReachable: false,
      modelAvailable: false,
      resolvedModel: undefined,
      message: isNetworkFailure
        ? `Could not reach Ollama at ${config.baseUrl}. Check that the Ollama service is running and reachable from Signal K.`
        : message
    };
  }
}

async function runChat(ollama, model, prompt, payload, config) {
  return ollama.chat({
    model,
    stream: false,
    messages: buildAiMessages(prompt, payload && payload.context, config),
    options: {
      temperature: config.temperature,
      top_p: config.topP,
      num_predict: config.maxTokens,
      num_ctx: config.maxTokens
    }
  });
}

function getOllamaClient(config, dependencies = {}) {
  if (dependencies.ollamaClient && typeof dependencies.ollamaClient.chat === 'function') {
    return dependencies.ollamaClient;
  }

  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Global fetch is not available for AI requests.');
    error.code = 'unknown';
    throw error;
  }

  return new Ollama({
    host: config.baseUrl,
    fetch: createTimedFetch(fetchImpl, config.requestTimeoutMs)
  });
}

async function queryAiModel(payload, config, dependencies = {}) {
  const prompt = normalizePrompt(payload && payload.prompt);
  if (prompt.length === 0) {
    const error = new Error('Prompt must not be empty.');
    error.code = 'validation-failed';
    throw error;
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    const error = new Error(`Prompt must be ${MAX_PROMPT_LENGTH} characters or less.`);
    error.code = 'validation-failed';
    throw error;
  }
  if (!config.enabled) {
    const error = new Error('AI bridge is disabled by plugin configuration.');
    error.code = 'disabled';
    throw error;
  }

  const ollama = getOllamaClient(config, dependencies);
  let response;
  let modelUsed = normalizeModelName(config.model);

  try {
    try {
      response = await runChat(ollama, modelUsed, prompt, payload, config);
    } catch (error) {
      if (!isMissingModelError(error, modelUsed)) {
        throw error;
      }

      const resolvedModel = await resolveChatModel(modelUsed, config, dependencies);
      if (resolvedModel.length === 0 || resolvedModel === modelUsed) {
        throw error;
      }

      modelUsed = resolvedModel;
      response = await runChat(ollama, modelUsed, prompt, payload, config);
    }

    const answer = extractTextContent(
      response && response.message && typeof response.message === 'object' ? response.message.content : undefined
    );

    if (answer.length === 0) {
      const error = new Error('AI backend returned an empty response.');
      error.code = 'unknown';
      throw error;
    }

    return {
      answer,
      model:
        response && typeof response.model === 'string' && response.model.trim().length > 0
          ? response.model
          : modelUsed,
      createdAt: toIsoTimestamp(response && response.created_at),
      usage: parseUsage(response)
    };
  } catch (error) {
    if (error && error.code === 'timeout') {
      throw error;
    }
    if (isAbortError(error)) {
      throw createTimeoutError(config.requestTimeoutMs);
    }

    const message =
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string' &&
      error.message.trim().length > 0
        ? error.message
        : 'Unknown AI backend failure.';
    const wrapped = new Error(message);
    wrapped.code =
      typeof error === 'object' &&
      error !== null &&
      'status_code' in error &&
      Number(error.status_code) === 408
        ? 'timeout'
        : 'unknown';
    if (
      typeof error === 'object' &&
      error !== null &&
      'status_code' in error &&
      Number.isFinite(Number(error.status_code))
    ) {
      wrapped.statusCode = Number(error.status_code);
    }
    throw wrapped;
  }
}

async function readJsonBody(req) {
  if (req && typeof req.body === 'object' && req.body !== null) {
    return req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  return rawBody.length === 0 ? {} : JSON.parse(rawBody);
}

module.exports = {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  buildAiMessages,
  getAiAvailability,
  normalizeAiConfig,
  pruneContext,
  queryAiModel,
  readJsonBody
};
