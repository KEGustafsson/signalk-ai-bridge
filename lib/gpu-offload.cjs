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

// Ollama refuses an over-large model in the scheduler, long before CUDA is
// asked for anything: "model requires more system memory (5.5 GiB) than is
// available (3.2 GiB)". The kernel OOM-killer case arrives as "llama runner
// process has terminated: signal: killed". Neither says "out of memory", and
// missing them made the ladder treat a genuine fit failure as a broken backend
// and give up without ever halving the context - the one case it exists for.
// `oom` is word-bounded so it cannot match "room" or "zoom" in a body slice.
//
// The cuBLAS statuses are the same story one layer down: on a Jetson's
// unified memory, CUBLAS_STATUS_NOT_INITIALIZED is what cublasCreate returns
// when the runtime cannot allocate its workspace - memory pressure wearing an
// initialization error's name. Measured on a Xavier NX: a question that fit
// yesterday failed with exactly this once other processes had taken the RAM,
// and surfacing it raw sent the operator debugging CUDA instead of retrying
// at half the context.
const OUT_OF_MEMORY_PATTERN = new RegExp(
  [
    'out of memory',
    '\\boom\\b',
    'cudamalloc',
    'failed to allocate',
    'insufficient memory',
    'no memory',
    'unable to allocate',
    'cannot allocate',
    'not enough memory',
    'requires more (?:system |vram |gpu )?memory',
    'than is available',
    'signal: killed',
    'cublas_status_not_initialized',
    'cublas_status_alloc_failed'
  ].join('|'),
  'i'
);

function isOutOfMemoryError(error) {
  const message =
    typeof error === 'object' && error !== null && typeof error.message === 'string' ? error.message : '';
  return OUT_OF_MEMORY_PATTERN.test(message);
}

const offloadState = new Map();

// The tuning inputs belong in the key. Without numCtx/numGpu/gpuAutoTune, a
// result measured for one configuration was served to the next one - so an
// operator who lowered num_ctx after an OOM kept running at the old window,
// because a stop/start reuses the same backend|url|model key.
function offloadKey(config) {
  return [
    config.backend,
    config.baseUrl,
    config.model,
    config.numCtx,
    config.numGpu,
    config.gpuAutoTune ? 'auto' : 'fixed'
  ].join('|');
}

function resetOffloadState() {
  offloadState.clear();
}

/** Put back a previously measured result, e.g. after a re-tune failed. */
function restoreOffloadState(config, state) {
  if (state) {
    offloadState.set(offloadKey(config), state);
  }
  return state;
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

function recordOffload(config, state, isCurrent) {
  // A warm-up outlives the plugin generation that started it. Writing its
  // result after a stop() - or after a restart with different options - is how
  // a discarded configuration came back to life on the next request.
  if (typeof isCurrent === 'function' && !isCurrent()) {
    return state;
  }
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
async function tuneOffload(config, attempt, { isCurrent } = {}) {
  const key = offloadKey(config);
  const explicitLayers = typeof config.numGpu === 'number' && config.numGpu >= 0;

  if (!config.gpuAutoTune) {
    const settings = { numCtx: config.numCtx, numGpu: requestedLayers(config) };
    return recordOffload(config, { ...settings, tuned: false, reason: 'auto-tuning disabled' }, isCurrent);
  }

  // numGpu 0 is the operator pinning the model to the CPU on purpose. /api/ps
  // then reports no VRAM, which reads as "spilled", and the ladder would halve
  // the context four times chasing a GPU that was never in play - leaving every
  // later request at MIN_NUM_CTX for the life of the process.
  if (explicitLayers && config.numGpu === 0) {
    return recordOffload(config, {
      numCtx: config.numCtx,
      numGpu: 0,
      tuned: false,
      reason: 'Pinned to the CPU by configuration; there is no GPU placement to tune.'
    }, isCurrent);
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
      }, isCurrent);
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
      }, isCurrent);
    }

    // Not one byte on the GPU at the largest context: the accelerator is not
    // participating at all (no CUDA runner, driver mismatch, CPU-only host).
    // A smaller KV cache cannot change that, so stop instead of paying three
    // more multi-second model reloads to reach the same answer.
    if (step === 0 && residency.state === GPU_STATE.CPU && residency.vramBytes === 0) {
      return recordOffload(config, {
        numCtx,
        numGpu,
        tuned: false,
        steps,
        reason:
          'The backend placed no layers on the GPU at the configured context window, ' +
          'so the GPU is not being used at all. Check that the inference server has CUDA ' +
          'available - reducing the context window cannot change this.'
      }, isCurrent);
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
  // Hand the split back to the estimator *and* restore the operator's context
  // window. Keeping the smallest value tried would cap every later prompt for
  // no benefit: we just established that shrinking did not change residency.
  return recordOffload(config, {
    numCtx: config.numCtx,
    numGpu: fallbackLayers,
    tuned: true,
    steps,
    reason:
      'The model does not fit in GPU memory even at the smallest context window. ' +
      'Letting the backend choose the split — use a smaller or more heavily quantized model for full GPU execution.'
  }, isCurrent);
}

module.exports = {
  FORCE_ALL_LAYERS,
  MAX_TUNING_STEPS,
  getOffloadState,
  isOutOfMemoryError,
  resetOffloadState,
  resolveOffload,
  restoreOffloadState,
  tuneOffload
};
