'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compileGlob, createWatchEngine, normalizeWatchConfig } = require('../lib/watch/engine.cjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse('2026-06-01T08:00:00Z');

/** Deterministic noise in [-1, 1], so every run sees the same "sensor". */
function noise(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

/**
 * Drive the engine like the plugin does: samples every `stepMs`, a tick every
 * five seconds. `sample(t)` returns `[path, value, source?]` tuples.
 */
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

describe('watch engine: continuous values', () => {
  it('learns a steady temperature and reports a sustained jump, in °C, with its size', () => {
    const engine = newEngine();
    const rand = noise(7);
    const path = 'propulsion.main.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 353.15 + 0.2 * rand()]]);
    assert.deepEqual(detectors(engine), []);

    t = run(engine, t, t + 60 * SECOND, SECOND, () => [[path, 363.15 + 0.2 * rand()]]);
    const findings = engine.status().activeFindings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detector, 'shift');
    assert.equal(findings[0].severity, 'alert');
    assert.match(findings[0].title, /Main engine temperature unusually high/);
    assert.match(findings[0].message, /°C/);
    assert.match(findings[0].message, /usual 80\.\d °C/);

    const notification = engine.notificationStates().get(path);
    assert.equal(notification.state, 'alert');

    const incidents = engine.status().incidents;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].status, 'active');
  });

  it('does not report noise, and does not report before it has learned', () => {
    const engine = newEngine();
    const rand = noise(3);
    // A big swing in the first minutes is learning material, not an incident.
    run(engine, T0, T0 + 5 * MINUTE, SECOND, (t) => [['electrical.batteries.house.voltage', t < T0 + 2 * MINUTE ? 12.4 : 13.6]]);
    assert.deepEqual(detectors(engine), []);
    run(engine, T0 + 5 * MINUTE, T0 + 90 * MINUTE, SECOND, () => [['electrical.batteries.house.voltage', 13.6 + 0.04 * rand()]]);
    assert.deepEqual(detectors(engine), []);
  });

  it('catches a slow ramp the baseline cannot follow', () => {
    const engine = newEngine();
    const rand = noise(11);
    const path = 'electrical.batteries.house.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 298.15 + 0.1 * rand()]]);
    const start = t;
    // 0.5 °C per minute: a battery heading for thermal trouble.
    t = run(engine, t, t + 20 * MINUTE, SECOND, (now) => [[path, 298.15 + ((now - start) / MINUTE) * 0.5 + 0.1 * rand()]]);
    const shift = engine.status().activeFindings.find((finding) => finding.detector === 'shift');
    assert.ok(shift, 'expected a shift finding for the ramp');
    assert.match(shift.message, /changing \+0\.\d °C\/min/);
  });

  it('treats a counter that only climbs as a counter', () => {
    const engine = newEngine();
    run(engine, T0, T0 + 60 * MINUTE, SECOND, (t) => [['electrical.solar.main.energy', 1e6 + (t - T0) * 5]]);
    assert.deepEqual(detectors(engine), []);
  });

  it('unwraps an angle that crosses north', () => {
    const engine = newEngine();
    const rand = noise(5);
    run(engine, T0, T0 + 60 * MINUTE, SECOND, () => {
      const value = 0.01 * rand();
      return [['sensors.mast.yaw', value < 0 ? value + 2 * Math.PI : value]];
    });
    assert.deepEqual(detectors(engine), []);
  });

  it('flags a lively sensor that freezes', () => {
    const engine = newEngine();
    const rand = noise(9);
    const path = 'environment.inside.engineRoom.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 310 + 0.3 * rand()]]);
    t = run(engine, t, t + 6 * MINUTE, SECOND, () => [[path, 310.123]]);
    assert.ok(detectors(engine).includes(`frozen:${path}`));
    run(engine, t, t + 10 * SECOND, SECOND, () => [[path, 310 + 0.3 * rand()]]);
    assert.ok(!detectors(engine).includes(`frozen:${path}`));
  });
});

