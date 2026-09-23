import { resolveTranscriptProjectsDir } from '@neutronai/runtime/adapters/claude-code/persistent/signatures.ts'
import { spawnCapture, type HostCommandResult } from '@neutronai/trident/git-mode.ts'
import { runWorktreePath } from '@neutronai/trident/merge.ts'
import { mkdir, readFile, writeFile, lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createProjectRunners, type ProjectTrailerDecoder, type ProjectActingTurn } from '@neutronai/runtime/workers/project-runners.ts'
import { createClaudeActingTurn } from '@neutronai/runtime/workers/claude-acting-turn.ts'
import { observeClaudeChildUsage } from '@neutronai/runtime/workers/claude-child-observation.ts'
import { sessionJsonlPath } from '@neutronai/runtime/adapters/claude-code/persistent/jsonl-resumability.ts'
import { createCodexHeadlessRunner } from '@neutronai/runtime/workers/codex-headless.ts'
import { createClaudeHeadlessRunner } from '@neutronai/runtime/workers/claude-headless.ts'
import { reconcileStoppedTrailerReservations } from '@neutronai/runtime/workers/trailer-slot.ts'
import { PROJECT_REPL_TOOL_DEFS } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import type { CodexOwnerBindings } from './codex-owner-binding.ts'
import { codexBuildResultTransport } from './codex-build-result.ts'
import { pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
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
import { prepareProjectDependencies, projectSuiteIdentity } from './project-build-dependencies.ts'
import { parseBuildModeState, readBuildRetrySource } from '@neutronai/trident/build-mode-state.ts'
import { assertProjectSnapshot, PROJECT_SNAPSHOT_SCHEMA } from './project-build-snapshot.ts'
import { AttemptAccounting } from '@neutronai/trident/attempt-accounting.ts'
import { createProjectWorkerContinuity } from '@neutronai/trident/project-worker-continuity.ts'

/** Match the selected adapters' credential source without storing its contents.
 * Rotation is conservatively a different owner until account identity is attested. */
async function workerCredentialIdentity(provider: Provider, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (provider === 'anthropic') {
    const token = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .find(name => typeof env[name] === 'string' && env[name]!.trim() !== '')
    if (token) return createHash('sha256').update(JSON.stringify([token, env[token]])).digest('hex')
  }
  const directory = provider === 'openai-codex' ? env.CODEX_HOME
    : provider === 'anthropic' ? env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, '.claude') : undefined) : undefined
  if (!directory) return null
  try {
    const file = await open(join(directory, provider === 'openai-codex' ? 'auth.json' : '.credentials.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size === 0 || stat.size > 65_536) return null
      const bytes = Buffer.alloc(65_537)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead === 0 || bytesRead > 65_536) return null
      return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex')
    } finally { await file.close() }
  } catch { return null }
}

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

/**
 * The live `cc-agent-*` supervised sessions scoped to one project id.
 *
 * ONE reader, called twice by the acting turn — before the spawn and after it —
 * because the second call is the ONLY evidence a spawn produced anything (see the
 * comment at its second call site). Extracted so the two reads cannot drift: they
 * are the same question asked at two times, and a filter that differed between them
 * would make "it appeared" and "I looked differently" indistinguishable.
 */
function liveProjectSessions(projectId: string): Array<[string, PersistentReplSubstrateOptions]> {
  return [...supervisedBySessionKey].filter(([, options]) =>
    options.project_id === projectId && options.substrate_instance_id.startsWith('cc-agent-'))
}

export interface ProjectBuildContext {
  store: ProjectBuildHostOptions['production']['store']
  attempts: ProjectBuildHostOptions['attempts']
  runHost: ProjectBuildHostOptions['production']['runHost']
  /** Test seam for suite execution. Production uses plain spawnCapture, without
   * the GitHub environment loaded by the publication runner. */
  runSuite?: ProjectBuildHostOptions['production']['runHost']
  /** Test seam for dependency setup; production does not use publisher credentials. */
  runInstall?: typeof spawnCapture
  stateRoot: string
  projectDir: string
  projectId: string
  provider: Provider
  providerSource: ProviderSelectionSource
  env: NodeJS.ProcessEnv
  spawnProjectSession: (projectId: string) => Promise<void>
  /** The same host-owned resolver consumed by owner chat. Never creates a build session. */
  codexOwnerBindings?: Pick<CodexOwnerBindings, 'actingTurn' | 'guardBuildRunner'> & Partial<Pick<CodexOwnerBindings, 'prepareReview'>>
}

