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
  restoreOffloadState,
  resetOffloadState,
  resolveOffload,
  tuneOffload
} = require('./gpu-offload.cjs');
const { readJetsonTelemetry } = require('./jetson-telemetry.cjs');
const { buildCacheHint, inferCacheType, readModelGeometry } = require('./kv-cache.cjs');
const { createTimedFetch, createTimeoutError, isAbortError, resolveFetch } = require('./http-utils.cjs');
const { listTensorrtModels, runTensorrtChat, streamTensorrtChat } = require('./tensorrt-service.cjs');

const DEFAULT_AI_BASE_URL = 'http://localhost:11434';
// Untagged on purpose. resolveInstalledModel() below matches an untagged
// request against any installed tag of the same family, so this default follows
// whatever the board pulled - gemma4:e2b-it-qat from the compose files here -
// without naming a tag that a given board may not have room for. Naming one
// would break that: a tagged request that is not installed falls through to the
// family match, which compares against the whole string and never matches.
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
// The answer is bounded by num_predict in normal operation, but the schema
// documents requestTimeoutMs: 0 as "disable the timeout" - and with no timer a
// backend that never stops streaming has nothing to stop it. Measured: 355,150
// NDJSON lines in six seconds, with the answer growing in memory the whole way.
const MAX_ANSWER_CHARS = 200_000;

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

// Number() rather than parseInt: parseInt("1e300") is 1, which turned an
// absurd-but-harmless timeout into a 1 ms one that failed every request.
function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
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

/**
 * Strip userinfo from a URL before it is shown or logged.
 *
 * `http://admin:hunter2@ollama.local:11434` is a legitimate thing to configure
 * and was echoed back verbatim by /ai/status, password included.
 */
function redactUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // Not parseable as a URL; nothing to redact.
  }
  return value;
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

// Deliberately strict rather than coercing: String({}) is "[object Object]",
// which reached the model as a question, and String({toString: 1}) throws a
// TypeError that surfaced as HTTP 502 rather than a 400.
function normalizePrompt(prompt) {
  if (prompt === undefined || prompt === null) {
    return '';
  }
  if (typeof prompt !== 'string') {
    const error = new Error('Prompt must be a string.');
    error.code = 'validation-failed';
    throw error;
  }
  return prompt.trim();
}

function pruneContext(context = {}) {
  return {
    serverId: typeof context.serverId === 'string' ? context.serverId : undefined,
    aiDataPaths: Array.isArray(context.aiDataPaths) ? context.aiDataPaths : [],
    selectedData: typeof context.selectedData === 'object' && context.selectedData !== null ? context.selectedData : {},
    history: typeof context.history === 'object' && context.history !== null ? context.history : undefined
  };
}

// Signal K carries full float precision, which the model has no use for:
// 6 decimals is ~0.11 m of latitude and finer than any sensor on a boat
// reports. Trailing zeros vanish in JSON, so 4.100000 costs three characters.
const PROMPT_DECIMALS = 6;

function roundForPrompt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(value.toFixed(PROMPT_DECIMALS));
  }
  if (Array.isArray(value)) {
    return value.map(roundForPrompt);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundForPrompt(item)]));
  }
  return value;
}

/**
 * Paths the operator asked for that produced no value.
 *
 * The system prompt tells the model to be explicit about missing context, so
 * this information has to survive. Listing every *configured* path alongside
 * the data — as the prompt used to — duplicated each key, since the data is
 * already keyed by path. Only the absences are worth the tokens.
 */
function findUnavailablePaths(configuredPaths, selectedData) {
  const availableKeys = Object.keys(selectedData);

  return configuredPaths.filter((path) => {
    if (typeof path !== 'string' || path.length === 0) {
      return false;
    }
    // A wildcard resolves to whatever it matched; it is absent only if nothing did.
    const base = path.endsWith('.*') ? path.slice(0, -2) : path;
    return !availableKeys.some((key) => key === base || key.startsWith(`${base}.`));
  });
}

