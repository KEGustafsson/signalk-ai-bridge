/**
 * Local host for the embedded panel.
 *
 * Mounts the real plugin routes (`/plugins/signalk-ai-bridge/...`) on a plain
 * Node HTTP server, backed by a stub Signal K app, so `npm run dev` can render
 * the panel against the actual backend code instead of a dead endpoint.
 *
 *   node scripts/preview-host.mjs            # proxy to a real Ollama
 *   node scripts/preview-host.mjs --stub     # also stub Ollama (no model needed)
 *
 * The panel reaches it through the Vite dev proxy; point that elsewhere with
 * SIGNALK_AI_BRIDGE_DEV_TARGET if you are running a real Signal K server.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createPlugin = require('../index.cjs');

const useStub = process.argv.includes('--stub');
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

async function main() {
  const baseUrl = useStub ? `http://127.0.0.1:${stubPort}` : undefined;
  if (useStub) {
    await startStubOllama();
    console.log(`Stub Ollama listening on ${baseUrl}`);
  }

  const plugin = createPlugin(createSignalKAppShim());
  plugin.start({
    ...(baseUrl ? { baseUrl, model: STUB_MODEL } : {}),
    numCtx: 8192,
    keepAlive: '30m'
  });

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
