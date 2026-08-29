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

export interface JetsonPowerMode {
  readonly id: number;
  readonly name?: string;
  readonly isMaximum: boolean;
  readonly maximumId?: number;
  readonly maximumName?: string;
}

/** Read from the Tegra GPU's device-tree node name; there is no nvidia-smi on L4T. */
export interface JetsonGpu {
  /** Device-tree node, e.g. `gv11b` (Xavier) or `ga10b` (Orin). */
  readonly node: string;
  readonly architecture: string;
  readonly computeCapability: number;
}

export interface JetsonTelemetry {
  readonly present: boolean;
  readonly model?: string;
  readonly l4tVersion?: string;
  readonly gpu?: JetsonGpu;
  readonly powerMode?: JetsonPowerMode;
  readonly gpuLoadPercent?: number;
  readonly gpuClockHz?: number;
  readonly gpuMaxClockHz?: number;
  readonly gpuTemperatureC?: number;
  readonly warnings?: readonly string[];
  readonly message?: string;
}

export interface AcceleratorAutoTune {
  readonly enabled: boolean;
  readonly tuned: boolean;
  readonly numCtx?: number;
  readonly numGpu?: number;
  readonly reason?: string;
}

export interface KvCacheHint {
  /** True when the backend already runs a quantized KV cache. */
  readonly quantized: boolean;
  readonly savingBytes?: number;
  readonly numCtx?: number;
  readonly likelyCacheType?: string;
  readonly observedOverheadBytes?: number;
  readonly message: string;
}

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
  readonly autoTune?: AcceleratorAutoTune;
  readonly cache?: KvCacheHint;
  readonly jetson?: JetsonTelemetry;
}

export interface AiPerformance {
  readonly totalMs?: number;
  readonly loadMs?: number;
  readonly promptEvalMs?: number;
  readonly evalMs?: number;
  readonly tokensPerSecond?: number;
}
