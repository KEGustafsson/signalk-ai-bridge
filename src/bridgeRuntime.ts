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
const STREAM_PATH_SUFFIX = '/bridge/stream';

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

function toStreamEndpoint(api: AppPanelProps): string {
  const endpoint = api.bridgeEndpoint ?? DEFAULT_BRIDGE_ENDPOINT;
  return endpoint.replace(/\/bridge\/execute$/, STREAM_PATH_SUFFIX);
}

function isTokenLine(value: unknown): value is { type: 'token'; text: string } {
  return isObjectRecord(value) && value.type === 'token' && typeof value.text === 'string';
}

/**
 * Stream the answer, calling `onToken` for each fragment.
 *
 * The resolved ToolResult is authoritative — it carries the model name, usage
 * and timings that only arrive with the final line — so callers should render
 * tokens for immediacy and then replace the text with the result's answer.
 *
 * Falls back to the blocking endpoint whenever streaming is not usable: an old
 * plugin build with no /bridge/stream route, or a browser without a readable
 * response body. Nothing has been emitted at that point, so the fallback cannot
 * duplicate text.
 */
export async function streamBridgeRequest(
  api: AppPanelProps,
  request: BridgeRequest,
  onToken: (text: string) => void
): Promise<ToolResult> {
  const fetchImpl = api.bridgeFetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return toToolErrorResult(toApiError('Global fetch is not available for bridge requests.'));
  }

  let response: Response;
  try {
    response = await fetchImpl(toStreamEndpoint(api), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(request)
    });
  } catch {
    return executeBridgeRequest(api, request);
  }

  if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
    return executeBridgeRequest(api, request);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: ToolResult | undefined;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A truncated or malformed line is not worth failing the whole answer
      // over; the final result line is what the caller actually needs.
      return;
    }

    if (isTokenLine(parsed)) {
      onToken(parsed.text);
      return;
    }
    if (isToolResult(parsed)) {
      final = parsed;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    }
    consumeLine(buffer);
  } catch (error) {
    return toToolErrorResult(
      toApiError(error instanceof Error ? error.message : 'Bridge stream failed.')
    );
  }

  return final ?? toToolErrorResult(toApiError('Bridge stream ended without a result.'));
}
