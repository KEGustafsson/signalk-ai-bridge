'use strict';

function isAbortError(error) {
  return (typeof DOMException === 'function' && error instanceof DOMException)
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

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
function monitorBody(body, cleanup) {
  const reader = body.getReader();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        cleanup();
        controller.error(error);
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

    const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    // An abort timer must never be a reason for the process to stay alive. A
    // caller that discards a response without reading it would otherwise hold
    // the event loop open for the whole timeout.
    if (timeout !== null && typeof timeout.unref === 'function') {
      timeout.unref();
    }
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

    let response;
    try {
      response = await fetchImpl(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      cleanup();
      if (isAbortError(error) && !(externalSignal && externalSignal.aborted)) {
        throw createTimeoutError(timeoutMs);
      }
      throw error;
    }

    // Nothing left to wait for: no timer to hold, or a status that carries no
    // body (204/304), which Response also refuses to reconstruct with one.
    if (timeout === null || !response.body) {
      cleanup();
      return response;
    }

    return new Response(monitorBody(response.body, cleanup), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
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

module.exports = {
  createTimedFetch,
  createTimeoutError,
  isAbortError,
  resolveFetch
};
