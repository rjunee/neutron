import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import * as implementation from './planner-work.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(api = implementation, authorization?: { current(): boolean | Promise<boolean>; deadline?(): number }) {
  const root = await mkdtemp(join(tmpdir(), 'planner-ops-')); roots.push(root)
  const cwd = join(root, 'worktree'), state = join(root, 'state')
  await mkdir(cwd); await mkdir(state)
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(cwd, 'source.ts'), 'export const value = 1\n')
  await writeFile(join(cwd, '.gitattributes'), '*.ts filter=fixture diff=fixture\n')
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
  const base = git('rev-parse', 'HEAD')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'run:plan:0', role: 'plan', model_id: 'claude-sonnet-4-6',
    effort: 'high', cwd, writable: true, network: false, tools: 'edit', brief: { path: join(state, 'brief'), integrity: 'host-bound' },
    result: { path: join(state, 'result'), schema: 'plan-fixture' }, thread: null, budget: { wall_ms: 60_000 }, needs_approval_decision: false }
  const session = {}, cancel = new AbortController()
  let current = true
  const deadline = Date.now() + 60_000
  const capability = await api.bindPlannerWork({ session, request, base, pr: null, brief: 'Host brief', context: { request }, signal: cancel.signal, get deadline() { return authorization?.deadline?.() ?? deadline },
    current: () => authorization ? authorization.current() : current, validate: envelope => (envelope as { kind: string }).kind === 'blocked'
      || typeof (envelope as { result?: { payload?: { executionSpec?: string } } }).result?.payload?.executionSpec === 'string' })
  const call = (operation: string, fields: object = {}) => api.dispatchPlannerWork(session, { run_id: request.run_id, step_id: request.step_id, capability, operation, ...fields })
  return { root, cwd, state, base, request, session, capability, call, git, cancel, revoke: () => { current = false } }
}

