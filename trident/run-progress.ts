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
import { STALLED_WARN_MS } from './liveness.ts'

export { STALLED_WARN_MS }

/** Human-legible live phase of a bound run, for the Plan-item sub-label. */
export type RunPhaseLabel =
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'merged'
  | 'failed'
  | 'cancelled'

/**
 * M1 UX REDESIGN — the compact INNER-STEP label the redesigned Work item renders
 * live (building → reviewing → fixing → merging → terminal). It is a REFINEMENT
 * of `phase_label` with the redesign's exact vocabulary, DERIVED from the inner
 * workflow's `inner_checkpoint` (which the inner loop re-stamps at every phase
 * boundary — `trident/inner-workflow.mjs` `checkpoint()`), NOT the outer `phase`
 * (stuck on `forge-init` the whole build). Because checkpoints are written at the
 * END of each inner phase, each value maps to the phase the run is CURRENTLY in:
 *   - (none, round-1 build in flight)  → building
 *   - `forge-done`                     → reviewing  (build done, review running)
 *   - `argus-request-changes`          → fixing     (changes asked, fix building)
 *   - `fix-round-N`                    → reviewing  (fix built, re-review running)
 *   - `argus-approved`                 → merging    (approved, outer loop merging)
 *   - terminal `done`                  → done
 *   - terminal `failed`/`stopped`      → failed
 * `fixing` = a post-review Forge fix-round (round ≥ 2); `merging` = the outer
 * loop's merge step. The redesign consumes this to show the item working live.
 */
export type RunStepLabel = 'building' | 'reviewing' | 'fixing' | 'merging' | 'done' | 'failed'

/**
 * The compact run-derived progress attached to a bound board item. All fields
 * are snapshot-at-derivation EXCEPT `started_at`/`last_advanced_at`, which the
 * client can use to tick `elapsed`/`stalled` live between polls.
 */
export interface RunProgress {
  /** Which run this progress is for (correlates with `linked_run_id`). */
  run_id: string
  phase_label: RunPhaseLabel
  /**
   * M1 UX REDESIGN — the inner-step label (building/reviewing/fixing/merging +
   * terminal done/failed) the redesigned Work item renders live. Derived from the
   * inner workflow's checkpoint (see {@link RunStepLabel}). Always present.
   */
  step_label: RunStepLabel
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
 * M1 UX REDESIGN — map the outer phase + inner checkpoint to the redesign's
 * inner-step vocabulary. Pure + total (every input yields a label). Terminal
 * phases win; otherwise the live checkpoint (end-of-phase marker) names the phase
 * the run is CURRENTLY in — see {@link RunStepLabel} for the full mapping.
 */
export function deriveStepLabel(phase: TridentPhase, inner_checkpoint: string | null): RunStepLabel {
  if (phase === 'done') return 'done'
  if (phase === 'failed' || phase === 'stopped') return 'failed'
  // Live (non-terminal) — refine off the inner workflow's checkpoint.
  const cp = inner_checkpoint
  if (cp === null) return 'building' // round-1 build in flight (no checkpoint yet)
  if (cp === 'argus-approved') return 'merging' // approved → outer loop merging
  if (cp === 'argus-request-changes') return 'fixing' // changes asked → fix building
  if (cp === 'forge-done') return 'reviewing' // build done → review running
  if (/^fix-round-\d+$/.test(cp)) return 'reviewing' // fix built → re-review running
  // `inner-error` / any unrecognised checkpoint → still building (about to fail).
  return 'building'
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
  // FIX #336 — the DISPLAYED round is the inner fix-iteration, NOT the outer
  // `code_trident_runs.round`. The review→fix cycle happens ENTIRELY inside the
  // in-process inner workflow (`inner-workflow.mjs`); its `checkpoint()` only ever
  // re-stamps `inner_checkpoint` and never bumps the outer `round` column, so
  // `run.round` is pinned at 1 for the whole build. Deriving the round off the
  // checkpoint fixes a `fixing` item (a POST-review fix round) showing the
  // contradictory "round 1". Contract (see {@link RunStepLabel}):
  //   building (first)          → round 1   (cp null)
  //   reviewing (forge-done)    → round 1   (first review of the first build)
  //   fixing (request-changes)  → round ≥ 2 (a post-review fix round is starting)
  //   reviewing (fix-round-N)   → round N   (Nth fix built, re-review running)
  // The exact fix-round is unambiguous from `fix-round-N`; a bare
  // `argus-request-changes` only tells us a fix round is IMMINENT (≥ 2), so we
  // floor it at 2 (the very next checkpoint `fix-round-N` carries the precise N).
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
      // Review asked for changes → a fix round (round ≥ 2) is starting.
      round = Math.max(round, 2)
      phase_label = 'building'
    }
    // `inner-error` / any other checkpoint → keep the base label (about to fail).
  }

  const stalled = !terminal && sinceAdvance > STALLED_WARN_MS
  return {
    run_id: run.id,
    phase_label,
    step_label: deriveStepLabel(run.phase, run.inner_checkpoint),
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
