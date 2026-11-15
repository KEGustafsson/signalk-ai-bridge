'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { METADATA_TIMEOUT_MS, createTimedFetch, metadataTimeoutMs } = require('../lib/http-utils.cjs');

/**
 * Hold the event loop open for the duration of `run`.
 *
 * The abort timer is deliberately unref'd so a discarded response can never
 * keep a process alive. A real fetch has an open socket doing that job; these
 * fakes do not, so without this the runner sees an idle loop and cancels the
 * test before the timeout it is exercising can fire.
 */
async function withEventLoopAlive(run) {
  const keepAlive = setInterval(() => {}, 10);
  try {
    return await run();
  } finally {
    clearInterval(keepAlive);
  }
}

/** A response whose headers arrive immediately but whose body never does. */
function stalledBodyResponse(signal) {
  const body = new ReadableStream({
    start(controller) {
      // Never enqueues. Only the abort signal ends it.
      signal.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')), {
        once: true
      });
    }
  });

  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('createTimedFetch', () => {
  it('bounds the body read, not just the headers', async () => {
    // The failure this guards against: headers come back fast, then the peer
    // goes quiet. Clearing the timer once headers resolve leaves that hang
    // unbounded, which for a streamed chat is the whole response.
    const timedFetch = createTimedFetch(async (_input, init) => stalledBodyResponse(init.signal), 60);

    await withEventLoopAlive(async () => {
      const response = await timedFetch('http://localhost:11434/api/chat', { method: 'POST' });
      await assert.rejects(response.text(), (error) => error instanceof Error);
    });
  });

  it('releases the timer once the body is consumed', async () => {
    const timedFetch = createTimedFetch(
      async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
      60
    );

    const response = await timedFetch('http://localhost:11434/api/tags');
    assert.deepEqual(await response.json(), { ok: true });

    // The abort would fire well inside this window if the timer had survived.
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  it('passes through a response that carries no body', async () => {
    const timedFetch = createTimedFetch(async () => new Response(null, { status: 204 }), 1000);

    const response = await timedFetch('http://localhost:11434/api/ps');

    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });

  it('preserves status and headers through the wrapper', async () => {
    const timedFetch = createTimedFetch(
      async () =>
        new Response('nope', { status: 404, statusText: 'Not Found', headers: { 'x-trace': 'abc' } }),
      1000
    );

    const response = await timedFetch('http://localhost:11434/api/show');

    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
    assert.equal(response.headers.get('x-trace'), 'abc');
    assert.equal(await response.text(), 'nope');
  });

  it('bounds an error reply\'s body, even with the timeout disabled', async () => {
    const { ERROR_BODY_TIMEOUT_MS } = require('../lib/http-utils.cjs');
    const timedFetch = createTimedFetch(
      async (_input, init) => {
        const response = stalledBodyResponse(init.signal);
        return new Response(response.body, { status: 500 });
      },
      0
    );
    await withEventLoopAlive(async () => {
      const response = await timedFetch('http://localhost:11434/api/chat');
      const started = Date.now();
      await assert.rejects(response.text(), (error) => error.code === 'timeout');
      assert.ok(Date.now() - started < ERROR_BODY_TIMEOUT_MS + 1000);
    });
  });

  it('times out an error body even when fetch ignores the abort', async () => {
    const timedFetch = createTimedFetch(
      async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 500 }),
      0
    );
    await withEventLoopAlive(async () => {
      const response = await timedFetch('http://localhost:11434/api/chat');
      // A timeout, not an empty body passed off as the whole reply.
      await assert.rejects(response.text(), (error) => error.code === 'timeout');
    });
  });

  it('lets go of the caller\'s abort listener when an error body is never read', async () => {
    const caller = new AbortController();
    let listeners = 0;
    const add = caller.signal.addEventListener.bind(caller.signal);
    const remove = caller.signal.removeEventListener.bind(caller.signal);
    caller.signal.addEventListener = (type, fn, options) => {
      if (type === 'abort') listeners += 1;
      return add(type, fn, options);
    };
    caller.signal.removeEventListener = (type, fn, options) => {
      if (type === 'abort') listeners -= 1;
      return remove(type, fn, options);
    };
    const timedFetch = createTimedFetch(async () => new Response('oops', { status: 500 }), 100);
    await withEventLoopAlive(async () => {
      for (let index = 0; index < 20; index += 1) {
        await timedFetch('http://localhost:11434/api/chat', { signal: caller.signal });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    assert.equal(listeners, 0);
  });

  it('stops watching the request\'s abort once a body has ended', async () => {
    let listeners = 0;
    const timedFetch = createTimedFetch(async (_input, init) => {
      const add = init.signal.addEventListener.bind(init.signal);
      const remove = init.signal.removeEventListener.bind(init.signal);
      init.signal.addEventListener = (type, fn, options) => {
        if (type === 'abort') listeners += 1;
        return add(type, fn, options);
      };
      init.signal.removeEventListener = (type, fn, options) => {
        if (type === 'abort') listeners -= 1;
        return remove(type, fn, options);
      };
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }, 1000);
    const response = await timedFetch('http://localhost:11434/api/tags');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(listeners, 0);
  });

  it('does not keep a reaction per chunk of a long body', async () => {
    // Collected before each measurement, so only what the read still holds
    // is counted.
    require('node:v8').setFlagsFromString('--expose_gc');
    const gc = require('node:vm').runInNewContext('gc');
    let sent = 0;
    const chunk = new Uint8Array(16);
    const timedFetch = createTimedFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += 1;
              if (sent > 200000) controller.close();
              else controller.enqueue(chunk);
            }
          }),
          { status: 200 }
        ),
      60000
    );
    const response = await timedFetch('http://localhost:11434/api/chat');
    gc();
    const before = process.memoryUsage().heapUsed;
    const reader = response.body.getReader();
    let grown = 0;
    for (let count = 1; ; count += 1) {
      const { done } = await reader.read();
      if (done) break;
      if (count === 190000) {
        gc();
        grown = process.memoryUsage().heapUsed - before;
      }
    }
    assert.ok(grown < 10 * 1024 * 1024, `the read held ${Math.round(grown / 1024 / 1024)} MB after 190,000 chunks`);
  });

  it('reports a timeout rather than a bare abort', async () => {
    const timedFetch = createTimedFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      40
    );

    await withEventLoopAlive(() =>
      assert.rejects(timedFetch('http://localhost:11434/api/tags'), (error) => error.code === 'timeout')
    );
  });

  it('leaves a caller-supplied abort as the caller own', async () => {
    const controller = new AbortController();
    const timedFetch = createTimedFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted by caller');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      10_000
    );

    const pending = timedFetch('http://localhost:11434/api/tags', { signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code !== 'timeout');
  });
});

describe('metadataTimeoutMs', () => {
  it('caps a metadata probe well below the chat timeout', () => {
    // A listing answered from Ollama's bookkeeping takes milliseconds; bound
    // by the two-minute chat timeout, a wedged backend held /ai/status for
    // all of it.
    assert.equal(metadataTimeoutMs({ requestTimeoutMs: 120000 }), METADATA_TIMEOUT_MS);
    assert.equal(metadataTimeoutMs({ requestTimeoutMs: 3000 }), 3000);
  });

  it('keeps a bound even when the chat timeout is disabled', () => {
    // 0 turns off the bound on generation, which an operator may want for a
    // slow board. A listing that never returns is not something to want.
    assert.equal(metadataTimeoutMs({ requestTimeoutMs: 0 }), METADATA_TIMEOUT_MS);
    assert.equal(metadataTimeoutMs({}), METADATA_TIMEOUT_MS);
    assert.equal(metadataTimeoutMs(undefined), METADATA_TIMEOUT_MS);
  });
});
