'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAiMessages,
  normalizeAiConfig,
  queryAiModel
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
    assert.match(capturedBody, /\"num_predict\":131072/);
    assert.match(capturedBody, /\"num_ctx\":131072/);
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
