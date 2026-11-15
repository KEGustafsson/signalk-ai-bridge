'use strict';

// The stored path selections: their priority order, moves within it, and the
// one queue every write to the plugin's options goes through.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('../index.cjs');
const { MAX_HISTORY_PATHS } = require('../lib/history-service.cjs');

function createHost() {
  return {
    selfId: 'vessels.urn:mrn:signalk:uuid:test',
    getSelfPath() {
      return undefined;
    },
    setPluginStatus() {}
  };
}

describe('path priority order', () => {
  function routesFor(host) {
    const plugin = createPlugin(host, { fetchImpl: async () => new Response('{}', { status: 503 }) });
    const routes = {};
    plugin.registerWithRouter({
      get(route, handler) {
        routes[`GET ${route}`] = handler;
      },
      post(route, handler) {
        routes[`POST ${route}`] = handler;
      }
    });
    return { plugin, routes };
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
      }
    };
  }

  it('moves one path in the stored selection, on the server, and answers with the new order', async () => {
    const host = createHost();
    host.savePluginOptions = (options, done) => {
      host.saved = options;
      done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two', 'c.three', 'a.one'] });
    try {
      const status = recorder();
      await routes['GET /ai/status']({}, status);
      assert.deepEqual(status.body.aiDataPaths, ['a.one', 'b.two', 'c.three'], 'stored repeats are shown once');
      assert.equal(status.body.history.derived, true);

      const moved = recorder();
      await routes['POST /paths/move']({ body: { kind: 'live', path: 'c.three', delta: -1 } }, moved);
      assert.equal(moved.statusCode, 200);
      assert.deepEqual(moved.body.aiDataPaths, ['a.one', 'c.three', 'b.two']);
      // Only the order changes: the stored repeat stays where it was.
      assert.deepEqual(host.saved.aiDataPaths, ['a.one', 'c.three', 'b.two', 'a.one']);

      // History reusing the live list has nothing of its own to reorder.
      const derived = recorder();
      await routes['POST /paths/move']({ body: { kind: 'history', path: 'a.one', delta: 1 } }, derived);
      assert.equal(derived.statusCode, 409);
      assert.equal(host.saved.historyPaths, undefined, 'the derived history list was not frozen into a stored one');

      const gone = recorder();
      await routes['POST /paths/move']({ body: { kind: 'live', path: 'z.missing', delta: 1 } }, gone);
      assert.equal(gone.statusCode, 409);
    } finally {
      plugin.stop();
    }
  });

  it('moves a history path within the stored list, leaving what the shown list drops untouched', async () => {
    const host = createHost();
    host.savePluginOptions = (options, done) => {
      host.saved = options;
      done();
    };
    const { plugin, routes } = routesFor(host);
    // Past the cap, so the tail is stored but not shown.
    const tail = Array.from({ length: MAX_HISTORY_PATHS }, (_, index) => `tail.p${index}`);
    const stored = [' b.two ', 'navigation.*', '', 'a.one', 'b.two', 'c.three:average', ...tail];
    plugin.start({ warmupOnStart: false, historyPaths: stored });
    try {
      const moved = recorder();
      await routes['POST /paths/move']({ body: { kind: 'history', path: 'a.one', delta: -1 } }, moved);
      assert.equal(moved.statusCode, 200);
      assert.deepEqual(moved.body.history.paths.slice(0, 3), ['a.one', 'b.two', 'c.three:average']);
      // The two raw entries swap places; the wildcard, the blank, the repeat,
      // the spacing and the entries past the cap are all still stored as they were.
      assert.deepEqual(host.saved.historyPaths, ['a.one', 'navigation.*', '', ' b.two ', 'b.two', 'c.three:average', ...tail]);
    } finally {
      plugin.stop();
    }
  });

  it('writes nothing for a move that changes nothing, even on a host that cannot store settings', async () => {
    const host = createHost();
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two'] });
    try {
      const atEnd = recorder();
      await routes['POST /paths/move']({ body: { kind: 'live', path: 'b.two', delta: 1 } }, atEnd);
      assert.equal(atEnd.statusCode, 200, 'already last is a no-op, not a 501');
      assert.deepEqual(atEnd.body.aiDataPaths, ['a.one', 'b.two']);

      const gone = recorder();
      await routes['POST /paths/move']({ body: { kind: 'live', path: 'z.missing', delta: -1 } }, gone);
      assert.equal(gone.statusCode, 409);

      const derived = recorder();
      await routes['POST /paths/move']({ body: { kind: 'history', path: 'a.one', delta: 1 } }, derived);
      assert.equal(derived.statusCode, 409);
    } finally {
      plugin.stop();
    }

    const counting = createHost();
    let writes = 0;
    counting.savePluginOptions = (options, done) => {
      writes += 1;
      done();
    };
    const second = routesFor(counting);
    second.plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two'] });
    try {
      await second.routes['POST /paths/move']({ body: { kind: 'live', path: 'a.one', delta: -1 } }, recorder());
      await second.routes['POST /paths/move']({ body: { kind: 'live', path: 'z.missing', delta: 1 } }, recorder());
      await second.routes['POST /paths/move']({ body: { kind: 'history', path: 'a.one', delta: 1 } }, recorder());
      assert.equal(writes, 0, 'no-op moves do not rewrite the stored settings');
    } finally {
      second.plugin.stop();
    }
  });

  it('puts the restart\'s options back on disk when a redone change has nothing left to do', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, model: 'old-model', aiDataPaths: ['a.one', 'b.two'] });
    try {
      const reply = recorder();
      const moving = routes['POST /paths/move']({ body: { kind: 'live', path: 'b.two', delta: -1 } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      plugin.stop();
      // The restart's list no longer has b.two: the redone move finds nothing.
      plugin.start({ warmupOnStart: false, model: 'new-model', aiDataPaths: ['a.one', 'c.three'] });
      finish();
      await moving;
      const last = saves[saves.length - 1];
      assert.equal(last.model, 'new-model', 'disk holds the restart\'s options, not the older copy');
      assert.deepEqual(last.aiDataPaths, ['a.one', 'c.three']);
    } finally {
      plugin.stop();
    }
  });

  it('ends with the newest options on disk after two restarts during one save', async () => {
    const host = createHost();
    const pending = [];
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      pending.push(done);
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, model: 'm1', aiDataPaths: ['a.one', 'b.two'] });
    try {
      const moving = routes['POST /paths/move']({ body: { kind: 'live', path: 'b.two', delta: -1 } }, recorder());
      await new Promise((resolve) => setImmediate(resolve));
      // Restart 1: b.two is gone, so the redone move has nothing to do and
      // the restart's options are written back.
      plugin.stop();
      plugin.start({ warmupOnStart: false, model: 'm2', aiDataPaths: ['a.one'] });
      pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
      // Restart 2 while that re-save is in flight.
      plugin.stop();
      plugin.start({ warmupOnStart: false, model: 'm3', aiDataPaths: ['a.one'] });
      while (pending.length > 0) {
        pending.shift()();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await moving;
      assert.equal(saves[saves.length - 1].model, 'm3');
    } finally {
      plugin.stop();
    }
  });

  it('says a change was saved when the plugin stops after storing it', async () => {
    const host = createHost();
    let finish;
    host.savePluginOptions = (options, done) => {
      finish = done;
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two'] });
    const reply = recorder();
    const saving = routes['POST /paths/selection']({ body: { historyPaths: ['h.one'] } }, reply);
    await new Promise((resolve) => setImmediate(resolve));
    plugin.stop();
    finish();
    await saving;
    assert.doesNotMatch(JSON.stringify(reply.body), /nothing was saved/);
  });

  it('redoes a change on the restart\'s options when a restart lands while its save is in flight', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, model: 'old-model', aiDataPaths: ['a.one', 'b.two'] });
    try {
      const reply = recorder();
      const moving = routes['POST /paths/move']({ body: { kind: 'live', path: 'b.two', delta: -1 } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(typeof finish, 'function', 'the save is in flight');
      plugin.stop();
      plugin.start({ warmupOnStart: false, model: 'new-model', aiDataPaths: ['a.one', 'b.two', 'c.three'] });
      finish();
      await moving;
      // The move is made again on the restart's options, and that is what is
      // stored and answered: no older copy on disk or in memory.
      const last = saves[saves.length - 1];
      assert.equal(last.model, 'new-model');
      assert.deepEqual(last.aiDataPaths, ['b.two', 'a.one', 'c.three']);
      assert.deepEqual(reply.body.aiDataPaths, ['b.two', 'a.one', 'c.three']);
    } finally {
      plugin.stop();
    }
  });

  it('writes nothing for a save that waits in the queue while the plugin stops', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, model: 'kept-model', aiDataPaths: ['a.one', 'b.two'] });
    const first = routes['POST /paths/move']({ body: { kind: 'live', path: 'b.two', delta: -1 } }, recorder());
    await new Promise((resolve) => setImmediate(resolve));
    const queuedReply = recorder();
    const queued = routes['POST /paths/selection']({ body: { historyPaths: ['h.one'] } }, queuedReply);
    plugin.stop();
    finish();
    await first;
    await queued;
    assert.equal(saves.length, 1, 'the queued save must not store just its own change over the stopped options');
    assert.equal(saves[0].model, 'kept-model');
  });

  it('answers a stale move with 409 conflict and the lists as stored, so the panel can refresh', async () => {
    const host = createHost();
    host.savePluginOptions = (options, done) => done();
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two'] });
    try {
      const gone = recorder();
      await routes['POST /paths/move']({ body: { kind: 'live', path: 'z.missing', delta: 1 } }, gone);
      assert.equal(gone.statusCode, 409);
      assert.equal(gone.body.error.code, 'conflict');
      assert.deepEqual(gone.body.aiDataPaths, ['a.one', 'b.two']);
      assert.deepEqual(gone.body.history.paths, ['a.one', 'b.two']);
      assert.equal(gone.body.history.derived, true);

      const derived = recorder();
      await routes['POST /paths/move']({ body: { kind: 'history', path: 'a.one', delta: 1 } }, derived);
      assert.equal(derived.statusCode, 409);
      assert.equal(derived.body.error.code, 'conflict');
      assert.deepEqual(derived.body.aiDataPaths, ['a.one', 'b.two']);
      assert.equal(derived.body.history.derived, true);
    } finally {
      plugin.stop();
    }
  });

  it('keeps every change when saves overlap against a slow store', async () => {
    const host = createHost();
    const saves = [];
    let inFlight = 0;
    let maxInFlight = 0;
    host.savePluginOptions = (options, done) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      saves.push(options);
      setTimeout(() => {
        inFlight -= 1;
        done();
      }, 5);
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, model: 'kept', aiDataPaths: ['a.one', 'b.two'], historyPaths: ['h.one', 'h.two'] });
    try {
      const replies = [recorder(), recorder(), recorder()];
      await Promise.all([
        routes['POST /paths/selection']({ body: { aiDataPaths: ['a.one', 'b.two', 'c.three'] } }, replies[0]),
        routes['POST /paths/selection']({ body: { historyPaths: ['h.one', 'h.two', 'h.three'] } }, replies[1]),
        routes['POST /paths/move']({ body: { kind: 'history', path: 'h.two', delta: -1 } }, replies[2])
      ]);
      assert.equal(maxInFlight, 1, 'one save at a time');
      assert.deepEqual(
        replies.map((reply) => reply.statusCode),
        [200, 200, 200]
      );
      assert.equal(saves.length, 3);
      const last = saves[saves.length - 1];
      assert.deepEqual(last.aiDataPaths, ['a.one', 'b.two', 'c.three']);
      assert.deepEqual(last.historyPaths, ['h.two', 'h.one', 'h.three']);
      assert.equal(last.model, 'kept');
      const status = recorder();
      await routes['GET /ai/status']({}, status);
      assert.deepEqual(status.body.history.paths, ['h.two', 'h.one', 'h.three']);
    } finally {
      plugin.stop();
    }
  });

  it('runs the next save after one that failed, on the options as they still are', async () => {
    const host = createHost();
    const saves = [];
    host.savePluginOptions = (options, done) => {
      // Which save fails is decided when it is made, not when it finishes.
      const nth = saves.push(options);
      setTimeout(() => done(nth === 1 ? new Error('disk full') : null), 5);
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two'] });
    try {
      const failed = recorder();
      const next = recorder();
      await Promise.all([
        routes['POST /paths/selection']({ body: { aiDataPaths: ['z.lost'] } }, failed),
        routes['POST /paths/move']({ body: { kind: 'live', path: 'b.two', delta: -1 } }, next)
      ]);
      assert.equal(failed.statusCode, 500);
      assert.match(failed.body.error.message, /disk full/);
      assert.equal(next.statusCode, 200, 'a failed save does not wedge the queue');
      assert.deepEqual(saves[1].aiDataPaths, ['b.two', 'a.one']);
    } finally {
      plugin.stop();
    }
  });

  it('answers 409 when the plugin restarts during every attempt of a save', async () => {
    const host = createHost();
    const options = { warmupOnStart: false, aiDataPaths: ['a.one', 'b.two'] };
    let saves = 0;
    let plugin;
    host.savePluginOptions = (stored, done) => {
      saves += 1;
      // The server restarts the plugin while each write is on its way.
      plugin.stop();
      plugin.start({ ...options });
      done();
    };
    const created = routesFor(host);
    plugin = created.plugin;
    plugin.start({ ...options });
    try {
      const reply = recorder();
      await created.routes['POST /paths/move']({ body: { kind: 'live', path: 'b.two', delta: -1 } }, reply);
      assert.equal(saves, 3);
      assert.equal(reply.statusCode, 409);
      assert.equal(reply.body.error.code, 'conflict');
      assert.match(reply.body.error.message, /kept restarting/);
    } finally {
      plugin.stop();
    }
  });

  it('does not move a path twice when the plugin restarts from the options the move stored', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two', 'c.three'] });
    try {
      const reply = recorder();
      const moving = routes['POST /paths/move']({ body: { kind: 'live', path: 'c.three', delta: -1 } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(saves[0].aiDataPaths, ['a.one', 'c.three', 'b.two']);
      // The server restarts the plugin on the options just written.
      plugin.stop();
      plugin.start({ ...saves[0] });
      finish();
      await moving;
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.body.aiDataPaths, ['a.one', 'c.three', 'b.two']);
      assert.deepEqual(saves[saves.length - 1].aiDataPaths, ['a.one', 'c.three', 'b.two']);
    } finally {
      plugin.stop();
    }
  });

  it('does not move a path twice when the restart has the moved list tidied', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: [' a.one', 'b.two', 'c.three'] });
    try {
      const reply = recorder();
      const moving = routes['POST /paths/move']({ body: { kind: 'live', path: 'c.three', delta: -1 } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(saves[0].aiDataPaths, [' a.one', 'c.three', 'b.two']);
      // The same order, trimmed by a hand edit before the restart.
      plugin.stop();
      plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'c.three', 'b.two'] });
      finish();
      await moving;
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.body.aiDataPaths, ['a.one', 'c.three', 'b.two']);
      assert.deepEqual(saves[saves.length - 1].aiDataPaths, ['a.one', 'c.three', 'b.two'], 'disk holds what the plugin runs');
    } finally {
      plugin.stop();
    }
  });

  it('does not move a path twice when the restart has the move and another path', async () => {
    const host = createHost();
    let finish;
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      if (saves.length === 1) finish = done;
      else done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, historyPaths: ['a.one', 'navigation.*', 'b.two', 'c.three'] });
    try {
      const reply = recorder();
      const moving = routes['POST /paths/move']({ body: { kind: 'history', path: 'c.three', delta: -1 } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(saves[0].historyPaths, ['a.one', 'navigation.*', 'c.three', 'b.two']);
      // Restarted from the moved list with one more path added elsewhere.
      plugin.stop();
      plugin.start({ warmupOnStart: false, historyPaths: ['a.one', 'navigation.*', 'c.three', 'b.two', 'd.four'] });
      finish();
      await moving;
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.body.history.paths, ['a.one', 'c.three', 'b.two', 'd.four']);
      assert.deepEqual(saves[saves.length - 1].historyPaths, ['a.one', 'navigation.*', 'c.three', 'b.two', 'd.four']);
    } finally {
      plugin.stop();
    }
  });

  it('does not move a path twice when two restarts arrive out of order', async () => {
    const host = createHost();
    const pending = [];
    const saves = [];
    host.savePluginOptions = (options, done) => {
      saves.push(options);
      pending.push(done);
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two', 'c.three'] });
    try {
      const reply = recorder();
      const moving = routes['POST /paths/move']({ body: { kind: 'live', path: 'c.three', delta: -1 } }, reply);
      await new Promise((resolve) => setImmediate(resolve));
      const first = saves[0];
      assert.deepEqual(first.aiDataPaths, ['a.one', 'c.three', 'b.two']);
      // Restart 1 from a list reordered elsewhere: the redo moves c.three there.
      plugin.stop();
      plugin.start({ warmupOnStart: false, aiDataPaths: ['b.two', 'a.one', 'c.three'] });
      pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(saves[1].aiDataPaths, ['b.two', 'c.three', 'a.one']);
      // Restart 2 from the first write, which already has the move.
      plugin.stop();
      plugin.start({ ...first });
      while (pending.length > 0) {
        pending.shift()();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await moving;
      assert.equal(reply.statusCode, 200);
      assert.deepEqual(reply.body.aiDataPaths, ['a.one', 'c.three', 'b.two']);
      assert.deepEqual(saves[saves.length - 1].aiDataPaths, first.aiDataPaths, 'disk holds what the plugin runs');
    } finally {
      plugin.stop();
    }
  });

  it('takes delta only as the number 1 or -1', async () => {
    const host = createHost();
    let writes = 0;
    host.savePluginOptions = (options, done) => {
      writes += 1;
      done();
    };
    const { plugin, routes } = routesFor(host);
    plugin.start({ warmupOnStart: false, aiDataPaths: ['a.one', 'b.two'] });
    try {
      for (const delta of [true, '1', '-1', [1], 2, 0.5, null]) {
        const response = recorder();
        await routes['POST /paths/move']({ body: { kind: 'live', path: 'a.one', delta } }, response);
        assert.equal(response.statusCode, 400, `delta ${JSON.stringify(delta)} is refused`);
        assert.equal(response.body.error.code, 'validation-failed');
      }
      assert.equal(writes, 0);
    } finally {
      plugin.stop();
    }
  });
});
