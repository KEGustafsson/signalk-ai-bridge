'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWatchService } = require('../lib/watch-service.cjs');
const createPlugin = require('../index.cjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function createHost({ dataDir } = {}) {
  const messages = [];
  const host = {
    selfId: 'vessels.urn:mrn:signalk:uuid:test',
    deltaCallback: undefined,
    subscribeCommand: undefined,
    unsubscribed: 0,
    messages,
    subscriptionmanager: {
      subscribe(command, unsubscribes, onError, onDelta) {
        host.subscribeCommand = command;
        host.deltaCallback = onDelta;
        unsubscribes.push(() => {
          host.unsubscribed += 1;
        });
      }
    },
    handleMessage(id, delta) {
      messages.push({ id, delta });
    },
    getSelfPath(selfPath) {
      if (selfPath === 'propulsion.main.temperature') {
        return { value: 353, meta: { units: 'K', displayName: 'Engine temp' } };
      }
      return undefined;
    },
    setPluginStatus() {}
  };
  if (dataDir) {
    host.getDataDirPath = () => dataDir;
  }
  return host;
}

function notificationsFor(host, notificationPath) {
  return host.messages
    .flatMap((message) => message.delta.updates.flatMap((update) => update.values))
    .filter((value) => value.path === notificationPath)
    .map((value) => value.value);
}

/** Feed a value every second and tick every five, on a virtual clock. */
function drive(host, service, clock, durationMs, valueAt) {
  const end = clock.t + durationMs;
  while (clock.t < end) {
    host.deltaCallback({
      context: 'vessels.self',
      updates: [{ $source: 'n2k.42', values: [{ path: 'propulsion.main.temperature', value: valueAt(clock.t) }] }]
    });
    clock.t += SECOND;
    if (clock.t % (5 * SECOND) === 0) {
      service.tick();
    }
  }
}

describe('watch service', () => {
  it('does nothing until enabled', () => {
    const host = createHost();
    const service = createWatchService(host, {});
    assert.equal(service.start({}), false);
    assert.equal(host.subscribeCommand, undefined);
    const status = service.status();
    assert.equal(status.enabled, false);
    assert.equal(status.usesLanguageModel, false);
  });

  it('subscribes to the self vessel and publishes findings as Signal K notifications', () => {
    const host = createHost();
    const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
    const service = createWatchService(host, { now: () => clock.t });
    assert.equal(service.start({ watchEnabled: true, watchLearningMinutes: 10 }), true);
    assert.deepEqual(host.subscribeCommand.subscribe[0].path, '*');
    assert.equal(host.subscribeCommand.context, 'vessels.self');

    let seed = 1;
    const jitter = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 0.4;
    };
    drive(host, service, clock, 30 * MINUTE, () => 353 + jitter());
    const notificationPath = 'notifications.aiBridge.watch.propulsion.main.temperature';
    assert.deepEqual(notificationsFor(host, notificationPath), []);

    drive(host, service, clock, MINUTE, () => 365 + jitter());
    const raised = notificationsFor(host, notificationPath);
    assert.equal(raised.length, 1);
    assert.equal(raised[0].state, 'alert');
    assert.deepEqual(raised[0].method, ['visual']);
    // The display name and units came from the path's own metadata.
    assert.match(raised[0].message, /^Engine temp unusually high: 9\d\.\d °C/);
    assert.equal(host.messages[0].id, 'signalk-ai-bridge');

    const status = service.status();
    assert.equal(status.running, true);
    assert.equal(status.activeFindings.length, 1);
    assert.equal(status.paths.watched, 1);

    service.stop();
    const cleared = notificationsFor(host, notificationPath);
    assert.equal(cleared[cleared.length - 1].state, 'normal');
    assert.equal(host.unsubscribed, 1);
  });

  it('keeps the learned baseline across a restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
    try {
      const host = createHost({ dataDir });
      const clock = { t: Date.parse('2026-06-01T08:00:00Z') };
      const service = createWatchService(host, { now: () => clock.t });
      service.start({ watchEnabled: true, watchLearningMinutes: 10 });
      drive(host, service, clock, 15 * MINUTE, () => 353);
      await service.saveState();
      service.stop();

      const again = createWatchService(createHost({ dataDir }), { now: () => clock.t });
      again.start({ watchEnabled: true });
      const status = again.status();
      assert.equal(status.restoredBaseline, true);
      assert.equal(status.paths.watched, 1);
      again.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('replays recorded history through a fresh watch', async () => {
    const host = createHost();
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - 6 * 60 * MINUTE;
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.includes('/history/paths')) {
        return new Response(JSON.stringify(['propulsion.main.temperature', 'navigation.headingTrue', 'notifications.x']), { status: 200 });
      }
      const data = [];
      for (let at = start; at <= end; at += 10 * SECOND) {
        const late = at > end - 30 * MINUTE;
        data.push([new Date(at).toISOString(), late ? 368 : 353 + ((at / 10000) % 3) * 0.05]);
      }
      return new Response(JSON.stringify({ values: [{ path: 'propulsion.main.temperature', method: 'average' }], data }), { status: 200 });
    };
    const service = createWatchService(host, { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    const result = await service.replay({ duration: 'PT6H' }, { historyTimeoutMs: 5000 });
    assert.equal(result.ok, true);
    // Heading is not watched on its own, but the GNSS check reads it for dead
    // reckoning; notifications are never replayed.
    assert.equal(result.pathsReplayed, 2);
    assert.ok(result.findingsOpened >= 1);
    assert.ok(result.byDetector.shift >= 1);
    assert.match(result.incidents[0].title, /temperature unusually high/);
    assert.ok(requests.some((url) => url.includes('/signalk/v2/api/history/values')));
    service.stop();
  });
});

describe('watch routes', () => {
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
      }
    };
  }

  function registerRoutes(plugin) {
    const routes = {};
    plugin.registerWithRouter({
      get(route, handler) {
        routes[`GET ${route}`] = handler;
      },
      post(route, handler) {
        routes[`POST ${route}`] = handler;
      }
    });
    return routes;
  }

  it('reports watch status, and refuses to mute without write access', async () => {
    const host = createHost();
    host.securityStrategy = { isDummy: () => false };
    const plugin = createPlugin(host, { fetchImpl: async () => new Response('{}', { status: 503 }) });
    const routes = registerRoutes(plugin);
    plugin.start({ watchEnabled: true, warmupOnStart: false });
    try {
      const status = recorder();
      await routes['GET /watch/status']({}, status);
      assert.equal(status.statusCode, 200);
      assert.equal(status.body.running, true);
      assert.equal(status.body.usesLanguageModel, false);

      const denied = recorder();
      await routes['POST /watch/mute']({ body: { path: 'propulsion.main.temperature' } }, denied);
      assert.equal(denied.statusCode, 401);

      const allowed = recorder();
      await routes['POST /watch/mute'](
        { body: { path: 'propulsion.main.temperature', minutes: 30 }, skPrincipal: { permissions: 'admin' } },
        allowed
      );
      assert.equal(allowed.statusCode, 200);
      assert.equal(allowed.body.mutes[0].path, 'propulsion.main.temperature');
    } finally {
      plugin.stop();
    }

    const stopped = recorder();
    await routes['GET /watch/status']({}, stopped);
    assert.equal(stopped.statusCode, 503);
  });
});
