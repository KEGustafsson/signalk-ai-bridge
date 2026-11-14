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
    const result = parseRule('coolant above 95 °C and battery below 12 V', VESSEL);
    assert.equal(result.ok, false);
    assert.equal(result.terminal, true, 'not handed to a model, which could only drop one too');
    assert.match(result.reason, /joins 2 with "and".*"coolant above 95 °c", "battery below 12 v"/);
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
