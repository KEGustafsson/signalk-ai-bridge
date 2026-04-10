import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySignedPolicyUpdate,
  authorizeTool,
  signPolicyDocument,
  verifyPolicyDocumentSignature
} from './policy.js';
import type { EmbeddedWebAppApi } from './types.js';

describe('authorizeTool', () => {
  it('rejects when explicitly logged out', async () => {
    const api: EmbeddedWebAppApi = { isLoggedIn: false };
    await assert.rejects(authorizeTool(api, 'get-vessel-snapshot'));
  });

  it('defaults to viewer role and allows read-only tools', async () => {
    const api: EmbeddedWebAppApi = { isLoggedIn: true };
    await authorizeTool(api, 'get-vessel-snapshot');
  });

  it('blocks draft action for viewer role', async () => {
    const api: EmbeddedWebAppApi = {
      isLoggedIn: true,
      getApplicationData: async <T>(key: string) => {
        if (key === 'ai-bridge/user-role') {
          return 'viewer' as T;
        }
        return undefined as T;
      }
    };

    await assert.rejects(authorizeTool(api, 'create-waypoint-draft'));
  });

  it('allows draft action for operator role', async () => {
    const api: EmbeddedWebAppApi = {
      isLoggedIn: true,
      getApplicationData: async <T>(key: string) => {
        if (key === 'ai-bridge/user-role') {
          return 'operator' as T;
        }
        return undefined as T;
      }
    };

    await authorizeTool(api, 'create-waypoint-draft');
  });

  it('rejects tool missing from allow list even if role allows it', async () => {
    const api: EmbeddedWebAppApi = {
      isLoggedIn: true,
      getApplicationData: async <T>(key: string) => {
        if (key === 'ai-bridge/user-role') {
          return 'operator' as T;
        }
        if (key === 'ai-bridge/allowed-tools') {
          return ['get-vessel-snapshot'] as T;
        }
        return undefined as T;
      }
    };

    await assert.rejects(authorizeTool(api, 'create-waypoint-draft'));
  });
});

describe('signed policy updates', () => {
  it('signs and verifies policy documents', async () => {
    const policy = {
      version: 7,
      role: 'operator' as const,
      allowedTools: ['get-vessel-snapshot', 'create-waypoint-draft'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z'
    };

    const secret = 'local-dev-secret';
    const signature = await signPolicyDocument(policy, secret);
    assert.equal(await verifyPolicyDocumentSignature(policy, signature, secret), true);
    assert.equal(await verifyPolicyDocumentSignature(policy, `${signature}ff`, secret), false);
  });

  it('applies verified policy to app-data', async () => {
    const appData: Record<string, unknown> = {};
    const api: EmbeddedWebAppApi = {
      setApplicationData: async (path, value) => {
        appData[path] = value;
      }
    };

    const policy = {
      version: 9,
      role: 'admin' as const,
      allowedTools: ['get-vessel-snapshot', 'create-waypoint-draft'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z'
    };

    const signature = await signPolicyDocument(policy, 'local-dev-secret');
    await applySignedPolicyUpdate(api, policy, signature, 'local-dev-secret');

    assert.equal(appData['ai-bridge/user-role'], 'admin');
    assert.deepEqual(appData['ai-bridge/allowed-tools'], [...policy.allowedTools]);
    assert.equal(appData['ai-bridge/policy-version'], 9);
  });
});
