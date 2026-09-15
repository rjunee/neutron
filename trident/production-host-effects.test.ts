import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { spawnCapture, type EnvCapableHostRunner, type HostCommandResult } from './git-mode.ts'
import { createProductionHostEffects, workContextPath } from './production-host-effects.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import type { BuildSnapshot } from './build-run.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })
const bad = (): HostCommandResult => ({ ok: false, stdout: '', stderr: 'unreadable', exit_code: 128 })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'production-host-test-'))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
  const repo = join(dir, 'repo')
  const remote = join(dir, 'remote.git')
  const worktree = join(dir, 'work')
  async function command(argv: string[], cwd = dir) {
    const result = await spawnCapture(argv, cwd)
    if (!result.ok) throw new Error(result.stderr)
    return result.stdout
  }
  await command(['git', 'init', '--initial-branch=main', repo])
  await command(['git', '-C', repo, 'config', 'user.name', 'Build Fixture'])
  await command(['git', '-C', repo, 'config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(repo, 'code.txt'), 'before\n')
  await command(['git', '-C', repo, 'add', 'code.txt'])
  await command(['git', '-C', repo, 'commit', '-m', 'Initial fixture'])
  const base = await command(['git', '-C', repo, 'rev-parse', 'HEAD'])
  await command(['git', 'init', '--bare', remote])
  await command(['git', '-C', repo, 'remote', 'add', 'origin', remote])
  await command(['git', '-C', repo, 'push', 'origin', 'main'])
  await command(['git', '-C', repo, 'worktree', 'add', '-b', 'change', worktree])
  // A file-backed diff must retain the entire payload and its trailing newline.
  await writeFile(join(worktree, 'code.txt'), 'after\n' + 'payload\n'.repeat(1000))
  await command(['git', '-C', worktree, 'commit', '-am', 'Build fixture'])
  const tip = await command(['git', '-C', worktree, 'rev-parse', 'HEAD'])
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: 'build', project_slug: 'project', repo_path: repo, task: 'Build' })
  await store.update(row.id, { branch: 'change', worktree, base_sha: base, merge_mode: 'pr' })
  let pr: any = null
  let ci: unknown = [{ headSha: tip, status: 'completed', conclusion: 'success' }]
  const calls: string[][] = []
  let intercept: ((argv: string[]) => HostCommandResult | undefined | Promise<HostCommandResult | undefined>) | undefined
  const runHost: EnvCapableHostRunner = async (argv, cwd, env, timeout) => {
    calls.push([...argv])
    const override = await intercept?.([...argv])
    if (override) return override
    if (argv[0] === 'gh') {
      if (argv[1] === 'run') return ok(JSON.stringify(ci))
      if (argv[2] === 'list') return ok(JSON.stringify(pr ? [pr] : []))
      if (argv[2] === 'create') {
        pr = { number: 12, headRefOid: tip, state: 'OPEN', headRefName: 'change', baseRefName: 'main', isCrossRepository: false }
        return ok('created')
      }
      if (argv[2] === 'merge') { pr.state = 'MERGED'; return ok() }
      return ok(JSON.stringify(pr))
    }
    return spawnCapture(argv, cwd, env, timeout)
  }
  const options = { store, runId: row.id, projectSlug: 'project', repo, worktree, branch: 'change', baseBranch: 'main', runHost,
    ciWorkflow: 'ci.yml', publication: { title: 'Build', bodyFile: join(dir, 'body.md') } }
  const host = createProductionHostEffects(options)
  return { ...host, options, db, dir, repo, worktree, store, row, base, tip, calls, command,
    intercept(fn: typeof intercept) { intercept = fn }, setPr(value: any) { pr = value }, setCi(value: unknown) { ci = value } }
}
async function measured(f: Awaited<ReturnType<typeof fixture>>): Promise<BuildSnapshot> {
  const observation = await f.effects.measure()
  expect(observation.kind).toBe('known')
  if (observation.kind !== 'known') throw new Error(observation.detail)
  return observation.value
}

test('measurement reads complete committed diff and re-reads persisted pins', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  expect(snapshot.head).toBe(f.tip)
  expect(snapshot.diff.match(/\+payload/g)?.length).toBe(1000)
  expect(snapshot.diff.endsWith('\n')).toBe(true)
  expect(snapshot.pr).toBeNull()
  await f.store.update(f.row.id, { base_sha: null })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('launch base') })
})

