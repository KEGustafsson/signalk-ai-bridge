'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRule } = require('../lib/watch/rule-parser.cjs');
const { describeRule, evaluateRule, normalizeRule } = require('../lib/watch/rules.cjs');
const { assistRule } = require('../lib/watch/rule-assist.cjs');
const { createWatchEngine, normalizeWatchConfig } = require('../lib/watch/engine.cjs');
const { createWatchService } = require('../lib/watch-service.cjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse('2026-06-01T08:00:00Z');

const VESSEL = [
  'propulsion.main.temperature',
  'propulsion.main.revolutions',
  'propulsion.main.oilPressure',
  'electrical.batteries.house.voltage',
  'electrical.batteries.start.voltage',
  'electrical.batteries.house.capacity.stateOfCharge',
  'tanks.freshWater.0.currentLevel',
  'tanks.fuel.0.currentLevel',
  'environment.inside.refrigerator.temperature',
  'environment.inside.temperature',
  'environment.water.temperature',
  'environment.outside.pressure',
  'electrical.switches.bilgePump.state',
  'electrical.ac.shore.state',
  'electrical.inverters.main.inverterMode'
].map((path) => ({ path, role: 'watching' }));

function parsed(text, options) {
  const result = parseRule(text, VESSEL, options);
  assert.equal(result.ok, true, `${text}: ${result.reason}`);
  return result.rule;
}

describe('rule parser (no model)', () => {
  it('reads a threshold in the operator\'s units, with a duration', () => {
    const rule = parsed('Tell me if the coolant goes above 95 for 2 minutes');
    assert.equal(rule.path, 'propulsion.main.temperature');
    assert.equal(rule.op, 'above');
    assert.equal(rule.value, 368.15);
    assert.equal(rule.forSeconds, 120);
    assert.equal(rule.severity, 'warn');
  });

  it('reads a "while" condition and urgency', () => {
    const rule = parsed('alert if the fridge gets warmer than 8 °C while shore is on');
    assert.equal(rule.path, 'environment.inside.refrigerator.temperature');
    assert.equal(rule.value, 281.15);
    assert.deepEqual(rule.when, { path: 'electrical.ac.shore.state', op: 'equals', value: true });
    assert.equal(rule.severity, 'alert');
  });

  it('converts typed units to SI and uses them to choose the path', () => {
    assert.equal(parsed('barometer below 1000 hPa').path, 'environment.outside.pressure');
    assert.equal(parsed('fuel below 15 %').value, 0.15);
    const oil = parsed('engine oil pressure under 2 bar while rpm is above 600');
    assert.equal(oil.value, 200000);
    assert.deepEqual(oil.when, { path: 'propulsion.main.revolutions', op: 'above', value: 10 });
  });

  it('reads states and changes', () => {
    assert.deepEqual(
      { path: parsed('let me know when the bilge pump runs').path, value: parsed('let me know when the bilge pump runs').value },
      { path: 'electrical.switches.bilgePump.state', value: true }
    );
    assert.equal(parsed('notify me if the inverter mode changes').op, 'changes');
  });

  it('asks which one rather than guessing', () => {
    const result = parseRule('tell me if the battery is below 12', VESSEL);
    assert.equal(result.ok, false);
    assert.match(result.reason, /Which "the battery" do you mean\?/);
    assert.deepEqual(
      result.alternatives.slice(0, 2).map((item) => item.path).sort(),
      ['electrical.batteries.house.voltage', 'electrical.batteries.start.voltage']
    );
    // ...and takes the answer.
    const rule = parsed('tell me if the battery is below 12', { forcePath: 'electrical.batteries.start.voltage' });
    assert.equal(rule.path, 'electrical.batteries.start.voltage');
    assert.equal(rule.value, 12);
  });

  it('says so when there is nothing to compare', () => {
    const result = parseRule('tell me if the fridge gets warm', VESSEL);
    assert.equal(result.ok, false);
    assert.match(result.reason, /No comparison found/);
  });

  it('refuses a unit that cannot apply to the path', () => {
    const result = parseRule('house battery voltage above 30 °C', VESSEL);
    assert.equal(result.ok, false);
  });
});

describe('rules', () => {
  it('validates before storing', () => {
    assert.throws(() => normalizeRule({ path: 'notifications.x', op: 'above', value: 1 }), /Signal K path/);
    assert.throws(() => normalizeRule({ path: 'a.b', op: 'above', value: 'hot' }), /needs a number/);
    assert.throws(() => normalizeRule({ path: 'a.b', op: 'explode' }), /needs one of/);
    const rule = normalizeRule({ path: 'a.b', op: 'changes', forSeconds: -5 }, T0);
    assert.equal(rule.forSeconds, 0);
    assert.match(rule.id, /^r-/);
  });

  it('reads back in plain words', () => {
    const rule = normalizeRule(parsed('engine oil pressure under 2 bar for 30 s while rpm is above 600'), T0);
    assert.equal(
      describeRule(rule),
      'Warn when Main engine oil pressure is below 2000.0 hPa for 30 s, only while Main engine revolutions is above 600 rpm'
    );
  });

  it('evaluates with its guard, and treats on, 1 and true alike', () => {
    const rule = normalizeRule(parsed('alert if the fridge gets warmer than 8 °C while shore is on'), T0);
    const data = new Map([
      ['environment.inside.refrigerator.temperature', { value: 283, at: T0 }],
      ['electrical.ac.shore.state', { value: 1, at: T0 }]
    ]);
    assert.equal(evaluateRule(rule, (path) => data.get(path), T0, {}).active, true);
    data.set('electrical.ac.shore.state', { value: 0, at: T0 });
    assert.equal(evaluateRule(rule, (path) => data.get(path), T0, {}), null);
    data.set('electrical.ac.shore.state', { value: 'on', at: T0 - 10 * MINUTE });
    assert.equal(evaluateRule(rule, (path) => data.get(path), T0, {}), null, 'stale guard data is not "on"');
  });
});

describe('rule assist (model fallback)', () => {
  const candidates = VESSEL.slice(0, 5);

  it('asks with a schema of real paths, and converts the answer to SI', async () => {
    let sent;
    const fetchImpl = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              path: 'propulsion.main.temperature',
              op: 'above',
              value: 90,
              forSeconds: 60,
              severity: 'warn',
              whenPath: 'propulsion.main.revolutions',
              whenOp: 'above',
              whenValue: 1000
            })
          }
        }),
        { status: 200 }
      );
    };
    const result = await assistRule(
      'engine running hot, over ninety, at cruising revs',
      candidates,
      { baseUrl: 'http://ollama:11434', model: 'qwen3:0.6b', keepAlive: '2m', backend: 'ollama' },
      { fetchImpl }
    );
    assert.equal(sent.url, 'http://ollama:11434/api/chat');
    assert.equal(sent.body.model, 'qwen3:0.6b');
    assert.deepEqual(sent.body.format.properties.path.enum, [...candidates.map((item) => item.path), '']);
    assert.equal(sent.body.options.temperature, 0);
    assert.equal(result.ok, true);
    assert.equal(result.rule.value, 363.15);
    assert.deepEqual(result.rule.when, { path: 'propulsion.main.revolutions', op: 'above', value: 1000 / 60 });
    assert.equal(result.rule.source, 'model');
  });

  it('reports a model that found nothing, or answered badly, without throwing', async () => {
    const answer = (content) => async () => new Response(JSON.stringify({ message: { content } }), { status: 200 });
    const options = { baseUrl: 'http://ollama:11434', model: 'm', backend: 'ollama' };
    assert.match((await assistRule('x', candidates, options, { fetchImpl: answer('{"path":""}') })).message, /no path/);
    assert.match((await assistRule('x', candidates, options, { fetchImpl: answer('sure!') })).message, /did not answer with a rule/);
    assert.match((await assistRule('x', candidates, { ...options, backend: 'tensorrt-llm' }, {})).message, /needs the Ollama backend/);
  });
});

