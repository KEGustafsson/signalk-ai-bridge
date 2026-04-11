import {
  assertHttpsEndpoint,
  assertMutualTlsVerified,
  assertPinnedCertificate,
  createMutualTlsFetchInitOverrides
} from './policyChannel.js';
import type { MutualTlsClientConfig } from './policyChannel.js';
import { applySignedPolicyUpdate } from './policy.js';
import type { EmbeddedWebAppApi } from './types.js';

interface RemotePolicyEnvelope {
  readonly document: {
    readonly version: number;
    readonly role: 'viewer' | 'operator' | 'admin';
    readonly allowedTools: readonly ('get-vessel-snapshot' | 'get-recent-deltas' | 'get-active-alarms' | 'create-waypoint-draft')[];
    readonly issuedAt: string;
    readonly expiresAt?: string;
  };
  readonly signature: string;
}

export interface PolicySyncOptions {
  readonly pinnedFingerprint?: string;
  readonly requireMutualTls?: boolean;
  readonly mutualTlsHeaderName?: string;
  readonly mutualTlsExpectedValue?: string;
  readonly allowUnpinnedMutualTlsAttestation?: boolean;
  readonly maxPolicyAgeMs?: number;
  readonly maxFutureSkewMs?: number;
  readonly now?: Date;
  readonly fetchImpl?: typeof fetch;
  readonly fetchInitOverrides?: RequestInit;
  readonly mutualTlsClientConfig?: MutualTlsClientConfig;
  readonly mutualTlsAgentFactory?: (options: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface HardenedPolicySyncPresetInput {
  readonly pinnedFingerprint: string;
  readonly maxPolicyAgeMs?: number;
  readonly maxFutureSkewMs?: number;
  readonly mutualTlsHeaderName?: string;
  readonly mutualTlsExpectedValue?: string;
  readonly mutualTlsClientConfig?: MutualTlsClientConfig;
  readonly mutualTlsAgentFactory?: (options: Record<string, unknown>) => unknown | Promise<unknown>;
}

export function createHardenedPolicySyncOptions(input: HardenedPolicySyncPresetInput): PolicySyncOptions {
  const pinnedFingerprint = input.pinnedFingerprint.trim();
  if (!pinnedFingerprint) {
    throw new Error('Hardened policy sync requires a non-empty pinnedFingerprint.');
  }
  if (typeof input.maxPolicyAgeMs === 'number' && (!Number.isFinite(input.maxPolicyAgeMs) || input.maxPolicyAgeMs < 0)) {
    throw new Error('Hardened policy sync maxPolicyAgeMs must be a finite non-negative number.');
  }
  if (typeof input.maxFutureSkewMs === 'number' && (!Number.isFinite(input.maxFutureSkewMs) || input.maxFutureSkewMs < 0)) {
    throw new Error('Hardened policy sync maxFutureSkewMs must be a finite non-negative number.');
  }
  if (input.mutualTlsClientConfig && !input.mutualTlsAgentFactory) {
    throw new Error('Hardened policy sync requires mutualTlsAgentFactory when mutualTlsClientConfig is provided.');
  }

  return {
    pinnedFingerprint,
    requireMutualTls: true,
    maxPolicyAgeMs: input.maxPolicyAgeMs,
    maxFutureSkewMs: input.maxFutureSkewMs,
    mutualTlsHeaderName: input.mutualTlsHeaderName,
    mutualTlsExpectedValue: input.mutualTlsExpectedValue,
    mutualTlsClientConfig: input.mutualTlsClientConfig,
    mutualTlsAgentFactory: input.mutualTlsAgentFactory
  };
}

function isRemotePolicyEnvelope(value: unknown): value is RemotePolicyEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.signature === 'string' && typeof candidate.document === 'object' && candidate.document !== null;
}

function assertPolicyFreshness(document: RemotePolicyEnvelope['document'], options?: PolicySyncOptions): void {
  const now = options?.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error('Policy sync now must be a valid Date.');
  }
  if (typeof options?.maxPolicyAgeMs === 'number') {
    if (!Number.isFinite(options.maxPolicyAgeMs) || options.maxPolicyAgeMs < 0) {
      throw new Error('Policy sync maxPolicyAgeMs must be a finite non-negative number.');
    }
  }
  if (typeof options?.maxFutureSkewMs === 'number') {
    if (!Number.isFinite(options.maxFutureSkewMs) || options.maxFutureSkewMs < 0) {
      throw new Error('Policy sync maxFutureSkewMs must be a finite non-negative number.');
    }
  }
  const issuedAtMs = Date.parse(document.issuedAt);
  if (Number.isNaN(issuedAtMs)) {
    throw new Error('Policy sync payload contains invalid issuedAt timestamp.');
  }
  const maxFutureSkewMs = options?.maxFutureSkewMs ?? 0;
  if (issuedAtMs > now.getTime() + maxFutureSkewMs) {
    throw new Error('Policy sync payload issuedAt is in the future.');
  }

