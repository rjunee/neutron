import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { runWorktreePath } from '@neutronai/trident/merge.ts'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createProjectRunners } from '@neutronai/runtime/workers/project-runners.ts'
import { createClaudeActingTurn } from '@neutronai/runtime/workers/claude-acting-turn.ts'
import { createCodexHeadlessRunner } from '@neutronai/runtime/workers/codex-headless.ts'
import { pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { Provider } from '@neutronai/runtime/provider.ts'
import type { ProviderSelectionSource } from '@neutronai/runtime/adapters/select-substrate.ts'
import type { ProjectBuildHostOptions } from '@neutronai/trident/project-build-host.ts'
import type { InnerLoopInput } from '@neutronai/trident/inner-loop.ts'
import { briefIntegrity } from '@neutronai/trident/gates/brief-integrity.ts'
import { validateTrailer, PLAN_SCHEMA, FORGE_SCHEMA, VERDICT_SCHEMA } from '@neutronai/trident/gates/result-contract.ts'
import { phaseByKey, parsePhaseModelConfig } from '@neutronai/trident/phase-models.ts'
import { modelTier } from '@neutronai/trident/model-tiers.ts'
import { readProjectRepos } from '@neutronai/trident/project-repos.ts'
import { buildReflectionGuidance } from '@neutronai/trident/reflection-guidance.ts'
import { PROJECT_BUILD_WALL_MS } from '@neutronai/trident/project-build-budget.ts'

/**
 * WALL BUDGET PER ROLE. This was ONE flat 45 minutes for all four roles, which is
 * the wrong shape: the roles do not cost remotely the same thing.
 *
 * Measured on the fourth acceptance run (5a69ae54) against this repo:
 *   - `plan` finished in 4m28s. It reads and writes a plan; it runs no suite.
 *   - `build` was still inside its FIRST suite run at 32 minutes and had not yet
 *     started the second. That builder ran the suite twice — a baseline before its
 *     change and a verification after — so 45 minutes could not fit even one honest
 *     build, and the wall, not the work, decided the outcome.
 *
 * The two-run shape was never DESIGNED; it was what a builder did when the TEST
 * EXECUTION block stated no run budget. #1044 states one (`BASELINE_FULL_SUITE_RUNS`,
 * `trident/test-strategy.ts`): zero full-suite runs before the change, and the
 * pre-existing/new distinction taken from re-running only the files that came back
 * red. These walls are NOT re-cut on that: one suite run on this repo was measured at
 * over 32 minutes and a builder still has to edit, fail, fix and re-run inside its
 * wall — 90 minutes is now headroom for one honest build instead of a bare fit for
 * two, which is the direction a stop should err in.
 *
 * `review` is read-only with no write and no network, so it stays close to plan.
 * `fix` is a builder and gets the builder's budget.
 *
 * A budget is a stop, not a target: raising the builder's does not invite a slower
 * build, it stops a correct build being killed mid-suite and reported as a failure
 * of the work. It is deliberately not unbounded — a wedged builder must still die.
 */

// Cold session acquisition has its own deadline, independent of the worker wall.
// Match the conversational prewarm allowance; a stuck prewarm cannot clear this timer.
export const PROJECT_SESSION_ACQUIRE_TIMEOUT_MS = 35_000

export interface ProjectBuildContext {
  store: ProjectBuildHostOptions['production']['store']
  phaseUsage: ProjectBuildHostOptions['phaseUsage']
  runHost: ProjectBuildHostOptions['production']['runHost']
  /** Test seam for suite execution. Production uses plain spawnCapture, without
   * the GitHub environment loaded by the publication runner. */
  runSuite?: ProjectBuildHostOptions['production']['runHost']
  stateRoot: string
  projectDir: string
  projectId: string
  provider: Provider
  providerSource: ProviderSelectionSource
  env: NodeJS.ProcessEnv
  spawnProjectSession: (projectId: string) => Promise<void>
}

/**
 * WATCHDOG FOR THE HOST'S OWN SUITE RUN.
 *
 * `runHost` defaults to `DEFAULT_HOST_COMMAND_TIMEOUT_MS` — 60 seconds
 * (`trident/git-mode.ts:1166`), which is right for the git and gh calls it was
 * written for and far too short for a test suite. The call below passed no budget,
 * so the host's suite run was killed at 60s, `observed.timed_out` was always true,
 * the exit receipt was always omitted, and G063 answered `unknown` for every card.
 * `unknown` is fail-closed, so NO dispatched card could reach `merged`.
 *
 * Measured on this repo: one directory of the persistent adapter suite alone takes
 * 81 seconds, and acceptance run 5a69ae54's full `scripts/run-tests.sh` was still
 * going at 11 minutes. 60 seconds could never have produced a receipt here.
 *
 * Bounded, not unbounded: a suite that overruns this still yields no receipt and
 * still degrades to `unknown`, which is the honest answer and authorises nothing.
 * The cost of this call sitting on the gateway event loop is tracked separately in
 * the review-suite-placement issue; this constant only stops the gate from being
 * unanswerable by construction.
 */
export const REVIEW_SUITE_TIMEOUT_MS = 45 * 60_000

/**
 * THE SUITE TRANSCRIPT MUST NOT TRAVEL THROUGH THE GATEWAY'S HEAP.
 *
 * The other half of #1042. The placement worry was stated as "the suite runs on
 * the gateway event loop", and the WAIT is not what occupies it — measured on this
 * box, a 5s child under `spawnCapture` let a 100ms timer fire 49 times in 5017ms,
 * because `Bun.spawn` + `await proc.exited` is ordinary non-blocking I/O.
 *
 * What occupies the loop is the CAPTURE. `spawnCapture` pipes the child and reads
 * both streams into JS strings (`trident/git-mode.ts:1215-1218`) with no cap, and
 * `readCheckpoint` below reads NOTHING from them — only `exit_code` and
 * `timed_out`. Measured with the same helper: 256 MiB of child stdout cost one
 * 523ms event-loop stall (longest gap between 100ms ticks; 6 ticks in 1025ms) and
 * took the process from 37 MB to 832 MB RSS. Both scale with transcript size and
 * neither is bounded.
 *
 * And this suite is the one command on that seam whose transcript is unbounded:
 * `scripts/run-tests.sh` `cat`s every chunk and every isolation lane's log to its
 * own stdout (`scripts/run-tests.sh:628` serial, the `JOBS -gt 1` emit block, and
 * `run_pglite_lane`/`run_device_lane`/`run_http_lane`), and it is largest in
 * exactly the case this gate exists for — a red suite, with every failure's output
 * and stack attached.
 *
 * So the child's own stdout and stderr go to a file in the run's state directory
 * and the gateway keeps O(1) of them. The receipt G063 classifies — the exit code
 * — is unchanged, and the transcript is still on disk for a human.
 *
 * `: >LOG` FIRST, AND A MARKER, BECAUSE A REDIRECT THAT CANNOT OPEN IS `unknown`.
 * A bare `{ … } >LOG` whose redirect fails exits 1 with no output, which reaches
 * `assessReviewSuite` as a red suite (`trident/gates/review-suite.ts:50`, "FULL
 * SUITE NOT PROVEN") — a "the answer is no" manufactured out of "could not find
 * out". The probe is a simple command, so a failure leaves the shell alive to
 * print the marker and exit 97, and the caller omits `hostExitCode` for it, which
 * is the same honest `unknown` a timeout gets.
 */
const SUITE_LOG_UNAVAILABLE = 'NEUTRON_SUITE_LOG_UNAVAILABLE'

const singleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export function suiteScript(command: string, logPath: string): string {
  const quoted = singleQuote(logPath)
  return [
    `: >${quoted} || { printf '%s\\n' ${SUITE_LOG_UNAVAILABLE}; exit 97; }`,
    '{',
    command,
    `} >>${quoted} 2>&1`,
  ].join('\n')
}

function fullSuiteCommand(strategy: string | null | undefined): string | null {
  if (!strategy) return null
  const lines = strategy.split('\n')
  const marker = lines.findIndex(line => line.startsWith('Full suite (stage 2), run exactly this'))
  if (marker < 0) return null
  // THE MARKER SENTENCE CAN WRAP, AND PROSE FOLLOWS IT BEFORE THE COMMANDS.
  //
  // This used to `break` on the first line that was not indented, which assumed the
  // marker line was the whole sentence. It is not: when the project has a jobs knob,
  // `trident/test-strategy.ts:789-796` emits
  //
  //     Full suite (stage 2), run exactly this — the export lines FIRST, on their own lines, so a
  //     compound test command inherits them:
  //
  //       export <JOBS_ENV>=<n>
  //       <command>
  //
  // so the line straight after the marker is unindented prose. The scan broke on it
  // immediately, returned null, and `readCheckpoint` then reported `report: null`,
  // which G063 answers as `unknown`. `unknown` is fail-closed, so on any project
  // WITH a jobs knob — this repo included — no card could reach `merged`.
  //
  // Measured against the two real shapes: the knob form parsed to `null`, the plain
  // form to `bun test`.
  //
  // So prose BEFORE the block is skipped, and only once collection has started does
  // an unindented line end it — the command block is still the first indented run,
  // never a later one. The scan also stops at a following section heading, so a
  // marker with no block of its own cannot reach down and adopt the next section's.
  const commands: string[] = []
  for (const line of lines.slice(marker + 1)) {
    const indented = line.startsWith('  ')
    if (commands.length === 0) {
      if (indented) commands.push(line.slice(2))
      else if (/^(?:STAGE\b|Stage\b|Full suite\b)/.test(line)) break
      continue
    }
    if (!indented) break
    commands.push(line.slice(2))
  }
  return commands.length > 0 ? commands.join('\n') : null
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
      if (context.provider !== 'anthropic') return { kind: 'refused', reason: 'capability-unsupported', detail: `No live acting-turn binding for ${context.provider} selected at ${context.providerSource} level` }
      let candidates = [...supervisedBySessionKey].filter(([, options]) =>
        options.project_id === context.projectId && options.substrate_instance_id.startsWith('cc-agent-'))
      if (candidates.length > 1) return { kind: 'unknown', detail: 'Project conversation session is missing or ambiguous' }
      if (candidates.length === 1) {
        const [, options] = candidates[0]!
        if (options.skip_permissions !== true || options.restricted || options.permissions) return { kind: 'refused', reason: 'capability-unsupported', detail: 'Project launch grants cannot authorize bounded build work' }
      }
      const candidatePending = candidates.length === 1 ? pool.get(candidates[0]![0]) : undefined
      const candidateSession = candidatePending !== undefined && Bun.peek.status(candidatePending) === 'fulfilled'
        ? await candidatePending
        : undefined
      if (candidateSession === undefined || candidateSession.hasChildExited()) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const expired = new Promise<true>(resolve => {
            timer = setTimeout(() => resolve(true), PROJECT_SESSION_ACQUIRE_TIMEOUT_MS)
          })
          const timedOut = await Promise.race([
            context.spawnProjectSession(context.projectId).then(() => false), expired,
          ])
          if (timedOut) return { kind: 'unknown', detail: 'Project conversation session acquisition timed out' }
        }
        catch { return { kind: 'unknown', detail: 'Project conversation session could not be started' } }
        finally { clearTimeout(timer) }
        candidates = [...supervisedBySessionKey].filter(([, options]) =>
          options.project_id === context.projectId && options.substrate_instance_id.startsWith('cc-agent-'))
      }
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
    // Owner guidance and test execution instructions belong only to the builders.
    const isBuilder = role === 'build' || role === 'fix'
    const brief = [run.task, isBuilder ? input.test_strategy ?? '' : '',
      // THE BRIEF MUST STATE THE ENVELOPE, AND THE WORKER MUST COPY ITS IDS.
      // `decodeProjectTrailer` (`runtime/workers/project-runners.ts:44-58`) reads
      // `{ schema, run_id, step_id, kind, result }` and refuses unless `run_id`,
      // `step_id` and `schema` each match the request EXACTLY.
      //
      // The brief used to ask only for "a result object with head, diff, pr and
      // payload". A worker that obeyed it precisely wrote the INNER object, and the
      // host rejected it: "Trailer run_id missing or mismatched." Observed on the
      // third acceptance dispatch — the plan worker did exactly what it was told.
      //
      // The ids CANNOT be baked in here. `step_id` is computed per role AND round
      // (`trident/build-run.ts:278`), while this brief is written once at prepare
      // time, before any round exists. They are, however, already in the per-dispatch
      // host context (`request.run_id`, `request.step_id`, `request.result.schema`),
      // so the brief points the worker at the copy that is correct for ITS dispatch.
      `Perform the ${role} role.`,
      'Write your result file as a JSON object with EXACTLY these five fields:',
      '  "schema", "run_id", "step_id"  — copy each verbatim from the host context: `request.result.schema`, `request.run_id`, `request.step_id`. Do not invent or reformat them.',
      '  "kind"   — "completed" when you finished the role, or "blocked" when you could not.',
      '  "result" — when completed: { head, diff, pr, payload }. Omit when blocked.',
      'When blocked, add "on": a non-empty sentence saying what stopped you. Report blocked rather than inventing a result; a fabricated result is worse than a stopped run.',
      `\`result.payload\` must satisfy the ${role === 'plan' ? 'plan' : role === 'review' ? 'verdict' : 'forge'} trailer contract below. Read the host context for the measured snapshot.`,
      JSON.stringify(role === 'plan' ? PLAN_SCHEMA : role === 'review' ? VERDICT_SCHEMA : FORGE_SCHEMA),
      'Never publish or merge; the host owns those actions.',
    ].join('\n\n') + (isBuilder ? buildReflectionGuidance(input.reflection_context) : '')
    const path = join(state, `${role}.brief`)
    await writeFile(path, brief, { mode: 0o600 })
    workers[role] = { provider, request: {
      model_id: descriptor.model_id, effort: selected?.effort ?? phase.default.effort,
      cwd: run.worktree, writable: role !== 'review', network: role !== 'review',
      tools: role === 'review' ? 'read-only' : 'edit-and-run',
      brief: { path, integrity: briefIntegrity(brief) },
      result: { schema: role === 'plan' ? 'project-plan' : role === 'review' ? 'project-review' : 'project-build', path: join(state, `${role}.result`) },
      thread: null, budget: { wall_ms: PROJECT_BUILD_WALL_MS[role] },
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
      reviewSuite: { strategy: input.test_strategy ?? '', scope: 'full-suite',
        // G063 REQUIRES A BUILD/FIX CHECKPOINT FOR THIS REVISION. Stubbed to `null`,
        // the source returns `unknown` (`project-observation-sources.ts:76`) for EVERY
        // card and any strategy — measured — and `applyReviewSuite` propagates it, so
        // the review decision is `unknown` and no dispatched card can reach `merged`.
        //
        // The checkpoint establishes which revision finished; its suite verdict remains
        // untrusted. The host therefore runs the configured suite in that worktree and
        // records the process exit code it observed. A timeout has no usable verdict.
        //
        // THE IDENTITY IS THE HOST'S. The original carried the claim in a round-labelled
        // checkpoint (`forge-done` / `fix-round-N`); here each role overwrites one result
        // file, so the revision identity is the head. A file whose own `result.head` is
        // not the head the host just measured is a claim about a DIFFERENT revision and
        // answers nothing — `fix` is read first because it is the fresher of the two.
        readCheckpoint: async (snapshot, round) => {
          for (const role of ['fix', 'build'] as const) {
            let value: { result?: { head?: unknown; payload?: unknown } }
            try { value = JSON.parse(await readFile(workers[role].request.result.path, 'utf8')) }
            catch { continue }
            if (value?.result?.head !== snapshot.head) continue
            const checked = validateTrailer('forge', value.result.payload)
            if (!checked.ok) continue
            const claim = checked.value
            const command = fullSuiteCommand(input.test_strategy)
            if (!command) return { runId: run.id, head: snapshot.head, round, report: null }
            const logPath = join(state, `suite-round-${round}.log`)
            const observed = await (context.runSuite ?? spawnCapture)(['bash', '-lc', suiteScript(command, logPath)], run.worktree, undefined, REVIEW_SUITE_TIMEOUT_MS)
            // A shell that could not open the transcript never ran the suite; its
            // exit code is about the redirect, not about the tests. `unknown`, not red.
            const unopenable = observed.stdout.trimStart().startsWith(SUITE_LOG_UNAVAILABLE)
            return { runId: run.id, head: snapshot.head, round, report: {
              ...(observed.timed_out || unopenable ? {} : { hostExitCode: observed.exit_code }),
              ...(claim.suiteOutcome === undefined ? {} : { suiteOutcome: claim.suiteOutcome }),
              ...(claim.suiteEvidence === undefined ? {} : { suiteEvidence: claim.suiteEvidence }),
            } }
          }
          return null
        } },
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
