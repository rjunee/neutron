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
 * THE ONE DERIVER, AND SINCE #520 IT DERIVES TWO FACTS OVER ONE GATE. `deriveInfraBlock`
 * answers "was the machine broken, or was the code rejected"; `deriveTerminalCause`
 * answers "which of the known terminal exits was this". They share
 * `harvestedTerminalResult` precisely so the staleness rule below cannot be widened for
 * one question and not the other.
 *
 * `trident/delivery.ts` (the chat result) and — next task —
 * `trident/run-progress.ts` (the board payload) BOTH read the distinction through this
 * function. Neither re-implements the gate: two copies would drift, and the two surfaces
 * would then disagree about whether the machine or the code was broken.
 */

import { parseInnerResult } from './inner-loop.ts'
import type { TridentRun } from './store.ts'
import type { TerminalCause } from './terminal-cause.ts'

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
  const result = harvestedTerminalResult(run)
  if (result === null || result.block_kind !== 'infra-only') return null
  return { cause: result.terminal_cause }
}

/**
 * THE HARVESTED TERMINAL RESULT, OR NOTHING — conditions 1 and 2 of the gate described
 * at the top of this module, in ONE place, so the two questions this module answers about
 * a run row are asked over exactly the same evidence.
 *
 * ONE COPY, AND THAT IS THE WHOLE POINT OF EXTRACTING IT. Two copies of a staleness gate
 * is two chances to widen one of them, and the one that stayed narrow would then be the
 * only thing standing between a stale `inner_result` and a sentence about an ending that
 * is not this run's. This is not hypothetical: the first cut of #520 left
 * `deriveInfraBlock`'s copy in place beside the call, so the module had exactly the two
 * gates its own docblock said it did not have.
 *
 * Not exported: the gate is only meaningful together with the question it guards, and a
 * caller holding the raw result would be one refactor away from asking it about an
 * unharvested row.
 */
function harvestedTerminalResult(
  run: Pick<TridentRun, 'phase' | 'harvested_at' | 'inner_result'>,
): ReturnType<typeof parseInnerResult> {
  if (run.phase !== 'failed') return null
  // `harvested_at !== null`, spelled fail-closed: an absent field on a partial row must
  // read as "not harvested", never slip through as "not null".
  if (typeof run.harvested_at !== 'number') return null
  return parseInnerResult(run.inner_result)
}

/**
 * WHY THE INNER LOOP STOPPED, off the row (#520) — or `null` when this run cannot say.
 *
 * THE SECOND STRUCTURAL FACT THIS MODULE DERIVES, and the sibling of
 * {@link deriveInfraBlock}: same gate, same fail-closed reading, different question.
 * That one asks "was the machine broken or was the code rejected", which only the
 * `'infra-only'` kind answers; this one asks "which of the known exits was this", which
 * every terminal path now answers — including the review-verdict exits that emitted
 * nothing at all before this card, and which therefore reached the owner as one
 * undifferentiated sentence.
 *
 * `null` COVERS THREE DIFFERENT SILENCES AND BUYS THE SAME THING FOR ALL OF THEM: the
 * run is not terminally failed, its result was never harvested (so a stale
 * `inner_result` from an earlier iteration must not be read as this ending — see the
 * gate's own note), or the result carried no recognisable kind. In every case the caller
 * keeps the behaviour it had before this field existed, byte for byte.
 *
 * `'unknown'` IS NOT ONE OF THOSE SILENCES. It is the workflow asserting that it looked
 * at its own exit conditions and could not name one, and it is returned as itself so a
 * caller can tell "I was told nothing" from "I was told that nothing could be told".
 * Both end in saying less; only one of them is a measurement.
 */
export function deriveTerminalCause(
  run: Pick<TridentRun, 'phase' | 'harvested_at' | 'inner_result'>,
): TerminalCause | null {
  return harvestedTerminalResult(run)?.terminal_cause_kind ?? null
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
