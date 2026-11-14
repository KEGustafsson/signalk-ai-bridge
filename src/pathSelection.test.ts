import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retickedFromChange, statusKeepingNewerLists, withSelectionLists, withUnlistedSelection } from './pathSelection.js';

describe('withUnlistedSelection', () => {
  it('keeps a configured path the listing could not show', () => {
    // A live source that happens to be silent, or a listing truncated at its
    // cap, has no checkbox - so the picker cannot express "remove it" and the
    // path has to survive the save.
    const picked = withUnlistedSelection(['navigation.position'], ['navigation.position'], [
      'navigation.position',
      'tanks.fuel.0.currentLevel'
    ]);

    assert.deepEqual(picked, ['navigation.position', 'tanks.fuel.0.currentLevel']);
  });

  it('removes a listed path the operator unticked', () => {
    const picked = withUnlistedSelection([], ['navigation.position'], ['navigation.position']);

    assert.deepEqual(picked, []);
  });

  it('removes an unticked path that was configured with an aggregation method', () => {
    // The picker lists `navigation.speedOverGround` and pre-ticks it from a
    // configured `navigation.speedOverGround:average`. Comparing raw strings
    // counted the configured spec as unlisted, so unticking the box left the
    // spec saved and the path never went away.
    const picked = withUnlistedSelection([], ['navigation.speedOverGround'], [
      'navigation.speedOverGround:average'
    ]);

    assert.deepEqual(picked, []);
  });

  it('keeps the aggregation method of a path that stays ticked', () => {
    const picked = withUnlistedSelection(
      ['navigation.speedOverGround'],
      ['navigation.speedOverGround'],
      ['navigation.speedOverGround:average']
    );

    assert.deepEqual(picked, ['navigation.speedOverGround:average']);
  });

  it('keeps every aggregation of one path, which the History API serves separately', () => {
    const picked = withUnlistedSelection(
      ['environment.wind.speedApparent'],
      ['environment.wind.speedApparent'],
      ['environment.wind.speedApparent:min', 'environment.wind.speedApparent:max']
    );

    assert.deepEqual(picked, [
      'environment.wind.speedApparent:min',
      'environment.wind.speedApparent:max'
    ]);
  });

  it('adds a newly ticked path that was not configured before', () => {
    const picked = withUnlistedSelection(
      ['navigation.headingTrue'],
      ['navigation.headingTrue', 'navigation.position'],
      []
    );

    assert.deepEqual(picked, ['navigation.headingTrue']);
  });
});

describe('selection order', () => {
  it('keeps the stored order when saving from the picker, and adds new ticks at the end', () => {
    const listed = ['electrical.batteries.house.voltage', 'navigation.position', 'notifications.*'];
    const configured = ['notifications.*', 'navigation.position'];
    const picked = withUnlistedSelection(
      ['electrical.batteries.house.voltage', 'navigation.position', 'notifications.*'],
      listed,
      configured
    );
    assert.deepEqual(picked, ['notifications.*', 'navigation.position', 'electrical.batteries.house.voltage']);
  });

});

describe('applying list replies', () => {
  interface History {
    readonly paths: readonly string[];
    readonly derived: boolean;
    readonly samples?: number;
  }
  interface Status {
    readonly model: string;
    readonly aiDataPaths?: readonly string[];
    readonly history?: History;
  }
  const before: Status = {
    model: 'old-model',
    aiDataPaths: ['a.one', 'b.two'],
    history: { paths: ['a.one', 'b.two'], derived: true }
  };

  it('patches both lists from a move reply, including a 409 that carries them', () => {
    const patched = withSelectionLists<History, Status>(before, {
      aiDataPaths: ['b.two', 'a.one'],
      history: { paths: ['b.two', 'a.one'], derived: true }
    });
    assert.deepEqual(patched, {
      model: 'old-model',
      aiDataPaths: ['b.two', 'a.one'],
      history: { paths: ['b.two', 'a.one'], derived: true }
    });
  });

  it('keeps a list the reply did not carry, and does nothing before the first status', () => {
    assert.deepEqual(withSelectionLists<History, Status>(before, { aiDataPaths: ['b.two'] })?.history, before.history);
    assert.equal(withSelectionLists<History, Status>(null, { aiDataPaths: ['b.two'] }), null);
  });

  it('applies a status reply whole when no list change landed while it was in flight', () => {
    const incoming: Status = { model: 'new-model', aiDataPaths: ['c.three'], history: { paths: [], derived: true } };
    assert.deepEqual(statusKeepingNewerLists<History, Status>(before, incoming, 3, 3), incoming);
  });

  it('keeps the newer lists when a list change landed after the status read was sent', () => {
    // A move to ['b.two', 'a.one'] was applied (version 3 -> 4) while a status
    // read sent at version 3 was still on its way, answered with the old order.
    const moved = withSelectionLists<History, Status>(before, { aiDataPaths: ['b.two', 'a.one'] }) as Status;
    const stale: Status = { model: 'new-model', aiDataPaths: ['a.one', 'b.two'], history: before.history };
    const applied = statusKeepingNewerLists<History, Status>(moved, stale, 3, 4);
    assert.deepEqual(applied.aiDataPaths, ['b.two', 'a.one'], 'the pre-move order is not put back');
    assert.equal(applied.model, 'new-model', 'the rest of the status still updates');
  });

  it('keeps only the history order from the screen, and takes the reply\'s other history fields', () => {
    const shown: Status = { model: 'm', aiDataPaths: ['a.one'], history: { paths: ['b.two', 'a.one'], derived: false, samples: 10 } };
    const stale: Status = { model: 'm', aiDataPaths: ['a.one'], history: { paths: ['a.one', 'b.two'], derived: false, samples: 99 } };
    const applied = statusKeepingNewerLists<History, Status>(shown, stale, 3, 4);
    assert.deepEqual(applied.history, { paths: ['b.two', 'a.one'], derived: false, samples: 99 });
  });

  it('drops a status reply whole once a status sent after it has been applied', () => {
    const shown: Status = { model: 'model-from-read-2', aiDataPaths: ['a.one'] };
    const late: Status = { model: 'model-from-read-1', aiDataPaths: ['a.one'] };
    assert.equal(statusKeepingNewerLists<History, Status>(shown, late, 3, 4, true), shown);
  });

  it('applies only what another browser changed to the picker\'s ticks', () => {
    // Ticked from [a.one, b.two, c.three]; the operator also ticked d.four and
    // unticked b.two without saving. Another browser removed c.three and
    // added e.five.
    const picked = { 'a.one': true, 'b.two': false, 'c.three': true, 'd.four': true, 'e.five': false };
    assert.deepEqual(retickedFromChange(picked, ['a.one', 'b.two', 'c.three'], ['a.one', 'b.two', 'e.five:max']), {
      'a.one': true,
      'b.two': false,
      'c.three': false,
      'd.four': true,
      'e.five': true
    });
  });

  it('leaves the ticks alone when the stored selection did not change', () => {
    const picked = { 'a.one': true, 'h.new': true };
    assert.deepEqual(retickedFromChange(picked, ['a.one'], ['a.one']), picked);
  });

  it('takes a status reply as it is when there was nothing on screen to keep', () => {
    const incoming: Status = { model: 'new-model', aiDataPaths: ['c.three'] };
    assert.deepEqual(statusKeepingNewerLists<History, Status>(null, incoming, 0, 1), incoming);
  });
});
