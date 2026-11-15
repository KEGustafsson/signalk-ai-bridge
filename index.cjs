'use strict';

const {
  getAccelerationReport,
  getAiAvailability,
  resolveOffload,
  normalizeAiConfig,
  queryAiModel,
  readJsonBody,
  redactUrl,
  resetRuntimeState,
  retuneOffload,
  warmUpModel
} = require('./lib/ai-service.cjs');
const { createBridgeService, listSelfPaths, normalizeAiDataPaths } = require('./lib/bridge-service.cjs');
const {
  MAX_HISTORY_PATHS,
  authHeadersFromRequest,
  listHistoryPaths,
  normalizeHistoryConfig,
  resolveHistoryBaseUrl,
  resolveHistoryPaths,
  resolveWindow
} = require('./lib/history-service.cjs');
const { SETTING_LABELS, migrateSettings, readSettings, settingsSchema, settingsUiSchema } = require('./lib/settings.cjs');

// A selection is prompt material: every path is prompt-eval work on the GPU,
// and the context budget drops what does not fit anyway. Wildcards mean a
// handful of entries covers a whole vessel.
const MAX_SELECTED_AI_PATHS = 100;

module.exports = function createPlugin(app, dependencies = {}) {
  // The options as Signal K stored them - in sections, or flat from before the
  // sections - and as every save writes them back: a save changes its own keys
  // (the top-level path selections) and keeps the rest as it is. Read them
  // through readSettings(), as getConfig() does.
  let pluginOptions = {};
  let routesRegistered = false;
  // Express has no public API for unmounting a subrouter, and signalk-server
  // calls registerWithRouter unconditionally - outside its `if (enabled)` guard
  // - so gating a stopped plugin is the plugin's own job. Without this, stop()
  // left every route live and getConfig() fell back to normalizeAiConfig({}),
  // whose defaults are enabled:true against http://localhost:11434: a stopped
  // plugin answering inference against a host the operator never configured.
  let running = false;
  // Bumped on every start/stop so a warm-up that finishes after the plugin was
  // stopped (or restarted with new options) cannot overwrite the live status.
  let lifecycleGeneration = 0;
  const bridgeService = createBridgeService(app, dependencies);

  function normalizeServerConfig(options = {}) {
    // Deduplicated keeping first occurrences: the stored order is the priority
    // order, and a legacy config with repeats would otherwise show (and move)
    // the same path twice.
    const aiDataPaths = Array.isArray(options.aiDataPaths)
      ? [...new Set(options.aiDataPaths.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];

    return {
      aiDataPaths
    };
  }

  const getConfig = () => {
    const settings = readSettings(pluginOptions);
    return {
      ...normalizeAiConfig(settings),
      ...normalizeServerConfig(settings),
      ...normalizeHistoryConfig(settings)
    };
  };

  // The settings form; lib/settings.cjs holds it, with readSettings(), which
  // turns what the form stores into the flat settings the code below reads.
  const schema = () => settingsSchema();

  /**
   * History configuration as it will actually be used, plus how the last read
   * went.
   *
   * Reporting the last outcome rather than probing keeps /ai/status free: the
   * panel polls it on every render pass, and a probe there would put a database
   * query behind each of those polls for information that only changes when a
   * question is asked.
   */
  const describeHistory = (config) => {
    const window = resolveWindow(config);

    return {
      enabled: config.historyEnabled,
      // The same fallback the bridge applies: an unset `aiDataPaths` means the
      // default live paths, and those are what an empty history list reuses.
      paths: resolveHistoryPaths({ ...config, aiDataPaths: normalizeAiDataPaths(config) }),
      // True when no history paths are stored and the list above is reused
      // from the live selection: it follows that selection, so it is not
      // reordered on its own (that would freeze it into a fixed list).
      derived: !(Array.isArray(config.historyPaths) && config.historyPaths.length > 0),
      durationSeconds: window.durationSeconds,
      resolutionSeconds: window.resolutionSeconds,
      samples: config.historySamples,
      // Redacted for the same reason baseUrl is: an operator may have put
      // credentials in the URL of a remote Signal K server.
      serverUrl: redactUrl(resolveHistoryBaseUrl(app, config)),
      ...(config.historyProvider ? { provider: config.historyProvider } : {}),
      lastFetch: bridgeService.getHistoryStatus()
    };
  };

  /**
   * HTTP status for an error code.
   *
   * One place for code -> HTTP, so /ai/query and the bridge routes cannot
   * drift apart the way they had (only one of them mapped `disabled` and
   * `timeout`). `fallback` is the status for a code nothing here maps: 502
   * where the backend answers the request, 500 where the plugin itself does.
   */
  const statusForCode = (code, fallback = 502) => {
    switch (code) {
      case 'validation-failed':
        return 400;
      case 'unauthorized':
        return 401;
      // The request was valid but the stored state it refers to has moved on
      // (a path another save removed, a list that is not stored at all).
      case 'conflict':
        return 409;
      case 'disabled':
        return 503;
      case 'timeout':
        return 504;
      default:
        return fallback;
    }
  };

  /** The error code for a route's error body, from whatever was thrown. */
  const errorCode = (error) =>
    typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'unknown';

  /** The message for a route's error body; `fallback` when nothing usable was thrown. */
  const errorMessage = (error, fallback) => (error instanceof Error ? error.message : fallback);

  /**
   * Answer a failed route. A thrown error that carries its own HTTP status
   * (a backend's 404, say) keeps it; anything else is mapped from its code.
   */
  const sendError = (res, error, fallbackStatus, fallbackMessage) => {
    const statusCode =
      typeof error === 'object' && error !== null && typeof error.statusCode === 'number'
        ? error.statusCode
        : statusForCode(errorCode(error), fallbackStatus);

    res.status(statusCode).json({
      error: { code: errorCode(error), message: errorMessage(error, fallbackMessage) }
    });
  };

  // A stopped plugin must not serve inference. Returns true when the request
  // was answered with 503 and the caller should stop.
  const rejectIfStopped = (res) => {
    if (running) {
      return false;
    }
    res.status(503).json({
      error: { code: 'disabled', message: 'AI Bridge is stopped.' }
    });
    return true;
  };

  // A save the plugin stopped right after: the change is stored, so the
  // reply says so (and that it need not be made again) instead of the
  // generic "stopped", and sends no stopped plugin's lists.
  const rejectIfStoppedAfterSave = (res, saved) => {
    if (running) {
      return false;
    }
    res.status(503).json({
      error: {
        code: 'disabled',
        message: saved
          ? 'The change was saved, but the plugin stopped before it could reply; reload once it runs again instead of making the change again.'
          : 'AI Bridge is stopped.'
      }
    });
    return true;
  };

  /** GET /ai/status: configuration, backend availability and GPU residency. */
  const statusHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const availability = await getAiAvailability(config, dependencies);
      // Residency is only meaningful once the backend answered; probing a
      // host that is down would just repeat the same connection failure.
      // Report what requests will actually use, not just what was configured:
      // the start-up tuner may have shrunk the context window to fit the GPU.
      const effective = resolveOffload(config);
      const accelerator = availability.backendReachable
        ? await getAccelerationReport({ ...config, resolvedModel: availability.resolvedModel }, dependencies)
        : undefined;

      res.status(200).json({
        enabled: config.enabled,
        // Redacted: a baseUrl may legitimately carry credentials, and this
        // payload is rendered in the panel and readable by anyone with access.
        baseUrl: redactUrl(config.baseUrl),
        model: config.model,
        backend: config.backend,
        requestTimeoutMs: config.requestTimeoutMs,
        maxTokens: config.maxTokens,
        numCtx: effective.numCtx,
        numGpu: effective.numGpu,
        configuredNumCtx: config.numCtx,
        numBatch: config.numBatch,
        numThread: config.numThread,
        keepAlive: config.keepAlive,
        gpuAutoTune: config.gpuAutoTune,
        aiDataPaths: config.aiDataPaths,
        history: describeHistory(config),
        signalKSelfId: typeof app.selfId === 'string' ? app.selfId : undefined,
        aiAvailable: availability.available,
        ollamaReachable: availability.backendReachable,
        modelAvailable: availability.modelAvailable,
        resolvedModel: availability.resolvedModel,
        availabilityMessage: availability.message,
        accelerator
      });
    } catch (error) {
      sendError(res, error, 500, 'Unknown AI status failure.');
    }
  };

  /** POST /ai/query: one blocking answer to the body's prompt, with the live context. */
  const queryHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const payload = await bridgeService.buildAiPayload(body, config, {
        authHeaders: authHeadersFromRequest(req)
      });
      const result = await queryAiModel(payload, config, dependencies);
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error, 502, 'Unknown AI backend failure.');
    }
  };

  /** POST /bridge/execute: run a tool request and return its result envelope. */
  const bridgeExecuteHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const result = await bridgeService.executeTool(body, config, {
        authHeaders: authHeadersFromRequest(req)
      });
      res.status(200).json(result);
    } catch (error) {
      // executeTool reports backend failures inside a 200 result, so what
      // reaches here is the plugin's own: a bad body, or a bug.
      sendError(res, error, 500, 'Unknown bridge failure.');
    }
  };

  /**
   * May this request change the path selection?
   *
   * The selection decides what vessel data leaves the boat for the inference
   * host, so it is a write, not a preference. On a server with security
   * enabled that means an authenticated principal with more than read access;
   * on a server with security off - a single-user boat network, which is the
   * common Signal K setup - there is no identity to check and the route is as
   * open as the rest of the server already is.
   */
  const isSelectionWriteAllowed = (req) => {
    const strategy = app && app.securityStrategy;
    if (!strategy || (typeof strategy.isDummy === 'function' && strategy.isDummy())) {
      return true;
    }

    const principal = req && req.skPrincipal;
    if (principal) {
      const permissions = String(principal.permissions || '').toLowerCase();
      return permissions === 'admin' || permissions === 'readwrite';
    }

    // Older strategies expose the session only through getLoginStatus.
    if (typeof strategy.getLoginStatus === 'function') {
      try {
        const status = strategy.getLoginStatus(req) || {};
        if (status.status !== 'loggedIn') return false;
        // The login's level is userLevel. readOnlyAccess is the server's
        // "Allow Readonly Access" setting (reads without a login), not this
        // login's, so it says nothing about whether it may write.
        const level = String(status.userLevel || '').toLowerCase();
        return level === 'admin' || level === 'readwrite';
      } catch {
        return false;
      }
    }

    return false;
  };

  // Every write to the stored options goes through this one queue. Each
  // handler used to copy pluginOptions, await the save, then assign its copy
  // back - so two overlapping saves (a live and a history path selection, say)
  // both started from the same options and the later one silently undid the
  // earlier, while both reported success.
  let optionsWriteQueue = Promise.resolve();

  /**
   * Read-modify-save the plugin's options, one at a time. `change` gets the
   * options as they are once every earlier save has finished and returns the
   * new options; they are stored, then applied to the running plugin.
   * Returning the options it was given unchanged (the same object) means
   * "nothing to change": nothing is written, so a no-op neither rewrites the
   * stored settings nor fails on a host that cannot store them.
   */
  const updatePluginOptions = (change) => {
    const run = optionsWriteQueue.then(async () => {
      // A restart while a save is in flight replaces pluginOptions with the
      // options the server started with. The change is then made again on
      // those and saved again, so neither memory nor disk keeps an older copy
      // - and a save queued while the plugin was stopped (pluginOptions is {}
      // then) writes nothing at all instead of storing just its own change.
      // What the last write stored: this change ('change'), the restart's
      // own options put back because the redo had nothing to do ('restart'),
      // or nothing yet.
      let stored;
      const stopped = () => {
        const error = new Error(
          stored === 'change'
            ? 'The change was written, but the plugin stopped before it took effect; if the settings were saved meanwhile (from the admin page, say), they may have replaced it.'
            : stored === 'restart'
              ? 'The plugin stopped; the stored settings are the ones it restarted with (which may or may not hold this change).'
              : 'The plugin is stopped; nothing was saved.'
        );
        error.code = 'disabled';
        error.statusCode = 503;
        return error;
      };
      // Three attempts, then a fourth pass only to report: stopped, or kept
      // restarting.
      for (let attempt = 0; ; attempt += 1) {
        if (!running) throw stopped();
        if (attempt === 3) {
          const error = new Error('The plugin kept restarting while saving; the stored settings may hold this change. Check them and try again.');
          error.code = 'conflict';
          error.statusCode = 409;
          throw error;
        }
        const generation = lifecycleGeneration;
        const updated = change(pluginOptions);
        if (updated === pluginOptions) {
          // Redone after a restart and nothing to change now - but an
          // earlier attempt already stored a copy made from the older
          // options: put the restart's options back on disk.
          if (stored) {
            await new Promise((resolve, reject) => {
              app.savePluginOptions(pluginOptions, (error) => (error ? reject(error) : resolve()));
            });
            stored = 'restart';
            // Restarted again while that was written: start over on the
            // newest options, so disk ends with what the plugin runs.
            if (generation !== lifecycleGeneration) continue;
          }
          return updated;
        }
        if (typeof app.savePluginOptions !== 'function') {
          const error = new Error('This Signal K server does not let plugins store their own settings.');
          error.code = 'unknown';
          error.statusCode = 501;
          throw error;
        }
        await new Promise((resolve, reject) => {
          app.savePluginOptions(updated, (error) => (error ? reject(error) : resolve()));
        });
        stored = 'change';
        if (generation === lifecycleGeneration) {
          pluginOptions = updated;
          return updated;
        }
      }
    });
    // A failed save must not wedge the queue for the next one.
    optionsWriteQueue = run.catch(() => {});
    return run;
  };

  // One line for the server log. Signal K shows a plugin's standard output in
  // its log; app.debug is shown only with debugging turned on for the plugin.
  const logInfo = (message) => {
    console.log(`signalk-ai-bridge: ${message}`);
  };

  /**
   * Move settings an earlier version stored flat into their sections, and
   * store the result once, through the options write queue - so the admin
   * page's form shows the values the plugin runs on, instead of defaults that
   * its first save would put over them.
   *
   * The queue does the guarding: nothing is written while the plugin is
   * stopped, and a restart while the save is in flight makes the move again
   * on the options it restarted with. With nothing flat left (the usual
   * case, and every start after the first) nothing is queued or written.
   * Should the save fail, the plugin runs on the moved settings in memory -
   * the same settings, since readSettings() reads flat keys too - and the
   * next start tries again.
   */
  const migrateStoredSettings = (options, generation) => {
    if (migrateSettings(options).options === options) {
      return Promise.resolve();
    }
    let last = { moved: [], kept: [], changed: false };
    const describe = () =>
      last.moved.join(', ') + (last.kept.length > 0 ? `; for ${last.kept.join(', ')} the value already in its section was kept` : '');
    return updatePluginOptions((current) => {
      const migration = migrateSettings(current);
      last = { ...migration, changed: migration.options !== current };
      return migration.options;
    }).then(
      () => {
        if (last.changed) {
          logInfo(`moved settings saved by an earlier version into their sections: ${describe()}.`);
        }
      },
      (error) => {
        // Stopped or restarted meanwhile: the options it runs on now are
        // another start's, which makes its own move.
        if (!running || generation !== lifecycleGeneration || errorCode(error) === 'disabled') {
          return;
        }
        const migration = migrateSettings(pluginOptions);
        if (migration.options === pluginOptions) {
          return;
        }
        pluginOptions = migration.options;
        last = { ...migration, changed: true };
        // A server that cannot store plugin settings at all (an embedding
        // host, not signalk-server) would be told the same on every start.
        if (error && error.statusCode === 501) {
          return;
        }
        logInfo(
          `settings saved by an earlier version are used from their sections for now (${describe()}), ` +
            `but could not be stored (${errorMessage(error, 'unknown error')}); this is tried again on the next start.`
        );
      }
    );
  };

  /** A path list from the panel: strings, trimmed, deduplicated, bounded. */
  const normalizeSelection = (value, limit) => {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const cleaned = value
      .map((item) => String(item == null ? '' : item).trim())
      .filter((item) => item.length > 0 && item.length <= 200);
    return [...new Set(cleaned)].slice(0, limit);
  };

  /**
   * Store the path selections the panel made.
   *
   * These two lists left the plugin's settings schema: a path list is chosen
   * against what the vessel actually publishes, which the settings form cannot
   * show and the panel's pickers can. They are still stored as plugin options,
   * so a restart and a config backup carry them like any other setting.
   */
  const saveSelectionHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }

    if (!isSelectionWriteAllowed(req)) {
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'Changing the path selection requires a Signal K login with write access.'
        }
      });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const aiDataPaths = normalizeSelection(body && body.aiDataPaths, MAX_SELECTED_AI_PATHS);
      const historyPaths = normalizeSelection(body && body.historyPaths, MAX_HISTORY_PATHS);

      if (aiDataPaths === undefined && historyPaths === undefined) {
        res.status(400).json({
          error: {
            code: 'validation-failed',
            message: 'Send aiDataPaths, historyPaths, or both, as arrays of Signal K paths.'
          }
        });
        return;
      }

      // Applied to the running plugin as well as stored, so the next question
      // uses the new selection without waiting for a restart.
      await updatePluginOptions((current) => ({
        ...current,
        ...(aiDataPaths === undefined ? {} : { aiDataPaths }),
        ...(historyPaths === undefined ? {} : { historyPaths })
      }));
      // Stopped between the save and this reply: a stopped plugin's empty
      // options are not the selection, so they are not sent as one.
      if (rejectIfStoppedAfterSave(res, true)) return;

      const config = getConfig();
      res.status(200).json({
        aiDataPaths: normalizeAiDataPaths(config),
        historyPaths: resolveHistoryPaths({ ...config, aiDataPaths: normalizeAiDataPaths(config) })
      });
    } catch (error) {
      sendError(res, error, 500, 'Could not save the path selection.');
    }
  };

  /**
   * A stored path list as the panel shows it: the first occurrence of each
   * normalised form (`normalizeOne` gives '' for an entry the shown list
   * drops), at most `limit` of them, each with its index in the raw list.
   */
  const shownEntries = (raw, normalizeOne, limit) => {
    const stored = Array.isArray(raw) ? raw : [];
    const shown = [];
    const seen = new Set();
    for (let index = 0; index < stored.length && shown.length < limit; index += 1) {
      const key = normalizeOne(stored[index]);
      if (key && !seen.has(key)) {
        seen.add(key);
        shown.push({ key, index });
      }
    }
    return shown;
  };

  /**
   * Move one entry of a stored path list by one place, in the raw stored list.
   *
   * The list the panel shows (`shownEntries`) is mapped back to the raw
   * entries that produced it, and the move swaps the two raw entries for
   * `path` and its neighbour in that shown order. Everything else stored
   * (wildcards the history list ignores, blanks, repeats, entries past the
   * cap, spacing) stays where and as it was, so a move changes the order and
   * nothing else.
   *
   * Returns { outcome: 'no-stored-list' | 'not-found' | 'unchanged' | 'moved' },
   * with `list` (the new raw list) and `neighbour` (the path swapped with)
   * for 'moved' only.
   */
  const moveInStoredList = (raw, normalizeOne, limit, path, delta) => {
    const shown = shownEntries(raw, normalizeOne, limit);
    if (shown.length === 0) {
      return { outcome: 'no-stored-list' };
    }
    const position = shown.findIndex((entry) => entry.key === path);
    if (position < 0) {
      return { outcome: 'not-found' };
    }
    const target = position + delta;
    if (target < 0 || target >= shown.length) {
      return { outcome: 'unchanged' };
    }
    const list = [...raw];
    const from = shown[position].index;
    const to = shown[target].index;
    [list[from], list[to]] = [list[to], list[from]];
    return { outcome: 'moved', list, neighbour: shown[target].key };
  };

  /** One live entry as the shown list has it: trimmed, '' when blank. */
  const normalizeLiveEntry = (item) => String(item || '').trim();
  /** One history entry as the shown list has it: its spec, '' when dropped (blank, wildcard). */
  const normalizeHistoryEntry = (item) => normalizeHistoryConfig({ historyPaths: [item] }).historyPaths[0] || '';

  /** Both selections as they now are; liveSelected includes the defaults, as the live picker starts from it. */
  const currentLists = () => {
    const config = getConfig();
    return {
      aiDataPaths: config.aiDataPaths,
      liveSelected: normalizeAiDataPaths(config),
      history: describeHistory(config)
    };
  };

  /**
   * POST /paths/move { kind: 'live' | 'history', path, delta }: move one path
   * in the stored selection, applied to the selection as stored when its turn
   * in the options-write queue comes - not to a list the panel read earlier,
   * which another save, another browser or a quick second click may have made
   * stale. Every answer that gets this far (moved, already at the end, or a
   * 409 conflict) carries both selections as they now are, so the panel can
   * show the stored list whether or not the move happened.
   */
  const movePathHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    if (!isSelectionWriteAllowed(req)) {
      res.status(401).json({
        error: { code: 'unauthorized', message: 'Changing the path selection requires a Signal K login with write access.' }
      });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const kind = body && body.kind;
      const path = body && typeof body.path === 'string' ? body.path : '';
      // The number itself: `true`, "1" and [1] all coerce to 1 and are not a move.
      const delta = body ? body.delta : undefined;
      if ((kind !== 'live' && kind !== 'history') || !path || (delta !== -1 && delta !== 1)) {
        res.status(400).json({
          error: { code: 'validation-failed', message: 'Send kind ("live" or "history"), path, and delta (-1 or 1).' }
        });
        return;
      }
      let outcome = 'unchanged';
      const key = kind === 'live' ? 'aiDataPaths' : 'historyPaths';
      const normalizeOne = kind === 'live' ? normalizeLiveEntry : normalizeHistoryEntry;
      const limit = kind === 'live' ? Number.POSITIVE_INFINITY : MAX_HISTORY_PATHS;
      // The paths this move swapped `path` with. A restart from options one
      // of its attempts wrote already has the move - `path` sits right
      // before (moved up) or after (moved down) that neighbour - and redoing
      // it there would move the path twice. Judged on the shown entries
      // without the cap, so a restart whose list was tidied, gained paths
      // (pushing the neighbour past the cap) or came from an earlier attempt
      // still counts as moved, as long as `path` and that neighbour are
      // still next to each other and `path` itself is still shown (within
      // the cap). A path the restart pushed past the cap is answered as no
      // longer in the selection, as any move of it would be.
      const neighbours = [];
      await updatePluginOptions((current) => {
        const shown = shownEntries(current[key], normalizeOne, Number.POSITIVE_INFINITY).map((entry) => entry.key);
        const at = shown.indexOf(path);
        // shown[-1] is undefined, so a neighbour no longer in the list never
        // matches a path that is first.
        if (at >= 0 && at < limit && neighbours.includes(shown[at - delta])) {
          outcome = 'moved';
          return current;
        }
        const result = moveInStoredList(current[key], normalizeOne, limit, path, delta);
        // History reusing the live paths, or the default live selection, has
        // no stored list to reorder (and reordering would freeze it into one).
        outcome = result.outcome;
        if (result.outcome !== 'moved') {
          // The same object back when nothing moves, so nothing is written.
          return current;
        }
        neighbours.push(result.neighbour);
        return { ...current, [key]: result.list };
      });
      // Stopped between the save and this reply: no lists from a stopped
      // plugin for the panel to take as the selection.
      if (rejectIfStoppedAfterSave(res, outcome === 'moved')) return;
      const lists = currentLists();
      if (outcome === 'no-stored-list' || outcome === 'not-found') {
        res.status(statusForCode('conflict')).json({
          error: {
            code: 'conflict',
            message:
              outcome === 'not-found'
                ? `${path} is no longer in the saved selection; the list has been refreshed.`
                : 'There is no saved list to reorder: save a selection from the picker first.'
          },
          ...lists
        });
        return;
      }
      res.status(200).json(lists);
    } catch (error) {
      // `running` again here: a stop between the queue's answer and this
      // catch must not send a stopped plugin's empty lists.
      if (errorCode(error) === 'conflict' && running) {
        // "Kept restarting while saving": the lists as they now are, like
        // every other conflict, so the panel can refresh.
        res.status(statusForCode('conflict')).json({
          error: { code: 'conflict', message: errorMessage(error, 'Could not move the path.') },
          ...currentLists()
        });
        return;
      }
      sendError(res, error, 500, 'Could not move the path.');
    }
  };

  /**
   * Live Signal K paths this vessel publishes, for the panel's picker.
   *
   * Read straight from the data model - no backend, no provider - so it
   * answers whether or not AI is configured, which is what makes it useful
   * while an operator is still deciding what to send.
   */
  const selfPathsHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      res.status(200).json({ ...listSelfPaths(app), selected: normalizeAiDataPaths(getConfig()) });
    } catch (error) {
      sendError(res, error, 500, 'Unknown path listing failure.');
    }
  };

  /**
   * Paths the History API has recorded, for the panel's picker.
   *
   * Deliberately not gated on historyEnabled: browsing what a provider records
   * is how an operator decides whether enabling history is worth it. Failures
   * arrive as a message in a 200 body - the picker shows the reason instead of
   * the card breaking on a status code.
   */
  const historyPathsHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const result = await listHistoryPaths(app, config, dependencies, {
        authHeaders: authHeadersFromRequest(req)
      });
      res.status(200).json(result);
    } catch (error) {
      sendError(res, error, 500, 'Unknown history failure.');
    }
  };

  /**
   * Re-measure the GPU fit and report the result.
   *
   * The start-up tuner never grows its context window back, so this is how an
   * operator picks up memory that has since been freed without restarting the
   * plugin.
   */
  const retuneHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      const config = getConfig();
      const result = await retuneOffload(config, dependencies);
      res.status(result.retuned ? 200 : 503).json(result);
    } catch (error) {
      sendError(res, error, 500, 'Unknown re-tune failure.');
    }
  };

  /**
   * Newline-delimited JSON stream of the answer as it is generated.
   *
   * NDJSON rather than SSE: the payload is already JSON objects, every line is
   * independently parseable, and it survives Express's default handling without
   * needing an event-source content type. Each line is one of
   *   {"type":"token","text":"..."}
   *   {"type":"result", ...}   (the same shape /bridge/execute returns)
   *   {"type":"error","error":{...}}
   *
   * Errors after the first byte cannot use a status code — the header is long
   * gone — so they are delivered as a trailing error line instead.
   */
  const bridgeStreamHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    let headersSent = false;

    // A question the operator walked away from is still a question the GPU is
    // answering: without this the generation ran to completion for a closed
    // socket, holding the single Ollama slot the Jetson compose files configure
    // and queueing the next question behind it.
    //
    // Watch the RESPONSE, not the request. On Node 16 and newer an
    // IncomingMessage emits 'close' as soon as the request body has been fully
    // received - not when the client goes away - so listening on `req` aborted
    // every stream the instant readJsonBody() drained the body, before
    // generation had even started. writeLine() then suppressed every token and
    // the final result, and the catch block stayed quiet because the signal
    // said "the client left", so the panel got an empty stream and reported
    // "Bridge stream ended without a result" for every single question.
    // Measured on the Node 26 that signalk-server ships: 'close' fires during
    // the body read, 100% of the time.
    //
    // `res` is the object whose lifetime actually tracks the client, and
    // writableFinished separates a client that hung up mid-answer from a
    // response we completed ourselves.
    const abortController = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) {
        abortController.abort();
      }
    };
    if (res && typeof res.on === 'function') {
      res.on('close', onClientGone);
    }
    const releaseClientListeners = () => {
      if (res && typeof res.off === 'function') {
        res.off('close', onClientGone);
      }
    };

    const writeLine = (payload) => {
      // res.write on a destroyed socket returns false rather than throwing, so
      // the loop would otherwise keep going and keep formatting output nobody
      // can read.
      if (abortController.signal.aborted || res.writableEnded) {
        return;
      }
      if (!headersSent) {
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('cache-control', 'no-cache, no-transform');
        // Without this a reverse proxy in front of Signal K may buffer the
        // whole response and defeat the point of streaming.
        res.setHeader('x-accel-buffering', 'no');
        if (typeof res.status === 'function') {
          res.status(200);
        }
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }
        headersSent = true;
      }
      res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const config = getConfig();
      const body = await readJsonBody(req);
      const result = await bridgeService.streamTool(
        body,
        config,
        (text) => {
          writeLine({ type: 'token', text });
        },
        abortController.signal,
        { authHeaders: authHeadersFromRequest(req) }
      );

      // streamTool reports a bad request by *returning* an error result rather
      // than throwing, so a validation failure went out as HTTP 200 with an
      // error line and the status ladder below was dead code for it.
      //
      // Only pre-generation errors are mapped to a status: a backend failure
      // stays a trailing error line, because a non-2xx makes the panel fall
      // back to the blocking route and pay for a second generation.
      const preGeneration =
        result &&
        result.type === 'error' &&
        result.error &&
        (result.error.code === 'validation-failed' || result.error.code === 'disabled');

      if (!headersSent && preGeneration && typeof res.status === 'function') {
        releaseClientListeners();
        res.status(statusForCode(result.error.code)).json({ error: result.error });
        return;
      }

      writeLine(result);
    } catch (error) {
      // The client hanging up is not a failure to report - there is nobody
      // left to report it to, and the headers may already be gone.
      if (!abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Unknown bridge failure.';
        const code =
          typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'unknown';

        // Nothing has been written yet, so a real status code is still
        // available: a malformed request should not look like a backend fault.
        if (!headersSent && typeof res.status === 'function' && code === 'validation-failed') {
          releaseClientListeners();
          res.status(400).json({ error: { code, message } });
          return;
        }
        writeLine({ type: 'error', error: { code, message } });
      }
    } finally {
      releaseClientListeners();
      if (!res.writableEnded) {
        res.end();
      }
    }
  };

  // Masks both API keys: an ordinary text input would show a token in
  // cleartext and echo it back on every config page load.
  const uiSchema = () => settingsUiSchema();

  return {
    id: 'signalk-ai-bridge',
    name: 'AI Bridge',
    description: 'Signal K Ask AI plugin with embedded web UI for Ollama and Gemma.',
    schema,
    uiSchema,
    start: (options = {}) => {
      pluginOptions = options;
      running = true;
      bridgeService.reset();
      resetRuntimeState();
      lifecycleGeneration += 1;
      const generation = lifecycleGeneration;
      migrateStoredSettings(options, generation);
      const config = getConfig();
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus(
          config.enabled
            ? `AI Bridge ready: ${config.model} via ${config.baseUrl}`
            : `AI Bridge is off; switch on "${SETTING_LABELS.enabled}" in its settings to answer questions.`
        );
      }

      // Fire-and-forget: a warm-up is a latency optimisation, so start() must
      // not wait for it and must never fail because the backend is not up yet.
      warmUpModel(config, dependencies, { isCurrent: () => generation === lifecycleGeneration })
        .then((result) => {
          if (generation !== lifecycleGeneration) {
            return;
          }
          // A failed warm-up used to leave the optimistic "ready" status from
          // start() in place, so the admin UI showed green while the backend
          // was unreachable.
          if (!result.warmed && result.reason && result.reason !== 'skipped') {
            if (typeof app.setPluginError === 'function') {
              app.setPluginError(`AI Bridge could not reach the model: ${result.reason}`);
            } else if (typeof app.setPluginStatus === 'function') {
              app.setPluginStatus(`AI Bridge degraded: ${result.reason}`);
            }
            return;
          }
          if (result.warmed && typeof app.setPluginStatus === 'function') {
            const offload = result.offload;
            const numCtx = offload ? offload.numCtx : config.numCtx;
            // numGpu is what we *asked* for (999 means "all layers"), not what
            // landed. Only the last ladder step's measured residency can say
            // "all layers on GPU"; claiming it from the request printed a full
            // offload even when /api/ps was unreadable or reported a spill.
            const measured =
              offload && Array.isArray(offload.steps) && offload.steps.length > 0
                ? offload.steps[offload.steps.length - 1].state
                : undefined;
            const placement =
              offload && offload.numGpu === 0
                ? `CPU only, num_ctx ${numCtx}`
                : measured === 'gpu'
                  ? `all layers on GPU, num_ctx ${numCtx}`
                  : measured === 'partial'
                    ? `partly on CPU, num_ctx ${numCtx}`
                    : measured === 'cpu'
                      ? `on CPU, num_ctx ${numCtx}`
                      : `GPU residency unconfirmed, num_ctx ${numCtx}`;
            app.setPluginStatus(`AI Bridge ready: ${result.model} preloaded (${placement})`);
          }
        })
        .catch(() => {});
    },
    registerWithRouter: (router) => {
      if (routesRegistered) {
        return;
      }
      router.get('/ai/status', statusHandler);
      router.post('/ai/query', queryHandler);
      router.post('/bridge/execute', bridgeExecuteHandler);
      router.post('/bridge/stream', bridgeStreamHandler);
      router.post('/ai/retune', retuneHandler);
      router.get('/history/paths', historyPathsHandler);
      router.get('/signalk/paths', selfPathsHandler);
      router.post('/paths/selection', saveSelectionHandler);
      router.post('/paths/move', movePathHandler);
      routesRegistered = true;
    },
    stop: () => {
      lifecycleGeneration += 1;
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus('AI Bridge stopped.');
      }
      bridgeService.reset();
      resetRuntimeState();
      pluginOptions = {};
      running = false;
    }
  };
};
