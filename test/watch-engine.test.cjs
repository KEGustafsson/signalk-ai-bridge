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
    // Perfectly steady through learning, so it has never gone down: the case
    // the old "rose on a fifth of its updates" rule called a counter.
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 13.2]]);
    // Then it climbs a little on every single update: never down, always up.
    // Twenty minutes of climbing: past the share of rising updates the old
    // rule took for a counter, which then switched the shift check off.
    let value = 13.2;
    t = run(engine, t, t + 20 * MINUTE, SECOND, () => {
      value += 0.002;
      return [[path, value]];
    });
    assert.ok(detectors(engine).includes(`shift:${path}`), 'a runaway voltage must not be excused as a counter');
  });

  it('counts the last hour to the minute, never reaching past it', () => {
    // Half a minute past the minute, so the oldest bucket straddles the hour.
    const t = T0 + 10 * 60 * MINUTE + 30 * SECOND;
    const state = monitor.createPathState('electrical.switches.pump.state', T0);
    state.kind = 'discrete';
    state.firstAt = T0;
    // 9 transitions in the minute that started 60.5 minutes ago; 2 inside the hour.
    const outside = Math.floor((t - 60 * MINUTE) / MINUTE) * MINUTE;
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
    // ...then the whole feed goes quiet for five minutes (no fixes, no log)...
    t = run(engine, t, t + 5 * MINUTE, SECOND, () => []);
    // Later both resume, the log first, at speed, with the old fix repeated:
    // only the gap itself says the old candidate is meaningless.
    t = run(engine, t, t + 10 * SECOND, SECOND, () => [
      ['navigation.speedThroughWater', 6 * knots],
      ['navigation.position', fix, 'gps']
    ]);
    assert.ok(!detectors(engine).includes('gnss.frozen:navigation.position'));
  });

  it('does not count a path as a counter for four flat hours and two climbing ones', () => {
    const engine = newEngine();
    const path = 'plugins.example.reading';
    // Older than six hours by the end, but climbing for only two of them.
    let t = run(engine, T0, T0 + 4 * 60 * MINUTE, 10 * SECOND, () => [[path, 50]]);
    let value = 50;
    t = run(engine, t, t + 2 * 60 * MINUTE + 10 * MINUTE, 10 * SECOND, () => {
      value += 0.05;
      return [[path, value]];
    });
    const state = engine.exportState(t).paths.find((item) => item.path === path);
    assert.equal(monitor.isCounterState(state), false, 'two hours of climbing are not six');
    assert.equal(engine.inventory(t).paths.find((item) => item.path === path).kind, 'continuous');
  });

  it('never guesses a counter from a climb alone, however long', () => {
    const climbing = (path, units) => {
      const state = monitor.createPathState(path, T0);
      // Rises in eight different hours: what the old fallback took for a counter.
      Object.assign(state, { n: 5000, rose: true, monotonic: true, rises: 5000, units, riseHours: [1, 2, 3, 4, 5, 6, 7, 8] });
      return monitor.isCounterState(state);
    };
    assert.equal(climbing('electrical.batteries.house.voltage', 'V'), false);
    assert.equal(climbing('tanks.blackWater.0.currentLevel'), false, 'a level rising for hours is news, with or without units');
    // A voltage under an unknown name and with no units looks like anything.
    assert.equal(climbing('plugins.example.reading'), false);
  });

  it('treats a path the operator listed as a counter as one, and nothing else under that name', () => {
    const engine = newEngine({ watchCounterPaths: ['plugins.example.pulses'] });
    let pulses = 0;
    let t = run(engine, T0, T0 + 40 * MINUTE, 10 * SECOND, () => {
      pulses += 1;
      return [['plugins.example.pulses', pulses], ['plugins.example.reading', 13.2]];
    });
    const kinds = Object.fromEntries(engine.inventory(t).paths.map((item) => [item.path, item.kind]));
    assert.equal(kinds['plugins.example.pulses'], 'counter');
    assert.notEqual(kinds['plugins.example.reading'], 'counter');
    // Saved and restored under settings that no longer list it: not a counter.
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const restarted = newEngine();
    restarted.importState(saved, t);
    t = run(restarted, t, t + MINUTE, 10 * SECOND, () => [['plugins.example.pulses', (pulses += 1)]]);
    assert.notEqual(restarted.inventory(t).paths.find((item) => item.path === 'plugins.example.pulses').kind, 'counter');
  });

  it('tells counters from measurements that carry a counter-like word', () => {
    const counter = (path, units) => {
      const state = monitor.createPathState(path, T0);
      Object.assign(state, { n: 100, rose: true, monotonic: true, rises: 100, units });
      return monitor.isCounterState(state);
    };
    assert.equal(counter('electrical.batteries.house.lifetimeDischarge', 'C'), true);
    assert.equal(counter('navigation.log', 'm'), true);
    assert.equal(counter('electrical.solar.mppt.yieldToday', 'J'), true);
    assert.equal(counter('electrical.batteries.house.lifetimeMaxTemperature', 'K'), false);
    assert.equal(counter('electrical.ac.totalPower', 'W'), false);
    assert.equal(counter('electrical.batteries.house.energyStored', 'J'), false);
    assert.equal(counter('navigation.gnss.satellitesInView.count'), false);
  });

  it('keeps named counters in a plugin\'s own units, and a tank volume a measurement', () => {
    const counter = (path, units) => {
      const state = monitor.createPathState(path, T0);
      Object.assign(state, { n: 100, rose: true, monotonic: true, rises: 100, units, kind: 'continuous' });
      return monitor.isCounterState(state);
    };
    assert.equal(counter('propulsion.main.runTime', 'h'), true);
    assert.equal(counter('electrical.batteries.house.lifetimeDischarge', 'Ah'), true);
    assert.equal(counter('electrical.solar.energyTotal', 'kWh'), true);
    assert.equal(counter('tanks.blackWater.0.currentVolume', 'm3'), false, 'a tank filling for hours is news');
  });

  it('never judges a listed counter as a discrete value, and lists it as counted by its pattern', () => {
    const engine = newEngine({ watchCounterPaths: ['plugins.example.starts'] });
    let starts = 12;
    // An engine-start count: a small whole number, one more every two hours.
    let t = run(engine, T0, T0 + 12 * 60 * MINUTE, MINUTE, (now) => {
      if ((now - T0) % (2 * 60 * MINUTE) === 0 && now > T0) starts += 1;
      return [['plugins.example.starts', starts], ['plugins.example.status', 'ok']];
    });
    assert.ok(!detectors(engine).some((key) => key.includes('plugins.example.starts')), detectors(engine).join(', '));
    const rows = Object.fromEntries(engine.inventory(t).paths.map((item) => [item.path, item]));
    assert.equal(rows['plugins.example.starts'].kind, 'counter');
    assert.equal(rows['plugins.example.starts'].counterBy, 'plugins.example.starts');
    assert.notEqual(rows['plugins.example.status'].kind, 'counter', 'a word is never a counter');
  });

  it('lets a pattern list counters but not the measurements beside them', () => {
    const rand = noise(5);
    const sample = (voltage) => () => [
      ['plugins.ex.pulses', (pulses += 1)],
      ['plugins.ex.batteryVoltage', voltage + 0.02 * rand()]
    ];
    let pulses = 0;
    const engine = newEngine({ watchCounterPaths: ['plugins.ex'] });
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, sample(13.1));
    t = run(engine, t, t + 2 * MINUTE, SECOND, sample(11.0));
    const kinds = Object.fromEntries(engine.inventory(t).paths.map((item) => [item.path, item.kind]));
    assert.equal(kinds['plugins.ex.pulses'], 'counter');
    assert.notEqual(kinds['plugins.ex.batteryVoltage'], 'counter');
    assert.ok(detectors(engine).includes('shift:plugins.ex.batteryVoltage'), 'a voltage collapse under a counter pattern is still reported');
    // Listed by its exact path, the operator's word stands.
    const exact = newEngine({ watchCounterPaths: ['plugins.ex.batteryVoltage'] });
    t = run(exact, T0, T0 + 40 * MINUTE, SECOND, sample(13.1));
    assert.equal(exact.inventory(t).paths.find((item) => item.path === 'plugins.ex.batteryVoltage').kind, 'counter');
  });

  it('keeps a named counter a counter after it is reset to zero', () => {
    const state = monitor.createPathState('electrical.solar.mppt.yieldToday', T0);
    let value = 0;
    for (let i = 0; i < 100; i += 1) {
      value = i === 60 ? 0 : value + 1000;
      monitor.observe(state, value, T0 + i * MINUTE, {});
    }
    assert.equal(monitor.isCounterState(state), true, 'the midnight reset is not a fall');
    const voltage = monitor.createPathState('electrical.batteries.house.voltage', T0);
    for (let i = 0; i < 100; i += 1) monitor.observe(voltage, i === 60 ? 0 : 12 + i * 0.001, T0 + i * MINUTE, {});
    assert.equal(monitor.isCounterState(voltage), false);
  });

  it('does not make a counter of a climb that is restored after a long stop', () => {
    const state = monitor.createPathState('plugins.example.reading', T0);
    // Forty flat minutes, then twenty climbing: one or two hours with a rise.
    let value = 13.2;
    for (let i = 0; i < 3600; i += 1) {
      if (i >= 2400) value += 0.001;
      monitor.observe(state, value, T0 + i * SECOND, {});
    }
    assert.equal(monitor.isCounterState(state), false);
    // Restored seven hours later: still not a counter.
    const restored = monitor.importPathState(JSON.parse(JSON.stringify(monitor.exportPathState(state))), T0 + 8 * 60 * MINUTE);
    assert.equal(monitor.isCounterState(restored), false);
  });

  it('still treats real counters as counters: fuel used, and a listed one under a plugin\'s own name', () => {
    const engine = newEngine({ watchCounterPaths: ['plugins.example.*'] });
    let used = 0;
    let custom = 0;
    // Two hours of climbing with the engine on, then a long stop.
    let t = run(engine, T0, T0 + 7 * 60 * MINUTE, 10 * SECOND, (now) => {
      if (now < T0 + 2 * 60 * MINUTE) used += 0.00001;
      custom += 1;
      return [
        ['propulsion.main.fuel.used', used],
        ['plugins.example.pulses', custom]
      ];
    });
    t = run(engine, t, t + 30 * MINUTE, 10 * SECOND, () => [
      ['propulsion.main.fuel.used', used],
      ['plugins.example.pulses', custom]
    ]);
    assert.ok(!detectors(engine).some((key) => key.includes('propulsion.main.fuel.used')), 'fuel used holding still is not a stuck sensor');
    assert.ok(!detectors(engine).some((key) => key.includes('plugins.example.pulses')), 'a counter the operator listed is still a counter');
  });

  it('keeps the frozen-fix check for a receiver that reports every 10 s', () => {
    const engine = newEngine();
    const knots = 0.514444;
    const fix = { latitude: 60, longitude: 24 };
    let lat = 60;
    // Learn the receiver's rate while moving normally...
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, (now) => {
      const values = [['navigation.speedThroughWater', 6 * knots], ['navigation.headingTrue', 0]];
      if ((now - T0) % (10 * SECOND) === 0) {
        lat += (60 * knots * 10) / 111195 / 6;
        values.push(['navigation.position', { latitude: lat, longitude: 24 }, 'gps']);
      }
      return values;
    });
    // ...then it repeats one fix every 10 s while the log reads 6 kn.
    fix.latitude = lat;
    t = run(engine, t, t + 4 * MINUTE, SECOND, (now) => {
      const values = [['navigation.speedThroughWater', 6 * knots], ['navigation.headingTrue', 0]];
      if ((now - T0) % (10 * SECOND) === 0) values.push(['navigation.position', fix, 'gps']);
      return values;
    });
    assert.ok(detectors(engine).includes('gnss.frozen:navigation.position'));
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

describe('GNSS: a receiver that really slows down', () => {
  const knots = 0.514444;

  it('learns the slower rate instead of reporting it lost after every fix', () => {
    const engine = newEngine();
    let lat = 60;
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, () => {
      lat += 0.00001;
      return [['navigation.position', { latitude: lat, longitude: 24 }, 'gps']];
    });
    // Now one fix every 40 s, for 40 minutes.
    t = run(engine, t, t + 40 * MINUTE, SECOND, (now) => {
      if ((now - T0) % (40 * SECOND) !== 0) return [];
      lat += 0.0004;
      return [['navigation.position', { latitude: lat, longitude: 24 }, 'gps']];
    });
    // Thirty-five seconds after the last fix: normal for this receiver now.
    t = run(engine, t, t + 35 * SECOND, SECOND, () => []);
    assert.notEqual(engine.status(t).gnss.status, 'lost');
    assert.ok(!detectors(engine).includes('gnss.lost:navigation.position'));
  });

  it('does not stretch the usual interval from a few irregular dropouts', () => {
    for (const gap of [20, 45]) {
      const engine = newEngine();
      let lat = 60;
      let t = run(engine, T0, T0 + 2 * MINUTE, SECOND, () => {
        lat += 0.00001;
        return [['navigation.position', { latitude: lat, longitude: 24 }, 'gps']];
      });
      // Three fixes, each one gap apart (a receiver dropping out), then nothing.
      for (let i = 0; i < 3; i += 1) {
        t = run(engine, t, t + gap * SECOND, SECOND, () => []);
        engine.ingest('navigation.position', { latitude: (lat += 0.0001), longitude: 24 }, t, 'gps');
      }
      t = run(engine, t, t + 60 * SECOND, SECOND, () => []);
      assert.ok(detectors(engine).includes('gnss.lost:navigation.position'), `a receiver gone for a minute after ${gap} s dropouts is lost`);
    }
  });

  it('keeps the frozen-fix check after a 1 Hz receiver settles at one fix every 10 s', () => {
    const engine = newEngine();
    let lat = 60;
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, () => {
      lat += (6 * knots) / 111195;
      return [
        ['navigation.position', { latitude: lat, longitude: 24 }, 'gps'],
        ['navigation.speedThroughWater', 6 * knots]
      ];
    });
    const phase = t;
    t = run(engine, t, t + 5 * MINUTE, SECOND, (now) => {
      const out = [['navigation.speedThroughWater', 6 * knots]];
      if ((now - phase) % (10 * SECOND) === 0) {
        lat += (60 * knots) / 111195;
        out.push(['navigation.position', { latitude: lat, longitude: 24 }, 'gps']);
      }
      return out;
    });
    // The fix freezes while the log still reads 6 kn.
    const frozen = { latitude: lat, longitude: 24 };
    t = run(engine, t, t + 5 * MINUTE, SECOND, (now) => {
      const out = [['navigation.speedThroughWater', 6 * knots]];
      if ((now - phase) % (10 * SECOND) === 0) out.push(['navigation.position', frozen, 'gps']);
      return out;
    });
    assert.ok(detectors(engine).includes('gnss.frozen:navigation.position'));
  });
});

