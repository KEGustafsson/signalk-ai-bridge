/**
 * Watchkeeper types and the pure helpers behind the panel's Watch card.
 *
 * Kept free of React so they are unit-tested on their own: the incident
 * question in particular is what the operator sends to the model, and it has
 * to stay bounded and say plainly that the numbers in it were measured.
 */

export type WatchSeverity = 'warn' | 'alert';

export interface WatchFinding {
  readonly key: string;
  readonly detector: string;
  readonly path: string;
  readonly severity: WatchSeverity;
  readonly title: string;
  readonly message: string;
  readonly openedAt: number;
  readonly clearedAt?: number;
  readonly incidentId?: string;
}

export interface WatchIncident {
  readonly id: string;
  readonly status: 'active' | 'resolved';
  readonly openedAt: number;
  readonly updatedAt: number;
  readonly resolvedAt?: number;
  readonly interrupted?: boolean;
  readonly severity: WatchSeverity;
  readonly title: string;
  readonly findings: readonly WatchFinding[];
}

export interface WatchRegimeChange {
  readonly at: number;
  readonly label: string;
  readonly affected: number;
  readonly settleMs: number;
}

export interface WatchStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly usesLanguageModel?: boolean;
  readonly subscription?: string;
  readonly restoredBaseline?: boolean;
  readonly startedAt?: string;
  readonly lastError?: string;
  readonly sensitivity?: string;
  readonly learningMinutes?: number;
  readonly paths?: {
    readonly watched: number;
    readonly ready: number;
    readonly learning: number;
    readonly relearning: number;
    readonly excluded: number;
    readonly capped: number;
  };
  readonly sourcesCompared?: number;
  readonly activeFindings?: readonly WatchFinding[];
  readonly incidents?: readonly WatchIncident[];
  readonly regimeChanges?: readonly WatchRegimeChange[];
  readonly gnss?: {
    readonly status: 'ok' | 'degraded' | 'suspect' | 'unavailable';
    readonly indicators: Readonly<Record<string, 'ok' | 'active' | 'unavailable'>>;
  };
  readonly mutes?: ReadonlyArray<{ readonly path: string; readonly until: number }>;
}

export interface WatchInventoryRow {
  readonly path: string;
  readonly role: 'watching' | 'learning' | 'relearning' | 'skipped' | 'gnss-input';
  readonly kind?: string;
  readonly units?: string;
  readonly displayName?: string;
  readonly intervalMs?: number;
  readonly samples?: number;
  readonly excludedBy?: string;
  readonly sources?: ReadonlyArray<{ readonly name: string; readonly primary: boolean; readonly samples: number }>;
}

export interface WatchInventory {
  readonly totals: {
    readonly seen: number;
    readonly watched: number;
    readonly skipped: number;
    readonly capped: number;
    readonly gnssInputs: number;
    readonly multiSource: number;
  };
  readonly branches: ReadonlyArray<{ readonly branch: string; readonly watched: number; readonly excluded: number }>;
  readonly capabilities: ReadonlyArray<{ readonly id: string; readonly label: string; readonly available: boolean; readonly detail: string }>;
  readonly paths: readonly WatchInventoryRow[];
  readonly truncated?: number;
}

/** One inventory row in words: `watching · continuous · every 1 s · 2 sources (n2k.10 primary)`. */
export function describeInventoryRow(row: WatchInventoryRow): string {
  const parts: string[] = [];
  if (row.role === 'skipped') {
    parts.push(`skipped (${row.excludedBy ?? 'excluded'})`);
  } else if (row.role === 'gnss-input') {
    parts.push('read by the GNSS check');
  } else {
    parts.push(row.role === 'relearning' ? 're-learning' : row.role);
  }
  if (row.kind && row.kind !== 'unknown') parts.push(row.kind);
  if (typeof row.intervalMs === 'number') {
    parts.push(row.intervalMs < 1500 ? 'every 1 s' : row.intervalMs < 90000 ? `every ${Math.round(row.intervalMs / 1000)} s` : `every ${Math.round(row.intervalMs / 60000)} min`);
  }
  if (row.units) parts.push(row.units);
  const sources = row.sources ?? [];
  if (sources.length > 1) {
    const primary = sources.find((source) => source.primary);
    parts.push(`${sources.length} sources${primary ? ` (${primary.name} primary)` : ''}`);
  } else if (sources.length === 1 && sources[0].name !== 'default') {
    parts.push(sources[0].name);
  }
  return parts.join(' · ');
}