async function assertSyntaxDoesNotExecute(f: Awaited<ReturnType<typeof fixture>>) {
  const marker = join(f.root, 'forbidden-execution')
  await f.call('write', { path: 'uncertainty.ts', content: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export const value = 1` })
  expect(await f.call('probe', { path: 'uncertainty.ts', kind: 'syntax', uncertainty: 'Does the declaration parse without evaluation?' })).toMatchObject({ ok: true })
  await expect(access(marker)).rejects.toThrow()
}

test('closed writable planning preserves preparation, diagnostics and atomic host-measured results', async () => {
  const f = await fixture()
  await f.call('write', { path: 'prepared/new.ts', content: 'export const answer: number = 42\n' })
  const syntax = await f.call('probe', { path: 'prepared/new.ts', kind: 'syntax', uncertainty: 'Does this TypeScript declaration parse?' }) as { ok: boolean; log: string }
  expect(syntax.ok).toBe(true)
  expect(JSON.parse(await readFile(syntax.log, 'utf8')).ok).toBe(true)
  await f.call('write', { path: 'fixture.json', content: '{"ok":true}' })
  expect(await f.call('probe', { path: 'fixture.json', kind: 'json', uncertainty: 'Is the fixture valid JSON?' })).toMatchObject({ ok: true })
  expect(await f.call('state')).toMatchObject({ head: f.base, diff: '', preparation: [{ path: 'prepared/new.ts', committed: false }, { path: 'fixture.json', committed: false }] })
  expect(await f.call('publish', { payload: { executionSpec: 'Build the change and run every required acceptance gate.' } })).toMatchObject({ published: true, head: f.base })
  const result = JSON.parse(await readFile(f.request.result.path, 'utf8'))
  expect(result).toMatchObject({ schema: 'plan-fixture', run_id: 'run', step_id: 'run:plan:0', result: { head: f.base, diff: '', pr: null } })
  expect(result.result.payload.executionSpec).toContain('Host-observed uncommitted preparation')
  expect(await readFile(join(f.cwd, 'prepared/new.ts'), 'utf8')).toContain('42')
  await expect(f.call('state')).rejects.toThrow('expired')
})

test('candidate execution, forged identity, scope aliases and invalid result are refused beside valid siblings', async () => {
  const f = await fixture()
  await expect(f.call('exec', { command: 'bun test' })).rejects.toThrow('Unsupported')
  await expect(f.call('probe', { path: 'source.ts', kind: 'syntax', uncertainty: 'uncertainty', command: 'tsc -p tsconfig.json' })).rejects.toThrow('Unsupported')
  await expect(f.call('probe', { path: 'source.ts', kind: 'test', uncertainty: 'uncertainty' })).rejects.toThrow('closed diagnostic')
  await expect(f.call('probe', { path: 'source.ts', kind: 'syntax', uncertainty: '' })).rejects.toThrow('uncertainty')
  await expect(f.call('state', { step_id: 'other-step' })).rejects.toThrow('no current')
  await expect(f.call('state', { base: 'f'.repeat(40) })).rejects.toThrow('Unsupported')
  await expect(f.call('write', { path: '../state/result', content: 'forged' })).rejects.toThrow('scope')
  await expect(f.call('write', { path: '.git/config', content: 'forged' })).rejects.toThrow('scope')
  await expect(f.call('write', { path: 'node_modules/runner.js', content: 'forged' })).rejects.toThrow('scope')
  await symlink(f.state, join(f.cwd, 'alias'))
  await expect(f.call('write', { path: 'alias/result', content: 'forged' })).rejects.toThrow('aliases')
  await link(join(f.cwd, 'source.ts'), join(f.cwd, 'hardlink.ts'))
  await expect(f.call('write', { path: 'hardlink.ts', content: 'forged' })).rejects.toThrow('aliases')
  await expect(f.call('publish', { payload: {} })).rejects.toThrow('contract')
  await expect(access(f.request.result.path)).rejects.toThrow()
  expect(await f.call('publish', { blocked: 'Closed diagnostics cannot resolve the remaining uncertainty.' })).toMatchObject({ published: true })
})

test('host diagnostics never evaluate source, preload, plugin, Git filter, textconv, extdiff or fsmonitor', async () => {
  const f = await fixture()
  await assertSyntaxDoesNotExecute(f)
  const marker = join(f.root, 'executed')
  const executable = join(f.root, 'forbidden.sh')
  await writeFile(executable, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o755 })
  for (const setting of ['core.fsmonitor', 'diff.external', 'diff.fixture.textconv', 'filter.fixture.clean']) f.git('config', setting, executable)
  await f.call('write', { path: 'source.ts', content: `import './plugin'; require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')` })
  await f.call('write', { path: 'plugin.ts', content: 'throw new Error("must never execute")' })
  expect(await f.call('probe', { path: 'source.ts', kind: 'syntax', uncertainty: 'Does this import parse without loading its target?' })).toMatchObject({ ok: true })
  expect(await f.call('state')).toMatchObject({ head: f.base })
  await f.call('write', { path: 'macro-user.ts', content: 'import { fail } from "./plugin.ts" with { type: "macro" }; export const result = fail();' })
  expect(await f.call('probe', { path: 'macro-user.ts', kind: 'syntax', uncertainty: 'Does the macro import syntax parse without execution?' })).toMatchObject({ ok: false })
  await expect(access(marker)).rejects.toThrow()
  await f.call('write', { path: 'broken.ts', content: 'export const = ;' })
  expect(await f.call('probe', { path: 'broken.ts', kind: 'syntax', uncertainty: 'Is this declaration malformed?' })).toMatchObject({ ok: false })
})

test('revocation and cancellation stop operations without authorizing a result', async () => {
  for (const mode of ['revoke', 'cancel'] as const) {
    const f = await fixture()
    if (mode === 'revoke') f.revoke(); else f.cancel.abort()
    await expect(f.call('write', { path: 'late.ts', content: 'late' })).rejects.toThrow('expired')
    await expect(access(join(f.cwd, 'late.ts'))).rejects.toThrow()
    await expect(access(f.request.result.path)).rejects.toThrow()
  }
})

test('concurrent requests on one native MCP session require their own secret and exact identity', async () => {
  const first = await fixture(), second = await fixture()
  const request = { ...second.request, run_id: 'other-run', step_id: 'other-run:plan:0' }
  const capability = await implementation.bindPlannerWork({ session: first.session, request, base: second.base, pr: null,
    brief: 'Second private brief', context: { request }, signal: second.cancel.signal, deadline: Date.now() + 60_000,
    current: () => true, validate: () => true })
  const invoke = (fields: object) => implementation.dispatchPlannerWork(first.session, { run_id: request.run_id, step_id: request.step_id, capability, operation: 'brief', ...fields })
  await expect(invoke({ capability: first.capability })).rejects.toThrow('no current')
  await expect(first.call('brief', { capability })).rejects.toThrow('no current')
  await expect(first.call('read', { path: '../state/brief' })).rejects.toThrow('scope')
  await expect(invoke({ step_id: first.request.step_id })).rejects.toThrow('no current')
  expect(await invoke({})).toMatchObject({ brief: 'Second private brief' })
  expect(await first.call('brief')).toMatchObject({ brief: 'Host brief' })
  expect(await first.call('list', { path: '' })).toMatchObject({ entries: [{ name: 'source.ts' }] })
  expect(implementation.PLANNER_AGENT.tools).toEqual([implementation.PLANNER_NATIVE_TOOL])
})

test('semantic mutations expose executable diagnostics and lost legitimate preparation', async () => {
  const source = (await readFile(new URL('./planner-work.ts', import.meta.url), 'utf8')).replace(/'(@neutronai\/[^']+)'/g, (_match, specifier: string) => JSON.stringify(import.meta.resolve(specifier)))
  const directory = await mkdtemp(join(tmpdir(), 'planner-mutants-')); roots.push(directory)
  const mutations = [
    { name: 'executable-diagnostic', from: 'else new Bun.Transpiler({ loader: loader! }).scan(source)', to: 'else await import(path)',
      check: async (f: Awaited<ReturnType<typeof fixture>>) => {
        // Valid TypeScript mutant evaluates the mutable source instead of parsing it.
        await expect(assertSyntaxDoesNotExecute(f)).rejects.toThrow()
        expect(await readFile(join(f.root, 'forbidden-execution'), 'utf8')).toBe('executed')
      } },
    { name: 'deny-writes', from: "if (raw.operation === 'write') {", to: "if (raw.operation === 'write') { throw Error('mutant denies legitimate preparation');",
      check: async (f: Awaited<ReturnType<typeof fixture>>) => {
        await expect(f.call('write', { path: 'useful.ts', content: 'export const useful = true' })).rejects.toThrow('mutant denies')
      } },
  ]
  for (const mutation of mutations) {
    expect(source.includes(mutation.from)).toBe(true)
    const path = join(directory, mutation.name + '.ts')
    await writeFile(path, source.replace(mutation.from, mutation.to))
    const api = await import(path) as typeof implementation
    await mutation.check(await fixture(api))
  }
})


