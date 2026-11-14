'use strict';

// Detection and replay fixes from the CodeRabbit full review: feed mutes, the
// learned update interval across outages, the signed offset between two
// sources, and replay's row limit and ticks through gaps in the history.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createWatchEngine, normalizeWatchConfig } = require('../lib/watch/engine.cjs');
const monitor = require('../lib/watch/path-monitor.cjs');
const { createWatchService } = require('../lib/watch-service.cjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-06-01T08:00:00Z');

function noise(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

/** Samples every `stepMs`, a tick every five seconds, as the plugin does. */
function run(engine, from, to, stepMs, sample) {
  let nextTick = from;
  for (let t = from; t < to; t += stepMs) {
    for (const [path, value, source] of sample(t)) {
      engine.ingest(path, value, t, source);
    }
    if (t >= nextTick) {
      engine.tick(t);
      nextTick = t + 5 * SECOND;
    }
  }
  engine.tick(to);
  return to;
}

function newEngine(overrides = {}) {
  return createWatchEngine(normalizeWatchConfig({ watchEnabled: true, watchLearningMinutes: 20, ...overrides }), { now: T0 });
}

function detectors(engine) {
  return engine.status().activeFindings.map((finding) => `${finding.detector}:${finding.path}`);
}

describe('watch detection: feed mutes', () => {
  it('applies a mute of the feed finding to the feed-silent condition', () => {
    const engine = newEngine();
    const names = Array.from({ length: 10 }, (_, index) => `environment.sensor${index}.temperature`);
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => names.map((name) => [name, 290.15, 'gateway']));
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => []);
    assert.deepEqual(detectors(engine), ['feed:feed']);

    // Muting the open finding clears it and its notification...
    engine.mute('feed', t + HOUR, t);
    t = run(engine, t, t + 10 * SECOND, SECOND, () => []);
    assert.deepEqual(detectors(engine), [], 'a muted feed finding must not stay active');
    assert.notEqual(engine.notificationStates().get('dataFeed')?.state, 'alert');

    // ...a new silence while muted is not reported, and its paths' dropouts
    // stay folded into the muted fact.
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => names.map((name) => [name, 290.15, 'gateway']));
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => []);
    assert.deepEqual(detectors(engine), []);

    // Once unmuted, it is reported again.
    engine.unmute('feed', t);
    run(engine, t, t + 10 * SECOND, SECOND, () => []);
    assert.deepEqual(detectors(engine), ['feed:feed']);
  });
});

describe('watch detection: the feed and muted paths', () => {
  it('does not report a feed made silent only by paths that are muted', () => {
    const engine = newEngine();
    const muted = Array.from({ length: 6 }, (_, index) => `environment.sensor${index}.temperature`);
    const live = Array.from({ length: 4 }, (_, index) => `electrical.batteries.bank${index}.voltage`);
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [...muted.map((name) => [name, 290.15]), ...live.map((name) => [name, 12.8])]);
    engine.mute('environment.*', t + HOUR, t);
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => live.map((name) => [name, 12.8]));
    assert.deepEqual(detectors(engine), [], 'the muted paths went quiet; the rest of the feed is fine');
    // The unmuted paths going quiet too is a silent feed.
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => []);
    assert.deepEqual(detectors(engine), ['feed:feed']);
  });
});

