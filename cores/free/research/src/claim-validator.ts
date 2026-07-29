/**
 * @neutronai/research-core — sources-cited invariant.
 *
 * Per docs/plans/research-core-tier1-brief.md § 3.5 + § 8.
 *
 * The SINGLE most important contract this Core ships. From SOUL.md /
 * CLAUDE.md operating principle #9: "No fabricated analysis. Never
 * present rankings, reviews, or product details from general knowledge
 * alone. If you haven't searched, say so — don't guess."
 *
 * Every claim row produced by the synthesis pipeline (substrate or
 * sub-agent) MUST satisfy:
 *
 *   - a non-null `citation` (URL or file path), OR
 *   - `confidence === 'unverified'` (explicit acknowledgement)
 *
 * No third path. `assertSourcesCited` is the predicate the orchestrator
 * calls BEFORE `setCompleted`. A claim-less brief or any claim missing
 * both fields fails the task with a typed `SourcesCitedViolationError`.
 *
 * The retry-once orchestrator path includes a sources-cited-specific
 * retry-prompt rider when the FIRST attempt fails the invariant —
 * "Your previous output failed the sources-cited invariant. Every claim
 * MUST have a citation or be tagged confidence:unverified." The second
 * failure marks the task `failed`.
 */

import type { ResearchClaim } from './claim-store.ts'

export class SourcesCitedViolationError extends Error {
  readonly code = 'sources_cited_violation' as const
  readonly task_id: string
  readonly offending_claim_id: string
  readonly offending_claim_text: string
  constructor(task_id: string, claim: ResearchClaim) {
    super(
      `task ${task_id} claim ${claim.id} has no citation and is not ` +
        `tagged unverified: "${claim.claim.slice(0, 200)}"`,
    )
    this.name = 'SourcesCitedViolationError'
    this.task_id = task_id
    this.offending_claim_id = claim.id
    this.offending_claim_text = claim.claim
  }
}

/**
 * Throws SourcesCitedViolationError on the first claim row missing
 * both `citation` AND `confidence='unverified'`. Returns the count of
 * valid claims on success.
 *
 * Called by the orchestrator BEFORE `setCompleted`. A claim-less brief
 * (zero claims) ALSO fails — every research brief must carry at least
 * one claim with provenance OR an explicit unverified tag.
 *
 * The invariant is shape-only: a claim is valid iff EITHER
 *   - `citation` is a non-empty string, OR
 *   - `confidence === 'unverified'`
 * Citation strings are not URL-validated — markdown file paths, DOIs,
 * and arxiv ids are all valid citations.
 */
export function assertSourcesCited(
  task_id: string,
  claims: readonly ResearchClaim[],
): number {
  if (claims.length === 0) {
    throw new SourcesCitedViolationError(task_id, {
      id: '<no-claims>',
      task_id,
      claim: '<brief had zero claims; every research brief must carry at least one claim>',
      evidence: null,
      citation: null,
      confidence: 'low',
      created_at: 0,
    })
  }
  for (const c of claims) {
    const hasCitation =
      typeof c.citation === 'string' && c.citation.trim().length > 0
    const isUnverified = c.confidence === 'unverified'
    if (!hasCitation && !isUnverified) {
      throw new SourcesCitedViolationError(task_id, c)
    }
  }
  return claims.length
}
