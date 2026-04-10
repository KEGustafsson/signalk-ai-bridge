export interface EmbeddedWebAppApi {
  readonly isLoggedIn?: boolean;
  readonly login?: () => void;
  readonly get?: <T>(path: string) => Promise<T>;
  readonly setApplicationData?: (path: string, value: unknown) => Promise<void>;
  readonly getApplicationData?: <T>(path: string) => Promise<T>;
}

export interface ApiError {
  readonly code: 'unauthorized' | 'validation-failed' | 'timeout' | 'unknown';
  readonly message: string;
}

export interface VesselPosition {
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface VesselSnapshot {
  readonly timestamp?: string;
  readonly position?: VesselPosition;
  readonly speedOverGround?: number;
  readonly courseOverGroundTrue?: number;
}

export interface AlarmSummary {
  readonly path: string;
  readonly state?: string;
  readonly message?: string;
}

export interface RecentDelta {
  readonly path: string;
  readonly value: unknown;
  readonly source?: string;
  readonly timestamp?: string;
}

export interface WaypointDraft {
  readonly id: string;
  readonly createdAt: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly status: 'draft';
}
