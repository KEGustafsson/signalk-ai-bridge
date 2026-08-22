'use strict';

const { Ollama } = require('ollama');
const {
  DEFAULT_BACKEND,
  DEFAULT_KEEP_ALIVE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_NUM_BATCH,
  DEFAULT_NUM_CTX,
  DEFAULT_NUM_GPU,
  DEFAULT_NUM_THREAD,
  MAX_NUM_BATCH,
  MAX_NUM_CTX,
  MAX_NUM_GPU,
  MAX_NUM_THREAD,
  MIN_NUM_BATCH,
  MIN_NUM_CTX,
  SUPPORTED_BACKENDS,
  buildRuntimeOptions,
  normalizeAccelConfig
} = require('./accel-config.cjs');
const { getAcceleratorStatus, getOllamaGpuStatus, GPU_STATE } = require('./gpu-telemetry.cjs');
const {
  getOffloadState,
  isOutOfMemoryError,
  resetOffloadState,
  resolveOffload,
  tuneOffload
} = require('./gpu-offload.cjs');
const { readJetsonTelemetry } = require('./jetson-telemetry.cjs');
const { createTimedFetch, createTimeoutError, isAbortError, resolveFetch } = require('./http-utils.cjs');
const { listTensorrtModels, runTensorrtChat } = require('./tensorrt-service.cjs');

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
const MAX_PROMPT_LENGTH = 4000;
const MODEL_TAG_SEPARATOR = ':';

// Availability is polled by every open panel on every render pass. Without a
// short cache each poll costs the inference server a round trip, and on a
// Jetson that competes with the GPU worker for the same few CPU cores.
const AVAILABILITY_CACHE_TTL_MS = 5000;

const availabilityCache = new Map();

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
    .replace(/\/v1\/chat\/completions$/, '')
    .replace(/\/api$/, '')
    .replace(/\/v1$/, '');

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
  const apiKey = String(options.apiKey || env.SIGNALK_AI_BRIDGE_API_KEY || '').trim();

  return {
    enabled,
    baseUrl,
    model: model.length > 0 ? model : DEFAULT_AI_MODEL,
    systemPrompt: systemPrompt.length > 0 ? systemPrompt : DEFAULT_SYSTEM_PROMPT,
    apiKey,
    requestTimeoutMs: Math.min(
      300000,
      toNonNegativeInteger(options.requestTimeoutMs ?? env.SIGNALK_AI_BRIDGE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
    ),
    temperature: Math.max(0, Math.min(2, toNumber(options.temperature, DEFAULT_TEMPERATURE))),
    topP: Math.max(0, Math.min(1, toNumber(options.topP, DEFAULT_TOP_P))),
    maxTokens: Math.max(64, Math.min(MAX_NUM_CTX, toInteger(options.maxTokens, DEFAULT_MAX_TOKENS))),
    warmupOnStart: normalizeBoolean(options.warmupOnStart ?? env.SIGNALK_AI_BRIDGE_WARMUP, true),
    gpuAutoTune: normalizeBoolean(options.gpuAutoTune ?? env.SIGNALK_AI_BRIDGE_GPU_AUTOTUNE, true),
    ...normalizeAccelConfig(options, env)
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

/**
 * Nanosecond timings Ollama reports per response, converted to milliseconds and
 * tokens/second. Throughput is the number that tells an operator whether the
 * Orin's GPU is doing the work: a 4B-class model answers at tens of tokens per
 * second on the CUDA cores and at low single digits once it spills to the CPU.
 */
function parsePerformance(response) {
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }

  const toMs = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Number((parsed / 1e6).toFixed(1)) : undefined;
  };

  const evalCount = Number(response.eval_count);
  const evalDurationNs = Number(response.eval_duration);
  const tokensPerSecond =
    Number.isFinite(evalCount) && Number.isFinite(evalDurationNs) && evalDurationNs > 0
      ? Number(((evalCount / evalDurationNs) * 1e9).toFixed(2))
      : undefined;

  const performance = {
    totalMs: toMs(response.total_duration),
    loadMs: toMs(response.load_duration),
    promptEvalMs: toMs(response.prompt_eval_duration),
    evalMs: toMs(response.eval_duration),
    tokensPerSecond
  };

  return Object.values(performance).some((value) => value !== undefined) ? performance : undefined;
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
  if (config.backend === 'tensorrt-llm') {
    return listTensorrtModels(config, dependencies);
  }

  let fetchImpl;
  try {
    fetchImpl = resolveFetch(dependencies);
  } catch {
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

function backendLabel(config) {
  return config.backend === 'tensorrt-llm' ? 'TensorRT-LLM' : 'Ollama';
}

async function readAvailability(config, dependencies = {}) {
  const label = backendLabel(config);

  try {
    const installedModels = await fetchInstalledModels(config, dependencies);
    const resolvedModel = resolveInstalledModel(config.model, installedModels);

    if (resolvedModel) {
      return {
        available: true,
        backendReachable: true,
        modelAvailable: true,
        resolvedModel,
        message: `${label} is reachable and model ${resolvedModel} is available.`
      };
    }

    return {
      available: false,
      backendReachable: true,
      modelAvailable: false,
      resolvedModel: undefined,
      message: `${label} is reachable, but model ${normalizeModelName(config.model) || DEFAULT_AI_MODEL} is not installed.`
    };
  } catch (error) {
    const message =
      error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
        ? error.message.trim()
        : `Could not reach ${label}.`;

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
        ? `Could not reach ${label} at ${config.baseUrl}. Check that the ${label} service is running and reachable from Signal K.`
        : message
    };
  }
}

function availabilityCacheKey(config) {
  return `${config.backend}|${config.baseUrl}|${config.model}`;
}

function resetAvailabilityCache() {
  availabilityCache.clear();
}

/**
 * Cached, single-flight availability probe.
 *
 * Concurrent callers share one in-flight request, and a successful answer is
 * reused for AVAILABILITY_CACHE_TTL_MS, so an open panel cannot turn into a
 * steady poll against the inference server.
 */
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

  const key = availabilityCacheKey(config);
  const now = Date.now();
  const cached = availabilityCache.get(key);

  if (cached && cached.pending) {
    return cached.pending;
  }
  if (cached && typeof cached.expiresAt === 'number' && cached.expiresAt > now) {
    return cached.value;
  }

  const pending = readAvailability(config, dependencies)
    .then((value) => {
      availabilityCache.set(key, { value, expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS });
      return value;
    })
    .catch((error) => {
      availabilityCache.delete(key);
      throw error;
    });

  availabilityCache.set(key, { pending });
  return pending;
}