/**
 * The context as the model sees it.
 *
 * Every token here is prompt-eval work on the GPU, so this is deliberately
 * tighter than the context returned to the UI: compact JSON instead of
 * two-space indentation, rounded numbers, and absences instead of a second copy
 * of every path name. The wire and UI contract is unchanged.
 */
// Prompt evaluation is GPU time, and it is charged before the first token
// appears. MAX_PROMPT_LENGTH bounds the operator's question but nothing bounded
// the vessel context: ~300 configured leaf paths already serialize to roughly
// 15,000 characters, which at the default num_ctx 8192 leaves no room for
// num_predict 2048 - and llama.cpp answers by silently dropping the oldest
// context rather than erroring, so the operator gets a confident wrong answer.
// Dropping paths explicitly, and saying so, is the same honesty the system
// prompt already demands about missing data.
const MAX_CONTEXT_CHARS = 12000;

// History is charged against the same context window as everything else, and it
// is the part that grows without bound: twelve paths at two hundred samples is
// 2,400 points. It gets its own budget so a long window can never squeeze the
// live snapshot - which answers "what is happening now" - out of the prompt.
const MAX_HISTORY_CONTEXT_CHARS = 6000;

/**
 * Historical series, trimmed to fit.
 *
 * A series that will not fit loses its samples before it is dropped outright:
 * min/max/first/last/average still answer "is it rising?", which is most of
 * what history is asked for, at a twentieth of the tokens.
 */
function buildPromptHistory(history) {
  if (typeof history !== 'object' || history === null) {
    return undefined;
  }

  const { series, ...rest } = history;
  const header = roundForPrompt(rest);
  const entries = typeof series === 'object' && series !== null ? Object.entries(series) : [];
  if (entries.length === 0) {
    return header;
  }

  const kept = {};
  let droppedSeries = 0;
  let trimmedSeries = 0;
  let used = JSON.stringify({ ...header, series: {} }).length;

  for (const [path, summary] of entries) {
    const rounded = roundForPrompt(summary);
    const full = path.length + JSON.stringify(rounded).length + 4;
    if (used + full <= MAX_HISTORY_CONTEXT_CHARS) {
      used += full;
      kept[path] = rounded;
      continue;
    }

    const { samples, ...stats } = rounded && typeof rounded === 'object' ? rounded : {};
    const compact = path.length + JSON.stringify(stats).length + 4;
    if (samples !== undefined && used + compact <= MAX_HISTORY_CONTEXT_CHARS) {
      used += compact;
      kept[path] = stats;
      trimmedSeries += 1;
      continue;
    }

    droppedSeries += 1;
  }

  return {
    ...header,
    series: kept,
    ...(trimmedSeries > 0
      ? { trimmed: `${trimmedSeries} series reduced to summary statistics to fit the context window.` }
      : {}),
    ...(droppedSeries > 0
      ? { truncated: `${droppedSeries} further series omitted to fit the context window.` }
      : {})
  };
}

function buildPromptContext(context) {
  const pruned = pruneContext(context);
  const selectedData = roundForPrompt(pruned.selectedData);
  const unavailablePaths = findUnavailablePaths(pruned.aiDataPaths, selectedData);

  const entries = Object.entries(selectedData);
  let data = selectedData;
  let droppedPaths = 0;

  if (JSON.stringify(selectedData).length > MAX_CONTEXT_CHARS) {
    data = {};
    let used = 0;
    for (const [path, value] of entries) {
      const cost = path.length + JSON.stringify(value ?? null).length + 4;
      if (used + cost > MAX_CONTEXT_CHARS) {
        droppedPaths += 1;
        continue;
      }
      used += cost;
      data[path] = value;
    }
  }

  const history = buildPromptHistory(pruned.history);

  return {
    ...(pruned.serverId ? { serverId: pruned.serverId } : {}),
    data,
    ...(history ? { history } : {}),
    ...(unavailablePaths.length > 0 ? { unavailablePaths } : {}),
    ...(droppedPaths > 0
      ? {
          truncated: `${droppedPaths} further path(s) omitted to fit the model context window; ` +
            'say so if the answer depends on data that is not here.'
        }
      : {})
  };
}