describe('GNSS frozen fix: each safeguard on its own', () => {
  const gnssModule = require('../lib/watch/gnss.cjs');
  const options = {
    gnssMaxSpeedKn: 40,
    gnssJumpMinMetres: 100,
    gnssCurrentAllowanceKn: 2,
    gnssSourceDisagreeMetres: 100,
    gnssFrozenMs: MINUTE,
    gnssClockJumpMs: 30000,
    gnssLostMs: 30000
  };
  const speed = 6 * 0.514444;
  const fix = { latitude: 60, longitude: 24 };
  const at = (seconds) => T0 + seconds * SECOND;

  it('starts the candidate over when the log was quiet, though the fixes stayed consecutive', () => {
    const state = gnssModule.createGnssState();
    for (let s = 0; s <= 50; s += 1) {
      gnssModule.observeGnss(state, 'navigation.speedThroughWater', speed, at(s), 'log', options);
      gnssModule.observeGnss(state, 'navigation.position', fix, at(s), 'gps', options);
    }
    // The log stops; four more fixes, then a 4 s pause in the fixes.
    for (let s = 51; s <= 54; s += 1) gnssModule.observeGnss(state, 'navigation.position', fix, at(s), 'gps', options);
    // The log comes back after 7 s, then fixes resume, still "consecutive".
    for (let s = 57; s <= 62; s += 1) {
      gnssModule.observeGnss(state, 'navigation.speedThroughWater', speed, at(s), 'log', options);
      if (s >= 58) gnssModule.observeGnss(state, 'navigation.position', fix, at(s), 'gps', options);
    }
    const out = gnssModule.evaluateGnss(state, at(62), options);
    assert.ok(!out.frozen || !out.frozen.active, 'the time before the log went quiet is not evidence');
  });

  it('needs a fix inside the receiver\'s own window when judging', () => {
    const state = gnssModule.createGnssState();
    for (let s = 0; s <= 70; s += 1) {
      gnssModule.observeGnss(state, 'navigation.speedThroughWater', speed, at(s), 'log', options);
      gnssModule.observeGnss(state, 'navigation.position', fix, at(s), 'gps', options);
    }
    assert.equal(gnssModule.evaluateGnss(state, at(70), options).frozen.active, true);
    // Fixes stop; the log goes on. Eight seconds is eight missed 1 Hz fixes.
    for (let s = 71; s <= 78; s += 1) gnssModule.observeGnss(state, 'navigation.speedThroughWater', speed, at(s), 'log', options);
    assert.equal(gnssModule.evaluateGnss(state, at(78), options).frozen.active, false);
  });
});

