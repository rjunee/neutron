/**
 * OFFLINE END-TO-END HARNESS FOR THE REBUILT TRIDENT DRIVER.
 *
 * WHY THIS EXISTS. The rebuilt driver has never completed a build. Three live
 * acceptance dispatches each stopped at a DIFFERENT point, and each stop was
 * only discoverable by spending a dispatch:
 *
 *   1. the admission gate discarded its cause (#1009);
 *   2. the admission gate's post-fire write clobbered the worktree the launcher
 *      had persisted (#1032);
 *   3. the plan worker's trailer was rejected — "Trailer run_id missing or
 *      mismatched." — because the brief asked for `{head, diff, pr, payload}`
 *      while `decodeProjectTrailer` requires the ENVELOPE
 *      `{schema, run_id, step_id, kind, result}` (#1033).
 *
 * Every one of them was a WIRING bug, findable offline. This file drives a
 * COMPLETE build — plan → build → review → publish → merge — through the real
 * composition, so the next one is found in a test run instead of a dispatch.
 *
 * ── WHAT IS REAL HERE ─────────────────────────────────────────────────
 *   • `prepareProjectBuild` (open/wiring/project-build.ts) builds the options.
 *   • `createProjectBuildHost` → `createBuildHost` → `buildRun` drive them.
 *   • A REAL temporary git repository with a REAL bare `origin` beside it, so
 *     admission's `git fetch`, publication's `ls-remote` /
 *     `push --force-with-lease` / witness read, `pinnedMergeReadiness`'s fetch
 *     and diff, and the merge itself are all real git against real objects.
 *   • A REAL migrated sqlite database (`tests/support/migrated-db.ts`) behind
 *     the real `TridentRunStore` and `TridentPhaseUsageStore`.
 *   • The REAL in-REPL worker transport: `createProjectRunners` →
 *     `claudeInReplRunner` → `createClaudeActingTurn` → `decodeProjectTrailer`.
 *     Nothing about the dispatch, the result file, or its decoding is stubbed.
 *   • The REAL leak preflight module, over a real throwaway git worktree.
 *   • The REAL `productionCiSource`, parsing real `gh api` JSON shapes.
 *
 * ── WHAT IS FAKE, AND EXACTLY WHERE ───────────────────────────────────
 *   1. THE MODEL TURN, at the one seam where a model actually sits:
 *      `session.child.submitLine`. `createClaudeActingTurn` hands that function
 *      the same line a live Claude REPL would receive, and `literalWorker`
 *      below reads the dispatch out of it, reads the brief and the host turn
 *      context off disk, does the role's work in the real worktree, and writes
 *      the result file. If a brief is wrong, this harness goes red exactly as
 *      the live run did — see `envelopeFieldsNamedBy`.
 *   2. THE GITHUB API (`gh`), as an in-memory PR record over the real bare
 *      origin. Everything else in `runHost` is `spawnCapture`.
 *   3. THE LEAK SCANNER ITSELF — `policy.leak.gate_script` is pointed at a
 *      two-line stub that prints the gate's own SILENT sentinel. The preflight
 *      module, its worktree provisioning and its verdict classification are
 *      real; only the ~100s scan is not.
 *
 * Everything this does NOT cover is enumerated at the bottom of this file.
 */
import { LIVE_AGENT_TOOL_NAMES } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { WorkBoardStore } from '@neutronai/work-board/store.ts'
import { dispatchBoardBoundBuild } from '@neutronai/trident/board-dispatch.ts'
import { buildTridentOrchestrator } from '@neutronai/trident/orchestrator.ts'
import { createProjectLauncher } from '@neutronai/trident/project-launcher.ts'
import { slugifyTask } from '@neutronai/trident/slugify-task.ts'
import { TridentPhaseUsageStore } from '@neutronai/trident/phase-usage.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { createProjectBuildHost, type ProjectBuildOutcome } from '@neutronai/trident/project-build-host.ts'
import { spawnCapture, type HostCommandResult } from '@neutronai/trident/git-mode.ts'
import { gitRangeArgv } from '@neutronai/trident/git-range.ts'
import { VERDICT_SCHEMA } from '@neutronai/trident/gates/result-contract.ts'
import { taskLedgerPath, workContextPath } from '@neutronai/trident/production-host-effects.ts'
import { briefIntegrity } from '@neutronai/trident/gates/brief-integrity.ts'
import { pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { buildRun, type BuildRunOutcome } from '@neutronai/trident/build-run.ts'
import type { InnerLoopInput } from '@neutronai/trident/inner-loop.ts'
import { PROJECT_SESSION_ACQUIRE_TIMEOUT_MS, prepareProjectBuild, type ProjectBuildContext } from '../wiring/project-build.ts'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'
import { restrictedOwnerFixture } from './fixtures/codex-owner-review.ts'
import { PROJECT_DEPENDENCIES_TIMEOUT_MS } from '../wiring/project-build-dependencies.ts'
import { PROJECT_SNAPSHOT_SCHEMA } from '../wiring/project-build-snapshot.ts'
import { EfficiencyTrace, EFFICIENCY_SCENARIOS, assertEfficient, compareEfficiency, type EfficiencyReport, type EfficiencyScenario } from './fixtures/trident-efficiency-benchmark.ts'
import { ReplSession } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

test.each(['denied', 'secret-rotation'] as const)('idle Codex MCP revocation kills only the quiet revoked peer and preserves successor chat and unrelated handles: %s', async change => {
  const cwd = await mkdtemp(join(tmpdir(), 'idle-owner-mcp-'))
  cleanups.push(() => rm(cwd, { recursive: true, force: true }))
  let revoked = false, turn = 0
  const handles = new Map<string, string>()
  const native = await restrictedOwnerFixture({ projectId: 'idle-project', cwd, execute: async () => {}, ownerMcp: true,
    ownerTurn: async call => {
      turn++
      const invoke = async (args: Record<string, unknown>) => {
        const response = (await call(args)).result as { success: boolean; contentItems: Array<{ text: string }> }
        expect(response.success).toBe(true)
        return JSON.parse(response.contentItems[0]!.text)
      }
      for (const name of revoked ? ['survivor'] : ['revoked', 'survivor']) {
        if (!handles.has(name)) handles.set(name, (await invoke({ action: 'open', server: name })).handle)
        expect((await invoke({ action: 'request', handle: handles.get(name), method: 'resources/read', params: { uri: 'fixture://one' } })).contents[0].text).toBe('fixture text')
      }
      if (revoked) expect((await call({ action: 'request', handle: handles.get('revoked'), method: 'tools/list' })).result).toMatchObject({ success: false })
    } })
  cleanups.push(() => native.close())
  native.bindings.resolveApprovedServers = async () => (revoked && change === 'denied' ? ['survivor'] : ['revoked', 'survivor']).map(name => ({ name, command: process.execPath,
    args: [fileURLToPath(new URL('../../runtime/adapters/codex-cli/persistent/fixtures/approved-mcp-server.ts', import.meta.url))],
    env_names: ['BROKER_TEST_LOG', 'BROKER_TEST_VALUE'], env: { BROKER_TEST_LOG: join(cwd, name), BROKER_TEST_VALUE: name === 'revoked' && revoked ? 'rotated' : 'initial' } }))
  const chat = async () => {
    const events = []
    for await (const event of native.bindings.start('idle-project', { prompt: 'chat', tools: [], model_preference: [] }).events) events.push(event)
    expect(events.at(-1)?.kind).toBe('completion')
    expect(native.errors).toEqual([])
  }
  await chat()
  const pid = async (name: string) => Number((await readFile(join(cwd, `${name}.pid`), 'utf8')).trim())
  const revokedPid = await pid('revoked'), survivorPid = await pid('survivor')
  const alive = (id: number) => { try { process.kill(id, 0); return true } catch { return false } }
  expect(alive(revokedPid)).toBe(true)
  expect(alive(survivorPid)).toBe(true)
  await native.bindings.retireRevokedMcpServers()
  expect(alive(revokedPid)).toBe(true)
  expect(alive(survivorPid)).toBe(true)
  revoked = true
  await native.bindings.retireRevokedMcpServers()
  expect(alive(revokedPid)).toBe(false)
  expect(alive(survivorPid)).toBe(true)
  expect(turn).toBe(1) // No request, notification or successor turn triggered retirement.
  await chat()
  expect(await pid('survivor')).toBe(survivorPid)
  expect(native.opens()).toBe(1)
})

test('durable Open owner MCP reaches approved SDK peer, retains successor handles and refuses bounded turns', async () => {
  const f = await codexOwnerWithClaude()
  const log = join(f.context.projectDir, 'mcp-peer.log')
  let handle = '', ownerTurns = 0, boundedRefusals = 0, approved = true
  const native = await restrictedOwnerFixture({ projectId: f.context.projectId, cwd: f.context.projectDir,
    execute: literalWorker(f.world), ownerMcp: true,
    ownerTurn: async (call, prompt) => {
      const result = async (args: Record<string, unknown>) => {
        const envelope = await call(args)
        const value = envelope.result as { success: boolean; contentItems: Array<{ text: string }> }
        expect(value.success).toBe(true)
        return JSON.parse(value.contentItems[0]!.text)
      }
      if (prompt.startsWith('Execute the prompt in this JSON dispatch specification: ')) {
        const envelope = await call({ action: 'discover' })
        expect(envelope.error !== undefined || (envelope.result as { success?: boolean })?.success === false).toBe(true)
        boundedRefusals++
        return
      }
      ownerTurns++
      expect((await call({ action: 'discover' }, { threadId: 'native-child' })).error).toMatchObject({ code: -32001 })
      expect((await call({ action: 'discover' }, { turnId: 'predecessor-turn' })).error).toMatchObject({ code: -32001 })
      expect((await result({ action: 'discover' })).servers[0].name).toBe('approved')
      if (!handle) handle = (await result({ action: 'open', server: 'approved' })).handle
      expect((await result({ action: 'request', handle, method: 'resources/read', params: { uri: 'fixture://one' } })).contents[0].text).toBe('fixture text')
      await result({ action: 'request', handle, method: 'tools/call', params: { name: 'inspect', arguments: { progress: true }, _meta: { progressToken: `turn-${ownerTurns}` } } })
      if (ownerTurns === 2) {
        const received = await result({ action: 'receive', handle })
        expect(received.notifications.map((event: { params: { progressToken: string } }) => event.params.progressToken)).toEqual(['turn-2'])
      }
      if (ownerTurns === 3) {
        approved = false
        expect((await call({ action: 'request', handle, method: 'tools/list' })).result).toMatchObject({ success: false })
      }
    },
  })
  cleanups.push(() => native.close())
  native.bindings.resolveApprovedServers = async () => approved ? [{ name: 'approved', command: process.execPath,
    args: [fileURLToPath(new URL('../../runtime/adapters/codex-cli/persistent/fixtures/approved-mcp-server.ts', import.meta.url))],
    env_names: ['BROKER_TEST_LOG'], env: { BROKER_TEST_LOG: log } }] : []
  f.context.codexOwnerBindings = native.bindings
  const chat = async () => {
    const events = []
    for await (const event of native.bindings.start(f.context.projectId, { prompt: 'owner chat', tools: [], model_preference: [] }).events) events.push(event)
    expect(events.at(-1)?.kind).toBe('completion')
    expect(native.errors).toEqual([])
  }
  await chat()
  await chat()
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(boundedRefusals).toBeGreaterThan(0)
  await chat()
  expect(native.opens()).toBe(1)
  expect((await readFile(log, 'utf8')).split('\n').filter(line => line === 'spawn')).toHaveLength(1)
  expect(native.native.some(message => message.method === 'thread/start')).toBe(false)
}, 60_000)

// ─────────────────────────────────────────────────────────────────────────────
// THE LITERAL-MINDED WORKER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five top-level fields `decodeProjectTrailer` compares against the request
 * (`runtime/workers/project-runners.ts:48-59`). This list is the decoder's
 * vocabulary, and it is the ONLY thing this harness knows about the envelope —
 * it deliberately does not know which of them any particular brief asks for.
 */
const ENVELOPE_FIELDS = ['schema', 'run_id', 'step_id', 'kind', 'result'] as const

/**
 * WHICH TOP-LEVEL FIELDS DID THE BRIEF ACTUALLY ASK FOR?
 *
 * This is the whole point of the harness, so it is worth being precise about
 * what it models and what it does not.
 *
 * A worker writes the file its brief describes. The rule here is the most
 * literal reading of a brief there is: a field belongs in the result FILE only
 * if the brief names it, in double quotes, as a field — which is how #1033's
 * brief names them ("schema", "run_id", "step_id", "kind", "result"). The scan
 * stops at the embedded JSON payload schema, because that blob describes
 * `result.payload`, not the file, and its own keys must not be mistaken for
 * instructions about the envelope.
 *
 * When a brief names NONE of them, the only shape it has described is the inner
 * object, and that is what gets written — which is precisely what the plan
 * worker did on the third acceptance dispatch, and precisely what the host
 * rejected with "Trailer run_id missing or mismatched."
 *
 * THE LIMIT, STATED. A real model is not this literal: it also sees
 * `Request (data): {...}` in the dispatch prompt and might guess the envelope
 * from it. So a red here is "a worker that followed its brief exactly would
 * fail", not "every worker will fail". The live dispatch is the evidence that
 * the weaker claim is the one that matters: the real plan worker did follow the
 * brief exactly.
 */
export function envelopeFieldsNamedBy(brief: string): Set<string> {
  return new Set(ENVELOPE_FIELDS.filter(field => instructionsIn(brief).includes(`"${field}"`)))
}

/**
 * DATA A BRIEF CARRIES IS NOT INSTRUCTION A BRIEF GIVES.
 *
 * A role brief ends with `JSON.stringify(PLAN_SCHEMA | FORGE_SCHEMA |
 * VERDICT_SCHEMA)`, which describes `result.payload` and whose own keys must not
 * read as instructions about the file. A review-panel brief
 * (`createProjectReviewSource`) is JSON, and the measured diff it carries could
 * contain any text at all — including `"run_id"`. Both are stripped here, so a
 * brief only counts as naming a field when its prose names it.
 */
function instructionsIn(brief: string): string {
  try {
    const value: unknown = JSON.parse(brief)
    // A structured brief: only its string-valued fields are prose.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.values(value).filter(entry => typeof entry === 'string').join('\n')
    }
  } catch { /* a role brief is prose, not JSON */ }
  return brief.split('\n\n{"type":"object"')[0] ?? brief
}

type Runner = (argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) => Promise<HostCommandResult>

