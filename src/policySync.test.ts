import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRotatingTokenProvider } from './policyChannel.js';
import { signPolicyDocument } from './policy.js';
import { createHardenedPolicySyncOptions, syncPolicyFromServer, syncPolicyFromServerWithTokenProvider } from './policySync.js';
import type { EmbeddedWebAppApi } from './types.js';

declare const global: {
  fetch?: typeof fetch;
};

afterEach(() => {
  delete global.fetch;
});

describe('syncPolicyFromServer', () => {
  it('builds hardened sync defaults', async () => {
    const options = createHardenedPolicySyncOptions({
      pinnedFingerprint: '  AA:BB:CC  ',
      maxPolicyAgeMs: 60000,
      maxFutureSkewMs: 15000
    });

    assert.equal(options.pinnedFingerprint, 'AA:BB:CC');
    assert.equal(options.requireMutualTls, true);
    assert.equal(options.maxPolicyAgeMs, 60000);
    assert.equal(options.maxFutureSkewMs, 15000);
  });

  it('rejects hardened sync defaults with empty fingerprint', async () => {
    assert.throws(() => createHardenedPolicySyncOptions({ pinnedFingerprint: '   ' }));
  });

  it('rejects hardened sync defaults with invalid maxPolicyAgeMs', async () => {
    assert.throws(() =>
      createHardenedPolicySyncOptions({
        pinnedFingerprint: 'AA:BB:CC',
        maxPolicyAgeMs: Number.NaN
      })
    );
  });

  it('rejects hardened sync defaults with invalid maxFutureSkewMs', async () => {
    assert.throws(() =>
      createHardenedPolicySyncOptions({
        pinnedFingerprint: 'AA:BB:CC',
        maxFutureSkewMs: -1
      })
    );
  });

  it('rejects hardened sync mTLS config without agent factory', async () => {
    assert.throws(() =>
      createHardenedPolicySyncOptions({
        pinnedFingerprint: 'AA:BB:CC',
        mutualTlsClientConfig: {
          certPem: 'cert',
          keyPem: 'key'
        }
      })
    );
  });

  it('preserves mTLS wiring inputs in hardened sync defaults', async () => {
    const agentFactory = () => ({ name: 'dispatcher' });
    const options = createHardenedPolicySyncOptions({
      pinnedFingerprint: 'AA:BB:CC',
      mutualTlsHeaderName: 'x-mtls-status',
      mutualTlsExpectedValue: 'verified',
      mutualTlsClientConfig: {
        certPem: 'cert',
        keyPem: 'key'
      },
      mutualTlsAgentFactory: agentFactory
    });

    assert.equal(options.requireMutualTls, true);
    assert.equal(options.mutualTlsHeaderName, 'x-mtls-status');
    assert.equal(options.mutualTlsExpectedValue, 'verified');
    assert.equal(options.mutualTlsClientConfig?.certPem, 'cert');
    assert.equal(options.mutualTlsAgentFactory, agentFactory);
  });

  it('applies a valid signed policy payload', async () => {
    const data: Record<string, unknown> = {};
    const api: EmbeddedWebAppApi = {
      setApplicationData: async (path, value) => {
        data[path] = value;
      }
    };

    const document = {
      version: 11,
      role: 'operator' as const,
      allowedTools: ['get-vessel-snapshot', 'create-waypoint-draft'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z'
    };

    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret');

    assert.equal(data['ai-bridge/user-role'], 'operator');
    assert.equal(data['ai-bridge/policy-version'], 11);
  });

  it('throws on HTTP error', async () => {
    const api: EmbeddedWebAppApi = {};

    global.fetch = (async () =>
      ({
        ok: false,
        status: 503,
        headers: {
          get: () => null
        },
        json: async () => ({})
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret'));
  });

  it('rejects non-https policy endpoint', async () => {
    const api: EmbeddedWebAppApi = {};
    await assert.rejects(syncPolicyFromServer(api, 'http://policy.local/document', 'token', 'sync-secret'));
  });

  it('validates pinned certificate fingerprint when provided', async () => {
    const api: EmbeddedWebAppApi = {};

    const document = {
      version: 1,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (header: string) => (header === 'x-cert-sha256' ? 'AA:BB:CC' : null)
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        pinnedFingerprint: 'AA:BB:CD'
      })
    );
  });

  it('syncs using rotating token provider', async () => {
    const data: Record<string, unknown> = {};
    const api: EmbeddedWebAppApi = {
      setApplicationData: async (path, value) => {
        data[path] = value;
      }
    };

    const document = {
      version: 12,
      role: 'admin' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z'
    };

    const signature = await signPolicyDocument(document, 'sync-secret');
    const provider = createRotatingTokenProvider('token-a');
    provider.rotate('token-b');

    global.fetch = (async (_input, init) => {
      const auth = new Headers(init?.headers).get('Authorization');
      assert.equal(auth, 'Bearer token-b');
      return {
        ok: true,
        status: 200,
        headers: {
          get: (header: string) => (header === 'x-cert-sha256' ? 'AA:BB:CC' : null)
        },
        json: async () => ({ document, signature })
      } as unknown as Response;
    }) as typeof fetch;

    await syncPolicyFromServerWithTokenProvider(
      api,
      'https://policy.local/document',
      () => provider.getToken(),
      'sync-secret',
      {
        pinnedFingerprint: 'AA:BB:CC'
      }
    );

    assert.equal(data['ai-bridge/policy-version'], 12);
  });

  it('rejects when mTLS verification header is missing while required', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 2,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (header: string) => (header === 'x-cert-sha256' ? 'AA:BB:CC' : null)
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        pinnedFingerprint: 'AA:BB:CC',
        requireMutualTls: true
      })
    );
  });

  it('accepts custom mTLS verification header when required', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 3,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (header: string) => {
            if (header === 'x-cert-sha256') {
              return 'AA:BB:CC';
            }
            if (header === 'x-mtls-status') {
              return 'success';
            }
            return null;
          }
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
      pinnedFingerprint: 'AA:BB:CC',
      requireMutualTls: true,
      mutualTlsHeaderName: 'x-mtls-status',
      mutualTlsExpectedValue: 'success'
    });
  });

  it('accepts custom mTLS verification value when required', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 4,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (header: string) => {
            if (header === 'x-cert-sha256') {
              return 'AA:BB:CC';
            }
            if (header === 'x-mtls-status') {
              return 'verified';
            }
            return null;
          }
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
      pinnedFingerprint: 'AA:BB:CC',
      requireMutualTls: true,
      mutualTlsHeaderName: 'x-mtls-status',
      mutualTlsExpectedValue: 'verified'
    });
  });

  it('rejects mTLS attestation without pinning by default', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 5,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (header: string) => (header === 'x-mtls-client-auth' ? 'success' : null)
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        requireMutualTls: true
      })
    );
  });

  it('allows explicit override for unpinned mTLS attestation', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 6,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-04-10T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (header: string) => (header === 'x-mtls-client-auth' ? 'success' : null)
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
      requireMutualTls: true,
      allowUnpinnedMutualTlsAttestation: true
    });
  });

  it('rejects expired policies before applying', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 7,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        now: new Date('2026-01-03T00:00:00.000Z')
      })
    );
  });

  it('rejects policies where expiresAt is earlier than issuedAt', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 17,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-03T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret'));
  });

  it('rejects stale policies that exceed maxPolicyAgeMs', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 8,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        now: new Date('2026-01-02T00:00:00.000Z'),
        maxPolicyAgeMs: 60 * 60 * 1000
      })
    );
  });

  it('accepts fresh policies within maxPolicyAgeMs', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 9,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T00:30:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
      now: new Date('2026-01-01T01:00:00.000Z'),
      maxPolicyAgeMs: 60 * 60 * 1000
    });
  });

  it('rejects policies issued in the future by default', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 10,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T02:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        now: new Date('2026-01-01T01:00:00.000Z')
      })
    );
  });

  it('accepts future-issued policy within maxFutureSkewMs', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 11,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T01:00:30.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
      now: new Date('2026-01-01T01:00:00.000Z'),
      maxFutureSkewMs: 60 * 1000
    });
  });

  it('rejects negative maxPolicyAgeMs configuration', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 12,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T01:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        maxPolicyAgeMs: -1
      })
    );
  });

  it('rejects negative maxFutureSkewMs configuration', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 13,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T01:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        maxFutureSkewMs: -1
      })
    );
  });

  it('rejects non-finite maxPolicyAgeMs configuration', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 14,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T01:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        maxPolicyAgeMs: Number.NaN
      })
    );
  });

  it('rejects non-finite maxFutureSkewMs configuration', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 15,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T01:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        maxFutureSkewMs: Number.POSITIVE_INFINITY
      })
    );
  });

  it('rejects invalid now date configuration', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 16,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T01:00:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      }) as unknown as Response) as typeof fetch;

    await assert.rejects(
      syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
        now: new Date('invalid')
      })
    );
  });

  it('passes fetch overrides through for transport wiring', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 10,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T00:30:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    let seenDispatcher: unknown;
    const customFetch = (async (_input, init) => {
      seenDispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
      return {
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      } as unknown as Response;
    }) as typeof fetch;

    const dispatcher = { name: 'mtls-dispatcher' };
    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
      fetchImpl: customFetch,
      fetchInitOverrides: {
        dispatcher
      } as RequestInit
    });

    assert.equal(seenDispatcher, dispatcher);
  });

  it('builds transport overrides from mutualTlsClientConfig', async () => {
    const api: EmbeddedWebAppApi = {};
    const document = {
      version: 11,
      role: 'viewer' as const,
      allowedTools: ['get-vessel-snapshot'] as const,
      issuedAt: '2026-01-01T00:30:00.000Z'
    };
    const signature = await signPolicyDocument(document, 'sync-secret');

    const dispatcher = { name: 'agent-factory-dispatcher' };
    let seenDispatcher: unknown;
    const customFetch = (async (_input, init) => {
      seenDispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
      return {
        ok: true,
        status: 200,
        headers: {
          get: () => null
        },
        json: async () => ({ document, signature })
      } as unknown as Response;
    }) as typeof fetch;

    await syncPolicyFromServer(api, 'https://policy.local/document', 'token', 'sync-secret', {
      fetchImpl: customFetch,
      mutualTlsClientConfig: {
        certPem: 'cert',
        keyPem: 'key'
      },
      mutualTlsAgentFactory: () => dispatcher
    });

    assert.equal(seenDispatcher, dispatcher);
  });
});
