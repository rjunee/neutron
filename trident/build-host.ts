import { assessReviewCi, type ReviewCiSource } from './gates/review-ci.ts'
import { reviewArtifact } from './gates/review-artifact.ts'
import { assessReviewSuite, type ReviewSuiteSource } from './gates/review-suite.ts'
import { awaitReviewReadiness, type ReviewReadinessSource } from './gates/review-readiness.ts'
import { executeBoundReview, type BoundReviewOutcome } from './review-run.ts'
import { checkBuildClaim } from './gates/build-claim.ts'
import { fixLineage } from './gates/fix-lineage.ts'
import { readFile } from 'node:fs/promises'
import { placementFor, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { buildRun, type BuildRunOutcome, type BuildRunDeps, type BuildRunInput, type BuildSnapshot, type GateResult } from './build-run.ts'
import { publicationReadiness, pinnedMergeReadiness } from './gates/release-readiness.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { projectAdmission, type AdmissionSource } from './gates/project-admission.ts'
import { unknownCause } from './gates/unknown-cause.ts'
import { reviewPanel, type ReviewSource } from './gates/review-panel.ts'
import { ciReadinessForHead, type CiRunObservation } from './ci-readiness.ts'
import { runLeakGatePreflight } from './leak-preflight.ts'
import { assessMergeDiff, localMergeReadiness } from './merge.ts'
import { runMutationProofGate, type MutationGateInput } from './mutation-prover.ts'
import type { PhaseUsageReport, PhaseUsageRow, TridentPhaseUsageStore } from './phase-usage.ts'

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
  phaseUsage: Pick<TridentPhaseUsageStore, 'list' | 'record'>
  leak: Omit<Parameters<typeof runLeakGatePreflight>[0], 'head' | 'fixer' | 'max_fix_attempts'>
  mutation: Omit<MutationGateInput, 'expected_head' | 'claim'> & {
    run: MutationGateInput['run'] & { max_rounds?: number | undefined }
    readClaim(snapshot: BuildSnapshot): Promise<MutationGateInput['claim']>
  }
  /** Persisted previous review pin; explicit null for a fresh first round. */
  reviewed_head: string | null
  local?: { baseBranch: string; worktree: string }
  admission?: AdmissionSource
  reviewReadiness?: ReviewReadinessSource
  reviewCi?: ReviewCiSource
  reviewSuite?: ReviewSuiteSource
  /** REQUIRED, not optional. A host that cannot produce terminal full-suite evidence
   * must not reach merge, and making this optional moved that decision from
   * construction time — where the type can enforce it — to a runtime `unknown` that
   * every caller had to remember to wire. Supply a source, or supply one that refuses. */
  publicationSuite: ReviewSuiteSource
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
  const usageBaselines = new Map<string, PhaseUsageRow>()
  const usageLastObserved = new Map<string, number>()
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
      options.mutation.run.branch, options.local.baseBranch, options.local.worktree, snapshot.head, options.mutation.run.id)
    : Promise.resolve(unknown('Local merge configuration is missing'))
  const deps: BuildRunDeps = {
    ...options.effects,
    recordPhaseUsage: async (runId, phase, report) => {
      const key = `${runId}:${phase}`
      let baseline = usageBaselines.get(key)
      if (!baseline) {
        const rows = options.phaseUsage.list(runId)
        if (rows === null) throw new Error('Phase usage target run is unknown')
        baseline = rows.find(row => row.phase === phase)
        if (baseline) usageBaselines.set(key, baseline)
      }
      const known = baseline?.status !== 'unknown'
      const add = (prior: number | null | undefined, current: number | null): number | null =>
        current === null || (known && prior == null) ? null : (prior ?? 0) + current
      const absolute: PhaseUsageReport = {
        ...report,
        input_tokens: add(baseline?.input_tokens, report.input_tokens),
        output_tokens: add(baseline?.output_tokens, report.output_tokens),
        cache_read_tokens: add(baseline?.cache_read_tokens, report.cache_read_tokens),
        cache_creation_tokens: add(baseline?.cache_creation_tokens, report.cache_creation_tokens),
        cost_usd: add(baseline?.cost_usd, report.cost_usd),
        source: known && baseline?.source !== report.source ? 'multiple-models' : report.source,
        observed_at: Math.max(report.observed_at, (baseline?.observed_at ?? -1) + 1, (usageLastObserved.get(key) ?? -1) + 1),
      }
      // NOTHING MEASURED, NOTHING TO WRITE — and the schema is what decides that.
      // `0144_trident_phase_usage.sql:23-34` permits all-null measurements ONLY under
      // `status = 'unknown'`; a `'partial'` row must carry a source, an observed_at AND
      // at least one non-null token/cost field. The trigger `code_trident_runs_seed_usage`
      // already seeds every phase as `'unknown'`, so when the harness reports no usage
      // the truthful row is ALREADY THERE and rewriting it as `'partial'` is what the
      // CHECK rejects.
      //
      // That is not hypothetical: a project build supplies `metadata: () => undefined`
      // (`open/wiring/project-build.ts`), so `decodeProjectTrailer` fills
      // `{usage: null, model_reported: null, ...}` and EVERY field here resolves null.
      // The first completed worker turn — plan, round 0 — therefore threw
      // `Phase usage write was …` out of this very line, and `buildRun` reported
      // `{kind: 'unknown', phase: 'plan'}` before any gate ran. Measured against a copy
      // of the live database: `SQLiteError: CHECK constraint failed`.
      //
      // Skipping preserves the record rather than degrading it: the row keeps saying
      // "no measurement", which is exactly what happened.
      if (absolute.input_tokens === null && absolute.output_tokens === null
        && absolute.cache_read_tokens === null && absolute.cache_creation_tokens === null
        && absolute.cost_usd === null) return
      const result = await options.phaseUsage.record(runId, phase, absolute)
      if (result !== 'recorded') throw new Error(`Phase usage write was ${result}`)
      usageLastObserved.set(key, absolute.observed_at)
    },
    reviewArtifact,
    checkBuildClaim: (claim, snapshot) => checkBuildClaim(options.mutation.run_host,
      options.mutation.run.repo_path, options.mutation.run.branch ?? `trident/${options.mutation.run.slug}`, claim, snapshot, options.mutation.run.id),
    checkFixLineage: (snapshot, reviewedHead) => fixLineage(options.mutation.run_host,
      options.mutation.run.repo_path, options.mutation.run.branch ?? `trident/${options.mutation.run.slug}`, reviewedHead, snapshot.head),
    async readReviewCap(runId) {
      const row = options.mutation.run
      if (!row || row.id !== runId) return { kind: 'unknown', detail: 'Review round cap run row is missing or mismatched' }
      return { kind: 'known', max_rounds: row.max_rounds }
    },
    // A missing run row is the cap reader's `unknown`, not a crash here: the same
    // test deletes the row to exercise that refusal.
    assignedBranch: options.mutation.run?.branch ?? (options.mutation.run?.slug ? `trident/${options.mutation.run.slug}` : undefined),
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
        catch (error) { return unknownCause(`${role} brief could not be read`, error, input.run_id) }
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
    reviewReadiness: (snapshot, signal, mergeMode) => mergeMode === 'local'
      ? localReadiness(snapshot)
      : awaitReviewReadiness(options.reviewReadiness, snapshot, signal),
    // A LOCAL RUN HAS NO PR, SO IT HAS NO CI TO OBSERVE — and G055 is entirely about
    // a PR's checks. `createProjectObservationSources`'s CI source reads its rows off
    // `snapshot.pr` (`project-observation-sources.ts:32,66`), which `readPr` pins to
    // `null` for a local run (`production-host-effects.ts:183-185`), so it answered
    // `Review CI: Review readiness PR or full head is missing` — `unknown`, which is
    // fail-closed, for EVERY local build. Measured offline end to end: with
    // `merge_mode: 'local'` the driver planned, built, and then stopped at review with
    // that detail and no dispatch left to make. `merge_mode` defaults to `'local'`
    // (`store.ts:867`), so this was the default mode failing by construction.
    //
    // The branch is never pushed in local mode (`publishChecked` refuses anything but
    // `pr`), so there are no checks for this revision to be red — an empty KNOWN
    // assessment is the measurement, not an exemption. The suite evidence that does
    // apply locally is G063's, which is the host's own suite run and is untouched.
    //
    // Local-awareness belongs here, beside `reviewReadiness` below, not in the driver:
    // the host already owns what each gate means per merge mode.
    reviewCi: (snapshot, mergeMode, signal) => mergeMode === 'local'
      ? Promise.resolve({ kind: 'known', findings: [] })
      : assessReviewCi(options.reviewCi, snapshot, options.leak.base_sha, options.mutation.run.id, signal),
    reviewSuite: (snapshot, round) => assessReviewSuite(options.reviewSuite, snapshot, round, options.mutation.run.id),
    publicationSuite: snapshot => assessReviewSuite(options.publicationSuite, snapshot, -1, options.mutation.run.id),
    reviewGate: (payload, snapshot, round, replansUsed, recordProgress) => reviewPanel(options.review, payload, snapshot, round, options.mutation.run.id, replansUsed, { provider: options.workers.build.provider, modelId: options.workers.build.request.model_id }, recordProgress),
    async publishGate(snapshot, mergeMode) {
      const claim = await options.mutation.readClaim(snapshot)
      const proof = await runMutationProofGate({ ...options.mutation, claim, expected_head: snapshot.head })
      if (!proof.ok) return proof.repair
        ? { kind: 'repair-nomination', finding: `Mutation nomination is invalid: ${proof.repair.detail}. Supply a corrected nomination for the repaired commit; the mutation prover must still pass.` }
        : { kind: 'blocked', on: proof.reason }
      const readiness = mergeMode === 'local' ? await localReadiness(snapshot) : await publicationReadiness(options.mutation.run_host, options.mutation.run.repo_path, options.mutation.run.branch ?? `trident/${options.mutation.run.slug}`, options.leak.base_sha, snapshot, options.mutation.run.id)
      if (readiness.kind !== 'allow') return readiness
      return fixLineage(options.mutation.run_host, options.mutation.run.repo_path, options.mutation.run.branch ?? `trident/${options.mutation.run.slug}`, options.reviewed_head, snapshot.head)
    },
    async mergeGate(snapshot, mergeMode) {
      if (mergeMode === 'local') return localReadiness(snapshot)
      const ci = ciReadinessForHead(snapshot.head, await options.observeCi(snapshot))
      if (ci.kind === 'cannot-read') return unknown(ci.reason)
      if (ci.kind !== 'green') return { kind: 'blocked', on: `CI: ${ci.kind}` }
      return pinnedMergeReadiness(options.mutation.run_host, options.mutation.run.repo_path, snapshot, options.mutation.run.id)
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