function buildAiMessages(prompt, context, config) {
  const normalizedPrompt = normalizePrompt(prompt);
  const promptContext = buildPromptContext(context);

  return [
    {
      role: 'system',
      content: config.systemPrompt
    },
    {
      role: 'user',
      content:
        `Operator request:\n${normalizedPrompt}\n\n` +
        `Signal K context (JSON, keyed by path):\n${JSON.stringify(promptContext)}\n\n` +
        // Said only when there is history to explain: the samples are
        // `[timestamp, value]` pairs, which is not self-evident from the JSON,
        // and a model that mistakes them for [value, value] reads every trend
        // backwards.
        (promptContext.history
          ? '`history` holds Signal K History API series for the window `from`..`to`. ' +
            'Each series has summary statistics and `samples` as [ISO timestamp, value] pairs, oldest first. ' +
            'Use it for trends and change over time; say so if a series is missing or empty.\n\n'
          : '') +
        'Response requirements:\n' +
        '- Complete every section you begin.\n' +
        '- End with a short final summary.\n' +
        '- Do not stop mid-list or mid-sentence.'
    }
  ];
}

/**
 * Text out of a message content field.
 *
 * `trim` must be false for streamed fragments: the whitespace between tokens
 * lives at the fragment boundaries, so trimming each one welds the words
 * together ("The vessel " + "is making " becomes "The vesselis making"). The
 * assembled answer is trimmed once at the end instead.
 */
