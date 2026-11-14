# How Ask AI builds its request

What the plugin sends to the model, and why: streaming, the prompt budget, units
and model names. None of this needs configuring; it explains what you see in
"What was sent to AI".

## Streaming

Answers stream token by token over `POST /bridge/stream` (newline-delimited
JSON), so the first words appear in a few hundred milliseconds instead of after
the whole answer is generated. This does not make the GPU faster — it changes
when you see the output. Both backends stream (Ollama's NDJSON and
TensorRT-LLM's SSE), and the panel falls back to the blocking route
automatically if streaming is unavailable.

The configured model name is resolved to the installed tag *before* the first
request. The default is the untagged `gemma4`, which Ollama reads as
`gemma4:latest` and rejects when only `gemma4:e2b-it-qat` is installed; a
question used to pay one rejected request for that, and because a rejection
cannot be retried mid-stream, a default install fell back to a blocking
generation and never streamed at all. The installed-model listing behind that
resolution is cached for 30 seconds and shared with the status poll, so a
question asked a moment after the panel loads makes no listing request of its
own.

## Prompt size

Prompt evaluation is GPU work, so the context sent to the model is kept tight:
compact JSON rather than indented, numbers rounded to what the unit is read at
(see [Units](#units)), and the data keyed by path instead of repeating the path
list alongside it. Paths that produced no value are listed separately, so the
model can still be explicit about what is missing.

Staleness is sent only where there is some. Every leaf used to carry its ISO
timestamp as a sibling key, which said nothing useful about a value refreshed a
second ago and cost more characters than the value itself — measured on a
55-leaf snapshot, the timestamps were 62% of the context. Now a value that has
gone more than a minute without an update carries `"<path>@": "stale for 5 min"`
(or `3 h`, `2 d`), and a current one carries nothing — as does one whose
timestamp cannot be read or lies in the future, and the prompt says so, so the
model does not take "unmarked" for "verified fresh". The wording is deliberate:
a small model reads "stale for 3 h" correctly, where it would have had to
subtract an ISO timestamp from a "now" it was never told. Exact paths get the
same marker as wildcard leaves, so the default selection can say a fix is old.

A normal notification is trimmed to its `state`. Its `message` ("Value is within
normal range"), `silenced` and `acknowledged` are the same constants on every
one, and a working vessel has dozens — measured aboard, 43 normal notifications
flattened to 14,730 characters, more than the whole context budget. An alarm
that is *not* normal keeps everything, because which alarm, what it says and
whether anyone has acknowledged it are all worth the tokens. Every notification
also loses the UUID, the alert methods and the five `can…` booleans, which
describe what a notification UI may do with it and answer no question.

The budget follows `numCtx`. llama.cpp resolves a prompt that will not fit by
truncating the prompt itself, to whatever `num_predict` leaves it, and says so
only in the inference server's log — so the plugin sizes its own context to the
window and drops whole paths, from the end of your selection, rather than let
the backend cut the prompt mid-JSON. When it drops any, it says how many in the
prompt, so the model can tell you the answer may be incomplete.

**Order your path selection by what matters most.** The budget keeps entries in
the order you chose them and drops from the tail, so alarms and engine data
belong ahead of signal strengths and camera URLs.

The operator's question is charged against the same window. A short question
costs nothing worth counting, but a pasted checklist near the 4,000-character
limit is roughly a thousand tokens, and the context budget shrinks by that much
so the whole prompt still fits — rather than letting the backend cut it. When
the question alone fills the window, no vessel data or history is sent at all
and the prompt says so, so the model answers "not available" instead of
answering from a prompt the backend truncated.

If the snapshot ends up with no notification data at all — none selected, or all
of it dropped — the prompt says so explicitly and tells the model to report
alarm status as unknown. Without that the model reliably answered "all alarms
are normal" about paths it had never been shown, which is the one answer a
vessel assistant must never give.

The context returned to the panel is unchanged — only what reaches the model is
compacted.

## Units

Values reach the model in the units an operator reads, and the prompt says so,
so the model has no arithmetic left to get wrong:

| Signal K | Sent to the model |
| --- | --- |
| Angles, in radians | Degrees, to 1 decimal |
| Temperatures, in kelvin | Degrees Celsius, to 1 decimal |
| Speeds, in metres per second | Knots, to 2 decimals |
| Everything else | Unchanged SI — pressure in pascals, distance in metres, ratios 0–1 — to 6 decimals |

The precision is the operator's, not the sensor's. The system prompt tells the
model to repeat values as given, and a heading sent as `86.837462` came back to
the helm as "86.837462 degrees": five tokens where one decimal is already finer
than a compass card. Positions are not angle leaves and keep six decimals, which
is about 0.1 m. History statistics are rounded the same way as the values they
summarize.

Angle leaves are matched on the last segment of the path, including camelCase
compounds such as `fusedHeading`, and distances, speeds and positions that live
under an angle-ish parent (`navigation.courseGreatCircle.nextPoint.distance`)
are explicitly excluded.

Live values and history are converted by the same code, so the two can never
disagree about which way the boat was pointing. Do not ask for conversions in
`systemPrompt`: the values are already converted, and a prompt that asks for
them again gets them applied twice — an attitude yaw of 86.5° came back as 495°.

## Model names

The plugin defaults to the Gemma 4 family.

If you configure `gemma4` but Ollama only has a tagged variant installed, such as `gemma4:e2b-it-qat`, the plugin will try to resolve and use the installed tagged model automatically. The default is deliberately untagged for this reason: it follows whichever Gemma 4 tag the board actually has.

That resolution only works within a family. A board running `qwen3.5:2b-q4_K_M` shares no family name with `gemma4`, so its model field has to be set explicitly.

If you already know the exact installed model name, configuring that exact name is the clearest option — and on an 8 GB board it is also the only way to be sure which tag you got, since `gemma4:e2b` and `gemma4:e2b-it-qat` differ by 2.9 GB of weights. See [Choosing a model](jetson.md#choosing-a-model).