async function gitOut(run: Runner, cwd: string, args: string[]): Promise<string> {
  const result = await run(['git', '-C', cwd, ...args], cwd)
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

/**
 * Reproduce the host's own diff measurement (`production-host-effects.ts:203`)
 * from inside the worker. A build worker has to: the host context it was given
 * describes the revision BEFORE its commit, and `corroborates`
 * (`build-run.ts:151`) compares its trailer against the revision the host
 * measures AFTER. Same flags, same three-dot range, same range builder.
 */
async function measureDiff(run: Runner, repo: string, base: string, head: string, scratch: string): Promise<string> {
  const output = join(scratch, `diff-${head}-${Math.random().toString(36).slice(2)}.txt`)
  const result = await run(gitRangeArgv({ repo_path: repo, subcommand: 'diff',
    flags: ['--binary', '--no-ext-diff', '--no-textconv', '--full-index', `--output=${output}`],
    base, head, dots: '...' }), repo)
  if (!result.ok) throw new Error(`worker diff measurement failed: ${result.stderr}`)
  return readFile(output, 'utf8')
}

interface WorkerWorld {
  suiteReport?: (role: string, context: { findings: string[] }) => Promise<Record<string, unknown>>
  strategy: 'single' | 'task_sequence'
  plannerPatch?: Record<string, unknown>
  builderObservations: { strategy: unknown; rationale: unknown; plan: unknown; scope: unknown; previous: unknown; contextStrategy: unknown }[]
  readSelectedRun: (runId: string) => ReturnType<TridentRunStore['get']>
  reviewVeto?: 'standalone' | 'synthesis'
  numericBuildPr?: boolean
  mutationArgv?: 'bare' | 'valid'
  commitAttribution?: 'direct' | 'wrapped'
  extraBuildFiles?: Record<string, string>
  run: Runner
  repo: string
  scratch: string
  /**
   * BLOCKING FINDINGS THIS PANEL RAISES, BY HOST ROUND (1-based; index 0 unused).
   * Every seat and the synthesis read the SAME entry for the round they were
   * dispatched at, because `reviewPanel` compares the review worker's trailer with
   * the recorded synthesis field by field (`gates/review-panel.ts:104-105`) and
   * blocks on any disagreement. `0` — including every round past the end of this
   * array — is an APPROVE with no findings.
   */
  blockersByRound: readonly number[]
  /** Keep the first finding's identity stable across rounds to exercise G070. */
  repeatFirstFinding: boolean
  /**
   * ROUNDS WHOSE VERDICT ALSO DECLARES `escalate: { kind: 'design-gap', … }`.
   * That declaration — and only that declaration, with a nonempty `whatIsMissing`
   * and a verdict that is not APPROVE (`gates/escalation.ts:85-96,140`) — is what
   * turns the panel into `{ kind: 're-plan' }` instead of `{ kind: 'fix' }`.
   */
  replanRounds: readonly number[]
  /** ROUNDS WHOSE REVIEWER AND SYNTHESIS ANSWER WITH AN UNRESOLVED COMMENT. */
  commentRounds: ReadonlySet<number>
  /** ROUNDS WHOSE ADVERSARIAL PANEL SEAT CANNOT PRODUCE A VERDICT. */
  unavailableSeatRounds: ReadonlySet<number>
  /**
   * ROLES THIS WORKER REPORTS AS BLOCKED. Every role brief sanctions exactly this:
   * `"kind" — "completed" when you finished the role, or "blocked" when you could
   * not` plus `"on"` (`open/wiring/project-build.ts:190-192`), and
   * `decodeProjectTrailer` turns it into `{ kind: 'blocked', on }`
   * (`runtime/workers/project-runners.ts:54-57`). It does no role work first,
   * because a blocked worker did none.
   */
  blockRoles: ReadonlySet<string>
  /** Every dispatch this fake observed, in order — the harness's audit trail. */
  dispatches: { role: string; step_id: string; schema: string; wrote: string[]; measuredHead?: string; resultPath?: string }[]
  /** The task the host handed each build turn after planner validation. */
  selectedTasks: string[]
  /** The planner route the real driver wrote into each plan turn's context. */
  plannerChoices: string[]
  /** The committed ledger bytes the real driver handed each plan turn (`committedPlan.body`). */
  committedPlans: (string | undefined)[]
  /**
   * THE HOST IS THE ONLY LEDGER WRITER. When set, a build worker never writes a
   * ledger itself (not even the legacy root `IMPLEMENTATION_PLAN.md`; it still records
   * the task it was handed), so the only ledger a continuation can find is the one
   * `commitLedger` committed at the branch's own `.trident/ledgers/<branch>.md`
   * (`trident/build-run.ts`, the task-sequence handoff).
   */
  hostLedger?: boolean
  synthesisShape: 'legacy' | 'schema-guided' | 'malformed' | 'independent'
  synthesisSchemaSeen: boolean[]
}

/**
 * ONE PANEL VERDICT FOR ONE ROUND, shared by the review role, the adversarial seat
 * and the synthesis.
 *
 * `severity: 'major'` is what makes a finding BLOCKING (`review-panel.ts:107` keeps
 * everything that is not `minor`/`nit`), which is what turns the decision into
 * `{ kind: 'fix' }` (`review-panel.ts:118-121`).
 *
 * THE IDENTITY CARRIES THE ROUND. `findingIdentity` is `file:symbol:rule`
 * (`gates/escalation.ts:25-31`), and G070 blocks the run if a finding from the
 * previous panel reappears (`gates/review-progress.ts:16`). A harness whose rounds
 * all raised the same finding would therefore stop on `repeated finding` and never
 * reach a second fix — so the symbol names the round it came from.
 */
function verdictFor(world: WorkerWorld, round: number) {
  const blockers = world.blockersByRound[round] ?? 0
  return {
    verdict: world.commentRounds.has(round) ? 'COMMENT' : blockers > 0 ? 'REQUEST_CHANGES' : 'APPROVE',
    findings: Array.from({ length: blockers }, (_, index) => ({
      severity: 'major',
      title: `NOTES.md is missing the round ${round} marker (${index})`,
      evidence: `NOTES.md carries no marker for round ${round}, finding ${index}`,
      file: 'NOTES.md', symbol: world.repeatFirstFinding && index === 0 ? 'note-repeated-f0' : `note-r${round}-f${index}`,
      rule: 'harness-round-blocker', line: 1,
    })),
    ...(world.replanRounds.includes(round)
      ? { escalate: { kind: 'design-gap', whatIsMissing: `the round ${round} spec never said where the marker goes` } }
      : {}),
  }
}

/** Review identities additionally bind the full measured revision. */
const roundOfStep = (step_id: string): number => Number(step_id.match(/:(?:plan|build|fix|review):(\d+)(?::head:[a-f0-9]{40})?$/)?.[1])

function dispatchStep(dispatch: WorkerWorld['dispatches'][number]): string {
  if (dispatch.role !== 'review' || dispatch.schema === 'verdict') return dispatch.step_id
  expect(dispatch.measuredHead).toMatch(/^[a-f0-9]{40}$/)
  expect(dispatch.step_id.endsWith(`:head:${dispatch.measuredHead}`)).toBe(true)
  return dispatch.step_id.slice(0, -46)
}

const standaloneReview = (world: WorkerWorld) => world.dispatches.find(dispatch => dispatch.schema === 'project-review')!

/**
 * THE ONLY FAKE MODEL IN THIS FILE.
 *
 * `createClaudeActingTurn` calls `child.submitLine` with
 *   'Execute the prompt in this JSON dispatch specification: ' + JSON.stringify(spec)
 * and `claudeInReplRunner` composed that spec's prompt as
 *   '…Forward the arguments as data…' + JSON.stringify({ …, prompt: 'Request (data): {…}' })
 * so the request reaches this function exactly as it reaches a live worker.
 */
function literalWorker(world: WorkerWorld) {
  return async function submitLine(line: string): Promise<void> {
    const spec = JSON.parse(line.slice(line.indexOf('{')))
    const args = JSON.parse(String(spec.prompt).slice(String(spec.prompt).indexOf('{')))
    const marker = 'Request (data): '
    const requestLine = String(args.prompt ?? args.message).split('\n').find((row: string) => row.startsWith(marker))
    if (!requestLine) throw new Error('dispatch prompt carried no request')
    const request: BoundedWorkRequest = JSON.parse(requestLine.slice(marker.length))

    const brief = await readFile(request.brief.path, 'utf8')
    const panelRound = request.result.schema === 'verdict' ? JSON.parse(brief).round as number : undefined
    const stopped = world.blockRoles.has(request.role)
      || (request.role === 'review' && panelRound !== undefined && world.unavailableSeatRounds.has(panelRound))
    let inner = stopped ? undefined : await performRole(world, request, brief)
    if ((world.reviewVeto === 'standalone' && request.role === 'review' && request.result.schema !== 'verdict')
        || (world.reviewVeto === 'synthesis' && request.role === 'synthesis')) {
      const veto = { verdict: 'COMMENT', findings: [] }
      inner = request.result.schema === 'verdict' ? veto : { ...(inner as object), payload: veto }
    }
    if (world.numericBuildPr && request.role === 'build') inner = { ...(inner as object), pr: 17 }

    // Write ONLY what the brief asked for. See `envelopeFieldsNamedBy`. A blocked
    // answer OMITS `result` and ADDS `on`, exactly as the brief words it.
    const named = envelopeFieldsNamedBy(brief)
    const envelope: Record<string, unknown> = { schema: request.result.schema, run_id: request.run_id,
      step_id: request.step_id, kind: stopped ? 'blocked' : 'completed', result: inner }
    const body = named.size === 0 ? inner : {
      ...Object.fromEntries([...named].filter(field => !(stopped && field === 'result'))
        .map(field => [field, envelope[field]])),
      ...(stopped ? { on: `harness: the ${request.role} worker was stopped mid-turn` } : {}),
    }
    world.dispatches.push({ role: request.role, step_id: request.step_id,
      schema: request.result.schema, wrote: Object.keys(body as object).sort(), resultPath: request.result.path,
      ...(request.role === 'review' ? { measuredHead: await gitOut(world.run, request.cwd, ['rev-parse', 'HEAD']) } : {}) })
    // The dispatch prompt asks for a temporary file and a rename, so do that.
    await writeFile(`${request.result.path}.tmp`, JSON.stringify(body), { mode: 0o600 })
    await rename(`${request.result.path}.tmp`, request.result.path)
  }
}

/** What each role produces, done for real in the real worktree. */
async function performRole(world: WorkerWorld, request: BoundedWorkRequest, brief: string): Promise<unknown> {
  // A review-panel seat (`createProjectReviewSource`) dispatches under the bare
  // `verdict` schema, and its brief is the panel's own JSON, not a role brief. Its
  // step id is per DIRECTORY, round and attempt (`project-review-source.ts:99`), so
  // the round comes from the brief the source wrote, not from the step id.
  if (request.result.schema === 'verdict') {
    const panelBrief = JSON.parse(brief)
    const verdict = verdictFor(world, panelBrief.round)
    if (request.role !== 'synthesis' || world.synthesisShape === 'legacy') return verdict
    if (world.synthesisShape === 'independent') {
      // The synthesis is a separate worker, not an echo of the top-level review
      // worker. In the live failure both returned valid REQUEST_CHANGES verdicts
      // but the synthesis added independently reasoned findings. A different
      // finding identity is enough to exercise the real trailer comparison.
      return panelBrief.round === 1 && verdict.findings.length > 0
        ? { ...verdict, findings: verdict.findings.map(finding => ({ ...finding,
            title: `Synthesis independently found: ${finding.title}`,
            symbol: `synthesis-${finding.symbol}` })) }
        : verdict
    }
    const hasSchema = JSON.stringify(panelBrief.verdictSchema) === JSON.stringify(VERDICT_SCHEMA)
    world.synthesisSchemaSeen.push(hasSchema)
    // A worker told only to account for each seat can plausibly add a summary.
    // The strict host contract rejects it. The malformed control adds it even
    // after seeing the schema, proving the gate was not relaxed to make merge pass.
    return hasSchema && world.synthesisShape === 'schema-guided'
      ? verdict : { ...verdict, synthesis: 'All supplied seats approve.' }
  }

  // Every role brief points at the host turn context, which the host wrote in
  // `prepareWork` (`production-host-effects.ts:451`) and whose path the brief
  // itself names. That is where the measured snapshot lives.
  const context = JSON.parse(await readFile(workContextPath(request.brief.path), 'utf8'))
  const snapshot = context.snapshot as { head: string; diff: string; pr: unknown }
  const cwd = request.cwd

  if (request.role === 'plan') {
    // A plan turn writes no commit, so the measured revision is unchanged.
    world.plannerChoices.push(context.planner)
    world.committedPlans.push(context.committedPlan?.body)
    if (context.planner === 'next') {
      // THE WORKER MUST NOT DO G029'S JOB. This used to read `context.committedPlan`
      // and emit the first unchecked task and the remaining count itself — so the
      // case passed whether or not `build-run.ts:438` replaced them, and a review
      // lane proved it by deleting that guard and watching the test stay green.
      //
      // The worker is a MODEL: it returns a plausible, UNTRUSTED claim, and here a
      // deliberately wrong one. Only the host's measured replacement can turn that
      // into the real task, so the assertions below now have exactly one source.
      return { ...snapshot, payload: {
        strategy: world.strategy, rationale: 'Tasks have independently verifiable execution boundaries.',
        implementationPlan: 'WORKER CLAIM — not the committed plan',
        topTask: '- [ ] WORKER INVENTED a task that is not in the committed plan',
        executionSpec: 'Complete the worker-invented task',
        complexity: 'mechanical',
        remainingTasks: 99,
      } }
    }
    const more = brief.includes('MORE TASKS')
    const payload = {
      strategy: world.strategy, rationale: 'The accepted plan determines the useful execution boundary.',
      implementationPlan: `- [ ] T1 record the note\n${more ? '- [ ] T2 record another note\n' : ''}`,
      topTask: world.strategy === 'single' ? 'Complete every task in the accepted plan' : '- [ ] T1 record the note',
      executionSpec: world.strategy === 'single' && more ? 'Record both requested notes and commit the complete change.' : 'Append one line to NOTES.md and commit it.',
      complexity: 'mechanical',
      remainingTasks: world.strategy === 'task_sequence' && more ? 1 : 0,
      ...world.plannerPatch,
    }
    if (request.result.schema === 'project-plan') {
      const { strategy: _strategy, rationale: _rationale, ...legacy } = payload
      return { ...snapshot, payload: legacy }
    }
    return { ...snapshot, payload }
  }

  if (request.role === 'build' || request.role === 'fix') {
    if (request.role === 'build') {
      const row = world.readSelectedRun(request.run_id)!
      world.builderObservations.push({ strategy: row.execution_strategy, rationale: row.strategy_rationale,
        plan: row.strategy_plan, scope: context.suiteScope, previous: context.previous, contextStrategy: context.executionStrategy })
    }
    const selected = context.previous as { implementationPlan?: string; topTask?: string }
    const commitsPlan = request.role === 'build' && selected.topTask
      && selected.implementationPlan?.includes('T2 record another note')
    if (commitsPlan && selected.topTask && selected.implementationPlan) {
      if (context.executionStrategy === 'single') {
        expect(brief).toContain('implement the WHOLE accepted plan')
        world.selectedTasks.push(...selected.implementationPlan.split('\n').filter(line => line.startsWith('- [ ] ')))
      } else {
        expect(brief).toContain('implement only the host-selected `topTask`')
        world.selectedTasks.push(selected.topTask)
      }
      if (!world.hostLedger) await writeFile(join(cwd, 'IMPLEMENTATION_PLAN.md'),
        selected.implementationPlan.replace(selected.topTask, selected.topTask.replace('- [ ]', '- [x]')))
    }
    const branch = await gitOut(world.run, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // Prose only, deliberately: `runMutationProofGate` exempts a prose-only diff
    // (`mutation-prover.ts:3814`), which is the one publish path that does not
    // require running a real guard/control test pair on this box.
    const notes = join(cwd, 'NOTES.md')
    const previous = await readFile(notes, 'utf8').catch(() => '')
    await writeFile(notes, `${previous}${request.step_id}\n`)
    for (const [file, bytes] of Object.entries(world.extraBuildFiles ?? {})) {
      await mkdir(dirname(join(cwd, file)), { recursive: true })
      await writeFile(join(cwd, file), bytes)
      await gitOut(world.run, cwd, ['add', '--', file])
    }
    if (world.mutationArgv) {
      await mkdir(join(cwd, 'src'), { recursive: true })
      await mkdir(join(cwd, 'tests'), { recursive: true })
      await writeFile(join(cwd, 'src/limit.ts'), 'export const limit = (n: number, max: number) => n > max ? max : n\n')
      await writeFile(join(cwd, 'tests/limit.test.ts'), "import { test, expect } from 'bun:test'\nimport { limit } from '../src/limit.ts'\ntest('clamps', () => expect(limit(7, 3)).toBe(3))\n")
      await writeFile(join(cwd, 'tests/control.test.ts'), "import { test, expect } from 'bun:test'\nimport { limit } from '../src/limit.ts'\ntest('preserves', () => expect(limit(2, 3)).toBe(2))\n")
      await gitOut(world.run, cwd, ['add', '--', 'src/limit.ts', 'tests/limit.test.ts', 'tests/control.test.ts'])
    }
    await gitOut(world.run, cwd, ['add', '--', 'NOTES.md',
      ...(commitsPlan && !world.hostLedger ? ['IMPLEMENTATION_PLAN.md'] : [])])
    const commitArgs = ['-m', `work: ${request.role} ${request.step_id}`,
      ...(world.commitAttribution ? ['-m', 'Claude-Session: fixture\nCo-Authored-By: Fixture <fixture@example.invalid>'] : [])]
    if (world.commitAttribution === 'wrapped') {
      expect(brief).toContain('Commit only through the host wrapper with argv')
      const wrapped = await world.run(['bash', fileURLToPath(new URL('../../trident/commit-with-resolved-head.sh', import.meta.url)), branch, ...commitArgs], cwd)
      if (!wrapped.ok) throw Error('fixture commit wrapper refused')
    } else await gitOut(world.run, cwd, ['-c', 'user.email=w@example.invalid', '-c', 'user.name=Worker',
      '-c', 'commit.gpgsign=false', 'commit', ...commitArgs])
    // Measure the produced revision from the only base this worker was given.
    //
    // THE BASE IS THE PRE-DISPATCH HEAD. On the FIRST build that happens to be the
    // launch pin, because `prepareProjectBuild` cut the branch at it — so the diff
    // coincides with the host's. ON A FIX ROUND IT IS NOT: the pre-dispatch head is
    // the reviewed commit, and the host still measures from `base_sha`
    // (`production-host-effects.ts:223`), so this diff covers the fix commit alone
    // while the host's covers the whole branch. The host turn context carries no
    // `base_sha` (`prepareWork` writes `{request, snapshot, previous, findings, …}`,
    // `production-host-effects.ts:453`), so a fix worker CANNOT reconstruct it.
    //
    // That is exactly the disagreement #1041 removed: the trailer is corroborated
    // on `head` and `pr`, not on diff bytes (`claimMatches`, `build-run.ts:182-186`).
    // Leaving this measurement deliberately wrong on a fix round is what gives the
    // fix-round case its teeth — restore `corroborates` there and it goes red.
    const head = await gitOut(world.run, world.repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
    const diff = await measureDiff(world.run, world.repo, snapshot.head, head, world.scratch)
    return { head, diff, pr: snapshot.pr, payload: {
      mutationClaim: world.mutationArgv ? { file: 'src/limit.ts', find: 'n > max ? max : n', replace: 'n',
        guard: [...(world.mutationArgv === 'valid' ? ['bun', 'test'] : []), 'tests/limit.test.ts'],
        control: [...(world.mutationArgv === 'valid' ? ['bun', 'test'] : []), 'tests/control.test.ts'] } : null,
      worktreePath: cwd, branch, commitSha: head, prNumber: null,
      diffFile: '', testsPassed: true, suiteOutcome: 'passed', suiteEvidence: 'harness stub suite',
      ...(await world.suiteReport?.(request.role, context) ?? {}),
    } }
  }

  // review: read-only, so the measured revision must be the one it was handed. Its
  // payload must equal the recorded synthesis field for field, so both read
  // `verdictFor` at the round the host stamped into this dispatch's step id.
  return { ...snapshot, payload: verdictFor(world, roundOfStep(request.step_id)) }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FAKE GITHUB
// ─────────────────────────────────────────────────────────────────────────────

interface FakePr { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; headRefName: string; baseRefName: string; isDraft?: boolean }

function fakeGithub(input: { origin: string; repo: string }) {
  const prs: FakePr[] = []
  const settings = { draftCreated: false }
  /** `gh pr <verb>`s this fake refuses, so a case can stop the driver at a chosen
   *  point without touching the driver. Mutable so one fixture can refuse and
   *  then relent, which is what a restarted build meets. */
  const refuse = new Set<string>()
  const ok = (stdout = ''): HostCommandResult => ({ ok: true, exit_code: 0, stdout, stderr: '' })
  const json = (value: unknown) => ok(JSON.stringify(value))
  const headOf = async (branch: string) => {
    const result = await spawnCapture(['git', '-C', input.origin, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`], input.origin)
    return result.ok ? result.stdout.trim() : ''
  }
  const project = async (pr: FakePr, fields: string[]) => {
    const all: Record<string, unknown> = { number: pr.number, state: pr.state, headRefName: pr.headRefName,
      baseRefName: pr.baseRefName, baseRefOid: await headOf(pr.baseRefName), isCrossRepository: false, headRefOid: await headOf(pr.headRefName), mergeable: 'MERGEABLE', isDraft: pr.isDraft ?? false }
    return Object.fromEntries(fields.map(field => [field, all[field]]))
  }
  const checkRuns = { total_count: 1, check_runs: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  return {
    prs, refuse, settings, checkRuns,
    async handle(argv: string[]): Promise<HostCommandResult> {
      const [, verb, ...rest] = argv
      if (verb === 'api') {
        const path = rest[0]!
        if (path.includes('/protection/required_status_checks')) return json({ contexts: ['test'], checks: [{ context: 'test' }] })
        if (path.includes('/rules/branches/')) return json([])
        if (path.includes('/check-runs')) return json(checkRuns)
        if (path.includes('/status')) return json({ total_count: 0, statuses: [] })
        if (/\/branches\/[^/]+$/.test(path)) return json({ protected: true })
        return { ok: false, exit_code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
      }
      if (verb !== 'pr') throw new Error(`fake gh does not implement: ${argv.join(' ')}`)
      const action = rest[0]
      if (action !== undefined && refuse.has(action)) {
        return { ok: false, exit_code: 1, stdout: '', stderr: `fake gh refuses pr ${action}` }
      }
      const fields = (rest[rest.indexOf('--json') + 1] ?? '').split(',').filter(Boolean)
      if (action === 'list') {
        const branch = rest[rest.indexOf('--head') + 1]
        const matches = prs.filter(pr => pr.headRefName === branch)
        return json(await Promise.all(matches.map(pr => project(pr, fields))))
      }
      if (action === 'view') {
        const pr = prs.find(row => row.number === Number(rest[1]))
        if (!pr) return { ok: false, exit_code: 1, stdout: '', stderr: 'no pull requests found' }
        return json(await project(pr, fields))
      }
      if (action === 'create') {
        const pr: FakePr = { number: prs.length + 1, state: 'OPEN', isDraft: settings.draftCreated,
          headRefName: rest[rest.indexOf('--head') + 1]!, baseRefName: rest[rest.indexOf('--base') + 1]! }
        prs.push(pr)
        // Real `gh pr create` prints the owner/repo URL; publication parses it for provenance.
        return ok(`https://example.invalid/project/repo/pull/${pr.number}`)
      }
      if (action === 'merge') {
        const pr = prs.find(row => row.number === Number(rest[1]))
        if (!pr) return { ok: false, exit_code: 1, stdout: '', stderr: 'no pull requests found' }
        if (pr.isDraft) return { ok: false, exit_code: 1, stdout: '', stderr: 'Pull request is still a draft' }
        const head = await headOf(pr.headRefName)
        if (rest[rest.indexOf('--match-head-commit') + 1] !== head) {
          return { ok: false, exit_code: 1, stdout: '', stderr: 'head commit changed' }
        }
        // A REAL fast-forward of the real base branch in the real bare origin.
        const pushed = await spawnCapture(['git', '-C', input.repo, 'push', input.origin,
          `${head}:refs/heads/${pr.baseRefName}`], input.repo)
        if (!pushed.ok) return { ok: false, exit_code: 1, stdout: '', stderr: pushed.stderr }
        pr.state = 'MERGED'
        return ok('Merged')
      }
      if (action === 'ready') {
        const pr = prs.find(row => row.number === Number(rest[1]))
        if (!pr || pr.state !== 'OPEN') return { ok: false, exit_code: 1, stdout: '', stderr: 'no open pull request found' }
        pr.isDraft = false
        return ok()
      }
      throw new Error(`fake gh does not implement: ${argv.join(' ')}`)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FIXTURE
// ─────────────────────────────────────────────────────────────────────────────

const LEAK_GATE_STUB = '#!/usr/bin/env bash\necho "LEAK GATE: SILENT"\nexit 0\n'

/**
 * THE HOST'S OWN SUITE RUN, AND WHY THIS FIXTURE PINS IT.
 *
 * G063 needs a HOST-observed suite receipt, not the builder's claim. `readCheckpoint`
 * (`open/wiring/project-build.ts:461-467`) pulls the command out of the test strategy
 * with `fullSuiteCommand`, which takes the indented lines under the exact marker
 * `Full suite (stage 2), run exactly this` (`project-build.ts:162`), runs it in the run
 * worktree, and records the process exit code. With no such marker there is no command,
 * the report is `null`, and `assessReviewSuite` reports that no full-suite command
 * is derivable from the strategy (`gates/review-suite.ts:51`) for every card —
 * measured: that is exactly how this
 * harness failed when #1040 landed after it was written.
 *
 * PINNED, NOT AMBIENT, in two ways. The command is a script COMMITTED TO THIS
 * FIXTURE'S OWN REPO and named by a RELATIVE path, so it resolves only if the host
 * really runs it in the worktree; and its exit status is `suiteExit` and nothing
 * else, so a green receipt here is this fixture's decision rather than whatever
 * `bun test` would have done to a temporary directory.
 */
const suiteScript = (exit: number) => `#!/usr/bin/env bash\necho "HARNESS SUITE ran in $PWD"\nexit ${exit}\n`
const suiteStrategy = 'TEST EXECUTION: run the card regression.\n\n'
  + 'Full suite (stage 2), run exactly this:\n\n  bash scripts/ci/suite.sh\n'

/**
 * A LOCAL CODEX EXECUTABLE, NOT A FAKE RUNNER. Production composition still
 * constructs `createCodexHeadlessRunner`, probes the CLI contract and routes the
 * configured cross-provider seat through it. This executable replaces only the
 * final network boundary: it records the exact process request and writes the
 * structured final message a successful Codex turn would have written.
 */
const fakeCodex = (calls: string, identity: 'valid' | 'wrong-run') => `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(`${calls}.invocations`)}, JSON.stringify(argv) + '\\n')
if (argv[0] === '--version' || (argv[0] === 'login' && argv[1] === 'status')) process.exit(0)
if (argv.includes('--help')) {
  console.log('--output-schema --json --output-last-message --ignore-rules')
  process.exit(0)
}
if (argv.includes('--strict-config')) {
  console.error('unknown configuration field neutron_codex_contract_probe_sentinel in -c/--config override')
  process.exit(1)
}
const prompt = readFileSync(0, 'utf8')
const requestLine = prompt.split('\\n').find(line => line.startsWith('Request (data): '))
if (!requestLine) process.exit(91)
const request = JSON.parse(requestLine.slice('Request (data): '.length))
const brief = JSON.parse(readFileSync(request.brief.path, 'utf8'))
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, cwd: process.cwd(), request, brief }) + '\\n')
const output = argv[argv.indexOf('-o') + 1]
const envelope = { schema: request.result.schema,
  run_id: ${identity === 'wrong-run' ? "'some-other-run'" : 'request.run_id'}, step_id: request.step_id,
  kind: 'completed', result: { verdict: 'APPROVE', findings: [] } }
writeFileSync(output, JSON.stringify({ envelope }))
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'e2e-codex-thread' }))
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }))
`

/** Only the Claude process boundary is simulated; the host still validates,
 * persists and consumes the real headless runner's structured result. */
const fakeClaude = (calls: string, identity: 'valid' | 'wrong-schema') => `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs'
const argv = process.argv.slice(2)
if (argv.includes('--help')) {
  console.log('--safe-mode --restricted --permission-prompts --permission-mode --tools --strict-mcp-config --mcp-config --disable-slash-commands --session-id --resume --setting-sources --model --effort --output-format --json-schema --add-dir')
  process.exit(0)
}
if (argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: process.env.CLAUDE_CODE_OAUTH_TOKEN === 'fixture-selected-claude' })); process.exit(0) }
const prompt = readFileSync(0, 'utf8')
const request = JSON.parse(prompt.split('\\n').find(line => line.startsWith('Request (data): ')).slice('Request (data): '.length))
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, request, env: process.env, prompt }) + '\\n')
const verdict = { verdict: 'APPROVE', findings: [] }
let result = verdict
if (request.result.schema !== 'verdict') {
  const context = JSON.parse(readFileSync(request.brief.path + '.context.json', 'utf8'))
  result = { ...context.snapshot, payload: request.role === 'plan' ? {
    strategy: 'single', rationale: 'The complete plan fits in one implementation turn.',
    implementationPlan: '- [ ] T1 record the note', topTask: '- [ ] T1 record the note',
    executionSpec: 'Append one line to NOTES.md and commit it.', complexity: 'mechanical', remainingTasks: 0,
  } : verdict }
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, permission_denials: [],
  session_id: argv[argv.indexOf(argv.includes('--resume') ? '--resume' : '--session-id') + 1],
  modelUsage: { [request.model_id.startsWith('claude-') ? request.model_id : 'claude-' + request.model_id + '-fixture']: {} }, usage: { input_tokens: 7, output_tokens: 3 },
  structured_output: { schema: ${identity === 'wrong-schema' ? "'unrequested-schema'" : 'request.result.schema'},
    run_id: request.run_id, step_id: request.step_id, kind: 'completed', result } }))
`

async function fixture(options: { taskSequence?: boolean; moreTasks?: boolean; suiteExit?: number; testStrategy?: string
  namedSuiteFailure?: boolean | 'generic'
  spec?: boolean
  /** `false`: the seed commit carries NO `IMPLEMENTATION_PLAN.md` (default `true`). */
  seedLedger?: boolean
  /** See `WorkerWorld.hostLedger` (default `false`). */
  hostLedger?: boolean
  bunWorkspace?: boolean
  bunWorkspacePeer?: boolean
  manifest?: Record<string, unknown>
  dispatchTask?: string
  blockersByRound?: readonly number[]; replanRounds?: readonly number[]
  maxRounds?: number; mergeMode?: 'pr' | 'local'; blockRoles?: readonly string[]
  repeatFirstFinding?: boolean; commentRounds?: readonly number[]
  unavailableSeatRounds?: readonly number[]; codexReview?: 'valid' | 'wrong-run'
  synthesisShape?: WorkerWorld['synthesisShape']; rateLimitedSynthesis?: boolean; nativeUsage?: boolean
  /** Real session ownership with only the model boundary held at a barrier. */
  reviewChild?: (request: BoundedWorkRequest, seat: string) => Promise<void>
  reviewVeto?: 'standalone' | 'synthesis'
  efficiencyTrace?: EfficiencyTrace
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'project-build-e2e-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'code')
  const scratch = join(dir, 'scratch')
  await mkdir(scratch, { recursive: true })
  const codexCalls = join(dir, 'codex-calls.jsonl')
  let codexHome: string | undefined
  let codexBin: string | undefined
  if (options.codexReview) {
    codexHome = join(dir, 'codex-home')
    codexBin = join(dir, 'bin')
    await mkdir(codexHome, { recursive: true })
    await mkdir(codexBin, { recursive: true })
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null,
      tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' },
      last_refresh: '2026-01-01T00:00:00.000Z' }), { mode: 0o600 })
    const executable = join(codexBin, 'codex')
    await writeFile(executable, fakeCodex(codexCalls, options.codexReview))
    await chmod(executable, 0o755)
  }

  const git = async (cwd: string, args: string[]) => {
    const result = await spawnCapture(['git', '-C', cwd, ...args], cwd)
    if (!result.ok) throw new Error(`setup: git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  await spawnCapture(['git', 'init', '--bare', '--initial-branch=main', origin], dir)
  await spawnCapture(['git', 'init', '--initial-branch=main', repo], dir)
  await git(repo, ['config', 'user.email', 'harness@example.invalid'])
  await git(repo, ['config', 'user.name', 'Harness'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  await mkdir(join(repo, 'scripts', 'ci'), { recursive: true })
  // The repo OPTS IN to the leak gate; `runLeakGatePreflight` probes for exactly
  // this path before it runs anything (`leak-preflight.ts:281`).
  await writeFile(join(repo, 'scripts', 'ci', 'leak-gate.sh'), LEAK_GATE_STUB, { mode: 0o755 })
  await writeFile(join(repo, 'scripts', 'ci', 'suite.sh'), suiteScript(options.suiteExit ?? 0), { mode: 0o755 })
  if (options.namedSuiteFailure) {
    await mkdir(join(repo, 'tests'), { recursive: true })
    if (options.namedSuiteFailure === 'generic') {
      await writeFile(join(repo, 'tests', 'preexisting.test.sh'), "echo 'tests/preexisting.test.sh: pre-existing red'\nexit 1\n")
      await writeFile(join(repo, 'scripts', 'ci', 'suite.sh'), 'bash ./tests/preexisting.test.sh\n')
    } else {
      await writeFile(join(repo, 'tests', 'preexisting.test.ts'), "import { expect, test } from 'bun:test'\ntest('pre-existing red', () => expect(false).toBe(true))\n")
      await writeFile(join(repo, 'scripts', 'ci', 'suite.sh'), 'bun test ./tests/preexisting.test.ts\n')
    }
  }
  if (options.manifest) await writeFile(join(repo, 'package.json'), JSON.stringify(options.manifest))
  if (options.bunWorkspace) {
    // A real tarball dependency keeps this fixture offline while exercising Bun's
    // isolated store and package-local resolution, just like the production suite.
    await mkdir(join(repo, 'app'), { recursive: true })
    await mkdir(join(repo, 'vendor', 'package'), { recursive: true })
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['app'],
      scripts: { postinstall: 'touch lifecycle-ran' } }))
    await writeFile(join(repo, 'bunfig.toml'), '[install]\nlinker = "isolated"\n')
    await writeFile(join(repo, 'vendor', 'package', 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: 'index.js' }))
    await writeFile(join(repo, 'vendor', 'package', 'index.js'), 'exports.message = "dependency consumed"\n')
    const packed = await spawnCapture(['tar', '-czf', 'dependency.tgz', 'package'], join(repo, 'vendor'))
    expect(packed.ok).toBe(true)
    if (options.bunWorkspacePeer) {
      await mkdir(join(repo, 'vendor', 'peer'), { recursive: true })
      await writeFile(join(repo, 'vendor', 'peer', 'package.json'), JSON.stringify({ name: 'fixture-peer', version: '1.0.0', main: 'index.js' }))
      await writeFile(join(repo, 'vendor', 'peer', 'index.js'), 'exports.message = "local peer"\n')
      expect((await spawnCapture(['tar', '-czf', 'peer.tgz', 'peer'], join(repo, 'vendor'))).ok).toBe(true)
    }
    await writeFile(join(repo, 'app', 'package.json'), JSON.stringify({ name: 'fixture-app', dependencies: { 'fixture-dependency': 'file:../vendor/dependency.tgz' },
      ...(options.bunWorkspacePeer ? { peerDependencies: { 'fixture-peer': 'file:../vendor/peer.tgz' } } : {}) }))
    await writeFile(join(repo, 'app', 'check.ts'), 'import { message } from "fixture-dependency"; if (message !== "dependency consumed") throw Error("wrong dependency"); console.log(message)\n'
      + (options.bunWorkspacePeer ? 'import { message as peer } from "fixture-peer"; if (peer !== "local peer") throw Error("wrong peer");\n' : ''))
    await writeFile(join(repo, 'scripts', 'ci', 'verify-workspace-deps.ts'), await readFile(new URL('../../scripts/ci/verify-workspace-deps.ts', import.meta.url), 'utf8'))
    await writeFile(join(repo, 'scripts', 'ci', 'suite.sh'), '#!/usr/bin/env bash\nset -e\nbun scripts/ci/verify-workspace-deps.ts\nbun app/check.ts\n')
    const installed = await spawnCapture(['bun', 'install'], repo, { BUN_INSTALL_CACHE_DIR: join(dir, 'bun-cache') })
    expect(installed.ok, installed.stderr).toBe(true)
    // Positive control: this lifecycle script really runs without --ignore-scripts.
    expect(await readFile(join(repo, 'lifecycle-ran'), 'utf8')).toBe('')
    await rm(join(repo, 'lifecycle-ran'))
    await rm(join(repo, 'node_modules'), { recursive: true, force: true })
    await rm(join(repo, 'app', 'node_modules'), { recursive: true, force: true })
  }
  await writeFile(join(repo, 'NOTES.md'), 'seed\n')
  if (options.spec) await writeFile(join(repo, 'SPEC.md'), '# Project specification\n\nRecord and verify notes.\n')
  if (options.seedLedger ?? true) {
    await writeFile(join(repo, 'IMPLEMENTATION_PLAN.md'),
      `- [ ] T1 record the note\n${options.moreTasks ? '- [ ] T2 record another note\n' : ''}`)
  }
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'chore: seed'])
  await git(repo, ['remote', 'add', 'origin', origin])
  await git(repo, ['push', '-u', 'origin', 'main'])
  const baseSha = await git(repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}'])

  await writeFile(join(dir, 'project-repos.json'), JSON.stringify({
    repos: [{ name: 'project', path: 'code', remote: null, ciWorkflow: 'ci.yml' }], default: 'project' }))

  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(() => db.close())
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: options.dispatchTask ? slugifyTask(options.dispatchTask) : 'card', project_slug: 'project', repo_path: repo,
    task: options.dispatchTask ?? `Record a note in NOTES.md.${options.moreTasks ? '\nMORE TASKS' : ''}`,
    // The review round ceiling is read off THIS row (`build-host.ts:140-144`), so a
    // ceiling case pins its own rather than leaning on the schema default of 8/10.
    ...(options.maxRounds === undefined ? {} : { max_rounds: options.maxRounds }) })
  await store.update(row.id, { merge_mode: options.mergeMode ?? 'pr', base_sha: baseSha })

  const github = fakeGithub({ origin, repo })
  const commands: string[][] = []
  const world: WorkerWorld = { run: spawnCapture, repo, scratch, dispatches: [],
    strategy: options.taskSequence ? 'task_sequence' : 'single', builderObservations: [], readSelectedRun: id => store.get(id),
    ...(options.reviewVeto ? { reviewVeto: options.reviewVeto } : {}),
    selectedTasks: [], plannerChoices: [], committedPlans: [], hostLedger: options.hostLedger ?? false,
    synthesisShape: options.synthesisShape ?? 'legacy', synthesisSchemaSeen: [],
    blockersByRound: options.blockersByRound ?? [], replanRounds: options.replanRounds ?? [],
    blockRoles: new Set(options.blockRoles ?? []), repeatFirstFinding: options.repeatFirstFinding ?? false,
    commentRounds: new Set(options.commentRounds ?? []),
    unavailableSeatRounds: new Set(options.unavailableSeatRounds ?? []) }
  const runHost = Object.assign(async (argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) => {
    commands.push([...argv])
    if (argv[0] === 'gh') return github.handle(argv)
    return spawnCapture(argv, cwd, env, timeout)
  }, { writesDiffOutput: true as const })
  world.run = runHost

  // The project REPL session. `spawnProjectSession` is the composition's own
  // seam; the entries it writes are the ones `prepareProjectBuild` reads back
  // (`open/wiring/project-build.ts:214-251`).
  const key = `e2e-${row.id}`
  cleanups.push(() => { pool.delete(key); supervisedBySessionKey.delete(key) })
  const worker = literalWorker(world)
  const projectsDir = join(dir, 'claude-projects')
  const session = { sessionId: 'e2e-session', authFingerprint: 'fixture-spawned-credential', toolSurface: LIVE_AGENT_TOOL_NAMES.join(','), cwd: dir, hasChildExited: () => false,
    child: { submitLine: async (line: string) => {
      const spec = JSON.parse(line.slice(line.indexOf('{')))
      const args = JSON.parse(String(spec.prompt).slice(String(spec.prompt).indexOf('{')))
      const requestLine = String(args.prompt).split('\n').find(row => row.startsWith('Request (data): '))!
      const request: BoundedWorkRequest = JSON.parse(requestLine.slice('Request (data): '.length))
      if (options.nativeUsage) {
        const directory = join(projectsDir, dir.replace(/\//g, '-'), 'e2e-session', 'subagents')
        await mkdir(directory, { recursive: true })
        const agentId = createHash('sha256').update(request.step_id).digest('hex').slice(0, 12)
        await writeFile(join(directory, `agent-${agentId}.meta.json`), JSON.stringify({ description: args.description }))
        const identity = { agentId, sessionId: 'e2e-session', isSidechain: true }
        await writeFile(join(directory, `agent-${agentId}.jsonl`), [
          { ...identity, type: 'user', message: { role: 'user', content: args.prompt } },
          { ...identity, type: 'assistant', message: { id: 'provider-message', role: 'assistant', model: request.model_id,
            content: [], usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n')
      }
      if (!options.rateLimitedSynthesis || request.role !== 'synthesis') return options.efficiencyTrace && request.role !== 'review'
        ? options.efficiencyTrace.during(request.role, () => worker(line)) : worker(line)
      // The provider owns this transcript envelope. No result file is written.
      const directory = join(projectsDir, dir.replace(/\//g, '-'), 'e2e-session', 'subagents')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'agent-quota.meta.json'), JSON.stringify({ description: args.description, toolUseId: 'tool-quota' }))
      const identity = { agentId: 'quota', sessionId: 'e2e-session', isSidechain: true }
      await writeFile(join(directory, 'agent-quota.jsonl'), [
        { ...identity, type: 'user', message: { role: 'user', content: args.prompt } },
        { ...identity, type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] },
          isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
          quotaLimits: { status: 'rejected' }, requestId: 'quota-request' },
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
      world.dispatches.push({ role: request.role, step_id: request.step_id, schema: request.result.schema, wrote: [] })
    } }, acquireTurn: async () => () => {} }

  let registeredSession: typeof session | ReplSession = session
  if (options.reviewChild) {
    const live = new ReplSession(key, 'e2e-generation', 'e2e-session', 'e2e-channel', dir)
    live.authFingerprint = session.authFingerprint
    live.toolSurface = session.toolSurface
    const children: Promise<void>[] = []
    const errors: unknown[] = []
    live.attachChild({ pid: 123, write() {}, kill() {}, hasExited: () => false,
      exited: new Promise(() => {}), submitLine: async line => {
        const spec = JSON.parse(line.slice(line.indexOf('{')))
        const args = JSON.parse(String(spec.prompt).slice(String(spec.prompt).indexOf('{')))
        const requestLine = String(args.prompt).split('\n').find(row => row.startsWith('Request (data): '))!
        const request: BoundedWorkRequest = JSON.parse(requestLine.slice('Request (data): '.length))
        if (request.role !== 'review') return session.child.submitLine(line)
        const seat = request.result.schema === 'verdict' ? JSON.parse(await readFile(request.brief.path, 'utf8')).seat : 'standalone'
        const directory = join(projectsDir, dir.replace(/\//g, '-'), 'e2e-session', 'subagents')
        await mkdir(directory, { recursive: true })
        const agentId = createHash('sha256').update(request.step_id).digest('hex')
        await writeFile(join(directory, `agent-${agentId}.meta.json`), JSON.stringify({ description: args.description }))
        await writeFile(join(directory, `agent-${agentId}.jsonl`), JSON.stringify({ agentId, sessionId: 'e2e-session',
          isSidechain: true, type: 'user', message: { role: 'user', content: args.prompt } }) + '\n')
        // Acceptance returns immediately; the independently owned child remains
        // live until its barrier opens. Production owns submission serialization.
        children.push(options.reviewChild!(request, seat).then(() => worker(line)).catch(error => { errors.push(error) }))
      } })
    registeredSession = live
    cleanups.push(async () => { await Promise.all(children); expect(errors).toEqual([]); expect(live.turnSlotHeld).toBe(0) })
  }

  const register = (registration: { key?: string; projectId?: string; instanceId?: string
    state?: 'ready' | 'pending' | 'missing' | 'empty' | 'exited' } = {}) => {
    const sessionKey = registration.key ?? key
    cleanups.push(() => { pool.delete(sessionKey); supervisedBySessionKey.delete(sessionKey) })
    supervisedBySessionKey.set(sessionKey, {
      substrate_instance_id: registration.instanceId ?? 'cc-agent-e2e',
      project_id: registration.projectId ?? 'e2e-project',
      skip_permissions: true, extra_dirs: [dir],
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-native-credential', ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined },
      projectsDir,
    } as never)
    if (registration.state === 'missing') { pool.delete(sessionKey); return }
    pool.set(sessionKey, registration.state === 'pending' ? new Promise(() => {})
      : Promise.resolve((registration.state === 'empty' ? undefined
        : registration.state === 'exited' ? { ...session, hasChildExited: () => true } : registeredSession) as never))
  }

  const context: ProjectBuildContext = {
    store, attempts: new TridentAttemptLedger(db), runHost, runSuite: runHost,
    runInstall: Object.assign((argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) =>
      spawnCapture(argv, cwd, { ...env, BUN_INSTALL_CACHE_DIR: join(dir, 'bun-cache') }, timeout),
    { writesDiffOutput: true as const }),
    stateRoot: join(dir, 'state'), projectDir: dir, projectId: 'e2e-project',
    provider: 'anthropic', providerSource: 'application',
    env: codexBin ? { PATH: `${codexBin}:${process.env.PATH ?? ''}` } : {},
    spawnProjectSession: async () => {
      register()
      await Promise.resolve()
    },
  }

  const input: InnerLoopInput = {
    run: store.get(row.id)!, base_branch: 'main', db_path: join(dir, 'project.db'), max_rounds: 3,
    ...(codexHome ? { codex_home: codexHome } : {}),
    // A nonempty strategy is what makes `assessReviewSuite` actually read the
    // build's recorded claim; an empty one returns `known()` vacuously
    // (`gates/review-suite.ts:39`). The stage-2 block is what gives the host a
    // command to run for its own receipt — see `suiteStrategy`.
    test_strategy: options.testStrategy ?? suiteStrategy,
    // Only the adversarial core seat stays on by default. A Codex case supplies a
    // local subscription-shaped home and CLI boundary; Kimi remains out of scope.
    phase_models: { review_rubric: { model: 'none' },
      review_codex: { model: options.codexReview ? 'sol' : 'none' }, review_kimi: { model: 'none' } },
  }

  const prepare = async () => {
    const options = await prepareProjectBuild(input, context, new AbortController().signal)
    // The leak SCANNER is stubbed; the preflight module around it is not.
    options.policy.leak.gate_script = join(repo, 'scripts', 'ci', 'leak-gate.sh')
    return options
  }

  return { dir, repo, origin, baseSha, db, store, row, input, context, prepare, github, commands, world,
    register, key, codexCalls }
}

async function drive(f: Awaited<ReturnType<typeof fixture>>): Promise<ProjectBuildOutcome> {
  const options = await f.prepare()
  const host = await createProjectBuildHost(options)
  return host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
}

for (const taskSequence of [false, true]) test(`terminal ${taskSequence ? 'task-sequence' : 'single'} runs one host suite for review and publication`, async () => {
  const f = await fixture({ taskSequence })
  f.input.test_strategy_intermediate = 'Intermediate stage 1 only.'
  let suites = 0
  const runSuite = f.context.runSuite!
  f.context.runSuite = async (...args) => { suites++; return runSuite(...args) }
  f.world.suiteReport = async () => ({ testsPassed: false, suiteOutcome: 'deferred', suiteEvidence: '' })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.builderObservations[0]?.scope).toBe('host-suite')
  expect(suites).toBe(1)
  const receipts = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-suite-receipt' && JSON.parse(event.meta!).receipt)
  expect(receipts).toHaveLength(1)
  expect(JSON.parse(receipts[0]!.meta!).receipt).toMatchObject({ scope: 'full-suite', round: 1, report: { hostExitCode: 0 } })
}, 120_000)

test('v2 pending builder reconstruction preserves every brief and its later fix contract', async () => {
  const f = await fixture({ blockersByRound: [0, 1, 0] })
  const prepared = await f.prepare()
  for (const [role, worker] of Object.entries(prepared.workers)) {
    const path = join(f.context.stateRoot, f.row.id, `${role}.strategy-v2.brief`)
    const brief = (await readFile(worker.request.brief.path, 'utf8')).replace(
      'The host selects `suiteScope`: `full-suite` requires the worker full suite for a wave member; `subset` defers it for an intermediate task; `host-suite` leaves the full suite to host review after worker stage 1.',
      'The host selects `suiteScope` after validating this task: `full-suite` requires the full suite; only `subset` defers it for an intermediate task.')
    await writeFile(path, brief)
    worker.request = { ...worker.request, brief: { path, integrity: briefIntegrity(brief) } }
  }
  const first = await createProjectBuildHost(prepared)
  const original = Object.fromEntries(Object.entries(first.workers).map(([role, worker]) => [role, worker.request.brief]))
  const runner = first.workers.build.runner
  first.workers.build.runner = { ...runner, run: async (...args) => {
    expect((await runner.run(...args)).kind).toBe('completed')
    return { kind: 'unknown', detail: 'completed worker acknowledgement lost' }
  } }
  expect(await buildRun({ mode: 'implementation', start: 'fresh', run_id: f.row.id,
    workers: first.workers, repl_provider: 'anthropic', merge_mode: 'pr' }, first.deps, new AbortController().signal))
    .toMatchObject({ kind: 'unknown', phase: 'build' })
  const recovered = await createProjectBuildHost(await f.prepare())
  expect(Object.fromEntries(Object.entries(recovered.workers).map(([role, worker]) => [role, worker.request.brief]))).toEqual(original)
  const outcome = await recovered.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'build')).toHaveLength(1)
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toHaveLength(1)
  for (const role of ['build', 'fix'] as const) {
    const context = JSON.parse(await readFile(workContextPath(recovered.workers[role].request.brief.path), 'utf8'))
    expect(context.suiteScope).toBe('full-suite')
    expect(context.testStrategy).toBe(f.input.test_strategy)
  }
}, 120_000)

test('wave member retains worker full suite and returns before host review', async () => {
  const f = await fixture({ taskSequence: true, moreTasks: true })
  const host = await createProjectBuildHost(await f.prepare())
  const outcome = await host.run({ mode: 'wave', pinnedTaskId: 'T1', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('built')
  const context = JSON.parse(await readFile(workContextPath(host.workers.build.request.brief.path), 'utf8'))
  expect(context.suiteScope).toBe('full-suite')
  expect(context.testStrategy).toBe(f.input.test_strategy)
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'review')).toBe(false)
  expect(f.store.stageEvents(f.row.id).some(event => event.stage === 'build-suite-receipt')).toBe(false)
}, 120_000)

test('G070 repeated host red still arbitrates when a fix removes the other panel blocker', async () => {
  const f = await fixture({ namedSuiteFailure: true, blockersByRound: [0, 1, 0], maxRounds: 3 })
  f.world.suiteReport = async () => ({ testsPassed: false, suiteOutcome: 'deferred', suiteEvidence: '' })
  const outcome = await drive(f)
  expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toHaveLength(1)
  const rejected = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state')
    .map(event => JSON.parse(event.meta!).checkpoint).filter(checkpoint => checkpoint.stage === 'rejected')
  expect(rejected.at(-1).previousReview.blockingCount).toBe(1)
  expect(rejected[0].previousReview.blockingCount).toBe(4) // Three panel seats plus the host suite.
  expect(rejected.at(-1).previousReview.findings).toContain(rejected[0].previousReview.findings.find((value: string) => value.startsWith('host-suite:')))
}, 120_000)

test('same-round cached nonzero host receipt replays red without running the suite again', async () => {
  const f = await fixture({ suiteExit: 1 })
  let suites = 0
  const runSuite = f.context.runSuite!
  f.context.runSuite = async (...args) => { suites++; return runSuite(...args) }
  let host = await createProjectBuildHost(await f.prepare())
  const measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('Expected measured fixture')
  const first = await host.deps.publicationSuite(measured.value)
  expect(first).toMatchObject({ kind: 'known', findings: [{ advisory: false }] })
  host = await createProjectBuildHost(await f.prepare())
  expect(await host.deps.publicationSuite(measured.value)).toEqual(first)
  expect(suites).toBe(1)
}, 120_000)

test('G070 permits a different host failure with fewer blockers and an eventual green suite', async () => {
  const f = await fixture({ namedSuiteFailure: true, blockersByRound: [0, 1, 0], maxRounds: 3 })
  f.world.suiteReport = async () => ({ testsPassed: false, suiteOutcome: 'deferred', suiteEvidence: '' })
  let suites = 0
  const runSuite = f.context.runSuite!
  f.context.runSuite = async (...args) => {
    const result = await runSuite(...args)
    suites++
    if (suites === 2) {
      const log = join(f.context.stateRoot, f.row.id, 'suite-round-2.log')
      await writeFile(log, (await readFile(log, 'utf8')).replaceAll('pre-existing red', 'different remaining failure'))
    }
    return suites === 3 ? { ...result, ok: true, exit_code: 0 } : result
  }
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toHaveLength(2)
  expect(suites).toBe(3)
}, 120_000)

for (const changed of [false, true]) test(`G072 generic red with fewer blockers remains undecidable, changed=${changed}`, async () => {
  const f = await fixture({ namedSuiteFailure: 'generic', blockersByRound: [0, 1, 0], maxRounds: 3 })
  f.world.suiteReport = async () => ({ testsPassed: false, suiteOutcome: 'deferred', suiteEvidence: '' })
  let suites = 0
  const runSuite = f.context.runSuite!
  f.context.runSuite = async (...args) => {
    const result = await runSuite(...args)
    suites++
    if (changed && suites === 2) {
      const log = join(f.context.stateRoot, f.row.id, 'suite-round-2.log')
      await writeFile(log, 'tests/different.test.sh: a different failure\n')
    }
    return result
  }
  const outcome = await drive(f)
  expect(outcome, why(f, outcome)).toMatchObject({ kind: 'unknown', detail: 'Review progress cannot compare unidentified host suite failures' })
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toHaveLength(1)
  expect(lastCheckpoint(f).previousReview).toEqual({ blockingCount: 1, unknownIdentities: true, findings: [] })
}, 120_000)

for (const format of ['bun', 'generic'] as const)
for (const evidence of (format === 'bun' ? ['valid', 'empty', 'changed-failure', 'mixed-crash', 'panel-veto'] : ['valid', 'empty', 'changed-run']) as readonly string[])
test(`${format} host red reaches targeted base comparison and preserves ${evidence}`, async () => {
  const f = await fixture({ namedSuiteFailure: format === 'bun' ? true : 'generic', maxRounds: 2,
    ...(evidence === 'panel-veto' ? { commentRounds: [2] } : {}) })
  let suites = 0
  let comparisons = 0
  const runSuite = f.context.runSuite!
  f.context.runSuite = async (...args) => {
    const result = await runSuite(...args)
    suites++
    if (['changed-failure', 'mixed-crash'].includes(evidence) && suites === 2) {
      const log = join(f.context.stateRoot, f.row.id, 'suite-round-2.log')
      const text = await readFile(log, 'utf8')
      await writeFile(log, evidence === 'mixed-crash' ? `${text}\nerror: Cannot find module './broken-by-diff'\n` : text.replaceAll('pre-existing red', 'new regression'))
    }
    return result
  }
  f.world.suiteReport = async (role, context) => {
    if (role !== 'fix') return { testsPassed: false, suiteOutcome: 'failed-preexisting', suiteEvidence: 'unrelated stage-1 base red' }
    const findings = context.findings.join('\n')
    expect(findings).toContain('suite-round-1.log')
    const file = format === 'bun' ? 'preexisting.test.ts' : 'preexisting.test.sh'
    expect(findings).toContain(file)
    const identity = findings.match(/host-suite:[a-f0-9]{64}/)?.[0]
    if (format === 'bun') expect(identity).toBeDefined()
    const base = await spawnCapture(['git', 'show', `${f.baseSha}:tests/${file}`], f.repo)
    expect(base.ok).toBe(true)
    const directory = join(f.dir, 'targeted-base')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, file), base.stdout)
    const compared = await spawnCapture(format === 'bun' ? ['bun', 'test', `./${file}`] : ['bash', `./${file}`], directory)
    comparisons++
    expect(compared.exit_code).toBe(1)
    if (evidence === 'changed-run') {
      const events = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-suite-receipt')
      for (const event of events) {
        const value = JSON.parse(event.meta!)
        if (value.receipt) value.receipt.runId = 'different-run'
        f.db.raw().query('UPDATE code_trident_stage_events SET meta = ? WHERE id = ?').run(JSON.stringify(value), event.id)
      }
    }
    return { testsPassed: false, suiteOutcome: 'failed-preexisting',
      suiteEvidence: evidence === 'empty' ? '' : `${identity ?? 'generic runner'}; tests/${file}: pre-existing red failed at base ${f.baseSha} without the diff; targeted test exit ${compared.exit_code}` }
  }
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe(evidence === 'valid' ? 'merged' : 'blocked')
  expect(comparisons).toBe(1)
  expect(suites).toBe(2)
}, 120_000)

for (const attribution of ['direct', 'wrapped'] as const) for (const fix of [false, true])
test(`host commit recovery merges unattended with ${attribution} attribution, fix=${fix}`, async () => {
  const f = await fixture({ blockersByRound: fix ? [0, 1] : [] })
  f.world.commitAttribution = attribution
  // Make the consuming mutation reader and prover run on the replacement OID;
  // a documentation-only exemption would miss a broken artifact projection.
  f.world.mutationArgv = 'valid'
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.github.prs[0]!.state).toBe('MERGED')
  const receipts = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-commit-recovery')
  expect(receipts).toHaveLength(attribution === 'direct' ? (fix ? 2 : 1) : 0)
  const publicHead = await gitOut(spawnCapture, f.origin, ['rev-parse', 'refs/heads/main'])
  const messages = await gitOut(spawnCapture, f.origin, ['log', '--format=%B', `${f.baseSha}..${publicHead}`])
  expect(messages).not.toContain('Claude-Session:')
  expect(messages).toContain('Co-Authored-By: Fixture')
  for (const receipt of receipts) {
    const value = JSON.parse(receipt.meta!)
    const role = value.step.includes(':fix:') ? 'fix' : 'build'
    const original = await readFile(join(f.context.stateRoot, f.row.id, `${role}.result`), 'utf8')
    expect(createHash('sha256').update(original).digest('hex')).toBe(value.artifact)
    expect(JSON.parse(original).result.head).toBe(value.from)
    expect(JSON.parse(original).result.payload.commitSha).toBe(value.from)
    expect(value.to).not.toBe(value.from)
    const before = await gitOut(spawnCapture, f.repo, ['cat-file', 'commit', value.from])
    const after = await gitOut(spawnCapture, f.repo, ['cat-file', 'commit', value.to])
    expect(before).toContain('Claude-Session:')
    expect(after).not.toContain('Claude-Session:')
    expect(after.split('\n\n')[0]).toBe(before.split('\n\n')[0])
  }
}, 120_000)

test('historical carrier checkpoints remain refused on resume and are not adopted by an unpublished PR retry', async () => {
  const task = 'Write a small documented behavior and verify the completed change'
  const f = await fixture({ dispatchTask: task })
  f.world.commitAttribution = 'direct'
  const priorHost = await createProjectBuildHost(await f.prepare())
  // Reproduce the old host, whose completed builder checkpoint preceded G166
  // and which had no host recovery effect at the worker boundary.
  delete priorHost.deps.recoverBuildCommit
  const first = await buildRun({ mode: 'implementation', start: 'fresh', run_id: f.row.id, workers: priorHost.workers,
    repl_provider: 'anthropic', merge_mode: 'pr' }, priorHost.deps, new AbortController().signal)
  expect(first).toMatchObject({ kind: 'blocked', phase: 'publish', on: expect.stringContaining('Claude-Session trailer') })
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint).toMatchObject({ stage: 'built', round: 1 })
  expect(checkpoint.pending).toBeUndefined()
  f.world.dispatches.length = 0
  const next = await createProjectBuildHost(await f.prepare())
  const retried = await buildRun({ mode: 'implementation', start: 'resume', run_id: f.row.id, workers: next.workers,
    repl_provider: 'anthropic', merge_mode: 'pr' }, next.deps, new AbortController().signal)
  expect(retried).toMatchObject({ kind: 'blocked', phase: 'publish', on: expect.stringContaining('Claude-Session trailer') })
  expect(f.world.dispatches).toEqual([])
  expect(f.github.prs).toEqual([])
  const prior = f.store.get(f.row.id)!
  expect(await gitOut(spawnCapture, f.repo, ['rev-parse', `refs/heads/${prior.branch}`])).toBe(String(checkpoint.head))
  await f.store.update(prior.id, { phase: 'failed', worktree: null })
  const dispatched = await dispatchBoardBoundBuild({ task, board_item_id: 'retry-card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    board: { get: () => ({ id: 'retry-card', title: task, design_doc_ref: null, linked_run_id: prior.id }), attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => 'pr', hostRunner: f.context.runHost,
  })
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  // PR retry admission proves the remote tip, which G166 never published.
  // This is a fresh build request, not authorization to repair the old object.
  expect(dispatched.run.inner_checkpoint_head).toBeNull()
  expect(f.store.stageEvents(dispatched.run.id).some(event => event.stage === 'build-retry-source')).toBe(false)
  expect(f.store.stageEvents(dispatched.run.id).some(event => event.stage === 'build-commit-recovery')).toBe(false)
}, 120_000)

for (const mergeMode of ['local', 'pr'] as const) for (const carrier of [false, true]) {
  test(`G166 consuming pre-merge ${mergeMode}: own carrier=${carrier}, public-base carrier excluded`, async () => {
    const f = await fixture({ mergeMode })
    const options = await f.prepare()
    const run = f.store.get(f.row.id)!
    const git = (cwd: string, args: string[]) => gitOut(spawnCapture, cwd, args)
    // The launch pin predates a public carrier. This is ordinary upstream
    // history and must not poison admission of the run's own clean work.
    await git(f.repo, ['commit', '--allow-empty', '-m', 'Public base', '-m', 'Claude-Session: public-fixture'])
    const publicBase = await git(f.repo, ['rev-parse', 'HEAD'])
    await git(f.repo, ['push', 'origin', 'main'])
    await git(run.worktree!, ['rebase', 'main'])
    if (carrier) await git(run.worktree!, ['commit', '--allow-empty', '-m', 'Own ancestor', '-m', 'cLaUdE-sEsSiOn: fixture'])
    const ancestor = await git(run.worktree!, ['rev-parse', 'HEAD'])
    await writeFile(join(run.worktree!, 'NOTES.md'), 'completed fixture work\n')
    await git(run.worktree!, ['add', 'NOTES.md'])
    await git(run.worktree!, ['commit', '-m', 'Discuss Claude-Session: as data', '-m', 'Co-Authored-By: Fixture <fixture@example.invalid>'])
    const reviewed = await git(run.worktree!, ['rev-parse', 'HEAD'])
    if (mergeMode === 'pr') {
      await git(run.worktree!, ['push', 'origin', run.branch!])
      f.github.prs.push({ number: 1, state: 'OPEN', headRefName: run.branch!, baseRefName: 'main', isDraft: true })
      await f.store.update(run.id, { pr: 1, published_pr: 1 })
    }
    // Exercise the consuming composition's merge effect directly, deliberately
    // independent of publication. A pre-push refusal cannot make this pass.
    const host = await createProjectBuildHost(options)
    const measured = await host.deps.measure()
    expect(measured.kind).toBe('known')
    if (measured.kind !== 'known') throw new Error(measured.detail)
    expect(measured.value.head).toBe(reviewed)
    f.commands.length = 0
    const target = mergeMode === 'pr' ? f.origin : f.repo
    if (carrier) {
      await expect(host.deps.merge(measured.value)).rejects.toThrow(
        `Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base: ${ancestor}`)
      expect(await git(target, ['rev-parse', 'refs/heads/main'])).toBe(publicBase)
      expect(f.commands.some(argv => argv[0] === 'gh' && ['ready', 'merge'].includes(argv[2]!))).toBe(false)
      if (mergeMode === 'pr') expect(f.github.prs[0]).toMatchObject({ state: 'OPEN', isDraft: true })
    } else {
      await host.deps.merge(measured.value)
      expect(await git(target, ['show', 'refs/heads/main:NOTES.md'])).toBe('completed fixture work')
      if (mergeMode === 'pr') expect(f.github.prs[0]).toMatchObject({ state: 'MERGED', isDraft: false })
    }
    expect(f.commands.some(argv => argv.includes('cat-file') && argv.includes('commit'))).toBe(true)
  }, 120_000)
}

for (const productionChange of [false, true])
test(`publication mutation uses the launch pin with stale local main: ${productionChange ? 'production still requires proof' : 'docs and tests remain exempt'}`, async () => {
  const f = await fixture()
  const git = (args: string[]) => gitOut(f.world.run, f.repo, args)
  // Upstream production code landed after this checkout's local main. The run
  // launches from that newer commit, as a real fetched project build does.
  await mkdir(join(f.repo, 'src'), { recursive: true })
  await writeFile(join(f.repo, 'src/upstream.ts'), 'export const value = 1\n')
  await git(['add', '--', 'src/upstream.ts'])
  await git(['commit', '-m', 'feat: upstream code'])
  await git(['push', 'origin', 'main'])
  const launchBase = await git(['rev-parse', 'HEAD'])
  await git(['checkout', '--detach', launchBase])
  await git(['update-ref', 'refs/heads/main', f.baseSha, launchBase])
  await f.store.update(f.row.id, { base_sha: launchBase })
  f.input.run = f.store.get(f.row.id)!
  f.world.extraBuildFiles = {
    'tests/upstream.test.ts': "import { test, expect } from 'bun:test'\nimport { value } from '../src/upstream.ts'\ntest('value', () => expect(value).toBeGreaterThan(0))\n",
    ...(productionChange ? { 'src/upstream.ts': 'export const value = 2\n' } : {}),
  }

  const outcome = await drive(f)
  if (productionChange) {
    expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', phase: 'publish', on: expect.stringContaining('nominated no mutation') })
    expect(f.github.prs.some(pr => pr.state === 'MERGED')).toBe(false)
  } else {
    expect(outcome.kind, why(f, outcome)).toBe('merged')
    expect(f.github.prs[0]).toMatchObject({ state: 'MERGED', baseRefName: 'main' })
  }
  const mutationRanges = f.commands.filter(argv => argv.includes('diff') && argv.includes('--name-status'))
    .map(argv => argv.find(arg => arg.includes('...'))!)
  expect(mutationRanges.length).toBeGreaterThan(0)
  const builtHead = mutationRanges[0]!.split('...')[1]!
  expect(await git(['rev-parse', 'refs/heads/main'])).toBe(f.baseSha)
  // Positive control: the obsolete range really does include production code.
  expect((await git(['diff', '--name-only', `refs/heads/main...${builtHead}`])).split('\n')).toContain('src/upstream.ts')
  expect((await git(['diff', '--name-only', `${launchBase}...${builtHead}`])).split('\n').sort()).toEqual([
    'NOTES.md', ...(productionChange ? ['src/upstream.ts'] : []), 'tests/upstream.test.ts',
  ])
}, 120_000)

test('attempt accounting consumes a full build with missing metadata and attributes each role and review seat', async () => {
  const f = await fixture()
  expect((await drive(f)).kind).toBe('merged')
  const attempts = f.context.attempts.list(f.row.id)
  expect(attempts.map(row => row.role).sort()).toEqual(['build', 'plan', 'review', 'review', 'synthesis'])
  expect(attempts.filter(row => row.review_seat !== null).map(row => row.review_seat).sort()).toEqual(['review_adversarial', 'synthesis'])
  for (const attempt of attempts) {
    expect(attempt).toMatchObject({ run_id: f.row.id, outcome: 'completed', placement: 'in-repl', provider: 'anthropic' })
    expect(attempt.task_id).toBe(`${f.row.id}:task:0`)
    expect(attempt.head_sha).toMatch(/^[a-f0-9]{40}$/)
    expect(attempt.requested_model.length).toBeGreaterThan(0)
    expect(attempt.resolved_model.length).toBeGreaterThan(0)
    expect(attempt.started_at!).toBeGreaterThanOrEqual(attempt.prepared_at!)
    expect(attempt.ended_at!).toBeGreaterThanOrEqual(attempt.started_at!)
    expect(f.context.attempts.receipt(attempt)).toBeNull()
  }
  expect(new TridentPhaseUsageStore(f.db).list(f.row.id)!.every(row => row.status === 'unknown')).toBe(true)
  const intervals = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-stage-ended').map(event => JSON.parse(event.meta!))
  expect(intervals.map(value => value.stage)).toContain('cleanup')
  expect(intervals.map(value => value.stage)).toContain('publication-proof')
  expect(intervals.map(value => value.stage)).toContain('dependency-preparation')
  for (const interval of intervals) expect(interval.ended_at).toBeGreaterThanOrEqual(interval.started_at)
})

test.each(['valid', 'wrong-run'] as const)('attempt accounting retains actual headless transport usage with %s result identity', async codexReview => {
  const f = await fixture({ codexReview })
  const result = await drive(f)
  expect(result.kind === 'merged').toBe(codexReview === 'valid')
  const attempts = f.context.attempts.list(f.row.id).filter(row => row.provider === 'openai-codex')
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({ review_seat: 'review_codex', phase: 'review_codex', requested_model: 'sol', placement: 'headless' })
  const receipt = f.context.attempts.receipt(attempts[0]!)!
  expect(receipt).toMatchObject({ source: 'codex-cli-jsonl', input_tokens: null, output_tokens: 3, cost_usd: null })
  expect(attempts[0]!.outcome === 'completed').toBe(codexReview === 'valid')
  expect(new TridentPhaseUsageStore(f.db).list(f.row.id)!.find(row => row.phase === 'review_codex')).toMatchObject({ input_tokens: null, output_tokens: 3 })
})

test('attempt accounting consumes native child measurements through the actual Open acting-turn binding', async () => {
  const f = await fixture({ nativeUsage: true })
  expect((await drive(f)).kind).toBe('merged')
  const attempts = f.context.attempts.list(f.row.id)
  expect(attempts).toHaveLength(5)
  for (const attempt of attempts) expect(f.context.attempts.receipt(attempt)).toMatchObject({
    source: 'claude-repl-jsonl', input_tokens: 7, output_tokens: 3,
    cache_read_tokens: 2, cache_creation_tokens: 0, cost_usd: null, model_reported: attempt.resolved_model,
  })
  expect(new TridentPhaseUsageStore(f.db).list(f.row.id)!.find(row => row.phase === 'review_adversarial')).toMatchObject({
    input_tokens: 14, output_tokens: 6, cache_read_tokens: 4,
  })
})

test('attempt accounting keeps a provider-reported model without usage, merges unattended, and leaves every counter unknown', async () => {
  const f = await fixture()
  const options = await f.prepare()
  const real = options.substrate.inRepl!
  const reported = (role: string, model: string) => `provider-reported-${role}-${model}`
  options.substrate.inRepl = { ...real, async run(request, placement, signal) {
    const result = await real.run(request, placement, signal)
    if (result.kind !== 'completed') return result
    const { observation: _none, ...validated } = result
    return { ...validated, usage: null, model_reported: reported(request.role, request.model_id), thread_id: null }
  } }
  const host = await createProjectBuildHost(options)
  expect((await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)).kind).toBe('merged')
  expect(f.github.prs[0]).toMatchObject({ state: 'MERGED' })
  const attempts = f.context.attempts.list(f.row.id)
  expect(attempts.map(row => row.role).sort()).toEqual(['build', 'plan', 'review', 'review', 'synthesis'])
  for (const attempt of attempts) {
    expect(attempt.outcome).toBe('completed')
    const receipt = f.context.attempts.receipt(attempt)!
    expect(receipt).toMatchObject({ source: 'bounded-worker-metadata', model_reported: reported(attempt.role, attempt.resolved_model),
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, cost_usd: null })
    expect(Number.isFinite(receipt.observed_at)).toBe(true)
    expect(receipt.observed_at).toBeGreaterThanOrEqual(attempt.started_at!)
    // Requested, resolved and reported models remain three independent facts.
    expect(attempt.requested_model.length).toBeGreaterThan(0)
    expect(attempt.resolved_model.length).toBeGreaterThan(0)
    expect(receipt.model_reported).not.toBe(attempt.requested_model)
    expect(receipt.model_reported).not.toBe(attempt.resolved_model)
  }
  expect(new TridentPhaseUsageStore(f.db).list(f.row.id)!.every(row => row.status === 'unknown' && row.input_tokens === null)).toBe(true)
}, 120_000)

test('attempt accounting keeps explicit zero on successful work and partial usage on a failed build without authorizing it', async () => {
  const f = await fixture()
  const options = await f.prepare()
  const real = options.substrate.inRepl!
  options.substrate.inRepl = { ...real, async run(request, placement, signal) {
    const result = await real.run(request, placement, signal)
    const observed = { source: 'claude-cli-json' as const, started_at_ms: Date.now(), finished_at_ms: Date.now(), observed_at_ms: Date.now(),
      model_reported: request.model_id, thread_id: null, usage: { input_tokens: request.role === 'plan' ? 0 : 23,
        output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: null, cost_usd: null } }
    return request.role === 'build' ? { kind: 'failed' as const, class: 'infra' as const, detail: 'partial transport failure', observation: observed }
      : { ...result, observation: observed }
  } }
  const host = await createProjectBuildHost(options)
  expect((await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)).kind).toBe('failed')
  const attempts = f.context.attempts.list(f.row.id)
  expect(attempts).toHaveLength(2)
  expect(attempts.find(row => row.role === 'build')!.outcome).toBe('failed')
  const phases = new TridentPhaseUsageStore(f.db).list(f.row.id)!
  expect(phases.find(row => row.phase === 'decomposition')).toMatchObject({ input_tokens: 0, output_tokens: 0, status: 'partial' })
  expect(phases.find(row => row.phase === 'build')).toMatchObject({ input_tokens: 23, output_tokens: 0, status: 'partial' })
  expect(f.github.prs.some(pr => pr.state === 'MERGED')).toBe(false)
})

test('attempt accounting reopens the production host and consumes the same transport receipt without replay or double counting', async () => {
  const f = await fixture()
  const options = await f.prepare()
  const real = options.substrate.inRepl!
  const observedAt = Date.now()
  options.substrate.inRepl = { ...real, async run(request, placement, signal) {
    return { ...await real.run(request, placement, signal), observation: {
      source: 'claude-cli-json', started_at_ms: observedAt, finished_at_ms: observedAt, observed_at_ms: observedAt,
      model_reported: request.model_id, thread_id: null, usage: { input_tokens: 19, output_tokens: 2,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: null },
    } }
  } }
  let host = await createProjectBuildHost(options)
  const measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('fixture revision must be measurable')
  const request: BoundedWorkRequest = { ...host.workers.plan.request, run_id: f.row.id,
    step_id: `${f.row.id}:plan:0`, role: 'plan', needs_approval_decision: false }
  const execute = async () => {
    await host.deps.prepareWork(request, { snapshot: measured.value, previous: null, findings: [] })
    expect((await host.workers.plan.runner.run(request, 'in-repl', new AbortController().signal)).kind).toBe('completed')
  }
  await execute()
  const first = f.context.attempts.list(f.row.id)
  await execute()
  // A new composition and ledger object has no in-memory usage baseline to carry.
  options.attempts = new TridentAttemptLedger(f.db)
  host = await createProjectBuildHost(options)
  await execute()
  expect(f.context.attempts.list(f.row.id)).toEqual(first)
  expect(f.world.dispatches).toHaveLength(1)
  expect(new TridentPhaseUsageStore(f.db).list(f.row.id)!.find(row => row.phase === 'decomposition')).toMatchObject({ input_tokens: 19, output_tokens: 2 })
})

test('worktree-add diagnostics preserve a terminal predecessor and allow retry after explicit release', async () => {
  const f = await fixture()
  await f.prepare()
  const prior = f.store.get(f.row.id)!
  const holder = prior.worktree!
  const branch = prior.branch!
  const before = await gitOut(spawnCapture, holder, ['rev-parse', 'HEAD'])
  await f.store.update(prior.id, { phase: 'failed' })
  const retry = await f.store.create({ slug: prior.slug, project_slug: prior.project_slug,
    repo_path: f.repo, task: prior.task, branch })
  await f.store.update(retry.id, { base_sha: f.baseSha })
  f.input.run = f.store.get(retry.id)!
  const start = f.commands.length
  await expect(f.prepare()).rejects.toThrow('reason=branch-held; exit=128; timed_out=false; diagnostic_recorded=true')
  const events = f.store.stageEvents(retry.id).filter(event => event.stage === 'build-worktree-add-failed')
  expect(events).toHaveLength(1)
  expect(JSON.parse(events[0]!.meta!)).toEqual({ operation: 'git-worktree-add', reason: 'branch-held', exit_code: 128, timed_out: false })
  expect(events[0]!.meta).not.toContain(f.dir)
  expect(events[0]!.meta).not.toContain(branch)
  expect(await gitOut(spawnCapture, holder, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${branch}`)
  expect(await gitOut(spawnCapture, holder, ['rev-parse', 'HEAD'])).toBe(before)
  expect(f.commands.slice(start).some(argv => argv.includes('--force') || argv.includes('remove') || argv.includes('checkout'))).toBe(false)
  expect(f.world.dispatches).toHaveLength(0)

  // The fixture explicitly releases its clean old tree; preparation has no
  // authority to infer worker quiescence from a terminal database row.
  await gitOut(spawnCapture, f.repo, ['worktree', 'remove', holder])
  const host = await createProjectBuildHost(await f.prepare())
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.store.stageEvents(retry.id).filter(event => event.stage === 'build-worktree-add-failed')).toHaveLength(1)
}, 300_000)

for (const scenario of [
  { stderr: 'fatal: private-path already exists', reason: 'path-exists', exit: 128 },
  { stderr: 'fatal: private-path is already registered', reason: 'path-exists', exit: 128 },
  { stderr: 'fatal: private-path Permission denied', reason: 'permission', exit: 128 },
  { stderr: 'fatal: private-path No space left on device', reason: 'storage-full', exit: 128 },
  { stderr: 'private-path already checked out', reason: 'timeout', exit: 137, timedOut: true },
  { stderr: 'private-path', reason: 'unclassified', exit: 128 },
  { stderr: `${'x'.repeat(4096)} Permission denied private-path`, reason: 'unclassified', exit: 128 },
  { stderr: 'private-path', reason: 'observation-error', exit: null },
] as const) test(`worktree-add diagnostics persist only bounded categories: ${scenario.reason}/${scenario.stderr.length}`, async () => {
  const f = await fixture()
  const original = f.context.runHost
  f.context.runHost = async (...args) => {
    if (!args[0].includes('worktree') || !args[0].includes('add')) return original(...args)
    if (scenario.exit === null) throw new Error(scenario.stderr)
    return { ok: false, exit_code: scenario.exit, stderr: scenario.stderr, stdout: 'private-stdout',
      timed_out: 'timedOut' in scenario }
  }
  let detail = ''
  try { await f.prepare() } catch (error) { detail = String(error) }
  expect(detail).toContain(`reason=${scenario.reason}`)
  expect(detail).not.toContain('private-')
  expect(detail.length).toBeLessThan(220)
  const events = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-worktree-add-failed')
  expect(events).toHaveLength(1)
  expect(JSON.parse(events[0]!.meta!)).toEqual({ operation: 'git-worktree-add', reason: scenario.reason,
    exit_code: scenario.exit, timed_out: scenario.exit === null ? null : 'timedOut' in scenario })
  expect(events[0]!.meta!.length).toBeLessThan(140)
  expect(f.world.dispatches).toHaveLength(0)
})

async function codexOwnerWithClaude(identity: 'valid' | 'wrong-schema' = 'valid') {
  const f = await fixture()
  const ownerHome = await mkdtemp(join(tmpdir(), 'project-build-cross-provider-'))
  cleanups.push(() => rm(ownerHome, { recursive: true, force: true }))
  const bin = join(ownerHome, 'bin')
  const calls = join(ownerHome, 'claude-calls.jsonl')
  await mkdir(bin)
  await writeFile(join(bin, 'claude'), fakeClaude(calls, identity), { mode: 0o700 })
  f.context.stateRoot = join(ownerHome, '.trident', 'project-builds')
  f.context.provider = 'openai-codex'
  f.context.env = { PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-selected-claude',
    GH_TOKEN: 'must-not-reach-claude', NEUTRON_REPLY_SINK: 'must-not-reach-claude' }
  f.input.phase_models = { ...f.input.phase_models, decomposition: { model: 'opus' },
    build: { model: 'sol' }, review_adversarial: { model: 'opus' }, synthesis: { model: 'opus' } }
  const children: BoundedWorkRequest[] = []
  const execute = literalWorker(f.world)
  const guard = new CodexOwnerBindings(async () => ({ cwd: f.context.projectDir, codexHome: ownerHome, credentialIdentity: 'fixture', env: {} }))
  cleanups.push(() => guard.close())
  f.context.codexOwnerBindings = {
    guardBuildRunner: (project, worker) => guard.guardBuildRunner(project, worker),
    actingTurn: project => async turn => {
      expect(project).toBe(f.context.projectId)
      children.push(turn.request)
      await execute('Execute the prompt in this JSON dispatch specification: ' + JSON.stringify(turn.spec))
      return { kind: 'turn-ended' }
    },
  }
  return { ...f, calls, children }
}

test('Codex owner routes explicit Claude plan, review and synthesis headlessly and its native build merges', async () => {
  const f = await codexOwnerWithClaude()
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.children.map(request => request.role)).toEqual(['build'])
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.request.role)).toEqual(['plan', 'review', 'review', 'synthesis'])
  for (const call of calls) {
    expect(call.request.run_id).toBe(f.row.id)
    expect(call.argv[call.argv.indexOf('--model') + 1]).toBe(call.request.model_id)
    expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-selected-claude')
    expect(call.env.GH_TOKEN).toBeUndefined()
    expect(call.env.NEUTRON_REPLY_SINK).toBeUndefined()
    expect(call.argv).toContain('--restricted')
    expect(call.argv).not.toContain('--fallback-model')
    const envelope = JSON.parse(await readFile(call.request.result.path, 'utf8'))
    expect(envelope).toMatchObject({ run_id: f.row.id, step_id: call.request.step_id, schema: call.request.result.schema, kind: 'completed' })
  }
}, 30_000)

async function preparedClaudePlanner(f: Awaited<ReturnType<typeof codexOwnerWithClaude>>) {
  const host = await createProjectBuildHost(await f.prepare())
  const measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('expected measured fixture')
  const request = (step: string): BoundedWorkRequest => ({ ...host.workers.plan.request,
    run_id: f.row.id, step_id: `${f.row.id}:plan:${step}`, role: 'plan', needs_approval_decision: false })
  const call = async (req: BoundedWorkRequest) => {
    await host.deps.prepareWork(req, { snapshot: measured.value, previous: null, findings: [] })
    return host.workers.plan.runner.run(req, 'headless', new AbortController().signal)
  }
  return { request, call }
}

test('prepared recurring Claude planning resumes its observed conversation after host reconstruction', async () => {
  const f = await codexOwnerWithClaude()
  const first = await preparedClaudePlanner(f)
  expect((await first.call(first.request('0'))).kind).toBe('completed')
  expect((await first.call(first.request('1'))).kind).toBe('completed')
  const restarted = await preparedClaudePlanner(f)
  expect((await restarted.call(restarted.request('2'))).kind).toBe('completed')
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toHaveLength(3)
  const thread = calls[0].argv[calls[0].argv.indexOf('--session-id') + 1]
  expect(thread).toBeTruthy()
  expect(calls.map(call => call.request.thread)).toEqual([null, { id: thread }, { id: thread }])
  expect(calls.slice(1).map(call => call.argv[call.argv.indexOf('--resume') + 1])).toEqual([thread, thread])
  expect(f.children).toHaveLength(0)
}, 30_000)

for (const changed of ['model', 'credential', 'project', 'missing', 'corrupt', 'writer', 'whole-state'] as const)
test(`prepared recurring conversation refuses changed ${changed} and still admits its legitimate successor`, async () => {
  const f = await codexOwnerWithClaude()
  const first = await preparedClaudePlanner(f)
  expect((await first.call(first.request('0'))).kind).toBe('completed')
  const binding = join(f.context.stateRoot, f.row.id, 'worker-conversation-plan', 'binding.json')
  const saved = await readFile(binding, 'utf8')
  const restore: Array<() => Promise<void> | void> = []
  if (changed === 'credential') {
    f.context.env.CLAUDE_CODE_OAUTH_TOKEN = 'rotated-owner'
    restore.push(() => { f.context.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-selected-claude' })
  }
  if (changed === 'missing') { await rename(binding, `${binding}.saved`); restore.push(() => rename(`${binding}.saved`, binding)) }
  if (changed === 'corrupt') { await writeFile(binding, '{}'); restore.push(() => writeFile(binding, saved)) }
  if (changed === 'whole-state') {
    const state = join(f.context.stateRoot, f.row.id)
    await rename(state, `${state}.saved`)
    await mkdir(state)
    // Rebuild all host-owned transports/briefs exactly as restart does. Only
    // the SQLite initiation witness remains from the first conversation.
    restore.push(async () => { await rm(state, { recursive: true }); await rename(`${state}.saved`, state) })
  }
  const lock = join(f.context.stateRoot, f.row.id, 'worker-conversation-plan.writer.lock')
  if (changed === 'writer') { await writeFile(lock, ''); restore.push(() => rm(lock)) }
  if (changed === 'project') {
    f.context.projectId = 'another-project'
    await expect(preparedClaudePlanner(f)).rejects.toThrow('State directory belongs to a different project conversation or run')
    restore.push(() => { f.context.projectId = 'e2e-project' })
  } else {
    const candidate = changed === 'whole-state' ? await preparedClaudePlanner(f) : first
    const request = { ...candidate.request('1'), ...(changed === 'model' ? { model_id: 'claude-different-model' } : {}) }
    expect((await candidate.call(request)).kind).toBe('unknown')
  }
  expect((await readFile(f.calls, 'utf8')).trim().split('\n')).toHaveLength(1)
  for (const undo of restore.reverse()) await undo()
  const recovered = await preparedClaudePlanner(f)
  // Model-mismatched accounting is a distinct attempted step, so use a fresh
  // successor while keeping the same role's conversation ownership.
  expect((await recovered.call(recovered.request('2'))).kind).toBe('completed')
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls).toHaveLength(2)
  expect(calls[1].argv).toContain('--resume')
  expect(calls[1].request.thread.id).toBe(JSON.parse(saved).thread)
}, 30_000)

for (const changed of ['none', 'head', 'strategy', 'dependencies', 'runtime', 'workspace', 'missing', 'corrupt', 'subset'] as const)
test(`prepared host suite receipt survives reconstruction and handles ${changed} inputs`, async () => {
  const f = await fixture({ bunWorkspace: true })
  const original = f.context.runSuite!
  let suites = 0
  f.context.runSuite = async (...args) => { suites++; return original(...args) }
  const prepared = await f.prepare()
  let host = await createProjectBuildHost(prepared)
  let measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('expected measured fixture')
  expect(await host.deps.publicationSuite(measured.value)).toMatchObject({ kind: 'known' })
  expect(suites).toBe(1)
  const receipt = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-suite-receipt').at(-1)!
  expect(JSON.parse(receipt.meta!).receipt).toMatchObject({ head: measured.value.head, scope: 'full-suite' })
  const worktree = f.store.get(f.row.id)!.worktree!
  if (changed === 'head') expect((await spawnCapture(['git', 'commit', '--allow-empty', '-m', 'test: moved revision'], worktree)).ok).toBe(true)
  if (changed === 'dependencies') {
    // The lockfile, manifest, and git head stay unchanged; installed bytes alone
    // must invalidate the proof acquired against the previous installation.
    await writeFile(join(worktree, 'node_modules', 'proof-input'), 'changed installation')
  }
  if (changed === 'runtime') {
    const directory = join(f.dir, 'alternate-runtime')
    await mkdir(directory)
    await copyFile(process.execPath, join(directory, 'bun'))
    await chmod(join(directory, 'bun'), 0o755)
    const path = process.env.PATH
    cleanups.push(() => { if (path === undefined) delete process.env.PATH; else process.env.PATH = path })
    process.env.PATH = `${directory}:${path ?? ''}`
  }
  if (changed === 'workspace') {
    const prior = `${worktree}.prior`
    await rename(worktree, prior)
    await mkdir(worktree)
    for (const entry of await readdir(prior)) await rename(join(prior, entry), join(worktree, entry))
    await rm(prior, { recursive: true })
  }
  if (changed === 'strategy') f.input.test_strategy += '\nAdditional host strategy identity.'
  if (changed === 'missing') f.db.raw().query('DELETE FROM code_trident_stage_events WHERE run_id = ? AND stage = ?').run(f.row.id, 'build-suite-receipt')
  if (changed === 'corrupt' || changed === 'subset') {
    const value = JSON.parse(receipt.meta!)
    if (changed === 'subset') value.receipt.scope = 'subset'
    await f.store.recordStageEvent(f.row.id, 'build-suite-receipt', changed === 'corrupt' ? '{' : JSON.stringify(value))
  }
  host = await createProjectBuildHost(await f.prepare())
  measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('expected measured fixture')
  expect(await host.deps.publicationSuite(measured.value)).toMatchObject({ kind: 'known' })
  expect(suites).toBe(changed === 'none' ? 1 : 2)
  expect(f.world.dispatches).toHaveLength(0)
}, 120_000)

async function preparedPanelFixture() {
  const f = await fixture()
  f.register()
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  const move = async () => {
    await writeFile(join(worktree, 'NOTES.md'), `measured revision ${await gitOut(spawnCapture, worktree, ['rev-parse', 'HEAD'])}\n`)
    expect((await spawnCapture(['git', 'add', 'NOTES.md'], worktree)).ok).toBe(true)
    expect((await spawnCapture(['git', 'commit', '-m', 'test: measured panel revision'], worktree)).ok).toBe(true)
  }
  await move()
  const observe = async (round = 1) => {
    const host = await createProjectBuildHost(await f.prepare())
    const measured = await host.deps.measure()
    if (measured.kind !== 'known') throw Error('expected measured panel revision')
    return host.deps.observeReview(measured.value, round)
  }
  return { ...f, move, observe }
}

for (const changed of ['none', 'head', 'round', 'task', 'model', 'effort', 'credential', 'desired-credential', 'file-credential'] as const)
test(`prepared panel recovery purchases only the work invalidated by ${changed}`, async () => {
  const f = await preparedPanelFixture()
  const config = join(f.dir, 'selected-native-config')
  if (changed === 'file-credential') {
    const session = (await pool.get(f.key))!
    session.authFingerprint = ''
    supervisedBySessionKey.get(f.key)!.env!.CLAUDE_CODE_OAUTH_TOKEN = undefined
    supervisedBySessionKey.get(f.key)!.claudeConfigDir = config
    await mkdir(config)
    await writeFile(join(config, '.credentials.json'), '{"fixture":"original-account"}')
  }
  expect((await f.observe()).kind).toBe('observed')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review', 'synthesis'])
  if (changed === 'head') await f.move()
  if (changed === 'task') f.db.raw().query('UPDATE code_trident_runs SET task = ? WHERE id = ?').run('changed canonical task', f.row.id)
  if (changed === 'model') f.input.phase_models = { ...f.input.phase_models, review_adversarial: { model: 'fable' } }
  if (changed === 'effort') f.input.phase_models = { ...f.input.phase_models, review_adversarial: { model: 'opus', effort: 'low' } }
  if (changed === 'credential') (await pool.get(f.key))!.authFingerprint = 'fixture-replaced-child-credential'
  if (changed === 'desired-credential') supervisedBySessionKey.get(f.key)!.env!.CLAUDE_CODE_OAUTH_TOKEN = 'desired-but-not-spawned-credential'
  if (changed === 'file-credential') await writeFile(join(config, '.credentials.json'), '{"fixture":"changed-account"}')
  const expectedCalls = changed === 'none' || changed === 'desired-credential' ? 2 : changed === 'effort' ? 3 : 4
  expect((await f.observe(changed === 'round' ? 2 : 1)).kind).toBe('observed')
  expect(f.world.dispatches).toHaveLength(expectedCalls)
  // The newly accepted observations are themselves reusable after another host
  // reconstruction; invalidation cannot become permanent repeated work.
  expect((await f.observe(changed === 'round' ? 2 : 1)).kind).toBe('observed')
  expect(f.world.dispatches).toHaveLength(expectedCalls)
})

for (const damaged of ['missing', 'corrupt', 'foreign', 'pending', 'directory', 'whole-state'] as const)
test(`prepared panel recovery refuses ${damaged} host evidence without buying another verdict`, async () => {
  const f = await preparedPanelFixture()
  expect((await f.observe()).kind).toBe('observed')
  expect(f.world.dispatches).toHaveLength(2)
  const directory = dirname(f.world.dispatches[0]!.resultPath!)
  const path = join(directory, 'receipt.json')
  const original = await readFile(path, 'utf8')
  const restore: Array<() => Promise<void>> = []
  if (damaged === 'whole-state') {
    const state = join(f.context.stateRoot, f.row.id)
    await rename(state, `${state}.saved`)
    restore.push(async () => { await rm(state, { recursive: true }); await rename(`${state}.saved`, state) })
  } else if (damaged === 'directory') {
    await rename(directory, `${directory}.saved`)
    restore.push(() => rename(`${directory}.saved`, directory))
  } else {
    const value = JSON.parse(original)
    if (damaged === 'missing') await rm(path)
    else if (damaged === 'corrupt') await writeFile(path, '{')
    else if (damaged === 'foreign') await writeFile(path, JSON.stringify({ ...value, identity: 'another-request' }))
    else {
      await writeFile(path, JSON.stringify({ ...value, state: 'pending', observation: undefined }))
      // Without the original request there is no authority to ask the transport
      // to reconcile this pending slot, even if a result happens to exist.
      const request = join(directory, 'request.json')
      const bytes = await readFile(request, 'utf8')
      await rm(request)
      restore.push(() => writeFile(request, bytes))
    }
    restore.push(() => writeFile(path, original))
  }
  expect((await f.observe()).kind).not.toBe('observed')
  expect(f.world.dispatches).toHaveLength(2)
  for (const undo of restore) await undo()
  expect((await f.observe()).kind).toBe('observed')
  expect(f.world.dispatches).toHaveLength(2)
})

test('prepared panel recovery retains the consumed infrastructure retry and permits fresh review for a moved head', async () => {
  const f = await preparedPanelFixture()
  const paid: BoundedWorkRequest[] = []
  const observe = async () => {
    const options = await f.prepare()
    const original = options.substrate.inRepl!
    options.substrate.inRepl = { ...original, async run(request, placement, signal) {
      if (request.result.schema === 'verdict' && request.role === 'review') {
        paid.push(request)
        return { kind: 'failed', class: 'infra', detail: 'fixture infrastructure failure' }
      }
      return original.run(request, placement, signal)
    } }
    const host = await createProjectBuildHost(options)
    const measured = await host.deps.measure()
    if (measured.kind !== 'known') throw Error('expected measured panel revision')
    return host.deps.observeReview(measured.value, 1)
  }
  expect((await observe()).kind).toBe('blocked')
  expect(paid).toHaveLength(2)
  expect((await observe()).kind).toBe('blocked')
  expect(paid).toHaveLength(2)
  const retryDirectory = dirname(paid[1]!.result.path)
  await rename(retryDirectory, `${retryDirectory}.saved`)
  expect((await observe()).kind).toBe('blocked')
  expect(paid).toHaveLength(2)
  await rename(`${retryDirectory}.saved`, retryDirectory)
  await f.move()
  expect((await observe()).kind).toBe('blocked')
  expect(paid).toHaveLength(4)
})

test('prepared panel recovery reconciles a lost acknowledgement through the original native request without another paid turn', async () => {
  const f = await preparedPanelFixture()
  const options = await f.prepare()
  const runner = options.substrate.inRepl!
  let lost = false
  options.substrate.inRepl = { ...runner, async run(request, placement, signal) {
    const outcome = await runner.run(request, placement, signal)
    if (request.role === 'review' && !lost) {
      lost = true
      throw Error('fixture: acknowledgement lost after native result settled')
    }
    return outcome
  } }
  const host = await createProjectBuildHost(options)
  const measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('expected measured panel revision')
  expect((await host.deps.observeReview(measured.value, 1)).kind).not.toBe('observed')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review'])
  const originalStep = f.world.dispatches[0]!.step_id
  expect((await f.observe()).kind).toBe('observed')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review', 'synthesis'])
  expect(f.world.dispatches[0]!.step_id).toBe(originalStep)
  expect((await f.observe()).kind).toBe('observed')
  expect(f.world.dispatches).toHaveLength(2)
})

for (const damaged of ['missing', 'corrupt', 'unarmed', 'foreign'] as const)
test(`prepared pending panel refuses ${damaged} native reservation without repurchasing and recovers when restored`, async () => {
  const f = await preparedPanelFixture()
  const options = await f.prepare()
  const runner = options.substrate.inRepl!
  options.substrate.inRepl = { ...runner, async run(request, placement, signal) {
    const outcome = await runner.run(request, placement, signal)
    if (request.role === 'review') throw Error('fixture: lost native acknowledgement')
    return outcome
  } }
  const host = await createProjectBuildHost(options)
  const measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('expected measured panel revision')
  expect((await host.deps.observeReview(measured.value, 1)).kind).not.toBe('observed')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review'])
  const state = join(f.context.stateRoot, f.row.id)
  const names = (await readdir(state)).filter(name => /^claude-step-[a-f0-9]{64}\.json$/.test(name))
  // Positive control: damage the actual runner's single paid reservation, not
  // a fixture-only idempotence map or a guessed evidence path.
  expect(names).toHaveLength(1)
  const reservation = join(state, names[0]!)
  const original = await readFile(reservation, 'utf8')
  expect(original).toContain(f.world.dispatches[0]!.step_id)
  expect(original).toEndWith('\n#dispatch-armed\n')
  if (damaged === 'missing') await rm(reservation)
  else if (damaged === 'corrupt') await writeFile(reservation, '{')
  else if (damaged === 'unarmed') await writeFile(reservation, original.replace('\n#dispatch-armed\n', ''))
  else await writeFile(reservation, original.replace(f.row.id, 'foreign-run'))
  const recovered = await f.observe()
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review'])
  expect(recovered.kind).not.toBe('observed')
  await writeFile(reservation, original)
  expect((await f.observe()).kind).toBe('observed')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review', 'synthesis'])
  expect((await f.observe()).kind).toBe('observed')
  expect(f.world.dispatches).toHaveLength(2)
})

test('prepared panel recovery cannot authorize a verdict across an actual child credential change during dispatch', async () => {
  const f = await preparedPanelFixture()
  const session = (await pool.get(f.key))!
  const originalCredential = session.authFingerprint
  const options = await f.prepare()
  const runner = options.substrate.inRepl!
  options.substrate.inRepl = { ...runner, async run(request, placement, signal) {
    if (request.role === 'review') session.authFingerprint = 'changed-during-actual-dispatch'
    return runner.run(request, placement, signal)
  } }
  const host = await createProjectBuildHost(options)
  const measured = await host.deps.measure()
  if (measured.kind !== 'known') throw Error('expected measured panel revision')
  expect((await host.deps.observeReview(measured.value, 1)).kind).not.toBe('observed')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review'])
  session.authFingerprint = originalCredential
  expect((await f.observe()).kind).not.toBe('observed')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review'])
})

test('Codex owner with unavailable selected Claude credentials refuses before any worker or publication', async () => {
  const f = await codexOwnerWithClaude()
  f.context.env.CLAUDE_CODE_OAUTH_TOKEN = 'wrong-selected-credential'
  await expect(drive(f)).rejects.toThrow('provider-not-connected')
  expect(f.children).toEqual([])
  await expect(readFile(f.calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.commands.some(argv => argv[0] === 'gh' && argv.includes('create'))).toBe(false)
})

test('Codex owner cannot substitute its native child for a missing configured Claude runner', async () => {
  const f = await codexOwnerWithClaude()
  const prepared = await f.prepare()
  delete prepared.substrate.headless.anthropic
  const host = await createProjectBuildHost(prepared)
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind).not.toBe('merged')
  expect(f.children).toEqual([])
  await expect(readFile(f.calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('Codex owner observes wrong Claude schema as unknown without building or publishing', async () => {
  const f = await codexOwnerWithClaude('wrong-schema')
  const outcome = await drive(f)
  expect(outcome.kind).not.toBe('merged')
  expect(f.children).toEqual([])
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls.map(call => call.request.role)).toEqual(['plan'])
  await expect(readFile(calls[0].request.result.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.commands.some(argv => argv[0] === 'gh' && argv.includes('create'))).toBe(false)
})

test('prepared Codex build/fix transport publishes canonical artifacts while unattested review remains unavailable', async () => {
  const f = await fixture()
  const ownerHome = await mkdtemp(join(tmpdir(), 'project-build-owner-home-'))
  cleanups.push(() => rm(ownerHome, { recursive: true, force: true }))
  f.context.stateRoot = join(ownerHome, '.trident', 'project-builds')
  f.context.provider = 'openai-codex'
  f.input.phase_models = { ...f.input.phase_models, build: { model: 'sol' }, review_adversarial: { model: 'sol' } }
  const children: BoundedWorkRequest[] = []
  const execute = literalWorker(f.world)
  const guard = new CodexOwnerBindings(async () => ({ cwd: f.context.projectDir, codexHome: ownerHome, credentialIdentity: 'fixture', env: {} }))
  f.context.codexOwnerBindings = {
    guardBuildRunner: (project, worker) => guard.guardBuildRunner(project, worker),
    actingTurn: project => async turn => {
      expect(project).toBe(f.context.projectId)
      expect(turn.request.result.path.startsWith(join(f.context.projectDir, '.neutron', 'build-results'))).toBe(true)
      expect(turn.request.brief.path.startsWith(f.context.stateRoot)).toBe(true)
      children.push(turn.request)
      await execute('Execute the prompt in this JSON dispatch specification: ' + JSON.stringify(turn.spec))
      return { kind: 'turn-ended' }
    },
  }
  await expect(f.prepare()).rejects.toThrow('lacks attested read-only child execution')
  f.input.phase_models = { ...f.input.phase_models, review_adversarial: { model: 'opus' } }
  const prepared = await f.prepare()
  for (const role of ['build', 'fix'] as const) {
    const request: BoundedWorkRequest = { ...prepared.workers[role].request, run_id: f.row.id, step_id: `${f.row.id}:${role}:0`, role, needs_approval_decision: false }
    // Exercise the prepared build runner without bypassing the full host's
    // review admission refusal. This is fixture-owned measured turn context.
    const snapshot = { head: await gitOut(f.world.run, request.cwd, ['rev-parse', 'HEAD']), diff: '', pr: null }
    await writeFile(workContextPath(request.brief.path), JSON.stringify({ request, snapshot, previous: {}, findings: [] }))
    expect((await prepared.substrate.inRepl!.run(request, 'in-repl', new AbortController().signal)).kind).toBe('completed')
  }
  expect(children.map(request => request.role)).toEqual(['build', 'fix'])
  const state = join(f.context.stateRoot, encodeURIComponent(f.row.id))
  for (const role of ['build', 'fix']) {
    const artifact = JSON.parse(await readFile(join(state, `${role}.result`), 'utf8'))
    expect(artifact.run_id).toBe(f.row.id)
    expect(artifact.kind).toBe('completed')
  }
  expect(prepared.substrate.inRepl!.supports('review', 'in-repl')).toMatchObject({ ok: false, reason: 'capability-unsupported' })
  expect(prepared.substrate.inRepl!.supports('synthesis', 'in-repl')).toMatchObject({ ok: false, reason: 'capability-unsupported' })
  await guard.close()
})

test.each(['valid', 'forbidden-edit', 'wrong-schema', 'restore-lost', 'ack-lost', 'restore-mismatch'] as const)('Codex owner restricted same-provider panel and synthesis: %s', async fault => {
  const f = await codexOwnerWithClaude()
  f.input.phase_models = { ...f.input.phase_models, review_adversarial: { model: 'sol' }, review_codex: { model: 'sol' }, synthesis: { model: 'sol' } }
  const native = await restrictedOwnerFixture({ projectId: f.context.projectId, cwd: f.context.projectDir, execute: literalWorker(f.world), childSettlesAfterMs: 30,
    ...(fault === 'forbidden-edit' ? { forbiddenEdit: true } : {}),
    ...(fault === 'wrong-schema' ? { wrongSchema: true } : {}),
    ...(fault === 'restore-lost' ? { drop: 'reviewRestore' } : {}),
    ...(fault === 'ack-lost' ? { drop: 'reviewAcknowledge' } : {}),
    ...(fault === 'restore-mismatch' ? { badRestore: true } : {}),
  })
  cleanups.push(() => native.close())
  f.context.codexOwnerBindings = native.bindings
  const before = await gitOut(f.world.run, f.origin, ['rev-parse', 'refs/heads/main'])
  const outcome = await drive(f)
  expect(native.errors).toEqual([])
  expect(native.opens()).toBe(1)
  if (fault === 'valid') {
    expect(outcome.kind, why(f, outcome)).toBe('merged')
    expect(native.children.map(child => child.role)).toEqual(['build', 'review', 'review', 'review', 'synthesis'])
    expect(native.wire.filter(message => message.operation === 'reviewRelease')).toHaveLength(4)
    expect(await gitOut(f.world.run, f.origin, ['rev-parse', 'refs/heads/main'])).not.toBe(before)
    expect(f.github.prs[0]?.state).toBe('MERGED')
    const events = []
    for await (const event of native.bindings.start(f.context.projectId, { prompt: 'next owner chat', tools: [], model_preference: [] }).events) events.push(event)
    expect(events.at(-1)?.kind).toBe('completion')
  } else {
    expect(outcome.kind, why(f, outcome)).not.toBe('merged')
    expect(await gitOut(f.world.run, f.origin, ['rev-parse', 'refs/heads/main'])).toBe(before)
    expect(f.github.prs.some(pr => pr.state === 'MERGED')).toBe(false)
    expect(native.wire.filter(message => message.operation === 'reviewRelease')).toHaveLength(0)
  }
  const claude = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(claude.map(call => call.request.role)).toEqual(['plan'])
}, 30_000)

test('Bun workspace dependencies are local before workers and publication consumes them', async () => {
  const f = await fixture({ bunWorkspace: true })
  f.input.test_strategy_intermediate = 'Run targeted checks only.'
  const prepared = await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  const consumed = await spawnCapture(['bun', 'app/check.ts'], worktree)
  expect(consumed.stdout).toBe('dependency consumed')
  expect(consumed.ok).toBe(true)
  await expect(readFile(join(worktree, 'lifecycle-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.world.dispatches).toEqual([])
  const host = await createProjectBuildHost(prepared)
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  const state = join(f.context.stateRoot, encodeURIComponent(f.row.id))
  expect(await readFile(join(state, 'dependencies.log'), 'utf8')).toContain('Worktree-local dependency preparation completed')
  expect(await readFile(join(state, 'suite-round-1.log'), 'utf8')).toContain('dependency consumed')
}, 120_000)

test('Bun workspace recovery repairs missing dependencies before workers', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  await rm(join(worktree, 'node_modules'), { recursive: true })
  await rm(join(worktree, 'app', 'node_modules'), { recursive: true })
  const broken = await spawnCapture(['bun', 'scripts/ci/verify-workspace-deps.ts'], worktree)
  expect(broken.ok).toBe(false)
  expect(broken.stderr).toContain('node_modules/.bun does not exist')
  f.input.run = f.store.get(f.row.id)!
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  const log = await readFile(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies.log'), 'utf8')
  expect(log.match(/Worktree-local dependency preparation completed/g)).toHaveLength(2)
}, 120_000)

test('Bun workspace unchanged recovery saves an install and still verifies before merging', async () => {
  const f = await fixture({ bunWorkspace: true })
  const original = f.context.runInstall!
  const calls: string[] = []
  f.context.runInstall = Object.assign(async (...args: Parameters<typeof original>) => {
    calls.push(args[0][2]!.includes('verify-workspace-deps.ts') ? 'verify' : 'install')
    return original(...args)
  }, { writesDiffOutput: true as const })
  await f.prepare()
  expect(calls).toEqual(['install', 'verify'])
  f.input.run = f.store.get(f.row.id)!
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(calls).toEqual(['install', 'verify', 'verify'])
}, 120_000)

for (const changed of ['root manifest', 'workspace manifest', 'lockfile', 'config', 'branch verifier',
  'revision', 'missing receipt', 'corrupt receipt', 'wrong receipt', 'missing modules', 'toolchain'] as const) {
  test(`Bun workspace receipt requires installation after changed ${changed}`, async () => {
    const f = await fixture({ bunWorkspace: true })
    await f.prepare()
    const worktree = f.store.get(f.row.id)!.worktree!
    const receipt = join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies-receipt.json')
    // Positive control: a real verified install created the observation we invalidate.
    expect(JSON.parse(await readFile(receipt, 'utf8')).key).toMatch(/^[a-f0-9]{64}$/)
    const originalPath = process.env.PATH
    if (changed === 'revision') {
      await gitOut(spawnCapture, worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture revision'])
    } else if (changed === 'missing receipt' || changed === 'missing modules') {
      await rm(changed === 'missing receipt' ? receipt : join(worktree, 'node_modules'), { recursive: true })
    } else if (changed === 'corrupt receipt') await writeFile(receipt, 'invalid')
    else if (changed === 'wrong receipt') {
      const stored = JSON.parse(await readFile(receipt, 'utf8'))
      await writeFile(receipt, JSON.stringify({ ...stored, key: '0'.repeat(64) }))
    } else if (changed === 'toolchain') {
      const bin = join(f.dir, 'replacement-toolchain')
      await mkdir(bin)
      const actual = Bun.which('bun')!
      await writeFile(join(bin, 'bun'), `#!/bin/sh\nexec '${actual.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 })
      process.env.PATH = `${bin}:${originalPath}`
    } else {
      const path = join(worktree, {
        'root manifest': 'package.json', 'workspace manifest': 'app/package.json', 'lockfile': 'bun.lock',
        'config': 'bunfig.toml', 'branch verifier': 'scripts/ci/verify-workspace-deps.ts',
      }[changed])
      await writeFile(path, `${await readFile(path, 'utf8')}\n`)
    }
    const original = f.context.runInstall!
    const calls: string[] = []
    f.context.runInstall = Object.assign(async (...args: Parameters<typeof original>) => {
      calls.push(args[0][2]!.includes('verify-workspace-deps.ts') ? 'verify' : 'install')
      return original(...args)
    }, { writesDiffOutput: true as const })
    try {
      await f.prepare()
      expect(calls).toEqual(['install', 'verify'])
      expect(JSON.parse(await readFile(receipt, 'utf8')).key).toMatch(/^[a-f0-9]{64}$/)
    } finally { process.env.PATH = originalPath }
  }, 30_000)
}

test('Bun workspace reused receipt never hides verifier failure and failure invalidates success', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const receipt = join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies-receipt.json')
  const stored = await readFile(receipt, 'utf8')
  expect(JSON.parse(stored).key).toMatch(/^[a-f0-9]{64}$/)
  const original = f.context.runInstall!
  const calls: string[] = []
  let failVerification = true
  f.context.runInstall = Object.assign(async (...args: Parameters<typeof original>) => {
    const verifier = args[0][2]!.includes('verify-workspace-deps.ts')
    calls.push(verifier ? 'verify' : 'install')
    if (verifier && failVerification) return { ok: false, exit_code: 3, stdout: '', stderr: 'verification failed' }
    return original(...args)
  }, { writesDiffOutput: true as const })
  await expect(f.prepare()).rejects.toThrow('workspace dependency verification did not complete successfully')
  expect(calls).toEqual(['verify'])
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.world.dispatches).toEqual([])
  failVerification = false
  await f.prepare()
  expect(calls).toEqual(['verify', 'install', 'verify'])
}, 30_000)

test('Bun workspace receipt cannot borrow an ancestor after its local dependency disappears', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  const ancestor = join(worktree, '..', 'node_modules', 'fixture-dependency')
  await mkdir(ancestor, { recursive: true })
  await writeFile(join(ancestor, 'package.json'), JSON.stringify({ name: 'fixture-dependency', main: 'index.js' }))
  await writeFile(join(ancestor, 'index.js'), 'exports.message = "borrowed dependency"')
  await rm(join(worktree, 'app', 'node_modules', 'fixture-dependency'))
  // Positive control: the old verifier really accepts the ancestor resolution.
  const verifier = fileURLToPath(new URL('../../scripts/ci/verify-workspace-deps.ts', import.meta.url))
  expect((await spawnCapture(['bun', '--config=/dev/null', '--no-env-file', verifier, worktree], f.dir)).ok).toBe(true)
  expect((await spawnCapture(['bun', 'app/check.ts'], worktree)).stderr).toContain('wrong dependency')
  const original = f.context.runInstall!
  let installs = 0
  f.context.runInstall = Object.assign(async (...args: Parameters<typeof original>) => {
    if (!args[0][2]!.includes('verify-workspace-deps.ts')) installs++
    return original(...args)
  }, { writesDiffOutput: true as const })
  await f.prepare()
  expect(installs).toBe(1)
  expect((await spawnCapture(['bun', 'app/check.ts'], worktree)).stdout).toBe('dependency consumed')
}, 30_000)

for (const shape of ['borrowed', 'hoisted'] as const) {
  test(`Bun workspace receipt tracks ${shape} peer dependencies`, async () => {
    const f = await fixture({ bunWorkspace: true, bunWorkspacePeer: true })
    await f.prepare()
    const worktree = f.store.get(f.row.id)!.worktree!
    const local = join(worktree, 'app', 'node_modules', 'fixture-peer')
    const target = await realpath(local)
    if (shape === 'borrowed') {
      const ancestor = join(worktree, '..', 'node_modules', 'fixture-peer')
      await mkdir(ancestor, { recursive: true })
      await writeFile(join(ancestor, 'package.json'), JSON.stringify({ name: 'fixture-peer', main: 'index.js' }))
      await writeFile(join(ancestor, 'index.js'), 'exports.message = "borrowed peer"')
    } else await symlink(target, join(worktree, 'node_modules', 'fixture-peer'))
    await rm(local)
    const before = await spawnCapture(['bun', 'app/check.ts'], worktree)
    if (shape === 'borrowed') expect(before.stderr).toContain('wrong peer')
    else expect(before.ok, before.stderr).toBe(true)
    const original = f.context.runInstall!
    let installs = 0
    f.context.runInstall = Object.assign(async (...args: Parameters<typeof original>) => {
      if (!args[0][2]!.includes('verify-workspace-deps.ts')) installs++
      return original(...args)
    }, { writesDiffOutput: true as const })
    await f.prepare()
    expect(installs).toBe(shape === 'borrowed' ? 1 : 0)
    const after = await spawnCapture(['bun', 'app/check.ts'], worktree)
    expect(after.ok, after.stderr).toBe(true)
  }, 30_000)
}

test('Bun workspace preparation never records external peer resolution as reusable evidence', async () => {
  const f = await fixture({ bunWorkspace: true, bunWorkspacePeer: true })
  const ancestor = join(f.dir, 'external-peer')
  await mkdir(ancestor)
  await writeFile(join(ancestor, 'package.json'), JSON.stringify({ name: 'fixture-peer', main: 'index.js' }))
  await writeFile(join(ancestor, 'index.js'), 'exports.message = "borrowed peer"')
  const original = f.context.runInstall!
  let borrow = true
  let installs = 0
  f.context.runInstall = Object.assign(async (...args: Parameters<typeof original>) => {
    if (args[0][2]!.includes('verify-workspace-deps.ts')) return original(...args)
    installs++
    const local = join(args[1]!, 'app', 'node_modules', 'fixture-peer')
    await rm(local, { force: true })
    const result = await original(...args)
    if (borrow) {
      await rm(local)
      await symlink(ancestor, local)
    }
    return result
  }, { writesDiffOutput: true as const })
  const receipt = join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies-receipt.json')
  await f.prepare()
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.prepare()
  expect(installs).toBe(2)
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
  borrow = false
  await f.prepare()
  expect(JSON.parse(await readFile(receipt, 'utf8')).resolution).toMatch(/^[a-f0-9]{64}$/)
  await f.prepare()
  expect(installs).toBe(3)
}, 30_000)

test('Bun workspace receipt preserves valid root-local hoisting and stable unresolved optional probes', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  const local = join(worktree, 'app', 'node_modules', 'fixture-dependency')
  const target = await realpath(local)
  await symlink(target, join(worktree, 'node_modules', 'fixture-dependency'))
  await rm(local)
  const manifest = join(worktree, 'app', 'package.json')
  const parsed = JSON.parse(await readFile(manifest, 'utf8'))
  await writeFile(manifest, JSON.stringify({ ...parsed, optionalDependencies: { 'unavailable-fixture-optional': '*' } }))
  const original = f.context.runInstall!
  let installs = 0
  f.context.runInstall = Object.assign(async (...args: Parameters<typeof original>) => {
    if (!args[0][2]!.includes('verify-workspace-deps.ts')) {
      installs++
      // Model an installer that omits an unavailable optional package. All
      // resolution/verifier/receipt behavior remains the real consuming path.
      return { ok: true, exit_code: 0, stdout: '', stderr: '' }
    }
    return original(...args)
  }, { writesDiffOutput: true as const })
  await f.prepare()
  expect(installs).toBe(1)
  await f.prepare()
  expect(installs).toBe(1)
  expect((await spawnCapture(['bun', 'app/check.ts'], worktree)).stdout).toBe('dependency consumed')
}, 30_000)

test('Bun workspace receipt refuses a borrowed Bun store before workers', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  const store = join(worktree, 'node_modules', '.bun')
  const borrowed = join(f.dir, 'borrowed-store')
  await rename(store, borrowed)
  await symlink(borrowed, store)
  f.context.runInstall = Object.assign(async () => { throw new Error('must refuse before commands') }, { writesDiffOutput: true as const })
  await expect(f.prepare()).rejects.toThrow('Bun store must be a worktree-local directory')
  expect(f.world.dispatches).toEqual([])
  await expect(readFile(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies-receipt.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
}, 30_000)

for (const shape of ['failure', 'failure-installed', 'empty-success', 'empty-store', 'timeout', 'timeout-installed'] as const) {
  test(`Bun workspace install ${shape} cannot dispatch or publish`, async () => {
    const f = await fixture({ bunWorkspace: true })
    let installs = 0
    const original = f.context.runInstall!
    f.context.runInstall = Object.assign(async (argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) => {
      if (argv[2]?.includes('verify-workspace-deps.ts')) return original(argv, cwd, env, timeout)
      installs++
      expect(timeout).toBe(PROJECT_DEPENDENCIES_TIMEOUT_MS)
      if (shape === 'empty-store') await mkdir(join(cwd!, 'node_modules', '.bun'), { recursive: true })
      if (shape.endsWith('-installed')) expect((await original(argv, cwd, env, timeout)).ok).toBe(true)
      const failed = shape.startsWith('failure')
      return { ok: !failed, exit_code: failed ? 1 : 0,
        stdout: '', stderr: '', ...(shape.startsWith('timeout') ? { timed_out: true } : {}) }
    }, { writesDiffOutput: true as const })
    await expect(drive(f)).rejects.toThrow('Build dependency preparation failed')
    expect(installs).toBe(1)
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
    const log = await readFile(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies.log'), 'utf8')
    expect(log).toContain('REFUSED:')
    await expect(readFile(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies-receipt.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
}

test('Bun workspace publication suite still refuses merge when dependencies disappear', async () => {
  const f = await fixture({ bunWorkspace: true })
  f.input.test_strategy_intermediate = 'Run targeted checks only.'
  const prepared = await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  await rm(join(worktree, 'node_modules'), { recursive: true })
  const host = await createProjectBuildHost(prepared)
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind).not.toBe('merged')
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'build')).toBe(true)
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  expect(await gitOut(spawnCapture, f.origin, ['rev-parse', 'refs/heads/main'])).toBe(f.baseSha)
  expect(await readFile(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'suite-round-1.log'), 'utf8'))
    .toContain('node_modules/.bun does not exist')
}, 120_000)

test('Bun workspace recovery rejects a shared node_modules symlink before installation', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  await rm(join(worktree, 'node_modules'), { recursive: true })
  await mkdir(join(f.repo, 'node_modules'))
  await symlink(join(f.repo, 'node_modules'), join(worktree, 'node_modules'))
  f.context.runInstall = Object.assign(async () => { throw new Error('must reject before install') }, { writesDiffOutput: true as const })
  await expect(f.prepare()).rejects.toThrow('node_modules must be a worktree-local directory')
  expect(f.world.dispatches).toEqual([])
  expect(f.github.prs).toEqual([])
}, 30_000)

test('Bun workspace hung installer is killed by the bounded host watchdog', async () => {
  const f = await fixture({ bunWorkspace: true })
  f.context.runInstall = Object.assign((_argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) =>
    spawnCapture(['bash', '-c', 'exec sleep 60'], cwd, env, timeout), { writesDiffOutput: true as const })
  const nativeTimeout = globalThis.setTimeout
  const clock = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(callback, ms === PROJECT_DEPENDENCIES_TIMEOUT_MS ? 20 : ms, ...args)
  ) as typeof setTimeout)
  try {
    await expect(drive(f)).rejects.toThrow('Build dependency preparation failed')
    const log = await readFile(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies.log'), 'utf8')
    expect(log).toContain('timed_out=true')
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
  } finally { clock.mockRestore() }
}, 30_000)

test('Bun workspace preparation uses the host verifier without executing the branch verifier', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  await writeFile(join(worktree, 'scripts', 'ci', 'verify-workspace-deps.ts'),
    'await Bun.write("branch-verifier-ran", "executed"); process.exit(0)\n')
  await f.prepare()
  await expect(readFile(join(worktree, 'branch-verifier-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Positive control: the replaced branch script is executable and produces the marker.
  const executed = await spawnCapture(['bun', 'scripts/ci/verify-workspace-deps.ts'], worktree)
  expect(executed.ok).toBe(true)
  expect(await readFile(join(worktree, 'branch-verifier-ran'), 'utf8')).toBe('executed')
}, 30_000)

test('Bun workspace preparation cannot execute branch bunfig preloads through the host verifier', async () => {
  const f = await fixture({ bunWorkspace: true })
  await f.prepare()
  const worktree = f.store.get(f.row.id)!.worktree!
  const marker = join(f.dir, 'branch-preload-ran')
  await writeFile(join(worktree, 'preload.ts'), `await Bun.write(${JSON.stringify(marker)}, "executed")\n`)
  await writeFile(join(worktree, 'bunfig.toml'), 'preload = ["./preload.ts"]\n[install]\nlinker = "isolated"\n')
  const verifier = fileURLToPath(new URL('../../scripts/ci/verify-workspace-deps.ts', import.meta.url))
  // Positive control reproduces the old invocation: a trusted absolute script
  // still runs the worktree's preload before checking any dependencies.
  const oldInvocation = await spawnCapture(['bun', verifier, worktree], worktree)
  expect(oldInvocation.ok, oldInvocation.stderr).toBe(true)
  expect(await readFile(marker, 'utf8')).toBe('executed')
  await rm(marker)
  const original = f.context.runInstall!
  const observed: string[] = []
  f.context.runInstall = Object.assign(async (argv: string[], cwd?: string, env?: Record<string, string>, timeout?: number) => {
    const result = await original(argv, cwd, env, timeout)
    // Observe each exact production command separately, including bun install
    // from the worktree; --ignore-scripts is not a runtime preload boundary.
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    observed.push(argv[2]?.includes('verify-workspace-deps.ts') ? 'verify' : 'install')
    return result
  }, { writesDiffOutput: true as const })
  await f.prepare()
  expect(observed).toEqual(['install', 'verify'])
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  const log = await readFile(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies.log'), 'utf8')
  expect(log.match(/workspace dependency verification: exit=0; timed_out=false/g)).toHaveLength(2)
  expect(f.world.dispatches).toEqual([])
}, 30_000)

for (const [kind, manifest] of [
  ['no manifest', undefined],
  ['npm workspace', { workspaces: ['app'], packageManager: 'npm@10.0.0' }],
  ['unmarked workspace', { workspaces: ['app'] }],
  ['Bun single package', { packageManager: 'bun@1.3.13' }],
] as const) {
  test(`non-Bun-workspace repository (${kind}) never invokes dependency installation and can merge`, async () => {
    const f = await fixture(manifest ? { manifest } : {})
    let installs = 0
    f.context.runInstall = Object.assign(async () => {
      installs++
      throw new Error('non-Bun repository must not be installed with Bun')
    }, { writesDiffOutput: true as const })
    const outcome = await drive(f)
    expect(outcome.kind, why(f, outcome)).toBe('merged')
    expect(installs).toBe(0)
  }, 120_000)
}

async function codexReviewEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const calls = (await readFile(f.codexCalls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const state = join(f.context.stateRoot, encodeURIComponent(f.row.id))
  for (const entry of await readdir(state, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('review-')) continue
    const directory = join(state, entry.name)
    const brief = JSON.parse(await readFile(join(directory, 'brief.json'), 'utf8'))
    if (brief.seat !== 'review_codex') continue
    return { calls, brief, envelope: JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) }
  }
  throw new Error('Codex review evidence directory was not retained')
}

/**
 * Recreate what a fresh retry sees after its prior process published and then
 * died: the new worktree is still at the pinned base, while the real remote
 * branch and its open PR point at the prior process's different commit.
 */
async function seedPriorPublication(f: Awaited<ReturnType<typeof fixture>>, publishedPr: number) {
  const options = await f.prepare()
  const run = f.store.get(f.row.id)!
  if (!run.branch || !run.worktree) throw new Error('prepared run has no branch or worktree')
  const setup = async (args: string[]) => {
    const result = await spawnCapture(['git', '-C', f.repo, ...args], f.repo)
    if (!result.ok) throw new Error(`prior publication setup failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  await setup(['switch', '-c', 'prior-publication', 'main'])
  await writeFile(join(f.repo, 'NOTES.md'), 'seed\nprior publication\n')
  await setup(['add', '--', 'NOTES.md'])
  await setup(['commit', '-m', 'test: prior publication'])
  const priorHead = await setup(['rev-parse', 'HEAD^{commit}'])
  await setup(['push', f.origin, `${priorHead}:refs/heads/${run.branch}`])
  await setup(['switch', 'main'])
  await setup(['branch', '-D', 'prior-publication'])
  f.github.prs.push({ number: 1, state: 'OPEN', headRefName: run.branch, baseRefName: 'main' })
  await f.store.update(f.row.id, { published_pr: publishedPr })
  return { options, branch: run.branch, worktree: run.worktree, priorHead }
}

/**
 * ONE DRIVER PROCESS THAT DOES NOT LIVE TO CLEAN UP.
 *
 * `createProjectBuildHost(...).run` wraps every build in `withProductionCleanup`
 * (`project-build-host.ts:104-112`), whose `finally` removes the worktree and
 * deletes the branch. A gateway that is KILLED mid-run never reaches that finally,
 * and the whole point of resume is what the next process finds on disk — so this
 * drives the same `buildRun` state machine over the same real `host.deps` and
 * `host.workers` and simply stops when the driver returns.
 *
 * The four fields below are the ONLY thing reconstructed here; they are exactly
 * what `project-build-host.ts:107` passes, read from the same places.
 */
async function driveUntilTheProcessDies(f: Awaited<ReturnType<typeof fixture>>, start: 'fresh' | 'resume'): Promise<BuildRunOutcome> {
  const host = await createProjectBuildHost(await f.prepare())
  return buildRun({ mode: 'implementation', start, run_id: f.row.id, workers: host.workers,
    repl_provider: 'anthropic', merge_mode: f.store.get(f.row.id)!.merge_mode },
  host.deps, new AbortController().signal)
}

for (const owned of [true, false]) test(`salvaged publication ${owned ? 'carries its creation receipt' : 'does not adopt a discovered PR'} into the real retry consumer`, async () => {
  const task = 'Record a note in NOTES.md and verify the note survives publication and retry without rebuilding'
  const f = await fixture({ dispatchTask: task })
  const firstHost = await createProjectBuildHost(await f.prepare())
  firstHost.deps.publishGate = async () => ({ kind: 'blocked', on: 'fixture proof infrastructure unavailable' })
  expect(await buildRun({ mode: 'implementation', start: 'fresh', run_id: f.row.id,
    workers: firstHost.workers, repl_provider: 'anthropic', merge_mode: 'pr' },
  firstHost.deps, new AbortController().signal)).toMatchObject({ kind: 'blocked', phase: 'publish' })
  const checkpoint = lastCheckpoint(f)
  const prior = f.store.get(f.row.id)!
  expect(checkpoint).toMatchObject({ stage: 'built', round: 1 })
  if (!owned) f.github.prs.push({ number: 1, state: 'OPEN', headRefName: prior.branch!, baseRefName: 'main' })
  const salvageHost = Object.assign(async (...args: Parameters<typeof f.context.runHost>) => {
    const argv = args[0]
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'list' && argv.includes('--jq')) {
      const pr = f.github.prs.find(row => row.headRefName === argv[argv.indexOf('--head') + 1])
      return { ok: true, exit_code: 0, stdout: pr ? String(pr.number) : '', stderr: '' }
    }
    return f.context.runHost(...args)
  }, { writesDiffOutput: true as const })
  const orch = buildTridentOrchestrator({ fire_workflow: async () => { throw Error('No build dispatch during salvage') },
    db_path: f.input.db_path, base_branch: 'main', run_host: salvageHost, sleep: async () => {},
    persist_refire_reset: async (id, patch) => { await f.store.update(id, patch) },
    leak_preflight: async input => ({ status: 'clean', head: input.head, findings: [], skipped_rules: [], attempts: 0, note: 'fixture scanner' }) })
  const salvaged = await orch.reconcile_stranded({ ...prior, phase: 'failed', failure_reason: 'proof infrastructure unavailable' })
  expect(salvaged).not.toBeNull()
  expect(salvaged!.pr).toBe(1)
  expect(salvaged!.published_pr).toBe(owned ? 1 : null)
  // The old driver is terminal and its worktree has been released before a new
  // launch claims the same branch; the saved build checkpoint survives cleanup.
  expect((await spawnCapture(['git', '-C', f.repo, 'worktree', 'remove', '--force', prior.worktree!], f.repo)).ok).toBe(true)
  await f.store.save({ ...salvaged!, worktree: null })
  const dispatched = await dispatchBoardBoundBuild({ task, board_item_id: 'salvage-retry-card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    board: { get: () => ({ id: 'salvage-retry-card', title: task, design_doc_ref: null, linked_run_id: prior.id }), attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => 'pr',
  })
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  expect(dispatched.run.published_pr).toBe(owned ? 1 : null)
  f.world.dispatches.length = 0
  f.input.run = dispatched.run
  const host = await createProjectBuildHost(await f.prepare())
  const outcome = await host.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe(owned ? 'merged' : 'unknown')
  expect(f.world.dispatches.some(call => ['plan', 'build'].includes(call.role))).toBe(false)
  expect(f.github.prs[0]!.state).toBe(owned ? 'MERGED' : 'OPEN')
  expect(f.github.prs).toHaveLength(1)
}, 30_000)

/** The state a restarted driver actually reads back (`production-host-effects.ts:235`). */
function lastCheckpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const events = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state')
  return JSON.parse(events.at(-1)!.meta!).checkpoint as Record<string, unknown>
}

/** Recover through the outer gateway and its actual project launcher. */
async function restartThroughGateway(f: Awaited<ReturnType<typeof fixture>>) {
  const before = f.store.get(f.row.id)!
  expect(before.inner_checkpoint).toBeNull()
  expect(before.inner_checkpoint_head).toBeNull()
  await f.store.update(f.row.id, { inner_result: JSON.stringify({
    projectBuild: { kind: 'unknown', phase: 'plan', step_id: null, detail: 'prior gateway ended' },
    projectBuildReservation: { kind: 'in-process-driver', gateway_session: 'prior-gateway' },
  }) })
  let settled!: () => void
  const completion = new Promise<void>(resolve => { settled = resolve })
  const record = f.store.recordStageEvent.bind(f.store)
  const recording = spyOn(f.store, 'recordStageEvent').mockImplementation(async (...args) => {
    await record(...args)
    if (args[1] === 'build-driver-settled') settled()
  })
  cleanups.push(() => recording.mockRestore())
  const launcher = createProjectLauncher({ store: f.store, onError: error => { throw error }, prepare: async input => {
    expect(lastCheckpoint(f).stage).toBe(input.resume_checkpoint)
    expect(lastCheckpoint(f).head).toBe(input.resume_checkpoint_head)
    f.input.run = input.run
    return f.prepare()
  } })
  const orch = buildTridentOrchestrator({ fire_workflow: launcher, db_path: f.input.db_path,
    base_branch: 'main', run_host: Object.assign(f.context.runHost, { writesDiffOutput: true as const }),
    read_run: id => f.store.get(id), list_stage_events: id => f.store.stageEvents(id),
    begin_project_build_driver_recovery: (id, reservation) => f.store.beginProjectBuildDriverRecovery(id, reservation),
    sleep: async () => {} })
  const advanced = await orch.step(f.store.get(f.row.id)!)
  expect(advanced.run.phase, advanced.run.failure_reason ?? advanced.note).not.toBe('failed')
  expect(await f.store.saveIfActive(advanced.run)).toBe(true)
  await completion
  expect(f.store.get(f.row.id)!.crash_recoveries).toBe(1)
  expect(f.store.get(f.row.id)!.base_sha).toBe(before.base_sha)
  return JSON.parse(f.store.get(f.row.id)!.inner_result!).projectBuild as ProjectBuildOutcome
}

/**
 * LAUNCH ANY ROW THROUGH THE OUTER GATEWAY, the way a dispatched run is really
 * started: the orchestrator's `step` → `launch` → `prepareLaunch`
 * (`trident/orchestrator.ts`) → the real project launcher → `createProjectBuildHost`
 * → `buildRun`. Unlike `restartThroughGateway` it asserts no crash-recovery
 * preconditions, so a RE-DISPATCHED row can be driven from its first fire.
 * `onPrepare` sees exactly what `prepareLaunch` handed the launcher. A launch that
 * ends `failed` before firing returns no outcome instead of waiting for a driver
 * that never started.
 */
async function launchThroughGateway(f: Awaited<ReturnType<typeof fixture>>, runId: string,
  onPrepare: (input: InnerLoopInput) => void) {
  let settled!: () => void
  const completion = new Promise<void>(resolve => { settled = resolve })
  const record = f.store.recordStageEvent.bind(f.store)
  const recording = spyOn(f.store, 'recordStageEvent').mockImplementation(async (...args) => {
    await record(...args)
    if (args[0] === runId && args[1] === 'build-driver-settled') settled()
  })
  cleanups.push(() => recording.mockRestore())
  const errors: unknown[] = []
  const launcher = createProjectLauncher({ store: f.store, onError: error => { errors.push(error) }, prepare: async input => {
    onPrepare(input)
    f.input.run = input.run
    return f.prepare()
  } })
  const orch = buildTridentOrchestrator({ fire_workflow: launcher, db_path: f.input.db_path,
    base_branch: 'main', run_host: Object.assign(f.context.runHost, { writesDiffOutput: true as const }),
    read_run: id => f.store.get(id), list_stage_events: id => f.store.stageEvents(id),
    begin_project_build_driver_recovery: (id, reservation) => f.store.beginProjectBuildDriverRecovery(id, reservation),
    sleep: async () => {} })
  const advanced = await orch.step(f.store.get(runId)!)
  if (advanced.run.phase === 'failed') return { stepped: advanced.run, outcome: null, errors }
  expect(await f.store.saveIfActive(advanced.run)).toBe(true)
  await completion
  return { stepped: advanced.run, errors,
    outcome: JSON.parse(f.store.get(runId)!.inner_result!).projectBuild as ProjectBuildOutcome }
}

/** The outcome plus the dispatch trail — a stop is only legible with both. */
function why(f: Awaited<ReturnType<typeof fixture>>, outcome: BuildRunOutcome | ProjectBuildOutcome): string {
  return JSON.stringify({ outcome, dispatches: f.world.dispatches })
}

for (const spec of [false, true]) for (const strategy of ['single', 'task_sequence'] as const)
test(`initial planner chooses ${strategy} through board and launcher ${spec ? 'with' : 'without'} SPEC.md`, async () => {
  const f = await fixture({ spec, taskSequence: strategy === 'task_sequence', moreTasks: true, seedLedger: false, hostLedger: true })
  const task = 'Record and verify both requested notes with the complete regression suite. MORE TASKS'
  const dispatched = await dispatchBoardBoundBuild({ task, board_item_id: 'strategy-card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    board: { get: () => ({ id: 'strategy-card', title: task, design_doc_ref: null, linked_run_id: null }), attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => 'pr', hostRunner: f.context.runHost,
  })
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  expect(dispatched.run.execution_strategy).toBeNull()
  expect(dispatched.run.strategy_rationale).toBeNull()
  expect(dispatched.run.strategy_plan).toBeNull()
  const launched = await launchThroughGateway(f, dispatched.run.id, input => {
    expect(input.run.execution_strategy).toBeNull()
  })
  expect(launched.errors).toEqual([])
  expect(launched.outcome?.kind, JSON.stringify(launched.outcome)).toBe(strategy === 'single' ? 'merged' : 'continued')
  expect(f.world.dispatches.filter(d => d.role === 'plan')).toHaveLength(1)
  expect(f.world.dispatches.filter(d => d.role === 'build')).toHaveLength(1)
  expect(f.world.builderObservations).toHaveLength(1)
  const observed = f.world.builderObservations[0]!
  expect(observed).toMatchObject({ strategy, contextStrategy: strategy,
    rationale: 'The accepted plan determines the useful execution boundary.',
    scope: strategy === 'single' ? 'host-suite' : 'subset' })
  expect(JSON.parse(observed.plan as string)).toMatchObject({ strategy, implementationPlan: '- [ ] T1 record the note\n- [ ] T2 record another note\n' })
  expect(observed.previous).toMatchObject({ strategy, implementationPlan: '- [ ] T1 record the note\n- [ ] T2 record another note\n' })
  expect(f.world.selectedTasks).toEqual(strategy === 'single'
    ? ['- [ ] T1 record the note', '- [ ] T2 record another note'] : ['- [ ] T1 record the note'])
  expect(f.world.dispatches.some(d => d.role === 'review')).toBe(strategy === 'single')
  expect(f.github.prs).toHaveLength(strategy === 'single' ? 1 : 0)
}, 60_000)

for (const patch of [
  { strategy: undefined }, { strategy: 'parallel' }, { strategy: null },
  { rationale: '' }, { rationale: '   ' }, { strategy: 'single', unexpected: true },
  { implementationPlan: '' }, { executionSpec: '' }, { remainingTasks: -1 },
]) test(`invalid initial strategy prevents builder dispatch: ${JSON.stringify(patch)}`, async () => {
  const f = await fixture()
  f.world.plannerPatch = patch
  const outcome = await drive(f)
  expect(outcome).toMatchObject({ kind: 'unknown', phase: 'plan', detail: 'Trailer result failed host schema validation.' })
  expect(f.world.dispatches.map(d => d.role)).toEqual(['plan'])
  expect(f.world.builderObservations).toEqual([])
  expect(f.store.get(f.row.id)!.execution_strategy).toBeNull()
  expect(f.store.get(f.row.id)!.strategy_plan).toBeNull()
  expect(f.github.prs).toEqual([])
}, 30_000)

// ─────────────────────────────────────────────────────────────────────────────
// THE TESTS
// ─────────────────────────────────────────────────────────────────────────────

// Acquisition is driven through the same composed host as the successful build.
//
// EVERY DETAIL HERE IS DISTINCT, AND THAT IS THE ASSERTION (#1085). Three of these
// shapes — `missing`, `ambiguous-before`, `ambiguous-after` — used to answer with one
// string, "Project conversation session is missing or ambiguous". That string is the
// ONLY thing an operator receives: it travels out as the run's uncertainty detail via
// `runtime/workers/project-runners.ts`. So an instance that had lost its project REPL
// and an instance that was spawning two of them under one project id were, on the
// wire, the same event — and the acts they call for are opposites. The table pins the
// strings; `acquisitionDetails` below pins that no two of them are equal, so a future
// edit cannot quietly re-merge them and stay green.
const acquisitionCases = [
  ['missing', 'Project conversation session was NOT created: the spawn for project id "e2e-project" returned without error (none existed) and no live cc-agent session exists for it'],
  ['ambiguous-before', 'Project conversation session is AMBIGUOUS: 2 live cc-agent sessions carry project id "e2e-project"'],
  ['ambiguous-after', 'Project conversation session is AMBIGUOUS after a spawn: 2 live cc-agent sessions carry project id "e2e-project"'],
  ['reject', 'Project conversation session could not be started (none existed): start failed'],
  ['missing-pool', 'Project conversation is not ready'],
  ['pending', 'Project conversation is not ready'],
  ['empty', 'Project conversation child is unavailable'],
  ['exited', 'Project conversation child is unavailable'],
] as const

test('#1085 — the acquisition failures that call for different acts carry different strings', () => {
  // `missing-pool`/`pending` and `empty`/`exited` legitimately pair up: each pair is
  // one fact about one session reached two ways. The three that must NOT pair are the
  // ones about how many sessions exist.
  const distinct = ['missing', 'ambiguous-before', 'ambiguous-after', 'reject']
    .map(shape => acquisitionCases.find(([s]) => s === shape)![1])
  expect(new Set(distinct).size).toBe(distinct.length)
  // And each says WHICH of the two counts it saw, so the string is actionable rather
  // than merely unique.
  expect(distinct[0]).toContain('NOT created')
  expect(distinct[1]).toContain('AMBIGUOUS: 2')
  expect(distinct[2]).toContain('AMBIGUOUS after a spawn: 2')
})

for (const [shape, detail] of acquisitionCases) {
  test(`session acquisition: ${shape} stops as unknown before dispatch`, async () => {
    const f = await fixture()
    let spawns = 0
    const ambiguous = () => { f.register(); f.register({ key: `${f.key}-second` }) }
    if (shape === 'ambiguous-before') ambiguous()
    f.context.spawnProjectSession = async projectId => {
      expect(projectId).toBe(f.context.projectId)
      spawns++
      if (shape === 'reject') throw new Error('start failed')
      if (shape === 'ambiguous-after') ambiguous()
      if (shape === 'missing-pool') f.register({ state: 'missing' })
      if (shape === 'pending' || shape === 'empty' || shape === 'exited') f.register({ state: shape })
    }
    const outcome = await drive(f)
    expect(outcome).toMatchObject({ kind: 'unknown', phase: 'plan',
      detail: `Dispatch turn completion unknown: ${detail}` })
    expect(spawns).toBe(shape === 'ambiguous-before' ? 0 : 1)
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
  }, 30_000)
}

for (const state of ['ready', 'exited', 'rekeyed'] as const) {
  test(`session acquisition: ${state} session reaches merge`, async () => {
    const f = await fixture()
    // An adopted session can have a different map key. Selection uses its options.
    f.register({ key: state === 'rekeyed' ? `${f.key}-adopted` : f.key,
      state: state === 'exited' ? 'exited' : 'ready' })
    // Both filter clauses must exclude unrelated live sessions.
    f.register({ key: `${f.key}-other-project`, projectId: 'other-project' })
    f.register({ key: `${f.key}-other-substrate`, instanceId: 'cc-compose-e2e' })
    let spawns = 0
    f.context.spawnProjectSession = async () => { spawns++; f.register() }
    const outcome = await drive(f)
    expect(outcome.kind, why(f, outcome)).toBe('merged')
    expect(spawns).toBe(state === 'exited' ? 1 : 0)
    expect(f.world.dispatches[0]?.role).toBe('plan')
  }, 120_000)
}

test('session acquisition: hung prewarm expires and late completion never dispatches', async () => {
  const f = await fixture()
  let release!: () => void
  let started = false
  f.context.spawnProjectSession = () => {
    started = true
    return new Promise<void>(resolve => { release = resolve })
  }
  const host = await createProjectBuildHost(await f.prepare())
  const controller = new AbortController()
  const nativeTimeout = globalThis.setTimeout
  // Accelerate only the acquisition clock; keep the real worker wall and host intact.
  const clock = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(callback, ms === PROJECT_SESSION_ACQUIRE_TIMEOUT_MS ? 20 : ms, ...args)
  ) as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout')
  const watchdog = nativeTimeout(() => controller.abort(), 2_000)
  try {
    expect(PROJECT_SESSION_ACQUIRE_TIMEOUT_MS).toBe(35_000)
    const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, controller.signal)
    expect(started).toBe(true)
    expect(outcome).toMatchObject({ kind: 'unknown', phase: 'plan',
      // The timeout names the budget it blew AND what it was trying to repair, so a
      // reader can tell a cold first spawn from a respawn after a death (#1085).
      detail: `Dispatch turn completion unknown: Project conversation session acquisition timed out after ${PROJECT_SESSION_ACQUIRE_TIMEOUT_MS}ms (none existed)` })
    const timerIndex = clock.mock.calls.findIndex(call => call[1] === PROJECT_SESSION_ACQUIRE_TIMEOUT_MS)
    expect(timerIndex).toBeGreaterThanOrEqual(0)
    const acquisitionTimer = clock.mock.results[timerIndex]!.value
    expect(clear.mock.calls.some(([handle]) => handle === acquisitionTimer)).toBe(true)
    f.register()
    release()
    await new Promise(resolve => nativeTimeout(resolve, 50))
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
  } finally {
    release?.()
    controller.abort()
    clearTimeout(watchdog)
    clock.mockRestore()
    clear.mockRestore()
  }
}, 30_000)

test('every dispatched brief states the envelope the decoder requires', async () => {
  const f = await fixture()
  const options = await f.prepare()
  for (const role of ['plan', 'build', 'review', 'fix'] as const) {
    const brief = await readFile(options.workers[role].request.brief.path, 'utf8')
    // THE REGRESSION TEST FOR #1033, stated as behaviour rather than as text: a
    // worker that writes exactly what the brief names must produce something the
    // decoder accepts. Reverting the brief to "Return a result object with head,
    // diff, pr and payload" empties this set and this assertion fails first.
    expect([...envelopeFieldsNamedBy(brief)].sort(), `${role} brief`).toEqual([...ENVELOPE_FIELDS].sort())
    const schemas = brief.split('\n\n').filter(part => part.startsWith('{"type":"object"')).map(part => JSON.parse(part))
    expect(schemas, `${role} outer snapshot contract`).toContainEqual(PROJECT_SNAPSHOT_SCHEMA)
    expect(brief).toContain('Copy `snapshot.pr` from the host context unchanged')
    expect(brief).toContain('result.payload.prNumber')
  }
}, 120_000)

test('numeric outer PR stops a valid build payload before review or publication', async () => {
  const f = await fixture()
  f.world.numericBuildPr = true
  const outcome = await drive(f)
  expect(outcome).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('result.pr must be null or an object') })
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['plan', 'build'])
  expect(f.github.prs).toEqual([])
}, 30_000)

test.each(['approve', 'standalone', 'synthesis', 'missing-seat'] as const)('all-producer barrier crosses the real session lock and preserves vetoes: %s', async verdict => {
  const started: string[] = []
  let release!: () => void, allStarted!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { allStarted = resolve })
  const f = await fixture({
    ...(verdict === 'standalone' || verdict === 'synthesis' ? { reviewVeto: verdict } : {}),
    unavailableSeatRounds: verdict === 'missing-seat' ? [1] : [],
    reviewChild: async (_request, seat) => { started.push(seat); if (started.length === 3) allStarted(); await hold },
  })
  f.input.phase_models = { ...f.input.phase_models, review_rubric: { model: 'fable' } }
  let settled = false
  const running = drive(f).then(result => { settled = true; return result })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The deadline prevents a broken serial implementation leaving children
    // behind; success depends on the barrier, never on elapsed-time estimates.
    await Promise.race([entered, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`Producers did not reach barrier: ${started.join(',')}`)), 10_000)
    })])
    expect([...started].sort()).toEqual(['review_adversarial', 'review_rubric', 'standalone'])
    expect(settled).toBe(false)
    expect(f.world.dispatches.filter(call => call.role === 'review' || call.role === 'synthesis')).toEqual([])
    expect(f.github.prs.every(pr => pr.state === 'OPEN')).toBe(true)
  } finally { clearTimeout(timer); release(); await running }
  const outcome = await running
  expect(outcome.kind, why(f, outcome)).toBe(verdict === 'approve' ? 'merged' : 'blocked')
  if (verdict === 'standalone' || verdict === 'synthesis') {
    expect(outcome).toMatchObject({ kind: 'blocked', on: 'Review has an unresolved verdict without nonblocking findings' })
  }
  expect(started).toHaveLength(3)
  expect(f.world.dispatches.filter(call => call.role === 'synthesis')).toHaveLength(verdict === 'missing-seat' ? 0 : 1)
  if (verdict !== 'approve') expect(f.github.prs.every(pr => pr.state === 'OPEN')).toBe(true)
}, 30_000)

