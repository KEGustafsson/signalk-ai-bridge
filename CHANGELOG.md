# Changelog

All notable changes to `signalk-ai-bridge` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **The board's GPU generation is now read and reported.** L4T has no
  nvidia-smi, so the Tegra GPU's device-tree node name (`gv11b` on Xavier,
  `ga10b` on Orin, `gp10b`/`gm20b` on TX2/TX1) is the only thing on the board
  that identifies the GPU. The telemetry maps it to an architecture and compute
  capability, and the GPU Acceleration card shows both.
- **Selecting TensorRT-LLM on a board that cannot run it now says so.**
  TensorRT-LLM compiles for SM 8.0 and newer; on a Xavier (7.2) it is not a
  setting to tune but an impossibility. The panel previously showed only
  "TensorRT-LLM is unreachable", which reads as "the container has not started
  yet" rather than "no such container can start here". The warning is raised
  only for a loopback backend — a Xavier may legitimately ask an Orin elsewhere
  on the boat for answers, and the local GPU says nothing about that one.

### Fixed

- **Every streamed question failed with "Bridge stream ended without a
  result".** The stream route treated `req.on('close')` as a client-disconnect
  signal, but on Node 16 and newer an `IncomingMessage` emits `close` as soon as
  the request body has been fully received — not when the client goes away. On
  the Node 26 that signalk-server ships, that fires while `readJsonBody()` is
  still draining the body, so the abort signal was already set before generation
  started: `writeLine()` suppressed every token *and* the final result, and the
  catch block stayed silent because the signal claimed the client had left. The
  panel therefore received a completely empty stream for every question. The
  route now watches the response instead — `res` is the object whose lifetime
  tracks the client, and `writableFinished` separates a client that hung up from
  a response the server finished itself. Verified both ways on Node 26.
- **Every Ollama compose file restart-looped and never started.** Compose
  word-splits a string `command` shell-style, so the inner double quotes of
  `echo "model pull attempt $n failed; retrying"` closed the outer argument:
  the script reaching `sh -c` was truncated mid-`until` loop and died with
  `Syntax error: end of file unexpected (expecting "done")`, over and over,
  before `ollama serve` ever ran. `docker-compose.xavier.yml`,
  `docker-compose.jetson.yml` and `docker-compose.gemma.yml` carried the same
  line. All three now pass the script as a YAML block scalar in list form, so
  Compose does no splitting and the quoting is the shell's business alone.
- **The compose files never pulled a model, and never said so.** The
  "do we already have a model?" guard was `ollama list | grep -q .`, but
  `ollama list` prints a `NAME ID SIZE MODIFIED` header even on an empty store,
  so the guard was unconditionally true: the pull loop was skipped entirely and
  the `no model available` fallback never printed either. It was invisible until
  the syntax error above was fixed, because the script had never run at all. The
  header is now dropped before the test.
- **`docker-compose.xavier.yml` talked operators out of flash attention.** The
  comment claimed Volta lacked "the Ampere tensor-core path", but Volta is the
  generation that introduced tensor cores and llama.cpp's `ggml-cuda/fattn.cu`
  carries an explicit `cc == VOLTA` branch that uses them. Worse, the invitation
  to "drop both if you see instability" would also have disabled
  `OLLAMA_KV_CACHE_TYPE=q8_0`, since Ollama honours a quantized cache only with
  flash attention on — doubling the KV cache on the board with the least
  bandwidth to absorb a CPU spill.

### Documented

- **Why Ollama is the maximal path on Xavier NX, not a fallback.** The arm64
  `ollama/ollama` image ships a `cuda_jetpack5` runner built with
  `CMAKE_CUDA_ARCHITECTURES` `72;87`, so Volta gets native sm_72 SASS rather
  than JIT-compiled PTX or a CPU runner, and the compose file selects it both
  via `JETSON_JETPACK=5` and via the `/etc/nv_tegra_release` mount.
- **Why a 20 W power mode matters on Xavier NX.** Every mode on that board caps
  the GPU at the same 1109 MHz and gates the same TPC, so the mode buys no
  shader clock at all. The three 20 W modes alone raise EMC from 1600 to
  1866 MHz, and token generation is memory-bandwidth bound — the memory
  controller is the entire reason to prefer them.

