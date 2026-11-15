# signalk-ai-bridge

[![signalk-plugin-ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml)
[![ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml)

A Signal K plugin that adds **Ask AI** to the Signal K web UI: send selected
vessel data to a local language model (Ollama or TensorRT-LLM) and read its
answer in the browser.

The background watch of every path, Watchkeeper, is its own plugin:
[signalk-watchkeeper](https://github.com/KEGustafsson/signalk-watchkeeper).

> **⚠️ Ask AI needs two separate parts.**
>
> 1. **This plugin**, installed from the Signal K App Store.
> 2. **An AI container** ([`docker-compose.gemma.yml`](docker-compose.gemma.yml) or
>    another compose file), deployed by you on the same host or elsewhere on the
>    network. It runs the model and is **not** part of the App Store install.
>
> With only the plugin there is nothing to answer; with only the container nothing
> reaches Signal K.

## Experimental

This is an experimental study plugin for testing and evaluating AI-assisted vessel
monitoring. It is not a safety-critical navigation system, an authoritative
decision-maker or a replacement for the alarms already on the boat.

## What you can do

- ask about the vessel in plain language, with the Signal K paths you choose
- include recent history from the Signal K History API, for trend questions
- watch the answer stream in, and see exactly what was sent to the model
- see whether the model runs on the GPU, and how fast it generates

## Quick start

1. Start an AI container (see below) and make sure it has a model.
2. In Signal K, open the plugin's configuration and set the inference host URL and
   model name.
3. Open the plugin's web app, press **Browse available paths** and save the paths
   the model should see.
4. Write a question and press **Ask AI**.

## Running the model with Docker Compose

| File | Use it for |
| --- | --- |
| [`docker-compose.gemma.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.gemma.yml) | Any host. No GPU requested, so inference runs on the CPU. |
| [`docker-compose.nano-super.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.nano-super.yml) | NVIDIA Jetson Orin Nano Super (JetPack 6). |
| [`docker-compose.xavier.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.xavier.yml) | NVIDIA Jetson Xavier NX (JetPack 5). |
| [`docker-compose.tensorrt.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.tensorrt.yml) | NVIDIA TensorRT-LLM, for engines compiled for the local GPU. |

```bash
docker compose -f docker-compose.gemma.yml up -d
```

The Ollama compose files pull their model on start, so no separate `ollama pull`
is needed. The plugin's default model, the untagged `gemma4`, resolves to whichever
Gemma 4 tag is installed. Which model fits which board is covered in
[Choosing a model](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/jetson.md#choosing-a-model).

Point the plugin at the server:

- Signal K on the same host: `http://localhost:11434` (the default).
- Signal K in another container: an address that container can reach, for example
  `http://ollama:11434` on a shared Docker network.
- Signal K on another machine: this host's address, for example
  `http://192.168.0.43:11434`. Check it with
  `curl http://<that-address>:11434/api/tags` **from the Signal K machine**.

**Ollama has no authentication.** Anyone who can reach the port can run, pull and
delete models, and Docker bypasses the host firewall for published ports. The
compose files publish on all interfaces; on a machine that ever joins marina or
other untrusted wifi, narrow it with `OLLAMA_BIND` (or put it in a `.env` file
beside the compose file):

```bash
OLLAMA_BIND=192.168.1.10 docker compose -f docker-compose.xavier.yml up -d   # this LAN only
OLLAMA_BIND=127.0.0.1 docker compose -f docker-compose.xavier.yml up -d      # this host only
```

## The panel

- **Signal K**: login state and vessel ID.
- **Inference server**: URL, model, availability and timeout, with a setup link
  when the server cannot be reached.
- **AI Path Selection**: which paths are sent to the model. **Browse available
  paths** lists what this vessel publishes; tick and save. The selection is made
  here, not in the plugin settings. The saved list is in priority order: use
  **↑**/**↓** to put alarms and engine data first, because when the context
  window is full, earlier paths are kept first and what does not fit is left out
  (the prompt says how many). The default selection has no arrows until you
  save a selection of your own.
- **History Context**: the history window, the last read, and **Browse recorded
  paths**.
- **GPU Acceleration**: whether the model is fully on the GPU, and the board's
  power mode, clocks and temperature when Signal K runs on a Jetson.
- **AI Response** and **Ask AI History**: the answer, earlier questions, and the
  exact request sent for each.

On a server with security enabled, saving selections needs a login with write
access.

## Key settings

| Setting | What it does |
| --- | --- |
| `baseUrl` | Inference server URL. Default `http://localhost:11434`. |
| `model` | Model name. Default `gemma4`, which resolves to the installed Gemma 4 tag. |
| `backend` | `ollama` (default) or `tensorrt-llm`. |
| `requestTimeoutMs` | How long to wait for an answer. Allow for a cold model load: 180 s is comfortable on a Xavier NX. |
| `numCtx` | Context window. Sizes GPU memory use and how much vessel data fits. 8192 suits an 8 GB board. |
| `gpuAutoTune` | Shrink the context window on start until the whole model fits on the GPU. |
| `historyEnabled` | Also send recent history from the Signal K History API. |

All settings are described in
[docs/settings.md](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/settings.md),
which links to the history settings.

## Documentation

| | |
| --- | --- |
| [GPU, Jetson and choosing a model](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/jetson.md) | Model sizes per board, keeping the model on the GPU, power modes, TensorRT-LLM, testing on a Jetson |
| [How Ask AI builds its request](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/how-it-works.md) | Streaming, the prompt budget, units, model names |
| [Vessel history](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/history.md) | Sending History API data with a question |
| [Plugin settings](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/settings.md) | Ask AI and GPU settings, with a link to the history ones |
| [Development](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/development.md) | Building, previewing without a boat, tests, CI and publishing |
| [Changelog](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/CHANGELOG.md) | What changed, and why |

## Licence

European Union Public Licence v. 1.2 (EUPL-1.2). See [`LICENSE`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/LICENSE).