describe('watch engine: timing', () => {
  it('reports a dropout and clears it when the path resumes', () => {
    const engine = newEngine();
    const rand = noise(2);
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [
      ['electrical.batteries.house.voltage', 12.8 + 0.02 * rand(), 'can0.12'],
      ['environment.inside.temperature', 293 + 0.1 * rand()],
      ['environment.outside.pressure', 101300 + 5 * rand()],
      ['tanks.fuel.main.currentLevel', 0.6],
      ['electrical.batteries.start.voltage', 12.6 + 0.02 * rand()]
    ]);
    t = run(engine, t, t + 60 * SECOND, SECOND, () => [
      ['environment.inside.temperature', 293 + 0.1 * rand()],
      ['environment.outside.pressure', 101300 + 5 * rand()],
      ['tanks.fuel.main.currentLevel', 0.6],
      ['electrical.batteries.start.voltage', 12.6 + 0.02 * rand()]
    ]);
    const dropout = engine.status().activeFindings.find((finding) => finding.detector === 'dropout');
    assert.ok(dropout);
    assert.equal(dropout.path, 'electrical.batteries.house.voltage');
    assert.match(dropout.message, /source can0\.12/);

    run(engine, t, t + 3 * SECOND, SECOND, () => [['electrical.batteries.house.voltage', 12.8]]);
    assert.ok(!detectors(engine).some((key) => key.startsWith('dropout:')));
  });

  it('reports a whole feed going quiet as one finding, not one per path', () => {
    const engine = newEngine();
    const names = Array.from({ length: 10 }, (_, index) => `environment.sensor${index}.temperature`);
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => names.map((name) => [name, 290, 'gateway']));
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => []);
    const active = detectors(engine);
    assert.deepEqual(active, ['feed:feed']);
    assert.equal(engine.notificationStates().get('dataFeed').state, 'alert');
    run(engine, t, t + 2 * SECOND, SECOND, () => names.map((name) => [name, 290, 'gateway']));
    assert.deepEqual(detectors(engine), []);
  });

  it('re-learns instead of alerting when the engine starts', () => {
    const engine = newEngine();
    const rand = noise(4);
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [
      ['propulsion.main.revolutions', 0],
      ['propulsion.main.temperature', 288 + 0.1 * rand()],
      ['electrical.batteries.house.voltage', 12.6 + 0.02 * rand()]
    ]);
    const start = t;
    run(engine, t, t + 30 * MINUTE, SECOND, (now) => [
      ['propulsion.main.revolutions', 25 + rand()],
      ['propulsion.main.temperature', Math.min(353, 288 + ((now - start) / MINUTE) * 8) + 0.1 * rand()],
      ['electrical.batteries.house.voltage', 14.2 + 0.02 * rand()]
    ]);
    assert.deepEqual(detectors(engine), []);
    const change = engine.status().regimeChanges[0];
    assert.equal(change.label, 'Engine main running');
    assert.ok(change.affected >= 3);
  });
});

describe('watch engine: discrete values', () => {
  it('reports a value the path has never taken', () => {
    const engine = newEngine();
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, (now) => [
      ['electrical.inverters.main.inverterMode', Math.floor((now - T0) / (5 * MINUTE)) % 2 ? 'inverting' : 'standby']
    ]);
    assert.deepEqual(detectors(engine), []);
    run(engine, t, t + 5 * SECOND, SECOND, () => [['electrical.inverters.main.inverterMode', 'fault']]);
    const finding = engine.status().activeFindings[0];
    assert.equal(finding.detector, 'newState');
    assert.match(finding.title, /changed to "fault"/);
  });

  it('reports a pump cycling far more often than it normally does', () => {
    const engine = newEngine();
    const path = 'electrical.switches.bilgePump.state';
    // Eight hours with a 2-minute run every 4 hours.
    let t = run(engine, T0, T0 + 8 * 60 * MINUTE, 10 * SECOND, (now) => {
      const phase = (now - T0) % (4 * 60 * MINUTE);
      return [[path, phase < 2 * MINUTE ? 1 : 0]];
    });
    assert.deepEqual(detectors(engine), []);
    // Then every five minutes.
    const start = t;
    run(engine, t, t + 60 * MINUTE, 10 * SECOND, (now) => [[path, (now - start) % (5 * MINUTE) < MINUTE ? 1 : 0]]);
    assert.ok(detectors(engine).includes(`cycling:${path}`));
  });
});

