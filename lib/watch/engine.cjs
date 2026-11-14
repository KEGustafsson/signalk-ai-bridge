'use strict';

const monitor = require('./path-monitor.cjs');
const { createGnssState, evaluateGnss, isGnssPath, observeGnss } = require('./gnss.cjs');
const { narrate } = require('./narrate.cjs');
const sources = require('./sources.cjs');
const rules = require('./rules.cjs');
const { isAnglePath } = require('../signalk-units.cjs');

/**
 * Watchkeeper engine: every watched Signal K path in, findings and incidents
 * out.
 *
 * Pure and clock-free - the caller passes the time with every call - so the
 * same engine runs live inside the plugin, over a day of History API data in a
 * replay, and in a unit test, and gives the same answers in all three. It uses
 * no language model at any point: detection is statistics, the text is
 * templates (narrate.cjs), and the operator asks the AI about an incident only
 * when they choose to.
 *
 * Pipeline, per sample:
 *   ingest -> regime gates -> exclusions -> path monitor / GNSS monitor
 * and on every tick:
 *   conditions -> tracker (persistence, hysteresis) -> findings -> incidents
 */

const STATE_VERSION = 1;
const MAX_INCIDENTS = 50;
const MAX_REGIME_CHANGES = 20;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const SENSITIVITY = {
  low: { zWarn: 8, zAlert: 14, zClear: 4 },
  normal: { zWarn: 6, zAlert: 10, zClear: 3 },
  high: { zWarn: 4.5, zAlert: 8, zClear: 2.5 }
};

/**
 * Paths whose normal job is to change quickly: they follow the helm, the
 * wind and the seabed, and a "sudden change" in them is seamanship, not news.
 * Position and fix quality are excluded from the per-path checks because the
 * GNSS integrity monitor reads them instead. Notifications are never watched:
 * they are alarms already, and this plugin raises its own there.
 */
const DEFAULT_EXCLUDE = [
  'navigation.position',
  'navigation.gnss',
  'navigation.datetime',
  'navigation.courseOverGround*',
  'navigation.heading*',
  'navigation.attitude',
  'navigation.rateOfTurn',
  'navigation.speedOverGround',
  'navigation.speedThroughWater*',
  'navigation.leewayAngle',
  'navigation.course',
  'navigation.courseRhumbline',
  'navigation.courseGreatCircle',
  'navigation.destination',
  'navigation.anchor',
  'navigation.trip',
  'navigation.log',
  'navigation.magneticVariation*',
  'environment.wind',
  'environment.current',
  'environment.depth',
  'environment.tide',
  'environment.sun',
  'environment.moon',
  'environment.mode',
  'environment.time',
  'steering',
  'performance',
  'design',
  'resources',
  'communication',
  '**.runTime'
];

/**
 * Operating-state changes that make a learned baseline wrong. When an engine
 * starts, its temperatures climb, the alternator lifts the battery voltage and
 * fuel flow appears - all at once, all expected. Instead of an alert for each,
 * the affected paths re-learn their baseline for a settling period.
 */
const DEFAULT_GATES = [
  {
    pattern: /^propulsion\.([^.]+)\.revolutions$/,
    regime: (value) => (typeof value === 'number' ? (value > 0.5 ? 'running' : 'stopped') : undefined),
    affects: (match) => [`propulsion.${match[1]}.`, 'electrical.', 'tanks.fuel.'],
    settleMs: 15 * MINUTE,
    label: (match, regime) => `Engine ${match[1]} ${regime}`
  },
  {
    pattern: /^propulsion\.([^.]+)\.state$/,
    regime: (value) => (value === undefined || value === null ? undefined : String(value)),
    affects: (match) => [`propulsion.${match[1]}.`, 'electrical.', 'tanks.fuel.'],
    settleMs: 15 * MINUTE,
    label: (match, regime) => `Engine ${match[1]} state ${regime}`
  },
  {
    pattern: /^electrical\.(?:chargers|inverters|solar|alternators|ac)\.([^.]+)\.(?:chargingMode|mode|state)$/,
    regime: (value) => (value === undefined || value === null ? undefined : String(value)),
    affects: () => ['electrical.'],
    settleMs: 10 * MINUTE,
    label: (match, regime) => `${match[0].split('.')[1]} ${match[1]} ${regime}`
  },
  {
    pattern: /^navigation\.state$/,
    regime: (value) => (value === undefined || value === null ? undefined : String(value)),
    affects: () => ['propulsion.', 'electrical.', 'tanks.'],
    settleMs: 10 * MINUTE,
    label: (match, regime) => `Vessel ${regime}`
  }
];

const RESTING_REGIME = /^(?:stopped|off|idle|standby|not[ _-]?running|disabled|moored|0)$/i;

// How long a condition must hold before it is a finding, and how long it must
// be gone before the finding clears. Persistence keeps a one-second glitch out
// of the operator's way; the clear delay keeps a value hovering at the
// threshold from opening and closing the same finding every few seconds.
const TIMING = {
  shift: { persistMs: 15000, clearMs: 60000 },
  dropout: { persistMs: 0, clearMs: 0 },
  frozen: { persistMs: 0, clearMs: 0 },
  newState: { persistMs: 0, clearMs: 0 },
  cycling: { persistMs: 0, clearMs: 10 * MINUTE },
  forecast: { persistMs: 2 * MINUTE, clearMs: 5 * MINUTE },
  feed: { persistMs: 0, clearMs: 0 },
  disagree: { persistMs: 30000, clearMs: 60000 },
  failover: { persistMs: 0, clearMs: 0 },
  rule: { persistMs: 5000, clearMs: 30000 },
  'gnss.jump': { persistMs: 0, clearMs: 0 },
  'gnss.deadReckoning': { persistMs: 30000, clearMs: 60000 },
  'gnss.sourcesDisagree': { persistMs: 30000, clearMs: 60000 },
  'gnss.quality': { persistMs: 30000, clearMs: 60000 },
  'gnss.frozen': { persistMs: 0, clearMs: 10000 },
  'gnss.clock': { persistMs: 0, clearMs: 0 }
};

