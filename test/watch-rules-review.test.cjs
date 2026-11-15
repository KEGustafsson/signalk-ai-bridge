'use strict';

// Fixes from the CodeRabbit full review of the watch rules: each case here
// failed before its fix.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRule } = require('../lib/watch/rule-parser.cjs');
const { describeRule, evaluateRule, normalizeRule } = require('../lib/watch/rules.cjs');
const { assistRule, buildSchema } = require('../lib/watch/rule-assist.cjs');
const { createWatchEngine, normalizeWatchConfig } = require('../lib/watch/engine.cjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse('2026-06-01T08:00:00Z');

const VESSEL = [
  'propulsion.main.temperature',
  'propulsion.main.revolutions',
  'propulsion.main.state',
  'electrical.batteries.house.voltage',
  'environment.depth.belowTransducer',
  'tanks.fuel.0.currentLevel',
  'electrical.switches.bilgePump.state'
].map((path) => ({ path, role: 'watching' }));

function newEngine() {
  return createWatchEngine(normalizeWatchConfig({ watchEnabled: true }), { now: T0 });
}

describe('CodeRabbit full review: watch rules in the engine', () => {
  it('sees a change that went and came back between two ticks (4575943941)', () => {
    const engine = newEngine();
    const pump = 'electrical.switches.bilgePump.state';
    engine.ingest(pump, false, T0);
    engine.setRules([{ id: 'r-pump', path: pump, op: 'changes', source: 'manual' }]);
    let t = T0;
    engine.tick(t);
    // The pump runs for two seconds, all within one tick interval.
    engine.ingest(pump, true, t + 1 * SECOND);
    engine.ingest(pump, false, t + 3 * SECOND);
    for (t += 5 * SECOND; t <= T0 + 30 * SECOND; t += 5 * SECOND) {
      engine.ingest(pump, false, t);
      engine.tick(t);
    }
    const finding = engine.status(t).activeFindings.find((item) => item.detector === 'rule');
    assert.ok(finding, 'the false -> true -> false change is reported');
  });

  it('starts a re-added rule\'s duration afresh (4575943946)', () => {
    const engine = newEngine();
    const path = 'propulsion.main.temperature';
    const rule = { id: 'r-hot', path, op: 'above', value: 360, forSeconds: 60, source: 'manual' };
    engine.setRules([rule]);
    let t = T0;
    for (; t <= T0 + 30 * SECOND; t += 5 * SECOND) {
      engine.ingest(path, 370, t);
      engine.tick(t);
    }
    engine.setRules([]);
    for (; t <= T0 + 10 * MINUTE; t += 5 * SECOND) {
      engine.ingest(path, 370, t);
      engine.tick(t);
    }
    engine.setRules([rule]);
    engine.ingest(path, 370, t);
    engine.tick(t);
    assert.equal(
      engine.status(t).activeFindings.filter((item) => item.detector === 'rule').length,
      0,
      'the time the rule was gone does not count toward its 60 s'
    );
    for (t += 5 * SECOND; t <= T0 + 10 * MINUTE + 70 * SECOND; t += 5 * SECOND) {
      engine.ingest(path, 370, t);
      engine.tick(t);
    }
    assert.equal(engine.status(t).activeFindings.filter((item) => item.detector === 'rule').length, 1);
  });

  it('fires a "changes" rule whose duration is as long as the change hold (4575943977)', () => {
    const engine = newEngine();
    const path = 'electrical.switches.bilgePump.state';
    engine.ingest(path, false, T0);
    engine.setRules([{ id: 'r-long', path, op: 'changes', forSeconds: 600, source: 'manual' }]);
    let t = T0;
    engine.tick(t);
    let fired = false;
    for (t += 5 * SECOND; t <= T0 + 15 * MINUTE; t += 5 * SECOND) {
      engine.ingest(path, true, t);
      engine.tick(t);
      if (engine.status(t).activeFindings.some((item) => item.detector === 'rule')) fired = true;
    }
    assert.equal(fired, true);
  });
});

describe('CodeRabbit full review: rule comparison', () => {
  it('matches "running" and "stopped" published as words to the parsed state (4575943975)', () => {
    const rule = normalizeRule(parseRule('tell me when the engine state is running', VESSEL).rule, T0);
    assert.equal(rule.value, true);
    const at = (value) => () => ({ value, at: T0 });
    assert.equal(evaluateRule(rule, at('running'), T0, {}).active, true);
    assert.equal(evaluateRule(rule, at('Running'), T0, {}).active, true);
    assert.equal(evaluateRule(rule, at('started'), T0, {}).active, true);
    assert.equal(evaluateRule(rule, at('stopped'), T0, {}).active, false);
    const stopped = normalizeRule(parseRule('tell me when the engine state is stopped', VESSEL).rule, T0);
    assert.equal(evaluateRule(stopped, at('stopped'), T0, {}).active, true);
    assert.equal(evaluateRule(stopped, at('off'), T0, {}).active, true);
  });
});

describe('CodeRabbit full review: rule parser', () => {
  it('refuses a unit it cannot convert instead of reading it as none (4575943964)', () => {
    const result = parseRule('tell me if the depth is below 30 cm', VESSEL);
    assert.equal(result.ok, false);
    assert.match(result.reason, /"cm".*not a unit the watch can convert/);
    // Known units, spelled out or not, still read.
    assert.equal(parseRule('depth below 3 m', VESSEL).rule.value, 3);
    assert.equal(parseRule('coolant above 95 degrees celsius', VESSEL).rule.value, 368.15);
    assert.equal(parseRule('fuel below 15 %', VESSEL).rule.value, 0.15);
  });

  it('refuses a second condition joined with "and" rather than dropping it (4575943967)', () => {
    // Two things joined by "and" may mean "A while B": refused with that
    // hint, not stored as one half (and a model's reading is checked).
    const result = parseRule('coolant above 95 °C and battery below 12 V', VESSEL);
    assert.equal(result.ok, false);
    assert.match(result.reason, /joins two with "and".*"coolant above 95 °c while battery below 12 v"/);
    const three = parseRule('coolant above 95 °C and battery below 12 V and fuel below 10 %', VESSEL);
    assert.equal(three.ok, false);
    assert.equal(three.terminal, true, 'three conditions cannot fit one watch');
    const either = parseRule('coolant above 95 °C or battery below 12 V', VESSEL);
    assert.equal(either.terminal, true, '"or" is two watches');
    const inGuard = parseRule('coolant above 95 while rpm above 600 and fuel below 10 %', VESSEL);
    assert.equal(inGuard.ok, false);
    assert.equal(inGuard.terminal, true);
    const trailing = parseRule('coolant above 95 °C on the port side', VESSEL);
    assert.equal(trailing.ok, false);
    assert.match(trailing.reason, /Could not read "on the port side"/);
    // Filler after the number is still fine.
    assert.equal(parseRule('coolant above 95, please', VESSEL).ok, true);
  });

  it('keeps >= and <= inclusive, from the parser to the comparison (4575943973)', () => {
    const atLeast = normalizeRule(parseRule('house battery voltage >= 12 V', VESSEL).rule, T0);
    assert.equal(atLeast.op, 'atLeast');
    const atMost = normalizeRule(parseRule('house battery voltage at most 12.5 V', VESSEL).rule, T0);
    assert.equal(atMost.op, 'atMost');
    assert.equal(normalizeRule(parseRule('house battery voltage <= 12.5 V', VESSEL).rule, T0).op, 'atMost');
    const at = (value) => () => ({ value, at: T0 });
    assert.equal(evaluateRule(atLeast, at(12), T0, {}).active, true, 'exactly 12 V is at least 12 V');
    assert.equal(evaluateRule(atLeast, at(11.9), T0, {}).active, false);
    assert.equal(evaluateRule(atMost, at(12.5), T0, {}).active, true);
    assert.equal(evaluateRule(atMost, at(12.6), T0, {}).active, false);
    assert.match(describeRule(atLeast), /is at least 12\.00 V/);
    // Strict forms are unchanged, so stored rules read as before.
    const above = normalizeRule(parseRule('house battery voltage > 12 V', VESSEL).rule, T0);
    assert.equal(above.op, 'above');
    assert.equal(evaluateRule(above, at(12), T0, {}).active, false);
    // The model may answer with them too.
    const schema = buildSchema(['a.b']);
    assert.ok(schema.properties.op.enum.includes('atLeast'));
    assert.ok(schema.properties.whenOp.enum.includes('atMost'));
  });
});

describe('CodeRabbit full review: rule assist', () => {
  const candidates = VESSEL.slice(0, 4);
  const options = { baseUrl: 'http://ollama:11434', model: 'm', backend: 'ollama' };
  const answer = (content) => async () => new Response(JSON.stringify({ message: { content } }), { status: 200 });

  it('does not wait for ever on an error reply whose body stalls (4575943951)', async () => {
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('upstream '));
          },
          cancel() {
            cancelled = true;
          }
        }),
        { status: 500 }
      );
    const started = Date.now();
    const result = await Promise.race([
      assistRule('x', candidates, options, { fetchImpl, errorBodyTimeoutMs: 50 }),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 1500))
    ]);
    assert.notEqual(result, 'pending', 'the error body read is bounded');
    assert.equal(result.ok, false);
    assert.match(result.message, /HTTP 500: upstream/);
    assert.ok(Date.now() - started < 1500);
    assert.equal(cancelled, true, 'the stalled body is released');
  });

  it('reports an answer that is JSON but not an object, without throwing (4575943955)', async () => {
    for (const content of ['null', '42', '[]', '"rule"']) {
      const result = await assistRule('x', candidates, options, { fetchImpl: answer(content) });
      assert.equal(result.ok, false, content);
      assert.match(result.message, /did not answer with a rule/);
    }
  });

  it('converts a number given for equals from the shown unit to SI (4575943959)', async () => {
    const content = JSON.stringify({
      path: 'propulsion.main.temperature',
      op: 'equals',
      value: 90,
      forSeconds: 0,
      severity: 'warn',
      whenPath: 'propulsion.main.state',
      whenOp: 'notEquals',
      whenValue: 'stopped'
    });
    const result = await assistRule('x', candidates, options, { fetchImpl: answer(content) });
    assert.equal(result.ok, true);
    assert.equal(result.rule.value, 363.15);
    assert.deepEqual(result.rule.when, { path: 'propulsion.main.state', op: 'notEquals', value: 'stopped' });
  });
});