async function runChat(ollama, model, prompt, payload, config, runtimeConfig = config) {
  return ollama.chat({
    model,
    stream: false,
    keep_alive: config.keepAlive,
    messages: buildAiMessages(prompt, payload && payload.context, config),
    options: buildRuntimeOptions(runtimeConfig)
  });
}

function getOllamaClient(config, dependencies = {}) {
  if (dependencies.ollamaClient && typeof dependencies.ollamaClient.chat === 'function') {
    return dependencies.ollamaClient;
  }

  const fetchImpl = resolveFetch(dependencies);

  return new Ollama({
    host: config.baseUrl,
    fetch: createTimedFetch(fetchImpl, config.requestTimeoutMs)
  });
}

async function queryOllamaModel(prompt, payload, config, dependencies) {
  const ollama = getOllamaClient(config, dependencies);
  // Whatever the start-up tuner settled on, so every request runs with the
  // layer split and context window that were proven to fit on the GPU.
  let runtimeConfig = resolveOffload(config);
  let response;
  let modelUsed = normalizeModelName(config.model);

  try {
    response = await runChat(ollama, modelUsed, prompt, payload, config, runtimeConfig);
  } catch (error) {
    if (isOutOfMemoryError(error) && config.gpuAutoTune) {
      // Memory pressure can appear after start-up — another process took VRAM,
      // or a longer context grew the cache. Retry once at half the context
      // rather than failing the operator's question outright.
      runtimeConfig = {
        ...runtimeConfig,
        numCtx: Math.max(MIN_NUM_CTX, Math.floor(runtimeConfig.numCtx / 2))
      };
      response = await runChat(ollama, modelUsed, prompt, payload, config, runtimeConfig);
    } else if (isMissingModelError(error, modelUsed)) {
      const resolvedModel = await resolveChatModel(modelUsed, config, dependencies);
      if (resolvedModel.length === 0 || resolvedModel === modelUsed) {
        throw error;
      }

      modelUsed = resolvedModel;
      response = await runChat(ollama, modelUsed, prompt, payload, config, runtimeConfig);
    } else {
      throw error;
    }
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
    usage: parseUsage(response),
    performance: parsePerformance(response)
  };
}

