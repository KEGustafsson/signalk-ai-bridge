# Plugin settings

The settings form under **Server → Plugin Config → AI Bridge**, section by
section, with what each setting does in detail. The form itself keeps to short,
plain descriptions and links here.

Only two things usually need attention: the **Turn on AI Bridge** switch (on
by default) and the **AI model** section, which says where the model server is
and which model it runs. Everything else has working defaults.

AI Bridge needs a model server, which is not part of the plugin: Ollama by
default, installed and run separately (the compose files in this repository
are one way, see the [README](../README.md#running-the-model-with-docker-compose)),
or an OpenAI-compatible NVIDIA server such as `trtllm-serve` or a NIM container.

Which vessel data is sent is chosen in the plugin's web app, not in this form:
see [Path selections](#path-selections-chosen-in-the-panel) below.

## How the settings are stored

Each section of the form is a nested object in the plugin's options, and inside
a section a setting keeps the key it has always had:

```json
{
  "enabled": true,
  "aiModel": { "backend": "ollama", "baseUrl": "http://localhost:11434", "model": "gemma4", "keepAlive": "30m", "warmupOnStart": true },
  "answers": { "systemPrompt": "…", "temperature": 0.2, "topP": 0.95, "maxTokens": 2048, "requestTimeoutMs": 120000 },
  "history": { "historyEnabled": false },
  "advanced": { "numCtx": 8192, "numGpu": -1, "gpuAutoTune": true, "numBatch": 512, "numThread": 0 },
  "aiDataPaths": ["navigation.*", "notifications.*"],
  "historyPaths": []
}
```

The switch and the two path selections (`aiDataPaths`, `historyPaths`, written
by the panel) stay at the top level.

**Settings saved by an earlier version are moved into the sections on the
first start, and shown in the form from the start even while the plugin is
off.** Every version before the sections stored the settings flat
(`"model": "qwen3:4b"` at the top level). The admin page's form shows only
what the sections hold, so it would show the defaults instead, and its first
save would put them over the stored values. On start, the plugin therefore
moves each flat setting into its section, with its value unchanged, removes
the flat key, and stores the result once, through the same write queue as the
path selections. A value already in the section (written by the form) wins
over the flat one. The switch, the path selections and keys the plugin does
not know stay as they are. The server log gets one line naming the moved
settings:

```
signalk-ai-bridge: moved settings saved by an earlier version into their sections: baseUrl, model, numCtx.
```

Nothing is stored when nothing is flat, which is every start after the first.
Nothing is stored while the plugin is stopped, either. If the server cannot
store the result, the plugin runs on the moved settings, which are the same
values, and the next start tries again.

A plugin that is off is not started, so its flat settings stay where they
are until it is turned on. The form shows them all the same: each time the
admin page loads the plugin's settings, the plugin reads the stored options
(`app.readPluginOptions()`) and makes each flat setting the default of its
field, so the form shows the stored value and a save stores it in its
section. A stored value the field does not take (outside its range or
choices, or of the wrong type) is not shown: the field keeps its usual
default, its description says so, and a save stores that default. Loading
the form writes nothing, and a server that cannot give the stored options
gets the usual form.

Flat settings are still read in any case: a key in its section wins, and the
top-level key is used when the section does not have it. A setting given in
neither place is not set at all, so its default — or the environment variable
below — applies. Saving a path selection or moving a path changes only that
list and keeps every section as it is.

## Turn on AI Bridge

- **Turn on AI Bridge** (`enabled`, default on)
  Answer questions asked in the panel. Off, the panel still loads, the status
  says the plugin is off, and nothing is sent to a model.

## AI model

- **Model server type** (`backend`, default `ollama`)
  **Ollama** (`ollama`) talks to an Ollama server, which runs llama.cpp with
  its CUDA backend. **TensorRT-LLM or NIM (NVIDIA)** (`tensorrt-llm`) talks to
  any OpenAI-compatible NVIDIA server such as `trtllm-serve` or a NIM
  container, where the CUDA engine is compiled ahead of time for this GPU; it
  needs compute capability 8.0 or newer (Orin, not Xavier). The stored values
  are the ones in parentheses; `trtllm`, `tensorrt`, `trt-llm` and `openai`
  are read as `tensorrt-llm`. See [TensorRT-LLM](jetson.md#tensorrt-llm)

- **Model server address** (`baseUrl`, default `http://localhost:11434`)
  The server's URL. A trailing `/api`, `/v1`, `/api/chat` or
  `/v1/chat/completions` is dropped, so either form works for both server
  types. Blank uses `AI_MODEL_URL` or `SIGNALK_AI_BRIDGE_BASE_URL`, or the
  default. Which address to use when Signal K and the model run in different
  containers or on different machines is in the
  [README](../README.md#running-the-model-with-docker-compose)

- **Model name** (`model`, default `gemma4`)
  An Ollama tag, or the model id a TensorRT-LLM server reports at
  `GET /v1/models`. The untagged default resolves to whichever Gemma 4 tag is
  installed (for example `gemma4:e2b-it-qat`); a tagged name must be installed
  as written. See [Model names](how-it-works.md#model-names) and
  [Choosing a model](jetson.md#choosing-a-model)

- **API key** (`apiKey`, default blank) — shown only for TensorRT-LLM or NIM
  Sent as a bearer token to the OpenAI-compatible server. Leave blank for an
  unauthenticated `trtllm-serve`. Ollama is never sent it

- **Keep the model loaded for** (`keepAlive`, default `30m`)
  How long the model stays resident in GPU memory between questions (Ollama's
  `keep_alive`): `10m`, `30s`, `1h`, a number of seconds, or `-1` to never
  unload. Reloading a model from Jetson storage costs several seconds on the
  next question. An unreadable value is taken as the default

- **Load the model when the plugin starts** (`warmupOnStart`, default on)
  Loads the model into GPU memory on start so the first question does not pay
  the cold-load cost, and, with **Fit the model on the GPU automatically** on,
  runs the GPU fitting at the same time. Ollama only

## Answers

How the model writes its answers. Safe to leave as they are.

- **Instructions to the model** (`systemPrompt`)
  Sent as a native system message before every question. The default is tuned
  against measured failures — negated alarm answers, silently skipped values,
  whole-context recitals — so prefer adding to it over replacing it, and do
  not ask for unit conversions: angles, temperatures and speeds are already
  converted to degrees, Celsius and knots before the model sees them, and
  asking again gets them converted twice. See [Units](how-it-works.md#units).
  Blank uses the default

- **Creativity (temperature)** (`temperature`, default 0.2, 0 to 2)
  Lower values are more stable and literal, higher values more varied

- **Word choice (top-p)** (`topP`, default 0.95, 0 to 1)
  Nucleus sampling: an additional control on how varied the output is

- **Longest answer (tokens)** (`maxTokens`, default 2048, 64 to 131072)
  The most tokens the model may generate (`num_predict`). It does not size the
  context window, but it is capped at half of the **Context window**: the
  prompt and the answer share the window, and llama.cpp resolves a conflict by
  truncating the *prompt*. Half a window is already generous for a vessel
  summary — a few hundred tokens is typical — so lower it for shorter answers,
  and raise the context window for longer ones. A model that spends the whole
  budget reasoning and returns no answer is reported with a pointer to this
  setting

- **Wait for an answer (ms)** (`requestTimeoutMs`, default 120000, 0 to 300000)
  How long the plugin waits for the model server. Allow for a cold model load
  plus the answer: measured on a Xavier NX, ~47 s to load and ~20 s of prompt
  evaluation before the first token, so 120 s is tight and 180 s comfortable.
  `0` disables the timeout entirely, which leaves nothing to stop a wedged
  backend. Metadata calls — listing models, reading GPU residency — are bounded
  separately, at this value or 15 s, whichever is lower, so a wedged backend
  cannot hold the status page for the whole chat timeout

## History in answers – optional

Also send recent history for the chosen paths, read from the Signal K History
API, so the model can answer trend questions. It needs a history provider
plugin such as `signalk-to-influxdb2` or `signalk-parquet`; without one the
answer says history was unavailable and uses live data alone. How it works:
[Vessel history](history.md).

- **Include recent history** (`historyEnabled`, default off)
  Turn it on once a history provider is recording. The settings below are
  shown only while it is on; values already stored are kept while it is off.
  The history paths are chosen in the panel, see
  [Path selections](#path-selections-chosen-in-the-panel)

- **How far back** (`historyDuration`, default `PT1H`)
  An ISO 8601 duration (`PT15M`, `PT1H`, `P1D`), a shorthand (`30m`, `2h`), or
  a plain number of seconds. Capped at 31 days. An unreadable value is taken as
  the default

- **Time step** (`historyResolution`, default blank)
  Size of each aggregation window, for example `1m` or `300` (seconds). Leave
  blank to derive it from the window and the sample budget, which keeps the
  request proportional to what fits in the prompt: asking a provider for a day
  of one-second samples and then keeping twelve is work for nobody's benefit

- **Points per path** (`historySamples`, default 12, 2 to 200)
  Points per path that reach the model, picked evenly across the window and
  always including its first and last, with min, max, first, last and average
  sent alongside. Two is the minimum: a single point is not a series, and the
  live snapshot already carries the newest value

- **History server address** (`historyServerUrl`, default blank)
  Where the History API lives. Blank calls this server over loopback, on the
  port it listens on (see [Servers with security enabled](history.md#servers-with-security-enabled)).
  Set it for history served by another Signal K instance on the boat, with its
  own **History API key**. With TLS on, leave it blank and see
  [Servers with TLS](history.md#servers-with-tls). An address with a user name
  or password, a query or a fragment, or one that is not an http or https URL
  is never called

- **History API key** (`historyApiKey`, default blank)
  Bearer token for a history server that is not this Signal K server: another
  host, or another service on this machine at a different port (InfluxDB on
  `localhost:8086`, say). The operator's own session is forwarded only to this
  server — a cookie minted here is replayable against another Signal K
  instance — so anything else needs a credential issued for itself. Leave
  blank for this server's own history, or for an unauthenticated one

- **History provider** (`historyProvider`, default blank)
  The plugin id of a specific provider, for example `signalk-parquet`. Blank
  uses the server's default provider

- **Wait for history (ms)** (`historyTimeoutMs`, default 5000, 0 to 120000)
  How long to wait for the History API before answering from live data alone.
  Kept short on purpose: this runs before the model sees the question. `0`
  disables the timeout

## Advanced – GPU and memory

Leave these unless you know your GPU: the defaults and the automatic fitting
suit most boards. Suggested values for 8 GB Jetson boards are in
[Suggested plugin settings on 8 GB](jetson.md#suggested-plugin-settings-on-8-gb).

- **Context window (tokens)** (`numCtx`, default 8192, 512 to 131072)
  Tokens of context the model keeps in memory (`num_ctx`). llama.cpp reserves
  the KV cache from this value up front, so it is the setting that decides
  whether the model stays resident on the GPU. It also sets how much vessel
  data the plugin will send: paths beyond what fits are dropped from the end of
  your selection, and the prompt says how many (see
  [Prompt size](how-it-works.md#prompt-size)). On a Jetson Orin Nano Super
  (8 GB unified memory) keep it at or below 16384 for a 4B-class model. With
  TensorRT-LLM it must stay at or below the engine's `--max_seq_len`

- **GPU layers** (`numGpu`, default -1, -1 to 999)
  Layers offloaded to the GPU (`num_gpu`). `-1` lets the automatic fitting (or
  Ollama's own estimate) decide; an explicit value overrides it, with `0`
  forcing CPU-only and `999` full offload

- **Fit the model on the GPU automatically** (`gpuAutoTune`, default on)
  On start, force every layer onto the GPU and shrink the context window until
  the whole model is resident, instead of accepting whatever CPU/GPU split the
  backend estimates. Falls back to the backend estimate only if the model
  cannot fit at all. See [Maximizing GPU use](jetson.md#maximizing-gpu-use)

- **Batch size** (`numBatch`, default 512, 32 to 4096)
  Tokens evaluated per GPU batch (`num_batch`). This sizes the prompt-eval
  compute buffers, so on a small unified-memory board it is usually the first
  setting to lower when a question fails with `CUDA error: out of memory`. 512
  is the backend's own default, but it is not safe everywhere: on a Xavier NX
  (8 GB, Volta) it fails reliably at a context window of 8192, where 256 is
  stable. Values above the context window are clamped to it

- **CPU threads** (`numThread`, default 0, 0 to 64)
  Threads for anything not offloaded to the GPU (`num_thread`). `0` lets the
  runtime choose; the Orin Nano Super has 6 Cortex-A78AE cores

## Path selections (chosen in the panel)

- **AI data paths** (`aiDataPaths`)
  Open the plugin's web app, press **Browse available paths** in the `AI Path
  Selection` card, tick what the model should see, and save. The picker lists
  what this vessel is actually publishing — branch wildcards first, then the
  individual leaves they cover — which is why the choice lives there and not in
  the settings form. Prefer a wildcard for a whole branch: it is flattened,
  unit-converted and budgeted leaf by leaf, where a bare branch name is sent as
  one raw subtree. The saved list is in priority order (↑/↓ in the card). On a
  server with security enabled, saving needs a login with write access

- **History paths** (`historyPaths`)
  Chosen under **History Context** in the panel. See
  [Vessel history](history.md#settings)

## Environment variables

A setting that is not set at all can come from the environment of the Signal K
server instead. Text settings marked "blank too" also fall back when they are
stored blank; the others only when the key is missing, and a form saved once
stores every visible field, defaults included.

| Setting | Variable |
| --- | --- |
| `enabled` | `SIGNALK_AI_BRIDGE_ENABLED` |
| `backend` | `SIGNALK_AI_BRIDGE_BACKEND` |
| `baseUrl` (blank too) | `AI_MODEL_URL`, then `SIGNALK_AI_BRIDGE_BASE_URL` |
| `model` (blank too) | `AI_MODEL_NAME`, then `SIGNALK_AI_BRIDGE_MODEL` |
| `apiKey` (blank too) | `SIGNALK_AI_BRIDGE_API_KEY` |
| `keepAlive` | `SIGNALK_AI_BRIDGE_KEEP_ALIVE` |
| `warmupOnStart` | `SIGNALK_AI_BRIDGE_WARMUP` |
| `systemPrompt` (blank too) | `SIGNALK_AI_BRIDGE_SYSTEM_PROMPT` |
| `requestTimeoutMs` | `SIGNALK_AI_BRIDGE_TIMEOUT_MS` |
| `historyEnabled` | `SIGNALK_AI_BRIDGE_HISTORY_ENABLED` |
| `historyDuration` (blank too) | `SIGNALK_AI_BRIDGE_HISTORY_DURATION` |
| `historyServerUrl` (blank too) | `SIGNALK_AI_BRIDGE_HISTORY_URL` |
| `historyApiKey` (blank too) | `SIGNALK_AI_BRIDGE_HISTORY_API_KEY` |
| `historyTimeoutMs` | `SIGNALK_AI_BRIDGE_HISTORY_TIMEOUT_MS` |
| `numCtx` | `SIGNALK_AI_BRIDGE_NUM_CTX` |
| `numGpu` | `SIGNALK_AI_BRIDGE_NUM_GPU` |
| `gpuAutoTune` | `SIGNALK_AI_BRIDGE_GPU_AUTOTUNE` |
| `numBatch` | `SIGNALK_AI_BRIDGE_NUM_BATCH` |
| `numThread` | `SIGNALK_AI_BRIDGE_NUM_THREAD` |

`temperature`, `topP`, `maxTokens`, `historyResolution`, `historySamples` and
`historyProvider` have no environment variable.
