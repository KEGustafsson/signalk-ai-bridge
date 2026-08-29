'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTimedFetch } = require('../lib/http-utils.cjs');

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
