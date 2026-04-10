import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeBridgeRequest } from './bridgeRuntime.js';
import type { AppPanelProps } from './panelTypes.js';

describe('executeBridgeRequest', () => {
  it('rejects invalid auth token', async () => {
    const api: AppPanelProps = { isLoggedIn: true };

    const result = await executeBridgeRequest(
      api,
      { toolId: 'get-vessel-snapshot' },
      'bad-token',
      'expected-token'
    );

    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'unauthorized');
    }
  });

  it('runs read-only request when token and policy are valid', async () => {
    const api: AppPanelProps = {
      isLoggedIn: true,
      get: async <T>(path: string) => {
        if (path.endsWith('/navigation/position')) {
          return { latitude: 1, longitude: 2 } as T;
        }
        if (path.endsWith('/navigation/speedOverGround')) {
          return 4.2 as T;
        }
        return 1.1 as T;
      }
    };

    const result = await executeBridgeRequest(
      api,
      { toolId: 'get-vessel-snapshot' },
      'token',
      'token'
    );

    assert.equal(result.type, 'get-vessel-snapshot-result');
  });
});
