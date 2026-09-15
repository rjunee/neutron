import { executeBoundReview, type BoundReviewOutcome } from './review-run.ts'
import { fixLineage } from './gates/fix-lineage.ts'
import { readFile } from 'node:fs/promises'
import { placementFor, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { buildRun, type BuildRunOutcome, type BuildRunDeps, type BuildRunInput, type BuildSnapshot, type GateResult } from './build-run.ts'
import { publicationReadiness, pinnedMergeReadiness } from './gates/release-readiness.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { projectAdmission, type AdmissionSource } from './gates/project-admission.ts'
import { reviewPanel, type ReviewSource } from './gates/review-panel.ts'
import { ciReadinessForHead, type CiRunObservation } from './ci-readiness.ts'
import { runLeakGatePreflight } from './leak-preflight.ts'
import { assessMergeDiff, localMergeReadiness } from './merge.ts'
import { runMutationProofGate, type MutationGateInput } from './mutation-prover.ts'

type Workers = BuildRunInput['workers']
type Role = keyof Workers
const roles = ['plan', 'build', 'review', 'fix'] as const

export interface BuildHostOptions {
  modes?: BuildRunDeps['modes']
  boundReview?: { run: Parameters<typeof executeBoundReview>[0]; deps: Parameters<typeof executeBoundReview>[1] }
  runners: Partial<Record<Provider, WorkerRunner>>
  replProvider: Provider
  workers: Record<Role, { provider: Provider; request: Workers[Role]['request'] }>
  /** Host observations and effects, never worker assertions or gate overrides. */
  effects: Pick<BuildRunDeps, 'prepareWork' | 'measure' | 'publish' | 'merge'>
  leak: Omit<Parameters<typeof runLeakGatePreflight>[0], 'head' | 'fixer' | 'max_fix_attempts'>
  mutation: Omit<MutationGateInput, 'expected_head' | 'claim'> & {
    readClaim(snapshot: BuildSnapshot): Promise<MutationGateInput['claim']>
  }
  /** Persisted previous review pin; explicit null for a fresh first round. */
  reviewed_head: string | null
  local?: { baseBranch: string; worktree: string }
  admission?: AdmissionSource
  review?: ReviewSource
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

/** Compose the kept gates and the advisory leak preflight. */
export function createBuildHost(options: BuildHostOptions): { deps: BuildRunDeps; workers: Workers; run(input: BuildRunInput, signal: AbortSignal): Promise<BuildRunOutcome | BoundReviewOutcome> } {
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
  const localReadiness = (snapshot: BuildSnapshot): Promise<GateResult> => options.local
    ? localMergeReadiness(options.mutation.run_host, options.mutation.run.repo_path,
      options.mutation.run.branch, options.local.baseBranch, options.local.worktree, snapshot.head)
    : Promise.resolve(unknown('Local merge configuration is missing'))
  const deps: BuildRunDeps = {
    ...options.effects,
    ...(options.modes ? { modes: options.modes } : {}),
    async confirmLocalMerge(snapshot) {
      if (!options.local) return unknown('Local merge configuration is missing')
      const run = options.mutation.run_host
      const repo = options.mutation.run.repo_path
      const branch = options.mutation.run.branch
      const tip = await run(['git', '-C', repo, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`], repo)
      if (!tip.ok) return unknown('Local branch confirmation could not be read')
      if (tip.stdout.trim() !== snapshot.head) return { kind: 'blocked', on: 'Local branch was changed or removed' }
      const contained = await run(['git', '-C', repo, 'merge-base', '--is-ancestor', snapshot.head, `refs/heads/${options.local.baseBranch}`], repo)
      if (contained.ok) return { kind: 'allow' }
      return contained.exit_code === 1 && !contained.timed_out
        ? { kind: 'blocked', on: 'Local merge not confirmed for reviewed head' }
        : unknown('Local merge ancestry could not be read')
    },
    async admissionGate(input) {
      // Re-read every brief on admission, including the later fix role.
      for (const role of roles) {
        const brief = input.workers[role].request.brief
        let text: string
        try { text = await readFile(brief.path, 'utf8') }
        catch { return unknown(`${role} brief could not be read`) }
        if (briefIntegrity(text) !== brief.integrity) return { kind: 'blocked', on: `${role} brief integrity mismatch` }
      }
      return projectAdmission(options.admission, input)
    },
    async runLeakGatePreflight(snapshot) {
      let gateReturned = false
      const result = await runLeakGatePreflight({ ...options.leak, head: snapshot.head, max_fix_attempts: 0,
        run_host: async (argv, cwd, env, timeout) => {
          const result = await options.leak.run_host(argv, cwd, env, timeout)
          // The scanner returned an observation, including a gate error. Setup
          // failures and thrown invocations provide no such observation.
          if (argv.includes('bash') && argv.includes('--tree')) gateReturned = true
          return result
        },
      })
      if (!gateReturned) return { ...result, status: 'unknown' }
      return result
    },
    assessMergeDiff,
    reviewGate: (payload, snapshot, round, replansUsed) => reviewPanel(options.review, payload, snapshot, round, options.mutation.run.id, replansUsed),
    async publishGate(snapshot, mergeMode) {
      const claim = await options.mutation.readClaim(snapshot)
      const proof = await runMutationProofGate({ ...options.mutation, claim, expected_head: snapshot.head })
      if (!proof.ok) return { kind: 'blocked', on: proof.reason }
      const readiness = mergeMode === 'local' ? await localReadiness(snapshot) : await publicationReadiness(options.mutation.run_host, options.mutation.run.repo_path, options.mutation.run.branch ?? `trident/${options.mutation.run.slug}`, options.leak.base_sha, snapshot)
      if (readiness.kind !== 'allow') return readiness
      return fixLineage(options.mutation.run_host, options.mutation.run.repo_path, options.mutation.run.branch ?? `trident/${options.mutation.run.slug}`, options.reviewed_head, snapshot.head)
    },
    async mergeGate(snapshot, mergeMode) {
      if (mergeMode === 'local') return localReadiness(snapshot)
      const ci = ciReadinessForHead(snapshot.head, await options.observeCi(snapshot))
      if (ci.kind === 'cannot-read') return unknown(ci.reason)
      if (ci.kind !== 'green') return { kind: 'blocked', on: `CI: ${ci.kind}` }
      return pinnedMergeReadiness(options.mutation.run_host, options.mutation.run.repo_path, snapshot)
    },
  }
  return {
    deps, workers,
    async run(input, signal) {
      if (input.mode === 'bound_pr') {
        const review = options.boundReview
        if (!review || review.run.id !== input.run_id || review.run.bound_pr !== input.bound_pr) {
          return { kind: 'blocked', phase: 'review', on: 'Bound review context is missing or mismatched', recipient: 'orchestrator' }
        }
        // Return both success and failure directly: neither enters buildRun.
        return executeBoundReview(review.run, review.deps)
      }
      return buildRun(input, deps, signal)
    },
  }
}