## [0.2.0-beta.1]

### Fixed

- **The admin-UI panel never loaded.** `package.json` declares `"type":
  "module"`, so signalk-server emits `<script type="module"
  src=".../remoteEntry.js">` — but the Vite config named the ESM container
  `esmRemoteEntry.js` and left `remoteEntry.js` as the `var` IIFE. A module
  script creates no global and the IIFE exports nothing, so the admin UI
  reported "Module ... is not available". The panel is only ever loaded
  directly by the tests and by `scripts/preview-host.mjs`, which is why nothing
  caught it; `scripts/smoke-test.mjs` now asserts the container shape.
- **The GPU auto-tuner missed real out-of-memory failures.** Ollama refuses an
  over-large model with `model requires more system memory (...) than is
  available (...)`, and the kernel OOM-killer case arrives as `signal: killed`.
  Neither matched, so the ladder treated a fit failure as a broken backend and
  never halved the context — the one case it exists for.
- **The tuner shrank the context on hardware with no GPU to win.** With
  `numGpu: 0` (a documented CPU pin) `/api/ps` reports no VRAM, which read as
  "spilled", so the ladder halved four times and pinned every later request to
  the smallest window for the life of the process. It now stops when no layer
  reached the GPU at full context, and the give-up path restores the configured
  window rather than keeping the smallest one it tried.
- **Distances and positions were multiplied by 180/π.** The angle heuristic
  matched any path *segment* starting with `course`/`track`/…, and under `/i`
  the character class also matched `.`, so every leaf beneath
  `navigation.courseGreatCircle.*` was converted: a 1852 m leg reached the
  model as `106111.783658`. Matching is now on the leaf segment against an
  explicit list.
- **A wildcard selection sent raw envelopes and unconverted angles.** The
  wildcard branch flattened `{value, timestamp, $source, meta}` instead of
  unwrapping it, so keys ended in `.value` — which meant the angle conversion
  never fired for wildcards, and `meta` plus one copy per conflicting source
  went into the prompt. Leaves are now unwrapped, the timestamp is kept as
  `<path>@` so the model can see staleness, and `meta`/`$source` are dropped.
- **A stopped plugin kept answering.** Express cannot unmount a subrouter, so
  every route stayed live after `stop()` and fell back to the *default* config
  — `enabled: true` against `http://localhost:11434`. All five routes now
  return 503 while stopped, and reach no backend.
- **A warm-up could write tuning state for a configuration that no longer
  existed.** The generation guard covered only the status string, and the state
  key omitted `numCtx`/`numGpu`/`gpuAutoTune`, so lowering `num_ctx` after an
  out-of-memory error and restarting silently kept the old window.
- **A failed re-tune left the plugin worse off than before.** `/ai/retune`
  cleared the measured state up front, so a re-tune against an unreachable
  backend dropped it back to the settings the tuner had already rejected. The
  previous result is now restored on failure, and the availability cache is
  cleared so a re-tune moments after starting Ollama is not answered from a
  stale probe.
- **A stalled stream was reported as an unknown error.** The timeout-to-`code`
  translation covered only the header phase, but for a streamed answer the body
  *is* the response, so a peer going quiet mid-answer surfaced as a bare
  `AbortError` and mapped to 502 instead of 504.
- **TensorRT-LLM streams lost tokens.** CRLF-framed events never matched the
  `\n\n` boundary, so a conforming server yielded nothing and fell back to a
  second full generation; and the final event was dropped when the peer closed
  without a trailing blank line, truncating the answer while presenting it as
  complete. A server that ignores `stream: true` is now read from the body
  already received rather than generating a second time.
- **A cancelled question kept the GPU busy.** `/bridge/stream` never noticed a
  client disconnect, so the accelerator finished an answer nobody could read
  while holding the single Ollama slot the Jetson compose files configure.
- **`num_predict` could exceed the whole context window.** It was clamped
  independently of `num_ctx`, so after the tuner shrank the window llama.cpp
  dropped the prompt mid-answer instead of erroring.
