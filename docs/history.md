# Vessel history

`getSelfPath` answers *what is true now*. A lot of what an operator actually
asks is about a trend — "has the wind been building?", "did the batteries
recover overnight?", "were we making way an hour ago?" — and the live data model
cannot answer any of it.

Switching on **Include recent history** (`historyEnabled`), in the **History
in answers – optional** section of the plugin settings, makes the plugin also
read the server's
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

The history settings are in the **History in answers – optional** section of
the plugin settings, and appear once **Include recent history**
(`historyEnabled`, off by default) is switched on. Each one is described in
[Plugin settings](settings.md#history-in-answers--optional): **How far back**
(`historyDuration`), **Time step** (`historyResolution`), **Points per path**
(`historySamples`), **History server address** (`historyServerUrl`),
**History API key** (`historyApiKey`), **History provider**
(`historyProvider`) and **Wait for history (ms)** (`historyTimeoutMs`). The
sections below name them by key.

- **History paths** — chosen in the web app, not in the settings
  Press **Browse recorded paths** in the panel's `History Context` card: it
  lists every path your provider has data for in the last day (or your window,
  if longer), and saves what you tick. The History API takes no wildcards, so
  these are explicit paths; a path may carry an aggregation method, for example
  `navigation.speedOverGround:average` (`average`, `min`, `max`, `first`,
  `last`, `mid`, `middle_index`, `sma`, `ema`). Select none to reuse the exact
  paths from the AI data path selection. Only exact paths are reused: wildcards
  such as `navigation.*` are not expanded, so if the live selection is all
  wildcards, select history paths explicitly or no history is requested. At
  most 12 paths are requested

## Servers with security enabled

The History API is behind the same authentication as the rest of the REST API,
and a plugin has no session of its own. The operator asking the question does:
their cookie or bearer token arrives on the request that reached the plugin and
is forwarded to the history read. History is therefore read with exactly the
access the operator already has — the plugin cannot read history a user could not
read themselves.

That reasoning only holds when the History API is this Signal K server. A cookie
minted here is replayable against another Signal K instance, so the operator's
session is forwarded only to **this server**: a loopback address that
reaches it, on the port it listens on.

The plugin works out that port the way Signal K picks it. (The listening
socket itself is a server internal that plugins may not use, so its address
is not read.)

- the HTTP port is `PORT` if set, else `port` in its settings, else 3000;
- with TLS on, the HTTPS port is `SSLPORT` if set, else `sslport`, else 3443.
  The server's API is on that port, and a blank `historyServerUrl` calls it
  there; the HTTP port carries only its redirect to the advertised port, and
  is neither called nor sent the session;
- only the value Signal K uses counts: with `PORT` set, a different `port` in
  the settings is not one of its ports, and the same for `SSLPORT` and
  `sslport`;
- under systemd socket activation (`LISTEN_FDS` set), which
  `signalk-server-setup` uses for every systemd install, systemd opens the
  listening socket (`ListenStream=`, two of them with TLS on) and Signal K
  listens on none of its configured ports. Its port is then the one Signal K
  advertises: `EXTERNALPORT`, which the setup script writes as the API
  socket's own port in every variant (3000, 80, 3443 or 443), and for a
  hand-written unit without it, `proxy_port` or the configured port. The
  default 3000 does not count on an install whose socket is 80.

Outside socket activation, `EXTERNALPORT` and `proxy_port` are the ports a
reverse proxy publishes, not ones this server listens on, and never count.
Under socket activation, a hand-written unit whose `EXTERNALPORT` names a
reverse proxy (nginx on 80 in front of `ListenStream=3000`) has the session
sent to that proxy, which hands it to this server. If something else answers
on that port, set `historyServerUrl` to the socket's own port and give it a
`historyApiKey` (a token issued by this server): only the advertised port is
sent the operator's session.

A `historyServerUrl` (or `SIGNALK_AI_BRIDGE_HISTORY_URL`) with a user name or
password in it (`http://user:password@host`), one that is not a valid http or
https URL, or one with a query or fragment (`?…`, `#…`, which the API path
would be appended after) is never called: the history context says so without repeating the URL, so
the password does not reach the panel or the model's prompt. Put a token in
`historyApiKey` instead.

When no port of this server is known - a configured or advertised port that
is not a valid port - a blank `historyServerUrl` calls nothing, rather than
send the paths and time window to whatever holds a guessed port: the history
context says why. A `historyServerUrl` set then is not sent the session
either; give it a `historyApiKey`.

Loopback alone is not enough, because any other service on this machine is on
loopback too, so a `historyServerUrl` of `localhost` at a different port is
treated like another host. Another host, or another port, is never sent the
session. Give it a credential issued for itself in `historyApiKey`, or leave
that blank if it needs none. When a key is configured and the server still
answers 401 or 403, the error shows the server's own reason and says the key
was rejected.

On this server's port, `localhost`, `127.0.0.1` and `[::1]` all count. Signal
K listens without naming a host, and Node then binds the dual-stack wildcard
`::` (or `0.0.0.0` on a host without IPv6, where nobody can bind `[::1]`
either); a systemd `ListenStream=<port>` socket binds the dual-stack wildcard
too by default. While Signal K holds the port that way, no other process can
hold `127.0.0.1` or `[::1]` on it. The exposure that remains is a listener on
one address family only: a socket unit with `BindIPv6Only=ipv6-only`, or
`net.ipv6.bindv6only=1` with the default `BindIPv6Only=`, or one bound to an
IPv4 address. Another service could then take the other family's loopback on
the same port, and `localhost` can resolve there. Avoid that combination, or
set `historyServerUrl` to the loopback address Signal K holds.

## Servers with TLS

With TLS on, a blank `historyServerUrl` calls `https://localhost:<port>`.
Node does not trust Signal K's generated certificate, so that call fails with
`DEPTH_ZERO_SELF_SIGNED_CERT` until it is told to. Setting `historyServerUrl`
does not change that: every address of this machine is presented with the same
certificate. What works:

- Signal K's generated certificate (`ssl-cert.pem` in its configuration
  directory, normally `~/.signalk`) is issued to `localhost`, so starting
  Signal K with `NODE_EXTRA_CA_CERTS` pointing at it makes
  `https://localhost:<port>` verify. In a systemd install, add
  `Environment=NODE_EXTRA_CA_CERTS=/home/<user>/.signalk/ssl-cert.pem` to the
  service (`systemctl edit signalk`) and restart it. `https://127.0.0.1` still
  fails (`ERR_TLS_CERT_ALTNAME_INVALID`), because the certificate names only
  `localhost`;
- a certificate of your own: add its issuer to `NODE_EXTRA_CA_CERTS` the same
  way, and call a name it is issued to. A name that is not a loopback address
  is not this server as far as the session goes, so give it a
  `historyApiKey`.

When a call fails, the history context names the cause (`fetch failed:
ECONNREFUSED`, `fetch failed: DEPTH_ZERO_SELF_SIGNED_CERT`, ...), and a
rejected certificate comes with this advice.

## Response size

A History API response is read at most 16 MB far (a declared larger
`Content-Length` is refused without reading). The plugin runs in the Signal
K server's own process, so a provider that ignores the requested resolution
cannot exhaust its memory; the history context or path listing says the
response was too large instead.
