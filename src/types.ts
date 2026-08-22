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
  readonly performance?: AiPerformance;
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

export type AcceleratorState = 'gpu' | 'partial' | 'cpu' | 'not-loaded' | 'unknown';

export interface AcceleratorStatus {
  /** False when the backend cannot report a CPU/GPU split (TensorRT-LLM). */
  readonly supported: boolean;
  readonly state: AcceleratorState;
  readonly model?: string;
  readonly totalBytes?: number;
  readonly vramBytes?: number;
  readonly vramRatio?: number;
  readonly expiresAt?: string;
  readonly loadedModels?: number;
  readonly message: string;
}

export interface AiPerformance {
  readonly totalMs?: number;
  readonly loadMs?: number;
  readonly promptEvalMs?: number;
  readonly evalMs?: number;
  readonly tokensPerSecond?: number;
}
