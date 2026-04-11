import type { AlarmSummary, ApiError, RecentDelta, VesselSnapshot, WaypointDraft } from './types.js';

export type ToolId =
  | 'get-vessel-snapshot'
  | 'get-recent-deltas'
  | 'get-active-alarms'
  | 'create-waypoint-draft';

export interface GetVesselSnapshotResult {
  readonly type: 'get-vessel-snapshot-result';
  readonly snapshot: VesselSnapshot;
}

export interface GetRecentDeltasResult {
  readonly type: 'get-recent-deltas-result';
  readonly deltas: readonly RecentDelta[];
}

export interface GetActiveAlarmsResult {
  readonly type: 'get-active-alarms-result';
  readonly alarms: readonly AlarmSummary[];
}

export interface CreateWaypointDraftResult {
  readonly type: 'create-waypoint-draft-result';
  readonly draft: WaypointDraft;
}

export interface ToolErrorResult {
  readonly type: 'error';
  readonly error: ApiError;
}

export type ToolResult =
  | GetVesselSnapshotResult
  | GetRecentDeltasResult
  | GetActiveAlarmsResult
  | CreateWaypointDraftResult
  | ToolErrorResult;
