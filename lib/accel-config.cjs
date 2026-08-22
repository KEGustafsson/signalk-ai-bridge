'use strict';

/**
 * Hardware-acceleration configuration for the AI backends.
 *
 * The bridge itself does no tensor math — the whole compute cost of a request
 * lives in the inference server (Ollama/llama.cpp with the CUDA backend, or
 * TensorRT-LLM). What the plugin controls is the request shape, and on a
 * Jetson Orin Nano Super that shape decides whether the model is resident in
 * GPU memory or spilled onto the 6 Cortex-A78AE cores.
 *
 * The unified LPDDR5 pool on an Orin Nano Super is 8 GB shared between CPU and
 * GPU, so the KV cache competes with the weights for the same bytes. A context
 * window sized like a datacentre GPU's is the single most common reason an
 * otherwise CUDA-capable install ends up running partly (or entirely) on CPU:
 * llama.cpp reserves KV cache up front from `num_ctx`, and when the reservation
 * no longer fits it silently drops layers back to the host.
 */

// Ollama's own default is 2048; 8192 keeps the vessel context plus a useful
// answer in-window while leaving room for the weights inside 8 GB of unified
// memory. At q8_0 KV a 4B-class model needs roughly 0.5 GB of cache here,
// against ~8 GB for the 131072 the plugin used to request.
const DEFAULT_NUM_CTX = 8192;

// Output budget only (`num_predict`). Separated from `num_ctx` so raising the
// answer length can no longer resize the KV cache.
const DEFAULT_MAX_TOKENS = 2048;

// -1 lets Ollama's memory estimator pick the layer split. With a sane num_ctx
// that estimate lands on "all layers on the GPU" for the Gemma models this
// plugin targets. Set a high explicit count (e.g. 999) to force full offload,
// or 0 to pin the model to the CPU.
const DEFAULT_NUM_GPU = -1;

// llama.cpp's prompt-eval batch. The Orin Ampere GPU is throughput-bound on
// prompt eval, so keeping the default 512 (rather than a small batch) matters
// for the large Signal K context this plugin sends.
const DEFAULT_NUM_BATCH = 512;

// 0 = let the runtime pick. Only used for whatever stays on the CPU.
const DEFAULT_NUM_THREAD = 0;

// Keeping the model resident avoids re-reading several GB from eMMC/NVMe on
// every ask. Ollama's default is 5 minutes, which for an operator who asks a
// question every so often means a cold load nearly every time.
const DEFAULT_KEEP_ALIVE = '30m';

const DEFAULT_BACKEND = 'ollama';
const SUPPORTED_BACKENDS = ['ollama', 'tensorrt-llm'];

const MIN_NUM_CTX = 512;
const MAX_NUM_CTX = 131072;
const MAX_NUM_GPU = 999;
const MIN_NUM_BATCH = 32;
const MAX_NUM_BATCH = 4096;
const MAX_NUM_THREAD = 64;

// `10m`, `30s`, `1h`, a bare seconds count, or `-1` for "never unload".
const KEEP_ALIVE_PATTERN = /^-?\d+(\.\d+)?(ms|s|m|h)?$/;

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBackend(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (SUPPORTED_BACKENDS.includes(normalized)) {
    return normalized;
  }
  // `trtllm`, `tensorrt`, `trt-llm` all mean the same OpenAI-compatible server.
  if (/^(trt|trtllm|tensorrt|trt-llm|tensorrt_llm|openai)$/.test(normalized)) {
    return 'tensorrt-llm';
  }
  return DEFAULT_BACKEND;
}

function normalizeKeepAlive(value, fallback = DEFAULT_KEEP_ALIVE) {
  const normalized = String(value ?? '').trim();
  if (normalized.length === 0) {
    return fallback;
  }
  return KEEP_ALIVE_PATTERN.test(normalized) ? normalized : fallback;
}

function normalizeAccelConfig(options = {}, env = {}) {
  return {
    backend: normalizeBackend(options.backend ?? env.SIGNALK_AI_BRIDGE_BACKEND),
    numCtx: clampInteger(
      options.numCtx ?? env.SIGNALK_AI_BRIDGE_NUM_CTX,
      DEFAULT_NUM_CTX,
      MIN_NUM_CTX,
      MAX_NUM_CTX
    ),
    numGpu: clampInteger(
      options.numGpu ?? env.SIGNALK_AI_BRIDGE_NUM_GPU,
      DEFAULT_NUM_GPU,
      -1,
      MAX_NUM_GPU
    ),
    numBatch: clampInteger(
      options.numBatch ?? env.SIGNALK_AI_BRIDGE_NUM_BATCH,
      DEFAULT_NUM_BATCH,
      MIN_NUM_BATCH,
      MAX_NUM_BATCH
    ),
    numThread: clampInteger(
      options.numThread ?? env.SIGNALK_AI_BRIDGE_NUM_THREAD,
      DEFAULT_NUM_THREAD,
      0,
      MAX_NUM_THREAD
    ),
    keepAlive: normalizeKeepAlive(options.keepAlive ?? env.SIGNALK_AI_BRIDGE_KEEP_ALIVE)
  };
}

/**
 * llama.cpp runtime options for one Ollama chat/generate request.
 *
 * `num_gpu: -1` is Ollama's "estimate the split yourself" sentinel and must be
 * omitted rather than sent, otherwise it is taken literally as a layer count.
 */
function buildRuntimeOptions(config) {
  const options = {
    temperature: config.temperature,
    top_p: config.topP,
    num_predict: config.maxTokens,
    num_ctx: config.numCtx,
    num_batch: config.numBatch
  };

  if (typeof config.numGpu === 'number' && config.numGpu >= 0) {
    options.num_gpu = config.numGpu;
  }
  if (typeof config.numThread === 'number' && config.numThread > 0) {
    options.num_thread = config.numThread;
  }

  return options;
}

module.exports = {
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
  normalizeAccelConfig,
  normalizeBackend,
  normalizeKeepAlive
};