describe('watch detection: the learned update interval', () => {
  it('reports a second outage after a one-hour outage of a 30 s sensor', () => {
    const engine = newEngine();
    const rand = noise(5);
    const path = 'electrical.batteries.house.voltage';
    const sample = () => [[path, 12.8 + 0.02 * rand()]];
    let t = run(engine, T0, T0 + 40 * MINUTE, 30 * SECOND, sample);
    t = run(engine, t, t + HOUR, SECOND, () => []);
    assert.ok(detectors(engine).includes(`dropout:${path}`), 'the first outage is reported');
    t = run(engine, t, t + 5 * MINUTE, 30 * SECOND, sample);
    assert.ok(!detectors(engine).includes(`dropout:${path}`), 'and clears when the sensor is back');
    t = run(engine, t, t + 10 * MINUTE, SECOND, () => []);
    assert.ok(detectors(engine).includes(`dropout:${path}`), 'the second outage must be reported too');
  });

  it('keeps the usual interval regular across outages, and learns a steady slower rate', () => {
    const options = { minIntervalMs: 1000, dropoutMinMs: 30000, dropoutFactor: 10 };
    const state = monitor.createPathState('electrical.batteries.house.voltage', T0);
    let t = T0;
    const feed = (count, gapMs) => {
      for (let index = 0; index < count; index += 1) {
        t += gapMs;
        monitor.observe(state, 12.8 + 0.001 * (index % 3), t, options);
      }
    };
    feed(60, 30 * SECOND);
    assert.ok(Math.abs(state.intervalMean - 30 * SECOND) < 1, 'learns 30 s');
    // Outages of different lengths, each followed by 15 minutes of regular
    // updates: an outage moves the interval at most to the dropout limit's
    // tenth, so it stays regular (under a minute) and comes back.
    for (const outage of [HOUR, 10 * MINUTE, 25 * MINUTE]) {
      feed(1, outage);
      assert.ok(state.intervalMean < MINUTE, `a ${outage / MINUTE} min outage left ${state.intervalMean} ms`);
      feed(30, 30 * SECOND);
      assert.ok(state.intervalMean < 33 * SECOND, `back to about 30 s after a ${outage / MINUTE} min outage`);
    }
    // A steady slower rate is learned.
    feed(40, 6 * MINUTE);
    assert.ok(Math.abs(state.intervalMean - 6 * MINUTE) < 0.1 * 6 * MINUTE, `learned ${state.intervalMean} ms`);
  });

  it('does not report every quiet night of a sender that reports on change', () => {
    const engine = newEngine();
    const path = 'environment.inside.temperature';
    let seed = 1;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    const times = [];
    for (let at = T0; at < T0 + 3 * 24 * HOUR; ) {
      const hour = new Date(at).getUTCHours();
      at += hour >= 8 && hour < 20 ? 10 * SECOND : Math.round((2 + 38 * random()) * MINUTE);
      times.push(at);
    }
    let index = 0;
    for (let t = T0; t <= times[times.length - 1]; t += 5 * SECOND) {
      while (index < times.length && times[index] <= t) {
        engine.ingest(path, 293 + 0.5 * Math.sin(times[index] / 600000) + (index % 5) * 0.01, times[index]);
        index += 1;
      }
      engine.tick(t);
    }
    const opened = engine.stats().byDetector.dropout || 0;
    // Three nights of 2-40 minute gaps: about one dropout per night as it
    // goes quiet, not one per gap (64 when long gaps were left out).
    assert.ok(opened <= 12, `${opened} dropouts`);
  });

  it('learns a genuine slow-down from a steady run of long gaps', () => {
    const engine = newEngine();
    const rand = noise(9);
    const path = 'electrical.batteries.house.voltage';
    const sample = () => [[path, 12.8 + 0.02 * rand()]];
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, sample);
    // The sender now reports every 40 s: the first gaps are dropouts, eight in
    // a row of one size are its new rate, after which 40 s is not a dropout.
    t = run(engine, t, t + 8 * 40 * SECOND, 40 * SECOND, sample);
    t = run(engine, t, t + 10 * MINUTE, 40 * SECOND, sample);
    for (let index = 0; index < 7; index += 1) {
      t = run(engine, t, t + 35 * SECOND, SECOND, () => []);
      assert.ok(!detectors(engine).includes(`dropout:${path}`), '40 s is the path\'s rate now');
      t = run(engine, t, t + 5 * SECOND, 5 * SECOND, sample);
    }
  });
});

