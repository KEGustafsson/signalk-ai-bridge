'use strict';

const os = require('node:os');
const { createTimedFetch, resolveFetch } = require('./http-utils.cjs');
const {
  DEFAULT_DECIMALS,
  circularMeanDegrees,
  convertAiValueForPath,
  isAnglePath,
  promptDecimalsForPath
} = require('./signalk-units.cjs');

/**
 * Signal K History API client.
 *
 * `getSelfPath` answers "what is true now"; a lot of the questions an operator
 * actually asks are about a trend - "has the wind been building?", "did the
 * battery recover overnight?" - and the live data model cannot answer any of
 * them. The server's History API can, when a history provider such as
 * signalk-to-influxdb2 or signalk-parquet is installed, so this module turns a
 * configured window into a handful of series compact enough to sit in the same
 * prompt as the live snapshot.
 *
 * https://demo.signalk.org/documentation/Developing/REST_APIs/History_API.html
 *
 * Everything here is best-effort: history is an enrichment, and a provider that
 * is missing, slow or broken must never turn an answerable question into an
 * error. Failures come back as a `message` in the context so the model can say
 * the history was unavailable instead of inventing a trend.
 */

const HISTORY_API_PATH = '/signalk/v2/api/history';
const DEFAULT_HISTORY_DURATION = 'PT1H';
const DEFAULT_HISTORY_SAMPLES = 12;
const DEFAULT_HISTORY_TIMEOUT_MS = 5000;
const DEFAULT_SIGNALK_PORT = 3000;

// A history request is prompt material, not a data export. These bounds exist
// because both ends are unbounded otherwise: a provider will happily return a
// month of one-second samples for twenty paths, and the whole point of the
// summary below is that it fits in a context window next to the live snapshot.
const MAX_HISTORY_PATHS = 12;
const MIN_HISTORY_SAMPLES = 2;
const MAX_HISTORY_SAMPLES = 200;
const MIN_RESOLUTION_SECONDS = 1;
// Upper bound on rows one request may ask the provider for: the window's
// duration divided by its resolution. Without it a 31-day window at an
// explicit one-second resolution asks for 2,678,400 rows - a response big
// enough that parsing it is its own problem, for a summary that keeps at most
// MAX_HISTORY_SAMPLES points per path anyway.
const MAX_HISTORY_ROWS = 5000;
const MAX_CONTEXT_LABEL_CHARS = 120;
const MAX_DURATION_SECONDS = 31 * 24 * 60 * 60;

// The aggregation methods the History API documents. A path may carry one as a
// `:method` suffix (`navigation.speedOverGround:sma:5`), which is passed
// through untouched - the server owns the aggregation, not this plugin.
const AGGREGATION_METHODS = new Set([
  'average',
  'min',
  'max',
  'first',
  'last',
  'mid',
  'middle_index',
  'sma',
  'ema'
]);

// Hostnames that are this machine. Forwarding the operator's session to
// anything else would hand a third party a credential that is replayable
// against their own Signal K server.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return fallback;
}

function toBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * Seconds from a duration or window size.
 *
 * Accepts what the History API documents (an integer number of seconds, or an
 * ISO 8601 duration such as `PT15M`) plus the `1s`/`1m`/`1h`/`1d` shorthand the
 * same document uses for `resolution`, because an operator who read that table
 * will reasonably type either one into either field.
 *
 * Returns undefined for anything it cannot read, so the caller can fall back to
 * its own default rather than sending a nonsense window to the provider.
 */
function parseDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const text = value.trim();
  if (text.length === 0) {
    return undefined;
  }

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Math.trunc(Number(text));
    return seconds > 0 ? seconds : undefined;
  }

  const shorthand = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i.exec(text);
  if (shorthand) {
    const amount = Number(shorthand[1]);
    const unit = shorthand[2].toLowerCase();
    const factor = unit.startsWith('w')
      ? 604800
      : unit.startsWith('d')
        ? 86400
        : unit.startsWith('h')
          ? 3600
          : unit.startsWith('m')
            ? 60
            : 1;
    const seconds = Math.trunc(amount * factor);
    return seconds > 0 ? seconds : undefined;
  }

  // Years and months are deliberately unsupported: neither has a fixed length
  // in seconds, and a window that silently means something different in
  // February is worse than one the operator has to spell out in days.
  const iso = /^P(?!$)(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?!$)(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    text
  );
  if (!iso) {
    return undefined;
  }

  const [, weeks, days, hours, minutes, seconds] = iso;
  const total =
    (Number(weeks) || 0) * 604800 +
    (Number(days) || 0) * 86400 +
    (Number(hours) || 0) * 3600 +
    (Number(minutes) || 0) * 60 +
    (Number(seconds) || 0);

  const truncated = Math.trunc(total);
  return truncated > 0 ? truncated : undefined;
}

/** `navigation.speedOverGround:sma:5` -> `{ spec, path, method }`. */
function parsePathSpec(spec) {
  const text = String(spec || '').trim();
  if (text.length === 0) {
    return undefined;
  }

  const [path, method] = text.split(':');
  const cleanPath = String(path || '').trim();
  if (cleanPath.length === 0) {
    return undefined;
  }

  const cleanMethod = String(method || '').trim().toLowerCase();

  return {
    spec: text,
    path: cleanPath,
    method: AGGREGATION_METHODS.has(cleanMethod) ? cleanMethod : undefined
  };
}

