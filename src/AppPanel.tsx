import React from 'react';
import { streamBridgeRequest } from './bridgeRuntime.js';
import type { AskVesselAiResult, ToolResult } from './contracts.js';
import type { AppPanelProps } from './panelTypes.js';
import type { AcceleratorStatus, AiChatMessage, AiHistoryFetchStatus, AiHistoryStatus } from './types.js';

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
  readonly history?: AiHistoryStatus;
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

function getSelectionEndpoint(props: AppPanelProps): string {
  if (typeof props.bridgeEndpoint === 'string' && props.bridgeEndpoint.length > 0) {
    return props.bridgeEndpoint.replace(/\/bridge\/execute$/, '/paths/selection');
  }

  return '/plugins/signalk-ai-bridge/paths/selection';
}

function getSelfPathsEndpoint(props: AppPanelProps): string {
  if (typeof props.bridgeEndpoint === 'string' && props.bridgeEndpoint.length > 0) {
    return props.bridgeEndpoint.replace(/\/bridge\/execute$/, '/signalk/paths');
  }

  return '/plugins/signalk-ai-bridge/signalk/paths';
}

function getHistoryPathsEndpoint(props: AppPanelProps): string {
  if (typeof props.bridgeEndpoint === 'string' && props.bridgeEndpoint.length > 0) {
    return props.bridgeEndpoint.replace(/\/bridge\/execute$/, '/history/paths');
  }

  return '/plugins/signalk-ai-bridge/history/paths';
}

interface PathPickerState {
  readonly status: 'idle' | 'loading' | 'loaded';
  readonly paths: readonly string[];
  readonly windowSeconds?: number;
  readonly message?: string;
}

interface PathPickerProps {
  readonly state: PathPickerState;
  readonly picked: Record<string, boolean>;
  readonly setPicked: (updater: (previous: Record<string, boolean>) => Record<string, boolean>) => void;
  readonly filter: string;
  readonly setFilter: (value: string) => void;
  readonly notice: string | null;
  readonly saving: boolean;
  readonly onBrowse: () => void;
  readonly onSave: () => void;
  readonly idleLabel: string;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly summary: (count: number) => string;
}

const pickerButtonStyle = {
  padding: '0.35rem 0.75rem',
  borderRadius: '6px',
  border: '1px solid #94a3b8',
  background: '#ffffff',
  color: '#0f172a'
} as const;

/**
 * Browse-tick-copy over a list of Signal K paths.
 *
 * Shared by the live and history cards because the interaction is identical
 * and only the source and wording differ. Saving writes straight through to
 * the plugin's stored options: these two lists are chosen against what the
 * vessel actually publishes, which the settings form cannot show, so the panel
 * is the only place they are edited.
 */
/**
 * The picked paths, plus the configured ones the picker could not offer.
 *
 * A save writes the whole list, so anything the listing did not carry would be
 * dropped by a save the operator meant as "keep these too". The listing misses
 * paths for reasons that say nothing about intent: a live source that happens
 * to be silent, a listing truncated at its cap, a history path with nothing
 * recorded in the discovery window. An unlisted path has no checkbox, so the
 * picker cannot express "remove it" either - only what it showed can be
 * unticked.
 */
function withUnlistedSelection(
  picked: readonly string[],
  listed: readonly string[],
  configured: readonly string[] | undefined
): string[] {
  const shown = new Set(listed);
  return [...picked, ...(configured ?? []).filter((path) => !shown.has(path))];
}

/**
 * Write a path selection through to the plugin's stored options.
 *
 * Returns a message rather than throwing: every outcome - saved, refused for
 * want of a login, plugin unreachable - belongs beside the picker that made
 * the selection, not in a console nobody has open on a boat.
 */
async function saveSelection(
  props: AppPanelProps,
  selection: { aiDataPaths?: readonly string[]; historyPaths?: readonly string[] }
): Promise<{ message: string; status?: BackendStatus }> {
  const fetchImpl = props.bridgeFetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { message: 'This browser cannot reach the plugin.' };
  }

  const count = (selection.aiDataPaths ?? selection.historyPaths ?? []).length;
  try {
    const response = await fetchImpl(getSelectionEndpoint(props), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(selection)
    });
    const payload = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) {
      return { message: payload.error?.message ?? `The plugin refused the change (HTTP ${response.status}).` };
    }

    // Re-read the status so the card's own list shows what was stored, not
    // what the browser hoped was stored.
    let status: BackendStatus | undefined;
    try {
      const statusResponse = await fetchImpl(getStatusEndpoint(props), { method: 'GET', credentials: 'include' });
      if (statusResponse.ok) {
        status = (await statusResponse.json()) as BackendStatus;
      }
    } catch {
      // The save landed; a stale card is a cosmetic problem.
    }

    return {
      message: count === 0 ? 'Saved: no paths selected.' : `Saved ${count} path${count === 1 ? '' : 's'}.`,
      status
    };
  } catch (error) {
    return { message: error instanceof Error ? error.message : 'Could not reach the plugin.' };
  }
}

