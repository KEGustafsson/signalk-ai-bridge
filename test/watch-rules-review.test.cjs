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