for (const command of ['rev-parse', 'diff', 'list']) {
  test(`measurement refuses unreadable ${command}`, async () => {
    const f = await fixture()
    await measured(f)
    f.intercept(argv => argv.includes(command) ? bad() : undefined)
    expect(await f.effects.measure()).toMatchObject({ kind: 'unknown' })
  })
}

test('measurement refuses moved head and changed durable identity', async () => {
  const f = await fixture()
  await measured(f)
  let reads = 0
  f.intercept(argv => argv.includes('refs/heads/change^{commit}') && ++reads === 2 ? ok('b'.repeat(40)) : undefined)
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('moved') })
  f.intercept(undefined)
  await f.store.update(f.row.id, { branch: 'other' })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('identity') })
})

test('measurement refuses malformed PR, different checkout, and timeout with output', async () => {
  const f = await fixture()
  await measured(f)
  f.setPr({ number: 12, headRefOid: f.tip, state: 'OPEN' })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown' })
  f.setPr(null)
  f.intercept(argv => argv.includes('HEAD^{commit}') ? ok(f.base) : undefined)
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown' })
  f.intercept(argv => argv.includes('rev-parse') ? { ...ok(f.tip), timed_out: true } : undefined)
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown' })
})

test('CI observes success, absent, running, failed and unreadable without converting unknown to green', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'completed', headSha: f.tip, conclusion: 'success' })
  f.setCi([])
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'absent' })
  f.setCi([{ headSha: f.tip, status: 'queued', conclusion: '' }])
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'running', headSha: f.tip })
  f.setCi([{ headSha: f.tip, status: 'completed', conclusion: 'skipped' }])
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'completed', headSha: f.tip, conclusion: 'failure' })
  for (const value of [null, {}, [{ status: 'completed', conclusion: 'success' }], [{ headSha: f.tip, status: 'completed', conclusion: '' }]]) {
    f.setCi(value)
    expect(await f.observeCi(snapshot)).toMatchObject({ kind: 'unreadable' })
  }
  f.intercept(argv => argv[1] === 'run' ? bad() : undefined)
  expect(await f.observeCi(snapshot)).toMatchObject({ kind: 'unreadable' })
})

test('admission reads ownership from the durable row and rejects wrong run', async () => {
  const f = await fixture()
  const input = { run_id: f.row.id } as Parameters<typeof f.admission.observe>[0]
  expect(await f.admission.observe(input)).toMatchObject({ runId: f.row.id, prior: { base: f.base, head: null } })
  await f.store.update(f.row.id, { inner_checkpoint_head: f.tip })
  expect(await f.admission.observe(input)).toMatchObject({ prior: { head: f.tip } })
  expect(await f.admission.observe({ ...input, run_id: 'other' })).toBeNull()
})

test('publication pushes the pinned commit with a lease, witnesses PR, and persists its number', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  expect(await f.publishChecked(snapshot)).toEqual({ kind: 'allow' })
  expect(f.store.get(f.row.id)?.pr).toBe(12)
  expect(f.calls.find(argv => argv.includes('push'))).toContain(`${f.tip}:refs/heads/change`)
  expect(f.calls.find(argv => argv.includes('push'))).toContain('--force-with-lease=refs/heads/change:')
  expect(await f.command(['git', '-C', f.repo, 'ls-remote', '--heads', 'origin', 'change'])).toContain(f.tip)
  expect((await measured(f)).pr).toEqual({ number: 12, head: f.tip, state: 'OPEN' })
})

test('publication refuses changed snapshot without push', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  expect(await f.publishChecked({ ...snapshot, head: f.base })).toMatchObject({ kind: 'blocked' })
  expect(f.calls.some(argv => argv.includes('push'))).toBe(false)
})