function normalizePathSpecs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const specs = [];
  for (const item of value) {
    const parsed = parsePathSpec(item);
    // A wildcard is meaningless here: the History API takes explicit paths, and
    // there is no data model to expand `navigation.*` against for a window that
    // ended before the plugin started.
    if (!parsed || parsed.path.includes('*') || seen.has(parsed.spec)) {
      continue;
    }
    seen.add(parsed.spec);
    specs.push(parsed.spec);
    if (specs.length >= MAX_HISTORY_PATHS) {
      break;
    }
  }

  return specs;
}

/**
 * Strip anything past the server root so both `http://localhost:3000` and a
 * pasted `http://localhost:3000/signalk/v2/api/history/values` work.
 */
function normalizeServerUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (text.length === 0) {
    return '';
  }

  return text
    .replace(/\/signalk\/v2\/api\/history(?:\/.*)?$/i, '')
    .replace(/\/signalk\/v[12]\/api(?:\/.*)?$/i, '')
    .replace(/\/+$/, '');
}

function normalizeHistoryConfig(options = {}, env = process.env) {
  const historyPaths = normalizePathSpecs(options.historyPaths);
  const durationText = String(
    options.historyDuration || env.SIGNALK_AI_BRIDGE_HISTORY_DURATION || DEFAULT_HISTORY_DURATION
  ).trim();
  const durationSeconds = parseDurationSeconds(durationText);

  return {
    historyEnabled: normalizeBoolean(
      options.historyEnabled ?? env.SIGNALK_AI_BRIDGE_HISTORY_ENABLED,
      false
    ),
    historyServerUrl: normalizeServerUrl(
      options.historyServerUrl || env.SIGNALK_AI_BRIDGE_HISTORY_URL || ''
    ),
    historyPaths,
    historyDuration: durationSeconds ? durationText : DEFAULT_HISTORY_DURATION,
    historyDurationSeconds: Math.min(
      MAX_DURATION_SECONDS,
      durationSeconds || parseDurationSeconds(DEFAULT_HISTORY_DURATION)
    ),
    // Blank means "derive one from the window and the sample budget", which is
    // almost always what an operator wants: asking a provider for a day of raw
    // one-second samples to then throw all but twelve of them away is work for
    // the database, the network and nobody's benefit.
    historyResolutionSeconds: parseDurationSeconds(options.historyResolution),
    // Two, not one: a single point is not a series, and the live snapshot in
    // the same prompt already carries the newest value.
    historySamples: toBoundedInteger(
      options.historySamples,
      DEFAULT_HISTORY_SAMPLES,
      MIN_HISTORY_SAMPLES,
      MAX_HISTORY_SAMPLES
    ),
    historyProvider: String(options.historyProvider || '').trim(),
    historyApiKey: String(options.historyApiKey || env.SIGNALK_AI_BRIDGE_HISTORY_API_KEY || '').trim(),
    historyTimeoutMs: toBoundedInteger(
      options.historyTimeoutMs ?? env.SIGNALK_AI_BRIDGE_HISTORY_TIMEOUT_MS,
      DEFAULT_HISTORY_TIMEOUT_MS,
      0,
      120000
    )
  };
}

/**
 * Paths to ask history for.
 *
 * With none configured, the exact (non-wildcard) live paths are reused: an
 * operator who selected `navigation.speedOverGround` for the snapshot almost
 * certainly wants its trend too, and making them type the same list twice is
 * the kind of setup step that gets skipped.
 */
function resolveHistoryPaths(config) {
  if (Array.isArray(config.historyPaths) && config.historyPaths.length > 0) {
    return config.historyPaths;
  }

  return normalizePathSpecs(Array.isArray(config.aiDataPaths) ? config.aiDataPaths : []);
}

/**
 * Where to call the History API, and who counts as this server there.
 *
 * With `historyServerUrl` set, that URL. Otherwise this is a loopback call
 * back into the process's own host: a loopback name is preferred over
 * whatever external hostname the server advertises, since mDNS names do not
 * always resolve from inside a container and loopback needs no DNS at all.
 * The port is the server's main listener (signalkListeners) and the host is
 * one that listener is reached at - `localhost` when that is unambiguous,
 * else the loopback literal of the listener's address family - so the
 * derived URL is always one isOwnServer counts. `historyServerUrl` remains for
 * history served by a different Signal K instance on the boat.
 *
 * When the main listener's port is not known, there is no derived URL:
 * `baseUrl` is undefined and `unknown` says why, so that the paths and time
 * window are not sent to whatever else holds a guessed port.
 */
function resolveHistoryTarget(app, config) {
  const listeners = signalkListeners(app);
  const own = { ports: new Set(listeners.ports.map(String)), hosts: listeners.hosts, reason: listeners.reason };

  if (config.historyServerUrl) {
    return { baseUrl: config.historyServerUrl, own };
  }
  if (!listeners.primary) {
    return {
      own,
      unknown:
        `this Signal K server's port is not known (${listeners.reason}), so there is no address to call it on; ` +
        'set "Signal K server URL" to the address it serves on, with a "History API key", since the operator\'s ' +
        'session is not sent to a port that cannot be confirmed as this server'
    };
  }

  const scheme = listeners.ssl ? 'https' : 'http';
  const host = listeners.hosts.has('localhost')
    ? 'localhost'
    : listeners.hosts.has('127.0.0.1')
      ? '127.0.0.1'
      : '[::1]';

  return { baseUrl: `${scheme}://${host}:${listeners.primary}`, own };
}