describe('watch engine: forecasts', () => {
  it('warns hours before the fresh water tank runs dry', () => {
    const engine = newEngine();
    const path = 'tanks.freshWater.main.currentLevel';
    // Falling 15% per hour from 60%: about 3.3 h to the 10% limit.
    let t = run(engine, T0, T0 + 50 * MINUTE, 10 * SECOND, (now) => [[path, 0.6 - ((now - T0) / (60 * MINUTE)) * 0.15]]);
    t = run(engine, t, t + 30 * MINUTE, 10 * SECOND, (now) => [[path, 0.6 - ((now - T0) / (60 * MINUTE)) * 0.15]]);
    const forecast = engine.status().activeFindings.find((finding) => finding.detector === 'forecast');
    assert.ok(forecast, 'expected a depletion forecast');
    assert.match(forecast.message, /reaches the low limit \(10 %\) in about \d/);
  });

  it('forecasts against the zones in the path metadata', () => {
    const engine = newEngine();
    const path = 'propulsion.main.oilPressure';
    let t = run(engine, T0, T0 + 1000, 1000, () => [[path, 400000]]);
    engine.setMeta(path, { units: 'Pa', zones: [{ upper: 150000, state: 'alarm' }] });
    const rand = noise(8);
    t = run(engine, t, T0 + 40 * MINUTE, SECOND, () => [[path, 400000 + 500 * rand()]]);
    const start = t;
    // Falling 10 kPa per minute: alarm zone in 25 min.
    run(engine, t, t + 12 * MINUTE, SECOND, (now) => [[path, 400000 - ((now - start) / MINUTE) * 10000 + 500 * rand()]]);
    const forecast = engine.status().activeFindings.find((finding) => finding.detector === 'forecast');
    assert.ok(forecast, 'expected a zone forecast');
    assert.match(forecast.message, /alarm zone \(1500\.0 hPa\)/);
  });
});

describe('watch engine: GNSS integrity', () => {
  /** A boat steaming north at 6 kn, its log and compass agreeing with its fix. */
  function voyage(position, t) {
    return [
      ['navigation.position', { latitude: position.latitude, longitude: position.longitude }, 'gps.1'],
      ['navigation.headingTrue', 0],
      ['navigation.speedThroughWater', 6 * 0.514444],
      ['navigation.gnss.satellites', 11],
      ['navigation.gnss.horizontalDilution', 0.8]
    ];
  }

  it('stays quiet on a consistent voyage', () => {
    const engine = newEngine();
    run(engine, T0, T0 + 30 * MINUTE, SECOND, (t) =>
      voyage({ latitude: 60 + ((t - T0) / 1000) * (6 * 0.514444) / 111195, longitude: 24 }, t)
    );
    assert.deepEqual(detectors(engine), []);
    assert.equal(engine.status().gnss.status, 'ok');
  });

  it('reports a position jump the vessel cannot have made', () => {
    const engine = newEngine();
    const lat = (t) => 60 + ((t - T0) / 1000) * (6 * 0.514444) / 111195;
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, (now) => voyage({ latitude: lat(now), longitude: 24 }, now));
    t = run(engine, t, t + 3 * SECOND, SECOND, (now) => voyage({ latitude: lat(now), longitude: 24.2 }, now));
    const jump = engine.status().activeFindings.find((finding) => finding.detector === 'gnss.jump');
    assert.ok(jump);
    assert.match(jump.message, /Position jumped \d+\.\d nm/);
    assert.ok(engine.notificationStates().has('gnss'));
  });

  it('reports a fix that walks away from dead reckoning, and escalates with a second indicator', () => {
    const engine = newEngine();
    const lat = (t) => 60 + ((t - T0) / 1000) * (6 * 0.514444) / 111195;
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, (now) => voyage({ latitude: lat(now), longitude: 24 }, now));
    const start = t;
    // A spoofer drags the fix east at 12 kn - smoothly, so no jump.
    t = run(engine, t, t + 5 * MINUTE, SECOND, (now) =>
      voyage({ latitude: lat(now), longitude: 24 + (((now - start) / 1000) * 12 * 0.514444) / (111195 * Math.cos((60 * Math.PI) / 180)) }, now)
    );
    const status = engine.status();
    assert.ok(status.activeFindings.some((finding) => finding.detector === 'gnss.deadReckoning'));
    assert.equal(status.gnss.indicators.deadReckoning, 'active');

    // Now the receivers lose lock as well.
    run(engine, t, t + MINUTE, SECOND, (now) =>
      voyage({ latitude: lat(now), longitude: 24 + (((now - start) / 1000) * 12 * 0.514444) / (111195 * Math.cos((60 * Math.PI) / 180)) }, now).map(
        (entry) => (entry[0] === 'navigation.gnss.satellites' ? [entry[0], 3] : entry)
      )
    );
    const after = engine.status();
    assert.equal(after.gnss.status, 'suspect');
    assert.equal(engine.notificationStates().get('gnss').state, 'alert');
  });
});