for (const stage of ['lease', 'push', 'witness', 'create', 'pr-witness']) {
  test(`publication does not allow missing ${stage}`, async () => {
    const f = await fixture()
    const snapshot = await measured(f)
    let remoteReads = 0
    let created = false
    f.intercept(argv => {
      if (argv.includes('ls-remote')) {
        remoteReads++
        if (stage === 'lease' && remoteReads === 2) return bad()
        if (stage === 'witness' && remoteReads === 3) return ok(`${f.base}\trefs/heads/change`)
      }
      if (stage === 'push' && argv.includes('push')) return bad()
      if (argv[0] === 'gh' && argv[2] === 'create') {
        created = true
        if (stage === 'create') return bad()
      }
      if (stage === 'pr-witness' && created && argv[2] === 'list') return ok('[]')
    })
    expect(await f.publishChecked(snapshot)).toMatchObject({ kind: 'unknown' })
    expect(f.store.get(f.row.id)?.pr).toBeNull()
  })
}

test('merge pins reviewed head and requires independent merged witness', async () => {
  const f = await fixture()
  expect(await f.publishChecked(await measured(f))).toEqual({ kind: 'allow' })
  const snapshot = await measured(f)
  expect(await f.mergeChecked(snapshot)).toEqual({ kind: 'allow' })
  const argv = f.calls.find(argv => argv[0] === 'gh' && argv[2] === 'merge')!
  expect(argv).toEqual(['gh', 'pr', 'merge', '12', '--squash', '--match-head-commit', f.tip])
  expect((await measured(f)).pr?.state).toBe('MERGED')
})

for (const failure of ['command', 'witness']) {
  test(`merge refuses missing ${failure}`, async () => {
    const f = await fixture()
    expect(await f.publishChecked(await measured(f))).toEqual({ kind: 'allow' })
    const snapshot = await measured(f)
    f.intercept(argv => argv[0] === 'gh' && argv[2] === 'merge' ? failure === 'command' ? bad() : ok() : undefined)
    expect(await f.mergeChecked(snapshot)).toMatchObject({ kind: 'unknown' })
  })
}

test('local merge explicitly remains unknown and never runs gh merge', async () => {
  const f = await fixture()
  await f.store.update(f.row.id, { merge_mode: 'local' })
  const snapshot = await measured(f)
  expect(await f.mergeChecked(snapshot)).toEqual({ kind: 'unknown', detail: 'Atomic local merge effect is not connected' })
  expect(f.calls.some(argv => argv[0] === 'gh')).toBe(false)
})

test('prepare persists host context and stage evidence; mismatched request cannot prepare', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  const path = join(f.dir, 'brief')
  const text = `Build. Read ${workContextPath(path)}`
  await writeFile(path, text)
  const request: BoundedWorkRequest = { run_id: f.row.id, step_id: 'build:0', role: 'build', model_id: 'test', effort: null,
    cwd: f.worktree, writable: true, network: false, tools: 'edit-and-run', brief: { path, integrity: briefIntegrity(text) },
    result: { schema: 'build', path: join(f.dir, 'result') }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
  const context = { snapshot, previous: { plan: 'Implement' }, findings: ['Fix the named failure'] }
  await f.effects.prepareWork(request, context)
  expect(JSON.parse(await readFile(workContextPath(path), 'utf8'))).toEqual({ request, ...context })
  expect(f.db.prepare<{ stage: string }, []>('SELECT stage FROM code_trident_stage_events').all()).toContainEqual({ stage: 'build-work-prepared' })
  await expect(f.effects.prepareWork({ ...request, run_id: 'other' }, context)).rejects.toThrow('does not belong')
  await writeFile(path, 'tampered')
  await expect(f.effects.prepareWork(request, context)).rejects.toThrow('verified host context')
})

test('measurement refuses changing store pins, ambiguous PRs, and a local persisted PR', async () => {
  const f = await fixture()
  await measured(f)
  f.intercept(async argv => {
    if (argv[0] === 'gh') {
      await f.store.update(f.row.id, { base_sha: f.tip })
      return ok('[]')
    }
  })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('pins changed') })
  f.intercept(argv => argv[0] === 'gh' ? ok('[{},{}]') : undefined)
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('ambiguous') })
  f.intercept(undefined)
  await f.store.update(f.row.id, { merge_mode: 'local', pr: 12 })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('persisted PR') })
})

