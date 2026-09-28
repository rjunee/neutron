import type { BuildSnapshot } from './build-run.ts'
import type { ReviewSuiteSource, SuiteObservation } from './gates/review-suite.ts'
import type { TridentRun, TridentRunStore } from './store.ts'

const STAGE = 'build-suite-receipt'
export const SUITE_IDENTITY_COMPONENTS = ['preparation', 'resolution', 'installed', 'installation', 'workspace'] as const
export type SuiteIdentityComponents = Record<typeof SUITE_IDENTITY_COMPONENTS[number], string>
export interface SuiteIdentityMeasurement {
  identity: string
  components?: SuiteIdentityComponents
}

// Persist only the fixed vocabulary and digests, never arbitrary probe fields.
const safeComponents = (measurement: SuiteIdentityMeasurement | null): SuiteIdentityComponents | null => {
  const components = measurement?.components
  if (!components || !SUITE_IDENTITY_COMPONENTS.every(key =>
    typeof components[key] === 'string' && /^[a-f0-9]{64}$/.test(components[key]))) return null
  return Object.fromEntries(SUITE_IDENTITY_COMPONENTS.map(key => [key, components[key]])) as SuiteIdentityComponents
}
const unknown = (detail: string) => ({ kind: 'unknown' as const, detail })
const owner = (run: TridentRun) => JSON.stringify([run.id, run.project_slug, run.repo_path,
  run.worktree, run.branch, run.base_sha])

/** A host-owned observation, never worker telemetry or an approval. Its original
 * run/head/round/scope/strategy are retained and G063 still assesses the report. */
export function createProjectSuiteReceipts(options: {
  store: TridentRunStore
  run: TridentRun
  identity: ((snapshot: BuildSnapshot) => Promise<SuiteIdentityMeasurement | null>) | undefined
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
      const measuredBefore = await measure(snapshot)
      const identity = measuredBefore?.identity ?? null
      const before = { identity, components: safeComponents(measuredBefore), at: new Date().toISOString() }
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
      const measuredAfter = await measure(snapshot)
      const after = measuredAfter?.identity ?? null
      const componentsAfter = safeComponents(measuredAfter)
      // Keep measurements independently of reusable proof. Unknown is not a
      // changed hash, and neither may hide the host's already observed exit.
      const observation = { before, after: { identity: after, components: componentsAfter, at: new Date().toISOString() },
        delta: before.components && componentsAfter
          ? { kind: 'known', changed: SUITE_IDENTITY_COMPONENTS.filter(key => before.components![key] !== componentsAfter[key]) }
          : { kind: 'unavailable' },
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
