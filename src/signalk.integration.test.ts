import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getActiveAlarms, getRecentDeltas, getVesselSnapshot } from './api.js';
import type { EmbeddedWebAppApi } from './types.js';

describe('Signal K harness integration (mocked API surface)', () => {
  it('retrieves snapshot + alarms + deltas through EmbeddedWebAppApi contract', async () => {
    const appData: Record<string, unknown> = {
      'ai-bridge/last-flattened-snapshot': {
        'navigation.position.latitude': 37.0,
        'navigation.position.longitude': -122.0,
        'navigation.speedOverGround': 3.5
      }
    };

    const vesselSelf = {
      navigation: {
        position: { latitude: 37.1, longitude: -122.1 },
        speedOverGround: 4.1,
        courseOverGroundTrue: 1.57
      },
      notifications: {
        'navigation.anchor': {
          state: 'alarm',
          message: 'Anchor drag detected'
        }
      }
    };

    const api: EmbeddedWebAppApi = {
      get: async <T>(path: string) => {
        if (path.endsWith('/navigation/position')) {
          return vesselSelf.navigation.position as T;
        }
        if (path.endsWith('/navigation/speedOverGround')) {
          return vesselSelf.navigation.speedOverGround as T;
        }
        if (path.endsWith('/navigation/courseOverGroundTrue')) {
          return vesselSelf.navigation.courseOverGroundTrue as T;
        }
        if (path.endsWith('/notifications')) {
          return vesselSelf.notifications as T;
        }

        return vesselSelf as T;
      },
      getApplicationData: async <T>(path: string) => appData[path] as T,
      setApplicationData: async (path, value) => {
        appData[path] = value;
      }
    };

    const snapshot = await getVesselSnapshot(api);
    assert.equal(snapshot.position?.latitude, 37.1);
    assert.equal(snapshot.speedOverGround, 4.1);

    const alarms = await getActiveAlarms(api);
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0]?.path, 'navigation.anchor');

    const deltas = await getRecentDeltas(api);
    assert.ok(deltas.length >= 1);
  });
});
