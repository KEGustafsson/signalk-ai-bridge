import type {
  AiChatMessage,
  AiBridgeResponse,
  AiRequestContext,
  ApiError
} from './types.js';

export type ToolId = 'ask-vessel-ai';

export interface AskVesselAiResult {
  readonly type: 'ask-vessel-ai-result';
  readonly prompt: string;
  readonly context?: AiRequestContext;
  readonly requestMessages?: readonly AiChatMessage[];
  readonly response: AiBridgeResponse;
}

export interface ToolErrorResult {
  readonly type: 'error';
  readonly error: ApiError;
}

export type ToolResult = AskVesselAiResult | ToolErrorResult;
