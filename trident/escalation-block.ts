/**
 * @neutronai/trident — DID THIS RUN STOP BECAUSE IT WAS BLOCKED, OR BECAUSE IT FAILED?
 *
 * Two different words, and until this module there was only one. A run that stopped
 * because its PLAN could not succeed — a reviewer proved the design was wrong, the card
 * needed work that lives outside it, or the same finding survived a fix round — reached
 * the owner wearing ❌ and the sentence of a rejection, because every terminal
 * non-merge shares the `failed` phase. The owner then cannot tell "nobody can build
 * this until something else lands" from "this build broke", and those need opposite
 * responses.
 *
 * THE SIBLING OF `infra-block.ts`, deliberately down to the shape of its gate. That
 * module answers "was the MACHINE broken?"; this one answers "was the PLAN wrong?".
 * They are mutually exclusive by construction (one `block_kind` per result) and they
 * are kept apart because the two stops say opposite things about the review panel: an
 * infra block asserts NO seat judged the code, while an escalation is only ever reached
 * from a round a full panel judged.
 *
 * THE GATE, and why each condition is load-bearing — the same three `infra-block.ts`
 * applies, for the same reasons:
 *
 *  1. `phase === 'failed'` — an escalation is a TERMINAL stop. A run still in flight
 *     (or `done`, or `stopped`) is not being explained by this.
 *  2. `harvested_at !== null` — THE STALE-RESULT HAZARD. A force-terminated or cancelled
 *     row can keep a stale but perfectly parseable `inner_result` from an earlier
 *     iteration; `saveIfActive` never overwrites it, so the column alone cannot say
 *     "this is how the run ACTUALLY ended". `harvested_at` is written EXCLUSIVELY by
 *     `orchestrator.applyResult`, so it is the force-terminate-proof proof that the
 *     result belongs to this ending.
 *  3. A decoded `escalation` whose kind matches the decoded `block_kind`. BOTH, not
 *     either: the kind is what the outer loop routes on and the payload is what it
 *     reports, and a result carrying one without the other is a half-written
 *     escalation, not an escalation. `parseInnerResult` already decodes both
 *     FAIL-CLOSED (an unknown kind becomes `null`; a payload with a blank
 *     `whatIsMissing` becomes `null`), so this re-validates nothing — one decoder, one
 *     rule.
 *
 * Fail-closed by construction: anything short of all three returns `null` and the
 * caller keeps its existing behaviour byte-for-byte. Calling a genuine FAILURE a block
 * is the strictly worse error — it tells the owner to go unblock something when the
 * build is simply broken — so the ambiguous cases fall that way.
 *
 * THE ONE DERIVER FOR READERS, exactly as `deriveInfraBlock` is. `trident/delivery.ts`
 * (the chat result) and `trident/board-reconcile.ts` (the card's lane) read the
 * distinction through this function and neither re-implements the gate: two copies would
 * drift, and the two surfaces would then disagree about whether the owner is looking at
 * something blocked or something broken.
 *
 * THE WRITER CANNOT USE IT, AND THAT IS NOT A GAP. `orchestrator.ts` composes the
 * `failure_reason` (`innerTerminalFailureReason` → `escalationStopSentence`) at the moment
 * it BUILDS the terminal row — upstream of both conditions 1 and 2, which it is itself
 * about to make true. `phase` is not yet `failed` and `harvested_at` is stamped by
 * `applyResult`, so calling this function there would return `null` on every real
 * escalation and the sentence would never fire. What the writer genuinely shares with the
 * reader is condition 3 alone, and it is exported as `escalationKindAgrees` so there is
 * still exactly ONE spelling of the rule rather than two that must be remembered together.
 *
 * `trident/run-progress.ts` IS NOT A CONSUMER, DELIBERATELY. It reports what the RUN did,
 * and the run genuinely ended in the `failed` phase; blockedness is a fact about the CARD,
 * written to its lane by `board-reconcile` through this deriver. Teaching the run payload
 * to also say "blocked" would put a second source of truth for the same distinction on the
 * same surface — the drift this module exists to prevent — so every board renderer instead
 * asks the LANE first and lets the run refine it (`stepTag`, `dotState`, `runNotice` and
 * `summarize`, in both clients).
 *
 * IT DERIVES A FACT, NEVER AN ACTION. Nothing here returns a card to move, a position
 * to move it to, or any other board mutation — the RUN reports and the ORCHESTRATOR
 * decides, and a build that could reorder the owner's queue would re-prioritise the
 * work with no judgement in between.
 */

