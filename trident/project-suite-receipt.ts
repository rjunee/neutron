import type { BuildSnapshot } from './build-run.ts'
import type { ReviewSuiteSource, SuiteObservation } from './gates/review-suite.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { readBuildRetrySource } from './build-mode-state.ts'

const STAGE = 'build-suite-receipt'
export const SUITE_IDENTITY_COMPONENTS = ['preparation', 'resolution', 'installed', 'installation', 'workspace'] as const
export type SuiteIdentityComponents = Record<typeof SUITE_IDENTITY_COMPONENTS[number], string>
export interface SuiteIdentityMeasurement {
  identity: string
  components?: SuiteIdentityComponents
  /** Versioned host measurement; never inferred from a legacy strict digest. */
  portableIdentity?: string
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
const portable = (measurement: SuiteIdentityMeasurement | null) =>
  /^[a-f0-9]{64}$/.test(measurement?.portableIdentity ?? '') ? measurement!.portableIdentity! : null

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
    strategy: string, identity: string | null, portableIdentity: string | null): SuiteObservation | null => {
    if (!identity || currentOwner() !== boundOwner) return null
    try {
      const value = JSON.parse(meta ?? 'null')
      const receipt = value?.receipt
      if (![1, 2].includes(value?.version) || value.owner !== boundOwner || value.identity !== identity
        || (value.portableIdentity !== undefined && value.portableIdentity !== portableIdentity)
        || !receipt || receipt.kind !== 'known' || receipt.runId !== run.id
        || receipt.head !== snapshot.head || receipt.round !== round
        || receipt.strategy !== strategy || receipt.scope !== 'full-suite'
        || !receipt.report || !Number.isInteger(receipt.report.hostExitCode)
        || (receipt.report.suiteOutcome !== undefined && typeof receipt.report.suiteOutcome !== 'string')
        || (receipt.report.suiteEvidence !== undefined && typeof receipt.report.suiteEvidence !== 'string')) return null
      return receipt
    } catch { return null }
  }
  // The retry link only nominates a predecessor. Its latest host receipt must
  // independently establish full green proof under the portable input contract.
  const predecessor = (snapshot: BuildSnapshot, strategy: string, identity: string | null) => {
    if (!identity || currentOwner() !== boundOwner) return null
    try {
      const current = store.get(run.id)!
      const source = readBuildRetrySource(store, current)
      if (!source || source.prior.phase !== 'failed' || source.state.checkpoint.head !== snapshot.head) return null
      const event = store.stageEvents(source.prior.id).filter(event => event.stage === STAGE).at(-1)
      const value = JSON.parse(event?.meta ?? 'null')
      const receipt = value?.receipt as SuiteObservation | undefined
      const savedOwner = JSON.parse(value?.owner ?? 'null')
      const expectedOwner = JSON.parse(owner(source.prior))
      // Cleanup may clear the source worktree after observation. All other
      // ownership coordinates still have to match the authenticated predecessor.
      if (!Array.isArray(savedOwner) || savedOwner.length !== expectedOwner.length
        || savedOwner.some((part, index) => index === 3 && source.prior.worktree === null
          ? typeof part !== 'string' : part !== expectedOwner[index])) return null
      if (!event || value.version !== 2 || value.portableIdentity !== identity
        || !value.identity || value.observation?.before?.identity !== value.identity
        || value.observation?.after?.identity !== value.identity
        || value.observation?.before?.portableIdentity !== identity
        || value.observation?.after?.portableIdentity !== identity
        || value.adoptedFrom !== undefined
        || receipt?.kind !== 'known' || receipt.runId !== source.prior.id
        || receipt.head !== snapshot.head || receipt.round !== source.state.checkpoint.round
        || receipt.strategy !== strategy || receipt.scope !== 'full-suite'
        || receipt.report?.hostExitCode !== 0) return null
      return { event, receipt }
    } catch { return null }
  }
  return {
    async observe(source: ReviewSuiteSource, snapshot: BuildSnapshot, round: number,
      strategy: string | undefined, scope: SuiteObservation['scope'] | undefined) {
      const measuredBefore = await measure(snapshot)
      const identity = measuredBefore?.identity ?? null
      const portableIdentity = portable(measuredBefore)
      const before = { identity, components: safeComponents(measuredBefore), at: new Date().toISOString(),
        ...(portableIdentity ? { portableIdentity } : {}) }
      const event = latest()
      const prior = scope === 'full-suite' && strategy !== undefined
        ? decode(event?.meta, snapshot, round, strategy, identity, portableIdentity) : null
      if (prior) return prior
      // Once this run has acquired or invalidated proof, it cannot revive an
      // ancestor. Only the first observation may adopt its direct predecessor.
      const candidate = !event && scope === 'full-suite' && strategy !== undefined
        ? predecessor(snapshot, strategy, portableIdentity) : null
      if (candidate && identity) {
        const checked = await measure(snapshot)
        const confirmed = predecessor(snapshot, strategy!, portable(checked))
        if (checked?.identity === identity && portable(checked) === portableIdentity
          && confirmed?.event.id === candidate.event.id && confirmed.event.meta === candidate.event.meta) {
          const receipt: SuiteObservation = { ...candidate.receipt, runId: run.id, round }
          const adoptedFrom = { runId: candidate.receipt.runId, eventId: candidate.event.id, round: candidate.receipt.round }
          const saved = await store.appendSuiteReceipt(run.id, null, JSON.stringify({ version: 2,
            owner: boundOwner, identity, portableIdentity, receipt, adoptedFrom,
            observation: { before, after: { ...before, at: new Date().toISOString() }, hostExitCode: 0 } }),
            { runId: candidate.receipt.runId, eventId: candidate.event.id, meta: candidate.event.meta! })
          if (saved === null) return unknown('Suite adoption ownership changed or run stopped')
          return receipt
        }
      }
      // A missing/corrupt/mismatched receipt is not proof. Atomic invalidation
      // prevents a failed acquisition, or a stale host, reviving old success.
      const version = await store.appendSuiteReceipt(run.id, event?.id ?? null,
        JSON.stringify({ version: 1, owner: boundOwner, observation: { before } }))
      if (version === null) return unknown('Suite acquisition ownership changed or run stopped')
      const receipt = await source.observe(snapshot, round)
      const measuredAfter = await measure(snapshot)
      const after = measuredAfter?.identity ?? null
      const portableAfter = portable(measuredAfter)
      const componentsAfter = safeComponents(measuredAfter)
      // Keep measurements independently of reusable proof. Unknown is not a
      // changed hash, and neither may hide the host's already observed exit.
      const observation = { before, after: { identity: after, components: componentsAfter, at: new Date().toISOString(),
        ...(portableAfter ? { portableIdentity: portableAfter } : {}) },
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
          JSON.stringify({ version: 2, owner: boundOwner, identity, receipt, observation,
            ...(portableIdentity && portableIdentity === portableAfter ? { portableIdentity } : {}) }))
        if (saved === null) return unknown('Suite completion ownership changed or run stopped')
      }
      return receipt
    },
  }
}