test('measurement rejects failed commands even when they contain usable output', async () => {
  const f = await fixture()
  await measured(f)
  f.intercept(argv => argv.includes('refs/heads/change^{commit}') ? { ...ok(f.tip), ok: false, exit_code: 1 } : undefined)
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('branch head') })
  f.intercept(argv => argv[0] === 'gh' ? { ...ok('[]'), ok: false, exit_code: 1 } : undefined)
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('PR observation') })
  f.intercept(async argv => {
    if (argv.includes('diff')) {
      const result = await spawnCapture(argv, f.repo)
      expect(result.ok).toBe(true)
      return { ...result, ok: false, exit_code: 1 }
    }
  })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('diff is unreadable') })
})

test('publication refuses malformed lease, missing store write and local mode', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  let reads = 0
  f.intercept(argv => argv.includes('ls-remote') && ++reads === 2 ? ok('garbled') : undefined)
  expect(await f.publishChecked(snapshot)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('lease is malformed') })
  f.intercept(undefined)
  const update = f.store.update.bind(f.store)
  f.store.update = async () => null
  expect(await f.publishChecked(snapshot)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('persisted') })
  f.store.update = update
  await update(f.row.id, { merge_mode: 'local' })
  expect(await f.publishChecked(snapshot)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('PR mode') })
})

test('effect adapters reject uncertainty and changed snapshots instead of succeeding', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  await expect(f.effects.publish({ ...snapshot, head: f.base })).rejects.toThrow('changed')
  await expect(f.effects.merge({ ...snapshot, head: f.base })).rejects.toThrow('changed')
  f.intercept(argv => argv.includes('diff') ? bad() : undefined)
  expect(await f.publishChecked(snapshot)).toMatchObject({ kind: 'unknown' })
})

test('publication and merge preserve readiness refusals', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  f.intercept(argv => argv.includes('ls-remote') ? bad() : undefined)
  expect(await f.publishChecked(snapshot)).toMatchObject({ kind: 'unknown' })
  expect(f.calls.some(argv => argv.includes('push'))).toBe(false)
  f.intercept(undefined)
  expect(await f.publishChecked(snapshot)).toEqual({ kind: 'allow' })
  const published = await measured(f)
  f.intercept(argv => argv.includes('fetch') ? bad() : undefined)
  expect(await f.mergeChecked(published)).toMatchObject({ kind: 'unknown' })
  expect(f.calls.some(argv => argv[0] === 'gh' && argv[2] === 'merge')).toBe(false)
})

test('CI refuses absent workflow even with a successful response', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  f.options.ciWorkflow = ''
  expect(await f.observeCi(snapshot)).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('workflow') })
})

test('prepare requires a context reference and an unchanged host snapshot', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  const path = join(f.dir, 'brief')
  const request: BoundedWorkRequest = { run_id: f.row.id, step_id: 'build:0', role: 'build', model_id: 'test', effort: null,
    cwd: f.worktree, writable: true, network: false, tools: 'edit-and-run', brief: { path, integrity: briefIntegrity('Build') },
    result: { schema: 'build', path: join(f.dir, 'result') }, thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false }
  await writeFile(path, 'Build')
  await expect(f.effects.prepareWork(request, { snapshot, previous: null, findings: [] })).rejects.toThrow('context reference')
  const text = `Read ${workContextPath(path)}`
  await writeFile(path, text)
  await expect(f.effects.prepareWork({ ...request, brief: { path, integrity: briefIntegrity(text) } },
    { snapshot: { ...snapshot, head: f.base }, previous: null, findings: [] })).rejects.toThrow('current snapshot')
})

test('terminal run cannot be measured or dispatch a new turn', async () => {
  const f = await fixture()
  await measured(f)
  await f.store.update(f.row.id, { phase: 'stopped' })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('terminal') })
})

test('PR and CI OIDs must be strings, not coercible JSON values', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  f.setPr({ number: 12, headRefOid: [f.tip], state: 'OPEN', headRefName: 'change', baseRefName: 'main', isCrossRepository: false })
  expect(await f.effects.measure()).toMatchObject({ kind: 'unknown' })
  f.setCi([{ headSha: [f.tip], status: 'completed', conclusion: 'success' }])
  expect(await f.observeCi(snapshot)).toMatchObject({ kind: 'unreadable' })
})
