import type { BuildSnapshot } from './build-run.ts'
import { classifyCiRollup } from './ci-readiness.ts'
import { classifyReviewReadiness, type ReviewReadinessSource } from './gates/review-readiness.ts'
import type { ReviewCiSource } from './gates/review-ci.ts'
import type { ReviewSuiteSource, SuiteObservation } from './gates/review-suite.ts'
import type { ProductionCiSource } from './production-host-effects.ts'

const unknown = (detail: string) => ({ kind: 'unknown' as const, detail })

/** The report reader must read a host record, including its identity, independently
 * of the review worker. Strategy and scope come from configuration and dispatch. */
export interface ProjectSuiteOptions {
  strategy: string
  scope: SuiteObservation['scope']
  readCheckpoint(snapshot: BuildSnapshot, round: number): Promise<Pick<SuiteObservation, 'runId' | 'head' | 'round' | 'report'> | null>
}

/** Reuse production's credentialed acquisition and named-row classifier. No clocks
 * or retries here: awaitReviewReadiness owns the elapsed budget and cancellation. */
export function createProjectObservationSources(options: {
  ci: ProductionCiSource
  baseBranch: string
  ciWorkflow: string | undefined
  runId: string
  suite: ProjectSuiteOptions | undefined
}) {
  const reviewReadiness: ReviewReadinessSource = {
    async observe(snapshot, signal) {
      try {
        if (signal.aborted) return unknown('Review readiness acquisition cancelled')
        if (!options.ciWorkflow?.trim()) return unknown('Review readiness CI workflow is missing')
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.head) || !snapshot.pr) return unknown('Review readiness PR or full head is missing')
        const [configuration, value] = await Promise.all([
          options.ci.required(options.baseBranch), options.ci.readiness(snapshot.pr.number),
        ])
        if (signal.aborted) return unknown('Review readiness acquisition cancelled')
        if (configuration.kind === 'unknown') return unknown(`Review readiness configuration: ${configuration.reason}`)
        if ('unreadable' in value) return unknown(`Review readiness: ${value.unreadable}`)
        if (value.headSha !== snapshot.head) return unknown('Review readiness head is missing or mismatched')
        if (!['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(String(value.mergeable)) || !Array.isArray(value.rows)) return unknown('Review readiness mergeability or rows are malformed')
        const checks: { name: string; state: 'passed' | 'failed' | 'skipped' | 'running' }[] = []
        for (const row of value.rows) {
          const name = typeof row?.name === 'string' && row.name !== '' ? row.name : row?.context
          // A single-row classification preserves app binding, skipped and pending
          // semantics without maintaining a second CI state parser.
          const result = classifyCiRollup(snapshot.head, 'MERGEABLE', [row], { ...configuration, required: [name] }, 0, Infinity)
          if (result.kind === 'unreadable') return unknown(`Review readiness: ${result.reason}`)
          const state = result.kind === 'completed' ? (result.conclusion === 'success' ? 'passed' : 'failed')
            : result.kind === 'absent' ? 'skipped' : 'running'
          checks.push({ name, state })
        }
        return { kind: 'known', head: snapshot.head, configuration,
          mergeability: value.mergeable === 'MERGEABLE' ? 'mergeable' : value.mergeable === 'CONFLICTING' ? 'conflicting' : 'pending', checks }
      } catch (error) { return unknown(`Review readiness acquisition failed: ${String(error)}`) }
    },
  }
  const reviewCi: ReviewCiSource = {
    async observe(snapshot) {
      const value = await reviewReadiness.observe(snapshot, new AbortController().signal)
      if (value.kind === 'unknown') return unknown(`Review CI: ${value.detail}`)
      const readiness = classifyReviewReadiness(snapshot, value)
      if (readiness.kind !== 'passed' && readiness.kind !== 'failed') return unknown('Review CI configuration, mergeability or checks have not settled')
      // ProductionCiSource has no pinned-base check acquisition. null supplies no
      // advisory exemption; named branch failures remain actionable in G055.
      return { kind: 'known', head: value.head, status: readiness.kind === 'passed' ? 'green' : 'red',
        failing: readiness.failed, base: null }
    },
  }
  const reviewSuite: ReviewSuiteSource = {
    async observe(snapshot, round) {
      try {
        const suite = options.suite
        if (!suite) return unknown('Review suite strategy, dispatched scope and checkpoint reader are missing')
        const record = await suite.readCheckpoint(snapshot, round)
        if (!record) return unknown('Review suite build/fix checkpoint is missing')
        if (record.runId !== options.runId || record.head !== snapshot.head || record.round !== round) return unknown('Review suite checkpoint identity does not match run, head and round')
        return { ...record, kind: 'known', strategy: suite.strategy, scope: suite.scope }
      } catch (error) { return unknown(`Review suite checkpoint acquisition failed: ${String(error)}`) }
    },
  }
  return { reviewReadiness, reviewCi, reviewSuite }
}