test.each(['readiness', 'ci', 'artifact'] as const)('unavailable admission prevents every review producer in the consuming host: %s', async stop => {
  const started: string[] = []
  const f = await fixture({ reviewChild: async (_request, seat) => { started.push(seat) } })
  f.input.phase_models = { ...f.input.phase_models, review_rubric: { model: 'fable' } }
  const host = await createProjectBuildHost(await f.prepare())
  if (stop === 'readiness') host.deps.reviewReadiness = async () => ({ kind: 'unknown', detail: 'fixture readiness unavailable' })
  if (stop === 'ci') host.deps.reviewCi = async () => ({ kind: 'blocked', on: 'fixture CI unavailable' })
  if (stop === 'artifact') host.deps.reviewArtifact = async () => ({ kind: 'unknown', detail: 'fixture artifact unavailable' })
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind).toBe(stop === 'ci' ? 'blocked' : 'unknown')
  expect(started).toEqual([])
  expect(f.world.dispatches.map(call => call.role)).toEqual(['plan', 'build'])
}, 30_000)

/** Same task, providers, gates and scripted verdicts in both schedules. The
 * baseline reconstructs the serial paid-review constraint measured in #1196;
 * removing the setup receipt recreates pre-receipt preparation. No live timing,
 * pricing or historical recovery count is synthesized by this fixture. */
