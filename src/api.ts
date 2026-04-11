import type {
  AlarmSummary,
  ApiError,
  EmbeddedWebAppApi,
  RecentDelta,
  VesselSnapshot,
  VesselPosition,
  WaypointDraft
} from './types.js';
import { assertSignalkPathAccess } from './pathAccess.js';
import { APP_DATA_KEYS, SIGNALK_PATHS } from './signalkPaths.js';

const MAX_TRACKED_DELTA_KEYS = 50;

function toApiError(message: string, code: ApiError['code'] = 'unknown'): ApiError {
  return { code, message };
}

function parsePosition(value: unknown): VesselPosition | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const latitude = 'latitude' in value ? Number((value as Record<string, unknown>).latitude) : undefined;
  const longitude = 'longitude' in value ? Number((value as Record<string, unknown>).longitude) : undefined;

  return {
    latitude: Number.isFinite(latitude) ? latitude : undefined,
    longitude: Number.isFinite(longitude) ? longitude : undefined
  };
}

export function flattenObject(input: unknown, prefix = ''): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return prefix ? { [prefix]: input } : {};
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flattenObject(value, path));
    } else {
      out[path] = value;
    }
  }

  return out;
}

export function shallowEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function getVesselSnapshot(api: EmbeddedWebAppApi): Promise<VesselSnapshot> {
  if (!api.get) {
    throw toApiError('Signal K API function `get` is not available.');
  }
  await Promise.all([
    assertSignalkPathAccess(api, SIGNALK_PATHS.selfNavigationPosition, 'read'),
    assertSignalkPathAccess(api, SIGNALK_PATHS.selfNavigationSog, 'read'),
    assertSignalkPathAccess(api, SIGNALK_PATHS.selfNavigationCogt, 'read')
  ]);

  const [positionRaw, sogRaw, cogRaw] = await Promise.all([
    api.get<unknown>(SIGNALK_PATHS.selfNavigationPosition),
    api.get<unknown>(SIGNALK_PATHS.selfNavigationSog),
    api.get<unknown>(SIGNALK_PATHS.selfNavigationCogt)
  ]);

  const speedOverGround = Number(sogRaw as number);
  const courseOverGroundTrue = Number(cogRaw as number);

  return {
    timestamp: new Date().toISOString(),
    position: parsePosition(positionRaw),
    speedOverGround: Number.isFinite(speedOverGround) ? speedOverGround : undefined,
    courseOverGroundTrue: Number.isFinite(courseOverGroundTrue) ? courseOverGroundTrue : undefined
  };
}

export async function getActiveAlarms(api: EmbeddedWebAppApi): Promise<readonly AlarmSummary[]> {
  if (!api.get) {
    throw toApiError('Signal K API function `get` is not available.');
  }
  await assertSignalkPathAccess(api, SIGNALK_PATHS.selfAlarms, 'read');

  const notifications = await api.get<unknown>(SIGNALK_PATHS.selfAlarms);
  if (typeof notifications !== 'object' || notifications === null) {
    return [];
  }

  return Object.entries(notifications as Record<string, unknown>).map(([path, value]) => {
    if (typeof value !== 'object' || value === null) {
      return { path };
    }

    const notification = value as Record<string, unknown>;
    return {
      path,
      state: typeof notification.state === 'string' ? notification.state : undefined,
      message: typeof notification.message === 'string' ? notification.message : undefined
    };
  });
}

export async function getRecentDeltas(api: EmbeddedWebAppApi): Promise<readonly RecentDelta[]> {
  if (!api.get) {
    throw toApiError('Signal K API function `get` is not available.');
  }
  await assertSignalkPathAccess(api, SIGNALK_PATHS.selfNavigation, 'read');

  const currentSelf = await api.get<unknown>(SIGNALK_PATHS.selfNavigation);
  const currentFlat = flattenObject(currentSelf);

  const previousFlat =
    (await api.getApplicationData?.<Record<string, unknown>>(APP_DATA_KEYS.lastFlattenedSnapshot)) ?? {};

  const changed = Object.entries(currentFlat)
    .filter(([path, value]) => !shallowEqual(previousFlat[path], value))
    .slice(0, MAX_TRACKED_DELTA_KEYS)
    .map(([path, value]) => ({
      path,
      value,
      source: 'vessels.self.navigation',
      timestamp: new Date().toISOString()
    }));

  if (api.setApplicationData) {
    await api.setApplicationData(APP_DATA_KEYS.lastFlattenedSnapshot, currentFlat);
  }

  return changed;
}

export async function createWaypointDraft(
  api: EmbeddedWebAppApi,
  name: string,
  latitude: number,
  longitude: number
): Promise<WaypointDraft> {
  await assertSignalkPathAccess(api, 'navigation.waypoints', 'write');

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw toApiError('Latitude and longitude must be valid finite numbers.', 'validation-failed');
  }

  if (latitude < -90 || latitude > 90) {
    throw toApiError('Latitude must be between -90 and 90.', 'validation-failed');
  }

  if (longitude < -180 || longitude > 180) {
    throw toApiError('Longitude must be between -180 and 180.', 'validation-failed');
  }

  const draft: WaypointDraft = {
    id: `draft-${Date.now()}`,
    createdAt: new Date().toISOString(),
    name,
    latitude,
    longitude,
    status: 'draft'
  };

  if (api.setApplicationData) {
    await api.setApplicationData(APP_DATA_KEYS.lastWaypointDraft, draft);
  }

  return draft;
}