describe('watch engine: incidents', () => {
  it('groups related findings into one incident, earliest first, and keeps GNSS apart', () => {
    const engine = newEngine();
    const rand = noise(21);
    const lat = (t) => 60 + ((t - T0) / 1000) * (6 * 0.514444) / 111195;
    const normal = (t) => [
      ['propulsion.main.temperature', 353 + 0.2 * rand()],
      ['electrical.batteries.house.voltage', 13.9 + 0.02 * rand()],
      ['navigation.position', { latitude: lat(t), longitude: 24 }],
      ['navigation.headingTrue', 0],
      ['navigation.speedThroughWater', 6 * 0.514444]
    ];
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, normal);
    // Alternator fails first; the engine overheats a minute later; the fix jumps.
    const failAt = t;
    t = run(engine, t, t + 3 * MINUTE, SECOND, (now) => {
      const values = normal(now).filter(([path]) => path !== 'navigation.position');
      values[1] = ['electrical.batteries.house.voltage', 12.4 + 0.02 * rand()];
      if (now - failAt > MINUTE) values[0] = ['propulsion.main.temperature', 366 + 0.2 * rand()];
      const jump = now - failAt > 2 * MINUTE ? 0.3 : 0;
      return [...values, ['navigation.position', { latitude: lat(now), longitude: 24 + jump }]];
    });
    const incidents = engine.status().incidents.filter((incident) => incident.status === 'active');
    assert.equal(incidents.length, 2);
    const vessel = incidents.find((incident) => !incident.findings[0].detector.startsWith('gnss.'));
    const gnss = incidents.find((incident) => incident.findings[0].detector.startsWith('gnss.'));
    assert.deepEqual(
      vessel.findings.map((finding) => finding.path),
      ['electrical.batteries.house.voltage', 'propulsion.main.temperature']
    );
    assert.equal(vessel.title, 'House battery voltage unusually low (+1 related)');
    assert.ok(gnss.findings.every((finding) => finding.detector.startsWith('gnss.')));
  });

  it('names paths the way an operator would, with units inferred where no metadata exists', () => {
    const { describePath, formatValue } = require('../lib/watch/format.cjs');
    assert.equal(describePath('electrical.batteries.house.voltage'), 'House battery voltage');
    assert.equal(describePath('propulsion.port.oilPressure'), 'Port engine oil pressure');
    assert.equal(describePath('tanks.freshWater.0.currentLevel'), 'Fresh water tank current level');
    assert.equal(describePath('environment.inside.engineRoom.temperature'), 'Engine room temperature');
    assert.equal(describePath('anything.at.all', 'Coolant'), 'Coolant');
    assert.equal(formatValue('electrical.batteries.house.voltage', 12.5), '12.50 V');
    assert.equal(formatValue('propulsion.port.oilPressure', 250000), '2500.0 hPa');
    assert.equal(formatValue('propulsion.port.revolutions', 25), '1500 rpm');
    assert.equal(formatValue('tanks.fuel.0.currentLevel', 0.42), '42.0 %');
  });
});

describe('watch engine: operator controls and persistence', () => {
  it('honours default and operator exclusions', () => {
    const match = compileGlob('navigation.heading*');
    assert.equal(match('navigation.headingTrue'), true);
    assert.equal(match('navigation.headingMagnetic'), true);
    assert.equal(match('navigation.speedOverGround'), false);
    assert.equal(compileGlob('**.runTime')('propulsion.main.runTime'), true);
    assert.equal(compileGlob('steering')('steering.rudderAngle'), true);

    const engine = newEngine({ watchExcludePaths: ['environment.inside'] });
    run(engine, T0, T0 + 10 * SECOND, SECOND, () => [
      ['navigation.headingTrue', 1],
      ['environment.inside.temperature', 290],
      ['environment.outside.temperature', 280]
    ]);
    assert.equal(engine.hasPath('navigation.headingTrue'), false);
    assert.equal(engine.hasPath('environment.inside.temperature'), false);
    assert.equal(engine.hasPath('environment.outside.temperature'), true);
  });

  it('mutes a path until the mute expires', () => {
    const engine = newEngine();
    const rand = noise(12);
    const path = 'environment.water.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 285 + 0.1 * rand()]]);
    engine.mute(path, t + 10 * MINUTE, t);
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => [[path, 295 + 0.1 * rand()]]);
    assert.deepEqual(detectors(engine), []);
    assert.equal(engine.status().mutes.length, 1);
  });

  it('keeps its baseline across a restart, so it is ready at once', () => {
    const engine = newEngine();
    const rand = noise(6);
    const path = 'propulsion.main.temperature';
    const t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 353 + 0.2 * rand()]]);
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));

    const later = t + 10 * MINUTE;
    const restored = createWatchEngine(normalizeWatchConfig({ watchEnabled: true, watchLearningMinutes: 20 }), { now: later });
    assert.equal(restored.importState(saved, later), true);
    // No dropout for the gap the plugin was down...
    restored.tick(later + 5 * SECOND);
    assert.deepEqual(detectors(restored), []);
    // ...and a jump straight after the restart is reported without relearning.
    run(restored, later, later + 60 * SECOND, SECOND, () => [[path, 363 + 0.2 * rand()]]);
    assert.ok(detectors(restored).includes(`shift:${path}`));
  });
});

