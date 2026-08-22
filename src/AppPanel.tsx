import React from 'react';
import { executeBridgeRequest } from './bridgeRuntime.js';
import type { AskVesselAiResult, ToolResult } from './contracts.js';
import type { AppPanelProps } from './panelTypes.js';
import type { AcceleratorStatus, AiChatMessage } from './types.js';

interface AiInput {
  readonly prompt: string;
}

interface AiRequestLogEntry {
  readonly id: string;
  readonly askedAt: string;
  readonly promptPreview: string;
  readonly outcome: 'pending' | 'success' | 'error';
  readonly model?: string;
  readonly errorMessage?: string;
  readonly requestText?: string;
}

interface BackendStatus {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly model: string;
  readonly backend?: string;
  readonly requestTimeoutMs: number;
  readonly maxTokens?: number;
  readonly numCtx?: number;
  readonly configuredNumCtx?: number;
  readonly numGpu?: number;
  readonly numBatch?: number;
  readonly numThread?: number;
  readonly keepAlive?: string;
  readonly accelerator?: AcceleratorStatus;
  readonly aiDataPaths?: readonly string[];
  readonly signalKSelfId?: string;
  readonly aiAvailable?: boolean;
  readonly ollamaReachable?: boolean;
  readonly modelAvailable?: boolean;
  readonly resolvedModel?: string;
  readonly availabilityMessage?: string;
}

function getLoginState(props: AppPanelProps): boolean | undefined {
  if (typeof props.isLoggedIn === 'boolean') {
    return props.isLoggedIn;
  }

  const status = props.loginStatus?.status;
  if (status === 'loggedIn') {
    return true;
  }
  if (status === 'notLoggedIn') {
    return false;
  }

  return undefined;
}

function getStatusEndpoint(props: AppPanelProps): string {
  if (typeof props.bridgeEndpoint === 'string' && props.bridgeEndpoint.length > 0) {
    return props.bridgeEndpoint.replace(/\/bridge\/execute$/, '/ai/status');
  }

  return '/plugins/signalk-ai-bridge/ai/status';
}

