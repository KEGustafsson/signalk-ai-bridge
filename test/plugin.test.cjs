'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('../index.cjs');

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function createPluginHost(overrides = {}) {
  const selfTree = overrides.selfTree || {
    navigation: {
      position: {
        latitude: 60.1,
        longitude: 24.9
      },
      speedOverGround: 5.4,
      courseOverGroundTrue: 180
    },
    notifications: {
      'navigation.anchor': {
        state: 'alarm',
        message: 'Anchor drag detected'
      }
    }
  };

  function getAtPath(root, dottedPath) {
    return dottedPath.split('.').reduce((value, segment) => {
      if (value && typeof value === 'object') {
        return value[segment];
      }
      return undefined;
    }, root);
  }

  return {
    selfId: overrides.selfId || 'vessels.urn:mrn:signalk:uuid:test-self',
    setPluginStatus: overrides.setPluginStatus || (() => {}),
    getSelfPath: overrides.getSelfPath || ((path) => getAtPath(selfTree, path))
  };
}

describe('signalk-ai-bridge plugin', () => {
  it('exposes AI status with real backend availability details', async () => {
    const registeredRoutes = {};
    let pluginStatus = '';

    const plugin = createPlugin(createPluginHost({
      setPluginStatus(message) {
        pluginStatus = message;
      }
    }), {
      fetchImpl: async () =>
        new Response(
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
        )
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434',
      maxTokens: 131072,
      requestTimeoutMs: 0
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const statusResponse = createResponseRecorder();
    await registeredRoutes['GET /ai/status']({}, statusResponse);

    assert.equal(statusResponse.statusCode, 200);
    assert.equal(statusResponse.body.model, 'gemma4:e2b');
    assert.equal(statusResponse.body.maxTokens, 131072);
    assert.equal(statusResponse.body.requestTimeoutMs, 0);
    assert.equal(statusResponse.body.signalKSelfId, 'vessels.urn:mrn:signalk:uuid:test-self');
    assert.equal(statusResponse.body.ollamaReachable, true);
    assert.equal(statusResponse.body.modelAvailable, true);
    assert.equal(statusResponse.body.aiAvailable, true);
    assert.equal(statusResponse.body.resolvedModel, 'gemma4:e2b');
    assert.match(statusResponse.body.availabilityMessage, /reachable/i);
    assert.match(pluginStatus, /gemma4:e2b/);
  });

  it('collects configured Signal K data for Ask AI requests', async () => {
    const registeredRoutes = {};
    let capturedMessages = [];

    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        chat: async ({ messages }) => {
          capturedMessages = messages;
          return {
            model: 'gemma4:e2b',
            created_at: '2026-04-11T10:00:00.000Z',
            message: {
              role: 'assistant',
              content: 'Steady course and speed.'
            },
            prompt_eval_count: 6,
            eval_count: 4
          };
        }
      }
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434',
      aiDataPaths: ['navigation.*', 'notifications']
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const bridgeResponse = createResponseRecorder();
    await registeredRoutes['POST /bridge/execute'](
      {
        user: { id: 'operator-1' },
        body: {
          toolId: 'ask-vessel-ai',
          prompt: 'Summarize the current situation.'
        }
      },
      bridgeResponse
    );

    assert.equal(bridgeResponse.statusCode, 200);
    assert.equal(bridgeResponse.body.type, 'ask-vessel-ai-result');
    assert.deepEqual(bridgeResponse.body.context.aiDataPaths, ['navigation.*', 'notifications']);
    assert.equal(bridgeResponse.body.context.selectedData['navigation.position.latitude'], 60.1);
    assert.equal(bridgeResponse.body.context.selectedData['navigation.speedOverGround'], 5.4);
    assert.equal(bridgeResponse.body.context.selectedData.notifications['navigation.anchor'].state, 'alarm');
    assert.match(capturedMessages[1].content, /selectedData/);
  });

  it('converts angle data from radians to degrees before sending it to AI', async () => {
    const registeredRoutes = {};

    const plugin = createPlugin(createPluginHost({
      selfTree: {
        navigation: {
          headingTrue: Math.PI,
          courseOverGroundTrue: Math.PI / 2
        }
      }
    }), {
      ollamaClient: {
        chat: async () => ({
          model: 'gemma4:e2b',
          created_at: '2026-04-11T10:00:00.000Z',
          message: {
            role: 'assistant',
            content: 'Angle conversion worked.'
          }
        })
      }
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434',
      aiDataPaths: ['navigation.headingTrue', 'navigation.courseOverGroundTrue']
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const bridgeResponse = createResponseRecorder();
    await registeredRoutes['POST /bridge/execute'](
      {
        user: { id: 'operator-1' },
        body: {
          toolId: 'ask-vessel-ai',
          prompt: 'Summarize heading and course.'
        }
      },
      bridgeResponse
    );

    assert.equal(bridgeResponse.statusCode, 200);
    assert.equal(bridgeResponse.body.context.selectedData['navigation.headingTrue'], 180);
    assert.equal(bridgeResponse.body.context.selectedData['navigation.courseOverGroundTrue'], 90);
  });

  it('converts wildcard-selected angle fields from radians to degrees', async () => {
    const registeredRoutes = {};

    const plugin = createPlugin(createPluginHost({
      selfTree: {
        environment: {
          wind: {
            angleApparent: Math.PI / 3,
            speedApparent: 8.2
          }
        }
      }
    }), {
      ollamaClient: {
        chat: async () => ({
          model: 'gemma4:e2b',
          created_at: '2026-04-11T10:00:00.000Z',
          message: {
            role: 'assistant',
            content: 'Wildcard angle conversion worked.'
          }
        })
      }
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434',
      aiDataPaths: ['environment.*']
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const bridgeResponse = createResponseRecorder();
    await registeredRoutes['POST /bridge/execute'](
      {
        user: { id: 'operator-1' },
        body: {
          toolId: 'ask-vessel-ai',
          prompt: 'Summarize wind.'
        }
      },
      bridgeResponse
    );

    assert.equal(bridgeResponse.statusCode, 200);
    assert.equal(bridgeResponse.body.context.selectedData['environment.wind.angleApparent'], 60);
    assert.equal(bridgeResponse.body.context.selectedData['environment.wind.speedApparent'], 8.2);
  });

  it('retries Ask AI with an installed tagged Gemma model', async () => {
    const registeredRoutes = {};
    const chatModels = [];
    let listCalls = 0;

    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        async chat({ model }) {
          chatModels.push(model);
          if (model === 'gemma4') {
            const error = new Error("model 'gemma4' not found");
            error.status_code = 404;
            throw error;
          }

          return {
            model,
            created_at: '2026-04-11T10:00:00.000Z',
            message: {
              role: 'assistant',
              content: 'Tagged model fallback worked.'
            }
          };
        }
      },
      fetchImpl: async (url) => {
        listCalls += 1;
        assert.equal(String(url), 'http://localhost:11434/api/tags');
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
    });

    plugin.start({
      model: 'gemma4',
      baseUrl: 'http://localhost:11434'
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const bridgeResponse = createResponseRecorder();
    await registeredRoutes['POST /bridge/execute'](
      {
        user: { id: 'operator-1' },
        body: {
          toolId: 'ask-vessel-ai',
          prompt: 'Summarize the current situation.'
        }
      },
      bridgeResponse
    );

    assert.equal(bridgeResponse.statusCode, 200);
    assert.equal(bridgeResponse.body.response.answer, 'Tagged model fallback worked.');
    assert.equal(bridgeResponse.body.response.model, 'gemma4:e2b');
    assert.deepEqual(chatModels, ['gemma4', 'gemma4:e2b']);
    assert.equal(listCalls, 1);
  });

  it('reports when Ollama is reachable but the configured model is missing', async () => {
    const registeredRoutes = {};
    const plugin = createPlugin(createPluginHost(), {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'llama3.2',
                details: {
                  family: 'llama3',
                  families: ['llama3']
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
        )
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434'
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const statusResponse = createResponseRecorder();
    await registeredRoutes['GET /ai/status']({}, statusResponse);

    assert.equal(statusResponse.statusCode, 200);
    assert.equal(statusResponse.body.ollamaReachable, true);
    assert.equal(statusResponse.body.modelAvailable, false);
    assert.equal(statusResponse.body.aiAvailable, false);
    assert.equal(statusResponse.body.resolvedModel, undefined);
    assert.match(statusResponse.body.availabilityMessage, /not installed/i);
  });

  it('fills AI query context on the server', async () => {
    const registeredRoutes = {};
    let capturedMessages = [];

    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        chat: async ({ messages }) => {
          capturedMessages = messages;
          return {
            model: 'gemma4:e2b',
            created_at: '2026-04-11T10:00:00.000Z',
            message: {
              role: 'assistant',
              content: 'Prompt-only request worked.'
            }
          };
        }
      }
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434',
      aiDataPaths: ['navigation.position', 'notifications']
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const queryResponse = createResponseRecorder();
    await registeredRoutes['POST /ai/query'](
      {
        user: { id: 'operator-1' },
        body: {
          prompt: 'Summarize the vessel state.'
        }
      },
      queryResponse
    );

    assert.equal(queryResponse.statusCode, 200);
    assert.equal(queryResponse.body.answer, 'Prompt-only request worked.');
    assert.match(capturedMessages[1].content, /selectedData/);
    assert.match(capturedMessages[1].content, /navigation\.position/);
    assert.match(capturedMessages[1].content, /notifications/);
  });

  it('ignores caller-supplied AI context and rebuilds it from Signal K data', async () => {
    const registeredRoutes = {};
    let capturedMessages = [];

    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        chat: async ({ messages }) => {
          capturedMessages = messages;
          return {
            model: 'gemma4:e2b',
            created_at: '2026-04-11T10:00:00.000Z',
            message: {
              role: 'assistant',
              content: 'Server-built context was used.'
            }
          };
        }
      }
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434',
      aiDataPaths: ['navigation.position']
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const queryResponse = createResponseRecorder();
    await registeredRoutes['POST /ai/query'](
      {
        user: { id: 'operator-1' },
        body: {
          prompt: 'Summarize the vessel state.',
          context: {
            serverId: 'forged-server',
            aiDataPaths: ['environment.*'],
            selectedData: {
              'environment.wind.speedTrue': 99
            }
          }
        }
      },
      queryResponse
    );

    assert.equal(queryResponse.statusCode, 200);
    assert.equal(queryResponse.body.answer, 'Server-built context was used.');
    assert.match(capturedMessages[1].content, /navigation\.position/);
    assert.doesNotMatch(capturedMessages[1].content, /forged-server/);
    assert.doesNotMatch(capturedMessages[1].content, /environment\.wind\.speedTrue/);
  });

  it('ignores missing configured AI data paths instead of failing the request', async () => {
    const registeredRoutes = {};

    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        chat: async () => ({
          model: 'gemma4:e2b',
          created_at: '2026-04-11T10:00:00.000Z',
          message: {
            role: 'assistant',
            content: 'Missing path was ignored.'
          }
        })
      }
    });

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434',
      aiDataPaths: ['navigation.position', 'environment.wind.speedTrue']
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const bridgeResponse = createResponseRecorder();
    await registeredRoutes['POST /bridge/execute'](
      {
        user: { id: 'operator-1' },
        body: {
          toolId: 'ask-vessel-ai',
          prompt: 'Summarize the current situation.'
        }
      },
      bridgeResponse
    );

    assert.equal(bridgeResponse.statusCode, 200);
    assert.equal(bridgeResponse.body.response.answer, 'Missing path was ignored.');
    assert.equal(bridgeResponse.body.context.selectedData['navigation.position'].latitude, 60.1);
    assert.equal('environment.wind.speedTrue' in bridgeResponse.body.context.selectedData, false);
  });

  it('rejects anonymous AI query and bridge requests', async () => {
    const registeredRoutes = {};
    const plugin = createPlugin(createPluginHost());

    plugin.start({
      model: 'gemma4:e2b',
      baseUrl: 'http://localhost:11434'
    });

    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const queryResponse = createResponseRecorder();
    await registeredRoutes['POST /ai/query'](
      {
        body: {
          prompt: 'Summarize the vessel state.'
        }
      },
      queryResponse
    );

    const bridgeResponse = createResponseRecorder();
    await registeredRoutes['POST /bridge/execute'](
      {
        body: {
          toolId: 'ask-vessel-ai',
          prompt: 'Summarize the current situation.'
        }
      },
      bridgeResponse
    );

    assert.equal(queryResponse.statusCode, 401);
    assert.equal(queryResponse.body.error.code, 'unauthorized');
    assert.equal(bridgeResponse.statusCode, 401);
    assert.equal(bridgeResponse.body.error.code, 'unauthorized');
  });

});