const plannerBarrier = () => {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
}

test('planner binding and every operation await current host authorization', async () => {
  let pause = plannerBarrier(), entered = plannerBarrier(), waiting = true
  const authorization = { current: async () => { if (waiting) { entered.release(); await pause.promise }; return true } }
  const preparing = fixture(implementation, authorization)
  await entered.promise
  expect(Bun.peek.status(preparing)).toBe('pending')
  waiting = false; pause.release()
  const f = await preparing
  for (const operation of ['brief', 'read', 'write', 'publish'] as const) {
    pause = plannerBarrier(); entered = plannerBarrier(); waiting = true
    const fields = operation === 'read' ? { path: 'source.ts' }
      : operation === 'write' ? { path: 'during-wait.ts', content: 'export const useful = true' }
      : operation === 'publish' ? { blocked: 'Host-authorized result.' } : {}
    const running = f.call(operation, fields)
    await entered.promise
    expect(Bun.peek.status(running)).toBe('pending')
    if (operation === 'write') await expect(access(join(f.cwd, 'during-wait.ts'))).rejects.toThrow()
    if (operation === 'publish') await expect(access(f.request.result.path)).rejects.toThrow()
    waiting = false; pause.release()
    await running
  }
  expect(await readFile(join(f.cwd, 'during-wait.ts'), 'utf8')).toContain('useful')
  expect(JSON.parse(await readFile(f.request.result.path, 'utf8')).kind).toBe('blocked')
})

test.each(['false', 'cancelled', 'expired'] as const)('planner rechecks %s authorization after awaiting before writes or publication', async change => {
  for (const operation of ['brief', 'write', 'publish'] as const) {
    let waiting = false, allowed = true, deadline = Date.now() + 60_000
    const pause = plannerBarrier(), entered = plannerBarrier()
    const f = await fixture(implementation, { deadline: () => deadline,
      current: async () => { if (waiting) { entered.release(); await pause.promise }; return allowed } })
    waiting = true
    const fields = operation === 'write' ? { path: 'refused.ts', content: 'must not escape' } : operation === 'publish' ? { blocked: 'must not publish' } : {}
    const running = f.call(operation, fields)
    await entered.promise
    if (change === 'false') allowed = false
    if (change === 'cancelled') f.cancel.abort()
    if (change === 'expired') deadline = Date.now() - 1
    pause.release()
    await expect(running).rejects.toThrow('expired or lost ownership')
    await expect(access(join(f.cwd, 'refused.ts'))).rejects.toThrow()
    await expect(access(f.request.result.path)).rejects.toThrow()
  }
})

