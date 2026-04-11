import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHttpsEndpoint,
  assertMutualTlsVerified,
  assertPinnedCertificate,
  createMutualTlsFetchInitOverrides,
  createRotatingTokenProvider
} from './policyChannel.js';

describe('policy channel helpers', () => {
  it('supports token rotation', async () => {
    const provider = createRotatingTokenProvider('first');
    assert.equal(await provider.getToken(), 'first');

    provider.rotate('second');
    assert.equal(await provider.getToken(), 'second');
  });

  it('enforces https policy endpoint', async () => {
    assert.doesNotThrow(() => assertHttpsEndpoint('https://policy.local/document'));
    assert.throws(() => assertHttpsEndpoint('http://policy.local/document'));
  });

  it('checks pinned certificate fingerprints', async () => {
    assert.doesNotThrow(() => assertPinnedCertificate('AA:BB:CC', 'aabbcc'));
    assert.throws(() => assertPinnedCertificate('AA:BB:CD', 'aabbcc'));
    assert.throws(() => assertPinnedCertificate('AA:BB', 'AABBCC'));
    assert.throws(() => assertPinnedCertificate('ZZ:11', 'aa11'));
    assert.throws(() => assertPinnedCertificate('AA11', 'not-hex'));
    assert.throws(() => assertPinnedCertificate('ABC', 'ABC'));
  });

  it('checks mutual tls verification marker', async () => {
    assert.doesNotThrow(() => assertMutualTlsVerified('success'));
    assert.doesNotThrow(() => assertMutualTlsVerified('SUCCESS'));
    assert.doesNotThrow(() => assertMutualTlsVerified('verified', 'verified'));
    assert.throws(() => assertMutualTlsVerified('failed'));
    assert.throws(() => assertMutualTlsVerified(null));
  });

  it('builds mTLS fetch init overrides using injected agent factory', async () => {
    const fakeDispatcher = { kind: 'dispatcher' };
    const init = await createMutualTlsFetchInitOverrides(
      {
        certPem: 'cert',
        keyPem: 'key',
        caPem: 'ca',
        servername: 'policy.local'
      },
      (options) => {
        const connect = options.connect as Record<string, string>;
        assert.equal(connect.cert, 'cert');
        assert.equal(connect.key, 'key');
        assert.equal(connect.ca, 'ca');
        assert.equal(connect.servername, 'policy.local');
        return fakeDispatcher;
      }
    );

    assert.equal((init as RequestInit & { dispatcher?: unknown }).dispatcher, fakeDispatcher);
  });

  it('passes rejectUnauthorized override to mTLS agent factory', async () => {
    await createMutualTlsFetchInitOverrides(
      {
        certPem: 'cert',
        keyPem: 'key',
        rejectUnauthorized: false
      },
      (options) => {
        const connect = options.connect as Record<string, unknown>;
        assert.equal(connect.rejectUnauthorized, false);
        return {};
      }
    );
  });

  it('defaults rejectUnauthorized to true for mTLS agent factory', async () => {
    await createMutualTlsFetchInitOverrides(
      {
        certPem: 'cert',
        keyPem: 'key'
      },
      (options) => {
        const connect = options.connect as Record<string, unknown>;
        assert.equal(connect.rejectUnauthorized, true);
        return {};
      }
    );
  });

  it('omits optional CA when not provided', async () => {
    await createMutualTlsFetchInitOverrides(
      {
        certPem: 'cert',
        keyPem: 'key'
      },
      (options) => {
        const connect = options.connect as Record<string, unknown>;
        assert.equal(connect.ca, undefined);
        return {};
      }
    );
  });

  it('omits optional servername when not provided', async () => {
    await createMutualTlsFetchInitOverrides(
      {
        certPem: 'cert',
        keyPem: 'key'
      },
      (options) => {
        const connect = options.connect as Record<string, unknown>;
        assert.equal(connect.servername, undefined);
        return {};
      }
    );
  });

  it('rejects incomplete mTLS client config', async () => {
    await assert.rejects(createMutualTlsFetchInitOverrides({ certPem: '', keyPem: 'key' }));
    await assert.rejects(createMutualTlsFetchInitOverrides({ certPem: 'cert', keyPem: '' }));
  });

  it('rejects mTLS override creation without agent factory', async () => {
    await assert.rejects(createMutualTlsFetchInitOverrides({ certPem: 'cert', keyPem: 'key' }));
  });
});
