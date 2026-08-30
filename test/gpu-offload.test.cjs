'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAiConfig, resetRuntimeState, warmUpModel } = require('../lib/ai-service.cjs');
const {
  FORCE_ALL_LAYERS,
  getOffloadState,
  isOutOfMemoryError,
  resetOffloadState,
  resolveOffload,
  tuneOffload
} = require('../lib/gpu-offload.cjs');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

beforeEach(() => {
  resetRuntimeState();
  resetOffloadState();
});

describe('GPU offload tuning', () => {
  it('requests full offload rather than the backend estimate', async () => {
    const config = normalizeAiConfig({});
    const seen = [];

    const result = await tuneOffload(config, async (candidate) => {
      seen.push({ numCtx: candidate.numCtx, numGpu: candidate.numGpu });
      return { state: 'gpu' };
    });

    assert.deepEqual(seen, [{ numCtx: 8192, numGpu: FORCE_ALL_LAYERS }]);
    assert.equal(result.tuned, false);
    assert.equal(result.numGpu, FORCE_ALL_LAYERS);
  });

  it('halves the context window until every layer is resident', async () => {
    const config = normalizeAiConfig({ numCtx: 32768 });
    const seen = [];

    const result = await tuneOffload(config, async (candidate) => {
      seen.push(candidate.numCtx);
      return { state: candidate.numCtx > 8192 ? 'partial' : 'gpu' };
    });

    assert.deepEqual(seen, [32768, 16384, 8192]);
    assert.equal(result.numCtx, 8192);
    assert.equal(result.tuned, true);
    assert.match(result.reason, /reduced to 8192/);
  });

  it('treats an allocation failure the same as a CPU fallback', async () => {
    const config = normalizeAiConfig({ numCtx: 16384 });
    const seen = [];

    const result = await tuneOffload(config, async (candidate) => {
      seen.push(candidate.numCtx);
      if (candidate.numCtx > 8192) {
        throw new Error('cudaMalloc failed: out of memory');
      }
      return { state: 'gpu' };
    });

    assert.deepEqual(seen, [16384, 8192]);
    assert.equal(result.numCtx, 8192);
  });

  it('hands the split back to the backend when the model can never fit', async () => {
    const config = normalizeAiConfig({ numCtx: 8192 });

    const result = await tuneOffload(config, async () => ({ state: 'partial' }));

    assert.equal(result.numGpu, -1);
    assert.equal(result.tuned, true);
    assert.match(result.reason, /does not fit/);
  });

  it('keeps an explicitly pinned layer count through the fallback', async () => {
    const config = normalizeAiConfig({ numCtx: 8192, numGpu: 12 });

    const result = await tuneOffload(config, async (candidate) => {
      assert.equal(candidate.numGpu, 12);
      return { state: 'partial' };
    });

    assert.equal(result.numGpu, 12);
  });

  it('never shrinks anything when auto-tuning is switched off', async () => {
    const config = normalizeAiConfig({ numCtx: 32768, gpuAutoTune: false });
    let called = false;

    const result = await tuneOffload(config, async () => {
      called = true;
      return { state: 'partial' };
    });

    assert.equal(called, false);
    assert.equal(result.numCtx, 32768);
    assert.equal(result.numGpu, -1);
    assert.match(result.reason, /disabled/);
  });

  it('leaves the configuration alone when the backend fails for another reason', async () => {
    const config = normalizeAiConfig({});

    await assert.rejects(
      tuneOffload(config, async () => {
        throw new Error('connection refused');
      }),
      /connection refused/
    );
    assert.equal(getOffloadState(config), undefined);
  });

  it('recognises the allocation failures worth retrying', () => {
    assert.equal(isOutOfMemoryError(new Error('CUDA error: out of memory')), true);
    assert.equal(isOutOfMemoryError(new Error('failed to allocate CUDA0 buffer')), true);
    // cublasCreate fails with NOT_INITIALIZED when the runtime cannot allocate
    // its workspace - on unified-memory Jetsons this IS the OOM signature.
    assert.equal(
      isOutOfMemoryError(
        new Error('an error was encountered while running the model: CUDA error: CUBLAS_STATUS_NOT_INITIALIZED')
      ),
      true
    );
    assert.equal(isOutOfMemoryError(new Error('CUBLAS_STATUS_ALLOC_FAILED')), true);
    assert.equal(isOutOfMemoryError(new Error('model not found')), false);
  });
});

describe('tuned settings reach the chat request', () => {
  it('applies the tuned context window to later questions', async () => {
    const config = normalizeAiConfig({ model: 'gemma4:e2b', numCtx: 32768 });
    let residencySequence = 0;

    await warmUpModel(config, {
      fetchImpl: async (url) => {
        if (String(url).endsWith('/api/tags')) {
          return jsonResponse({ models: [{ name: 'gemma4:e2b' }] });
        }
        if (String(url).endsWith('/api/ps')) {
          residencySequence += 1;
          // Fits only once the context has been halved twice.
          return residencySequence < 3
            ? jsonResponse({ models: [{ name: 'gemma4:e2b', size: 100, size_vram: 40 }] })
            : jsonResponse({ models: [{ name: 'gemma4:e2b', size: 100, size_vram: 100 }] });
        }
        return jsonResponse({ done: true });
      }
    });

    const effective = resolveOffload(config);
    assert.equal(effective.numCtx, 8192);
    assert.equal(effective.numGpu, FORCE_ALL_LAYERS);
  });
});

describe('review follow-ups', () => {
  it('does not claim a GPU placement when the layer count is pinned to zero', async () => {
    const statuses = [];
    const plugin = require('../index.cjs')(
      {
        selfId: 'urn:mrn:signalk:uuid:test',
        setPluginStatus: (message) => statuses.push(message),
        getSelfPath: () => undefined
      },
      {
        fetchImpl: async (url) => {
          if (String(url).endsWith('/api/tags')) {
            return jsonResponse({ models: [{ name: 'gemma4:e2b' }] });
          }
          if (String(url).endsWith('/api/ps')) {
            return jsonResponse({ models: [{ name: 'gemma4:e2b', size: 100, size_vram: 0 }] });
          }
          return jsonResponse({ done: true });
        }
      }
    );

    plugin.start({ model: 'gemma4:e2b', numGpu: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const preloaded = statuses.find((message) => /preloaded/.test(message));
    assert.ok(preloaded, 'expected a preload status message');
    assert.match(preloaded, /CPU only/);
    assert.doesNotMatch(preloaded, /all layers on GPU/);
    plugin.stop();
  });
});
