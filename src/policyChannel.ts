export interface TokenProvider {
  getToken: () => Promise<string>;
  rotate: (nextToken: string) => void;
}

export interface MutualTlsClientConfig {
  readonly certPem: string;
  readonly keyPem: string;
  readonly caPem?: string;
  readonly servername?: string;
  readonly rejectUnauthorized?: boolean;
}

export function createRotatingTokenProvider(initialToken: string): TokenProvider {
  let token = initialToken;

  return {
    async getToken() {
      return token;
    },
    rotate(nextToken: string) {
      token = nextToken;
    }
  };
}

export function assertHttpsEndpoint(endpoint: string): void {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:') {
    throw new Error('Policy sync endpoint must use HTTPS.');
  }
}

function normalizeFingerprint(fingerprint: string): string {
  const normalized = fingerprint.replace(/[:\s]/g, '').toLowerCase();
  if (!normalized || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error('Policy sync certificate fingerprint format is invalid.');
  }
  if (normalized.length % 2 !== 0) {
    throw new Error('Policy sync certificate fingerprint length is invalid.');
  }
  return normalized;
}

function secureFingerprintEquals(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = left.charCodeAt(index) || 0;
    const rightCode = right.charCodeAt(index) || 0;
    diff |= leftCode ^ rightCode;
  }
  return diff === 0;
}

export function assertPinnedCertificate(receivedFingerprint: string, expectedFingerprint: string): void {
  if (!secureFingerprintEquals(normalizeFingerprint(receivedFingerprint), normalizeFingerprint(expectedFingerprint))) {
    throw new Error('Policy sync certificate fingerprint mismatch.');
  }
}

export function assertMutualTlsVerified(verificationHeader: string | null, expectedValue = 'success'): void {
  if (verificationHeader?.toLowerCase() !== expectedValue.toLowerCase()) {
    throw new Error('Policy sync mutual TLS verification failed.');
  }
}

export async function createMutualTlsFetchInitOverrides(
  config: MutualTlsClientConfig,
  agentFactory?: (options: Record<string, unknown>) => unknown | Promise<unknown>
): Promise<RequestInit> {
  if (!config.certPem || !config.keyPem) {
    throw new Error('Mutual TLS client configuration requires both certPem and keyPem.');
  }

  const connect: Record<string, unknown> = {
    cert: config.certPem,
    key: config.keyPem,
    rejectUnauthorized: config.rejectUnauthorized ?? true
  };
  if (config.caPem) {
    connect.ca = config.caPem;
  }
  if (config.servername) {
    connect.servername = config.servername;
  }

  const dispatcher = agentFactory
    ? await agentFactory({ connect })
    : (() => {
        throw new Error('No agentFactory provided for mTLS transport wiring.');
      })();

  return { dispatcher } as RequestInit;
}
