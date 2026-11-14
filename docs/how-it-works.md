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
window and leaves out whole paths rather than let the backend cut the prompt
mid-JSON. When it leaves any out, it says how many in the prompt, so the model
can tell you the answer may be incomplete.

**Which paths are left out.** The budget walks the selected data in the order
the selection is stored in and skips any entry that does not fit in what is
left, then carries on — so a large entry early on can be skipped while smaller
ones after it are kept, but an entry earlier in the list always gets the first
claim on the window.

**Put what matters first.** The `AI Path Selection` and `History Context`
cards list the saved selection in that priority order, with **↑** and **↓** to
move a path. Each move is made on the server against the selection as stored
(`POST /plugins/signalk-ai-bridge/paths/move` with `{ kind, path, delta }`,
`delta` the number `1` or `-1`). A move never sends a list, so it cannot put
back an old copy of one: it swaps the path with its neighbour in the stored
list and changes nothing else there (entries the card does not show, such as
a wildcard in the history list, stay where they were). A move that would
change nothing (the path is already first or last) stores nothing. If the
path has gone from the stored list, or there is no stored list to reorder,
the server answers `409` with the lists as they are and the card shows those.
Paths newly ticked in a picker are added at the end, and saving from the
picker keeps the order you set. A picker save does send the whole list as
the panel last read it, so the panel makes one change to the lists at a time:
Save and the arrows are disabled while a move or a save is in flight, and a
status read that was already on its way cannot put an older order back on
screen. A change another browser made since this panel loaded can still be
replaced by a picker save from here. Keep alarms and engine data
near the top, and signal strengths, camera URLs and other bulky paths at the
bottom or out of the selection.

Two lists cannot be reordered until you save one: the default AI selection
(used until you save your own), and a history list that is reusing the AI
selection, which follows that selection's order. History series reach the
model in the order you set, whatever order the history provider answers in.

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
