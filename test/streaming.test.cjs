'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('../index.cjs');
const { normalizeAiConfig, resetRuntimeState, streamAiModel } = require('../lib/ai-service.cjs');

/** Ollama client stub whose chat() yields the given fragments as a stream. */
function streamingClient(fragments, final = {}) {
  return {
    async chat(request) {
      assert.equal(request.stream, true);
      return (async function* generate() {
        for (let index = 0; index < fragments.length; index += 1) {
          const isLast = index === fragments.length - 1;
          yield {
            model: 'gemma4:e2b',
            created_at: '2026-04-11T10:00:00.000Z',
            message: { role: 'assistant', content: fragments[index] },
            done: isLast,
            ...(isLast ? final : {})
          };
        }
      })();
    }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** A response whose body streams the given Server-Sent Events text. */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });

  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Collects everything a streaming route writes, as parsed NDJSON lines. */
function createStreamRecorder() {
  const chunks = [];
  const listeners = {};
  return {
    headers: {},
    statusCode: 200,
    ended: false,
    // Node sets this when the response has been completed by the server, which
    // is how a client that hung up is told apart from one that got its answer.
    writableFinished: false,
    on(event, handler) {
      listeners[event] = handler;
    },
    off(event) {
      delete listeners[event];
    },
    /** The client's socket went away before the response finished. */
    hangUp() {
      if (listeners.close) {
        listeners.close();
      }
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
      this.writableFinished = true;
    },
    json(payload) {
      chunks.push(`${JSON.stringify(payload)}\n`);
      return this;
    },
    lines() {
      return chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }
  };
}

function createPluginHost() {
  return {
    selfId: 'urn:mrn:signalk:uuid:test-self',
    setPluginStatus: () => {},
    getSelfPath: () => undefined
  };
}

function registerRoutes(plugin) {
  const routes = {};
  plugin.registerWithRouter({
    get(path, handler) {
      routes[`GET ${path}`] = handler;
    },
    post(path, handler) {
      routes[`POST ${path}`] = handler;
    }
  });
  return routes;
}

beforeEach(() => {
  resetRuntimeState();
});

