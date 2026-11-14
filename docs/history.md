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
  paths from the AI data path selection. Only exact paths are reused: wildcards
  such as `navigation.*` are not expanded, so if the live selection is all
  wildcards, select history paths explicitly or no history is requested. At
  most 12 paths are requested

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
  Bearer token for a history server that is not this Signal K server: another
  host, or another service on this machine at a different port (InfluxDB on
  `localhost:8086`, say). Leave blank for this server's own history, or for an
  unauthenticated one

- `historyProvider`
  A specific provider plugin id. Blank uses the server's default provider

- `historyServerUrl`
  Where the History API lives. Blank calls this server over loopback, on the
  port it listens on (see below). Set it for history served by another Signal K
  instance on the boat. With TLS on, see [Servers with TLS](#servers-with-tls)

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

That reasoning only holds when the History API is this Signal K server. A cookie
minted here is replayable against another Signal K instance, so the operator's
session is forwarded only to **this server**: a loopback address that
reaches it, on the port it listens on.

The plugin asks the server: Signal K hands plugins its HTTP(S) server, and
that server reports the address and port it is listening on, whatever they
came from - `PORT`, the settings, or a socket systemd handed it. That port is
this server's port, and a blank `historyServerUrl` calls it there (HTTPS with
TLS on). With TLS on, the HTTP port beside it carries only a redirect to the
port Signal K advertises (`EXTERNALPORT`, which may be a reverse proxy), so it
is not sent the session.

`signalk-server-setup` runs every systemd install with socket activation:
systemd opens the listening socket (`ListenStream=`, two of them with TLS on,
`LISTEN_FDS=2`) and hands it to Signal K, which then listens on none of its
configured ports. `EXTERNALPORT` is set there too, but it is the port Signal K
advertises - nginx on 80 in front of `ListenStream=3000`, say - not the port
it holds, so it never counts. The server's own report is what names the
socket's port.

Only when the server does not report an address (before it has started
listening, or under a host that does not hand plugins its server) are the
ports worked out the way Signal K picks them:

- the HTTP port is `PORT` if set, else `port` in its settings, else 3000;
- with TLS on, the HTTPS port is `SSLPORT` if set, else `sslport`, else 3443.
  The server's API is on that port, and the HTTP port carries only its redirect
  to it; both count;
- only the value Signal K uses counts: with `PORT` set, a different `port` in
  the settings is not one of its ports, and the same for `SSLPORT` and
  `sslport`;
- under socket activation (`LISTEN_FDS` set) none of these is its port, and
  the socket's cannot be known, so no port counts.

`EXTERNALPORT` and `proxy_port` are the ports a reverse proxy publishes, not
ones this server listens on, and never count. When no port of this server is
known - socket activation with no address reported, a configured port that is
not a valid port, a listener on a LAN address or a local socket only - a blank
`historyServerUrl` calls nothing, rather than send the paths and time window to
whatever holds a guessed port: the history context says why. A
`historyServerUrl` set then is not sent the session either; give it a
`historyApiKey`.

Loopback alone is not enough, because any other service on this machine is on
loopback too, so a `historyServerUrl` of `localhost` at a different port is
treated like another host. Another host, or another port, is never sent the
session. Give it a credential issued for itself in `historyApiKey`, or leave
that blank if it needs none. When a key is configured and the server still
answers 401 or 403, the error shows the server's own reason and says the key
was rejected.

Which loopback addresses count depends on what the listener is bound to, as
the server reports it:

- the dual-stack wildcard (`::`): `localhost`, `127.0.0.1` and `[::1]` all
  count. Signal K listens without naming a host, and Node then binds `::` as
  dual-stack (or `0.0.0.0` on a host without IPv6, where nobody can bind
  `[::1]` either); a systemd `ListenStream=3000` socket binds the dual-stack
  wildcard too by default. While Signal K holds the port that way, no other
  process can hold `127.0.0.1` or `[::1]` on it;
- an IPv4 address (`0.0.0.0`, `127.0.0.1`): only `127.0.0.1` counts, since
  another process could hold `[::1]` on the same port. `localhost` resolves
  to both, and Node tries both, so it counts only when this machine has no
  IPv6 loopback address for anyone to bind; otherwise a blank
  `historyServerUrl` calls `127.0.0.1`;
- `[::1]`: only `[::1]` counts, the same way round;
- any other address (a LAN address only): no loopback address reaches it, and
  nothing counts.

The exposure that remains is an IPv6 wildcard that is IPv6-only, which the
server's report cannot tell apart from a dual-stack one: a socket unit with
`BindIPv6Only=ipv6-only`, or `net.ipv6.bindv6only=1` with the default
`BindIPv6Only=`. Another service could then take `127.0.0.1` on the same port,
and a `historyServerUrl` naming it would hand that service the session; the
blank default calls `localhost`, which can resolve there too. Avoid that
combination, or bind the socket to `[::1]` explicitly.

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
