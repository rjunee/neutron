/**
 * @neutronai/app — project-backups + restore API client (P7.4 restore UI).
 *
 * Thin fetch wrapper for the gateway's
 * `/api/app/projects/<id>/backups[...]` + `/api/app/projects/<id>/restore`
 * routes. Mirrors the P5.4 / P7.0 client shape: pass the bearer token
 * at construction time; each call returns the canonical server view.
 *
 * Backing surface: `gateway/http/app-backups-surface.ts`. Backing store:
 * `gateway/git/project-backup-store.ts` — same `.project-backup/` repo
 * the P7.4 Phase 2 admin surface manages.
 */

import {
  GatewayClientError,
  GatewayHttpClient,
  type GatewayHttpClientOptions,
} from '@neutronai/client-core';

export interface SnapshotSummary {
  sha: string;
  parent_sha: string | null;
  message: string;
  author_date: string;
  shortstat: { files_changed: number; insertions: number; deletions: number } | null;
}

export type SnapshotFileStatus = 'added' | 'modified' | 'deleted' | 'unchanged';

export interface SnapshotFile {
  path: string;
  status: SnapshotFileStatus;
  size_bytes_at_sha: number | null;
}

export interface SnapshotPreview {
  sha: string;
  parent_sha: string | null;
  message: string;
  author_date: string;
  files: SnapshotFile[];
}

export interface SnapshotFileContent {
  sha: string;
  path: string;
  content: string;
  binary: boolean;
  size_bytes: number;
  truncated: boolean;
}

export interface SnapshotFileDiff {
  sha: string;
  path: string;
  hunks: string;
  truncated: boolean;
}

export interface RestoreResult {
  snapshot_sha: string;
  prior_head_sha: string;
  recovery_commit_sha: string;
  file_path: string | null;
  completed_at_ms: number;
}

export type BackupsClientOptions = GatewayHttpClientOptions;

export class BackupsClientError extends GatewayClientError {
  constructor(code: string, message: string, status: number) {
    super(code, message, status);
    this.name = 'BackupsClientError';
  }
}

export class BackupsClient extends GatewayHttpClient {
  protected override makeError(code: string, message: string, status: number): GatewayClientError {
    return new BackupsClientError(code, message, status);
  }

  async listSnapshots(
    project_id: string,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ snapshots: SnapshotSummary[]; next_cursor: string | null }> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor !== null && opts.cursor !== undefined) {
      params.set('cursor', opts.cursor);
    }
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    const res = await this.req<{
      ok: boolean;
      snapshots: SnapshotSummary[];
      next_cursor: string | null;
    }>(`/api/app/projects/${encodeURIComponent(project_id)}/backups${qs}`);
    return { snapshots: res.snapshots, next_cursor: res.next_cursor };
  }

  async previewSnapshot(
    project_id: string,
    sha: string,
  ): Promise<SnapshotPreview> {
    const res = await this.req<{ ok: boolean; preview: SnapshotPreview }>(
      `/api/app/projects/${encodeURIComponent(project_id)}/backups/${encodeURIComponent(sha)}`,
    );
    return res.preview;
  }

  async getSnapshotFile(
    project_id: string,
    sha: string,
    path: string,
  ): Promise<SnapshotFileContent> {
    const qs = `?path=${encodeURIComponent(path)}`;
    const res = await this.req<{ ok: boolean; file: SnapshotFileContent }>(
      `/api/app/projects/${encodeURIComponent(project_id)}/backups/${encodeURIComponent(sha)}/file${qs}`,
    );
    return res.file;
  }

  async getSnapshotDiff(
    project_id: string,
    sha: string,
    path: string,
  ): Promise<SnapshotFileDiff> {
    const qs = `?path=${encodeURIComponent(path)}`;
    const res = await this.req<{ ok: boolean; diff: SnapshotFileDiff }>(
      `/api/app/projects/${encodeURIComponent(project_id)}/backups/${encodeURIComponent(sha)}/diff${qs}`,
    );
    return res.diff;
  }

  /**
   * Trigger a restore. Pass `file_path: null` (or omit) for a
   * whole-project restore; pass a relative path to restore just one
   * file. The recovery commit lands in the project's
   * `.project-backup/` history; the response carries both the new
   * recovery sha AND the prior HEAD sha so the UI can stash the latter
   * to fuel a one-tap "undo this restore" follow-up.
   */
  async restore(
    project_id: string,
    snapshot_sha: string,
    file_path?: string | null,
  ): Promise<RestoreResult> {
    const body: { snapshot_sha: string; file_path?: string | null } = {
      snapshot_sha,
    };
    if (file_path !== undefined && file_path !== null) {
      body.file_path = file_path;
    }
    const res = await this.req<{ ok: boolean; restore: RestoreResult }>(
      `/api/app/projects/${encodeURIComponent(project_id)}/restore`,
      { method: 'POST', body },
    );
    return res.restore;
  }
}

/**
 * Pretty-print a snapshot timestamp relative to `now`. Mirrors
 * `app/lib/docs-client.ts` short-relative formatting:
 *   <1m ago, <Nm ago, <Nh ago, <Nd ago, then ISO date.
 */
export function formatRelativeTime(iso: string, now_ms: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const delta = Math.max(0, now_ms - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Bucket snapshots by local-tz day. Returns a list of `{ day_iso,
 * label, snapshots }` rows so the UI can render collapsible day-
 * buckets without doing the grouping itself.
 *
 * `label` is the day relative to `now`:
 *   - "Today"      — same local-tz date
 *   - "Yesterday"  — yesterday local-tz
 *   - "MMM D"      — within current year
 *   - "MMM D YYYY" — older
 */
export function groupSnapshotsByDay(
  snapshots: readonly SnapshotSummary[],
  now_ms: number,
): Array<{ day_iso: string; label: string; snapshots: SnapshotSummary[] }> {
  if (snapshots.length === 0) return [];
  const todayKey = localDayKey(now_ms);
  const yesterdayKey = localDayKey(now_ms - 86_400_000);
  const groups = new Map<string, SnapshotSummary[]>();
  const orderedKeys: string[] = [];
  for (const snap of snapshots) {
    const t = Date.parse(snap.author_date);
    const key = Number.isFinite(t) ? localDayKey(t) : 'unknown';
    if (!groups.has(key)) {
      groups.set(key, []);
      orderedKeys.push(key);
    }
    groups.get(key)!.push(snap);
  }
  return orderedKeys.map((key) => {
    const items = groups.get(key)!;
    let label: string;
    if (key === todayKey) label = 'Today';
    else if (key === yesterdayKey) label = 'Yesterday';
    else label = formatDayLabel(key, now_ms);
    return { day_iso: key, label, snapshots: items };
  });
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatDayLabel(day_iso: string, now_ms: number): string {
  const parts = day_iso.split('-').map(Number);
  if (parts.length !== 3) return day_iso;
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  const month = MONTHS[m - 1] ?? '?';
  const currentYear = new Date(now_ms).getFullYear();
  if (y === currentYear) return `${month} ${d}`;
  return `${month} ${d} ${y}`;
}
