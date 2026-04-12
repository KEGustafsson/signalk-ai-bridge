# signalk-ai-bridge

`signalk-ai-bridge` is a Signal K plugin that adds an `Ask AI` panel to the Signal K web UI.

It lets you send selected Signal K vessel data to a local Ollama model such as Gemma, then read the response directly in the browser.

## Experimental Plugin

This is an experimental study plugin.

It is intended for testing, evaluation, and local experimentation with AI-assisted vessel summaries inside Signal K. It should not be treated as a safety-critical navigation system, an authoritative decision-maker, or a production-hardened marine control feature.

## What It Is

This plugin is a bridge between:

- Signal K vessel data
- a local Ollama AI model
- a simple web UI inside Signal K

It is meant for local, operator-facing use. You choose which Signal K paths are shared with the AI, write a question in plain language, and the plugin sends that question plus the selected vessel context to Ollama.

## What It Does

With this plugin you can:

- ask for a vessel-state summary in plain language
- send selected Signal K paths to AI instead of the full data tree
- review the AI response in a readable panel
- see a history of previous AI requests
- inspect the actual request that was sent to the model
- check whether Ollama and the configured model are available

## What You Need

- a running Signal K server
- this plugin installed in Signal K
- a running Ollama server
- a locally available Ollama model, for example `gemma4:e2b`

## Quick Start

1. Start Ollama.
2. Make sure the model you want to use is available.
3. Open the plugin configuration in Signal K.
4. Set the Ollama URL and model name.
5. Choose which Signal K paths should be sent to AI.
6. Open the plugin web UI and press `Ask AI`.

## Ollama With Docker Compose

If you do not already have Ollama running, you can use the included compose file:

[`docker-compose.gemma.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.gemma.yml)

Start it with:

```bash
docker compose -f docker-compose.gemma.yml up -d
```

This compose setup already pulls `gemma4:e2b` during startup, so you do not need to run a separate `ollama pull` command.

If Signal K runs on the host, the default Ollama URL `http://localhost:11434` is usually correct.

If Signal K runs in another container, use an address reachable from that container, for example `http://ollama:11434` on a shared Docker network.

## Normal Use

In the web UI you will see:

- `Signal K`: login state and vessel self ID
- `Ollama / Gemma`: backend URL, model, AI status, and timeout
- `AI Path Selection`: which Signal K paths are currently sent to AI
- `AI Response`: the latest answer from the model
- `Ask AI History`: previous prompts and results

If AI is unavailable, the web UI also shows a help link that opens the Ollama setup instructions.

## Important Plugin Settings

These are the settings most users will care about:

- `baseUrl`
  Ollama server URL. Default: `http://localhost:11434`

- `model`
  Ollama model name. Example: `gemma4:e2b`

- `aiDataPaths`
  The Signal K self paths that will be sent to AI. You can use exact paths like `navigation.position` and simple wildcards like `navigation.*`

- `requestTimeoutMs`
  How long the plugin waits for Ollama. Set `0` to disable the timeout

- `systemPrompt`
  Extra instructions sent to the model before your question

- `temperature`
  Lower values are more stable and literal. Higher values are more varied

- `topP`
  Additional output randomness control

- `maxTokens`
  The output/context budget forwarded to Ollama

## Notes About Model Names

The plugin defaults to the Gemma 4 family.

If you configure `gemma4` but Ollama only has a tagged variant installed, such as `gemma4:e2b`, the plugin will try to resolve and use the installed tagged model automatically.

If you already know the exact installed model name, configuring that exact name is the clearest option.

## Development

For local development:

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run test
npm run check
```

To remove generated build output:

```bash
npm run clean
```

To build the packaged web UI:

```bash
npm run build
```
