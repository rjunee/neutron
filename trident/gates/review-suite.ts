import type { BuildSnapshot, ReviewDecision } from '../build-run.ts'
import { unknownCause } from './unknown-cause.ts'

export interface SuiteFinding {
  title: string
  evidence: string
  advisory: boolean
}
export type SuiteAssessment =
  | { kind: 'known'; findings: readonly SuiteFinding[] }
  | { kind: 'unknown'; detail: string }
export interface SuiteObservation {
  kind: 'known'
  /** Host-observed record identity, not identity asserted by the worker. */
  runId: string
  head: string
  round: number
  /** Read from host configuration and the dispatched task, never the report. */
  strategy: string
  scope: 'full-suite' | 'subset'
  /** Independently read build/fix checkpoint for this revision. Still an untrusted claim. */
  report: { testsPassed?: boolean; suiteOutcome?: string; suiteEvidence?: string } | null
}
export interface ReviewSuiteSource {
  observe(snapshot: BuildSnapshot, round: number): Promise<SuiteObservation | { kind: 'unknown'; detail: string }>
}
const known = (findings: readonly SuiteFinding[] = []): SuiteAssessment => ({ kind: 'known', findings })
const unknown = (detail: string): SuiteAssessment => ({ kind: 'unknown', detail })
const blocker = (title: string, evidence: string): SuiteAssessment => known([{ title, evidence, advisory: false }])

/** G063–G065: classify the recorded claim, without treating its transcription as verified tests. */
export async function assessReviewSuite(source: ReviewSuiteSource | undefined, snapshot: BuildSnapshot, round: number, runId: string): Promise<SuiteAssessment> {
  if (!source) return unknown('Review suite observation source is missing')
  try {
    const value = await source.observe(snapshot, round)
    if (value.kind === 'unknown') return value
    if (value.kind !== 'known' || value.runId !== runId || value.head !== snapshot.head || value.round !== round) return unknown('Review suite record does not match run, revision and round')
    if (typeof value.strategy !== 'string' || !['full-suite', 'subset'].includes(value.scope)) return unknown('Review suite strategy or dispatched scope is unreadable')
    if (value.strategy === '') return known()
    const report = value.report
    if (report && ((report.testsPassed !== undefined && typeof report.testsPassed !== 'boolean') || (report.suiteOutcome !== undefined && typeof report.suiteOutcome !== 'string') || (report.suiteEvidence !== undefined && typeof report.suiteEvidence !== 'string'))) return unknown('Review suite report is malformed')
    if (report?.testsPassed === true && typeof report.suiteOutcome === 'string' && report.suiteOutcome !== 'passed') return blocker('CONTRADICTORY SUITE CLAIM', 'testsPassed=true requires a passed suite outcome')
    if (report?.testsPassed === true) return known()
    if (report?.suiteOutcome === 'deferred' && value.scope === 'subset') return known()
    const evidence = typeof report?.suiteEvidence === 'string' ? report.suiteEvidence.trim() : ''
    if (report?.suiteOutcome === 'failed-preexisting') {
      if (!evidence) return blocker('FAILED-PREEXISTING CLAIMED WITHOUT EVIDENCE', 'Re-run the failing files at the base and record the comparison')
      return known([{ title: 'FULL SUITE RED FOR PRE-EXISTING REASONS', evidence: `Untrusted build transcription; verify the base comparison and named failures before approving:\n${evidence}`, advisory: true }])
    }
    return blocker('FULL SUITE NOT PROVEN', 'Run the required full suite and record its result')
  } catch (error) { return unknownCause('Review suite host observation failed', error, runId) }
}

/** Suite evidence can require repairs, but cannot override a panel stop or grant approval. */
export function applyReviewSuite(panel: ReviewDecision, suite: SuiteAssessment): ReviewDecision {
  if (panel.kind === 'blocked' || panel.kind === 'unknown') return panel
  if (suite.kind === 'unknown') return suite
  const blockers = suite.findings.filter(f => !f.advisory).map(f => `${f.title}: ${f.evidence}`)
  if (blockers.length === 0) return panel
  if (panel.kind === 'approve') return { kind: 'fix', findings: blockers, blockingCount: blockers.length }
  return { ...panel, findings: [...blockers, ...panel.findings], blockingCount: blockers.length + (panel.blockingCount ?? panel.findings.length) }
}
