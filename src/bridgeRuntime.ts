import { createWaypointDraft, getActiveAlarms, getRecentDeltas, getVesselSnapshot } from './api.js';
import { appendAuditEntry } from './audit.js';
import type { ToolId, ToolResult } from './contracts.js';
import type { AppPanelProps } from './panelTypes.js';
import { authorizeTool } from './policy.js';

export interface BridgeRequest {
  readonly toolId: ToolId;
  readonly draftName?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

export async function executeBridgeRequest(
  api: AppPanelProps,
  request: BridgeRequest,
  providedToken: string,
  expectedToken: string
): Promise<ToolResult> {
  if (!constantTimeEquals(providedToken, expectedToken)) {
    await appendAuditEntry(api, request.toolId, 'denied', 'Invalid bridge auth token');
    return {
      type: 'error',
      error: {
        code: 'unauthorized',
        message: 'Invalid bridge auth token.'
      }
    };
  }

  try {
    await authorizeTool(api, request.toolId);
    await appendAuditEntry(api, request.toolId, 'allowed');

    switch (request.toolId) {
      case 'get-vessel-snapshot':
        return {
          type: 'get-vessel-snapshot-result',
          snapshot: await getVesselSnapshot(api)
        };
      case 'get-active-alarms':
        return {
          type: 'get-active-alarms-result',
          alarms: await getActiveAlarms(api)
        };
      case 'get-recent-deltas':
        return {
          type: 'get-recent-deltas-result',
          deltas: await getRecentDeltas(api)
        };
      case 'create-waypoint-draft':
        return {
          type: 'create-waypoint-draft-result',
          draft: await createWaypointDraft(
            api,
            request.draftName ?? 'New waypoint draft',
            request.latitude ?? Number.NaN,
            request.longitude ?? Number.NaN
          )
        };
      default:
        return {
          type: 'error',
          error: {
            code: 'validation-failed',
            message: 'Unknown tool id.'
          }
        };
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
      const apiError = error as { code: 'unauthorized' | 'validation-failed' | 'timeout' | 'unknown'; message: string };
      await appendAuditEntry(api, request.toolId, apiError.code === 'unauthorized' ? 'denied' : 'error', apiError.message);
      return {
        type: 'error',
        error: apiError
      };
    }

    const message = error instanceof Error ? error.message : 'Unknown runtime error.';
    await appendAuditEntry(api, request.toolId, 'error', message);
    return {
      type: 'error',
      error: {
        code: 'unknown',
        message
      }
    };
  }
}
