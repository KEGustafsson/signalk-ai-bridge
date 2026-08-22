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

### Fixed

- A non-numeric `status_code` on a backend error no longer produces a
  `NaN` HTTP status on the plugin's own routes.

## [0.1.0-beta.1]

- Initial experimental release: `Ask AI` panel, Signal K path selection, Ollama
  chat bridge, request history and AI availability reporting.