async function efficiencyBenchmark(scenario: EfficiencyScenario, scheduling: EfficiencyReport['scheduling']): Promise<EfficiencyReport> {
  const trace = new EfficiencyTrace()
  let serial = Promise.resolve()
  let pending: Array<() => void> = []
  let barrierExpired = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  cleanups.push(() => { for (const timer of timers) clearTimeout(timer); for (const release of pending) release() })
  const f = await fixture({ bunWorkspace: true, efficiencyTrace: trace,
    blockersByRound: scenario === 'code-fix' ? [0, 1] : [],
    reviewChild: async (_request, seat) => {
      if (scheduling === 'serial-baseline') {
        const next = serial.then(() => trace.during(`review:${seat}`, async () => {}, 10))
        serial = next
        return next
      }
      const finish = trace.begin(`review:${seat}`, 10)
      await new Promise<void>(resolve => {
        // Deadline is only a deadlock escape for a regressed serial producer.
        // Release its child so the real transport can drain; never abandon a
        // result writer and wait for the much longer provider budget.
        const timer = setTimeout(() => {
          barrierExpired = true
          const batch = pending; pending = []; for (const release of batch) release()
        }, 10_000)
        timers.add(timer)
        pending.push(() => { clearTimeout(timer); timers.delete(timer); resolve() })
        if (pending.length === 3) { const batch = pending; pending = []; for (const release of batch) release() }
      })
      finish()
    },
  })
  f.input.phase_models = { ...f.input.phase_models, review_rubric: { model: 'fable' } }
  const counts = { plan: 0, build: 0, fix: 0, review: 0, synthesis: 0, install: 0, verify: 0, proof: 0 }
  const suite = f.context.runSuite!
  f.context.runSuite = Object.assign(async (...args: Parameters<typeof suite>) =>
    trace.during('proof', () => suite(...args)), { writesDiffOutput: true as const })
  const install = f.context.runInstall!
  f.context.runInstall = Object.assign(async (...args: Parameters<typeof install>) => {
    const stage = args[0][2]!.includes('verify-workspace-deps.ts') ? 'verify' : 'install'
    counts[stage]++
    return trace.during(stage, () => install(...args))
  }, { writesDiffOutput: true as const })
  const prepare = async () => trace.during('prepare', async () => {
    if (scheduling === 'serial-baseline') await rm(join(f.context.stateRoot, encodeURIComponent(f.row.id), 'dependencies-receipt.json'), { force: true })
    f.input.run = f.store.get(f.row.id)!
    return f.prepare()
  })
  // A stable second preparation is the positive reuse control. Recovery after a
  // committed build legitimately changes the receipt's revision and installs.
  await prepare()
  const outcomes: string[] = []
  const run = async (start: 'fresh' | 'resume', die = false) => {
    const host = await createProjectBuildHost(await prepare())
    if (scenario === 'pending-interruption' && start === 'fresh') {
      const runner = host.workers.review.runner
      host.workers.review.runner = { ...runner, run: async (...args) => {
        await runner.run(...args)
        // The actual provider evidence exists, but this process loses its
        // acknowledgement before the driver clears the durable pending identity.
        throw Error('scripted acknowledgement lost after completed review')
      } }
    }
    for (const key of ['admissionGate', 'reviewReadiness', 'reviewArtifact', 'reviewCi', 'reviewSuite', 'reviewGate', 'publicationSuite', 'publishGate', 'mergeGate'] as const) {
      const original = host.deps[key]!
      // Observe the real gate result. This wrapper never supplies a verdict.
      Object.assign(host.deps, { [key]: async (...args: never[]) => {
        const value = await trace.during(`gate:${key}`, () => (original as (...args: never[]) => Promise<{ kind: string }>)(...args))
        trace.decisions.push(`${key}:${value.kind}`)
        return value
      } })
    }
    const outcome = die ? await buildRun({ mode: 'implementation', start, run_id: f.row.id, workers: host.workers,
      repl_provider: 'anthropic', merge_mode: 'pr' }, host.deps, new AbortController().signal)
      : await host.run({ mode: 'implementation', start }, new AbortController().signal)
    outcomes.push(outcome.kind)
    return outcome
  }
  if (scenario === 'unchanged-head' || scenario === 'moved-head') {
    const refusedAction = scenario === 'moved-head' ? 'merge' : 'create'
    f.github.refuse.add(refusedAction)
    const first = await run('fresh', true)
    expect(first).toMatchObject({ kind: 'unknown', phase: scenario === 'moved-head' ? 'merge' : 'publish' })
    if (scenario === 'moved-head') {
      expect(lastCheckpoint(f)).toMatchObject({ stage: 'approved' })
      const worktree = f.store.get(f.row.id)!.worktree!
      await writeFile(join(worktree, 'MOVED.md'), 'external revision\n')
      await gitOut(f.world.run, worktree, ['add', 'MOVED.md'])
      await gitOut(f.world.run, worktree, ['commit', '-m', 'advance assigned branch'])
    }
    f.github.refuse.delete(refusedAction)
    await run('resume')
  } else if (scenario === 'interruption') {
    f.github.refuse.add('merge')
    expect(await run('fresh', true)).toMatchObject({ kind: 'unknown', phase: 'merge' })
    expect(lastCheckpoint(f)).toMatchObject({ stage: 'approved' })
    const approvedHead = lastCheckpoint(f).head
    f.github.refuse.delete('merge')
    expect(await run('resume')).toMatchObject({ kind: 'merged', snapshot: { head: approvedHead } })
  } else if (scenario === 'pending-interruption') {
    expect(await run('fresh', true)).toMatchObject({ kind: 'blocked', phase: 'review', on: 'infra-only: Review producer failed during the review join: Error: scripted acknowledgement lost after completed review' })
    const pending = lastCheckpoint(f).pending
    const reviewStep = `${f.row.id}:review:1:head:${lastCheckpoint(f).head}`
    expect(pending).toMatchObject({ phase: 'review', step_id: reviewStep,
      recovery: { request: { run_id: f.row.id, step_id: reviewStep, role: 'review' }, snapshot: { head: lastCheckpoint(f).head } } })
    const completed = JSON.parse(await readFile(join(f.dir, 'state', f.row.id, 'review.result'), 'utf8'))
    expect(completed).toMatchObject({ kind: 'completed', step_id: reviewStep, result: { head: lastCheckpoint(f).head } })
    expect(await run('resume')).toMatchObject({ kind: 'merged', snapshot: { head: completed.result.head } })
    expect(lastCheckpoint(f).pending).toBeUndefined()
  } else await run('fresh')
  for (const call of f.world.dispatches) counts[call.role as 'plan' | 'build' | 'fix' | 'review' | 'synthesis']++
  counts.proof = f.commands.filter(argv => argv[0] === 'bash' && argv[1] === '-lc' && (argv[2] ?? '').includes('bash scripts/ci/suite.sh')).length
  // Both schedules run in this test. Retire the first fixture's identity so the
  // second project's acquisition cannot select the predecessor's granted roots.
  pool.delete(f.key)
  supervisedBySessionKey.delete(f.key)
  const models = f.context.attempts.list(f.row.id).map(attempt => ({ role: attempt.role, seat: attempt.review_seat,
    provider: attempt.provider, requested: attempt.requested_model, resolved: attempt.resolved_model, placement: attempt.placement }))
  return { scope: { fixture: 'project-build-e2e-scripted-v1', task: f.row.task,
    gates: { observed: [...new Set(trace.decisions.map(decision => decision.split(':')[0]!))].sort(),
      suite_strategy: f.input.test_strategy ?? '', intermediate_strategy: f.input.test_strategy_intermediate ?? null,
      max_rounds: f.input.max_rounds, merge_mode: 'pr' },
    models: [...new Set(models.map(model => JSON.stringify(model)))].sort().map(model => JSON.parse(model)) },
    timing_unit: 'scripted-workload-unit', barrier_complete: !barrierExpired, scenario, scheduling, counts, decisions: trace.decisions, intervals: trace.intervals, outcomes,
    usage: { tokens: null, cost: null, source: 'scripted-provider-no-usage' } }
}

