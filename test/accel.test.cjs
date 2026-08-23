'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_KEEP_ALIVE,
  DEFAULT_NUM_CTX,
  buildRuntimeOptions,
  getAccelerationReport,
  getAcceleratorStatus,
  getAiAvailability,
  normalizeAiConfig,
  queryAiModel,
  resetRuntimeState,
  warmUpModel
} = require('../lib/ai-service.cjs');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

beforeEach(() => {
  resetRuntimeState();
});

describe('accelerator configuration', () => {
  it('keeps the KV cache budget independent of the output budget', () => {
    const config = normalizeAiConfig({ maxTokens: 4096 });

    assert.equal(config.maxTokens, 4096);
    assert.equal(config.numCtx, DEFAULT_NUM_CTX);
    assert.equal(config.keepAlive, DEFAULT_KEEP_ALIVE);
  });

  it('clamps context, batch and layer counts into ranges the Orin can serve', () => {
    const tooSmall = normalizeAiConfig({ numCtx: 1, numBatch: 1, numGpu: -50, numThread: -3 });
    const tooLarge = normalizeAiConfig({ numCtx: 10 ** 7, numBatch: 10 ** 6, numGpu: 10 ** 6, numThread: 10 ** 4 });

    assert.equal(tooSmall.numCtx, 512);
    assert.equal(tooSmall.numBatch, 32);
    assert.equal(tooSmall.numGpu, -1);
    assert.equal(tooSmall.numThread, 0);
    assert.equal(tooLarge.numCtx, 131072);
    assert.equal(tooLarge.numBatch, 4096);
    assert.equal(tooLarge.numGpu, 999);
    assert.equal(tooLarge.numThread, 64);
  });

  it('rejects a malformed keep_alive instead of forwarding it to the backend', () => {
    assert.equal(normalizeAiConfig({ keepAlive: 'forever' }).keepAlive, DEFAULT_KEEP_ALIVE);
    assert.equal(normalizeAiConfig({ keepAlive: '45m' }).keepAlive, '45m');
    assert.equal(normalizeAiConfig({ keepAlive: '-1' }).keepAlive, '-1');
  });

  it('reads accelerator settings from the environment', () => {
    const config = normalizeAiConfig(
      {},
      {
        SIGNALK_AI_BRIDGE_NUM_CTX: '4096',
        SIGNALK_AI_BRIDGE_NUM_GPU: '999',
        SIGNALK_AI_BRIDGE_KEEP_ALIVE: '2h',
        SIGNALK_AI_BRIDGE_BACKEND: 'tensorrt'
      }
    );

    assert.equal(config.numCtx, 4096);
    assert.equal(config.numGpu, 999);
    assert.equal(config.keepAlive, '2h');
    assert.equal(config.backend, 'tensorrt-llm');
  });

  it('only forwards explicit GPU layer and thread counts', () => {
    const auto = buildRuntimeOptions(normalizeAiConfig({}));
    const forced = buildRuntimeOptions(normalizeAiConfig({ numGpu: 999, numThread: 6 }));
    const cpuOnly = buildRuntimeOptions(normalizeAiConfig({ numGpu: 0 }));

    assert.equal('num_gpu' in auto, false);
    assert.equal('num_thread' in auto, false);
    assert.equal(forced.num_gpu, 999);
    assert.equal(forced.num_thread, 6);
    assert.equal(cpuOnly.num_gpu, 0);
  });
});