import type { EscalationKind, InnerEscalation, InnerResult } from './inner-loop.ts'
import { parseInnerResult } from './inner-loop.ts'
import type { TridentRun } from './store.ts'

/** A terminal run that STOPPED and escalated rather than spending its round budget. */
export interface EscalationBlock {
  kind: EscalationKind
  /** The SPECIFIC thing the plan got wrong, or the dependency that must land first.
   *  Never empty — the decoder refuses an escalation that states nothing. */
  whatIsMissing: string
  /** EVERY gate that fired. `[]` when the workflow reported none, never a guess. */
  triggers: string[]
  /** The arithmetic the decision was made on, in the workflow's own words. '' when absent. */
  evidence: string
  /** The round it fired at. 0 when the workflow reported none. */
  round: number
}

/**
 * Derive the escalation fact from a run row, or `null` when this run is not one.
 * Pure + deterministic (no I/O), so every consuming surface is unit-testable.
 */
export function deriveEscalationBlock(
  run: Pick<TridentRun, 'phase' | 'harvested_at' | 'inner_result'>,
): EscalationBlock | null {
  if (run.phase !== 'failed') return null
  // `harvested_at !== null`, spelled fail-closed: an absent field on a partial row must
  // read as "not harvested", never slip through as "not null".
  if (typeof run.harvested_at !== 'number') return null
  const result = parseInnerResult(run.inner_result)
  if (result === null) return null
  const escalation: InnerEscalation | null = result.escalation
  if (escalation === null) return null
  if (!escalationKindAgrees(result)) return null
  return {
    kind: escalation.kind,
    whatIsMissing: escalation.whatIsMissing,
    triggers: escalation.triggers,
    evidence: escalation.evidence,
    round: escalation.round,
  }
}

/**
 * CONDITION 3 ON ITS OWN — THE KIND AND THE PAYLOAD MUST AGREE.
 *
 * `block_kind` is what the outer loop routes on; the payload is what it reports. A result
 * carrying one without the other is a HALF-WRITTEN escalation, not an escalation, and
 * guessing which half is right is exactly the repair that turns a bug into a silently
 * wrong owner-facing sentence.
 *
 * Exported because the READER (`deriveEscalationBlock`, above) and the WRITER
 * (`orchestrator.innerTerminalFailureReason`, which composes the stored `failure_reason`
 * before the row is harvested and so cannot use the full gate) must apply the SAME rule.
 * They differ only in the two conditions that are about a STORED row; they must not differ
 * in this one, because a sentence quoting a claim whose routing kind says something else
 * is wrong on either side of the boundary.
 */
export function escalationKindAgrees(
  result: Pick<InnerResult, 'block_kind' | 'escalation'>,
): boolean {
  return result.escalation !== null && result.block_kind === result.escalation.kind
}

/**
 * THE one sentence for a build that stopped because it was BLOCKED.
 *
 * It exists here, beside the deriver, for the reason `infraDeathSentence` exists in
 * `infra-block.ts`: the orchestrator WRITES this into `failure_reason` and the delivery
 * layer READS the structured block back, so a reworded sentence can never become one a
 * reader silently stops recognising. The word is BLOCKED, and it is chosen against
 * "failed" on purpose — they are the two different words the owner has to be able to
 * tell apart on the card.
 */
export function escalationStopSentence(block: EscalationBlock, ceiling: number): string {
  return `build BLOCKED at round ${block.round} of ${ceiling} (${block.kind}) — it stopped instead of iterating: ${block.whatIsMissing}`
}