- **The KV cache hint gave inverted advice.** The match was symmetric, so
  ordinary compute buffers pushed the observation into the next larger
  candidate and an already-quantized cache was reported as `f16`. Matching is
  now one-sided, ambiguous footprints report nothing, and sliding-window models
  (Gemma 3/4) are declined outright — the whole-context formula overestimates
  them several times over.
- **The start-up status claimed a GPU placement it had not measured.** It read
  the *requested* layer count, so it printed "all layers on GPU" even when the
  plugin's own telemetry reported a spill or could not read residency at all.
- **The context sent to the model was unbounded.** Roughly 300 configured leaf
  paths already exceeded the default `num_ctx`, and llama.cpp answers by
  silently dropping the oldest context. It is now capped, with the number of
  omitted paths stated in the prompt.
- Smaller: `parseInt` in the config clamps turned `1e300` into `1` (a 1 ms
  timeout); `formatBytes` rendered `"512.0 undefined"` below one byte;
  malformed and oversized request bodies returned 502 with internal parser text
  instead of 400; non-string prompts were coerced (`[object Object]`) or threw;
  cyclic or very deep Signal K values blew the stack; the panel refetched
  `/ai/status` on every parent render; and a non-2xx response leaked its abort
  timer, listener and pooled connection.

### Security

- `POST /ai/retune` is single-flight and serialized against inference. It loads
  and unloads the model up to four times, so concurrent calls interleaved those
  loads in the same unified memory and raced each other's result — ten at once
  produced seventy model preloads. Inference now also waits for an in-flight
  re-tune rather than being torn down mid-answer by the reload.
- The accumulated answer is capped. `requestTimeoutMs: 0` is documented as
  "disable the timeout", after which a backend that never stops streaming had
  nothing to stop it.
- Credentials are stripped from `baseUrl` before `/ai/status` serializes it.
- The Ollama and TensorRT-LLM ports in every compose file now bind
  `127.0.0.1`. Docker publishes to `0.0.0.0` by default *and* bypasses the host
  firewall, which put an unauthenticated inference API — including
  `POST /api/pull` and `DELETE /api/delete` — on the boat's LAN.
- `apiKey` is rendered with a password widget instead of a cleartext field.

### Changed

- `react` and `react-dom` move to `devDependencies`: Vite bundles them into
  `public/`, and nothing in the shipped CommonJS resolves them. A production
  install drops from 7.8 MB to 1.8 MB, which is real storage on a Jetson.
- The TensorRT-LLM image is pinned. There is no `latest` tag in that NGC
  repository, so `docker compose up` failed with `manifest unknown`; a
  serialized engine is also tied to the exact runtime version that built it.
  The compose command now points at the checkpoint directory it actually
  serves, and the whole TensorRT path is marked unverified-on-hardware.
- `TRTLLM_CUDA_ARCHS` is gone from the build script — it is not a TensorRT-LLM
  variable and provided none of the protection its comment claimed. The GPU's
  compute capability is checked against `nvidia-smi` instead.
- The compose files forward SIGTERM to `ollama serve`, wait 30 s for it, and
  retry a failed model pull three times: `sh -c "... & wait"` without a trap
  orphaned the server, so a shore-power cut during the initial pull corrupted
  `ollama_data`.
- The test runner passes `--test-timeout=30000` and CI jobs are bounded at 15
  minutes. A regression in the request-bounding code turns a failing test into
  one that never settles, and this suite has hung that way before.
- Compose files are published in the npm tarball; the README references them by
  bare filename.
- Both Jetson compose files drop the `deploy.resources.reservations.devices`
  block. Compose turns it into a `--gpus` device request, which on L4T needs CDI
  specs that the documented `apt-get install nvidia-container-toolkit` does not
  generate — the container then refuses to start at all. `runtime: nvidia` is
  the supported form on Tegra.
- GGUF geometry and weight size are cached per model tag. They cannot change
  without the model being re-pulled, but were re-fetched on every `/ai/status`,
  and the weight lookup hit `/api/tags` a second time — defeating the
  availability cache in front of the first call. Three status polls cost ten
  backend round trips; they now cost six, with `/api/ps` still read live.

### Added