describe('rules in the watch', () => {
  function engineWithRule(text) {
    const engine = createWatchEngine(normalizeWatchConfig({ watchEnabled: true }), { now: T0 });
    engine.ingest('propulsion.main.temperature', 353, T0);
    engine.ingest('propulsion.main.revolutions', 30, T0);
    const proof = engine.proveRule(parsed(text), T0);
    engine.setRules([proof.rule]);
    return { engine, proof };
  }

  it('fires a rule after its duration and publishes it on its own notification', () => {
    const { engine, proof } = engineWithRule('Tell me if the coolant goes above 95 for 30 seconds while rpm is above 600');
    assert.equal(proof.wouldFireNow, false);
    assert.match(proof.current.text, /79\.9 °C/);
    let t = T0;
    for (; t < T0 + 20 * SECOND; t += SECOND) {
      engine.ingest('propulsion.main.temperature', 370, t);
      engine.ingest('propulsion.main.revolutions', 30, t);
      engine.tick(t);
    }
    assert.equal(engine.status(t).activeFindings.length, 0, 'not before 30 s');
    for (; t < T0 + 40 * SECOND; t += SECOND) {
      engine.ingest('propulsion.main.temperature', 370, t);
      engine.ingest('propulsion.main.revolutions', 30, t);
      engine.tick(t);
    }
    const finding = engine.status(t).activeFindings[0];
    assert.equal(finding.detector, 'rule');
    assert.match(finding.title, /^Main engine temperature is above 95\.0 °C for 30 s/);
    assert.match(finding.message, /^Now 96\.9 °C\. Your watch: "Tell me if the coolant/);
    assert.ok(engine.notificationStates().has(`rules.${proof.rule.id}`));
    assert.equal(engine.status(t).rules[0].firing, true);

    // Deleting the rule clears its finding.
    engine.setRules([]);
    engine.tick(t + SECOND);
    assert.equal(engine.status(t + SECOND).activeFindings.length, 0);
  });

  it('compiles through the service: parser first, model only for the rest', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'gemma4:e2b-it-qat' }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({ path: 'propulsion.main.temperature', op: 'above', value: 100, forSeconds: 0, severity: 'alert', whenPath: '', whenOp: '', whenValue: null })
          }
        }),
        { status: 200 }
      );
    };
    let onDelta;
    const host = {
      subscriptionmanager: {
        subscribe(command, unsubscribes, onError, callback) {
          onDelta = callback;
        }
      }
    };
    const service = createWatchService(host, { now: () => T0, fetchImpl });
    service.start({ watchEnabled: true });
    try {
      onDelta({ updates: [{ values: [{ path: 'propulsion.main.temperature', value: 353 }, { path: 'propulsion.main.revolutions', value: 30 }] }] });
      const aiConfig = { enabled: true, baseUrl: 'http://ollama:11434', model: 'gemma4', backend: 'ollama', keepAlive: '30m', requestTimeoutMs: 5000 };

      const byParser = await service.compileRule({ text: 'warn me if the coolant is above 100' }, aiConfig);
      assert.equal(byParser.ok, true);
      assert.equal(byParser.source, 'parser');
      assert.equal(byParser.description, 'Warn when Main engine temperature is above 100.0 °C');
      assert.equal(calls.length, 0, 'the parser needed no model');

      const byModel = await service.compileRule({ text: 'shout if the engine is cooking' }, aiConfig);
      assert.equal(byModel.ok, true);
      assert.equal(byModel.source, 'model');
      assert.equal(byModel.model, 'gemma4:e2b-it-qat', 'the main model, resolved to the installed tag');
      assert.equal(byModel.rule.severity, 'alert');

      const off = createWatchService(host, { now: () => T0, fetchImpl });
      off.start({ watchEnabled: true, watchRuleAssist: 'off' });
      onDelta({ updates: [{ values: [{ path: 'propulsion.main.temperature', value: 353 }] }] });
      const refused = await off.compileRule({ text: 'shout if the engine is cooking' }, aiConfig);
      assert.equal(refused.ok, false);
      assert.equal(refused.assist, 'off');
      off.stop();
    } finally {
      service.stop();
    }
  });
});