describe('streamAiModel', () => {
  it('emits each fragment and returns the assembled answer', async () => {
    const fragments = [];
    const result = await streamAiModel(
      { prompt: 'Summarize the vessel state.' },
      normalizeAiConfig({}),
      {
        ollamaClient: streamingClient(['The vessel ', 'is making ', '4.1 knots.'], {
          prompt_eval_count: 40,
          eval_count: 12,
          eval_duration: 400_000_000
        })
      },
      (text) => fragments.push(text)
    );

    assert.deepEqual(fragments, ['The vessel ', 'is making ', '4.1 knots.']);
    assert.equal(result.answer, 'The vessel is making 4.1 knots.');
    assert.equal(result.usage.totalTokens, 52);
    assert.equal(result.performance.tokensPerSecond, 30);
  });

  it('rejects an empty prompt before opening a stream', async () => {
    await assert.rejects(
      streamAiModel({ prompt: '  ' }, normalizeAiConfig({}), {
        ollamaClient: {
          chat() {
            throw new Error('should not be called');
          }
        }
      }),
      (error) => error.code === 'validation-failed'
    );
  });

  it('falls back to the blocking path when the stream fails before any output', async () => {
    let blockingCalls = 0;
    const result = await streamAiModel({ prompt: 'Status?' }, normalizeAiConfig({}), {
      ollamaClient: {
        async chat(request) {
          if (request.stream) {
            throw new Error("model 'gemma4' not found");
          }
          blockingCalls += 1;
          return {
            model: 'gemma4',
            message: { role: 'assistant', content: 'Recovered without streaming.' }
          };
        }
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    });

    assert.equal(blockingCalls, 1);
    assert.equal(result.answer, 'Recovered without streaming.');
  });

  it('surfaces a mid-stream failure rather than replaying it', async () => {
    const fragments = [];
    let blockingCalls = 0;

    await assert.rejects(
      streamAiModel(
        { prompt: 'Status?' },
        normalizeAiConfig({}),
        {
          ollamaClient: {
            async chat(request) {
              if (!request.stream) {
                blockingCalls += 1;
                return { message: { content: 'replayed' } };
              }
              return (async function* generate() {
                yield { message: { role: 'assistant', content: 'partial answer' } };
                throw new Error('connection reset');
              })();
            }
          }
        },
        (text) => fragments.push(text)
      ),
      /connection reset/
    );

    // Replaying after emitting would duplicate text mid-answer.
    assert.deepEqual(fragments, ['partial answer']);
    assert.equal(blockingCalls, 0);
  });

  it('streams TensorRT-LLM over SSE', async () => {
    const fragments = [];
    let requestBody;

    const result = await streamAiModel(
      { prompt: 'Status?' },
      normalizeAiConfig({ backend: 'tensorrt-llm' }),
      {
        fetchImpl: async (url, init) => {
          assert.match(String(url), /\/v1\/chat\/completions$/);
          requestBody = JSON.parse(String(init.body));
          return sseResponse([
            'data: {"model":"trt","choices":[{"delta":{"content":"All "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"nominal."}}]}\n\n',
            'data: {"usage":{"prompt_tokens":30,"completion_tokens":4,"total_tokens":34}}\n\n',
            'data: [DONE]\n\n'
          ]);
        }
      },
      (text) => fragments.push(text)
    );

    assert.equal(requestBody.stream, true);
    // Without include_usage a streamed OpenAI response carries no token counts.
    assert.deepEqual(requestBody.stream_options, { include_usage: true });
    assert.deepEqual(fragments, ['All ', 'nominal.']);
    assert.equal(result.answer, 'All nominal.');
    assert.equal(result.usage.totalTokens, 34);
  });

  it('reassembles TensorRT-LLM events split across chunk boundaries', async () => {
    const fragments = [];

    const result = await streamAiModel(
      { prompt: 'Status?' },
      normalizeAiConfig({ backend: 'tensorrt-llm' }),
      {
        fetchImpl: async () =>
          sseResponse([
            'data: {"choices":[{"delta":{"con',
            'tent":"split"}}]}\n\ndata: [DO',
            'NE]\n\n'
          ])
      },
      (text) => fragments.push(text)
    );

    assert.deepEqual(fragments, ['split']);
    assert.equal(result.answer, 'split');
  });

  it('reads a non-streaming completion body without generating a second time', async () => {
    // Some OpenAI-compatible servers ignore `stream: true` and reply with one
    // ordinary completion object. The generation has already been paid for, so
    // re-issuing it as a blocking request would bill the same GPU twice.
    const bodies = [];
    const fragments = [];

    const result = await streamAiModel(
      { prompt: 'Status?' },
      normalizeAiConfig({ backend: 'tensorrt-llm' }),
      {
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init.body));
          bodies.push(body.stream === true);
          if (body.stream) {
            return sseResponse(['{"choices":[{"message":{"content":"Blocking."}}]}']);
          }
          return jsonResponse({ choices: [{ message: { content: 'Blocking.' } }] });
        }
      },
      (text) => fragments.push(text)
    );

    assert.deepEqual(bodies, [true], 'the answer must not be generated twice');
    assert.deepEqual(fragments, ['Blocking.']);
    assert.equal(result.answer, 'Blocking.');
  });

  it('does not replay a mid-flight backend failure as a second generation', async () => {
    // `emitted === false` only means no content reached the client; it does not
    // mean the request failed early. Replaying a late failure cost a second
    // full generation and a second timeout window.
    let calls = 0;

    await assert.rejects(
      streamAiModel({ prompt: 'Status?' }, normalizeAiConfig({ backend: 'tensorrt-llm' }), {
        fetchImpl: async () => {
          calls += 1;
          return new Response('{"error":"CUDA kernel launch failed"}', {
            status: 500,
            headers: { 'content-type': 'application/json' }
          });
        }
      }),
      (error) => error.code !== 'validation-failed'
    );

    assert.equal(calls, 1);
  });

  it('reports a stalled stream as a timeout, not an unknown abort', async () => {
    // The abort raised while reading the body has to be classified before the
    // "something was emitted" check, or it escapes as a bare AbortError and the
    // route maps it to 502 instead of 504.
    const encoder = new TextEncoder();
    const stalling = (signal) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Steady "}}]}\n\n'));
            signal.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')), {
              once: true
            });
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );

    const keepAlive = setInterval(() => {}, 10);
    try {
      await assert.rejects(
        streamAiModel(
          { prompt: 'Status?' },
          normalizeAiConfig({ backend: 'tensorrt-llm', requestTimeoutMs: 80 }),
          { fetchImpl: async (_url, init) => stalling(init.signal) },
          () => {}
        ),
        (error) => error.code === 'timeout'
      );
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('parses a CRLF-framed SSE stream and its unterminated tail', async () => {
    // WHATWG allows CRLF line endings, and says the end of the stream is
    // enough to dispatch the final event. Missing either lost tokens silently:
    // CRLF yielded nothing at all, and a missing trailing blank line dropped
    // the last delta while still presenting the answer as complete.
    const fragments = [];

    const result = await streamAiModel(
      { prompt: 'Status?' },
      normalizeAiConfig({ backend: 'tensorrt-llm' }),
      {
        fetchImpl: async () =>
          sseResponse([
            'data: {"choices":[{"delta":{"content":"All "}}]}\r\n\r\n',
            'data: {"choices":[{"delta":{"content":"nominal."}}]}\r\n'
          ])
      },
      (text) => fragments.push(text)
    );

    assert.deepEqual(fragments, ['All ', 'nominal.']);
    assert.equal(result.answer, 'All nominal.');
  });
});

