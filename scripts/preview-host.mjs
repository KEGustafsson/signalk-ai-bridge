/**
 * Local host for the embedded panel.
 *
 * Mounts the real plugin routes (`/plugins/signalk-ai-bridge/...`) on a plain
 * Node HTTP server, backed by a stub Signal K app, so `npm run dev` can render
 * the panel against the actual backend code instead of a dead endpoint.
 *
 *   node scripts/preview-host.mjs            # proxy to a real Ollama
 *   node scripts/preview-host.mjs --stub     # also stub Ollama (no model needed)
 *   node scripts/preview-host.mjs --stub --watch-demo
 *                                            # also play a Watchkeeper scenario
 *
 * The panel reaches it through the Vite dev proxy; point that elsewhere with
 * SIGNALK_AI_BRIDGE_DEV_TARGET if you are running a real Signal K server.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createPlugin = require('../index.cjs');

const useStub = process.argv.includes('--stub');
const watchDemo = process.argv.includes('--watch-demo');
const previewPort = Number(process.env.PREVIEW_PORT || 3100);
const stubPort = Number(process.env.STUB_OLLAMA_PORT || 11534);
const ROUTE_PREFIX = '/plugins/signalk-ai-bridge';

const STUB_MODEL = 'gemma4:e2b';
const STUB_ANSWER = [
  '## Vessel state',
  '',
  '- Position: 60.1000 N, 24.9000 E',
  '- Speed over ground: 5.4 kn',
  '- Course over ground: 180.0 deg true',
  '',
  '## Needs attention',
  '',
  '- `notifications.navigation.anchor` is in the `alarm` state with the message',
  '  "Anchor drag detected". Confirm the anchor is holding before leaving the boat.',
  '',
  '## Summary',
  '',
  'The vessel is making way south at 5.4 knots with one active anchor alarm.',
  'Nothing else in the shared Signal K context needs operator action.'
].join('\n');

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  try {
    return raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function startStubOllama() {
  let residencyProbes = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      sendJson(res, 200, { models: [{ name: STUB_MODEL, details: { family: 'gemma4' } }] });
      return;
    }

    if (req.url === '/api/ps') {
      // The first probe reports a partial offload, so the preview exercises the
      // auto-tuner the same way an 8 GB Jetson would.
      residencyProbes += 1;
      const resident = residencyProbes > 1 ? 5_600_000_000 : 3_100_000_000;
      sendJson(res, 200, {
        models: [
          {
            name: STUB_MODEL,
            size: 5_600_000_000,
            size_vram: resident,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
          }
        ]
      });
      return;
    }

    if (req.url === '/api/generate') {
      sendJson(res, 200, { model: STUB_MODEL, done: true });
      return;
    }

    if (req.url === '/api/chat') {
      const finalFields = {
        prompt_eval_count: 412,
        eval_count: 168,
        prompt_eval_duration: 900_000_000,
        eval_duration: 4_600_000_000,
        load_duration: 12_000_000,
        total_duration: 5_600_000_000
      };

      readBody(req).then((body) => {
        if (!body.stream) {
          sendJson(res, 200, {
            model: STUB_MODEL,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: STUB_ANSWER },
            done: true,
            ...finalFields
          });
          return;
        }

        // Ollama streams NDJSON, one chunk per token-ish fragment. Splitting on
        // word boundaries (keeping the trailing space) mimics that closely
        // enough to exercise the client's reassembly.
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const fragments = STUB_ANSWER.match(/\S+\s*/g) ?? [STUB_ANSWER];
        let index = 0;

        const pump = () => {
          if (index >= fragments.length) {
            res.end(
              `${JSON.stringify({
                model: STUB_MODEL,
                created_at: new Date().toISOString(),
                message: { role: 'assistant', content: '' },
                done: true,
                ...finalFields
              })}\n`
            );
            return;
          }

          res.write(
            `${JSON.stringify({
              model: STUB_MODEL,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: fragments[index] },
              done: false
            })}\n`
          );
          index += 1;
          setTimeout(pump, 12);
        };

        pump();
      });
      return;
    }

    sendJson(res, 404, { error: `stub Ollama has no route for ${req.url}` });
  });

  return new Promise((resolve) => {
    server.listen(stubPort, '127.0.0.1', () => resolve(server));
  });
}

function createSignalKAppShim() {
  const selfTree = {
    navigation: {
      position: { latitude: 60.1, longitude: 24.9 },
      speedOverGround: 5.4,
      courseOverGroundTrue: Math.PI
    },
    notifications: {
      'navigation.anchor': { state: 'alarm', message: 'Anchor drag detected' }
    }
  };

  return {
    selfId: 'urn:mrn:signalk:uuid:preview-vessel',
    setPluginStatus: (message) => console.log(`[plugin status] ${message}`),
    setPluginError: (message) => console.error(`[plugin error] ${message}`),
    debug: () => {},
    error: (message) => console.error(message),
    getSelfPath: (path) =>
      String(path)
        .split('.')
        .reduce((value, segment) => (value && typeof value === 'object' ? value[segment] : undefined), selfTree)
  };
}

function collectRoutes(plugin) {
  const routes = new Map();
  const register = (method) => (path, handler) => {
    routes.set(`${method} ${path}`, handler);
    return router;
  };
  const router = {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    delete: register('DELETE'),
    patch: register('PATCH'),
    use: () => router
  };

  plugin.registerWithRouter(router);
  return routes;
}