const SEVERITY_RANK = { warn: 1, alert: 2 };

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function toBounded(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeWatchConfig(options = {}) {
  const sensitivity = Object.prototype.hasOwnProperty.call(SENSITIVITY, options.watchSensitivity)
    ? options.watchSensitivity
    : 'normal';
  const extraExclude = Array.isArray(options.watchExcludePaths)
    ? options.watchExcludePaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const useDefaults = toBoolean(options.watchDefaultExclusions, true);

  return {
    watchEnabled: toBoolean(options.watchEnabled, false),
    watchSensitivity: sensitivity,
    watchNotifications: toBoolean(options.watchNotifications, true),
    watchSound: toBoolean(options.watchSound, false),
    watchLearningMinutes: toBounded(options.watchLearningMinutes, 30, 1, 24 * 60),
    watchMaxPaths: Math.round(toBounded(options.watchMaxPaths, 1500, 10, 10000)),
    watchExcludePaths: extraExclude,
    watchDefaultExclusions: useDefaults,
    watchRules: rules.normalizeRules(options.watchRules),
    watchRuleAssist: ['off', 'main', 'helper'].includes(options.watchRuleAssist) ? options.watchRuleAssist : 'main',
    watchHelperModel: typeof options.watchHelperModel === 'string' ? options.watchHelperModel.trim() : '',
    exclude: [...(useDefaults ? DEFAULT_EXCLUDE : []), ...extraExclude]
  };
}

/** Detector options for a normalized watch config. */
function detectorOptions(config) {
  return {
    ...SENSITIVITY[config.watchSensitivity || 'normal'],
    minIntervalMs: 1000,
    minSamples: 30,
    acceptExcursionMs: 60 * MINUTE,
    relearnMs: 10 * MINUTE,
    learningMs: (config.watchLearningMinutes || 30) * MINUTE,
    maxRegularIntervalMs: MINUTE,
    dropoutMinMs: 30000,
    dropoutFactor: 10,
    frozenMinSamples: 100,
    frozenMinRepeats: 30,
    frozenMs: 5 * MINUTE,
    eventHoldMs: 10 * MINUTE,
    cyclingLearningMs: 6 * HOUR,
    cyclingMinPerHour: 4,
    gnssMaxSpeedKn: 40,
    gnssJumpMinMetres: 100,
    gnssCurrentAllowanceKn: 2,
    gnssSourceDisagreeMetres: 100,
    gnssFrozenMs: MINUTE,
    gnssClockJumpMs: 30000
  };
}

/**
 * `navigation.heading*`, `**.runTime`, `steering`: `*` is one segment's worth
 * of characters, `**` crosses segments, and every pattern also covers the
 * paths beneath it.
 */
function compileGlob(pattern) {
  const text = String(pattern || '').trim();
  if (!text.includes('*')) {
    return (path) => path === text || path.startsWith(`${text}.`);
  }
  const source = text
    .split('**')
    .map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*'))
    .join('.*');
  const regex = new RegExp(`^${source}(?:\\..*)?$`);
  return (path) => regex.test(path);
}

/** A matcher that returns the first pattern a path matches, or undefined. */
function compileMatchers(patterns) {
  const matchers = patterns.map((pattern) => [pattern, compileGlob(pattern)]);
  return (path) => {
    for (const [pattern, match] of matchers) {
      if (match(path)) return pattern;
    }
    return undefined;
  };
}

/** Leaves of an object value (attitude, a nested sensor), bounded. */
function leaves(path, value, out = [], depth = 0) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.push([path, value]);
    return out;
  }
  if (depth >= 3) {
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (out.length >= 32) break;
    leaves(`${path}.${key}`, item, out, depth + 1);
  }
  return out;
}

function pathGroup(path) {
  return String(path || '').split('.').slice(0, 2).join('.');
}