async function queryTensorrtModel(prompt, payload, config, dependencies) {
  const messages = buildAiMessages(prompt, payload && payload.context, config);
  let modelUsed = normalizeModelName(config.model);

  try {
    return await runTensorrtChat(messages, modelUsed, config, dependencies);
  } catch (error) {
    const resolvedModel = await resolveChatModel(modelUsed, config, dependencies);
    if (resolvedModel.length === 0 || resolvedModel === modelUsed) {
      throw error;
    }
    modelUsed = resolvedModel;
    return runTensorrtChat(messages, modelUsed, config, dependencies);
  }
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

  try {
    return config.backend === 'tensorrt-llm'
      ? await queryTensorrtModel(prompt, payload, config, dependencies)
      : await queryOllamaModel(prompt, payload, config, dependencies);
  } catch (error) {
    if (error && (error.code === 'timeout' || error.code === 'validation-failed')) {
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
    const statusCode =
      typeof error === 'object' && error !== null
        ? Number(error.status_code ?? error.statusCode)
        : Number.NaN;
    if (Number.isFinite(statusCode)) {
      wrapped.statusCode = statusCode;
    }
    throw wrapped;
  }
}

/**
 * Load a model with specific accelerator settings, without generating anything.
 *
 * An empty prompt is Ollama's documented preload call: it runs the loader —
 * which is where the CPU/GPU split is decided — and returns. `keep_alive: 0`
 * unloads instead, which is how the tuner frees VRAM between attempts.
 */
async function preloadModel(model, config, dependencies, keepAlive = config.keepAlive) {
  const fetchImpl = resolveFetch(dependencies);
  const response = await createTimedFetch(fetchImpl, config.requestTimeoutMs)(
    `${config.baseUrl}/api/generate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: '',
        stream: false,
        keep_alive: keepAlive,
        options: buildRuntimeOptions(config)
      })
    }
  );

  if (!response.ok) {
    const error = new Error(`Model preload returned ${response.status}.`);
    error.statusCode = response.status;
    // Ollama reports a failed offload in the body, not the status line, so the
    // tuner needs the text to tell "did not fit" from "backend is broken".
    try {
      error.message = `${error.message} ${(await response.text()).slice(0, 500)}`.trim();
    } catch {
      // Body already consumed or unreadable — the status alone will do.
    }
    throw error;
  }

  return response;
}

/**
 * Preload the model and push as much of it onto the GPU as will fit.
 *
 * Two jobs in one pass, because both need a load to observe:
 *  - the first operator question does not pay a multi-second cold load from
 *    Jetson storage;
 *  - the layer split is measured rather than assumed, and the context window is
 *    shrunk until every layer is resident (see gpu-offload.cjs).
 *
 * Failures are deliberately swallowed. Warm-up is an optimisation, so a backend
 * that is not up yet must not stop the plugin from starting.
 */
async function warmUpModel(config, dependencies = {}) {
  if (!config.enabled || !config.warmupOnStart || config.backend !== 'ollama') {
    return { warmed: false, reason: 'skipped' };
  }

  try {
    const availability = await getAiAvailability(config, dependencies);
    if (!availability.available) {
      return { warmed: false, reason: availability.message };
    }

    const model = availability.resolvedModel;
    let attempts = 0;

    const offload = await tuneOffload(config, async (candidate) => {
      if (attempts > 0) {
        // Free the previous resident copy before loading different settings,
        // so the two do not briefly compete for the same unified memory.
        await preloadModel(model, candidate, dependencies, 0).catch(() => {});
      }
      attempts += 1;

      await preloadModel(model, candidate, dependencies);
      return getOllamaGpuStatus({ ...candidate, resolvedModel: model }, dependencies);
    });

    return { warmed: true, model, offload };
  } catch (error) {
    return {
      warmed: false,
      reason: error instanceof Error ? error.message : 'Unknown warm-up failure.'
    };
  }
}

/**
 * Everything the panel needs to answer "is this running on the GPU, and is that
 * GPU running flat out?" — model residency from the inference backend, plus
 * board-level power and clock state when Signal K shares a host with it.
 */
async function getAccelerationReport(config, dependencies = {}) {
  const [accelerator, jetson] = await Promise.all([
    getAcceleratorStatus(config, dependencies),
    dependencies.jetsonTelemetry
      ? dependencies.jetsonTelemetry()
      : readJetsonTelemetry().catch(() => ({ present: false }))
  ]);

  const offload = getOffloadState(config);

  return {
    ...accelerator,
    autoTune: offload
      ? {
          enabled: config.gpuAutoTune,
          tuned: offload.tuned,
          numCtx: offload.numCtx,
          numGpu: offload.numGpu,
          reason: offload.reason
        }
      : { enabled: config.gpuAutoTune, tuned: false },
    jetson
  };
}

function resetRuntimeState() {
  resetAvailabilityCache();
  resetOffloadState();
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
  AVAILABILITY_CACHE_TTL_MS,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_BACKEND,
  DEFAULT_KEEP_ALIVE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_NUM_BATCH,
  DEFAULT_NUM_CTX,
  DEFAULT_NUM_GPU,
  DEFAULT_NUM_THREAD,
  DEFAULT_SYSTEM_PROMPT,
  GPU_STATE,
  MAX_NUM_BATCH,
  MAX_NUM_CTX,
  MAX_NUM_GPU,
  MAX_NUM_THREAD,
  MIN_NUM_BATCH,
  MIN_NUM_CTX,
  SUPPORTED_BACKENDS,
  buildAiMessages,
  buildRuntimeOptions,
  getAccelerationReport,
  getAcceleratorStatus,
  getAiAvailability,
  readJetsonTelemetry,
  resolveOffload,
  normalizeAiConfig,
  pruneContext,
  queryAiModel,
  readJsonBody,
  resetAvailabilityCache,
  resetRuntimeState,
  warmUpModel
};