describe('watch detection: the signed offset between two sources', () => {
  const path = 'electrical.batteries.house.voltage';

  it('reports a source moving from a volt above the other to a volt below it', () => {
    const engine = newEngine();
    const rand = noise(61);
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [
      [path, 12.5 + 0.01 * rand(), 'a'],
      [path, 13.5 + 0.01 * rand(), 'b']
    ]);
    assert.deepEqual(detectors(engine), []);
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => [
      [path, 12.5 + 0.01 * rand(), 'a'],
      [path, 11.5 + 0.01 * rand(), 'b']
    ]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'disagree');
    assert.ok(finding, 'b reading a volt low instead of a volt high is a disagreement');
    assert.match(finding.message, /^a reads 12\.\d+ V, b reads 11\.\d+ V: 1\.\d+ V apart, where b usually reads 1\.\d+ V above a/);
  });

  it('still learns a constant offset as normal, on either side', () => {
    const engine = newEngine();
    const rand = noise(62);
    run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [
      [path, 12.5 + 0.01 * rand(), 'a'],
      [path, 11.5 + 0.01 * rand(), 'b'],
      [path, 13.5 + 0.01 * rand(), 'c']
    ]);
    assert.deepEqual(detectors(engine), []);
  });

  it('learns again from a saved pair that holds the mean of |difference|', () => {
    const engine = newEngine();
    const rand = noise(63);
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, () => [
      [path, 12.5 + 0.01 * rand(), 'a'],
      [path, 11.5 + 0.01 * rand(), 'b']
    ]);
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const item = saved.paths.find((entry) => entry.path === path);
    const pair = item.sources.pairs['a|b'];
    assert.equal(pair.signed, true);
    assert.ok(pair.mean < -0.9, 'the offset is learned with its sign');
    // What an older version wrote: the mean gap without its side.
    delete pair.signed;
    pair.mean = 1;
    const restored = createWatchEngine(normalizeWatchConfig({ watchEnabled: true, watchLearningMinutes: 20 }), { now: t });
    assert.equal(restored.importState(saved, t), true);
    const migrated = restored.exportState(t).paths.find((entry) => entry.path === path).sources.pairs['a|b'];
    assert.equal(migrated.signed, true);
    assert.equal(migrated.n, 0, 'an unsigned mean is not taken for an offset');
    // Read as +1 V, the restored pair would call the usual -1 V a disagreement.
    t = run(restored, t, t + 3 * MINUTE, SECOND, () => [
      [path, 12.5 + 0.01 * rand(), 'a'],
      [path, 11.5 + 0.01 * rand(), 'b']
    ]);
    assert.deepEqual(detectors(restored), []);
  });
});

function createHost() {
  return {
    selfId: 'vessels.urn:mrn:signalk:uuid:test',
    subscriptionmanager: { subscribe() {} },
    handleMessage() {},
    getSelfPath() {
      return undefined;
    },
    setPluginStatus() {}
  };
}

function historyFetch(paths, rowsFor) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes('/history/paths')) {
      return new Response(JSON.stringify(paths), { status: 200 });
    }
    return new Response(JSON.stringify({ values: paths.map((path) => ({ path, method: 'average' })), data: rowsFor() }), { status: 200 });
  };
  return { fetchImpl, requests };
}

