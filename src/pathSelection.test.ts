import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withUnlistedSelection } from './pathSelection.js';

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
