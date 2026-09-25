/**
 * #1237 — the native-child seam of a bounded build step holds a durable lease.
 *
 * `prepareProjectBuild`'s acting turn is the ONE production entry that starts a
 * native child inside the project REPL, and it calls the child's acting turn
 * directly — never through the chat runner's admitted turn. So it admits its own
 * `liveChild` lease, BEFORE any REPL is resolved or spawned, over the REAL
 * `ProjectAdmission` on a migrated database.
 */
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import type { InnerLoopInput } from '@neutronai/trident/inner-loop.ts'
import * as runners from '@neutronai/runtime/workers/project-runners.ts'
import * as codex from '@neutronai/runtime/workers/codex-headless.ts'
import { fakeRunner, type BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { LIVE_AGENT_TOOL_NAMES } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import { ProjectAdmission, type NativeChildAdmission } from '@neutronai/gateway/project-admission.ts'
import { buildAdmissionReleaseObserver } from '@neutronai/gateway/proactive/admission-release.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { prepareProjectBuild, type ProjectBuildContext } from '../project-build.ts'
import { buildTridentTerminalObserver } from '../trident-nexus-observer.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'native-child-lease-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  seedMigratedDb(join(dir, 'db'))
  const db = ProjectDb.open(join(dir, 'db'))
  cleanup.push(() => db.close())
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: 'card', project_slug: 'project', repo_path: join(dir, 'code'), task: 'Build card' })
  await store.update(row.id, { branch: 'change', base_sha: 'a'.repeat(40) })
  let captured!: runners.ProjectRunnersOptions
  const runnerSpy = spyOn(runners, 'createProjectRunners').mockImplementation(async options => {
    captured = options
    return { provider: options.conversation.provider, inRepl: fakeRunner(options.conversation.provider), headless: options.headless }
  })
  const codexSpy = spyOn(codex, 'createCodexHeadlessRunner').mockReturnValue(fakeRunner('openai-codex'))
  cleanup.push(() => { runnerSpy.mockRestore(); codexSpy.mockRestore() })

  const admission = new ProjectAdmission({ db, ownerHandle: 'lease-owner', bootId: 'lease-boot' })
  const admitCalls: string[] = []
  const real = admission.forNativeChild(null)
  const nativeChildAdmission: NativeChildAdmission = {
    admit: (runId, stepId) => { admitCalls.push(stepId); return real.admit(runId, stepId) },
  }
  let spawns = 0
  const context: ProjectBuildContext = { store, attempts: new TridentAttemptLedger(db), projectDir: dir, projectId: 'lease-project',
    stateRoot: join(dir, 'state'), provider: 'anthropic', providerSource: 'application', env: {},
    spawnProjectSession: async () => { spawns += 1 }, nativeChildAdmission,
    runHost: async argv => ({ ok: true, exit_code: 0, stdout: argv.includes('symbolic-ref') ? 'refs/heads/change' : '', stderr: '' }) }
  context.runSuite = context.runHost
  const input: InnerLoopInput = { run: store.get(row.id)!, base_branch: 'main', db_path: join(dir, 'db'), max_rounds: 3 }
  const options = await prepareProjectBuild(input, context, new AbortController().signal)
  const request: BoundedWorkRequest = { ...options.workers.build.request, run_id: row.id, step_id: 'build:0', role: 'build', needs_approval_decision: false }
  const turn = () => ({ conversation: captured.conversation, request, spec: { ...captured.conversation.spec, prompt: 'bounded work' },
    timeout_ms: 50, signal: new AbortController().signal })
  const childLeases = () => admission.listLeases('liveChild').map((lease) => lease.workRef)

  // A live pooled project session whose child records the leases at submission.
  const observedDuringTurn: string[][] = []
  const key = `lease-session-${row.id}`
  cleanup.push(() => { pool.delete(key); supervisedBySessionKey.delete(key) })
  const registerSession = () => {
    supervisedBySessionKey.set(key, { substrate_instance_id: 'cc-agent-lease', project_id: 'lease-project', skip_permissions: true, extra_dirs: [dir] } as never)
    pool.set(key, Promise.resolve({ sessionId: 'lease-session', toolSurface: LIVE_AGENT_TOOL_NAMES.join(','), cwd: dir,
      hasChildExited: () => false, acquireTurn: async () => () => {},
      child: { submitLine: async () => { observedDuringTurn.push(childLeases()) } } } as never))
  }
  return { db, store, row, admission, context, captured: () => captured, request, turn, childLeases, observedDuringTurn,
    registerSession, admitCalls, spawns: () => spawns, prepare: () => prepareProjectBuild(input, context, new AbortController().signal) }
}