test.each([...EFFICIENCY_SCENARIOS])('deterministic efficiency benchmark: %s', async scenario => {
  const before = await efficiencyBenchmark(scenario, 'serial-baseline')
  const after = await efficiencyBenchmark(scenario, 'concurrent')
  const comparison = compareEfficiency(before, after)
  if (process.env.TRIDENT_EFFICIENCY_REPORT === '1') console.log(JSON.stringify({ before, after, comparison }))
  expect(comparison).toEqual({ kind: 'matched' })
  assertEfficient(after)
  expect(() => assertEfficient(before)).toThrow('Independent reviews serialized')
  expect(after.decisions).toEqual(before.decisions)
  expect(after.outcomes).toEqual(before.outcomes)
  expect(after.counts).toEqual({ ...before.counts, install: before.counts.install - 1 })
  expect(after.counts.proof).toBe(scenario === 'code-fix' || scenario === 'moved-head' ? 2 : 1)
  expect(after.usage).toEqual({ tokens: null, cost: null, source: 'scripted-provider-no-usage' })
  // The machine-readable record is emitted on demand; no private run paths or
  // generated timestamps enter the fixed scenario comparison.
}, 120_000)

test('pr mode drives plan, build, review, publish and merge to a terminal merged outcome', async () => {
  const f = await fixture()
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  // The sequence actually dispatched, not merely the ending.
  const roles = f.world.dispatches.map(d => d.role)
  expect(roles.slice(0, 3)).toEqual(['plan', 'build', 'review'])
  // The review panel and its synthesis ran through the same real transport.
  expect(roles.filter(role => role === 'review').length).toBeGreaterThanOrEqual(2)
  expect(roles).toContain('synthesis')
  // Every dispatch wrote the full envelope, because every brief asked for it.
  for (const dispatch of f.world.dispatches) {
    expect(dispatch.wrote, `${dispatch.role} ${dispatch.step_id}`).toEqual([...ENVELOPE_FIELDS].sort())
  }

  // G063's receipt is the HOST'S OWN suite run (#1040), not the builder's claim:
  // once, in the run worktree, of the command the strategy named.
  //
  // Matched by CONTENT, not by exact argv. The host no longer passes the bare
  // command: it wraps it so the child's stdout and stderr are redirected to the
  // run's own log instead of being captured into gateway memory, which the gateway
  // never reads and which `run-tests.sh` makes unbounded. An equality assertion here
  // pinned the WRAPPER's shape as if it were the contract; what this case actually
  // owns is that the named command ran exactly once, in the worktree.
  const suiteRuns = f.commands.filter(argv =>
    argv[0] === 'bash' && argv[1] === '-lc' && (argv[2] ?? '').includes('bash scripts/ci/suite.sh'))
  expect(suiteRuns).toHaveLength(1)
  // And the transcript is redirected away from the gateway rather than captured.
  expect(suiteRuns[0]![2]).toMatch(/>>.*suite-round-\d+\.log.* 2>&1/)

  // Publication and merge really happened: real push, real PR, real base move.
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout.trim()).not.toBe(f.baseSha)
  expect(f.store.get(f.row.id)!.pr).toBe(1)
  expect(['cleaned', 'preserved']).toContain(outcome.cleanup.kind)
}, 300_000)

test('owned draft reaches ready only after approval, host suite and merge gates, then merges unattended', async () => {
  const f = await fixture()
  f.github.settings.draftCreated = true
  const host = await createProjectBuildHost(await f.prepare())
  const mergeGate = host.deps.mergeGate
  let gatePassed = false
  host.deps.mergeGate = async (...args) => {
    expect(f.github.prs[0]?.isDraft).toBe(true)
    expect(f.store.get(f.row.id)?.published_pr).toBe(f.github.prs[0]?.number)
    expect(f.world.dispatches.some(dispatch => dispatch.role === 'synthesis')).toBe(true)
    expect(f.commands.some(argv => argv[0] === 'bash' && (argv[2] ?? '').includes('bash scripts/ci/suite.sh'))).toBe(true)
    const result = await mergeGate(...args)
    gatePassed = result.kind === 'allow'
    return result
  }
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(gatePassed).toBe(true)
  expect(f.github.prs[0]).toMatchObject({ state: 'MERGED', isDraft: false })
  const writes = f.commands.filter(argv => argv[0] === 'gh' && ['ready', 'merge'].includes(argv[2]!))
  expect(writes).toEqual([['gh', 'pr', 'ready', '1'], ['gh', 'pr', 'merge', '1', '--squash', '--match-head-commit', expect.any(String)]])
}, 300_000)

for (const stop of ['suite', 'review', 'ci'] as const) test(`owned draft is never readied when ${stop} gate refuses`, async () => {
  const f = await fixture({ suiteExit: stop === 'suite' ? 1 : 0, maxRounds: 1,
    ...(stop === 'review' ? { blockersByRound: [0, 1] } : {}) })
  f.github.settings.draftCreated = true
  const host = await createProjectBuildHost(await f.prepare())
  if (stop === 'ci') {
    const mergeGate = host.deps.mergeGate
    host.deps.mergeGate = async (...args) => {
      f.github.checkRuns.check_runs[0]!.conclusion = 'FAILURE'
      return mergeGate(...args)
    }
  }
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).not.toBe('merged')
  expect(f.commands.some(argv => argv[0] === 'gh' && ['ready', 'merge'].includes(argv[2]!))).toBe(false)
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs.every(pr => pr.state === 'OPEN' && pr.isDraft)).toBe(true)
}, 300_000)

test('a synthesis worker guided by the exact verdict schema reaches MERGED unattended', async () => {
  const f = await fixture({ synthesisShape: 'schema-guided' })
  const outcome = await drive(f)
  expect(f.world.synthesisSchemaSeen).toEqual([true])
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

test('independent valid synthesis findings enter the fix loop instead of stopping at a trailer mismatch', async () => {
  // The review-role worker and the recorded synthesis are separate model turns.
  // Round 1 gives both a valid major finding, but synthesis independently names
  // its finding. This reproduces the live stop without relying on its private
  // run data. The recorded panel must request a fix without requiring the
  // unrelated review worker to produce a byte-for-byte echo.
  const f = await fixture({ blockersByRound: [0, 1, 0], synthesisShape: 'independent' })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'synthesis')).toBe(true)
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'fix')).toBe(true)
  expect(f.github.prs[0]?.state).toBe('MERGED')
}, 300_000)

test('an extra synthesis payload field still blocks review and leaves the PR open', async () => {
  const f = await fixture({ synthesisShape: 'malformed' })
  const outcome = await drive(f)
  expect(f.world.synthesisSchemaSeen).toHaveLength(1)
  expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', phase: 'review',
    recipient: 'orchestrator', on: expect.stringContaining('infra-only: Review panel host observation failed') })
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout.trim()).toBe(f.baseSha)
}, 300_000)

test('fresh retry rebuilds and republishes its prior open PR from a different real head', async () => {
  const f = await fixture()
  const seeded = await seedPriorPublication(f, 1)
  expect(await gitOut(spawnCapture, seeded.worktree, ['rev-parse', 'HEAD^{commit}'])).toBe(f.baseSha)
  expect(seeded.priorHead).not.toBe(f.baseSha)

  const host = await createProjectBuildHost(seeded.options)
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  const finalHead = await gitOut(spawnCapture, f.origin, ['rev-parse', `refs/heads/${seeded.branch}^{commit}`])
  expect(finalHead).not.toBe(seeded.priorHead)
  expect(await gitOut(spawnCapture, f.origin, ['rev-parse', 'refs/heads/main^{commit}'])).toBe(finalHead)
  expect(f.github.prs).toEqual([{ number: 1, state: 'MERGED', headRefName: seeded.branch, baseRefName: 'main' }])
  expect(f.store.get(f.row.id)).toMatchObject({ pr: 1, published_pr: 1 })
  const roles = f.world.dispatches.map(dispatch => dispatch.role)
  expect(roles.slice(0, 3)).toEqual(['plan', 'build', 'review'])
  expect(roles.filter(role => role === 'review').length).toBeGreaterThanOrEqual(2)
  expect(roles).toContain('synthesis')
  expect(f.commands.filter(argv => argv[0] === 'bash' && argv[1] === '-lc'
    && (argv[2] ?? '').includes('bash scripts/ci/suite.sh'))).toHaveLength(1)
}, 300_000)

test('fresh retry refuses an open PR whose durable publication provenance names another PR', async () => {
  const f = await fixture()
  const seeded = await seedPriorPublication(f, 2)
  const host = await createProjectBuildHost(seeded.options)
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)

  expect(outcome).toMatchObject({ kind: 'blocked', phase: 'plan', on: 'Fresh build already has a PR' })
  expect(f.world.dispatches).toEqual([])
  expect(f.github.prs).toEqual([{ number: 1, state: 'OPEN', headRefName: seeded.branch, baseRefName: 'main' }])
  expect(await gitOut(spawnCapture, f.origin, ['rev-parse', `refs/heads/${seeded.branch}^{commit}`])).toBe(seeded.priorHead)
  expect(f.store.get(f.row.id)).toMatchObject({ pr: null, published_pr: 2 })
}, 300_000)

