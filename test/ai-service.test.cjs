'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAiMessages,
  normalizeAiConfig,
  queryAiModel,
  streamAiModel
} = require('../lib/ai-service.cjs');

describe('normalizeAiConfig', () => {
  it('prefers Ollama environment variables when present', () => {
    const config = normalizeAiConfig(
      {},
      {
        AI_MODEL_URL: 'http://ollama.internal:11434/api/',
        AI_MODEL_NAME: 'gemma4:latest'
      }
    );

    assert.equal(config.baseUrl, 'http://ollama.internal:11434');
    assert.equal(config.model, 'gemma4:latest');
  });

  it('allows disabling the timeout with zero and caps large values at five minutes', () => {
    const disabledTimeoutConfig = normalizeAiConfig({
      requestTimeoutMs: 0
    });
    const cappedTimeoutConfig = normalizeAiConfig({
      requestTimeoutMs: 999999
    });

    assert.equal(disabledTimeoutConfig.requestTimeoutMs, 0);
    assert.equal(cappedTimeoutConfig.requestTimeoutMs, 300000);
  });
});

describe('buildAiMessages', () => {
  it('embeds prompt and Signal K context into the user message', () => {
    const config = normalizeAiConfig();
    const messages = buildAiMessages(
      'What needs attention?',
      {
        serverId: 'dockside-preview',
        aiDataPaths: ['navigation.position', 'notifications'],
        selectedData: {
          'navigation.position': { latitude: 60.1, longitude: 24.9 },
          notifications: { anchor: { state: 'alarm' } }
        }
      },
      config
    );

    assert.equal(messages[0].role, 'system');
    assert.match(messages[1].content, /What needs attention\?/);
    assert.match(messages[1].content, /dockside-preview/);
    assert.match(messages[1].content, /navigation\.position/);
    assert.match(messages[1].content, /notifications/);
  });
});