describe('watch engine: discovery and redundant sources', () => {
  it('feeds the baseline from one source, so two offset sources are not noise', () => {
    const engine = newEngine();
    const rand = noise(31);
    const path = 'environment.water.temperature';
    // Two sounders that read 1.5 °C apart, interleaved.
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [
      [path, 285 + 0.05 * rand(), 'n2k.10'],
      [path, 286.5 + 0.05 * rand(), 'n2k.20']
    ]);
    assert.deepEqual(detectors(engine), []);
    // One of them drifts 3 °C away from the other: the gap, not either value, is news.
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => [
      [path, 285 + 0.05 * rand(), 'n2k.10'],
      [path, 289.5 + 0.05 * rand(), 'n2k.20']
    ]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'disagree');
    assert.ok(finding, 'expected a disagreement finding');
    assert.match(finding.message, /n2k\.10 reads 11\.\d °C, n2k\.20 reads 16\.\d °C: 4\.5 °C apart, where they are usually within 1\.5 °C/);
    assert.ok(!detectors(engine).includes(`shift:${path}`));
  });

  it('compares redundant sources even on paths it does not baseline', () => {
    const engine = newEngine();
    // Two compasses: heading itself is excluded, but their agreement is not.
    let t = run(engine, T0, T0 + 10 * MINUTE, SECOND, (now) => {
      const heading = ((now - T0) / MINUTE) * 0.05;
      return [
        ['navigation.headingMagnetic', heading, 'autopilot'],
        ['navigation.headingMagnetic', heading + 0.01, 'plotter']
      ];
    });
    assert.deepEqual(detectors(engine), []);
    t = run(engine, t, t + 2 * MINUTE, SECOND, (now) => {
      const heading = ((now - T0) / MINUTE) * 0.05;
      return [
        ['navigation.headingMagnetic', heading, 'autopilot'],
        ['navigation.headingMagnetic', heading + 0.35, 'plotter']
      ];
    });
    assert.ok(detectors(engine).includes('disagree:navigation.headingMagnetic'));
  });

  it('reports a failover when the primary source goes quiet', () => {
    const engine = newEngine();
    const path = 'electrical.batteries.house.voltage';
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [
      [path, 13.2, 'bmv'],
      [path, 13.21, 'shunt']
    ]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 13.21, 'shunt']]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'failover');
    assert.ok(finding);
    assert.equal(finding.message, 'bmv went quiet; now reading shunt');
    assert.ok(!detectors(engine).includes(`dropout:${path}`), 'the path kept updating, so it is not a dropout');
  });

  it('lists what it found and which checks this vessel supports', () => {
    const engine = newEngine();
    run(engine, T0, T0 + 2 * MINUTE, SECOND, () => [
      ['propulsion.main.revolutions', 0],
      ['electrical.batteries.house.voltage', 13.2],
      ['tanks.fuel.0.currentLevel', 0.5],
      ['navigation.headingTrue', 1, 'compass'],
      ['navigation.position', { latitude: 60, longitude: 24 }, 'gps']
    ]);
    const inventory = engine.inventory(T0 + 2 * MINUTE);
    assert.equal(inventory.totals.watched, 3);
    const heading = inventory.paths.find((row) => row.path === 'navigation.headingTrue');
    assert.equal(heading.role, 'gnss-input');
    assert.equal(heading.excludedBy, 'navigation.heading*');
    const capability = (id) => inventory.capabilities.find((item) => item.id === id);
    assert.equal(capability('gnss-position').available, true);
    assert.equal(capability('gnss-dead-reckoning').available, false);
    assert.match(capability('gnss-dead-reckoning').detail, /needs navigation\.speedThroughWater/);
    assert.equal(capability('regimes').available, true);
    assert.match(capability('forecasts').detail, /1 tank or battery level/);
    assert.deepEqual(
      inventory.branches.map((branch) => branch.branch),
      ['electrical', 'navigation', 'propulsion', 'tanks']
    );
  });
});

