# Plugin settings

The Ask AI and GPU settings in the plugin's configuration page, and what each one
does. The History API settings are described with the feature, in
[Vessel history](history.md#settings).

- `baseUrl`
  Ollama server URL. Default: `http://localhost:11434`

- `model`
  Ollama model name. Example: `gemma4:e2b-it-qat`

- **AI data paths** — chosen in the web app, not here
  Open the plugin's web app, press **Browse available paths** in the `AI Path
  Selection` card, tick what the model should see, and save. The picker lists
  what this vessel is actually publishing — branch wildcards first, then the
  individual leaves they cover — which is why the choice lives there and not in
  this settings form. Prefer a wildcard for a whole branch: it is flattened,
  unit-converted and budgeted leaf by leaf, where a bare branch name is sent as
  one raw subtree. On a server with security enabled, saving needs a login with
  write access

- `historyEnabled`
  Also send recent history for the selected paths, read from the Signal K
  History API. See [Vessel history](history.md)

- `requestTimeoutMs`
  How long the plugin waits for Ollama. Allow for a cold model load plus the
  answer: measured on a Xavier NX, ~47 s to load and ~20 s of prompt evaluation
  before the first token, so 120 s is tight and 180 s comfortable. `0` disables
  the timeout entirely, which leaves nothing to stop a wedged backend. Metadata
  calls — listing models, reading GPU residency — are bounded separately, at
  this value or 15 s, whichever is lower, so a wedged backend cannot hold the
  status page for the whole chat timeout

- `systemPrompt`
  Instructions sent to the model before your question. The default is tuned
  against measured failures — negated alarm answers, silently skipped values,
  whole-context recitals — so prefer adding to it over replacing it, and do not
  ask for unit conversions: see [Units](how-it-works.md#units)

- `temperature`
  Lower values are more stable and literal. Higher values are more varied

- `topP`
  Additional output randomness control

- `maxTokens`
  Maximum tokens the model may generate (`num_predict`). It does not size the
  context window, but it is capped at half of `numCtx`: the prompt and the
  answer share the window, and llama.cpp resolves a conflict by truncating the
  *prompt*. Half a window is already generous for a vessel summary — a few
  hundred tokens is typical — so lower it if you want shorter answers, and raise
  `numCtx` if you want longer ones

- `numCtx`
  Context window in tokens (`num_ctx`). This is what sizes the KV cache, and
  therefore whether the model stays resident on the GPU. It also sets how much
  vessel context the plugin will send: see [Prompt size](how-it-works.md#prompt-size)

- `gpuAutoTune`
  Force every layer onto the GPU on start and shrink `numCtx` until the whole
  model is resident, falling back to the backend estimate only if it cannot fit

- `numGpu`
  Layers offloaded to the GPU (`num_gpu`). `-1` lets the auto-tuner drive; an
  explicit value overrides it, with `0` forcing CPU-only and `999` full offload

- `numBatch`
  Tokens evaluated per GPU batch (`num_batch`). This sizes the prompt-eval
  compute buffers, so on a small unified-memory board it is usually the first
  setting to lower when a question fails with `CUDA error: out of memory`. 512
  is the backend's own default, but it is not safe everywhere: on a Xavier NX
  (8 GB, Volta) it fails reliably at `numCtx` 8192, where 256 is stable. Values
  above `numCtx` are clamped to it

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

