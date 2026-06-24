/**
 * @neutronai/skill-forge — workflow signature.
 *
 * A stable hash of a completed workflow's normalized step sequence. Two runs
 * of the "same" workflow (same ordered actions) hash identically regardless of
 * volatile per-run args, so the proposals store can dedupe: a workflow is
 * proposed at most once while a prior proposal for the same signature is still
 * pending or approved.
 */

import { createHash } from 'node:crypto'

import type { CompletedWorkflow } from './types.ts'

/** Normalize a step action: lower-case, collapse whitespace, drop trailing args. */
export function normalizeAction(action: string): string {
  return action
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // Drop a trailing "(...)" or " arg=val" argument tail — only the verb matters.
    .replace(/\s*\(.*\)\s*$/, '')
}

/**
 * Deterministic signature of a workflow's *shape* (its ordered, normalized
 * actions). Intent and artifacts are intentionally excluded — they vary per
 * run; the dedupe key is the procedure, not the payload.
 */
export function workflowSignature(workflow: CompletedWorkflow): string {
  const shape = workflow.steps.map((s) => normalizeAction(s.action)).join('>')
  return createHash('sha256').update(shape).digest('hex').slice(0, 32)
}
