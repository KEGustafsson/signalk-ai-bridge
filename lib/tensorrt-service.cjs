'use strict';

const { createTimedFetch, resolveFetch } = require('./http-utils.cjs');

/**
 * OpenAI-compatible backend, used for NVIDIA TensorRT-LLM on Jetson.
 *
 * `trtllm-serve` (TensorRT-LLM) and the NIM containers both expose the OpenAI
 * REST shape — `GET /v1/models` and `POST /v1/chat/completions` — so one small
 * client covers both. Unlike Ollama there is no runtime layer split to
 * negotiate: the engine was compiled ahead of time for this GPU's SM version
 * (SM 8.7 on Orin) with a fixed max sequence length, so the plugin only has to
 * stay inside the limits the engine was built with.
 */

function toApiError(message, code = 'unknown', statusCode) {
  const error = new Error(message);
  error.code = code;
  if (typeof statusCode === 'number') {
    error.statusCode = statusCode;
  }
  return error;
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload === 'object') {
      if (typeof payload.error === 'string') {
        return payload.error;
      }
      if (payload.error && typeof payload.error.message === 'string') {
        return payload.error.message;
      }
      if (typeof payload.message === 'string') {
        return payload.message;
      }
    }
  } catch {
    // Body was not JSON — fall through to the status-only message.
  }
  return undefined;
}

function buildHeaders(config) {
  const headers = { 'content-type': 'application/json' };
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

async function listTensorrtModels(config, dependencies = {}) {
  const fetchImpl = resolveFetch(dependencies);
  const response = await createTimedFetch(fetchImpl, config.requestTimeoutMs)(
    `${config.baseUrl}/v1/models`,
    { method: 'GET', headers: buildHeaders(config) }
  );

  if (!response.ok) {
    throw toApiError(
      `Failed to list TensorRT-LLM models (${response.status}).`,
      response.status === 408 ? 'timeout' : 'unknown',
      response.status
    );
  }

  const payload = await response.json();
  const entries = Array.isArray(payload && payload.data) ? payload.data : [];

  // Normalised to the same `{ name }` shape the Ollama tag listing uses so the
  // shared model-resolution logic works against either backend.
  return entries
    .map((entry) => (entry && typeof entry.id === 'string' ? { name: entry.id } : undefined))
    .filter(Boolean);
}

function extractChoiceContent(payload) {
  const choices = Array.isArray(payload && payload.choices) ? payload.choices : [];
  const message = choices[0] && choices[0].message;
  if (!message) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  return '';
}

function parseUsage(payload) {
  const usage = payload && payload.usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);

  if (![promptTokens, completionTokens, totalTokens].some(Number.isFinite)) {
    return undefined;
  }

  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : undefined,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
    totalTokens: Number.isFinite(totalTokens)
      ? totalTokens
      : (Number.isFinite(promptTokens) ? promptTokens : 0) +
        (Number.isFinite(completionTokens) ? completionTokens : 0)
  };
}

