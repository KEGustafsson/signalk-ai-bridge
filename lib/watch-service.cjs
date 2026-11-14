'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const nodePath = require('node:path');
const { createWatchEngine, normalizeWatchConfig } = require('./watch/engine.cjs');
const { parseRule, rankPaths } = require('./watch/rule-parser.cjs');
const { assistRule } = require('./watch/rule-assist.cjs');
const { normalizeRules } = require('./watch/rules.cjs');
const { describePath } = require('./watch/format.cjs');
const { getAiAvailability } = require('./ai-service.cjs');
const { createTimedFetch, resolveFetch } = require('./http-utils.cjs');
const {
  buildValuesUrl,
  describeFetchError,
  historyFailureDetail,
  historyRequestHeaders,
  listHistoryPaths,
  parseDurationSeconds,
  resolveHistoryTarget
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

// Saves of one state file run one at a time, across service instances: a
// periodic save still in flight when the plugin stops, or two services in
// one process, would otherwise write and rename the same temporary file
// together, and one rename could carry the other's half-written snapshot.
const saveQueues = new Map();

function queueSave(file, write) {
  const previous = saveQueues.get(file) || Promise.resolve();
  const run = previous.then(write);
  const settled = run.catch(() => {});
  saveQueues.set(file, settled);
  settled.then(() => {
    if (saveQueues.get(file) === settled) saveQueues.delete(file);
  });
  return run;
}

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
  // The engine's state at the last stop(), kept in memory: a restart in the
  // same process (a settings change) restores from it rather than from a
  // file whose final save may still be in flight.
  let finalSnapshot;

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
    if (finalSnapshot && t - finalSnapshot.savedAt <= MAX_STATE_AGE_MS) {
      const snapshot = finalSnapshot;
      finalSnapshot = undefined;
      return engine.importState(JSON.parse(JSON.stringify(snapshot)), t);
    }
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

  async function saveState(snapshot) {
    const file = stateFile();
    if (!file || (!engine && !snapshot)) return;
    const t = now();
    const content = JSON.stringify(snapshot || engine.exportState(t));
    const tmp = `${file}.tmp`;
    try {
      await queueSave(file, async () => {
        await fsp.writeFile(tmp, content);
        await fsp.rename(tmp, file);
      });
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
            // One bad value must not take the rest of the delta - or the
            // server's subscription callback - down with it.
            try {
              engine.ingest(entry.path, entry.value, t, source);
            } catch (error) {
              lastError = `Could not watch ${entry.path}: ${error instanceof Error ? error.message : error}`;
            }
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

  /** Hand a batch to the server. True only when the server accepted it. */
  function publish(values) {
    if (values.length === 0) return true;
    if (typeof app.handleMessage !== 'function') return false;
    try {
      app.handleMessage(pluginId, { updates: [{ values }] });
      return true;
    } catch (error) {
      lastError = `Could not publish a notification: ${error instanceof Error ? error.message : error}`;
      return false;
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
    const raised = [];
    const cleared = [];
    for (const [key, state] of states) {
      const previous = emitted.get(key);
      const changedState = !previous || previous.state !== state.state;
      const changedText = previous && previous.message !== state.message && t - previous.sentAt >= MESSAGE_REFRESH_MS;
      if (changedState || changedText) {
        values.push({
          path: notificationPath(key),
          value: { state: state.state, method: methodsFor(state.state), message: state.message }
        });
        raised.push([key, { ...state, sentAt: t }]);
      }
    }
    for (const [key, previous] of emitted) {
      if (!states.has(key)) {
        values.push({
          path: notificationPath(key),
          value: { state: 'normal', method: [], message: `Back to normal: ${previous.title}` }
        });
        cleared.push(key);
      }
    }
    // What was sent is recorded only once the server took it. A batch the
    // server refused is retried on the next tick, so a warning is not lost
    // and a clearance cannot leave a stale warning standing for good.
    if (!publish(values)) return;
    for (const [key, state] of raised) emitted.set(key, state);
    for (const key of cleared) emitted.delete(key);
  }

  function clearNotifications() {
    const values = [...emitted.entries()].map(([key, previous]) => ({
      path: notificationPath(key),
      value: { state: 'normal', method: [], message: `Watch stopped: ${previous.title}` }
    }));
    // The plugin is stopping, so there is no later tick to retry on: forget
    // the state either way, and leave the reason in lastError if it failed.
    publish(values);
    emitted.clear();
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
      // The snapshot is taken now and also kept in memory for a restart.
      finalSnapshot = engine.exportState(now());
      saveState(finalSnapshot).catch(() => {});
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

  function inventory() {
    requireRunning();
    return engine.inventory(now());
  }

  function report(hours) {
    requireRunning();
    return engine.report(now(), hours);
  }

  function feedback(path, useful) {
    requireRunning();
    const clean = String(path || '').trim();
    if (!clean || clean.length > 200) throw watchError('Send the path the feedback is about.', 'validation-failed');
    return engine.giveFeedback(clean, useful === 'reset' ? 'reset' : useful === true, now());
  }

  function unusual() {
    requireRunning();
    return engine.unusual(now());
  }

  /**
   * Plain language -> a rule the operator can confirm. The parser first, with
   * no model; the model only for what the parser could not read, and only if
   * `watchRuleAssist` allows it. Nothing is stored here.
   */
  async function compileRule(request = {}, aiConfig = {}) {
    requireRunning();
    const text = String(request.text || '').trim().slice(0, 300);
    if (!text) throw watchError('Say what to watch for.', 'validation-failed');
    const t = now();
    const candidates = engine.knownPaths(t);
    const forcePath =
      typeof request.path === 'string' && candidates.some((candidate) => candidate.path === request.path) ? request.path : undefined;
    const parsed = parseRule(text, candidates, { forcePath });
    const describeAlternatives = (list) =>
      (list || []).slice(0, 6).map((item) => {
        const info = candidates.find((candidate) => candidate.path === item.path) || {};
        return { path: item.path, name: describePath(item.path, info.displayName) };
      });

    const finish = (rule, extra = {}) => {
      try {
        return { ok: true, ...extra, ...engine.proveRule(rule, t) };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'The rule is not valid.', ...extra };
      }
    };

    if (parsed.ok) {
      return finish(parsed.rule, { source: 'parser' });
    }
    const failed = { ok: false, reason: parsed.reason, alternatives: describeAlternatives(parsed.alternatives) };
    if (parsed.terminal) {
      return failed;
    }
    if (config.watchRuleAssist === 'off' || aiConfig.enabled === false) {
      return { ...failed, assist: 'off' };
    }

    // The model chooses from a shortlist: the parser's alternatives first,
    // then whatever else the request's words point at.
    const seen = new Set();
    const shortlist = [...(parsed.alternatives || []), ...rankPaths(text, candidates)]
      .filter((item) => !seen.has(item.path) && seen.add(item.path))
      .map((item) => candidates.find((candidate) => candidate.path === item.path))
      .filter(Boolean);

    const useHelper = config.watchRuleAssist === 'helper' && config.watchHelperModel;
    let model = useHelper ? config.watchHelperModel : aiConfig.model;
    if (!useHelper) {
      try {
        const availability = await getAiAvailability(aiConfig, dependencies);
        model = availability.resolvedModel || model;
      } catch {
        // Ask with the configured name; the failure, if any, is reported below.
      }
    }
    const assisted = await assistRule(
      text,
      shortlist,
      {
        baseUrl: aiConfig.baseUrl,
        backend: aiConfig.backend,
        model,
        // A separate helper model is let go soon after: it must not sit in
        // GPU memory the operator's own model needs.
        keepAlive: useHelper ? '2m' : aiConfig.keepAlive
      },
      dependencies
    );
    if (!assisted.ok) {
      return { ...failed, model: assisted.model, assistNote: assisted.message };
    }
    return finish(assisted.rule, { source: 'model', model: assisted.model });
  }

  /**
   * Why a rule cannot be stored as it is, or undefined. The same check the
   * rule compiler makes (proveRule), for rules written by hand or by another
   * tool: a word or on/off on a measurement would be a watch that never
   * fires. Without a running watch there is nothing to check against.
   */
  function checkRule(rule) {
    if (!engine) return undefined;
    try {
      engine.proveRule(rule, now());
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : 'The rule is not valid.';
    }
  }

  function setRules(list) {
    const rules = normalizeRules(list);
    if (config) config = { ...config, watchRules: rules };
    if (engine) engine.setRules(rules);
    return rules;
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
      // Only paths the engine would watch, the GNSS monitor reads, or a rule
      // reads: a rule may be about a path the statistics skip.
      const rulePaths = new Set(
        (replayConfig.watchRules || []).flatMap((rule) => [rule.path, rule.when && rule.when.path].filter(Boolean))
      );
      paths = paths.filter((path) => {
        if (path.startsWith('notifications')) return false;
        probe.ingest(path, 0, from.getTime());
        return (
          probe.hasPath(path) ||
          rulePaths.has(path) ||
          /^navigation\.(?:position|headingTrue|headingMagnetic|speedThroughWater|gnss\.)/.test(path)
        );
      });
      // Rule inputs go first, so the 80-path cap reaches them last (only more
      // than 80 rule inputs - 50 rules with guards - could still be cut).
      paths = [...paths.filter((path) => rulePaths.has(path)), ...paths.filter((path) => !rulePaths.has(path))];
      const skipped = Math.max(0, paths.length - MAX_REPLAY_PATHS);
      paths = paths.slice(0, MAX_REPLAY_PATHS);
      if (paths.length === 0) {
        return { ok: false, message: 'The History API has no recorded paths that the watch would monitor.' };
      }

      // No derived URL when this server's port is not known: the paths and
      // window are not sent to whatever else holds a guessed port.
      const { baseUrl, own: ownPorts, unknown } = resolveHistoryTarget(app, historyConfig);
      if (!baseUrl) {
        return { ok: false, message: `The History API was not called: ${unknown}.` };
      }
      const fetchImpl = createTimedFetch(resolveFetch(dependencies), Math.max(REPLAY_TIMEOUT_MS, historyConfig.historyTimeoutMs || 0));
      const window = { from: from.toISOString(), to: to.toISOString(), resolutionSeconds };
      const rows = new Map();
      const failures = [];

      for (let index = 0; index < paths.length; index += REPLAY_PATHS_PER_REQUEST) {
        const chunk = paths.slice(index, index + REPLAY_PATHS_PER_REQUEST);
        const url = buildValuesUrl(baseUrl, chunk, window, historyConfig);
        try {
          // The same credential scoping as every other history read: the
          // operator's session goes to this server only.
          const headers = historyRequestHeaders(baseUrl, historyConfig, { ...options, ownPorts });
          const response = await fetchImpl(url, { method: 'GET', headers, signal: options.signal });
          if (!response.ok) {
            failures.push(
              historyFailureDetail(
                baseUrl,
                ownPorts,
                response.status,
                historyConfig,
                `HTTP ${response.status} for ${chunk.length} paths`
              )
            );
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
          failures.push(describeFetchError(error));
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
  return { checkRule, compileRule, feedback, report, setRules, inventory, unusual, mute, replay, series, start, status, stop, tick, unmute, saveState, isRunning: () => running };
}

module.exports = { NOTIFICATION_ROOT, createWatchService };