/**
 * THE PLAN BRIEF MUST STATE THE LEDGER THE HOST ENFORCES AND COMMITS.
 *
 * The typed driver reads a plan's `implementationPlan` as a checkbox ledger: G025
 * refuses a Ralph handoff plan whose unchecked lines disagree with `topTask` and
 * `remainingTasks`, the handoff commits the ledger with the top box ticked at the
 * branch's own `.trident/ledgers/<branch>.md`, and G026-G029 select the cheap
 * continuation planner only when that committed file has an unchecked task
 * (`trident/build-run.ts`, `taskLedgerPath` in `trident/production-host-effects.ts`).
 * None of that was in the brief, so a planner that returned headings and no boxes
 * was doing exactly what it had been told — and every continuation re-planned from
 * scratch (spec item a-retry-must-resume-from-the-checkpoint, acceptance 2).
 *
 * The brief is written once at prepare time, before any iteration exists, so the
 * `planner: "next"` duty is stated unconditionally and keyed on the host context
 * field each dispatch carries.
 */
export const PLAN_LEDGER_CONTRACT = [
  'THE TASK LEDGER. `implementationPlan` is a checkbox list with one line per task: `- [x] T<n>: <one line>` for a task already built on this branch, and `- [ ] T<n>: <one line>` for each task still to build, the next task first among the unchecked lines.',
  '`topTask` is the first unchecked line, copied verbatim. `remainingTasks` is the number of unchecked lines minus one. When tasks remain, the host refuses a plan whose lines disagree with those two fields.',
  'After a build that leaves tasks remaining, the host ticks the top task and commits the ledger itself, at a per-branch path under `.trident/ledgers/`, on a PUBLIC branch whose files and commit messages are leak-scanned: no hostnames, usernames or absolute paths in any line. Do not write or edit that file, or a repo-root IMPLEMENTATION_PLAN.md, yourself.',
  'CONTINUATION. When the host context carries `planner: "next"` and `committedPlan`, the committed ledger IS the plan: return `committedPlan.body` unchanged as `implementationPlan`, its first unchecked line as `topTask`, and its unchecked count minus one as `remainingTasks`, and write only the `executionSpec` for that task. Do not re-survey the repository or re-plan the remaining tasks.',
].join('\n')

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

/** Diagnostic categories are not ownership evidence and never authorize cleanup.
 * Git's output may name private paths, so only fixed labels reach durable state. */
function worktreeAddDiagnostic(result: HostCommandResult | null) {
  const output = result ? `${result.stderr.slice(0, 4096)}\n${result.stdout.slice(0, 4096)}` : ''
  const reason = result === null ? 'observation-error'
    : result.timed_out ? 'timeout'
    : /already (?:checked out|used by worktree)/i.test(output) ? 'branch-held'
    : /already exists|already registered/i.test(output) ? 'path-exists'
    : /permission denied|operation not permitted/i.test(output) ? 'permission'
    : /no space left on device|disk quota exceeded/i.test(output) ? 'storage-full'
    : 'unclassified'
  const code = result?.exit_code
  return { operation: 'git-worktree-add', reason,
    exit_code: Number.isInteger(code) && code! >= 0 && code! <= 255 ? code! : null,
    timed_out: result === null ? null : result.timed_out === true }
}