describe('review of c5649a1: phrasings the leftover check refused', () => {
  const BOAT = [
    ...VESSEL,
    { path: 'electrical.batteries.start.voltage', role: 'watching' },
    { path: 'electrical.ac.shore.state', role: 'watching' },
    { path: 'environment.outside.pressure', role: 'watching' }
  ];
  const read = (text) => parseRule(text, BOAT);

  it('reads "but only if" and "but only when" as the guard', () => {
    const ifRule = read('coolant above 95 °C but only if the engine state is running');
    assert.equal(ifRule.ok, true, ifRule.reason);
    assert.deepEqual(ifRule.rule.when, { path: 'propulsion.main.state', op: 'equals', value: true });
    const whenRule = read('house battery below 12 V, but only when shore is on');
    assert.equal(whenRule.ok, true, whenRule.reason);
    assert.equal(whenRule.rule.when.path, 'electrical.ac.shore.state');
  });

  it('accepts urgency words and harmless trailers after the comparison', () => {
    for (const text of ['coolant above 95 °C immediately', 'coolant above 95 °C, critical', 'coolant above 95 emergency']) {
      const result = read(text);
      assert.equal(result.ok, true, `${text}: ${result.reason}`);
      assert.equal(result.rule.severity, 'alert', text);
    }
    for (const text of ['coolant above 95 °C now', 'coolant above 95 again', 'coolant above 95 °C, send a notification']) {
      assert.equal(read(text).ok, true, text);
    }
    assert.equal(read('house battery below 12 V for 2 minutes straight').rule.forSeconds, 120);
    assert.equal(read('coolant above 95 °C for 2 minutes or more').rule.forSeconds, 120);
    // A word that is no unit is still named as one only when it stands alone.
    assert.match(read('coolant above 30 cm').reason, /"cm" after "30": it is not a unit/);
    assert.match(read('coolant above 95 during the storm').reason, /Could not read "during the storm"/);
  });

  it('reads both states joined as a change, and hints "while" for two things joined by "and"', () => {
    for (const text of ['the bilge pump starts and stops', 'the bilge pump starts or stops']) {
      const result = read(text);
      assert.equal(result.ok, true, `${text}: ${result.reason}`);
      assert.equal(result.rule.op, 'changes');
    }
    const joined = read('coolant above 95 °C and the shore is on');
    assert.equal(joined.ok, false);
    assert.notEqual(joined.terminal, true, 'not refused for good: it may mean "while"');
    assert.match(joined.reason, /say "coolant above 95 °c while the shore is on"/);
  });

  it('narrows the subject with a trailing qualifier, and refuses one that names nothing', () => {
    const house = read('battery below 12 V on the house bank');
    assert.equal(house.ok, true, house.reason);
    assert.equal(house.rule.path, 'electrical.batteries.house.voltage');
    assert.equal(read('coolant above 95 °C on the main engine').rule.path, 'propulsion.main.temperature');
    for (const text of ['coolant above 95 °C at anchor', 'coolant above 95 °C on the port side', 'the bilge pump switches on in the forward bilge']) {
      const result = read(text);
      assert.equal(result.ok, false, text);
      assert.match(result.reason, /Could not read "(?:at|on|in) /, text);
    }
  });

  it('reads mb, º and °celsius', () => {
    assert.equal(read('barometer below 1000 mb').rule.value, 100000);
    assert.equal(read('coolant above 95 ºC').rule.value, 368.15);
    assert.equal(read('coolant above 95 °celsius').rule.value, 368.15);
  });

  it('does not report at unmute a change made while the path was muted', () => {
    const engine = newEngine();
    const pump = 'electrical.switches.bilgePump.state';
    engine.ingest(pump, false, T0);
    engine.setRules([{ id: 'r-pump', path: pump, op: 'changes', source: 'manual' }]);
    let t = T0;
    engine.tick(t);
    engine.mute(pump, t + 60 * MINUTE, t);
    for (t += 5 * SECOND; t <= T0 + 40 * MINUTE; t += 5 * SECOND) {
      const on = t >= T0 + 10 * MINUTE && t < T0 + 10 * MINUTE + 2 * SECOND;
      engine.ingest(pump, on, t);
      if (t === T0 + 10 * MINUTE + 5 * SECOND) engine.ingest(pump, false, t);
      if (t === T0 + 30 * MINUTE) engine.unmute(pump, t);
      engine.tick(t);
      assert.equal(engine.status(t).activeFindings.filter((item) => item.detector === 'rule').length, 0, `at ${(t - T0) / SECOND} s`);
    }
    // A change after the mute is reported.
    engine.ingest(pump, true, t);
    for (const end = t + 30 * SECOND; t <= end; t += 5 * SECOND) {
      engine.ingest(pump, true, t);
      engine.tick(t);
    }
    assert.equal(engine.status(t).activeFindings.filter((item) => item.detector === 'rule').length, 1);
  });

  it('keeps the error detail of a response that offers only text()', async () => {
    const options = { baseUrl: 'http://ollama:11434', model: 'm', backend: 'ollama' };
    const fetchImpl = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', headers: new Map(), body: null, text: async () => 'model not loaded' });
    const result = await assistRule('x', VESSEL.slice(0, 4), options, { fetchImpl, errorBodyTimeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.match(result.message, /model not loaded/);
  });
});

describe('review of d17e43d: more phrasings the leftover check refused', () => {
  const read = (text) => parseRule(text, VESSEL);

  it('reads "changes state" and "switches on/off" as a change', () => {
    for (const text of [
      'notify me if the engine state changes state',
      'the engine state changes its state',
      'the engine state switches state',
      'the engine state changes mode',
      'tell me if the bilge pump switches on/off',
      'the bilge pump starts, then stops',
      'the bilge pump changes at all'
    ]) {
      const result = read(text);
      assert.equal(result.ok, true, `${text}: ${result.reason}`);
      assert.equal(result.rule.op, 'changes', text);
    }
  });

  it('accepts thanks and the like after a state', () => {
    for (const text of ['the bilge pump switches on, thanks', 'the bilge pump is on, thank you', 'the bilge pump switches on again', 'the bilge pump is on now']) {
      const result = read(text);
      assert.equal(result.ok, true, `${text}: ${result.reason}`);
      assert.deepEqual([result.rule.op, result.rule.value], ['equals', true], text);
    }
  });

  it('keeps punctuation inside a quoted state', () => {
    assert.equal(read('the engine state equals "a.b"').rule.value, 'a.b');
    assert.equal(read('the engine state changes to "float."').rule.value, 'float.');
    assert.equal(read("the engine state is 'wow!'").rule.value, 'wow!');
  });

  it('keeps a quoted state whole: punctuation, "while" and "and" inside it (4575989371)', () => {
    const modes = [...VESSEL, { path: 'electrical.inverters.main.mode', role: 'watching', valueType: 'string' }];
    const parse = (text) => parseRule(text, modes);
    assert.equal(parse('inverter mode changes to "fault, low"').rule.value, 'fault, low');
    const whileInside = parse('inverter mode changes to "low, while charging"');
    assert.equal(whileInside.ok, true, whileInside.reason);
    assert.equal(whileInside.rule.value, 'low, while charging');
    assert.equal(whileInside.rule.when, undefined);
    assert.equal(parse('inverter mode is "fault and low"').rule.value, 'fault and low');
    // An urgency word inside the quotes is the state, not the urgency.
    assert.equal(parse("inverter mode becomes 'bulk alarm'").rule.severity, 'warn');
    // A guard after a quoted state is still read, and a quoted "on" is on.
    const guarded = parse('inverter mode becomes "float" while the engine state is "running"');
    assert.deepEqual(guarded.rule.when, { path: 'propulsion.main.state', op: 'equals', value: true });
  });
});

describe('review of 0934d63..7ecbc1a: the qualifier, apostrophes and quotes', () => {
  const BOAT = [
    ...VESSEL,
    { path: 'environment.inside.engineRoom.temperature', role: 'watching' },
    { path: 'environment.inside.refrigerator.temperature', role: 'watching' },
    { path: 'electrical.switches.anchorLight.state', role: 'watching' },
    { path: 'electrical.ac.shore.state', role: 'watching' },
    { path: 'electrical.inverters.main.mode', role: 'watching', valueType: 'string' }
  ];
  const read = (text) => parseRule(text, BOAT);

  it('never lets a qualifier move the watch to another thing than the subject names', () => {
    for (const text of ['coolant above 95 °C in the engine room', 'the fridge temperature is above 8 °C in the engine room']) {
      const result = read(text);
      assert.equal(result.ok, false, `${text} -> ${result.rule && result.rule.path}`);
    }
    const pump = read('the bilge pump runs in the engine room');
    assert.equal(pump.ok, false);
    assert.notEqual(pump.terminal, true, 'refused for the qualifier, not as a measurement');
    // A qualifier that only repeats the subject is a condition in disguise.
    const anchored = read('the anchor light is off at anchor');
    assert.equal(anchored.ok, false);
    assert.match(anchored.reason, /only repeats/);
    // An engine room is not an engine.
    assert.equal(read('engine coolant above 95 °C').rule.path, 'propulsion.main.temperature');
    assert.equal(read('engine room temperature above 40 °C').rule.path, 'environment.inside.engineRoom.temperature');
  });

  it('keeps the op of "starts and stops" with a qualifier', () => {
    const pump = read('the bilge pump starts and stops in the engine room');
    assert.equal(pump.ok, false);
    assert.match(pump.reason, /Could not read "in the engine room"/);
    const bank = read('the bilge pump switches on and off on the house bank');
    assert.equal(bank.ok, false);
    assert.doesNotMatch(bank.reason, /undefined/);
  });

  it('takes an apostrophe for an apostrophe, not a quote', () => {
    const state = read("the bilge pump's state isn't 'off'");
    assert.equal(state.ok, true, state.reason);
    assert.deepEqual([state.rule.op, state.rule.value], ['notEquals', false]);
    const guarded = read("tell me if the engine's coolant is above 95 °C while the bilge pump isn't on");
    assert.equal(guarded.ok, true, guarded.reason);
    assert.deepEqual(guarded.rule.when, { path: 'electrical.switches.bilgePump.state', op: 'notEquals', value: true });
  });

  it('reads quoted words in a subject, and refuses empty quotes', () => {
    assert.equal(read('the "engine room" temperature above 40 °C').rule.path, 'environment.inside.engineRoom.temperature');
    assert.equal(read('the inverter mode is ""').ok, false);
  });

  it('gives the "while" hint whatever filler is around, and reads a qualifier after a bare number', () => {
    const hinted = read('alert immediately when coolant above 95 °C and the shore is on');
    assert.equal(hinted.ok, false);
    assert.notEqual(hinted.terminal, true);
    assert.match(hinted.reason, /say "coolant above 95 °c while the shore is on"/);
    const bare = read('battery voltage below 12 on the house bank');
    assert.equal(bare.ok, true, bare.reason);
    assert.equal(bare.rule.path, 'electrical.batteries.house.voltage');
  });

  it('keeps the HTTP status when text() throws at once', async () => {
    const options = { baseUrl: 'http://ollama:11434', model: 'm', backend: 'ollama' };
    const fetchImpl = async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Map(),
      body: null,
      text() {
        throw new Error('no body');
      }
    });
    const result = await assistRule('x', VESSEL.slice(0, 4), options, { fetchImpl, errorBodyTimeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.match(result.message, /503/);
  });
});

describe('review of 0004c3f: choosing among paths with a qualifier', () => {
  const at = (paths) => paths.map((item) => (typeof item === 'string' ? { path: item, role: 'watching' } : item));

  it('takes the qualifier as the subject when the request names nothing before the comparison', () => {
    const boat = at(['environment.inside.engineRoom.temperature', 'environment.inside.temperature', 'electrical.switches.engineRoomFan.state', 'electrical.switches.engineRoomBilge.state', 'electrical.batteries.house.voltage', 'electrical.batteries.starter.voltage']);
    for (const [text, path] of [
      ['tell me if it gets above 40 °C in the engine room', 'environment.inside.engineRoom.temperature'],
      ['alert when above 40 °C in the engine room', 'environment.inside.engineRoom.temperature'],
      ['warn me if it drops below 12 V on the starter bank', 'electrical.batteries.starter.voltage']
    ]) {
      const result = parseRule(text, boat);
      assert.equal(result.ok, true, `${text}: ${result.reason}`);
      assert.equal(result.rule.path, path, text);
    }
  });

  it('lets the qualifier choose by the subject\'s words alone, not by role, depth or display name', () => {
    const freezer = parseRule('temperature below -10 °C in the freezer', at(['environment.inside.temperature', 'environment.outside.temperature', 'environment.inside.refrigerator.freezer.temperature']));
    assert.equal(freezer.rule && freezer.rule.path, 'environment.inside.refrigerator.freezer.temperature', freezer.reason);
    const relearning = parseRule('temperature above 40 °C in the engine room', [
      { path: 'environment.inside.engineRoom.temperature', role: 'relearning' },
      { path: 'environment.inside.temperature', role: 'watching' },
      { path: 'environment.outside.temperature', role: 'watching' }
    ]);
    assert.equal(relearning.rule && relearning.rule.path, 'environment.inside.engineRoom.temperature', relearning.reason);
    const named = parseRule('battery below 12 V on the house bank', [
      { path: 'electrical.batteries.279.voltage', role: 'watching', displayName: 'House bank' },
      { path: 'electrical.batteries.0.voltage', role: 'watching', displayName: 'Start Battery' }
    ]);
    assert.equal(named.rule && named.rule.path, 'electrical.batteries.279.voltage', named.reason);
    const twin = at(['propulsion.port.coolantTemperature', 'propulsion.starboard.temperature', 'propulsion.port.oilPressure', 'propulsion.starboard.engineOilPressure']);
    assert.equal(parseRule('coolant above 95 °C on the starboard engine', twin).rule.path, 'propulsion.starboard.temperature');
    assert.equal(parseRule('oil pressure below 2 bar on the starboard engine', twin).rule.path, 'propulsion.starboard.engineOilPressure');
  });

  it('does not take an engine room, or an engineRoomTemperature, for an engine', () => {
    const boat = at(['propulsion.main.temperature', 'environment.inside.engineRoomTemperature', 'environment.inside.engineRoom.temperature']);
    assert.equal(parseRule('engine temperature above 95 °C', boat).rule.path, 'propulsion.main.temperature');
    assert.equal(parseRule('motor above 95 °C', boat).rule.path, 'propulsion.main.temperature');
  });

  it('accepts a qualifier that names the same thing again, and one on a path the operator picked', () => {
    const boat = at(['electrical.batteries.house.voltage', 'electrical.batteries.starter.voltage']);
    const repeated = parseRule('the house battery below 12 V on the house bank', boat);
    assert.equal(repeated.ok, true, repeated.reason);
    // A path picked from the alternatives does not drop a condition.
    const forced = parseRule('the battery below 12 V at the dock', boat, { forcePath: 'electrical.batteries.house.voltage' });
    assert.equal(forced.ok, false);
    assert.match(forced.reason, /Could not read "at the dock"/);
    // A qualifier that names nothing among the subject's paths is named in the refusal.
    const night = parseRule('battery below 12 V at night', boat);
    assert.equal(night.ok, false);
    assert.match(night.reason, /Could not read "at night": it names none of the paths/);
    assert.deepEqual(night.alternatives, [], 'nothing to pick that would drop "at night"');
  });

  it('refuses empty and blank quotes with a reason', () => {
    for (const text of ["the inverter mode is ''", "the inverter mode is ' '", 'the inverter mode is " "']) {
      const result = parseRule(text, at([{ path: 'electrical.inverters.main.mode', valueType: 'string' }]));
      assert.equal(result.ok, false, text);
      assert.match(result.reason, /empty quoted value/, text);
    }
  });
});

describe('review of 016d644: joined words, numbers, quoted qualifiers and repeats', () => {
  const at = (paths) => paths.map((item) => (typeof item === 'string' ? { path: item, role: 'watching' } : item));

  it('does not let two words written as one match a path that has only the first', () => {
    const boat = at(['propulsion.main.revolutions', 'electrical.batteries.engine.voltage', 'propulsion.main.temperature']);
    assert.equal(parseRule('engine rpm above 3000', boat).rule.path, 'propulsion.main.revolutions');
    const blower = at(['propulsion.main.revolutions', 'electrical.switches.engineBlower.state']);
    assert.equal(parseRule('engine rpm above 3000', blower).rule.path, 'propulsion.main.revolutions');
    const noLog = parseRule('speed through water above 8 kn', at(['navigation.speedOverGround', 'environment.wind.speedApparent']));
    assert.equal(noLog.ok, false, 'no speed through water on this boat');
  });

  it('keeps numbers as words, and reads a quoted qualifier', () => {
    const boat = at(['electrical.batteries.1.voltage', 'electrical.batteries.2.voltage', 'propulsion.port.revolutions', 'propulsion.starboard.revolutions', 'electrical.batteries.starter.voltage', 'electrical.batteries.house.voltage', 'electrical.switches.bilgePump.state']);
    assert.equal(parseRule('battery 2 below 12 V', boat).rule.path, 'electrical.batteries.2.voltage');
    assert.equal(parseRule('rpm above 3000 on the "starboard"', boat).rule.path, 'propulsion.starboard.revolutions');
    assert.equal(parseRule('battery below 12 V on the "starter"', boat).rule.path, 'electrical.batteries.starter.voltage');
    const room = parseRule('the bilge pump is on in the "engine room"', boat);
    assert.equal(room.ok, false, 'the quoted place is not dropped');
  });

  it('refuses a repeat that is a condition, and names a subject that matches nothing', () => {
    const boat = at(['electrical.switches.anchorLight.state', 'electrical.ac.shore.power', 'propulsion.port.revolutions', 'electrical.batteries.house.voltage']);
    for (const text of ['the anchor light is off on anchor', 'the anchor light is off on the anchor', 'shore power below 100 W on shore power']) {
      assert.equal(parseRule(text, boat).ok, false, text);
    }
    assert.equal(parseRule('battery below 12 V from the house bank', boat).rule.path, 'electrical.batteries.house.voltage');
    const revs = parseRule('speed above 3000 on the port engine', boat);
    assert.equal(revs.ok, false);
    assert.match(revs.reason, /No path on this vessel matches/);
  });

  it('does not take two quoted values side by side for an empty one', () => {
    const result = parseRule('the inverter mode is "invert" "charge"', at([{ path: 'electrical.inverters.main.mode', valueType: 'string' }]));
    assert.doesNotMatch(result.reason || '', /empty quoted value/);
  });
});

describe('review of 5f24be6: numbers, kind words, duplicate meanings and states', () => {
  const at = (paths) => paths.map((item) => (typeof item === 'string' ? { path: item, role: 'watching' } : { role: 'watching', ...item }));

  it('does not let an instance number settle a tie its display name contradicts', () => {
    const boat = at([
      { path: 'electrical.batteries.0.voltage', displayName: 'Battery 1' },
      { path: 'electrical.batteries.1.voltage', displayName: 'Battery 2' },
      { path: 'electrical.batteries.2.voltage', displayName: 'Battery 3' },
      { path: 'propulsion.0.temperature', displayName: 'Engine 1' },
      { path: 'propulsion.1.temperature', displayName: 'Engine 2' }
    ]);
    const two = parseRule('battery 2 below 12 V', boat);
    assert.equal(two.ok, false, `battery 2 is ambiguous here, not ${two.rule && two.rule.path}`);
    assert.equal(parseRule('engine 2 temperature above 95 °C', boat).rule.path, 'propulsion.1.temperature');
    // Without display names the number is the index.
    assert.equal(parseRule('battery 2 below 12 V', at(['electrical.batteries.1.voltage', 'electrical.batteries.2.voltage'])).rule.path, 'electrical.batteries.2.voltage');
  });

  it('reads kind words and the boat itself in a subject', () => {
    const boat = at(['electrical.batteries.house.voltage', 'electrical.batteries.starter.voltage', 'tanks.fuel.port.currentLevel', 'tanks.fuel.starboard.currentLevel']);
    for (const text of ['battery bank below 12 V on the house bank', 'boat battery below 12 V on the house bank', 'the vessel battery below 12 V on the house bank', 'battery sensor below 12 V on the house bank']) {
      const result = parseRule(text, boat);
      assert.equal(result.ok, true, `${text}: ${result.reason}`);
      assert.equal(result.rule.path, 'electrical.batteries.house.voltage', text);
    }
    assert.equal(parseRule('the battery system below 12 V on the starter battery', boat).rule.path, 'electrical.batteries.starter.voltage');
    assert.equal(parseRule('fuel tank sensor below 20 % in the port tank', boat).rule.path, 'tanks.fuel.port.currentLevel');
    // A word that names nothing is named in the refusal.
    const water = parseRule('water temperature above 30 °C in the engine room', at(['environment.inside.engineRoom.temperature', 'propulsion.main.temperature']));
    assert.equal(water.ok, false);
    assert.match(water.reason, /No path on this vessel matches "water"/);
  });

  it('chooses the starter bank beside a houseBank path, and does not count a meaning twice', () => {
    const yacht = at(['electrical.batteries.house.voltage', 'electrical.batteries.starter.voltage', 'electrical.batteries.houseBank.voltage']);
    assert.equal(parseRule('battery below 12 V on the starter bank', yacht).rule.path, 'electrical.batteries.starter.voltage');
    const banks = at([
      { path: 'electrical.switches.bank.0.1.state', displayName: 'Bilge pump' },
      { path: 'electrical.switches.bank.0.3.state', displayName: 'Engine room blower' },
      { path: 'environment.inside.engineRoom.temperature' }
    ]);
    const pump = parseRule('bilge pump in the engine room is on', banks);
    assert.notEqual(pump.rule && pump.rule.path, 'electrical.switches.bank.0.3.state', 'not the blower');
  });

  it('prefers a path with states for a state, and still refuses on/off on a named measurement', () => {
    const boat = at(['electrical.ac.shore.power', { path: 'electrical.switches.bank.0.2.state', displayName: 'Shore power' }]);
    assert.equal(parseRule('the shore power is on', boat).rule.path, 'electrical.switches.bank.0.2.state');
    const measured = parseRule('the coolant temperature is on', at(['propulsion.main.temperature']));
    assert.equal(measured.ok, false);
    assert.match(measured.reason, /is a measurement/);
  });

  it('offers only paths the words name when nothing else does, and reads empty quotes on their own', () => {
    const boat = at(['tanks.fuel.0.currentLevel', 'tanks.freshWater.0.currentLevel']);
    const tank = parseRule('it is below 20 % in the port tank', boat);
    assert.equal(tank.ok, false);
    assert.deepEqual(tank.alternatives, [], 'no tank here is the port one');
    const mode = at([{ path: 'electrical.inverters.main.mode', valueType: 'string' }]);
    assert.match(parseRule('the inverter mode is "" or "invert"', mode).reason, /empty quoted value/);
  });
});

describe('review of 659cde9: numbered and named instances, states, empty quotes', () => {
  const at = (paths) => paths.map((item) => (typeof item === 'string' ? { path: item, role: 'watching' } : { role: 'watching', ...item }));

  it('does not prefer a numbered instance to a named one when no number was given', () => {
    const boat = at(['electrical.batteries.0.voltage', 'electrical.batteries.house.voltage', 'propulsion.0.revolutions', 'propulsion.port.revolutions']);
    assert.equal(parseRule('battery below 12 V', boat).ok, false, 'which battery?');
    assert.equal(parseRule('rpm above 3000', boat).ok, false, 'which engine?');
    const venus = at([{ path: 'electrical.batteries.279.voltage', displayName: 'Starter' }, 'electrical.batteries.house.voltage']);
    assert.equal(parseRule('battery below 12 V', venus).ok, false);
    // A display name that only repeats the path says nothing about which.
    const tanks = at([{ path: 'tanks.freshWater.0.currentLevel', displayName: 'Bow water tank' }, { path: 'tanks.fuel.0.currentLevel', displayName: 'Port fuel' }]);
    assert.equal(parseRule('holding tank above 80 %', tanks).ok, false);
  });

  it('does not take a switch named after a thing for the thing, nor for a named measurement', () => {
    const sail = at(['propulsion.main.state', 'electrical.switches.mainEngineBlower.state', 'electrical.batteries.engine.voltage', 'propulsion.main.temperature']);
    for (const text of ['the engine is running', 'the engine is not running', 'coolant above 95 °C while the engine is running']) {
      const result = parseRule(text, sail);
      const used = result.rule && [result.rule.path, result.rule.when && result.rule.when.path];
      assert.ok(!used || !used.includes('electrical.switches.mainEngineBlower.state'), `${text}: ${JSON.stringify(used)}`);
    }
    const words = at(['electrical.ac.shorePower.voltage', { path: 'electrical.shorePower.state', valueType: 'boolean' }, 'environment.inside.engineRoom.temperature', { path: 'electrical.switches.engineRoomBilgePump.state', valueType: 'boolean' }]);
    assert.match(parseRule('the shore power voltage is off', words).reason, /is a measurement/);
    assert.match(parseRule('the engine room temperature is "high"', words).reason, /is a measurement/);
    assert.equal(parseRule('the shore power is on', words).rule.path, 'electrical.shorePower.state');
    // Neither answers every word: asked among the switches, not refused as a measurement.
    const banks = at([{ path: 'electrical.switches.bank.0.3.state', displayName: 'Engine room blower' }, 'environment.inside.engineRoom.temperature']);
    const fan = parseRule('the engine room fan is off', banks);
    assert.equal(fan.ok, false);
    assert.doesNotMatch(fan.reason, /is a measurement/);
    assert.equal(fan.alternatives[0].path, 'electrical.switches.bank.0.3.state');
  });

  it('refuses empty quotes before punctuation, and accepts a subject a qualifier agrees with', () => {
    const mode = at([{ path: 'electrical.inverters.main.mode', valueType: 'string' }]);
    for (const text of ['inverter mode changes to "":', 'inverter mode changes to ""…', "the inverter mode switches to ''…", 'the inverter mode=""']) {
      assert.match(parseRule(text, mode).reason || '', /empty quoted value/, text);
    }
    const minimal = at(['electrical.batteries.house.voltage', 'propulsion.main.revolutions']);
    assert.equal(parseRule('main battery below 12 V on the house bank', minimal).rule.path, 'electrical.batteries.house.voltage');
    assert.match(parseRule('alert when above 3000 rpm on the port engine', at(['propulsion.main.revolutions'])).reason, /No path on this vessel matches "on the port engine"|port/);
  });
});

describe('review of cc73c01: unanswered words, switch words, names and flags', () => {
  const at = (paths) => paths.map((item) => (typeof item === 'string' ? { path: item, role: 'watching' } : { role: 'watching', ...item }));

  it('leaves only a qualifying word to the qualifier, never one that names a thing', () => {
    const cabin = at([{ path: 'environment.inside.temperature', units: 'K' }, { path: 'electrical.batteries.house.voltage', units: 'V' }]);
    for (const text of ['freezer temperature above -10 °C in the cabin', 'fridge temperature above 8 °C in the cabin', 'starter battery below 12 V on the house bank']) {
      const result = parseRule(text, cabin);
      assert.equal(result.ok, false, `${text} -> ${result.rule && result.rule.path}`);
      assert.match(result.reason, /No path on this vessel matches/);
    }
    assert.equal(parseRule('main battery below 12 V on the house bank', cabin).rule.path, 'electrical.batteries.house.voltage');
    // A room within the boat is not its cabin.
    const room = at([{ path: 'environment.inside.engineRoom.temperature', units: 'K' }, { path: 'environment.outside.temperature', units: 'K' }]);
    assert.equal(parseRule('cabin temperature above 30 °C in the saloon', room).ok, false);
  });

  it('answers "switch", "breaker" and "relay" with any path that has states', () => {
    const boat = at([{ path: 'electrical.ac.shorePower.voltage', units: 'V' }, { path: 'electrical.shorePower.state', valueType: 'boolean' }, { path: 'electrical.batteries.house.voltage', units: 'V' }]);
    assert.equal(parseRule('the shore power switch is on', boat).rule.path, 'electrical.shorePower.state');
    assert.equal(parseRule('the shore power breaker is off', boat).rule.path, 'electrical.shorePower.state');
    assert.equal(parseRule('house battery below 12 V while the shore power switch is on', boat).rule.when.path, 'electrical.shorePower.state');
  });

  it('does not let a display name that repeats the class settle a numbered tie', () => {
    const boat = at([{ path: 'electrical.batteries.0.voltage', displayName: 'House battery' }, 'electrical.batteries.starter.voltage']);
    const result = parseRule('battery below 12 V', boat);
    assert.equal(result.ok, false, `not ${result.rule && result.rule.path}`);
    const engines = at([{ path: 'propulsion.0.temperature', displayName: 'Port engine' }, 'propulsion.starboard.temperature']);
    assert.equal(parseRule('engine temperature above 95 °C', engines).ok, false);
  });

  it('takes on/off on a .state leaf whatever its units, and refuses a word on a flag', () => {
    const units = at([{ path: 'electrical.switches.bilgePump.state', units: 'ratio' }, { path: 'electrical.switches.bilgePump.current', units: 'A' }]);
    assert.equal(parseRule('the bilge pump is on', units).rule.path, 'electrical.switches.bilgePump.state');
    const flag = at([{ path: 'propulsion.main.overTemperature', valueType: 'boolean' }, { path: 'propulsion.main.temperature', units: 'K' }]);
    const high = parseRule('the engine temperature is "high"', flag);
    assert.equal(high.ok, false);
    assert.match(high.reason, /is on or off/);
    assert.equal(parseRule('the overtemperature is on', flag).rule.value, true);
  });
});

