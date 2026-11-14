# Vessel history

`getSelfPath` answers *what is true now*. A lot of what an operator actually
asks is about a trend — "has the wind been building?", "did the batteries
recover overnight?", "were we making way an hour ago?" — and the live data model
cannot answer any of it.

Turning on `historyEnabled` makes the plugin also read the server's
[History API](https://demo.signalk.org/documentation/Developing/REST_APIs/History_API.html)
(`GET /signalk/v2/api/history/values`) before each question, and put the result
in the same prompt as the live snapshot, under a `history` key.

## What you need

A history provider plugin has to be installed and recording on the same Signal K
server — for example `signalk-to-influxdb2` or `signalk-parquet`. The History API
is the server's front end for whichever provider is installed; without one there
is nothing behind it.

If no provider is installed, the API answers 404. The plugin does not fail the
question over it: the context says the history was unavailable, and the model is
told to answer from live data alone and to say the history is missing rather than
invent a trend. The same is true of a provider that is slow, down, or has no data
for the window.

## What reaches the model

For each path, one series:

```json
"history": {
  "from": "2026-04-11T09:00:00.000Z",
  "to": "2026-04-11T10:00:00.000Z",
  "resolutionSeconds": 300,
  "series": {
    "environment.wind.speedApparent": {
      "method": "average",
      "count": 12,
      "min": 5.1, "max": 11.4, "first": 5.4, "last": 10.9, "average": 8.2,
      "samples": [["2026-04-11T09:00:00.000Z", 5.4], ["2026-04-11T09:05:00.000Z", 6.1]]
    }
  }
}
```

Points are picked evenly across the window and always include its first and last,
so a trend keeps both ends. Angles, temperatures and speeds are converted
exactly as the live snapshot is (see [Units](how-it-works.md#units)), so the two never disagree
about which way the boat was pointing or how warm the cabin was. History gets
its own share of the prompt budget: a series that will not fit loses its
`samples` before it is dropped, because min/max/first/last still answer "is it
rising?" at a fraction of the tokens.

## Settings

- `historyEnabled`
  Off by default. Turn it on once a history provider is recording

- **History paths** — chosen in the web app, not here
  Press **Browse recorded paths** in the panel's `History Context` card: it
  lists every path your provider has data for in the last day (or your window,
  if longer), and saves what you tick. The History API takes no wildcards, so
  these are explicit paths; a path may carry an aggregation method, for example
  `navigation.speedOverGround:average` (`average`, `min`, `max`, `first`,
  `last`, `mid`, `middle_index`, `sma`, `ema`). Select none to reuse the exact
  paths from the AI data path selection. At most 12 paths are requested

- `historyDuration`
  How far back to look: `PT1H`, `P1D`, `30m`, or a plain number of seconds.
  Capped at 31 days

- `historyResolution`
  Size of each aggregation window, for example `1m` or `300`. Leave blank to
  derive it from the window and the sample budget, which keeps the request
  proportional to what fits in the prompt

- `historySamples`
  Points per path that reach the model. Default 12, minimum 2 — a single point
  is not a series, and the live snapshot already carries the newest value

- `historyApiKey`
  Bearer token for a history server that is not this machine. Leave blank for
  local history, or for an unauthenticated remote one

- `historyProvider`
  A specific provider plugin id. Blank uses the server's default provider

- `historyServerUrl`
  Where the History API lives. Blank calls this server on `localhost`. Set it for
  history served by another Signal K instance on the boat, or when this server
  runs behind TLS with a certificate `localhost` cannot verify

- `historyTimeoutMs`
  How long to wait before answering from live data alone. Default 5000, kept
  short on purpose — this runs before the model sees the question

## Servers with security enabled

The History API is behind the same authentication as the rest of the REST API,
and a plugin has no session of its own. The operator asking the question does:
their cookie or bearer token arrives on the request that reached the plugin and
is forwarded to the history read. History is therefore read with exactly the
access the operator already has — the plugin cannot read history a user could not
read themselves.

That holds for **this** server only. A cookie minted here is replayable against
another Signal K instance, so the operator's session is forwarded to a loopback
target and nowhere else. A `historyServerUrl` pointing at another host is never
sent it; give that host a credential issued for itself in `historyApiKey`, or
leave it blank if it needs none.