describe('GPU residency reporting', () => {
  const config = normalizeAiConfig({ model: 'gemma4:e2b' });

  function statusFor(models) {
    return getAcceleratorStatus(config, {
      fetchImpl: async (url) => {
        assert.equal(String(url), 'http://localhost:11434/api/ps');
        return jsonResponse({ models });
      }
    });
  }

  it('reports full GPU residency when the whole model is in VRAM', async () => {
    const status = await statusFor([
      { name: 'gemma4:e2b', size: 5_000_000_000, size_vram: 5_000_000_000 }
    ]);

    assert.equal(status.state, 'gpu');
    assert.equal(status.vramRatio, 1);
    assert.match(status.message, /CUDA/);
  });

  it('flags a partial offload as the CPU fallback it is', async () => {
    const status = await statusFor([
      { name: 'gemma4:e2b', size: 5_000_000_000, size_vram: 2_000_000_000 }
    ]);

    assert.equal(status.state, 'partial');
    assert.match(status.message, /num_ctx/);
  });

  it('reports a CPU-only load', async () => {
    const status = await statusFor([{ name: 'gemma4:e2b', size: 5_000_000_000, size_vram: 0 }]);

    assert.equal(status.state, 'cpu');
    assert.match(status.message, /NVIDIA runtime/);
  });

  it('reports not-loaded when the configured model is not resident', async () => {
    const status = await statusFor([{ name: 'llama3:8b', size: 1, size_vram: 1 }]);

    assert.equal(status.state, 'not-loaded');
  });

  it('degrades to unknown rather than failing when /api/ps is unreachable', async () => {
    const status = await getAcceleratorStatus(config, {
      fetchImpl: async () => {
        throw new Error('fetch failed');
      }
    });

    assert.equal(status.state, 'unknown');
  });

  it('treats a TensorRT-LLM engine as inherently GPU resident', async () => {
    const status = await getAcceleratorStatus(normalizeAiConfig({ backend: 'tensorrt-llm' }), {
      fetchImpl: async () => {
        throw new Error('should not be called');
      }
    });

    assert.equal(status.supported, false);
    assert.equal(status.state, 'gpu');
  });
});

describe('TensorRT-LLM backend', () => {
  const config = normalizeAiConfig({
    backend: 'tensorrt-llm',
    baseUrl: 'http://jetson:8000/v1',
    model: 'gemma-4-e2b-int4-awq'
  });

  it('strips a /v1 suffix so both backends accept the same host field', () => {
    assert.equal(config.baseUrl, 'http://jetson:8000');
  });

  it('sends an OpenAI-shaped chat completion and reads the answer back', async () => {
    const calls = [];

    const result = await queryAiModel(
      { prompt: 'Summarize the vessel state.', context: { selectedData: {} } },
      config,
      {
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
          return jsonResponse({
            model: 'gemma-4-e2b-int4-awq',
            created: 1776000000,
            choices: [{ message: { role: 'assistant', content: 'All nominal.' } }],
            usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 }
          });
        }
      }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://jetson:8000/v1/chat/completions');
    assert.equal(calls[0].body.model, 'gemma-4-e2b-int4-awq');
    assert.equal(calls[0].body.stream, false);
    assert.equal(calls[0].body.max_tokens, config.maxTokens);
    assert.equal(result.answer, 'All nominal.');
    assert.equal(result.usage.totalTokens, 48);
    assert.equal(result.createdAt, new Date(1776000000 * 1000).toISOString());
  });

  it('sends a bearer token when an API key is configured', async () => {
    let authorization;

    await queryAiModel(
      { prompt: 'Status?' },
      normalizeAiConfig({ backend: 'tensorrt-llm', apiKey: 'nim-token' }),
      {
        fetchImpl: async (url, init) => {
          authorization = init.headers.authorization;
          return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
        }
      }
    );

    assert.equal(authorization, 'Bearer nim-token');
  });

  it('discovers served models through /v1/models for the availability check', async () => {
    const availability = await getAiAvailability(config, {
      fetchImpl: async (url) => {
        assert.equal(String(url), 'http://jetson:8000/v1/models');
        return jsonResponse({ data: [{ id: 'gemma-4-e2b-int4-awq' }] });
      }
    });

    assert.equal(availability.available, true);
    assert.equal(availability.resolvedModel, 'gemma-4-e2b-int4-awq');
    assert.match(availability.message, /TensorRT-LLM/);
  });

  it('surfaces the backend error body instead of a bare status code', async () => {
    await assert.rejects(
      queryAiModel({ prompt: 'Status?' }, normalizeAiConfig({ backend: 'tensorrt-llm' }), {
        fetchImpl: async () => jsonResponse({ error: { message: 'engine max_seq_len exceeded' } }, 400)
      }),
      (error) => /engine max_seq_len exceeded/.test(error.message)
    );
  });
});