- **NVIDIA Jetson / CUDA acceleration controls.** New plugin settings for
  `num_ctx`, `num_gpu`, `num_batch`, `num_thread` and `keep_alive`, so the
  request shape can be matched to the GPU it runs on instead of relying on
  whatever llama.cpp guesses.
- **GPU residency reporting.** `/ai/status` now reads Ollama's `/api/ps` and
  reports whether the model is fully on the GPU, partly spilled to the CPU, or
  running on the CPU alone, with a concrete remedy in the message. The embedded
  panel shows this as a `GPU Acceleration` card.
- **Generation throughput.** Responses carry `performance.tokensPerSecond`,
  `loadMs`, `promptEvalMs` and `evalMs` derived from Ollama's timings — the
  fastest way to see a CPU fallback that nothing else reports.
- **Automatic GPU offload maximization.** On start the plugin now requests full
  offload (`num_gpu` = all layers) and measures what actually landed on the GPU.
  If any layer spilled to the CPU it halves the context window and reloads, up
  to three times, and only hands the split back to the backend's estimator when
  the model cannot fit at all. Controlled by `gpuAutoTune`; an explicit `numGpu`
  always overrides it. A mid-flight allocation failure retries once at half the
  context instead of failing the operator's question.
- **Jetson board telemetry.** When Signal K runs on the Jetson itself, the panel
  reports board model, JetPack/L4T version, `nvpmodel` power mode, GPU load,
  clock against maximum and GPU temperature — with the exact command to run when
  a reduced power mode or thermal limit is holding the GPU back. Absent, at no
  cost, on any other host.
- **INT4-AWQ TensorRT-LLM engine build script.** `scripts/build-trtllm-engine.sh`
  quantizes and builds an engine for SM 8.7, the configuration that makes most
  use of the Orin's Tensor cores.
- **Streaming responses.** The answer now appears token by token as the model
  generates it, over a new `POST /bridge/stream` NDJSON route. Throughput is
  unchanged — the GPU generates at the same rate — but on a Jetson producing
  tens of tokens per second, a long vessel summary goes from a spinner to
  visible text in a few hundred milliseconds. Falls back to the blocking route
  when streaming is unavailable, and a mid-stream failure surfaces as an error
  rather than replaying and duplicating text.
- **KV cache configuration hint.** Ollama exposes no endpoint reporting its own
  settings, so the plugin now infers the cache type arithmetically: model
  geometry from `/api/show`, weight size from `/api/tags` and resident size from
  `/api/ps`. When the footprint matches an unquantized f16 cache it says so, and
  reports the memory `OLLAMA_FLASH_ATTENTION=1` plus `OLLAMA_KV_CACHE_TYPE=q8_0`
  would free. Reported as an estimate, and silent when it cannot tell.
- **TensorRT-LLM streaming.** The OpenAI backend now streams over SSE with
  `stream_options.include_usage`, so it reports token counts like the blocking
  path does. Previously only Ollama streamed.
- **`POST /ai/retune`.** Re-measures the GPU fit from the configured settings
  without restarting the plugin, since the start-up tuner only ever shrinks the
  context window and never grows it back within a run.
- **Model preload on start.** The plugin warms the model into GPU memory when it
  starts (`warmupOnStart`), so the first operator question does not pay a
  multi-second cold load from Jetson storage.
- **TensorRT-LLM backend.** A `backend: tensorrt-llm` option talks to any
  OpenAI-compatible NVIDIA server (`trtllm-serve`, NIM) with an optional API
  key, for engines compiled ahead of time for the local GPU.
- **Jetson Xavier NX support.** `docker-compose.xavier.yml` for JetPack 5, and
  the host telemetry now works on the older board: the GPU node is found by
  scanning for any Tegra GPU device-tree name (`ga10b` on Orin, `gv11b` on
  Xavier, `gp10b`/`gm20b` on TX2/TX1) instead of matching only `gpu`, which
  silently found nothing on every board except Orin. Power-mode ranking no
  longer requires a `MAXN` entry — Xavier NX names its modes by budget and core
  count, so the highest wattage wins with core count breaking ties.
  TensorRT-LLM remains Orin-only; Xavier's compute capability 7.2 is below its
  8.0 floor.
