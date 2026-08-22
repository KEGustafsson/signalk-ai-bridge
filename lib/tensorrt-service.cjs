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

module.exports = {
  listTensorrtModels,
  runTensorrtChat
};