describe('watch engine: operating states', () => {
  it('judges a restarted engine against how it normally runs, not against its warm-up', () => {
    const engine = newEngine();
    const rand = noise(41);
    const temp = 'propulsion.main.temperature';
    const running = (value) => () => [
      ['propulsion.main.revolutions', 30 + 0.2 * rand()],
      [temp, value + 0.2 * rand()]
    ];
    const stopped = (value) => () => [
      ['propulsion.main.revolutions', 0],
      [temp, value + 0.2 * rand()]
    ];
    // Learn the stopped engine, then a running engine at 80 °C, then stop again.
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, stopped(290));
    t = run(engine, t, t + 40 * MINUTE, SECOND, running(353));
    t = run(engine, t, t + 30 * MINUTE, SECOND, stopped(300));
    assert.deepEqual(detectors(engine), []);
    // Restart: it settles 10 °C hotter than it normally runs.
    t = run(engine, t, t + 18 * MINUTE, SECOND, running(363));
    const change = engine.status().regimeChanges[0];
    assert.equal(change.label, 'Engine main running');
    assert.ok(change.restored >= 1, 'the running baseline should be restored');
    const shift = engine.status().activeFindings.find((finding) => finding.path === temp);
    assert.ok(shift, 'expected the hot restart to be reported once it settled');
    assert.match(shift.message, /usual (?:79\.9|80\.\d) °C/);
  });

  it('ranks what is most unusual right now, below any alarm threshold', () => {
    const engine = newEngine();
    const rand = noise(43);
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [
      ['environment.inside.temperature', 293 + 0.5 * rand()],
      ['electrical.batteries.house.voltage', 13.2 + 0.05 * rand()],
      ['tanks.fuel.0.currentLevel', 0.5]
    ]);
    t = run(engine, t, t + MINUTE, SECOND, () => [
      ['environment.inside.temperature', 293 + 0.5 * rand()],
      // Below the warn threshold, but the most unusual thing aboard.
      ['electrical.batteries.house.voltage', 13.2 - 0.17 + 0.05 * rand()],
      ['tanks.fuel.0.currentLevel', 0.5]
    ]);
    assert.deepEqual(detectors(engine), []);
    const { rows } = engine.unusual(t);
    assert.equal(rows[0].path, 'electrical.batteries.house.voltage');
    assert.match(rows[0].title, /House battery voltage somewhat low/);
  });
});

describe('watch engine: feedback and the watch report', () => {
  it('needs a bigger departure on a path the operator keeps dismissing, and recovers with "useful"', () => {
    const engine = newEngine();
    const rand = noise(51);
    const path = 'environment.inside.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 293 + 0.1 * rand()]]);
    // A departure of about 7 noise floors: reported at normal sensitivity.
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 295.1 + 0.1 * rand()]]);
    assert.ok(detectors(engine).includes(`shift:${path}`));

    // Dismissed three times: the same departure no longer interrupts.
    engine.giveFeedback(path, false, t);
    engine.giveFeedback(path, false, t);
    const { factor } = engine.giveFeedback(path, false, t);
    assert.equal(factor, 1.75);
    t = run(engine, t, t + 5 * MINUTE, SECOND, () => [[path, 293 + 0.1 * rand()]]);
    assert.ok(!detectors(engine).includes(`shift:${path}`), 'recovered');
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => [[path, 295.1 + 0.1 * rand()]]);
    assert.ok(!detectors(engine).includes(`shift:${path}`), 'the same departure no longer interrupts');
    assert.equal(engine.status(t).lessSensitive[0].path, path);
    assert.equal(engine.inventory(t).paths.find((row) => row.path === path).lessSensitive, 1.75);

    // Marked useful again, and a fortnight later most of it has worn off anyway.
    assert.equal(engine.giveFeedback(path, true, t).factor, 1.5);
    assert.equal(engine.giveFeedback(path, true, t + 14 * 24 * 60 * MINUTE).factor, 1);
  });

  it('counts a mute of something that just fired as a dismissal', () => {
    const engine = newEngine();
    const rand = noise(52);
    const path = 'environment.water.temperature';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 285 + 0.1 * rand()]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 290 + 0.1 * rand()]]);
    engine.mute(path, t + 60 * MINUTE, t);
    assert.equal(engine.status(t).lessSensitive[0].factor, 1.25);
  });

  it('writes a plain report of the last day', () => {
    const engine = newEngine();
    const rand = noise(53);
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [
      ['propulsion.main.revolutions', 0],
      ['electrical.batteries.house.voltage', 12.8 + 0.02 * rand()],
      ['environment.inside.engineRoom.temperature', 300 + 0.2 * rand()]
    ]);
    // The voltage sags for ten minutes and recovers; the engine-room sensor drops out for good.
    t = run(engine, t, t + 10 * MINUTE, SECOND, () => [
      ['propulsion.main.revolutions', 0],
      ['electrical.batteries.house.voltage', 12.2 + 0.02 * rand()]
    ]);
    t = run(engine, t, t + 70 * MINUTE, SECOND, () => [
      ['propulsion.main.revolutions', 0],
      ['electrical.batteries.house.voltage', 12.8 + 0.02 * rand()]
    ]);
    const result = engine.report(t, 24);
    assert.equal(result.hours, 24);
    assert.ok(result.findings >= 2);
    const text = result.lines.join('\n');
    assert.match(text, /^\d+ incidents? \(/);
    assert.match(text, /Still active: Engine room temperature stopped updating/);
    assert.match(text, /Longest: /);
    assert.match(text, /Sensors and data: Engine room temperature stopped updating/);
  });

  it('keeps feedback and the finding log across a restart', () => {
    const engine = newEngine();
    engine.ingest('environment.inside.temperature', 293, T0);
    engine.giveFeedback('environment.inside.temperature', false, T0);
    const saved = JSON.parse(JSON.stringify(engine.exportState(T0)));
    const restored = createWatchEngine(normalizeWatchConfig({ watchEnabled: true }), { now: T0 });
    restored.importState(saved, T0 + MINUTE);
    assert.equal(restored.status(T0 + MINUTE).lessSensitive[0].path, 'environment.inside.temperature');
  });
});

