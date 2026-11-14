'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const nodePath = require('node:path');
const { createWatchEngine, normalizeWatchConfig } = require('./watch/engine.cjs');
const { createTimedFetch, resolveFetch } = require('./http-utils.cjs');
const {
  buildValuesUrl,
  historyRequestHeaders,
  listHistoryPaths,
  parseDurationSeconds,
  resolveHistoryBaseUrl
} = require('./history-service.cjs');

/**
 * Watchkeeper inside Signal K: the engine wired to the server.
 *
 *   in   every self-vessel delta, through the subscription manager
 *   out  one Signal K notification per affected path, under
 *        notifications.aiBridge.watch.*, so KIP, Freeboard, WilhelmSK and every
 *        other notification consumer shows them with no extra setup
 *   disk the learned baseline, so a restart does not cost a learning period
 *
 * The language model is not involved. It is not called on a timer, not called
 * per finding, and not needed for the watch to work: with the inference host
 * down or the AI pipeline disabled, the watch runs exactly the same.
 */

const TICK_MS = 5000;
const SAVE_MS = 5 * 60 * 1000;
const META_PER_TICK = 50;
const META_REFRESH_MS = 30 * 60 * 1000;
const MESSAGE_REFRESH_MS = 60 * 1000;
const STATE_FILE = 'watch-state.json';
const MAX_STATE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const NOTIFICATION_ROOT = 'notifications.aiBridge.watch';

// Replay bounds: a day of ten-second rows for eighty paths is ~700k values,
// which the engine chews through in well under a second, and asks the history
// provider for a bounded number of bounded requests.
const MAX_REPLAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_REPLAY_PATHS = 80;
const REPLAY_PATHS_PER_REQUEST = 10;
const REPLAY_MAX_ROWS = 10000;
const REPLAY_TIMEOUT_MS = 30000;
const REPLAY_TICK_MS = 5000;

function watchError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function notificationPath(key) {
  return `${NOTIFICATION_ROOT}.${key}`;
}

function sourceLabel(update) {
  if (typeof update.$source === 'string') return update.$source;
  const source = update.source;
  if (source && typeof source === 'object') {
    return [source.label, source.src].filter(Boolean).join('.') || undefined;
  }
  return undefined;
}

