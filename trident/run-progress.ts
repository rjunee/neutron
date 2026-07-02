/**
 * @neutronai/trident — live run-progress derivation for the Work Board (M1
 * trident-UX hardening, item 1).
 *
 * A board item bound to a trident run (`work_board_items.linked_run_id`) shows
 * only a fork `⑂` glyph today — no phase, round, or elapsed. This pure module
 * derives a compact LIVE progress summary from the linked `code_trident_runs`
 * row so the Work Board surface (HTTP GET) and the `work_board_changed` push can
 * both ship it on each item (ONE derivation, two callers).
 *
 * DERIVATION IS phase + checkpoint, NOT phase alone. In the Phase-2a EXEC model
 * the OUTER run `phase` stays `forge-init` for the WHOLE inner Forge→Argus→fix
 * workflow (`orchestrator.ts` only transitions it to a TERMINAL phase); the live
 * granularity lives in `inner_checkpoint` (`forge-done` → reviewing,
 * `fix-round-N` → building round N, `argus-approved` → reviewing/merging), which
 * the inner workflow re-stamps mid-run. So a label read off `phase` alone would
 * be stuck on "planning" the entire build. We map the terminal phases directly
 * and refine the live phases with the checkpoint.
 */

import type { TridentPhase, TridentRun } from './store.ts'

/**
 * A run whose `last_advanced_at` has not moved for longer than this while
 * non-terminal is shown with a "⚠️ stalled Nm" warning on its Plan item. This is
 * the DISPLAY warning threshold only — it is deliberately SHORTER than the
 * orchestrator's `NO_ADVANCE_HANG_MS` reap threshold (15m), so a stall is warned
 * about first and only reaped to `failed` if it persists.
 */
export const STALLED_WARN_MS = 10 * 60_000

/** Human-legible live phase of a bound run, for the Plan-item sub-label. */
export type RunPhaseLabel =
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'merged'
  | 'failed'
  | 'cancelled'

/**
 * The compact run-derived progress attached to a bound board item. All fields
 * are snapshot-at-derivation EXCEPT `started_at`/`last_advanced_at`, which the
 * client can use to tick `elapsed`/`stalled` live between polls.
 */
export interface RunProgress {
  /** Which run this progress is for (correlates with `linked_run_id`). */
  run_id: string
  phase_label: RunPhaseLabel
  /** Review/fix cycle count (1 during the first build+review; N during fix-round-N). */
  round: number
  /** ISO-8601 UTC run start — the client ticks live elapsed off this. */
  started_at: string
  /** ISO-8601 UTC last checkpoint/transition — the client ticks live stall off this. */
  last_advanced_at: string
  /** Server snapshot of `now - started_at` (ms). */
  elapsed_ms: number
  /** Non-terminal AND no advance for > `STALLED_WARN_MS`. */
  stalled: boolean
  /** How long stalled (ms), or null when not stalled. */
  stalled_ms: number | null
  pr: number | null
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | null
  /** The failure reason (e.g. the hang-watchdog reap) when `phase_label==='failed'`. */
  failure_reason: string | null
}

const TERMINAL_PHASES: readonly TridentPhase[] = ['done', 'failed', 'stopped']

/** The base label for a phase, before any `inner_checkpoint` refinement. */
function baseLabel(phase: TridentPhase): RunPhaseLabel {
  switch (phase) {
    case 'forge-init':
    case 'ralph-plan':
      return 'planning'
    case 'ralph-task':
    case 'forge-fix':
      return 'building'
    case 'argus':
      return 'reviewing'
    case 'done':
      return 'merged'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'cancelled'
  }
}

/**
 * Derive the live progress summary for a run. Pure + clock-injected (`nowMs`)
 * so both the HTTP surface and the push helper compute an identical snapshot.
 */
export function deriveRunProgress(run: TridentRun, nowMs: number): RunProgress {
  const startedMs = Date.parse(run.started_at)
  const advancedMs = Date.parse(run.last_advanced_at)
  const elapsed_ms = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0
  const sinceAdvance = Number.isFinite(advancedMs) ? Math.max(0, nowMs - advancedMs) : 0
  const terminal = TERMINAL_PHASES.includes(run.phase)

  let phase_label = baseLabel(run.phase)
  let round = run.round > 0 ? run.round : 1

  // Refine the LIVE (non-terminal) label with the inner workflow's checkpoint —
  // the outer phase alone is stuck on `forge-init` for the whole build.
  if (!terminal && run.inner_checkpoint !== null) {
    const cp = run.inner_checkpoint
    const fixRound = /fix-round-(\d+)/.exec(cp)
    if (fixRound !== null) {
      round = Math.max(round, Number(fixRound[1]))
      phase_label = 'building'
    } else if (cp === 'forge-done' || cp === 'argus-approved') {
      // Build finished → reviewing (or approved, about to merge).
      phase_label = 'reviewing'
    } else if (cp === 'argus-request-changes') {
      // Review asked for changes → a fix round is starting.
      phase_label = 'building'
    }
    // `inner-error` / any other checkpoint → keep the base label (about to fail).
  }

  const stalled = !terminal && sinceAdvance > STALLED_WARN_MS
  return {
    run_id: run.id,
    phase_label,
    round,
    started_at: run.started_at,
    last_advanced_at: run.last_advanced_at,
    elapsed_ms,
    stalled,
    stalled_ms: stalled ? sinceAdvance : null,
    pr: run.pr,
    verdict: run.inner_verdict,
    failure_reason: run.failure_reason,
  }
}

/**
 * Derive the progress for a board item bound to a run, or null when the item has
 * no linked run (or the run row is gone / cross-project). `lookupRun` is
 * `TridentRunStore.get`; `nowMs` is the caller's clock.
 */
export function runProgressForItem(
  item: { linked_run_id: string | null; project_slug?: string },
  lookupRun: (run_id: string) => TridentRun | null,
  nowMs: number,
): RunProgress | null {
  const runId = item.linked_run_id
  if (runId === null || runId.length === 0) return null
  const run = lookupRun(runId)
  if (run === null) return null
  // Defensive scope check — a linked_run_id should only ever name this project's
  // run, but never derive across instances.
  if (item.project_slug !== undefined && run.project_slug !== item.project_slug) return null
  return deriveRunProgress(run, nowMs)
}
