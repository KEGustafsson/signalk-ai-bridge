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
2. In Signal K, open **Server → Plugin Config → AI Bridge**. **Turn on AI Bridge**
   is on by default; under **AI model**, set the **Model server address** and the
   **Model name**. Everything else has working defaults.
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

## Settings

The settings form starts with one switch, **Turn on AI Bridge**, and groups the
rest into four sections. Usually only the switch and **AI model** need
attention. In the plugin's options each section is a nested object (its key is
in parentheses), and a setting keeps its long-standing key inside it, for
example `aiModel.model`. Settings saved by an earlier version are moved into
the sections on the first start.

| Setting | Default | |
| --- | --- | --- |
| **Turn on AI Bridge** (`enabled`) | on | Answer questions from the panel |
| ***AI model*** (`aiModel`) | | |
| Model server type (`backend`) | Ollama | Ollama (`ollama`), or TensorRT-LLM or NIM (`tensorrt-llm`) |
| Model server address (`baseUrl`) | `http://localhost:11434` | Where the model server runs |
| Model name (`model`) | `gemma4` | Resolves to the installed Gemma 4 tag |
| API key (`apiKey`) | empty | Shown for TensorRT-LLM or NIM only |
| Keep the model loaded for (`keepAlive`) | `30m` | `-1` never unloads |
| Load the model when the plugin starts (`warmupOnStart`) | on | No cold load on the first question |
| ***Answers*** (`answers`) – safe to leave | | |
| Instructions to the model (`systemPrompt`) | tuned default | Add to it rather than replace it |
| Creativity (`temperature`) | 0.2 | |
| Word choice (`topP`) | 0.95 | |
| Longest answer, tokens (`maxTokens`) | 2048 | Held to half the context window |
| Wait for an answer, ms (`requestTimeoutMs`) | 120000 | Allow for a cold model load: 180000 is comfortable on a Xavier NX |
| ***History in answers – optional*** (`history`) | | |
| Include recent history (`historyEnabled`) | off | Needs a History API provider; the settings below appear once it is on |
| How far back (`historyDuration`) | `PT1H` | At most 31 days |
| Time step (`historyResolution`) | empty | Empty fits the points per path |
| Points per path (`historySamples`) | 12 | |
| History server address (`historyServerUrl`) | empty | Empty is this server |
| History API key (`historyApiKey`) | empty | For a history server that is not this one |
| History provider (`historyProvider`) | empty | A specific provider plugin |
| Wait for history, ms (`historyTimeoutMs`) | 5000 | Then answer from live data alone |
| ***Advanced – GPU and memory*** (`advanced`) | | |
| Context window, tokens (`numCtx`) | 8192 | Sizes GPU memory use and how much vessel data fits |
| GPU layers (`numGpu`) | -1 | -1 automatic, 0 CPU only, 999 all on the GPU |
| Fit the model on the GPU automatically (`gpuAutoTune`) | on | Shrinks the context window on start until the model fits |
| Batch size (`numBatch`) | 512 | Lower first after an out-of-memory error; 256 on a Xavier NX |
| CPU threads (`numThread`) | 0 | 0 lets the runtime choose |

The paths sent to the model are chosen in the panel, not here. Every setting,
the environment variables that can stand in for them, and a note on upgrading
from flat settings are in
[docs/settings.md](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/settings.md).

## Documentation

| | |
| --- | --- |
| [GPU, Jetson and choosing a model](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/jetson.md) | Model sizes per board, keeping the model on the GPU, power modes, TensorRT-LLM, testing on a Jetson |
| [How Ask AI builds its request](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/how-it-works.md) | Streaming, the prompt budget, units, model names |
| [Vessel history](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/history.md) | Sending History API data with a question |
| [Plugin settings](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/settings.md) | Every setting, section by section, and the environment variables |
| [Development](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/development.md) | Building, previewing without a boat, tests, CI and publishing |
| [Changelog](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/CHANGELOG.md) | What changed, and why |

## Licence

European Union Public Licence v. 1.2 (EUPL-1.2). See [`LICENSE`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/LICENSE).
