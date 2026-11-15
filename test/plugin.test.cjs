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
      warmupOnStart: false,
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
      warmupOnStart: false,
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
    // 5.4 m/s in knots: speeds reach the model in the units an operator reads.
    assert.equal(bridgeResponse.body.context.selectedData['navigation.speedOverGround'], 10.5);
    // Notifications are flattened whatever shape selects them - here the bare
    // branch name, which is what the plugin's own default selection uses. As
    // one nested object they could only be dropped from the prompt whole,
    // taking live alarms with them, and neither the normal-notification
    // trimming nor the "no alarm data" note could see inside them.
    assert.equal(
      bridgeResponse.body.context.selectedData['notifications.navigation.anchor.state'],
      'alarm'
    );
    assert.equal(bridgeResponse.body.context.selectedData.notifications, undefined);
    // The prompt carries the data keyed by path, with no second copy of the
    // path list — every token here is prompt-eval work on the GPU.
    assert.match(capturedMessages[1].content, /"data":/);
    assert.match(capturedMessages[1].content, /navigation\.speedOverGround/);
    assert.doesNotMatch(capturedMessages[1].content, /"aiDataPaths"/);
    assert.doesNotMatch(capturedMessages[1].content, /\n  "/);
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
      warmupOnStart: false,
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
      warmupOnStart: false,
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
    assert.equal(bridgeResponse.body.context.selectedData['environment.wind.speedApparent'], 15.94);
  });

  // Both path lists left the settings schema: they are chosen against what the
  // vessel publishes, which the settings form cannot show and the panel can.
  describe('path selection from the panel', () => {
    function createSavingPlugin(overrides = {}) {
      const saved = [];
      const host = createPluginHost();
      const plugin = createPlugin(
        {
          ...host,
          savePluginOptions: (options, callback) => {
            saved.push(options);
            callback(null);
          },
          ...overrides
        },
        {
          fetchImpl: async () =>
            new Response(JSON.stringify({ models: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })
        }
      );

      plugin.start({ aiModel: { warmupOnStart: false } });
      const routes = {};
      plugin.registerWithRouter({
        get(path, handler) {
          routes[`GET ${path}`] = handler;
        },
        post(path, handler) {
          routes[`POST ${path}`] = handler;
        }
      });
      return { plugin, routes, saved };
    }

    it('no longer offers the two path lists as plugin settings', () => {
      const plugin = createPlugin(createPluginHost(), {});
      const properties = plugin.schema().properties;

      assert.ok(!('aiDataPaths' in properties));
      assert.ok(!('historyPaths' in properties));
      // The rest of the history settings stay in the form, in their section.
      assert.ok('historyEnabled' in properties.history.properties);
      const [, on] = properties.history.dependencies.historyEnabled.oneOf;
      assert.ok('historyDuration' in on.properties);
      assert.ok(!JSON.stringify(plugin.schema()).includes('"aiDataPaths"'));
      assert.ok(!JSON.stringify(plugin.schema()).includes('"historyPaths"'));
    });

    it('stores a selection and applies it to the running plugin', async () => {
      const { plugin, routes, saved } = createSavingPlugin();

      const response = createResponseRecorder();
      await routes['POST /paths/selection'](
        {
          headers: {},
          body: { aiDataPaths: ['navigation.*', ' navigation.* ', 'notifications'], historyPaths: ['navigation.speedOverGround'] }
        },
        response
      );

      assert.equal(response.statusCode, 200);
      // Trimmed and deduplicated on the way in.
      assert.deepEqual(response.body.aiDataPaths, ['navigation.*', 'notifications']);
      assert.deepEqual(saved[0].aiDataPaths, ['navigation.*', 'notifications']);
      assert.deepEqual(saved[0].historyPaths, ['navigation.speedOverGround']);

      // Applied without waiting for a restart: the status route reports it.
      const status = createResponseRecorder();
      await routes['GET /ai/status']({}, status);
      assert.deepEqual(status.body.aiDataPaths, ['navigation.*', 'notifications']);

      plugin.stop();
    });

    it('rejects a body that selects nothing at all', async () => {
      const { plugin, routes } = createSavingPlugin();

      const response = createResponseRecorder();
      await routes['POST /paths/selection']({ headers: {}, body: { nothing: true } }, response);

      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.code, 'validation-failed');
      plugin.stop();
    });

    // The selection decides what vessel data leaves the boat, so on a secured
    // server it takes a login with write access - not merely a reachable route.
    it('refuses an anonymous change when the server has security enabled', async () => {
      const { plugin, routes, saved } = createSavingPlugin({
        securityStrategy: { isDummy: () => false, getLoginStatus: () => ({ status: 'notLoggedIn' }) }
      });

      const anonymous = createResponseRecorder();
      await routes['POST /paths/selection']({ headers: {}, body: { aiDataPaths: ['navigation.*'] } }, anonymous);
      assert.equal(anonymous.statusCode, 401);
      assert.equal(anonymous.body.error.code, 'unauthorized');

      const readOnly = createResponseRecorder();
      await routes['POST /paths/selection'](
        { headers: {}, skPrincipal: { permissions: 'readonly' }, body: { aiDataPaths: ['navigation.*'] } },
        readOnly
      );
      assert.equal(readOnly.statusCode, 401);
      assert.equal(saved.length, 0);

      const admin = createResponseRecorder();
      await routes['POST /paths/selection'](
        { headers: {}, skPrincipal: { permissions: 'admin' }, body: { aiDataPaths: ['navigation.*'] } },
        admin
      );
      assert.equal(admin.statusCode, 200);
      assert.equal(saved.length, 1);

      plugin.stop();
    });

    // readOnlyAccess in the login status is the server's "Allow Readonly
    // Access" setting, not the login's level; userLevel is.
    it('judges a login status by its userLevel, not by the server allowing read-only visitors', async () => {
      const cases = [
        [{ status: 'loggedIn', readOnlyAccess: true, userLevel: 'admin' }, 200],
        [{ status: 'loggedIn', readOnlyAccess: false, userLevel: 'readwrite' }, 200],
        [{ status: 'loggedIn', readOnlyAccess: false, userLevel: 'readonly' }, 401],
        [{ status: 'loggedIn' }, 401]
      ];
      for (const [loginStatus, expected] of cases) {
        const { plugin, routes } = createSavingPlugin({
          securityStrategy: { isDummy: () => false, getLoginStatus: () => loginStatus }
        });
        const response = createResponseRecorder();
        await routes['POST /paths/selection']({ headers: {}, body: { aiDataPaths: ['navigation.*'] } }, response);
        assert.equal(response.statusCode, expected, JSON.stringify(loginStatus));
        plugin.stop();
      }
    });

    it('says so when the server cannot store plugin settings', async () => {
      const host = createPluginHost();
      const plugin = createPlugin({ ...host, savePluginOptions: undefined }, {});
      plugin.start({ warmupOnStart: false });
      const routes = {};
      plugin.registerWithRouter({
        get(path, handler) {
          routes[`GET ${path}`] = handler;
        },
        post(path, handler) {
          routes[`POST ${path}`] = handler;
        }
      });

      const response = createResponseRecorder();
      await routes['POST /paths/selection']({ headers: {}, body: { aiDataPaths: ['navigation.*'] } }, response);
      assert.equal(response.statusCode, 501);

      plugin.stop();
    });
  });

  // The panel's live-path picker: what does this vessel actually publish?
  it('lists the live Signal K paths at both granularities for the picker', async () => {
    const registeredRoutes = {};
    const plugin = createPlugin(createPluginHost(), {
      fetchImpl: async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    });

    plugin.start({ warmupOnStart: false, aiDataPaths: ['navigation.*'] });
    plugin.registerWithRouter({
      get(path, handler) {
        registeredRoutes[`GET ${path}`] = handler;
      },
      post(path, handler) {
        registeredRoutes[`POST ${path}`] = handler;
      }
    });

    const response = createResponseRecorder();
    await registeredRoutes['GET /signalk/paths']({ headers: {} }, response);

    assert.equal(response.statusCode, 200);
    // A branch wildcard is the selection that scales; the leaves it covers are
    // offered beside it for a narrower choice.
    assert.deepEqual(
      response.body.branches.map((branch) => branch.path).sort(),
      ['navigation.*', 'notifications.*']
    );
    assert.ok(response.body.paths.includes('navigation.speedOverGround'));
    assert.ok(response.body.paths.includes('navigation.position.latitude'));
    // The staleness keys the prompt flattener adds are not selectable paths.
    assert.ok(!response.body.paths.some((path) => path.endsWith('@')));
    // The picker pre-ticks what the plugin already uses.
    assert.deepEqual(response.body.selected, ['navigation.*']);

    plugin.stop();
    const stopped = createResponseRecorder();
    await registeredRoutes['GET /signalk/paths']({ headers: {} }, stopped);
    assert.equal(stopped.statusCode, 503);
  });

  it('sends Ask AI straight to the installed tagged Gemma model', async () => {
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
      warmupOnStart: false,
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
    // Resolved from the listing before the first request: no rejected
    // `gemma4` attempt ahead of the real one.
    assert.deepEqual(chatModels, ['gemma4:e2b']);
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
      warmupOnStart: false,
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
      warmupOnStart: false,
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
    // The prompt carries the data keyed by path, with no second copy of the
    // path list — every token here is prompt-eval work on the GPU.
    assert.match(capturedMessages[1].content, /"data":/);
    assert.doesNotMatch(capturedMessages[1].content, /"aiDataPaths"/);
    assert.doesNotMatch(capturedMessages[1].content, /\n  "/);
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
      warmupOnStart: false,
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
      warmupOnStart: false,
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

  it('allows prompt-only AI routes without explicit auth state', async () => {
    const registeredRoutes = {};

    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        chat: async () => ({
          model: 'gemma4:e2b',
          created_at: '2026-04-11T10:00:00.000Z',
          message: {
            role: 'assistant',
            content: 'Anonymous local request worked.'
          }
        })
      }
    });

    plugin.start({
      warmupOnStart: false,
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

    assert.equal(queryResponse.statusCode, 200);
    assert.equal(queryResponse.body.answer, 'Anonymous local request worked.');
    assert.equal(bridgeResponse.statusCode, 200);
    assert.equal(bridgeResponse.body.response.answer, 'Anonymous local request worked.');
  });


  it('reports GPU residency and accelerator settings on /ai/status', async () => {
    const registeredRoutes = {};
    const plugin = createPlugin(createPluginHost(), {
      fetchImpl: async (url) => {
        if (String(url).endsWith('/api/ps')) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: 'gemma4:e2b',
                  size: 5000000000,
                  size_vram: 5000000000,
                  expires_at: '2026-04-11T10:30:00.000Z'
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }

        return new Response(JSON.stringify({ models: [{ name: 'gemma4:e2b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    });

    plugin.start({
      warmupOnStart: false,
      model: 'gemma4:e2b',
      numCtx: 4096,
      numGpu: 999,
      keepAlive: '45m'
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
    assert.equal(statusResponse.body.backend, 'ollama');
    assert.equal(statusResponse.body.numCtx, 4096);
    assert.equal(statusResponse.body.numGpu, 999);
    assert.equal(statusResponse.body.keepAlive, '45m');
    assert.equal(statusResponse.body.accelerator.state, 'gpu');
    assert.equal(statusResponse.body.accelerator.vramBytes, 5000000000);
  });

  it('omits GPU residency when the inference host is unreachable', async () => {
    const registeredRoutes = {};
    const plugin = createPlugin(createPluginHost(), {
      fetchImpl: async () => {
        throw new Error('fetch failed');
      }
    });

    plugin.start({ warmupOnStart: false });
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
    assert.equal(statusResponse.body.ollamaReachable, false);
    assert.equal(statusResponse.body.accelerator, undefined);
  });

  it('preloads the model on start so the first question does not pay the cold load', async () => {
    const calls = [];
    const statusMessages = [];
    const plugin = createPlugin(
      createPluginHost({
        setPluginStatus(message) {
          statusMessages.push(message);
        }
      }),
      {
        fetchImpl: async (url) => {
          calls.push(String(url));
          if (String(url).endsWith('/api/tags')) {
            return new Response(JSON.stringify({ models: [{ name: 'gemma4:e2b' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          return new Response(JSON.stringify({ done: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      }
    );

    plugin.start({ model: 'gemma4:e2b', keepAlive: '30m' });

    // start() must not block on the warm-up, so wait for it separately.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(calls.includes('http://localhost:11434/api/generate'));
    assert.ok(statusMessages.some((message) => /preloaded/.test(message)));
    plugin.stop();
  });

});

describe('lifecycle gating', () => {
  function makeHost() {
    const statuses = [];
    const errors = [];
    return {
      app: {
        selfId: 'urn:mrn:signalk:uuid:test-self',
        getSelfPath: () => undefined,
        setPluginStatus: (text) => statuses.push(text),
        setPluginError: (text) => errors.push(text)
      },
      statuses,
      errors
    };
  }

  function collectRoutes(plugin) {
    const routes = {};
    plugin.registerWithRouter({
      get: (path, handler) => {
        routes[`GET ${path}`] = handler;
      },
      post: (path, handler) => {
        routes[`POST ${path}`] = handler;
      }
    });
    return routes;
  }

  function recorder() {
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
      },
      setHeader() {},
      write() {
        return true;
      },
      end() {}
    };
  }

  it('serves nothing, and reaches no backend, once stopped', async () => {
    // Express cannot unmount a subrouter and signalk-server never tries, so a
    // stopped plugin kept answering - and getConfig() fell back to
    // normalizeAiConfig({}), whose defaults are enabled:true against
    // http://localhost:11434. That is inference against a host the operator
    // never configured, from a plugin they had switched off.
    const host = makeHost();
    const reached = [];
    const plugin = createPlugin(host.app, {
      ollamaClient: {
        async chat() {
          reached.push('chat');
          return { message: { content: 'hi' } };
        }
      },
      fetchImpl: async (url) => {
        reached.push(String(url));
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    });
    const routes = collectRoutes(plugin);

    plugin.start({ model: 'my-model', baseUrl: 'http://ollama.local:11434', warmupOnStart: false });
    plugin.stop();
    reached.length = 0;

    for (const route of ['GET /ai/status', 'POST /ai/query', 'POST /bridge/execute', 'POST /ai/retune']) {
      const res = recorder();
      await routes[route]({ body: { toolId: 'ask-vessel-ai', prompt: 'Status?' } }, res);
      assert.equal(res.statusCode, 503, `${route} should refuse while stopped`);
      assert.equal(res.body.error.code, 'disabled');
    }

    assert.deepEqual(reached, [], 'a stopped plugin must not contact any backend');
  });

  it('reports an unreachable backend as a plugin error, not as ready', async () => {
    const host = makeHost();
    const plugin = createPlugin(host.app, {
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      }
    });

    plugin.start({ warmupOnStart: true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(host.errors.length, 1, 'the admin UI should be told the backend is down');
    assert.match(host.errors[0], /could not reach the model/i);
  });

  it('exposes a password widget for both API keys', () => {
    const plugin = createPlugin(makeHost().app, {});
    assert.equal(typeof plugin.uiSchema, 'function');
    assert.equal(plugin.uiSchema().aiModel.apiKey['ui:widget'], 'password');
    assert.equal(plugin.uiSchema().history.historyApiKey['ui:widget'], 'password');
  });
});

describe('settings stored in sections', () => {
  /** Options as the admin page stores them, every section filled in, with the panel's selections. */
  const sectioned = () => ({
    enabled: true,
    aiModel: {
      backend: 'ollama',
      baseUrl: 'http://gpu.local:11434',
      model: 'gemma4:e2b',
      keepAlive: '1h',
      warmupOnStart: false
    },
    answers: { systemPrompt: 'Be brief.', temperature: 0.3, topP: 0.9, maxTokens: 1024, requestTimeoutMs: 180000 },
    history: {
      historyEnabled: true,
      historyDuration: 'PT2H',
      historyResolution: '',
      historySamples: 20,
      historyServerUrl: '',
      historyApiKey: '',
      historyProvider: 'signalk-parquet',
      historyTimeoutMs: 6000
    },
    advanced: { numCtx: 4096, numGpu: -1, gpuAutoTune: false, numBatch: 256, numThread: 0 },
    aiDataPaths: ['a.one', 'b.two', 'c.three'],
    historyPaths: ['h.one', 'h.two']
  });

  function startWith(options, appOverrides = {}) {
    const saved = [];
    const statuses = [];
    const fetched = [];
    const app = {
      selfId: 'urn:mrn:signalk:uuid:test-self',
      getSelfPath: () => undefined,
      setPluginStatus: (text) => statuses.push(text),
      savePluginOptions: (stored, done) => {
        saved.push(JSON.parse(JSON.stringify(stored)));
        done(null);
      },
      ...appOverrides
    };
    const plugin = createPlugin(app, {
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    const routes = {};
    plugin.registerWithRouter({
      get: (path, handler) => {
        routes[`GET ${path}`] = handler;
      },
      post: (path, handler) => {
        routes[`POST ${path}`] = handler;
      }
    });
    plugin.start(options);
    return { plugin, routes, saved, statuses, fetched };
  }

  it('keeps every section as it was when a selection is saved or a path moved, and adds no flat keys', async () => {
    const options = sectioned();
    const { plugin, routes, saved } = startWith(options);
    try {
      const selection = createResponseRecorder();
      await routes['POST /paths/selection']({ headers: {}, body: { aiDataPaths: ['a.one', 'b.two', 'c.three', 'd.four'] } }, selection);
      assert.equal(selection.statusCode, 200);
      const historySelection = createResponseRecorder();
      await routes['POST /paths/selection']({ headers: {}, body: { historyPaths: ['h.one', 'h.two', 'h.three'] } }, historySelection);
      assert.equal(historySelection.statusCode, 200);
      const live = createResponseRecorder();
      await routes['POST /paths/move']({ headers: {}, body: { kind: 'live', path: 'd.four', delta: -1 } }, live);
      assert.equal(live.statusCode, 200);
      const history = createResponseRecorder();
      await routes['POST /paths/move']({ headers: {}, body: { kind: 'history', path: 'h.three', delta: -1 } }, history);
      assert.equal(history.statusCode, 200);

      assert.equal(saved.length, 4);
      const sections = sectioned();
      delete sections.aiDataPaths;
      delete sections.historyPaths;
      for (const stored of saved) {
        const { aiDataPaths, historyPaths, ...rest } = stored;
        assert.deepEqual(rest, sections);
        assert.ok(Array.isArray(aiDataPaths));
        assert.ok(Array.isArray(historyPaths));
        assert.deepEqual(Object.keys(stored).sort(), ['advanced', 'aiDataPaths', 'aiModel', 'answers', 'enabled', 'history', 'historyPaths']);
      }
      assert.deepEqual(saved[0].aiDataPaths, ['a.one', 'b.two', 'c.three', 'd.four']);
      assert.deepEqual(saved[1].historyPaths, ['h.one', 'h.two', 'h.three']);
      assert.deepEqual(saved[2].aiDataPaths, ['a.one', 'b.two', 'd.four', 'c.three']);
      assert.deepEqual(saved[3].historyPaths, ['h.one', 'h.three', 'h.two']);
      // The options it was started with are not changed in place.
      assert.deepEqual(options, sectioned());
    } finally {
      plugin.stop();
    }
  });

  it('runs on the settings its sections hold', async () => {
    const { plugin, routes, statuses, fetched } = startWith(sectioned());
    try {
      assert.match(statuses.at(-1), /gemma4:e2b via http:\/\/gpu\.local:11434/);
      const status = createResponseRecorder();
      await routes['GET /ai/status']({}, status);
      assert.equal(status.statusCode, 200);
      assert.equal(status.body.model, 'gemma4:e2b');
      assert.equal(status.body.baseUrl, 'http://gpu.local:11434');
      assert.equal(status.body.requestTimeoutMs, 180000);
      assert.equal(status.body.maxTokens, 1024);
      assert.equal(status.body.configuredNumCtx, 4096);
      assert.equal(status.body.numBatch, 256);
      assert.equal(status.body.keepAlive, '1h');
      assert.equal(status.body.gpuAutoTune, false);
      assert.deepEqual(status.body.aiDataPaths, ['a.one', 'b.two', 'c.three']);
      assert.equal(status.body.history.enabled, true);
      assert.equal(status.body.history.samples, 20);
      assert.equal(status.body.history.durationSeconds, 7200);
      assert.equal(status.body.history.provider, 'signalk-parquet');
      assert.deepEqual(status.body.history.paths, ['h.one', 'h.two']);
      assert.ok(fetched.every((url) => url.startsWith('http://gpu.local:11434/')), fetched.join(', '));
    } finally {
      plugin.stop();
    }
  });

  it('says which switch to turn on when it is off', () => {
    const { plugin, statuses } = startWith({ ...sectioned(), enabled: false });
    try {
      assert.match(statuses.at(-1), /switch on "Turn on AI Bridge"/);
    } finally {
      plugin.stop();
    }
  });
});

describe('settings saved flat by an earlier version', () => {
  /** Flat options, as every version before the sections stored them. */
  const flat = () => ({
    enabled: true,
    baseUrl: 'http://gpu.local:11434',
    model: 'qwen3:4b',
    warmupOnStart: false,
    maxTokens: 1024,
    historyEnabled: true,
    historySamples: 20,
    numCtx: 4096,
    aiDataPaths: ['a.one', 'b.two'],
    historyPaths: ['h.one']
  });
  const migrated = () => ({
    enabled: true,
    aiDataPaths: ['a.one', 'b.two'],
    historyPaths: ['h.one'],
    aiModel: { baseUrl: 'http://gpu.local:11434', model: 'qwen3:4b', warmupOnStart: false },
    answers: { maxTokens: 1024 },
    history: { historyEnabled: true, historySamples: 20 },
    advanced: { numCtx: 4096 }
  });

  /** Let the options write queue run what start() put on it. */
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  function host(save) {
    const saved = [];
    const app = {
      selfId: 'urn:mrn:signalk:uuid:test-self',
      getSelfPath: () => undefined,
      setPluginStatus: () => {},
      savePluginOptions: (stored, done) => {
        saved.push(JSON.parse(JSON.stringify(stored)));
        (save || ((callback) => callback(null)))(done);
      }
    };
    const plugin = createPlugin(app, {
      fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    });
    const routes = {};
    plugin.registerWithRouter({
      get: (path, handler) => {
        routes[`GET ${path}`] = handler;
      },
      post: (path, handler) => {
        routes[`POST ${path}`] = handler;
      }
    });
    return { plugin, routes, saved };
  }

  const status = async (routes) => {
    const response = createResponseRecorder();
    await routes['GET /ai/status']({}, response);
    return response.body;
  };

  it('moves them into their sections on start and stores that once, so the form shows them', async (t) => {
    const logged = t.mock.method(console, 'log', () => {});
    const { plugin, routes, saved } = host();
    const options = flat();
    plugin.start(options);
    try {
      await settle();
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0], migrated());
      // The options it was started with are not changed in place.
      assert.deepEqual(options, flat());
      const lines = logged.mock.calls.map((call) => call.arguments.join(' '));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^signalk-ai-bridge: moved settings saved by an earlier version into their sections: baseUrl, model, warmupOnStart, maxTokens, historyEnabled, historySamples, numCtx\.$/);
      // Running on the same values as before.
      const body = await status(routes);
      assert.equal(body.model, 'qwen3:4b');
      assert.equal(body.configuredNumCtx, 4096);
      assert.equal(body.history.samples, 20);
      // A later save keeps the sections and brings back no flat key.
      const selection = createResponseRecorder();
      await routes['POST /paths/selection']({ headers: {}, body: { aiDataPaths: ['c.three'] } }, selection);
      assert.equal(selection.statusCode, 200);
      assert.deepEqual(saved[1], { ...migrated(), aiDataPaths: ['c.three'] });
    } finally {
      plugin.stop();
    }
  });

  it('keeps a value already in its section over the flat one', async (t) => {
    const logged = t.mock.method(console, 'log', () => {});
    const { plugin, routes, saved } = host();
    plugin.start({ model: 'old-flat', numCtx: 2048, aiModel: { model: 'from-the-form' } });
    try {
      await settle();
      assert.deepEqual(saved, [{ aiModel: { model: 'from-the-form' }, advanced: { numCtx: 2048 } }]);
      assert.match(logged.mock.calls[0].arguments[0], /numCtx; for model the value already in its section was kept\.$/);
      assert.equal((await status(routes)).model, 'from-the-form');
    } finally {
      plugin.stop();
    }
  });

  it('stores nothing, and says nothing, when nothing is flat', async (t) => {
    const logged = t.mock.method(console, 'log', () => {});
    const { plugin, saved } = host();
    plugin.start(migrated());
    plugin.stop();
    plugin.start({});
    try {
      await settle();
      assert.equal(saved.length, 0);
      assert.equal(logged.mock.calls.length, 0);
    } finally {
      plugin.stop();
    }
  });

  it('runs on the moved settings when they cannot be stored, and tries again on the next start', async (t) => {
    const logged = t.mock.method(console, 'log', () => {});
    let fail = true;
    const { plugin, routes, saved } = host((done) => done(fail ? new Error('disk full') : null));
    plugin.start(flat());
    try {
      await settle();
      assert.equal(saved.length, 1);
      const lines = logged.mock.calls.map((call) => call.arguments.join(' '));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /could not be stored \(disk full\); this is tried again on the next start\./);
      const body = await status(routes);
      assert.equal(body.model, 'qwen3:4b');
      assert.equal(body.configuredNumCtx, 4096);

      // The server starts it again with what is on disk: still flat.
      fail = false;
      plugin.stop();
      plugin.start(flat());
      await settle();
      assert.equal(saved.length, 2);
      assert.deepEqual(saved[1], migrated());
    } finally {
      plugin.stop();
    }
  });

  it('stores nothing when the plugin stops before the move gets its turn', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { plugin, saved } = host();
    plugin.start(flat());
    plugin.stop();
    await settle();
    assert.equal(saved.length, 0);
  });

  it('makes the move on the restart options when it restarts while the move is being stored', async (t) => {
    t.mock.method(console, 'log', () => {});
    let restarted = false;
    let plugin;
    const restartOptions = { ...flat(), model: 'restarted' };
    const made = host((done) => {
      if (!restarted) {
        restarted = true;
        plugin.stop();
        plugin.start(restartOptions);
      }
      done(null);
    });
    plugin = made.plugin;
    plugin.start(flat());
    try {
      await settle();
      // The first copy, then the restart's options moved: disk ends with what the plugin runs.
      assert.equal(made.saved.length, 2);
      assert.deepEqual(made.saved[1], { ...migrated(), aiModel: { ...migrated().aiModel, model: 'restarted' } });
      assert.equal((await status(made.routes)).model, 'restarted');
    } finally {
      plugin.stop();
    }
  });
});

describe('the settings form for settings saved flat by an earlier version', () => {
  const { settingsSchema } = require('../lib/settings.cjs');
  const flat = () => ({
    enabled: false,
    baseUrl: 'http://gpu.local:11434',
    model: 'qwen3:4b',
    warmupOnStart: false,
    maxTokens: 1024,
    historyEnabled: true,
    historySamples: 20,
    numCtx: 4096,
    aiDataPaths: ['a.one']
  });

  /** A plugin that is never started, as Signal K keeps one that is off. */
  function offPlugin(readPluginOptions) {
    const saves = [];
    const app = {
      selfId: 'urn:mrn:signalk:uuid:test-self',
      getSelfPath: () => undefined,
      setPluginStatus: () => {},
      savePluginOptions: (stored, done) => {
        saves.push(stored);
        done(null);
      }
    };
    if (readPluginOptions !== undefined) app.readPluginOptions = readPluginOptions;
    return { plugin: createPlugin(app, {}), saves };
  }

  it('shows the stored values while the plugin is off, before any start has moved them', () => {
    const { plugin, saves } = offPlugin(() => ({ enabled: false, configuration: flat() }));
    const { properties } = plugin.schema();
    assert.equal(properties.aiModel.properties.baseUrl.default, 'http://gpu.local:11434');
    assert.equal(properties.aiModel.properties.model.default, 'qwen3:4b');
    assert.equal(properties.aiModel.properties.warmupOnStart.default, false);
    assert.equal(properties.answers.properties.maxTokens.default, 1024);
    assert.equal(properties.history.properties.historyEnabled.default, true);
    const [, on] = properties.history.dependencies.historyEnabled.oneOf;
    assert.equal(on.properties.historySamples.default, 20);
    assert.equal(properties.advanced.properties.numCtx.default, 4096);
    // Everything not stored flat keeps its usual default.
    const usual = settingsSchema().properties;
    assert.equal(properties.aiModel.properties.keepAlive.default, usual.aiModel.properties.keepAlive.default);
    assert.equal(properties.advanced.properties.numBatch.default, usual.advanced.properties.numBatch.default);
    // Asking for the form writes nothing.
    assert.deepEqual(saves, []);
    assert.deepEqual(JSON.parse(JSON.stringify(plugin.schema())), plugin.schema());
  });

  it('reads the stored options each time the form is asked for', () => {
    let configuration = flat();
    const { plugin } = offPlugin(() => ({ enabled: false, configuration }));
    assert.equal(plugin.schema().properties.aiModel.properties.model.default, 'qwen3:4b');
    // Saved from the form: in the sections now, so the form is the usual one.
    configuration = { aiModel: { model: 'qwen3:4b' } };
    assert.deepEqual(plugin.schema(), settingsSchema());
  });

  it('is the usual form when the stored options are in sections, empty or cannot be read', () => {
    const usual = settingsSchema();
    const hosts = {
      'in sections': () => ({ enabled: true, configuration: { aiModel: { model: 'qwen3:4b' }, advanced: { numCtx: 4096 } } }),
      'nothing stored': () => ({}),
      'empty configuration': () => ({ enabled: false, configuration: {} }),
      'returns nothing': () => undefined,
      'returns null': () => null,
      'returns a string': () => 'options',
      'configuration not an object': () => ({ configuration: 'flat' }),
      throws: () => {
        throw new Error('EACCES');
      },
      'not a function': 'readPluginOptions'
    };
    for (const [name, readPluginOptions] of Object.entries(hosts)) {
      const { plugin } = offPlugin(readPluginOptions);
      assert.deepEqual(plugin.schema(), usual, name);
    }
    // A host without readPluginOptions at all.
    assert.deepEqual(offPlugin().plugin.schema(), usual);
  });
});
