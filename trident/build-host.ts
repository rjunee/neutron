import { readFile } from 'node:fs/promises'
import { placementFor, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import type { BuildRunDeps, BuildRunInput, BuildSnapshot, GateResult } from './build-run.ts'
import { publicationReadiness, pinnedMergeReadiness } from './gates/release-readiness.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { validateTrailer } from './gates/result-contract.ts'
import { eligibleFixFindings } from './gates/verdict.ts'
import { ciReadinessForHead, type CiRunObservation } from './ci-readiness.ts'
import { runLeakGatePreflight } from './leak-preflight.ts'
import { assessMergeDiff } from './merge.ts'
import { runMutationProofGate, type MutationGateInput } from './mutation-prover.ts'

type Workers = BuildRunInput['workers']
type Role = keyof Workers
const roles = ['plan', 'build', 'review', 'fix'] as const

export interface BuildHostOptions {
  runners: Partial<Record<Provider, WorkerRunner>>
  replProvider: Provider
  workers: Record<Role, { provider: Provider; request: Workers[Role]['request'] }>
  /** Host observations and effects, never worker assertions or gate overrides. */
  effects: Pick<BuildRunDeps, 'prepareWork' | 'measure' | 'publish' | 'merge'>
  leak: Omit<Parameters<typeof runLeakGatePreflight>[0], 'head' | 'fixer' | 'max_fix_attempts'>
  mutation: Omit<MutationGateInput, 'expected_head' | 'claim'> & {
    readClaim(snapshot: BuildSnapshot): Promise<MutationGateInput['claim']>
  }
  observeCi(snapshot: BuildSnapshot): Promise<CiRunObservation>
}

/** A missing or mis-keyed runner remains an explicit admission refusal. */
function unavailableRunner(provider: Provider): WorkerRunner {
  return {
    provider,
    supports: () => ({ ok: false, reason: 'provider-not-connected', detail: `No matching runner supplied for ${provider}` }),
    run: async () => ({ kind: 'refused', reason: 'provider-not-connected' }),
    liveness: async () => 'unknown',
  }
}

/** Compose the kept gates. Partial gate evidence never authorizes publication. */
export function createBuildHost(options: BuildHostOptions): { deps: BuildRunDeps; workers: Workers } {
  const workers = {} as Workers
  for (const role of roles) {
    const selected = options.workers[role]
    const supplied = options.runners[selected.provider]
    const runner = supplied?.provider === selected.provider ? supplied : unavailableRunner(selected.provider)
    const placement = placementFor(selected.provider, options.replProvider)
    workers[role] = {
      request: structuredClone(selected.request),
      runner: {
        provider: selected.provider,
        supports: (workRole) => runner.supports(workRole, placement),
        run: (request, _placement, signal) => runner.run(request, placement, signal),
        liveness: (handle) => runner.liveness(handle),
      },
    }
  }
  const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
  const deps: BuildRunDeps = {
    ...options.effects,
    async admissionGate(input) {
      // Re-read every brief on admission, including the later fix role.
      for (const role of roles) {
        const brief = input.workers[role].request.brief
        let text: string
        try { text = await readFile(brief.path, 'utf8') }
        catch { return unknown(`${role} brief could not be read`) }
        if (briefIntegrity(text) !== brief.integrity) return { kind: 'blocked', on: `${role} brief integrity mismatch` }
      }
      return unknown('Complete project admission policy is not wired')
    },
    runLeakGatePreflight: (snapshot) => runLeakGatePreflight({ ...options.leak, head: snapshot.head, max_fix_attempts: 0 }),
    assessMergeDiff,
    async reviewGate(payload) {
      const checked = validateTrailer('verdict', payload)
      if (!checked.ok) return { kind: 'unknown', detail: `Review trailer ${checked.reason} at ${checked.path}` }
      const findings = eligibleFixFindings(checked.value.findings)
      if (findings && findings.length > 0) return { kind: 'blocked', on: 'Review has blocking findings; panel provenance is not wired' }
      return { kind: 'unknown', detail: 'Review panel provenance, cross-model seats and arbitration are not wired' }
    },
    async publishGate(snapshot) {
      const claim = await options.mutation.readClaim(snapshot)
      const proof = await runMutationProofGate({ ...options.mutation, claim, expected_head: snapshot.head })
      if (!proof.ok) return { kind: 'blocked', on: proof.reason }
      const readiness = await publicationReadiness(options.mutation.run_host, options.mutation.run.repo_path, options.mutation.run.branch ?? `trident/${options.mutation.run.slug}`, options.leak.base_sha, snapshot)
      if (readiness.kind !== 'allow') return readiness
      return unknown('Publication previous reviewed-head lineage could not be established')
    },
    async mergeGate(snapshot) {
      const ci = ciReadinessForHead(snapshot.head, await options.observeCi(snapshot))
      if (ci.kind === 'cannot-read') return unknown(ci.reason)
      if (ci.kind !== 'green') return { kind: 'blocked', on: `CI: ${ci.kind}` }
      return pinnedMergeReadiness(options.mutation.run_host, options.mutation.run.repo_path, snapshot)
    },
  }
  return { deps, workers }
}
