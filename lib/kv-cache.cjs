'use strict';

/**
 * KV cache accounting, used to tell whether the inference server is running
 * with the accelerator settings that make a Jetson viable.
 *
 * Ollama exposes no endpoint that reports its own configuration, so there is no
 * way to ask whether OLLAMA_FLASH_ATTENTION or OLLAMA_KV_CACHE_TYPE are set.
 * What it does expose is enough to work it out arithmetically: `/api/show`
 * gives the model's GGUF geometry, `/api/tags` gives the on-disk weight size,
 * and `/api/ps` gives the resident size. The difference between resident and
 * weights is dominated by the KV cache, whose size is exactly computable from
 * the geometry and the context length — and differs by 2x between f16 and q8_0.
 *
 * This is an estimate and is reported as one. Compute buffers also live in that
 * difference, and Ollama's size accounting has changed across releases, so the
 * output says "this looks like f16" and shows the numbers rather than asserting
 * a configuration.
 */

// Bytes per element for each llama.cpp cache type. The quantized formats carry
// a scale per 32-value block: q8_0 is 34 bytes per block, q4_0 is 18.
const CACHE_TYPE_BYTES = {
  f16: 2,
  q8_0: 34 / 32,
  q4_0: 18 / 32
};

// The estimate ignores compute buffers, which are tens to low hundreds of MiB.
// A candidate has to be within this fraction of the observed overhead before we
// are willing to name it.
const MATCH_TOLERANCE = 0.45;

// Compute/graph buffers that the cache estimate deliberately excludes. Sized
// generously: an Orin at num_ctx 8192 / num_batch 512 sits well inside this.
const MAX_COMPUTE_BUFFER_BYTES = 768 * 1024 * 1024;

