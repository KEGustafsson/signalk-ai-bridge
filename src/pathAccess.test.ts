import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSignalkPathAccess } from './pathAccess.js';
import type { EmbeddedWebAppApi } from './types.js';

describe('path access policy', () => {
  it('allows read access for matching read-only wildcard', async () => {
    const api: EmbeddedWebAppApi = {
      getApplicationData: async <T>(_path: string) => [{ path: 'navigation.*', access: 'read-only' }] as T
    };

    await assertSignalkPathAccess(api, '/signalk/v1/api/vessels/self/navigation/position', 'read');
  });

  it('rejects write access for read-only rule', async () => {
    const api: EmbeddedWebAppApi = {
      getApplicationData: async <T>(_path: string) => [{ path: 'navigation.*', access: 'read-only' }] as T
    };

    await assert.rejects(assertSignalkPathAccess(api, 'navigation.waypoints', 'write'));
  });

  it('allows write access for read-write exact path', async () => {
    const api: EmbeddedWebAppApi = {
      getApplicationData: async <T>(_path: string) => [{ path: 'navigation.waypoints', access: 'read-write' }] as T
    };

    await assertSignalkPathAccess(api, 'navigation.waypoints', 'write');
  });
});