function createWatchEngine(config = {}, { now = 0, onNewPath } = {}) {
  const watchConfig = config.exclude ? config : normalizeWatchConfig(config);
  const options = detectorOptions(watchConfig);
  const isExcluded = compileMatchers(watchConfig.exclude);
  const gates = DEFAULT_GATES;

  const paths = new Map();
  // Excluded path -> the pattern that excluded it, for the inventory.
  const excluded = new Map();
  // Excluded paths are not baselined, but redundant sources on them are still
  // compared: two compasses disagreeing matters even though heading itself is
  // expected to swing. Created only once a second source appears.
  const firstSource = new Map();
  const sourceOnly = new Map();
  const gnssInputs = new Set();
  // The latest value of every leaf, watched or not, for rules: a rule may be
  // about a path the statistics skip ("tell me if the depth is below 3 m").
  const latest = new Map();
  const MAX_LATEST = 6000;
  let activeRules = watchConfig.watchRules || [];
  const ruleMemory = new Map();
  let capped = 0;
  const gnss = createGnssState();
  const gateRegimes = new Map();
  const regimeChanges = [];
  const trackers = new Map();
  const findings = new Map();
  let incidents = [];
  let incidentCounter = 0;
  let mutes = [];
  let mutesCompiled = () => false;
  let lastTick = now;
  const startedAt = now;
  const counters = { findingsOpened: 0, incidentsOpened: 0, byDetector: {} };

  function compileMutes(t) {
    mutes = mutes.filter((mute) => mute.until > t);
    const matchers = mutes.map((mute) => compileGlob(mute.path));
    mutesCompiled = (path) => path !== undefined && matchers.some((match) => match(path));
  }

  // Gate path -> the prefixes it affects, so each path's operating state can be
  // named: "propulsion.main.revolutions=running;navigation.state=motoring".
  const gatePrefixes = new Map();

  function regimeKeyFor(path) {
    const parts = [];
    for (const [gatePath, prefixes] of gatePrefixes) {
      if (prefixes.some((prefix) => path.startsWith(prefix)) && gateRegimes.has(gatePath)) {
        parts.push(`${gatePath}=${gateRegimes.get(gatePath)}`);
      }
    }
    return parts.sort().join(';');
  }

  /**
   * An operating-state change. Every affected path files its settled baseline
   * under the state it is leaving, and re-learns through the transition. If it
   * has been in the new state before, the baseline it learned there is
   * restored once the transition settles - so the second engine start is
   * judged against how this engine normally runs, not against whatever it did
   * while warming up. Without that, a re-learn after every start would quietly
   * accept "running 10 °C hotter than usual" as the new normal.
   */
  function applyGates(path, value, t) {
    for (const gate of gates) {
      const match = gate.pattern.exec(path);
      if (!match) continue;
      const regime = gate.regime(value);
      if (regime === undefined) continue;
      const prefixes = gate.affects(match);
      gatePrefixes.set(path, prefixes);
      const previous = gateRegimes.get(path);
      if (previous === regime) continue;
      if (previous === undefined) {
        gateRegimes.set(path, regime);
        continue;
      }
      const affectedStates = [...paths.values()].filter((state) => prefixes.some((prefix) => state.path.startsWith(prefix)));
      const leaving = new Map(affectedStates.map((state) => [state, regimeKeyFor(state.path)]));
      gateRegimes.set(path, regime);
      let restored = 0;
      for (const state of affectedStates) {
        monitor.saveRegimeBaseline(state, leaving.get(state), t, options);
        // Restored only into an active state. A stopped engine's temperatures
        // are a cool-down that takes hours and depends on the weather, so
        // "how it usually is when stopped" is not a baseline to hold it to.
        if (!RESTING_REGIME.test(regime) && monitor.planRegimeRestore(state, regimeKeyFor(state.path))) restored += 1;
        else monitor.planRegimeRestore(state, undefined);
        monitor.beginRelearn(state, t, gate.settleMs);
      }
      regimeChanges.unshift({
        at: t,
        path,
        from: previous,
        to: regime,
        label: gate.label(match, regime),
        affected: affectedStates.length,
        restored,
        settleMs: gate.settleMs
      });
      regimeChanges.splice(MAX_REGIME_CHANGES);
    }
  }

  function getState(path, t) {
    let state = paths.get(path);
    if (!state) {
      if (paths.size >= watchConfig.watchMaxPaths) {
        capped += 1;
        return undefined;
      }
      state = monitor.createPathState(path, t);
      paths.set(path, state);
      if (typeof onNewPath === 'function') onNewPath(path);
    }
    return state;
  }

  /** One Signal K value. `t` is when it was received (ms since epoch). */
  function ingest(path, value, t, source) {
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('notifications')) {
      return;
    }
    if (isGnssPath(path)) {
      gnssInputs.add(path);
      observeGnss(gnss, path, value, t, source, options);
    }
    const gnssInput = isGnssPath(path);
    for (const [leafPath, leafValue] of leaves(path, value)) {
      if (gnssInput) gnssInputs.add(leafPath);
      if (latest.has(leafPath) || latest.size < MAX_LATEST) latest.set(leafPath, { value: leafValue, at: t });
      applyGates(leafPath, leafValue, t);
      const excludedBy = isExcluded(leafPath);
      if (excludedBy !== undefined) {
        if (!excluded.has(leafPath) && excluded.size < 5000) excluded.set(leafPath, excludedBy);
        trackExcludedSources(leafPath, leafValue, t, source);
        continue;
      }
      const state = getState(leafPath, t);
      if (!state) continue;
      if (!state.sources) state.sources = sources.createSourceState();
      const fromPrimary = sources.routeSample(state.sources, source, leafValue, t, {
        intervalMean: state.intervalMean,
        angle: state.angle,
        scaleOf: () => monitor.noiseFloor(state),
        zClear: options.zClear
      });
      if (!fromPrimary) continue;
      state.source = state.sources.primary === 'default' ? undefined : state.sources.primary;
      monitor.observe(state, leafValue, t, options);
    }
  }

  function trackExcludedSources(path, value, t, source) {
    if (!source || path.startsWith('navigation.position') || path === 'navigation.datetime') return;
    let entry = sourceOnly.get(path);
    if (!entry) {
      const first = firstSource.get(path);
      if (first === undefined) {
        if (firstSource.size < 5000) firstSource.set(path, source);
        return;
      }
      if (first === source || sourceOnly.size >= 500) return;
      entry = { path, units: undefined, angle: isAnglePath(path), sources: sources.createSourceState(), interval: undefined, lastAt: undefined };
      sourceOnly.set(path, entry);
    }
    if (entry.lastAt !== undefined && t > entry.lastAt) {
      const dt = t - entry.lastAt;
      entry.interval = entry.interval === undefined ? dt : entry.interval + 0.1 * (dt - entry.interval);
    }
    entry.lastAt = t;
    sources.routeSample(entry.sources, source, value, t, {
      intervalMean: entry.interval,
      angle: entry.angle,
      scaleOf: () => monitor.noiseFloor(entry),
      zClear: options.zClear
    });
  }

  /** Units, display name and zones from the path's Signal K metadata. */
  function setMeta(path, meta) {
    const state = paths.get(path) || sourceOnly.get(path);
    if (!state || !meta || typeof meta !== 'object') return;
    if (typeof meta.units === 'string') state.units = meta.units;
    if (typeof meta.displayName === 'string') state.displayName = meta.displayName;
    if (Array.isArray(meta.zones)) state.zones = meta.zones.slice(0, 10);
  }

  // ---- incidents -----------------------------------------------------------

  function findIncidentFor(finding, t) {
    const group = finding.detector.startsWith('gnss.') ? 'gnss' : pathGroup(finding.path);
    // Findings join an incident by system (same two-segment prefix, e.g.
    // propulsion.main) or by timing (within three minutes of its last new
    // finding). GNSS is kept apart in both directions: a spoofed fix and an
    // overheating engine arriving together are a coincidence, and folding one
    // into the other would bury the position warning under an engine title.
    return incidents.find((incident) => {
      if (incident.status !== 'active') return false;
      const gnssOnly = incident.groups.length > 0 && incident.groups.every((item) => item === 'gnss');
      if (group === 'gnss') return incident.groups.includes('gnss');
      if (gnssOnly) return false;
      return t - incident.joinedAt <= 3 * MINUTE || incident.groups.includes(group);
    });
  }

  function refreshIncident(incident) {
    const entries = incident.findings;
    const first = entries[0];
    incident.title = entries.length > 1 ? `${first.title} (+${entries.length - 1} related)` : first.title;
    incident.severity = entries.reduce(
      (worst, entry) => (SEVERITY_RANK[entry.severity] > SEVERITY_RANK[worst] ? entry.severity : worst),
      incident.severity || 'warn'
    );
  }

  function attach(finding, t) {
    const group = finding.detector.startsWith('gnss.') ? 'gnss' : pathGroup(finding.path);
    let incident = findIncidentFor(finding, t);
    if (!incident) {
      incidentCounter += 1;
      counters.incidentsOpened += 1;
      incident = {
        id: `inc-${t.toString(36)}-${incidentCounter}`,
        status: 'active',
        openedAt: t,
        updatedAt: t,
        joinedAt: t,
        resolvedAt: undefined,
        severity: finding.severity,
        groups: [],
        findings: [],
        title: ''
      };
      incidents.unshift(incident);
      incidents = incidents.slice(0, MAX_INCIDENTS);
    }
    if (!incident.groups.includes(group)) incident.groups.push(group);
    incident.findings.push(snapshot(finding));
    incident.updatedAt = t;
    // Grouping is by when findings *joined*, not by when the incident last
    // changed: open findings refresh their text on every tick, and keying on
    // that would make one long incident swallow everything after it.
    incident.joinedAt = t;
    finding.incidentId = incident.id;
    refreshIncident(incident);
  }

  function snapshot(finding) {
    return {
      key: finding.key,
      detector: finding.detector,
      path: finding.path,
      severity: finding.severity,
      title: finding.title,
      message: finding.message,
      openedAt: finding.openedAt,
      clearedAt: finding.clearedAt
    };
  }

  function updateIncidentEntry(finding, t) {
    const incident = incidents.find((item) => item.id === finding.incidentId);
    if (!incident) return;
    const entry = incident.findings.find((item) => item.key === finding.key && item.openedAt === finding.openedAt);
    if (entry) Object.assign(entry, snapshot(finding));
    incident.updatedAt = t;
    if (incident.findings.every((item) => item.clearedAt !== undefined)) {
      incident.status = 'resolved';
      incident.resolvedAt = t;
    }
    refreshIncident(incident);
  }

  // ---- condition tracking --------------------------------------------------

  /**
   * Feed one condition through persistence and hysteresis. `cond` is
   * `{ active, severity, evidence, message? }`, or null when the detector has
   * no opinion (still learning, muted, not applicable) - which counts as
   * inactive, so a finding whose path goes into re-learning still clears.
   */
  function applyCondition(key, detector, info, cond, t, timingOverride) {
    const timing = timingOverride || TIMING[detector] || { persistMs: 0, clearMs: 0 };
    const tracker = trackers.get(key) || {};
    const open = findings.get(key);
    const active = Boolean(cond && cond.active);

    if (active) {
      tracker.clearSince = undefined;
      if (!open) {
        tracker.pendingSince = tracker.pendingSince === undefined ? t : tracker.pendingSince;
        if (t - tracker.pendingSince >= timing.persistMs) {
          const text = narrate(detector, info, cond.evidence, cond);
          const finding = {
            key,
            detector,
            path: info.path,
            notifyKey: info.notifyKey,
            severity: cond.severity,
            openedAt: t,
            updatedAt: t,
            clearedAt: undefined,
            title: text.title,
            message: text.message,
            evidence: cond.evidence
          };
          findings.set(key, finding);
          counters.findingsOpened += 1;
          counters.byDetector[detector] = (counters.byDetector[detector] || 0) + 1;
          attach(finding, t);
          tracker.pendingSince = undefined;
        }
      } else {
        const text = narrate(detector, info, cond.evidence, cond);
        // Severity escalates while a finding is open but does not fall back:
        // an alert that eased to a warning is still the alert it was.
        if (SEVERITY_RANK[cond.severity] > SEVERITY_RANK[open.severity]) open.severity = cond.severity;
        open.title = text.title;
        open.message = text.message;
        open.evidence = cond.evidence;
        open.updatedAt = t;
        updateIncidentEntry(open, t);
      }
    } else {
      tracker.pendingSince = undefined;
      if (open) {
        tracker.clearSince = tracker.clearSince === undefined ? t : tracker.clearSince;
        if (t - tracker.clearSince >= timing.clearMs) {
          open.clearedAt = t;
          findings.delete(key);
          updateIncidentEntry(open, t);
          tracker.clearSince = undefined;
        }
      }
    }
    if (tracker.pendingSince === undefined && tracker.clearSince === undefined && !findings.has(key)) {
      trackers.delete(key);
    } else {
      trackers.set(key, tracker);
    }
  }

  function pathInfo(state) {
    return {
      path: state.path,
      units: state.units,
      displayName: state.displayName,
      notifyKey: state.path
    };
  }

  /** Run every time-based check. Call every few seconds. */
  function tick(t) {
    lastTick = t;
    compileMutes(t);

    // Feed-wide silence first: when half the vessel goes quiet at once that is
    // one fact (a gateway or the server's input died), not forty dropouts.
    let regular = 0;
    let silent = 0;
    const silentSources = new Set();
    const dropouts = new Map();
    for (const state of paths.values()) {
      const cond = monitor.evaluateDropout(state, t, options);
      if (!cond) continue;
      regular += 1;
      if (cond.active) {
        silent += 1;
        if (state.source) silentSources.add(state.source);
      }
      dropouts.set(state.path, cond);
    }
    const feedSilent = regular >= 4 && silent >= Math.max(4, 0.5 * regular);
    applyCondition(
      'feed',
      'feed',
      { path: 'feed', notifyKey: 'dataFeed' },
      regular >= 4
        ? { active: feedSilent, severity: 'alert', evidence: { silent, regular, sources: [...silentSources] } }
        : null,
      t
    );

    for (const state of paths.values()) {
      monitor.applyPendingRestore(state, t);
      const muted = mutesCompiled(state.path);
      const info = pathInfo(state);
      const checks = [
        ['shift', muted ? null : monitor.evaluateShift(state, t, options, findings.has(`shift:${state.path}`))],
        ['dropout', muted || feedSilent ? null : dropouts.get(state.path) || null],
        ['frozen', muted ? null : monitor.evaluateFrozen(state, t, options)],
        ['newState', muted ? null : monitor.evaluateNewState(state, t, options)],
        ['cycling', muted ? null : monitor.evaluateCycling(state, t, options)],
        ['forecast', muted ? null : monitor.evaluateForecast(state, t, options)],
        ['disagree', muted || !state.sources ? null : sources.evaluateDisagree(state.sources, t, {
          ...options,
          scale: monitor.noiseFloor(state),
          isOpen: findings.has(`disagree:${state.path}`)
        })],
        ['failover', muted || !state.sources ? null : sources.evaluateFailover(state.sources, t, options.eventHoldMs)]
      ];
      for (const [detector, cond] of checks) {
        const key = `${detector}:${state.path}`;
        if (cond === null && !findings.has(key) && !trackers.has(key)) continue;
        applyCondition(key, detector, info, cond, t);
      }
    }

    for (const entry of sourceOnly.values()) {
      const muted = mutesCompiled(entry.path);
      const info = { path: entry.path, units: entry.units, displayName: entry.displayName, notifyKey: entry.path };
      const checks = [
        ['disagree', muted ? null : sources.evaluateDisagree(entry.sources, t, {
          ...options,
          scale: monitor.noiseFloor(entry),
          isOpen: findings.has(`disagree:${entry.path}`)
        })],
        ['failover', muted ? null : sources.evaluateFailover(entry.sources, t, options.eventHoldMs)]
      ];
      for (const [detector, cond] of checks) {
        const key = `${detector}:${entry.path}`;
        if (cond === null && !findings.has(key) && !trackers.has(key)) continue;
        applyCondition(key, detector, info, cond, t);
      }
    }

    for (const rule of activeRules) {
      let memory = ruleMemory.get(rule.id);
      if (!memory) {
        memory = {};
        ruleMemory.set(rule.id, memory);
      }
      const cond = mutesCompiled(rule.path) ? null : rules.evaluateRule(rule, (path) => latest.get(path), t, memory);
      const state = paths.get(rule.path);
      applyCondition(
        `rule:${rule.id}`,
        'rule',
        {
          path: rule.path,
          units: state && state.units,
          displayName: state && state.displayName,
          notifyKey: `rules.${rule.id}`,
          infoFor
        },
        cond,
        t,
        { persistMs: Math.max(TIMING.rule.persistMs, rule.forSeconds * 1000), clearMs: TIMING.rule.clearMs }
      );
    }

    const gnssMuted = mutesCompiled('navigation.position');
    const indicators = evaluateGnss(gnss, t, options);
    const activeIndicators = Object.values(indicators).filter((cond) => cond && cond.active).length;
    for (const [name, cond] of Object.entries(indicators)) {
      const key = `gnss.${name}`;
      if (cond === null && !findings.has(key) && !trackers.has(key)) continue;
      // Two independent indicators at once is corroboration: an alert, not a
      // warning, whichever two they are.
      const escalated = cond && cond.active && activeIndicators >= 2 ? { ...cond, severity: 'alert' } : cond;
      applyCondition(key, key, { path: 'navigation.position', notifyKey: 'gnss' }, gnssMuted ? null : escalated, t);
    }
  }

  // ---- inventory -----------------------------------------------------------

  function roleOf(state, t) {
    if (t < state.relearnUntil) return 'relearning';
    return monitor.isReady(state, t, options) ? 'watching' : 'learning';
  }

  /**
   * Everything the watch has discovered on this vessel, and what that makes
   * possible. Nothing here is configured per boat: paths are found as they
   * are published, classified from their own values and metadata, and each
   * check reports whether this vessel's data is enough to run it.
   */
  function inventory(t = lastTick) {
    const branches = new Map();
    const branchOf = (path) => {
      const name = path.split('.')[0];
      if (!branches.has(name)) branches.set(name, { branch: name, watched: 0, excluded: 0 });
      return branches.get(name);
    };
    const rows = [];
    let withMeta = 0;
    let multiSource = 0;
    let zoned = 0;
    let depletion = 0;
    for (const state of paths.values()) {
      branchOf(state.path).watched += 1;
      if (state.units) withMeta += 1;
      if (Array.isArray(state.zones) && state.zones.length > 0) zoned += 1;
      if (monitor.hasDepletionTarget(state.path)) depletion += 1;
      const sourceList = sources.sourceSummary(state.sources, t) || [];
      if (sourceList.length > 1) multiSource += 1;
      rows.push({
        path: state.path,
        role: roleOf(state, t),
        kind: monitor.isCounterState(state) ? 'counter' : state.kind,
        units: state.units,
        displayName: state.displayName,
        intervalMs: state.intervalMean === undefined ? undefined : Math.round(state.intervalMean),
        samples: state.n,
        sources: sourceList
      });
    }
    for (const [path, pattern] of excluded) {
      branchOf(path).excluded += 1;
      const entry = sourceOnly.get(path);
      const sourceList = entry ? sources.sourceSummary(entry.sources, t) : undefined;
      if (sourceList && sourceList.length > 1) multiSource += 1;
      rows.push({
        path,
        role: gnssInputs.has(path) ? 'gnss-input' : 'skipped',
        excludedBy: pattern,
        ...(sourceList ? { sources: sourceList } : {})
      });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));

    const gatesSeen = [...gateRegimes.entries()].map(([path, regime]) => `${path} (${regime})`);
    const positionSources = Object.keys(gnss.fixes).length;
    const hasHeading = gnss.heading !== undefined || (gnss.headingMagnetic !== undefined && gnss.variation !== undefined);
    const hasLog = gnss.stw !== undefined;
    const drMissing = [
      positionSources > 0 ? undefined : 'navigation.position',
      hasHeading ? undefined : 'navigation.headingTrue (or headingMagnetic with magneticVariation)',
      hasLog ? undefined : 'navigation.speedThroughWater'
    ].filter(Boolean);
    const capabilities = [
      {
        id: 'baselines',
        label: 'Learned baselines',
        available: paths.size > 0,
        detail: `${paths.size} paths watched; ${withMeta} with units from their own metadata, the rest from Signal K naming`
      },
      {
        id: 'gnss-position',
        label: 'GNSS position checks (jumps, frozen fix)',
        available: positionSources > 0,
        detail: positionSources > 0 ? `${positionSources} position source${positionSources === 1 ? '' : 's'}` : 'needs navigation.position'
      },
      {
        id: 'gnss-dead-reckoning',
        label: 'Dead reckoning cross-check',
        available: drMissing.length === 0,
        detail: drMissing.length === 0 ? 'heading and speed through water available' : `needs ${drMissing.join(', ')}`
      },
      {
        id: 'gnss-receivers',
        label: 'Second GNSS receiver comparison',
        available: positionSources >= 2,
        detail: positionSources >= 2 ? `${positionSources} receivers` : 'needs a second source publishing navigation.position'
      },
      {
        id: 'gnss-quality',
        label: 'Satellite and dilution checks',
        available: gnss.satellites !== undefined || gnss.hdop !== undefined,
        detail:
          gnss.satellites !== undefined || gnss.hdop !== undefined
            ? [gnss.satellites !== undefined ? 'satellite count' : undefined, gnss.hdop !== undefined ? 'dilution' : undefined]
                .filter(Boolean)
                .join(' and ') + ' available'
            : 'needs navigation.gnss.satellites or navigation.gnss.horizontalDilution'
      },
      {
        id: 'gnss-clock',
        label: 'GNSS clock check',
        available: gnss.clockSamples > 0,
        detail: gnss.clockSamples > 0 ? 'navigation.datetime available' : 'needs navigation.datetime'
      },
      {
        id: 'regimes',
        label: 'Operating-state awareness',
        available: gatesSeen.length > 0,
        detail: gatesSeen.length > 0 ? gatesSeen.slice(0, 6).join(', ') : 'needs propulsion.*.revolutions or .state, a charger or inverter mode, or navigation.state'
      },
      {
        id: 'redundancy',
        label: 'Redundant sensors compared',
        available: multiSource > 0,
        detail: multiSource > 0 ? `${multiSource} path${multiSource === 1 ? '' : 's'} with more than one source` : 'no path has more than one source'
      },
      {
        id: 'forecasts',
        label: 'Trend forecasts',
        available: depletion + zoned > 0,
        detail: depletion + zoned > 0
          ? `${depletion} tank or battery level${depletion === 1 ? '' : 's'}, ${zoned} path${zoned === 1 ? '' : 's'} with zones`
          : 'needs tanks.*.*.currentLevel, a battery stateOfCharge, or meta.zones on a path'
      }
    ];

    return {
      totals: {
        seen: paths.size + excluded.size,
        watched: paths.size,
        skipped: excluded.size,
        capped,
        gnssInputs: gnssInputs.size,
        multiSource
      },
      branches: [...branches.values()].sort((a, b) => a.branch.localeCompare(b.branch)),
      capabilities,
      paths: rows.slice(0, 3000),
      ...(rows.length > 3000 ? { truncated: rows.length - 3000 } : {})
    };
  }

  /**
   * The paths furthest from their own normal right now, alarming or not.
   *
   * The answer to "something feels off": every continuous path ranked by how
   * many of its own normal variations it sits from its baseline for the
   * current operating state, plus discrete paths sitting in a state they are
   * rarely in. Nothing has to cross a threshold to appear here.
   */
  function unusual(t = lastTick, limit = 10) {
    const rows = [];
    for (const state of paths.values()) {
      if (!monitor.isReady(state, t, options) || mutesCompiled(state.path)) continue;
      if (state.kind === 'continuous' && !monitor.isCounterState(state)) {
        const cond = monitor.evaluateShift(state, t, options, false);
        if (!cond) continue;
        const z = cond.evidence.z;
        if (!Number.isFinite(z) || Math.abs(z) < 1.5) continue;
        const text = narrate('shift', pathInfo(state), cond.evidence);
        rows.push({ path: state.path, score: Math.abs(z), title: text.title.replace(/unusually/, Math.abs(z) >= options.zWarn ? 'unusually' : 'somewhat'), message: text.message, regime: regimeKeyFor(state.path) || undefined });
      } else if (state.kind === 'discrete' && state.lastValue !== undefined) {
        const total = Object.values(state.seen).reduce((sum, count) => sum + count, 0);
        const share = total > 0 ? (state.seen[state.lastValue] || 0) / total : 1;
        if (total < 100 || share >= 0.05) continue;
        // Rarity on the same rough scale as the z-scores: 5% -> 1.6, 1% -> 2.3, 0.1% -> 3.
        const score = -Math.log10(share) + 0.3;
        const info = pathInfo(state);
        rows.push({
          path: state.path,
          score,
          title: `${narrate('newState', info, { value: state.lastValue }).title.replace('changed to', 'is')}`,
          message: `In this state ${(share * 100).toFixed(share < 0.01 ? 2 : 1)} % of the time it has been watched`
        });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    return { at: t, rows: rows.slice(0, limit).map((row) => ({ ...row, score: Number(row.score.toFixed(1)) })) };
  }

  // ---- operator rules --------------------------------------------------------

  function infoFor(path) {
    const state = paths.get(path) || sourceOnly.get(path);
    return state ? { units: state.units, displayName: state.displayName } : undefined;
  }

  /** Every path a rule could be about, with what is known of it. */
  function knownPaths(t = lastTick) {
    const out = [];
    for (const path of latest.keys()) {
      if (path.startsWith('navigation.position.')) continue;
      const state = paths.get(path);
      const info = infoFor(path) || {};
      out.push({
        path,
        units: info.units,
        displayName: info.displayName,
        role: state ? roleOf(state, t) : gnssInputs.has(path) ? 'gnss-input' : 'skipped'
      });
    }
    return out;
  }

  function setRules(list) {
    activeRules = rules.normalizeRules(list);
    const ids = new Set(activeRules.map((rule) => rule.id));
    for (const id of [...ruleMemory.keys()]) {
      if (!ids.has(id)) ruleMemory.delete(id);
    }
    // Findings of rules that no longer exist clear on the next tick through
    // the ordinary path: no condition means inactive.
    for (const key of [...findings.keys()]) {
      if (key.startsWith('rule:') && !ids.has(key.slice(5))) {
        applyCondition(key, 'rule', { path: findings.get(key).path, notifyKey: findings.get(key).notifyKey }, null, lastTick, { persistMs: 0, clearMs: 0 });
      }
    }
    return activeRules;
  }

  /**
   * What a candidate rule would say now, and how often it would have been
   * true over the watch's own recent record of the path - evidence for the
   * operator before they store it.
   */
  function proveRule(candidate, t = lastTick) {
    const rule = rules.normalizeRule(candidate, t);
    const current = latest.get(rule.path);
    const verdict = rules.evaluateRule(rule, (path) => latest.get(path), t, {});
    const state = paths.get(rule.path);
    let recent;
    if (state && (rule.op === 'above' || rule.op === 'below') && state.kind === 'continuous') {
      const minutes = monitor.seriesWithOpen(state, 'minutes', 'minuteBucket', 60000);
      if (minutes.length > 0) {
        const hits = minutes.filter(([, value]) => (rule.op === 'above' ? value > rule.value : value < rule.value)).length;
        recent = { minutes: minutes.length, share: hits / minutes.length };
      }
    }
    return {
      rule,
      description: rules.describeRule(rule, infoFor),
      current: current
        ? { value: current.value, text: rules.describeValue(rule.path, current.value, infoFor(rule.path)), ageMs: t - current.at }
        : undefined,
      wouldFireNow: verdict === null ? null : verdict.active,
      ...(recent ? { recent } : {})
    };
  }

  function ruleStatus(t) {
    return activeRules.map((rule) => {
      const current = latest.get(rule.path);
      return {
        ...rule,
        description: rules.describeRule(rule, infoFor),
        firing: findings.has(`rule:${rule.id}`),
        current: current ? rules.describeValue(rule.path, current.value, infoFor(rule.path)) : undefined,
        currentAgeMs: current ? t - current.at : undefined
      };
    });
  }

  // ---- outputs -------------------------------------------------------------

  /**
   * One notification per path (or per GNSS / data feed), carrying the worst
   * open finding for it: `Map<notifyKey, { state, message, findings }>`.
   */
  function notificationStates() {
    const out = new Map();
    for (const finding of findings.values()) {
      const current = out.get(finding.notifyKey);
      if (!current) {
        out.set(finding.notifyKey, { state: finding.severity, title: finding.title, message: `${finding.title}: ${finding.message}`, count: 1 });
        continue;
      }
      current.count += 1;
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[current.state]) {
        current.state = finding.severity;
        current.title = finding.title;
        current.message = `${finding.title}: ${finding.message}`;
      }
    }
    for (const value of out.values()) {
      if (value.count > 1) value.message = `${value.message} (+${value.count - 1} more)`;
    }
    return out;
  }

  function gnssSummary(t) {
    const indicators = evaluateGnss(gnss, t, options);
    const summary = {};
    let any = false;
    for (const [name, cond] of Object.entries(indicators)) {
      const open = findings.has(`gnss.${name}`);
      summary[name] = cond === null ? 'unavailable' : open ? 'active' : 'ok';
      if (cond !== null) any = true;
    }
    const active = Object.values(summary).filter((value) => value === 'active').length;
    return {
      status: !any && !gnss.lastFix ? 'unavailable' : active >= 2 ? 'suspect' : active === 1 ? 'degraded' : 'ok',
      lastFixAt: gnss.lastFix ? gnss.lastFix.at : undefined,
      indicators: summary
    };
  }

  function status(t = lastTick) {
    let learning = 0;
    let ready = 0;
    let relearning = 0;
    for (const state of paths.values()) {
      if (t < state.relearnUntil) relearning += 1;
      else if (monitor.isReady(state, t, options)) ready += 1;
      else learning += 1;
    }
    return {
      startedAt,
      sensitivity: watchConfig.watchSensitivity,
      learningMinutes: watchConfig.watchLearningMinutes,
      paths: { watched: paths.size, ready, learning, relearning, excluded: excluded.size, capped },
      sourcesCompared: sourceOnly.size + [...paths.values()].filter((state) => state.sources && Object.keys(state.sources.entries).length > 1).length,
      activeFindings: [...findings.values()].map(snapshotWithIncident),
      incidents: incidents.map(publicIncident),
      regimeChanges: regimeChanges.slice(),
      gnss: gnssSummary(t),
      rules: ruleStatus(t),
      mutes: mutes.map((mute) => ({ ...mute }))
    };
  }

  function snapshotWithIncident(finding) {
    return { ...snapshot(finding), incidentId: finding.incidentId };
  }

  function publicIncident(incident) {
    const { groups, ...rest } = incident;
    return { ...rest, findings: incident.findings.map((entry) => ({ ...entry })) };
  }

  /** Learned series for one path, for the panel's evidence sparkline. */
  function series(path) {
    const state = paths.get(path);
    if (!state) return undefined;
    return {
      path,
      units: state.units,
      minutes: monitor.seriesWithOpen(state, 'minutes', 'minuteBucket', 60000),
      recent: monitor.seriesWithOpen(state, 'recent', 'recentBucket', 10000)
    };
  }

  function mute(path, untilMs, t) {
    const clean = String(path || '').trim();
    if (!clean) return;
    mutes = mutes.filter((item) => item.path !== clean);
    mutes.push({ path: clean, until: untilMs });
    compileMutes(t);
  }

  function unmute(path, t) {
    mutes = mutes.filter((item) => item.path !== String(path || '').trim());
    compileMutes(t);
  }

  function exportState(t) {
    return {
      version: STATE_VERSION,
      savedAt: t,
      paths: [...paths.values()].map(monitor.exportPathState),
      incidents: incidents.map((incident) => ({ ...incident, findings: incident.findings.map((entry) => ({ ...entry })) })),
      mutes,
      gateRegimes: [...gateRegimes.entries()],
      gatePrefixes: [...gatePrefixes.entries()]
    };
  }

  /** Restore a saved baseline. Open incidents are closed: their findings did not survive. */
  function importState(saved, t) {
    if (!saved || saved.version !== STATE_VERSION || !Array.isArray(saved.paths)) {
      return false;
    }
    for (const item of saved.paths) {
      if (!item || typeof item.path !== 'string' || isExcluded(item.path) || paths.size >= watchConfig.watchMaxPaths) continue;
      const state = monitor.importPathState(item, t);
      if (!state) continue;
      if (state.sources && state.sources.entries) {
        // Like lastAt: the gap while the plugin was down is not a failover.
        for (const entry of Object.values(state.sources.entries)) entry.at = t;
        state.sources.lastDiff = undefined;
        state.sources.failover = undefined;
      }
      paths.set(state.path, state);
    }
    if (Array.isArray(saved.incidents)) {
      incidents = saved.incidents.slice(0, MAX_INCIDENTS).map((incident) => {
        if (incident.status !== 'active') return incident;
        return {
          ...incident,
          status: 'resolved',
          resolvedAt: t,
          interrupted: true,
          findings: (incident.findings || []).map((entry) => ({ ...entry, clearedAt: entry.clearedAt ?? t }))
        };
      });
    }
    if (Array.isArray(saved.mutes)) {
      mutes = saved.mutes.filter((item) => item && typeof item.path === 'string' && item.until > t);
      compileMutes(t);
    }
    if (Array.isArray(saved.gateRegimes)) {
      for (const [path, regime] of saved.gateRegimes) gateRegimes.set(path, regime);
    }
    if (Array.isArray(saved.gatePrefixes)) {
      for (const [path, prefixes] of saved.gatePrefixes) {
        if (Array.isArray(prefixes)) gatePrefixes.set(path, prefixes);
      }
    }
    return true;
  }

  return {
    config: watchConfig,
    options,
    exportState,
    importState,
    ingest,
    inventory,
    knownPaths,
    proveRule,
    setRules,
    unusual,
    mute,
    notificationStates,
    series,
    setMeta,
    status,
    tick,
    unmute,
    hasPath: (path) => paths.has(path),
    paths: () => [...paths.keys()],
    stats: () => ({ ...counters, byDetector: { ...counters.byDetector } })
  };
}

module.exports = {
  DEFAULT_EXCLUDE,
  SENSITIVITY,
  compileGlob,
  createWatchEngine,
  detectorOptions,
  normalizeWatchConfig
};
