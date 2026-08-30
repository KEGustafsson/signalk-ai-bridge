# signalk-ai-bridge

[![signalk-plugin-ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/plugin-ci.yml)
[![ci](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-ai-bridge/actions/workflows/ci.yml)

`signalk-ai-bridge` is a Signal K plugin that adds an `Ask AI` panel to the Signal K web UI.

It lets you send selected Signal K vessel data to a local Ollama model such as Gemma, then read the response directly in the browser.

## Two Parts, Both Installed Manually

This project has two separate parts, and **both must be in place before anything works**:

1. **The Signal K plugin** — `signalk-ai-bridge`, installed into your Signal K server
   (Signal K App Store, or manually from this repository). It provides the `Ask AI`
   panel and the plugin configuration.
2. **The AI container** — a separate AI server (Ollama, or TensorRT-LLM) that you run
   yourself, on the same host or on another machine on the network. This project does
   not ship or start it for you; see
   [Ollama With Docker Compose](#ollama-with-docker-compose) for ready-made compose files.

Neither part installs the other. The plugin only talks to the AI server over HTTP, so
you install and start the AI container separately, then point the plugin at its URL in
the plugin configuration. If the AI server is not running, or the plugin is not
configured with its address and a model that server has, the `Ask AI` panel will not
return answers.

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
- watch the answer stream in as the model generates it
- see whether the model is actually running on the GPU, and how fast it generates

## What You Need

- a running Signal K server
- this plugin installed in Signal K
- a running Ollama server
- a locally available Ollama model, for example `gemma4:e2b-it-qat`

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
| [`docker-compose.nano-super.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.nano-super.yml) | NVIDIA Jetson Orin Nano Super (JetPack 6). Ollama with the NVIDIA container runtime, flash attention and a quantized KV cache. |
| [`docker-compose.xavier.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.xavier.yml) | NVIDIA Jetson Xavier NX (JetPack 5). Same, adjusted for the older JetPack. |
| [`docker-compose.tensorrt.yml`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.tensorrt.yml) | NVIDIA TensorRT-LLM served over the OpenAI API, for engines compiled ahead of time for the local GPU. |

Start one with:

```bash
docker compose -f docker-compose.gemma.yml up -d
```

The Ollama compose setups pull a model during startup, so you do not need to run a
separate `ollama pull` command. Which one depends on how much memory the board has
left for it: `gemma4:e2b-it-qat` on any host with room for 4.3 GB of weights, and
`qwen3.5:2b-q4_K_M` on an 8 GB Xavier NX, which does not have that room. See
[Choosing a model](#choosing-a-model).

If Signal K runs on the host, the default Ollama URL `http://localhost:11434` is usually correct.

If Signal K runs in another container, use an address reachable from that container, for example `http://ollama:11434` on a shared Docker network.

## NVIDIA Jetson

Tested targets are the Orin Nano Super (JetPack 6) and the Xavier NX developer
kit (JetPack 5). The plugin itself is hardware-agnostic — it talks to Ollama over
HTTP and never branches on the board — so anything Ollama runs on will work. What
differs per board is the deployment file and what the telemetry can read.

| | Orin Nano Super | Xavier NX |
| --- | --- | --- |
| Compute capability | 8.7 (Ampere) | 7.2 (Volta) |
| Memory | 8 GB LPDDR5, 102 GB/s | 8 GB LPDDR4x, 59.7 GB/s |
| JetPack | 6 (L4T 36.x) | 5.1.x (L4T 35.x) — JetPack 6 dropped Xavier |
| Host image | JetPack | headless Yocto/meta-tegra |
| Compose file | `docker-compose.nano-super.yml` | `docker-compose.xavier.yml` |
| Recommended model | `gemma4:e2b-it-qat` (4.3 GB) | `gemma4:e2b-it-qat` (4.3 GB) |
| Top power mode | `MAXN_SUPER` | highest wattage, usually `MODE_20W_6CORE` |
| TensorRT-LLM | supported | **not supported** — needs compute capability 8.0+ |

Generation is memory-bandwidth bound, so expect roughly 55-65% of the Orin Nano
Super's tokens per second on a Xavier NX with the same model. The GPU tuning
matters more there, not less: the same 8 GB budget with less bandwidth to make up
for a spill to the CPU.

Xavier NX has two NVDLA engines that Orin Nano lacks, but llama.cpp cannot use
DLA — it is a fixed-function accelerator for convolutional networks — so it buys
nothing for this workload.

Losing TensorRT-LLM does not mean losing CUDA on Xavier. The arm64 `ollama/ollama`
image ships a `cuda_jetpack5` runner compiled with `CMAKE_CUDA_ARCHITECTURES`
`72;87`, so Volta gets native sm_72 machine code rather than JIT-compiled PTX or a
CPU fallback, and `docker-compose.xavier.yml` selects that runner both by
`JETSON_JETPACK=5` and by the `/etc/nv_tegra_release` mount. Flash attention is a
tuned path there too, not a degraded one: llama.cpp's `ggml-cuda/fattn.cu` has an
explicit Volta branch that uses the tensor cores this generation introduced. Ollama
with the settings in that file is the fastest thing this board can run — there is
nothing further to move it to.

If you point `backend` at `tensorrt-llm` on a pre-Ampere board anyway, the GPU
Acceleration card now says the GPU is too old rather than reporting the server
unreachable, which is the difference between "not started yet" and "cannot start".

The plugin does no inference itself — all of the compute happens in Ollama or
TensorRT-LLM. What the plugin controls is the shape of the request, and on a
Jetson that shape decides whether the model runs on the GPU at all.

The Orin Nano Super has 8 GB of LPDDR5 shared between CPU and GPU, so the KV
cache competes with the model weights for the same bytes. llama.cpp reserves the
KV cache from `num_ctx` up front; when the reservation no longer fits, it quietly
moves layers back to the six Cortex-A78AE cores. The model still answers — just
at a few tokens per second instead of tens, with nothing in the response saying
why.

### Choosing a model

The tuner can shrink the KV cache. It cannot shrink the weights, so the model
tag is the one decision it cannot make for you, and the wrong tag costs more
than every setting below it put together.

| Board | Pull this | Weights |
| --- | --- | --- |
| Orin Nano Super, 8 GB | `gemma4:e2b-it-qat` | 4.3 GB |
| Xavier NX, 8 GB, headless | `gemma4:e2b-it-qat` | 4.3 GB |
| Xavier NX, 8 GB, desktop image | `qwen3.5:2b-q4_K_M` | 1.9 GB |

**Quantization-aware training is why the Orin can run Gemma 4 at all.** The
plain `gemma4:e2b` tag is 7.2 GB even though it is labelled `q4_K_M`. Four-bit
weights for E2B's 5B total parameters would come to roughly 3 GB, so more than
half of that tag is not quantized transformer weights at all: it is the parts
four-bit quantization does not touch — the per-layer embedding tables that make
those 5B parameters 2.3B *effective*, and the vision and audio encoders E2B
carries for modalities this plugin never sends. 7.2 GB does not fit in 8 GB of
unified memory alongside the OS and Signal K, whatever `numCtx` is set to. The `-it-qat` build is 4.3 GB of the same model, trained expecting int4
rather than rounded down afterwards, and leaves room for the KV cache.

**What the host image costs you matters more than the board.** Both Jetsons
have the same 8 GB; what differs is how much is already spent when Ollama
starts. A headless Yocto/meta-tegra Xavier idles at a few hundred MB and leaves
around 6 GB free, so the 4.3 GB QAT build fits there as comfortably as on the
Orin — just at 55-65% of its tokens per second, roughly 14-16 against 25. A
JetPack desktop session costs 2.5-3 GB instead, which drops the ceiling to about
2.5 GB of weights and makes `qwen3.5:2b-q4_K_M` (1.9 GB) the right answer. Check
which case you are in with `free -h` before trusting the table above.

**Format matters as much as size on Volta.** Xavier's sm_72 has no bf16 and no
FP4 hardware, so the `-bf16` and `-nvfp4` tags in the same libraries are a larger
download for a slower path. Q4_K_M and QAT q4_0 GGUF are what this GPU executes.

**A long advertised context is not a reason to raise `numCtx`.** These models
advertise 128K and 256K windows; the KV cache reserved for them is exactly what
evicts layers to the CPU. Gemma 4 suffers less than most because its 4:1
local-to-global attention ratio keeps the cache nearly flat as the window grows,
but 8192 is still the right starting point on 8 GB.

Whatever you pull, the plugin's `model` field has to name it. The default is the
untagged `gemma4`, which resolves to any installed Gemma 4 tag, so both compose
files here need no configuration. Pulling outside that family — the
`qwen3.5:2b-q4_K_M` fallback above, say — means setting the field explicitly.

### Maximizing GPU use

The plugin does not accept whatever CPU/GPU split the backend estimates. On
start it asks for **full offload** (`num_gpu` = all layers) and then measures
what actually landed on the GPU. If any layer spilled to the CPU, it halves the
context window — the KV cache is the part of the footprint the plugin controls,
and it scales linearly with `num_ctx` — and loads again, up to three times.

Only if the model still will not fit at the smallest context does it hand the
split back to the backend's estimator, and say so. A model that genuinely cannot
fit must still answer, on the CPU if that is all there is, rather than failing
with an allocation error.

The panel shows the tuned result, for example:

> Context window: 4096 tokens (configured 8192)
> GPU layers: All (forced)
> Auto-tuned: Context window reduced to 4096 tokens so every layer fits in GPU memory.

Turn this off with `gpuAutoTune` if you would rather pin the settings yourself.
Setting `numGpu` explicitly always wins over the tuner, including `0`, which is
useful for a CPU-vs-GPU comparison.

### Is it actually accelerated?

The `GPU Acceleration` card answers this directly. It reads Ollama's `/api/ps`
and reports one of:

- **GPU accelerated** — the whole model is resident in GPU memory.
- **Partly on CPU** — some layers spilled; lower `numCtx` or use a smaller or
  more heavily quantized model.
- **CPU only** — no layers on the GPU; the container is missing the NVIDIA
  runtime or the GPU device reservation.
- **Model not loaded** — nothing resident yet; ask a question or leave
  `warmupOnStart` enabled.

Each AI response also reports `Generation speed` in tokens/second, which is the
quickest independent confirmation.

### Is the GPU running flat out?

Residency is not the whole story: an Orin held in a 15 W power mode, or
clock-capped by temperature, is fully GPU-resident and still delivering a
fraction of its throughput. When Signal K runs on the Jetson itself, the same
card reads the board's own sysfs and reports the model, JetPack/L4T version,
`nvpmodel` power mode, GPU load, clock against maximum, and GPU temperature —
with a warning and the exact command to run when any of them is holding the GPU
back. When Signal K runs elsewhere, this section is simply absent.

### Streaming

Answers stream token by token over `POST /bridge/stream` (newline-delimited
JSON), so the first words appear in a few hundred milliseconds instead of after
the whole answer is generated. This does not make the GPU faster — it changes
when you see the output. Both backends stream (Ollama's NDJSON and
TensorRT-LLM's SSE), and the panel falls back to the blocking route
automatically if streaming is unavailable.

### Prompt size

Prompt evaluation is GPU work, so the context sent to the model is kept tight:
compact JSON rather than indented, numbers rounded to 6 decimals (finer than any
sensor on a boat), and the data keyed by path instead of repeating the path list
alongside it. Paths that produced no value are listed separately, so the model
can still be explicit about what is missing. On a typical wildcard selection
this is roughly half the tokens the plugin used to send, on every request.

The context returned to the panel is unchanged — only what reaches the model is
compacted.

### Re-tuning without a restart

The start-up tuner only ever shrinks the context window. If memory is freed
later — another process exits, a smaller model is loaded — the reduced value
persists for the life of the run. `POST /plugins/signalk-ai-bridge/ai/retune`
discards the tuned state and measures the fit again. It is deliberately manual:
re-tuning reloads the model, which is not something to do unprompted mid-voyage.

### Squeezing the most out of the hardware

Roughly in order of what they buy on an Orin Nano Super:

1. `docker-compose.nano-super.yml` — NVIDIA runtime, flash attention and a q8_0 KV
   cache (`q4_0` halves the cache again if you need a larger context, at some
   cost to answer quality). Without the runtime there is no GPU at all; the other two are what make
   full residency achievable. If you run your own Ollama, the panel estimates
   whether the KV cache is quantized and tells you what enabling it would free —
   Ollama reports no configuration, so this is inferred from the resident
   footprint rather than read.
2. `sudo nvpmodel -m <MAXN id> && sudo jetson_clocks` — the panel names the id.
3. Leave `gpuAutoTune` on, so full offload is driven rather than hoped for.
4. `scripts/build-trtllm-engine.sh` — an INT4-AWQ TensorRT-LLM engine compiled
   for SM 8.7. This is the ceiling: a plan built for this exact device, with the
   Ampere Tensor cores doing four-bit matmuls.

The same thing from the command line:

```bash
curl -s localhost:11434/api/ps | jq '.models[] | {name, size, size_vram}'
```

`size_vram` must equal `size`.

### Host setup

```bash
sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker
sudo nvpmodel -m <id>   # the panel names the id for your board
sudo jetson_clocks

# Orin (JetPack 6)
docker compose -f docker-compose.nano-super.yml up -d
# Xavier NX (JetPack 5)
docker compose -f docker-compose.xavier.yml up -d
```

The power-mode id differs per board: Orin exposes `MAXN`/`MAXN_SUPER`, while
Xavier NX names its modes by budget and core count with no MAXN at all. The
plugin ranks them either way and names the id to switch to.

On a Xavier NX the ranking lands on a 20 W mode, and it is worth knowing that
the reason is memory rather than shaders: every mode on that board caps the GPU
at the same 1109 MHz and gates the same TPC, so the mode buys no GPU clock at
all. What the 20 W modes alone raise is EMC, from 1600 to 1866 MHz — and since
token generation is memory-bandwidth bound, that is the whole of the difference.

### Suggested plugin settings on 8 GB

| Setting | Value | Why |
| --- | --- | --- |
| `numCtx` | `8192` | Keeps weights plus KV cache inside unified memory. Raise to `16384` only if the card still reports GPU accelerated. |
| `maxTokens` | `2048` | Output budget only; it no longer resizes the KV cache. |
| `gpuAutoTune` | `true` | Force full offload and shrink the context until it fits, instead of accepting the backend's estimate. |
| `numGpu` | `-1` | `-1` lets the tuner drive. An explicit value overrides it: `999` forces full offload, `0` pins to CPU for comparison. |
| `numBatch` | `512` | Prompt-eval throughput on the Jetson iGPU, Ampere or Volta. |
| `keepAlive` | `30m` | Avoids re-reading several GB from storage on the next question. |
| `warmupOnStart` | `true` | Loads the model when the plugin starts, not when the operator asks. |

### TensorRT-LLM

**Orin only.** TensorRT-LLM requires compute capability 8.0 or newer; Xavier NX
is 7.2, so there is no engine to build or serve there. On Xavier, Ollama is the
whole story.

Set `backend` to `tensorrt-llm` and point `baseUrl` at an OpenAI-compatible
NVIDIA server (`trtllm-serve` or a NIM container); `model` is the id reported by
`GET /v1/models`, and `apiKey` is sent as a bearer token when set.

TensorRT-LLM compiles a CUDA engine ahead of time for this GPU's SM version
(8.7 on Orin) with a fixed maximum sequence length, so there is no runtime
CPU/GPU split to get wrong — but `numCtx` must stay at or below the engine's
`--max_seq_len`, because exceeding it is a request error rather than a silent
fallback.

Build the engine on the Jetson with
[`scripts/build-trtllm-engine.sh`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/scripts/build-trtllm-engine.sh),
which quantizes to INT4-AWQ and builds for SM 8.7:

```bash
docker run --rm -it --runtime nvidia \
  -v "$PWD/trtllm_models:/models" \
  -v "$PWD/trtllm_engines:/engines" \
  -v "$PWD/scripts:/scripts" \
  nvcr.io/nvidia/tensorrt-llm/release:latest \
  bash /scripts/build-trtllm-engine.sh
```

The engine must be built on the target board — it needs the local driver and the
GPU present, so it cannot be cross-built on a workstation. Calibration takes tens
of minutes; the result is reused on every start.

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
  Ollama model name. Example: `gemma4:e2b-it-qat`

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

- `gpuAutoTune`
  Force every layer onto the GPU on start and shrink `numCtx` until the whole
  model is resident, falling back to the backend estimate only if it cannot fit

- `numGpu`
  Layers offloaded to the GPU (`num_gpu`). `-1` lets the auto-tuner drive; an
  explicit value overrides it, with `0` forcing CPU-only and `999` full offload

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

If you configure `gemma4` but Ollama only has a tagged variant installed, such as `gemma4:e2b-it-qat`, the plugin will try to resolve and use the installed tagged model automatically. The default is deliberately untagged for this reason: it follows whichever Gemma 4 tag the board actually has.

That resolution only works within a family. A board running `qwen3.5:2b-q4_K_M` shares no family name with `gemma4`, so its model field has to be set explicitly.

If you already know the exact installed model name, configuring that exact name is the clearest option — and on an 8 GB board it is also the only way to be sure which tag you got, since `gemma4:e2b` and `gemma4:e2b-it-qat` differ by 2.9 GB of weights. See [Choosing a model](#choosing-a-model).

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

## Testing on a Jetson Before a Release

A pre-release branch has to be packed before it is installed. **Do not install
this plugin straight from a git URL** — the embedded webapp is built by the
`prepack` script, which npm does not run for git installs, so such an install
ships an `index.html` referencing bundles that are not there and the `Ask AI`
panel never loads.

Build a tarball first, then install that:

```bash
git clone -b <branch> https://github.com/KEGustafsson/signalk-ai-bridge
cd signalk-ai-bridge
npm install
npm pack                                 # runs the build; writes the .tgz
```

Then on the Jetson:

```bash
scp signalk-ai-bridge-*.tgz <jetson>:~
ssh <jetson> 'cd ~/.signalk && npm install ~/signalk-ai-bridge-*.tgz'
```

Restart Signal K afterwards and the plugin appears in the plugin list. Cloning
and packing on the Jetson itself works too; only the git-URL install is broken.

(The obvious fix — moving the build to a `prepare` script, which npm *does* run
for git installs — is not viable yet: npm 10 runs `prepare` even under
`--ignore-scripts`, and its lifecycle banner on stdout breaks the `JSON.parse`
of `npm pack --dry-run --json --ignore-scripts` in the official Signal K plugin
CI's pack check. Upstream says the same thing in that workflow's own comments —
"npm < 11 runs prepare here despite --ignore-scripts" — so this becomes safe to
change once the CI matrix is on npm 11. Re-tested against npm 10.9.7: the check
still fails with `Unexpected token 'v', "vite v6.4."...`.)

### What to check once it is running

1. Start the inference server for your board:
   - Orin Nano Super (JetPack 6): `docker compose -f docker-compose.nano-super.yml up -d`
   - Xavier NX (JetPack 5): `docker compose -f docker-compose.xavier.yml up -d`
2. Raise the power mode: `sudo nvpmodel -m <id> && sudo jetson_clocks`. The panel
   names the id when the current mode is capped. On Orin that is `MAXN_SUPER`;
   Xavier NX has no MAXN mode at all, so the highest wattage and core count wins
   — usually `MODE_20W_6CORE`.
3. Open the plugin's web UI and read the `GPU Acceleration` card. It should say
   **GPU accelerated**, with `In GPU memory` equal for both figures.
4. Ask a question. `Generation speed` should be in the tens of tokens/second on a
   4B-class model. Low single digits means the model is on the CPU regardless of
   what anything else claims.
5. If the card reports a partial offload, the auto-tuner has already shrunk the
   context as far as it will go — try `q4_0` for `OLLAMA_KV_CACHE_TYPE`, or a
   more heavily quantized model.

`POST /plugins/signalk-ai-bridge/ai/retune` re-measures the fit if you free
memory later without restarting the plugin.

## Licence

Apache-2.0. See [`LICENSE`](https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/LICENSE).

## Continuous Integration

Two workflows run on every push and pull request:

- **`signalk-plugin-ci`** calls the canonical
  [`SignalK/signalk-server` reusable plugin CI workflow](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml).
  It validates the plugin the way the Signal K server and App Store actually
  load it — package metadata, entry point, `schema()`, the start/stop/restart
  lifecycle, deprecated and internal API usage, `npm pack` contents and an
  `--ignore-scripts` App Store install — across Linux x64/arm64, macOS and
  Windows on Node 22 and 24, plus a live `signalk-server` install. The armv7
  (Venus OS / Cerbo GX) leg is disabled: this plugin targets hosts with an
  NVIDIA GPU, not 32-bit ARM.
- **`ci`** runs the repository's own smoke test, type check, unit tests and a
  production `npm audit`, and then packs the plugin, installs the tarball with
  production dependencies only and runs the suite again from there — which is
  how the plugin registry runs it.

The build and test commands declared to the reusable workflow are also what the
[Signal K plugin registry](https://signalk.org/signalk-plugin-registry/) reads
when it scores the plugin, so they are asserted by `npm run lint`.

### Publishing

The registry scores the **published package**, not this repository, so two
things about a release matter beyond the code in it:

- **Publish from a git checkout of `main`.** `npm publish` records the commit
  it published from as `gitHead`, and the registry needs that together with the
  `repository` field to find this plugin's `signalk-plugin-ci` run for the
  release. Publishing from an unpacked tarball or a tree without `.git` leaves
  `gitHead` unset, and the score takes a 10-point `no-plugin-ci` penalty for a
  workflow that did in fact run.
- **Keep the suite in the tarball.** The registry runs `npm test` inside the
  installed plugin. `npm run lint` asserts that everything it reads —
  `scripts/run-tests.mjs`, `test/`, `src/` and the two `tsconfig` files — is
  covered by `files` in `package.json`, and the `packaged-tests` CI job proves
  the suite still passes there with devDependencies absent.

`npm pack --dry-run` shows exactly what a release will contain.
