import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fakeRunner, type BoundedWorkOutcome, type BoundedWorkRequest, type WorkerRunner } from '@neutronai/runtime/bounded-work.ts'
import { createCodexHeadlessRunner } from '@neutronai/runtime/workers/codex-headless.ts'
import { createClaudeHeadlessRunner } from '@neutronai/runtime/workers/claude-headless.ts'
import { createProjectWorkerContinuity, type ProjectWorkerContinuityOptions } from './project-worker-continuity.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const signal = () => new AbortController().signal
const completed = (thread = 'observed-first'): BoundedWorkOutcome => ({
  kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: thread,
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'worker-continuity-')); dirs.push(dir)
  const request = (over: Partial<BoundedWorkRequest> = {}): BoundedWorkRequest => ({
    run_id: 'run', step_id: 'one', role: 'build', model_id: 'gpt-test', effort: 'high', cwd: dir,
    writable: true, network: false, tools: 'edit-and-run', brief: { path: join(dir, 'brief'), integrity: 'fixture' },
    result: { schema: 'FORGE', path: join(dir, 'result') }, thread: null, budget: { wall_ms: 5000 },
    needs_approval_decision: false, ...over,
  })
  const runner = fakeRunner('openai-codex', { outcomes: new Map(['one', 'two', 'three'].map(id => [id, completed()])) })
  const initiated = new Set<string>()
  const options: ProjectWorkerContinuityOptions = { stateDir: dir, runId: 'run', projectId: 'project', replProvider: 'anthropic', runner,
    claimInitial: async request => { if (initiated.has(request.role)) return false; initiated.add(request.role); return true },
    credentialIdentity: async () => 'account-a' }
  const wrap = (over: Partial<ProjectWorkerContinuityOptions> = {}) => createProjectWorkerContinuity({ ...options, ...over })
  const call = (over: Partial<BoundedWorkRequest> = {}) => wrap().run(request(over), 'headless', signal())
  return { dir, request, runner, options, wrap, call, binding: join(dir, 'worker-conversation-build', 'binding.json') }
}

test('first observed thread is reused by a reconstructed host, while original step recovery retains its original request', async () => {
  const f = await fixture()
  expect((await f.call()).kind).toBe('completed')
  expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
  expect((await f.call()).kind).toBe('completed')
  expect(f.runner.calls.map(call => call.thread)).toEqual([null, { id: 'observed-first' }, null])
})

test('recovery uses the stored original thread, settles validated completion and never claims a new binding', async () => {
  const f = await fixture(), recovered: BoundedWorkRequest[] = []
  let claims = 0
  const runner = { ...f.runner, recover: async (request: BoundedWorkRequest) => { recovered.push(request); return completed() } }
  const wrap = () => f.wrap({ runner, claimInitial: async () => { claims++; return true } })
  expect((await wrap().recover!(f.request(), 'headless', signal())).kind).toBe('unknown')
  expect(await readdir(f.dir)).toEqual([]); expect(claims).toBe(0)
  await f.call()
  await f.call({ step_id: 'two' })
  for (const step_id of ['one', 'two']) expect((await wrap().recover!(f.request({ step_id }), 'headless', signal())).kind).toBe('completed')
  expect(recovered.map(request => request.thread)).toEqual([null, { id: 'observed-first' }])
  expect(f.runner.calls).toHaveLength(2); expect(claims).toBe(0)
  expect(JSON.parse(await readFile(f.binding, 'utf8'))).toMatchObject({ thread: 'observed-first', pending: null })
})