describe('rule parser: review fixes', () => {
  it('keeps the named state in "switches on" and "changes to fault"', () => {
    const pump = parsed('tell me when the bilge pump switches on');
    assert.deepEqual([pump.op, pump.value], ['equals', true]);
    const mode = parsed('tell me if the inverter mode changes to fault');
    assert.deepEqual([mode.op, mode.value], ['equals', 'fault']);
    assert.equal(parsed('notify me if the inverter mode changes').op, 'changes');
  });

  it('refuses a second "while" rather than dropping it', () => {
    const result = parseRule('coolant above 95 while rpm above 600 only when shore is on', VESSEL);
    assert.equal(result.ok, false);
    assert.match(result.reason, /one "while" condition; this has 2/);
  });
});

describe('review fixes (minor)', () => {
  const { formatValue } = require('../lib/watch/format.cjs');
  const { toPosition } = require('../lib/watch/stats.cjs');

  it('keeps the sign of a roll, and wraps only directions', () => {
    assert.equal(formatValue('navigation.attitude.roll', -Math.PI / 18, 'rad'), '-10.0 °');
    assert.equal(formatValue('navigation.headingTrue', -Math.PI / 18, 'rad'), '350.0 °');
  });

  it('does not read null coordinates as 0° 0°', () => {
    assert.equal(toPosition({ latitude: null, longitude: null }), undefined);
    assert.equal(toPosition({ latitude: '', longitude: '' }), undefined);
    assert.deepEqual(toPosition({ latitude: 60.1, longitude: '24.9' }), { latitude: 60.1, longitude: 24.9 });
  });

  it('keeps a "changes" rule up to date while its guard is false', () => {
    const rule = normalizeRule({ path: 'a.mode', op: 'changes', when: { path: 'a.power', op: 'equals', value: true } }, T0);
    const data = new Map([['a.mode', { value: 'idle', at: T0 }], ['a.power', { value: true, at: T0 }]]);
    const memory = {};
    evaluateRule(rule, (path) => data.get(path), T0, memory);
    // Power off; the mode changes while nobody is watching for it.
    data.set('a.power', { value: false, at: T0 });
    data.set('a.mode', { value: 'fault', at: T0 });
    assert.equal(evaluateRule(rule, (path) => data.get(path), T0, memory), null);
    // Power back on: the mode has not changed since, so nothing fires.
    data.set('a.power', { value: true, at: T0 + 1000 });
    assert.equal(evaluateRule(rule, (path) => data.get(path), T0 + 1000, memory).active, false);
  });
});

describe('rule compilation: review follow-ups', () => {
  it('does not hand a two-condition request to the model, which would drop one too', async () => {
    let onDelta;
    let calls = 0;
    const service = createWatchService(
      { subscriptionmanager: { subscribe(command, unsubscribes, onError, callback) { onDelta = callback; } } },
      { now: () => T0, fetchImpl: async () => { calls += 1; return new Response('{}', { status: 500 }); } }
    );
    service.start({ watchEnabled: true, watchRuleAssist: 'main' });
    try {
      onDelta({ updates: [{ values: [
        { path: 'propulsion.main.temperature', value: 353 },
        { path: 'propulsion.main.revolutions', value: 30 },
        { path: 'electrical.ac.shore.state', value: true }
      ] }] });
      const result = await service.compileRule(
        { text: 'coolant above 95 while rpm above 600 only when shore is on' },
        { enabled: true, baseUrl: 'http://ollama:11434', model: 'gemma4', backend: 'ollama' }
      );
      assert.equal(result.ok, false);
      assert.match(result.reason, /one "while" condition/);
      assert.equal(calls, 0, 'no model was asked');
    } finally {
      service.stop();
    }
  });
});
