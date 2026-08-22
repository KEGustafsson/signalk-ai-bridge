'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('../index.cjs');
const { normalizeAiConfig, resetRuntimeState, streamAiModel } = require('../lib/ai-service.cjs');

/** Ollama client stub whose chat() yields the given fragments as a stream. */
function streamingClient(fragments, final = {}) {
  return {
    async chat(request) {
      assert.equal(request.stream, true);
      return (async function* generate() {
        for (let index = 0; index < fragments.length; index += 1) {
          const isLast = index === fragments.length - 1;
          yield {
            model: 'gemma4:e2b',
            created_at: '2026-04-11T10:00:00.000Z',
            message: { role: 'assistant', content: fragments[index] },
            done: isLast,
            ...(isLast ? final : {})
          };
        }
      })();
    }
  };
}

/** Collects everything a streaming route writes, as parsed NDJSON lines. */
function createStreamRecorder() {
  const chunks = [];
  return {
    headers: {},
    statusCode: 200,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
    json(payload) {
      chunks.push(`${JSON.stringify(payload)}\n`);
      return this;
    },
    lines() {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }
  };
}

function createPluginHost() {
  return {
    selfId: 'urn:mrn:signalk:uuid:test-self',
    setPluginStatus: () => {},
    getSelfPath: () => undefined
  };
}

function registerRoutes(plugin) {
  const routes = {};
  plugin.registerWithRouter({
    get(path, handler) {
      routes[`GET ${path}`] = handler;
    },
    post(path, handler) {
      routes[`POST ${path}`] = handler;
    }
  });
  return routes;
}

beforeEach(() => {
  resetRuntimeState();
});

describe('streamAiModel', () => {
  it('emits each fragment and returns the assembled answer', async () => {
    const fragments = [];
    const result = await streamAiModel(
      { prompt: 'Summarize the vessel state.' },
      normalizeAiConfig({}),
      {
        ollamaClient: streamingClient(['The vessel ', 'is making ', '4.1 knots.'], {
          prompt_eval_count: 40,
          eval_count: 12,
          eval_duration: 400_000_000
        })
      },
      (text) => fragments.push(text)
    );

    assert.deepEqual(fragments, ['The vessel ', 'is making ', '4.1 knots.']);
    assert.equal(result.answer, 'The vessel is making 4.1 knots.');
    assert.equal(result.usage.totalTokens, 52);
    assert.equal(result.performance.tokensPerSecond, 30);
  });

  it('rejects an empty prompt before opening a stream', async () => {
    await assert.rejects(
      streamAiModel({ prompt: '  ' }, normalizeAiConfig({}), {
        ollamaClient: {
          chat() {
            throw new Error('should not be called');
          }
        }
      }),
      (error) => error.code === 'validation-failed'
    );
  });

  it('falls back to the blocking path when the stream fails before any output', async () => {
    let blockingCalls = 0;
    const result = await streamAiModel({ prompt: 'Status?' }, normalizeAiConfig({}), {
      ollamaClient: {
        async chat(request) {
          if (request.stream) {
            throw new Error("model 'gemma4' not found");
          }
          blockingCalls += 1;
          return {
            model: 'gemma4',
            message: { role: 'assistant', content: 'Recovered without streaming.' }
          };
        }
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    });

    assert.equal(blockingCalls, 1);
    assert.equal(result.answer, 'Recovered without streaming.');
  });

  it('surfaces a mid-stream failure rather than replaying it', async () => {
    const fragments = [];
    let blockingCalls = 0;

    await assert.rejects(
      streamAiModel(
        { prompt: 'Status?' },
        normalizeAiConfig({}),
        {
          ollamaClient: {
            async chat(request) {
              if (!request.stream) {
                blockingCalls += 1;
                return { message: { content: 'replayed' } };
              }
              return (async function* generate() {
                yield { message: { role: 'assistant', content: 'partial answer' } };
                throw new Error('connection reset');
              })();
            }
          }
        },
        (text) => fragments.push(text)
      ),
      /connection reset/
    );

    // Replaying after emitting would duplicate text mid-answer.
    assert.deepEqual(fragments, ['partial answer']);
    assert.equal(blockingCalls, 0);
  });

  it('uses the blocking path for backends that cannot stream', async () => {
    const result = await streamAiModel(
      { prompt: 'Status?' },
      normalizeAiConfig({ backend: 'tensorrt-llm' }),
      {
        fetchImpl: async (url) => {
          assert.match(String(url), /\/v1\/chat\/completions$/);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: 'From TensorRT-LLM.' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
      }
    );

    assert.equal(result.answer, 'From TensorRT-LLM.');
  });
});

describe('POST /bridge/stream', () => {
  it('writes NDJSON tokens followed by the full result', async () => {
    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: streamingClient(['All ', 'nominal.'])
    });
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const res = createStreamRecorder();
    await routes['POST /bridge/stream'](
      { body: { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' } },
      res
    );

    const lines = res.lines();
    assert.deepEqual(
      lines.filter((line) => line.type === 'token').map((line) => line.text),
      ['All ', 'nominal.']
    );

    const result = lines[lines.length - 1];
    assert.equal(result.type, 'ask-vessel-ai-result');
    assert.equal(result.response.answer, 'All nominal.');
    assert.equal(res.ended, true);
    assert.match(res.headers['content-type'], /application\/x-ndjson/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
  });

  it('reports a backend failure as a trailing error line', async () => {
    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        async chat() {
          throw new Error('Ollama is unreachable.');
        }
      },
      fetchImpl: async () => {
        throw new Error('fetch failed');
      }
    });
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const res = createStreamRecorder();
    await routes['POST /bridge/stream'](
      { body: { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' } },
      res
    );

    const lines = res.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, 'error');
    assert.match(lines[0].error.message, /unreachable/);
    assert.equal(res.ended, true);
  });

  it('rejects an unknown tool id', async () => {
    const plugin = createPlugin(createPluginHost(), {});
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const res = createStreamRecorder();
    await routes['POST /bridge/stream']({ body: { toolId: 'nope' } }, res);

    const lines = res.lines();
    assert.equal(lines[0].type, 'error');
    assert.equal(lines[0].error.code, 'validation-failed');
  });
});
