'use strict';

const {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  getAiAvailability,
  normalizeAiConfig,
  queryAiModel,
  readJsonBody
} = require('./lib/ai-service.cjs');
const { createBridgeService } = require('./lib/bridge-service.cjs');

module.exports = function createPlugin(app, dependencies = {}) {
  let pluginOptions = {};
  let routesRegistered = false;
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
        title: 'Ollama host',
        description:
          'Ollama host URL. Leave blank to use AI_MODEL_URL or the default local Ollama server.',
        default: DEFAULT_AI_BASE_URL
      },
      model: {
        type: 'string',
        title: 'AI model',
        description: 'Ollama model name to send in chat requests.',
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
        default: 131072,
        minimum: 64,
        maximum: 131072
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
      res.status(200).json({
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        model: config.model,
        requestTimeoutMs: config.requestTimeoutMs,
        maxTokens: config.maxTokens,
        aiDataPaths: config.aiDataPaths,
        signalKSelfId: typeof app.selfId === 'string' ? app.selfId : undefined,
        aiAvailable: availability.available,
        ollamaReachable: availability.backendReachable,
        modelAvailable: availability.modelAvailable,
        resolvedModel: availability.resolvedModel,
        availabilityMessage: availability.message
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
      const config = getConfig();
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus(
          config.enabled
            ? `AI Bridge ready: ${config.model} via ${config.baseUrl}`
            : 'AI Bridge webapp assets available. AI pipeline disabled.'
        );
      }
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
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus('AI Bridge stopped.');
      }
      bridgeService.reset();
      pluginOptions = {};
    }
  };
};