/**
 * The History API base URL, for display: the URL resolveHistoryTarget would
 * call, or - when this server's port is not known and nothing is called - a
 * sentence saying so. Requests use resolveHistoryTarget.
 */
function resolveHistoryBaseUrl(app, config) {
  const target = resolveHistoryTarget(app, config);
  return target.baseUrl || `not called: the port is not known (${target.own.reason})`;
}

function resolveWindow(config, now = new Date()) {
  const durationSeconds = Math.min(
    MAX_DURATION_SECONDS,
    config.historyDurationSeconds || parseDurationSeconds(DEFAULT_HISTORY_DURATION)
  );
  const samples = config.historySamples || DEFAULT_HISTORY_SAMPLES;
  // The row bound outranks even an explicit resolution: an operator typing 1s
  // against a month window has asked for 2.7 million rows, and no summary this
  // module produces can use more than a few thousand of them.
  const resolutionSeconds = Math.max(
    MIN_RESOLUTION_SECONDS,
    config.historyResolutionSeconds || Math.round(durationSeconds / samples),
    Math.ceil(durationSeconds / MAX_HISTORY_ROWS)
  );

  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - durationSeconds * 1000);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    durationSeconds,
    resolutionSeconds
  };
}

function buildValuesUrl(baseUrl, paths, window, config) {
  const params = new URLSearchParams();
  params.set('paths', paths.join(','));
  params.set('from', window.from);
  params.set('to', window.to);
  params.set('resolution', String(window.resolutionSeconds));
  if (config.historyProvider) {
    params.set('provider', config.historyProvider);
  }

  return `${baseUrl}${HISTORY_API_PATH}/values?${params.toString()}`;
}

/**
 * True when the History API being called is this machine's own server.
 *
 * Only a loopback target may be sent the operator's session, so a hostname
 * that does not parse, or that resolves anywhere else, is treated as remote.
 */
function isLoopbackTarget(baseUrl) {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function effectivePort(url) {
  return url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
}

const DEFAULT_SIGNALK_SSL_PORT = 3443;

function validPort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : undefined;
}

/**
 * True when this machine has the loopback address of `family` (4 or 6). A
 * family with no loopback address cannot be bound by anyone, so a name that
 * may resolve to it cannot reach another process. Unknown counts as present:
 * the answer only ever widens what is trusted.
 */
function hasLoopbackAddress(family) {
  try {
    const want = family === 6 ? '::1' : '127.0.0.1';
    return Object.values(os.networkInterfaces()).some((entries) =>
      (entries || []).some((entry) => entry && entry.address === want)
    );
  } catch {
    return true;
  }
}

/**
 * The loopback hostnames that reach a listener bound to `address`, as
 * `new URL(...).hostname` spells them.
 *
 * - The IPv6 wildcard `::` is taken as dual-stack, which is how Node binds a
 *   listen() with no host (it clears IPV6_V6ONLY itself) and how a systemd
 *   ListenStream=<port> socket binds by default: while it holds the port, no
 *   other process can hold 127.0.0.1 or [::1] on it, so every loopback name
 *   reaches it. A v6only wildcard cannot be told apart from here; see
 *   docs/history.md.
 * - An IPv4 listener (0.0.0.0, or 127.0.0.1) leaves [::1] on the same port
 *   free for another process, and an IPv6 [::1] listener leaves 127.0.0.1
 *   free, so only the matching literal counts. `localhost` resolves to both
 *   families and fetch tries both, so it counts only when the other family
 *   has no loopback address on this machine for anyone to bind.
 * - Any other address (a LAN address, 127.0.0.2) is not reached through
 *   these names at all.
 */
function loopbackHostsFor(address, family) {
  const v6 = family === 'IPv6' || family === 6;
  if (v6 && (address === '::' || address === '0:0:0:0:0:0:0:0')) {
    return new Set(LOOPBACK_HOSTNAMES);
  }
  if (!v6 && (address === '0.0.0.0' || address === '127.0.0.1')) {
    return new Set(hasLoopbackAddress(6) ? ['127.0.0.1'] : ['127.0.0.1', 'localhost']);
  }
  if (v6 && address === '::1') {
    return new Set(hasLoopbackAddress(4) ? ['[::1]', '::1'] : ['[::1]', '::1', 'localhost']);
  }
  return new Set();
}

/**
 * The main listener as the server itself reports it. signalk-server sets
 * `app.server` before it starts plugins and listens on it afterwards, so its
 * address() is read here, at request time, not when the plugin starts. It is
 * null until the server listens, a string for a local (unix) socket, and
 * `{ address, family, port }` for TCP - whatever the port came from: PORT,
 * settings, or a socket systemd handed over.
 */
