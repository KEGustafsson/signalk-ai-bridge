'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCacheHint,
  estimateKvCacheBytes,
  inferCacheType,
  readModelGeometry
} = require('../lib/kv-cache.cjs');

// Geometry in the shape Ollama's /api/show returns for a Gemma-class model.
const SHOW_PAYLOAD = {
  model_info: {
    'general.architecture': 'gemma3',
    'gemma3.block_count': 34,
    'gemma3.attention.head_count': 8,
    'gemma3.attention.head_count_kv': 4,
    'gemma3.attention.key_length': 256,
    'gemma3.attention.value_length': 256,
    'gemma3.embedding_length': 2560
  }
};

const GEOMETRY = {
  architecture: 'gemma3',
  blockCount: 34,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256
};

describe('model geometry', () => {
  it('reads the architecture-namespaced GGUF keys', () => {
    assert.deepEqual(readModelGeometry(SHOW_PAYLOAD), GEOMETRY);
  });

  it('derives the head dimension when key/value length are absent', () => {
    const geometry = readModelGeometry({
      model_info: {
        'general.architecture': 'llama',
        'llama.block_count': 32,
        'llama.attention.head_count': 32,
        'llama.attention.head_count_kv': 8,
        'llama.embedding_length': 4096
      }
    });

    assert.equal(geometry.keyLength, 128);
    assert.equal(geometry.valueLength, 128);
    assert.equal(geometry.headCountKv, 8);
  });

  it('accepts a per-layer array by taking the shared value', () => {
    const geometry = readModelGeometry({
      model_info: {
        ...SHOW_PAYLOAD.model_info,
        'gemma3.attention.head_count_kv': [4, 4, 4]
      }
    });

    assert.equal(geometry.headCountKv, 4);
  });

  it('gives up rather than guessing when the metadata is incomplete', () => {
    assert.equal(readModelGeometry({ model_info: { 'general.architecture': 'gemma3' } }), undefined);
    assert.equal(readModelGeometry({}), undefined);
    assert.equal(readModelGeometry(undefined), undefined);
  });
});

describe('KV cache sizing', () => {
  it('sizes the cache from context length and attention geometry', () => {
    // 8192 tokens * 34 layers * 4 KV heads * (256 + 256) dims * 2 bytes
    assert.equal(estimateKvCacheBytes(GEOMETRY, 8192, 'f16'), 1140850688);
  });

  it('halves at q8_0 and quarters at q4_0', () => {
    const f16 = estimateKvCacheBytes(GEOMETRY, 8192, 'f16');
    const q8 = estimateKvCacheBytes(GEOMETRY, 8192, 'q8_0');
    const q4 = estimateKvCacheBytes(GEOMETRY, 8192, 'q4_0');

    assert.ok(Math.abs(q8 / f16 - 0.53) < 0.01);
    assert.ok(Math.abs(q4 / f16 - 0.28) < 0.01);
  });

  it('scales linearly with the context window', () => {
    const small = estimateKvCacheBytes(GEOMETRY, 4096, 'f16');
    const large = estimateKvCacheBytes(GEOMETRY, 8192, 'f16');

    assert.equal(large, small * 2);
  });
});

describe('cache type inference', () => {
  const WEIGHTS = 3_000_000_000;

  function residentWith(cacheType, numCtx = 8192) {
    return WEIGHTS + estimateKvCacheBytes(GEOMETRY, numCtx, cacheType);
  }

  it('recognises an unquantized f16 cache', () => {
    const inference = inferCacheType(GEOMETRY, 8192, residentWith('f16'), WEIGHTS);

    assert.equal(inference.likelyCacheType, 'f16');
    const hint = buildCacheHint(inference);
    assert.equal(hint.quantized, false);
    assert.match(hint.message, /OLLAMA_KV_CACHE_TYPE=q8_0/);
    assert.match(hint.message, /inferred from the resident footprint/);
  });

  it('recognises a quantized cache and says nothing needs changing', () => {
    const inference = inferCacheType(GEOMETRY, 8192, residentWith('q8_0'), WEIGHTS);

    assert.equal(inference.likelyCacheType, 'q8_0');
    const hint = buildCacheHint(inference);
    assert.equal(hint.quantized, true);
    assert.match(hint.message, /flash attention and cache quantization are active/);
  });

  it('reports the memory a quantized cache would free', () => {
    const inference = inferCacheType(GEOMETRY, 8192, residentWith('f16'), WEIGHTS);
    const hint = buildCacheHint(inference);

    assert.ok(hint.savingBytes > 0);
    assert.match(hint.message, /freeing about \d+ MiB/);
  });

  it('declines to name a cache type when nothing matches closely', () => {
    // Resident footprint far larger than any cache type explains.
    const inference = inferCacheType(GEOMETRY, 8192, WEIGHTS + 50_000_000_000, WEIGHTS);

    assert.equal(inference.likelyCacheType, undefined);
    assert.equal(buildCacheHint(inference), undefined);
  });

  it('returns nothing when an input is missing or nonsensical', () => {
    assert.equal(inferCacheType(undefined, 8192, 4_000_000_000, WEIGHTS), undefined);
    assert.equal(inferCacheType(GEOMETRY, 8192, undefined, WEIGHTS), undefined);
    // Resident smaller than the weights: the model is partly on the CPU, so the
    // difference says nothing about the cache.
    assert.equal(inferCacheType(GEOMETRY, 8192, WEIGHTS - 1, WEIGHTS), undefined);
  });
});