describe('watch report: GNSS cross-check within the window', () => {
  it('says cross-checked only when dead reckoning compared the fix inside the report window', () => {
    const engine = newEngine();
    const knots = 0.514444;
    let lat = 60;
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, () => {
      lat += (6 * knots) / 111195;
      return [
        ['navigation.position', { latitude: lat, longitude: 24 }, 'gps'],
        ['navigation.headingTrue', 0],
        ['navigation.speedThroughWater', 6 * knots]
      ];
    });
    assert.match(engine.report(t, 1).lines.join('\n'), /cross-checked the fix \(last at/);
    // Two hours later, fixes only: no heading or log, so nothing checks them.
    t = run(engine, t, t + 2 * 60 * MINUTE, 10 * SECOND, () => {
      lat += (60 * knots) / 111195;
      return [['navigation.position', { latitude: lat, longitude: 24 }, 'gps']];
    });
    assert.match(engine.report(t, 1).lines.join('\n'), /nothing independent cross-checked the fix in this period/);
  });

  it('keeps the last cross-check across a restart', () => {
    const engine = newEngine();
    const knots = 0.514444;
    let lat = 60;
    const t = run(engine, T0, T0 + 5 * MINUTE, SECOND, () => {
      lat += (6 * knots) / 111195;
      return [
        ['navigation.position', { latitude: lat, longitude: 24 }, 'gps'],
        ['navigation.headingTrue', 0],
        ['navigation.speedThroughWater', 6 * knots]
      ];
    });
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    const restarted = newEngine();
    assert.equal(restarted.importState(saved, t + MINUTE), true);
    // No fix since the restart: the earlier cross-check is kept, but the
    // report does not call a receiver it has not heard from "no warnings".
    const quiet = restarted.report(t + MINUTE, 24).lines.join('\n');
    assert.match(quiet, /GNSS: no fix since the watch restarted \(the fix was last cross-checked at/);
    assert.doesNotMatch(quiet, /no warnings/);
    // A fix arrives: the day's cross-checking counts again.
    restarted.ingest('navigation.position', { latitude: lat, longitude: 24 }, t + 2 * MINUTE, 'gps');
    restarted.tick(t + 2 * MINUTE);
    assert.match(restarted.report(t + 2 * MINUTE, 24).lines.join('\n'), /no warnings; dead reckoning or a second receiver cross-checked the fix \(last at/);
  });
});

describe('review of 9366cdb, and the stale-log case', () => {
  it('restores a baseline saved before per-pair statistics without crashing on the next secondary sample', () => {
    const engine = newEngine();
    const path = 'electrical.batteries.house.voltage';
    const t = run(engine, T0, T0 + 5 * MINUTE, SECOND, () => [[path, 13.2, 'a'], [path, 13.21, 'b']]);
    const saved = JSON.parse(JSON.stringify(engine.exportState(t)));
    // What an older version wrote: one shared gap, no pair table.
    for (const item of saved.paths) {
      if (item.sources) {
        delete item.sources.pairs;
        Object.assign(item.sources, { diffMean: 0.01, diffVar: 0, diffN: 40, lastDiff: undefined });
      }
    }
    const restored = createWatchEngine(normalizeWatchConfig({ watchEnabled: true }), { now: t });
    restored.importState(saved, t);
    assert.doesNotThrow(() => run(restored, t, t + 10 * SECOND, SECOND, () => [[path, 13.2, 'a'], [path, 13.21, 'b']]));
  });

  it('still reports a receiver lost a second time, after an earlier outage', () => {
    const engine = newEngine();
    let lat = 60;
    const fix = () => {
      lat += 3 / 111195;
      return [['navigation.position', { latitude: lat, longitude: 24 }, 'gps']];
    };
    let t = run(engine, T0, T0 + 5 * MINUTE, SECOND, fix);
    t = run(engine, t, t + 10 * MINUTE, SECOND, () => []);
    assert.equal(engine.status(t).gnss.status, 'lost');
    t = run(engine, t, t + 5 * SECOND, SECOND, fix);
    t = run(engine, t, t + 3 * MINUTE, SECOND, () => []);
    assert.equal(engine.status(t).gnss.status, 'lost');
    assert.ok(detectors(engine).includes('gnss.lost:navigation.position'));
  });

  it('does not let one glitch that comes straight back set the sensor resolution', () => {
    const engine = newEngine();
    const path = 'tanks.freshWater.0.currentLevel';
    let t = run(engine, T0, T0 + 40 * MINUTE, SECOND, () => [[path, 0.8]]);
    t = run(engine, t, t + SECOND, SECOND, () => [[path, 0.2]]);
    t = run(engine, t, t + 5 * MINUTE, SECOND, () => [[path, 0.8]]);
    t = run(engine, t, t + MINUTE, SECOND, () => [[path, 0.2]]);
    assert.ok(detectors(engine).includes(`shift:${path}`));
  });

  it('learns a coarse pressure sender\'s resolution, so one step is not an alarm', () => {
    const engine = newEngine();
    const path = 'propulsion.main.oilPressure';
    const step = 4000;
    const rand = noise(3);
    // Half an hour of varied pressure in 4 kPa steps, as a J1939 gateway sends it.
    let t = run(engine, T0, T0 + 30 * MINUTE, SECOND, () => [[path, 300000 + step * Math.round(3 * rand())]]);
    // Steady at cruise for six hours, flickering one step every five minutes.
    t = run(engine, t, t + 6 * 60 * MINUTE, 10 * SECOND, (now) => [[path, (now - T0) % (5 * MINUTE) < 10 * SECOND ? 300000 + step : 300000]]);
    // Then it settles one step up.
    t = run(engine, t, t + 10 * MINUTE, SECOND, () => [[path, 300000 + step]]);
    assert.ok(!detectors(engine).some((key) => key.includes(path)), detectors(engine).join(', '));
  });

  it('still reports a tank on an eighths sender going from full to empty', () => {
    const engine = newEngine();
    const path = 'tanks.fuel.0.currentLevel';
    // Full, flickering one eighth now and then: the sender's resolution is learned.
    let t = run(engine, T0, T0 + 60 * MINUTE, 10 * SECOND, (now) => [[path, (now - T0) % (5 * MINUTE) < 10 * SECOND ? 0.875 : 1]]);
    assert.ok(!detectors(engine).some((key) => key.includes(path)), 'one eighth step is not news');
    t = run(engine, t, t + 5 * MINUTE, 10 * SECOND, () => [[path, 0]]);
    assert.ok(detectors(engine).includes(`shift:${path}`), 'full to empty must be reported');
  });

  it('treats one count on a small whole-number path as one count', () => {
    const monitor = require('../lib/watch/path-monitor.cjs');
    const state = monitor.createPathState('plugins.example.pumpsRunning', T0);
    Object.assign(state, { mean: 1, quantum: 1, allInteger: true });
    assert.ok(monitor.noiseFloor(state) >= 1, 'a one-count change must not score as a large departure');
  });

  it('needs three steps of a size, not a glitch and its return, to learn a resolution', () => {
    const monitor = require('../lib/watch/path-monitor.cjs');
    const state = monitor.createPathState('tanks.freshWater.0.currentLevel', T0);
    const values = [0.8, 0.8, 0.2, 0.8, 0.2];
    values.forEach((value, index) => monitor.observe(state, value, T0 + index * SECOND, {}));
    assert.equal(state.quantum, undefined, 'out-and-back, then one real drop, is not a resolution');
    const flicker = monitor.createPathState('tanks.fuel.0.currentLevel', T0);
    [0.5, 0.625, 0.5, 0.625, 0.5, 0.625, 0.5].forEach((value, index) => monitor.observe(flicker, value, T0 + index * SECOND, {}));
    assert.ok(Math.abs(flicker.quantum - 0.125) < 1e-9, 'a sensor flickering between eighths does have that resolution');
  });

  it('does not open a frozen fix from an old candidate when the log comes back before the fixes', () => {
    const engine = newEngine();
    const knots = 0.514444;
    const fix = { latitude: 60, longitude: 24 };
    let lat = 60;
    // Learn a 1 Hz receiver while moving.
    let t = run(engine, T0, T0 + MINUTE, SECOND, () => {
      lat += (6 * knots) / 111195;
      return [['navigation.speedThroughWater', 6 * knots], ['navigation.position', { latitude: lat, longitude: 24 }, 'gps']];
    });
    fix.latitude = lat;
    // 50 s of an unmoving fix at speed: a candidate, not yet a finding.
    t = run(engine, t, t + 50 * SECOND, SECOND, () => [
      ['navigation.speedThroughWater', 6 * knots],
      ['navigation.position', fix, 'gps']
    ]);
    assert.ok(!detectors(engine).includes('gnss.frozen:navigation.position'));
    // Both go quiet for 9 s; then the log returns before any fix does.
    t = run(engine, t, t + 9 * SECOND, SECOND, () => []);
    t = run(engine, t, t + 5 * SECOND, SECOND, () => [['navigation.speedThroughWater', 6 * knots]]);
    assert.ok(!detectors(engine).includes('gnss.frozen:navigation.position'));
  });
});