function PathPicker(props: PathPickerProps) {
  const { state, picked, setPicked, filter, setFilter, notice } = props;
  const pickedCount = state.paths.filter((path) => picked[path]).length;
  const visible = state.paths.filter((path) => path.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <button
        type="button"
        onClick={props.onBrowse}
        disabled={state.status === 'loading'}
        style={{ ...pickerButtonStyle, cursor: state.status === 'loading' ? 'wait' : 'pointer' }}
      >
        {state.status === 'loading' ? props.loadingLabel : props.idleLabel}
      </button>
      {state.status === 'loaded' ? (
        <>
          {state.message ? <p style={{ margin: '0.5rem 0 0 0', color: '#b45309' }}>{state.message}</p> : null}
          {state.paths.length === 0 ? (
            <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>{props.emptyLabel}</p>
          ) : (
            <div style={{ marginTop: '0.5rem' }}>
              <p style={{ margin: 0, color: '#475569' }}>
                {props.summary(state.paths.length)} Tick the ones the model should see, then save.
              </p>
              {state.paths.length > 8 ? (
                <input
                  type="text"
                  value={filter}
                  onChange={(event: { target: { value: string } }) => setFilter(event.target.value)}
                  placeholder="Filter paths…"
                  style={{
                    marginTop: '0.5rem',
                    padding: '0.3rem 0.5rem',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                />
              ) : null}
              <div
                style={{
                  marginTop: '0.5rem',
                  maxHeight: '14rem',
                  overflowY: 'auto',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                  padding: '0.35rem 0.5rem',
                  background: '#ffffff'
                }}
              >
                {visible.length === 0 ? (
                  <p style={{ margin: 0, color: '#475569' }}>No path matches that filter.</p>
                ) : (
                  visible.map((path) => (
                    <label key={path} style={{ display: 'block', padding: '0.1rem 0', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(picked[path])}
                        onChange={(event: { target: { checked: boolean } }) =>
                          setPicked((previous) => ({ ...previous, [path]: event.target.checked }))
                        }
                        style={{ marginRight: '0.4rem' }}
                      />
                      <code>{path}</code>
                    </label>
                  ))
                )}
              </div>
              <p style={{ margin: '0.5rem 0 0 0' }}>
                <button
                  type="button"
                  onClick={props.onSave}
                  disabled={props.saving}
                  style={{ ...pickerButtonStyle, cursor: props.saving ? 'wait' : 'pointer' }}
                >
                  {props.saving ? 'Saving…' : `Save ${pickedCount} selected`}
                </button>
                {notice ? <span style={{ marginLeft: '0.5rem', color: '#475569' }}>{notice}</span> : null}
              </p>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function formatTimestamp(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'Unavailable';
  }

  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

/** `5400` -> `1 h 30 min`, for a window an operator typed as `PT1H30M`. */
function formatSeconds(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 'Unavailable';
  }

  const units: ReadonlyArray<readonly [number, string]> = [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'min'],
    [1, 's']
  ];

  const parts: string[] = [];
  let remaining = Math.round(seconds);
  for (const [size, label] of units) {
    const amount = Math.floor(remaining / size);
    if (amount > 0) {
      parts.push(`${amount} ${label}`);
      remaining -= amount * size;
    }
    if (parts.length === 2) {
      break;
    }
  }

  return parts.join(' ');
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

/** Short backend name for status lines. */
function backendName(backend: string | undefined): string {
  return backend === 'tensorrt-llm' ? 'TensorRT-LLM' : 'Ollama';
}

function isOllamaBackend(backend: string | undefined): boolean {
  return backend !== 'tensorrt-llm';
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

  // The help below is the Ollama Docker Compose walkthrough; it would be wrong
  // advice for a TensorRT-LLM server, which is set up entirely differently.
  if (!isOllamaBackend(status.backend)) {
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
  aiInput: AiInput,
  onToken: (text: string) => void
): Promise<ToolResult> {
  return streamBridgeRequest(
    props,
    {
      toolId: 'ask-vessel-ai',
      prompt: aiInput.prompt
    },
    onToken
  );
}

export default function AppPanel(props: AppPanelProps) {
  const [toolResult, setToolResult] = React.useState<ToolResult | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  // Text accumulated from the stream, shown until the final result arrives.
  const [streamingAnswer, setStreamingAnswer] = React.useState<string>('');
  const [aiRequestLog, setAiRequestLog] = React.useState<AiRequestLogEntry[]>([]);
  const [backendStatus, setBackendStatus] = React.useState<BackendStatus | null>(null);
  // The status route is polled once, on mount, and each poll costs the
  // inference server three round trips plus a full Jetson sysfs scan - so the
  // history card is refreshed from the answer itself, which carries the very
  // context the bridge just recorded, rather than by asking the server again.
  const [lastHistoryFetch, setLastHistoryFetch] = React.useState<AiHistoryFetchStatus | null>(null);
  // The picker is fetch-on-demand: the listing is a provider database query,
  // so it runs when the operator asks for it, never on a render pass.
  const [historyPathsState, setHistoryPathsState] = React.useState<PathPickerState>({ status: 'idle', paths: [] });
  const [pickedPaths, setPickedPaths] = React.useState<Record<string, boolean>>({});
  const [pathFilter, setPathFilter] = React.useState('');
  const [copyNotice, setCopyNotice] = React.useState<string | null>(null);
  const [livePathsState, setLivePathsState] = React.useState<PathPickerState>({ status: 'idle', paths: [] });
  const [pickedLivePaths, setPickedLivePaths] = React.useState<Record<string, boolean>>({});
  const [livePathFilter, setLivePathFilter] = React.useState('');
  const [liveCopyNotice, setLiveCopyNotice] = React.useState<string | null>(null);
  const [savingSelection, setSavingSelection] = React.useState<'live' | 'history' | null>(null);
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
    // Not [props]: the host builds a fresh props object on every one of its own
    // renders, so the effect refired and re-ran a status fetch that costs the
    // inference server three round trips plus a full Jetson sysfs scan.
  }, [props.bridgeFetch, props.bridgeEndpoint]);

  const onAskAi = React.useCallback(async () => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    setIsLoading(true);
    setStreamingAnswer('');
    setToolResult(null);
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
      const result = await runTool(props, aiInput, (text) => {
        setStreamingAnswer((previous) => previous + text);
      });
      // The result's answer is authoritative — it is the complete text the
      // backend assembled, so the streamed preview is discarded rather than
      // trusted as the final rendering.
      setToolResult(result);
      setStreamingAnswer('');
      if (result.type === 'ask-vessel-ai-result' && result.context?.history) {
        const history = result.context.history;
        setLastHistoryFetch({
          at: new Date().toISOString(),
          ok: typeof history.message !== 'string',
          requestedPaths: history.requestedPaths,
          seriesCount: history.series ? Object.keys(history.series).length : 0,
          message: history.message
        });
      }
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
      setStreamingAnswer('');
    }
  }, [props, aiInput]);

  // Whichever is newer: this session's own answers, else whatever the server
  // had recorded when the panel loaded.
  const historyFetch = lastHistoryFetch ?? backendStatus?.history?.lastFetch;
  const historyPaths = backendStatus?.history?.paths ?? [];

  const onBrowseHistoryPaths = React.useCallback(async () => {
    const fetchImpl = props.bridgeFetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      return;
    }

    setHistoryPathsState({ status: 'loading', paths: [] });
    setCopyNotice(null);
    try {
      const response = await fetchImpl(getHistoryPathsEndpoint(props), {
        method: 'GET',
        credentials: 'include'
      });
      const payload = (await response.json()) as {
        paths?: readonly string[];
        windowSeconds?: number;
        message?: string;
        error?: { message?: string };
      };
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      setHistoryPathsState({
        status: 'loaded',
        paths,
        windowSeconds: payload.windowSeconds,
        message: payload.message ?? payload.error?.message
      });
      // Pre-tick what the plugin already uses, so the selection starts from
      // the current configuration instead of from nothing.
      const configured = new Set(
        (backendStatus?.history?.paths ?? []).map((path) => path.split(':')[0])
      );
      setPickedPaths(Object.fromEntries(paths.map((path) => [path, configured.has(path)])));
    } catch (error) {
      setHistoryPathsState({
        status: 'loaded',
        paths: [],
        message: error instanceof Error ? error.message : 'Could not reach the plugin.'
      });
    }
  }, [props, backendStatus]);

  const onBrowseLivePaths = React.useCallback(async () => {
    const fetchImpl = props.bridgeFetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      return;
    }

    setLivePathsState({ status: 'loading', paths: [] });
    setLiveCopyNotice(null);
    try {
      const response = await fetchImpl(getSelfPathsEndpoint(props), {
        method: 'GET',
        credentials: 'include'
      });
      const payload = (await response.json()) as {
        paths?: readonly string[];
        branches?: ReadonlyArray<{ path?: string; leafCount?: number }>;
        selected?: readonly string[];
        message?: string;
        error?: { message?: string };
      };

      // Branch wildcards first: they are the selection that scales, and the
      // one an operator wanting "all of navigation" should reach for rather
      // than ticking forty leaves.
      const branchPaths = (payload.branches ?? [])
        .map((branch) => branch.path)
        .filter((path): path is string => typeof path === 'string');
      const leafPaths = Array.isArray(payload.paths) ? payload.paths : [];
      const paths = [...branchPaths, ...leafPaths];

      setLivePathsState({ status: 'loaded', paths, message: payload.message ?? payload.error?.message });
      const configured = new Set(payload.selected ?? []);
      setPickedLivePaths(Object.fromEntries(paths.map((path) => [path, configured.has(path)])));
    } catch (error) {
      setLivePathsState({
        status: 'loaded',
        paths: [],
        message: error instanceof Error ? error.message : 'Could not reach the plugin.'
      });
    }
  }, [props]);

  const onSavePickedLivePaths = React.useCallback(async () => {
    const picked = withUnlistedSelection(
      livePathsState.paths.filter((path) => pickedLivePaths[path]),
      livePathsState.paths,
      backendStatus?.aiDataPaths
    );
    setSavingSelection('live');
    setLiveCopyNotice(null);
    const result = await saveSelection(props, { aiDataPaths: picked });
    setSavingSelection(null);
    setLiveCopyNotice(result.message);
    if (result.status) {
      setBackendStatus(result.status);
    }
  }, [backendStatus, livePathsState, pickedLivePaths, props]);

  const onSavePickedPaths = React.useCallback(async () => {
    const picked = withUnlistedSelection(
      historyPathsState.paths.filter((path) => pickedPaths[path]),
      historyPathsState.paths,
      backendStatus?.history?.paths
    );
    setSavingSelection('history');
    setCopyNotice(null);
    const result = await saveSelection(props, { historyPaths: picked });
    setSavingSelection(null);
    setCopyNotice(result.message);
    if (result.status) {
      setBackendStatus(result.status);
    }
  }, [backendStatus, historyPathsState, pickedPaths, props]);

  const acceleratorPresentation = React.useMemo(
    () => describeAccelerator(backendStatus?.accelerator),
    [backendStatus]
  );
  const jetson = backendStatus?.accelerator?.jetson;
  const autoTune = backendStatus?.accelerator?.autoTune;
  const cacheHint = backendStatus?.accelerator?.cache;

  return (
    <section style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Signal K AI Bridge</h2>
      <p>
        Embedded Admin UI panel for sending selected Signal K data to a local AI backend and reviewing the exact AI request.
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
          <h3 style={{ marginTop: 0 }}>{backendName(backendStatus?.backend)}</h3>
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
              {backendName(backendStatus?.backend)} reachable:{' '}
              {backendStatus?.ollamaReachable === undefined ? 'Unavailable' : backendStatus.ollamaReachable ? 'Yes' : 'No'}
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
          <PathPicker
            state={livePathsState}
            picked={pickedLivePaths}
            setPicked={setPickedLivePaths}
            filter={livePathFilter}
            setFilter={setLivePathFilter}
            notice={liveCopyNotice}
            saving={savingSelection === 'live'}
            onBrowse={onBrowseLivePaths}
            onSave={onSavePickedLivePaths}
            idleLabel="Browse available paths"
            loadingLabel="Reading Signal K…"
            emptyLabel="This vessel is not publishing any data on the paths the picker knows about."
            summary={(count) =>
              `${count} selectable path${count === 1 ? '' : 's'}: branch wildcards first, then the individual leaves they cover.`
            }
          />
        </section>

        <section
          style={{
            padding: '0.75rem',
            borderRadius: '8px',
            backgroundColor: '#f8fafc',
            border: '1px solid #cbd5e1'
          }}
        >
          <h3 style={{ marginTop: 0 }}>History Context</h3>
          {/*
            Outside the `enabled` branch on purpose. The stored selection used
            to render only when history was switched on, so an operator who had
            picked their paths and left the feature off saw nothing but the
            "Disabled" note - the selection first appeared when they pressed
            Browse, which reads as the picker inventing ticks rather than
            showing what was already saved. The live card has always listed its
            selection unconditionally; this one now matches it.
          */}
          {historyPaths.length > 0 ? (
            <ul style={{ margin: '0 0 0.5rem 0', paddingLeft: '1.1rem' }}>
              {historyPaths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: '0 0 0.5rem 0' }}>
              No history paths are configured, and no exact live paths were available to reuse.
            </p>
          )}
          {backendStatus?.history?.enabled ? (
            <>
              <p style={{ margin: 0 }}>
                Window: last {formatSeconds(backendStatus.history.durationSeconds)}, one point per{' '}
                {formatSeconds(backendStatus.history.resolutionSeconds)}, up to {backendStatus.history.samples} sample
                {backendStatus.history.samples === 1 ? '' : 's'} per path
                <br />
                Source: {backendStatus.history.serverUrl}
                {backendStatus.history.provider ? ` (provider ${backendStatus.history.provider})` : ''}
              </p>
              {historyFetch ? (
                <p style={{ margin: '0.5rem 0 0 0', color: historyFetch.ok ? '#166534' : '#b45309' }}>
                  Last read {formatTimestamp(historyFetch.at)}:{' '}
                  {historyFetch.ok
                    ? `${historyFetch.seriesCount ?? 0} series returned`
                    : historyFetch.message}
                </p>
              ) : (
                <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>
                  History is read when a question is asked; nothing has been read yet.
                </p>
              )}
            </>
          ) : (
            <p style={{ margin: 0 }}>
              Disabled{historyPaths.length > 0 ? ', so the paths above are stored but not sent' : ''}. Enable{' '}
              <code>historyEnabled</code> in the plugin settings to also send recent history from the Signal K History
              API, which needs a history provider plugin such as signalk-to-influxdb2 or signalk-parquet.
            </p>
          )}

          <PathPicker
            state={historyPathsState}
            picked={pickedPaths}
            setPicked={setPickedPaths}
            filter={pathFilter}
            setFilter={setPathFilter}
            notice={copyNotice}
            saving={savingSelection === 'history'}
            onBrowse={onBrowseHistoryPaths}
            onSave={onSavePickedPaths}
            idleLabel="Browse recorded paths"
            loadingLabel="Reading History API…"
            emptyLabel={`The History API answered, but no paths have recorded data in the last ${formatSeconds(
              historyPathsState.windowSeconds
            )}.`}
            summary={(count) =>
              `${count} path${count === 1 ? '' : 's'} with recorded data in the last ${formatSeconds(
                historyPathsState.windowSeconds
              )}.`
            }
          />
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
                {jetson.gpu ? (
                  <>
                    <br />
                    GPU: {jetson.gpu.architecture}, compute capability {jetson.gpu.computeCapability}
                  </>
                ) : null}
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
            ) : jetson?.message ? (
              <>
                <br />
                {jetson.message}
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
          {cacheHint && !cacheHint.quantized ? (
            <p
              style={{
                margin: '0.5rem 0 0 0',
                padding: '0.5rem',
                borderRadius: '6px',
                backgroundColor: '#fff7ed',
                border: '1px solid #fdba74',
                color: '#9a3412'
              }}
            >
              {cacheHint.message}
            </p>
          ) : null}
          {cacheHint?.quantized ? (
            <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>{cacheHint.message}</p>
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
        <legend>{backendName(backendStatus?.backend)} vessel analysis</legend>
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
              Ask AI is disabled until {backendName(backendStatus?.backend)} and the configured model are available.
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
            <p style={{ margin: 0, fontWeight: 600, color: '#1d4ed8' }}>
              {streamingAnswer.length > 0 ? 'Streaming AI response...' : getLoadingLabel(backendStatus)}
            </p>
            {streamingAnswer.length > 0 ? (
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                {streamingAnswer}
                <span aria-hidden="true" style={{ color: '#1d4ed8' }}>
                  {'\u2588'}
                </span>
              </p>
            ) : (
              <p style={{ margin: 0, color: '#475569' }}>
                The request has been sent. The response will appear here as the model generates it.
              </p>
            )}
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