test('a run holding a build lease runs its step under a draining fence; the child lease is released on turn-ended', async () => {
  const f = await fixture()
  expect((await f.admission.forDispatch(null, 'work-board').admit(f.row.id)).status).toBe('admitted')
  const fence = await f.admission.maintenance.beginMaintenance(f.admission.scopeFor(null))
  expect(fence?.phase).toBe('draining')
  f.registerSession()
  await Promise.resolve()
  await mkdir(join(f.context.stateRoot), { recursive: true })
  await writeFile(f.request.result.path, '{}')

  expect((await f.captured().actingTurn(f.turn())).kind).toBe('turn-ended')
  // The child lease existed WHILE the child ran, naming the run...
  expect(f.observedDuringTurn).toEqual([[f.row.id]])
  // ...and is gone once the step provably ended. The run's build lease remains.
  expect(f.childLeases()).toEqual([])
  expect(f.admission.listLeases('build').map((lease) => lease.workRef)).toEqual([f.row.id])
})

test('an UNKNOWN outcome retains the child lease; the composed terminal chain releases it', async () => {
  const f = await fixture()
  expect((await f.admission.forDispatch(null, 'work-board').admit(f.row.id)).status).toBe('admitted')
  // No session and a spawn that produces none: the step's outcome is unknown.
  const outcome = await f.captured().actingTurn(f.turn())
  expect(outcome.kind).toBe('unknown')
  // Guard: the child may still be live, so its lease is RETAINED.
  expect(f.childLeases()).toEqual([f.row.id])

  await f.store.update(f.row.id, { phase: 'failed' })
  const chain = buildTridentTerminalObserver({
    nexus: null,
    observers: [buildAdmissionReleaseObserver({ releaseBuild: (run) => f.admission.releaseBuild(null, run.id) })],
  })
  await chain(f.store.get(f.row.id)!)
  expect(f.childLeases()).toEqual([])
  expect(f.admission.listLeases('build')).toEqual([])
})

test('a fenced scope with NO build lease refuses the step before any REPL is resolved or spawned', async () => {
  const f = await fixture()
  await f.admission.maintenance.register(f.admission.scopeFor(null))
  expect((await f.admission.maintenance.beginMaintenance(f.admission.scopeFor(null)))?.phase).toBe('draining')
  const outcome = await f.captured().actingTurn(f.turn())
  expect(outcome).toMatchObject({ kind: 'refused', reason: 'capability-unsupported' })
  expect(outcome.kind === 'refused' ? outcome.detail : '').toContain('Project admission refused the native child (fenced)')
  expect(f.spawns()).toBe(0)
  expect(f.childLeases()).toEqual([])

  // Opposite control: once the fence is abandoned the same step is admitted and
  // reaches the spawn (which, producing nothing here, ends unknown).
  const fence = f.admission.maintenance.resume(f.admission.scopeFor(null))!
  expect(await f.admission.maintenance.abandon(fence)).toBe(true)
  expect((await f.captured().actingTurn(f.turn())).kind).toBe('unknown')
  expect(f.spawns()).toBe(1)
})

test('the Codex owner-thread branch takes no native-child lease', async () => {
  const f = await fixture()
  f.context.provider = 'openai-codex'
  f.context.codexOwnerBindings = {
    actingTurn: () => async () => ({ kind: 'turn-ended' }),
    guardBuildRunner: (_projectId, runner) => runner,
    prepareReview: async () => {},
  }
  await f.prepare()
  expect((await f.captured().actingTurn(f.turn())).kind).toBe('turn-ended')
  expect(f.admitCalls).toEqual([])
  expect(f.childLeases()).toEqual([])
})