function formatTimestamp(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'Unavailable';
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

function formatTimeoutLabel(timeoutMs: number | undefined): string {
  if (typeof timeoutMs !== 'number') {
    return 'Unavailable';
  }

  return timeoutMs === 0 ? 'Disabled' : `${timeoutMs} ms`;
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** exponent;
  return `${scaled.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatBackendLabel(backend: string | undefined): string {
  return backend === 'tensorrt-llm' ? 'TensorRT-LLM (CUDA engine)' : 'Ollama (llama.cpp CUDA)';
}

interface AcceleratorPresentation {
  readonly label: string;
  readonly background: string;
  readonly border: string;
  readonly color: string;
}

function describeAccelerator(accelerator: AcceleratorStatus | undefined): AcceleratorPresentation {
  switch (accelerator?.state) {
    case 'gpu':
      return { label: 'GPU accelerated', background: '#f0fdf4', border: '#86efac', color: '#166534' };
    case 'partial':
      return { label: 'Partly on CPU', background: '#fff7ed', border: '#fdba74', color: '#9a3412' };
    case 'cpu':
      return { label: 'CPU only', background: '#fef2f2', border: '#fca5a5', color: '#991b1b' };
    case 'not-loaded':
      return { label: 'Model not loaded', background: '#f8fafc', border: '#cbd5e1', color: '#475569' };
    default:
      return { label: 'Unknown', background: '#f8fafc', border: '#cbd5e1', color: '#475569' };
  }
}

function formatClock(currentHz: number | undefined, maxHz: number | undefined): string {
  if (typeof currentHz !== 'number' || !Number.isFinite(currentHz) || currentHz <= 0) {
    return '';
  }

  const current = `${Math.round(currentHz / 1e6)} MHz`;
  if (typeof maxHz !== 'number' || !Number.isFinite(maxHz) || maxHz <= 0) {
    return ` at ${current}`;
  }

  return ` at ${current} of ${Math.round(maxHz / 1e6)} MHz`;
}

function formatThroughput(tokensPerSecond: number | undefined): string | undefined {
  if (typeof tokensPerSecond !== 'number' || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    return undefined;
  }

  return `${tokensPerSecond.toFixed(1)} tokens/s`;
}

function shouldShowReadmeHelp(status: BackendStatus | null): boolean {
  if (!status) {
    return false;
  }

  if (status.aiAvailable === false) {
    return true;
  }

  if (status.ollamaReachable === false || status.modelAvailable === false) {
    return true;
  }

  if (
    typeof status.availabilityMessage === 'string' &&
    /not installed|not available|could not reach|failed to list|timed out/i.test(status.availabilityMessage)
  ) {
    return true;
  }

  return false;
}

function canAskAi(status: BackendStatus | null): boolean {
  return status?.aiAvailable === true;
}

function getLoadingLabel(status: BackendStatus | null): string {
  const modelName = status?.resolvedModel ?? status?.model;
  return typeof modelName === 'string' && modelName.trim().length > 0
    ? `Waiting for AI response from ${modelName}...`
    : 'Waiting for AI response...';
}

function formatAiRequestMessages(messages: readonly AiChatMessage[] | undefined, fallbackPrompt: string): string {
  if (!messages || messages.length === 0) {
    return fallbackPrompt.trim().length > 0 ? fallbackPrompt : '(empty prompt)';
  }

  return messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join('\n\n');
}

function createPromptPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) {
    return normalized.length > 0 ? normalized : '(empty prompt)';
  }

  return `${normalized.slice(0, 117)}...`;
}

function getAskAiRequestText(result: AskVesselAiResult, fallbackPrompt: string): string {
  return formatAiRequestMessages(result.requestMessages, result.prompt || fallbackPrompt);
}

async function runTool(
  props: AppPanelProps,
  aiInput: AiInput
): Promise<ToolResult> {
  return executeBridgeRequest(props, {
    toolId: 'ask-vessel-ai',
    prompt: aiInput.prompt
  });
}

export default function AppPanel(props: AppPanelProps) {
  const [toolResult, setToolResult] = React.useState<ToolResult | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [aiRequestLog, setAiRequestLog] = React.useState<AiRequestLogEntry[]>([]);
  const [backendStatus, setBackendStatus] = React.useState<BackendStatus | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = React.useState<boolean>(false);
  const [isReadmeHelpOpen, setIsReadmeHelpOpen] = React.useState<boolean>(false);
  const [openHistoryRequestIds, setOpenHistoryRequestIds] = React.useState<Record<string, boolean>>({});
  const [aiInput, setAiInput] = React.useState<AiInput>({
    prompt: 'Summarize the vessel state and call out anything that needs operator attention.'
  });

  const loginState = getLoginState(props);
  const authLabel = React.useMemo(() => {
    if (loginState === true) {
      return 'Authenticated';
    }

    if (loginState === false) {
      return 'Not authenticated';
    }

    return 'Authentication status unavailable';
  }, [loginState]);
  const authHelpText = React.useMemo(() => {
    if (loginState === true) {
      return 'This browser session is logged into Signal K, so Ask AI requests are allowed.';
    }
    if (loginState === false) {
      return 'This browser session is not logged into Signal K. Ask AI requests will be rejected until you log in.';
    }
    return 'The embedded UI did not provide login state, so the panel cannot tell whether Ask AI requests will be accepted until one is attempted.';
  }, [loginState]);

  React.useEffect(() => {
    const fetchImpl = props.bridgeFetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      return;
    }

    let isActive = true;

    fetchImpl(getStatusEndpoint(props), {
      method: 'GET',
      credentials: 'include'
    })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        const payload = await response.json();
        return payload as BackendStatus;
      })
      .then((payload) => {
        if (isActive && payload) {
          setBackendStatus(payload);
        }
      })
      .catch(() => {
        if (isActive) {
          setBackendStatus(null);
        }
      });

    return () => {
      isActive = false;
    };
  }, [props]);

  const onAskAi = React.useCallback(async () => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    setIsLoading(true);
    const trimmedPrompt = aiInput.prompt.trim();
    setAiRequestLog((previous) => {
      const pendingEntry: AiRequestLogEntry = {
        id: requestId,
        askedAt: new Date().toISOString(),
        promptPreview: createPromptPreview(trimmedPrompt),
        outcome: 'pending'
      };

      return [pendingEntry, ...previous].slice(0, 12);
    });

    try {
      const result = await runTool(props, aiInput);
      setToolResult(result);
      setAiRequestLog((previous) =>
        previous.map((entry) =>
          entry.id === requestId
            ? {
                ...entry,
                promptPreview: createPromptPreview(aiInput.prompt),
                outcome: result.type === 'error' ? 'error' : 'success',
                model: result.type === 'ask-vessel-ai-result' ? result.response.model : undefined,
                errorMessage: result.type === 'error' ? result.error.message : undefined,
                requestText: result.type === 'ask-vessel-ai-result'
                  ? getAskAiRequestText(result, aiInput.prompt)
                  : undefined
              }
            : entry
        )
      );
    } finally {
      setIsLoading(false);
    }
  }, [props, aiInput]);

  const acceleratorPresentation = React.useMemo(
    () => describeAccelerator(backendStatus?.accelerator),
    [backendStatus]
  );
  const jetson = backendStatus?.accelerator?.jetson;
  const autoTune = backendStatus?.accelerator?.autoTune;

  return (
    <section style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Signal K AI Bridge</h2>
      <p>
        Embedded Admin UI panel for sending selected Signal K data to Ollama and reviewing the exact AI request.
      </p>
      <div
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))'
        }}
      >
        <section
          style={{
            padding: '0.75rem',
            borderRadius: '8px',
            backgroundColor: '#f8fafc',
            border: '1px solid #cbd5e1'
          }}
        >
          <h3 style={{ marginTop: 0 }}>Signal K</h3>
          <p style={{ margin: 0 }}>
            UI access: {authLabel}
            <br />
            Self ID: {backendStatus?.signalKSelfId ?? props.serverId ?? 'Unavailable'}
          </p>
          <p style={{ marginBottom: 0, color: '#475569' }}>{authHelpText}</p>
        </section>

        <section
          style={{
            padding: '0.75rem',
            borderRadius: '8px',
            backgroundColor: '#f8fafc',
            border: '1px solid #cbd5e1'
          }}
        >
          <h3 style={{ marginTop: 0 }}>Ollama / Gemma</h3>
          <p style={{ margin: 0 }}>
            Backend: {backendStatus?.baseUrl ?? 'Unavailable'}
            <br />
            Model: {backendStatus?.model ?? 'Unavailable'}
            {backendStatus?.resolvedModel && backendStatus.resolvedModel !== backendStatus.model ? (
              <>
                <br />
                Using model: {backendStatus.resolvedModel}
              </>
            ) : null}
            <br />
            AI status: {backendStatus?.aiAvailable === undefined ? 'Unavailable' : backendStatus.aiAvailable ? 'Ready' : 'Unavailable'}
            <br />
            Timeout: {formatTimeoutLabel(backendStatus?.requestTimeoutMs)}
          </p>
          {backendStatus?.aiAvailable !== true ? (
            <p style={{ marginTop: '0.5rem', marginBottom: 0, color: '#475569' }}>
              Ollama reachable: {backendStatus?.ollamaReachable === undefined ? 'Unavailable' : backendStatus.ollamaReachable ? 'Yes' : 'No'}
              <br />
              Model available: {backendStatus?.modelAvailable === undefined ? 'Unavailable' : backendStatus.modelAvailable ? 'Yes' : 'No'}
              <br />
              Config enabled: {backendStatus ? (backendStatus.enabled ? 'Yes' : 'No') : 'Unavailable'}
            </p>
          ) : null}
          {shouldShowReadmeHelp(backendStatus) ? (
            <div
              style={{
                marginTop: '0.75rem',
                padding: '0.75rem',
                borderRadius: '8px',
                backgroundColor: '#eff6ff',
                border: '1px solid #bfdbfe'
              }}
            >
              <p style={{ margin: 0, fontWeight: 600, color: '#0f172a' }}>How to enable AI</p>
              <p style={{ margin: '0.35rem 0 0 0', color: '#475569' }}>
                Open the README instructions for starting Ollama with Docker Compose and enabling Gemma locally.
              </p>
              <p style={{ margin: '0.5rem 0 0 0' }}>
              <button
                type="button"
                onClick={() => setIsReadmeHelpOpen(true)}
                style={{
                  padding: 0,
                  border: 0,
                  background: 'transparent',
                  color: '#1d4ed8',
                  cursor: 'pointer',
                  textDecoration: 'underline'
                }}
              >
                Open README: Ollama with Docker Compose
              </button>
              </p>
            </div>
          ) : null}
        </section>

        <section
          style={{
            padding: '0.75rem',
            borderRadius: '8px',
            backgroundColor: '#f8fafc',
            border: '1px solid #cbd5e1'
          }}
        >
          <h3 style={{ marginTop: 0 }}>AI Path Selection</h3>
          {backendStatus?.aiDataPaths && backendStatus.aiDataPaths.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {backendStatus.aiDataPaths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: 0 }}>Using default plugin AI data path selection.</p>
          )}
        </section>

        <section
          style={{
            padding: '0.75rem',
            borderRadius: '8px',
            backgroundColor: acceleratorPresentation.background,
            border: `1px solid ${acceleratorPresentation.border}`
          }}
        >
          <h3 style={{ marginTop: 0 }}>GPU Acceleration</h3>
          <p style={{ margin: 0 }}>
            Runtime: {formatBackendLabel(backendStatus?.backend)}
            <br />
            Status:{' '}
            <strong style={{ color: acceleratorPresentation.color }}>{acceleratorPresentation.label}</strong>
            {backendStatus?.accelerator?.supported && backendStatus.accelerator.totalBytes ? (
              <>
                <br />
                In GPU memory: {formatBytes(backendStatus.accelerator.vramBytes)} of{' '}
                {formatBytes(backendStatus.accelerator.totalBytes)}
              </>
            ) : null}
            <br />
            Context window: {backendStatus?.numCtx ?? 'Unavailable'} tokens
            {typeof backendStatus?.configuredNumCtx === 'number' &&
            backendStatus.configuredNumCtx !== backendStatus.numCtx
              ? ` (configured ${backendStatus.configuredNumCtx})`
              : ''}
            <br />
            GPU layers: {backendStatus?.numGpu === undefined
              ? 'Unavailable'
              : backendStatus.numGpu < 0
                ? 'Backend estimate'
                : backendStatus.numGpu === 0
                  ? 'CPU only'
                  : backendStatus.numGpu >= 999
                    ? 'All (forced)'
                    : backendStatus.numGpu}
            <br />
            Keep loaded: {backendStatus?.keepAlive ?? 'Unavailable'}
            {jetson?.present ? (
              <>
                <br />
                Board: {jetson.model ?? 'Jetson'}
                {jetson.l4tVersion ? ` (L4T ${jetson.l4tVersion})` : ''}
                {jetson.powerMode ? (
                  <>
                    <br />
                    Power mode: {jetson.powerMode.name ?? jetson.powerMode.id}
                    {jetson.powerMode.isMaximum ? ' (maximum)' : ' (below maximum)'}
                  </>
                ) : null}
                {typeof jetson.gpuLoadPercent === 'number' ? (
                  <>
                    <br />
                    GPU load: {jetson.gpuLoadPercent}%
                    {formatClock(jetson.gpuClockHz, jetson.gpuMaxClockHz)}
                  </>
                ) : null}
                {typeof jetson.gpuTemperatureC === 'number' ? (
                  <>
                    <br />
                    GPU temperature: {jetson.gpuTemperatureC} C
                  </>
                ) : null}
              </>
            ) : null}
          </p>
          {backendStatus?.accelerator?.message ? (
            <p style={{ margin: '0.5rem 0 0 0', color: acceleratorPresentation.color }}>
              {backendStatus.accelerator.message}
            </p>
          ) : null}
          {autoTune?.tuned && autoTune.reason ? (
            <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Auto-tuned: {autoTune.reason}</p>
          ) : null}
          {(jetson?.warnings ?? []).map((warning) => (
            <p
              key={warning}
              style={{
                margin: '0.5rem 0 0 0',
                padding: '0.5rem',
                borderRadius: '6px',
                backgroundColor: '#fff7ed',
                border: '1px solid #fdba74',
                color: '#9a3412'
              }}
            >
              {warning}
            </p>
          ))}
        </section>
      </div>

      {loginState === false && props.login ? (
        <button type="button" onClick={props.login}>
          Login
        </button>
      ) : null}

      {isReadmeHelpOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            zIndex: 1000
          }}
        >
          <section
            style={{
              width: 'min(42rem, 100%)',
              maxHeight: '80vh',
              overflow: 'auto',
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              border: '1px solid #cbd5e1',
              padding: '1rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>README: Ollama with Docker Compose</h3>
              <button type="button" onClick={() => setIsReadmeHelpOpen(false)}>
                Close
              </button>
            </div>
            <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.75rem' }}>
              <p style={{ margin: 0 }}>
                <a
                  href="https://github.com/KEGustafsson/signalk-ai-bridge/blob/main/docker-compose.gemma.yml"
                  target="_blank"
                  rel="noreferrer"
                >
                  docker-compose.gemma.yml
                </a>{' '}
                runs a local Ollama server and persists pulled models in <code>./ollama_data</code>.
              </p>
              <div>
                <p style={{ margin: 0 }}>Start Ollama:</p>
                <pre
                  style={{
                    margin: '0.35rem 0 0 0',
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '0.92rem'
                  }}
                >
{`docker compose -f docker-compose.gemma.yml up -d`}
                </pre>
              </div>
              <p style={{ margin: 0 }}>
                This compose setup already pulls <code>gemma4:e2b</code> during startup, so you do not need to run a separate <code>ollama pull</code> command.
              </p>
              <p style={{ margin: 0 }}>
                If Signal K runs on the host, the plugin default <code>http://localhost:11434</code> is correct.
                If Signal K runs in another container, point the plugin at <code>http://ollama:11434</code> on a shared Docker network instead of <code>localhost</code>.
              </p>
            </div>
          </section>
        </div>
      ) : null}

      <fieldset style={{ marginTop: '1rem', border: '1px solid #bfdbfe', borderRadius: '8px' }}>
        <legend>Ollama vessel analysis</legend>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <textarea
            aria-label="AI prompt"
            value={aiInput.prompt}
            rows={4}
            onChange={(event: { target: { value: string } }) =>
              setAiInput({ prompt: event.target.value })}
          />
          <button type="button" onClick={onAskAi} disabled={isLoading || !canAskAi(backendStatus)}>
            Ask AI
          </button>
          {!canAskAi(backendStatus) ? (
            <p style={{ margin: 0, color: '#475569' }}>
              Ask AI is disabled until Ollama and the configured model are available.
            </p>
          ) : null}
        </div>
      </fieldset>

      <section
        style={{
          marginTop: '1rem',
          padding: '0.75rem',
          borderRadius: '8px',
          backgroundColor: '#eef2ff',
          border: '1px solid #c7d2fe'
        }}
      >
        <h3 style={{ marginTop: 0 }}>AI Response</h3>
        {isLoading ? (
          <div
            style={{
              display: 'grid',
              gap: '0.5rem'
            }}
          >
            <p style={{ margin: 0, fontWeight: 600, color: '#1d4ed8' }}>{getLoadingLabel(backendStatus)}</p>
            <p style={{ margin: 0, color: '#475569' }}>
              The request has been sent. The response will appear here as soon as the model finishes.
            </p>
          </div>
        ) : toolResult?.type === 'ask-vessel-ai-result' ? (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{toolResult.response.answer}</p>
            <p style={{ margin: 0, color: '#475569' }}>
              Model: {toolResult.response.model}
              <br />
              Created: {formatTimestamp(toolResult.response.createdAt)}
              {toolResult.response.usage?.promptTokens !== undefined ? (
                <>
                  <br />
                  Prompt tokens: {toolResult.response.usage.promptTokens}
                </>
              ) : null}
              {toolResult.response.usage?.completionTokens !== undefined ? (
                <>
                  <br />
                  Completion tokens: {toolResult.response.usage.completionTokens}
                </>
              ) : null}
              {toolResult.response.usage?.totalTokens !== undefined ? (
                <>
                  <br />
                  Total tokens: {toolResult.response.usage.totalTokens}
                </>
              ) : null}
              {formatThroughput(toolResult.response.performance?.tokensPerSecond) ? (
                <>
                  <br />
                  Generation speed: {formatThroughput(toolResult.response.performance?.tokensPerSecond)}
                </>
              ) : null}
              {typeof toolResult.response.performance?.loadMs === 'number' &&
              toolResult.response.performance.loadMs > 0 ? (
                <>
                  <br />
                  Model load: {toolResult.response.performance.loadMs} ms
                </>
              ) : null}
            </p>
            {typeof backendStatus?.maxTokens === 'number' &&
            toolResult.response.usage?.completionTokens !== undefined &&
            toolResult.response.usage.completionTokens >= backendStatus.maxTokens ? (
              <p
                style={{
                  margin: 0,
                  padding: '0.75rem',
                  borderRadius: '8px',
                  backgroundColor: '#fff7ed',
                  border: '1px solid #fdba74',
                  color: '#9a3412'
                }}
              >
                This response may be truncated because the model reached the configured max output token limit of {backendStatus.maxTokens}.
              </p>
            ) : null}
          </div>
        ) : toolResult?.type === 'error' ? (
          <p style={{ margin: 0, color: '#b91c1c' }}>{toolResult.error.message}</p>
        ) : (
          <p style={{ margin: 0 }}>Ask AI to view the model response here.</p>
        )}
      </section>

      <section
        style={{
          marginTop: '1rem',
          padding: '0.75rem',
          borderRadius: '8px',
          backgroundColor: '#eff6ff',
          border: '1px solid #bfdbfe'
        }}
      >
        <button
          type="button"
          onClick={() => setIsHistoryOpen((value) => !value)}
          style={{
            display: 'flex',
            width: '100%',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'transparent',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            textAlign: 'left'
          }}
        >
          <span style={{ fontWeight: 600, color: '#0f172a' }}>
            Ask AI History
          </span>
          <span style={{ fontSize: '0.875rem', color: '#334155' }}>
            {isHistoryOpen ? 'Hide' : 'Show'} ({aiRequestLog.length})
          </span>
        </button>

        {isHistoryOpen ? (
          aiRequestLog.length === 0 ? (
            <p style={{ marginBottom: 0 }}>No AI requests yet.</p>
          ) : (
            <div style={{ marginTop: '0.75rem', display: 'grid', gap: '0.75rem' }}>
              {aiRequestLog.map((entry) => (
                <article
                  key={entry.id}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '8px',
                    backgroundColor: '#ffffff',
                    border: '1px solid #dbeafe'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'baseline' }}>
                    <strong style={{ color: '#0f172a' }}>
                      {entry.outcome === 'pending'
                        ? 'Pending'
                        : entry.outcome === 'success'
                          ? 'Completed'
                          : 'Failed'}
                    </strong>
                    <time style={{ fontSize: '0.8rem', color: '#475569' }}>{entry.askedAt}</time>
                  </div>
                  <p
                    style={{
                      margin: '0.35rem 0 0 0',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      color: '#1e293b'
                    }}
                  >
                    {entry.promptPreview}
                  </p>
                  {entry.model ? (
                    <p style={{ margin: '0.35rem 0 0 0', color: '#475569' }}>Model: {entry.model}</p>
                  ) : null}
                  {entry.errorMessage ? (
                    <p style={{ margin: '0.35rem 0 0 0', color: '#b91c1c' }}>{entry.errorMessage}</p>
                  ) : null}
                  {entry.outcome === 'success' && entry.requestText ? (
                    <div style={{ marginTop: '0.5rem' }}>
                      <button
                        type="button"
                        onClick={() =>
                          setOpenHistoryRequestIds((previous) => ({
                            ...previous,
                            [entry.id]: !previous[entry.id]
                          }))}
                        style={{
                          display: 'flex',
                          width: '100%',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: 'transparent',
                          border: 0,
                          padding: 0,
                          cursor: 'pointer',
                          textAlign: 'left'
                        }}
                      >
                        <span style={{ fontWeight: 600, color: '#0f172a' }}>What Was Sent To AI</span>
                        <span style={{ fontSize: '0.875rem', color: '#334155' }}>
                          {openHistoryRequestIds[entry.id] ? 'Hide' : 'Show'}
                        </span>
                      </button>

                      {openHistoryRequestIds[entry.id] ? (
                        <p
                          style={{
                            margin: '0.75rem 0 0 0',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                            color: '#1e293b'
                          }}
                        >
                          {entry.requestText}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )
        ) : null}
      </section>
    </section>
  );
}
