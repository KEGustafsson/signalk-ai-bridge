# signalk-ai-bridge

[![signalk-plugin-ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml)
[![ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml)

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
- see whether the model is actually running on the GPU, and how fast it generates

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

If you do not already have Ollama running, you can use one of the included compose files:

| File | Use it for |
| --- | --- |
| [`docker-compose.gemma.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.gemma.yml) | Any host. Portable, no GPU requested, so inference runs on the CPU. |
| [`docker-compose.jetson.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.jetson.yml) | NVIDIA Jetson Orin Nano Super. Ollama with the NVIDIA container runtime, flash attention and a quantized KV cache. |
| [`docker-compose.tensorrt.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.tensorrt.yml) | NVIDIA TensorRT-LLM served over the OpenAI API, for engines compiled ahead of time for the local GPU. |

Start one with:

```bash
docker compose -f docker-compose.gemma.yml up -d
```

The Ollama compose setups already pull `gemma4:e2b` during startup, so you do not need to run a separate `ollama pull` command.

If Signal K runs on the host, the default Ollama URL `http://localhost:11434` is usually correct.

If Signal K runs in another container, use an address reachable from that container, for example `http://ollama:11434` on a shared Docker network.

## NVIDIA Jetson Orin Nano Super

The plugin does no inference itself — all of the compute happens in Ollama or
TensorRT-LLM. What the plugin controls is the shape of the request, and on a
Jetson that shape decides whether the model runs on the GPU at all.

The Orin Nano Super has 8 GB of LPDDR5 shared between CPU and GPU, so the KV
cache competes with the model weights for the same bytes. llama.cpp reserves the
KV cache from `num_ctx` up front; when the reservation no longer fits, it quietly
moves layers back to the six Cortex-A78AE cores. The model still answers — just
at a few tokens per second instead of tens, with nothing in the response saying
why.

### Is it actually accelerated?

The `GPU Acceleration` card in the panel answers this directly. It reads Ollama's
`/api/ps` and reports one of:

- **GPU accelerated** — the whole model is resident in GPU memory.
- **Partly on CPU** — some layers spilled; lower `numCtx` or use a smaller or
  more heavily quantized model.
- **CPU only** — no layers on the GPU; the container is missing the NVIDIA
  runtime or the GPU device reservation.
- **Model not loaded** — nothing resident yet; ask a question or leave
  `warmupOnStart` enabled.

Each AI response also reports `Generation speed` in tokens/second, which is the
quickest independent confirmation.

The same thing from the command line:

```bash
curl -s localhost:11434/api/ps | jq '.models[] | {name, size, size_vram}'
```

`size_vram` must equal `size`.

### Host setup

```bash
sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker
sudo nvpmodel -m 2   # MAXN SUPER
sudo jetson_clocks
docker compose -f docker-compose.jetson.yml up -d
```

### Suggested plugin settings on 8 GB

| Setting | Value | Why |
| --- | --- | --- |
| `numCtx` | `8192` | Keeps weights plus KV cache inside unified memory. Raise to `16384` only if the card still reports GPU accelerated. |
| `maxTokens` | `2048` | Output budget only; it no longer resizes the KV cache. |
| `numGpu` | `-1` | Let Ollama estimate the split. Use `999` to force full offload, `0` to pin to CPU for comparison. |
| `numBatch` | `512` | Prompt-eval throughput on the Ampere GPU. |
| `keepAlive` | `30m` | Avoids re-reading several GB from storage on the next question. |
| `warmupOnStart` | `true` | Loads the model when the plugin starts, not when the operator asks. |

### TensorRT-LLM

Set `backend` to `tensorrt-llm` and point `baseUrl` at an OpenAI-compatible
NVIDIA server (`trtllm-serve` or a NIM container); `model` is the id reported by
`GET /v1/models`, and `apiKey` is sent as a bearer token when set.

TensorRT-LLM compiles a CUDA engine ahead of time for this GPU's SM version
(8.7 on Orin) with a fixed maximum sequence length, so there is no runtime
CPU/GPU split to get wrong — but `numCtx` must stay at or below the engine's
`--max_seq_len`, because exceeding it is a request error rather than a silent
fallback.

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
  Maximum tokens the model may generate (`num_predict`). This does not size the
  context window

- `numCtx`
  Context window in tokens (`num_ctx`). This is what sizes the KV cache, and
  therefore whether the model stays resident on the GPU

- `numGpu`
  Layers offloaded to the GPU (`num_gpu`). `-1` lets Ollama estimate, `0` forces
  CPU-only, a high value such as `999` forces full offload

- `numBatch`
  Tokens evaluated per GPU batch (`num_batch`)

- `numThread`
  CPU threads for anything not offloaded (`num_thread`). `0` lets the runtime choose

- `keepAlive`
  How long the model stays loaded between requests, for example `30m` or `-1` to
  never unload

- `warmupOnStart`
  Preload the model when the plugin starts so the first question is not slow

- `backend`
  `ollama` (default) or `tensorrt-llm` for an OpenAI-compatible NVIDIA server

- `apiKey`
  Optional bearer token for a TensorRT-LLM or NIM backend

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

To render the panel against the real plugin routes without a Signal K server,
run the preview host in a second shell — `--stub` also stubs the inference
backend, so no model is needed:

```bash
node scripts/preview-host.mjs --stub
SIGNALK_AI_BRIDGE_DEV_TARGET=http://127.0.0.1:3100 npm run dev
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

## Continuous Integration

Two workflows run on every push and pull request:

- **`signalk-plugin-ci`** calls the canonical
  [`SignalK/signalk-server` reusable plugin CI workflow](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml).
  It validates the plugin the way the Signal K server and App Store actually
  load it — package metadata, entry point, `schema()`, the start/stop/restart
  lifecycle, deprecated and internal API usage, `npm pack` contents and an
  `--ignore-scripts` App Store install — across Linux x64/arm64, macOS and
  Windows on Node 22 and 24, armv7 (Venus OS / Cerbo GX) under QEMU, and a live
  `signalk-server` install.
- **`ci`** runs the repository's own smoke test, type check, unit tests and a
  production `npm audit`.

The build and test commands declared to the reusable workflow are also what the
[Signal K plugin registry](https://signalk.org/signalk-plugin-registry/) reads
when it scores the plugin, so they are asserted by `npm run lint`.