function serverAddress(app) {
  const server = app && app.server;
  if (!server || typeof server.address !== 'function') {
    return undefined;
  }
  try {
    return server.address() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Signal K server in this process: where its main listener is, and which
 * loopback hostnames and ports reach it.
 *
 * The listener's own address (`app.server.address()`) is used whenever the
 * server reports one. That covers systemd socket activation, which
 * signalk-server-setup uses for every systemd install: the server listens on
 * the activated socket and on none of the configured ports, and the socket's
 * port is visible only this way. Its address and family also say which
 * loopback names reach it (loopbackHostsFor). Only the main listener counts.
 * With TLS on that is the https server; the http redirect beside it is not
 * on `app.server`, serves nothing but a redirect to the advertised port
 * (EXTERNALPORT, which may be a reverse proxy), and is not sent the session.
 *
 * Without an address (an older server, or before it listens), the port is
 * worked out the way signalk-server's ports.js picks it:
 *
 * - http port: `Number(PORT) || settings.port || 3000`;
 * - with TLS on, the https port, `Number(SSLPORT) || settings.sslport || 3443`,
 *   is the main listener, and the http port carries the server's redirect to
 *   it. Only the value the server uses counts: with PORT set, settings.port is
 *   not a listener, and with SSLPORT set, settings.sslport is not one.
 * - under socket activation (`LISTEN_FDS` > 0) none of these is its port and
 *   the socket's cannot be known, so no port counts. EXTERNALPORT is not taken
 *   for it: it is the port the server advertises, often a reverse proxy's (an
 *   nginx on 80 in front of ListenStream=3000), and that proxy is not this
 *   server.
 *
 * EXTERNALPORT and settings.proxy_port never count: they are the ports a
 * reverse proxy publishes, not ones this process listens on.
 *
 * `primary` is the main listener's port (undefined when unknown), `ports`
 * every listener's that counts, `hosts` the loopback hostnames that reach
 * them, `ssl` whether the main listener speaks TLS, and `reason` - set when
 * `ports` is empty - why no port counts.
 */
function signalkListeners(app) {
  const settings = (app && app.config && app.config.settings) || {};
  const ssl = Boolean(settings.ssl);
  const none = (reason) => ({ ssl, primary: undefined, ports: [], hosts: new Set(), reason });

  const address = serverAddress(app);
  if (typeof address === 'string') {
    return none(`it listens on the local socket ${address}, not on a TCP port`);
  }
  if (address && validPort(address.port)) {
    const hosts = loopbackHostsFor(address.address, address.family);
    if (hosts.size === 0) {
      return none(`it listens on ${address.address} port ${address.port} only, which loopback does not reach`);
    }
    return { ssl, primary: address.port, ports: [address.port], hosts };
  }

  if (Number(process.env.LISTEN_FDS) > 0) {
    return none(
      'it was started by systemd socket activation and the server does not report the socket it listens on'
    );
  }
  // Node's listen() with no host binds the dual-stack wildcard, or 0.0.0.0
  // on a host without IPv6, where nobody can bind [::1] either: every
  // loopback name reaches it.
  const hosts = new Set(LOOPBACK_HOSTNAMES);
  const httpSetting = Number(process.env.PORT) || settings.port || DEFAULT_SIGNALK_PORT;
  const http = validPort(httpSetting);
  if (!ssl) {
    return http
      ? { ssl, primary: http, ports: [http], hosts }
      : none(`its configured port (${httpSetting}) is not a valid TCP port`);
  }
  const httpsSetting = Number(process.env.SSLPORT) || settings.sslport || DEFAULT_SIGNALK_SSL_PORT;
  const https = validPort(httpsSetting);
  if (!https) {
    return none(`its configured TLS port (${httpsSetting}) is not a valid TCP port`);
  }
  return { ssl, primary: https, ports: [https, http].filter(Boolean), hosts };
}

/**
 * This Signal K server as isOwnServer takes it: the ports that count (as
 * strings), the loopback hostnames that reach them, and - when no port
 * counts - the reason (signalkListeners).
 */
function ownServer(app) {
  const { ports, hosts, reason } = signalkListeners(app);
  return { ports: new Set(ports.map(String)), hosts, ...(reason ? { reason } : {}) };
}

/** The ports this Signal K server listens on, as strings (ownServer). */
function ownServerPorts(app) {
  return ownServer(app).ports;
}

/**
 * True when `baseUrl` is this Signal K server: a loopback host that reaches
 * it, on one of the ports it listens on. `own` is ownServer(app); a Set or
 * array of ports (any loopback host), or a URL (its loopback host family and
 * port) are accepted too.
 *
 * Loopback alone is not enough. Any service on this machine is on loopback,
 * and a historyServerUrl of localhost at another port would hand that service
 * the operator's cookie or bearer token. Nor is every loopback name enough:
 * a listener on one address family leaves the other family's loopback, on the
 * same port, to whoever binds it (loopbackHostsFor). The scheme is not
 * compared: http and https on the same local port are the same listener.
 */
function isOwnServer(baseUrl, own) {
  if (!own || !isLoopbackTarget(baseUrl)) {
    return false;
  }
  try {
    let ports;
    let hosts = LOOPBACK_HOSTNAMES;
    if (typeof own === 'string') {
      if (!isLoopbackTarget(own)) return false;
      ports = new Set([effectivePort(new URL(own))]);
    } else if (own instanceof Set || Array.isArray(own)) {
      ports = new Set(own);
    } else {
      ports = own.ports instanceof Set ? own.ports : new Set(own.ports || []);
      hosts = own.hosts instanceof Set ? own.hosts : new Set(own.hosts || []);
    }
    const url = new URL(baseUrl);
    return hosts.has(url.hostname.toLowerCase()) && ports.has(effectivePort(url));
  } catch {
    return false;
  }
}

/**
 * The 401/403 explanation for a target that was not sent the session and
 * had no key to send instead: a loopback URL that is not this server is
 * named as such, with what this server is - its ports and the names that
 * reach it, or why none is known - so an operator who typed their own
 * server's address can see why.
 */
function credentialHint(baseUrl, own, status) {
  if (isLoopbackTarget(baseUrl)) {
    let port = '';
    let host = 'localhost';
    try {
      const url = new URL(baseUrl);
      port = effectivePort(url);
      host = url.hostname;
    } catch {
      // Unparseable: the generic wording below still applies.
    }
    const ports = own instanceof Set || Array.isArray(own) ? new Set(own) : new Set((own && own.ports) || []);
    const hosts = own && !(own instanceof Set) && !Array.isArray(own) && own.hosts ? own.hosts : LOOPBACK_HOSTNAMES;
    const subject =
      `HTTP ${status}: ${host}${port ? ` port ${port}` : ''} is not recognised as this Signal K server`;
    if (ports.size === 0) {
      const reason = (own && own.reason) || 'no port of its is known';
      return (
        `${subject} (its port is not known: ${reason}), so the operator's session was not sent; ` +
        'give the server a credential in "History API key"'
      );
    }
    const reachedAt = [...hosts].filter((name) => name !== '::1');
    const where = reachedAt.length < LOOPBACK_HOSTNAMES.size - 1 ? `, reached at ${reachedAt.join(' or ')} only` : '';
    return (
      `${subject} (its ports: ${[...ports].join(', ')}${where}), so the operator's session was not sent; ` +
      'leave "Signal K server URL" blank to use this server, or give that service its own credential in "History API key"'
    );
  }
  return `HTTP ${status}: a history server other than this one needs its own credential in "History API key"`;
}

// Codes Node's TLS layer gives a certificate it does not accept.
const TLS_CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED'
]);

