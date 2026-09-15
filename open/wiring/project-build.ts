import { runWorktreePath } from '@neutronai/trident/merge.ts'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createProjectRunners } from '@neutronai/runtime/workers/project-runners.ts'
import { createClaudeActingTurn } from '@neutronai/runtime/workers/claude-acting-turn.ts'
import { createCodexHeadlessRunner } from '@neutronai/runtime/workers/codex-headless.ts'
import { pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { Provider } from '@neutronai/runtime/provider.ts'
import type { ProjectBuildHostOptions } from '@neutronai/trident/project-build-host.ts'
import type { InnerLoopInput } from '@neutronai/trident/inner-loop.ts'
import { briefIntegrity } from '@neutronai/trident/gates/brief-integrity.ts'
import { validateTrailer, PLAN_SCHEMA, FORGE_SCHEMA, VERDICT_SCHEMA } from '@neutronai/trident/gates/result-contract.ts'
import { phaseByKey, parsePhaseModelConfig } from '@neutronai/trident/phase-models.ts'
import { modelTier } from '@neutronai/trident/model-tiers.ts'
import { readProjectRepos } from '@neutronai/trident/project-repos.ts'

export interface ProjectBuildContext {
  store: ProjectBuildHostOptions['production']['store']
  phaseUsage: ProjectBuildHostOptions['phaseUsage']
  runHost: ProjectBuildHostOptions['production']['runHost']
  stateRoot: string
  projectDir: string
  projectId: string
  provider: Provider
  env: NodeJS.ProcessEnv
}

/** Bind one dispatched project, using the host's retained session launch options. */
export async function prepareProjectBuild(input: InnerLoopInput, context: ProjectBuildContext, signal: AbortSignal): Promise<ProjectBuildHostOptions> {
  const run = { ...input.run, branch: input.run.branch ?? `trident/${input.run.slug}`,
    worktree: input.run.worktree ?? runWorktreePath(input.run.repo_path, input.run) }
  if (!run.base_sha) throw Error('Dispatched build has no pinned base')
  const git = async (args: string[]) => context.runHost(['git', '-C', run.repo_path, ...args], run.repo_path)
  const saved = await context.store.update(run.id, { branch: run.branch, worktree: run.worktree, base_sha: run.base_sha })
  if (!saved) throw Error('Dispatched build row disappeared')
  let exists = false
  try { await lstat(run.worktree); exists = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!exists) {
    const branch = await git(['show-ref', '--verify', '--quiet', `refs/heads/${run.branch}`])
    if (branch.timed_out || (!branch.ok && branch.exit_code !== 1)) throw Error('Build branch existence is unknown')
    const added = await git(branch.ok
      ? ['worktree', 'add', '--', run.worktree, run.branch]
      : ['worktree', 'add', '-b', run.branch, '--', run.worktree, run.base_sha])
    if (!added.ok || added.timed_out) throw Error('Build worktree creation was not confirmed')
  }
  const checked = await context.runHost(['git', '-C', run.worktree, 'symbolic-ref', '--quiet', 'HEAD'], run.worktree)
  if (!checked.ok || checked.timed_out || checked.stdout.trim() !== `refs/heads/${run.branch}`) throw Error('Build worktree does not hold the assigned branch')
  const state = join(context.stateRoot, encodeURIComponent(run.id))
  await mkdir(state, { recursive: true })
  const topic = run.chat_id ?? context.projectId
  const substrate = await createProjectRunners({
    conversation: { project_id: context.projectId, topic_id: topic, provider: context.provider,
      spec: { tools: [], model_preference: [], metering_context: { project_id: context.projectId } } },
    run_id: run.id, state_dir: state,
    actingTurn: async turn => {
      if (context.provider !== 'anthropic') return { kind: 'refused', reason: 'capability-unsupported', detail: `No live acting-turn binding for ${context.provider}` }
      const candidates = [...supervisedBySessionKey].filter(([, options]) =>
        options.project_id === context.projectId && options.substrate_instance_id.startsWith('cc-agent-'))
      if (candidates.length !== 1) return { kind: 'unknown', detail: 'Project conversation session is missing or ambiguous' }
      const [key, options] = candidates[0]!
      const pending = pool.get(key)
      if (!pending || Bun.peek.status(pending) !== 'fulfilled') return { kind: 'unknown', detail: 'Project conversation is not ready' }
      const session = await pending
      if (!session || session.hasChildExited()) return { kind: 'unknown', detail: 'Project conversation child is unavailable' }
      // Restricted launches do not attest the edit/run grants required by this bridge.
      if (options.skip_permissions !== true || options.restricted || options.permissions) return { kind: 'refused', reason: 'capability-unsupported', detail: 'Project launch grants cannot authorize bounded build work' }
      return createClaudeActingTurn({ project_id: context.projectId, topic_id: topic, session,
        grants: { tools: 'edit-and-run', writable: true, network: true, roots: options.extra_dirs ?? [] } })(turn)
    },
    trailer: { schemas: new Map([
      ['project-plan', (value: unknown) => validSnapshot(value, 'plan')],
      ['project-build', (value: unknown) => validSnapshot(value, 'forge')],
      ['project-review', (value: unknown) => validSnapshot(value, 'verdict')],
      ['verdict', (value: unknown) => validateTrailer('verdict', value).ok],
    ]), metadata: () => undefined },
    headless: { 'openai-codex': createCodexHeadlessRunner({ env: { ...context.env, ...(input.codex_home ? { CODEX_HOME: input.codex_home } : {}) } }) },
  })
  const parsed = parsePhaseModelConfig(input.phase_models ?? {})
  if (parsed.errors.length) throw Error(`Invalid project phase models: ${parsed.errors.join('; ')}`)
  const config = parsed.config
  const workers = {} as ProjectBuildHostOptions['workers']
  for (const role of ['plan', 'build', 'review', 'fix'] as const) {
    const phase = phaseByKey(role === 'plan' ? 'decomposition' : role === 'review' ? 'review_adversarial' : 'build')!
    const selected = config[phase.key]
    const descriptor = modelTier(selected?.model ?? phase.default.tier)
    if (!descriptor) throw Error(`Unknown model for ${role}`)
    const provider: Provider = descriptor.group === 'claude' ? 'anthropic' : descriptor.group === 'codex' ? 'openai-codex' : 'pi'
    const brief = [run.task, input.reflection_context ?? '', input.test_strategy ?? '',
      `Perform the ${role} role. Return a result object with head, diff, pr and payload.`,
      `Read the host context for the measured snapshot. Payload must satisfy the ${role === 'plan' ? 'plan' : role === 'review' ? 'verdict' : 'forge'} trailer contract.`,
      JSON.stringify(role === 'plan' ? PLAN_SCHEMA : role === 'review' ? VERDICT_SCHEMA : FORGE_SCHEMA),
      'Never publish or merge; the host owns those actions.',
    ].join('\n\n')
    const path = join(state, `${role}.brief`)
    await writeFile(path, brief, { mode: 0o600 })
    workers[role] = { provider, request: {
      model_id: descriptor.model_id, effort: selected?.effort ?? phase.default.effort,
      cwd: run.worktree, writable: role !== 'review', network: role !== 'review',
      tools: role === 'review' ? 'read-only' : 'edit-and-run',
      brief: { path, integrity: briefIntegrity(brief) },
      result: { schema: role === 'plan' ? 'project-plan' : role === 'review' ? 'project-review' : 'project-build', path: join(state, `${role}.result`) },
      thread: null, budget: { wall_ms: 2_700_000 },
    } }
  }
  const bodyFile = join(state, 'publication.md')
  await writeFile(bodyFile, run.task, { mode: 0o600 })
  const declaration = readProjectRepos(context.projectDir, run.project_slug)
  const repo = declaration.repos.find(row => resolve(context.projectDir, row.path) === resolve(run.repo_path))
  return {
    substrate, workers, phaseUsage: context.phaseUsage,
    production: { store: context.store, runId: run.id, projectSlug: run.project_slug,
      repo: run.repo_path, worktree: run.worktree, branch: run.branch, baseBranch: input.base_branch,
      runHost: context.runHost, ciWorkflow: repo?.ciWorkflow,
      publication: { title: run.task.split('\n')[0]!, bodyFile } },
    policy: {
      leak: { scratch_dir: join(state, 'leak') },
      mutation: { readClaim: async () => {
        const value = JSON.parse(await readFile(workers.build.request.result.path, 'utf8'))
        const checked = validateTrailer('forge', value?.result?.payload)
        return checked.ok ? checked.value.mutationClaim : null
      } },
      reviewSuite: { strategy: input.test_strategy ?? '', scope: 'full-suite', readCheckpoint: async () => null },
      review: { evidenceRoot: state, env: context.env, phaseModels: config, wallMs: 2_700_000, signal,
        runnerFor: (model, seat) => model.group === 'api' || model.group === 'kimi' ? undefined
          : seat.provider === substrate.provider ? substrate.inRepl : substrate.headless[seat.provider] },
    },
  }
}

function validSnapshot(value: unknown, kind: 'plan' | 'forge' | 'verdict'): boolean {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Record<string, unknown>
  return typeof snapshot.head === 'string' && typeof snapshot.diff === 'string'
    && (snapshot.pr === null || (typeof snapshot.pr === 'object' && snapshot.pr !== null))
    && validateTrailer(kind, snapshot.payload).ok
}
