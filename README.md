# signalk-ai-bridge

Signal K AI Bridge packaged as a Signal K plugin with both standalone and embedded Admin UI webapp support.

## What it does

- Serves a packaged React webapp for standalone and embedded Signal K Admin UI use.
- Publishes a legacy-compatible `public/remoteEntry.js` container for Signal K Admin embedding.
- Lets the plugin read selected Signal K self paths directly from the Signal K plugin API.
- Sends the operator prompt plus selected Signal K data to a local Ollama server.
- Shows the AI response, request history, and the exact request sent to AI in the web UI.

## AI pipeline

1. The webapp posts an Ask AI request to `/plugins/signalk-ai-bridge/bridge/execute`.
2. The plugin reads the configured Signal K self paths directly from the Signal K plugin API.
3. The plugin sends the operator prompt plus collected Signal K context to Ollama through the official `ollama` npm client.
4. The plugin returns the AI response and request context back to the UI.

The default backend target is `http://localhost:11434` with model family `gemma4`.
If Ollama only has a tagged variant installed, such as `gemma4:e2b`, the plugin will retry with the installed tag automatically.

## Development

```bash
npm install
npm run dev
```

## Local checks

```bash
npm run lint
npm run typecheck
npm run test
npm run check
```

## Build

```bash
npm run build
```

## Plugin configuration

The plugin accepts AI settings from plugin config or environment variables:

- `AI_MODEL_URL` or plugin `baseUrl`: Ollama host URL. Default: `http://localhost:11434`
- `AI_MODEL_NAME` or plugin `model`: Ollama model name. Default: `gemma4`
  If the exact name is missing, the plugin will try an installed tagged variant from the same Ollama family.
- Optional plugin settings for `systemPrompt`, `requestTimeoutMs`, `temperature`, `topP`, and `maxTokens`
  The default AI timeout is `120000` ms to allow for local Gemma model load and generation. Set `requestTimeoutMs` to `0` to disable the timeout. The maximum configurable timeout is `300000` ms.
  The default token setting is `131072`, and it is forwarded to Ollama as both `num_predict` and `num_ctx`.
- `aiDataPaths`: array of Signal K self paths to send to AI. Exact paths like `navigation.position` and simple wildcards like `navigation.*` are supported.

## Ollama with Docker Compose

[`docker-compose.gemma.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.gemma.yml) runs a local Ollama server and persists pulled models in `./ollama_data`.

Start Ollama:

```bash
docker compose -f docker-compose.gemma.yml up -d
```

This compose setup already pulls `gemma4:e2b` during startup, so you do not need to run a separate `ollama pull` command.

If Signal K runs on the host, the plugin default `http://localhost:11434` is correct.
If Signal K runs in another container, point the plugin at `http://ollama:11434` on a shared Docker network instead of `localhost`.
