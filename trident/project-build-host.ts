import { lstat, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { placementFor, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import type { BuildRunInput, BuildRunOutcome, BuildSnapshot } from './build-run.ts'
import { createBuildHost, type BuildHostOptions } from './build-host.ts'
import { createProjectReviewSource, type ProjectReviewSourceOptions } from './project-review-source.ts'
import { createProjectObservationSources, type ProjectSuiteOptions } from './project-observation-sources.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { assessReviewSuite } from './gates/review-suite.ts'
import { createProductionHostEffects, productionCiSource, workContextPath, type CleanupOutcome, type ProductionHostOptions } from './production-host-effects.ts'
import { AttemptAccounting } from './attempt-accounting.ts'
import type { TridentAttemptLedger } from './attempt-ledger.ts'
import { createProjectSuiteReceipts } from './project-suite-receipt.ts'
import { renderHostSuiteWorkerStrategy } from './test-strategy.ts'

/** Bound by the project composition, including its live conversational runner. */
export interface ProjectBuildSubstrate {
  provider: Provider
  inRepl: WorkerRunner | undefined
  headless: Partial<Record<Provider, WorkerRunner>>
}

/** Select only the placement prescribed by the project REPL's provider. */
export function projectBuildRunners(substrate: ProjectBuildSubstrate, providers: readonly Provider[]) {
  const runners: Partial<Record<Provider, WorkerRunner>> = {}
  for (const provider of providers) {
    const candidate = placementFor(provider, substrate.provider) === 'in-repl'
      ? substrate.inRepl : substrate.headless[provider]
    if (candidate?.provider === provider) runners[provider] = candidate
  }
  return runners
}

export interface ProjectBuildHostOptions {
  substrate: ProjectBuildSubstrate
  production: ProductionHostOptions
  /** Policy-specific sources remain explicit, without permissive defaults. */
  attempts: TridentAttemptLedger
  policy: Pick<BuildHostOptions, 'boundReview'> & {
    reviewSuite?: ProjectSuiteOptions
    publicationSuite?: ProjectSuiteOptions
    review?: Omit<ProjectReviewSourceOptions, 'runId' | 'projectSlug' | 'cwd' | 'replProvider' | 'accounting' | 'taskId'>
    leak: Pick<BuildHostOptions['leak'], 'scratch_dir' | 'gate_script'>
    mutation: Omit<BuildHostOptions['mutation'], 'run' | 'run_host' | 'base_branch'>
  }
  workers: BuildHostOptions['workers']
  requestedModels: Record<keyof BuildHostOptions['workers'], string>
  /** Rendered strategies selected only after the driver validates this task's plan. */
  testStrategies?: { full: string; intermediate: string | null }
  /** Host-measured dependency/toolchain/workspace identity; unknown forbids reuse. */
  suiteIdentity?: (snapshot: BuildSnapshot) => Promise<string | null>
}

export type ProjectBuildOutcome = BuildRunOutcome & { cleanup: CleanupOutcome }

export async function withProductionCleanup(
  build: () => Promise<BuildRunOutcome>,
  cleanupEffect: () => Promise<CleanupOutcome>,
): Promise<ProjectBuildOutcome> {
  let outcome: BuildRunOutcome
  let cleanup: CleanupOutcome
  try { outcome = await build() }
  catch (error) { outcome = { kind: 'unknown', phase: 'plan', step_id: null, detail: String(error) } }
  finally { cleanup = await cleanupEffect() }
  return { ...outcome, cleanup }
}

/** The later launcher cutover owns invoking this additive composition. Brief paths
 * are host-owned files, separate from the owner's source briefs. */
export async function createProjectBuildHost(options: ProjectBuildHostOptions) {
  const config = options.production
  const run = config.store.get(config.runId)
  if (!run || run.project_slug !== config.projectSlug || run.repo_path !== config.repo
    || run.branch !== config.branch || run.worktree !== config.worktree || !run.base_sha) {
    throw new Error('Project build requires an initialized run with matching identity and launch base')
  }
  const workers = structuredClone(options.workers)
  for (const [role, worker] of Object.entries(workers)) {
    // Reuse only identical admitted bytes when reconstructing this host.
    const path = `${worker.request.brief.path}.${role}.host`
    const source = await readFile(worker.request.brief.path, 'utf8')
    if (briefIntegrity(source) !== worker.request.brief.integrity) throw new Error('Project source brief integrity mismatch')
    const text = `${source}\n\nRead the host turn context at ${workContextPath(path)} before doing this task.\n`
    try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== text) throw error
    }
    worker.request = { ...worker.request, brief: { path, integrity: briefIntegrity(text) } }
  }
  const ci = config.ciSource ?? productionCiSource(config.runHost, config.repo)
  const production = createProductionHostEffects({ ...config, ciSource: ci })
  const runners = projectBuildRunners(options.substrate, Object.values(workers).map(worker => worker.provider))
  const accounting = new AttemptAccounting(options.attempts, dirname(workers.plan.request.brief.path),
    (stage, meta) => config.store.recordStageEvent(run.id, stage, meta))
  const recoveryRunners = projectBuildRunners(options.substrate, options.attempts.list(run.id).map(row => row.provider as Provider))
  await accounting.reconcile(run.id, provider => recoveryRunners[provider as Provider])
  async function timed<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    return accounting.interval(stage, { run_id: config.runId }, operation)
  }
  const taskId = () => run.wave_task_id ?? `${run.id}:task:${config.store.get(run.id)?.execution_strategy === 'task_sequence' ? production.taskIteration() : 0}`
  for (const [provider, runner] of Object.entries(runners)) {
    runners[provider as Provider] = { provider: runner.provider,
      supports: (role, placement) => runner.supports(role, placement),
      liveness: handle => runner.liveness(handle),
      run: (request, placement, signal) => accounting.run(runner, request, placement, signal),
      recover: (request, placement, signal) => accounting.recover(runner, request, placement, signal),
    }
  }
  const { review, reviewSuite, publicationSuite, ...policy } = options.policy
  const observations = createProjectObservationSources({ ci, baseBranch: config.baseBranch,
    ciWorkflow: config.ciWorkflow, runId: run.id, suite: reviewSuite })
  const publicationObservations = createProjectObservationSources({ ci, baseBranch: config.baseBranch,
    ciWorkflow: config.ciWorkflow, runId: run.id, suite: publicationSuite })
  const suiteReceipts = createProjectSuiteReceipts({ store: config.store, run, identity: options.suiteIdentity })
  let reviewRound: number | undefined
  const host = createBuildHost({
    ...policy,
    ...(review ? { review: createProjectReviewSource({ ...review,
      accounting, taskId, taskInput: () => config.store.get(run.id)?.task ?? '',
      runId: run.id, projectSlug: config.projectSlug, cwd: config.worktree, replProvider: options.substrate.provider }) } : {}),
    workers, runners,
    reviewed_head: run.inner_checkpoint_head,
    leak: { ...options.policy.leak, run_host: config.runHost, repo_path: config.repo, branch: config.branch, base_sha: run.base_sha },
    mutation: { ...options.policy.mutation, run, run_host: config.runHost, base_branch: config.baseBranch },
    replProvider: options.substrate.provider,
    effects: { ...production.effects, async prepareWork(request, context) {
      const strategies = options.testStrategies
      const builder = request.role === 'build' || request.role === 'fix'
      // Already-admitted v2 runs finish the contract embedded in their immutable
      // brief. Recovery cannot retroactively change a worker's suite obligation.
      const legacyWorker = request.brief.path.endsWith(`.strategy-v2.brief.${request.role}.host`)
      const suiteScope = legacyWorker && context.suiteScope === 'host-suite' ? 'full-suite' : context.suiteScope
      const selected = workers[request.role as keyof typeof workers]
      const phase = request.role === 'plan' ? 'decomposition' : request.role === 'review' ? 'review_adversarial' : 'build'
      await accounting.prepare(request, selected.provider, placementFor(selected.provider, options.substrate.provider), {
        phase, task_id: taskId(), head_sha: context.snapshot.head, review_seat: null,
        requested_model: options.requestedModels[request.role as keyof typeof workers],
      }, () => production.effects.prepareWork(request, strategies && builder ? {
          ...context,
          ...(suiteScope ? { suiteScope } : {}),
          testStrategy: suiteScope === 'host-suite'
            ? renderHostSuiteWorkerStrategy(config.baseBranch)
            : suiteScope === 'subset' && strategies.intermediate !== null
            ? strategies.intermediate : strategies.full,
        } : context))
    } },
    modes: production.modes,
    admission: production.admission,
    observeCi: production.observeCi,
    reviewReadiness: observations.reviewReadiness,
    reviewCi: observations.reviewCi,
    reviewSuite: { async observe(snapshot, round) {
      reviewRound = round
      return suiteReceipts.observe(observations.reviewSuite, snapshot, round, reviewSuite?.strategy, reviewSuite?.scope)
    } },
    publicationSuite: publicationObservations.reviewSuite,
    local: { baseBranch: options.production.baseBranch, worktree: options.production.worktree },
  })
  host.deps.validateLegacyPendingRequest = async originalWorkers => {
    const current = config.store.get(run.id)
    if (current?.strategy_source !== 'legacy' || current.execution_strategy === null) {
      return { kind: 'unknown', detail: 'Original worker compatibility requires a migrated execution strategy' }
    }
    try {
      const expected = Object.fromEntries(Object.entries(host.workers).map(([role, worker]) =>
        [role, { provider: worker.runner.provider, request: structuredClone(worker.request) }]))
      for (const role of ['plan', 'build', 'review', 'fix'] as const) {
        const live = expected[role]!.request
        const original = originalWorkers?.[role]?.request
        const directory = dirname(live.brief.path)
        if (![2, 3].some(version => live.brief.path === join(directory, `${role}.strategy-v${version}.brief.${role}.host`))
          || original?.brief.path !== join(directory, `${role}.brief.${role}.host`)
          || typeof original.brief.integrity !== 'string') {
          return { kind: 'unknown', detail: 'Original worker brief is not the reserved legacy artifact' }
        }
        expected[role] = { ...expected[role]!, request: { ...live,
          brief: structuredClone(original.brief),
          ...(role === 'plan' ? { result: { ...live.result, schema: 'project-plan' } } : {}),
        } }
      }
      // Only the known brief/schema transition is permitted. Provider, model,
      // effort, grants, paths, budgets and all other identity remain exact.
      if (!isDeepStrictEqual(originalWorkers, expected)) {
        return { kind: 'unknown', detail: 'Original worker routing or authority changed during recovery' }
      }
      for (const { request } of Object.values(expected)) {
        if (!(await lstat(request.brief.path)).isFile()
          || briefIntegrity(await readFile(request.brief.path, 'utf8')) !== request.brief.integrity) {
          return { kind: 'unknown', detail: 'Original worker brief integrity cannot be established' }
        }
      }
      return { kind: 'allow' }
    } catch (error) { return { kind: 'unknown', detail: `Original worker artifact is unavailable: ${String(error)}` } }
  }
  host.deps.publicationSuite = async snapshot => {
    // Recovery reads the driver's durable round. An in-memory round is useful
    // only before a driver checkpoint exists (direct host consumers).
    let round = reviewRound ?? -1
    try { round = (await production.modes.loadResume())?.round ?? round }
    catch {
      if (config.store.stageEvents(run.id).some(event => event.stage === 'build-mode-state')) {
        return { kind: 'unknown', detail: 'Publication suite round checkpoint is unreadable' }
      }
    }
    return timed('publication-suite', () => assessReviewSuite({ observe: () => suiteReceipts.observe(publicationObservations.reviewSuite,
      snapshot, round, publicationSuite?.strategy, publicationSuite?.scope) }, snapshot, round, run.id))
  }
  const readiness = host.deps.reviewReadiness!
  host.deps.reviewReadiness = (...args) => timed('review-readiness-wait', () => readiness(...args))
  const reviewGate = host.deps.reviewGate
  host.deps.reviewGate = (...args) => timed('review-and-synthesis', () => reviewGate(...args))
  const publishGate = host.deps.publishGate
  host.deps.publishGate = (...args) => timed('publication-proof', () => publishGate(...args))
  const mergeGate = host.deps.mergeGate
  host.deps.mergeGate = (...args) => timed('merge-readiness-wait', () => mergeGate(...args))
  return {
    runners, workers: host.workers, deps: host.deps,
    async run(input: Omit<BuildRunInput, 'run_id' | 'workers' | 'repl_provider' | 'merge_mode'>, signal: AbortSignal): Promise<ProjectBuildOutcome> {
      return withProductionCleanup(
        async () => {
          const current = config.store.get(run.id)
          if (!current) throw new Error('Build run disappeared before dispatch')
          const result = await host.run({ ...input,
            ...(input.mode === 'implementation' ? { executionStrategy: current.execution_strategy } : {}),
            ...(run.published_pr !== null ? { owned_pr: run.published_pr } : {}),
            ...(input.mode === 'implementation' ? { taskIteration: production.taskIteration() } : {}),
            run_id: run.id, workers: host.workers, repl_provider: options.substrate.provider, merge_mode: run.merge_mode }, signal)
          if (!('kind' in result)) throw new Error('Project build returned a review-only outcome')
          return result
        },
        () => timed('cleanup', production.cleanup),
      )
    },
  }
}