function toIsoTimestamp(created) {
  const seconds = Number(created);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

async function runTensorrtChat(messages, model, config, dependencies = {}) {
  const fetchImpl = resolveFetch(dependencies);
  const response = await createTimedFetch(fetchImpl, config.requestTimeoutMs)(
    `${config.baseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: config.temperature,
        top_p: config.topP,
        max_tokens: config.maxTokens
      })
    }
  );

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw toApiError(
      detail || `TensorRT-LLM request failed (${response.status}).`,
      response.status === 408 || response.status === 504 ? 'timeout' : 'unknown',
      response.status
    );
  }

  const payload = await response.json();
  const answer = extractChoiceContent(payload);

  if (answer.length === 0) {
    throw toApiError('AI backend returned an empty response.', 'unknown');
  }

  return {
    answer,
    model: typeof payload.model === 'string' && payload.model.trim().length > 0 ? payload.model : model,
    createdAt: toIsoTimestamp(payload && payload.created),
    usage: parseUsage(payload)
  };
}

/**
 * Server-Sent Events framing, as the OpenAI chat-completions stream uses it.
 *
 * Events are separated by a blank line and each carries one `data:` payload;
 * the literal `[DONE]` marks the end. Anything else on a line is a comment or
 * a field this client has no use for.
 */
// The WHATWG event-stream grammar allows CRLF, LF or a bare CR to end a line,
// and an event is dispatched on a blank line. Matching only "\n\n" left a
// CRLF-framed server buffering forever: zero tokens, then an empty-answer throw,
// then a silent fall back to a second full blocking generation.
//
// `flush` handles the other half of the grammar - "the end of the stream is
// sufficient to dispatch the final event". A server that closes without a
// trailing blank line was losing its last delta, so an answer arrived truncated
// and was presented as complete, and the include_usage token counts vanished.
function parseSseEvents(buffer, { flush = false } = {}) {
  const events = [];
  // Normalizing first keeps the boundary search and the line split agreeing
  // about what a line ending is, whichever the peer chose.
  let rest = buffer.replace(/\r\n?/g, '\n');

  const takeBlock = (block) => {
    // Per spec a multi-line event concatenates its data fields with "\n".
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':') || !line.startsWith('data:')) {
        continue;
      }
      // "data:x" and "data: x" are the same field; only one leading space is
      // part of the framing, so trailing whitespace is all that is trimmed.
      data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) {
      const payload = data.join('\n').trim();
      if (payload.length > 0) {
        events.push(payload);
      }
    }
  };

  for (;;) {
    const boundary = rest.indexOf('\n\n');
    if (boundary === -1) {
      break;
    }

    takeBlock(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
  }

  if (flush && rest.trim().length > 0) {
    takeBlock(rest);
    rest = '';
  }

  return { events, rest };
}

function extractDeltaContent(chunk) {
  const choices = Array.isArray(chunk && chunk.choices) ? chunk.choices : [];
  const delta = choices[0] && choices[0].delta;
  if (!delta) {
    return '';
  }
  if (typeof delta.content === 'string') {
    return delta.content;
  }
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/**
 * Stream a TensorRT-LLM chat completion, calling `onToken` per fragment.
 *
 * `stream_options.include_usage` asks the server for a final chunk carrying the
 * token counts, which a streamed OpenAI response otherwise omits — without it
 * the panel would lose the usage figures it shows for the blocking path.
 */
async function streamTensorrtChat(messages, model, config, dependencies = {}, onToken = () => {}, signal) {
  const fetchImpl = resolveFetch(dependencies);
  const response = await createTimedFetch(fetchImpl, config.requestTimeoutMs)(
    `${config.baseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: config.temperature,
        top_p: config.topP,
        max_tokens: config.maxTokens
      })
    }
  );

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    throw toApiError(
      detail || `TensorRT-LLM request failed (${response.status}).`,
      response.status === 408 || response.status === 504 ? 'timeout' : 'unknown',
      response.status
    );
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    throw toApiError('TensorRT-LLM returned no readable stream.', 'unknown');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let answer = '';
  let last;

  for (;;) {
    if (signal && signal.aborted) {
      await reader.cancel().catch(() => {});
      const error = new Error('Client closed the connection.');
      error.code = 'aborted';
      throw error;
    }

    const { done, value } = await reader.read();
    if (done) {
      // Drain the decoder and dispatch whatever the peer left unterminated.
      const tail = decoder.decode();
      buffer += tail;
      if (answer.length === 0 && raw.length < 65536) {
        raw += tail;
      }
    }

    if (!done) {
      const text = decoder.decode(value, { stream: true });
      buffer += text;
      // Only kept while nothing has been emitted; a real stream never grows
      // this past its first few events.
      if (answer.length === 0 && raw.length < 65536) {
        raw += text;
      }
    }

    const { events, rest } = parseSseEvents(buffer, { flush: done });
    buffer = rest;

    for (const payload of events) {
      if (payload === '[DONE]') {
        continue;
      }

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        // A malformed event is not worth failing the answer over.
        continue;
      }

      last = chunk;
      const fragment = extractDeltaContent(chunk);
      if (fragment.length > 0) {
        answer += fragment;
        onToken(fragment);
      }
    }

    if (done) {
      break;
    }
  }

  answer = answer.trim();

  // A server that ignores `stream: true` answers with one ordinary completion
  // object and no SSE framing at all. The generation already happened, so
  // replaying it through the blocking path would pay for it twice on the same
  // GPU - read the answer out of the body we already have instead.
  if (answer.length === 0 && raw.trim().length > 0) {
    let whole;
    try {
      whole = JSON.parse(raw);
    } catch {
      whole = undefined;
    }
    const blocking = extractChoiceContent(whole);
    if (blocking.length > 0) {
      onToken(blocking);
      return {
        answer: blocking,
        model:
          whole && typeof whole.model === 'string' && whole.model.trim().length > 0 ? whole.model : model,
        createdAt: toIsoTimestamp(whole && whole.created),
        usage: parseUsage(whole)
      };
    }
  }

  if (answer.length === 0) {
    throw toApiError('AI backend returned an empty response.', 'unknown');
  }

  return {
    answer,
    model: last && typeof last.model === 'string' && last.model.trim().length > 0 ? last.model : model,
    createdAt: toIsoTimestamp(last && last.created),
    usage: parseUsage(last)
  };
}

module.exports = {
  listTensorrtModels,
  parseSseEvents,
  runTensorrtChat,
  streamTensorrtChat
};