function createWatchService(app, dependencies = {}) {
  const now = () => (typeof dependencies.now === 'function' ? dependencies.now() : Date.now());
  const pluginId = dependencies.pluginId || 'signalk-ai-bridge';

  let engine;
  let config;
  let running = false;
  let unsubscribes = [];
  let tickTimer;
  let saveTimer;
  let startedAt;
  let lastSavedAt;
  let lastError;
  let subscription = 'none';
  let restored = false;
  let replayRunning = false;
  let lastReplay;
  const emitted = new Map();
  const metaQueue = new Set();
  let lastMetaRefresh = 0;
  let samples = 0;

  function stateFile() {
    if (typeof app.getDataDirPath !== 'function') return undefined;
    try {
      const dir = app.getDataDirPath();
      return typeof dir === 'string' && dir.length > 0 ? nodePath.join(dir, STATE_FILE) : undefined;
    } catch {
      return undefined;
    }
  }

  function loadState(t) {
    const file = stateFile();
    if (!file) return false;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || typeof saved.savedAt !== 'number' || t - saved.savedAt > MAX_STATE_AGE_MS) {
        return false;
      }
      return engine.importState(saved, t);
    } catch {
      return false;
    }
  }

  async function saveState() {
    const file = stateFile();
    if (!file || !engine) return;
    const t = now();
    const tmp = `${file}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(engine.exportState(t)));
      await fsp.rename(tmp, file);
      lastSavedAt = t;
    } catch (error) {
      lastError = `Could not save the watch baseline: ${error instanceof Error ? error.message : error}`;
    }
  }

  function handleDelta(delta) {
    if (!engine || !delta || !Array.isArray(delta.updates)) return;
    const t = now();
    for (const update of delta.updates) {
      if (!update) continue;
      const source = sourceLabel(update);
      if (Array.isArray(update.values)) {
        for (const entry of update.values) {
          if (entry && typeof entry.path === 'string') {
            samples += 1;
            engine.ingest(entry.path, entry.value, t, source);
          }
        }
      }
      if (Array.isArray(update.meta)) {
        for (const entry of update.meta) {
          if (entry && typeof entry.path === 'string') engine.setMeta(entry.path, entry.value);
        }
      }
    }
  }

  function subscribe() {
    const manager = app.subscriptionmanager;
    if (manager && typeof manager.subscribe === 'function') {
      manager.subscribe(
        { context: 'vessels.self', subscribe: [{ path: '*', policy: 'instant', minPeriod: 1000 }] },
        unsubscribes,
        (error) => {
          lastError = `Subscription error: ${error instanceof Error ? error.message : error}`;
        },
        handleDelta
      );
      return 'subscriptionmanager';
    }
    const bundle = app.streambundle;
    if (bundle && typeof bundle.getSelfBus === 'function') {
      const bus = bundle.getSelfBus();
      if (bus && typeof bus.onValue === 'function') {
        const stop = bus.onValue((value) => {
          if (value && typeof value.path === 'string') {
            samples += 1;
            engine.ingest(value.path, value.value, now(), value.$source);
          }
        });
        if (typeof stop === 'function') unsubscribes.push(stop);
        return 'streambundle';
      }
    }
    return 'none';
  }

  function lookupMeta() {
    if (typeof app.getSelfPath !== 'function') return;
    let count = 0;
    for (const path of metaQueue) {
      if (count >= META_PER_TICK) break;
      metaQueue.delete(path);
      count += 1;
      try {
        const node = app.getSelfPath(path);
        if (node && typeof node === 'object' && node.meta) engine.setMeta(path, node.meta);
      } catch {
        // Metadata is a refinement; a path without it uses leaf-name units.
      }
    }
  }

  function methodsFor(state) {
    return config.watchSound && state === 'alert' ? ['visual', 'sound'] : ['visual'];
  }

  function publish(values) {
    if (values.length === 0 || typeof app.handleMessage !== 'function') return;
    try {
      app.handleMessage(pluginId, { updates: [{ values }] });
    } catch (error) {
      lastError = `Could not publish a notification: ${error instanceof Error ? error.message : error}`;
    }
  }

  /**
   * Bring the server's notifications in line with the open findings. A state
   * change goes out at once; a message that only refreshed its numbers goes
   * out at most once a minute, so a live finding does not flood every
   * notification consumer on the boat with a delta every five seconds.
   */
  function syncNotifications(t) {
    if (!config.watchNotifications) return;
    const states = engine.notificationStates();
    const values = [];
    for (const [key, state] of states) {
      const previous = emitted.get(key);
      const changedState = !previous || previous.state !== state.state;
      const changedText = previous && previous.message !== state.message && t - previous.sentAt >= MESSAGE_REFRESH_MS;
      if (changedState || changedText) {
        values.push({
          path: notificationPath(key),
          value: { state: state.state, method: methodsFor(state.state), message: state.message }
        });
        emitted.set(key, { ...state, sentAt: t });
      }
    }
    for (const [key, previous] of emitted) {
      if (!states.has(key)) {
        values.push({
          path: notificationPath(key),
          value: { state: 'normal', method: [], message: `Back to normal: ${previous.title}` }
        });
        emitted.delete(key);
      }
    }
    publish(values);
  }

  function clearNotifications() {
    const values = [...emitted.entries()].map(([key, previous]) => ({
      path: notificationPath(key),
      value: { state: 'normal', method: [], message: `Watch stopped: ${previous.title}` }
    }));
    emitted.clear();
    publish(values);
  }

  function tick() {
    if (!engine) return;
    const t = now();
    try {
      if (t - lastMetaRefresh >= META_REFRESH_MS) {
        for (const path of engine.paths()) metaQueue.add(path);
        lastMetaRefresh = t;
      }
      lookupMeta();
      engine.tick(t);
      syncNotifications(t);
    } catch (error) {
      lastError = `Watch tick failed: ${error instanceof Error ? error.message : error}`;
    }
  }

  function start(options = {}) {
    stop();
    config = normalizeWatchConfig(options);
    if (!config.watchEnabled) return false;
    const t = now();
    engine = createWatchEngine(config, { now: t, onNewPath: (path) => metaQueue.add(path) });
    restored = loadState(t);
    lastMetaRefresh = t;
    startedAt = t;
    samples = 0;
    lastError = undefined;
    running = true;
    subscription = subscribe();
    if (subscription === 'none') {
      lastError = 'This Signal K server offers neither a subscription manager nor a stream bundle; nothing to watch.';
    }
    tickTimer = setInterval(tick, TICK_MS);
    saveTimer = setInterval(() => {
      saveState().catch(() => {});
    }, SAVE_MS);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
    return true;
  }

  function stop() {
    if (tickTimer) clearInterval(tickTimer);
    if (saveTimer) clearInterval(saveTimer);
    tickTimer = undefined;
    saveTimer = undefined;
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Already gone.
      }
    }
    unsubscribes = [];
    if (running && engine) {
      clearNotifications();
      // Best effort: the baseline is worth keeping, but stop() cannot wait.
      saveState().catch(() => {});
    }
    running = false;
  }

  function status() {
    const base = {
      enabled: Boolean(config && config.watchEnabled),
      running,
      usesLanguageModel: false,
      subscription,
      restoredBaseline: restored,
      startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
      lastSavedAt: lastSavedAt ? new Date(lastSavedAt).toISOString() : undefined,
      samples,
      ...(lastError ? { lastError } : {}),
      ...(lastReplay ? { lastReplay } : {})
    };
    if (!running || !engine) return base;
    // The service's own fields win: its startedAt is the ISO time the watch
    // started, where the engine's is the clock value it was created with.
    return { ...engine.status(now()), ...base };
  }

  function requireRunning() {
    if (!running || !engine) {
      throw watchError('The watch is not running. Enable "Watch all Signal K paths" in the plugin settings.', 'disabled');
    }
  }

  function mute(path, minutes) {
    requireRunning();
    const clean = String(path || '').trim();
    if (!clean || clean.length > 200) throw watchError('Send the path to mute.', 'validation-failed');
    const duration = Math.min(7 * 24 * 60, Math.max(1, Number(minutes) || 60));
    const t = now();
    engine.mute(clean, t + duration * 60 * 1000, t);
    return engine.status(t).mutes;
  }

  function unmute(path) {
    requireRunning();
    const t = now();
    engine.unmute(path, t);
    return engine.status(t).mutes;
  }

  function series(path) {
    requireRunning();
    return engine.series(String(path || ''));
  }

  /**
   * Run a fresh engine over recorded history and report what it would have
   * raised. This is how sensitivity is judged before it ever interrupts
   * anyone: "this would have fired twice yesterday" is a tuning fact, where a
   * live false alarm is a lost bit of trust.
   */
  async function replay(request = {}, historyConfig = {}, options = {}) {
    if (replayRunning) throw watchError('A replay is already running.', 'busy');
    replayRunning = true;
    try {
      const seconds = Math.min(
        MAX_REPLAY_SECONDS,
        parseDurationSeconds(request.duration || 'PT24H') || 24 * 60 * 60
      );
      const resolutionSeconds = Math.max(10, Math.ceil(seconds / REPLAY_MAX_ROWS));
      const to = new Date(now());
      const from = new Date(to.getTime() - seconds * 1000);
      const replayConfig = normalizeWatchConfig({ ...(config || {}), ...historyConfig, watchEnabled: true });
      const probe = createWatchEngine(replayConfig, { now: from.getTime() });

      let paths = Array.isArray(request.paths)
        ? request.paths.map((item) => String(item || '').trim()).filter(Boolean)
        : undefined;
      if (!paths || paths.length === 0) {
        const listing = await listHistoryPaths(app, { ...historyConfig, historyDurationSeconds: seconds }, dependencies, options);
        if (listing.message && listing.paths.length === 0) {
          return { ok: false, message: listing.message };
        }
        paths = listing.paths;
      }
      // Only paths the engine would watch (or the GNSS monitor reads).
      paths = paths.filter((path) => {
        if (path.startsWith('notifications')) return false;
        probe.ingest(path, 0, from.getTime());
        return probe.hasPath(path) || /^navigation\.(?:position|headingTrue|headingMagnetic|speedThroughWater|gnss\.)/.test(path);
      });
      const skipped = Math.max(0, paths.length - MAX_REPLAY_PATHS);
      paths = paths.slice(0, MAX_REPLAY_PATHS);
      if (paths.length === 0) {
        return { ok: false, message: 'The History API has no recorded paths that the watch would monitor.' };
      }

      const baseUrl = resolveHistoryBaseUrl(app, historyConfig);
      const fetchImpl = createTimedFetch(resolveFetch(dependencies), Math.max(REPLAY_TIMEOUT_MS, historyConfig.historyTimeoutMs || 0));
      const window = { from: from.toISOString(), to: to.toISOString(), resolutionSeconds };
      const rows = new Map();
      const failures = [];

      for (let index = 0; index < paths.length; index += REPLAY_PATHS_PER_REQUEST) {
        const chunk = paths.slice(index, index + REPLAY_PATHS_PER_REQUEST);
        const url = buildValuesUrl(baseUrl, chunk, window, historyConfig);
        try {
          // The same credential scoping as every other history read: the
          // operator's session goes to this machine only.
          const headers = historyRequestHeaders(baseUrl, historyConfig, options);
          const response = await fetchImpl(url, { method: 'GET', headers, signal: options.signal });
          if (!response.ok) {
            failures.push(`HTTP ${response.status} for ${chunk.length} paths`);
            continue;
          }
          const payload = await response.json();
          const declared = Array.isArray(payload && payload.values) ? payload.values : [];
          const columns = declared.length > 0 ? declared.map((entry, i) => (entry && entry.path) || chunk[i]) : chunk;
          for (const row of Array.isArray(payload && payload.data) ? payload.data : []) {
            if (!Array.isArray(row)) continue;
            const at = Date.parse(row[0]);
            if (!Number.isFinite(at)) continue;
            let bucket = rows.get(at);
            if (!bucket) {
              bucket = [];
              rows.set(at, bucket);
            }
            columns.forEach((path, i) => {
              const value = row[i + 1];
              if (value !== null && value !== undefined) bucket.push([path, value]);
            });
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      const times = [...rows.keys()].sort((a, b) => a - b);
      if (times.length === 0) {
        return {
          ok: false,
          message: failures.length > 0 ? `The History API could not be read (${failures[0]}).` : 'The History API returned no data for that window.'
        };
      }

      const replayEngine = createWatchEngine(replayConfig, { now: times[0] });
      let lastTick = 0;
      for (const at of times) {
        for (const [path, value] of rows.get(at)) {
          replayEngine.ingest(path, value, at, 'history');
        }
        if (at - lastTick >= REPLAY_TICK_MS) {
          replayEngine.tick(at);
          lastTick = at;
        }
      }
      replayEngine.tick(times[times.length - 1]);
      const result = replayEngine.status(times[times.length - 1]);
      const stats = replayEngine.stats();

      lastReplay = {
        at: new Date(now()).toISOString(),
        from: window.from,
        to: window.to,
        findingsOpened: stats.findingsOpened,
        incidentsOpened: stats.incidentsOpened
      };

      return {
        ok: true,
        from: window.from,
        to: window.to,
        resolutionSeconds,
        pathsReplayed: paths.length,
        ...(skipped > 0 ? { pathsSkipped: skipped } : {}),
        rows: times.length,
        findingsOpened: stats.findingsOpened,
        incidentsOpened: stats.incidentsOpened,
        byDetector: stats.byDetector,
        incidents: result.incidents.slice(0, 20),
        ...(failures.length > 0 ? { failures: failures.slice(0, 5) } : {}),
        note:
          'Replayed from aggregated history, which is smoother than live data: treat this as a lower bound on what ' +
          'the live watch would raise, and use it to compare sensitivity settings.'
      };
    } finally {
      replayRunning = false;
    }
  }

    // `tick` is public so a test (or a host without timers) can drive the watch
  // deterministically; the plugin itself runs it on an interval.
  return { mute, replay, series, start, status, stop, tick, unmute, saveState, isRunning: () => running };
}

module.exports = { NOTIFICATION_ROOT, createWatchService };
