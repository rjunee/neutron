/**
 * @neutronai/gateway/realmode-composer — GBrain sync-state observability store (P9).
 *
 * The sole writer of the `gbrain_sync_state` table (migration 0098; P4
 * table-ownership map). It implements the `GbrainSyncStateSink` port that
 * `GBrainSyncHook` calls best-effort at each latch / success / defer point, and
 * persists the snapshot as a single UPSERTed row keyed by GBrain scope (today
 * one brain per instance → one row per project slug).
 *
 * **Fail-soft, by two independent guards.** This unit adds VISIBILITY, not
 * behavior. The hook already wraps every `publish` call so a throw here can
 * never reach the sync path; belt-and-suspenders, this writer ALSO swallows its
 * own errors and uses `runSync` (a single-shot synchronous write that shares
 * fate with any in-flight transaction but never awaits) so a busy DB degrades
 * to a dropped diagnostic, never a stalled or aborted entity write. The row is
 * a pure diagnostic — sync correctness never depends on it.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { GbrainSyncStateSink, GbrainSyncStateSnapshot } from '@neutronai/gbrain-memory/index.ts'

/**
 * The persisted `gbrain_sync_state` row, decoded for a diagnostics reader. This
 * is the typed accessor O5's "is my memory being written?" diagnostics reads
 * (P9 ships the enabling data + this reader; O5 wires it into a surface).
 */
export interface GbrainSyncStateRow {
  scope: string
  status: 'ok' | 'unavailable'
  latchReason: string | null
  latchedAt: string | null
  /** ISO-8601 UTC of the last successful GBrain page persist; null until first success. */
  lastSuccessAt: string | null
  /** Current depth of the RAM deferred-edge retry queue at the last observation. */
  deferredCount: number
  /** ISO-8601 UTC of the last observability write. */
  updatedAt: string
}

interface RawGbrainSyncStateRow {
  scope: string
  status: string
  latch_reason: string | null
  latched_at: string | null
  last_success_at: string | null
  deferred_count: number
  updated_at: string
}

/**
 * Read the current sync-health row for a GBrain scope (the project slug today),
 * or `null` when no write has happened yet. The production reader for the P9
 * observability row — this is what makes the row answerable rather than
 * write-only. Pure read; not a table writer (does not affect table-ownership).
 */
export function readGbrainSyncState(input: { db: ProjectDb; scope: string }): GbrainSyncStateRow | null {
  const raw = input.db
    .prepare<RawGbrainSyncStateRow, [string]>(
      `SELECT scope, status, latch_reason, latched_at, last_success_at, deferred_count, updated_at
         FROM gbrain_sync_state
        WHERE scope = ?`,
    )
    .get(input.scope)
  if (raw === undefined || raw === null) return null
  return {
    scope: raw.scope,
    status: raw.status === 'unavailable' ? 'unavailable' : 'ok',
    latchReason: raw.latch_reason,
    latchedAt: raw.latched_at,
    lastSuccessAt: raw.last_success_at,
    deferredCount: raw.deferred_count,
    updatedAt: raw.updated_at,
  }
}

/**
 * Build the `gbrain_sync_state` observability sink for one GBrain scope.
 *
 * @param db    the per-instance ProjectDb (the migrated instance DB).
 * @param scope the GBrain scope key — the project slug today (one brain per
 *              instance; project partitioning lands in M2.6).
 */
export function createGbrainSyncStateStore(input: {
  db: ProjectDb
  scope: string
}): GbrainSyncStateSink {
  const { db, scope } = input
  return {
    publish(snapshot: GbrainSyncStateSnapshot): void {
      try {
        // UPSERT the single per-scope row. `runSync` is the blessed synchronous
        // mutation primitive (persistence/db.ts): not busy-retry-wrapped, but
        // it never awaits — exactly right for a fire-and-forget diagnostic
        // called from the hook's synchronous observation points.
        db.runSync(
          `INSERT INTO gbrain_sync_state
             (scope, status, latch_reason, latched_at, last_success_at, deferred_count, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope) DO UPDATE SET
             status          = excluded.status,
             latch_reason    = excluded.latch_reason,
             latched_at      = excluded.latched_at,
             -- Monotonic-keep: the sink's snapshot source (GBrainSyncHook's
             -- in-RAM lastSuccessAt) starts NULL on every process restart, so
             -- a publish before the first post-restart success (e.g. the
             -- unavailable-latch trip, or the end-of-write publish after a
             -- failed put_page) would otherwise carry snapshot.lastSuccessAt
             -- = null and clobber the durable last-known-good timestamp. That
             -- is exactly the failure scenario this row exists to diagnose
             -- ("was my memory being written, and until when?"), so a null
             -- incoming value must never erase a previously recorded one —
             -- COALESCE keeps the durable value until a REAL new success
             -- (a non-null excluded.last_success_at) supersedes it.
             last_success_at = COALESCE(excluded.last_success_at, gbrain_sync_state.last_success_at),
             deferred_count  = excluded.deferred_count,
             updated_at      = excluded.updated_at`,
          [
            scope,
            snapshot.status,
            snapshot.latchReason,
            snapshot.latchedAt,
            snapshot.lastSuccessAt,
            snapshot.deferredCount,
            new Date().toISOString(),
          ],
        )
      } catch {
        // Best-effort: a failed diagnostic write must never surface. The hook
        // already swallows a throw from here, but we swallow at the source too
        // so the contract is local + obvious.
      }
    },
  }
}
