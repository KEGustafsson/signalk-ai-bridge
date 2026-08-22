# Changelog

All notable changes to `signalk-ai-bridge` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/).

## [0.2.0-beta.1]

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
- **Model preload on start.** The plugin warms the model into GPU memory when it
  starts (`warmupOnStart`), so the first operator question does not pay a
  multi-second cold load from Jetson storage.
- **TensorRT-LLM backend.** A `backend: tensorrt-llm` option talks to any
  OpenAI-compatible NVIDIA server (`trtllm-serve`, NIM) with an optional API
  key, for engines compiled ahead of time for the local GPU.
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