test('configured Codex review uses the production read-only headless runner and its exact verdict merges', async () => {
  const f = await fixture({ codexReview: 'valid' })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  const evidence = await codexReviewEvidence(f)
  const invocations = (await readFile(`${f.codexCalls}.invocations`, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  expect(invocations).toContainEqual(['--version'])
  expect(invocations).toContainEqual(['login', 'status'])
  expect(evidence.calls).toHaveLength(1)
  const call = evidence.calls[0] as {
    argv: string[]
    cwd: string
    request: BoundedWorkRequest
    brief: { seat: string; snapshot: { head: string }; round: number }
  }
  const run = f.store.get(f.row.id)!
  expect(call.argv).toEqual([
    'exec', '--json', '--ignore-user-config', '--ignore-rules', '-m', 'gpt-5.6-sol',
    '-c', 'sandbox_mode="read-only"', '--output-schema', expect.any(String),
    '-o', expect.any(String), '-',
  ])
  expect(call.argv.join(' ')).not.toMatch(/danger-full-access|workspace-write|approve-for-me|auto_review|approval_policy|approvals_reviewer|model_reasoning_effort/)
  expect(run.worktree).not.toBeNull()
  expect(call.cwd).toBe(run.worktree!)
  expect(call.request).toMatchObject({ run_id: f.row.id, role: 'review', model_id: 'gpt-5.6-sol',
    writable: false, network: true, tools: 'read-only', needs_approval_decision: false,
    result: { schema: 'verdict' } })
  expect(call.brief).toMatchObject({ seat: 'review_codex', round: 1,
    snapshot: { head: evidence.brief.snapshot.head } })
  expect(evidence.envelope).toEqual({ schema: 'verdict', run_id: f.row.id,
    step_id: call.request.step_id, kind: 'completed', result: { verdict: 'APPROVE', findings: [] } })
  expect(Object.keys(evidence.envelope).sort()).toEqual([...ENVELOPE_FIELDS].sort())

  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout.trim()).toBe(evidence.brief.snapshot.head)
  expect(originMain.stdout.trim()).not.toBe(f.baseSha)
}, 300_000)

for (const [label, auth] of [
  ['bare key', 'sk-fixture'],
  ['API key', JSON.stringify({ OPENAI_API_KEY: 'metered' })],
  ['mixed OAuth and API key', JSON.stringify({ OPENAI_API_KEY: 'metered', tokens: { access_token: 'fixture', refresh_token: 'fixture' } })],
  ['malformed account', '{'],
] as const) {
  test(`Codex review ${label} fails admission before plan or build`, async () => {
    const f = await fixture({ codexReview: 'valid' })
    await writeFile(join(f.input.codex_home!, 'auth.json'), auth)
    await expect(drive(f)).rejects.toThrow('Review seat review_codex: provider-not-connected')
    expect(f.world.dispatches).toHaveLength(0)
    expect(f.github.prs).toHaveLength(0)
    await expect(readFile(f.codexCalls, 'utf8')).rejects.toThrow()
    await expect(readFile(`${f.codexCalls}.invocations`, 'utf8')).rejects.toThrow()
  }, 300_000)
}

test('missing Codex review runner constructs but blocks the consuming build before merge', async () => {
  const f = await fixture({ codexReview: 'valid' })
  const options = await f.prepare()
  const runnerFor = options.policy.review!.runnerFor
  options.policy.review!.runnerFor = (model, seat) => seat.id === 'review_codex' ? undefined : runnerFor(model, seat)
  const host = await createProjectBuildHost(options)
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)

  expect(outcome, why(f, outcome)).toMatchObject({
    kind: 'blocked', phase: 'review', recipient: 'orchestrator',
    on: 'Review seat review_codex (openai-codex) is unavailable',
  })
  expect(f.world.dispatches.map(dispatch => dispatch.role))
    .toEqual(['plan', 'build', 'review', 'review'])
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'synthesis')).toBe(false)
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'fix')).toBe(false)
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout.trim()).toBe(f.baseSha)
  await expect(readFile(f.codexCalls, 'utf8')).rejects.toThrow()
}, 300_000)

test('a Codex review envelope for another run is observed but cannot merge', async () => {
  const f = await fixture({ codexReview: 'wrong-run' })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).not.toBe('merged')

  // Positive control: this is a rejected RESULT, not an unavailable seat or a
  // fake that never ran. The production runner reached the local CLI exactly once.
  const calls = (await readFile(f.codexCalls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(calls).toHaveLength(1)
  expect(calls[0]!.request).toMatchObject({ run_id: f.row.id, role: 'review', result: { schema: 'verdict' } })
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout.trim()).toBe(f.baseSha)
}, 300_000)

test('a missing full-suite command stops with its own cause and runs no suite', async () => {
  const f = await fixture({ testStrategy: 'TEST EXECUTION: stage 1 only\n' })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('unknown')
  if (outcome.kind === 'unknown') {
    expect(outcome.phase).toBe('review')
    expect(outcome.detail).toContain('No full-suite command is derivable from the test strategy')
    expect(outcome.detail).not.toContain('Host-observed review suite exit code is missing or unreadable')
  }
  expect(f.commands.filter(argv => argv[0] === 'bash' && argv[1] === '-lc' && (argv[2] ?? '').includes('suite.sh'))).toEqual([])
}, 300_000)

test('task_sequence strategy with a single task reaches the same terminal merged outcome', async () => {
  const f = await fixture({ taskSequence: true })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(d => d.role).slice(0, 3)).toEqual(['plan', 'build', 'review'])
  // Selection happens in the initial plan; subsequent task work carries its iteration.
  expect(f.world.dispatches[0]!.step_id).toBe(`${f.row.id}:plan:0`)
  expect(f.world.dispatches[1]!.step_id).toBe(`${f.row.id}:task:0:build:0`)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

// ── THE FIRST TWO LIVE FAILURES, REPRODUCED THROUGH THE SAME DRIVER ──────────

test('an admission host exception reaches the outcome with its cause attached', async () => {
  // FAILURE 1 (#1009). The first acceptance dispatch stopped at admission, and
  // the refusal said only "Project admission host observation failed" — the
  // catch discarded `error`, so the dispatch bought a stop with no diagnosis.
  // `projectAdmission` (`gates/project-admission.ts:75`) now wraps with
  // `unknownCause`. Reverting that to a bare `catch { … }` drops the second half
  // of this assertion.
  const f = await fixture()
  const options = await f.prepare()
  const real = options.production.runHost
  options.production.runHost = Object.assign(async (argv: string[], ...rest: unknown[]) => {
    if (argv.includes('check-ref-format')) throw new Error('admission host is offline')
    return (real as Runner)(argv, ...(rest as [string?, Record<string, string>?, number?]))
  }, { writesDiffOutput: true as const }) as typeof real
  const host = await createProjectBuildHost(options)
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('unknown')
  if (outcome.kind === 'unknown') {
    expect(outcome.phase).toBe('plan')
    expect(outcome.detail).toContain('Project admission host observation failed')
    // The cause itself — the half #1009 restored.
    expect(outcome.detail).toContain('admission host is offline')
  }
  // Admission stops before any worker is dispatched.
  expect(f.world.dispatches).toEqual([])
}, 120_000)

test('a clobbered run row stops the build and names the field that moved', async () => {
  // FAILURE 2 (#1032), AS THE DRIVER EXPERIENCED IT. The second acceptance
  // dispatch died at plan round 0 because the orchestrator's post-fire row write
  // spread the PRE-launch snapshot back over the row, putting `worktree: null`
  // over the worktree `prepareProjectBuild` had just persisted, and the driver's
  // next `row()` refused.
  //
  // WHAT THIS DOES AND DOES NOT COVER. The WRITE that clobbered the row lives in
  // `trident/orchestrator.ts`, upstream of this harness's entry point, and is
  // fixed by an injected `read_run` — that half is covered by
  // `trident/orchestrator.test.ts`, not here. What IS covered here is the
  // driver's response to the clobbered row, on the real store, and that the
  // refusal names WHICH field moved (#1031) rather than all four.
  const f = await fixture()
  const options = await f.prepare()
  await f.store.update(f.row.id, { worktree: null })
  await expect(createProjectBuildHost(options)).rejects.toThrow('initialized run with matching identity')

  // …and, exactly as the live dispatch had it, when the clobber lands AFTER the
  // host is bound and the driver's very first `row()` meets it: plan, round 0,
  // before any gate runs and before any worker is dispatched.
  const fresh = await fixture()
  const host = await createProjectBuildHost(await fresh.prepare())
  await fresh.store.update(fresh.row.id, { worktree: null })
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(fresh, outcome)).toBe('unknown')
  if (outcome.kind === 'unknown') {
    expect(outcome.phase).toBe('plan')
    // ONE field named, not all four (#1031). `worktree` is the field that moved;
    // `branch`, `repo_path` and `project_slug` did not, and must not appear.
    expect(outcome.detail).toContain('Build run identity changed: worktree no longer matches')
    for (const intact of ['branch', 'repo_path', 'project_slug']) expect(outcome.detail).not.toContain(intact)
  }
  expect(fresh.world.dispatches).toEqual([])
}, 180_000)

test('task_sequence strategy with remaining tasks hands off after the build instead of merging', async () => {
  const f = await fixture({ taskSequence: true, moreTasks: true })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('continued')
  if (outcome.kind === 'continued') expect(outcome.remainingTasks).toBe(1)
  // The handoff is consumed before the iteration advances (`advanceTask`).
  const events = f.store.stageEvents(f.row.id).filter(e => e.stage === 'build-mode-state')
  expect(JSON.parse(events.at(-1)!.meta!).iteration).toBe(1)
  expect(f.world.dispatches.map(d => d.role)).toEqual(['plan', 'build'])
}, 300_000)

for (const mergeMode of ['pr', 'local'] as const)
for (const boundary of ['before-ledger', 'before-commit', 'commit-uncheckpointed', 'after-ledger', 'zero-conflict'] as const)
test(`same-run task-sequence crash ${boundary} in ${mergeMode} cannot publish unfinished tasks`, async () => {
  const f = await fixture({ mergeMode, taskSequence: true, moreTasks: true, seedLedger: false, hostLedger: true })
  const host = await createProjectBuildHost(await f.prepare())
  const save = host.deps.modes!.saveCheckpoint
  const commit = host.deps.modes!.commitPlan
  if (boundary === 'before-commit' || boundary === 'commit-uncheckpointed') {
    host.deps.modes!.commitPlan = async value => {
      if (boundary === 'commit-uncheckpointed') expect((await commit(value)).kind).toBe('known')
      throw new Error('simulated process death after durable intermediate build')
    }
  }
  let builtCheckpoints = 0
  host.deps.modes!.saveCheckpoint = async checkpoint => {
    await save(checkpoint)
    if (checkpoint.stage === 'built' && checkpoint.head && !checkpoint.pending && checkpoint.remainingTasks === 1) {
      builtCheckpoints++
      if (boundary !== 'before-commit' && boundary !== 'commit-uncheckpointed'
        && builtCheckpoints === (boundary === 'after-ledger' ? 2 : 1)) {
        throw new Error('simulated process death after durable intermediate build')
      }
    }
  }
  const first = await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 0,
    run_id: f.row.id, workers: host.workers, repl_provider: 'anthropic', merge_mode: mergeMode },
  host.deps, new AbortController().signal)
  expect(first).toMatchObject({ kind: 'unknown', phase: 'build', detail: 'simulated process death after durable intermediate build' })
  expect(lastCheckpoint(f)).toMatchObject({ stage: 'built', remainingTasks: 1 })
  expect(lastCheckpoint(f).pending).toBeUndefined()
  expect(f.store.get(f.row.id)!.task_iteration).toBe(1)
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['plan', 'build'])
  expect(f.github.prs).toEqual([])
  const interruptedHead = lastCheckpoint(f).head
  if (boundary === 'zero-conflict') {
    const event = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state').at(-1)!
    const state = JSON.parse(event.meta!)
    state.checkpoint.remainingTasks = 0
    await f.store.recordStageEvent(f.row.id, 'build-mode-state', JSON.stringify(state))
    expect(JSON.parse(f.store.get(f.row.id)!.strategy_plan!).remainingTasks).toBe(1)
  }

  f.world.dispatches.length = 0
  if (boundary === 'commit-uncheckpointed') {
    const interrupted = await createProjectBuildHost(await f.prepare())
    const persist = interrupted.deps.modes!.saveCheckpoint
    interrupted.deps.modes!.saveCheckpoint = async checkpoint => {
      await persist(checkpoint)
      throw new Error('simulated second process death after ledger recovery')
    }
    const again = await buildRun({ mode: 'implementation', start: 'resume', taskIteration: 1,
      run_id: f.row.id, workers: interrupted.workers, repl_provider: 'anthropic', merge_mode: mergeMode },
    interrupted.deps, new AbortController().signal)
    expect(again).toMatchObject({ kind: 'unknown', detail: 'simulated second process death after ledger recovery' })
    expect(f.store.get(f.row.id)!.task_iteration).toBe(1)
    expect(f.world.dispatches).toEqual([])
  }
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  if (boundary === 'zero-conflict') {
    expect(outcome, why(f, outcome)).toMatchObject({ kind: 'unknown',
      detail: expect.stringContaining('Task ledger intent is invalid') })
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
    return
  }
  expect(outcome.kind, why(f, outcome)).toBe('continued')
  expect(f.world.dispatches).toEqual([])
  expect(f.github.prs).toEqual([])
  expect(lastCheckpoint(f)).toMatchObject({ stage: 'task-built', remainingTasks: 1 })
  if (boundary === 'after-ledger') expect(lastCheckpoint(f).head).toBe(interruptedHead)
  else expect(lastCheckpoint(f).head).not.toBe(interruptedHead)
  const events = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state')
  expect(JSON.parse(events.at(-1)!.meta!).iteration).toBe(1)
  expect(f.store.get(f.row.id)!.task_iteration).toBe(1)
  const ledger = `.trident/ledgers/${f.store.get(f.row.id)!.branch}.md`
  const committed = await spawnCapture(['git', '-C', f.repo, 'show', `${lastCheckpoint(f).head}:${ledger}`], f.repo)
  expect(committed.stdout.trim()).toBe('- [x] T1 record the note\n- [ ] T2 record another note')
  const main = await spawnCapture(['git', '-C', mergeMode === 'pr' ? f.origin : f.repo, 'show', 'main:NOTES.md'], f.repo)
  expect(main.stdout.trim()).toBe('seed')

  // Recovery produced a real continuation: its next reader can build T2.
  const next = await createProjectBuildHost(await f.prepare())
  const terminal = await next.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(terminal.kind, why(f, terminal)).toBe('merged')
  expect(f.world.plannerChoices).toEqual(['full', 'next'])
  expect(f.world.selectedTasks).toEqual(['- [ ] T1 record the note', '- [ ] T2 record another note'])
  expect(f.world.dispatches[0]).toMatchObject({ role: 'plan', step_id: `${f.row.id}:task:1:plan:0` })
  if (mergeMode === 'local') expect(f.commands.some(argv => argv[0] === 'gh')).toBe(false)
}, 300_000)

for (const cap of [1, 2])
test(`clean task handoff checks cap ${cap} before dispatching the next planner`, async () => {
  const f = await fixture({ mergeMode: 'local', taskSequence: true, moreTasks: true, seedLedger: false, hostLedger: true })
  f.db.runSync('UPDATE code_trident_runs SET max_task_iterations = ? WHERE id = ?', [cap, f.row.id])
  const board = new WorkBoardStore(f.db)
  const card = await board.create(f.row.project_slug, { title: 'Clean handoff budget' })
  await board.attachRun(f.row.project_slug, card.id, f.row.id)
  const host = await createProjectBuildHost(await f.prepare())
  const commit = host.deps.modes!.commitPlan
  host.deps.modes!.commitPlan = async value => {
    expect((await commit(value)).kind).toBe('known')
    throw new Error('simulated process death after Git commit')
  }
  expect(await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 0,
    run_id: f.row.id, workers: host.workers, repl_provider: 'anthropic', merge_mode: 'local' },
  host.deps, new AbortController().signal)).toMatchObject({ kind: 'unknown', detail: 'simulated process death after Git commit' })
  expect(f.store.get(f.row.id)!.task_iteration).toBe(1)
  f.world.dispatches.length = 0
  const recovered = await createProjectBuildHost(await f.prepare())
  expect(await recovered.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal))
    .toMatchObject({ kind: 'continued', remainingTasks: 1 })
  expect(lastCheckpoint(f).stage).toBe('task-built')
  expect(f.world.dispatches).toEqual([])
  expect(board.get(f.row.project_slug, card.id)!.task_iteration).toBe(1)

  const next = await createProjectBuildHost(await f.prepare())
  const outcome = await next.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  if (cap === 1) {
    expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', on: 'task iteration budget is exhausted' })
    expect(f.world.dispatches).toEqual([])
    const again = await createProjectBuildHost(await f.prepare())
    expect(await again.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal))
      .toMatchObject({ kind: 'blocked', on: 'task iteration budget is exhausted' })
    expect(f.world.dispatches).toEqual([])
    expect(f.github.prs).toEqual([])
  } else {
    expect(outcome.kind, why(f, outcome)).toBe('merged')
    expect(f.world.dispatches.map(d => d.role).slice(0, 2)).toEqual(['plan', 'build'])
    expect(f.world.plannerChoices).toEqual(['full', 'next'])
    expect(f.world.selectedTasks).toEqual(['- [ ] T1 record the note', '- [ ] T2 record another note'])
  }
  // Only the intermediate handoff is charged by this host; terminal harvesting
  // belongs to the outer orchestrator and is outside this fixture.
  expect(f.store.get(f.row.id)!.task_iteration).toBe(1)
  expect(board.get(f.row.project_slug, card.id)!.task_iteration).toBe(1)
}, 300_000)

for (const cap of [1, 2])
test(`task ledger interrupted handoff preserves spend at a differing head with cap ${cap}`, async () => {
  const f = await fixture({ mergeMode: 'local', taskSequence: true, moreTasks: true, seedLedger: false, hostLedger: true })
  f.db.runSync('UPDATE code_trident_runs SET max_task_iterations = ? WHERE id = ?', [cap, f.row.id])
  const board = new WorkBoardStore(f.db)
  const card = await board.create(f.row.project_slug, { title: 'Ledger interruption budget' })
  await board.attachRun(f.row.project_slug, card.id, f.row.id)
  const host = await createProjectBuildHost(await f.prepare())
  const commit = host.deps.modes!.commitPlan
  host.deps.modes!.commitPlan = async value => {
    expect((await commit(value)).kind).toBe('known')
    throw new Error('simulated process death after Git commit')
  }
  expect(await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 0,
    run_id: f.row.id, workers: host.workers, repl_provider: 'anthropic', merge_mode: 'local' },
  host.deps, new AbortController().signal)).toMatchObject({ kind: 'unknown', detail: 'simulated process death after Git commit' })
  expect(f.store.get(f.row.id)!.task_iteration).toBe(1)
  expect(board.get(f.row.project_slug, card.id)!.task_iteration).toBe(1)
  const worktree = f.store.get(f.row.id)!.worktree!
  await writeFile(join(worktree, 'unrelated.md'), 'An unrelated change invalidates ledger adoption.\n')
  await gitOut(f.world.run, worktree, ['add', '--', 'unrelated.md'])
  await gitOut(f.world.run, worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Unrelated change'])
  f.world.dispatches.length = 0
  const restarted = await createProjectBuildHost(await f.prepare())
  const outcome = await restarted.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  if (cap === 1) {
    expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', on: 'task iteration budget is exhausted' })
    expect(f.world.dispatches).toEqual([])
    const again = await createProjectBuildHost(await f.prepare())
    expect(await again.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal))
      .toMatchObject({ kind: 'blocked', on: 'task iteration budget is exhausted' })
    expect(f.world.dispatches).toEqual([])
  } else {
    expect(outcome.kind, why(f, outcome)).toBe('continued')
    expect(f.world.dispatches.map(d => d.role)).toEqual(['plan', 'build'])
    expect(f.world.dispatches.every(d => d.step_id.includes(':task:1:'))).toBe(true)
    expect(f.world.plannerChoices).toEqual(['full', 'full'])
  }
  expect(f.store.get(f.row.id)!.task_iteration).toBe(cap)
  expect(board.get(f.row.project_slug, card.id)!.task_iteration).toBe(cap)
  expect(f.github.prs).toEqual([])
}, 300_000)

for (const mergeMode of ['pr', 'local'] as const)
test(`same-run terminal task-sequence crash in ${mergeMode} resumes review without rebuilding`, async () => {
  const f = await fixture({ mergeMode, taskSequence: true })
  const host = await createProjectBuildHost(await f.prepare())
  const save = host.deps.modes!.saveCheckpoint
  host.deps.modes!.saveCheckpoint = async checkpoint => {
    await save(checkpoint)
    if (checkpoint.stage === 'built' && checkpoint.head && !checkpoint.pending) {
      throw new Error('simulated process death after terminal build')
    }
  }
  const first = await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 0,
    run_id: f.row.id, workers: host.workers, repl_provider: 'anthropic', merge_mode: mergeMode },
  host.deps, new AbortController().signal)
  expect(first).toMatchObject({ kind: 'unknown', phase: 'build' })
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint).toMatchObject({ stage: 'built', remainingTasks: 0 })
  f.world.dispatches.length = 0
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review', 'review', 'synthesis'])
  expect(standaloneReview(f.world).measuredHead).toBe(checkpoint.head as string)
  const merged = await spawnCapture(['git', '-C', mergeMode === 'pr' ? f.origin : f.repo, 'show', 'main:NOTES.md'], f.repo)
  expect(merged.stdout.trim()).toBe(`seed\n${f.row.id}:task:0:build:0`)
}, 300_000)

for (const proposal of ['details', 'tick', 'drop', 'reorder'] as const)
test(`full task refresh preserves unfinished tasks through the production host: ${proposal}`, async () => {
  const f = await fixture({ taskSequence: true, moreTasks: true, seedLedger: false, hostLedger: true })
  await f.store.update(f.row.id, { task_iteration: 4 })
  f.world.plannerPatch = { implementationPlan: '- [ ] T1 record the note\n- [ ] T2 record another note\n- [ ] T3 record the final note',
    topTask: '- [ ] T1 record the note', remainingTasks: 2 }
  const firstHost = await createProjectBuildHost(await f.prepare())
  const first = await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 4,
    run_id: f.row.id, workers: firstHost.workers, repl_provider: 'anthropic', merge_mode: 'pr' },
  firstHost.deps, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('continued')
  const accepted = f.store.get(f.row.id)!.strategy_plan
  f.world.dispatches.length = 0
  f.world.plannerPatch = {
    implementationPlan: proposal === 'details' ? '- [x] T1 record the note\n- [ ] T2 record another note\n- [ ] T3 record the final note'
      : proposal === 'tick' ? '- [x] T1 record the note\n- [x] T2 record another note\n- [ ] T3 record the final note'
      : proposal === 'drop' ? '- [x] T1 record the note\n- [ ] T3 record the final note'
      : '- [x] T1 record the note\n- [ ] T3 record the final note\n- [ ] T2 record another note',
    topTask: proposal === 'details' ? '- [ ] T2 record another note' : '- [ ] T3 record the final note',
    remainingTasks: proposal === 'details' || proposal === 'reorder' ? 1 : 0,
    executionSpec: 'Append another verified note and commit it.',
  }
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(f.world.plannerChoices).toEqual(['full', 'full'])
  if (proposal === 'details') {
    expect(outcome.kind, why(f, outcome)).toBe('continued')
    expect(f.world.selectedTasks).toEqual(['- [ ] T1 record the note', '- [ ] T2 record another note'])
    expect(f.world.dispatches.map(d => d.role)).toEqual(['plan', 'build'])
  } else {
    expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', phase: 'plan',
      on: 'Planner cannot change the host-owned pending task sequence' })
    expect(f.world.selectedTasks).toEqual(['- [ ] T1 record the note'])
    expect(f.world.dispatches.map(d => d.role)).toEqual(['plan'])
    expect(f.store.get(f.row.id)!.strategy_plan).toBe(accepted)
  }
}, 300_000)

test('task_sequence continuation probes the committed plan and selects its next unchecked task', async () => {
  const f = await fixture({ taskSequence: true, moreTasks: true })

  // Keep the first process's worktree and mode checkpoint, as a real process exit
  // would, then construct a fresh composed host over those durable artifacts.
  const firstHost = await createProjectBuildHost(await f.prepare())
  const first = await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 0,
    run_id: f.row.id, workers: firstHost.workers, repl_provider: 'anthropic', merge_mode: 'pr' },
  firstHost.deps, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('continued')
  expect(f.world.selectedTasks).toEqual(['- [ ] T1 record the note'])

  f.world.dispatches.length = 0
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', phase: 'publish' })
  expect(f.world.dispatches[0]).toMatchObject({ role: 'plan', step_id: `${f.row.id}:task:1:plan:0` })
  expect(f.world.plannerChoices).toEqual(['full', 'next'])
  expect(f.world.selectedTasks).toEqual([
    '- [ ] T1 record the note',
    '- [ ] T2 record another note',
  ])
}, 300_000)

// ── A RETRY OF A RALPH HANDOFF (spec item a-retry-must-resume-from-the-checkpoint) ──
//
// The case above keeps ONE row alive and leaves the ledger to the worker and the
// seed commit, so it says nothing about the two things a RETRY depends on: the
// ledger the HOST commits at the handoff, and the dispatch → `prepareLaunch` path
// that carries the dead run's checkpoint onto a NEW row. Here the seed commit has
// no ledger and the worker never writes one (`seedLedger: false`, `hostLedger:
// true`), so the only ledger anywhere is `commitLedger`'s, at the branch's own
// `.trident/ledgers/<branch>.md` — and the retry is driven through the real dispatch
// and the real gateway launch.

const CONTINUATION_TASK = 'Record a note in NOTES.md and verify the resulting change with the complete regression suite. MORE TASKS'
const HANDOFF_LEDGER = '- [x] T1 record the note\n- [ ] T2 record another note\n'
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
/** The git blob id of `text` — an exact-bytes comparison (`spawnCapture` trims stdout). */
const blobId = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')

