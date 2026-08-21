/**
 * trident/checkpoint-phase.ts — the canonical checkpoint → phase mapping.
 *
 * WHY THIS EXISTS. `code_trident_runs.phase` was decorative. Measured over every
 * run this database has ever held: `failed` 138, `stopped` 59, `done` 9,
 * `forge-init` 1 — and ZERO rows in any of the four in-flight phases
 * (`ralph-plan`, `ralph-task`, `forge-fix`, `argus`). The column was written once
 * at create (`store.ts` `input.phase ?? 'forge-init'`) and then not again until a
 * terminal write, so for the whole life of a build every raw read of `phase` said
 * "init" — through a 40-minute Forge round, through review, through fix rounds.
 *
 * The information was never missing. The inner workflow stamps `inner_checkpoint`
 * faithfully at every transition (`forge-done`, `ralph-task-built`,
 * `argus-request-changes-round-N`, `fix-round-N`, …). It simply never reached the
 * column that names the phase, because the exec-model orchestrator drives the loop
 * and `state-machine.ts`'s per-phase graph — the only thing that ever computed
 * those four phases — is deliberately not in that path (see the header of
 * `orchestrator.ts`).
 *
 * The cost was paid by every reader that has no checkpoint-decoder of its own:
 * `/code status`, `active-runs.ts`, the board reconciler, and every operator SQL
 * query. `run-progress.ts` had already grown a private workaround — its own
 * inline checkpoint decoder, under a comment reading "the outer phase alone is
 * stuck on `forge-init` for the whole build". That workaround is why the UI was
 * right while everything else was wrong, and having ONE canonical table here is
 * what stops the next reader from writing a third copy that disagrees with both.
 *
 * MIRRORED IN BASH. `trident/checkpoint.sh` applies this same table at the single
 * choke point every live checkpoint write flows through, because the inner
 * workflow checkpoints via that script and NOT via `TridentRunStore.update`. The
 * two copies are pinned against each other by `checkpoint-phase.test.ts` — the
 * same treatment the terminal-phase set already gets, for the same reason: a
 * second copy that silently drifts is worse than no second copy.
 */

import type { TridentPhase } from './store.ts'

/**
 * The live phase a checkpoint implies, or `null` when it implies NOTHING and the
 * phase must be left exactly as it is.
 *
 * `null` is the answer for three distinct cases, and conflating any of them with
 * a guess is how a status read starts lying in a NEW way instead of the old one:
 *
 *   * TERMINAL-ADJACENT — `pr-merged` (the outer loop stamps `done` on its next
 *     tick) and `inner-error` / `awaiting-trailer` (both written on the inner
 *     loop's THROW path, where the outer loop stamps `failed`). Naming a live
 *     phase here would show a finished run as working.
 *   * OUTER-LOOP MARKERS — `outer-published:<sha>:<n>:<m>` and anything else the
 *     outer loop writes for its own bookkeeping.
 *   * UNRECOGNISED — a checkpoint this table has never seen. Deliberately not a
 *     throw and not a default: a new checkpoint name must leave the column
 *     untouched rather than assert a phase nobody chose.
 */
export function phaseForCheckpoint(checkpoint: string | null): TridentPhase | null {
  if (checkpoint === null || checkpoint === '') return null

  // The build finished and review is what runs next. `argus-approved` is also
  // `argus`: the reviewer has spoken but the run is still the review's to own
  // until the outer loop merges and stamps `done`.
  if (checkpoint === 'forge-done' || checkpoint === 'argus-approved') return 'argus'

  // `fix-round-N` marks fix N as BUILT, so the re-review is what is now running.
  // This is the one the two existing decoders disagreed about — `deriveStepLabel`
  // read it as 'reviewing' (correct) while `deriveRunProgress` read it as
  // 'building' (the phase that had just ENDED), so one snapshot carried both
  // claims at once.
  if (/^fix-round-\d+$/.test(checkpoint)) return 'argus'

  // Review asked for changes → the fix round is what runs next.
  if (checkpoint === 'argus-request-changes' || /^argus-request-changes-round-\d+$/.test(checkpoint)) {
    return 'forge-fix'
  }

  // One Ralph task built, the next one is being built.
  if (checkpoint === 'ralph-task-built') return 'ralph-task'

  return null
}
