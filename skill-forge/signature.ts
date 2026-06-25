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
  const collapsed = action.trim().toLowerCase().replace(/\s+/g, ' ')
  // Drop a trailing "(...)" or " arg=val" argument tail — only the verb matters.
  return dropTrailingParenTail(collapsed)
}

/**
 * Strip a trailing `\s*(...)\s*` argument tail, linear-time.
 *
 * Behaviourally identical to `.replace(/\s*\(.*\)\s*$/, '')` (greedy `.*`, so
 * the first `(` through the last `)` that is followed only by whitespace is
 * removed, along with any whitespace immediately preceding that `(`), but
 * without the ambiguous leading `\s*` + greedy `.*` that gives the regex
 * super-linear backtracking on adversarial input (CodeQL js/polynomial-redos).
 */
function dropTrailingParenTail(s: string): string {
  const open = s.indexOf('(')
  if (open === -1) return s
  // The trailing `)` must be the last non-whitespace character (the regex's
  // `\)\s*$`). Walk back over a trailing whitespace run, then require a `)`.
  let end = s.length
  while (end > 0 && /\s/.test(s[end - 1]!)) end--
  if (end === 0 || s[end - 1] !== ')') return s
  if (end - 1 <= open) return s // need a `(` strictly before the closing `)`
  // Consume the whitespace immediately preceding the first `(` (the leading
  // `\s*`), then drop everything from there to the end of string.
  let start = open
  while (start > 0 && /\s/.test(s[start - 1]!)) start--
  return s.slice(0, start)
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