function extractTextContent(content, { trim = true } = {}) {
  if (typeof content === 'string') {
    return trim ? content.trim() : content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const joined = content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part === 'object' && part !== null && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('\n');

  return trim ? joined.trim() : joined;
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

/**
 * Whether the installed model declares Ollama's `thinking` capability.
 *
 * A thinking model routes its reasoning into `message.thinking`, and only what
 * is left of num_predict lands in `message.content`. gemma4:e2b-it-qat - the
 * model the compose files pull - declares it, and with a full vessel context
 * the model happily spent its entire output budget reasoning and returned an
 * empty answer. The chat requests pass `think: false` for such models:
 * reasoning tokens are generation time on a Jetson, and none of them reach
 * the operator.
 *
 * Checked against the /api/tags listing the caller already fetched - one
 * round trip per question, shared with the missing-model fallback. The name
 * is resolved the same way the chat's own fallback resolves it, because the
 * default configuration is the untagged `gemma4` and the capability lives on
 * the installed tag it resolves to. Older Ollama servers do not report
 * capabilities, which reads as "don't send the parameter" - never a failed
 * question.
 */
function modelSupportsThinking(modelName, installedModels) {
  const models = installedModels || [];
  const normalized = normalizeModelName(resolveInstalledModel(modelName, models) || modelName);
  const entry = models.find((item) => normalizeModelName(item && item.name) === normalized);
  return Array.isArray(entry && entry.capabilities) && entry.capabilities.includes('thinking');
}

/** The /api/tags listing, or an empty list - a chat must not fail over it. */
async function tryFetchInstalledModels(config, dependencies = {}) {
  try {
    return await fetchInstalledModels(config, dependencies);
  } catch {
    return [];
  }
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

async function runChat(ollama, model, prompt, payload, config, runtimeConfig = config, disableThinking = false) {
  return ollama.chat({
    model,
    stream: false,
    keep_alive: config.keepAlive,
    // Sent only when the model declares the capability: some models cannot
    // switch reasoning off and reject the parameter outright.
    ...(disableThinking ? { think: false } : {}),
    messages: buildAiMessages(prompt, payload && payload.context, config),
    options: buildRuntimeOptions(runtimeConfig)
  });
}

/**
 * "Empty" with reasoning present is its own failure: the model DID generate,
 * but every token went into `message.thinking` and num_predict ran out before
 * the answer began. The bare "empty response" sent operators looking at the
 * network; this names the actual remedy.
 */
function emptyAnswerError(message) {
  const thinking = extractTextContent(message && typeof message === 'object' ? message.thinking : undefined);
  const error = new Error(
    thinking.length > 0
      ? 'The model spent its entire output budget on reasoning and returned no answer. ' +
        'Raise "Max output tokens", or use a model without the thinking capability.'
      : 'AI backend returned an empty response.'
  );
  error.code = 'unknown';
  return error;
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
  const installedModels = await tryFetchInstalledModels(config, dependencies);
  let disableThinking = modelSupportsThinking(modelUsed, installedModels);

  try {
    response = await runChat(ollama, modelUsed, prompt, payload, config, runtimeConfig, disableThinking);
  } catch (error) {
    if (isOutOfMemoryError(error) && config.gpuAutoTune) {
      // Memory pressure can appear after start-up — another process took VRAM,
      // or a longer context grew the cache. Retry once at half the context
      // rather than failing the operator's question outright.
      runtimeConfig = {
        ...runtimeConfig,
        numCtx: Math.max(MIN_NUM_CTX, Math.floor(runtimeConfig.numCtx / 2))
      };
      response = await runChat(ollama, modelUsed, prompt, payload, config, runtimeConfig, disableThinking);
    } else if (isMissingModelError(error, modelUsed)) {
      const resolvedModel =
        resolveInstalledModel(modelUsed, installedModels) || (await resolveChatModel(modelUsed, config, dependencies));
      if (resolvedModel.length === 0 || resolvedModel === modelUsed) {
        throw error;
      }

      modelUsed = resolvedModel;
      disableThinking = modelSupportsThinking(modelUsed, installedModels);
      response = await runChat(ollama, modelUsed, prompt, payload, config, runtimeConfig, disableThinking);
    } else {
      throw error;
    }
  }

  const answer = extractTextContent(
    response && response.message && typeof response.message === 'object' ? response.message.content : undefined
  );

  if (answer.length === 0) {
    throw emptyAnswerError(response && response.message);
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
    // Only a model-identity failure earns a second inference call. Retrying a
    // timeout or a 5xx would cost the operator two full timeout windows and two
    // generations. Mirrors the isMissingModelError guard on the Ollama path.
    const statusCode = Number(error && error.statusCode);
    if (!isMissingModelError(error, modelUsed) && statusCode !== 404) {
      throw error;
    }

    const resolvedModel = await resolveTensorrtModel(modelUsed, config, dependencies);
    if (resolvedModel === undefined || resolvedModel === modelUsed) {
      throw error;
    }
    modelUsed = resolvedModel;
    return runTensorrtChat(messages, modelUsed, config, dependencies);
  }
}

/**
 * Find the id a TensorRT-LLM server actually serves.
 *
 * Ollama's tag and family matching is useless here: `trtllm-serve` derives its
 * id from the engine directory, so it looks nothing like the model name an
 * operator would type. What does hold is that these servers load one engine, so
 * when exactly one model is served and the configured id is not it, that single
 * id is the answer.
 */
async function resolveTensorrtModel(requestedModel, config, dependencies = {}) {
  let served;
  try {
    served = await listTensorrtModels(config, dependencies);
  } catch {
    return undefined;
  }

  const exact = resolveInstalledModel(requestedModel, served);
  if (exact) {
    return exact;
  }

  return served.length === 1 ? served[0].name : undefined;
}

/**
 * Stream an Ollama chat, calling `onToken` for each fragment as it arrives.
 *
 * Throughput is unchanged by streaming — the GPU generates at the same rate —
 * but the operator sees the first token in a few hundred milliseconds instead
 * of waiting for the whole answer. On a Jetson generating at tens of tokens per
 * second, a long vessel summary is the difference between a visible answer and
 * a spinner.
 */
async function streamOllamaModel(prompt, payload, config, dependencies, onToken, signal) {
  const ollama = getOllamaClient(config, dependencies);
  const runtimeConfig = resolveOffload(config);
  const model = normalizeModelName(config.model);
  const disableThinking = modelSupportsThinking(model, await tryFetchInstalledModels(config, dependencies));

  const stream = await ollama.chat({
    model,
    stream: true,
    keep_alive: config.keepAlive,
    ...(disableThinking ? { think: false } : {}),
    messages: buildAiMessages(prompt, payload && payload.context, config),
    options: buildRuntimeOptions(runtimeConfig)
  });

  let answer = '';
  let sawThinking = false;
  let last;
  for await (const chunk of stream) {
    // Breaking out calls .return() on the iterator, which is what actually
    // tells the client library to stop pulling from the backend.
    if (signal && signal.aborted) {
      break;
    }
    last = chunk;
    const message = chunk && typeof chunk.message === 'object' ? chunk.message : undefined;
    if (!sawThinking && message && extractTextContent(message.thinking, { trim: false }).length > 0) {
      sawThinking = true;
    }
    const fragment = extractTextContent(message ? message.content : undefined, { trim: false });
    if (fragment.length > 0) {
      answer += fragment;
      onToken(fragment);
      if (answer.length > MAX_ANSWER_CHARS) {
        break;
      }
    }
  }

  if (signal && signal.aborted) {
    const error = new Error('Client closed the connection.');
    error.code = 'aborted';
    throw error;
  }

  answer = answer.trim();
  if (answer.length === 0) {
    throw emptyAnswerError(sawThinking ? { thinking: 'seen' } : undefined);
  }

  // Ollama puts the usage counters and timings on the final chunk only.
  return {
    answer,
    model: last && typeof last.model === 'string' && last.model.trim().length > 0 ? last.model : model,
    createdAt: toIsoTimestamp(last && last.created_at),
    usage: parseUsage(last),
    performance: parsePerformance(last)
  };
}

/**
 * Stream a chat completion, falling back to a single blocking request for any
 * backend that cannot stream. `onToken` may be called zero times — callers must
 * treat the returned answer as authoritative rather than accumulating tokens
 * themselves.
 */
async function streamAiModel(payload, config, dependencies = {}, onToken = () => {}) {
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

  // A re-tune unloads and reloads the model; starting a generation in the
  // middle of that races the reload and, under OLLAMA_NUM_PARALLEL=1, can kill
  // the runner mid-answer.
  await modelMutation;

  // Replaying through the blocking path is only safe while nothing has reached
  // the client. Once a fragment is out, a retry would duplicate text in the
  // middle of the answer, so a mid-stream failure has to surface as a failure.
  let emitted = false;
  const trackedOnToken = (fragment) => {
    emitted = true;
    onToken(fragment);
  };

  try {
    const signal = payload && payload.signal;
    // A signal that is already aborted means the operator left while the
    // context (history included) was being collected. Both backends send the
    // model request before their first in-stream abort check, so without this
    // the whole prompt evaluation ran on the GPU for a closed socket - the
    // exact waste the abort plumbing exists to prevent.
    if (signal && signal.aborted) {
      const error = new Error('Client closed the connection.');
      error.code = 'aborted';
      throw error;
    }
    return config.backend === 'tensorrt-llm'
      ? await streamTensorrtChat(
          buildAiMessages(prompt, payload && payload.context, config),
          normalizeModelName(config.model),
          config,
          dependencies,
          trackedOnToken,
          signal
        )
      : await streamOllamaModel(prompt, payload, config, dependencies, trackedOnToken, signal);
  } catch (error) {
    // Classify before anything else: an abort raised during the body read is
    // still a timeout, and deciding that after the `emitted` check let a
    // stalled stream surface as code 'unknown' / "This operation was aborted".
    if (payload && payload.signal && payload.signal.aborted) {
      // The operator navigated away. Nothing to report, and definitely not a
      // timeout - re-raise so the route can end quietly.
      throw error;
    }
    const failure = isAbortError(error) ? createTimeoutError(config.requestTimeoutMs) : error;

    if (emitted) {
      throw failure;
    }
    if (failure && (failure.code === 'timeout' || failure.code === 'validation-failed')) {
      throw failure;
    }
    // Replay only for failures that happened *before* generation started and
    // that the blocking ladder can actually resolve: a missing model tag, or
    // memory pressure it can retry at half the context. Falling back on any
    // other error bought a second full generation and a second timeout window
    // - up to 2x requestTimeoutMs before the operator sees the same failure.
    if (isMissingModelError(failure, normalizeModelName(config.model)) || isOutOfMemoryError(failure)) {
      return queryAiModel(payload, config, dependencies);
    }
    throw failure;
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

  // The preload body carries nothing we need, but it has to be consumed so the
  // request's timeout is released rather than left armed until it expires.
  await response.text().catch(() => undefined);
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
async function warmUpModel(config, dependencies = {}, { isCurrent } = {}) {
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

    const offload = await tuneOffload(
      config,
      async (candidate) => {
        if (attempts > 0) {
          // Free the previous resident copy before loading different settings,
          // so the two do not briefly compete for the same unified memory.
          await preloadModel(model, candidate, dependencies, 0).catch(() => {});
        }
        attempts += 1;

        await preloadModel(model, candidate, dependencies);
        return getOllamaGpuStatus({ ...candidate, resolvedModel: model }, dependencies);
      },
      { isCurrent }
    );

    return { warmed: true, model, offload };
  } catch (error) {
    return {
      warmed: false,
      reason: error instanceof Error ? error.message : 'Unknown warm-up failure.'
    };
  }
}

// GGUF attention geometry and on-disk weight size cannot change for a given
// model tag without the model being re-pulled, but both were re-fetched on
// every /ai/status - and fetchModelWeightBytes went to /api/tags a second time,
// defeating the availability cache that sits in front of the first call.
// Measured: three backend round trips per status poll, on the host that is also
// driving the GPU. Cleared by resetRuntimeState().
const modelFactCache = new Map();

function cachedModelFact(key, compute) {
  if (modelFactCache.has(key)) {
    return modelFactCache.get(key);
  }
  const pending = Promise.resolve()
    .then(compute)
    .then((value) => {
      // Only a real answer is worth keeping; a transient failure must not
      // pin "unknown" for the life of the process.
      if (value === undefined) {
        modelFactCache.delete(key);
      }
      return value;
    })
    .catch((error) => {
      modelFactCache.delete(key);
      throw error;
    });
  modelFactCache.set(key, pending);
  return pending;
}

function resetModelFactCache() {
  modelFactCache.clear();
}

/**
 * Ask Ollama for one model's GGUF metadata. Used to compute the KV cache
 * footprint, which is how the plugin infers whether the inference server is
 * running with flash attention and a quantized cache.
 */
async function fetchModelGeometry(model, config, dependencies = {}) {
  return cachedModelFact(`geometry|${config.baseUrl}|${model}`, () =>
    fetchModelGeometryUncached(model, config, dependencies)
  );
}

async function fetchModelGeometryUncached(model, config, dependencies = {}) {
  try {
    const fetchImpl = resolveFetch(dependencies);
    const response = await createTimedFetch(fetchImpl, config.requestTimeoutMs)(`${config.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    });

    if (!response.ok) {
      return undefined;
    }

    return readModelGeometry(await response.json());
  } catch {
    return undefined;
  }
}

/** On-disk size of the resolved model, which approximates the weight footprint. */
async function fetchModelWeightBytes(model, config, dependencies = {}) {
  return cachedModelFact(`weights|${config.baseUrl}|${model}`, () =>
    fetchModelWeightBytesUncached(model, config, dependencies)
  );
}

async function fetchModelWeightBytesUncached(model, config, dependencies = {}) {
  try {
    const installed = await fetchInstalledModels(config, dependencies);
    const entry = installed.find((item) => normalizeModelName(item && item.name) === normalizeModelName(model));
    const size = Number(entry && entry.size);
    return Number.isFinite(size) && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Infer whether the backend is running with a quantized KV cache.
 *
 * Only meaningful once a model is resident: the whole method is to compare the
 * resident footprint against the weights and attribute the difference to the
 * cache. Returns undefined whenever any input is missing, rather than guessing.
 */
async function getCacheHint(config, accelerator, dependencies = {}) {
  if (config.backend !== 'ollama' || accelerator.state === GPU_STATE.NOT_LOADED) {
    return undefined;
  }

  const model = accelerator.model || config.resolvedModel || config.model;
  const residentBytes = accelerator.totalBytes;
  if (!model || !Number.isFinite(residentBytes)) {
    return undefined;
  }

  const [geometry, weightBytes] = await Promise.all([
    fetchModelGeometry(model, config, dependencies),
    fetchModelWeightBytes(model, config, dependencies)
  ]);

  const numCtx = resolveOffload(config).numCtx;
  const inference = inferCacheType(geometry, numCtx, residentBytes, weightBytes);
  const hint = buildCacheHint(inference);
  if (!hint) {
    return undefined;
  }

  return { ...hint, numCtx, ...inference };
}

// TensorRT-LLM builds kernels for SM 8.0 and newer only. On an older Tegra the
// backend cannot be made to work by any amount of configuration.
const MIN_TENSORRT_COMPUTE_CAPABILITY = 8;

/**
 * Is this backend running on the same host as Signal K?
 *
 * Only a backend on this host can be attributed to this host's GPU. A Xavier
 * running Signal K is perfectly entitled to ask an Orin across the boat network
 * for TensorRT-LLM answers, and warning about the local GPU then would be
 * simply wrong.
 *
 * The whole 127.0.0.0/8 range counts, not just 127.0.0.1: every address in it
 * is loopback, and `http://127.0.0.2:8000` is as local as the canonical one.
 * URL keeps the brackets on an IPv6 hostname, so they come off before matching.
 */
function isLoopbackBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Warn when the configured backend cannot run on the GPU this host actually has.
 *
 * Without it the operator sees only "TensorRT-LLM is unreachable" and has no
 * way to tell a container that has not started yet from one that can never
 * start, which on a Xavier is the difference between waiting and reconfiguring.
 */
function unsupportedBackendWarning(config, jetson) {
  if (config.backend !== 'tensorrt-llm' || !jetson || !jetson.present) {
    return undefined;
  }
  if (!isLoopbackBaseUrl(config.baseUrl)) {
    return undefined;
  }

  const gpu = jetson.gpu;
  if (
    !gpu ||
    typeof gpu.computeCapability !== 'number' ||
    gpu.computeCapability >= MIN_TENSORRT_COMPUTE_CAPABILITY
  ) {
    return undefined;
  }

  return (
    `This board's GPU is ${gpu.architecture} (compute capability ${gpu.computeCapability}), and ` +
    `TensorRT-LLM requires ${MIN_TENSORRT_COMPUTE_CAPABILITY}.0 or newer, so no TensorRT-LLM ` +
    'server can run on it. Set the inference backend back to "ollama", whose CUDA runner is ' +
    `built for this GPU — it is the fastest backend available on ${gpu.architecture} Tegra.`
  );
}

/**
 * Everything the panel needs to answer "is this running on the GPU, and is that
 * GPU running flat out?" — model residency from the inference backend, plus
 * board-level power and clock state when Signal K shares a host with it.
 */
async function getAccelerationReport(config, dependencies = {}) {
  const [accelerator, jetson] = await Promise.all([
    getAcceleratorStatus(config, dependencies),
    // Either source may fail; neither should turn the status page into a 500.
    (dependencies.jetsonTelemetry ? dependencies.jetsonTelemetry() : readJetsonTelemetry()).catch(() => ({
      present: false
    }))
  ]);

  const offload = getOffloadState(config);
  const cache = await getCacheHint(config, accelerator, dependencies);

  // Appended rather than mutated: the panel already renders jetson.warnings, so
  // a board-level backend mismatch belongs in the same list as the power-mode
  // and thermal advice instead of needing its own UI.
  const backendWarning = unsupportedBackendWarning(config, jetson);
  const board = backendWarning
    ? { ...jetson, warnings: [...(jetson.warnings ?? []), backendWarning] }
    : jetson;

  return {
    ...accelerator,
    cache,
    autoTune: offload
      ? {
          enabled: config.gpuAutoTune,
          tuned: offload.tuned,
          numCtx: offload.numCtx,
          numGpu: offload.numGpu,
          reason: offload.reason
        }
      : { enabled: config.gpuAutoTune, tuned: false },
    jetson: board
  };
}

/**
 * Re-run the GPU fit from the configured settings.
 *
 * The start-up tuner only ever shrinks: once it settles on a context window it
 * keeps it for the life of the run, so memory freed later (another process
 * exiting, a smaller model loaded) goes unused until a restart. This discards
 * the tuned state and measures again, and is deliberately operator-triggered —
 * re-tuning reloads the model, which is not something to do behind their back
 * mid-voyage.
 */
// A re-tune loads and unloads the model up to four times. Two of them at once
// interleave those loads in the same unified memory and race each other's
// recorded result; a burst of them is a cheap way for anyone who can reach the
// route to thrash the accelerator (measured: 10 concurrent calls, 70 preloads).
// One in-flight run, shared by every caller.
let retuneInFlight = null;

// Inference must not start while the model is being unloaded and reloaded
// underneath it, and a re-tune must not begin mid-answer. Both wait on this.
let modelMutation = Promise.resolve();

function whileModelIsStable(run) {
  const next = modelMutation.then(run, run);
  // Keep the chain alive even when a link rejects, or one failure would wedge
  // every later request.
  modelMutation = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function retuneOffload(config, dependencies = {}) {
  if (retuneInFlight) {
    return retuneInFlight;
  }
  retuneInFlight = runRetune(config, dependencies).finally(() => {
    retuneInFlight = null;
  });
  return retuneInFlight;
}

async function runRetune(config, dependencies = {}) {
  return whileModelIsStable(async () => {
  // Whatever the tuner previously proved fits. Clearing it up front meant a
  // re-tune that failed - backend down, model pulled out from under us - left
  // the plugin running at the untuned settings the tuner had already rejected,
  // and the operator's only remedy was the thing that broke it.
  const previous = getOffloadState(config);

  // A re-tune is the operator saying "conditions changed". Availability is
  // cached for five seconds, so without this a re-tune moments after starting
  // Ollama would be answered from the stale "unreachable" probe.
  resetAvailabilityCache();
  resetOffloadState();

  const result = await warmUpModel({ ...config, warmupOnStart: true }, dependencies);

  if (!result.warmed) {
    if (previous) {
      restoreOffloadState(config, previous);
    }
    return {
      retuned: false,
      reason: result.reason,
      model: result.model,
      offload: previous
    };
  }

  return {
    retuned: true,
    reason: result.reason,
    model: result.model,
    offload: result.offload ?? getOffloadState(config)
  };
  });
}

function resetRuntimeState() {
  resetAvailabilityCache();
  resetOffloadState();
  resetModelFactCache();
  retuneInFlight = null;
  modelMutation = Promise.resolve();
}

// A body larger than this is not a question about a boat. signalk-server
// normally mounts its own 10 MB JSON parser ahead of us, so this only bites
// when the plugin is driven directly, but an uncapped Buffer.concat is not
// something to leave in a route that anyone on the LAN can reach.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function badRequest(message) {
  const error = new Error(message);
  error.code = 'validation-failed';
  return error;
}

async function readJsonBody(req) {
  if (req && typeof req.body === 'object' && req.body !== null) {
    return req.body;
  }

  // Anything that is not a readable stream at this point is a malformed call,
  // not a backend problem: without this the async-iteration failure surfaced as
  // HTTP 502 with "req is not async iterable" in the operator's face.
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    throw badRequest('Request body must be JSON.');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw badRequest('Request body is too large.');
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (rawBody.length === 0) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    // The parser's own message names offsets in a body we will not show back,
    // and arriving as a 502 made a client error look like a backend failure.
    throw badRequest('Request body is not valid JSON.');
  }
}

module.exports = {
  AVAILABILITY_CACHE_TTL_MS,
  redactUrl,
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
  buildPromptContext,
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
  retuneOffload,
  streamAiModel,
  warmUpModel
};
