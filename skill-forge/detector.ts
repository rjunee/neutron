/**
 * @neutronai/skill-forge — detector (the audit gate).
 *
 * Pure heuristic that decides whether a completed workflow is worth proposing
 * as a skill. This is the FIRST gate (the second is the user's approval). It
 * is deliberately conservative — a false positive nags the user; we only
 * surface workflows that are (a) successful, (b) genuinely multi-step, and
 * (c) repeatable (more than one *distinct* kind of action, so it is a
 * procedure, not a single tool call run N times).
 */

import { normalizeAction } from './signature.ts'
import type { CompletedWorkflow } from './types.ts'

/** Minimum distinct normalized actions for a workflow to count as a procedure. */
export const MIN_DISTINCT_STEPS = 2

export interface AuditResult {
  worthy: boolean
  /** Human-readable reason — surfaced in logs/telemetry, never to the user. */
  reason: string
}

/**
 * Audit a completed workflow. Returns `{ worthy: true }` only when the
 * workflow is a successful, multi-step, repeatable procedure.
 */
export function auditWorkflow(workflow: CompletedWorkflow): AuditResult {
  if (!workflow.succeeded) {
    return { worthy: false, reason: 'workflow did not succeed' }
  }
  if (workflow.intent.trim().length === 0) {
    return { worthy: false, reason: 'workflow has no stated intent' }
  }
  if (workflow.steps.length < MIN_DISTINCT_STEPS) {
    return {
      worthy: false,
      reason: `workflow has ${workflow.steps.length} step(s); need >= ${MIN_DISTINCT_STEPS}`,
    }
  }
  const distinct = new Set(workflow.steps.map((s) => normalizeAction(s.action)))
  distinct.delete('')
  if (distinct.size < MIN_DISTINCT_STEPS) {
    return {
      worthy: false,
      reason: `workflow has ${distinct.size} distinct action(s); a single repeated action is not a procedure`,
    }
  }
  return { worthy: true, reason: `multi-step procedure (${distinct.size} distinct actions)` }
}
