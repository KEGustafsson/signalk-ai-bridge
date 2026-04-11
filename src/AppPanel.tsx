import { useCallback, useMemo, useState } from 'react';
import { executeBridgeRequest } from './bridgeRuntime.js';
import type { ToolId, ToolResult } from './contracts.js';
import type { AppPanelProps } from './panelTypes.js';

interface DraftInput {
  readonly name: string;
  readonly latitude: string;
  readonly longitude: string;
}

const LOCAL_BRIDGE_TOKEN = 'dev-bridge-token';

async function runTool(
  toolId: ToolId,
  props: AppPanelProps,
  draftInput: DraftInput
): Promise<ToolResult> {
  return executeBridgeRequest(
    props,
    {
      toolId,
      draftName: draftInput.name,
      latitude: Number(draftInput.latitude),
      longitude: Number(draftInput.longitude)
    },
    LOCAL_BRIDGE_TOKEN,
    LOCAL_BRIDGE_TOKEN
  );
}

export default function AppPanel(props: AppPanelProps) {
  const [toolResult, setToolResult] = useState<ToolResult | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [draftInput, setDraftInput] = useState<DraftInput>({
    name: 'Harbor Entry',
    latitude: '37.7749',
    longitude: '-122.4194'
  });

  const status = useMemo(() => {
    if (props.isLoggedIn === true) {
      return 'Authenticated';
    }

    if (props.isLoggedIn === false) {
      return 'Not authenticated';
    }

    return 'Authentication status unavailable';
  }, [props.isLoggedIn]);

  const onRunTool = useCallback(
    async (toolId: ToolId) => {
      setIsLoading(true);
      try {
        const result = await runTool(toolId, props, draftInput);
        setToolResult(result);
      } finally {
        setIsLoading(false);
      }
    },
    [props, draftInput]
  );

  return (
    <section style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Signal K AI Bridge</h2>
      <p>
        Embedded Admin UI panel with read-only tools and a draft-only waypoint workflow requiring
        explicit user action.
      </p>
      <ul>
        <li>Status: {status}</li>
        <li>Server ID: {props.serverId ?? 'unknown'}</li>
      </ul>

      {props.isLoggedIn === false && props.login ? (
        <button type="button" onClick={props.login}>
          Login
        </button>
      ) : null}

      <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => onRunTool('get-vessel-snapshot')} disabled={isLoading}>
          Get Vessel Snapshot
        </button>
        <button type="button" onClick={() => onRunTool('get-active-alarms')} disabled={isLoading}>
          Get Active Alarms
        </button>
        <button type="button" onClick={() => onRunTool('get-recent-deltas')} disabled={isLoading}>
          Get Recent Deltas
        </button>
      </div>

      <fieldset style={{ marginTop: '1rem', border: '1px solid #c7d2fe', borderRadius: '8px' }}>
        <legend>Draft-only waypoint action</legend>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '0.5rem' }}>
          <input
            aria-label="Waypoint name"
            value={draftInput.name}
            onChange={(event: { target: { value: string } }) =>
              setDraftInput((prev) => ({ ...prev, name: event.target.value }))}
          />
          <input
            aria-label="Latitude"
            value={draftInput.latitude}
            onChange={(event: { target: { value: string } }) =>
              setDraftInput((prev) => ({ ...prev, latitude: event.target.value }))}
          />
          <input
            aria-label="Longitude"
            value={draftInput.longitude}
            onChange={(event: { target: { value: string } }) =>
              setDraftInput((prev) => ({ ...prev, longitude: event.target.value }))}
          />
          <button type="button" onClick={() => onRunTool('create-waypoint-draft')} disabled={isLoading}>
            Create Waypoint Draft
          </button>
        </div>
      </fieldset>

      <pre
        style={{
          marginTop: '1rem',
          padding: '0.75rem',
          borderRadius: '8px',
          backgroundColor: '#eef2ff',
          overflowX: 'auto'
        }}
      >
        {toolResult ? JSON.stringify(toolResult, null, 2) : 'Run a tool to view output.'}
      </pre>
    </section>
  );
}
