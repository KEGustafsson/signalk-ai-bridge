import { APP_DATA_KEYS, SIGNALK_PATHS } from './signalkPaths.js';
import type { EmbeddedWebAppApi } from './types.js';

export type PathAccessMode = 'read-only' | 'read-write';
export type RequestedMode = 'read' | 'write';

interface PathAccessRule {
  readonly path: string;
  readonly access: PathAccessMode;
}

const SELF_API_PREFIX = `${SIGNALK_PATHS.selfVessel}/`;

function toLogicalPath(path: string): string {
  if (path.startsWith(SELF_API_PREFIX)) {
    return path.slice(SELF_API_PREFIX.length).replace(/\//g, '.');
  }
  return path.replace(/^\//, '');
}

function isValidRule(value: unknown): value is PathAccessRule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    (candidate.access === 'read-only' || candidate.access === 'read-write')
  );
}

function matchPattern(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const expression = new RegExp(`^${escaped}$`);
  return expression.test(path);
}

function isAllowed(rule: PathAccessRule, mode: RequestedMode): boolean {
  return rule.access === 'read-write' || (rule.access === 'read-only' && mode === 'read');
}

export async function assertSignalkPathAccess(
  api: EmbeddedWebAppApi,
  path: string,
  mode: RequestedMode
): Promise<void> {
  const configuredRules = await api.getApplicationData?.<unknown>(APP_DATA_KEYS.pathAccessRules);
  if (!Array.isArray(configuredRules) || configuredRules.length === 0) {
    return;
  }

  const rules = configuredRules.filter(isValidRule);
  if (rules.length === 0) {
    return;
  }

  const logicalPath = toLogicalPath(path);
  const grantsAccess = rules.some((rule) => matchPattern(rule.path, logicalPath) && isAllowed(rule, mode));
  if (!grantsAccess) {
    throw {
      code: 'unauthorized',
      message: `Path access denied for ${logicalPath} (${mode}).`
    };
  }
}
