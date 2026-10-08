import { resolveTranscriptProjectsDir } from '@neutronai/runtime/adapters/claude-code/persistent/signatures.ts'
import { spawnCapture, type HostCommandResult } from '@neutronai/trident/git-mode.ts'
import { HOST_SUITE_ENV, runHostSuite, type SuiteCommandRunner } from '@neutronai/trident/host-suite.ts'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import { runWorktreePath } from '@neutronai/trident/merge.ts'
import { mkdir, readFile, writeFile, lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { createProjectRunners, decodeProjectTrailer, type ProjectTrailerDecoder, type ProjectActingTurn } from '@neutronai/runtime/workers/project-runners.ts'
import { createClaudeActingTurn } from '@neutronai/runtime/workers/claude-acting-turn.ts'
import { CLAUDE_CONTINUATION_PROFILE, continueClaudeNativeChild, readClaudeContinuationResult, type ClaudeQuotaState } from '@neutronai/runtime/workers/claude-native-continuation.ts'
import { nativeRelayRouteFingerprint, nativeRelayScopeCurrent, type AcquireClaudeCapacity, type ControlClaudeContinuation } from '@neutronai/runtime/workers/claude-capacity-client.ts'
import { bindPlannerWork, releasePlannerWork, PLANNER_ROLE, requiresPlannerWork } from '@neutronai/runtime/workers/planner-work.ts'
import { readArmedTrailerReservation } from '@neutronai/runtime/workers/trailer-slot.ts'
import { workContextPath } from '@neutronai/trident/production-host-effects.ts'
import { isDeepStrictEqual } from 'node:util'
import { createClaudeNativeDispatchReceipt, readClaudeNativeDispatchReceipt, verifyNativeDispatchChildBound, type NativeDispatchAuthority, type SignedNativeDispatchRecord, type NativeDispatchEvidence } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { readProcessIdentity } from '@neutronai/runtime/adapters/claude-code/persistent/process-identity.ts'
import { readNativeParentLaunchEvidence } from '@neutronai/runtime/adapters/claude-code/persistent/native-parent-launch-evidence.ts'
import { admitNativeChildWorkspace, completeNativeChildWorkspace, completeNativeChildWorkspaceRequest, ownsNativeChildWorkspace, nativeChildCensusKnown, type NativeChildWorkspace } from '@neutronai/runtime/workers/native-child-workspace.ts'
import { observeClaudeChildUsage } from '@neutronai/runtime/workers/claude-child-observation.ts'
import { sessionJsonlPath } from '@neutronai/runtime/adapters/claude-code/persistent/jsonl-resumability.ts'
import { createCodexHeadlessRunner, codexHeadlessReservation } from '@neutronai/runtime/workers/codex-headless.ts'
import { createClaudeHeadlessRunner } from '@neutronai/runtime/workers/claude-headless.ts'
import { createWorkerPlacement, type WorkerPlacementHost, type WorkerPlacementScope } from '@neutronai/runtime/workers/worker-placement.ts'
import { reconcileStoppedTrailerReservations } from '@neutronai/runtime/workers/trailer-slot.ts'
import { PROJECT_REPL_TOOL_DEFS } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import type { CodexOwnerBindings } from './codex-owner-binding.ts'
import { codexBuildResultTransport } from './codex-build-result.ts'
import { pool } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { liveProjectSessions } from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import { mergeEnv, type ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import type { NativeChildAdmission } from '@neutronai/gateway/project-admission.ts'
import { createLogger } from '@neutronai/logger'
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
import { prepareProjectDependencies, projectSuiteIdentityMeasurement, type projectInstallAvailableBytes } from './project-build-dependencies.ts'
import { parseBuildModeState, readBuildRetrySource } from '@neutronai/trident/build-mode-state.ts'
import { proofFixWorkerMatches } from '@neutronai/trident/settled-proof-fix-recovery.ts'
import { pendingReviewCheckoutHead } from '@neutronai/trident/pending-review-checkout.ts'
import { normalizeLegacyStoredExecutionPlan } from '@neutronai/trident/legacy-execution-compat.ts'
import { assertProjectSnapshot, PROJECT_SNAPSHOT_SCHEMA } from './project-build-snapshot.ts'
import { AttemptAccounting } from '@neutronai/trident/attempt-accounting.ts'
import { createProjectWorkerContinuity } from '@neutronai/trident/project-worker-continuity.ts'
import { recoveredBuildArtifact } from '@neutronai/trident/recover-builder-commit.ts'
import { TRIDENT_SCRIPT_DIR } from '@neutronai/trident/script-dir.ts'
import { suiteFailure } from '@neutronai/trident/suite-failure.ts'

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

const log = createLogger('project-build')

/** A provisioned relay cannot use a parent launched before that route or its
 * continuation grants existed. This is observation only: admission still owns
 * every spawn, and an old child never gains launch authority from this check. */
function nativeParentPreparationRefusal(session: ReplSession, projectId: string, request: Parameters<ProjectActingTurn>[0]['request']): string | undefined {
  try {
    const fingerprint = nativeRelayRouteFingerprint()
    // Unregistered self-hosts retain native authentication (SPEC 2026-09-30).
    if (fingerprint === undefined) return undefined
    if (session.authFingerprint !== fingerprint) return 'Native parent authentication route is stale.'
    if (session.toolSurface !== PROJECT_REPL_TOOL_DEFS.map(tool => tool.name).join(',')) return 'Native parent tool grants are stale.'
    if (requiresPlannerWork(request) && session.plannerRole !== PLANNER_ROLE) return 'Native parent planner profile is unavailable.'
    const launch = readNativeParentLaunchEvidence(session)
    if (!launch || launch.version !== 1 || launch.projectId !== projectId || launch.sessionId !== session.sessionId
      || launch.childGeneration !== session.childGeneration || launch.executable.version !== CLAUDE_CONTINUATION_PROFILE.version
      || launch.executable.sha256 !== CLAUDE_CONTINUATION_PROFILE.sha256 || !launch.executable.realPath
      || !isDeepStrictEqual(launch.tools, session.toolSurface.split(','))) return 'Native parent continuation launch is unavailable.'
    const grants = launch.argv.flatMap((arg, index) => arg === '--tools' ? [launch.argv[index + 1]] : [])
    const sessions = launch.argv.flatMap((arg, index) => arg === '--session-id' || arg === '--resume' ? [launch.argv[index + 1]] : [])
    if (grants.length !== 1 || grants[0] !== session.toolSurface || sessions.length !== 1 || sessions[0] !== session.sessionId
      || !launch.relay || launch.relay.registration.body.parentSessionId !== session.sessionId
      || launch.relay.registration.body.parentPid !== session.child.pid || !nativeRelayScopeCurrent(launch.relay)) {
      return 'Native parent continuation relay is unavailable.'
    }
    return undefined
  } catch { return 'Native parent continuation authority is unavailable.' }
}

// `liveProjectSessions` — the live `cc-agent-*` supervised sessions scoped to one
// project id — is ONE reader for preflight and admitted acquisition. A fresh read
// after acquisition is the ONLY evidence a spawn produced anything. It lives in the runtime
// (`live-project-sessions.ts`) so the liveness census asks the very same question.

export interface ProjectBuildContext {
  /** Host dependency seam. Production loads the independently provisioned public pin. */
  acquireClaudeCapacity?: AcquireClaudeCapacity
  controlClaudeContinuation?: ControlClaudeContinuation
  /** Host filesystem measurement at the actual dependency-install boundary. */
  measureInstallAvailableBytes?: typeof projectInstallAvailableBytes
  store: ProjectBuildHostOptions['production']['store']
  attempts: ProjectBuildHostOptions['attempts']
  runHost: ProjectBuildHostOptions['production']['runHost']
  /** Test seam for suite execution. Production owns the suite's process claim, without
   * the GitHub environment loaded by the publication runner. */
  runSuite?: SuiteCommandRunner
  /** Test seam for dependency setup; production does not use publisher credentials. */
  runInstall?: typeof spawnCapture
  stateRoot: string
  projectDir: string
  projectId: string
  provider: Provider
  providerSource: ProviderSelectionSource
  env: NodeJS.ProcessEnv
  spawnProjectSession: (projectId: string) => Promise<void>
  /**
   * #1237 — the lease every NATIVE CHILD of this run's project REPL holds. REQUIRED:
   * an unwired gate is a composition bug, not open admission. The acting turn admits
   * before it acquires or spawns any REPL; read-only preflight of an existing ready
   * parent grants no authority. A fenced or unknown scope refuses the step.
   */
  nativeChildAdmission: NativeChildAdmission
  /** The same host-owned resolver consumed by owner chat. Never creates a build session. */
  codexOwnerBindings?: Pick<CodexOwnerBindings, 'actingTurn' | 'guardBuildRunner'> & Partial<Pick<CodexOwnerBindings, 'prepareReview'>>
  /** Where this dispatch's CROSS-PROVIDER bounded workers (Claude headless, the Codex
   * build wrapper, the Codex review seat) get a visible task tab: the shared strict
   * project-workspace host (null when this process is not on Herdr) and the run's
   * own scope (`projectId` null for General). Absent or null host → every worker runs
   * unplaced and records why. The tab is a view; evidence never comes from it. */
  workerTerminal?: { host: WorkerPlacementHost | null; scope: WorkerPlacementScope }
}

/**
 * THE PLAN BRIEF MUST STATE THE LEDGER THE HOST ENFORCES AND COMMITS.
 *
 * The typed driver reads a plan's `implementationPlan` as a checkbox ledger: G025
 * refuses a task-sequence handoff plan whose unchecked lines disagree with `topTask` and
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
  'EXECUTION STRATEGY. On a fresh implementation build choose `strategy: "single"` or `strategy: "task_sequence"`, give a nonempty `rationale`, and supply the executable plan in this same result. Base the choice on coherent work boundaries, dependencies, and the size of a useful builder assignment. A repository with SPEC.md can use either strategy; a repository without it can use either strategy. Read and obey repository governance, but never treat the presence of a file or the number of arbitrary checklist bullets as the strategy decision.',
  'When host context `executionStrategy` is already selected, retain it exactly. Continuation, recovery, and bounded replanning cannot change it. The host owns task identities, budgets, test scope, review, mutation proof, publication, and merge. No worker proposal changes those authorities.',
  'For `single`, `implementationPlan` and `executionSpec` describe the WHOLE accepted work; `topTask` summarizes that whole work and `remainingTasks` is 0. The builder completes the entire plan in one call.',
  'THE TASK LEDGER. For `task_sequence`, `implementationPlan` is a checkbox list with one line per executable task: `- [x] T<n>: <one line>` for a task already built on this branch, and `- [ ] T<n>: <one line>` for each task still to build, the next task first among the unchecked lines. `executionSpec` describes only the selected top task. A wave member remains pinned to its host-assigned task.',
  '`topTask` is the first unchecked line, copied verbatim. `remainingTasks` is the number of unchecked lines minus one. When tasks remain, the host refuses a plan whose lines disagree with those two fields.',
  'After a build that leaves tasks remaining, the host ticks the top task and commits the ledger itself, at a per-branch path under `.trident/ledgers/`, on a PUBLIC branch whose files and commit messages are leak-scanned: no hostnames, usernames or absolute paths in any line. Do not write or edit that file, or a repo-root IMPLEMENTATION_PLAN.md, yourself.',
  'CONTINUATION. When the host context carries `planner: "next"` and `committedPlan`, the committed ledger IS the plan: return `committedPlan.body` unchanged as `implementationPlan`, its first unchecked line as `topTask`, and its unchecked count minus one as `remainingTasks`, and write only the `executionSpec` for that task. Do not re-survey the repository or re-plan the remaining tasks.',
].join('\n')

// Separate from the historical ledger contract so admitted v2/v3 briefs can
// still be reconciled byte-for-byte without rewriting a pending worker's input.
const PLAN_WORK_BOUNDARY = 'PLANNING WORK. Produce evidence-backed executable instructions. Before a probe, name the specific planning uncertainty it resolves and use the smallest relevant check. Leave candidate implementation, acceptance validation, mutation trials and gate diagnosis to the builder unless a targeted probe is necessary to resolve that uncertainty. Do not build and validate a complete trial candidate, then discard or reset it solely for the builder to repeat. Planning remains writable: preserve useful preparatory changes, measure and report their resulting head and diff honestly, and describe the work remaining for the builder. A changed input still requires the affected builder validation and host proof; a planning probe does not replace either. Capture complete probe output to a log once and inspect that log; do not rerun an unchanged check merely because earlier output was filtered or truncated.'

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

/** The builder TEST EXECUTION sentence of every brief rendered today (strategy v3). */
const TEST_EXECUTION_V3 = 'Follow the TEST EXECUTION instructions in the host context `testStrategy`. The host selects `suiteScope`: `full-suite` requires the worker full suite for a wave member; `subset` defers it for an intermediate task; `host-suite` leaves the full suite to host review after worker stage 1. Never infer scope from the task number or an earlier task.'
/**
 * The same sentence as the strategy-v2 renderer wrote it, byte-exact. It is the
 * ONLY line v2 and v3 disagreed on, so it is what lets a legacy v2 brief be
 * re-rendered from current inputs and compared instead of trusted (#1296).
 */
const TEST_EXECUTION_LEGACY_V2 = 'Follow the TEST EXECUTION instructions in the host context `testStrategy`. The host selects `suiteScope` after validating this task: `full-suite` requires the full suite; only `subset` defers it for an intermediate task. Never infer scope from the task number or an earlier task.'

/**
 * Why a stored legacy brief matches none of the renderings of the current inputs.
 * Each rendering is `task + '\n\n' + contract + reflection`; the fixed contract is
 * located in the stored bytes and the text on either side compared with the
 * current task and reflection. Nothing is inferred when the contract itself
 * differs: that is `unrecognized`, never a reason to reuse or to refuse.
 */
function legacyBriefChange(stored: string, renderings: readonly string[], task: string,
  reflection: string): 'task' | 'reflection' | 'unrecognized' {
  for (const rendering of renderings) {
    const contract = '\n\n' + rendering.slice(task.length + 2, rendering.length - reflection.length)
    const at = stored.indexOf(contract)
    if (at < 0) continue
    if (stored.slice(0, at) !== task) return 'task'
    if (stored.slice(at + contract.length) !== reflection) return 'reflection'
  }
  return 'unrecognized'
}

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
  const declaration = readProjectRepos(context.projectDir, run.project_slug)
  const repo = declaration.repos.find(row => resolve(context.projectDir, row.path) === resolve(run.repo_path))
  // PR builds cannot reach review or merge without this explicit project binding.
  // Refuse before preparing a worktree or workers; local builds need no remote CI.
  if (run.merge_mode === 'pr') {
    if (!repo) throw Error('PR build repository is not declared in project-repos.json')
    if (!repo.ciWorkflow?.trim()) throw Error(`PR build requires ciWorkflow for selected repo "${repo.name}" in project-repos.json`)
  }
  const runSuite = (command: string, logPath: string) => runHostSuite({
    argv: ['bash', '--noprofile', '--norc', '-c', suiteScript(command, logPath)], cwd: run.worktree,
    env: HOST_SUITE_ENV,
    timeoutMs: REVIEW_SUITE_TIMEOUT_MS, signal,
    isRunActive: () => {
      const current = context.store.get(run.id)
      return current !== null && !isTerminalPhase(current.phase)
    },
    ...(context.runSuite === undefined ? {} : { run: context.runSuite }),
  })
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
      // Cleanup can remove a published branch even when this same run still has
      // a pending review. Its own latest checkpoint outranks an imported retry.
      const pendingHead = await pendingReviewCheckoutHead(context.store, saved, input.base_branch, context.runHost)
      const expected = pendingHead ?? readBuildRetrySource(context.store, saved)?.state.checkpoint.head
      if (expected) {
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
    () => prepareProjectDependencies(run.worktree, state, context.runInstall, context.measureInstallAvailableBytes))
  const topic = run.chat_id ?? context.projectId
  const observerPath = (step: string) => join(state, `claude-observer-${createHash('sha256').update(step).digest('hex')}.json`)
  const codexEnv = { ...context.env, ...(input.codex_home ? { CODEX_HOME: input.codex_home } : {}) }
  const trailer = projectBuildTrailerDecoder(() => context.store.get(run.id))
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
  // Cross-provider workers only: the same-provider native child is untouched. Without
  // a Herdr host every worker runs unplaced and its receipt says so — never an
  // inherited or ambient workspace.
  const workerPlacement = createWorkerPlacement(context.workerTerminal?.host
    ? { host: context.workerTerminal.host, scope: context.workerTerminal.scope }
    : { host: null, unavailable: 'herdr-unconfigured' })
  // The same-provider native-child step, run only AFTER its lease was admitted
  // (see the acting turn below). Resolves or spawns the project REPL and hands
  // the step to it as a native child.
  const nativeWorkspaces = new Map<string, NativeChildWorkspace>()
  const nativeReviewScope = new AsyncLocalStorage<string>()
  const usageLocations = new Map<string, { session: string; directory: string }>()
  const nativeChildTurn = async (turn: Parameters<ProjectActingTurn>[0], generation: number, onDispatchSubmitted: () => void,
    evidence: (event: NativeDispatchEvidence) => void, enterActor: () => void): ReturnType<ProjectActingTurn> => {
    const deadline = turn.deadline_ms ?? Date.now() + Math.min(turn.timeout_ms, turn.request.budget.wall_ms)
    const expired = () => turn.signal.aborted || Date.now() >= deadline
    const expiredBeforeDispatch = () => ({ kind: 'refused' as const, reason: 'capability-unsupported' as const,
      detail: 'Native child preparation exhausted the original dispatch deadline.' })
    if (expired()) return expiredBeforeDispatch()
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
      if (expired()) return expiredBeforeDispatch()
      // WHY WE ARE SPAWNING, captured BEFORE the attempt, so the refusal below can
      // say whether the instance had no project REPL at all or had one whose child
      // had gone. #1085 is the first shape ("nothing respawned it"); they are not
      // interchangeable and the old wording covered both with neither.
      const had = candidates.length === 0 ? 'none existed' : 'the one that existed had a dead child'
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const expired = new Promise<true>(resolve => {
          timer = setTimeout(() => resolve(true), Math.min(PROJECT_SESSION_ACQUIRE_TIMEOUT_MS, Math.max(1, deadline - Date.now())))
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
    const preparationRefusal = nativeParentPreparationRefusal(session, context.projectId, turn.request)
    if (preparationRefusal) return { kind: 'refused', reason: 'capability-unsupported', detail: preparationRefusal }
    // Restricted launches do not attest the edit/run grants required by this bridge.
    if (options.skip_permissions !== true || options.restricted || options.permissions) return { kind: 'refused', reason: 'capability-unsupported', detail: 'Project launch grants cannot authorize bounded build work' }
    const launch = readNativeParentLaunchEvidence(session)
    evidence({ kind: 'parent-bound', parent: { sessionId: session.sessionId, childGeneration: session.childGeneration,
      pid: session.child.pid, processIdentity: readProcessIdentity(session.child.pid) ?? null, ...(launch ? { launch } : {}) } })
    const transcript = sessionJsonlPath(session.sessionId, session.cwd, resolveTranscriptProjectsDir(options))
    const observer = JSON.stringify({ request: turn.request, session: session.sessionId,
      directory: join(transcript.slice(0, -'.jsonl'.length), 'subagents') })
    usageLocations.set(turn.request.step_id, { session: session.sessionId,
      directory: join(transcript.slice(0, -'.jsonl'.length), 'subagents') })
    try { await writeFile(observerPath(turn.request.step_id), observer, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(observerPath(turn.request.step_id), 'utf8') !== observer) {
        // Observer binding cannot reroute or block paid work; its absence stays
        // explicit unknown telemetry rather than selecting a different session.
        await accounting.recordEvent('attempt-observer-binding-unavailable', { run_id: run.id, step_id: turn.request.step_id })
      }
    }
    let workspace: NativeChildWorkspace | undefined
    if (expired()) return expiredBeforeDispatch()
    if (context.nativeChildAdmission.pending) {
      try {
        workspace = await admitNativeChildWorkspace({ session, request: turn.request, runId: run.id,
          worktree: run.worktree, branch: run.branch, generation, pending: () => context.nativeChildAdmission.pending!(),
          git: async args => {
            if (expired()) throw new Error('Native workspace deadline expired')
            const result = await context.runHost(['git', '-C', run.worktree, ...args], run.worktree, undefined, Math.max(1, deadline - Date.now()))
            if (expired()) throw new Error('Native workspace deadline expired')
            if (!result.ok || result.timed_out) throw new Error('Native worktree identity unavailable')
            return result.stdout.trim()
          } })
        nativeWorkspaces.set(turn.request.step_id, workspace)
      } catch { return { kind: 'refused', reason: 'capability-unsupported', detail: 'Native writer has no checked independent worktree admission.' } }
    }
    if (expired()) return expiredBeforeDispatch()
    let plannerCapability: string | undefined
    if (requiresPlannerWork(turn.request)) {
      if (session.plannerRole !== PLANNER_ROLE || !workspace) return { kind: 'refused', reason: 'capability-unsupported', detail: 'Native planner role and closed host operations are unavailable.' }
      const admitted = workspace
      const hostContext = JSON.parse(await readFile(workContextPath(turn.request.brief.path), 'utf8'))
      if (!isDeepStrictEqual(hostContext.request, turn.request)) throw Error('Planner host context does not match the signed dispatch')
      const brief = await readFile(turn.request.brief.path, 'utf8')
      if (briefIntegrity(brief) !== turn.request.brief.integrity) throw Error('Planner brief integrity changed')
      plannerCapability = await bindPlannerWork({ session, request: turn.request, get deadline() { return turn.dispatchBudget?.deadline_ms ?? deadline }, signal: turn.signal, base: run.base_sha!, pr: hostContext.snapshot.pr, brief, context: hostContext,
        current: async () => {
          // Fresh sibling leases precede their local worktree measurements.
          // Every planner operation waits for that census, not only initial bind.
          // Lost own authority refuses immediately; unknown/foreign children
          // cannot acquire proof merely by waiting under the original deadline.
          while (!session.hasChildExited() && ownsNativeChildWorkspace(admitted, session, turn.request)) {
            const remaining = (turn.dispatchBudget?.deadline_ms ?? deadline) - Date.now()
            if (turn.signal.aborted || remaining <= 0) return false
            if (nativeChildCensusKnown(admitted)) return true
            try { await delay(Math.min(25, remaining), undefined, { signal: turn.signal }) }
            catch { return false }
          }
          return false
        },
        validate: envelope => ['completed', 'blocked'].includes(decodeProjectTrailer(JSON.stringify(envelope), turn.request, trailer).kind) })
    }
    enterActor()
    return createClaudeActingTurn({ project_id: context.projectId, topic_id: topic, session, projects_dir: resolveTranscriptProjectsDir(options), ...(workspace ? { workspace } : {}), ...(plannerCapability ? { plannerCapability } : {}), onDispatchSubmitted, onNativeDispatchEvidence: evidence,
      onQueueWait: (started_at, ended_at) => accounting.recordEvent('build-stage-ended', { run_id: run.id, step_id: turn.request.step_id,
        stage: 'repl-writer-queue', started_at, ended_at }),
      grants: { tools: 'edit-and-run', writable: true, network: true, roots: options.extra_dirs ?? [] } })({ ...turn,
        deadline_ms: deadline, timeout_ms: Math.max(1, deadline - Date.now()) })
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
      // Read an already-ready parent without acquiring or refreshing it. Refuse
      // known-stale authority before creating another durable child hold. Cold
      // acquisition stays below admission and repeats the check before binding.
      const candidates = liveProjectSessions(context.projectId)
      if (candidates.length === 1) {
        const pending = pool.get(candidates[0]![0])
        const session = pending && Bun.peek.status(pending) === 'fulfilled' ? Bun.peek(pending) as ReplSession | undefined : undefined
        if (session && !session.hasChildExited()) {
          const preparationRefusal = nativeParentPreparationRefusal(session, context.projectId, turn.request)
          if (preparationRefusal) return { kind: 'refused', reason: 'capability-unsupported', detail: preparationRefusal }
        }
      }
      // #1237 — THE NATIVE CHILD'S LEASE, taken BEFORE any REPL is acquired or
      // spawned, so a fenced project never gains a child. The child joins the run's
      // `build` lease (it is that run draining); the Codex branch above takes none —
      // it is the cross-provider observed owner thread, not a child of this REPL.
      const originalDeadline = turn.deadline_ms ?? Date.now() + Math.min(turn.timeout_ms, turn.request.budget.wall_ms)
      const child = await context.nativeChildAdmission.admit(run.id, turn.request.step_id)
      if (child.status !== 'admitted') {
        log.warn('native_child_refused', { run_id: run.id, step_id: turn.request.step_id, status: child.status })
        return { kind: 'refused', reason: 'capability-unsupported', detail: `Project admission refused the native child (${child.status})` }
      }
      let outcome: Awaited<ReturnType<ProjectActingTurn>> | undefined
      let receipt: ReturnType<typeof createClaudeNativeDispatchReceipt> | undefined
      let authority: NativeDispatchAuthority | undefined
      let actorEntered = false
      let notSubmitted = false
      let parent: Extract<NativeDispatchEvidence, { kind: 'parent-bound' }> | undefined
      const enclosingStep = nativeReviewScope.getStore()
      const evidence = (event: NativeDispatchEvidence) => {
        // The bounded writer wait is measured before original submission. Select
        // and sign its one execution deadline here, before any input can escape;
        // no post-submission event or recovery may establish another authority.
        if (event.kind === 'parent-bound') {
          if (parent || receipt) throw new Error('Original native parent is already bound')
          parent = structuredClone(event)
          return
        }
        if (!receipt && (event.kind === 'submission-started' || event.kind === 'not-submitted')) {
          authority = context.nativeChildAdmission.dispatchAuthority?.(child.lease, turn.request,
            turn.dispatchBudget?.deadline_ms ?? originalDeadline,
            enclosingStep === turn.request.step_id ? undefined : enclosingStep)
          if (!authority) throw new Error('Original native dispatch signing authority is unavailable')
          receipt = createClaudeNativeDispatchReceipt(state, turn.request, authority)
          if (parent) receipt.record(parent)
        }
        if (!receipt) throw new Error('Original native dispatch receipt is unavailable')
        receipt.record(event)
        if (event.kind === 'not-submitted') notSubmitted = true
      }
      try {
        outcome = await nativeChildTurn({ ...turn, deadline_ms: originalDeadline }, child.generation, () => context.nativeChildAdmission.finishPreparing?.(child.lease),
          evidence, () => { actorEntered = true })
        return outcome
      } catch {
        outcome = { kind: 'unknown', detail: 'Original native dispatch evidence or observation was interrupted.' }
        return outcome
      } finally {
        // No acting invocation was entered: even an acquisition timeout is a
        // positive pre-input refusal. Once entered, only the original actor's
        // terminal callback may prove that; unknown submit acknowledgements stay held.
        if (!actorEntered) {
          try { evidence({ kind: 'not-submitted' }) } catch { /* Incomplete durable evidence keeps the lease. */ }
        }
        receipt?.close()
        // Capture accounting provenance before a validated result can release
        // admission. Telemetry failure cannot veto that result.
        const location = usageLocations.get(turn.request.step_id)
        if (authority && location) {
          try {
            const signed = readClaudeNativeDispatchReceipt(state, turn.request)
            const pin = authority.lease
            if (verifyNativeDispatchChildBound(signed, turn.request, pin)
              && (signed as SignedNativeDispatchRecord).body.parent?.sessionId === location.session) {
              await context.attempts.archiveNativeUsage({ run_id: run.id, step_id: turn.request.step_id, attempt_id: 'dispatch' },
                { version: 1, lease: pin, receipt: signed as SignedNativeDispatchRecord, directory: location.directory, captured_at: Date.now() }, turn.request)
            }
          } catch { await accounting.recordEvent('attempt-usage-binding-unavailable', { run_id: run.id, step_id: turn.request.step_id }) }
        }
        usageLocations.delete(turn.request.step_id)
        context.nativeChildAdmission.finishPreparing?.(child.lease)
        // Parent-turn completion does not establish child completion. Only a
        // refusal before dispatch releases here; the consuming trailer validator
        // below owns all post-dispatch releases, including restart recovery.
        if (notSubmitted) {
          const workspace = nativeWorkspaces.get(turn.request.step_id)
          if (workspace) completeNativeChildWorkspace(workspace)
          // A failed release preserves ownership and must not turn a refusal into
          // a dispatch retry.
          await child.release().catch((error: unknown) => log.warn('native_child_release_failed', {
            run_id: run.id, step_id: turn.request.step_id, error: error instanceof Error ? error.message : String(error) }))
        } else log.info('native_child_lease_retained', { run_id: run.id, step_id: turn.request.step_id, outcome: outcome?.kind ?? 'threw' })
      }
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
      state_dir: state, schemas: trailer.schemas, placement: workerPlacement, taskName: run.slug }),
      'openai-codex': createCodexHeadlessRunner({ env: codexEnv, placement: workerPlacement, taskName: run.slug,
        reviewBriefIntegrity: briefIntegrity, reviewContracts: new Map([
      ['verdict', { jsonSchema: VERDICT_SCHEMA, validate: (value: unknown) => validateTrailer('verdict', value).ok }],
      ['project-review', { jsonSchema: { ...PROJECT_SNAPSHOT_SCHEMA,
        properties: { ...PROJECT_SNAPSHOT_SCHEMA.properties, payload: VERDICT_SCHEMA },
      }, validate: (value: unknown) => validSnapshot(value, 'verdict') }],
    ]) }) },
  })
  // Only the consuming runner's validated trailer establishes child completion.
  // Recovery uses the same request identity against the existing durable authority.
  if (context.provider === 'anthropic' && substrate.inRepl) {
    const runner = substrate.inRepl
    const waitingEpisodes = new Map<string, string | null | false>()
    const quotaState = async (request: Parameters<typeof runner.run>[0], state: ClaudeQuotaState, parentStepId?: string) => {
      const key = JSON.stringify([request.step_id, state.childId])
      if (!waitingEpisodes.has(key)) {
        // Producer recovery uses its authenticated native request, including a
        // panel child whose step differs from the enclosing host checkpoint.
        const last = context.store.stageEvents(run.id).findLast(event => {
          if (!['claude-quota-waiting', 'claude-quota-resumed', 'claude-quota-wait-ended'].includes(event.stage)) return false
          try { const meta = JSON.parse(event.meta ?? 'null'); return meta?.stepId === request.step_id && meta.childId === state.childId }
          catch { return false }
        })
        waitingEpisodes.set(key, last?.stage === 'claude-quota-waiting' ? JSON.parse(last.meta!).episodeId ?? null : false)
      }
      if (state.kind === 'waiting') {
        if (waitingEpisodes.get(key) === false) await context.store.recordStageEvent(run.id, 'claude-native-child-bound', JSON.stringify({ stepId: request.step_id, childId: state.childId,
          ...(parentStepId ? { parentStepId } : {}) }))
        waitingEpisodes.set(key, state.episodeId)
      } else {
        if (waitingEpisodes.get(key) === false || state.episodeId !== undefined && waitingEpisodes.get(key) !== null && waitingEpisodes.get(key) !== state.episodeId) return
        waitingEpisodes.set(key, false)
      }
      await context.store.recordStageEvent(run.id,
        `claude-quota-${state.kind === 'waiting' ? 'waiting' : state.kind === 'resumed' ? 'resumed' : 'wait-ended'}`,
        JSON.stringify({ stepId: request.step_id, childId: state.childId, ...(state.episodeId ? { episodeId: state.episodeId } : {}),
          ...(state.kind === 'waiting' ? { retryAtMs: state.retryAtMs } : {}) }))
    }
    const continuation = async (request: Parameters<typeof runner.run>[0], stopped: AbortSignal, deadline: number) => {
      if (request.run_id !== run.id) return { kind: 'unknown' as const, detail: 'Native continuation request belongs to another host run.' }
      const receipt = readClaudeNativeDispatchReceipt(state, request)
      const authority = context.nativeChildAdmission.continuation?.(request, receipt)
      if (!authority) return undefined
      // Harvest before requiring a live parent or reconstructing a workspace.
      // A completed original result survives both gateway and parent replacement.
      const reservationKey = createHash('sha256').update(JSON.stringify([request.run_id, request.step_id])).digest('hex')
      const held = await readArmedTrailerReservation(join(state, `claude-step-${reservationKey}.json`), JSON.stringify(request), { signal: stopped, deadline })
      if (held.kind !== 'resume') return { kind: 'unknown' as const, detail: 'Native continuation original reservation is unavailable.' }
      const harvested = await readClaudeContinuationResult({ request, decodeTrailer: (bytes, req) => decodeProjectTrailer(bytes, req, trailer) })
      if (harvested?.kind === 'result') {
        await quotaState(request, { kind: 'resumed', childId: (receipt as SignedNativeDispatchRecord).body.nativeAgentId! })
        return harvested.outcome
      }
      if (harvested) return { kind: 'unknown' as const, detail: 'Native continuation original result is unreadable.' }
      const candidates = liveProjectSessions(context.projectId)
      if (candidates.length !== 1) return { kind: 'unknown' as const, detail: 'Native continuation parent is missing or ambiguous.' }
      const [key, options] = candidates[0]!
      const pending = pool.get(key)
      if (!pending || Bun.peek.status(pending) !== 'fulfilled') return { kind: 'unknown' as const, detail: 'Native continuation parent is unavailable.' }
      const session = await pending
      if (!session || session.hasChildExited() || options.skip_permissions !== true || options.restricted || options.permissions
        || (receipt as SignedNativeDispatchRecord).body.parent?.sessionId !== session.sessionId) return { kind: 'unknown' as const, detail: 'Native continuation parent identity is unavailable.' }
      let workspace = nativeWorkspaces.get(request.step_id)
      if (!workspace || !ownsNativeChildWorkspace(workspace, session, request)) {
        if (!context.nativeChildAdmission.pending) return undefined
        try {
          workspace = await admitNativeChildWorkspace({ session, request, runId: run.id, worktree: run.worktree,
            branch: run.branch, generation: authority.lease.generation, pending: () => context.nativeChildAdmission.pending!(),
            git: async args => {
              if (stopped.aborted || Date.now() >= deadline) throw new Error('Continuation budget expired')
              const result = await context.runHost(['git', '-C', run.worktree, ...args], run.worktree, undefined, Math.max(1, deadline - Date.now()))
              if (!result.ok || result.timed_out) throw new Error('Continuation worktree unknown')
              return result.stdout.trim()
            } })
          nativeWorkspaces.set(request.step_id, workspace)
        } catch { return { kind: 'unknown' as const, detail: 'Native continuation workspace identity is unavailable.' } }
      }
      const observed = await continueClaudeNativeChild({ request, receipt, authority, stateDir: state, session, workspace,
        capacity: { ...(context.acquireClaudeCapacity ? { acquire: context.acquireClaudeCapacity } : {}),
          ...(context.controlClaudeContinuation ? { control: context.controlClaudeContinuation } : {}) },
        onQuotaState: state => quotaState(request, state, (receipt as SignedNativeDispatchRecord).body.parentStepId),
        projectsDir: resolveTranscriptProjectsDir(options), deadline, signal: stopped,
        decodeTrailer: (bytes, req) => decodeProjectTrailer(bytes, req, trailer) })
      if (observed.kind === 'result') return observed.outcome
      if (observed.kind === 'unknown') return { kind: 'unknown' as const, detail: `Native continuation ${observed.reason}; original child ownership retained.` }
      if (observed.kind === 'submitted') return 'submitted' as const
      return undefined
    }
    // Native HTTP may arrive before SendMessage's tool result. Keep passive
    // result harvesting alive while reconciling the pending intent; promotion
    // unlocks that same HTTP request, and later signed quotas can spend successors.
    const recoverContinuing = async (request: Parameters<typeof runner.run>[0], placement: Parameters<typeof runner.run>[1],
      stopped: AbortSignal, deadline: number) => {
      const receipt = readClaudeNativeDispatchReceipt(state, request)
      if (context.nativeChildAdmission.continuation?.(request, receipt)) {
        const original = (receipt as SignedNativeDispatchRecord).body.deadlineMs
        if (Number.isSafeInteger(original)) deadline = Math.min(deadline, original!)
      }
      const done = new AbortController(), signal = AbortSignal.any([stopped, done.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
      const passive = runner.recover!(request, placement, signal)
      const reconcile = async () => {
        while (!signal.aborted && Date.now() < deadline) {
          const next = await continuation(request, signal, deadline)
          if (next && next !== 'submitted' && next.kind !== 'unknown') return next
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
            const timer = setTimeout(finish, 100)
            signal.addEventListener('abort', finish, { once: true })
            if (signal.aborted) finish()
          })
        }
        return passive
      }
      try { return await Promise.race([passive, reconcile()]) }
      finally {
        done.abort()
        if (context.nativeChildAdmission.continuation?.(request, receipt)) await quotaState(request,
          { kind: 'ended', childId: (receipt as SignedNativeDispatchRecord).body.nativeAgentId! })
      }
    }
    const finish: typeof runner.run = async (...args) => {
      let deadline = Date.now() + args[0].budget.wall_ms
      let outcome = await runner.run(...args)
      if (outcome.kind === 'blocked' || outcome.kind === 'unknown') {
        const receipt = readClaudeNativeDispatchReceipt(state, args[0])
        if (context.nativeChildAdmission.continuation?.(args[0], receipt)) {
          const original = (receipt as SignedNativeDispatchRecord).body.deadlineMs
          if (Number.isSafeInteger(original)) deadline = original!
        }
        const stopped = AbortSignal.any([args[2], AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
        const continued = await continuation(args[0], stopped, deadline)
        if (continued === 'submitted' && runner.recover) outcome = await recoverContinuing(args[0], args[1], stopped, deadline)
        else if (continued && continued !== 'submitted') outcome = outcome.kind === 'blocked' && continued.kind === 'unknown'
          ? { kind: 'blocked', on: `${outcome.on} ${continued.detail}` } : continued
      }
      if (outcome.kind === 'completed' || outcome.kind === 'blocked') await releaseValidatedChild(args[0])
      return outcome
    }
    const releaseValidatedChild = async (request: Parameters<typeof runner.run>[0]) => {
      try {
        const result = decodeProjectTrailer(await readFile(request.result.path, 'utf8'), request, trailer)
        if (result.kind === 'completed' || result.kind === 'blocked') {
          await context.nativeChildAdmission.complete(request.run_id, request.step_id)
          const workspace = nativeWorkspaces.get(request.step_id)
          if (workspace) completeNativeChildWorkspace(workspace)
          for (const [key] of liveProjectSessions(context.projectId)) {
            const pending = pool.get(key)
            if (pending && Bun.peek.status(pending) === 'fulfilled') {
              const session = await pending
              if (session) { completeNativeChildWorkspaceRequest(session, request); releasePlannerWork(session, request) }
            }
          }
        }
      } catch { /* Missing evidence or failed durable release preserves ownership. */ }
    }
    substrate.inRepl = { ...runner, run: finish, ...(runner.recover ? { recover: async (...args: Parameters<NonNullable<typeof runner.recover>>) => {
      if (args[0].run_id !== run.id || args[1] !== 'in-repl' || !runner.supports(args[0].role, args[1]).ok) return runner.recover!(...args)
      try {
        if (args[0].run_id === run.id && await context.nativeChildAdmission.releaseUnsubmitted?.(args[0], readClaudeNativeDispatchReceipt(state, args[0]))) {
          return { kind: 'failed' as const, class: 'killed' as const, detail: 'Original native dispatch actor durably refused before submitting input.' }
        }
      } catch { return { kind: 'unknown' as const, detail: 'Original native dispatch lease reconciliation is unavailable.' } }
      const deadline = Date.now() + args[0].budget.wall_ms
      const stopped = AbortSignal.any([args[2], AbortSignal.timeout(Math.max(1, args[0].budget.wall_ms))])
      const continued = await continuation(args[0], stopped, deadline)
      // Continuation uncertainty forbids another input, not passive observation.
      // Missing parents, preconditions and even a spent lost-ack claim must not
      // suppress the original runner's result polling during this recovery.
      const outcome = continued && continued !== 'submitted' && continued.kind !== 'unknown'
        ? continued : await recoverContinuing(args[0], args[1], stopped, deadline)
      if (outcome.kind === 'completed' || outcome.kind === 'blocked') await releaseValidatedChild(args[0])
      return outcome
    } } : {}) }
  }
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
  const retainedSource = readBuildRetrySource(context.store, context.store.get(run.id)!)
  const proofRetry = retainedSource?.proofFix ?? retainedSource?.mergeRefresh
  // Only an original host checkpoint AND its exact armed transport reservation
  // preserve legacy planner authority. A prepared brief alone authorizes nothing.
  let pendingPlanner: ProjectBuildHostOptions['workers']['plan'] | undefined
  const latestMode = context.store.stageEvents(run.id).filter(event => event.stage === 'build-mode-state').at(-1)
  if (latestMode) {
    try {
      const recovery = parseBuildModeState(latestMode.meta ?? null, run, true).checkpoint.pending?.recovery
      if (recovery) {
        const request = recovery.request
        const provider = recovery.inputs.workers[request.role]?.provider
        const prefix = provider === 'anthropic' ? 'claude' : provider === 'openai-codex' ? 'codex' : provider === 'pi' ? 'pi' : null
        if (prefix && request.run_id === run.id && Reflect.get(recovery.inputs, 'repl_provider') === context.provider) {
          const hash = createHash('sha256').update(JSON.stringify([run.id, request.step_id])).digest('hex')
          const reservation = provider === 'openai-codex' && context.provider !== provider
            ? codexHeadlessReservation(request, codexEnv)
            : { path: join(state, `${prefix}-step-${hash}.json`), identity: JSON.stringify(request) }
          const held = await readArmedTrailerReservation(reservation.path, reservation.identity, { signal })
          if (held.kind === 'resume') pendingPlanner = recovery.inputs.workers.plan
        }
      }
    } catch { /* Unauthenticated legacy inputs cannot authorize a new planner. */ }
  }
  const legacyPlanner = pendingPlanner?.request.tools === 'edit-and-run' ? pendingPlanner : proofRetry?.workers.plan?.request.tools === 'edit-and-run' ? proofRetry.workers.plan : undefined
  // The pre-strategy schema migration has its own exact validator in the build
  // host. Only an authenticated pending reservation may select that binding.
  const legacyRun = context.store.get(run.id)!
  const unversionedPlanner = pendingPlanner?.request.tools === 'edit-and-run'
    && legacyRun.strategy_source === 'legacy' && legacyRun.execution_strategy !== null
    && pendingPlanner.request.brief.path === join(state, 'plan.brief.plan.host')
  const legacyPlanVersion = legacyPlanner?.request.brief.path.match(/\.strategy-v([234])\.brief\.plan\.host$/)?.[1]
    ?? (unversionedPlanner ? '3' : undefined)
  const requestedModels = {} as ProjectBuildHostOptions['requestedModels']
  const invalidated: { role: string; cause: 'task' | 'reflection' }[] = []
  // Whether THIS run's latest persisted reservation was admitted with a v2 brief.
  // A checkpoint this run cannot parse names no brief; it changes no decision.
  const pendingLegacyBrief = (role: string): boolean => {
    let latest: string | undefined
    for (const event of context.store.stageEvents(run.id)) {
      if (event.stage !== 'build-mode-state') continue
      try { latest = parseBuildModeState(event.meta, run, true).checkpoint.pending?.recovery?.request.brief.path }
      catch { /* Not an identity this run can read. */ }
    }
    return latest?.endsWith(`.strategy-v2.brief.${role}.host`) ?? false
  }
  for (const role of ['plan', 'build', 'review', 'fix'] as const) {
    const phase = phaseByKey(role === 'plan' ? 'decomposition' : role === 'review' ? 'review_adversarial' : 'build')!
    const selected = config[phase.key]
    const descriptor = modelTier(selected?.model ?? phase.default.tier)
    requestedModels[role] = selected?.model ?? phase.default.tier
    if (!descriptor) throw Error(`Unknown model for ${role}`)
    const provider: Provider = descriptor.group === 'claude' ? 'anthropic' : descriptor.group === 'codex' ? 'openai-codex' : 'pi'
    // Owner guidance and test execution instructions belong only to the builders.
    const isBuilder = role === 'build' || role === 'fix'
    const reflectionSuffix = isBuilder ? buildReflectionGuidance(input.reflection_context) : ''
    const renderBrief = ({ testExecution, commitWrapper, planWorkBoundary = false }: { testExecution: string; commitWrapper: boolean; planWorkBoundary?: boolean }) => [run.task, isBuilder
      ? testExecution : '',
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
      ...(role === 'plan' && planWorkBoundary ? [PLAN_WORK_BOUNDARY] : []),
      ...(isBuilder ? ['EXECUTION SCOPE. Read the host context `executionStrategy` and validated plan in `previous`. For `single`, implement the WHOLE accepted plan and executionSpec. For `task_sequence`, implement only the host-selected `topTask` and its executionSpec; leave later tasks to later calls. Never select a strategy or task yourself. A fix addresses the host-provided findings without changing strategy. A wave member implements only its host-pinned task.'] : []),
      ...(isBuilder && commitWrapper ? [`Commit only through the host wrapper with argv ${JSON.stringify(['bash', join(TRIDENT_SCRIPT_DIR, 'commit-with-resolved-head.sh'), run.branch])}, followed by your git commit arguments. Never invoke git commit directly. Do not add a Claude-Session: trailer; keep Co-Authored-By. After the wrapper returns, read the final OID with git rev-parse HEAD for both result.head and payload.commitSha.`] : []),
      'Never publish or merge; the host owns those actions.',
    ].join('\n\n') + reflectionSuffix
    let brief = renderBrief({ testExecution: TEST_EXECUTION_V3, commitWrapper: true, planWorkBoundary: !unversionedPlanner })
    // A LEGACY V2 BRIEF IS EVIDENCE, NOT AUTHORITY (#1296). A pending reservation
    // is identified by `{ brief.path, brief.integrity }` alone (`build-run.ts`
    // resume validation), and neither the task text nor the owner reflection is
    // part of that identity — reflection is even re-read live on every fire. So
    // adopting a stored v2 brief unconditionally recovered a v2 result that was
    // produced for a task or reflection that no longer holds.
    //
    // Reuse therefore needs the stored bytes to EQUAL a rendering of the CURRENT
    // inputs in one of the two known v2 shapes: the v2 TEST EXECUTION sentence
    // with the builder commit-wrapper line, and the same before #1238 added that
    // line. Byte-exact against known renderings, never a fuzzy match: anything
    // else is either a changed input (refused) or unrecognized (uncertain).
    //
    // A changed task or reflection THROWS after every role is classified: the
    // attempt journal makes step_id the idempotency key, so the same step cannot
    // be re-dispatched with a different brief. Re-execution is the cross-run
    // retry's fresh step; this prepare dispatches nothing and consumes nothing.
    //
    // Missing or unrecognized evidence stays explicit, bounded uncertainty: the
    // current brief identity is presented, it cannot match the v2 reservation, and
    // build-run answers its typed `unknown` with the reservation intact.
    let path = join(state, `${role}.strategy-v${role === 'plan' ? legacyPlanVersion ?? 5 : 3}.brief`)
    const legacyPath = join(state, `${role}.strategy-v2.brief`)
    let stored: string | null = null
    try { if (role !== 'plan' || legacyPlanVersion === '2') stored = await readFile(legacyPath, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const legacy = [renderBrief({ testExecution: TEST_EXECUTION_LEGACY_V2, commitWrapper: true }),
      renderBrief({ testExecution: TEST_EXECUTION_LEGACY_V2, commitWrapper: false })]
    const reconcile = (meta: Record<string, unknown>) =>
      context.store.recordStageEvent(run.id, 'build-legacy-brief-reconciled', JSON.stringify({ role, ...meta }))
    let adopt = false
    if (stored !== null && legacy.includes(stored)) {
      adopt = true
      await reconcile({ decision: 'reused', stored: briefIntegrity(stored) })
    } else if (stored !== null) {
      const cause = legacyBriefChange(stored, legacy, run.task, reflectionSuffix)
      const meta = { stored: briefIntegrity(stored), rendered: legacy.map(briefIntegrity) }
      if (cause !== 'unrecognized') {
        await reconcile({ decision: 'invalidated', cause, ...meta })
        invalidated.push({ role, cause })
        continue
      }
      await reconcile({ decision: 'unrecognized', ...meta })
    } else if (pendingLegacyBrief(role)) await reconcile({ decision: 'missing' })
    if (adopt) {
      brief = stored!
      path = legacyPath
    } else {
      if (role === 'plan') {
        // Existing run inputs retain the exact signed request/grants. New runs
        // receive v5 and the enforced edit-only planning capability.
        const previousPath = join(state, 'plan.strategy-v4.brief')
        let previous: string | null = null
        try { if (legacyPlanVersion === '4') previous = await readFile(previousPath, 'utf8') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (previous !== null) {
          if (previous !== brief) throw Error('Stored v4 planner inputs changed')
          path = previousPath
        }
        const priorPath = join(state, 'plan.strategy-v3.brief')
        let prior: string | null = null
        try { if (legacyPlanVersion === '3') prior = await readFile(priorPath, 'utf8') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (prior !== null) {
          // Preserve admitted inputs, not arbitrary old text. Changed task bytes
          // cannot be laundered into a new brief for the same reserved step.
          if (prior !== renderBrief({ testExecution: TEST_EXECUTION_V3, commitWrapper: true })) {
            throw new Error('Stored v3 planner brief does not match current inputs; its reserved identity cannot be rewritten')
          }
          brief = prior
          path = priorPath
        }
      }
      try { await writeFile(path, brief, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== brief) throw error
      }
    }
    workers[role] = { provider, request: {
      model_id: descriptor.model_id, effort: selected?.effort ?? phase.default.effort,
      cwd: run.worktree, writable: role !== 'review', network: role !== 'review' && !path.endsWith('plan.strategy-v5.brief'),
      tools: role === 'review' ? 'read-only' : path.endsWith('plan.strategy-v5.brief') ? 'edit' : 'edit-and-run',
      brief: { path, integrity: briefIntegrity(brief) },
      result: { schema: role === 'plan' ? 'project-plan-v2' : role === 'review' ? 'project-review' : 'project-build', path: join(state, `${role}.result`) },
      thread: null, budget: { wall_ms: PROJECT_BUILD_WALL_MS[role] },
    } }
  }
  if (invalidated.length > 0) {
    const { role, cause } = invalidated[0]!
    throw new Error(`Legacy v2 ${role} brief was rendered from different ${cause === 'task' ? 'task text' : 'reflection guidance'}; its reserved result is invalidated and the step must be re-executed`)
  }
  const bodyFile = join(state, 'publication.md')
  if (proofRetry) {
    // This exception retains implementation only under its original model and
    // instructions. Proof uses this run's current environment and new receipts.
    for (const role of ['plan', 'build', 'review', 'fix'] as const) {
      if (!proofFixWorkerMatches(proofRetry, role, workers[role]!,
        await readFile(workers[role]!.request.brief.path, 'utf8'))) {
        throw new Error(`Settled proof fix retry ${role} model, authority or brief changed; the retained candidate cannot be reused`)
      }
    }
  }
  // A retried build keeps its completed worker artifacts under the ORIGINAL
  // run's directory. Read through the dispatch-minted source chain; never move
  // receipts or relabel worker envelopes as if this run had produced them.
  const readArtifact = async (role: 'plan' | 'build' | 'fix', head?: string) => {
    let current = context.store.get(run.id)!
    const seen = new Set<string>()
    for (;;) {
      if (seen.has(current.id)) throw new Error('Retry artifact source cycle')
      seen.add(current.id)
      try {
        let text = await readFile(join(context.stateRoot, encodeURIComponent(current.id), `${role}.result`), 'utf8')
        if (role !== 'plan' && head !== undefined) {
          text = recoveredBuildArtifact(text, head, context.store.stageEvents(current.id))
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
        return { text, source: current }
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
    const artifact = await readArtifact('plan', snapshot.head)
    const planEnvelope = JSON.parse(artifact.text)
    if (planEnvelope?.run_id !== artifact.source.id || planEnvelope?.kind !== 'completed') {
      throw new Error('Publication plan is missing its original worker identity')
    }
    const legacyPlan = planEnvelope.schema === 'project-plan'
      ? normalizeLegacyStoredExecutionPlan(planEnvelope?.result?.payload, artifact.source) : null
    if (planEnvelope.schema !== 'project-plan-v2' && legacyPlan === null) {
      throw new Error('Publication plan has no valid execution-strategy provenance')
    }
    const plan = validateTrailer('plan', legacyPlan ?? planEnvelope?.result?.payload)
    if (!plan.ok) throw new Error(`Publication plan result is invalid: ${plan.reason} at ${plan.path}`)
    let forge: ReturnType<typeof validateTrailer<'forge'>> | null = null
    for (const role of ['fix', 'build'] as const) {
      try {
        const envelope = JSON.parse((await readArtifact(role, snapshot.head)).text)
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
  const reviewCredentialIdentity = async (provider: Provider): Promise<string | null> => {
    if (provider !== 'anthropic' || provider !== context.provider) {
      return workerCredentialIdentity(provider, provider === 'openai-codex' ? codexEnv : context.env)
    }
    const candidates = liveProjectSessions(context.projectId)
    if (candidates.length !== 1) return null
    const [key, options] = candidates[0]!
    const pending = pool.get(key)
    if (!pending || Bun.peek.status(pending) !== 'fulfilled') return null
    const session = await pending
    if (!session || session.hasChildExited()) return null
    // Spawn/adoption stamps the credential actually held by this child. A
    // changed desired overlay cannot relabel an already-running child.
    if (session.authFingerprint) return createHash('sha256').update(JSON.stringify([
      provider, context.projectId, session.sessionId, session.authFingerprint,
    ])).digest('hex')
    const selected = mergeEnv(options.env)
    if (options.claudeConfigDir !== undefined) selected.CLAUDE_CONFIG_DIR = options.claudeConfigDir
    if (['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].some(key => selected[key])) return null
    const credential = await workerCredentialIdentity(provider, selected)
    return credential ? createHash('sha256').update(JSON.stringify([credential, session.sessionId, session.authFingerprint])).digest('hex') : null
  }
  return {
    substrate, workers, requestedModels, attempts: context.attempts,
    reviewScope: (identity, operation) => nativeReviewScope.run(identity.step_id, operation),
    suiteIdentity: snapshot => projectSuiteIdentityMeasurement(run.worktree, snapshot.head, fullSuiteCommand(input.test_strategy) ?? undefined),
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
          try { value = JSON.parse((await readArtifact(role, snapshot.head)).text) } catch { continue }
          const checked = validateTrailer('forge', value?.result?.payload)
          if (checked.ok && checked.value.commitSha === snapshot.head) return checked.value.mutationClaim
        }
        // A validated worker omission is null. Unreadable, stale or foreign
        // artifacts must not authorize the bounded missing-nomination repair.
        return undefined
      } },
      reviewSuite: { strategy: input.test_strategy ?? '', scope: 'full-suite',
        // G063 REQUIRES A BUILD/FIX CHECKPOINT FOR THIS REVISION. Stubbed to `null`,
        // the source returns `unknown` (`project-observation-sources.ts:76`) for EVERY
        // card and any strategy — measured — and `applyReviewSuite` propagates it, so
        // the review decision is `unknown` and no dispatched card can reach `merged`.
        //
        // Intermediate tasks return before review. Every terminal review observes the
        // full suite, and publication consumes its existing identity-bound receipt.
        // A timeout has no usable verdict.
        //
        // THE IDENTITY IS THE HOST'S. The original carried the claim in a round-labelled
        // checkpoint (`forge-done` / `fix-round-N`); here each role overwrites one result
        // file, so the revision identity is the head. A file whose own `result.head` is
        // not the head the host just measured is a claim about a DIFFERENT revision and
        // answers nothing — `fix` is read first because it is the fresher of the two.
        readCheckpoint: async (snapshot, round) => {
          for (const role of ['fix', 'build'] as const) {
            let value: { step_id?: string; result?: { head?: unknown; payload?: unknown } }
            let artifact: Awaited<ReturnType<typeof readArtifact>>
            try { artifact = await readArtifact(role, snapshot.head); value = JSON.parse(artifact.text) }
            catch { continue }
            if (value?.result?.head !== snapshot.head) continue
            const checked = validateTrailer('forge', value.result.payload)
            if (!checked.ok) continue
            const claim = checked.value
            const command = fullSuiteCommand(input.test_strategy)
            if (!command) return { runId: run.id, head: snapshot.head, round, report: null }
            const logPath = join(state, `suite-round-${round}.log`)
            const observed = await runSuite(command, logPath)
            const unopenable = observed.stdout.trimStart().startsWith(SUITE_LOG_UNAVAILABLE)
            const pending = context.store.stageEvents(artifact.source.id).filter(event => event.stage === 'build-mode-state')
              .map(event => parseBuildModeState(event.meta, artifact.source, true).checkpoint?.pending)
              .find(pending => pending?.step_id === value.step_id)?.recovery
            const hostSuiteWorker = !!pending && Reflect.get(pending.inputs, 'mode') === 'implementation'
              && pending.request.brief.path.endsWith(`.strategy-v3.brief.${role}.host`)
            // A new stage-1 worker can compare only red the host actually gave its
            // fix turn. Legacy full-suite workers keep their original G065 contract.
            const hostComparisonEligible = role === 'fix' && artifact.source.id === run.id && !!pending
              && pending.findings.some(finding => finding.includes('Host full suite log:'))
              && context.store.stageEvents(run.id).some(event => {
                if (event.stage !== 'build-suite-receipt') return false
                try {
                  const receipt = JSON.parse(event.meta!).receipt
                  return receipt?.runId === run.id && receipt.head === pending.snapshot.head
                    && receipt.round === pending.round && receipt.strategy === (input.test_strategy ?? '')
                    && receipt.scope === 'full-suite' && Number.isInteger(receipt.report?.hostExitCode)
                    && receipt.report.hostExitCode !== 0
                } catch { return false }
              })
            return { runId: run.id, head: snapshot.head, round, report: {
              ...(observed.timed_out || unopenable ? {} : { hostExitCode: observed.exit_code }),
              ...(!observed.timed_out && !unopenable && observed.exit_code !== 0 ? {
                ...await suiteFailure(logPath, command, run.worktree), hostSuiteWorker, hostComparisonEligible,
              } : {}),
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
          const observed = await runSuite(command, logPath)
          const unopenable = observed.stdout.trimStart().startsWith(SUITE_LOG_UNAVAILABLE)
          return { runId: run.id, head: snapshot.head, round, report:
            observed.timed_out || unopenable ? {} : { hostExitCode: observed.exit_code,
              ...(observed.exit_code !== 0 ? await suiteFailure(logPath, command, run.worktree) : {}) } }
        } },
      review: { evidenceRoot: state, env: codexEnv, phaseModels: config, wallMs: 2_700_000, signal,
        credentialIdentity: reviewCredentialIdentity,
        runnerFor: (model, seat) => model.group === 'api' || model.group === 'kimi' ? undefined
          : seat.provider === substrate.provider ? substrate.inRepl : substrate.headless[seat.provider] },
    },
  }
}

export function validSnapshot(value: unknown, kind: 'plan' | 'forge' | 'verdict'): boolean {
  assertProjectSnapshot(value)
  return validateTrailer(kind, value.payload).ok
}

/** Live execution and passive late-result recovery share the same validators. */
export function projectBuildTrailerDecoder(currentRun: () => ReturnType<ProjectBuildContext['store']['get']>): ProjectTrailerDecoder {
  return { schemas: new Map([
    ['project-plan-v2', (value: unknown) => validSnapshot(value, 'plan')],
    ['project-plan', (value: unknown) => {
      assertProjectSnapshot(value)
      const current = currentRun()
      return current?.strategy_source === 'legacy'
        && normalizeLegacyStoredExecutionPlan(value.payload, current) !== null
    }],
    ['project-build', (value: unknown) => validSnapshot(value, 'forge')],
    ['project-review', (value: unknown) => validSnapshot(value, 'verdict')],
    ['verdict', (value: unknown) => validateTrailer('verdict', value).ok],
  ]), metadata: () => undefined }
}
