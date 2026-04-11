import type { ToolId } from './contracts.js';
import type { ApiError, EmbeddedWebAppApi } from './types.js';

const TOOL_POLICY_KEY = 'ai-bridge/allowed-tools';
const USER_ROLE_KEY = 'ai-bridge/user-role';
const POLICY_VERSION_KEY = 'ai-bridge/policy-version';

const ROLE_TOOL_PERMISSIONS: Record<UserRole, readonly ToolId[]> = {
  viewer: ['get-vessel-snapshot', 'get-active-alarms', 'get-recent-deltas'],
  operator: ['get-vessel-snapshot', 'get-active-alarms', 'get-recent-deltas', 'create-waypoint-draft'],
  admin: ['get-vessel-snapshot', 'get-active-alarms', 'get-recent-deltas', 'create-waypoint-draft']
};

export type UserRole = 'viewer' | 'operator' | 'admin';

export interface PolicyDocument {
  readonly version: number;
  readonly role: UserRole;
  readonly allowedTools: readonly ToolId[];
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

function unauthorized(message: string): ApiError {
  return {
    code: 'unauthorized',
    message
  };
}

function isUserRole(value: unknown): value is UserRole {
  return value === 'viewer' || value === 'operator' || value === 'admin';
}

function canonicalizePolicyDocument(document: PolicyDocument): string {
  return JSON.stringify({
    allowedTools: [...document.allowedTools].sort(),
    expiresAt: document.expiresAt ?? null,
    issuedAt: document.issuedAt,
    role: document.role,
    version: document.version
  });
}

function decodeHex(hex: string): Uint8Array {
  const pairs = hex.match(/.{1,2}/g) ?? [];
  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return encodeHex(new Uint8Array(signature));
}

export async function signPolicyDocument(document: PolicyDocument, secret: string): Promise<string> {
  return hmacSha256(secret, canonicalizePolicyDocument(document));
}

export async function verifyPolicyDocumentSignature(
  document: PolicyDocument,
  signatureHex: string,
  secret: string
): Promise<boolean> {
  const expectedHex = await signPolicyDocument(document, secret);
  const expected = decodeHex(expectedHex);
  const received = decodeHex(signatureHex);

  if (expected.length !== received.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected[index]! ^ received[index]!;
  }

  return diff === 0;
}

async function getUserRole(api: EmbeddedWebAppApi): Promise<UserRole> {
  const configuredRole = await api.getApplicationData?.<unknown>(USER_ROLE_KEY);
  if (isUserRole(configuredRole)) {
    return configuredRole;
  }

  return 'viewer';
}

export async function authorizeTool(api: EmbeddedWebAppApi, toolId: ToolId): Promise<void> {
  if (api.isLoggedIn === false) {
    throw unauthorized('User is not authenticated.');
  }

  const role = await getUserRole(api);
  if (!ROLE_TOOL_PERMISSIONS[role].includes(toolId)) {
    throw unauthorized(`Role \`${role}\` cannot execute tool \`${toolId}\`.`);
  }

  const configuredAllowList = await api.getApplicationData?.<readonly string[]>(TOOL_POLICY_KEY);
  if (!configuredAllowList || configuredAllowList.length === 0) {
    return;
  }

  if (!configuredAllowList.includes(toolId)) {
    throw unauthorized(`Tool \`${toolId}\` is not authorized by policy allow-list.`);
  }
}

export async function applySignedPolicyUpdate(
  api: EmbeddedWebAppApi,
  document: PolicyDocument,
  signatureHex: string,
  secret: string
): Promise<void> {
  if (!api.setApplicationData) {
    return;
  }

  const isValid = await verifyPolicyDocumentSignature(document, signatureHex, secret);
  if (!isValid) {
    throw unauthorized('Signed policy verification failed.');
  }

  if (document.expiresAt && new Date(document.expiresAt).getTime() < Date.now()) {
    throw unauthorized('Policy document is expired.');
  }

  await api.setApplicationData(USER_ROLE_KEY, document.role);
  await api.setApplicationData(TOOL_POLICY_KEY, [...document.allowedTools]);
  await api.setApplicationData(POLICY_VERSION_KEY, document.version);
}