  if (typeof options?.maxPolicyAgeMs === 'number') {
    const ageMs = now.getTime() - issuedAtMs;
    if (ageMs > options.maxPolicyAgeMs) {
      throw new Error('Policy sync payload is older than allowed maxPolicyAgeMs.');
    }
  }

  if (document.expiresAt) {
    const expiresAtMs = Date.parse(document.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new Error('Policy sync payload contains invalid expiresAt timestamp.');
    }
    if (expiresAtMs < issuedAtMs) {
      throw new Error('Policy sync payload expiresAt is earlier than issuedAt.');
    }
    if (now.getTime() > expiresAtMs) {
      throw new Error('Policy sync payload is expired.');
    }
  }
}

function buildRequestHeaders(bearerToken: string, overrideHeaders?: HeadersInit): Headers {
  const headers = new Headers(overrideHeaders);
  headers.set('Authorization', `Bearer ${bearerToken}`);
  headers.set('Accept', 'application/json');
  return headers;
}

async function buildFetchInit(options: PolicySyncOptions | undefined, bearerToken: string): Promise<RequestInit> {
  let transportOverrides: RequestInit = options?.fetchInitOverrides ?? {};

  if (options?.mutualTlsClientConfig) {
    const mtlsOverrides = await createMutualTlsFetchInitOverrides(options.mutualTlsClientConfig, options.mutualTlsAgentFactory);
    transportOverrides = {
      ...mtlsOverrides,
      ...transportOverrides
    };
  }

  return {
    ...transportOverrides,
    headers: buildRequestHeaders(bearerToken, transportOverrides.headers)
  };
}

export async function syncPolicyFromServer(
  api: EmbeddedWebAppApi,
  endpoint: string,
  bearerToken: string,
  sharedSecret: string,
  options?: PolicySyncOptions
): Promise<void> {
  assertHttpsEndpoint(endpoint);
  const fetchImpl = options?.fetchImpl ?? fetch;
  const fetchInit = await buildFetchInit(options, bearerToken);

  const response = await fetchImpl(endpoint, fetchInit);

  if (!response.ok) {
    throw new Error(`Policy sync failed with HTTP ${response.status}`);
  }

  if (options?.pinnedFingerprint) {
    const responseFingerprint = response.headers.get('x-cert-sha256');
    if (!responseFingerprint) {
      throw new Error('Policy sync response missing certificate fingerprint header.');
    }
    assertPinnedCertificate(responseFingerprint, options.pinnedFingerprint);
  }

  if (options?.requireMutualTls) {
    if (!options.pinnedFingerprint && !options.allowUnpinnedMutualTlsAttestation) {
      throw new Error('mTLS attestation requires pinnedFingerprint unless explicitly overridden.');
    }
    const headerName = options.mutualTlsHeaderName ?? 'x-mtls-client-auth';
    const expectedValue = options.mutualTlsExpectedValue ?? 'success';
    assertMutualTlsVerified(response.headers.get(headerName), expectedValue);
  }

  const payload = (await response.json()) as unknown;
  if (!isRemotePolicyEnvelope(payload)) {
    throw new Error('Policy sync payload shape is invalid.');
  }
  assertPolicyFreshness(payload.document, options);

  await applySignedPolicyUpdate(api, payload.document, payload.signature, sharedSecret);
}

export async function syncPolicyFromServerWithTokenProvider(
  api: EmbeddedWebAppApi,
  endpoint: string,
  tokenProvider: () => Promise<string>,
  sharedSecret: string,
  options?: PolicySyncOptions
): Promise<void> {
  const token = await tokenProvider();
  await syncPolicyFromServer(api, endpoint, token, sharedSecret, options);
}
