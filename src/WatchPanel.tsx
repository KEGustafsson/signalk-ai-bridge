import React from 'react';
import {
  buildIncidentQuestion,
  describeDetectorCounts,
  formatAgo,
  formatClockTime,
  sparklinePoints
} from './watchText.js';
import type { WatchIncident, WatchReplayResult, WatchStatus } from './watchText.js';

interface WatchPanelProps {
  readonly fetchImpl?: typeof fetch;
  /** `/watch/status` -> the plugin's full URL for it. */
  readonly endpoint: (route: string) => string;
  /** Put a question in the Ask AI box. Nothing is sent until the operator asks. */
  readonly onAskAboutIncident: (question: string) => void;
  readonly canAskAi: boolean;
}

// The status route reads in-memory state only - no backend, no provider - so
// polling it is cheap, unlike /ai/status.
const POLL_MS = 10000;

const SEVERITY_STYLE = {
  alert: { background: '#fef2f2', border: '#fca5a5', color: '#991b1b', label: 'Alert' },
  warn: { background: '#fffbeb', border: '#fcd34d', color: '#92400e', label: 'Warning' }
} as const;

const GNSS_LABEL = {
  ok: { text: 'corroborated', color: '#166534' },
  degraded: { text: 'one indicator active', color: '#b45309' },
  suspect: { text: 'not corroborated: treat the position with suspicion', color: '#b91c1c' },
  unavailable: { text: 'no position data', color: '#475569' }
} as const;

const buttonStyle = {
  padding: '0.3rem 0.65rem',
  borderRadius: '6px',
  border: '1px solid #94a3b8',
  background: '#ffffff',
  color: '#0f172a',
  cursor: 'pointer'
} as const;

type Series = ReadonlyArray<readonly [number, number]>;

async function readJson(response: Response): Promise<{ ok: boolean; status: number; body: unknown }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

function errorText(status: number, body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
  if (status === 401) {
    return message ?? 'This needs a Signal K login with write access.';
  }
  return message ?? fallback;
}