test.each(['step', 'brief', 'model', 'credential', 'thread', 'missing-binding', 'missing-initiation', 'missing-step', 'capability', 'lock'] as const)('recovery refuses changed or missing %s without fresh work; intact evidence recovers', async defect => {
  const f = await fixture(); await f.call()
  const recovered: BoundedWorkRequest[] = []
  const runner = { ...f.runner, recover: async (request: BoundedWorkRequest) => { recovered.push(request); return completed() } }
  const req = f.request({ ...(defect === 'step' ? { step_id: 'new' } : {}),
    ...(defect === 'brief' ? { brief: { ...f.request().brief, integrity: 'changed' } } : {}),
    ...(defect === 'model' ? { model_id: 'changed' } : {}), ...(defect === 'thread' ? { thread: { id: 'foreign' } } : {}) })
  const role = join(f.dir, 'worker-conversation-build')
  const step = (await readdir(role)).find(name => name.startsWith('step-'))!
  const target = defect === 'missing-binding' ? f.binding : defect === 'missing-initiation'
    ? join(f.dir, 'worker-conversation-build.initiated.json') : defect === 'missing-step' ? join(role, step, 'request.json') : null
  const original = target ? await readFile(target, 'utf8') : null
  if (target) await unlink(target)
  const lock = join(f.dir, 'worker-conversation-build.writer.lock')
  if (defect === 'lock') await writeFile(lock, '')
  const wrapped = f.wrap({ runner: defect === 'capability' ? f.runner : runner,
    ...(defect === 'credential' ? { credentialIdentity: async () => 'other-account' } : {}) })
  expect((await wrapped.recover!(req, 'headless', signal())).kind).toBe('unknown')
  expect(recovered).toHaveLength(0); expect(f.runner.calls).toHaveLength(1)
  if (target) await writeFile(target, original!)
  if (defect === 'lock') await unlink(lock)
  expect((await f.wrap({ runner }).recover!(f.request(), 'headless', signal())).kind).toBe('completed')
  expect(recovered).toHaveLength(1); expect(f.runner.calls).toHaveLength(1)
})

test.each(['unknown', 'wrong-thread', 'credential-change'] as const)('recovery leaves binding pending for %s until validated completion', async defect => {
  const f = await fixture()
  const pending = { ...f.runner, run: async (req: BoundedWorkRequest) => { await f.runner.run(req, 'headless', signal()); return { kind: 'unknown', detail: 'lost acknowledgement' } as const } }
  await f.wrap({ runner: pending }).run(f.request(), 'headless', signal())
  const before = await readFile(f.binding, 'utf8')
  let credential = 'account-a'
  const recover = async () => {
    if (defect === 'credential-change') credential = 'other-account'
    return defect === 'unknown' ? { kind: 'unknown', detail: 'pending' } as const : completed(defect === 'wrong-thread' ? '' : 'observed-first')
  }
  expect((await f.wrap({ runner: { ...pending, recover }, credentialIdentity: async () => credential }).recover!(f.request(), 'headless', signal())).kind).toBe('unknown')
  expect(await readFile(f.binding, 'utf8')).toBe(before); expect(f.runner.calls).toHaveLength(1)
  expect((await f.wrap({ runner: { ...pending, recover: async () => completed() } }).recover!(f.request(), 'headless', signal())).kind).toBe('completed')
  expect(JSON.parse(await readFile(f.binding, 'utf8'))).toMatchObject({ thread: 'observed-first', pending: null })
  expect(f.runner.calls).toHaveLength(1)
})

for (const field of ['run', 'project', 'model', 'credential', 'provider', 'cwd'] as const) {
  test(`changed ${field} ownership refuses without dispatch; original ownership remains usable`, async () => {
    const f = await fixture(); await f.call()
    const alien = fakeRunner('anthropic', { outcomes: new Map([['two', completed()]]) })
    const changed = f.wrap(field === 'project' ? { projectId: 'other' }
      : field === 'credential' ? { credentialIdentity: async () => 'account-b' }
      : field === 'provider' ? { runner: alien, replProvider: 'openai-codex' } : {})
    const req = f.request({ step_id: 'two', ...(field === 'run' ? { run_id: 'other' } : {}),
      ...(field === 'model' ? { model_id: 'other-model' } : {}), ...(field === 'cwd' ? { cwd: join(f.dir, 'other') } : {}) })
    expect((await changed.run(req, 'headless', signal())).kind).toBe('unknown')
    expect(f.runner.calls).toHaveLength(1); expect(alien.calls).toHaveLength(0)
    expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
  })
}

