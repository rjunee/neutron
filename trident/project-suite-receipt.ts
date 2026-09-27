import type { BuildSnapshot } from './build-run.ts'
import type { ReviewSuiteSource, SuiteObservation } from './gates/review-suite.ts'
import type { TridentRun, TridentRunStore } from './store.ts'

const STAGE = 'build-suite-receipt'
const unknown = (detail: string) => ({ kind: 'unknown' as const, detail })
const owner = (run: TridentRun) => JSON.stringify([run.id, run.project_slug, run.repo_path,
  run.worktree, run.branch, run.base_sha])

/** A host-owned observation, never worker telemetry or an approval. Its original
 * run/head/round/scope/strategy are retained and G063 still assesses the report. */
export function createProjectSuiteReceipts(options: {
  store: TridentRunStore
  run: TridentRun
  identity: ((snapshot: BuildSnapshot) => Promise<string | null>) | undefined
}) {
  const { store, run } = options
  const latest = () => store.stageEvents(run.id).filter(event => event.stage === STAGE).at(-1)
  const measure = async (snapshot: BuildSnapshot) => {
    try { return await options.identity?.(snapshot) ?? null } catch { return null }
  }
  const boundOwner = owner(run)
  const currentOwner = () => { const current = store.get(run.id); return current ? owner(current) : null }
  const decode = (meta: string | null | undefined, snapshot: BuildSnapshot, round: number,
    strategy: string, identity: string | null): SuiteObservation | null => {
    if (!identity || currentOwner() !== boundOwner) return null
    try {
      const value = JSON.parse(meta ?? 'null')
      const receipt = value?.receipt
      if (value?.version !== 1 || value.owner !== boundOwner || value.identity !== identity
        || !receipt || receipt.kind !== 'known' || receipt.runId !== run.id
        || receipt.head !== snapshot.head || receipt.round !== round
        || receipt.strategy !== strategy || receipt.scope !== 'full-suite'
        || !receipt.report || !Number.isInteger(receipt.report.hostExitCode)
        || (receipt.report.suiteOutcome !== undefined && typeof receipt.report.suiteOutcome !== 'string')
        || (receipt.report.suiteEvidence !== undefined && typeof receipt.report.suiteEvidence !== 'string')) return null
      return receipt
    } catch { return null }
  }
  return {
    async observe(source: ReviewSuiteSource, snapshot: BuildSnapshot, round: number,
      strategy: string | undefined, scope: SuiteObservation['scope'] | undefined) {
      const identity = await measure(snapshot)
      const before = { identity, at: new Date().toISOString() }
      const event = latest()
      const prior = scope === 'full-suite' && strategy !== undefined
        ? decode(event?.meta, snapshot, round, strategy, identity) : null
      if (prior) return prior
      // A missing/corrupt/mismatched receipt is not proof. Atomic invalidation
      // prevents a failed acquisition, or a stale host, reviving old success.
      const version = await store.appendSuiteReceipt(run.id, event?.id ?? null,
        JSON.stringify({ version: 1, owner: boundOwner, observation: { before } }))
      if (version === null) return unknown('Suite acquisition ownership changed or run stopped')
      const receipt = await source.observe(snapshot, round)
      const after = await measure(snapshot)
      // Keep measurements independently of reusable proof. Unknown is not a
      // changed hash, and neither may hide the host's already observed exit.
      const observation = { before, after: { identity: after, at: new Date().toISOString() },
        hostExitCode: receipt.kind === 'known' && Number.isInteger(receipt.report?.hostExitCode)
          ? receipt.report!.hostExitCode : null }
      if (identity && after !== identity) {
        const saved = await store.appendSuiteReceipt(run.id, version,
          JSON.stringify({ version: 1, owner: boundOwner, observation }))
        if (saved === null) return unknown('Suite completion ownership changed or run stopped')
        return unknown(after === null ? 'Suite input identity is unavailable after host observation'
          : 'Suite inputs changed during host observation')
      }
      if (receipt.kind === 'known' && receipt.runId === run.id && receipt.head === snapshot.head
        && receipt.round === round && receipt.strategy === strategy && receipt.scope === 'full-suite'
        && scope === 'full-suite' && receipt.report && Number.isInteger(receipt.report.hostExitCode)
        && identity && identity === after && currentOwner() === boundOwner) {
        const saved = await store.appendSuiteReceipt(run.id, version,
          JSON.stringify({ version: 1, owner: boundOwner, identity, receipt, observation }))
        if (saved === null) return unknown('Suite completion ownership changed or run stopped')
      }
      return receipt
    },
  }
}
