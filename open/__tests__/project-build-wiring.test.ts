import * as tiers from '@neutronai/trident/model-tiers.ts'
import type { InnerLoopInput } from '@neutronai/trident/inner-loop.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from '@neutronai/trident/store.ts'
import { TridentPhaseUsageStore } from '@neutronai/trident/phase-usage.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import * as runners from '@neutronai/runtime/workers/project-runners.ts'
import * as codex from '@neutronai/runtime/workers/codex-headless.ts'
import { pool, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { fakeRunner, type BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { prepareProjectBuild, type ProjectBuildContext } from '../wiring/project-build.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'project-options-'))
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
  const commands: string[][] = []
  let spawnProjectSession = async (_projectId: string): Promise<void> => {}
  const context: ProjectBuildContext = { store, phaseUsage: new TridentPhaseUsageStore(db), projectDir: dir, projectId: 'fixture-project',
    stateRoot: join(dir, 'state'), provider: 'anthropic', env: {}, spawnProjectSession: projectId => spawnProjectSession(projectId), runHost: async argv => {
      commands.push([...argv])
      return { ok: true, exit_code: 0, stdout: argv.includes('symbolic-ref') ? 'refs/heads/change' : '', stderr: '' }
    } }
  const input: InnerLoopInput = { run: store.get(row.id)!, base_branch: 'main', db_path: join(dir, 'db'), max_rounds: 3 }
  const prepare = () => prepareProjectBuild(input, context, new AbortController().signal)
  return { dir, input, context, prepare, commands, captured: () => captured,
    setSpawnProjectSession: (spawn: (projectId: string) => Promise<void>) => { spawnProjectSession = spawn } }
}

test('option sources preserve pin, selected provider, workflow and unavailable suite evidence', async () => {
  const f = await fixture()
  await writeFile(join(f.dir, 'project-repos.json'), JSON.stringify({ repos: [{ name: 'project', path: 'code', remote: null, ciWorkflow: 'ci.yml' }], default: 'project' }))
  const options = await f.prepare()
  expect(options.production.ciWorkflow).toBe('ci.yml')
  expect(options.production.branch).toBe('change')
  expect(f.context.store.get(f.input.run.id)!.worktree).toBe(options.production.worktree)
  expect(f.commands.some(args => args.includes('add') && args.includes('change'))).toBe(true)
  await mkdir(options.production.worktree, { recursive: true })
  f.commands.length = 0
  await f.prepare()
  expect(f.commands.some(args => args.includes('add'))).toBe(false)
  // G063's checkpoint reader. No result file yet → null, which the source turns into
  // `unknown` and the gate refuses on. That is the correct empty state, not the wiring.
  expect(await options.policy.reviewSuite!.readCheckpoint({ head: 'a'.repeat(40), diff: '', pr: null }, 1)).toBeNull()
  const model = tiers.modelTier('fable')!
  const seat = { id: 'fixture', provider: 'anthropic' as const, family: 'anthropic', modelId: model.model_id, role: 'core' as const, enabled: true }
  expect(options.policy.review!.runnerFor(model, seat)).toBe(options.substrate.inRepl)
  expect(options.policy.review!.runnerFor({ ...model, group: 'api' }, seat)).toBeUndefined()
  expect(options.policy.review!.runnerFor({ ...model, group: 'kimi' }, seat)).toBeUndefined()
  const claim = { file: 'guard.ts', find: 'before', replace: 'after', guard: ['bun', 'test'], control: ['bun', 'test'] }
  const forge = { mutationClaim: claim, worktreePath: options.production.worktree, branch: 'change', commitSha: 'a'.repeat(40), prNumber: null, diffFile: 'diff', testsPassed: true }
  await writeFile(options.workers.build.request.result.path, JSON.stringify({ result: { payload: forge } }))
  expect(await options.policy.mutation.readClaim({ head: 'a'.repeat(40), diff: '', pr: null })).toEqual(claim)
  await writeFile(options.workers.build.request.result.path, JSON.stringify({ result: { payload: { mutationClaim: claim } } }))
  expect(await options.policy.mutation.readClaim({ head: 'a'.repeat(40), diff: '', pr: null })).toBeNull()
  // THE SUITE CLAIM REACHES THE GATE, AND ONLY FOR THE REVISION IT DESCRIBES.
  const head = 'a'.repeat(40)
  const suiteForge = { ...forge, testsPassed: false, suiteOutcome: 'failed-preexisting', suiteEvidence: 'base is red too' }
  await writeFile(options.workers.build.request.result.path, JSON.stringify({ result: { head, payload: suiteForge } }))
  expect(await options.policy.reviewSuite!.readCheckpoint({ head, diff: '', pr: null }, 2)).toEqual({
    runId: f.input.run.id, head, round: 2,
    report: { testsPassed: false, suiteOutcome: 'failed-preexisting', suiteEvidence: 'base is red too' },
  })
  // A claim about a DIFFERENT revision answers nothing.
  expect(await options.policy.reviewSuite!.readCheckpoint({ head: 'b'.repeat(40), diff: '', pr: null }, 2)).toBeNull()
  // The fix round's claim is the fresher of the two and wins at the same head.
  await writeFile(options.workers.fix.request.result.path, JSON.stringify({ result: { head, payload: { ...forge, testsPassed: true, suiteOutcome: 'passed' } } }))
  expect((await options.policy.reviewSuite!.readCheckpoint({ head, diff: '', pr: null }, 3))?.report).toEqual({ testsPassed: true, suiteOutcome: 'passed' })
  const validators = f.captured().trailer.schemas
  const payload = { verdict: 'APPROVE', findings: [] }
  expect(validators.get('verdict')!(payload)).toBe(true)
  const validate = validators.get('project-review')!
  expect(validate({ head: 'a'.repeat(40), diff: '', pr: null, payload })).toBe(true)
  for (const value of [null, 1, {}, { head: 1, diff: '', pr: null, payload }, { head: 'a', diff: 3, pr: null, payload }, { head: 'a', diff: '', pr: 2, payload }, { head: 'a', diff: '', pr: null, payload: {} }]) expect(validate(value)).toBe(false)
  expect(f.captured().trailer.metadata({} as BoundedWorkRequest)).toBeUndefined()
})

test('preparation refuses missing pins, missing rows, unknown branches, failed adds and wrong worktrees', async () => {
  const f = await fixture()
  f.input.run.base_sha = null
  await expect(f.prepare()).rejects.toThrow('pinned base')
  f.input.run.base_sha = 'a'.repeat(40)
  const update = spyOn(f.context.store, 'update').mockResolvedValue(null)
  await expect(f.prepare()).rejects.toThrow('disappeared')
  update.mockRestore()
  const host = f.context.runHost
  for (const timed_out of [false, true]) {
    f.context.runHost = async argv => argv.includes('show-ref') ? { ok: false, exit_code: 128, stdout: '', stderr: '', timed_out } : host(argv, f.dir)
    await expect(f.prepare()).rejects.toThrow('existence is unknown')
  }
  f.context.runHost = async argv => argv.includes('add') ? { ok: false, exit_code: 1, stdout: '', stderr: '' } : host(argv, f.dir)
  await expect(f.prepare()).rejects.toThrow('creation was not confirmed')
  f.context.runHost = async argv => argv.includes('symbolic-ref') ? { ok: true, exit_code: 0, stdout: 'refs/heads/other', stderr: '' } : host(argv, f.dir)
  await expect(f.prepare()).rejects.toThrow('assigned branch')
  f.context.runHost = host
  await writeFile(join(f.dir, 'obstacle'), 'file')
  f.input.run.worktree = join(f.dir, 'obstacle', 'child')
  await expect(f.prepare()).rejects.toThrow('ENOTDIR')
  f.input.run.worktree = null
  f.input.phase_models = { build: { model: 'missing-model' } }
  await expect(f.prepare()).rejects.toThrow('Invalid project phase models')
  f.input.phase_models = null
  const tier = spyOn(tiers, 'modelTier').mockReturnValue(null)
  try { await expect(f.prepare()).rejects.toThrow('Unknown model') } finally { tier.mockRestore() }
  await f.prepare()
})

test('acting turn requires the selected live project session and observed grants', async () => {
  const f = await fixture()
  const options = await f.prepare()
  const captured = f.captured()
  const request: BoundedWorkRequest = { ...options.workers.build.request, run_id: f.input.run.id, step_id: 'fixture-step', role: 'build', needs_approval_decision: false }
  const turn = { conversation: captured.conversation, request, spec: { ...captured.conversation.spec, prompt: 'bounded work' }, timeout_ms: 50, signal: new AbortController().signal }
  const act = () => captured.actingTurn(turn)
  expect((await act()).kind).toBe('unknown')
  const key = 'fixture-project-launch'
  const config = { substrate_instance_id: 'cc-agent-fixture', project_id: f.context.projectId, skip_permissions: true, extra_dirs: [f.dir] }
  const session = { sessionId: 'fixture-session', cwd: f.dir, hasChildExited: () => false, child: { submitLine: async () => {} }, acquireTurn: async () => () => {} }
  cleanup.push(() => { pool.delete(key); supervisedBySessionKey.delete(key); supervisedBySessionKey.delete(key + '-other') })
  supervisedBySessionKey.set(key, config)
  expect((await act()).kind).toBe('unknown')
  pool.set(key, new Promise(() => {}))
  expect((await act()).kind).toBe('unknown')
  pool.set(key, Promise.resolve(session as never))
  await Promise.resolve()
  supervisedBySessionKey.set(key + '-other', config)
  expect((await act()).kind).toBe('unknown')
  supervisedBySessionKey.delete(key + '-other')
  session.hasChildExited = () => true
  expect((await act()).kind).toBe('unknown')
  session.hasChildExited = () => false
  supervisedBySessionKey.set(key, { ...config, restricted: true })
  expect((await act()).kind).toBe('refused')
  supervisedBySessionKey.set(key, config)
  await mkdir(join(f.dir, 'state'), { recursive: true })
  await writeFile(request.result.path, '{}')
  expect((await act()).kind).toBe('turn-ended')
  f.context.provider = 'pi'
  await f.prepare()
  expect((await f.captured().actingTurn({ ...turn, conversation: f.captured().conversation })).kind).toBe('refused')
})

test('acting turn lazily starts and retains a cold project session', async () => {
  const f = await fixture()
  const options = await f.prepare()
  const captured = f.captured()
  const request: BoundedWorkRequest = { ...options.workers.build.request, run_id: f.input.run.id, step_id: 'fixture-step', role: 'build', needs_approval_decision: false }
  const turn = { conversation: captured.conversation, request, spec: { ...captured.conversation.spec, prompt: 'bounded work' }, timeout_ms: 50, signal: new AbortController().signal }
  const key = 'cold-project-launch'
  const config = { substrate_instance_id: 'cc-agent-fixture', project_id: f.context.projectId, skip_permissions: true, extra_dirs: [f.dir] }
  const session = { sessionId: 'fixture-session', cwd: f.dir, hasChildExited: () => false, child: { submitLine: async () => {} }, acquireTurn: async () => () => {} }
  let spawns = 0
  cleanup.push(() => { pool.delete(key); supervisedBySessionKey.delete(key) })
  f.setSpawnProjectSession(async projectId => {
    spawns += 1
    expect(projectId).toBe(f.context.projectId)
    supervisedBySessionKey.set(key, config)
    pool.set(key, Promise.resolve(session as never))
    await Promise.resolve()
  })
  await mkdir(join(f.dir, 'state'), { recursive: true })
  await writeFile(request.result.path, '{}')
  expect((await captured.actingTurn(turn)).kind).toBe('turn-ended')
  expect((await captured.actingTurn(turn)).kind).toBe('turn-ended')
  expect(spawns).toBe(1)
})

test('acting turn keeps ambiguity and spawn/grant outcomes distinct', async () => {
  const f = await fixture()
  const options = await f.prepare()
  const captured = f.captured()
  const request: BoundedWorkRequest = { ...options.workers.build.request, run_id: f.input.run.id, step_id: 'fixture-step', role: 'build', needs_approval_decision: false }
  const turn = { conversation: captured.conversation, request, spec: { ...captured.conversation.spec, prompt: 'bounded work' }, timeout_ms: 50, signal: new AbortController().signal }
  f.setSpawnProjectSession(async () => { throw new Error('spawn failed') })
  expect((await captured.actingTurn(turn)).kind).toBe('unknown')
  const config = { substrate_instance_id: 'cc-agent-fixture', project_id: f.context.projectId, skip_permissions: true }
  const session = { hasChildExited: () => false }
  supervisedBySessionKey.set('one', { ...config, restricted: true })
  pool.set('one', Promise.resolve(session as never))
  await Promise.resolve()
  expect((await captured.actingTurn(turn)).kind).toBe('refused')
  supervisedBySessionKey.set('two', config)
  pool.set('two', Promise.resolve(session as never))
  await Promise.resolve()
  // AMBIGUITY IS REFUSED *BEFORE* THE SPAWN, and the outcome alone cannot show it:
  // with the pre-spawn check removed the run still ends `unknown`, because the
  // post-spawn `!== 1` catches it — after attempting a spawn that would add a THIRD
  // session to an already-ambiguous project. So count the spawns, not just the kind.
  let ambiguousSpawns = 0
  f.setSpawnProjectSession(async () => { ambiguousSpawns += 1 })
  expect((await captured.actingTurn(turn)).kind).toBe('unknown')
  expect(ambiguousSpawns).toBe(0)
  cleanup.push(() => { for (const key of ['one', 'two']) { pool.delete(key); supervisedBySessionKey.delete(key) } })
})

test('a spawned session with the wrong grants is refused, not used', async () => {
  const f = await fixture()
  const options = await f.prepare()
  const captured = f.captured()
  const request: BoundedWorkRequest = { ...options.workers.build.request, run_id: f.input.run.id, step_id: 'fixture-step', role: 'build', needs_approval_decision: false }
  const turn = { conversation: captured.conversation, request, spec: { ...captured.conversation.spec, prompt: 'bounded work' }, timeout_ms: 50, signal: new AbortController().signal }
  // NO candidate to begin with, so the PRE-spawn grant check cannot see anything —
  // the only thing standing between a badly-granted spawned session and a bounded
  // build is the check that runs AFTER the spawn. Without this case that check is
  // unreachable from the tests and a mutation to it stays green.
  cleanup.push(() => { pool.delete('spawned'); supervisedBySessionKey.delete('spawned') })
  f.setSpawnProjectSession(async () => {
    supervisedBySessionKey.set('spawned', { substrate_instance_id: 'cc-agent-fixture', project_id: f.context.projectId, skip_permissions: true, restricted: true } as never)
    pool.set('spawned', Promise.resolve({ hasChildExited: () => false } as never))
    await Promise.resolve()
  })
  expect((await captured.actingTurn(turn)).kind).toBe('refused')
})