for (const defect of ['missing-binding', 'corrupt-binding', 'missing-step', 'corrupt-step'] as const) {
  test(`${defect} cannot create a fresh conversation; restoring the receipt resumes normally`, async () => {
    const f = await fixture(); await f.call()
    const roleDir = join(f.dir, 'worker-conversation-build')
    const stepDir = (await readdir(roleDir)).find(name => name.startsWith('step-'))!
    const path = defect.endsWith('binding') ? f.binding : join(roleDir, stepDir, 'request.json')
    const original = await readFile(path, 'utf8')
    if (defect.startsWith('missing')) await unlink(path); else await writeFile(path, '{}')
    expect((await f.call()).kind).toBe('unknown'); expect(f.runner.calls).toHaveLength(1)
    await writeFile(path, original)
    expect((await f.call()).kind).toBe('completed')
  })
}

test('missing whole role directory cannot become an initial turn; restoration preserves observed thread', async () => {
  const f = await fixture(); await f.call()
  const dir = join(f.dir, 'worker-conversation-build')
  const saved = join(f.dir, 'saved-role')
  await rename(dir, saved)
  expect((await f.call({ step_id: 'two' })).kind).toBe('unknown')
  expect(f.runner.calls).toHaveLength(1)
  await rename(saved, dir)
  expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
  expect(f.runner.calls[1]!.thread).toEqual({ id: 'observed-first' })
})

test('losing the whole receipt directory and initiation file cannot turn a follow-up into a first turn', async () => {
  const f = await fixture()
  expect((await f.call()).kind).toBe('completed')
  const saved = `${f.dir}-saved`
  await rename(f.dir, saved)
  try {
    await mkdir(f.dir)
    expect((await f.call({ step_id: 'two' })).kind).toBe('unknown')
    expect((await f.call()).kind).toBe('unknown')
    expect(f.runner.calls).toHaveLength(1)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
    await rename(saved, f.dir)
  }
  expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
  expect(f.runner.calls[1]!.thread).toEqual({ id: 'observed-first' })
})

test('missing initiation witness cannot be reconstructed from a role directory', async () => {
  const f = await fixture(); await f.call()
  const path = join(f.dir, 'worker-conversation-build.initiated.json')
  const original = await readFile(path, 'utf8'); await unlink(path)
  expect((await f.call({ step_id: 'two' })).kind).toBe('unknown'); expect(f.runner.calls).toHaveLength(1)
  await writeFile(path, original)
  expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
})

test('concurrent writers cannot share a thread; after settlement another step can resume it', async () => {
  const f = await fixture()
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve })
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve })
  const runner: WorkerRunner = { ...f.runner, async run(req) { f.runner.calls.push(req); entered(); await held; return completed() } }
  const running = f.wrap({ runner }).run(f.request(), 'headless', signal()); await ready
  expect((await f.call()).kind).toBe('unknown'); expect(f.runner.calls).toHaveLength(1)
  expect((await f.call({ step_id: 'two' })).kind).toBe('unknown'); expect(f.runner.calls).toHaveLength(1)
  finish(); expect((await running).kind).toBe('completed')
  expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
  expect(f.runner.calls[1]!.thread).toEqual({ id: 'observed-first' })
})