describe('watch engine: review fixes', () => {
  it('learns the usual gap per source pair, so one offset sensor cannot hide another fault', () => {
    const engine = newEngine();
    const rand = noise(61);
    const path = 'electrical.batteries.house.voltage';
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [
      [path, 12.5 + 0.01 * rand(), 'a'],
      [path, 12.5 + 0.01 * rand(), 'b'],
      [path, 13.5 + 0.01 * rand(), 'c']
    ]);
    assert.deepEqual(detectors(engine), []);
    t = run(engine, t, t + 2 * MINUTE, SECOND, () => [
      [path, 12.5 + 0.01 * rand(), 'a'],
      [path, 13.5 + 0.01 * rand(), 'b'],
      [path, 13.5 + 0.01 * rand(), 'c']
    ]);
    const finding = engine.status().activeFindings.find((item) => item.detector === 'disagree');
    assert.ok(finding, 'b drifting a volt off must be reported despite c being a volt off by design');
    assert.match(finding.message, /^a reads 12\.\d+ V, b reads 13\.\d+ V/);
  });

  it('does not take one big step for the sensor resolution', () => {
    const engine = newEngine();
    const path = 'tanks.freshWater.0.currentLevel';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 0.8]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 0.2]]);
    assert.ok(detectors(engine).includes(`shift:${path}`), 'a 60-point drop must not hide behind a learned "resolution"');
  });

  it('does not take a still value that then jumps up for a counter', () => {
    const engine = newEngine();
    const path = 'electrical.batteries.house.voltage';
    let t = run(engine, T0, T0 + SECOND, SECOND, () => [[path, 12.4]]);
    t = run(engine, t, T0 + 40 * MINUTE, SECOND, () => [[path, 12.5]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 15.5]]);
    assert.ok(detectors(engine).includes(`shift:${path}`));
  });

  it('keeps counting a switch that cycles faster than the evidence list once held', () => {
    const engine = newEngine();
    const path = 'electrical.switches.pump.state';
    let t = run(engine, T0, T0 + 6 * 60 * MINUTE, 10 * SECOND, () => [[path, 0]]);
    // Ten minutes of a transition every second.
    t = run(engine, t, t + 10 * MINUTE, SECOND, (now) => [[path, Math.floor(now / SECOND) % 2]]);
    assert.ok(detectors(engine).includes(`cycling:${path}`));
    t = run(engine, t, t + 30 * MINUTE, SECOND, (now) => [[path, Math.floor(now / SECOND) % 2]]);
    assert.ok(detectors(engine).includes(`cycling:${path}`), 'still cycling, still reported');
  });

  it('reports a GNSS feed that stops, and does not call a stopped boat a frozen fix', () => {
    const engine = newEngine();
    const knots = 0.514444;
    let speed = 6 * knots;
    let lat = 60;
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, () => {
      lat += speed / 111195;
      return [
        ['navigation.position', { latitude: lat, longitude: 24 }, 'gps'],
        ['navigation.headingTrue', 0],
        ['navigation.speedThroughWater', speed]
      ];
    });
    // Slow to a stop: the fix stops moving because the boat did.
    speed = 0;
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => [
      ['navigation.position', { latitude: lat, longitude: 24 }, 'gps'],
      ['navigation.headingTrue', 0],
      ['navigation.speedThroughWater', 0]
    ]);
    assert.ok(!detectors(engine).includes('gnss.frozen:navigation.position'));
    // The receiver goes silent.
    t = run(engine, t, t + MINUTE, SECOND, () => [['navigation.headingTrue', 0]]);
    assert.ok(detectors(engine).includes('gnss.lost:navigation.position'));
    assert.equal(engine.status(t).gnss.status, 'lost');
  });
});

