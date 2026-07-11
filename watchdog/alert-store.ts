/**
 * @neutronai/watchdog — alert ledger.
 *
 * Persists fired alerts into the `watchdog_alerts` table (migration 0004).
 * Append-only; `resolveAlert(id)` sets resolved_at when a condition clears.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { parseJsonColumn } from '@neutronai/persistence/index.ts'
import type { WatchdogAlert, WatchdogKind } from './types.ts'

interface RawAlertRow {
  id: string
  kind: string
  project_slug: string
  detected_at: number
  resolved_at: number | null
  payload_json: string
}

export class AlertStore {
  constructor(private readonly db: ProjectDb) {}

  /**
   * Persist a fired alert. IDEMPOTENT (F4 round-3): `INSERT OR IGNORE` — a
   * re-record of an already-persisted incident id is a silent no-op success, NOT
   * a throw. This is what makes the supervisor's COMMIT-ON-SUCCESS retry safe: if
   * `record()` succeeded but the notifier failed, the next tick re-records the
   * SAME id (no duplicate row, no throw) and re-attempts the notify. A REAL store
   * failure (disk full, locked DB) still throws, so the supervisor can leave the
   * incident un-committed and retry it — never latching dedup on a transient blip.
   */
  async record(alert: WatchdogAlert): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO watchdog_alerts
         (id, kind, project_slug, detected_at, resolved_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        alert.id,
        alert.kind,
        alert.project_slug,
        alert.detected_at,
        alert.resolved_at,
        JSON.stringify(alert.payload),
      ],
    )
  }

  async resolve(id: string, resolved_at: number): Promise<void> {
    await this.db.run(
      `UPDATE watchdog_alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`,
      [resolved_at, id],
    )
  }

  listOpen(project_slug: string): WatchdogAlert[] {
    return this.db
      .prepare<RawAlertRow, [string]>(
        `SELECT id, kind, project_slug, detected_at, resolved_at, payload_json
           FROM watchdog_alerts
          WHERE project_slug = ? AND resolved_at IS NULL
          ORDER BY detected_at ASC`,
      )
      .all(project_slug)
      .map(rowToAlert)
  }

  /** Snapshot of all alerts (open + resolved), for tests + observability. */
  listAll(project_slug: string): WatchdogAlert[] {
    return this.db
      .prepare<RawAlertRow, [string]>(
        `SELECT id, kind, project_slug, detected_at, resolved_at, payload_json
           FROM watchdog_alerts
          WHERE project_slug = ?
          ORDER BY detected_at ASC`,
      )
      .all(project_slug)
      .map(rowToAlert)
  }
}

function rowToAlert(r: RawAlertRow): WatchdogAlert {
  return {
    id: r.id,
    kind: r.kind as WatchdogKind,
    project_slug: r.project_slug,
    detected_at: r.detected_at,
    resolved_at: r.resolved_at,
    payload: parseJsonColumn(r.payload_json, { onCorrupt: 'throw' }) as Record<string, unknown>,
  }
}