export default function WatchPanel(props: WatchPanelProps) {
  const [status, setStatus] = React.useState<WatchStatus | null>(null);
  const [unreachable, setUnreachable] = React.useState<boolean>(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [trends, setTrends] = React.useState<Record<string, Series | 'loading' | 'none'>>({});
  const [replay, setReplay] = React.useState<WatchReplayResult | 'running' | null>(null);
  const [showResolved, setShowResolved] = React.useState<boolean>(false);
  const [refresh, setRefresh] = React.useState<number>(0);
  const [now, setNow] = React.useState<number>(Date.now());

  const fetchImpl = props.fetchImpl ?? globalThis.fetch;
  const statusUrl = props.endpoint('/watch/status');

  React.useEffect(() => {
    if (typeof fetchImpl !== 'function') {
      return;
    }
    let active = true;
    const load = () => {
      fetchImpl(statusUrl, { method: 'GET', credentials: 'include' })
        .then(readJson)
        .then(({ ok, body }) => {
          if (!active) return;
          setUnreachable(!ok);
          if (ok) setStatus(body as WatchStatus);
          setNow(Date.now());
        })
        .catch(() => {
          if (active) setUnreachable(true);
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [fetchImpl, statusUrl, refresh]);

  const post = React.useCallback(
    async (route: string, body: unknown) => {
      if (typeof fetchImpl !== 'function') {
        throw new Error('This browser cannot reach the plugin.');
      }
      const response = await fetchImpl(props.endpoint(route), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return readJson(response);
    },
    [fetchImpl, props.endpoint]
  );

  const onMute = React.useCallback(
    async (path: string, minutes: number) => {
      setNotice(null);
      try {
        const result = await post('/watch/mute', { path, minutes });
        setNotice(result.ok ? `Muted ${path} for ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}.` : errorText(result.status, result.body, 'Could not mute.'));
        setRefresh((value) => value + 1);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not mute.');
      }
    },
    [post]
  );

  const onUnmute = React.useCallback(
    async (path: string) => {
      setNotice(null);
      try {
        const result = await post('/watch/unmute', { path });
        setNotice(result.ok ? `Watching ${path} again.` : errorText(result.status, result.body, 'Could not unmute.'));
        setRefresh((value) => value + 1);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not unmute.');
      }
    },
    [post]
  );

  const onReplay = React.useCallback(async () => {
    setReplay('running');
    try {
      const result = await post('/watch/replay', { duration: 'PT24H' });
      setReplay(
        result.ok
          ? (result.body as WatchReplayResult)
          : { ok: false, message: errorText(result.status, result.body, 'The replay failed.') }
      );
    } catch (error) {
      setReplay({ ok: false, message: error instanceof Error ? error.message : 'The replay failed.' });
    }
  }, [post]);

  const onTrend = React.useCallback(
    async (path: string) => {
      if (typeof fetchImpl !== 'function') return;
      if (trends[path] && trends[path] !== 'none') {
        setTrends((previous) => {
          const { [path]: _removed, ...rest } = previous;
          return rest;
        });
        return;
      }
      setTrends((previous) => ({ ...previous, [path]: 'loading' }));
      try {
        const response = await fetchImpl(`${props.endpoint('/watch/series')}?path=${encodeURIComponent(path)}`, {
          method: 'GET',
          credentials: 'include'
        });
        const { ok, body } = await readJson(response);
        const series = ok ? (body as { minutes?: Series; recent?: Series }) : undefined;
        const points = series && Array.isArray(series.minutes) && series.minutes.length >= 2 ? series.minutes : series?.recent;
        setTrends((previous) => ({ ...previous, [path]: points && points.length >= 2 ? points : 'none' }));
      } catch {
        setTrends((previous) => ({ ...previous, [path]: 'none' }));
      }
    },
    [fetchImpl, props.endpoint, trends]
  );

  const incidents = status?.incidents ?? [];
  const activeIncidents = incidents.filter((incident) => incident.status === 'active');
  const resolvedIncidents = incidents.filter((incident) => incident.status === 'resolved').slice(0, 10);

  const renderIncident = (incident: WatchIncident) => {
    const style = SEVERITY_STYLE[incident.severity] ?? SEVERITY_STYLE.warn;
    return (
      <article
        key={incident.id}
        style={{ padding: '0.65rem', borderRadius: '8px', background: style.background, border: `1px solid ${style.border}` }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong style={{ color: style.color }}>
            {style.label}: {incident.title}
          </strong>
          <span style={{ fontSize: '0.8rem', color: '#475569' }}>
            {formatClockTime(incident.openedAt)} · {formatAgo(incident.openedAt, now)}
          </span>
        </div>
        <ol style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
          {incident.findings.map((finding, index) => {
            const trend = trends[finding.path];
            const canTrend = !finding.detector.startsWith('gnss.') && finding.detector !== 'feed';
            return (
              <li key={`${finding.key}-${finding.openedAt}`} style={{ color: finding.clearedAt === undefined ? '#0f172a' : '#64748b' }}>
                <span style={{ fontWeight: 600 }}>{finding.title}</span>
                {index === 0 && incident.findings.length > 1 ? (
                  <span style={{ fontSize: '0.8rem', color: '#475569' }}> (first sign)</span>
                ) : null}
                {finding.clearedAt !== undefined ? (
                  <span style={{ fontSize: '0.8rem' }}> (cleared {formatClockTime(finding.clearedAt)})</span>
                ) : null}
                <br />
                <span style={{ overflowWrap: 'anywhere' }}>{finding.message}</span>
                {incident.status === 'active' && finding.clearedAt === undefined ? (
                  <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem', flexWrap: 'wrap' }}>
                    {canTrend ? (
                      <button type="button" style={buttonStyle} onClick={() => onTrend(finding.path)}>
                        {trend && trend !== 'none' ? 'Hide trend' : 'Trend'}
                      </button>
                    ) : null}
                    {finding.detector !== 'feed' ? (
                      <button type="button" style={buttonStyle} onClick={() => onMute(finding.path, 60)}>
                        Mute 1 h
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {trend === 'loading' ? <p style={{ margin: '0.3rem 0 0 0', color: '#475569' }}>Loading trend…</p> : null}
                {trend === 'none' ? <p style={{ margin: '0.3rem 0 0 0', color: '#475569' }}>No trend recorded yet.</p> : null}
                {Array.isArray(trend) ? (
                  <svg
                    role="img"
                    aria-label={`Trend of ${finding.path} over the last ${Math.round((trend[trend.length - 1][0] - trend[0][0]) / 60000)} minutes`}
                    width="100%"
                    height="40"
                    viewBox="0 0 240 40"
                    preserveAspectRatio="none"
                    style={{ display: 'block', marginTop: '0.3rem', background: '#ffffff', borderRadius: '4px', border: '1px solid #e2e8f0' }}
                  >
                    <polyline fill="none" stroke={style.color} strokeWidth="1.5" points={sparklinePoints(trend, 240, 36)} transform="translate(0,2)" />
                  </svg>
                ) : null}
              </li>
            );
          })}
        </ol>
        {incident.status === 'active' ? (
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={!props.canAskAi}
              title={props.canAskAi ? 'Puts a question about this incident in the Ask AI box; nothing is sent until you press Ask AI.' : 'The AI backend is not available.'}
              onClick={() => props.onAskAboutIncident(buildIncidentQuestion(incident))}
            >
              Ask AI about this
            </button>
          </div>
        ) : null}
      </article>
    );
  };

  const paths = status?.paths;
  const gnss = status?.gnss;
  const gnssLabel = gnss ? GNSS_LABEL[gnss.status] ?? GNSS_LABEL.unavailable : undefined;
  const latestRegime = status?.regimeChanges?.[0];

  return (
    <section
      style={{
        marginBottom: '1rem',
        padding: '0.75rem',
        borderRadius: '8px',
        backgroundColor: '#f8fafc',
        border: `1px solid ${activeIncidents.some((incident) => incident.severity === 'alert') ? '#fca5a5' : '#cbd5e1'}`
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Watchkeeper</h3>
        <span style={{ fontSize: '0.8rem', color: '#475569' }}>Statistical watch of every path · no language model</span>
      </div>

      {unreachable && !status ? (
        <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Watch status unavailable.</p>
      ) : !status ? (
        <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>Reading watch status…</p>
      ) : !status.enabled ? (
        <p style={{ margin: '0.5rem 0 0 0' }}>
          Off. Enable <strong>Watch all Signal K paths (Watchkeeper)</strong> in the plugin settings to learn how this vessel
          normally behaves and be told when something departs from it. It runs on the CPU and needs no AI backend.
        </p>
      ) : (
        <>
          <p style={{ margin: '0.5rem 0 0 0' }}>
            {activeIncidents.length === 0 ? (
              <strong style={{ color: '#166534' }}>Nothing unusual.</strong>
            ) : (
              <strong style={{ color: '#991b1b' }}>
                {activeIncidents.length} active incident{activeIncidents.length === 1 ? '' : 's'}.
              </strong>
            )}{' '}
            Watching {paths?.watched ?? 0} paths: {paths?.ready ?? 0} ready, {paths?.learning ?? 0} learning
            {paths && paths.relearning > 0 ? `, ${paths.relearning} re-learning` : ''}
            {paths && paths.excluded > 0 ? `; ${paths.excluded} skipped by design` : ''}
            {paths && paths.capped > 0 ? `; ${paths.capped} over the path limit` : ''}.
            {status.restoredBaseline ? ' Baseline restored from the last run.' : ''}
            <br />
            GNSS position: <span style={{ color: gnssLabel?.color }}>{gnssLabel?.text ?? 'unknown'}</span>
            {latestRegime ? (
              <>
                <br />
                Last operating change: {latestRegime.label} at {formatClockTime(latestRegime.at)} ({latestRegime.affected} paths
                re-learned)
              </>
            ) : null}
          </p>
          {status.lastError ? <p style={{ margin: '0.4rem 0 0 0', color: '#b45309' }}>{status.lastError}</p> : null}

          {activeIncidents.length > 0 ? (
            <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.6rem' }}>{activeIncidents.map(renderIncident)}</div>
          ) : null}

          {status.mutes && status.mutes.length > 0 ? (
            <p style={{ margin: '0.6rem 0 0 0', color: '#475569' }}>
              Muted:{' '}
              {status.mutes.map((mute) => (
                <span key={mute.path} style={{ marginRight: '0.6rem' }}>
                  <code>{mute.path}</code> until {formatClockTime(mute.until)}{' '}
                  <button type="button" style={{ ...buttonStyle, padding: '0.1rem 0.4rem' }} onClick={() => onUnmute(mute.path)}>
                    Unmute
                  </button>
                </span>
              ))}
            </p>
          ) : null}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', flexWrap: 'wrap' }}>
            <button type="button" style={buttonStyle} onClick={() => setShowResolved((value) => !value)}>
              {showResolved ? 'Hide' : 'Show'} recent incidents ({resolvedIncidents.length})
            </button>
            <button type="button" style={buttonStyle} onClick={onReplay} disabled={replay === 'running'}>
              {replay === 'running' ? 'Replaying…' : 'Replay last 24 h'}
            </button>
          </div>
          {notice ? <p style={{ margin: '0.4rem 0 0 0', color: '#475569' }}>{notice}</p> : null}

          {showResolved ? (
            resolvedIncidents.length === 0 ? (
              <p style={{ margin: '0.5rem 0 0 0', color: '#475569' }}>No resolved incidents yet.</p>
            ) : (
              <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.1rem' }}>
                {resolvedIncidents.map((incident) => (
                  <li key={incident.id}>
                    {formatClockTime(incident.openedAt)}–{formatClockTime(incident.resolvedAt)} {incident.title}
                    {incident.interrupted ? ' (plugin restarted)' : ''}
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {replay && replay !== 'running' ? (
            <div style={{ marginTop: '0.5rem', padding: '0.6rem', borderRadius: '8px', background: '#ffffff', border: '1px solid #e2e8f0' }}>
              {replay.ok ? (
                <>
                  <p style={{ margin: 0 }}>
                    Over the last 24 h of recorded history ({replay.pathsReplayed} paths
                    {replay.pathsSkipped ? `, ${replay.pathsSkipped} more not replayed` : ''}), this watch would have opened{' '}
                    <strong>{replay.incidentsOpened ?? 0}</strong> incident{replay.incidentsOpened === 1 ? '' : 's'} from{' '}
                    {replay.findingsOpened ?? 0} finding{replay.findingsOpened === 1 ? '' : 's'}: {describeDetectorCounts(replay.byDetector)}.
                  </p>
                  {replay.incidents && replay.incidents.length > 0 ? (
                    <ul style={{ margin: '0.4rem 0 0 0', paddingLeft: '1.1rem' }}>
                      {replay.incidents.slice(0, 8).map((incident) => (
                        <li key={incident.id}>
                          {new Date(incident.openedAt).toLocaleString()} {incident.title}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {replay.note ? <p style={{ margin: '0.4rem 0 0 0', color: '#475569', fontSize: '0.85rem' }}>{replay.note}</p> : null}
                </>
              ) : (
                <p style={{ margin: 0, color: '#b45309' }}>{replay.message}</p>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
