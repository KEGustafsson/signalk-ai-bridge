import type { ToolId } from './contracts.js';
import type { EmbeddedWebAppApi } from './types.js';

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly toolId: ToolId;
  readonly outcome: 'allowed' | 'denied' | 'error';
  readonly message?: string;
}

const AUDIT_KEY = 'ai-bridge/audit-log';
const MAX_AUDIT_ENTRIES = 100;

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `audit-${crypto.randomUUID()}`;
  }

  return `audit-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function toAuditArray(value: unknown): readonly AuditEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === 'object' && entry !== null) as readonly AuditEntry[];
}

export async function appendAuditEntry(
  api: EmbeddedWebAppApi,
  toolId: ToolId,
  outcome: AuditEntry['outcome'],
  message?: string
): Promise<void> {
  if (!api.getApplicationData || !api.setApplicationData) {
    return;
  }

  const existing = await api.getApplicationData?.<unknown>(AUDIT_KEY);
  const current = toAuditArray(existing);

  const entry: AuditEntry = {
    id: createId(),
    at: new Date().toISOString(),
    toolId,
    outcome,
    message
  };

  const next = [entry, ...current].slice(0, MAX_AUDIT_ENTRIES);
  await api.setApplicationData(AUDIT_KEY, next);
}