/**
 * Why a fetch threw, for an operator. fetch reports every network failure as
 * a bare "fetch failed" and keeps the reason in `error.cause`, so its code is
 * appended (ECONNREFUSED, ENOTFOUND, DEPTH_ZERO_SELF_SIGNED_CERT, ...), and a
 * certificate the TLS layer rejected comes with what makes it verify.
 */
function describeFetchError(error) {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown history failure.';
  const cause = error && error.cause;
  let code = cause && typeof cause.code === 'string' ? cause.code : undefined;
  if (!code && cause && Array.isArray(cause.errors)) {
    const inner = cause.errors.find((item) => item && typeof item.code === 'string');
    code = inner && inner.code;
  }
  if (!code || message.includes(code)) {
    return message;
  }
  if (!TLS_CERTIFICATE_CODES.has(code)) {
    return `${message}: ${code}`;
  }
  return (
    `${message}: ${code}, the server's TLS certificate is not trusted; for Signal K's own generated ` +
    'certificate (issued to localhost), start Signal K with NODE_EXTRA_CA_CERTS set to ssl-cert.pem in its ' +
    'configuration directory and call it as https://localhost, or trust the issuer of another server\'s ' +
    'certificate the same way'
  );
}

/**
 * The detail for a failed history response, given what the server said
 * (`serverDetail`). A 401/403 from a target that is not this server is
 * explained by what was sent to it: with `historyApiKey` configured that key
 * went, so the server's own error stands and the key is named as rejected;
 * with none, nothing went, and credentialHint says why the session did not.
 * Anything else - this server, or another status - keeps the server's error.
 */
function historyFailureDetail(baseUrl, own, status, config, serverDetail) {
  if ((status !== 401 && status !== 403) || isOwnServer(baseUrl, own)) {
    return serverDetail;
  }
  if (config && config.historyApiKey) {
    return `${serverDetail}; the configured "History API key" was sent and rejected`;
  }
  return credentialHint(baseUrl, own, status);
}

/**
 * Credentials for a server with security enabled.
 *
 * The History API is behind the same authentication as the rest of the REST
 * API, and a plugin has no session of its own. The operator asking the question
 * does: their cookie or bearer token arrives on the request that reached
 * /bridge/execute, so the history read runs with exactly the access they
 * already have - no ambient credential, and no way for the plugin to read
 * history a user could not read themselves.
 *
 * That reasoning only holds for this server. `historyServerUrl` can point at
 * another Signal K instance, and a cookie minted by this server is replayable
 * against it - a misconfigured or hostile host would be handed the operator's
 * live session. So the session travels to this server only (a loopback name
 * that reaches it, on a port it listens on: `options.ownPorts` from
 * ownServer, or the host and port of `options.ownBaseUrl`); anything else -
 * another host, or
 * another service on this machine - gets `historyApiKey`, a credential issued
 * for that destination, or nothing.
 */
function historyRequestHeaders(baseUrl, config, options = {}) {
  const headers = { accept: 'application/json' };

  if (isOwnServer(baseUrl, options.ownPorts || options.ownBaseUrl)) {
    return { ...headers, ...(options.authHeaders || {}) };
  }

  if (config.historyApiKey) {
    headers.authorization = `Bearer ${config.historyApiKey}`;
  }

  return headers;
}