describe('POST /bridge/stream', () => {
  it('writes NDJSON tokens followed by the full result', async () => {
    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: streamingClient(['All ', 'nominal.'])
    });
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const res = createStreamRecorder();
    await routes['POST /bridge/stream'](
      { body: { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' } },
      res
    );

    const lines = res.lines();
    assert.deepEqual(
      lines.filter((line) => line.type === 'token').map((line) => line.text),
      ['All ', 'nominal.']
    );

    const result = lines[lines.length - 1];
    assert.equal(result.type, 'ask-vessel-ai-result');
    assert.equal(result.response.answer, 'All nominal.');
    assert.equal(res.ended, true);
    assert.match(res.headers['content-type'], /application\/x-ndjson/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
  });

  it('reports a backend failure as a trailing error line', async () => {
    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        async chat() {
          throw new Error('Ollama is unreachable.');
        }
      },
      fetchImpl: async () => {
        throw new Error('fetch failed');
      }
    });
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const res = createStreamRecorder();
    await routes['POST /bridge/stream'](
      { body: { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' } },
      res
    );

    const lines = res.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, 'error');
    assert.match(lines[0].error.message, /unreachable/);
    assert.equal(res.ended, true);
  });

  it('stops generating when the client disconnects', async () => {
    // A closed socket used to be invisible: res.write returns false rather than
    // throwing, so the GPU finished an answer nobody could read while holding
    // the single Ollama slot the Jetson compose files configure.
    let produced = 0;
    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: {
        async chat() {
          return (async function* generate() {
            for (let index = 0; index < 1000; index += 1) {
              produced += 1;
              yield { message: { role: 'assistant', content: 'tok ' } };
            }
          })();
        }
      }
    });
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const req = { body: { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' } };

    const res = createStreamRecorder();
    let tokensSeen = 0;
    const realWrite = res.write.bind(res);
    res.write = (chunk) => {
      tokensSeen += 1;
      if (tokensSeen === 3) {
        res.hangUp();
      }
      return realWrite(chunk);
    };

    await routes['POST /bridge/stream'](req, res);

    assert.ok(produced < 1000, `generation should stop early, produced ${produced}`);
    assert.equal(res.ended, true);
    // Nothing is reported to a client that is already gone.
    assert.equal(
      res.lines().some((line) => line.type === 'error'),
      false
    );
  });

  // The regression this replaces: signalk-server runs on Node 26, where an
  // IncomingMessage emits 'close' as soon as the request body has been fully
  // received. The handler treated that as "the client left" and aborted every
  // generation before it began, so the panel showed "Bridge stream ended
  // without a result" for every question asked. Nothing in the mocks reproduced
  // it, because they hand the handler a pre-parsed `req.body` and never fire
  // the event a real socket does.
  it('still answers when the request emits close after its body is received', async () => {
    const plugin = createPlugin(createPluginHost(), {
      ollamaClient: streamingClient(['All ', 'clear.'])
    });
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    // Fired synchronously on registration: by the time the handler subscribes,
    // a small POST body has already arrived in full, so Node has already
    // completed the message. That is the ordering that broke this in the field.
    const req = {
      body: { toolId: 'ask-vessel-ai', prompt: 'Summarize the vessel state.' },
      on(event, handler) {
        if (event === 'close') {
          handler();
        }
      },
      off() {}
    };

    const res = createStreamRecorder();
    await routes['POST /bridge/stream'](req, res);

    const lines = res.lines();
    const result = lines.find((line) => line.type === 'ask-vessel-ai-result');
    assert.ok(result, `expected a result line, got ${JSON.stringify(lines)}`);
    assert.match(result.response.answer, /All clear\./);
  });

  it('rejects a malformed body with 400 rather than a stream error line', async () => {
    const plugin = createPlugin(createPluginHost(), {});
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const res = createStreamRecorder();
    await routes['POST /bridge/stream']({ body: { toolId: 'ask-vessel-ai', prompt: { a: 1 } } }, res);

    assert.equal(res.statusCode, 400);
  });

  it('rejects an unknown tool id with 400, not a 200 error line', async () => {
    // Nothing has been generated and no header has gone out, so a real status
    // code is still available - and a client error should not be reported the
    // same way as a backend fault that arrives mid-answer.
    const plugin = createPlugin(createPluginHost(), {});
    plugin.start({ warmupOnStart: false });
    const routes = registerRoutes(plugin);

    const res = createStreamRecorder();
    await routes['POST /bridge/stream']({ body: { toolId: 'nope' } }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.lines()[0].error.code, 'validation-failed');
  });
});