/** Bind one dispatched project, using the host's retained session launch options. */
export async function prepareProjectBuild(input: InnerLoopInput, context: ProjectBuildContext, signal: AbortSignal): Promise<ProjectBuildHostOptions> {
  const run = { ...input.run, branch: input.run.branch ?? `trident/${input.run.slug}`,
    worktree: input.run.worktree ?? runWorktreePath(input.run.repo_path, input.run) }
  if (!run.base_sha) throw Error('Dispatched build has no pinned base')
  const git = async (args: string[]) => context.runHost(['git', '-C', run.repo_path, ...args], run.repo_path)
  await context.store.invalidateRetrySource(run)
  const saved = await context.store.update(run.id, { branch: run.branch, worktree: run.worktree, base_sha: run.base_sha })
  if (!saved) throw Error('Dispatched build row disappeared')
  let exists = false
  try { await lstat(run.worktree); exists = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!exists) {
    const branch = await git(['show-ref', '--verify', '--quiet', `refs/heads/${run.branch}`])
    if (branch.timed_out || (!branch.ok && branch.exit_code !== 1)) throw Error('Build branch existence is unknown')
    let start = run.base_sha
    if (!branch.ok) {
      const source = readBuildRetrySource(context.store, saved)
      if (source) {
        const expected = source.state.checkpoint.head!
        // PR cleanup deletes a local branch only after proving origin holds it.
        // Re-fetch that branch and pin the observed commit before restoring it;
        // a moved remote must not be silently reset to the predecessor's head.
        if (run.merge_mode === 'pr') {
          const fetched = await git(['fetch', '--no-tags', 'origin', `refs/heads/${run.branch}`])
          if (!fetched.ok || fetched.timed_out) throw Error('Retry branch could not be fetched')
          const observed = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
          if (!observed.ok || observed.timed_out || observed.stdout.trim() !== expected) throw Error('Retry branch moved after dispatch')
        }
        const object = await git(['rev-parse', '--verify', `${expected}^{commit}`])
        if (!object.ok || object.timed_out || object.stdout.trim() !== expected) throw Error('Retry commit is unavailable')
        start = expected
      }
    }
    let added: HostCommandResult | null = null
    try {
      added = await git(branch.ok
        ? ['worktree', 'add', '--', run.worktree, run.branch]
        : ['worktree', 'add', '-b', run.branch, '--', run.worktree, start])
    } catch { /* A thrown observation carries no safe command evidence. */ }
    if (!added?.ok || added.timed_out) {
      const diagnostic = worktreeAddDiagnostic(added)
      let recorded = true
      try { await context.store.recordStageEvent(run.id, 'build-worktree-add-failed', JSON.stringify(diagnostic)) }
      catch { recorded = false }
      throw Error(`Build worktree creation was not confirmed (reason=${diagnostic.reason}; exit=${diagnostic.exit_code ?? 'unknown'}; timed_out=${diagnostic.timed_out ?? 'unknown'}; diagnostic_recorded=${recorded})`)
    }
  }
  const checked = await context.runHost(['git', '-C', run.worktree, 'symbolic-ref', '--quiet', 'HEAD'], run.worktree)
  if (!checked.ok || checked.timed_out || checked.stdout.trim() !== `refs/heads/${run.branch}`) throw Error('Build worktree does not hold the assigned branch')
  const state = join(context.stateRoot, encodeURIComponent(run.id))
  await mkdir(state, { recursive: true })
  // Launcher admission must precede preparation. Same-run gateway recovery requires
  // a durable checkpoint (orchestrator.ts); a pending unknown cannot reach this cleanup.
  // Armed files remain durable evidence that work may have been submitted.
  const reconciled = await reconcileStoppedTrailerReservations(state)
  if (!reconciled.ok) throw new Error(reconciled.detail)
  const accounting = new AttemptAccounting(context.attempts, state,
    (stage, meta) => context.store.recordStageEvent(run.id, stage, meta))
  await accounting.interval('dependency-preparation', { run_id: run.id },
    () => prepareProjectDependencies(run.worktree, state, context.runInstall))
  const topic = run.chat_id ?? context.projectId
  const observerPath = (step: string) => join(state, `claude-observer-${createHash('sha256').update(step).digest('hex')}.json`)
  const codexEnv = { ...context.env, ...(input.codex_home ? { CODEX_HOME: input.codex_home } : {}) }
  const trailer: ProjectTrailerDecoder = { schemas: new Map([
    ['project-plan', (value: unknown) => validSnapshot(value, 'plan')],
    ['project-build', (value: unknown) => validSnapshot(value, 'forge')],
    ['project-review', (value: unknown) => validSnapshot(value, 'verdict')],
    ['verdict', (value: unknown) => validateTrailer('verdict', value).ok],
  ]), metadata: () => undefined }
  const parsed = parsePhaseModelConfig(input.phase_models ?? {})
  if (parsed.errors.length) throw Error(`Invalid project phase models: ${parsed.errors.join('; ')}`)
  const config = parsed.config
  if (context.provider === 'openai-codex' && ['review_rubric', 'review_adversarial', 'review_codex', 'review_kimi', 'synthesis'].some(key => {
    const phase = phaseByKey(key)
    return phase && modelTier(config[phase.key]?.model ?? phase.default.tier)?.group === 'codex'
  })) {
    if (!context.codexOwnerBindings?.prepareReview) throw new Error('Codex owner lacks attested read-only child execution with isolated result output')
    await context.codexOwnerBindings.prepareReview(context.projectId)
  }
  const substrate = await createProjectRunners({
    conversation: { project_id: context.projectId, topic_id: topic, provider: context.provider,
      // THE SURFACE MUST MATCH THE SESSION'S, OR THE REUSE GUARD RESPAWNS IT.
      // `spec.tools` IS the `--tools` surface: `spawn.ts:302` derives it as
      // `spec.tools.map(t => t.name)`, and the reuse guard at `spawn.ts:1550`
      // respawns when it differs from the live session's. `tools: []` therefore
      // became `--tools ""` — "disables every built-in" (`build-repl-argv.ts:150-152`)
      // — so the dispatch asked a tool-less respawn to invoke a subagent. `Agent`
      // AND `Bash` both reported "disabled for this session" on exactly those
      // turns, while wake turns on the SAME session id ran Bash fine. Three
      // card-dispatched runs died this way and surfaced only as a timeout (#1112).
      spec: { tools: PROJECT_REPL_TOOL_DEFS, model_preference: [], metering_context: { project_id: context.projectId } } },
    run_id: run.id, state_dir: state,
    actingTurn: Object.assign(async (turn: Parameters<ProjectActingTurn>[0]): ReturnType<ProjectActingTurn> => {
      if (context.provider === 'openai-codex') {
        if (!context.codexOwnerBindings) return { kind: 'refused', reason: 'capability-unsupported', detail: 'Shared Codex owner binding is unavailable' }
        return context.codexOwnerBindings.actingTurn(context.projectId, topic, context.projectDir, [run.worktree])(turn)
      }
      if (context.provider !== 'anthropic') return { kind: 'refused', reason: 'capability-unsupported', detail: `No live acting-turn binding for ${context.provider} selected at ${context.providerSource} level` }
      let candidates = liveProjectSessions(context.projectId)
      // MISSING AND AMBIGUOUS ARE NOT ONE FACT (#1085). Both ended here as the
      // single string "Project conversation session is missing or ambiguous", and
      // that string is the ONLY thing an operator gets: it travels out through
      // `runtime/workers/project-runners.ts:145` as the run's uncertainty detail.
      // The two call for opposite acts — none means "start one", several means
      // "something is spawning twice under one project id" — and a reader could not
      // tell which had happened, on the very path that goes dark when an instance
      // loses its project REPL. Zero is not handled here at all: it is the case the
      // spawn below EXISTS for, and returning on it would disable the recovery.
      if (candidates.length > 1) return { kind: 'unknown', detail: `Project conversation session is AMBIGUOUS: ${candidates.length} live cc-agent sessions carry project id "${context.projectId}"` }
      if (candidates.length === 1) {
        const [, options] = candidates[0]!
        if (options.skip_permissions !== true || options.restricted || options.permissions) return { kind: 'refused', reason: 'capability-unsupported', detail: 'Project launch grants cannot authorize bounded build work' }
      }
      const candidatePending = candidates.length === 1 ? pool.get(candidates[0]![0]) : undefined
      const candidateSession = candidatePending !== undefined && Bun.peek.status(candidatePending) === 'fulfilled'
        ? await candidatePending
        : undefined
      if (candidateSession === undefined || candidateSession.hasChildExited()) {
        // WHY WE ARE SPAWNING, captured BEFORE the attempt, so the refusal below can
        // say whether the instance had no project REPL at all or had one whose child
        // had gone. #1085 is the first shape ("nothing respawned it"); they are not
        // interchangeable and the old wording covered both with neither.
        const had = candidates.length === 0 ? 'none existed' : 'the one that existed had a dead child'
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const expired = new Promise<true>(resolve => {
            timer = setTimeout(() => resolve(true), PROJECT_SESSION_ACQUIRE_TIMEOUT_MS)
          })
          const timedOut = await Promise.race([
            context.spawnProjectSession(context.projectId).then(() => false), expired,
          ])
          if (timedOut) return { kind: 'unknown', detail: `Project conversation session acquisition timed out after ${PROJECT_SESSION_ACQUIRE_TIMEOUT_MS}ms (${had})` }
        }
        catch (error) { return { kind: 'unknown', detail: `Project conversation session could not be started (${had}): ${error instanceof Error ? error.message : String(error)}` } }
        finally { clearTimeout(timer) }
        // THE RE-READ IS THE ONLY EVIDENCE THE SPAWN WORKED, and that is not a
        // belt-and-braces re-check — it is the sole one. `spawnProjectSession`
        // (`open/composer.ts`) awaits `prewarmSubstrate`, which swallows every error
        // and NEVER rejects (`open/composer.ts` `prewarmSubstrate`: the catch emits a
        // journal row and the promise still resolves). So the call resolving says
        // nothing whatsoever about whether a REPL now exists; only the registry does.
        // Any design that "prewarms a session and reports success" through this seam
        // reports a success it has not observed.
        candidates = liveProjectSessions(context.projectId)
        if (candidates.length === 0) return { kind: 'unknown', detail: `Project conversation session was NOT created: the spawn for project id "${context.projectId}" returned without error (${had}) and no live cc-agent session exists for it` }
      }
      if (candidates.length !== 1) return { kind: 'unknown', detail: `Project conversation session is AMBIGUOUS after a spawn: ${candidates.length} live cc-agent sessions carry project id "${context.projectId}"` }
      const [key, options] = candidates[0]!
      const pending = pool.get(key)
      if (!pending || Bun.peek.status(pending) !== 'fulfilled') return { kind: 'unknown', detail: 'Project conversation is not ready' }
      const session = await pending
      if (!session || session.hasChildExited()) return { kind: 'unknown', detail: 'Project conversation child is unavailable' }
      // Restricted launches do not attest the edit/run grants required by this bridge.
      if (options.skip_permissions !== true || options.restricted || options.permissions) return { kind: 'refused', reason: 'capability-unsupported', detail: 'Project launch grants cannot authorize bounded build work' }
      const transcript = sessionJsonlPath(session.sessionId, session.cwd, resolveTranscriptProjectsDir(options))
      const observer = JSON.stringify({ request: turn.request, session: session.sessionId,
        directory: join(transcript.slice(0, -'.jsonl'.length), 'subagents') })
      try { await writeFile(observerPath(turn.request.step_id), observer, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(observerPath(turn.request.step_id), 'utf8') !== observer) {
          // Observer binding cannot reroute or block paid work; its absence stays
          // explicit unknown telemetry rather than selecting a different session.
          await accounting.recordEvent('attempt-observer-binding-unavailable', { run_id: run.id, step_id: turn.request.step_id })
        }
      }
      return createClaudeActingTurn({ project_id: context.projectId, topic_id: topic, session, projects_dir: resolveTranscriptProjectsDir(options),
        grants: { tools: 'edit-and-run', writable: true, network: true, roots: options.extra_dirs ?? [] } })(turn)
    }, { observeUsage: async (request: Parameters<NonNullable<ProjectActingTurn['observeUsage']>>[0]) => {
      if (context.provider !== 'anthropic' || request.run_id !== run.id) return undefined
      try {
        const path = observerPath(request.step_id)
        if (!(await lstat(path)).isFile()) return undefined
        const saved = JSON.parse(await readFile(path, 'utf8'))
        if (JSON.stringify(saved.request) !== JSON.stringify(request) || typeof saved.session !== 'string' || !saved.session
          || typeof saved.directory !== 'string' || !saved.directory) return undefined
        return observeClaudeChildUsage(saved.directory, saved.session, request)
      } catch { return undefined }
    } }),
    trailer,
    ...(context.provider === 'openai-codex' ? { codexResultTransport: codexBuildResultTransport({
      projectId: context.projectId, projectDir: context.projectDir, stateDir: state, runId: run.id, trailer,
    }) } : {}),
    headless: { anthropic: createClaudeHeadlessRunner({ env: context.env, cwd: run.worktree,
      state_dir: state, schemas: trailer.schemas }),
      'openai-codex': createCodexHeadlessRunner({ env: codexEnv, reviewBriefIntegrity: briefIntegrity, reviewContracts: new Map([
      ['verdict', { jsonSchema: VERDICT_SCHEMA, validate: (value: unknown) => validateTrailer('verdict', value).ok }],
      ['project-review', { jsonSchema: { ...PROJECT_SNAPSHOT_SCHEMA,
        properties: { ...PROJECT_SNAPSHOT_SCHEMA.properties, payload: VERDICT_SCHEMA },
      }, validate: (value: unknown) => validSnapshot(value, 'verdict') }],
    ]) }) },
  })
  if (context.provider === 'openai-codex' && context.codexOwnerBindings && substrate.inRepl) {
    substrate.inRepl = context.codexOwnerBindings.guardBuildRunner(context.projectId, substrate.inRepl)
  }
  for (const provider of ['anthropic', 'openai-codex'] as const) {
    const runner = substrate.headless[provider]
    if (!runner || provider === context.provider) continue
    const env = provider === 'openai-codex' ? codexEnv : context.env
    substrate.headless[provider] = createProjectWorkerContinuity({ stateDir: state, runId: run.id,
      projectId: context.projectId, replProvider: context.provider, runner,
      claimInitial: (request, scope) => {
        if (request.role !== 'plan' && request.role !== 'build' && request.role !== 'fix') return Promise.resolve(false)
        return context.store.claimWorkerConversation(run.id, request.role, scope, request.step_id)
      },
      credentialIdentity: () => workerCredentialIdentity(provider, env) })
  }
  const workers = {} as ProjectBuildHostOptions['workers']
  const requestedModels = {} as ProjectBuildHostOptions['requestedModels']
  for (const role of ['plan', 'build', 'review', 'fix'] as const) {
    const phase = phaseByKey(role === 'plan' ? 'decomposition' : role === 'review' ? 'review_adversarial' : 'build')!
    const selected = config[phase.key]
    const descriptor = modelTier(selected?.model ?? phase.default.tier)
    requestedModels[role] = selected?.model ?? phase.default.tier
    if (!descriptor) throw Error(`Unknown model for ${role}`)
    const provider: Provider = descriptor.group === 'claude' ? 'anthropic' : descriptor.group === 'codex' ? 'openai-codex' : 'pi'
    // Owner guidance and test execution instructions belong only to the builders.
    const isBuilder = role === 'build' || role === 'fix'
    const brief = [run.task, isBuilder
      ? 'Follow the TEST EXECUTION instructions in the host context `testStrategy`. The host selects `suiteScope` after validating this task: `full-suite` requires the full suite; only `subset` defers it for an intermediate task. Never infer scope from the task number or an earlier task.' : '',
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
      'The completed result must satisfy this outer snapshot contract. Copy `snapshot.pr` from the host context unchanged: null or { "number": positive integer, "head": string, "state": "OPEN" | "CLOSED" | "MERGED" }. Never replace it with a number or URL. The forge payload field `result.payload.prNumber` is separately a number or null; it does not replace `result.pr`. Measure head and diff for the resulting revision; the host independently checks the claim.',
      JSON.stringify(PROJECT_SNAPSHOT_SCHEMA),
      `\`result.payload\` must satisfy the ${role === 'plan' ? 'plan' : role === 'review' ? 'verdict' : 'forge'} trailer contract below. Read the host context for the measured snapshot.`,
      JSON.stringify(role === 'plan' ? PLAN_SCHEMA : role === 'review' ? VERDICT_SCHEMA : FORGE_SCHEMA),
      ...(role === 'plan' ? [PLAN_LEDGER_CONTRACT] : []),
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
  // A retried build keeps its completed worker artifacts under the ORIGINAL
  // run's directory. Read through the dispatch-minted source chain; never move
  // receipts or relabel worker envelopes as if this run had produced them.
  const readArtifact = async (role: 'plan' | 'build' | 'fix', head?: string): Promise<string> => {
    let current = context.store.get(run.id)!
    const seen = new Set<string>()
    for (;;) {
      if (seen.has(current.id)) throw new Error('Retry artifact source cycle')
      seen.add(current.id)
      try {
        const text = await readFile(join(context.stateRoot, encodeURIComponent(current.id), `${role}.result`), 'utf8')
        if (role !== 'plan' && head !== undefined) {
          const envelope = JSON.parse(text)
          if (envelope?.result?.head !== head) throw new Error('Completed artifact does not match this revision')
          const states = context.store.stageEvents(current.id).filter(event => event.stage === 'build-mode-state')
            .map(event => parseBuildModeState(event.meta, current, true).checkpoint)
          // A matching SHA alone does not turn a copied result into a completed
          // fix. Require the original run's reservation and its host-observed
          // completion, in that order, without importing any worker identity.
          const completed = states.some((state, index) => state.pending?.phase === role
            && state.pending.step_id === envelope?.step_id
            && states[index + 1]?.pending === undefined
            && states[index + 1]?.stage === (role === 'fix' ? 'fixed' : 'built')
            && states[index + 1]?.head === head)
          if (envelope?.run_id !== current.id || envelope?.kind !== 'completed'
            || envelope?.schema !== 'project-build' || !completed) {
            throw new Error('Completed artifact is missing original host-observed worker identity')
          }
        }
        return text
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const source = readBuildRetrySource(context.store, current)
      if (!source || (role !== 'plan' && head !== undefined && source.state.checkpoint.head !== head)) {
        throw new Error(`Completed ${role} artifact is missing for this revision`)
      }
      current = source.prior
    }
  }
  const publication = async (snapshot: { head: string }) => {
    const planEnvelope = JSON.parse(await readArtifact('plan', snapshot.head))
    const plan = validateTrailer('plan', planEnvelope?.result?.payload)
    if (!plan.ok) throw new Error(`Publication plan result is invalid: ${plan.reason} at ${plan.path}`)
    let forge: ReturnType<typeof validateTrailer<'forge'>> | null = null
    for (const role of ['fix', 'build'] as const) {
      try {
        const envelope = JSON.parse(await readArtifact(role, snapshot.head))
        if (envelope?.result?.head !== snapshot.head) continue
        const checked = validateTrailer('forge', envelope?.result?.payload)
        if (checked.ok) { forge = checked; break }
      } catch { continue }
    }
    if (!forge?.ok) throw new Error('Publication build result is missing or does not match the reviewed head')
    // `result.head` and `payload.commitSha` are INDEPENDENT worker-reported values —
    // `trident/gates/result-contract.ts:33` types commitSha as a bare string with no
    // equality rule — so matching one does not vouch for the other. Publishing the
    // payload's sha unchecked would state a commit the host never reviewed.
    if (forge.value.commitSha !== snapshot.head) {
      throw new Error('Publication build result reports a commit that is not the reviewed head')
    }
    // `topTask` is THIS round's selected work item (`trident/inner-workflow.mjs:2018`).
    // `branchBrief` is deliberately a digest of what the branch ALREADY carried before
    // this round (`:2022`, "BUILT: what the previous tasks built"), so titling from it
    // describes prior state, not the change being published.
    const summary = plan.value.topTask.trim()
    const title = summary.split(/\r?\n/).find(line => line.trim() !== '')
      ?.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|\[[ xX]\]\s*)+/, '').trim().slice(0, 100)
    if (!title) throw new Error('Publication change title is missing')
    const claim = forge.value.mutationClaim
    const mutation = claim === null ? 'No mutation evidence was reported.'
      : `Guard: \`${claim.guard.join(' ')}\`\n\nControl: \`${claim.control.join(' ')}\``
    const tests = forge.value.suiteEvidence?.trim()
      || (forge.value.testsPassed ? 'The worker reported its required test suite passed.' : `Worker suite outcome: ${forge.value.suiteOutcome ?? 'not reported'}.`)
    const context = plan.value.branchBrief?.trim()
    const priorState = context ? `\n\n<details>\n<summary>Branch state before this change</summary>\n\n${context}\n\n</details>` : ''
    const body = `## What changed\n\n${summary}${priorState}\n\n## Commit\n\n\`${forge.value.commitSha}\`\n\n## Test and mutation evidence\n\n${tests}\n\n${mutation}\n\n<details>\n<summary>Original card design document</summary>\n\n${run.task}\n\n</details>\n`
    await writeFile(bodyFile, body, { mode: 0o600 })
    return { title, bodyFile }
  }
  const declaration = readProjectRepos(context.projectDir, run.project_slug)
  const repo = declaration.repos.find(row => resolve(context.projectDir, row.path) === resolve(run.repo_path))
  return {
    substrate, workers, requestedModels, attempts: context.attempts,
    suiteIdentity: snapshot => projectSuiteIdentity(run.worktree, snapshot.head),
    testStrategies: { full: input.test_strategy ?? '', intermediate: input.test_strategy_intermediate ?? null },
    production: { store: context.store, runId: run.id, projectSlug: run.project_slug,
      repo: run.repo_path, worktree: run.worktree, branch: run.branch, baseBranch: input.base_branch,
      runHost: context.runHost, ciWorkflow: repo?.ciWorkflow,
      publication },
    policy: {
      leak: { scratch_dir: join(state, 'leak') },
      mutation: { readClaim: async snapshot => {
        for (const role of ['fix', 'build'] as const) {
          let value
          try { value = JSON.parse(await readArtifact(role, snapshot.head)) } catch { continue }
          const checked = validateTrailer('forge', value?.result?.payload)
          if (checked.ok && checked.value.commitSha === snapshot.head) return checked.value.mutationClaim
        }
        return null
      } },
      reviewSuite: { strategy: input.test_strategy_intermediate ?? input.test_strategy ?? '',
        scope: input.test_strategy_intermediate ? 'subset' : 'full-suite',
        // G063 REQUIRES A BUILD/FIX CHECKPOINT FOR THIS REVISION. Stubbed to `null`,
        // the source returns `unknown` (`project-observation-sources.ts:76`) for EVERY
        // card and any strategy — measured — and `applyReviewSuite` propagates it, so
        // the review decision is `unknown` and no dispatched card can reach `merged`.
        //
        // The checkpoint establishes which revision finished. An intermediate strategy
        // deliberately defers its full suite; without one, the host retains the original
        // full-suite observation in that worktree. A timeout has no usable verdict.
        //
        // THE IDENTITY IS THE HOST'S. The original carried the claim in a round-labelled
        // checkpoint (`forge-done` / `fix-round-N`); here each role overwrites one result
        // file, so the revision identity is the head. A file whose own `result.head` is
        // not the head the host just measured is a claim about a DIFFERENT revision and
        // answers nothing — `fix` is read first because it is the fresher of the two.
        readCheckpoint: async (snapshot, round) => {
          for (const role of ['fix', 'build'] as const) {
            let value: { result?: { head?: unknown; payload?: unknown } }
            try { value = JSON.parse(await readArtifact(role, snapshot.head)) }
            catch { continue }
            if (value?.result?.head !== snapshot.head) continue
            const checked = validateTrailer('forge', value.result.payload)
            if (!checked.ok) continue
            const claim = checked.value
            if (input.test_strategy_intermediate) return { runId: run.id, head: snapshot.head, round, report: {
              ...(claim.suiteOutcome === undefined ? {} : { suiteOutcome: claim.suiteOutcome }),
              ...(claim.suiteEvidence === undefined ? {} : { suiteEvidence: claim.suiteEvidence }),
            } }
            const command = fullSuiteCommand(input.test_strategy)
            if (!command) return { runId: run.id, head: snapshot.head, round, report: null }
            const logPath = join(state, `suite-round-${round}.log`)
            const observed = await (context.runSuite ?? spawnCapture)(['bash', '-lc', suiteScript(command, logPath)], run.worktree, undefined, REVIEW_SUITE_TIMEOUT_MS)
            const unopenable = observed.stdout.trimStart().startsWith(SUITE_LOG_UNAVAILABLE)
            return { runId: run.id, head: snapshot.head, round, report: {
              ...(observed.timed_out || unopenable ? {} : { hostExitCode: observed.exit_code }),
              ...(claim.suiteOutcome === undefined ? {} : { suiteOutcome: claim.suiteOutcome }),
              ...(claim.suiteEvidence === undefined ? {} : { suiteEvidence: claim.suiteEvidence }),
            } }
          }
          return null
        } },
      publicationSuite: { strategy: input.test_strategy ?? '', scope: 'full-suite',
        readCheckpoint: async (snapshot, round) => {
          const command = fullSuiteCommand(input.test_strategy)
          if (!command) return { runId: run.id, head: snapshot.head, round, report: null }
          const logPath = join(state, 'suite-publication.log')
          const observed = await (context.runSuite ?? spawnCapture)(['bash', '-lc', suiteScript(command, logPath)], run.worktree, undefined, REVIEW_SUITE_TIMEOUT_MS)
          const unopenable = observed.stdout.trimStart().startsWith(SUITE_LOG_UNAVAILABLE)
          return { runId: run.id, head: snapshot.head, round, report:
            observed.timed_out || unopenable ? {} : { hostExitCode: observed.exit_code } }
        } },
      review: { evidenceRoot: state, env: codexEnv, phaseModels: config, wallMs: 2_700_000, signal,
        runnerFor: (model, seat) => model.group === 'api' || model.group === 'kimi' ? undefined
          : seat.provider === substrate.provider ? substrate.inRepl : substrate.headless[seat.provider] },
    },
  }
}

export function validSnapshot(value: unknown, kind: 'plan' | 'forge' | 'verdict'): boolean {
  assertProjectSnapshot(value)
  return validateTrailer(kind, value.payload).ok
}