describe('watch detection: replay', () => {
  it('enforces the row limit on a provider that ignores the resolution, and says so', async () => {
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - 24 * HOUR;
    const { fetchImpl, requests } = historyFetch(['propulsion.main.temperature'], () => {
      const data = [];
      // One-second rows, though ten-second ones were asked for.
      for (let at = start; at <= end; at += SECOND) {
        data.push([new Date(at).toISOString(), 353.15 + ((at / 1000) % 3) * 0.05]);
      }
      return data;
    });
    const service = createWatchService(createHost(), { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    try {
      const result = await service.replay({ duration: 'PT24H' }, { historyTimeoutMs: 5000 });
      assert.equal(result.ok, true);
      assert.equal(result.resolutionSeconds, 10);
      assert.ok(requests.some((url) => /resolution=10/.test(decodeURIComponent(url))), 'ten-second rows were asked for');
      // Rows closer than three quarters of the resolution are extra.
      assert.ok(result.rows <= Math.ceil(8640 / 0.75) + 3, `${result.rows} rows held`);
      assert.ok(result.rows >= 8640, 'the whole window is still replayed, at the asked resolution');
      assert.equal(result.truncated, true);
      assert.ok(result.rowsDropped >= 24 * 3600 - Math.ceil(8640 / 0.75) - 3, `${result.rowsDropped} rows reported dropped`);
      assert.match(result.note, /rows more than were asked for/);
    } finally {
      service.stop();
    }
  });

  it('does not read a response body past its byte limit', async () => {
    const end = Date.parse('2026-06-02T08:00:00Z');
    let bodyRead = false;
    const fetchImpl = async (url) => {
      if (url.includes('/history/paths')) return new Response(JSON.stringify(['propulsion.main.temperature']), { status: 200 });
      // A stream that would go on far past the limit; reading stops early.
      let sent = 0;
      const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
      const body = new ReadableStream({
        pull(controller) {
          sent += 1;
          if (sent > 64) {
            bodyRead = true;
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        }
      });
      return new Response(body, { status: 200 });
    };
    const service = createWatchService(createHost(), { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    try {
      const result = await service.replay({ duration: 'PT1H' }, { historyTimeoutMs: 5000 });
      assert.equal(bodyRead, false, 'the read was cancelled before the whole body arrived');
      assert.match(JSON.stringify(result), /larger than 16 MB/);
    } finally {
      service.stop();
    }
  });

  it('reports nothing dropped from a provider that keeps to the resolution', async () => {
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - 6 * HOUR;
    const { fetchImpl } = historyFetch(['propulsion.main.temperature'], () => {
      const data = [];
      for (let at = start; at <= end; at += 10 * SECOND) data.push([new Date(at).toISOString(), 353.15]);
      return data;
    });
    const service = createWatchService(createHost(), { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    try {
      const result = await service.replay({ duration: 'PT6H' }, { historyTimeoutMs: 5000 });
      assert.equal(result.ok, true);
      assert.equal(result.rows, 6 * 360 + 1);
      assert.equal(result.truncated, undefined);
      assert.equal(result.rowsDropped, undefined);
    } finally {
      service.stop();
    }
  });

  const replayWith = async (paths, rowsFor, duration, end) => {
    const { fetchImpl } = historyFetch(paths, rowsFor);
    const service = createWatchService(createHost(), { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    try {
      return await service.replay({ duration }, { historyTimeoutMs: 5000 });
    } finally {
      service.stop();
    }
  };

  it('keeps rows with jitter, clipped edge buckets and newest-first order', async () => {
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - 6 * HOUR;
    const paths = ['propulsion.main.temperature'];
    const value = (at) => 353.15 + ((at / 10000) % 3) * 0.05;
    // Ten-second rows, each up to 50 ms early or late.
    const jittered = [];
    for (let at = start, index = 0; at <= end; at += 10 * SECOND, index += 1) {
      const stamp = at + (index % 2 === 0 ? -50 : 50);
      jittered.push([new Date(stamp).toISOString(), value(at)]);
    }
    const jitterResult = await replayWith(paths, () => jittered, 'PT6H', end);
    assert.equal(jitterResult.ok, true);
    assert.equal(jitterResult.rows, jittered.length, 'no jittered row is extra');
    assert.equal(jitterResult.truncated, undefined);

    // Buckets stamped by their end and clipped at the window: the last row is
    // the window's end, 3 s after the one before it.
    const clipped = [];
    for (let at = start + 10 * SECOND; at < end; at += 10 * SECOND) clipped.push([new Date(at - 3 * SECOND).toISOString(), value(at)]);
    clipped.push([new Date(end).toISOString(), value(end)]);
    const clippedResult = await replayWith(paths, () => clipped, 'PT6H', end);
    assert.equal(clippedResult.rows, clipped.length, 'the newest, clipped bucket is kept');
    assert.equal(clippedResult.truncated, undefined);

    // Newest first: the same rows as oldest first, not a limit's worth of the newest.
    const descending = await replayWith(paths, () => [...jittered].reverse(), 'PT6H', end);
    assert.equal(descending.rows, jittered.length);
    assert.equal(descending.truncated, undefined);
  });

  it('checks dropouts in a week-long replay, and says where nothing was recorded', async () => {
    const end = Date.parse('2026-06-08T08:00:00Z');
    const start = end - 7 * 24 * HOUR;
    const paths = ['environment.sensor0.temperature', 'environment.sensor1.temperature'];
    const quietFrom = start + 3 * 24 * HOUR;
    const offFrom = start + 5 * 24 * HOUR;
    const result = await replayWith(
      paths,
      () => {
        const data = [];
        for (let at = start; at <= end; at += 60 * SECOND) {
          // The server was off for eight hours: nothing at all.
          if (at > offFrom && at < offFrom + 8 * HOUR) continue;
          // One sensor is silent for two hours while the other reports.
          const first = at > quietFrom && at < quietFrom + 2 * HOUR ? null : 290.15 + ((at / 60000) % 3) * 0.05;
          data.push([new Date(at).toISOString(), first, 291.15 + ((at / 60000) % 3) * 0.05]);
        }
        return data;
      },
      'P7D',
      end
    );
    assert.equal(result.ok, true);
    assert.equal(result.resolutionSeconds, 61);
    assert.ok(result.byDetector.dropout >= 1, `a 61 s row interval is still checked: ${JSON.stringify(result.byDetector)}`);
    assert.equal(result.historyGaps.count, 1);
    assert.ok(result.historyGaps.longestSeconds >= 8 * 3600 - 61);
    assert.match(result.note, /Nothing was recorded for any replayed path in 1 gap \(the longest 48\d min\)/);
  });

  it('keeps only the columns asked for, each once', async () => {
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - HOUR;
    const path = 'propulsion.main.temperature';
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.includes('/history/paths')) return new Response(JSON.stringify([path]), { status: 200 });
      // The path asked for, twice, and a thousand others.
      const values = [{ path }, { path }, ...Array.from({ length: 1000 }, (_, index) => ({ path: `environment.other${index}.temperature` }))];
      const data = [];
      for (let at = start; at <= end; at += 10 * SECOND) {
        // The columns not asked for jump for the last ten minutes: read, they would be shifts.
        const wobble = ((at / 10000) % 3) * 0.05;
        const other = at > end - 10 * MINUTE ? 999 : 290.15 + wobble;
        data.push([new Date(at).toISOString(), 353.15 + wobble, 353.15 + wobble, ...Array.from({ length: 1000 }, () => other)]);
      }
      return new Response(JSON.stringify({ values, data }), { status: 200 });
    };
    let ingested = [];
    const service = createWatchService(createHost(), { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    try {
      const result = await service.replay({ duration: 'PT1H', paths: [path] }, { historyTimeoutMs: 5000 });
      assert.equal(result.ok, true);
      assert.equal(result.pathsReplayed, 1);
      // The columns not asked for were not read: no shift to 999.
      assert.equal(result.byDetector.shift, undefined, JSON.stringify(result.byDetector));
      ingested = result.rows;
    } finally {
      service.stop();
    }
    assert.ok(ingested > 300);
  });

  it('reads a path declared twice from its first column only, and no column without a path', async () => {
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - HOUR;
    const path = 'propulsion.main.temperature';
    const replayed = async (values, rowFor) => {
      const fetchImpl = async (url) => {
        if (url.includes('/history/paths')) return new Response(JSON.stringify([path]), { status: 200 });
        const data = [];
        for (let at = start; at <= end; at += 10 * SECOND) data.push([new Date(at).toISOString(), ...rowFor(at)]);
        return new Response(JSON.stringify({ values, data }), { status: 200 });
      };
      const service = createWatchService(createHost(), { now: () => end, fetchImpl });
      service.start({ watchEnabled: true });
      try {
        return await service.replay({ duration: 'PT1H', paths: [path] }, { historyTimeoutMs: 5000 });
      } finally {
        service.stop();
      }
    };
    // Steady for 50 minutes, then 999: read, it is a shift.
    const jumping = (at) => (at > end - 10 * MINUTE ? 999 : 353.15 + ((at / 10000) % 3) * 0.05);
    const control = await replayed([{ path }], (at) => [jumping(at)]);
    assert.ok(control.byDetector.shift >= 1, 'the jump is a shift when read');
    // The first column for the path is empty; the duplicate after it jumps.
    const duplicate = await replayed([{ path }, { path }], (at) => [null, jumping(at)]);
    assert.equal(duplicate.byDetector.shift, undefined, 'the second column for the path is not read');
    // A column that names no path is not taken for the path at its position.
    const unnamed = await replayed([{ method: 'average' }], (at) => [jumping(at)]);
    assert.equal(unnamed.byDetector.shift, undefined, 'a column without a path is not read');
  });

  it('evaluates a feed silence that spans a gap in the history', async () => {
    const end = Date.parse('2026-06-02T08:00:00Z');
    const start = end - 6 * HOUR;
    const gapFrom = start + 3 * HOUR;
    const gapTo = gapFrom + 30 * MINUTE;
    const paths = Array.from({ length: 6 }, (_, index) => `environment.sensor${index}.temperature`);
    const { fetchImpl } = historyFetch(paths, () => {
      const data = [];
      for (let at = start; at <= end; at += 10 * SECOND) {
        // Nothing at all was recorded for half an hour: no rows.
        if (at > gapFrom && at < gapTo) continue;
        data.push([new Date(at).toISOString(), ...paths.map((_, index) => 290.15 + index + ((at / 10000) % 3) * 0.05)]);
      }
      return data;
    });
    const service = createWatchService(createHost(), { now: () => end, fetchImpl });
    service.start({ watchEnabled: true });
    try {
      const result = await service.replay({ duration: 'PT6H' }, { historyTimeoutMs: 5000 });
      assert.equal(result.ok, true);
      assert.equal(result.pathsReplayed, 6);
      assert.equal(result.byDetector.feed, 1, 'the silent half hour is one feed finding');
      assert.equal(result.byDetector.dropout, undefined, 'its paths are not reported one by one');
    } finally {
      service.stop();
    }
  });
});
