/**
 * @neutronai/trident — IS THIS RUN BLOCKED BY INFRASTRUCTURE, OR WAS ITS CODE REJECTED?
 *
 * A deferral and a rejection are different events and must not share a label. A run
 * that stopped because a required CI check never ran, because the PR is conflicting
 * with base, or because a credential blinked, terminates carrying
 * `verdict: 'REQUEST_CHANGES'` — the same clothes a genuine review rejection wears —
 * even though NO review seat ever read the diff. The durable distinction already
 * exists on the row: the inner workflow writes `blockKind: 'infra-only'` (plus the
 * MEASURED `terminalCause`) into `code_trident_runs.inner_result`. Nothing downstream
 * read it. This is the ONE place that does.
 *
 * THE GATE, and why each of its three conditions is load-bearing:
 *
 *  1. `phase === 'failed'` — an infra block is a TERMINAL failure story. A run still in
 *     flight (or `done`, or `stopped`) is not being explained by this.
 *  2. `harvested_at !== null` — THE STALE-RESULT HAZARD. A force-terminated or cancelled
 *     row can keep a stale but perfectly parseable `inner_result` from an earlier
 *     iteration (see the `inner_result` / `harvested_at` field docs in `store.ts` ~140,
 *     and the ownership note ~301): `saveIfActive` never overwrites it, so the column
 *     alone cannot say "this is how the run ACTUALLY ended". `harvested_at` is written
 *     EXCLUSIVELY by `orchestrator.applyResult` — the outer loop decoded this exact
 *     result and made its decision on it — so it is the force-terminate-proof proof that
 *     the result belongs to this ending.
 *  3. `parseInnerResult(...).block_kind === 'infra-only'` EXACTLY. `parseInnerResult`
 *     already decodes the kind FAIL-CLOSED (only the four strings the workflow writes
 *     decode; a garbled/truncated/future kind becomes `null` and can never be read as
 *     'infra-only'). We rely on that rather than re-validating — one decoder, one rule.
 *
 * Fail-closed by construction: anything short of all three returns `null`, and the
 * caller keeps its existing behaviour byte-for-byte. Mislabelling a genuine rejection as
 * infrastructure is the strictly worse error, so the ambiguous cases fall that way.
 *
 * THE ONE DERIVER. `trident/delivery.ts` (the chat result) and — next task —
 * `trident/run-progress.ts` (the board payload) BOTH read the distinction through this
 * function. Neither re-implements the gate: two copies would drift, and the two surfaces
 * would then disagree about whether the machine or the code was broken.
 */

import { parseInnerResult } from './inner-loop.ts'
import type { TridentRun } from './store.ts'

/** A terminal run that was blocked by INFRASTRUCTURE before any reviewer judged the code. */
export interface InfraBlock {
  /**
   * The MEASURED cause, verbatim from the workflow ("required check `test` has not run",
   * "PR is conflicting with base"), already redacted + clamped by `parseInnerResult`.
   * `null` when the workflow measured none — the block kind WAS measured, so the run is
   * still infra-blocked; only the message stays generic. Never assert a cause nobody
   * measured.
   */
  cause: string | null
}

/**
 * Derive the infra-block fact from a run row, or `null` when this run is not one.
 * Pure + deterministic (no I/O), so both consuming surfaces are unit-testable.
 */
export function deriveInfraBlock(
  run: Pick<TridentRun, 'phase' | 'harvested_at' | 'inner_result'>,
): InfraBlock | null {
  if (run.phase !== 'failed') return null
  // `harvested_at !== null`, spelled fail-closed: an absent field on a partial row must
  // read as "not harvested", never slip through as "not null".
  if (typeof run.harvested_at !== 'number') return null
  const result = parseInnerResult(run.inner_result)
  if (result === null || result.block_kind !== 'infra-only') return null
  return { cause: result.terminal_cause }
}

/**
 * T4 (run `f384460d`) — THE one sentence for an INFRASTRUCTURE death.
 *
 * The inner workflow threw; nothing about the diff was ever judged. The reason
 * has to say that in words, because `interpretFailure` reads the reason (not the
 * verdict) to choose the class the owner is delivered.
 *
 * ONE source: the orchestrator WRITES this into `failure_reason` and
 * `interpretFailure` READS it back to route the `infra` class, so a reworded
 * sentence can never become one the delivery silently stops recognising.
 *
 * IT LIVES HERE, not beside either reader, because both ends need it and they
 * already point at each other: `delivery.ts` imports `orchestrator.ts`, so
 * declaring this in `delivery.ts` made the orchestrator import back and closed
 * a `no-cycles` violation. This module is the infra-classification leaf and
 * imports neither of them, so it is the one place both can reach.
 */
export function infraDeathSentence(round: number, ceiling: number): string {
  return `build infrastructure failed at round ${round} of ${ceiling} before any review verdict`
}