test('unobserved or different threads never authorize a follow-up; pending original step can recover', async () => {
  const f = await fixture()
  const runner: WorkerRunner = { ...f.runner, run: async () => ({ ...completed(), thread_id: null }) as BoundedWorkOutcome }
  expect((await f.wrap({ runner }).run(f.request(), 'headless', signal())).kind).toBe('unknown')
  expect((await f.call({ step_id: 'two' })).kind).toBe('unknown'); expect(f.runner.calls).toHaveLength(0)
  expect((await f.call()).kind).toBe('completed')
  const changed: WorkerRunner = { ...f.runner, run: async () => completed('foreign') }
  expect((await f.wrap({ runner: changed }).run(f.request({ step_id: 'two' }), 'headless', signal())).kind).toBe('unknown')
  expect((await f.call({ step_id: 'three' })).kind).toBe('unknown')
  expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
})

test('credential changes during a turn cannot bind its thread, and missing identity cannot buy a turn', async () => {
  const f = await fixture()
  expect((await f.wrap({ credentialIdentity: async () => null }).run(f.request(), 'headless', signal())).kind).toBe('unknown')
  expect(f.runner.calls).toHaveLength(0)
  let account = 'account-a'
  const runner: WorkerRunner = { ...f.runner, async run() { account = 'account-b'; return completed() } }
  expect((await f.wrap({ runner, credentialIdentity: async () => account }).run(f.request(), 'headless', signal())).kind).toBe('unknown')
  expect((await f.call({ step_id: 'two' })).kind).toBe('unknown')
  expect((await f.call()).kind).toBe('completed')
})

test('supplied foreign thread and changed same-step request refuse; a new role has its own conversation', async () => {
  const f = await fixture(); await f.call()
  expect((await f.call({ thread: { id: 'foreign' } })).kind).toBe('unknown')
  expect((await f.call({ effort: 'low' })).kind).toBe('unknown')
  expect(f.runner.calls).toHaveLength(1)
  expect((await f.call()).kind).toBe('completed')
  expect((await f.call({ role: 'fix' })).kind).toBe('completed')
  expect(f.runner.calls[2]!.thread).toBeNull()
  expect((await f.call({ role: 'fix', step_id: 'two' })).kind).toBe('completed')
  expect(f.runner.calls[3]!.thread).toEqual({ id: 'observed-first' })
})

for (const defect of ['symlink', 'oversized', 'stale-lock'] as const) {
  test(`${defect} stays uncertain without dispatch; intact receipt is a positive control`, async () => {
    const f = await fixture(); await f.call()
    const original = await readFile(f.binding, 'utf8')
    if (defect === 'symlink') {
      await writeFile(join(f.dir, 'other'), original); await unlink(f.binding); await symlink(join(f.dir, 'other'), f.binding)
    } else if (defect === 'oversized') await writeFile(f.binding, original + ' '.repeat(16_385))
    else await writeFile(join(f.dir, 'worker-conversation-build.writer.lock'), '')
    expect((await f.call({ step_id: 'two' })).kind).toBe('unknown'); expect(f.runner.calls).toHaveLength(1)
    if (defect === 'symlink') await unlink(f.binding)
    if (defect === 'stale-lock') await unlink(join(f.dir, 'worker-conversation-build.writer.lock'))
    else await writeFile(f.binding, original)
    expect((await f.call({ step_id: 'two' })).kind).toBe('completed')
  })
}

test('same-provider work and review seats retain their native placement and do not enter builder binding storage', async () => {
  const f = await fixture()
  for (const provider of ['anthropic', 'openai-codex'] as const) {
    const runner = fakeRunner(provider, { outcomes: new Map([['one', completed()]]) })
    expect((await f.wrap({ runner, replProvider: provider }).run(f.request(), 'in-repl', signal())).kind).toBe('completed')
    expect(runner.calls[0]!.thread).toBeNull()
  }
  expect((await f.call({ role: 'review', thread: { id: 'seat-thread' } })).kind).toBe('completed')
  expect(f.runner.calls[0]!.thread).toEqual({ id: 'seat-thread' })
  expect(await readdir(f.dir)).toEqual([])
})

