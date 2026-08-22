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
  getAcceleratorStatus,
  getAiAvailability,
  normalizeAiConfig,
  queryAiModel,
  readJsonBody,
  resetAvailabilityCache,
  warmUpModel
} = require('./lib/ai-service.cjs');
const { createBridgeService } = require('./lib/bridge-service.cjs');

module.exports = function createPlugin(app, dependencies = {}) {
  let pluginOptions = {};
  let routesRegistered = false;
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
    ...normalizeServerConfig(pluginOptions)
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
        }
      }
    }
  });

  const statusHandler = async (req, res) => {
    try {
      const config = getConfig();
      const availability = await getAiAvailability(config, dependencies);
      // Residency is only meaningful once the backend answered; probing a
      // host that is down would just repeat the same connection failure.
      const accelerator = availability.backendReachable
        ? await getAcceleratorStatus({ ...config, resolvedModel: availability.resolvedModel }, dependencies)
        : undefined;

      res.status(200).json({
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        model: config.model,
        backend: config.backend,
        requestTimeoutMs: config.requestTimeoutMs,
        maxTokens: config.maxTokens,
        numCtx: config.numCtx,
        numGpu: config.numGpu,
        numBatch: config.numBatch,
        numThread: config.numThread,
        keepAlive: config.keepAlive,
        aiDataPaths: config.aiDataPaths,
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
    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const payload = await bridgeService.buildAiPayload(body, config);
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
    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const result = await bridgeService.executeTool(body, config);
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

  return {
    id: 'signalk-ai-bridge',
    name: 'AI Bridge',
    description: 'Signal K Ask AI plugin with embedded web UI for Ollama and Gemma.',
    schema,
    start: (options = {}) => {
      pluginOptions = options;
      bridgeService.reset();
      resetAvailabilityCache();
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
      warmUpModel(config, dependencies)
        .then((result) => {
          if (generation !== lifecycleGeneration) {
            return;
          }
          if (result.warmed && typeof app.setPluginStatus === 'function') {
            app.setPluginStatus(
              `AI Bridge ready: ${result.model} preloaded on ${config.baseUrl} (keep_alive ${config.keepAlive})`
            );
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
      routesRegistered = true;
    },
    stop: () => {
      lifecycleGeneration += 1;
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus('AI Bridge stopped.');
      }
      bridgeService.reset();
      resetAvailabilityCache();
      pluginOptions = {};
    }
  };
};
