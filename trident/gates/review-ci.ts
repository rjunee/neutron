import type { BuildSnapshot, ReviewDecision } from '../build-run.ts'
import { applyReviewSuite, type SuiteAssessment } from './review-suite.ts'

export interface ReviewCiObservation {
  kind: 'known'
  head: string
  status: 'green' | 'none' | 'red' | 'pending'
  failing: readonly string[]
  /** Measured at the host's pinned base, never copied from a builder trailer. */
  base: { head: string; status: 'red' | 'green' | 'pending' | 'unknown'; failing: readonly string[] } | null
}
export interface ReviewCiSource {
  observe(snapshot: BuildSnapshot): Promise<ReviewCiObservation | { kind: 'unknown'; detail: string }>
}
const unknown = (detail: string): SuiteAssessment => ({ kind: 'unknown', detail })

/** G055 acquisition and comparison; unknown base evidence excuses no branch failure. */
export async function assessReviewCi(source: ReviewCiSource | undefined, snapshot: BuildSnapshot, baseHead: string): Promise<SuiteAssessment> {
  if (!source) return unknown('Review CI observation source is missing')
  try {
    const value = await source.observe(snapshot)
    if (value.kind === 'unknown') return value
    if (value.head !== snapshot.head) return unknown('Review CI head does not match reviewed revision')
    // G056 is a distinct deferral step, before interpreting red or green evidence.
    const deferred = deferReviewCi(value.status)
    if (deferred) return deferred
    if (!Array.isArray(value.failing) || value.failing.some(name => typeof name !== 'string')) return unknown('Review CI failing check names are unreadable')
    if (value.status !== 'red') return { kind: 'known', findings: [] }
    if (!value.failing.length) return unknown('Red review CI has no failing check evidence')
    const base = value.base
    const names = base && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseHead) && base.head === baseHead && base.status === 'red' && Array.isArray(base.failing)
      ? new Set(base.failing.filter(name => typeof name === 'string' && name.trim() !== '' && name !== 'unnamed check')) : new Set<string>()
    return { kind: 'known', findings: value.failing.map(name => ({
      title: `CI FAILING: ${name || 'unnamed check'}`,
      evidence: names.has(name) ? 'Same check name measured red at the pinned base; comparison is by name only and does not clear red CI.' : 'Check is failing on this revision without a matching measured base failure.',
      advisory: names.has(name),
    })) }
  } catch { return unknown('Review CI host observation failed') }
}

/** G056: pending and unreadable CI join the nonterminal review deferral vocabulary. */
export function deferReviewCi(status: string): SuiteAssessment | null {
  return ['green', 'none', 'red'].includes(status) ? null : unknown(`Review CI deferred peer: ${status}`)
}

/** G055: force actionable red into repair; base-only red holds without spending a fix. */
export function applyReviewCi(panel: ReviewDecision, ci: SuiteAssessment): ReviewDecision {
  const decision = applyReviewSuite(panel, ci)
  if (decision.kind === 'approve' && ci.kind === 'known' && ci.findings.length > 0) return { kind: 'blocked', on: 'review-advisory-only: CI remains red at the pinned base' }
  return decision
}