export interface WatchUnusualRow {
  readonly path: string;
  readonly score: number;
  readonly title: string;
  readonly message: string;
}

/**
 * "Something feels off": the most unusual paths as a question for the model.
 * Same contract as the incident question - measured values, operator sends.
 */
export function buildUnusualQuestion(rows: readonly WatchUnusualRow[]): string {
  const lines = rows.slice(0, 8).map((row) => `- ${row.title}: ${row.message}`);
  return [
    'Nothing has raised an alarm, but the onboard watch (statistical, not AI) ranks these as the furthest from ' +
      'their own normal right now, most unusual first. The values were measured.',
    ...lines,
    'Do these fit together into anything worth checking? If they look like ordinary variation, say so.'
  ].join('\n');
}

export interface WatchReplayResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly from?: string;
  readonly to?: string;
  readonly pathsReplayed?: number;
  readonly pathsSkipped?: number;
  readonly findingsOpened?: number;
  readonly incidentsOpened?: number;
  readonly byDetector?: Readonly<Record<string, number>>;
  readonly incidents?: readonly WatchIncident[];
  readonly note?: string;
}

const MAX_QUESTION_CHARS = 1800;

/** `14:05`, in the browser's local time. */
export function formatClockTime(at: number | undefined): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return '—';
  }
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `3 min ago`, `2 h ago`. */
export function formatAgo(at: number | undefined, now: number = Date.now()): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return '';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * The question "Ask AI about this" puts in the prompt box.
 *
 * The detector's findings go in as measured facts, earliest first - the first
 * sign is the likeliest cause - and the model is asked to explain and
 * prioritise, not to re-detect. The operator still sees and can edit the text
 * before anything is sent: nothing reaches the model unprompted.
 */
export function buildIncidentQuestion(incident: WatchIncident): string {
  const header =
    'The onboard watch (statistical, not AI) reported this incident. The values below were measured; ' +
    'the first line is the earliest sign.';
  const lines: string[] = [];
  let used = header.length;
  for (const finding of incident.findings) {
    const state = finding.clearedAt === undefined ? '' : ' (since cleared)';
    const line = `- ${formatClockTime(finding.openedAt)} ${finding.title}: ${finding.message}${state}`;
    if (used + line.length > MAX_QUESTION_CHARS) {
      lines.push(`- …and ${incident.findings.length - lines.length} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const ask =
    'Using the vessel data provided, what could explain this, how urgent is it, and what should I check first? ' +
    'If the data does not support a conclusion, say so.';
  return [header, ...lines, ask].join('\n');
}

/** SVG polyline points for a sparkline of `[t, v]` pairs in a width×height box. */
export function sparklinePoints(series: ReadonlyArray<readonly [number, number]>, width: number, height: number): string {
  const points = series.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (points.length < 2) {
    return '';
  }
  let minT = Infinity;
  let maxT = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [t, v] of points) {
    minT = Math.min(minT, t);
    maxT = Math.max(maxT, t);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const spanT = maxT - minT || 1;
  const spanV = maxV - minV || 1;
  return points
    .map(([t, v]) => {
      const x = ((t - minT) / spanT) * width;
      const y = height - ((v - minV) / spanV) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** `shift 3, dropout 1`: a replay's findings by detector, in plain words. */
export function describeDetectorCounts(byDetector: Readonly<Record<string, number>> | undefined): string {
  const labels: Record<string, string> = {
    shift: 'unusual level',
    dropout: 'stopped updating',
    frozen: 'stuck sensor',
    newState: 'new state',
    cycling: 'cycling',
    forecast: 'trend toward a limit',
    feed: 'data feed silent',
    disagree: 'sources disagree',
    failover: 'source failover'
  };
  const entries = Object.entries(byDetector ?? {}).filter(([, count]) => count > 0);
  if (entries.length === 0) {
    return 'nothing';
  }
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([detector, count]) => `${count} ${labels[detector] ?? (detector.startsWith('gnss.') ? `GNSS ${detector.slice(5)}` : detector)}`)
    .join(', ');
}
