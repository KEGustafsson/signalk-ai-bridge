import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWaypointDraft, flattenObject, getRecentDeltas, shallowEqual } from './api.js';
import type { EmbeddedWebAppApi } from './types.js';

describe('api helpers', () => {
  it('flattens nested objects', () => {
    const result = flattenObject({ a: { b: 1 }, c: true });
    assert.deepEqual(result, { 'a.b': 1, c: true });
  });

  it('detects shallow equality by JSON serialization', () => {
    assert.equal(shallowEqual({ a: 1 }, { a: 1 }), true);
    assert.equal(shallowEqual({ a: 1 }, { a: 2 }), false);
  });
});

describe('getRecentDeltas', () => {
  it('returns changed keys and persists snapshot', async () => {
    const appData: Record<string, unknown> = {
      'ai-bridge/last-flattened-snapshot': { 'navigation.course': 120 }
    };

    const api: EmbeddedWebAppApi = {
      get: async <T>() => ({ navigation: { course: 121, speed: 5.2 } } as T),
      getApplicationData: async <T>(path: string) => appData[path] as T,
      setApplicationData: async (path, value) => {
        appData[path] = value;
      }
    };

    const deltas = await getRecentDeltas(api);
    assert.equal(deltas.length, 2);
    assert.ok(appData['ai-bridge/last-flattened-snapshot']);
  });
});

describe('createWaypointDraft', () => {
  it('creates and persists a draft', async () => {
    const appData: Record<string, unknown> = {};
    const api: EmbeddedWebAppApi = {
      setApplicationData: async (path, value) => {
        appData[path] = value;
      }
    };

    const draft = await createWaypointDraft(api, 'Approach', 10.123, -20.456);
    assert.equal(draft.status, 'draft');
    assert.ok(appData['ai-bridge/last-waypoint-draft']);
  });

  it('rejects invalid coordinates', async () => {
    const api: EmbeddedWebAppApi = {};
    await assert.rejects(createWaypointDraft(api, 'Bad', 100, 0), (error: unknown) => {
      const value = error as { code?: string };
      return value.code === 'validation-failed';
    });
  });

  it('rejects draft creation when navigation path is read-only', async () => {
    const api: EmbeddedWebAppApi = {
      getApplicationData: async <T>(_path: string) => [{ path: 'navigation.*', access: 'read-only' }] as T
    };

    await assert.rejects(createWaypointDraft(api, 'Blocked', 10, 20), (error: unknown) => {
      const value = error as { code?: string };
      return value.code === 'unauthorized';
    });
  });
});