function firstFinite(value) {
  // GGUF exposes some per-layer values as arrays (models with mixed attention).
  // Every layer shares the geometry we care about, so the first entry is fine.
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Pull the attention geometry out of an `/api/show` response.
 *
 * GGUF keys are namespaced by architecture ("gemma3.block_count"), so the
 * architecture has to be read first. key_length/value_length are optional —
 * when absent they are the embedding size divided by the head count.
 */
function readModelGeometry(showPayload) {
  const info = showPayload && typeof showPayload === 'object' ? showPayload.model_info : undefined;
  if (!info || typeof info !== 'object') {
    return undefined;
  }

  const architecture = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : undefined;
  if (!architecture) {
    return undefined;
  }

  const read = (suffix) => firstFinite(info[`${architecture}.${suffix}`]);

  const blockCount = read('block_count');
  const headCount = read('attention.head_count');
  const headCountKv = read('attention.head_count_kv') ?? headCount;
  const embeddingLength = read('embedding_length');

  const derivedHeadDim =
    embeddingLength !== undefined && headCount !== undefined ? embeddingLength / headCount : undefined;
  const keyLength = read('attention.key_length') ?? derivedHeadDim;
  const valueLength = read('attention.value_length') ?? derivedHeadDim;

  if (blockCount === undefined || headCountKv === undefined || keyLength === undefined || valueLength === undefined) {
    return undefined;
  }

  // Interleaved sliding-window attention: most layers allocate the window, not
  // the full context. The caller uses this to decline to guess a cache type.
  const slidingWindow = read('attention.sliding_window');

  return {
    architecture,
    blockCount,
    headCountKv,
    keyLength,
    valueLength,
    ...(slidingWindow !== undefined && slidingWindow > 0 ? { slidingWindow } : {})
  };
}

/**
 * Bytes of KV cache for `numCtx` tokens at a given cache type.
 *
 * Two tensors (keys and values) per layer, each holding one vector per KV head
 * per token.
 */
function estimateKvCacheBytes(geometry, numCtx, cacheType) {
  const bytesPerElement = CACHE_TYPE_BYTES[cacheType];
  if (!geometry || !bytesPerElement || !Number.isFinite(numCtx) || numCtx <= 0) {
    return undefined;
  }

  return Math.round(
    numCtx *
      geometry.blockCount *
      geometry.headCountKv *
      (geometry.keyLength + geometry.valueLength) *
      bytesPerElement
  );
}

/**
 * Guess which cache type the backend is using from the resident footprint.
 *
 * Returns `undefined` for `likelyCacheType` when nothing matches closely enough
 * — an honest "cannot tell" beats a confident wrong answer here, because the
 * remedy it drives (restarting the inference container with different
 * environment variables) is disruptive.
 */
function inferCacheType(geometry, numCtx, residentBytes, weightBytes) {

  if (
    !geometry ||
    !Number.isFinite(residentBytes) ||
    !Number.isFinite(weightBytes) ||
    residentBytes <= weightBytes
  ) {
    return undefined;
  }

  // Interleaved sliding-window attention (Gemma 3/4, among others) sizes most
  // layers to the window rather than to num_ctx, so the whole-context formula
  // below overestimates by several times - for gemma3:4b at 8192 it reports
  // 1088 MiB against a true 304 MiB, which is enough to call an unquantized
  // cache "already quantized". The geometry we read cannot model that, so say
  // nothing rather than something confidently wrong.
  if (geometry.slidingWindow) {
    return undefined;
  }

  const observedOverheadBytes = residentBytes - weightBytes;
  const estimates = {};
  for (const cacheType of Object.keys(CACHE_TYPE_BYTES)) {
    estimates[cacheType] = estimateKvCacheBytes(geometry, numCtx, cacheType);
  }

  // The observation is cache + compute/graph buffers, so it can only ever be
  // LARGER than the cache alone. A symmetric nearest-match therefore drifts
  // upward as those buffers grow: on an Orin at num_ctx 8192 roughly 180 MiB of
  // them was enough to report an already-quantized q8_0 cache as f16, and tell
  // the operator to restart their container with settings they already had.
  //
  // So: only consider candidates at or below the observation, take the largest
  // that fits, and require the unexplained remainder to be small enough to be
  // compute buffers rather than a cache type we did not model.
  const candidates = Object.entries(estimates)
    .filter(([, bytes]) => Number.isFinite(bytes) && bytes > 0)
    .sort((a, b) => a[1] - b[1]);

  let likelyCacheType;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const [cacheType, bytes] = candidates[index];
    if (bytes > observedOverheadBytes) {
      continue;
    }

    const unexplained = observedOverheadBytes - bytes;
    if (unexplained > MAX_COMPUTE_BUFFER_BYTES) {
      break;
    }

    // The remainder has to be clearly nearer this candidate than the next type
    // up, otherwise "a small cache with large compute buffers" and "a larger
    // cache with small ones" are the same footprint and picking either is a
    // coin toss dressed up as a measurement.
    const nextLarger = candidates[index + 1];
    if (nextLarger && unexplained >= (nextLarger[1] - bytes) / 2) {
      break;
    }

    likelyCacheType = cacheType;
    break;
  }

  return { observedOverheadBytes, estimates, likelyCacheType };
}

/**
 * Turn the inference into operator-facing advice.
 *
 * Ollama only honours a quantized KV cache when flash attention is enabled, so
 * "the cache looks like f16" implicates both settings at once — which is why
 * the hint names both rather than guessing between them.
 */
function buildCacheHint(inference) {
  if (!inference || !inference.likelyCacheType) {
    return undefined;
  }

  if (inference.likelyCacheType !== 'f16') {
    return {
      quantized: true,
      message: `The KV cache looks like ${inference.likelyCacheType}, so flash attention and cache quantization are active.`
    };
  }

  const f16 = inference.estimates.f16;
  const q8 = inference.estimates.q8_0;
  const savingBytes = typeof f16 === 'number' && typeof q8 === 'number' ? f16 - q8 : undefined;

  return {
    quantized: false,
    savingBytes,
    message:
      'The KV cache looks like unquantized f16. Setting OLLAMA_FLASH_ATTENTION=1 and ' +
      'OLLAMA_KV_CACHE_TYPE=q8_0 on the inference server would roughly halve it' +
      (savingBytes ? `, freeing about ${Math.round(savingBytes / 1024 / 1024)} MiB` : '') +
      ' — headroom that buys either a larger context window or full GPU residency. ' +
      'Ollama reports no configuration, so this is inferred from the resident footprint.'
  };
}

module.exports = {
  CACHE_TYPE_BYTES,
  MATCH_TOLERANCE,
  buildCacheHint,
  estimateKvCacheBytes,
  inferCacheType,
  readModelGeometry
};
