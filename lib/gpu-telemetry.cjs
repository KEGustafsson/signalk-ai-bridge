'use strict';

const { createTimedFetch, resolveFetch } = require('./http-utils.cjs');

const GPU_STATE = {
  GPU: 'gpu',
  PARTIAL: 'partial',
  CPU: 'cpu',
  NOT_LOADED: 'not-loaded',
  UNKNOWN: 'unknown'
};

// Ollama reports the split as whole bytes, and rounding inside its estimator
// means a fully offloaded model is not always byte-identical to its total size.
const FULL_OFFLOAD_RATIO = 0.995;

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** exponent;
  return `${scaled.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function matchesModel(entry, model) {
  if (typeof model !== 'string' || model.trim().length === 0) {
    return true;
  }
  const wanted = model.trim();
  const candidates = [entry && entry.name, entry && entry.model]
    .filter((value) => typeof value === 'string' && value.length > 0);

  return candidates.some(
    (candidate) => candidate === wanted || candidate.startsWith(`${wanted}:`)
  );
}

function describe(state, vramBytes, totalBytes) {
  switch (state) {
    case GPU_STATE.GPU:
      return `Model is fully resident in GPU memory (${formatBytes(vramBytes)}); inference runs on the CUDA cores.`;
    case GPU_STATE.PARTIAL:
      return (
        `Only ${formatBytes(vramBytes)} of ${formatBytes(totalBytes)} is on the GPU — the remaining layers run on the CPU. ` +
        'Lower "GPU context window" (num_ctx) or pick a smaller/more quantized model so the whole model fits in unified memory.'
      );
    case GPU_STATE.CPU:
      return (
        'The model is loaded entirely on the CPU. Check that the inference container has the NVIDIA runtime and GPU device ' +
        'reservations enabled, then lower "GPU context window" (num_ctx) so the KV cache fits alongside the weights.'
      );
    case GPU_STATE.NOT_LOADED:
      return 'The model is not loaded right now, so GPU residency is unknown. Ask a question or enable model warm-up.';
    default:
      return 'The inference backend did not report GPU residency.';
  }
}

/**
 * Read GPU residency for the configured model from Ollama's `/api/ps`.
 *
 * This is the check that answers "is this actually hardware accelerated?".
 * llama.cpp will happily fall back to the host CPU when the weights plus KV
 * cache do not fit, and nothing in a chat response says that happened — the
 * only symptom is that a Jetson Orin Nano Super answers at a couple of tokens
 * per second instead of tens.
 */
async function getOllamaGpuStatus(config, dependencies = {}) {
  let response;
  try {
    const fetchImpl = resolveFetch(dependencies);
    response = await createTimedFetch(fetchImpl, config.requestTimeoutMs)(`${config.baseUrl}/api/ps`, {
      method: 'GET'
    });
  } catch (error) {
    return {
      supported: true,
      state: GPU_STATE.UNKNOWN,
      message:
        error instanceof Error && error.message
          ? `Could not read GPU residency from Ollama: ${error.message}`
          : 'Could not read GPU residency from Ollama.'
    };
  }

  if (!response.ok) {
    return {
      supported: true,
      state: GPU_STATE.UNKNOWN,
      message: `Ollama /api/ps returned ${response.status}.`
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      supported: true,
      state: GPU_STATE.UNKNOWN,
      message: 'Ollama /api/ps returned a response that is not valid JSON.'
    };
  }

  const running = Array.isArray(payload && payload.models) ? payload.models : [];
  const entry = running.find((item) => matchesModel(item, config.resolvedModel || config.model));

  if (!entry) {
    return {
      supported: true,
      state: GPU_STATE.NOT_LOADED,
      loadedModels: running.length,
      message: describe(GPU_STATE.NOT_LOADED)
    };
  }

  const totalBytes = toFiniteNumber(entry.size);
  const vramBytes = toFiniteNumber(entry.size_vram) ?? 0;
  const vramRatio =
    typeof totalBytes === 'number' && totalBytes > 0 ? vramBytes / totalBytes : undefined;

  let state = GPU_STATE.UNKNOWN;
  if (typeof vramRatio === 'number') {
    if (vramRatio >= FULL_OFFLOAD_RATIO) {
      state = GPU_STATE.GPU;
    } else if (vramBytes > 0) {
      state = GPU_STATE.PARTIAL;
    } else {
      state = GPU_STATE.CPU;
    }
  }

  return {
    supported: true,
    state,
    model: typeof entry.name === 'string' ? entry.name : config.model,
    totalBytes,
    vramBytes,
    vramRatio: typeof vramRatio === 'number' ? Number(vramRatio.toFixed(4)) : undefined,
    expiresAt: typeof entry.expires_at === 'string' ? entry.expires_at : undefined,
    loadedModels: running.length,
    message: describe(state, vramBytes, totalBytes)
  };
}

async function getAcceleratorStatus(config, dependencies = {}) {
  if (config.backend === 'tensorrt-llm') {
    return {
      supported: false,
      state: GPU_STATE.GPU,
      message:
        'TensorRT-LLM serves prebuilt CUDA engines, so inference is GPU-resident by construction. ' +
        'Residency is fixed when the engine is built, not per request.'
    };
  }

  return getOllamaGpuStatus(config, dependencies);
}

module.exports = {
  FULL_OFFLOAD_RATIO,
  GPU_STATE,
  formatBytes,
  getAcceleratorStatus,
  getOllamaGpuStatus
};
