/**
 * @neutronai/reminders — ritual COMPLETION DELIVERY + FAILURE SURFACING helpers
 * (executor-mode reminders, plan task 5).
 *
 * Pure formatting helpers + the boot-reap driver. Everything here is delivery
 * POLICY, decoupled from the executor's fire path so it can be unit-tested with
 * no substrate:
 *   - one-line notice formatters (failure / escalation / boot-reap / completion
 *     fallback) — no em dashes, single line, capped;
 *   - `shouldEscalate` — the deterministic once-per-streak rule over the last 4
 *     terminal rows (zero new state);
 *   - `reapOrphanRitualRuns` — marks prior-boot orphaned 'running' rows 'crashed'
 *     and posts one best-effort notice each.
 *
 * Imports stay IN-BAND (only ./dispatcher.ts types, ./ritual-runs.ts, and the
 * logger) so no new cross-band depcruise edge is introduced.
 */

import { createLogger } from '@neutronai/logger'
import type { ReminderOutbound } from './dispatcher.ts'
import type {
  RitualRunRow,
  RitualRunStatus,
  RitualRunStore,
  RitualRunTerminalStatus,
} from './ritual-runs.ts'

const log = createLogger('ritual-delivery')

/** Consecutive failures that trigger the once-per-streak escalation notice. */
export const RITUAL_ESCALATION_CONSECUTIVE_FAILURES = 3

/**
 * The statuses that count as a FAILURE (finished/cancelled/skipped/running are
 * NOT). Typed over the FULL `RitualRunStatus` union so it can be queried against
 * any status without narrowing (the streak re-arm gate checks the 4th row, which
 * is not pre-narrowed to a terminal status).
 */
const FAIL: ReadonlySet<RitualRunStatus> = new Set<RitualRunStatus>(['failed', 'timed_out', 'crashed'])

/** Max chars of a failure reason appended to a one-line notice. */
const MAX_REASON_CHARS = 160

/** Collapse all whitespace runs (incl. newlines) to single spaces, trim. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * A one-line failure notice: `Ritual '<id>' <status> (run <run_id>)`, plus
 * `: <reason>` when a non-empty failure reason is present (whitespace collapsed,
 * capped at 160 chars). No trailing newline; no em dashes.
 */
export function formatRitualFailureNotice(i: {
  ritual_id: string
  status: RitualRunTerminalStatus
  run_id: string
  failure_reason?: string | null
}): string {
  const base = `Ritual '${i.ritual_id}' ${i.status} (run ${i.run_id})`
  const reason = i.failure_reason != null ? oneLine(i.failure_reason) : ''
  if (reason.length === 0) return base
  return `${base}: ${reason.slice(0, MAX_REASON_CHARS)}`
}

/** A finished-but-empty-output ritual's success line. */
export function formatRitualCompletionFallback(i: { ritual_id: string; run_id: string }): string {
  return `Ritual '${i.ritual_id}' finished (run ${i.run_id}): no output.`
}

/** The once-per-streak escalation notice (3 consecutive failures). */
export function formatRitualEscalationNotice(i: { ritual_id: string; run_id: string }): string {
  return `Ritual '${i.ritual_id}' has failed 3 consecutive runs (latest run ${i.run_id}). Consider pausing it.`
}

/** The boot-reap crash notice for an orphaned 'running' row. */
export function formatRitualBootReapNotice(i: { ritual_id: string; run_id: string }): string {
  return `Ritual '${i.ritual_id}' crashed (run ${i.run_id}): the gateway restarted while it was running.`
}

/**
 * Deterministic once-per-streak escalation rule over the most-recent terminal
 * rows (NEWEST FIRST — pass `listRecentTerminal({ ritual_id, limit: 4 })` taken
 * AFTER the newest failure row is written).
 *
 * True iff the 3 newest rows are all failures AND either there is no 4th row or
 * the 4th (older) row is NOT a failure — i.e. any streak-breaker (`finished`
 * success OR an operator `cancelled`) re-arms the notice. This fires EXACTLY
 * ONCE at the moment a streak crosses 3: the 4th CONSECUTIVE failure has a
 * failing 4th row so it returns false, and a streak-breaker then 3 more failures
 * re-arms it — all with zero new state. Gating on `=== 'finished'` (instead of
 * `!FAIL.has()`) would permanently suppress escalation for any streak preceded
 * by a cancel, since `cancelled` breaks the streak but is not a success (Argus
 * r2 blocker).
 */
export function shouldEscalate(rowsNewestFirst: ReadonlyArray<Pick<RitualRunRow, 'status'>>): boolean {
  if (rowsNewestFirst.length < RITUAL_ESCALATION_CONSECUTIVE_FAILURES) return false
  for (let i = 0; i < RITUAL_ESCALATION_CONSECUTIVE_FAILURES; i++) {
    const s = rowsNewestFirst[i]!.status
    if (s === 'running' || s === 'skipped' || !FAIL.has(s)) return false
  }
  if (rowsNewestFirst.length < RITUAL_ESCALATION_CONSECUTIVE_FAILURES + 1) return true
  // The 4th (older) row re-arms the notice unless it is itself a failure (which
  // means this is the 4th+ consecutive failure and we already escalated). Any
  // non-failure streak-breaker — `finished` OR `cancelled` — re-arms.
  return !FAIL.has(rowsNewestFirst[RITUAL_ESCALATION_CONSECUTIVE_FAILURES]!.status)
}

/**
 * Reap `code_ritual_runs` rows a PRIOR boot left 'running' — mark each 'crashed'
 * and post one best-effort boot-reap notice.
 *
 * The FIRST statement MUST remain the synchronous `listOrphanRunning()` snapshot:
 * `code_ritual_runs` has no boot_id column, so the only thing that keeps this
 * from clobbering a CURRENT-boot live run is ORDERING — this driver is called
 * during compose, before build-core-modules starts the tick loop, so at snapshot
 * time no current-boot 'running' row can exist. `markTerminal`'s
 * `WHERE status = 'running'` guard makes a repeat call a no-op (idempotent).
 *
 * Never throws: each notice post is try/catch-wrapped; the durable row is the
 * record.
 */
export async function reapOrphanRitualRuns(input: {
  runs: RitualRunStore
  outbound: ReminderOutbound
  topic_id: string
  owner_slug: string
  now?: () => number
}): Promise<RitualRunRow[]> {
  // FIRST, SYNCHRONOUS statement — the current-boot safety guarantee. Do not
  // move this behind an await or wrap the call in a deferred thunk.
  const orphans = input.runs.listOrphanRunning()
  const now = input.now ?? Date.now
  for (const row of orphans) {
    // eslint-disable-next-line no-await-in-loop
    await input.runs.markTerminal({
      run_id: row.run_id,
      status: 'crashed',
      ended_at_ms: now(),
      failure_reason: 'orphaned by gateway restart (boot reap)',
    })
    try {
      // eslint-disable-next-line no-await-in-loop
      await input.outbound.post({
        topic_id: input.topic_id,
        owner_slug: input.owner_slug,
        body: formatRitualBootReapNotice({ ritual_id: row.ritual_id, run_id: row.run_id }),
        reminder_id: row.reminder_id ?? row.run_id,
      })
    } catch (err) {
      log.error('ritual_reap_notice_failed', {
        run_id: row.run_id,
        ritual_id: row.ritual_id,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    }
  }
  return orphans
}
