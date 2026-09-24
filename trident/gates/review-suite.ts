import type { BuildSnapshot, ReviewDecision } from '../build-run.ts'
import { unknownCause } from './unknown-cause.ts'

export interface SuiteFinding {
  title: string
  evidence: string
  advisory: boolean
  /** Host failure identity for progress; diagnostics may contain round-specific paths. */
  identity?: string | null
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
  /** Host-observed suite exit plus untrusted diagnostic detail from the build/fix checkpoint. */
  report: { hostExitCode?: number; suiteOutcome?: string; suiteEvidence?: string; hostFailureId?: string; hostDiagnostics?: string;
    hostSuiteWorker?: boolean; hostComparisonEligible?: boolean; hostFailureFormat?: 'bun' | 'generic' } | null
}
export interface ReviewSuiteSource {
  observe(snapshot: BuildSnapshot, round: number): Promise<SuiteObservation | { kind: 'unknown'; detail: string }>
}
const known = (findings: readonly SuiteFinding[] = []): SuiteAssessment => ({ kind: 'known', findings })
const unknown = (detail: string): SuiteAssessment => ({ kind: 'unknown', detail })
const blocker = (title: string, evidence: string, identity?: string | null): SuiteAssessment => known([{ title, evidence, advisory: false, ...(identity !== undefined ? { identity } : {}) }])
const failedPreexisting = (report: { suiteOutcome?: string; suiteEvidence?: string; hostDiagnostics?: string; hostFailureId?: string }): SuiteAssessment => {
  const evidence = typeof report.suiteEvidence === 'string' ? report.suiteEvidence.trim() : ''
  if (!evidence) return blocker('FAILED-PREEXISTING CLAIMED WITHOUT EVIDENCE', `Re-run the failing files at the base and record the comparison${report.hostDiagnostics ? `\n${report.hostDiagnostics}` : ''}`, report.hostFailureId ?? (report.hostDiagnostics ? null : undefined))
  return known([{ title: 'FULL SUITE RED FOR PRE-EXISTING REASONS', evidence: `Untrusted build transcription; verify the base comparison and named failures before approving:\n${evidence}`, advisory: true }])
}

/** G063–G065: classify the host receipt, using checkpoint detail only for diagnostics. */
export async function assessReviewSuite(source: ReviewSuiteSource | undefined, snapshot: BuildSnapshot, round: number, runId: string): Promise<SuiteAssessment> {
  if (!source) return unknown('Review suite observation source is missing')
  try {
    const value = await source.observe(snapshot, round)
    if (value.kind === 'unknown') return value
    if (value.kind !== 'known' || value.runId !== runId || value.head !== snapshot.head || value.round !== round) return unknown('Review suite record does not match run, revision and round')
    if (typeof value.strategy !== 'string' || !['full-suite', 'subset'].includes(value.scope)) return unknown('Review suite strategy or dispatched scope is unreadable')
    if (value.strategy === '') return known()
    const report = value.report
    // NULL IS ITS OWN STATE AND IS TESTED FIRST. `report?.hostExitCode === undefined` is also
    // true for a null report, so ordering the subset exemption above this line would collapse
    // "no command was derivable" back into "the round deferred its suite" — the exact split
    // the previous commit exists to make. Not reachable through today's composition, since the
    // intermediate path always returns a present report, but the type permits it.
    if (!report) return unknown('No full-suite command is derivable from the test strategy')
    if (value.scope === 'subset' && report.hostExitCode === undefined) {
      if (report.suiteOutcome === 'failed-preexisting') return failedPreexisting(report)
      return known()
    }
    if (typeof report.hostExitCode !== 'number' || !Number.isInteger(report.hostExitCode)) return unknown('Host-observed review suite exit code is missing or unreadable')
    if ((report.suiteOutcome !== undefined && typeof report.suiteOutcome !== 'string') || (report.suiteEvidence !== undefined && typeof report.suiteEvidence !== 'string')) return unknown('Review suite report is malformed')
    if ((report.hostSuiteWorker !== undefined && typeof report.hostSuiteWorker !== 'boolean')
      || (report.hostComparisonEligible !== undefined && typeof report.hostComparisonEligible !== 'boolean')
      || (report.hostFailureFormat !== undefined && !['bun', 'generic'].includes(report.hostFailureFormat))) return unknown('Host suite comparison provenance is malformed')
    if (report.hostExitCode === 0) return known()
    if (report.suiteOutcome === 'failed-preexisting' && !report.suiteEvidence?.trim()) return failedPreexisting(report)
    if (report.hostDiagnostics !== undefined && (typeof report.hostDiagnostics !== 'string'
      || (report.hostFailureId !== undefined && typeof report.hostFailureId !== 'string'))) return unknown('Host suite diagnostics are malformed')
    if (report.hostSuiteWorker === true && report.suiteOutcome === 'failed-preexisting'
      && (report.hostComparisonEligible !== true || report.hostFailureFormat !== 'generic'
        && (!report.hostFailureId || !report.suiteEvidence?.includes(report.hostFailureId)))) {
      return blocker('HOST SUITE BASE COMPARISON NOT PROVEN', `${report.hostDiagnostics ?? 'Host failure identity unavailable.'}\nRe-run these named failures at the base and include any supplied failure identity and observed comparison in suiteEvidence.`, report.hostFailureId ?? null)
    }
    if (report?.suiteOutcome === 'failed-preexisting') {
      return failedPreexisting(report)
    }
    return blocker('FULL SUITE NOT PROVEN', report.hostDiagnostics ?? 'Run the required full suite and record its result', report.hostFailureId ?? null)
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
