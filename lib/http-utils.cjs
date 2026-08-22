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

    try {
      return await fetchImpl(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error) && !(externalSignal && externalSignal.aborted)) {
        throw createTimeoutError(timeoutMs);
      }
      throw error;
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      if (typeof removeAbortListener === 'function') {
        removeAbortListener();
      }
    }
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
