'use strict';

function isAbortError(error) {
  return (typeof DOMException === 'function' && error instanceof DOMException)
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

// How long an error reply's body is waited for.
const ERROR_BODY_TIMEOUT_MS = 2000;

function createTimeoutError(timeoutMs) {
  const timeoutError = new Error(`AI backend request timed out after ${timeoutMs} ms.`);
  timeoutError.code = 'timeout';
  return timeoutError;
}

/**
 * Wrap a fetch implementation so every request is bounded by `timeoutMs` while
 * still honouring a caller-supplied AbortSignal. `timeoutMs <= 0` disables the
 * timeout but keeps the external-abort plumbing.
 */
/**
 * Re-expose a response body while keeping the request's abort timer armed until
 * the body is actually drained.
 *
 * Without this the timer is cleared as soon as the headers arrive, so a peer
 * that stalls mid-body never trips the timeout. That is the common failure on a
 * flaky link — headers come back fast, then the connection goes quiet — and it
 * matters most for a streamed chat, where the body is the whole response.
 */
function monitorBody(body, cleanup, translateError, signal) {
  const reader = body.getReader();
  // The abort ends a read here too, not only when the underlying fetch
  // honours it: a body that never comes must not hold the reader. Each read
  // gets its own way to be rejected (`pending`), so a long body does not pile
  // up reactions on one shared promise.
  let pending;
  let abortError;
  const watching = Boolean(signal && typeof signal.addEventListener === 'function');
  const onAbort = () => {
    abortError = signal.reason ?? Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    // An error body nobody reads still lets go of the timer and the
    // caller's abort listener.
    cleanup();
    // Rejected before the reader is cancelled: cancelling settles a pending
    // read as done, which would otherwise end the body as if it were whole.
    if (pending) pending(abortError);
    Promise.resolve(reader.cancel(signal.reason)).catch(() => {});
  };
  if (watching) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const read = () =>
    watching
      ? new Promise((resolve, reject) => {
          if (abortError) {
            reject(abortError);
            return;
          }
          pending = reject;
          reader.read().then(resolve, reject);
        }).finally(() => {
          pending = undefined;
        })
      : reader.read();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        // The header phase converts our own timer's abort into a `timeout`
        // error; the body phase has to do the same or a stream that stalls
        // mid-answer surfaces as a bare AbortError with no `code`, which the
        // route ladder then reports as 502 "This operation was aborted".
        controller.error(translateError ? translateError(error) : error);
      }
    },
    cancel(reason) {
      cleanup();
      return reader.cancel(reason);
    }
  });
}

/**
 * Wrap a fetch implementation so every request is bounded by `timeoutMs` while
 * still honouring a caller-supplied AbortSignal. `timeoutMs <= 0` disables the
 * timeout but keeps the external-abort plumbing.
 *
 * The bound covers the whole exchange, headers and body, not just the headers.
 */
function createTimedFetch(fetchImpl, timeoutMs) {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const externalSignal = init.signal;

    let removeAbortListener = null;
    if (externalSignal && typeof externalSignal.addEventListener === 'function') {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        const onAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
      }
    }

    // The bound in force, and what a timeout error reports: the request's
    // own, or the shorter one an error reply's body gets.
    let limitMs = timeoutMs;
    const arm = (ms) => {
      const timer = setTimeout(() => controller.abort(), ms);
      // An abort timer must never be a reason for the process to stay
      // alive. A caller that discards a response without reading it would
      // otherwise hold the event loop open for the whole timeout.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      return timer;
    };
    let timeout = timeoutMs > 0 ? arm(timeoutMs) : null;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      if (typeof removeAbortListener === 'function') {
        removeAbortListener();
      }
    };

    // Our timer fired, rather than the caller cancelling: the difference is
    // what separates "the backend went quiet" from "the operator navigated
    // away", and only the first is a timeout.
    const asTimeout = (error) =>
      isAbortError(error) && !(externalSignal && externalSignal.aborted)
        ? createTimeoutError(limitMs)
        : error;

    let response;
    try {
      response = await fetchImpl(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      cleanup();
      throw asTimeout(error);
    }

    // Nothing left to wait for: a status that carries no body (204/304),
    // which Response also refuses to reconstruct with one.
    if (!response.body) {
      cleanup();
      return response;
    }

    if (!response.ok) {
      // An error reply's body gets a short bound of its own, timeout or not:
      // a caller that reads it (Ollama's client, an error message) must not
      // wait without end for a body that never comes, and one that never
      // touches it must not hold the timer, the abort listener and the
      // pooled connection for the full timeout either.
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      limitMs = timeoutMs > 0 ? Math.min(timeoutMs, ERROR_BODY_TIMEOUT_MS) : ERROR_BODY_TIMEOUT_MS;
      timeout = arm(limitMs);
    } else if (timeout === null) {
      cleanup();
      return response;
    }

    return new Response(monitorBody(response.body, cleanup, asTimeout, controller.signal), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

// A metadata call - listing models, reading residency, reading GGUF geometry -
// is answered from the backend's own bookkeeping and takes milliseconds.
// Bounding it by the chat timeout meant a wedged backend held /ai/status for
// the full two minutes, and a status poll that never returns is what the panel
// renders as a blank card. This is the most such a call may wait, whatever the
// chat timeout says.
const METADATA_TIMEOUT_MS = 15000;

/**
 * Timeout for a metadata request: the configured chat timeout, capped at
 * METADATA_TIMEOUT_MS. A chat timeout of 0 disables the bound on generation
 * only; a listing still has to come back.
 */
function metadataTimeoutMs(config) {
  const configured = Number(config && config.requestTimeoutMs);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, METADATA_TIMEOUT_MS)
    : METADATA_TIMEOUT_MS;
}

function resolveFetch(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Global fetch is not available for AI requests.');
    error.code = 'unknown';
    throw error;
  }
  return fetchImpl;
}

/**
 * At most `maxBytes` of a body as text, the rest cancelled unread. With
 * `deadlineMs`, the whole read gives up that long after it starts and
 * returns what came by then.
 */
async function readTextBounded(response, maxBytes, options) {
  const deadlineMs = options && options.deadlineMs;
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : undefined;
  let timer;
  const deadline =
    deadlineMs > 0
      ? new Promise((resolve) => {
          timer = setTimeout(() => resolve({ done: true, expired: true }), deadlineMs);
          if (typeof timer.unref === 'function') timer.unref();
        })
      : undefined;
  const within = (promise) => (deadline ? Promise.race([promise, deadline]) : promise);
  try {
    if (!reader) {
      const text = typeof response.text === 'function' ? await within(response.text()) : '';
      return typeof text === 'string' ? text.slice(0, maxBytes) : '';
    }
    const chunks = [];
    let size = 0;
    try {
      while (size < maxBytes) {
        const { done, value } = await within(reader.read());
        if (done) break;
        const bytes =
          typeof value === 'string'
            ? Buffer.from(value, 'utf8')
            : Buffer.from(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength);
        // Only what is still within the limit is kept: a 64 MB first chunk is
        // not copied whole to be cut down afterwards.
        const kept = bytes.subarray(0, maxBytes - size);
        chunks.push(kept);
        size += kept.byteLength;
      }
    } finally {
      // Not awaited: a cancel that never settles must not hold the answer.
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // Already closed.
      }
    }
    return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ERROR_BODY_TIMEOUT_MS,
  METADATA_TIMEOUT_MS,
  createTimedFetch,
  createTimeoutError,
  isAbortError,
  metadataTimeoutMs,
  readTextBounded,
  resolveFetch
};