function authHeadersFromRequest(req) {
  const source = (req && req.headers) || {};
  const headers = {};

  if (typeof source.authorization === 'string' && source.authorization.length > 0) {
    headers.authorization = source.authorization;
  }
  if (typeof source.cookie === 'string' && source.cookie.length > 0) {
    headers.cookie = source.cookie;
  }

  return headers;
}

/**
 * Round to the precision the path's unit is reported at - one decimal for a
 * heading, six for a position - so a statistic sits beside the samples it
 * summarizes at the same precision. Matches roundForPrompt in ai-service for
 * anything without a converted unit.
 */
function roundForPrompt(value, decimals = DEFAULT_DECIMALS) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number(value.toFixed(decimals));
  }
  return value;
}

/**
 * Evenly spaced picks including the first and last point.
 *
 * Taking the newest N would hide the start of the window - which is the half of
 * a trend question that matters - and taking every point would blow the context
 * budget. The endpoints are always kept so "then" and "now" are both present.
 */
function pickEvenly(points, limit) {
  if (points.length <= limit) {
    return points;
  }
  if (limit === 1) {
    return [points[points.length - 1]];
  }

  const picked = [];
  const step = (points.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    picked.push(points[Math.round(index * step)]);
  }

  return picked;
}

/**
 * One series from one response column: the non-null points, evenly picked
 * samples, and min/max/first/last/average at the path's unit precision.
 */
function summarizeColumn(pathSpec, rows, columnIndex, samplesLimit) {
  const parsed = parsePathSpec(pathSpec) || { path: pathSpec };
  const decimals = promptDecimalsForPath(parsed.path);
  const points = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length <= columnIndex) {
      continue;
    }
    const value = row[columnIndex];
    // Providers return null for a window with no data, which is information
    // about the gap rather than a value; the count below is what tells the
    // model how thin the series is.
    if (value === null || value === undefined) {
      continue;
    }
    const timestamp = typeof row[0] === 'string' ? row[0] : undefined;
    points.push([timestamp, roundForPrompt(convertAiValueForPath(parsed.path, value), decimals)]);
  }

  if (points.length === 0) {
    return undefined;
  }

  const numbers = points.map(([, value]) => value).filter((value) => typeof value === 'number');
  const summary = {
    count: points.length,
    samples: pickEvenly(points, samplesLimit)
  };

  if (numbers.length > 0) {
    // Incrementally, not Math.min(...numbers): spreading a column into an
    // argument list throws RangeError past ~125k values, and a provider that
    // ignores the requested resolution can return that many. The outer catch
    // would have dressed that crash up as "history unavailable".
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const value of numbers) {
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
      sum += value;
    }
    summary.first = numbers[0];
    summary.last = numbers[numbers.length - 1];

    // A direction series that crosses north breaks plain arithmetic: headings
    // of 350 and 10 average to 180 - due south - and their min/max of 10/350
    // describe the arc the vessel never pointed through. When the spread says
    // the series wraps (a real heading swing of >180 degrees in one window is
    // the rarer reading), the mean is taken on the circle and min/max are
    // withheld rather than reported wrong. A series that stays inside half the
    // circle keeps ordinary statistics, which are correct there.
    // >= on purpose: directions exactly 180 apart are the antipodal case
    // circularMeanDegrees defines as having no mean, and arithmetic would have
    // reported a heading of 0-and-180 as 90 - due east - with equal confidence.
    if (isAnglePath(parsed.path) && max - min >= 180) {
      const mean = circularMeanDegrees(numbers);
      if (mean !== undefined) {
        summary.average = roundForPrompt(mean, decimals);
      }
    } else {
      summary.min = roundForPrompt(min, decimals);
      summary.max = roundForPrompt(max, decimals);
      summary.average = roundForPrompt(sum / numbers.length, decimals);
    }
  }

  return summary;
}

/**
 * The History API response, reduced to what is worth a prompt token.
 *
 * `data` rows are `[timestamp, ...one value per entry in values]`, so the
 * column order is the order of `values` - which is also the order the paths
 * were requested in. Falling back to the requested list keeps a provider that
 * omits `values` readable.
 */