describe('queryAiModel', () => {
  it('calls the Ollama chat endpoint through the official client', async () => {
    let capturedUrl = '';
    let capturedBody = '';

    const result = await queryAiModel(
      {
        prompt: 'Summarize the vessel state.',
        context: {
          aiDataPaths: ['navigation.speedOverGround'],
          selectedData: {
            'navigation.speedOverGround': 4.1
          }
        }
      },
      normalizeAiConfig(),
      {
        fetchImpl: async (url, init) => {
          capturedUrl = String(url);
          capturedBody = String(init.body);
          return new Response(
            JSON.stringify({
              model: 'gemma4',
              created_at: '2026-04-11T10:00:00.000Z',
              message: {
                role: 'assistant',
                content: 'The vessel is making 4.1 knots with no active alarms.'
              },
              prompt_eval_count: 10,
              eval_count: 12,
              done: true,
              done_reason: 'stop',
              total_duration: 1,
              load_duration: 1,
              prompt_eval_duration: 1,
              eval_duration: 1
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json'
              }
            }
          );
        }
      }
    );

    assert.equal(capturedUrl, 'http://localhost:11434/api/chat');
    assert.match(capturedBody, /Summarize the vessel state\./);
    assert.match(capturedBody, /\"model\":\"gemma4\"/);
    assert.match(capturedBody, /\"num_predict\":2048/);
    assert.match(capturedBody, /\"num_ctx\":8192/);
    assert.match(capturedBody, /\"num_batch\":512/);
    assert.match(capturedBody, /\"keep_alive\":\"30m\"/);
    // Full offload is requested rather than left to Ollama's estimator, which
    // tends to leave a few layers on the CPU. llama.cpp clamps this to the real
    // layer count.
    assert.match(capturedBody, /\"num_gpu\":999/);
    assert.equal(result.model, 'gemma4');
    assert.equal(result.usage.totalTokens, 22);
  });

  it('retries with an installed tagged model when the configured model is missing', async () => {
    const calls = [];

    const result = await queryAiModel(
      {
        prompt: 'Summarize the vessel state.',
        context: {
          aiDataPaths: ['navigation.speedOverGround'],
          selectedData: {
            'navigation.speedOverGround': 4.1
          }
        }
      },
      normalizeAiConfig(),
      {
        fetchImpl: async (url, init = {}) => {
          calls.push({ url: String(url), body: String(init.body || '') });

          if (String(url).endsWith('/api/chat') && calls.filter((call) => call.url.endsWith('/api/chat')).length === 1) {
            return new Response(
              JSON.stringify({
                error: "model 'gemma4' not found"
              }),
              {
                status: 404,
                headers: {
                  'content-type': 'application/json'
                }
              }
            );
          }

          if (String(url).endsWith('/api/tags')) {
            return new Response(
              JSON.stringify({
                models: [
                  {
                    name: 'gemma4:e2b',
                    details: {
                      family: 'gemma4',
                      families: ['gemma4']
                    }
                  }
                ]
              }),
              {
                status: 200,
                headers: {
                  'content-type': 'application/json'
                }
              }
            );
          }

          return new Response(
            JSON.stringify({
              model: 'gemma4:e2b',
              created_at: '2026-04-11T10:00:00.000Z',
              message: {
                role: 'assistant',
                content: 'The vessel is making 4.1 knots with no active alarms.'
              }
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json'
              }
            }
          );
        }
      }
    );

    const chatBodies = calls.filter((call) => call.url.endsWith('/api/chat')).map((call) => call.body);
    assert.equal(chatBodies.length, 2);
    assert.match(chatBodies[0], /\"model\":\"gemma4\"/);
    assert.match(chatBodies[1], /\"model\":\"gemma4:e2b\"/);
    assert.equal(result.model, 'gemma4:e2b');
  });

  it('rejects empty prompts', async () => {
    await assert.rejects(
      queryAiModel({ prompt: '   ' }, normalizeAiConfig(), {
        fetchImpl: async () => {
          throw new Error('should not be called');
        }
      }),
      (error) => error && error.code === 'validation-failed'
    );
  });
});

// gemma4:e2b-it-qat - the model the compose files pull - declares Ollama's
// `thinking` capability. Left on, the model routed its reasoning into
// `message.thinking` and, with a full vessel context, spent its entire
// num_predict budget there: `content` came back empty and the operator saw
// "AI backend returned an empty response" from a backend that was fine.
describe('thinking models', () => {
  function tagsResponse(capabilities) {
    return new Response(
      JSON.stringify({
        models: [
          {
            name: 'gemma4:e2b-it-qat',
            details: { family: 'gemma4', families: ['gemma4'] },
            ...(capabilities ? { capabilities } : {})
          }
        ]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  function chatResponse(message) {
    return new Response(
      JSON.stringify({
        model: 'gemma4:e2b-it-qat',
        created_at: '2026-04-11T10:00:00.000Z',
        message,
        done: true
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  it('disables thinking for a model that declares the capability', async () => {
    let chatBody;
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat' }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return tagsResponse(['completion', 'tools', 'thinking', 'vision']);
          }
          chatBody = JSON.parse(String(init.body));
          return chatResponse({ role: 'assistant', content: 'Five knots.' });
        }
      }
    );

    assert.equal(chatBody.think, false);
  });

  // Some models cannot switch reasoning off and reject the parameter, and an
  // older Ollama reports no capabilities at all - both read as "don't send it".
  it('sends no think parameter when the model does not declare the capability', async () => {
    let chatBody;
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat' }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return tagsResponse(undefined);
          }
          chatBody = JSON.parse(String(init.body));
          return chatResponse({ role: 'assistant', content: 'Five knots.' });
        }
      }
    );

    assert.ok(!('think' in chatBody));
  });

  it('names the remedy when every output token went into reasoning', async () => {
    await assert.rejects(
      queryAiModel(
        { prompt: 'How fast are we going?', context: { selectedData: {} } },
        normalizeAiConfig({ model: 'gemma4:e2b-it-qat' }),
        {
          fetchImpl: async (url) => {
            if (String(url).endsWith('/api/tags')) {
              // The server predates capabilities, so think:false was not sent.
              return tagsResponse(undefined);
            }
            return chatResponse({ role: 'assistant', content: '', thinking: 'Let me reason about the vessel...' });
          }
        }
      ),
      /output budget on reasoning.*Max output tokens/s
    );
  });

  // The default configuration is the untagged `gemma4`; the capability lives
  // on the installed tag the family match resolves it to.
  it('resolves an untagged model name before checking the capability', async () => {
    let chatBody;
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat' }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return tagsResponse(['completion', 'thinking']);
          }
          chatBody = JSON.parse(String(init.body));
          return chatResponse({ role: 'assistant', content: 'Five knots.' });
        }
      }
    );
    assert.equal(chatBody.think, false);

    // And via the family match, the way the shipped default reaches the tag:
    // the bare name 404s, the retry runs against the resolved tag, and the
    // thinking decision is recomputed for it.
    const chatBodies = [];
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4' }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return tagsResponse(['completion', 'thinking']);
          }
          chatBodies.push(JSON.parse(String(init.body)));
          if (chatBodies.length === 1) {
            return new Response(JSON.stringify({ error: "model 'gemma4' not found" }), {
              status: 404,
              headers: { 'content-type': 'application/json' }
            });
          }
          return chatResponse({ role: 'assistant', content: 'Five knots.' });
        }
      }
    );

    assert.equal(chatBodies.length, 2);
    assert.equal(chatBodies[0].model, 'gemma4');
    assert.equal(chatBodies[1].model, 'gemma4:e2b-it-qat');
    assert.equal(chatBodies[1].think, false);
  });

  it('disables thinking on the streaming path too', async () => {
    let chatRequest;
    await streamAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat' }),
      {
        fetchImpl: async (url) => {
          assert.ok(String(url).endsWith('/api/tags'), `unexpected fetch: ${url}`);
          return tagsResponse(['completion', 'thinking']);
        },
        ollamaClient: {
          async chat(request) {
            chatRequest = request;
            return (async function* generate() {
              yield {
                model: 'gemma4:e2b-it-qat',
                created_at: '2026-04-11T10:00:00.000Z',
                message: { role: 'assistant', content: 'Five knots.' },
                done: true
              };
            })();
          }
        }
      },
      () => {}
    );

    assert.equal(chatRequest.think, false);
  });
});

