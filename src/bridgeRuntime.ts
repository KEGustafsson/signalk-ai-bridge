import type {
  AskVesselAiResult,
  ToolId,
  ToolResult
} from './contracts.js';
import type { AppPanelProps } from './panelTypes.js';
import type { AiChatMessage, ApiError } from './types.js';

export interface BridgeRequest {
  readonly toolId: ToolId;
  readonly draftName?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly prompt?: string;
}

const DEFAULT_BRIDGE_ENDPOINT = '/plugins/signalk-ai-bridge/bridge/execute';

function toApiError(message: string, code: ApiError['code'] = 'unknown'): ApiError {
  return { code, message };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiError(value: unknown): value is ApiError {
  return isObjectRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

function isAiChatMessage(value: unknown): value is AiChatMessage {
  return (
    isObjectRecord(value) &&
    (value.role === 'system' || value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string'
  );
}

function isAskVesselAiResult(value: unknown): value is AskVesselAiResult {
  return (
    isObjectRecord(value) &&
    value.type === 'ask-vessel-ai-result' &&
    typeof value.prompt === 'string' &&
    (value.context === undefined || isObjectRecord(value.context)) &&
    (value.requestMessages === undefined ||
      (Array.isArray(value.requestMessages) && value.requestMessages.every(isAiChatMessage))) &&
    isObjectRecord(value.response)
  );
}

function isToolErrorResult(value: unknown): value is ToolResult {
  return isObjectRecord(value) && value.type === 'error' && isApiError(value.error);
}

function isToolResult(value: unknown): value is ToolResult {
  return isAskVesselAiResult(value) || isToolErrorResult(value);
}

function parseRemoteError(value: unknown): string | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  if (typeof value.message === 'string') {
    return value.message;
  }

  if (isObjectRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message;
  }

  return undefined;
}

function toToolErrorResult(error: ApiError): ToolResult {
  return {
    type: 'error',
    error
  };
}

export async function executeBridgeRequest(
  api: AppPanelProps,
  request: BridgeRequest
): Promise<ToolResult> {
  const fetchImpl = api.bridgeFetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return toToolErrorResult(toApiError('Global fetch is not available for bridge requests.'));
  }

  try {
    const response = await fetchImpl(api.bridgeEndpoint ?? DEFAULT_BRIDGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify(request)
    });

    let payload: unknown = undefined;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      return toToolErrorResult(
        toApiError(
          parseRemoteError(payload) ?? `Bridge request failed with status ${response.status}.`,
          response.status === 401 ? 'unauthorized' : response.status === 400 ? 'validation-failed' : 'unknown'
        )
      );
    }

    if (!isToolResult(payload)) {
      return toToolErrorResult(toApiError('Bridge route returned an invalid response payload.'));
    }

    return payload;
  } catch (error) {
    return toToolErrorResult(
      toApiError(error instanceof Error ? error.message : 'Unknown bridge request failure.')
    );
  }
}