function summarizeHistoryPayload(payload, requestedSpecs, samplesLimit) {
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  const declared = Array.isArray(payload && payload.values) ? payload.values : [];

  // Each declared column is matched to a requested spec by what the provider
  // says the column IS - its path and method - not by its position. The
  // History API does not promise response order, and a provider may omit a
  // path it has nothing for: positionally, a dropped first column shifted
  // every spec one column left, so the wrong specs were marked as answered.
  // Multiplicity is respected (each spec is claimed once), an exact
  // path+method match wins over a path-only one, and a column declaring no
  // path at all falls back to its position.
  const remaining = requestedSpecs.map((spec) => ({ spec, parsed: parsePathSpec(spec), used: false }));
  const claimSpec = (path, method) => {
    const exact = remaining.find(
      (item) => !item.used && item.parsed?.path === path && (item.parsed?.method ?? undefined) === (method ?? undefined)
    );
    const match = exact || remaining.find((item) => !item.used && item.parsed?.path === path);
    if (!match) {
      return undefined;
    }
    match.used = true;
    return match.spec;
  };
  const claimByPosition = (index) => {
    const item = remaining[index];
    if (!item || item.used) {
      return undefined;
    }
    item.used = true;
    return item.spec;
  };

  const columns = declared.length > 0
    ? declared.map((entry, index) => {
        const declaredPath = typeof entry?.path === 'string' ? entry.path : undefined;
        const declaredMethod = typeof entry?.method === 'string' ? entry.method : undefined;
        const spec = declaredPath ? claimSpec(declaredPath, declaredMethod) : claimByPosition(index);
        const parsedSpec = parsePathSpec(spec);
        return {
          spec,
          path: declaredPath || parsedSpec?.path,
          method: declaredMethod ?? parsedSpec?.method
        };
      })
    : requestedSpecs.map((spec) => {
        const parsed = parsePathSpec(spec);
        return { spec, path: parsed?.path, method: parsed?.method };
      });

  // Asking for the same path twice under different aggregations is a
  // legitimate request - min and max of the wind over the window, say - and
  // keying on the path alone let the second column silently overwrite the
  // first. The method only joins the key where it has to disambiguate, so the
  // ordinary series stays keyed exactly like its live counterpart.
  const pathCounts = new Map();
  for (const column of columns) {
    const path = column.path || column.spec;
    if (path) {
      pathCounts.set(path, (pathCounts.get(path) || 0) + 1);
    }
  }

  const seriesKey = (column, index) => {
    const path = column.path || column.spec;
    if (!path || (pathCounts.get(path) || 0) < 2) {
      return path;
    }
    return column.method ? `${path}:${column.method}` : `${path}#${index + 1}`;
  };

  const series = {};
  const unavailablePaths = [];

  // Where each series' spec sits in the request: the prompt budget keeps
  // series in this order, and the request order is the operator's priority
  // order - not whatever column order the provider answered in.
  const seriesOrder = new Map();
  columns.forEach((column, index) => {
    const key = seriesKey(column, index);
    if (!key) {
      return;
    }

    // The provider-declared path, not the request-order spec, decides the unit
    // conversion: a provider that returns `values` in a different order than
    // requested would otherwise get another path's radians-to-degrees applied.
    const summary = summarizeColumn(column.path || column.spec || key, rows, index + 1, samplesLimit);
    if (!summary) {
      unavailablePaths.push(key);
      return;
    }

    series[key] = column.method ? { method: column.method, ...summary } : summary;
    seriesOrder.set(key, column.spec === undefined ? Infinity : requestedSpecs.indexOf(column.spec));
  });

  // A path the provider dropped from `values` entirely never got a column. A
  // spec that DID get a column is already accounted for - as a series or an
  // unavailable entry - under whatever key seriesKey chose for it, so it must
  // not be re-derived here: a bare duplicate is keyed `path#N`, which this
  // loop cannot reconstruct, and re-deriving it reported the path unavailable
  // right next to its own series.
  const coveredSpecs = new Set(columns.map((column) => column.spec).filter(Boolean));
  const covered = new Set([...Object.keys(series), ...unavailablePaths]);
  for (const spec of requestedSpecs) {
    if (coveredSpecs.has(spec)) {
      continue;
    }
    const parsed = parsePathSpec(spec);
    const path = parsed ? parsed.path : spec;
    const key = parsed && parsed.method && (pathCounts.get(path) || 0) > 1
      ? `${path}:${parsed.method}`
      : path;
    if (!covered.has(key) && !covered.has(path)) {
      unavailablePaths.push(key);
      covered.add(key);
    }
  }

  const ordered = Object.fromEntries(
    Object.entries(series).sort(([a], [b]) => {
      const left = seriesOrder.has(a) && seriesOrder.get(a) >= 0 ? seriesOrder.get(a) : Number.MAX_SAFE_INTEGER;
      const right = seriesOrder.has(b) && seriesOrder.get(b) >= 0 ? seriesOrder.get(b) : Number.MAX_SAFE_INTEGER;
      return left - right;
    })
  );

  return { series: ordered, unavailablePaths };
}

