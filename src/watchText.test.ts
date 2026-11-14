import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentQuestion, buildReportQuestion, buildUnusualQuestion, describeCompileEvidence, describeDetectorCounts, storedRule, describeInventoryRow, formatAgo, sparklinePoints } from './watchText.js';
import type { WatchIncident } from './watchText.js';

const incident: WatchIncident = {
  id: 'inc-1',
  status: 'active',
  openedAt: Date.UTC(2026, 5, 1, 8, 0),
  updatedAt: Date.UTC(2026, 5, 1, 8, 5),
  severity: 'alert',
  title: 'Propulsion main temperature unusually high (+1 related)',
  findings: [
    {
      key: 'shift:propulsion.main.temperature',
      detector: 'shift',
      path: 'propulsion.main.temperature',
      severity: 'alert',
      title: 'Propulsion main temperature unusually high',
      message: '92.0 °C, +11.2 °C from its usual 80.8 °C (7.4× its normal variation)',
      openedAt: Date.UTC(2026, 5, 1, 8, 0)
    },
    {
      key: 'shift:electrical.alternators.main.current',
      detector: 'shift',
      path: 'electrical.alternators.main.current',
      severity: 'warn',
      title: 'Electrical alternators main current unusually low',
      message: '2.0 A, −30.0 A from its usual 32.0 A',
      openedAt: Date.UTC(2026, 5, 1, 8, 3),
      clearedAt: Date.UTC(2026, 5, 1, 8, 5)
    }
  ]
};

describe('buildIncidentQuestion', () => {
  it('states the findings as measured facts, earliest first, and asks for an explanation', () => {
    const question = buildIncidentQuestion(incident);
    const lines = question.split('\n');
    assert.match(lines[0], /statistical, not AI/);
    assert.match(lines[1], /temperature unusually high: 92\.0 °C/);
    assert.match(lines[2], /\(since cleared\)$/);
    assert.match(lines[lines.length - 1], /If the data does not support a conclusion, say so\./);
  });

  it('stays bounded however many findings an incident has', () => {
    const many: WatchIncident = {
      ...incident,
      findings: Array.from({ length: 80 }, (_, index) => ({ ...incident.findings[0], key: `k${index}` }))
    };
    const question = buildIncidentQuestion(many);
    assert.ok(question.length < 2200);
    assert.match(question, /…and \d+ more/);
  });
});

describe('watch panel helpers', () => {
  it('draws a sparkline inside its box', () => {
    const points = sparklinePoints([[0, 1], [10, 3], [20, 2]], 100, 20).split(' ');
    assert.deepEqual(points, ['0.0,20.0', '50.0,0.0', '100.0,10.0']);
    assert.equal(sparklinePoints([[0, 1]], 100, 20), '');
  });

  it('describes replay counts in words, biggest first', () => {
    assert.equal(describeDetectorCounts({ dropout: 1, shift: 3, 'gnss.jump': 2 }), '3 unusual level, 2 GNSS jump, 1 stopped updating');
    assert.equal(describeDetectorCounts({}), 'nothing');
  });

  it('says how long ago', () => {
    assert.equal(formatAgo(1000, 1000 + 30 * 1000), 'just now');
    assert.equal(formatAgo(0, 5 * 60 * 1000), '5 min ago');
    assert.equal(formatAgo(0, 3 * 60 * 60 * 1000), '3 h ago');
  });
});

describe('describeInventoryRow', () => {
  it('says what the watch does with a path, and why', () => {
    assert.equal(
      describeInventoryRow({
        path: 'environment.water.temperature',
        role: 'watching',
        kind: 'continuous',
        intervalMs: 1000,
        units: 'K',
        sources: [
          { name: 'n2k.10', primary: true, samples: 10 },
          { name: 'n2k.20', primary: false, samples: 10 }
        ]
      }),
      'watching · continuous · every 1 s · K · 2 sources (n2k.10 primary)'
    );
    assert.equal(
      describeInventoryRow({ path: 'navigation.headingTrue', role: 'gnss-input', excludedBy: 'navigation.heading*' }),
      'read by the GNSS check'
    );
    assert.equal(
      describeInventoryRow({ path: 'environment.wind.speedApparent', role: 'skipped', excludedBy: 'environment.wind' }),
      'skipped (environment.wind)'
    );
  });
});

describe('buildUnusualQuestion', () => {
  it('lists the most unusual paths and invites "ordinary variation" as an answer', () => {
    const question = buildUnusualQuestion([
      { path: 'a', score: 3.1, title: 'House battery voltage somewhat low', message: '13.03 V, −0.17 V from its usual 13.20 V' }
    ]);
    assert.match(question, /House battery voltage somewhat low: 13\.03 V/);
    assert.match(question, /ordinary variation, say so\.$/);
  });

  it('does not claim that nothing raised an alarm (incidents may be open)', () => {
    const question = buildUnusualQuestion([{ path: 'a', score: 3, title: 'x', message: 'y' }]);
    assert.ok(!/Nothing has raised an alarm/.test(question));
  });
});

describe('watch rules in the panel', () => {
  it('summarises the evidence for a rule before it is added', () => {
    assert.equal(
      describeCompileEvidence({ ok: true, current: { text: '79.9 °C' }, wouldFireNow: false, recent: { minutes: 90, share: 0 } }),
      'Now 79.9 °C; the condition does not hold now; true for 0 % of the last 90 min the watch has recorded.'
    );
    assert.equal(describeCompileEvidence({ ok: true }), 'No data for this path has arrived yet.');
  });

  it('stores a rule without its status decorations', () => {
    const stored = storedRule({
      id: 'r-1', text: 't', path: 'a.b', op: 'above', value: 1, forSeconds: 0, severity: 'warn', createdAt: 1, source: 'parser',
      description: 'x', firing: true, current: '1'
    } as never);
    assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'forSeconds', 'id', 'op', 'path', 'severity', 'source', 'text', 'value']);
  });
});

describe('buildReportQuestion', () => {
  it('asks for a logbook entry from the measured lines only', () => {
    const question = buildReportQuestion({ hours: 24, incidents: 1, findings: 2, lines: ['1 incident (0 alerts, 1 warning) from 2 findings.'] });
    assert.match(question, /last 24 h/);
    assert.match(question, /- 1 incident \(0 alerts, 1 warning\)/);
    assert.match(question, /Do not add facts that are not listed\.$/);
  });
});
