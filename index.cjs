'use strict';

const {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_KEEP_ALIVE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_NUM_BATCH,
  DEFAULT_NUM_CTX,
  DEFAULT_NUM_GPU,
  DEFAULT_NUM_THREAD,
  DEFAULT_SYSTEM_PROMPT,
  MAX_NUM_BATCH,
  MAX_NUM_CTX,
  MAX_NUM_GPU,
  MAX_NUM_THREAD,
  MIN_NUM_BATCH,
  MIN_NUM_CTX,
  getAccelerationReport,
  getAiAvailability,
  resolveOffload,
  normalizeAiConfig,
  queryAiModel,
  readJsonBody,
  redactUrl,
  resetRuntimeState,
  retuneOffload,
  warmUpModel
} = require('./lib/ai-service.cjs');
const { createBridgeService, normalizeAiDataPaths } = require('./lib/bridge-service.cjs');
const {
  DEFAULT_HISTORY_DURATION,
  DEFAULT_HISTORY_SAMPLES,
  DEFAULT_HISTORY_TIMEOUT_MS,
  MAX_HISTORY_PATHS,
  MAX_HISTORY_SAMPLES,
  MIN_HISTORY_SAMPLES,
  authHeadersFromRequest,
  normalizeHistoryConfig,
  resolveHistoryBaseUrl,
  resolveHistoryPaths,
  resolveWindow
} = require('./lib/history-service.cjs');

