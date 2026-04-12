export interface EmbeddedWebAppApi {
  readonly isLoggedIn?: boolean;
  readonly login?: () => void;
  readonly loginStatus?: {
    readonly status?: 'notLoggedIn' | 'loggedIn';
    readonly authenticationRequired?: boolean;
    readonly readOnlyAccess?: boolean;
    readonly username?: string;
    readonly [key: string]: unknown;
  };
}

export interface ApiError {
  readonly code: 'unauthorized' | 'validation-failed' | 'timeout' | 'unknown';
  readonly message: string;
}

export interface AiTokenUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface AiBridgeResponse {
  readonly answer: string;
  readonly model: string;
  readonly createdAt: string;
  readonly usage?: AiTokenUsage;
}

export interface AiChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface AiRequestContext {
  readonly serverId?: string;
  readonly aiDataPaths?: readonly string[];
  readonly selectedData?: Record<string, unknown>;
}
