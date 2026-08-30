'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('../index.cjs');
const {
  authHeadersFromRequest,
  buildValuesUrl,
  collectHistoryContext,
  normalizeHistoryConfig,
  parseDurationSeconds,
  resolveHistoryBaseUrl,
  resolveHistoryPaths,
  resolveWindow,
  summarizeHistoryPayload
} = require('../lib/history-service.cjs');
const { buildAiMessages } = require('../lib/ai-service.cjs');

function historyConfig(overrides = {}) {
  return {
    ...normalizeHistoryConfig({ historyEnabled: true, ...overrides }, {}),
    aiDataPaths: overrides.aiDataPaths || []
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** A History API stub that records the request and answers with `payload`. */
function historyFetch(payload, { status = 200, calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse(payload, status);
  };
}

const SAMPLE_PAYLOAD = {
  context: 'vessels.urn:mrn:signalk:uuid:test-self',
  range: { from: '2026-04-11T09:00:00.000Z', to: '2026-04-11T10:00:00.000Z' },
  values: [
    { path: 'navigation.speedOverGround', method: 'average' },
    { path: 'navigation.courseOverGroundTrue', method: 'average' }
  ],
  data: [
    ['2026-04-11T09:00:00.000Z', 4, 0],
    ['2026-04-11T09:30:00.000Z', 6, Math.PI],
    ['2026-04-11T10:00:00.000Z', 5, null]
  ]
};

describe('history duration parsing', () => {
  it('reads ISO 8601 durations, shorthand and plain seconds', () => {
    assert.equal(parseDurationSeconds('PT15M'), 900);
    assert.equal(parseDurationSeconds('PT1H30M'), 5400);
    assert.equal(parseDurationSeconds('P1DT2H'), 93600);
    assert.equal(parseDurationSeconds('P2W'), 1209600);
    assert.equal(parseDurationSeconds('30m'), 1800);
    assert.equal(parseDurationSeconds('2h'), 7200);
    assert.equal(parseDurationSeconds('900'), 900);
    assert.equal(parseDurationSeconds(900), 900);
  });

  // A month is 28 to 31 days long, so PT1M-style precision is not available for
  // it. Reading it as "some number of seconds" would give the operator a window
  // that quietly changes length in February.
  it('rejects what it cannot read exactly', () => {
    assert.equal(parseDurationSeconds('P1Y'), undefined);
    assert.equal(parseDurationSeconds('P3M'), undefined);
    assert.equal(parseDurationSeconds('P'), undefined);
    assert.equal(parseDurationSeconds('PT'), undefined);
    assert.equal(parseDurationSeconds('last week'), undefined);
    assert.equal(parseDurationSeconds(''), undefined);
    assert.equal(parseDurationSeconds(0), undefined);
    assert.equal(parseDurationSeconds(-60), undefined);
  });
});

describe('history configuration', () => {
  it('defaults to off, with a one-hour window', () => {
    const config = normalizeHistoryConfig({}, {});
    assert.equal(config.historyEnabled, false);
    assert.equal(config.historyDuration, 'PT1H');
    assert.equal(config.historyDurationSeconds, 3600);
    assert.equal(config.historySamples, 12);
    assert.deepEqual(config.historyPaths, []);
  });

  it('drops wildcards and caps the path list', () => {
    const config = normalizeHistoryConfig({
      historyPaths: [
        'navigation.*',
        ' navigation.speedOverGround:average ',
        'navigation.speedOverGround:average',
        ...Array.from({ length: 20 }, (unused, index) => `electrical.batteries.${index}.voltage`)
      ]
    }, {});

    assert.ok(!config.historyPaths.includes('navigation.*'));
    assert.equal(config.historyPaths[0], 'navigation.speedOverGround:average');
    // The duplicate is dropped, so the cap is the only thing bounding the rest.
    assert.equal(config.historyPaths.length, 12);
  });

  it('falls back to an unreadable window rather than sending one', () => {
    const config = normalizeHistoryConfig({ historyDuration: 'yesterday' }, {});
    assert.equal(config.historyDuration, 'PT1H');
    assert.equal(config.historyDurationSeconds, 3600);
  });

  // A single point is not a series, and the live snapshot in the same prompt
  // already carries the newest value - so the floor is two, which is also what
  // "the samples always include both ends of the window" needs to be true.
  it('clamps the sample budget, and keeps room for both ends', () => {
    assert.equal(normalizeHistoryConfig({ historySamples: 0 }, {}).historySamples, 2);
    assert.equal(normalizeHistoryConfig({ historySamples: 1 }, {}).historySamples, 2);
    assert.equal(normalizeHistoryConfig({ historySamples: 100000 }, {}).historySamples, 200);
  });

  it('reuses the exact live paths when no history paths are configured', () => {
    const config = historyConfig({
      aiDataPaths: ['navigation.*', 'navigation.speedOverGround', 'notifications']
    });

    assert.deepEqual(resolveHistoryPaths(config), ['navigation.speedOverGround', 'notifications']);
  });
});

describe('history endpoint resolution', () => {
  it('calls this server on localhost, honouring its port and TLS setting', () => {
    assert.equal(
      resolveHistoryBaseUrl({ config: { settings: { port: 3001 } } }, historyConfig()),
      'http://localhost:3001'
    );
    assert.equal(
      resolveHistoryBaseUrl({ config: { settings: { port: 443, ssl: true } } }, historyConfig()),
      'https://localhost:443'
    );
    assert.equal(resolveHistoryBaseUrl({}, historyConfig()), 'http://localhost:3000');
  });

  it('accepts a configured URL with the API path already on it', () => {
    assert.equal(
      resolveHistoryBaseUrl({}, historyConfig({
        historyServerUrl: 'http://nas.local:3000/signalk/v2/api/history/values/'
      })),
      'http://nas.local:3000'
    );
  });

  it('derives a resolution from the window and the sample budget', () => {
    const window = resolveWindow(historyConfig({ historyDuration: 'PT1H', historySamples: 12 }));
    assert.equal(window.durationSeconds, 3600);
    assert.equal(window.resolutionSeconds, 300);
    assert.equal(new Date(window.to) - new Date(window.from), 3600 * 1000);
  });

  it('prefers an explicit resolution', () => {
    const window = resolveWindow(historyConfig({ historyDuration: 'PT1H', historyResolution: '1m' }));
    assert.equal(window.resolutionSeconds, 60);
  });

  it('builds a values request with the documented parameters', () => {
    const config = historyConfig({ historyProvider: 'signalk-parquet' });
    const window = resolveWindow(config);
    const url = new URL(buildValuesUrl('http://localhost:3000', ['a:average', 'b'], window, config));

    assert.equal(url.pathname, '/signalk/v2/api/history/values');
    assert.equal(url.searchParams.get('paths'), 'a:average,b');
    assert.equal(url.searchParams.get('from'), window.from);
    assert.equal(url.searchParams.get('to'), window.to);
    assert.equal(url.searchParams.get('resolution'), String(window.resolutionSeconds));
    assert.equal(url.searchParams.get('provider'), 'signalk-parquet');
  });
});

describe('history payload summary', () => {
  it('summarizes each column and converts angles to degrees', () => {
    const { series } = summarizeHistoryPayload(
      SAMPLE_PAYLOAD,
      ['navigation.speedOverGround', 'navigation.courseOverGroundTrue'],
      12
    );

    const speed = series['navigation.speedOverGround'];
    assert.equal(speed.method, 'average');
    assert.equal(speed.count, 3);
    assert.equal(speed.min, 4);
    assert.equal(speed.max, 6);
    assert.equal(speed.first, 4);
    assert.equal(speed.last, 5);
    assert.equal(speed.average, 5);
    assert.deepEqual(speed.samples[0], ['2026-04-11T09:00:00.000Z', 4]);

    // Signal K carries the course in radians; the live snapshot in the same
    // prompt is in degrees, and a series that disagreed with it would read as
    // a hard turn that never happened.
    const course = series['navigation.courseOverGroundTrue'];
    assert.equal(course.max, 180);
    // The null third row is a gap in the data, not a value.
    assert.equal(course.count, 2);
  });

  it('reports paths the provider returned nothing for', () => {
    const { series, unavailablePaths } = summarizeHistoryPayload(
      {
        values: [{ path: 'environment.wind.speedApparent', method: 'average' }],
        data: [['2026-04-11T09:00:00.000Z', null]]
      },
      ['environment.wind.speedApparent', 'environment.water.temperature'],
      12
    );

    assert.deepEqual(series, {});
    assert.deepEqual(unavailablePaths.sort(), [
      'environment.water.temperature',
      'environment.wind.speedApparent'
    ]);
  });

  it('keeps the ends of the window when down-sampling', () => {
    const data = Array.from({ length: 100 }, (unused, index) => [
      new Date(Date.UTC(2026, 3, 11, 9, index)).toISOString(),
      index
    ]);
    const { series } = summarizeHistoryPayload(
      { values: [{ path: 'electrical.batteries.house.voltage' }], data },
      ['electrical.batteries.house.voltage'],
      5
    );

    const summary = series['electrical.batteries.house.voltage'];
    assert.equal(summary.count, 100);
    assert.equal(summary.samples.length, 5);
    assert.equal(summary.samples[0][1], 0);
    assert.equal(summary.samples[4][1], 99);
    assert.equal(summary.min, 0);
    assert.equal(summary.max, 99);
  });

  // Min and max of the wind over the same window is a legitimate pair to ask
  // for, and keying on the path alone let the second column overwrite the first.
  it('keeps two aggregations of the same path apart', () => {
    const { series } = summarizeHistoryPayload(
      {
        values: [
          { path: 'environment.wind.speedApparent', method: 'min' },
          { path: 'environment.wind.speedApparent', method: 'max' }
        ],
        data: [['2026-04-11T09:00:00.000Z', 3, 9], ['2026-04-11T09:05:00.000Z', 4, 11]]
      },
      ['environment.wind.speedApparent:min', 'environment.wind.speedApparent:max'],
      12
    );

    assert.deepEqual(Object.keys(series), [
      'environment.wind.speedApparent:min',
      'environment.wind.speedApparent:max'
    ]);
    assert.equal(series['environment.wind.speedApparent:min'].last, 4);
    assert.equal(series['environment.wind.speedApparent:max'].last, 11);
  });

  // The ordinary case keeps the plain path, so a series is keyed exactly like
  // its live counterpart in the same prompt.
  it('keys an unambiguous series by its path alone', () => {
    const { series } = summarizeHistoryPayload(
      {
        values: [{ path: 'environment.wind.speedApparent', method: 'average' }],
        data: [['2026-04-11T09:00:00.000Z', 7]]
      },
      ['environment.wind.speedApparent:average'],
      12
    );

    assert.deepEqual(Object.keys(series), ['environment.wind.speedApparent']);
  });

  it('reads a provider that omits the values header', () => {
    const { series } = summarizeHistoryPayload(
      { data: [['2026-04-11T09:00:00.000Z', 12.6]] },
      ['electrical.batteries.house.voltage'],
      12
    );

    assert.equal(series['electrical.batteries.house.voltage'].last, 12.6);
  });
});

describe('collectHistoryContext', () => {
  it('returns nothing at all when history is switched off', async () => {
    const config = { ...normalizeHistoryConfig({}, {}), aiDataPaths: ['navigation.position'] };
    assert.equal(await collectHistoryContext({}, config, { fetchImpl: () => assert.fail('no request expected') }), undefined);
  });

  it('reads the configured window and forwards the operator credentials', async () => {
    const calls = [];
    const config = historyConfig({
      historyPaths: ['navigation.speedOverGround:average', 'navigation.courseOverGroundTrue'],
      historyDuration: 'PT1H',
      historySamples: 3
    });

    const history = await collectHistoryContext(
      { config: { settings: { port: 3000 } } },
      config,
      { fetchImpl: historyFetch(SAMPLE_PAYLOAD, { calls }) },
      { authHeaders: { cookie: 'JAUTHENTICATION=token' } }
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^http:\/\/localhost:3000\/signalk\/v2\/api\/history\/values\?/);
    // The plugin has no session of its own: the history read runs with exactly
    // the access the operator who asked the question already has.
    assert.equal(calls[0].init.headers.cookie, 'JAUTHENTICATION=token');
    assert.equal(history.message, undefined);
    assert.equal(history.context, 'vessels.urn:mrn:signalk:uuid:test-self');
    assert.equal(history.resolutionSeconds, 1200);
    assert.equal(history.series['navigation.speedOverGround'].average, 5);
    assert.deepEqual(history.requestedPaths, [
      'navigation.speedOverGround:average',
      'navigation.courseOverGroundTrue'
    ]);
  });

  // A cookie minted by this server is replayable against another Signal K
  // instance, so it must never leave this machine.
  it('sends the operator session to a loopback server only', async () => {
    const calls = [];
    await collectHistoryContext(
      {},
      historyConfig({
        historyPaths: ['navigation.speedOverGround'],
        historyServerUrl: 'https://other-boat.example'
      }),
      { fetchImpl: historyFetch(SAMPLE_PAYLOAD, { calls }) },
      { authHeaders: { cookie: 'JAUTHENTICATION=token', authorization: 'Bearer local-session' } }
    );

    assert.match(calls[0].url, /^https:\/\/other-boat\.example\//);
    assert.equal(calls[0].init.headers.cookie, undefined);
    assert.equal(calls[0].init.headers.authorization, undefined);
  });

  it('gives a remote history server its own credential', async () => {
    const calls = [];
    await collectHistoryContext(
      {},
      historyConfig({
        historyPaths: ['navigation.speedOverGround'],
        historyServerUrl: 'https://other-boat.example',
        historyApiKey: 'remote-token'
      }),
      { fetchImpl: historyFetch(SAMPLE_PAYLOAD, { calls }) },
      { authHeaders: { cookie: 'JAUTHENTICATION=token' } }
    );

    assert.equal(calls[0].init.headers.authorization, 'Bearer remote-token');
    assert.equal(calls[0].init.headers.cookie, undefined);
  });

  it('says what a remote server that rejects the request needs', async () => {
    const history = await collectHistoryContext(
      {},
      historyConfig({
        historyPaths: ['navigation.speedOverGround'],
        historyServerUrl: 'https://other-boat.example'
      }),
      { fetchImpl: async () => new Response('Unauthorized', { status: 401 }) }
    );

    assert.match(history.message, /History API key/i);
  });

  // The only header field a provider controls the length of, and it is counted
  // against the prompt budget it shares with the series it labels.
  it('caps the context label a provider returns', async () => {
    const history = await collectHistoryContext(
      {},
      historyConfig({ historyPaths: ['navigation.speedOverGround'] }),
      {
        fetchImpl: historyFetch({ ...SAMPLE_PAYLOAD, context: 'vessels.'.padEnd(5000, 'x') })
      }
    );

    assert.ok(history.context.length <= 120, `context was ${history.context.length} characters`);
  });

  it('explains a missing history provider instead of failing the question', async () => {
    const history = await collectHistoryContext(
      {},
      historyConfig({ historyPaths: ['navigation.speedOverGround'] }),
      { fetchImpl: async () => new Response('Not found', { status: 404 }) }
    );

    assert.match(history.message, /no history provider/i);
    assert.equal(history.series, undefined);
  });

  it('reports an unreachable server rather than throwing', async () => {
    const history = await collectHistoryContext(
      {},
      historyConfig({ historyPaths: ['navigation.speedOverGround'] }),
      {
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
        }
      }
    );

    assert.match(history.message, /unreachable/i);
    assert.match(history.message, /ECONNREFUSED/);
  });

  it('bounds the request with its own short timeout', async () => {
    const history = await collectHistoryContext(
      {},
      historyConfig({ historyPaths: ['navigation.speedOverGround'], historyTimeoutMs: 20 }),
      {
        // A ref'd timer, because the abort timer inside createTimedFetch is
        // unref'd on purpose: with nothing else holding the event loop open,
        // a test that waits only on that timer never sees it fire.
        fetchImpl: (url, init = {}) =>
          new Promise((resolve, reject) => {
            const slow = setTimeout(() => resolve(jsonResponse({ data: [] })), 500);
            init.signal.addEventListener('abort', () => {
              clearTimeout(slow);
              reject(init.signal.reason || new Error('The operation was aborted'));
            });
          })
      }
    );

    assert.match(history.message, /timed out after 20 ms/i);
  });

  it('does not read history for a disabled AI pipeline', async () => {
    const config = { ...historyConfig({ historyPaths: ['navigation.speedOverGround'] }), enabled: false };
    assert.equal(
      await collectHistoryContext({}, config, { fetchImpl: () => assert.fail('no request expected') }),
      undefined
    );
  });

  it('says so when history is on but there is nothing to ask for', async () => {
    const history = await collectHistoryContext({}, historyConfig({ aiDataPaths: ['navigation.*'] }), {
      fetchImpl: () => assert.fail('no request expected')
    });

    assert.match(history.message, /no history paths are configured/i);
  });
});

describe('history in the prompt', () => {
  it('explains the sample shape only when there is history', () => {
    const config = { systemPrompt: 'system' };
    const withHistory = buildAiMessages('How is the wind?', {
      selectedData: { 'environment.wind.speedApparent': 8 },
      history: {
        from: '2026-04-11T09:00:00.000Z',
        to: '2026-04-11T10:00:00.000Z',
        resolutionSeconds: 300,
        series: {
          'environment.wind.speedApparent': { count: 2, min: 6, max: 8, average: 7, samples: [['t', 6], ['t2', 8]] }
        }
      }
    }, config);

    assert.match(withHistory[1].content, /"history"/);
    assert.match(withHistory[1].content, /\[ISO timestamp, value\] pairs, oldest first/);

    const withoutHistory = buildAiMessages('How is the wind?', {
      selectedData: { 'environment.wind.speedApparent': 8 }
    }, config);
    assert.doesNotMatch(withoutHistory[1].content, /ISO timestamp/);
  });

  it('drops samples before series, and says which, when history will not fit', () => {
    const bigSeries = (seed) => ({
      count: 400,
      min: seed,
      max: seed + 1,
      average: seed,
      samples: Array.from({ length: 200 }, (unused, index) => [
        new Date(Date.UTC(2026, 3, 11, 9, index)).toISOString(),
        seed + index
      ])
    });

    const messages = buildAiMessages('Trend?', {
      selectedData: {},
      history: {
        from: '2026-04-11T09:00:00.000Z',
        to: '2026-04-11T10:00:00.000Z',
        resolutionSeconds: 60,
        series: Object.fromEntries(
          Array.from({ length: 12 }, (unused, index) => [`electrical.batteries.${index}.voltage`, bigSeries(index)])
        )
      }
    }, { systemPrompt: 'system' });

    const content = messages[1].content;
    // The statistics survive for far more series than the raw samples do, which
    // is the point: "is it rising?" is answerable from min/max/first/last.
    assert.match(content, /reduced to summary statistics|further series omitted/);
    assert.match(content, /electrical\.batteries\.0\.voltage/);
    assert.ok(content.length < 20000, `prompt was ${content.length} characters`);
  });
});

describe('request credentials', () => {
  it('forwards a cookie or bearer token, and nothing else', () => {
    assert.deepEqual(
      authHeadersFromRequest({
        headers: {
          authorization: 'Bearer abc',
          cookie: 'JAUTHENTICATION=token',
          'user-agent': 'panel',
          host: 'boat.local'
        }
      }),
      { authorization: 'Bearer abc', cookie: 'JAUTHENTICATION=token' }
    );

    assert.deepEqual(authHeadersFromRequest(undefined), {});
    assert.deepEqual(authHeadersFromRequest({}), {});
  });
});

describe('the plugin with history enabled', () => {
  function createHost() {
    return {
      selfId: 'urn:mrn:signalk:uuid:test-self',
      config: { settings: { port: 3000 } },
      setPluginStatus: () => {},
      getSelfPath: (path) => (path === 'navigation.speedOverGround' ? 5.4 : undefined)
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

  it('puts historical series in the context of an answered question', async () => {
    const calls = [];
    const plugin = createPlugin(createHost(), {
      fetchImpl: historyFetch(SAMPLE_PAYLOAD, { calls }),
      ollamaClient: {
        chat: async () => ({
          model: 'gemma4:e2b',
          created_at: '2026-04-11T10:00:00.000Z',
          message: { role: 'assistant', content: 'The vessel has been holding five knots.' },
          done: true
        })
      }
    });

    plugin.start({
      warmupOnStart: false,
      aiDataPaths: ['navigation.speedOverGround'],
      historyEnabled: true,
      historyPaths: ['navigation.speedOverGround:average', 'navigation.courseOverGroundTrue'],
      historyDuration: 'PT1H',
      historySamples: 3
    });

    const routes = registerRoutes(plugin);
    const response = createResponseRecorder();
    await routes['POST /bridge/execute'](
      {
        headers: { cookie: 'JAUTHENTICATION=token' },
        body: { toolId: 'ask-vessel-ai', prompt: 'How has our speed been?' }
      },
      response
    );

    const historyCalls = () => calls.filter((call) => call.url.includes('/signalk/v2/api/history'));

    assert.equal(response.statusCode, 200);
    assert.equal(historyCalls().length, 1);
    assert.equal(response.body.context.history.series['navigation.speedOverGround'].average, 5);
    assert.match(response.body.requestMessages[1].content, /"history"/);

    // The status route reports the outcome of that read without making one of
    // its own - the panel polls it on every render pass.
    const statusResponse = createResponseRecorder();
    await routes['GET /ai/status']({}, statusResponse);
    assert.equal(historyCalls().length, 1);
    assert.equal(statusResponse.body.history.enabled, true);
    assert.equal(statusResponse.body.history.resolutionSeconds, 1200);
    assert.equal(statusResponse.body.history.serverUrl, 'http://localhost:3000');
    assert.equal(statusResponse.body.history.lastFetch.ok, true);
    assert.equal(statusResponse.body.history.lastFetch.seriesCount, 2);

    plugin.stop();
  });

  it('still answers when the History API is down', async () => {
    const plugin = createPlugin(createHost(), {
      fetchImpl: async (url) => {
        if (String(url).includes('/signalk/v2/api/history')) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
        }
        return jsonResponse({ models: [] });
      },
      ollamaClient: {
        chat: async () => ({
          model: 'gemma4:e2b',
          created_at: '2026-04-11T10:00:00.000Z',
          message: { role: 'assistant', content: 'Answering from live data alone.' },
          done: true
        })
      }
    });

    plugin.start({
      warmupOnStart: false,
      aiDataPaths: ['navigation.speedOverGround'],
      historyEnabled: true,
      historyPaths: ['navigation.speedOverGround']
    });

    const routes = registerRoutes(plugin);
    const response = createResponseRecorder();
    await routes['POST /bridge/execute'](
      { body: { toolId: 'ask-vessel-ai', prompt: 'How has our speed been?' } },
      response
    );

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.type, 'ask-vessel-ai-result');
    assert.match(response.body.context.history.message, /unreachable/i);
    // The model is told the history is missing rather than left to assume the
    // absence of a trend means there was none.
    assert.match(response.body.requestMessages[1].content, /unreachable/i);

    plugin.stop();
  });

  it('asks for no history at all when the setting is off', async () => {
    const plugin = createPlugin(createHost(), {
      fetchImpl: async (url) => {
        assert.ok(!String(url).includes('/history'), `unexpected history request: ${url}`);
        return jsonResponse({ models: [] });
      },
      ollamaClient: {
        chat: async () => ({
          model: 'gemma4:e2b',
          created_at: '2026-04-11T10:00:00.000Z',
          message: { role: 'assistant', content: 'Five knots.' },
          done: true
        })
      }
    });

    plugin.start({ warmupOnStart: false, aiDataPaths: ['navigation.speedOverGround'] });

    const routes = registerRoutes(plugin);
    const response = createResponseRecorder();
    await routes['POST /bridge/execute'](
      { body: { toolId: 'ask-vessel-ai', prompt: 'How fast are we going?' } },
      response
    );

    assert.equal(response.body.context.history, undefined);

    const statusResponse = createResponseRecorder();
    await routes['GET /ai/status']({}, statusResponse);
    assert.equal(statusResponse.body.history.enabled, false);
    assert.equal(statusResponse.body.history.lastFetch, undefined);

    plugin.stop();
  });
});