module.exports = function createPlugin(app, dependencies = {}) {
  let pluginOptions = {};
  let routesRegistered = false;
  // Express has no public API for unmounting a subrouter, and signalk-server
  // calls registerWithRouter unconditionally - outside its `if (enabled)` guard
  // - so gating a stopped plugin is the plugin's own job. Without this, stop()
  // left every route live and getConfig() fell back to normalizeAiConfig({}),
  // whose defaults are enabled:true against http://localhost:11434: a stopped
  // plugin answering inference against a host the operator never configured.
  let running = false;
  // Bumped on every start/stop so a warm-up that finishes after the plugin was
  // stopped (or restarted with new options) cannot overwrite the live status.
  let lifecycleGeneration = 0;
  const bridgeService = createBridgeService(app, dependencies);

  function normalizeServerConfig(options = {}) {
    const aiDataPaths = Array.isArray(options.aiDataPaths)
      ? options.aiDataPaths.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    return {
      aiDataPaths
    };
  }

  const getConfig = () => ({
    ...normalizeAiConfig(pluginOptions),
    ...normalizeServerConfig(pluginOptions),
    ...normalizeHistoryConfig(pluginOptions)
  });

  const schema = () => ({
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        title: 'Enable AI pipeline',
        default: true
      },
      baseUrl: {
        type: 'string',
        title: 'Inference host',
        description:
          'Ollama or TensorRT-LLM host URL. Leave blank to use AI_MODEL_URL or the default local Ollama server.',
        default: DEFAULT_AI_BASE_URL
      },
      model: {
        type: 'string',
        title: 'AI model',
        description: 'Model name to send in chat requests (an Ollama tag, or a TensorRT-LLM served model id).',
        default: DEFAULT_AI_MODEL
      },
      systemPrompt: {
        type: 'string',
        title: 'System prompt',
        description: 'Passed as a native Ollama system message before the operator request.',
        default: DEFAULT_SYSTEM_PROMPT
      },
      requestTimeoutMs: {
        type: 'integer',
        title: 'Request timeout (ms)',
        description: 'How long to wait for Ollama before failing. Set to 0 to disable the timeout.',
        default: 120000,
        minimum: 0,
        maximum: 300000
      },
      temperature: {
        type: 'number',
        title: 'Temperature',
        default: 0.2,
        minimum: 0,
        maximum: 2
      },
      topP: {
        type: 'number',
        title: 'Top-p',
        default: 0.95,
        minimum: 0,
        maximum: 1
      },
      maxTokens: {
        type: 'integer',
        title: 'Max output tokens',
        description:
          'Upper bound on generated tokens (num_predict). This no longer sizes the KV cache — use "GPU context window" for that.',
        default: DEFAULT_MAX_TOKENS,
        minimum: 64,
        maximum: MAX_NUM_CTX
      },
      numCtx: {
        type: 'integer',
        title: 'GPU context window (num_ctx)',
        description:
          'Tokens of context the model keeps in memory. llama.cpp reserves the KV cache from this value up front, so it is the setting that decides whether the model stays resident on the GPU. On a Jetson Orin Nano Super (8 GB unified memory) keep this at or below 16384 for a 4B-class model.',
        default: DEFAULT_NUM_CTX,
        minimum: MIN_NUM_CTX,
        maximum: MAX_NUM_CTX
      },
      numGpu: {
        type: 'integer',
        title: 'GPU layers (num_gpu)',
        description:
          'Layers to offload to CUDA. -1 lets Ollama estimate the split, 0 forces CPU-only execution, and a high value such as 999 forces full GPU offload.',
        default: DEFAULT_NUM_GPU,
        minimum: -1,
        maximum: MAX_NUM_GPU
      },
      gpuAutoTune: {
        type: 'boolean',
        title: 'Maximize GPU offload automatically',
        description:
          'On start, force every layer onto the GPU and shrink the context window until the whole model is resident, instead of accepting whatever CPU/GPU split the backend estimates. Falls back to the backend estimate when the model cannot fit at all.',
        default: true
      },
      numBatch: {
        type: 'integer',
        title: 'Prompt batch size (num_batch)',
        description:
          'Tokens evaluated per GPU batch. Larger batches raise prompt-eval throughput on the Orin Ampere GPU at the cost of some memory.',
        default: DEFAULT_NUM_BATCH,
        minimum: MIN_NUM_BATCH,
        maximum: MAX_NUM_BATCH
      },
      numThread: {
        type: 'integer',
        title: 'CPU threads (num_thread)',
        description:
          'Threads used for whatever is not offloaded to the GPU. 0 lets the runtime choose; the Orin Nano Super has 6 Cortex-A78AE cores.',
        default: DEFAULT_NUM_THREAD,
        minimum: 0,
        maximum: MAX_NUM_THREAD
      },
      keepAlive: {
        type: 'string',
        title: 'Keep model loaded (keep_alive)',
        description:
          'How long the model stays resident in GPU memory between requests, for example 30m, 1h, or -1 to never unload. Reloading a model from Jetson storage costs several seconds on the next question.',
        default: DEFAULT_KEEP_ALIVE
      },
      warmupOnStart: {
        type: 'boolean',
        title: 'Preload model on start',
        description:
          'Load the model into GPU memory when the plugin starts so the first operator question does not pay the cold-load cost.',
        default: true
      },
      backend: {
        type: 'string',
        title: 'Inference backend',
        description:
          'ollama talks to an Ollama server (llama.cpp CUDA backend). tensorrt-llm talks to any OpenAI-compatible NVIDIA server such as trtllm-serve or a NIM container, where the CUDA engine is compiled ahead of time for this GPU.',
        enum: ['ollama', 'tensorrt-llm'],
        default: 'ollama'
      },
      apiKey: {
        type: 'string',
        title: 'API key (TensorRT-LLM / NIM only)',
        description:
          'Optional bearer token sent to an OpenAI-compatible backend. Leave blank for a local Ollama or unauthenticated trtllm-serve.',
        default: ''
      },
      aiDataPaths: {
        type: 'array',
        title: 'AI data paths',
        description:
          'Signal K self paths to collect and send to AI. Exact paths and simple wildcards ending in .* are supported. You can type your own paths, for example navigation.position, navigation.*, environment.wind.speedApparent, or notifications.',
        uniqueItems: true,
        default: [
          'navigation.position',
          'navigation.speedOverGround',
          'navigation.courseOverGroundTrue',
          'notifications'
        ],
        items: {
          type: 'string',
          title: 'Signal K path'
        }      },
      historyEnabled: {
        type: 'boolean',
        title: 'Include history from the Signal K History API',
        description:
          'Also send recent history for the paths below, read from the server\'s History API (/signalk/v2/api/history). Requires a history provider plugin such as signalk-to-influxdb2 or signalk-parquet; without one the plugin says the history was unavailable and answers from live data alone.',
        default: false
      },
      historyPaths: {
        type: 'array',
        title: 'History paths',
        description:
          'Signal K paths to read history for. Wildcards are not supported here — the History API takes explicit paths. A path may carry an aggregation method, for example navigation.speedOverGround:average or environment.wind.speedApparent:max (average, min, max, first, last, mid, middle_index, sma, ema). Leave empty to reuse the exact paths from "AI data paths". At most ' + MAX_HISTORY_PATHS + ' paths are requested.',
        uniqueItems: true,
        default: [],
        items: {
          type: 'string',
          title: 'Signal K path'
        }
      },
      historyDuration: {
        type: 'string',
        title: 'History window',
        description:
          'How far back to look, as an ISO 8601 duration (PT15M, PT1H, P1D), a shorthand (30m, 2h), or a plain number of seconds. Capped at 31 days.',
        default: DEFAULT_HISTORY_DURATION
      },
      historyResolution: {
        type: 'string',
        title: 'History resolution',
        description:
          'Size of each aggregation window, for example 1m or 300. Leave blank to derive it from the window and the sample budget, which is what keeps the request proportional to what actually fits in the prompt.',
        default: ''
      },
      historySamples: {
        type: 'integer',
        title: 'History samples per path',
        description:
          'How many points per path reach the model. Points are picked evenly across the window and always include its first and last, with min, max, first, last and average sent alongside. Two is the minimum: a single point is not a series, and the live snapshot already carries the newest value.',
        default: DEFAULT_HISTORY_SAMPLES,
        minimum: MIN_HISTORY_SAMPLES,
        maximum: MAX_HISTORY_SAMPLES
      },
      historyApiKey: {
        type: 'string',
        title: 'History API key (remote servers only)',
        description:
          'Bearer token for a history server that is not this machine. The operator\'s own session is forwarded only to this server on localhost — a cookie minted here is replayable against another Signal K instance, so a remote host is never sent it and needs a credential issued for itself. Leave blank for local history, or for an unauthenticated remote one.',
        default: ''
      },
      historyProvider: {
        type: 'string',
        title: 'History provider (optional)',
        description:
          'Plugin id of a specific history provider, for example signalk-parquet. Leave blank to use the server default.',
        default: ''
      },
      historyServerUrl: {
        type: 'string',
        title: 'Signal K server URL (optional)',
        description:
          'Where to reach the History API. Leave blank to call this server on localhost. Set it for history served by another Signal K instance, or when this server runs behind TLS with a certificate localhost cannot verify.',
        default: ''
      },
      historyTimeoutMs: {
        type: 'integer',
        title: 'History request timeout (ms)',
        description:
          'How long to wait for the History API before answering from live data alone. Kept short on purpose: this runs before the model sees the question. Set to 0 to disable the timeout.',
        default: DEFAULT_HISTORY_TIMEOUT_MS,
        minimum: 0,
        maximum: 120000
      }
    }
  });

  /**
   * History configuration as it will actually be used, plus how the last read
   * went.
   *
   * Reporting the last outcome rather than probing keeps /ai/status free: the
   * panel polls it on every render pass, and a probe there would put a database
   * query behind each of those polls for information that only changes when a
   * question is asked.
   */
  const describeHistory = (config) => {
    const window = resolveWindow(config);

    return {
      enabled: config.historyEnabled,
      // The same fallback the bridge applies: an unset `aiDataPaths` means the
      // default live paths, and those are what an empty history list reuses.
      paths: resolveHistoryPaths({ ...config, aiDataPaths: normalizeAiDataPaths(config) }),
      durationSeconds: window.durationSeconds,
      resolutionSeconds: window.resolutionSeconds,
      samples: config.historySamples,
      // Redacted for the same reason baseUrl is: an operator may have put
      // credentials in the URL of a remote Signal K server.
      serverUrl: redactUrl(resolveHistoryBaseUrl(app, config)),
      ...(config.historyProvider ? { provider: config.historyProvider } : {}),
      lastFetch: bridgeService.getHistoryStatus()
    };
  };

  // One place for code -> HTTP, so /ai/query and the bridge routes cannot drift
  // apart the way they had (only one of them mapped `disabled` and `timeout`).
  const statusForCode = (code) => {
    switch (code) {
      case 'validation-failed':
        return 400;
      case 'unauthorized':
        return 401;
      case 'disabled':
        return 503;
      case 'timeout':
        return 504;
      default:
        return 502;
    }
  };

  // A stopped plugin must not serve inference. Returns true when the request
  // was answered with 503 and the caller should stop.
  const rejectIfStopped = (res) => {
    if (running) {
      return false;
    }
    res.status(503).json({
      error: { code: 'disabled', message: 'AI Bridge is stopped.' }
    });
    return true;
  };

  const statusHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const availability = await getAiAvailability(config, dependencies);
      // Residency is only meaningful once the backend answered; probing a
      // host that is down would just repeat the same connection failure.
      // Report what requests will actually use, not just what was configured:
      // the start-up tuner may have shrunk the context window to fit the GPU.
      const effective = resolveOffload(config);
      const accelerator = availability.backendReachable
        ? await getAccelerationReport({ ...config, resolvedModel: availability.resolvedModel }, dependencies)
        : undefined;

      res.status(200).json({
        enabled: config.enabled,
        // Redacted: a baseUrl may legitimately carry credentials, and this
        // payload is rendered in the panel and readable by anyone with access.
        baseUrl: redactUrl(config.baseUrl),
        model: config.model,
        backend: config.backend,
        requestTimeoutMs: config.requestTimeoutMs,
        maxTokens: config.maxTokens,
        numCtx: effective.numCtx,
        numGpu: effective.numGpu,
        configuredNumCtx: config.numCtx,
        numBatch: config.numBatch,
        numThread: config.numThread,
        keepAlive: config.keepAlive,
        gpuAutoTune: config.gpuAutoTune,
        aiDataPaths: config.aiDataPaths,
        history: describeHistory(config),
        signalKSelfId: typeof app.selfId === 'string' ? app.selfId : undefined,
        aiAvailable: availability.available,
        ollamaReachable: availability.backendReachable,
        modelAvailable: availability.modelAvailable,
        resolvedModel: availability.resolvedModel,
        availabilityMessage: availability.message,
        accelerator
      });
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'unknown',
          message: error instanceof Error ? error.message : 'Unknown AI status failure.'
        }
      });
    }
  };

  const queryHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const payload = await bridgeService.buildAiPayload(body, config, {
        authHeaders: authHeadersFromRequest(req)
      });
      const result = await queryAiModel(payload, config, dependencies);
      res.status(200).json(result);
    } catch (error) {
      const statusCode =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : error && error.code === 'unauthorized'
            ? 401
          : error && error.code === 'validation-failed'
            ? 400
            : error && error.code === 'disabled'
              ? 503
              : error && error.code === 'timeout'
                ? 504
                : 502;

      res.status(statusCode).json({
        error: {
          code:
            typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'unknown',
          message: error instanceof Error ? error.message : 'Unknown AI backend failure.'
        }
      });
    }
  };

  const bridgeExecuteHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const result = await bridgeService.executeTool(body, config, {
        authHeaders: authHeadersFromRequest(req)
      });
      res.status(200).json(result);
    } catch (error) {
      const statusCode =
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number'
          ? error.statusCode
          : error && error.code === 'unauthorized'
            ? 401
            : error && error.code === 'validation-failed'
              ? 400
              : 500;

      res.status(statusCode).json({
        error: {
          code:
            typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'unknown',
          message: error instanceof Error ? error.message : 'Unknown bridge failure.'
        }
      });
    }
  };

  /**
   * Re-measure the GPU fit and report the result.
   *
   * The start-up tuner never grows its context window back, so this is how an
   * operator picks up memory that has since been freed without restarting the
   * plugin.
   */
  const retuneHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const result = await retuneOffload(config, dependencies);
      res.status(result.retuned ? 200 : 503).json(result);
    } catch (error) {
      res.status(500).json({
        error: {
          code: 'unknown',
          message: error instanceof Error ? error.message : 'Unknown re-tune failure.'
        }
      });
    }
  };

  /**
   * Newline-delimited JSON stream of the answer as it is generated.
   *
   * NDJSON rather than SSE: the payload is already JSON objects, every line is
   * independently parseable, and it survives Express's default handling without
   * needing an event-source content type. Each line is one of
   *   {"type":"token","text":"..."}
   *   {"type":"result", ...}   (the same shape /bridge/execute returns)
   *   {"type":"error","error":{...}}
   *
   * Errors after the first byte cannot use a status code — the header is long
   * gone — so they are delivered as a trailing error line instead.
   */
  const bridgeStreamHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    let headersSent = false;

    // A question the operator walked away from is still a question the GPU is
    // answering: without this the generation ran to completion for a closed
    // socket, holding the single Ollama slot the Jetson compose files configure
    // and queueing the next question behind it.
    //
    // Watch the RESPONSE, not the request. On Node 16 and newer an
    // IncomingMessage emits 'close' as soon as the request body has been fully
    // received - not when the client goes away - so listening on `req` aborted
    // every stream the instant readJsonBody() drained the body, before
    // generation had even started. writeLine() then suppressed every token and
    // the final result, and the catch block stayed quiet because the signal
    // said "the client left", so the panel got an empty stream and reported
    // "Bridge stream ended without a result" for every single question.
    // Measured on the Node 26 that signalk-server ships: 'close' fires during
    // the body read, 100% of the time.
    //
    // `res` is the object whose lifetime actually tracks the client, and
    // writableFinished separates a client that hung up mid-answer from a
    // response we completed ourselves.
    const abortController = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) {
        abortController.abort();
      }
    };
    if (res && typeof res.on === 'function') {
      res.on('close', onClientGone);
    }
    const releaseClientListeners = () => {
      if (res && typeof res.off === 'function') {
        res.off('close', onClientGone);
      }
    };

    const writeLine = (payload) => {
      // res.write on a destroyed socket returns false rather than throwing, so
      // the loop would otherwise keep going and keep formatting output nobody
      // can read.
      if (abortController.signal.aborted || res.writableEnded) {
        return;
      }
      if (!headersSent) {
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('cache-control', 'no-cache, no-transform');
        // Without this a reverse proxy in front of Signal K may buffer the
        // whole response and defeat the point of streaming.
        res.setHeader('x-accel-buffering', 'no');
        if (typeof res.status === 'function') {
          res.status(200);
        }
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }
        headersSent = true;
      }
      res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const result = await bridgeService.streamTool(
        body,
        config,
        (text) => {
          writeLine({ type: 'token', text });
        },
        abortController.signal,
        { authHeaders: authHeadersFromRequest(req) }
      );

      // streamTool reports a bad request by *returning* an error result rather
      // than throwing, so a validation failure went out as HTTP 200 with an
      // error line and the status ladder below was dead code for it.
      //
      // Only pre-generation errors are mapped to a status: a backend failure
      // stays a trailing error line, because a non-2xx makes the panel fall
      // back to the blocking route and pay for a second generation.
      const preGeneration =
        result &&
        result.type === 'error' &&
        result.error &&
        (result.error.code === 'validation-failed' || result.error.code === 'disabled');

      if (!headersSent && preGeneration && typeof res.status === 'function') {
        releaseClientListeners();
        res.status(statusForCode(result.error.code)).json({ error: result.error });
        return;
      }

      writeLine(result);
    } catch (error) {
      // The client hanging up is not a failure to report - there is nobody
      // left to report it to, and the headers may already be gone.
      if (!abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Unknown bridge failure.';
        const code =
          typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'unknown';

        // Nothing has been written yet, so a real status code is still
        // available: a malformed request should not look like a backend fault.
        if (!headersSent && typeof res.status === 'function' && code === 'validation-failed') {
          releaseClientListeners();
          res.status(400).json({ error: { code, message } });
          return;
        }
        writeLine({ type: 'error', error: { code, message } });
      }
    } finally {
      releaseClientListeners();
      if (!res.writableEnded) {
        res.end();
      }
    }
  };

  // Without this the admin UI renders apiKey as an ordinary text input, so the
  // token is on screen in cleartext and echoed back on every config page load.
  const uiSchema = () => ({
    apiKey: { 'ui:widget': 'password' },
    historyApiKey: { 'ui:widget': 'password' },
    systemPrompt: { 'ui:widget': 'textarea' }
  });

  return {
    id: 'signalk-ai-bridge',
    name: 'AI Bridge',
    description: 'Signal K Ask AI plugin with embedded web UI for Ollama and Gemma.',
    schema,
    uiSchema,
    start: (options = {}) => {
      pluginOptions = options;
      running = true;
      bridgeService.reset();
      resetRuntimeState();
      lifecycleGeneration += 1;
      const generation = lifecycleGeneration;
      const config = getConfig();
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus(
          config.enabled
            ? `AI Bridge ready: ${config.model} via ${config.baseUrl}`
            : 'AI Bridge webapp assets available. AI pipeline disabled.'
        );
      }

      // Fire-and-forget: a warm-up is a latency optimisation, so start() must
      // not wait for it and must never fail because the backend is not up yet.
      warmUpModel(config, dependencies, { isCurrent: () => generation === lifecycleGeneration })
        .then((result) => {
          if (generation !== lifecycleGeneration) {
            return;
          }
          // A failed warm-up used to leave the optimistic "ready" status from
          // start() in place, so the admin UI showed green while the backend
          // was unreachable.
          if (!result.warmed && result.reason && result.reason !== 'skipped') {
            if (typeof app.setPluginError === 'function') {
              app.setPluginError(`AI Bridge could not reach the model: ${result.reason}`);
            } else if (typeof app.setPluginStatus === 'function') {
              app.setPluginStatus(`AI Bridge degraded: ${result.reason}`);
            }
            return;
          }
          if (result.warmed && typeof app.setPluginStatus === 'function') {
            const offload = result.offload;
            const numCtx = offload ? offload.numCtx : config.numCtx;
            // numGpu is what we *asked* for (999 means "all layers"), not what
            // landed. Only the last ladder step's measured residency can say
            // "all layers on GPU"; claiming it from the request printed a full
            // offload even when /api/ps was unreadable or reported a spill.
            const measured =
              offload && Array.isArray(offload.steps) && offload.steps.length > 0
                ? offload.steps[offload.steps.length - 1].state
                : undefined;
            const placement =
              offload && offload.numGpu === 0
                ? `CPU only, num_ctx ${numCtx}`
                : measured === 'gpu'
                  ? `all layers on GPU, num_ctx ${numCtx}`
                  : measured === 'partial'
                    ? `partly on CPU, num_ctx ${numCtx}`
                    : measured === 'cpu'
                      ? `on CPU, num_ctx ${numCtx}`
                      : `GPU residency unconfirmed, num_ctx ${numCtx}`;
            app.setPluginStatus(`AI Bridge ready: ${result.model} preloaded (${placement})`);
          }
        })
        .catch(() => {});
    },
    registerWithRouter: (router) => {
      if (routesRegistered) {
        return;
      }
      router.get('/ai/status', statusHandler);
      router.post('/ai/query', queryHandler);
      router.post('/bridge/execute', bridgeExecuteHandler);
      router.post('/bridge/stream', bridgeStreamHandler);
      router.post('/ai/retune', retuneHandler);
      routesRegistered = true;
    },
    stop: () => {
      lifecycleGeneration += 1;
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus('AI Bridge stopped.');
      }
      bridgeService.reset();
      resetRuntimeState();
      pluginOptions = {};
      running = false;
    }
  };
};