async function readErrorMessage(response) {
  try {
    const text = await response.text();
    const trimmed = String(text || '').trim();
    if (trimmed.length === 0) {
      return `HTTP ${response.status}`;
    }
    return `HTTP ${response.status}: ${trimmed.slice(0, 200)}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * Historical series for the prompt, or an explanation of why there are none.
 *
 * Never throws and never rejects: the caller is in the middle of answering an
 * operator's question, and a history provider that is not installed is the
 * normal case, not a failure of the question.
 */
async function collectHistoryContext(app, config, dependencies = {}, options = {}) {
  if (!config || config.historyEnabled !== true) {
    return undefined;
  }

  // A disabled AI pipeline never builds a prompt, so reading history for it
  // would be a database query nothing consumes.
  if (config.enabled === false) {
    return undefined;
  }

  const requestedPaths = resolveHistoryPaths(config);
  const window = resolveWindow(config);
  const base = {
    from: window.from,
    to: window.to,
    resolutionSeconds: window.resolutionSeconds,
    requestedPaths,
    ...(config.historyProvider ? { provider: config.historyProvider } : {})
  };

  if (requestedPaths.length === 0) {
    return {
      ...base,
      message:
        'History is enabled but no history paths are configured, and no exact live paths were available to reuse.'
    };
  }

  const { baseUrl, own: ownPorts, unknown } = resolveHistoryTarget(app, config);
  if (!baseUrl) {
    return { ...base, message: `Signal K History API was not called: ${unknown}; no historical data is included.` };
  }
  const url = buildValuesUrl(baseUrl, requestedPaths, window, config);

  try {
    const fetchImpl = createTimedFetch(resolveFetch(dependencies), config.historyTimeoutMs);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: historyRequestHeaders(baseUrl, config, { ...options, ownPorts }),
      signal: options.signal
    });

    if (!response.ok) {
      // 404 is the shape "no history provider is installed" arrives in, and it
      // is worth saying plainly - an operator who enabled history and got a
      // bare HTTP 404 has no way to know that is what it means.
      // The operator's session is deliberately sent to this server only, so
      // anything else that wants credentials has to be given its own.
      const detail =
        response.status === 404
          ? 'the server has no history provider installed, or the History API is not available'
          : historyFailureDetail(baseUrl, ownPorts, response.status, config, await readErrorMessage(response));
      return {
        ...base,
        message: `Signal K History API returned an error (${detail}); no historical data is included.`
      };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return {
        ...base,
        message: `The Signal K History API response could not be read (${
          error instanceof Error ? error.message : 'unparseable body'
        }); no historical data is included.`
      };
    }

    const { series, unavailablePaths } = summarizeHistoryPayload(
      payload,
      requestedPaths,
      config.historySamples || DEFAULT_HISTORY_SAMPLES
    );

    return {
      ...base,
      // Upstream text, and the only part of the header a provider controls the
      // length of - it is counted against the prompt budget, so cap it here
      // rather than let one field crowd out the series it labels.
      ...(typeof payload?.context === 'string'
        ? { context: payload.context.slice(0, MAX_CONTEXT_LABEL_CHARS) }
        : {}),
      series,
      ...(unavailablePaths.length > 0 ? { unavailablePaths } : {}),
      ...(Object.keys(series).length === 0
        ? { message: 'The History API returned no data for the requested window.' }
        : {})
    };
  } catch (error) {
    return {
      ...base,
      message: `Signal K History API is unreachable (${describeFetchError(error)}); no historical data is included.`
    };
  }
}

/**
 * The paths the History API has recorded data for, for the panel's picker.
 *
 * Discovery wants breadth where a question wants focus: the configured
 * question window can be fifteen minutes, but an operator choosing paths cares
 * about what the provider records at all, so the listing window is at least a
 * day. Same endpoint resolution and credential scoping as the values read -
 * the operator's session goes to a loopback server only, a remote one gets
 * historyApiKey - and failures come back as a `message`, never a throw: an
 * empty picker with a reason beats a broken card.
 */
async function listHistoryPaths(app, config, dependencies = {}, options = {}) {
  const windowSeconds = Math.max(config.historyDurationSeconds || 0, 24 * 60 * 60);
  const { baseUrl, own: ownPorts, unknown } = resolveHistoryTarget(app, config);
  if (!baseUrl) {
    return { paths: [], windowSeconds, message: `Signal K History API was not called: ${unknown}.` };
  }
  const params = new URLSearchParams({ duration: String(windowSeconds) });
  // The same provider the values read will use: with several providers
  // installed, listing the default one's paths would offer the operator
  // series the configured provider cannot actually serve.
  if (config.historyProvider) {
    params.set('provider', config.historyProvider);
  }
  const url = `${baseUrl}${HISTORY_API_PATH}/paths?${params.toString()}`;

  try {
    const fetchImpl = createTimedFetch(resolveFetch(dependencies), config.historyTimeoutMs);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: historyRequestHeaders(baseUrl, config, { ...options, ownPorts }),
      signal: options.signal
    });

    if (!response.ok) {
      const detail =
        response.status === 404
          ? 'the server has no history provider installed, or the History API is not available'
          : historyFailureDetail(baseUrl, ownPorts, response.status, config, await readErrorMessage(response));
      return { paths: [], windowSeconds, message: `Signal K History API returned an error (${detail}).` };
    }

    const payload = await response.json();
    const paths = (Array.isArray(payload) ? payload : [])
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .sort();

    return { paths: [...new Set(paths)], windowSeconds };
  } catch (error) {
    return { paths: [], windowSeconds, message: `Signal K History API is unreachable (${describeFetchError(error)}).` };
  }
}

module.exports = {
  AGGREGATION_METHODS,
  DEFAULT_HISTORY_DURATION,
  DEFAULT_HISTORY_SAMPLES,
  DEFAULT_HISTORY_TIMEOUT_MS,
  MAX_HISTORY_PATHS,
  MAX_HISTORY_SAMPLES,
  MIN_HISTORY_SAMPLES,
  authHeadersFromRequest,
  buildValuesUrl,
  collectHistoryContext,
  credentialHint,
  describeFetchError,
  historyFailureDetail,
  historyRequestHeaders,
  isOwnServer,
  ownServer,
  ownServerPorts,
  listHistoryPaths,
  normalizeHistoryConfig,
  parseDurationSeconds,
  resolveHistoryBaseUrl,
  resolveHistoryPaths,
  resolveHistoryTarget,
  resolveWindow,
  signalkListeners,
  summarizeHistoryPayload
};
