import { readFile, writeFile } from 'node:fs/promises'
import { placementFor, type Provider, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import type { BuildRunInput, BuildRunOutcome } from './build-run.ts'
import { createBuildHost, type BuildHostOptions } from './build-host.ts'
import { createProjectReviewSource, type ProjectReviewSourceOptions } from './project-review-source.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { createProductionHostEffects, workContextPath, type CleanupOutcome, type ProductionHostOptions } from './production-host-effects.ts'

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
  /** Phase usage is a required write for the host, so the composition must supply
   * its store rather than let the driver run unmeasured. */
  phaseUsage: BuildHostOptions['phaseUsage']
  policy: Pick<BuildHostOptions, 'boundReview'> & {
    review?: Omit<ProjectReviewSourceOptions, 'runId' | 'projectSlug' | 'cwd' | 'replProvider'>
    leak: Pick<BuildHostOptions['leak'], 'scratch_dir' | 'gate_script'>
    mutation: Omit<BuildHostOptions['mutation'], 'run' | 'run_host' | 'base_branch'>
  }
  workers: BuildHostOptions['workers']
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
  const production = createProductionHostEffects(options.production)
  const runners = projectBuildRunners(options.substrate, Object.values(workers).map(worker => worker.provider))
  const { review, ...policy } = options.policy
  const host = createBuildHost({
    ...policy,
    ...(review ? { review: createProjectReviewSource({ ...review,
      runId: run.id, projectSlug: config.projectSlug, cwd: config.worktree, replProvider: options.substrate.provider }) } : {}),
    workers, runners, phaseUsage: options.phaseUsage,
    reviewed_head: run.inner_checkpoint_head,
    leak: { ...options.policy.leak, run_host: config.runHost, repo_path: config.repo, branch: config.branch, base_sha: run.base_sha },
    mutation: { ...options.policy.mutation, run, run_host: config.runHost, base_branch: config.baseBranch },
    replProvider: options.substrate.provider,
    effects: production.effects,
    modes: production.modes,
    admission: production.admission,
    observeCi: production.observeCi,
    local: { baseBranch: options.production.baseBranch, worktree: options.production.worktree },
  })
  return {
    runners, workers: host.workers, deps: host.deps,
    async run(input: Omit<BuildRunInput, 'run_id' | 'workers' | 'repl_provider' | 'merge_mode'>, signal: AbortSignal): Promise<ProjectBuildOutcome> {
      return withProductionCleanup(
        async () => {
          const result = await host.run({ ...input, ...(input.mode === 'ralph' ? { ralphRound: production.ralphIteration() } : {}), run_id: run.id, workers: host.workers, repl_provider: options.substrate.provider, merge_mode: run.merge_mode }, signal)
          if (!('kind' in result)) throw new Error('Project build returned a review-only outcome')
          return result
        },
        production.cleanup,
      )
    },
  }
}