function createResponseAdapter(res) {
  let statusCode = 200;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      sendJson(res, statusCode, payload);
      return this;
    },
    // The streaming route writes headers and NDJSON lines directly, so the
    // adapter has to expose the same surface Express gives it.
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    flushHeaders() {
      res.flushHeaders();
    },
    write(chunk) {
      return res.write(chunk);
    },
    end(chunk) {
      res.end(chunk);
    }
  };
}

/**
 * A Watchkeeper scenario for the preview: 45 minutes of a normal passage are
 * pre-rolled on a shifted clock so the watch has a learned baseline, then the
 * live part goes wrong - the alternator stops charging, the engine runs hot,
 * the engine-room sensor drops off the bus, and the GNSS fix starts walking
 * east of dead reckoning. Findings appear in the panel within half a minute.
 */
function createWatchDemo() {
  let offset = 0;
  let emit;
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  const now = () => Date.now() + offset;
  const subscriptionmanager = {
    subscribe(command, unsubscribes, onError, onDelta) {
      emit = onDelta;
      unsubscribes.push(() => {
        emit = undefined;
      });
    }
  };
  const knots = 0.514444;
  let latitude = 60.1;
  let longitude = 24.9;
  let liveStart;

  const sample = (t) => {
    const live = liveStart !== undefined && t >= liveStart + 5000;
    const sinceLive = live ? (t - liveStart) / 1000 : 0;
    latitude += (6 * knots) / 111195;
    const drift = live ? (sinceLive * 15 * knots) / (111195 * Math.cos((latitude * Math.PI) / 180)) : 0;
    const values = [
      { path: 'propulsion.main.revolutions', value: 30 + 0.3 * rand() },
      { path: 'propulsion.main.temperature', value: (live ? 366 : 353.2) + 0.2 * rand() },
      { path: 'electrical.batteries.house.voltage', value: (live ? 12.5 : 13.9) + 0.02 * rand() },
      { path: 'electrical.batteries.house.current', value: (live ? -8 : 25) + rand() },
      { path: 'tanks.freshWater.main.currentLevel', value: 0.62 },
      { path: 'environment.outside.pressure', value: 101300 + 5 * rand() },
      { path: 'navigation.position', value: { latitude, longitude: longitude + drift } },
      { path: 'navigation.headingTrue', value: 0.002 * rand() },
      { path: 'navigation.speedThroughWater', value: 6 * knots + 0.05 * rand() },
      { path: 'navigation.gnss.satellites', value: 11 },
      { path: 'navigation.gnss.horizontalDilution', value: 0.8 }
    ];
    if (!live) {
      values.push({ path: 'environment.inside.engineRoom.temperature', value: 318 + 0.3 * rand() });
    }
    if (emit) {
      emit({ context: 'vessels.self', updates: [{ $source: 'demo.n2k', values }] });
    }
  };

  const run = () => {
    const prerollSeconds = 45 * 60;
    for (let i = prerollSeconds; i > 0; i -= 1) {
      offset = -i * 1000;
      sample(now());
    }
    offset = 0;
    liveStart = now();
    setInterval(() => sample(now()), 1000).unref();
    console.log('Watch demo: baseline learned; trouble starts in 5 s.');
  };

  return { now, subscriptionmanager, run };
}

async function main() {
  const baseUrl = useStub ? `http://127.0.0.1:${stubPort}` : undefined;
  if (useStub) {
    await startStubOllama();
    console.log(`Stub Ollama listening on ${baseUrl}`);
  }

  const demo = watchDemo ? createWatchDemo() : undefined;
  const shim = createSignalKAppShim();
  if (demo) {
    shim.subscriptionmanager = demo.subscriptionmanager;
  }
  const plugin = createPlugin(shim, demo ? { now: demo.now } : {});
  plugin.start({
    ...(baseUrl ? { baseUrl, model: STUB_MODEL } : {}),
    numCtx: 8192,
    keepAlive: '30m',
    ...(demo ? { watchEnabled: true, watchLearningMinutes: 20 } : {})
  });
  if (demo) {
    demo.run();
  }

  const routes = collectRoutes(plugin);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${previewPort}`);
    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      sendJson(res, 404, { error: { code: 'unknown', message: 'Not a plugin route.' } });
      return;
    }

    const handler = routes.get(`${req.method} ${url.pathname.slice(ROUTE_PREFIX.length)}`);
    if (!handler) {
      sendJson(res, 404, { error: { code: 'unknown', message: `No route for ${req.url}` } });
      return;
    }

    Promise.resolve(handler(req, createResponseAdapter(res))).catch((error) => {
      sendJson(res, 500, { error: { code: 'unknown', message: String(error) } });
    });
  });

  server.listen(previewPort, '127.0.0.1', () => {
    console.log(`Plugin preview host listening on http://127.0.0.1:${previewPort}${ROUTE_PREFIX}`);
    console.log('Run "npm run dev" in another shell, with');
    console.log(`  SIGNALK_AI_BRIDGE_DEV_TARGET=http://127.0.0.1:${previewPort}`);
  });

  const shutdown = () => {
    plugin.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
