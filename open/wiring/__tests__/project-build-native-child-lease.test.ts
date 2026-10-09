/**
 * #1237 — the native-child seam of a bounded build step holds a durable lease.
 *
 * `prepareProjectBuild`'s acting turn is the ONE production entry that starts a
 * native child inside the project REPL, and it calls the child's acting turn
 * directly — never through the chat runner's admitted turn. So it admits its own
 * `liveChild` lease, BEFORE any REPL is resolved or spawned, over the REAL
 * `ProjectAdmission` on a migrated database.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as capacity from '@neutronai/runtime/workers/claude-capacity-client.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as fs from 'node:fs'
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
import { nativeDispatchReceiptPath, readClaudeNativeDispatchReceipt, type SignedNativeDispatchRecord } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'

const cleanup: (() => void | Promise<void>)[] = []
let pinLookup: ReturnType<typeof spyOn<typeof capacity, 'loadClaudeCapacityPin'>>
let routeLookup: ReturnType<typeof spyOn<typeof capacity, 'nativeRelayRouteFingerprint'>>
beforeEach(() => {
  // Fake project sessions model an UNREGISTERED self-host.
  pinLookup = spyOn(capacity, 'loadClaudeCapacityPin').mockReturnValue(undefined)
  routeLookup = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
})
afterEach(async () => {
  try { for (const fn of cleanup.splice(0).reverse()) await fn() }
  finally { pinLookup.mockRestore(); routeLookup.mockRestore() }
})

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
  let recoveries = 0
  const runnerSpy = spyOn(runners, 'createProjectRunners').mockImplementation(async options => {
    captured = options
    return { provider: options.conversation.provider, inRepl: { ...fakeRunner(options.conversation.provider),
      recover: async () => { recoveries++; return { kind: 'unknown' as const, detail: 'Native completion remains unknown' } } }, headless: options.headless }
  })
  const codexSpy = spyOn(codex, 'createCodexHeadlessRunner').mockReturnValue(fakeRunner('openai-codex'))
  cleanup.push(() => { runnerSpy.mockRestore(); codexSpy.mockRestore() })

  const admission = new ProjectAdmission({ db, ownerHandle: 'lease-owner', bootId: 'lease-boot' })
  const admitCalls: string[] = []
  const real = admission.forNativeChild(null)
  const nativeChildAdmission: NativeChildAdmission = {
    complete: real.complete,
    dispatchAuthority: real.dispatchAuthority!,
    releaseUnsubmitted: real.releaseUnsubmitted!,
    finishPreparing: real.finishPreparing!,
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
    pool.set(key, Promise.resolve({ sessionId: 'lease-session', childGeneration: 'lease-generation', toolSurface: LIVE_AGENT_TOOL_NAMES.join(','), cwd: dir,
      hasChildExited: () => false, acquireTurn: async () => () => {},
      child: { pid: process.pid, submitLine: async () => { observedDuringTurn.push(childLeases()) } } } as never))
  }
  return { db, store, row, admission, context, captured: () => captured, request, turn, childLeases, observedDuringTurn, options,
    recoveries: () => recoveries,
    registerSession, admitCalls, spawns: () => spawns, prepare: () => prepareProjectBuild(input, context, new AbortController().signal) }
}

test('a malformed trailer and ended parent turn cannot release the child under a draining fence', async () => {
  const f = await fixture()
  expect((await f.admission.forDispatch(null, 'work-board').admit(f.row.id)).status).toBe('admitted')
  const fence = await f.admission.maintenance.beginMaintenance(f.admission.scopeFor(null))
  expect(fence?.phase).toBe('draining')
  f.registerSession()
  await Promise.resolve()
  await mkdir(join(f.context.stateRoot), { recursive: true })
  await writeFile(f.request.result.path, '{}')

  // This ownership control is not a deadline test: allow bounded CI scheduling
  // slack while retaining the short deadline in the uncertainty controls below.
  expect((await f.captured().actingTurn({ ...f.turn(), timeout_ms: 5_000 })).kind).toBe('turn-ended')
  // The child lease existed while the child ran, naming the exact request.
  expect(f.observedDuringTurn).toEqual([[JSON.stringify([f.row.id, 'build:0'])]])
  // Malformed evidence cannot release it. The run's build lease also remains.
  expect(f.childLeases()).toEqual([JSON.stringify([f.row.id, 'build:0'])])
  expect(f.admission.listLeases('build').map((lease) => lease.workRef)).toEqual([f.row.id])
})

test('a positively unentered native actor releases only its own child despite acquisition uncertainty', async () => {
  const f = await fixture()
  expect((await f.admission.forDispatch(null, 'work-board').admit(f.row.id)).status).toBe('admitted')
  // No session and a spawn that produces none: the step's outcome is unknown.
  const outcome = await f.captured().actingTurn(f.turn())
  expect(outcome.kind).toBe('unknown')
  // Acquisition produced no parent and the acting invocation was never entered.
  // This is original actor evidence, not an inference from run termination.
  expect(f.childLeases()).toEqual([])

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

test('consuming recovery releases an authenticated original pre-input refusal after lost durable release', async () => {
  const f = await fixture()
  const admit = f.context.nativeChildAdmission.admit
  f.context.nativeChildAdmission.admit = async (...args) => {
    const child = await admit(...args)
    return child.status === 'admitted' ? { ...child, release: async () => { throw new Error('release acknowledgement lost') } } : child
  }
  // No acting turn was entered. Its terminal receipt survives the failed release.
  expect((await f.captured().actingTurn(f.turn())).kind).toBe('unknown')
  expect(f.childLeases()).toHaveLength(1)
  const originalToken = f.admission.listLeases('liveChild')[0]!.token
  const restarted = new ProjectAdmission({ db: f.db, ownerHandle: 'lease-owner', bootId: 'next-boot' })
  f.context.nativeChildAdmission = restarted.forNativeChild(null)
  await f.context.nativeChildAdmission.admit(f.row.id, f.request.step_id)
  const recovered = await f.prepare()
  expect(await recovered.substrate.inRepl!.recover!(f.request, 'in-repl', new AbortController().signal))
    .toMatchObject({ kind: 'failed', class: 'killed' })
  expect(f.recoveries()).toBe(0)
  expect(restarted.listLeases('liveChild')).toHaveLength(1)
  expect(restarted.listLeases('liveChild')[0]!.token).not.toBe(originalToken)
  expect(f.spawns()).toBe(1)
  expect(f.observedDuringTurn).toEqual([])
})

test.each([0, 75])('consuming recovery retains submitted work and a forged not-submitted flag cannot release it (%sms acknowledgement)', async acknowledgementMs => {
  const f = await fixture(); f.registerSession(); await Promise.resolve()
  await writeFile(f.request.result.path, '{}')
  if (acknowledgementMs > 0) {
    const session = await pool.get(`lease-session-${f.row.id}`)!
    const submit = session!.child.submitLine!
    session!.child.submitLine = async (...args) => { await submit(...args); await delay(acknowledgementMs) }
  }
  // This checks submitted authority and forgery, not deadline expiry. The delayed
  // acknowledgement proves that scheduling beyond the 50ms uncertainty budget
  // cannot accidentally turn this positive control into an unknown outcome.
  expect((await f.captured().actingTurn({ ...f.turn(), timeout_ms: 5_000 })).kind).toBe('turn-ended')
  expect(f.childLeases()).toHaveLength(1)
  const state = join(f.context.stateRoot, encodeURIComponent(f.row.id))
  const receipt = readClaudeNativeDispatchReceipt(state, f.request) as SignedNativeDispatchRecord
  expect(receipt.body).toMatchObject({ phase: 'submission-started', parent: { sessionId: 'lease-session', childGeneration: 'lease-generation' } })
  expect((await f.options.substrate.inRepl!.recover!(f.request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  receipt.body.phase = 'not-submitted'
  await writeFile(nativeDispatchReceiptPath(state, f.request), `${JSON.stringify(receipt)}\n${JSON.stringify(receipt)}\n`)
  expect((await f.options.substrate.inRepl!.recover!(f.request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.childLeases()).toHaveLength(1)
  expect(f.observedDuringTurn).toHaveLength(1)
  expect(f.spawns()).toBe(0)
  expect(f.recoveries()).toBe(2)
})

test('a failed durable submission-intent write prevents native input and retains uncertainty', async () => {
  const f = await fixture(); f.registerSession(); await Promise.resolve()
  const sync = fs.fsyncSync
  let syncs = 0
  const fault = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (++syncs === 4) throw new Error('submission fsync failed')
    sync(fd)
  })
  try {
    expect((await f.captured().actingTurn(f.turn())).kind).toBe('unknown')
  } finally { fault.mockRestore() }
  expect(syncs).toBe(4)
  expect(f.observedDuringTurn).toEqual([])
  expect(f.childLeases()).toHaveLength(1)
  expect((await f.options.substrate.inRepl!.recover!(f.request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.childLeases()).toHaveLength(1)
})
