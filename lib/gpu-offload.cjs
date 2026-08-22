'use strict';

const { MIN_NUM_CTX } = require('./accel-config.cjs');
const { GPU_STATE } = require('./gpu-telemetry.cjs');

/**
 * Drive the model onto the GPU instead of hoping it lands there.
 *
 * Reporting residency is not the same as achieving it. llama.cpp decides the
 * CPU/GPU split from the memory its estimator thinks is free, and on a Jetson's
 * unified pool that estimate is conservative: the common outcome is a handful
 * of layers quietly left on the CPU, which costs far more throughput than the
 * layer count suggests because every token then crosses the boundary twice.
 *
 * So instead of accepting whatever split we get, the plugin asks for full
 * offload and shrinks the context window until the whole model is resident.
 * The KV cache is the only part of the footprint the plugin controls, and it
 * scales linearly with num_ctx, so halving it is a direct lever on fit.
 *
 * The ladder is bounded and always terminates:
 *   1. full offload at the configured context
 *   2. halve the context, up to MAX_TUNING_STEPS times (never below MIN_NUM_CTX)
 *   3. give up on forcing and hand the split back to Ollama's own estimator
 *
 * Step 3 matters: a model that genuinely cannot fit must still answer, on the
 * CPU if that is all there is, rather than failing with an allocation error.
 */

// Full offload. llama.cpp clamps to the real layer count, so any number above
// it means "all layers"; Ollama's -1 means "estimate", which is what we are
// deliberately overriding.
const FORCE_ALL_LAYERS = 999;
const MAX_TUNING_STEPS = 3;

const OUT_OF_MEMORY_PATTERN =
  /out of memory|oom|cudamalloc|failed to allocate|insufficient memory|no memory|unable to allocate/i;

function isOutOfMemoryError(error) {
  const message =
    typeof error === 'object' && error !== null && typeof error.message === 'string' ? error.message : '';
  return OUT_OF_MEMORY_PATTERN.test(message);
}

const offloadState = new Map();

function offloadKey(config) {
  return `${config.backend}|${config.baseUrl}|${config.model}`;
}

function resetOffloadState() {
  offloadState.clear();
}

/**
 * The layer count to request. An explicit `numGpu` from the operator always
 * wins — including 0, which is a deliberate "run it on the CPU so I can compare".
 */
function requestedLayers(config) {
  if (typeof config.numGpu === 'number' && config.numGpu >= 0) {
    return config.numGpu;
  }
  return config.gpuAutoTune ? FORCE_ALL_LAYERS : -1;
}

/**
 * Effective accelerator settings for the next request: the tuned values when
 * the start-up probe found something better, the configured ones otherwise.
 */
function resolveOffload(config) {
  const tuned = offloadState.get(offloadKey(config));
  return {
    ...config,
    numCtx: tuned?.numCtx ?? config.numCtx,
    numGpu: tuned?.numGpu ?? requestedLayers(config)
  };
}

function getOffloadState(config) {
  return offloadState.get(offloadKey(config));
}

function recordOffload(config, state) {
  offloadState.set(offloadKey(config), state);
  return state;
}

/**
 * Walk the ladder until the model is fully GPU resident.
 *
 * `attempt(candidate)` must load the model with those settings and resolve to a
 * residency report from gpu-telemetry; it may reject, which is treated the same
 * as "did not fit" when the error looks like an allocation failure.
 */
async function tuneOffload(config, attempt) {
  const key = offloadKey(config);
  const explicitLayers = typeof config.numGpu === 'number' && config.numGpu >= 0;

  if (!config.gpuAutoTune) {
    const settings = { numCtx: config.numCtx, numGpu: requestedLayers(config) };
    return recordOffload(config, { ...settings, tuned: false, reason: 'auto-tuning disabled' });
  }

  let numCtx = config.numCtx;
  const numGpu = requestedLayers(config);
  const steps = [];

  for (let step = 0; step <= MAX_TUNING_STEPS; step += 1) {
    let residency;
    try {
      residency = await attempt({ ...config, numCtx, numGpu });
    } catch (error) {
      if (!isOutOfMemoryError(error)) {
        // Not a fit problem — the backend is down, the model is missing, and
        // so on. Leave the configuration alone and let the caller report it.
        offloadState.delete(key);
        throw error;
      }
      residency = { state: GPU_STATE.CPU };
    }

    steps.push({ numCtx, numGpu, state: residency.state });

    if (residency.state === GPU_STATE.GPU) {
      return recordOffload(config, {
        numCtx,
        numGpu,
        tuned: step > 0,
        steps,
        reason:
          step === 0
            ? 'Full GPU offload at the configured context window.'
            : `Context window reduced to ${numCtx} tokens so every layer fits in GPU memory.`
      });
    }

    // Residency we cannot act on: nothing is loaded, or the backend does not
    // report a split. Keep the configured settings rather than shrinking blind.
    if (residency.state !== GPU_STATE.PARTIAL && residency.state !== GPU_STATE.CPU) {
      return recordOffload(config, {
        numCtx,
        numGpu,
        tuned: step > 0,
        steps,
        reason: 'Backend did not report a CPU/GPU split; keeping the configured settings.'
      });
    }

    const nextNumCtx = Math.max(MIN_NUM_CTX, Math.floor(numCtx / 2));
    if (step < MAX_TUNING_STEPS && nextNumCtx < numCtx) {
      numCtx = nextNumCtx;
      continue;
    }

    break;
  }

  // Nothing we can shrink made it fit. Forcing every layer onto a GPU that
  // cannot hold them turns a slow answer into no answer, so hand the split
  // back to the backend's estimator unless the operator pinned it themselves.
  const fallbackLayers = explicitLayers ? config.numGpu : -1;
  return recordOffload(config, {
    numCtx,
    numGpu: fallbackLayers,
    tuned: true,
    steps,
    reason:
      'The model does not fit in GPU memory even at the smallest context window. ' +
      'Letting the backend choose the split — use a smaller or more heavily quantized model for full GPU execution.'
  });
}

module.exports = {
  FORCE_ALL_LAYERS,
  MAX_TUNING_STEPS,
  getOffloadState,
  isOutOfMemoryError,
  resetOffloadState,
  resolveOffload,
  tuneOffload
};