- **Jetson compose files.** `docker-compose.jetson.yml` (Ollama with the NVIDIA
  container runtime, flash attention and a quantized KV cache) and
  `docker-compose.tensorrt.yml` (TensorRT-LLM OpenAI server).
- **Official Signal K plugin CI.** `.github/workflows/plugin-ci.yml` calls the
  canonical `SignalK/signalk-server` reusable workflow, including a live
  `signalk-server` integration test. The armv7 (Venus OS) leg is disabled — the
  plugin targets hosts with an NVIDIA GPU.
- Package metadata required by the Signal K App Store and plugin registry:
  `repository`, `homepage`, `bugs`, `engines.node`, `signalk.screenshots`, and a
  published `assets/` directory.
- **Apache-2.0 licence.** `LICENSE` and the `license` field in `package.json`,
  which npm previously warned about on publish.

### Changed

- **Roughly half the prompt tokens.** Prompt evaluation is GPU work, so the
  context sent to the model is now compact JSON rather than two-space indented,
  numbers are rounded to 6 decimals, and the configured path list is no longer
  repeated alongside data that is already keyed by path — only paths that
  produced no value are listed, which is what the system prompt actually needs.
  Measured at about 20% fewer characters on a typical wildcard selection; the
  token saving is smaller still, since tokenizers encode runs of leading spaces
  efficiently and indentation is the largest single component. The context
  returned to the panel is unchanged.
- **`maxTokens` no longer sizes the KV cache.** It now maps to `num_predict`
  only; the context window is the separate `numCtx` setting. The previous
  behaviour requested a 131072-token context on every request, which on 8 GB of
  Jetson unified memory forced llama.cpp to drop layers back to the CPU — the
  model ran, just without the GPU. New defaults are `numCtx: 8192` and
  `maxTokens: 2048`.
- **Availability probes are cached and de-duplicated.** Concurrent `/ai/status`
  callers now share one backend round trip, and results are reused for a few
  seconds instead of polling the inference server from every open panel.
- Backend-facing messages name the configured backend (Ollama or TensorRT-LLM)
  rather than always saying Ollama.
- `/ai/status` reports the accelerator settings requests will actually use
  (post-tuning), alongside `configuredNumCtx` for what was asked for.
- `docker-compose.jetson.yml` pins `OLLAMA_SCHED_SPREAD=0` and gained a
  healthcheck.

### Fixed

- A non-numeric `status_code` on a backend error no longer produces a
  `NaN` HTTP status on the plugin's own routes.
- Message text is no longer trimmed per streamed fragment, which would have
  welded words together at chunk boundaries.
- `requestTimeoutMs` now bounds the whole exchange. The abort timer was cleared
  once response headers arrived, so a peer that stalled mid-body never timed out
  — which for a streamed answer is the entire response.
- A fixed five-second delay before `ollama pull` in the compose files could fail
  on slower storage and restart-loop the container. Both now poll for readiness,
  and a failed pull no longer takes the server down.
- `docker-compose.tensorrt.yml` now serves the engine directory
  `scripts/build-trtllm-engine.sh` actually produces; the two disagreed.
- The TensorRT-LLM path no longer retries on timeouts or 5xx responses, which
  cost two inference calls and two timeout windows. Its model resolution also
  now works: it falls back to the single served id, since `trtllm-serve` derives
  ids from engine paths that never match Ollama-style tag or family rules.
- Plugin status no longer claims "all layers on GPU" when `numGpu` is pinned
  to 0 (CPU-only).
- Jetson telemetry no longer advises a power-mode change when the reported
  `pmode` id is absent from `nvpmodel.conf` and its name cannot be resolved.
- An injected host-telemetry probe that rejects no longer turns `/ai/status`
  into a 500.
- Panel status text derives from the configured backend instead of naming
  Ollama unconditionally, and the Ollama Docker Compose help is hidden for a
  TensorRT-LLM backend.

## [0.1.0-beta.1]

- Initial experimental release: `Ask AI` panel, Signal K path selection, Ollama
  chat bridge, request history and AI availability reporting.