describe('watch engine: review follow-ups', () => {
  const monitor = require('../lib/watch/path-monitor.cjs');
  const sourcesModule = require('../lib/watch/sources.cjs');

  it('does not take a voltage climbing on every update for a counter', () => {
    const engine = newEngine();
    const path = 'electrical.batteries.house.voltage';
    const rand = noise(71);
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 13.2 + 0.01 * rand()]]);
    // Then it climbs a little on every single update: never down, always up.
    let value = 13.2;
    t = run(engine, t, t + 10 * MINUTE, SECOND, () => {
      value += 0.002;
      return [[path, value]];
    });
    assert.ok(detectors(engine).includes(`shift:${path}`), 'a runaway voltage must not be excused as a counter');
  });

  it('counts the last hour to the minute, never reaching past it', () => {
    const t = T0 + 10 * 60 * MINUTE;
    const state = monitor.createPathState('electrical.switches.pump.state', T0);
    state.kind = 'discrete';
    state.firstAt = T0;
    // 9 transitions in the minute that started 61 minutes ago; 2 inside the hour.
    const outside = Math.floor((t - 61 * MINUTE) / MINUTE) * MINUTE;
    const inside = Math.floor((t - 10 * MINUTE) / MINUTE) * MINUTE;
    state.transitionMinutes = [[outside, 9], [inside, 2]];
    state.transitionTotal = 11;
    const cond = monitor.evaluateCycling(state, t, { cyclingLearningMs: 6 * 60 * MINUTE, cyclingMinPerHour: 4 });
    assert.equal(cond.evidence.lastHour, 2);
  });

  it('does not report a frozen fix across a gap in the feed', () => {
    const engine = newEngine();
    const knots = 0.514444;
    const fix = { latitude: 60, longitude: 24 };
    // A few identical fixes while the log reads speed start a candidate...
    let t = run(engine, T0, T0 + 3 * SECOND, SECOND, () => [
      ['navigation.position', fix, 'gps'],
      ['navigation.speedThroughWater', 6 * knots]
    ]);
    // ...then the position feed stops and the boat slows to a stop.
    t = run(engine, t, t + 5 * MINUTE, SECOND, () => [['navigation.speedThroughWater', 0]]);
    // Later both resume, at speed, with the old fix repeated.
    t = run(engine, t, t + 10 * SECOND, SECOND, () => [
      ['navigation.position', fix, 'gps'],
      ['navigation.speedThroughWater', 6 * knots]
    ]);
    assert.ok(!detectors(engine).includes('gnss.frozen:navigation.position'));
  });

  it('makes room for the current primary when the pair table is full of former primaries', () => {
    const state = sourcesModule.createSourceState();
    for (let index = 0; index < 16; index += 1) {
      state.pairs[`old${index}|x`] = { primary: `old${index}`, secondary: 'x', mean: 0, variance: 0, n: 40, last: { at: index } };
    }
    const options = { intervalMean: 1000, angle: false, scaleOf: () => 0.1, zClear: 3 };
    sourcesModule.routeSample(state, 'a', 1, 1000, options);
    sourcesModule.routeSample(state, 'b', 1.05, 1100, options);
    assert.ok(state.pairs['a|b'], 'the current pair must be learned');
    assert.equal(Object.keys(state.pairs).length, 16);
    assert.equal(state.pairs['old0|x'], undefined, 'the least recently compared former pair goes first');
  });
});