/** Iteration 1 of a task-sequence card on the fixture's own row, handed back, then killed. */
async function handOffThenDie(f: Awaited<ReturnType<typeof fixture>>, mergeMode: 'pr' | 'local') {
  const host = await createProjectBuildHost(await f.prepare())
  const first = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('continued')
  if (first.kind === 'continued') expect(first.remainingTasks).toBe(1)
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint.stage).toBe('task-built')
  const states = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state')
  expect(JSON.parse(states.at(-1)!.meta!).iteration).toBe(1)
  const h2 = String(checkpoint.head)
  expect(h2).toMatch(/^[0-9a-f]{40}$/)
  const prior = f.store.get(f.row.id)!
  const branch = prior.branch!
  const ledger = taskLedgerPath(branch)!
  expect(ledger).toBe(`.trident/ledgers/${branch}.md`)
  // THE HOST'S LEDGER COMMIT IS THE HANDOFF HEAD, and it is the only ledger there is:
  // the worker's build commit beneath it carries none, and neither does the base.
  expect(await gitOut(spawnCapture, f.repo, ['rev-parse', '--verify', `${h2}:${ledger}`])).toBe(blobId(HANDOFF_LEDGER))
  expect(await gitOut(spawnCapture, f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', h2])).toBe(ledger)
  expect(await gitOut(spawnCapture, f.repo, ['log', '-1', '--format=%s', h2])).toBe('chore(trident): task ledger — 1 remaining')
  expect((await spawnCapture(['git', '-C', f.repo, 'cat-file', '-e', `${h2}^:${ledger}`], f.repo)).ok).toBe(false)
  expect((await spawnCapture(['git', '-C', f.repo, 'cat-file', '-e', `${f.baseSha}:${ledger}`], f.repo)).ok).toBe(false)
  // Nothing lands at the repo root: no shared file for two cards' PRs to meet on.
  expect((await spawnCapture(['git', '-C', f.repo, 'cat-file', '-e', `${h2}:IMPLEMENTATION_PLAN.md`], f.repo)).ok).toBe(false)
  // The handoff's cleanup PRESERVED the local ref (it holds unpushed work).
  expect(await gitOut(spawnCapture, f.repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).toBe(h2)
  if (mergeMode === 'pr') {
    // …and origin has never seen it: a remote read of this branch answers nothing.
    expect((await spawnCapture(['git', '-C', f.origin, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`], f.origin)).ok).toBe(false)
    expect(f.github.prs).toEqual([])
  }
  await f.store.update(prior.id, { phase: 'failed', worktree: null })
  return { prior: f.store.get(prior.id)!, h2, branch }
}

function redispatchContinuation(f: Awaited<ReturnType<typeof fixture>>, priorId: string, mergeMode: 'pr' | 'local') {
  return dispatchBoardBoundBuild({ task: CONTINUATION_TASK, board_item_id: 'card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    board: { get: () => ({ id: 'card', title: CONTINUATION_TASK, design_doc_ref: null, linked_run_id: priorId }),
      attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => mergeMode,
    hostRunner: f.context.runHost,
  })
}

for (const mergeMode of ['local', 'pr'] as const)
test(`a ${mergeMode} retry of a run that died after a task-sequence handoff resumes from the host's committed ledger`, async () => {
  const f = await fixture({ taskSequence: true, moreTasks: true, mergeMode, dispatchTask: CONTINUATION_TASK,
    seedLedger: false, hostLedger: true })
  // NO MUTATION NOMINATION, deliberately. Every change this card makes is prose
  // (NOTES.md), and the final diff also carries the host's ledger. The ledger sits at
  // the branch's own `.trident/ledgers/<branch>.md`, which the gate reads as inert
  // prose, so the card keeps the prose-only exemption and merges with nothing to
  // nominate. At the repo-root IMPLEMENTATION_PLAN.md (executable prose) it could not
  // merge at all: it owed a proof and had no legal target.
  const { prior, h2, branch } = await handOffThenDie(f, mergeMode)
  expect(f.world.plannerChoices).toEqual(['full'])

  // ── THE DISPATCH: the dead run's checkpoint and round travel onto a NEW row.
  const dispatchStart = f.commands.length
  const dispatched = await redispatchContinuation(f, prior.id, mergeMode)
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  const run = dispatched.run
  expect(run.id).not.toBe(prior.id)
  expect(run.inner_checkpoint).toBe('task-built')
  expect(run.inner_checkpoint_head).toBe(h2)
  expect(run.base_sha).toBe(f.baseSha)
  expect(run.task_iteration).toBe(1)
  expect(run.max_task_iterations).toBe(prior.max_task_iterations)
  expect(run.execution_strategy).toBe('task_sequence')
  expect(run.strategy_rationale).toBe(prior.strategy_rationale)
  expect(run.strategy_plan).toBe(prior.strategy_plan)
  const links = f.store.stageEvents(run.id).filter(event => event.stage === 'build-retry-source')
  expect(links).toHaveLength(1)
  expect(JSON.parse(links[0]!.meta!)).toMatchObject({ priorRunId: prior.id, head: h2, runId: run.id })
  // The TIP PROOF is a local `git rev-parse`, never a remote read, in either mode.
  // In `pr` mode the dispatch's merged-PR probe (`makeDispatchLandedProbe`) is its
  // only `gh` call — a landing check, not the tip proof.
  const dispatchArgvs = f.commands.slice(dispatchStart)
  expect(dispatchArgvs.filter(argv => argv.includes('ls-remote'))).toEqual([])
  expect(dispatchArgvs.filter(argv => argv[0] === 'gh').map(argv => argv.slice(0, 3).concat(argv.slice(5, 7))))
    .toEqual(mergeMode === 'pr' ? [['gh', 'pr', 'list', '--state', 'merged']] : [])
  expect(dispatchArgvs).toContainEqual(['git', '-C', f.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])

  // ── THE LAUNCH, through the real gateway.
  f.world.dispatches.length = 0
  f.world.plannerChoices.length = 0
  f.world.committedPlans.length = 0
  f.world.selectedTasks.length = 0
  const launchStart = f.commands.length
  let seen: { checkpoint: unknown; head: unknown; prs: number; commands: number } | undefined
  const launched = await launchThroughGateway(f, run.id, input => {
    seen = { checkpoint: input.resume_checkpoint, head: input.resume_checkpoint_head,
      prs: f.github.prs.length, commands: f.commands.length }
  })
  expect(launched.errors).toEqual([])
  expect({ checkpoint: seen?.checkpoint, head: seen?.head }).toEqual({ checkpoint: 'task-built', head: h2 })
  // `prepareLaunch` did not falsify the seed.
  expect(launched.stepped.inner_checkpoint).toBe('task-built')
  expect(launched.stepped.base_sha).toBe(f.baseSha)
  const outcome = launched.outcome!
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  // ACCEPTANCE 2: the continuation opened on the COMMITTED plan, not a full re-plan.
  expect(f.world.plannerChoices).toEqual(['next'])
  expect(f.world.dispatches[0]).toMatchObject({ role: 'plan', step_id: `${run.id}:task:1:plan:0` })
  expect(f.world.committedPlans).toEqual([HANDOFF_LEDGER])
  expect(f.world.selectedTasks).toEqual(['- [ ] T2 record another note'])
  expect(f.world.dispatches.some(dispatch => dispatch.step_id.startsWith(`${prior.id}:`))).toBe(false)
  // The plan turn's host context as the worker read it off disk (`project-build-host.ts`
  // writes `<role>.strategy-v3.brief.<role>.host`, and its context beside it).
  const planContext = JSON.parse(await readFile(workContextPath(join(f.context.stateRoot, run.id, 'plan.strategy-v3.brief.plan.host')), 'utf8'))
  expect(planContext.request.step_id).toBe(`${run.id}:task:1:plan:0`)
  expect(planContext.planner).toBe('next')
  expect(planContext.committedPlan).toMatchObject({ found: true, body: HANDOFF_LEDGER, sha256: sha256(HANDOFF_LEDGER), uncheckedCount: 1 })
  // The merged revision is the BUILDER's head, and it carries the handoff's ledger:
  // the final iteration commits none, because review and publication bind every
  // worker receipt to the head the builder reported (`trident/build-run.ts`).
  const merged = await gitOut(spawnCapture, mergeMode === 'pr' ? f.origin : f.repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}'])
  const subjects = (await gitOut(spawnCapture, mergeMode === 'pr' ? f.origin : f.repo, ['log', '--format=%s', `${f.baseSha}..${merged}`])).split('\n')
  expect(subjects).toContain(`work: build ${run.id}:task:1:build:0`)
  expect(subjects.filter(subject => subject.startsWith('chore(trident): task ledger'))).toEqual(['chore(trident): task ledger — 1 remaining'])
  expect(await gitOut(spawnCapture, f.repo, ['rev-parse', '--verify', `${merged}:${taskLedgerPath(branch)!}`])).toBe(blobId(HANDOFF_LEDGER))
  expect((await spawnCapture(['git', '-C', f.repo, 'cat-file', '-e', `${merged}:IMPLEMENTATION_PLAN.md`], f.repo)).ok).toBe(false)
  // The prose-only exemption carried the merge: no nomination was ever made.
  expect(f.world.mutationArgv).toBeUndefined()

  // ACCEPTANCE 3: the resume never leaned on the fire-time PR probe.
  if (mergeMode === 'local') {
    expect(f.commands.filter(argv => argv[0] === 'gh')).toEqual([])
    expect(f.github.prs).toEqual([])
    expect(await gitOut(spawnCapture, f.origin, ['for-each-ref', '--format=%(refname) %(objectname)']))
      .toBe(`refs/heads/main ${f.baseSha}`)
  } else {
    // The probe DID run before the fire, and answered nothing — there was no PR.
    expect(f.commands.slice(launchStart, seen!.commands))
      .toContainEqual(['gh', 'pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number // empty'])
    expect(seen!.prs).toBe(0)
    expect(f.github.prs).toHaveLength(1)
    expect(f.github.prs[0]).toMatchObject({ headRefName: branch, state: 'MERGED' })
  }
}, 300_000)

test('a task-sequence retry whose branch moved after the handoff carries no checkpoint, says why, and never adopts the moved branch', async () => {
  const f = await fixture({ taskSequence: true, moreTasks: true, mergeMode: 'local', dispatchTask: CONTINUATION_TASK,
    seedLedger: false, hostLedger: true })
  const { prior, h2, branch } = await handOffThenDie(f, 'local')
  const advanced = await gitOut(spawnCapture, f.repo, ['commit-tree', `${h2}^{tree}`, '-p', h2,
    '-m', 'test: branch advances after the handoff'])
  await gitOut(spawnCapture, f.repo, ['update-ref', `refs/heads/${branch}`, advanced])

  const lines: string[] = []
  const logging = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  let dispatched: Awaited<ReturnType<typeof redispatchContinuation>>
  try { dispatched = await redispatchContinuation(f, prior.id, 'local') } finally { logging.mockRestore() }
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  const run = dispatched.run
  expect(run.inner_checkpoint).toBeNull()
  expect(run.inner_checkpoint_head).toBeNull()
  expect(f.store.stageEvents(run.id).some(event => event.stage === 'build-retry-source')).toBe(false)
  const seedLine = lines.find(line => line.includes('event=dispatch_resume_seed'))
  expect(seedLine).toContain('reason=branch_tip_moved')
  // The budget is the card's, and it still travels when the checkpoint does not.
  expect(run.task_iteration).toBe(prior.task_iteration)
  expect(run.max_task_iterations).toBe(prior.max_task_iterations)

  // THE LAUNCH NEITHER CONTINUES NOR BUILDS ON THE MOVED BRANCH. With no checkpoint
  // the row is a fresh launch, and the branch now carries commits this run did not
  // make and origin never saw, so the wrong-base guard refuses before any worker —
  // which means no planner of either kind, and certainly no `next` off a ledger the
  // branch no longer ends at.
  f.world.dispatches.length = 0
  f.world.plannerChoices.length = 0
  let seen: { checkpoint: unknown } | undefined
  const launched = await launchThroughGateway(f, run.id, input => { seen = { checkpoint: input.resume_checkpoint } })
  expect(launched.errors).toEqual([])
  expect(launched.outcome).toBeNull()
  expect(launched.stepped.phase).toBe('failed')
  expect(launched.stepped.failure_reason).toContain('not on origin/main')
  expect(launched.stepped.failure_reason).toContain('refusing to build on another lane')
  expect(seen).toBeUndefined()
  expect(f.world.plannerChoices).toEqual([])
  expect(f.world.dispatches).toEqual([])
  // The moved commit is untouched.
  expect(await gitOut(spawnCapture, f.repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).toBe(advanced)
}, 300_000)

// ── FIX ROUNDS ───────────────────────────────────────────────────────────────

test('a REQUEST_CHANGES panel dispatches a fix worker and the re-review merges', async () => {
  // THE ROUND THE DRIVER SPENDS MOST OF ITS LIFE IN, and the first case here that
  // reaches `work('fix')`, `checkFixLineage`, `reviewProgress` and a second pass
  // through publication.
  const f = await fixture({ blockersByRound: [0, 1] })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  // The exact sequence, not merely the ending. `work('review')` dispatches the
  // review ROLE first; `reviewGate` then reads the adversarial seat and the
  // synthesis through the same transport (`gates/review-panel.ts:85,99`).
  expect(f.world.dispatches.map(d => d.role)).toEqual([
    'plan', 'build', 'review', 'review', 'synthesis',
    'fix', 'review', 'review', 'synthesis',
  ])
  // The fix carries the host's round-1 identity (`build-run.ts:308`).
  const fix = f.world.dispatches.find(dispatch => dispatch.role === 'fix')!
  expect(fix.step_id).toBe(`${f.row.id}:fix:1`)
  expect(fix.schema).toBe('project-build')
  // Every dispatch still wrote the whole envelope, fix and second panel included.
  for (const dispatch of f.world.dispatches) {
    expect(dispatch.wrote, `${dispatch.role} ${dispatch.step_id}`).toEqual([...ENVELOPE_FIELDS].sort())
  }

  // THE FIX COMMIT IS WHAT LANDED. Three notes reached the base branch: the seed,
  // the round-0 build and the round-1 fix — so the merged revision is the FIXED
  // one, not the reviewed-then-rejected one.
  // (`spawnCapture` trims its stdout — `trident/git-mode.ts:1223` — so the file's
  // real trailing newline is not part of this comparison.)
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:fix:1`)

  // The driver recorded the rejection BEFORE dispatching the fix, and the fix
  // before the approval (`build-run.ts:553`, `:399`, `:560`).
  const stages = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state')
    .map(event => JSON.parse(event.meta!).checkpoint.stage)
  expect(stages.filter((stage, index) => stage !== stages[index - 1]))
    .toEqual(['built', 'rejected', 'fixed', 'approved'])

  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

test('a COMMENT panel stops as an unresolved verdict and never merges', async () => {
  const f = await fixture({ commentRounds: [1] })
  const outcome = await drive(f)
  expect(outcome, why(f, outcome)).toMatchObject({
    kind: 'blocked', phase: 'review', recipient: 'orchestrator',
    on: 'Review has an unresolved verdict without nonblocking findings',
  })
  expect(f.world.dispatches.map(dispatch => dispatch.role))
    .toEqual(['plan', 'build', 'review', 'review', 'synthesis'])
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toEqual([])
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
}, 300_000)

test('an unavailable panel seat stops by configured seat and never synthesizes or merges', async () => {
  const f = await fixture({ unavailableSeatRounds: [1] })
  const outcome = await drive(f)
  expect(outcome, why(f, outcome)).toMatchObject({
    kind: 'blocked', phase: 'review', recipient: 'orchestrator',
    on: 'Review seat review_adversarial (anthropic) is unavailable',
  })
  expect(f.world.dispatches.map(dispatch => dispatch.role))
    .toEqual(['plan', 'build', 'review', 'review'])
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'synthesis')).toBe(false)
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'fix')).toBe(false)
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
}, 300_000)

test('a provider rate-limited synthesis stops with its cause without a trailer, replay, fix or merge', async () => {
  const f = await fixture({ rateLimitedSynthesis: true })
  const outcome = await drive(f)
  expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', phase: 'review', recipient: 'orchestrator',
    on: 'infra-only: Review synthesis unavailable: Review seat synthesis: Claude child stopped at the provider rate limit (HTTP 429).' })
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['plan', 'build', 'review', 'review', 'synthesis'])
  expect(f.world.dispatches.at(-1)?.wrote).toEqual([])
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
}, 30_000)

test('a design-gap escalation re-plans and rebuilds instead of dispatching a fix', async () => {
  // THE RE-PLAN BRANCH (`build-run.ts:564-574`). The panel reaches it only through a
  // valid self-declared claim: `escalate.kind === 'design-gap'`, a nonempty
  // `whatIsMissing`, a verdict that is not APPROVE, and no re-plan already spent
  // (`gates/escalation.ts:85-96,140`). It then runs plan AND build again rather
  // than a fix, which is the whole difference between the two branches.
  const f = await fixture({ blockersByRound: [0, 1], replanRounds: [1] })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual([
    'plan', 'build', 'review', 'review', 'synthesis',
    'plan', 'build', 'review', 'review', 'synthesis',
  ])
  // NO fix worker ran, and the replacement pair carries round 1's identity.
  expect(f.world.dispatches.map(dispatchStep).filter(id => id.startsWith(f.row.id)))
    .toEqual([`${f.row.id}:plan:0`, `${f.row.id}:build:0`, `${f.row.id}:review:1`,
      `${f.row.id}:plan:1`, `${f.row.id}:build:1`, `${f.row.id}:review:2`])

  // What landed is the REBUILD on top of the reviewed commit, not a fix.
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:build:1`)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

test('a second unconverged round stops at the row-configured ceiling, not at a verdict', async () => {
  // G071 AND THE CEILING, TOGETHER. Round 1 raises two blockers and round 2 raises
  // one: `reviewProgress` allows the second round because the count strictly fell
  // (`gates/review-progress.ts:20`) and the identities differ, so the run reaches
  // `round >= maxRounds` with work still outstanding (`build-run.ts:576`) instead of
  // being stopped earlier by progress arithmetic. The cap is this ROW's
  // (`build-host.ts:140-144`), pinned here at 2.
  const f = await fixture({ blockersByRound: [0, 2, 1], maxRounds: 2 })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('blocked')
  if (outcome.kind === 'blocked') {
    expect(outcome.on).toBe('Review requires orchestrator arbitration: round ceiling')
    expect(outcome.phase).toBe('review')
    expect(outcome.recipient).toBe('orchestrator')
  }
  // Exactly one fix ran — the round-1 one. Round 2 was rejected and then stopped.
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix').map(d => d.step_id))
    .toEqual([`${f.row.id}:fix:1`])
  // The rejection is recorded BEFORE the ceiling stop, so the orchestrator resumes
  // from a row that knows round 2 was rejected (`build-run.ts:548-555`).
  const last = f.store.stageEvents(f.row.id).filter(event => event.stage === 'build-mode-state').at(-1)!
  expect(JSON.parse(last.meta!).checkpoint.stage).toBe('rejected')
  expect(JSON.parse(last.meta!).checkpoint.round).toBe(2)
  // Nothing merged: the PR was published for review but the base never moved.
  expect(f.github.prs[0]!.state).toBe('OPEN')
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
}, 300_000)

test('a finding repeated after a fix stops before another fix is dispatched', async () => {
  const f = await fixture({ blockersByRound: [0, 2, 1], repeatFirstFinding: true })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('blocked')
  if (outcome.kind === 'blocked') {
    expect(outcome.on).toBe('Review requires orchestrator arbitration: repeated finding')
    expect(outcome.phase).toBe('review')
    expect(outcome.recipient).toBe('orchestrator')
  }
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix').map(d => d.step_id))
    .toEqual([`${f.row.id}:fix:1`])
  expect(lastCheckpoint(f)).toMatchObject({ stage: 'rejected', round: 2 })
  expect(f.github.prs[0]!.state).toBe('OPEN')
}, 300_000)

// ── RESUME ACROSS A DRIVER RESTART ───────────────────────────────────────────

for (const strategy of ['single', 'task_sequence', 'wave'] as const)
test(`historical pending ${strategy} planner recovers its original schema and reservation`, async () => {
  const f = await fixture({ taskSequence: strategy !== 'single', moreTasks: true, seedLedger: false, hostLedger: true })
  const mode = strategy === 'wave' ? { mode: 'wave' as const, pinnedTaskId: 'T1' } : { mode: 'implementation' as const }
  f.db.raw().query("UPDATE code_trident_runs SET execution_strategy = ?, strategy_source = 'legacy', strategy_rationale = ? WHERE id = ?")
    .run(strategy === 'wave' ? 'single' : strategy, 'Execution strategy preserved from the legacy run selection.', f.row.id)
  f.input.run = f.store.get(f.row.id)!
  const prepared = await f.prepare()
  for (const [role, worker] of Object.entries(prepared.workers)) {
    const path = join(f.context.stateRoot, f.row.id, `${role}.brief`)
    await writeFile(path, await readFile(worker.request.brief.path, 'utf8'))
    worker.request = { ...worker.request, brief: { ...worker.request.brief, path },
      result: { ...worker.request.result, ...(role === 'plan' ? { schema: 'project-plan' } : {}) } }
  }
  const host = await createProjectBuildHost(prepared)
  const runner = host.workers.plan.runner
  host.workers.plan.runner = { ...runner, async run(...args) {
    const outcome = await runner.run(...args)
    expect(outcome.kind).toBe('completed')
    return { kind: 'unknown', detail: 'fixture: completed historical planner acknowledgement lost' }
  } }
  expect(await buildRun({ ...mode, start: 'fresh', run_id: f.row.id, workers: host.workers,
    repl_provider: 'anthropic', merge_mode: 'pr' }, host.deps, new AbortController().signal))
    .toMatchObject({ kind: 'unknown', phase: 'plan' })
  const event = f.store.stageEvents(f.row.id).filter(row => row.stage === 'build-mode-state').at(-1)!
  const state = JSON.parse(event.meta!)
  const recovery = state.checkpoint.pending.recovery
  recovery.inputs.mode = strategy === 'single' ? 'pr' : strategy === 'wave' ? 'wave' : 'ralph'
  if (strategy === 'task_sequence') recovery.inputs.ralphRound = recovery.inputs.taskIteration ?? 0
  delete recovery.inputs.taskIteration
  delete recovery.executionStrategy
  await f.store.recordStageEvent(f.row.id, 'build-mode-state', JSON.stringify(state))
  const original = await readFile(join(f.context.stateRoot, f.row.id, 'plan.result'), 'utf8')
  expect(JSON.parse(original)).toMatchObject({ schema: 'project-plan', step_id: state.checkpoint.pending.step_id })
  expect(JSON.parse(original).result.payload.strategy).toBeUndefined()
  f.world.dispatches.length = 0
  f.input.run = f.store.get(f.row.id)!
  const outcome = strategy === 'wave'
    ? await (await createProjectBuildHost(await f.prepare())).run({ ...mode, start: 'resume' }, new AbortController().signal)
    : await restartThroughGateway(f)
  expect(outcome.kind, why(f, outcome)).toBe(strategy === 'single' ? 'merged' : strategy === 'wave' ? 'built' : 'continued')
  expect(f.world.dispatches.filter(d => d.role === 'plan')).toEqual([])
  expect(f.world.dispatches.filter(d => d.role === 'build')).toHaveLength(1)
  expect(f.world.builderObservations[0]).toMatchObject({ strategy: strategy === 'wave' ? 'single' : strategy,
    scope: strategy === 'task_sequence' ? 'subset' : strategy === 'wave' ? 'full-suite' : 'host-suite' })
  if (strategy === 'wave') {
    expect(f.world.selectedTasks).toEqual(['- [ ] T1 record the note'])
    expect(f.world.dispatches.some(d => d.role === 'review')).toBe(false)
    expect(f.github.prs).toEqual([])
  }
  expect(await readFile(join(f.context.stateRoot, f.row.id, 'plan.result'), 'utf8')).toBe(original)
}, 30_000)

for (const strategy of ['single', 'task_sequence'] as const) for (const source of ['legacy', 'planner'] as const)
for (const fault of source === 'legacy' && strategy === 'single'
  ? ['none', 'provider', 'model', 'effort', 'budget', 'tools', 'cwd', 'result-path', 'brief-path', 'brief-integrity'] : ['none'])
test(`historical pending ${strategy} builder recovers only with ${source} provenance${fault === 'none' ? '' : ` and rejects changed ${fault}`}`, async () => {
  const f = await fixture({ taskSequence: strategy === 'task_sequence', moreTasks: true, seedLedger: false, hostLedger: true })
  const prepared = await f.prepare()
  for (const [role, worker] of Object.entries(prepared.workers)) {
    const path = join(f.context.stateRoot, f.row.id, `${role}.brief`)
    await writeFile(path, await readFile(worker.request.brief.path, 'utf8'))
    worker.request = { ...worker.request, brief: { ...worker.request.brief, path } }
  }
  // The native pending reservation is created using the original path and
  // integrity before dispatch. Recovery cannot manufacture a replacement.
  const host = await createProjectBuildHost(prepared)
  const runner = host.workers.build.runner
  host.workers.build.runner = { ...runner, async run(...args) {
    const outcome = await runner.run(...args)
    expect(outcome.kind).toBe('completed')
    return { kind: 'unknown', detail: 'fixture: completed historical builder acknowledgement lost' }
  } }
  expect(await buildRun({ mode: 'implementation', start: 'fresh', run_id: f.row.id, workers: host.workers,
    repl_provider: 'anthropic', merge_mode: 'pr' }, host.deps, new AbortController().signal))
    .toMatchObject({ kind: 'unknown', phase: 'build' })
  const event = f.store.stageEvents(f.row.id).filter(row => row.stage === 'build-mode-state').at(-1)!
  const state = JSON.parse(event.meta!)
  const recovery = state.checkpoint.pending.recovery
  const originalStep = state.checkpoint.pending.step_id
  // Reconstruct the previous writer's durable shape, leaving the genuine native
  // build reservation and result artifact byte-for-byte intact.
  recovery.inputs.mode = strategy === 'single' ? 'pr' : 'ralph'
  if (strategy === 'task_sequence') recovery.inputs.ralphRound = recovery.inputs.taskIteration ?? 0
  delete recovery.inputs.taskIteration
  delete recovery.executionStrategy
  delete recovery.inputs.executionStrategy
  recovery.inputs.workers.plan.request.result.schema = 'project-plan'
  for (const plan of [recovery.plan, recovery.previous]) {
    delete plan.strategy
    delete plan.rationale
  }
  if (strategy === 'single') {
    // The historical single driver kept the accepted payload only in previous
    // and ignored its remainder when assigning the complete change.
    recovery.plan = null
    recovery.previous.remainingTasks = 1
  }
  const originalWorker = recovery.inputs.workers.build
  if (fault === 'provider') originalWorker.provider = 'openai-codex'
  if (fault === 'model') originalWorker.request.model_id = 'different-model'
  if (fault === 'effort') originalWorker.request.effort = 'xhigh'
  if (fault === 'budget') originalWorker.request.budget.wall_ms += 1
  if (fault === 'tools') originalWorker.request.tools = 'read-only'
  if (fault === 'cwd') originalWorker.request.cwd = f.repo
  if (fault === 'result-path') originalWorker.request.result.path += '.unreserved'
  if (fault === 'brief-path') originalWorker.request.brief.path += '.unreserved'
  if (fault === 'brief-integrity') originalWorker.request.brief.integrity = 'sha256:changed'
  // Keep the two checkpoint copies coherent. Only comparison with the actual
  // host-owned routing and immutable files can refuse this forged authority.
  if (fault !== 'none') recovery.request = { ...originalWorker.request,
    run_id: f.row.id, step_id: originalStep, role: 'build', needs_approval_decision: false }
  await f.store.recordStageEvent(f.row.id, 'build-mode-state', JSON.stringify(state))
  if (source === 'legacy') {
    f.db.raw().query("UPDATE code_trident_runs SET strategy_source = 'legacy', strategy_plan = NULL WHERE id = ?").run(f.row.id)
  }
  if (source === 'legacy' && fault === 'none') {
    const resumed = await createProjectBuildHost(await f.prepare())
    const normalized = (await resumed.deps.modes!.loadResume())!.pending!.recovery!
    expect(await resumed.deps.validateLegacyPendingRequest!(normalized.inputs.workers)).toEqual({ kind: 'allow' })
    expect(normalized.inputs as Record<string, unknown>).toEqual({ mode: 'implementation', run_id: f.row.id, repl_provider: 'anthropic', merge_mode: 'pr',
      taskIteration: 0, maxRounds: f.row.max_rounds, workers: normalized.inputs.workers })
    expect(normalized.request).toEqual({ ...normalized.inputs.workers.build!.request,
      run_id: f.row.id, step_id: originalStep, role: 'build', needs_approval_decision: false })
  }
  const spend = f.store.get(f.row.id)!.task_iteration
  const artifact = await readFile(join(f.context.stateRoot, f.row.id, 'build.result'), 'utf8')
  f.world.dispatches.length = 0
  const outcome = await restartThroughGateway(f)
  expect(outcome.kind, why(f, outcome)).toBe(source === 'planner' || fault !== 'none' ? 'unknown' : strategy === 'single' ? 'merged' : 'continued')
  if (fault !== 'none') expect(outcome).toMatchObject({ kind: 'unknown', detail: fault === 'brief-path'
    ? 'Original worker brief is not the reserved legacy artifact' : fault === 'brief-integrity'
      ? 'Original worker brief integrity cannot be established' : 'Original worker routing or authority changed during recovery' })
  expect(f.world.dispatches.some(d => d.role === 'plan' || d.role === 'build')).toBe(false)
  expect(f.store.get(f.row.id)!.execution_strategy).toBe(strategy)
  // A recovered completed builder consumes its task at the durable handoff,
  // before outer harvest. Refused recovery and single builds spend no task.
  expect(f.store.get(f.row.id)!.task_iteration).toBe(spend + (outcome.kind === 'continued' ? 1 : 0))
  if (source === 'legacy' && strategy === 'task_sequence') {
    const handoff = f.store.stageEvents(f.row.id).filter(row => row.stage === 'build-mode-state').at(-1)!
    expect(JSON.parse(handoff.meta!)).toMatchObject({ iteration: spend + 1, checkpoint: { stage: 'task-built' } })
  }
  expect(await readFile(join(f.context.stateRoot, f.row.id, 'build.result'), 'utf8')).toBe(artifact)
  expect(JSON.parse(artifact).step_id).toBe(originalStep)
  if (source === 'planner' || fault !== 'none') {
    expect(lastCheckpoint(f).pending).toEqual(state.checkpoint.pending)
    expect(f.github.prs).toEqual([])
  }
}, 30_000)

for (const progress of ['valid', 'missing', 'null', 'invalid'] as const)
test(`pending native fix recovery preserves repeated-finding enforcement with ${progress} progress`, async () => {
  const f = await fixture({ blockersByRound: [0, 2, 1], repeatFirstFinding: true })
  const host = await createProjectBuildHost(await f.prepare())
  const runner = host.workers.fix.runner
  host.workers.fix.runner = { ...runner, async run(...args) {
    const result = await runner.run(...args)
    expect(result.kind).toBe('completed')
    return { kind: 'unknown', detail: 'fixture: completed fix acknowledgement lost' }
  } }
  expect(await buildRun({ mode: 'implementation', start: 'fresh', run_id: f.row.id, workers: host.workers,
    repl_provider: 'anthropic', merge_mode: 'pr' }, host.deps, new AbortController().signal))
    .toMatchObject({ kind: 'unknown', phase: 'fix' })
  const event = f.store.stageEvents(f.row.id).filter(row => row.stage === 'build-mode-state').at(-1)!
  const state = JSON.parse(event.meta!)
  expect(state.checkpoint.pending).toMatchObject({ phase: 'fix', step_id: `${f.row.id}:fix:1`,
    recovery: { previousReview: { blockingCount: 6 } } })
  expect(state.checkpoint.pending.recovery.previousReview.findings.length).toBe(2)
  if (progress === 'missing') delete state.checkpoint.pending.recovery.previousReview
  if (progress === 'null') state.checkpoint.pending.recovery.previousReview = null
  if (progress === 'invalid') state.checkpoint.pending.recovery.previousReview = { findings: [' '], blockingCount: 6 }
  if (progress !== 'valid') await f.store.recordStageEvent(f.row.id, 'build-mode-state', JSON.stringify(state))
  const before = f.world.dispatches.length
  const outcome = await restartThroughGateway(f)
  if (progress === 'valid') {
    expect(outcome).toMatchObject({ kind: 'blocked', phase: 'review', on: 'Review requires orchestrator arbitration: repeated finding' })
    expect(f.world.dispatches.slice(before).map(call => call.role)).toEqual(['review', 'review', 'synthesis'])
  } else {
    expect(outcome.kind).toBe('unknown')
    expect(f.world.dispatches).toHaveLength(before)
  }
  expect(f.world.dispatches.filter(call => call.role === 'fix')).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
}, 30_000)

for (const scenario of ['bare', 'valid', 'repeated', 'exhausted', 'forged-fix', 'wrong-head-fix', 'wrong-run', 'wrong-step'] as const)
test(`unchanged-tip retry consumes prior ${scenario} mutation nomination despite new worker brief`, async () => {
  const argv = scenario === 'valid' ? 'valid' : 'bare'
  const task = 'Implement a bounded numeric limit and verify clamping and below-limit preservation with separate behavioural regression tests'
  const f = await fixture({ dispatchTask: task, maxRounds: scenario === 'exhausted' ? 1 : 5 })
  f.world.mutationArgv = argv
  f.github.refuse.add('create')
  const priorHost = await createProjectBuildHost(await f.prepare())
  // Reconstruct the old host's terminal refusal without altering the saved
  // worker result or the unchanged checkpoint that a real retry must carry.
  const priorGate = priorHost.deps.publishGate
  priorHost.deps.publishGate = async (...args) => {
    const result = await priorGate(...args)
    return result.kind === 'repair-nomination' ? { kind: 'blocked', on: result.finding } : result
  }
  const first = await priorHost.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe(argv === 'bare' ? 'blocked' : 'unknown')
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint).toMatchObject({ stage: 'built', round: 1 })
  expect(checkpoint.pending).toBeUndefined()
  const prior = f.store.get(f.row.id)!
  // Seed the historical publication boundary already observed on the failed
  // prior: its exact checkpoint is the open remote PR's head. No live PR exists.
  const pushed = await spawnCapture(['git', '-C', f.repo, 'push', 'origin', `${checkpoint.head}:refs/heads/${prior.branch}`], f.repo)
  expect(pushed.ok).toBe(true)
  f.github.prs.push({ number: 1, state: 'OPEN', headRefName: prior.branch!, baseRefName: 'main' })
  await f.store.update(prior.id, { phase: 'failed', worktree: null, pr: 1, published_pr: 1 })
  const originalArtifact = await readFile(join(f.context.stateRoot, prior.id, 'build.result'), 'utf8')
  expect(JSON.parse(originalArtifact).result.payload.mutationClaim.guard)
    .toEqual(argv === 'bare' ? ['tests/limit.test.ts'] : ['bun', 'test', 'tests/limit.test.ts'])
  if (scenario === 'forged-fix' || scenario === 'wrong-head-fix') {
    const forged = JSON.parse(originalArtifact)
    forged.step_id = `${prior.id}:fix:1`
    if (scenario === 'wrong-head-fix') forged.result.head = f.baseSha
    forged.result.payload.mutationClaim.guard = ['bun', 'test', 'tests/limit.test.ts']
    forged.result.payload.mutationClaim.control = ['bun', 'test', 'tests/control.test.ts']
    await writeFile(join(f.context.stateRoot, prior.id, 'fix.result'), JSON.stringify(forged))
  }
  const invalidIdentity = scenario === 'wrong-run' || scenario === 'wrong-step'
  if (invalidIdentity) {
    const envelope = JSON.parse(originalArtifact)
    if (scenario === 'wrong-run') envelope.run_id = 'unrelated-run'
    else envelope.step_id = `${prior.id}:build:42`
    await writeFile(join(f.context.stateRoot, prior.id, 'build.result'), JSON.stringify(envelope))
  }
  const retainedArtifact = await readFile(join(f.context.stateRoot, prior.id, 'build.result'), 'utf8')
  const dispatched = await dispatchBoardBoundBuild({ task, board_item_id: 'retry-card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    max_rounds: scenario === 'exhausted' ? 1 : 5,
    board: { get: () => ({ id: 'retry-card', title: task, design_doc_ref: null, linked_run_id: prior.id }), attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => 'pr',
  })
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  expect(dispatched.run.inner_checkpoint_head).toBe(String(checkpoint.head))
  expect(dispatched.run.published_pr).toBe(1)
  f.world.dispatches.length = 0
  f.github.refuse.delete('create')
  // Any genuinely requested new worker could return the corrected executable
  // nomination; the reproduction proves whether the loop ever asks one.
  f.world.mutationArgv = scenario === 'repeated' ? 'bare' : 'valid'
  let settled!: () => void
  const completion = new Promise<void>(resolve => { settled = resolve })
  const record = f.store.recordStageEvent.bind(f.store)
  const recording = spyOn(f.store, 'recordStageEvent').mockImplementation(async (...args) => {
    await record(...args)
    if (args[1] === 'build-driver-settled') settled()
  })
  cleanups.push(() => recording.mockRestore())
  const launcher = createProjectLauncher({ store: f.store, onError: () => {}, prepare: async input => {
    f.input.run = input.run
    const options = await f.prepare()
    expect(await readFile(options.workers.fix.request.brief.path, 'utf8')).toContain('executable argv arrays')
    return options
  } })
  const orch = buildTridentOrchestrator({ fire_workflow: launcher, db_path: f.input.db_path,
    base_branch: 'main', run_host: Object.assign(f.context.runHost, { writesDiffOutput: true as const }),
    read_run: id => f.store.get(id), sleep: async () => {} })
  const advanced = await orch.step(dispatched.run)
  expect(await f.store.saveIfActive(advanced.run)).toBe(true)
  await completion
  const terminal = await orch.step(f.store.get(dispatched.run.id)!)
  expect(await f.store.saveIfActive(terminal.run)).toBe(true)
  const result = JSON.parse(f.store.get(dispatched.run.id)!.inner_result!).projectBuild
  const blocked = scenario === 'repeated' || scenario === 'exhausted' || invalidIdentity
  expect(result.kind, JSON.stringify(result)).toBe(blocked ? 'blocked' : 'merged')
  if (blocked) expect(result.on).toContain(invalidIdentity ? 'mutation' : scenario === 'repeated' ? 'repeated finding' : 'round ceiling')
  expect(f.world.dispatches.some(dispatch => ['plan', 'build'].includes(dispatch.role))).toBe(false)
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix').map(dispatch => dispatch.step_id))
    .toEqual(argv === 'bare' && scenario !== 'exhausted' && !invalidIdentity ? [`${dispatched.run.id}:fix:1`] : [])
  expect(f.github.prs[0]!.state).toBe(blocked ? 'OPEN' : 'MERGED')
  const checkpoints = f.store.stageEvents(dispatched.run.id).filter(event => event.stage === 'build-mode-state')
    .map(event => JSON.parse(event.meta!).checkpoint)
  if (argv === 'bare' && !invalidIdentity) expect(checkpoints).toContainEqual(expect.objectContaining({ stage: 'rejected', head: checkpoint.head, round: 1 }))
  if (scenario === 'repeated') expect(checkpoints.at(-1)).toMatchObject({ stage: 'rejected', round: 2 })
  expect(await readFile(join(f.context.stateRoot, prior.id, 'build.result'), 'utf8')).toBe(retainedArtifact)
}, 300_000)

test('local invalid nomination gets one bounded fix and a fresh review before local merge', async () => {
  const f = await fixture({ mergeMode: 'local', maxRounds: 3 })
  f.world.mutationArgv = 'bare'
  const host = await createProjectBuildHost(await f.prepare())
  const prepare = host.deps.prepareWork
  host.deps.prepareWork = async (request, context) => {
    if (request.role === 'fix') {
      expect(context.findings.join('\n')).toContain('not a test runner on the prover allowlist')
      f.world.mutationArgv = 'valid'
    }
    await prepare(request, context)
  }
  const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.filter(dispatch => dispatch.step_id.startsWith(`${f.row.id}:`)
    && ['review', 'fix'].includes(dispatch.role)).map(dispatchStep))
    .toEqual([`${f.row.id}:review:1`, `${f.row.id}:fix:1`, `${f.row.id}:review:2`])
  expect(f.github.prs).toEqual([])
}, 300_000)

for (const mergeMode of ['pr', 'local'] as const)
for (const scenario of ['unmoved', 'branch', 'branch-and-base', 'before-dispatch', ...(mergeMode === 'pr' ? ['pre-fire'] as const : [])] as const)
test(`an orchestrated ${mergeMode} retry survives launch falsification: ${scenario}`, async () => {
  const task = 'Record a note in NOTES.md and verify the resulting change with the complete regression suite'
  const f = await fixture({ dispatchTask: task, mergeMode })
  f.github.refuse.add('create')
  const priorHost = await createProjectBuildHost(await f.prepare())
  if (mergeMode === 'local') priorHost.deps.reviewReadiness = async () => ({ kind: 'unknown', detail: 'Simulated stop before review' })
  const first = await priorHost.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('unknown')
  const checkpoint = lastCheckpoint(f)
  await f.store.update(f.row.id, { phase: 'failed', worktree: null })
  const redispatch = (priorId: string) => dispatchBoardBoundBuild({ task, board_item_id: 'retry-card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    board: { get: () => ({ id: 'retry-card', title: task, design_doc_ref: null, linked_run_id: priorId }), attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => mergeMode,
  })
  const advanceBranch = async () => {
  const committed = await spawnCapture(['git', '-C', f.repo, 'commit-tree', `${checkpoint.head}^{tree}`,
    '-p', String(checkpoint.head), '-m', 'test: advance before launch'], f.repo)
  expect(committed.ok).toBe(true)
  const branch = `refs/heads/${f.store.get(f.row.id)!.branch}`
  expect((await spawnCapture(['git', '-C', f.repo, ...(mergeMode === 'pr'
    ? ['push', 'origin', `${committed.stdout.trim()}:${branch}`] : ['update-ref', branch, committed.stdout.trim()])], f.repo)).ok).toBe(true)
  }
  if (scenario === 'before-dispatch') await advanceBranch()
  const dispatched = await redispatch(f.row.id)
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  expect(dispatched.run.inner_checkpoint_head).toBe(scenario === 'before-dispatch' ? null : String(checkpoint.head))
  if (scenario !== 'unmoved' && scenario !== 'before-dispatch') await advanceBranch()
  if (scenario === 'branch-and-base' || scenario === 'pre-fire') {
    const base = await spawnCapture(['git', '-C', f.repo, 'commit-tree', `${f.baseSha}^{tree}`,
      '-p', f.baseSha, '-m', 'test: advance base before launch'], f.repo)
    expect(base.ok).toBe(true)
    expect((await spawnCapture(['git', '-C', f.repo, ...(mergeMode === 'pr'
      ? ['push', 'origin', `${base.stdout.trim()}:refs/heads/main`] : ['update-ref', 'refs/heads/main', base.stdout.trim()])], f.repo)).ok).toBe(true)
  }
  f.world.dispatches.length = 0
  f.github.refuse.delete('create')
  let fired = 0
  let settled!: () => void
  const completion = new Promise<void>(resolve => { settled = resolve })
  const record = f.store.recordStageEvent.bind(f.store)
  const recording = spyOn(f.store, 'recordStageEvent').mockImplementation(async (...args) => {
    await record(...args)
    if (args[1] === 'build-driver-settled') settled()
  })
  cleanups.push(() => recording.mockRestore())
  const launcher = createProjectLauncher({ store: f.store, onError: () => {}, prepare: async input => {
    fired++
    f.input.run = input.run
    const options = await f.prepare()
    if (scenario !== 'unmoved') throw Error('Simulated failure after preparation')
    return options
  } })
  const runHost = Object.assign(async (...args: Parameters<typeof f.context.runHost>) =>
    scenario === 'pre-fire' && args[0].includes('fetch') && args[0].some(arg => arg.includes('refs/heads/main:'))
      ? { ok: false, stdout: '', stderr: 'Simulated base fetch failure', exit_code: 1, timed_out: false }
      : f.context.runHost(...args), { writesDiffOutput: true as const })
  const orch = buildTridentOrchestrator({ fire_workflow: launcher, db_path: f.input.db_path,
    base_branch: 'main', run_host: runHost, read_run: id => f.store.get(id), sleep: async () => {} })
  const advanced = await orch.step(dispatched.run)
  expect(await f.store.saveIfActive(advanced.run)).toBe(true)
  if (scenario === 'unmoved') {
    await completion
    const terminal = await orch.step(f.store.get(dispatched.run.id)!)
    expect(await f.store.saveIfActive(terminal.run)).toBe(true)
    expect(terminal.run.phase, JSON.stringify(terminal)).toBe('done')
    expect(f.world.dispatches.some(d => d.role === 'plan' || d.role === 'build' || d.role === 'fix')).toBe(false)
    expect(dispatchStep(standaloneReview(f.world))).toBe(`${dispatched.run.id}:review:1`)
    expect(standaloneReview(f.world).measuredHead).toBe(String(checkpoint.head))
    return
  }
  const failed = f.store.get(dispatched.run.id)!
  expect(fired).toBe(scenario === 'pre-fire' || mergeMode === 'local' ? 0 : 1)
  expect(failed.phase, JSON.stringify(advanced)).toBe('failed')
  expect(advanced.run.inner_checkpoint_head).toBeNull()
  expect(f.world.dispatches).toHaveLength(0)
  const invalidations = f.store.stageEvents(failed.id).filter(event => event.stage === 'build-retry-source-invalidated')
  expect(invalidations).toHaveLength(scenario === 'before-dispatch' ? 0 : 1)
  await f.store.invalidateRetrySource(advanced.run)
  expect(f.store.stageEvents(failed.id).filter(event => event.stage === 'build-retry-source-invalidated')).toHaveLength(invalidations.length)
  const next = await redispatch(failed.id)
  expect(next.ok, JSON.stringify({ failed: failed.failure_reason, next })).toBe(true)
  if (!next.ok) return
  expect(next.run.inner_checkpoint).toBeNull()
  expect(next.run.task_iteration).toBe(dispatched.run.task_iteration)
  expect(next.run.max_task_iterations).toBe(dispatched.run.max_task_iterations)
}, 300_000)

for (const { mergeMode, fixed, moved, preparationFailure, legacyTerminal = false } of [
  { mergeMode: 'pr', fixed: false, moved: false, preparationFailure: false },
  { mergeMode: 'local', fixed: false, moved: false, preparationFailure: false },
  { mergeMode: 'pr', fixed: true, moved: false, preparationFailure: false },
  { mergeMode: 'pr', fixed: false, moved: true, preparationFailure: false },
  { mergeMode: 'pr', fixed: true, moved: false, preparationFailure: true },
  { mergeMode: 'local', fixed: false, moved: false, preparationFailure: true },
  { mergeMode: 'pr', fixed: false, moved: false, preparationFailure: false, legacyTerminal: true },
  { mergeMode: 'local', fixed: false, moved: false, preparationFailure: false, legacyTerminal: true },
] as const)
test(`a cross-run ${mergeMode} retry ${moved ? 'refuses remote movement after dispatch' : `reviews the prior ${fixed ? 'fix' : 'build'} and reaches merged without rebuilding`}${preparationFailure ? ' after a preparation failure' : ''}${legacyTerminal ? ' from a migrated terminal task checkpoint' : ''}`, async () => {
  const task = 'Record a note in NOTES.md and verify the resulting change with the complete regression suite'
  const f = await fixture({ dispatchTask: task, mergeMode, taskSequence: fixed || legacyTerminal,
    ...(fixed ? { blockersByRound: [0, 1, 0] } : {}) })
  const firstHost = await createProjectBuildHost(await f.prepare())
  if (fixed) {
    const readiness = firstHost.deps.reviewReadiness!
    let calls = 0
    firstHost.deps.reviewReadiness = async (...args) => ++calls === 2
      ? { kind: 'unknown', detail: 'Simulated process death after publishing the fix' } : readiness(...args)
  } else if (mergeMode === 'pr') f.github.refuse.add('create')
  else firstHost.deps.reviewReadiness = async () => ({ kind: 'unknown', detail: 'Simulated process death before review' })
  const first = await firstHost.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('unknown')
  expect(f.world.dispatches.filter(dispatch => ['plan', 'build', 'fix'].includes(dispatch.role)).map(dispatch => dispatch.role))
    .toEqual(fixed ? ['plan', 'build', 'fix'] : ['plan', 'build'])
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint).toMatchObject({ stage: fixed ? 'fixed' : 'built', round: fixed ? 2 : 1 })
  if (legacyTerminal) {
    expect(checkpoint.remainingTasks).toBe(0)
    // A migrated pre-selection run has its authenticated terminal checkpoint,
    // but no strategy_plan: that column did not exist when the builder finished.
    f.db.raw().query("UPDATE code_trident_runs SET strategy_source = 'legacy', strategy_plan = NULL WHERE id = ?")
      .run(f.row.id)
  }
  const prior = f.store.get(f.row.id)!
  expect(prior.worktree).not.toBeNull()
  // Exercise the actual host cleanup: a pushed PR branch is disposable locally;
  // local mode retains its only copy. The retry must recover both shapes.
  const branchAfterCleanup = await spawnCapture(['git', '-C', f.repo, 'show-ref', '--verify', '--quiet', `refs/heads/${prior.branch}`], f.repo)
  expect(branchAfterCleanup.ok).toBe(mergeMode === 'local')
  await f.store.update(prior.id, { phase: 'failed', worktree: null })

  const redispatch = (priorId: string) => dispatchBoardBoundBuild({ task, board_item_id: 'retry-card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    board: { get: () => ({ id: 'retry-card', title: task, design_doc_ref: null, linked_run_id: priorId }),
      attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => mergeMode,
  })
  let dispatched = await redispatch(prior.id)
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  expect(dispatched.run.id).not.toBe(prior.id)
  expect(checkpoint.head).toBe(dispatched.run.inner_checkpoint_head)
  f.input.run = dispatched.run
  f.github.refuse.delete('create')
  f.world.dispatches.length = 0
  if (preparationFailure) {
    const runHost = f.context.runHost
    f.context.runHost = async (...args) => args[0].includes('worktree') && args[0].includes('add')
      ? { ok: false, stdout: '', stderr: 'Simulated worktree preparation failure', exit_code: 1, timed_out: false }
      : runHost(...args)
    try { await expect(f.prepare()).rejects.toThrow('Build worktree creation was not confirmed') }
    finally { f.context.runHost = runHost }
    const failed = f.store.get(dispatched.run.id)!
    expect(f.store.stageEvents(failed.id).filter(event => event.stage === 'build-mode-state')).toHaveLength(0)
    expect(f.store.stageEvents(failed.id).some(event => event.stage === 'build-retry-source')).toBe(true)
    expect(f.world.dispatches).toHaveLength(0)
    await f.store.update(failed.id, { phase: 'failed', worktree: null })
    dispatched = await redispatch(failed.id)
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
    if (!dispatched.ok) return
    expect(dispatched.run.task_iteration).toBe(failed.task_iteration)
    expect(dispatched.run.max_task_iterations).toBe(failed.max_task_iterations)
    f.input.run = dispatched.run
  }
  if (moved) {
    const committed = await spawnCapture(['git', '-C', f.repo, 'commit-tree', `${checkpoint.head}^{tree}`,
      '-p', String(checkpoint.head), '-m', 'test: remote advances after dispatch'], f.repo)
    expect(committed.ok).toBe(true)
    const pushed = await spawnCapture(['git', '-C', f.repo, 'push', 'origin', `${committed.stdout.trim()}:refs/heads/${prior.branch}`], f.repo)
    expect(pushed.ok).toBe(true)
    await expect(f.prepare()).rejects.toThrow('Retry branch moved after dispatch')
    expect(f.world.dispatches).toHaveLength(0)
    const local = await spawnCapture(['git', '-C', f.repo, 'show-ref', '--verify', '--quiet', `refs/heads/${prior.branch}`], f.repo)
    expect(local.exit_code).toBe(1)
    return
  }
  const host = await createProjectBuildHost(await f.prepare())
  const outcome = await host.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'plan' || dispatch.role === 'build' || dispatch.role === 'fix')).toBe(false)
  expect(dispatchStep(standaloneReview(f.world))).toBe(`${dispatched.run.id}:${fixed || legacyTerminal ? 'task:0:' : ''}review:${fixed ? 2 : 1}`)
  expect(standaloneReview(f.world).measuredHead).toBe(String(checkpoint.head))
  expect(f.world.dispatches.some(dispatch => dispatch.step_id.startsWith(`${prior.id}:`))).toBe(false)
  const saved = f.store.stageEvents(dispatched.run.id).filter(event => event.stage === 'build-mode-state')
  expect(JSON.parse(saved[0]!.meta!).checkpoint).toEqual(checkpoint)
  expect(JSON.parse(saved[0]!.meta!).runId).toBe(dispatched.run.id)
  const merged = await spawnCapture(['git', '-C', mergeMode === 'pr' ? f.origin : f.repo, 'show', 'refs/heads/main:NOTES.md'], f.repo)
  expect(merged.stdout).toBe(fixed ? `seed\n${prior.id}:task:0:build:0\n${prior.id}:task:0:fix:1` : `seed\n${prior.id}:${legacyTerminal ? 'task:0:' : ''}build:0`)
  if (mergeMode === 'local') expect(f.commands.some(argv => argv[0] === 'gh')).toBe(false)
}, 300_000)

test('a driver restarted between the build and review re-adopts the build instead of redoing it', async () => {
  // GATEWAY RESTARTS HAPPEN MID-RUN, and a build is the most expensive thing to
  // redo. What the next process has is the run row, the mode-state checkpoint and
  // the previous process's worker result files — nothing else.
  const f = await fixture()

  // ── PROCESS 1: plan, build, then the publication the restart interrupts.
  f.github.refuse.add('create')
  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('unknown')
  if (first.kind === 'unknown') expect(first.phase).toBe('publish')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['plan', 'build'])

  // The exact state the restart will find. `pending` MUST be absent: a checkpoint
  // that still names a running turn is settled by its host, never re-dispatched
  // (`build-run.ts:239-243`), and that is the other resume case below.
  const built = await spawnCapture(['git', '-C', f.repo, 'rev-parse', 'refs/heads/trident/card'], f.repo)
  expect(lastCheckpoint(f)).toEqual({ head: built.stdout, stage: 'built', round: 1,
    replansUsed: 0, previousFindings: [], previousBlockingCount: 0, findings: [],
    reviewBaseline: 'none', previousReview: null, remainingTasks: 0 })
  expect(lastCheckpoint(f).pending).toBeUndefined()

  // …and the build worker's result file, which the next process reads back as the
  // suite checkpoint for this revision (`open/wiring/project-build.ts:243-247`).
  const buildResult = JSON.parse(await readFile(join(f.dir, 'state', f.row.id, 'build.result'), 'utf8'))
  expect(buildResult.step_id).toBe(`${f.row.id}:build:0`)
  expect(buildResult.result.head).toBe(built.stdout)

  // ── PROCESS 2: a brand-new prepare, host and driver over the same row and disk.
  f.github.refuse.delete('create')
  f.world.dispatches.length = 0
  const outcome = await restartThroughGateway(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')

  // RE-ADOPTED, NOT REDONE: no plan and no build in the second process, and the
  // review it did run is round 1 — the round the first process had reached.
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual(['review', 'review', 'synthesis'])
  expect(dispatchStep(standaloneReview(f.world))).toBe(`${f.row.id}:review:1`)
  expect(standaloneReview(f.world).measuredHead).toBe(built.stdout)
  // The merged revision is the one process 1 built: one note, not two.
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0`)
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('MERGED')
}, 300_000)

test('a driver resumed after the branch head moved rebuilds instead of adopting the moved revision', async () => {
  const f = await fixture()

  // PROCESS 1 reaches a durable built checkpoint, then dies while publishing.
  f.github.refuse.add('create')
  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('unknown')
  if (first.kind === 'unknown') expect(first.phase).toBe('publish')
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint).toMatchObject({ stage: 'built', round: 1 })

  // While the driver is down, another writer advances the assigned branch. The
  // resume checkpoint still names process 1's build, not this new revision.
  const worktree = f.store.get(f.row.id)!.worktree!
  await writeFile(join(worktree, 'MOVED.md'), 'advanced while driver was down\n')
  await gitOut(f.world.run, worktree, ['add', 'MOVED.md'])
  await gitOut(f.world.run, worktree, ['commit', '-m', 'advance assigned branch'])
  const moved = await gitOut(f.world.run, f.repo, ['rev-parse', 'refs/heads/trident/card'])
  expect(moved).not.toBe(checkpoint.head)

  // PROCESS 2 must rebuild from the newly measured revision. Re-adopting it would
  // skip both these turns and send someone else's unbuilt commit straight to review.
  f.github.refuse.delete('create')
  f.world.dispatches.length = 0
  const outcome = await restartThroughGateway(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual([
    'plan', 'build', 'review', 'review', 'synthesis',
  ])
  expect(f.world.dispatches[0]!.step_id).toBe(`${f.row.id}:plan:1`)
  expect(f.world.dispatches[1]!.step_id).toBe(`${f.row.id}:build:1`)

  const mergedMove = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:MOVED.md'], f.origin)
  expect(mergedMove.stdout).toBe('advanced while driver was down')
  const mergedNotes = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(mergedNotes.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:build:1`)
}, 300_000)

test('a driver restarted during a worker turn refuses to re-fire it', async () => {
  // The driver persists original-request recovery authority before dispatch.
  // Restart may inspect that exact native result, but cannot buy another turn.
  // PROCESS 1 stops INSIDE the review turn: the worker reports `blocked`, which is
  // what every role brief tells it to do when it cannot finish. The driver has
  // already written `pending` and nothing on that path clears it.
  const f = await fixture({ blockRoles: ['review'] })
  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('blocked')
  if (first.kind === 'blocked') expect(first.on).toBe('harness: the review worker was stopped mid-turn')
  // The blocked answer really went through the decoder as a blocked envelope.
  expect(f.world.dispatches.at(-1)!.wrote).toEqual(['kind', 'on', 'run_id', 'schema', 'step_id'])
  const reviewStep = `${f.row.id}:review:1:head:${lastCheckpoint(f).head}`
  const pending = lastCheckpoint(f).pending
  expect(pending).toMatchObject({ phase: 'review', step_id: reviewStep,
    recovery: { request: { run_id: f.row.id, step_id: reviewStep }, snapshot: { head: lastCheckpoint(f).head } } })

  f.world.dispatches.length = 0
  const outcome = await restartThroughGateway(f)
  expect(outcome).toMatchObject({ kind: 'blocked', phase: 'review', on: 'harness: the review worker was stopped mid-turn' })
  // The original blocked observation is recovered, not turned into approval or
  // an invented fresh attempt. Its unresolved checkpoint remains exact.
  expect(lastCheckpoint(f).pending).toEqual(pending)
  // Nothing was dispatched by the second process, and the PR process 1 opened for
  // review is untouched — no merge, no second PR.
  expect(f.world.dispatches).toEqual([])
  expect(f.github.prs).toHaveLength(1)
  expect(f.github.prs[0]!.state).toBe('OPEN')
}, 300_000)

test('attempt accounting reconciles pre-crash provider spend through actual pending gateway recovery without dispatch or approval', async () => {
  const f = await fixture({ blockRoles: ['review'], nativeUsage: true })
  expect((await driveUntilTheProcessDies(f, 'fresh')).kind).toBe('blocked')
  const pending = lastCheckpoint(f).pending as { step_id: string }
  const attempt = f.context.attempts.list(f.row.id).find(row => row.step_id === pending.step_id)!
  expect(attempt).toBeDefined()
  const reviewAttempts = f.context.attempts.list(f.row.id).filter(row => row.phase === 'review_adversarial')
  expect(reviewAttempts).toHaveLength(2)
  expect(new Set(reviewAttempts.map(row => row.step_id)).size).toBe(2)
  expect(reviewAttempts.filter(row => row.review_seat === null)).toHaveLength(1)
  expect(reviewAttempts.filter(row => row.review_seat !== null)).toHaveLength(1)
  // Simulate the crash window: transport receipt reached disk, but ledger
  // completion/usage ingestion did not. The pending driver checkpoint is real.
  f.db.raw().query('UPDATE code_trident_attempts SET outcome = NULL, ended_at = NULL WHERE run_id = ? AND step_id = ?')
    .run(f.row.id, pending.step_id)
  f.db.raw().query('DELETE FROM code_trident_attempt_receipts WHERE run_id = ? AND step_id = ?').run(f.row.id, pending.step_id)
  expect(f.context.attempts.receipt(attempt)).toBeNull()
  // Lose the live session too. Recovery reads the original host-bound child
  // transcript and never acquires a new session to reconcile accounting.
  pool.delete(f.key)
  supervisedBySessionKey.delete(f.key)
  f.world.dispatches.length = 0
  const bindingPath = join(f.context.stateRoot, f.row.id,
    `claude-observer-${createHash('sha256').update(pending.step_id).digest('hex')}.json`)
  const bindingBytes = await readFile(bindingPath, 'utf8')
  const corrupted = JSON.parse(bindingBytes)
  corrupted.request.run_id = 'another-run'
  await writeFile(bindingPath, JSON.stringify(corrupted))
  await createProjectBuildHost(await f.prepare())
  expect(f.context.attempts.receipt(attempt)).toBeNull()
  expect(f.world.dispatches).toHaveLength(0)
  await writeFile(bindingPath, bindingBytes)
  await rename(bindingPath, `${bindingPath}.original`)
  await symlink(`${bindingPath}.original`, bindingPath)
  await createProjectBuildHost(await f.prepare())
  expect(f.context.attempts.receipt(attempt)).toBeNull()
  await rename(`${bindingPath}.original`, bindingPath)
  await createProjectBuildHost(await f.prepare())
  // Usage reconciliation alone cannot settle the result. The subsequent driver
  // recovery separately reads the original validated blocked trailer.
  expect(f.context.attempts.receipt(attempt)).toMatchObject({ source: 'claude-repl-jsonl', input_tokens: 7, output_tokens: 3 })
  expect(f.context.attempts.get(attempt)).toMatchObject({ outcome: null, ended_at: null })
  const resumed = await restartThroughGateway(f)
  expect(resumed).toMatchObject({ kind: 'blocked', phase: 'review', on: 'harness: the review worker was stopped mid-turn' })
  expect(f.world.dispatches).toHaveLength(0)
  expect(f.context.attempts.receipt(attempt)).toMatchObject({ source: 'claude-repl-jsonl', input_tokens: 7, output_tokens: 3 })
  expect(f.context.attempts.get(attempt)).toMatchObject({ outcome: null, ended_at: null })
  await createProjectBuildHost(await f.prepare())
  expect(f.context.attempts.receipt(attempt)).toMatchObject({ input_tokens: 7, output_tokens: 3 })
  const reviewReceipts = reviewAttempts.map(row => f.context.attempts.receipt(row)!)
  for (const receipt of reviewReceipts) expect(receipt).toMatchObject({ input_tokens: 7, output_tokens: 3 })
  expect(new Set(reviewReceipts.map(row => row.receipt_id)).size).toBe(2)
  // Concurrent standalone and panel calls are two real attempts. Reconciliation
  // retains both, but cannot charge either a second time.
  expect(new TridentPhaseUsageStore(f.db).list(f.row.id)!.find(row => row.phase === 'review_adversarial')).toMatchObject({ input_tokens: 14, output_tokens: 6 })
  expect(f.world.dispatches).toHaveLength(0)
  expect(f.github.prs[0]!.state).toBe('OPEN')
}, 300_000)

test('a driver resumed from a rejected checkpoint dispatches the deferred fix', async () => {
  const f = await fixture({ blockersByRound: [0, 1], maxRounds: 1 })

  const first = await driveUntilTheProcessDies(f, 'fresh')
  expect(first.kind, why(f, first)).toBe('blocked')
  if (first.kind === 'blocked') expect(first.on).toBe('Review requires orchestrator arbitration: round ceiling')
  expect(lastCheckpoint(f)).toMatchObject({ stage: 'rejected', round: 1 })
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toEqual([])

  f.db.raw().query('UPDATE code_trident_runs SET max_rounds = ? WHERE id = ?').run(3, f.row.id)
  f.input.run = f.store.get(f.row.id)!
  f.world.dispatches.length = 0
  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(dispatch => dispatch.role)).toEqual([
    'fix', 'review', 'review', 'synthesis',
  ])
  expect(f.world.dispatches[0]!.step_id).toBe(`${f.row.id}:fix:1`)
  const merged = await spawnCapture(['git', '-C', f.origin, 'show', 'refs/heads/main:NOTES.md'], f.origin)
  expect(merged.stdout).toBe(`seed\n${f.row.id}:build:0\n${f.row.id}:fix:1`)
}, 300_000)

// ── LOCAL MERGE MODE ─────────────────────────────────────────────────────────

test('local merge mode reaches merged with no PR, no push and no gh call', async () => {
  // `merge_mode` DEFAULTS TO 'local' (`trident/store.ts:867`), and nothing here had
  // ever driven it. It could not reach review at all: `reviewCi`'s project source
  // reads its rows off `snapshot.pr`, which is `null` by construction for a local
  // run, so G055 answered `unknown` — fail-closed — for every local build. That is
  // the fix this case guards; see `build-host.ts`'s `reviewCi`.
  const f = await fixture({ mergeMode: 'local' })
  const outcome = await drive(f)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(f.world.dispatches.map(dispatch => dispatch.role))
    .toEqual(['plan', 'build', 'review', 'review', 'synthesis'])

  // NOTHING WENT TO GITHUB. No PR record, and — the stronger claim — the driver
  // never invoked `gh` at all, so the mode is genuinely offline-by-construction
  // rather than merely tolerant of a fake that answered.
  expect(f.github.prs).toEqual([])
  expect(f.commands.filter(argv => argv[0] === 'gh')).toEqual([])
  // Nor did it push: `origin/main` and the branch on the origin are untouched.
  const originMain = await spawnCapture(['git', '-C', f.origin, 'rev-parse', 'refs/heads/main'], f.origin)
  expect(originMain.stdout).toBe(f.baseSha)
  const originBranch = await spawnCapture(['git', '-C', f.origin, 'rev-parse', '--verify', 'refs/heads/trident/card'], f.origin)
  expect(originBranch.ok).toBe(false)

  // THE LOCAL BASE MOVED, by a real merge commit with the reviewed head as a
  // parent, and the branch survives it (`mergeLocalReviewed` keeps the branch).
  const localMain = await spawnCapture(['git', '-C', f.repo, 'rev-parse', 'refs/heads/main'], f.repo)
  expect(localMain.stdout).not.toBe(f.baseSha)
  const parents = await spawnCapture(['git', '-C', f.repo, 'rev-list', '--parents', '-n', '1', 'refs/heads/main'], f.repo)
  const built = await spawnCapture(['git', '-C', f.repo, 'rev-parse', 'refs/heads/trident/card'], f.repo)
  expect(parents.stdout.split(' ').slice(1)).toEqual([f.baseSha, built.stdout])
  const notes = await spawnCapture(['git', '-C', f.repo, 'show', 'refs/heads/main:NOTES.md'], f.repo)
  expect(notes.stdout).toBe(`seed\n${f.row.id}:build:0`)
  // Local cleanup runs `keep-branch` (`production-host-effects.ts:427`), so the
  // branch itself survives — asserted on the ref, not on the script's prose.
  expect(built.ok).toBe(true)
  expect(outcome.cleanup.kind).toBe('cleaned')
  expect(outcome.cleanup.detail).not.toContain('DELETED branch')
}, 300_000)

/**
 * ── WHAT THIS HARNESS DOES NOT COVER ──────────────────────────────────
 *
 *  • REAL SESSION STARTUP AND RESTART. Acquisition shapes are injected; actual
 *    prewarm, process creation, and boot adoption are not executed.
 *  • THE MODEL. Whether a real model reads a brief the way `literalWorker`
 *    does. See `envelopeFieldsNamedBy` for the exact strength of the claim.
 *  • THE LEAK SCANNER. `scripts/ci/leak-gate.sh` itself is stubbed; only the
 *    preflight module around it runs. Findings, the fixer loop and the
 *    incomplete/skipped-rule verdicts are untested here.
 *  • THE MUTATION PROVER'S PROOF PATH. The harness's diff is prose-only, so
 *    `runMutationProofGate` takes its exemption. A real guard/control cycle
 *    spawns test processes and is not driven offline here.
 *  • REAL GITHUB. `gh` is faked. Rate limits, cross-repository PRs, branch
 *    protection variants and merge races are not exercised.
 *  • LIVE PROVIDER METERING. Accounting writes, explicit zero, unavailable
 *    metrics, partial failures and transport recovery are exercised above;
 *    a live provider's actual subscription spend still needs live evidence.
 *  • THE PANEL'S OTHER STOPS. `blockersByRound` drives `fix`, `re-plan` and the
 *    round ceiling and G070's repeated-finding stop; separate cases drive a
 *    `COMMENT` verdict and an `unavailable` seat. A seat that remains `deferred`,
 *    or a synthesis that disagrees with the review worker's trailer, is not driven.
 *    Every ordinary round here raises fresh identities. `resumeFix` (the fix
 *    dispatched from a RESUMED rejection, `build-run.ts:461-472`) is driven
 *    alongside the fresh fix path.
 *  • THE REST OF RESUME. The cases here resume `built`, `pending`, `rejected` and
 *    `task-built` checkpoints. An `approved` checkpoint and a regenerated
 *    diff that disagrees with the measurement are not driven.
 *  • KIMI AND THE REST OF HEADLESS PLACEMENT. Codex review's successful first
 *    call and wrong-run envelope are driven above; resume and concurrency are
 *    owned by the runner suite. Kimi remains configured off here.
 *  • Fresh wave orchestration and `mode: 'bound_pr'`. Migrated wave pending
 *    planner recovery and its pinned builder are exercised above.
 *  • LOCAL MODE'S REFUSALS. The local case merges; `localMergeReadiness`'s dirty
 *    worktree, base-drift overlap, moved-branch and non-isolated-worktree stops
 *    are not driven, nor is `confirmLocalMerge` failing after a merge.
 */

// ─────────────────────────────────────────────────────────────────────────────
// A DISPATCH SEAM THAT NEVER RETURNS MUST STOP AT THE WORKER WALL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHY THESE EXIST, AND WHAT THEY RULED OUT.
 *
 * Two live acceptance runs parked in `forge-init` immediately after
 * `build-work-prepared`, with no failure and no subagent, and the first reading
 * was that the plan step's 15-minute wall had not fired — `last_advanced_at` was
 * frozen 18 minutes deep and no stage event had followed.
 *
 * These three cases hang each seam between `build-work-prepared` and the worker's
 * result, one at a time, on a 1.5s wall:
 *
 *   • `submitLine`   — the herdr RPC never acknowledges the dispatch line;
 *   • `acquireTurn`  — the session's turn mutex is never granted;
 *   • silent worker  — the line lands and no result file is ever written.
 *
 * All three stop, in ~1.6s, as a measured `unknown` naming which seam it was. So
 * the wall DOES fire, the dispatch path IS bounded, and a park cannot be produced
 * here — which is what moved the investigation downstream, to what the LAUNCHER
 * does with an `unknown` (`trident/project-launcher.ts`) rather than to what the
 * dispatch does. Keep these: they are the control that says a future park is not
 * in this path.
 *
 * WHAT THEY DO NOT COVER: a seam that hangs the event loop itself, and the real
 * herdr transport. Both are faked here by construction.
 */
function registerSession(f: Awaited<ReturnType<typeof fixture>>, session: Record<string, unknown>) {
  supervisedBySessionKey.set(f.key, { substrate_instance_id: 'cc-agent-e2e',
    project_id: 'e2e-project', skip_permissions: true, extra_dirs: [f.dir] } as never)
  pool.set(f.key, Promise.resolve(session as never))
  cleanups.push(() => { pool.delete(f.key); supervisedBySessionKey.delete(f.key) })
}

const neverSettles = () => new Promise<never>(() => {})

test('terminal task-sequence task receives host-suite instructions after an intermediate task deferred proof', async () => {
  const { renderTestStrategy, FULL_SUITE_REQUIRED, INTERMEDIATE_SUITE_DEFERRED } = await import('@neutronai/trident/test-strategy.ts')
  const f = await fixture({ taskSequence: true, moreTasks: true })
  const strategy = { resolution: { command: 'bun test', source: 'package-json' as const }, jobs: 1, base_branch: 'main',
    knobs: { jobs_env: null, concurrency_env: null, probed_file: null, pinned_by_command: false } }
  f.input.test_strategy_intermediate = renderTestStrategy({ ...strategy, scope: 'subset' })
  f.input.test_strategy = renderTestStrategy({ ...strategy, scope: 'full-suite' })
  const firstHost = await createProjectBuildHost(await f.prepare())
  const first = await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 0,
    run_id: f.row.id, workers: firstHost.workers, repl_provider: 'anthropic', merge_mode: 'pr' },
  firstHost.deps, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('continued')
  const firstContext = JSON.parse(await readFile(workContextPath(firstHost.workers.build.request.brief.path), 'utf8'))
  expect(firstContext.suiteScope).toBe('subset')
  expect(firstContext.testStrategy).toContain(INTERMEDIATE_SUITE_DEFERRED)
  expect(firstContext.testStrategy).not.toContain(FULL_SUITE_REQUIRED)

  const resumed = await createProjectBuildHost(await f.prepare())
  const outcome = await resumed.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome, why(f, outcome)).toMatchObject({ kind: 'blocked', phase: 'publish' })
  const request = resumed.workers.build.request
  const context = JSON.parse(await readFile(workContextPath(request.brief.path), 'utf8'))
  expect(context.previous.remainingTasks).toBe(0)
  expect(context.suiteScope).toBe('host-suite')
  expect(context.testStrategy).toContain('STAGE 2 — HOST OWNED')
  expect(context.testStrategy).not.toContain(INTERMEDIATE_SUITE_DEFERRED)
  const brief = await readFile(request.brief.path, 'utf8')
  expect(brief).toContain('host context `testStrategy`')
  expect(brief).not.toContain(INTERMEDIATE_SUITE_DEFERRED)
}, 300_000)

