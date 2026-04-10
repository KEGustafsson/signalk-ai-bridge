import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendAuditEntry } from './audit.js';
import type { EmbeddedWebAppApi } from './types.js';

describe('appendAuditEntry', () => {
  it('stores audit entries in reverse chronological order', async () => {
    const data: Record<string, unknown> = {};
    const api: EmbeddedWebAppApi = {
      getApplicationData: async <T>(path: string) => data[path] as T,
      setApplicationData: async (path, value) => {
        data[path] = value;
      }
    };

    await appendAuditEntry(api, 'get-vessel-snapshot', 'allowed');
    await appendAuditEntry(api, 'create-waypoint-draft', 'denied', 'Not authorized');

    const entries = data['ai-bridge/audit-log'] as Array<{ toolId: string; outcome: string }>;
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.toolId, 'create-waypoint-draft');
    assert.equal(entries[0]?.outcome, 'denied');
    assert.equal(entries[1]?.toolId, 'get-vessel-snapshot');
    assert.equal(entries[1]?.outcome, 'allowed');
  });

  it('recovers from malformed existing audit data', async () => {
    const data: Record<string, unknown> = {
      'ai-bridge/audit-log': { broken: true }
    };

    const api: EmbeddedWebAppApi = {
      getApplicationData: async <T>(path: string) => data[path] as T,
      setApplicationData: async (path, value) => {
        data[path] = value;
      }
    };

    await appendAuditEntry(api, 'get-vessel-snapshot', 'allowed');
    const entries = data['ai-bridge/audit-log'] as Array<{ toolId: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.toolId, 'get-vessel-snapshot');
  });
});