describe('availability caching', () => {
  it('collapses concurrent probes into a single backend round trip', async () => {
    let calls = 0;
    const config = normalizeAiConfig({ model: 'gemma4:e2b' });
    const dependencies = {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ models: [{ name: 'gemma4:e2b' }] });
      }
    };

    const results = await Promise.all([
      getAiAvailability(config, dependencies),
      getAiAvailability(config, dependencies),
      getAiAvailability(config, dependencies)
    ]);

    assert.equal(calls, 1);
    assert.equal(await getAiAvailability(config, dependencies).then((value) => value.available), true);
    assert.equal(calls, 1);
    assert.deepEqual(results.map((value) => value.resolvedModel), [
      'gemma4:e2b',
      'gemma4:e2b',
      'gemma4:e2b'
    ]);
  });

  it('does not cache across different hosts', async () => {
    const hosts = [];
    const dependencies = {
      fetchImpl: async (url) => {
        hosts.push(String(url));
        return jsonResponse({ models: [{ name: 'gemma4:e2b' }] });
      }
    };

    await getAiAvailability(normalizeAiConfig({ model: 'gemma4:e2b' }), dependencies);
    await getAiAvailability(
      normalizeAiConfig({ model: 'gemma4:e2b', baseUrl: 'http://jetson:11434' }),
      dependencies
    );

    assert.deepEqual(hosts, ['http://localhost:11434/api/tags', 'http://jetson:11434/api/tags']);
  });
});

describe('model warm-up', () => {
  it('preloads the resolved model with the configured keep_alive', async () => {
    const calls = [];
    const result = await warmUpModel(normalizeAiConfig({ model: 'gemma4', keepAlive: '1h' }), {
      fetchImpl: async (url, init = {}) => {
        calls.push(String(url));
        if (String(url).endsWith('/api/tags')) {
          return jsonResponse({ models: [{ name: 'gemma4:e2b', details: { family: 'gemma4' } }] });
        }
        if (String(url).endsWith('/api/ps')) {
          return jsonResponse({ models: [{ name: 'gemma4:e2b', size: 100, size_vram: 100 }] });
        }
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, 'gemma4:e2b');
        assert.equal(body.prompt, '');
        assert.equal(body.keep_alive, '1h');
        assert.equal(body.options.num_ctx, DEFAULT_NUM_CTX);
        assert.equal(body.options.num_gpu, 999);
        return jsonResponse({ done: true });
      }
    });

    assert.equal(result.warmed, true);
    assert.equal(result.model, 'gemma4:e2b');
    assert.equal(result.offload.numCtx, DEFAULT_NUM_CTX);
    assert.equal(result.offload.numGpu, 999);
    assert.equal(result.offload.tuned, false);
    assert.deepEqual(calls, [
      'http://localhost:11434/api/tags',
      'http://localhost:11434/api/generate',
      'http://localhost:11434/api/ps'
    ]);
  });

  it('never throws when the backend is down', async () => {
    const result = await warmUpModel(normalizeAiConfig({}), {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      }
    });

    assert.equal(result.warmed, false);
  });

  it('is skipped for TensorRT-LLM, whose engine is already resident', async () => {
    const result = await warmUpModel(normalizeAiConfig({ backend: 'tensorrt-llm' }), {
      fetchImpl: async () => {
        throw new Error('should not be called');
      }
    });

    assert.equal(result.warmed, false);
    assert.equal(result.reason, 'skipped');
  });
});

describe('generation throughput reporting', () => {
  it('derives tokens/second from the nanosecond timings Ollama returns', async () => {
    const result = await queryAiModel({ prompt: 'Status?' }, normalizeAiConfig({}), {
      fetchImpl: async () =>
        jsonResponse({
          model: 'gemma4:e2b',
          message: { role: 'assistant', content: 'All nominal.' },
          eval_count: 120,
          eval_duration: 4_000_000_000,
          load_duration: 2_500_000_000,
          prompt_eval_duration: 500_000_000,
          total_duration: 7_000_000_000
        })
    });

    assert.equal(result.performance.tokensPerSecond, 30);
    assert.equal(result.performance.loadMs, 2500);
    assert.equal(result.performance.evalMs, 4000);
    assert.equal(result.performance.totalMs, 7000);
  });
});