test('planner async authorization semantic mutants cannot authorize false grants or discard legitimate waiting', async () => {
  const source = (await readFile(new URL('./planner-work.ts', import.meta.url), 'utf8')).replace(/'(@neutronai\/[^']+)'/g, (_match, specifier: string) => JSON.stringify(import.meta.resolve(specifier)))
  const directory = await mkdtemp(join(tmpdir(), 'planner-current-mutants-')); roots.push(directory)
  const anchor = 'const current = await input.current()'
  expect(source.split(anchor)).toHaveLength(2)
  const unsafe = join(directory, 'skip-await.ts')
  await writeFile(unsafe, source.replace(anchor, 'const current = input.current()'))
  const unsafeApi = await import(unsafe) as typeof implementation
  // Positive opposite: the same false asynchronous host decision must refuse.
  await expect(fixture(implementation, { current: async () => false })).rejects.toThrow('lost ownership')
  const escaped = await fixture(unsafeApi, { current: async () => false })
  expect(await escaped.call('write', { path: 'escaped.ts', content: 'unsafe mutant' })).toMatchObject({ written: 'escaped.ts' })
  expect(await readFile(join(escaped.cwd, 'escaped.ts'), 'utf8')).toBe('unsafe mutant')
  const deny = join(directory, 'deny-current.ts')
  await writeFile(deny, source.replace(anchor, 'const current = false'))
  const denyApi = await import(deny) as typeof implementation
  const allowed = await fixture(implementation, { current: async () => true })
  expect(await allowed.call('brief')).toMatchObject({ brief: 'Host brief' })
  await expect(fixture(denyApi, { current: async () => true })).rejects.toThrow('lost ownership')
  const recheck = "if (control.retired || terminal || input.signal.aborted || Date.now() >= input.deadline || !current)"
  expect(source.split(recheck)).toHaveLength(2)
  const stale = join(directory, 'skip-post-await-deadline.ts')
  await writeFile(stale, source.replace(recheck, 'if (!current)'))
  const staleApi = await import(stale) as typeof implementation
  for (const api of [implementation, staleApi]) {
    let deadline = Date.now() + 60_000, expire = false
    const f = await fixture(api, { deadline: () => deadline,
      current: async () => { if (expire) deadline = Date.now() - 1; return true } })
    expire = true
    // The brief operation has no downstream Git timeout to hide the missing
    // post-await authorization check. The original must refuse at active().
    if (api === implementation) await expect(f.call('brief')).rejects.toThrow('lost ownership')
    else expect(await f.call('brief')).toMatchObject({ brief: 'Host brief' })
  }
})


test('planner retirement drains an accepted operation and prevents later calls while preserving siblings', async () => {
  let waiting = false
  const entered = plannerBarrier(), pause = plannerBarrier()
  const f = await fixture(implementation, { current: async () => { if (waiting) { entered.release(); await pause.promise }; return true } })
  const sibling = await fixture()
  waiting = true
  const operation = f.call('write', { path: 'late.ts', content: 'must not write after retirement' })
  const rejection = operation.catch(error => error)
  await entered.promise
  const retirement = implementation.retirePlannerWork(f.request)
  expect(Bun.peek.status(retirement)).toBe('pending')
  await expect(f.call('brief')).rejects.toThrow('no current')
  expect(await sibling.call('brief')).toMatchObject({ brief: 'Host brief' })
  pause.release()
  expect((await rejection).message).toContain('expired or lost ownership'); await retirement
  await expect(access(join(f.cwd, 'late.ts'))).rejects.toThrow()
  await expect(implementation.bindPlannerWork({ session: {}, request: f.request, base: f.base, deadline: Date.now() + 10000,
    signal: new AbortController().signal, pr: null, brief: '', context: {}, current: () => true, validate: () => true })).rejects.toThrow('retired')
})

test('retirement includes constructing grants and refuses a late capability installation', async () => {
  const f = await fixture()
  const request = { ...f.request, step_id: 'constructing-step' }
  const entered = plannerBarrier(), pause = plannerBarrier()
  const binding = implementation.bindPlannerWork({ session: {}, request, base: f.base, deadline: Date.now() + 10000,
    signal: new AbortController().signal, pr: null, brief: '', context: {}, validate: () => true,
    current: async () => { entered.release(); await pause.promise; return true } })
  const rejection = binding.catch(error => error)
  await entered.promise
  const retirement = implementation.retirePlannerWork(request)
  expect(Bun.peek.status(retirement)).toBe('pending')
  pause.release(); expect((await rejection).message).toContain('expired or lost ownership'); await retirement
  expect(await f.call('brief')).toMatchObject({ brief: 'Host brief' })
})
