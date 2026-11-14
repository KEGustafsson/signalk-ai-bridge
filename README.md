# signalk-ai-bridge

[![signalk-plugin-ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml)
[![ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml)

A Signal K plugin that adds two things to the Signal K web UI:

- **Ask AI**: send selected vessel data to a local language model (Ollama or
  TensorRT-LLM) and read its answer in the browser.
- **Watchkeeper** (optional): watch *every* Signal K path in the background, learn
  what is normal for this vessel, and raise a Signal K notification when something
  departs from it. It is statistics, not AI, so it needs no model and no GPU.

> **⚠️ Ask AI needs two separate parts.**
>
> 1. **This plugin**, installed from the Signal K App Store.
> 2. **An AI container** ([`docker-compose.gemma.yml`](docker-compose.gemma.yml) or
>    another compose file), deployed by you on the same host or elsewhere on the
>    network. It runs the model and is **not** part of the App Store install.
>
> With only the plugin there is nothing to answer; with only the container nothing
> reaches Signal K. **Watchkeeper is the exception**: it runs inside the plugin, so
> the plugin alone is enough for it.

## Experimental

This is an experimental study plugin for testing and evaluating AI-assisted vessel
monitoring. It is not a safety-critical navigation system, an authoritative
decision-maker or a replacement for the alarms already on the boat.

## What you can do

**Ask AI**

- ask about the vessel in plain language, with the Signal K paths you choose
- include recent history from the Signal K History API, for trend questions
- watch the answer stream in, and see exactly what was sent to the model
- see whether the model runs on the GPU, and how fast it generates

**Watchkeeper**

- values far from their learned normal, sensors that stop or freeze, states never
  seen before, pumps cycling more than usual
- tanks and batteries trending toward empty, values heading for their zones
- GNSS positions that dead reckoning, a second receiver or the fix's own quality
  do not corroborate (jamming and spoofing)
- redundant sensors that disagree, or a source that fails over to another
- your own limits in plain words: *"tell me if the coolant goes above 95 for 2
  minutes"*

## Quick start

1. Start an AI container (see below) and make sure it has a model.
2. In Signal K, open the plugin's configuration and set the inference host URL and
   model name.
3. Open the plugin's web app, press **Browse available paths** and save the paths
   the model should see.
4. Write a question and press **Ask AI**.
5. Optional: turn on **Watch all Signal K paths (Watchkeeper)** in the plugin
   configuration. It learns for 30 minutes, then watches on its own.

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

- **Watchkeeper**: active incidents with trend lines, **Mute 1 h** and **Not
  useful**, your own plain-language watches, **Watch report**, **Most unusual
  now**, **What is watched?** and a 24-hour replay.
- **Signal K**: login state and vessel ID.
- **Inference server**: URL, model, availability and timeout, with a setup link
  when the server cannot be reached.
- **AI Path Selection**: which paths are sent to the model. **Browse available
  paths** lists what this vessel publishes; tick and save. The selection is made
  here, not in the plugin settings. When the context window is full, paths that
  do not fit are left out (and the prompt says how many), so select what the
  model needs rather than everything.
- **History Context**: the history window, the last read, and **Browse recorded
  paths**.
- **GPU Acceleration**: whether the model is fully on the GPU, and the board's
  power mode, clocks and temperature when Signal K runs on a Jetson.
- **AI Response** and **Ask AI History**: the answer, earlier questions, and the
  exact request sent for each.

On a server with security enabled, saving selections, watches and mutes needs a
login with write access.

## Watchkeeper

Every check is a small statistical computation on the CPU, a few microseconds
per update, and every message is a template filled with measured values. It keeps
working with the inference server down. The model is used only when you ask:

- **Ask AI about this** on an incident, and **Ask AI for a logbook entry** on the
  watch report, put a question in the Ask AI box for you to read and send.
- A plain-language watch the built-in parser cannot read can be passed to a
  model (`watchRuleAssist`), which picks from a short list of real paths with its
  answer held to a fixed format.

What makes it work on any boat:

- **Nothing is configured per vessel.** Every published path is picked up and
  classified from its own values and metadata. **What is watched?** shows what
  was found and which checks this boat's data supports.
- **Operating states.** Engine starts, charger modes and `navigation.state` are
  recognised, so expected changes re-learn instead of alerting. Each path keeps a
  baseline per state, so a restarted engine is judged against how it normally
  runs.
- **Findings become incidents**, earliest sign first, and are published as Signal
  K notifications under `notifications.aiBridge.watch.*` at `warn` or `alert`
  (never `alarm` or `emergency`). KIP, Freeboard, WilhelmSK and any other
  notification consumer show them with no setup.
- **It learns from you.** **Not useful** makes a path need a bigger change before
  its level, source-disagreement or dropout checks report again; **Restore**
  undoes it. Other findings, such as a stuck sensor, are not affected: mute
  those.
- **Tune before trusting it.** **Replay last 24 h** runs a fresh watch over
  recorded history and shows what it would have raised.

The full reference covers every check and threshold, the rule format, the HTTP
API and tuning:
[docs/watchkeeper.md](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/watchkeeper.md).

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
| `watchEnabled` | Turn on Watchkeeper. |
| `watchSensitivity` | `low`, `normal` or `high`. |

All settings are described in
[docs/settings.md](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/settings.md),
which links to the history and Watchkeeper settings.

## Documentation

| | |
| --- | --- |
| [Watchkeeper reference](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/watchkeeper.md) | Every check, the rules, the HTTP API, tuning and limitations |
| [GPU, Jetson and choosing a model](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/jetson.md) | Model sizes per board, keeping the model on the GPU, power modes, TensorRT-LLM, testing on a Jetson |
| [How Ask AI builds its request](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/how-it-works.md) | Streaming, the prompt budget, units, model names |
| [Vessel history](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/history.md) | Sending History API data with a question |
| [Plugin settings](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/settings.md) | Ask AI and GPU settings, with links to the history and Watchkeeper ones |
| [Development](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docs/development.md) | Building, previewing without a boat, tests, CI and publishing |
| [Changelog](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/CHANGELOG.md) | What changed, and why |

## Licence

Apache-2.0. See [`LICENSE`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/LICENSE).