describe('review follow-ups', () => {
  it('does not spend a second inference call on a TensorRT-LLM timeout', async () => {
    let chatCalls = 0;
    let listCalls = 0;

    await assert.rejects(
      queryAiModel({ prompt: 'Status?' }, normalizeAiConfig({ backend: 'tensorrt-llm' }), {
        fetchImpl: async (url) => {
          if (String(url).endsWith('/v1/models')) {
            listCalls += 1;
            return jsonResponse({ data: [{ id: 'some-other-model' }] });
          }
          chatCalls += 1;
          return jsonResponse({ error: { message: 'upstream timed out' } }, 504);
        }
      }),
      /upstream timed out/
    );

    // Retrying a timeout would cost the operator two full timeout windows.
    assert.equal(chatCalls, 1);
    assert.equal(listCalls, 0);
  });

  it('still resolves the served model id when the configured one is missing', async () => {
    const chatModels = [];

    const result = await queryAiModel({ prompt: 'Status?' }, normalizeAiConfig({ backend: 'tensorrt-llm' }), {
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/v1/models')) {
          return jsonResponse({ data: [{ id: 'gemma-3-4b-it-int4-awq' }] });
        }
        const body = JSON.parse(String(init.body));
        chatModels.push(body.model);
        if (chatModels.length === 1) {
          return jsonResponse({ error: { message: 'model not found' } }, 404);
        }
        return jsonResponse({ choices: [{ message: { content: 'Resolved.' } }] });
      }
    });

    assert.deepEqual(chatModels, ['gemma4', 'gemma-3-4b-it-int4-awq']);
    assert.equal(result.answer, 'Resolved.');
  });

  it('keeps the status page alive when host telemetry throws', async () => {
    const report = await getAccelerationReport(normalizeAiConfig({ model: 'gemma4:e2b' }), {
      fetchImpl: async () => jsonResponse({ models: [{ name: 'gemma4:e2b', size: 10, size_vram: 10 }] }),
      jetsonTelemetry: async () => {
        throw new Error('sysfs exploded');
      }
    });

    assert.equal(report.state, 'gpu');
    assert.equal(report.jetson.present, false);
  });
});

describe('unit conversion', () => {
  const { createBridgeService } = require('../lib/bridge-service.cjs');

  function contextFor(paths, model) {
    const app = {
      selfId: 'urn:mrn:signalk:uuid:test-self',
      getSelfPath: (path) => path.split('.').reduce((node, key) => (node ? node[key] : undefined), model)
    };
    const service = createBridgeService(app, {});
    return service.buildAiPayload({ prompt: 'x' }, { aiDataPaths: paths, ...normalizeAiConfig({}) });
  }

  it('leaves distances and positions alone under a course subtree', async () => {
    // "course" used to taint every leaf beneath it, because the pattern matched
    // a following "." under /i. A 1852 m leg reached the model as 106111.78 and
    // a latitude already in degrees was multiplied by 180/pi a second time.
    const payload = await contextFor(['navigation.courseGreatCircle.*'], {
      navigation: {
        courseGreatCircle: {
          nextPoint: {
            distance: { value: 1852 },
            velocityMadeGood: { value: 3.5 },
            position: { value: { latitude: 60.1, longitude: 24.9 } }
          },
          bearingTrackTrue: { value: Math.PI / 2 }
        }
      }
    });

    const data = payload.context.selectedData;
    assert.equal(data['navigation.courseGreatCircle.nextPoint.distance'], 1852);
    // The envelope is unwrapped, not flattened: no ".value" keys, no "meta",
    // no per-source copies - and the timestamp survives, so the model can tell
    // a live fix from a three-hour-old one.
    assert.equal(
      Object.keys(data).some((key) => key.endsWith('.value') || key.includes('.meta.')),
      false
    );
    assert.equal(data['navigation.courseGreatCircle.nextPoint.velocityMadeGood'], 3.5);
    assert.equal(data['navigation.courseGreatCircle.nextPoint.position.latitude'], 60.1);
    // A real angle in the same subtree still converts. This never fired for a
    // wildcard before, because the key was "...bearingTrackTrue.value".
    assert.equal(data['navigation.courseGreatCircle.bearingTrackTrue'], 90);
  });

  it('keeps the leaf timestamp so staleness is visible to the model', async () => {
    const payload = await contextFor(['navigation.*'], {
      navigation: {
        speedOverGround: { value: 4.1, timestamp: '2026-08-23T04:00:00Z', $source: 'gps.1' }
      }
    });

    const data = payload.context.selectedData;
    assert.equal(data['navigation.speedOverGround'], 4.1);
    assert.equal(data['navigation.speedOverGround@'], '2026-08-23T04:00:00Z');
    assert.equal(data['navigation.speedOverGround.$source'], undefined);
  });

  it('still converts the angle leaves that are genuinely radians', async () => {
    const payload = await contextFor(['navigation.headingTrue', 'environment.wind.angleApparent'], {
      navigation: { headingTrue: { value: Math.PI } },
      environment: { wind: { angleApparent: { value: Math.PI / 4 } } }
    });

    assert.equal(payload.context.selectedData['navigation.headingTrue'], 180);
    assert.equal(payload.context.selectedData['environment.wind.angleApparent'], 45);
  });
});