// A Xavier with num_batch 2048 sees the compute buffers, not the KV cache, as
// the dominant allocation - so a retry that only halved num_ctx failed exactly
// like the first attempt and handed the operator a bare CUDA error.
describe('out-of-memory retry', () => {
  function oomResponse() {
    return new Response(
      JSON.stringify({ error: 'an error was encountered while running the model: CUDA error: out of memory' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  function okResponse() {
    return new Response(
      JSON.stringify({
        model: 'gemma4:e2b-it-qat',
        created_at: '2026-04-11T10:00:00.000Z',
        message: { role: 'assistant', content: 'Five knots.' },
        done: true
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  it('retries with both the context and the batch halved', async () => {
    const chatBodies = [];
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat', numCtx: 8192, numBatch: 2048 }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return new Response(JSON.stringify({ models: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          chatBodies.push(JSON.parse(String(init.body)));
          return chatBodies.length === 1 ? oomResponse() : okResponse();
        }
      }
    );

    assert.equal(chatBodies.length, 2);
    assert.equal(chatBodies[0].options.num_ctx, 8192);
    assert.equal(chatBodies[0].options.num_batch, 2048);
    assert.equal(chatBodies[1].options.num_ctx, 4096);
    assert.equal(chatBodies[1].options.num_batch, 1024);
  });

  it('names the settings that decide the allocation when the retry also fails', async () => {
    await assert.rejects(
      queryAiModel(
        { prompt: 'How fast are we going?', context: { selectedData: {} } },
        normalizeAiConfig({ model: 'gemma4:e2b-it-qat', numCtx: 8192, numBatch: 2048 }),
        {
          fetchImpl: async (url) => {
            if (String(url).endsWith('/api/tags')) {
              return new Response(JSON.stringify({ models: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
              });
            }
            return oomResponse();
          }
        }
      ),
      (error) => {
        assert.match(error.message, /ran out of memory even after retrying smaller/);
        // The values the smallest attempt actually used, so the operator knows
        // what to lower from.
        assert.match(error.message, /context window 1024/);
        assert.match(error.message, /batch size 256/);
        assert.match(error.message, /num_ctx/);
        assert.match(error.message, /num_batch/);
        return true;
      }
    );
  });

  it('keeps halving until something fits rather than giving up after one try', async () => {
    const chatBodies = [];
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat', numCtx: 8192, numBatch: 2048 }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return new Response(JSON.stringify({ models: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          chatBodies.push(JSON.parse(String(init.body)));
          return chatBodies.length < 3 ? oomResponse() : okResponse();
        }
      }
    );

    assert.deepEqual(
      chatBodies.map((body) => [body.options.num_ctx, body.options.num_batch]),
      [
        [8192, 2048],
        [4096, 1024],
        [2048, 512]
      ]
    );
  });

  it('retries smaller even when the operator pinned the offload settings', async () => {
    const chatBodies = [];
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat', numCtx: 8192, numBatch: 2048, gpuAutoTune: false }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return new Response(JSON.stringify({ models: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          chatBodies.push(JSON.parse(String(init.body)));
          return chatBodies.length === 1 ? oomResponse() : okResponse();
        }
      }
    );

    assert.equal(chatBodies.length, 2);
    assert.equal(chatBodies[1].options.num_ctx, 4096);
    assert.equal(chatBodies[1].options.num_batch, 1024);
  });

  it('never asks for a batch wider than the context window', async () => {
    const chatBodies = [];
    await queryAiModel(
      { prompt: 'How fast are we going?', context: { selectedData: {} } },
      normalizeAiConfig({ model: 'gemma4:e2b-it-qat', numCtx: 1024, numBatch: 2048 }),
      {
        fetchImpl: async (url, init = {}) => {
          if (String(url).endsWith('/api/tags')) {
            return new Response(JSON.stringify({ models: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          chatBodies.push(JSON.parse(String(init.body)));
          return okResponse();
        }
      }
    );

    assert.equal(chatBodies[0].options.num_ctx, 1024);
    assert.equal(chatBodies[0].options.num_batch, 1024);
  });
});
