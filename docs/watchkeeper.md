# Watchkeeper reference

Watchkeeper is the background watch in `signalk-ai-bridge`. It learns how each
of this vessel's Signal K paths normally behaves and raises a Signal K
notification when one departs from it.

This page is the reference: how it works, every check and its thresholds, the
rule format, the HTTP API, and how to tune it. For a short introduction see the
[README](../README.md#watchkeeper).

> Watchkeeper is experimental. It adds detection for things nobody set a
> threshold for. It does not replace the alarms already on the boat, and it is
> not a safety-critical system.

## Contents

- [Design in one paragraph](#design-in-one-paragraph)
- [Pipeline](#pipeline)
- [Discovery](#discovery)
- [Per-path learning](#per-path-learning)
- [Checks](#checks)
- [GNSS integrity](#gnss-integrity)
- [Redundant sources](#redundant-sources)
- [Operating states](#operating-states)
- [Findings, incidents and notifications](#findings-incidents-and-notifications)
- [Your own watches (rules)](#your-own-watches-rules)
- [Feedback and the watch report](#feedback-and-the-watch-report)
- [Where the language model is and is not used](#where-the-language-model-is-and-is-not-used)
- [HTTP API](#http-api)
- [Settings](#settings)
- [Persistence](#persistence)
- [Tuning](#tuning)
- [Performance](#performance)
- [Limitations](#limitations)
- [Source map](#source-map)

## Design in one paragraph

Detection is statistics, not a language model. A small model cannot hold a
whole vessel's data in its context window, a scan would cost tens of seconds of
GPU time, it would occupy the inference slot the operator's own questions need,
and it would sometimes invent things. So every check is a small, deterministic,
O(1)-per-update computation on the CPU, and every message is a template filled
with the numbers the check measured. The model is only involved when the
operator chooses: to explain an incident, or to read a plain-language watch
rule that the built-in parser could not read.

## Pipeline

```
Signal K deltas (vessels.self, every path, ≤ 1 Hz per path)
  │
  ├─ operating-state gates ──► re-learn / restore per-state baselines
  ├─ exclusions ─────────────► skipped (still: latest value, source comparison)
  ├─ GNSS inputs ────────────► GNSS integrity monitor
  └─ watched paths
       ├─ source routing ────► primary feeds the baseline, others are compared
       └─ path monitor ──────► learned baseline, series, discrete states
                                    │
every 5 s:  checks ─► tracker (persistence, hysteresis) ─► findings
                                                                │
                              incidents ◄────────────────────────┤
                              notifications.aiBridge.watch.* ◄───┘
```

The engine (`lib/watch/engine.cjs`) has no clock and no I/O: the caller
passes the time with every call. The same engine therefore runs live in the
plugin, over a day of History API data in a replay, and in the unit tests, and
gives the same answers in all three.

## Discovery

Nothing is configured per boat. The watch subscribes to `*` on `vessels.self`
(through the subscription manager, or the stream bundle on servers without
one) and picks up each path when it is first published, whether it is a
standard Signal K path or a plugin's own.

- **Object values** (attitude, a nested sensor) are split into their leaves, to
  a depth of 3 and at most 32 leaves per value.
- **Kind** is decided from the values. Strings, booleans and `null` are
  *discrete*. Numbers are *continuous*, unless the first 20 samples are all
  integers with at most 4 distinct values (a pump state, a mode code), in which
  case they are discrete until a fifth value or a fraction appears. A number
  that has never fallen over at least 30 samples is a *counter* (engine hours,
  energy, fuel used), and the level and stuck-sensor checks skip it. Never
  falling is not enough on its own:
  - A path listed in `watchCounterPaths` is a counter, whatever it does.
    This is how a plugin's own counter under a name the watch does not know
    is declared.
  - A path named as a measurement is never a counter, whatever else its name
    says (`…Voltage`, `…Current`, `…Temperature`, `…Level`, `…Pressure`,
    `…Power`, `…Rate`, `…Stored`, `…Remaining` and the like, and anything
    about satellites). Neither is a path whose unit is not one a cumulative
    quantity has (s, m³, J, C, or m for a log).
  - Otherwise, a path that has never fallen is a counter if it is named as
    one (`runTime`, `…Hours`, `…Count`, `…Total`, `energy…`,
    `lifetimeDischarge`/`Recharge`/`Charge`/`Energy`, `…Consumed`,
    `…Today`, `yield…`, `used`, `odometer`, `log`, `trip`). A drop to
    (nearly) zero is a reset - a daily yield at midnight, a trip log
    cleared - and does not end it.
  Nothing is taken for a counter from its behaviour alone: a voltage under
  an unknown name and without units can climb for hours without a dip too,
  and the checks that would report it must stay on.
- **Units, display name and zones** come from the path's own `meta`. The
  watch reads it from update deltas when present and looks it up with
  `getSelfPath`: 50 paths per tick for new ones, and every path again every
  30 minutes. Without metadata, units are inferred from the leaf name
  (`voltage` → V, `temperature` → K, `currentLevel` → ratio, and so on).
- **Inventory**: `GET /watch/inventory` (and **What is watched?** in the panel)
  lists every path found, its role, and which checks this vessel's data
  supports. A role is *watching*, *learning*, *re-learning*, *skipped* (with
  the exclusion pattern) or *read by the GNSS check*. For an unavailable check
  it says what is missing, for example "needs navigation.speedThroughWater".

At most `watchMaxPaths` paths (default 1500) are watched. Paths beyond that are
counted, not watched.

## Per-path learning

Each watched path keeps a small, serialisable state object
(`lib/watch/path-monitor.cjs`):

| Learned | How |
| --- | --- |
| Update interval | Moving average of the time between accepted samples |
| Baseline mean and spread | Exponentially weighted, half-life **30 min**, time-based so "30 minutes" means 30 minutes at any update rate. While a path is learning, the weight is at least `1/n`, so the first minutes are a plain average |
| Fast average | Exponentially weighted, half-life **8 s**, used to compare against the baseline. A one-sample spike barely moves it |
| Sensor resolution | The smallest non-zero step seen three times (within 10 %) among the last 8 steps, where a step that goes straight back the way the one before it came counts once with it. The noise floor is at least twice it, but no more than the coarsest real senders of the unit allow (16 kPa for pressure, a quarter for a tank or other ratio, ten times the unit's floor otherwise; 5 % of the value without a unit, but never less than two counts on a whole-number path). A single step, or a glitch out and straight back followed by a real drop of the same size, is not evidence of resolution: a tank that sat at 80 % and dropped to 20 % would otherwise have learned a 60-point resolution and hidden its own drop |
| Transitions | Counted per minute, so a switch cycling every second is counted exactly. "The last hour" is the minute buckets that start inside it — 59 to 60 minutes, never more |
| Change rate | How often consecutive samples differ, for the frozen check |
| Discrete states | Count per value (up to 32 values) |
| Series | 60 ten-second buckets (10 min) and 90 one-minute buckets (90 min) |

**Noise floor.** A perfectly steady value has no spread, so the spread used is
never below a floor for what the path measures:

| Unit | Floor |
| --- | --- |
| Temperature (K) | 0.3 |
| Angle (rad) | 0.02 (≈ 1.1°) |
| Speed (m/s) | 0.1 |
| Voltage (V) | 0.05 |
| Current (A) | 0.3 |
| Power (W) | 5 |
| Pressure (Pa) | 30 |
| Ratio | 0.005 |
| Frequency (Hz) | 0.3 (18 rpm) |
| Length (m) | 0.1 |
| Flow (m³/s) | 1e-7 |
| Anything else | 0.5 % of the mean |

**Robust updates.** Once a path has settled, a single sample moves the
baseline by at most 4 spreads' worth. While a path is in an *excursion* (fast
average at least `zClear` spreads from the mean), the spread is frozen and the
mean creeps by at most one spread per sample. Otherwise a long departure would
widen the spread until it no longer stood out. An excursion that lasts **60
minutes** is accepted as the new normal and the path re-learns for 10 minutes.

**Angles** are unwrapped before any of this, so a heading crossing north is a
2° change, not 358°.

**Learning period.** A path can raise nothing until it has 30 samples and has
been watched for `watchLearningMinutes` (default 30).

## Checks

`z` below is `(fast average − baseline mean) / max(spread, noise floor)`.

| Check | Fires when | Severity | Persist / clear |
| --- | --- | --- | --- |
| **Unusually high / low** (`shift`) | `\|z\| ≥ zWarn`; clears below `zClear` | `alert` at `\|z\| ≥ zAlert`, else `warn` | 15 s / 60 s |
| **Stopped updating** (`dropout`) | A path that updates at least once a minute (30+ samples) has been silent for more than `max(30 s, 10 × usual interval)` | `warn` | immediate / on next update |
| **Data feed silent** (`feed`) | At least 4 regularly updating paths, and at least half of them, are silent at once. Reported once instead of per path | `alert` | immediate |
| **Looks stuck** (`frozen`) | A continuous path that changed on at least half its updates repeats exactly the same non-zero value 30+ times over 5+ minutes (100+ samples learned) | `warn` | immediate |
| **New state** (`newState`) | A discrete path takes a value never seen before, after learning. Held 10 minutes | `warn` | immediate |
| **Cycling** (`cycling`) | After 6 h of observation, transitions in the last hour ≥ `max(4, 3 × usual hourly rate + 2)` | `alert` at twice that, else `warn` | immediate / 10 min |
| **Heading for a limit** (`forecast`) | A linear trend (R² ≥ 0.6) reaches a limit within its horizon (see below) | `warn` | 2 min / 5 min |
| **Sources disagree** (`disagree`) | See [Redundant sources](#redundant-sources) | `alert` at `zAlert` | 30 s / 60 s |
| **Switched source** (`failover`) | See [Redundant sources](#redundant-sources). Held 10 minutes | `warn` | immediate |
| **GNSS** (`gnss.*`) | See [GNSS integrity](#gnss-integrity) | `alert` when two indicators are active at once | per indicator |
| **Your watch** (`rule`) | See [Your own watches](#your-own-watches-rules) | as written | your duration (min 5 s) / 30 s |

**Sensitivity** (`watchSensitivity`):

| | `zWarn` | `zAlert` | `zClear` |
| --- | --- | --- | --- |
| `low` | 8 | 14 | 4 |
| `normal` | 6 | 10 | 3 |
| `high` | 4.5 | 8 | 2.5 |

A ramp is caught by the same check as a step. The fast average follows the
ramp while the slow baseline lags it, by about the ramp rate × 43 minutes. When
the value is still moving, the message adds the rate over the last 90 seconds,
but only when that rate is itself beyond the noise.

**Forecast limits:**

| Path | Limit | Horizon | Trend window |
| --- | --- | --- | --- |
| `tanks.{fuel,freshWater,lubrication,gas}.*.currentLevel` | 10 % | 3 h | 60 min, 10+ points |
| `tanks.{wasteWater,blackWater}.*.currentLevel` | 90 % | 3 h | 60 min, 10+ points |
| `electrical.batteries.*.stateOfCharge` (or `.capacity.stateOfCharge`) | 20 % | 2 h | 60 min, 10+ points |
| Any path with `meta.zones` in `warn`, `alert`, `alarm` or `emergency` | the zone boundary | 30 min | 15 min, 5+ points |

A value already past its limit is not forecast: that is the zone's own alarm.

### Skipped by default

These paths change with the helm, the wind and the seabed, so a sudden change
in them is seamanship, not news (`watchDefaultExclusions`):

```
navigation.position  navigation.gnss  navigation.datetime
navigation.courseOverGround*  navigation.heading*  navigation.attitude
navigation.rateOfTurn  navigation.speedOverGround  navigation.speedThroughWater*
navigation.leewayAngle  navigation.course  navigation.courseRhumbline
navigation.courseGreatCircle  navigation.destination  navigation.anchor
navigation.trip  navigation.log  navigation.magneticVariation*
environment.wind  environment.current  environment.depth  environment.tide
environment.sun  environment.moon  environment.mode  environment.time
steering  performance  design  resources  communication  **.runTime
```

Pattern rules: a path covers everything beneath it, `*` matches within one
segment, `**` across segments. `notifications.*` is never watched.

Skipped paths are still recorded for rules, still compared across redundant
sources, and the GNSS check still reads position, heading, speed through water,
satellites, dilution and time.

## GNSS integrity

`lib/watch/gnss.cjs`. Jamming and spoofing do not trip limits: a jammed fix
degrades or freezes, and a spoofed one looks healthy somewhere else. Each
indicator uses evidence the receiver does not control:

| Indicator | Fires when | Persist / clear |
| --- | --- | --- |
| `jump` | Two consecutive fixes from one source are more than 100 m apart **and** imply more than 40 kn. `alert` above 5 km. Held 10 min | immediate |
| `deadReckoning` | The fix is further from dead reckoning (true heading + speed through water, integrated from an agreeing fix) than **150 m + 25 % of distance run + 2 kn × elapsed time**. Heading and log must be fresh (≤ 5 s). The reference is re-anchored every 10 minutes, and only on a fix that agrees, so a spoofed position never becomes the reference | 30 s / 60 s |
| `sourcesDisagree` | Two position sources updated within 10 s of each other are more than 100 m apart | 30 s / 60 s |
| `quality` | Fewer than 4 satellites, or horizontal dilution above 5, on a receiver that has reported at least 6 satellites or dilution below 2 at least 20 times | 30 s / 60 s |
| `frozen` | Consecutive fixes (no more than `max(5 s, 3 × the usual fix interval)` apart, so a receiver reporting every 10 s keeps the check) have not moved (< 0.5 m) for 60 s while speed through water is above 1 m/s. A fix that moved, a gap in the feed, or a log that is stale or reads under 1 m/s ends the candidate, and the check also needs a fix and a log reading from the last few seconds, so a boat that slowed and stopped, or a feed that paused, is not reported | immediate / 10 s |
| `lost` | After 30 fixes, none for `max(30 s, 10 × usual fix interval)`. Outages are left out of the usual interval, so a receiver that drops out twice is reported both times. Position is excluded from the per-path dropout check, so this is what notices a receiver that stops. The GNSS status then reads `lost`, as it does for any fix older than a minute | immediate |
| `clock` | `navigation.datetime` jumps more than 30 s against the server clock, after 10 samples. Held 10 min | immediate |

Two indicators at once escalate every GNSS finding to `alert`. All GNSS
findings share one notification, `notifications.aiBridge.watch.gnss`, and one
incident that never merges with other systems.

## Redundant sources

`lib/watch/sources.cjs`. When several sources publish one path, the first one
seen is primary and only its samples feed the baseline. Mixing them would make
a calibration offset look like noise, or a step at every switch.

- **Disagree**: each other source is compared with a fresh primary sample
  (within `max(5 s, 2 × interval)`). The usual gap is learned **per
  primary/secondary pair**, so a constant offset is normal and one sensor's
  offset cannot hide another's fault. It fires when a pair's gap exceeds its
  usual one by `zWarn` spreads and is at least 3 noise floors, after 30
  comparisons. Pairs learned under an earlier primary are kept but not judged.
  Up to 16 pairs per path; when full, the least recently compared pair of a
  former primary makes room, so the current primary's pairs are always
  learned.
- **Failover**: when the primary has been silent for `max(10 s, 5 × interval)`,
  the next source becomes primary. If the old primary was established (30+
  samples), that is reported, because the path kept updating and a dropout
  check would never see it.

This runs on skipped paths too: two compasses disagreeing is news even though
heading itself is expected to swing. Up to 8 sources per path, and up to 500
skipped paths with more than one source.

## Operating states

Some changes are expected together. When an engine starts, its temperatures
climb, the alternator lifts the battery voltage and fuel flow appears. These
*gates* recognise operating-state changes:

| Gate path | States | Affects | Settle |
| --- | --- | --- | --- |
| `propulsion.<id>.revolutions` | `running` above 0.5 Hz (30 rpm), else `stopped` | `propulsion.<id>.`, `electrical.`, `tanks.fuel.` | 15 min |
| `propulsion.<id>.state` | its value | same | 15 min |
| `electrical.{chargers,inverters,solar,alternators,ac}.<id>.{chargingMode,mode,state}` | its value | `electrical.` | 10 min |
| `navigation.state` | its value | `propulsion.`, `electrical.`, `tanks.` | 10 min |

On a change, every affected path:

1. **files its settled baseline** under the state it is leaving, if it had been
   settled for at least 10 minutes. Up to 6 states per path are kept.
2. **re-learns** through the settling period, raising nothing.
3. **restores** the baseline it learned the last time it was in the new state,
   once the settling period ends, if there is one and the new state is active.
   Resting states (`stopped`, `off`, `idle`, `standby`, `disabled`, `moored`,
   `0`) always re-learn, because a cooling engine is not at a steady state.

Step 3 is what makes the second engine start useful. It is judged against how
this engine normally runs, so an engine that settles 10 °C hotter than usual
is reported instead of being quietly re-learned as the new normal.

## Findings, incidents and notifications

A check's condition passes through a tracker that applies its persistence
(how long it must hold before it is a finding) and hysteresis (how long it must
be gone before the finding clears). An open finding can rise in severity but
does not drop back.

**Incidents** group findings. A new finding joins an active incident if it is
in the same system (the first two path segments, for example
`propulsion.main`), or if it starts within 3 minutes of the incident's last new
finding. GNSS findings only ever group with GNSS findings. Findings are listed
in the order they started, so the first one is labelled *first sign*. The last
50 incidents are kept.

**Notifications.** Each watched path gets one notification carrying its worst
open finding, plus one each for GNSS, the data feed and each rule:

```
notifications.aiBridge.watch.<path>
notifications.aiBridge.watch.gnss
notifications.aiBridge.watch.dataFeed
notifications.aiBridge.watch.rules.<rule id>
```

```json
{ "state": "alert", "method": ["visual"], "message": "Main engine temperature unusually high: 92.9 °C, +12.2 °C from its usual 80.1 °C (40.6× its normal variation)" }
```

- States are `warn` or `alert`, never `alarm` or `emergency`, which belong to
  real alarm sources.
- `sound` is added for `alert` when `watchSound` is on.
- A state change is published at once. A message whose numbers merely
  refreshed is republished at most once a minute.
- What was sent is recorded only once the server accepts the batch. A
  refused batch is retried on the next tick, so a warning or its clearance is
  never lost.
- A cleared finding publishes `normal` with "Back to normal: …".
- Stopping the plugin clears every watch notification.

**Mutes** (`POST /watch/mute`, or **Mute 1 h** in the panel) suppress a path or
pattern for 1 minute to 7 days. Muting `navigation.position` mutes the GNSS
checks.

## Your own watches (rules)

A rule is stored data, checked deterministically on every tick:

```json
{
  "id": "r-mf3k2a-7x1q",
  "text": "Alert if the coolant goes above 90 for 30 seconds while rpm is above 600",
  "path": "propulsion.main.temperature",
  "op": "above",
  "value": 363.15,
  "forSeconds": 30,
  "when": { "path": "propulsion.main.revolutions", "op": "above", "value": 10 },
  "severity": "alert",
  "createdAt": 1794685523434,
  "source": "parser"
}
```

- `op` is one of `above`, `below` (numbers), `equals`, `notEquals` or
  `changes`.
- `value` is in SI, like the data. `equals` treats `true`, `1`, `"on"` and
  `"true"` alike.
- `changes` fires for 10 minutes after the change is seen, once per change.
  While the `when` condition is known to be false, the rule keeps up with the
  value silently. While the `when` data is stale, nothing is judged: a change
  made meanwhile is reported once the guard is heard from again (its 10
  minutes count from then), and a change already reported is not reported a
  second time when the guard returns. Until the guard has been heard at all
  since start, the rule has no starting value, so it begins from the value
  present when the guard is first heard.
- The rule and its `when` guard need data no older than 5 minutes. Without
  it the rule cannot be judged and does not fire.
- At most 50 rules. They are stored in the plugin's options as `watchRules`.
- A word is a value only on a path that has states: "becomes warm" on a
  temperature, or "changes to empty" on a tank level, is refused with a request
  for a number, rather than stored as a watch that can never fire. "Switches on
  and off" means any change.
- One `while` condition per rule. A request with two is refused rather than
  stored with one of them silently dropped, and it is not passed to a model,
  which could only drop one too.
- Every write to the plugin's options (rules, path selections) goes through
  one queue, so two overlapping saves cannot undo each other. The panel adds
  and removes one rule at a time (`/watch/rules/add`, `/watch/rules/remove`),
  applied to the rules as stored, never to its own possibly stale copy.

**Reading plain language** (`lib/watch/rule-parser.cjs`), with no model:

- Comparisons: *above, over, higher/more/greater than, exceeds, hotter/warmer/
  faster than, below, under, lower/less than, colder/cooler/slower than*,
  `>`, `<`; *is on/off*, *switches on*, *runs*, *starts*, *stops*, *is not …*,
  *changes to …*, *becomes …*; and, with no target state, *changes*,
  *switches*, *toggles*.
- Units: °C, °F, K, V, A, W, kW, %, kn, m/s, rpm, Hz, hPa, mbar, kPa, bar, psi,
  Pa, m, ft, nm, L, L/h. A number without a unit is read in the unit the panel
  shows for that path ("above 95" on a coolant temperature is 95 °C).
- Duration: *for 30 s / 2 minutes / 1 hour*.
- Urgency: *alarm, alert, urgent, critical, emergency, immediately* →
  `alert`.
- Conditions: *while, whilst, only when, only if, as long as, when, if*.
- Paths: chosen from what this vessel publishes. The request's words are
  matched against path segments and display names, with everyday synonyms
  (*coolant, fridge, house battery, barometer, rpm, cabin, sea, shore, bilge*).
  A typed unit rules out paths that cannot carry it, and path segments the
  request does not account for count against a path. When two paths fit
  equally well, the parser returns both for the operator to choose instead of
  guessing.

**Reading what the parser cannot** (`lib/watch/rule-assist.cjs`), only if
`watchRuleAssist` allows it:

- The model gets the request and at most 25 candidate paths (the parser's
  alternatives first), each with its display unit.
- The answer is held to a JSON schema (Ollama's `format`) whose `path` and `op`
  fields allow only those paths and operators.
- Settings: `temperature 0`, `num_predict 160`, `num_ctx 2048`, thinking off,
  60 s timeout.
- `main` uses the configured model, resolved to its installed tag and already
  resident. `helper` uses `watchHelperModel` and lets it unload after 2
  minutes.
- Ollama only. With TensorRT-LLM the parser is the only reader.

Either way the result is validated, read back in plain words, and shown with
its current value and how often it held over the watch's last 90 minutes. A
rule read by a model is labelled as such. Nothing is stored until the operator
adds it.

## Feedback and the watch report

**Feedback.** The operator teaches the watch which findings are worth an
interruption:

- **Not useful** on a finding (`POST /watch/feedback { path, useful: false }`),
  or muting an exact path while it has an open finding, is one dismissal.
- Dismissals decay with a **14-day half-life**. A path with at least half a
  dismissal left gets a threshold factor of `1 + 0.25 × dismissals`, capped at
  **2**.
- The factor multiplies `zWarn` and `zAlert` for the level (`shift`) and
  source-disagreement checks (on watched and skipped paths alike), and the
  silence a `dropout` needs. Other checks — stuck sensors, new states,
  cycling, forecasts, GNSS, your own watches — are unaffected, so a dismissed
  stuck-sensor finding can recur just as before; mute the path for that.
- An open finding is not closed by feedback: it clears through its normal
  hysteresis. The next departure has to be bigger.
- `useful: true` removes one dismissal, and `"reset"` forgets them all
  (**Restore** in the panel).
- `GET /watch/status` lists every affected path under `lessSensitive`, and the
  inventory shows the factor per path, so nothing is tuned out of sight.
- Feedback is saved with the rest of the state.

**Watch report** (`GET /watch/report?hours=24`, 1–168 hours). It is built from
the open findings and a log of the last 1,000 closed ones, kept for 7 days and
saved across restarts. It returns counts (`incidents`, `alerts`, `findings`,
`byDetector`) and plain `lines`:

```
2 incidents (1 alert, 1 warning) from 5 findings.
Still active: Engine room temperature stopped updating.
Longest: House battery voltage unusually low, 42 min.
Repeated: House battery voltage unusually low ×2.
Sensors and data: Engine room temperature stopped updating.
GNSS: no warnings; dead reckoning or a second receiver cross-checked the fix (last at 11:58 UTC).
Your watches fired: Main engine temperature is above 90.0 °C for 30 s.
Operating changes: Engine main running at 08:12 UTC, Engine main stopped at 11:40 UTC.
Less sensitive after your dismissals: Water temperature.
```

Times are in UTC, so the report means the same thing whatever the server's
time zone. The GNSS line says the fix was cross-checked only if dead reckoning
or a second receiver compared against it inside the report's window. **Ask AI for a logbook entry** gives these lines to the model with
the instruction to add no facts of its own. The operator reads and sends that
question.

## Where the language model is and is not used

| Part | Model |
| --- | --- |
| All checks, all thresholds, all firing decisions | none |
| Finding, incident and notification text | none (templates) |
| Stored rules at watch time | none |
| Reading a typed rule | none, unless the parser fails and `watchRuleAssist` allows it |
| Explaining an incident, the "most unusual" list or the watch report | the main model, only when the operator presses the button and sends the question, which they can read and edit first |
| Learning from dismissals | none (a per-path threshold factor) |

## HTTP API

All routes are under `/plugins/signalk-ai-bridge`. While the plugin is stopped
they answer `503`. Routes marked *write* need a login with `readwrite` or
`admin` access when Signal K security is on, and answer `401` otherwise.

| Route | | Returns |
| --- | --- | --- |
| `GET /watch/status` | | `enabled`, `running`, `usesLanguageModel: false`, `subscription`, `restoredBaseline`, `startedAt`, `samples`, `sensitivity`, `paths` (watched/ready/learning/relearning/excluded/capped), `sourcesCompared`, `activeFindings`, `incidents`, `regimeChanges`, `gnss` (status and indicators), `rules`, `mutes`, `lastError?`, `lastReplay?` |
| `GET /watch/inventory` | | `totals`, `branches`, `capabilities[]` (`id`, `label`, `available`, `detail`), `paths[]` (`path`, `role`, `kind`, `units`, `intervalMs`, `sources`, `excludedBy`) |
| `GET /watch/unusual` | | `rows[]`: `path`, `score`, `title`, `message`, most unusual first |
| `GET /watch/series?path=…` | | `minutes` and `recent`, `[timeMs, SI value]` pairs. `404` for an unknown path |
| `POST /watch/mute` | write | Body `{ path, minutes }`. Returns `{ mutes }` |
| `POST /watch/unmute` | write | Body `{ path }`. Returns `{ mutes }` |
| `POST /watch/replay` | write | Body `{ duration?: "PT24H", paths?: [] }`. Returns `ok`, `from`, `to`, `pathsReplayed`, `rows`, `findingsOpened`, `incidentsOpened`, `byDetector`, `incidents`, `note`. `409` while another replay runs |
| `POST /watch/rules/compile` | write | Body `{ text, path? }` (`path` pins the subject after a "which one?"). Returns `ok`, `source`, `model?`, `rule`, `description`, `current`, `wouldFireNow`, `recent`; or `ok: false`, `reason`, `alternatives[]`, `assistNote?` |
| `POST /watch/rules/add` | write | Body `{ rule }`. Adds it, or replaces the rule with its id. Returns `{ rules }`; `409` when 50 watches already exist |
| `POST /watch/rules/remove` | write | Body `{ id }`. Returns `{ rules }` |
| `POST /watch/rules/save` | write | Body `{ rules: [...] }`, the full list, for tools that manage it as a unit. Invalid rules are dropped. Returns `{ rules }` |
| `GET /watch/report?hours=24` | | `from`, `to`, `hours`, `incidents`, `alerts`, `findings`, `byDetector`, `lines[]` |
| `POST /watch/feedback` | write | Body `{ path, useful }`: `false`, `true` or `"reset"`. Returns `{ path, factor }` |

The replay reads the History API with the same credential rules as the rest of
the plugin: the operator's session goes only to this machine, and a remote
history server needs `historyApiKey`. It replays up to 7 days, at least 10 s
per row and at most 10,000 rows, for up to 80 paths in requests of 10.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `watchEnabled` | `false` | Turn the watch on |
| `watchSensitivity` | `normal` | `low`, `normal` or `high` (see the table under [Checks](#checks)) |
| `watchLearningMinutes` | `30` | Minimum observation before a new path can raise anything (1–1440) |
| `watchNotifications` | `true` | Publish findings as Signal K notifications |
| `watchSound` | `false` | Add `sound` to the method of alert-level findings |
| `watchDefaultExclusions` | `true` | Skip the paths listed under [Skipped by default](#skipped-by-default) |
| `watchExcludePaths` | `[]` | More paths or patterns to skip |
| `watchCounterPaths` | `[]` | Paths or patterns that only count up, under names the watch does not recognise (a plugin's own pulse or energy counter); they are not judged as levels or stuck sensors |
| `watchMaxPaths` | `1500` | Most paths watched (10–10000) |
| `watchRuleAssist` | `main` | `main`, `helper` or `off` |
| `watchHelperModel` | empty | Ollama model for `helper`, for example `qwen3:0.6b` |
| `watchRules` | `[]` | Written by the panel; not in the settings form |

## Persistence

The learned state is saved to `watch-state.json` in the plugin's data directory
every 5 minutes and when the plugin stops. It is written to a temporary file
and renamed, so a crash cannot leave half a file. The saved state includes each
path's baseline, series, discrete states, per-state baselines and source
statistics, plus recent incidents, the finding log for the report, operator
feedback, mutes and the current operating states.

On start, a saved state younger than 14 days is restored. Every path's
last-seen time is reset to now, so the gap while the plugin was down is not
reported as dropouts or failovers. Incidents that were open are closed and
marked *plugin restarted*. About 1.2 MB per 1,000 paths.

## Tuning

1. **Start at `normal` and let it learn.** The first 30 minutes per path are
   learning, and operating states need to be visited once (engine run, charger
   cycle) before their baselines can be restored.
2. **Replay before changing sensitivity.** Once a history provider has a day of
   data, **Replay last 24 h** shows what the current settings would have
   raised. History is aggregated and smoother than live data, so read the
   result as a lower bound.
3. **Exclude, do not desensitise.** If one path is noisy by nature (a sensor
   that hunts, a value driven by the helm), add it to `watchExcludePaths`
   rather than lowering sensitivity for everything.
4. **Mute for a known situation; say "Not useful" for a noisy path.** **Mute 1 h**
   silences a path you know about (a deliberate test, a fault being worked on).
   **Not useful** tells the watch the finding was not worth the interruption,
   so that path needs a bigger change next time. Both count as feedback when
   the path is firing, and **Restore** undoes it.
5. **Write a rule for a hard limit.** The statistics find what is unusual for
   this vessel. A rule states what is not acceptable, whatever is usual.

## Performance

Measured on an x86 development machine with 1,000 continuous paths at 1 Hz:

| | |
| --- | --- |
| Per update | ≈ 3 µs |
| Per 5-second check, all paths | ≈ 2 ms |
| CPU at 1 Hz × 1,000 paths | ≈ 0.3 % of one core |
| Saved state | ≈ 1.2 MB |

A Jetson's Cortex cores are a few times slower, which is still a small fraction
of one core. No GPU is used.

## Limitations

- **Thresholds are tuned on simulated data.** The defaults come from the test
  scenarios, not from a fleet of real boats. Use the replay on your own data
  before trusting them.
- **Dead reckoning allows 2 kn of current.** In a stronger tidal stream, the
  dead-reckoning indicator can warn falsely. A second indicator is needed
  before anything escalates to `alert`.
- **Operating states come from a fixed set of gates.** Engines, charger and
  inverter modes and `navigation.state` are recognised; other regime changes
  (a watermaker starting, say) are not, and may show as short-lived findings.
- **Replay uses aggregated history,** which is smoother than live data, and
  replays at most 80 paths. Paths that rules read go first; only rules
  reading more than 80 paths in all could lose one.
- **The rule parser knows English phrasing** and a fixed list of synonyms.
  Other languages fall through to the model, if allowed.

## Source map

| File | |
| --- | --- |
| `lib/watch/engine.cjs` | Config, exclusions, operating states, tracker, findings, incidents, inventory, rules, export/import |
| `lib/watch/path-monitor.cjs` | Per-path learning and the per-path checks |
| `lib/watch/gnss.cjs` | GNSS integrity indicators |
| `lib/watch/sources.cjs` | Primary source, disagreement, failover |
| `lib/watch/rules.cjs` | Rule format, validation, evaluation, plain-language description |
| `lib/watch/rule-parser.cjs` | Plain language → rule, without a model |
| `lib/watch/rule-assist.cjs` | The schema-constrained model fallback |
| `lib/watch/narrate.cjs` | Finding text from templates |
| `lib/watch/format.cjs` | Operator units, path names, unit parsing |
| `lib/watch/stats.cjs` | Exponential averages, distances, trends |
| `lib/watch-service.cjs` | Signal K wiring: subscription, notifications, persistence, replay, rule compilation |
| `src/WatchPanel.tsx`, `src/watchText.ts` | The panel card and its helpers |
| `test/watch-*.test.cjs`, `src/watchText.test.ts` | Tests |
| `scripts/preview-host.mjs --watch-demo` | A scenario to see it working without a boat |