test('unsupported Claude build/fix retain explicit capability refusal without any dispatch or binding', async () => {
  const f = await fixture()
  const runner = createClaudeHeadlessRunner({ env: {}, cwd: f.dir, state_dir: f.dir, schemas: new Map() })
  const wrapped = f.wrap({ runner, replProvider: 'openai-codex' })
  for (const role of ['build', 'fix'] as const) {
    expect(await wrapped.run(f.request({ role }), 'headless', signal())).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
  }
  expect(await readdir(f.dir)).toEqual([])
})

test('real Codex adapter receives initial creation, restart resume and same-step recall without another paid dispatch', async () => {
  const f = await fixture()
  const script = join(f.dir, 'wrapper.sh')
  await writeFile(join(f.dir, 'brief'), 'build')
  await writeFile(join(f.dir, 'claim.diff'), '+change')
  await writeFile(script, `#!/bin/bash
printf '%s\\n' "$NEUTRON_CODEX_THREAD_ID" >> threads
printf '{"type":"thread.started","thread_id":"%s"}\\n' "\${NEUTRON_CODEX_THREAD_ID:-observed-first}"
echo '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":2}}'
printf 'NEUTRON_CODEX_BUILD_HEAD=head\\nNEUTRON_CODEX_BUILD_DIFF=claim.diff\\nNEUTRON_CODEX_BUILD_PR=\\n' > "$NEUTRON_CODEX_BUILD_TRAILER_FILE"
`)
  await chmod(script, 0o700)
  const fresh = (over: Partial<ProjectWorkerContinuityOptions> = {}) => f.wrap({
    runner: createCodexHeadlessRunner({ buildScript: script, probe: { ok: true }, env: { PATH: process.env.PATH } }), ...over,
  })
  expect((await fresh().run(f.request(), 'headless', signal())).kind).toBe('completed')
  await writeFile(join(f.dir, 'reconstructed-brief'), 'build')
  const recovered = f.request({ budget: { wall_ms: 1000 },
    brief: { path: join(f.dir, 'reconstructed-brief'), integrity: 'fixture' },
    result: { path: join(f.dir, 'reconstructed-result'), schema: 'FORGE' } })
  expect((await fresh().run(recovered, 'headless', signal())).kind).toBe('completed')
  expect((await fresh().run({ ...recovered, brief: { ...recovered.brief, integrity: 'changed' } }, 'headless', signal())).kind).toBe('unknown')
  expect((await fresh().run({ ...recovered, result: { ...recovered.result, path: join(f.dir, 'other', 'result') } }, 'headless', signal())).kind).toBe('unknown')
  expect((await fresh().run({ ...recovered, model_id: 'changed-model' }, 'headless', signal())).kind).toBe('unknown')
  expect((await fresh({ credentialIdentity: async () => 'changed-account' }).run(recovered, 'headless', signal())).kind).toBe('unknown')
  expect(await readFile(join(f.dir, 'threads'), 'utf8')).toBe('\n')
  expect((await fresh().run(f.request({ step_id: 'two' }), 'headless', signal())).kind).toBe('completed')
  expect(await readFile(join(f.dir, 'threads'), 'utf8')).toBe('\nobserved-first\n')
  const observation = await fresh().observe?.(f.request({ step_id: 'two' }))
  expect(observation?.thread_id).toBe('observed-first')
  expect(await readFile(join(f.dir, 'threads'), 'utf8')).toBe('\nobserved-first\n')
  const role = join(f.dir, 'worker-conversation-build'); const saved = join(f.dir, 'saved-role')
  await rename(role, saved)
  expect((await fresh().run(f.request({ step_id: 'three' }), 'headless', signal())).kind).toBe('unknown')
  expect(await readFile(join(f.dir, 'threads'), 'utf8')).toBe('\nobserved-first\n')
  await rename(saved, role)
  expect((await fresh().run(f.request({ step_id: 'three' }), 'headless', signal())).kind).toBe('completed')
  expect(await readFile(join(f.dir, 'threads'), 'utf8')).toBe('\nobserved-first\nobserved-first\n')
})