for (const seam of ['submitLine', 'acquireTurn', 'silent-worker'] as const) {
  test(`a hung ${seam} stops the plan step at its wall as a measured unknown`, async () => {
    const f = await fixture()
    const options = await f.prepare()
    // The real wall is 15 minutes (`PROJECT_BUILD_WALL_MS.plan`); only its LENGTH is
    // shortened here, not the mechanism that enforces it.
    options.workers.plan.request = { ...options.workers.plan.request, budget: { wall_ms: 1_500 } }
    registerSession(f, {
      sessionId: 'e2e-session', toolSurface: LIVE_AGENT_TOOL_NAMES.join(','), cwd: f.dir, hasChildExited: () => false,
      child: { submitLine: seam === 'submitLine' ? neverSettles : async () => {} },
      acquireTurn: seam === 'acquireTurn' ? neverSettles : async () => () => {},
    })
    const host = await createProjectBuildHost(options)
    // IT STOPS is the load-bearing half, and the TEST TIMEOUT is what asserts it.
    // A wall-clock `expect(elapsed).toBeLessThan(...)` here would be a second, worse
    // instrument for the same contract: it reddens when the runner is loaded rather
    // than when the code is wrong, and it cannot fire at all in the case that matters
    // — a genuine park never reaches the assertion. The 60s timeout on this test does
    // fire, and was observed doing so: forcing both walls to an hour (the control for
    // this case) fails it with `timed out after 60000ms`.
    const outcome = await host.run({ mode: 'implementation', start: 'fresh' }, new AbortController().signal)
    expect(outcome, why(f, outcome)).toMatchObject({ kind: 'unknown', phase: 'plan' })
    // WHICH uncertainty is deliberately not pinned. `claudeInReplRunner`'s dispatch
    // wall (`claude-in-repl.ts:76`) and `createClaudeActingTurn`'s own
    // (`claude-acting-turn.ts:73`) are armed from the SAME budget microseconds apart,
    // so either may win the race and each words its stop differently. Both are
    // `unknown`; nothing here depends on which one spoke.
    expect((outcome as { detail: string }).detail, why(f, outcome)).toMatch(/unknown/)
    expect(f.github.prs).toEqual([])
  }, 60_000)
}

for (const mergeMode of ['pr', 'local'] as const)
for (const reviewFix of [false, true])
test(`terminal task-sequence ${mergeMode} publication retry re-proves the built head without new planning or building${reviewFix ? ' and assigns its review-requested fix to host suite proof' : ''}`, async () => {
  const { renderTestStrategy, FULL_SUITE_REQUIRED, INTERMEDIATE_SUITE_DEFERRED } = await import('@neutronai/trident/test-strategy.ts')
  const task = 'Record a note in NOTES.md and verify the resulting change with the complete regression suite\nMORE TASKS'
  const f = await fixture({ dispatchTask: task, mergeMode, taskSequence: true, moreTasks: true, seedLedger: false, hostLedger: true,
    ...(reviewFix ? { blockersByRound: [0, 1, 0] } : {}) })
  // The host alone commits the branch ledger. Include executable code and a real
  // nominated guard/control pair so the retry must repeat mutation proof.
  f.world.mutationArgv = 'valid'
  const strategy = { resolution: { command: 'bash scripts/ci/suite.sh', source: 'package-json' as const }, jobs: 1, base_branch: 'main',
    knobs: { jobs_env: null, concurrency_env: null, probed_file: null, pinned_by_command: false } }
  f.input.test_strategy_intermediate = renderTestStrategy({ ...strategy, scope: 'subset' })
  f.input.test_strategy = renderTestStrategy({ ...strategy, scope: 'full-suite' })
  const intermediateHost = await createProjectBuildHost(await f.prepare())
  const intermediate = await buildRun({ mode: 'implementation', start: 'fresh', taskIteration: 0,
    run_id: f.row.id, workers: intermediateHost.workers, repl_provider: 'anthropic', merge_mode: mergeMode },
  intermediateHost.deps, new AbortController().signal)
  expect(intermediate.kind, why(f, intermediate)).toBe('continued')
  const intermediateContext = JSON.parse(await readFile(workContextPath(intermediateHost.workers.build.request.brief.path), 'utf8'))
  expect(intermediateContext.previous.remainingTasks).toBe(1)
  expect(intermediateContext.suiteScope).toBe('subset')
  expect(intermediateContext.testStrategy).toContain(INTERMEDIATE_SUITE_DEFERRED)
  expect(intermediateContext.testStrategy).not.toContain(FULL_SUITE_REQUIRED)
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'review')).toBe(false)
  await f.store.update(f.row.id, { task_iteration: 1 })
  f.input.run = f.store.get(f.row.id)!
  const firstHost = await createProjectBuildHost(await f.prepare())
  // In PR mode publication pushes the measured object, then PR creation fails.
  // Local mode never needs a remote ref or GitHub to establish continuity.
  if (mergeMode === 'pr') f.github.refuse.add('create')
  else firstHost.deps.reviewReadiness = async () => ({ kind: 'unknown', detail: 'proof temporarily unavailable before review' })
  const first = await firstHost.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(first.kind, why(f, first)).toBe('unknown')
  const terminalContext = JSON.parse(await readFile(workContextPath(firstHost.workers.build.request.brief.path), 'utf8'))
  expect(terminalContext.previous.remainingTasks).toBe(0)
  expect(terminalContext.suiteScope).toBe('host-suite')
  expect(terminalContext.testStrategy).toContain('STAGE 2 — HOST OWNED')
  expect(terminalContext.testStrategy).not.toContain(INTERMEDIATE_SUITE_DEFERRED)
  const checkpoint = lastCheckpoint(f)
  expect(checkpoint).toMatchObject({ stage: 'built', remainingTasks: 0, round: 1 })
  const prior = f.store.get(f.row.id)!
  await f.store.update(prior.id, { phase: 'failed', worktree: null })
  const dispatched = await dispatchBoardBoundBuild({ task, board_item_id: 'retry-card' }, {
    store: f.store, project_slug: 'project', repo_path: f.repo,
    board: { get: () => ({ id: 'retry-card', title: task, design_doc_ref: null, linked_run_id: prior.id }), attachRun: async () => {} },
    resolveBuildRepo: async () => f.repo, resolveMergeMode: async () => mergeMode,
  })
  expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
  if (!dispatched.ok) return
  expect(dispatched.run.inner_checkpoint_head).toBe(String(checkpoint.head))
  expect(dispatched.run.task_iteration).toBe(1)
  f.input.run = dispatched.run
  f.github.refuse.delete('create')
  f.world.dispatches.length = 0
  const host = await createProjectBuildHost(await f.prepare())
  expect(await host.deps.measure()).toMatchObject({ kind: 'known', value: { head: checkpoint.head } })
  const proofHeads: string[] = []
  const publication = host.deps.publishGate
  host.deps.publishGate = async (...args) => { proofHeads.push(args[0].head); return publication(...args) }
  const outcome = await host.run({ mode: 'implementation', start: 'resume' }, new AbortController().signal)
  expect(outcome.kind, why(f, outcome)).toBe('merged')
  expect(proofHeads.length).toBeGreaterThan(0)
  if (mergeMode === 'pr' || !reviewFix) expect(proofHeads).toContain(String(checkpoint.head))
  expect(f.world.dispatches.some(dispatch => ['plan', 'build'].includes(dispatch.role))).toBe(false)
  expect(f.world.dispatches.some(dispatch => dispatch.role === 'review')).toBe(true)
  expect(dispatchStep(standaloneReview(f.world))).toBe(`${dispatched.run.id}:task:1:review:1`)
  expect(standaloneReview(f.world).measuredHead).toBe(String(checkpoint.head))
  expect(f.world.dispatches.some(dispatch => dispatch.step_id.startsWith(`${prior.id}:`))).toBe(false)
  expect(f.world.dispatches.filter(dispatch => dispatch.role === 'fix')).toHaveLength(reviewFix ? 1 : 0)
  if (reviewFix) {
    const fixContext = JSON.parse(await readFile(workContextPath(host.workers.fix.request.brief.path), 'utf8'))
    // A resumed build skips planAndBuild; the in-memory plan is null. The review
    // payload in previous is not a replacement ExecutionPlan.
    expect(fixContext.previous.remainingTasks).toBeUndefined()
    expect(fixContext.suiteScope).toBe('host-suite')
    expect(fixContext.testStrategy).toContain('STAGE 2 — HOST OWNED')
    expect(fixContext.testStrategy).not.toContain(INTERMEDIATE_SUITE_DEFERRED)
    expect(f.world.dispatches.filter(dispatch => dispatch.schema === 'project-review')).toHaveLength(2)
  }
  const publicationLog = await readFile(join(f.context.stateRoot, dispatched.run.id, `suite-round-${reviewFix ? 2 : 1}.log`), 'utf8')
  expect(publicationLog).toContain('HARNESS SUITE ran in')
  const merged = await spawnCapture(['git', '-C', mergeMode === 'pr' ? f.origin : f.repo, 'show', 'refs/heads/main:NOTES.md'], f.repo)
  expect(merged.stdout).toBe(`seed\n${prior.id}:task:0:build:0\n${prior.id}:task:1:build:0${reviewFix ? `\n${dispatched.run.id}:task:1:fix:1` : ''}`)
  if (mergeMode === 'local') expect(f.commands.some(argv => argv[0] === 'gh')).toBe(false)
}, 300_000)
