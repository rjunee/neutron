import { reviewArtifact } from './gates/review-artifact.ts'
import { fixLineage } from './gates/fix-lineage.ts'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { fakeRunner, type BoundedWorkOutcome, type BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { spawnCapture, type EnvCapableHostRunner, type HostCommandResult } from './git-mode.ts'
import { createProductionHostEffects, productionCiSource, workContextPath } from './production-host-effects.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { buildRun, type BuildRunDeps, type BuildRunInput, type BuildSnapshot } from './build-run.ts'
import { readProjectRepos, resolveProjectRepo } from './project-repos.ts'
import { ciReadinessForHead } from './ci-readiness.ts'

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
  await writeFile(join(repo, 'code.txt'), 'before\n' + 'stable\n'.repeat(20))
  await command(['git', '-C', repo, 'add', 'code.txt'])
  await command(['git', '-C', repo, 'commit', '-m', 'Initial fixture'])
  const base = await command(['git', '-C', repo, 'rev-parse', 'HEAD'])
  await command(['git', 'init', '--bare', remote])
  await command(['git', '-C', repo, 'remote', 'add', 'origin', remote])
  await command(['git', '-C', repo, 'push', 'origin', 'main'])
  await command(['git', '-C', repo, 'worktree', 'add', '-b', 'change', worktree])
  // A file-backed diff must retain the entire payload and its trailing newline.
  await writeFile(join(worktree, 'code.txt'), 'after\n' + 'stable\n'.repeat(20) + 'payload\n'.repeat(1000))
  await command(['git', '-C', worktree, 'commit', '-am', 'Build fixture'])
  const tip = await command(['git', '-C', worktree, 'rev-parse', 'HEAD'])
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: 'build', project_slug: 'project', repo_path: repo, task: 'Build' })
  await store.update(row.id, { branch: 'change', worktree, base_sha: base, merge_mode: 'pr' })
  let pr: any = null
  let ciConfig: any = { kind: 'resolved', required: ['test'], appBound: [], produced: ['test'] }
  let ciReadiness: any = { headSha: tip, mergeable: 'MERGEABLE', rows: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  let now = 0
  const calls: string[][] = []
  let intercept: ((argv: string[]) => HostCommandResult | undefined | Promise<HostCommandResult | undefined>) | undefined
  const runHost: EnvCapableHostRunner = async (argv, cwd, env, timeout) => {
    calls.push([...argv])
    const override = await intercept?.([...argv])
    if (override) return override
    if (argv[0] === 'gh') {
      if (argv[2] === 'list') return ok(JSON.stringify(pr ? [pr] : []))
      if (argv[2] === 'create') {
        pr = { number: 12, headRefOid: await command(['git', '-C', repo, 'rev-parse', 'refs/heads/change']), state: 'OPEN', headRefName: 'change', baseRefName: 'main', isCrossRepository: false }
        return ok('created')
      }
      if (argv[2] === 'merge') { pr.state = 'MERGED'; return ok() }
      return ok(JSON.stringify(pr))
    }
    const result = await spawnCapture(argv, cwd, env, timeout)
    if (result.ok && argv.includes('push') && pr) {
      pr.headRefOid = await command(['git', '--git-dir', remote, 'rev-parse', 'refs/heads/change'])
    }
    return result
  }
  const options = { store, runId: row.id, projectSlug: 'project', repo, worktree, branch: 'change', baseBranch: 'main', runHost,
    ciWorkflow: 'ci.yml', ciNow: () => now,
    ciSource: { async required() { return structuredClone(ciConfig) }, async readiness() { return structuredClone(ciReadiness) } },
    publication: { title: 'Build', bodyFile: join(dir, 'body.md') } }
  const host = createProductionHostEffects(options)
  return { ...host, options, db, dir, repo, worktree, store, row, base, tip, calls, command,
    intercept(fn: typeof intercept) { intercept = fn }, setPr(value: any) { pr = value },
    setCiConfig(value: unknown) { ciConfig = value }, setCiReadiness(value: unknown) { ciReadiness = value }, advance(ms: number) { now += ms } }
}
async function measured(f: Awaited<ReturnType<typeof fixture>>): Promise<BuildSnapshot> {
  const observation = await f.effects.measure()
  expect(observation.kind).toBe('known')
  if (observation.kind !== 'known') throw new Error(observation.detail)
  return observation.value
}

test('G126/G127 production cleanup delegates mode and classifies complete script evidence', async () => {
  const f = await fixture()
  f.intercept(argv => argv[1]?.endsWith('worktree-cleanup.sh')
    ? { ok: false, stdout: 'PRESERVED worktree /build reason=dirty\nRESULT preserved=2 removed=0\n', stderr: '', exit_code: 3 }
    : undefined)
  expect(await f.cleanup()).toMatchObject({ kind: 'preserved', detail: expect.stringContaining('PRESERVED worktree') })
  expect(f.calls.at(-1)).toEqual(['bash', expect.stringContaining('worktree-cleanup.sh'), f.repo, 'change', 'delete-branch'])

  f.intercept(argv => argv[1]?.endsWith('worktree-cleanup.sh') ? ok('RESULT preserved=0 removed=1\n') : undefined)
  expect(await f.cleanup()).toEqual({ kind: 'cleaned', detail: 'RESULT preserved=0 removed=1\n' })

  for (const result of [
    ok(''),
    { ok: true, stdout: 'RESULT preserved=1 removed=0\n', stderr: '', exit_code: 0 },
    { ok: false, stdout: 'RESULT preserved=0 removed=0\n', stderr: '', exit_code: 3 },
    { ok: false, stdout: '', stderr: '', exit_code: 2 },
    { ...bad(), timed_out: true },
  ]) {
    f.intercept(argv => argv[1]?.endsWith('worktree-cleanup.sh') ? result : undefined)
    expect(await f.cleanup()).toMatchObject({ kind: 'failed' })
  }

  await f.store.update(f.row.id, { merge_mode: 'local' })
  const local = createProductionHostEffects(f.options)
  f.intercept(argv => argv[1]?.endsWith('worktree-cleanup.sh') ? ok('RESULT preserved=0 removed=0\n') : undefined)
  expect(await local.cleanup()).toMatchObject({ kind: 'cleaned' })
  expect(f.calls.at(-1)?.at(-1)).toBe('keep-branch')
})

test('G045 ruleset requirements survive a classic-protection 404', async () => {
  const source = productionCiSource(async argv => {
    const path = argv[2]!
    if (path.includes('/protection/')) return { ...bad(), exit_code: 1, stderr: 'HTTP 404 Not Found' }
    if (path.includes('/rules/')) return ok(JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test', integration_id: 7 }] } }]))
    if (path.endsWith('/branches/main')) return ok(JSON.stringify({ protected: true, protection: {} }))
    if (path.includes('/check-runs')) return ok(JSON.stringify({ total_count: 1, check_runs: [{ name: 'test' }] }))
    return ok(JSON.stringify({ total_count: 0, statuses: [] }))
  }, '.')
  expect(await source.required('main')).toEqual({ kind: 'resolved', required: ['test'], appBound: ['test'], produced: ['test'] })
})

test('G045 unresolved protection 404 is unknown without independent branch evidence', async () => {
  const source = productionCiSource(async argv => {
    const path = argv[2]!
    if (path.includes('/rules/')) return { ...bad(), exit_code: 1, stderr: 'HTTP 404 Not Found' }
    if (path.endsWith('/branches/main')) return bad()
    if (path.includes('/check-runs')) return ok(JSON.stringify({ total_count: 0, check_runs: [] }))
    if (path.includes('/status?')) return ok(JSON.stringify({ total_count: 0, statuses: [] }))
    return { ...bad(), exit_code: 1, stderr: 'HTTP 404 Not Found' }
  }, '.')
  expect(await source.required('main')).toMatchObject({ kind: 'unknown' })
})

test('G046 truncated producer lists are unreadable evidence', async () => {
  const source = productionCiSource(async argv => {
    const path = argv[2]!
    if (path.includes('/protection/')) return ok(JSON.stringify({ contexts: ['required'], checks: [] }))
    if (path.includes('/rules/')) return ok('[]')
    if (path.endsWith('/branches/main')) return ok(JSON.stringify({ protected: true }))
    if (path.includes('/check-runs')) return ok(JSON.stringify({ total_count: 2, check_runs: [{ name: 'other' }] }))
    return ok(JSON.stringify({ total_count: 0, statuses: [] }))
  }, '.')
  expect(await source.required('main')).toEqual({ kind: 'resolved', required: ['required'], appBound: [], produced: null })
})

test('measurement reads complete committed diff and re-reads persisted pins', async () => {
  const f = await fixture()
  const snapshot = await measured(f)
  expect(snapshot.head).toBe(f.tip)
  expect(snapshot.diff.match(/\+payload/g)?.length).toBe(1000)
  expect(snapshot.diff.endsWith('\n')).toBe(true)
  expect(snapshot.pr).toBeNull()
  expect(f.calls.some(argv => argv.includes(`${f.base}...${f.tip}`))).toBe(true)
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

test('CI combines requirements and rollup without converting unknown to green', async () => {
  const f = await fixture()
  f.setPr({ number: 12, headRefOid: f.tip, state: 'OPEN', headRefName: 'change', baseRefName: 'main', isCrossRepository: false })
  const snapshot = await measured(f)
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'completed', headSha: f.tip, conclusion: 'success' })
  f.setCiReadiness({ headSha: f.tip, mergeable: 'MERGEABLE', rows: [] })
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'absent' })
  f.setCiReadiness({ headSha: f.tip, mergeable: 'MERGEABLE', rows: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] })
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'running', headSha: f.tip })
  f.setCiReadiness({ headSha: f.tip, mergeable: 'MERGEABLE', rows: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] })
  expect(await f.observeCi(snapshot)).toEqual({ kind: 'completed', headSha: f.tip, conclusion: 'failure' })
  f.setCiConfig({ kind: 'unknown', reason: 'protection unavailable' })
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
  let attemptObserved = false
  f.intercept(argv => {
    if (argv[0] === 'gh' && argv[2] === 'merge') {
      const events = f.db.prepare<{ meta: string }, []>(
        "SELECT meta FROM code_trident_stage_events WHERE stage = 'build-remote-merge-attempt'",
      ).all()
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.meta)).toEqual({
        pr: 12, head: f.tip, baseBranch: 'main', basePrecondition: 'not-enforced',
        detail: 'Remote base may move between readiness assessment and merge; only the head is pinned',
      })
      attemptObserved = true
    }
    return undefined
  })
  expect(await f.mergeChecked(snapshot)).toEqual({ kind: 'allow' })
  expect(attemptObserved).toBe(true)
  const argv = f.calls.find(argv => argv[0] === 'gh' && argv[2] === 'merge')!
  expect(argv).toEqual(['gh', 'pr', 'merge', '12', '--squash', '--match-head-commit', f.tip])
  expect((await measured(f)).pr?.state).toBe('MERGED')
})

test('merge refuses when remote base-risk evidence cannot be persisted', async () => {
  const f = await fixture()
  expect(await f.publishChecked(await measured(f))).toEqual({ kind: 'allow' })
  const snapshot = await measured(f)
  let attempted = false
  f.store.recordStageEvent = async (_runId, stage) => {
    expect(stage).toBe('build-remote-merge-attempt')
    attempted = true
    throw new Error('Storage unavailable')
  }
  expect(await f.mergeChecked(snapshot)).toEqual({
    kind: 'unknown', detail: 'Remote merge base-risk evidence could not be persisted: Error: Storage unavailable',
  })
  expect(attempted).toBe(true)
  expect(f.calls.filter(argv => argv[0] === 'gh' && ['create', 'merge'].includes(argv[2]!))
    .map(argv => argv[2])).toEqual(['create'])
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

test('local merge preserves the reviewed branch and updates the checked-out base', async () => {
  const f = await fixture()
  await f.store.update(f.row.id, { merge_mode: 'local' })
  const snapshot = await measured(f)
  expect(await f.mergeChecked(snapshot)).toEqual({ kind: 'allow' })
  expect(await f.command(['git', '-C', f.repo, 'rev-parse', 'change'])).toBe(f.tip)
  expect(await f.command(['git', '-C', f.repo, 'status', '--porcelain'])).toBe('')
  expect(await readFile(join(f.repo, 'code.txt'), 'utf8')).toBe(await readFile(join(f.worktree, 'code.txt'), 'utf8'))
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

test('undeclared repo workflow is unreadable before acquisition, with valid PR and green CI available', async () => {
  const f = await fixture()
  f.setPr({ number: 12, headRefOid: f.tip, state: 'OPEN', headRefName: 'change', baseRefName: 'main', isCrossRepository: false })
  const snapshot = await measured(f)
  expect(snapshot.pr?.number).toBe(12)
  let acquisitions = 0
  const declared = (workflow: string | undefined) => ({
    repos: [{ name: 'project', path: 'code', remote: null, ...(workflow === undefined ? {} : { ciWorkflow: workflow }) }],
    default: 'project',
  })
  const observe = async () => {
    const repo = resolveProjectRepo(readProjectRepos(f.dir, 'project'))
    return createProductionHostEffects({ ...f.options, ciWorkflow: repo.ciWorkflow,
      ciSource: { ...f.options.ciSource, async required() { acquisitions++; return f.options.ciSource.required() } },
    }).observeCi(snapshot)
  }
  await writeFile(join(f.dir, 'project-repos.json'), JSON.stringify(declared(undefined)))
  expect(await observe()).toMatchObject({ kind: 'unreadable', reason: expect.stringContaining('project-repos.json') })
  expect(ciReadinessForHead(snapshot.head, await observe()).kind).toBe('cannot-read')
  expect(acquisitions).toBe(0)
  await writeFile(join(f.dir, 'project-repos.json'), JSON.stringify(declared('ci.yml')))
  expect(ciReadinessForHead(snapshot.head, await observe()).kind).toBe('green')
  expect(acquisitions).toBe(1)
  f.setCiReadiness({ headSha: snapshot.head, mergeable: 'MERGEABLE', rows: [] })
  expect(ciReadinessForHead(snapshot.head, await observe()).kind).toBe('no-run')
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
  f.setCiReadiness({ headSha: [f.tip], mergeable: 'MERGEABLE', rows: [] })
  expect(await f.observeCi(snapshot)).toMatchObject({ kind: 'unreadable' })
})

for (const condition of ['dirty-worktree', 'overlap', 'base-race', 'dirty-base'] as const) {
  test(`local effect refuses ${condition}`, async () => {
    const f = await fixture()
    await f.store.update(f.row.id, { merge_mode: 'local' })
    const snapshot = await measured(f)
    if (condition === 'dirty-worktree') await writeFile(join(f.worktree, 'untracked'), 'preserve')
    if (condition === 'dirty-base') await writeFile(join(f.repo, 'code.txt'), 'preserve')
    if (condition === 'overlap') {
      await writeFile(join(f.repo, 'code.txt'), 'before\n' + 'stable\n'.repeat(10) + 'base changed\n' + 'stable\n'.repeat(9))
      await f.command(['git', '-C', f.repo, 'commit', '-am', 'Move base'])
    }
    const before = await f.command(['git', '-C', f.repo, 'rev-parse', 'main'])
    if (condition === 'base-race') f.intercept(async argv => {
      if (argv.includes('push')) {
        await writeFile(join(f.repo, 'other.txt'), 'concurrent base')
        await f.command(['git', '-C', f.repo, 'add', 'other.txt'])
        await f.command(['git', '-C', f.repo, 'commit', '-m', 'Concurrent base'])
      }
      return undefined
    })
    expect((await f.mergeChecked(snapshot)).kind).not.toBe('allow')
    if (condition !== 'base-race') expect(await f.command(['git', '-C', f.repo, 'rev-parse', 'main'])).toBe(before)
    expect(await f.command(['git', '-C', f.repo, 'rev-parse', 'change'])).toBe(f.tip)
  })
}

test('local-mode driver reaches merged through the real production effect', async () => {
  const f = await fixture()
  await f.store.update(f.row.id, { merge_mode: 'local' })
  const snapshot = await measured(f)
  const outcomes = new Map<string, BoundedWorkOutcome>()
  for (const [role, round] of [['plan', 0], ['build', 0], ['review', 1]] as const) {
    outcomes.set(`${f.row.id}:${role}:${round}`, { kind: 'completed', result: { ...snapshot, payload: {} },
      usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null })
  }
  const path = join(f.dir, 'driver-brief')
  await writeFile(path, workContextPath(path))
  const request: BuildRunInput['workers']['build']['request'] = { model_id: 'test', effort: null, cwd: f.worktree, writable: true, network: false,
    tools: 'edit-and-run', brief: { path, integrity: briefIntegrity(workContextPath(path)) },
    result: { schema: 'test', path: join(f.dir, 'result') }, thread: null, budget: { wall_ms: 1000 } }
  const runner = fakeRunner('pi', { outcomes })
  const input: BuildRunInput = { run_id: f.row.id, mode: 'pr', start: 'fresh', merge_mode: 'local', repl_provider: 'pi',
    workers: { plan: { runner, request }, build: { runner, request }, review: { runner, request }, fix: { runner, request } } }
  // Policy seams are scripted here; git measurement, preparation, landing and
  // the final ancestry witness use the real local repository.
  // Compose the same readback gate as createBuildHost over production files.
  const deps: BuildRunDeps = { reviewArtifact, ...f.effects,
    // The driver requires a round cap from the run row and refuses without one
    // (`trident/build-run.ts` — 'Review round cap source is missing'). Production
    // gets it from `createBuildHost`; these fixtures build deps by hand, so they
    // supply the same row value rather than a number of their own.
    readReviewCap: async () => ({ kind: 'known', max_rounds: f.row.max_rounds }),
    // G023 refuses a build or fix whose branch assignment the host never made.
    // `createBuildHost` derives it from the run row; these hand-built deps use
    // the same branch the fixture's row carries.
    assignedBranch: 'change',
    // Phase usage is a required write, not an optional one: a run that cannot
    // record it must stop rather than continue unmeasured. These fixtures keep
    // the write observable and silent.
    recordPhaseUsage: async () => {},
    // Match createBuildHost: prove each fix with git against the host-held pin.
    checkFixLineage: (produced, pin) => fixLineage(spawnCapture, f.repo, 'change', pin, produced.head),
    // Review readiness and suite evidence are policy seams too, and the driver now
    // refuses without them. `createBuildHost` composes both in production; these
    // fixtures script them so the assertions stay about the persistence effects.
    reviewReadiness: async () => ({ kind: 'allow' as const }),
    reviewSuite: async () => ({ kind: 'known' as const, findings: [] }),
    reviewCi: async () => ({ kind: 'known' as const, findings: [] }),
    admissionGate: async () => ({ kind: 'allow' }),
    runLeakGatePreflight: async () => ({ status: 'clean', head: f.tip, note: '', findings: [], skipped_rules: [], attempts: 0 }),
    assessMergeDiff: () => ({ allow: true, measured_bytes: snapshot.diff.length }),
    reviewGate: async (_payload, _snapshot, _round, _replans, record) => { record?.({ findings: [], blockingCount: 0 }); return { kind: 'approve' } },
    publishGate: async () => ({ kind: 'allow' }), mergeGate: async () => ({ kind: 'allow' }),
    confirmLocalMerge: async () => {
      await f.command(['git', '-C', f.repo, 'merge-base', '--is-ancestor', f.tip, 'main'])
      return { kind: 'allow' }
    },
  }
  expect(await buildRun(input, deps, new AbortController().signal)).toMatchObject({ kind: 'merged' })
})

for (const failure of ['during-assessment', 'push-failure', 'push-timeout'] as const) {
  test(`local effect refuses ${failure}`, async () => {
    const f = await fixture()
    await f.store.update(f.row.id, { merge_mode: 'local' })
    const snapshot = await measured(f)
    let changed = false
    f.intercept(async argv => {
      if (failure === 'push-failure' && argv.includes('push')) return bad()
      if (failure === 'push-timeout' && argv.includes('push')) return { ...ok(), timed_out: true }
      if (failure === 'during-assessment' && !changed && argv.includes('--show-toplevel')) {
        changed = true
        await writeFile(join(f.repo, 'other.txt'), 'new base')
        await f.command(['git', '-C', f.repo, 'add', 'other.txt'])
        await f.command(['git', '-C', f.repo, 'commit', '-m', 'Move during assessment'])
      }
      return undefined
    })
    expect((await f.mergeChecked(snapshot)).kind).toBe('unknown')
  })
}

async function resumeFixture(round = 3, replansUsed = 1) {
  const f = await fixture()
  const snapshot = await measured(f)
  await f.modes.saveCheckpoint!({ head: f.tip, stage: 'rejected', round, replansUsed,
    previousFindings: ['older issue', 'another issue'], previousBlockingCount: 2,
    findings: [{ kind: 'code', actionable: true, text: 'new issue' }] })
  const path = join(f.dir, 'resume-brief')
  await writeFile(path, workContextPath(path))
  const request: BuildRunInput['workers']['build']['request'] = { model_id: 'test', effort: null,
    cwd: f.worktree, writable: true, network: false, tools: 'edit-and-run',
    brief: { path, integrity: briefIntegrity(workContextPath(path)) }, result: { schema: 'test', path: join(f.dir, 'result') },
    thread: null, budget: { wall_ms: 1000 } }
  // Every role reports what the repository ACTUALLY holds at the moment it answers,
  // because the fixer below commits for real and a trailer pinned to the fixture's
  // opening snapshot would disagree with the host's measurement one round later.
  // The counters stay wrong on purpose: the host's are the ones that must win, and
  // a resumed run has a re-plan already spent, so G075 needs a revised spec.
  const runner = fakeRunner('pi')
  runner.run = async request => {
    runner.calls.push(request)
    if (request.role === 'fix') {
      await f.command(['git', '-C', f.worktree, 'commit', '--allow-empty', '-m', `fix ${request.step_id}`])
    }
    const now = await measured(f)
    const payload = request.role === 'plan'
      ? { executionSpec: 'revised execution spec', round: 0, replansUsed: 0 }
      : { round: 0, replansUsed: 0 }
    return { kind: 'completed', result: { ...now, payload, round: 0, replansUsed: 0 },
      usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null }
  }
  const restarted = createProductionHostEffects(f.options)
  const rounds: number[][] = []
  // Compose the same readback gate as createBuildHost over production files.
  const deps: BuildRunDeps = { reviewArtifact, ...restarted.effects, modes: restarted.modes,
    // The driver requires a round cap from the run row and refuses without one
    // (`trident/build-run.ts` — 'Review round cap source is missing'). Production
    // gets it from `createBuildHost`; these fixtures build deps by hand, so they
    // supply the same row value rather than a number of their own.
    readReviewCap: async () => ({ kind: 'known', max_rounds: f.row.max_rounds }),
    // G023 refuses a build or fix whose branch assignment the host never made.
    // `createBuildHost` derives it from the run row; these hand-built deps use
    // the same branch the fixture's row carries.
    assignedBranch: 'change',
    // Phase usage is a required write, not an optional one: a run that cannot
    // record it must stop rather than continue unmeasured. These fixtures keep
    // the write observable and silent.
    recordPhaseUsage: async () => {},
    // Match createBuildHost: prove each fix with git against the host-held pin.
    checkFixLineage: (produced, pin) => fixLineage(spawnCapture, f.repo, 'change', pin, produced.head),
    // Review readiness and suite evidence are policy seams too, and the driver now
    // refuses without them. `createBuildHost` composes both in production; these
    // fixtures script them so the assertions stay about the persistence effects.
    reviewReadiness: async () => ({ kind: 'allow' as const }),
    reviewSuite: async () => ({ kind: 'known' as const, findings: [] }),
    reviewCi: async () => ({ kind: 'known' as const, findings: [] }),
    admissionGate: async () => ({ kind: 'allow' }),
    reviewGate: async (_payload, _snapshot, round, replans, record) => { rounds.push([round, replans!]); record?.({ findings: [], blockingCount: 0 }); return { kind: 'approve' } },
    // The preflight reports the head it scanned, and the driver refuses to publish a
    // revision the scan did not see. The fixer commits for real, so pinning this to
    // the fixture's opening tip would incorrectly report publication drift.
    runLeakGatePreflight: async reviewed => ({ status: 'clean', head: reviewed.head, note: '', findings: [], skipped_rules: [], attempts: 0 }),
    assessMergeDiff: () => ({ allow: true, measured_bytes: snapshot.diff.length }),
    publishGate: async () => ({ kind: 'allow' }),
    mergeGate: async () => ({ kind: 'blocked', on: 'fixture stops before merge' }),
  }
  const input: BuildRunInput = { run_id: f.row.id, mode: 'pr', start: 'resume', repl_provider: 'pi',
    workers: { plan: { runner, request }, build: { runner, request }, review: { runner, request }, fix: { runner, request } } }
  return { ...f, restarted, runner, rounds, deps, input, run: () => buildRun(input, deps, new AbortController().signal) }
}

test('production resume reloads rejected state, inherits rounds, and ignores worker counters', async () => {
  const f = await resumeFixture()
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'fixture stops before merge' })
  expect(f.runner.calls.map(c => c.step_id)).toEqual([`${f.row.id}:fix:3`, `${f.row.id}:review:4`])
  expect(f.rounds).toEqual([[4, 1]])
  // The fix commits for real, so the approved head is the one the repository now
  // holds, not the tip the fixture opened on — and it must not be that tip.
  const landed = (await measured(f)).head
  expect(landed).not.toBe(f.tip)
  expect(await createProductionHostEffects(f.options).modes.loadResume()).toMatchObject({
    stage: 'approved', round: 4, replansUsed: 1, head: landed,
  })
})

test('production resume refuses exhausted fix budget', async () => {
  // The ceiling is the run row's cap, which the store defaults to 10
  // (`trident/store.ts:842`); it used to be a 5 hardcoded in the driver.
  const f = await resumeFixture(10, 0)
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('round ceiling') })
  expect(f.runner.calls).toHaveLength(0)
})

test('production pending worker survives reconstruction without redispatch', async () => {
  const f = await resumeFixture()
  const pendingRunner = fakeRunner('pi', { outcomes: new Map([[`${f.row.id}:fix:3`, { kind: 'unknown', detail: 'still running' }]]) })
  f.input.workers.fix.runner = pendingRunner
  expect(await f.run()).toMatchObject({ kind: 'unknown', step_id: `${f.row.id}:fix:3` })
  f.deps.modes = createProductionHostEffects(f.options).modes
  expect(await f.run()).toMatchObject({ kind: 'unknown', step_id: `${f.row.id}:fix:3`, detail: expect.stringContaining('existing worker') })
  expect(pendingRunner.calls).toHaveLength(1)
  expect(f.runner.calls).toHaveLength(0)
  expect(await f.deps.modes.loadResume()).toMatchObject({ round: 3, replansUsed: 1, pending: { phase: 'fix', step_id: `${f.row.id}:fix:3` } })
})

test('production checkpoint rejects stale writers and missing resume state', async () => {
  const f = await fixture()
  await expect(f.modes.loadResume()).rejects.toThrow('missing')
  const checkpoint = { head: f.tip, stage: 'built' as const, round: 2, replansUsed: 1, findings: [], previousFindings: [] }
  await f.modes.saveCheckpoint!(checkpoint)
  const first = createProductionHostEffects(f.options)
  const stale = createProductionHostEffects(f.options)
  await first.modes.loadResume(); await stale.modes.loadResume()
  await first.modes.saveCheckpoint!({ ...checkpoint, round: 3 })
  await expect(stale.modes.saveCheckpoint!({ ...checkpoint, round: 4 })).rejects.toThrow('concurrently')
  expect(await createProductionHostEffects(f.options).modes.loadResume()).toMatchObject({ round: 3, replansUsed: 1 })
})

test('production Ralph handoff consumes once and probes the pinned committed plan', async () => {
  const f = await fixture()
  // This fixture enables the already-created run for the additive mode host.
  await f.db.run('UPDATE code_trident_runs SET ralph = 1 WHERE id = ?', [f.row.id])
  await writeFile(join(f.worktree, 'IMPLEMENTATION_PLAN.md'), '- [x] first\n- [ ] second\n')
  await f.command(['git', '-C', f.worktree, 'add', 'IMPLEMENTATION_PLAN.md'])
  await f.command(['git', '-C', f.worktree, 'commit', '-m', 'Commit plan'])
  const snapshot = await measured(f)
  await f.modes.saveCheckpoint!({ head: snapshot.head, stage: 'built', round: 1, replansUsed: 0, findings: [], previousFindings: [] })
  const handoff = { run_id: f.row.id, round: 0, snapshot, remainingTasks: 1 }
  expect(await f.modes.advanceRalph(handoff)).toEqual({ kind: 'allow' })
  const restarted = createProductionHostEffects(f.options)
  expect(await restarted.modes.advanceRalph(handoff)).toEqual({ kind: 'allow' })
  expect(restarted.ralphIteration()).toBe(1)
  expect(await restarted.modes.loadResume()).toMatchObject({ stage: 'ralph-task-built', round: 0 })
  expect(await restarted.modes.probePlan(snapshot.head)).toMatchObject({ body: '- [x] first\n- [ ] second\n', uncheckedCount: 1 })
  expect(await restarted.modes.advanceRalph({ ...handoff, snapshot: { ...snapshot, head: f.tip } })).toMatchObject({ kind: 'blocked' })
})

test('production fixed checkpoint survives a host crash without accepting trailer counters', async () => {
  const f = await resumeFixture()
  const save = f.deps.modes!.saveCheckpoint!
  f.deps.modes!.saveCheckpoint = async checkpoint => {
    await save(checkpoint)
    if (checkpoint.stage === 'fixed') throw new Error('fixture host crash after durable fix')
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'fixture host crash after durable fix' })
  const restarted = createProductionHostEffects(f.options)
  expect(await restarted.modes.loadResume()).toMatchObject({ stage: 'fixed', round: 4, replansUsed: 1 })
  f.deps.modes = restarted.modes
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'fixture stops before merge' })
  expect(f.runner.calls.map(c => c.step_id)).toEqual([`${f.row.id}:fix:3`, `${f.row.id}:review:4`])
  expect(f.rounds).toEqual([[4, 1]])
})

test('production G038 moved and absent heads rebuild; unreadable head stops', async () => {
  for (const state of ['moved', 'absent', 'unreadable'] as const) {
    const f = await resumeFixture()
    if (state === 'moved') {
      await writeFile(join(f.worktree, 'code.txt'), 'moved\n')
      await f.command(['git', '-C', f.worktree, 'commit', '-am', 'Move build'])
    } else if (state === 'absent') {
      await f.command(['git', '-C', f.worktree, 'checkout', '--detach'])
      await f.command(['git', '-C', f.repo, 'branch', '-D', 'change'])
    } else {
      f.intercept(argv => argv.includes('rev-parse') ? bad() : undefined)
    }
    const calls: string[] = []
    const runner = fakeRunner('pi')
    runner.run = async request => {
      calls.push(request.role)
      if (state === 'absent' && calls.length === 1) await f.command(['git', '-C', f.worktree, 'checkout', '-b', 'change'])
      const observed = await measured(f)
      // This fixture resumes with a re-plan already spent, so the planner must
      // return a revised execution spec or G075 stops the run before the rebuild
      // this test exists to observe.
      const payload = request.role === 'plan' ? { executionSpec: 'revised execution spec' } : null
      return { kind: 'completed', result: { ...observed, payload }, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null }
    }
    for (const role of ['plan', 'build', 'review', 'fix'] as const) f.input.workers[role].runner = runner
    const result = await f.run()
    expect(calls.slice(0, 2)).toEqual(state === 'unreadable' ? [] : ['plan', 'build'])
    expect(result.kind).toBe(state === 'unreadable' ? 'unknown' : 'blocked')
    if (state === 'unreadable') expect(result).toMatchObject({ detail: expect.stringContaining('head is unreadable') })
  }
})

test('production mode refuses malformed persisted state and unusable observations', async () => {
  const f = await fixture()
  const checkpoint = { head: f.tip, stage: 'built' as const, round: 1, replansUsed: 0, findings: [], previousFindings: [] }
  await f.modes.saveCheckpoint!(checkpoint)
  const original = f.store.stageEvents(f.row.id).find(e => e.stage === 'build-mode-state')!
  const value = JSON.parse(original.meta!)
  await f.store.recordStageEvent(f.row.id, 'build-mode-state', JSON.stringify({ ...value, checkpoint: { ...checkpoint, replansUsed: 9 } }))
  await expect(createProductionHostEffects(f.options).modes.loadResume()).rejects.toThrow('valid identity or state')
  await f.store.recordStageEvent(f.row.id, 'build-mode-state', original.meta)
  const host = createProductionHostEffects(f.options)
  expect(await host.modes.loadResume()).toMatchObject(checkpoint)
  expect(await host.modes.regenerateDiff('short')).toMatchObject({ kind: 'unknown' })
  await expect(host.modes.probePlan(f.tip.slice(0, 7))).rejects.toThrow('full head')
  f.intercept(argv => argv.includes('rev-parse') || argv.includes('show-ref') ? bad() : undefined)
  expect(await host.effects.measure()).toMatchObject({ kind: 'unknown' })
})

for (const operation of ['archive', 'tar'] as const) {
  test(`production plan refuses failed ${operation} even with usable output`, async () => {
    const f = await fixture()
    await writeFile(join(f.worktree, 'IMPLEMENTATION_PLAN.md'), '- [ ] next\n')
    await f.command(['git', '-C', f.worktree, 'add', 'IMPLEMENTATION_PLAN.md'])
    await f.command(['git', '-C', f.worktree, 'commit', '-m', 'Commit plan'])
    const snapshot = await measured(f)
    expect(await f.modes.probePlan(snapshot.head)).toMatchObject({ uncheckedCount: 1 })
    f.intercept(async argv => {
      if (argv.includes(operation)) {
        await spawnCapture(argv, f.repo)
        return bad()
      }
      return undefined
    })
    await expect(f.modes.probePlan(snapshot.head)).rejects.toThrow('unreadable')
  })
}

test('production Ralph rejects wrong identity, incomplete state and unknown head', async () => {
  const f = await fixture()
  await f.db.run('UPDATE code_trident_runs SET ralph = 1 WHERE id = ?', [f.row.id])
  const snapshot = await measured(f)
  const checkpoint = { head: f.tip, stage: 'built' as const, round: 1, replansUsed: 0, findings: [], previousFindings: [] }
  const handoff = { run_id: f.row.id, round: 0, snapshot, remainingTasks: 1 }
  expect(await f.modes.advanceRalph(handoff)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('checkpoint is missing') })
  await f.modes.saveCheckpoint!(checkpoint)
  expect(await f.modes.advanceRalph({ ...handoff, run_id: 'different' })).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('identity') })
  await f.modes.saveCheckpoint!({ ...checkpoint, stage: 'fixed' })
  expect(await f.modes.advanceRalph(handoff)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('completed build') })
  await f.modes.saveCheckpoint!(checkpoint)
  f.intercept(argv => argv.includes('rev-parse') ? bad() : undefined)
  expect(await f.modes.advanceRalph(handoff)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('unreadable') })
  f.intercept(undefined)
  expect(await f.modes.advanceRalph(handoff)).toEqual({ kind: 'allow' })
})

test('production plan refuses a committed link to host bytes', async () => {
  const f = await fixture()
  const outside = join(f.dir, 'outside-plan')
  await writeFile(outside, '- [ ] unrelated host task\n')
  await symlink(outside, join(f.worktree, 'IMPLEMENTATION_PLAN.md'))
  await f.command(['git', '-C', f.worktree, 'add', 'IMPLEMENTATION_PLAN.md'])
  await f.command(['git', '-C', f.worktree, 'commit', '-m', 'Commit link fixture'])
  const snapshot = await measured(f)
  await expect(f.modes.probePlan(snapshot.head)).rejects.toThrow('regular file')
})

test('production re-plan spend survives a crash before replanning begins', async () => {
  const f = await resumeFixture(2, 0)
  const save = f.deps.modes!.saveCheckpoint!
  f.deps.reviewGate = async (_p, _s, _r, _u, record) => { // A design gap is not a code blocker: reporting one here would read as
  // no progress against the resumed round and stop before the re-plan.
  record?.({ findings: ['design gap'], blockingCount: 0 }); return { kind: 're-plan', findings: ['design gap'], whatIsMissing: 'redesign' } }
  f.deps.modes!.saveCheckpoint = async checkpoint => {
    await save(checkpoint)
    if (checkpoint.replansUsed === 1 && checkpoint.head === null) throw new Error('crash before re-plan')
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'crash before re-plan' })
  const restarted = createProductionHostEffects(f.options)
  expect(await restarted.modes.loadResume()).toMatchObject({ head: null, replansUsed: 1, round: 4 })
  f.deps.modes = restarted.modes
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('re-plan already spent') })
})

test('production checkpoint append refuses a terminal transition after host observation', async () => {
  const f = await fixture()
  const first = await f.store.appendBuildModeState(f.row.id, null, '{}')
  expect(typeof first).toBe('number')
  await f.store.update(f.row.id, { phase: 'stopped' })
  expect(await f.store.appendBuildModeState(f.row.id, first, '{"later":true}')).toBeNull()
  expect(f.store.stageEvents(f.row.id).filter(e => e.stage === 'build-mode-state')).toHaveLength(1)
})

test('production rejected review survives a crash before the next fix', async () => {
  const f = await resumeFixture(1, 0)
  f.deps.reviewGate = async (_p, _s, _r, _u, record) => { record?.({ findings: ['second issue'], blockingCount: 1 }); return { kind: 'fix', findings: ['second issue'] } }
  const save = f.deps.modes!.saveCheckpoint!
  f.deps.modes!.saveCheckpoint = async checkpoint => {
    await save(checkpoint)
    if (checkpoint.stage === 'rejected' && !checkpoint.pending) throw new Error('crash after rejection')
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'crash after rejection' })
  const restarted = createProductionHostEffects(f.options)
  expect(await restarted.modes.loadResume()).toMatchObject({ stage: 'rejected', round: 2, replansUsed: 0,
    findings: [{ kind: 'code', actionable: true, text: 'second issue' }], previousFindings: ['new issue'] })
  f.deps.modes = restarted.modes
  f.deps.reviewGate = async (_p, _s, _r, _u, record) => { record?.({ findings: [], blockingCount: 0 }); return { kind: 'approve' } }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'fixture stops before merge' })
  expect(f.runner.calls.map(c => c.step_id)).toEqual([`${f.row.id}:fix:1`, `${f.row.id}:review:2`, `${f.row.id}:fix:2`, `${f.row.id}:review:3`])
})

test('production Ralph driver persists its continuation and host iteration', async () => {
  const f = await resumeFixture(0, 0)
  await f.db.run('UPDATE code_trident_runs SET ralph = 1 WHERE id = ?', [f.row.id])
  await f.modes.saveCheckpoint({ head: f.tip, stage: 'ralph-task-built', round: 0, replansUsed: 0, findings: [], previousFindings: [] })
  f.input.mode = 'ralph'
  f.input.ralphRound = 0
  const snapshot = await measured(f)
  const calls: string[] = []
  const runner = fakeRunner('pi')
  runner.run = async request => {
    calls.push(request.step_id)
    return { kind: 'completed', result: { ...snapshot, payload: request.role === 'plan'
      ? { implementationPlan: '- [ ] first\n- [ ] next\n', topTask: '- [ ] first', remainingTasks: 1, executionSpec: 'implement first' }
      : { round: 0, replansUsed: 99 } }, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null }
  }
  for (const role of ['plan', 'build', 'review', 'fix'] as const) f.input.workers[role].runner = runner
  expect(await f.run()).toMatchObject({ kind: 'continued', remainingTasks: 1 })
  expect(calls).toEqual([`${f.row.id}:task:0:plan:0`, `${f.row.id}:task:0:build:0`])
  const restarted = createProductionHostEffects(f.options)
  expect(restarted.ralphIteration()).toBe(1)
  expect(await restarted.modes.loadResume()).toMatchObject({ stage: 'ralph-task-built', round: 0, replansUsed: 0 })
})

test('production plan refuses archive transformations of committed bytes', async () => {
  const f = await fixture()
  await writeFile(join(f.worktree, '.gitattributes'), 'IMPLEMENTATION_PLAN.md export-subst\n')
  await writeFile(join(f.worktree, 'IMPLEMENTATION_PLAN.md'), '- [ ] next $Format:%H$\n')
  await f.command(['git', '-C', f.worktree, 'add', '.gitattributes', 'IMPLEMENTATION_PLAN.md'])
  await f.command(['git', '-C', f.worktree, 'commit', '-m', 'Commit archive attribute fixture'])
  const snapshot = await measured(f)
  await expect(f.modes.probePlan(snapshot.head)).rejects.toThrow('blob could not be verified')
})


test('G046 head lists require integral matching counts from both endpoints', async () => {
  const head = 'a'.repeat(40)
  const runRow = { name: 'test', status: 'completed', conclusion: 'success' }
  const statusRow = { context: 'classic', state: 'success' }
  for (const field of ['check_runs', 'statuses'] as const) {
    for (const count of [1, 2, 0, -1, 1.5, '1', null, undefined]) {
      const calls: string[][] = []
      const source = productionCiSource(async argv => {
        calls.push([...argv])
        if (argv[1] === 'pr') return ok(JSON.stringify({ headRefOid: head, mergeable: 'MERGEABLE' }))
        const key = argv[2]!.includes('/check-runs?') ? 'check_runs' : 'statuses'
        return ok(JSON.stringify({ total_count: key === field ? count : 1, [key]: [key === 'check_runs' ? runRow : statusRow] }))
      }, '.')
      expect(await source.readiness(7)).toEqual({ headSha: head, mergeable: 'MERGEABLE',
        checksComplete: count === 1, rows: count === 1 ? [runRow, statusRow] : [] })
      expect(calls.slice(1).map(call => call[2])).toEqual([
        `repos/{owner}/{repo}/commits/${head}/check-runs?per_page=100`,
        `repos/{owner}/{repo}/commits/${head}/status?per_page=100`,
      ])
    }
  }
})

test('G046 failed head list reads supply incomplete evidence without refusing', async () => {
  const head = 'a'.repeat(40)
  for (const field of ['check-runs', 'status?']) {
    for (const failure of ['denied', 'timeout', 'json', 'throw', 'shape']) {
      const source = productionCiSource(async argv => {
        if (argv[1] === 'pr') return ok(JSON.stringify({ headRefOid: head, mergeable: 'MERGEABLE' }))
        if (argv[2]!.includes(field)) {
          if (failure === 'throw') throw Error('offline')
          if (failure === 'denied') return { ...bad(), stdout: JSON.stringify({ total_count: 0, check_runs: [], statuses: [] }) }
          if (failure === 'timeout') return { ...ok(JSON.stringify({ total_count: 0, check_runs: [], statuses: [] })), timed_out: true }
          return ok(failure === 'json' ? '{' : '{}')
        }
        return ok(JSON.stringify({ total_count: 0, check_runs: [], statuses: [] }))
      }, '.')
      expect(await source.readiness(7)).toEqual({ headSha: head, mergeable: 'MERGEABLE', checksComplete: false, rows: [] })
    }
  }
  const completeEmpty = productionCiSource(async argv => ok(JSON.stringify(argv[1] === 'pr'
    ? { headRefOid: head, mergeable: 'MERGEABLE' } : { total_count: 0, check_runs: [], statuses: [] })), '.')
  expect(await completeEmpty.readiness(7)).toMatchObject({ checksComplete: true, rows: [] })
})


test('G046 malformed PR heads cannot address check probes', async () => {
  const calls: string[][] = []
  const source = productionCiSource(async argv => {
    calls.push([...argv])
    return ok(JSON.stringify(argv[1] === 'pr' ? { headRefOid: '../main', mergeable: 'MERGEABLE' }
      : { total_count: 0, check_runs: [], statuses: [] }))
  }, '.')
  expect(await source.readiness(7)).toEqual({ unreadable: 'PR head is malformed' })
  expect(calls).toHaveLength(1)
})

// THE ROW GUARD NAMES THE FIELD THAT MOVED. It had no test at all, and its message
// named all four things it compares — so a live acceptance dispatch on 2026-09-15
// failed with "identity, branch or worktree is missing or changed" and there was no
// way to tell which. By the time the row could be read, cleanup had nulled `worktree`,
// so the post-hoc state could not distinguish the field that mismatched from one
// mutated afterwards. A refusal that names a category instead of a fact costs a run.
test('the run-row guard names which field moved, and never leaks the path', async () => {
  const f = await fixture()
  const { effects } = createProductionHostEffects(f.options)
  // Baseline: the bound row matches, so the guard is silent.
  expect((await effects.measure()).kind).toBe('known')

  // NAMES ONLY THE FIELD THAT MOVED. Asserting merely that the message *contains*
  // "worktree" is a tautology — the old unspecific message named all four fields, so
  // it satisfied that too and a mutation back to it stayed green. The property is
  // exclusivity: when the branch moved, the message must NOT say worktree.
  await f.store.update(f.options.runId, { worktree: '/somewhere/else' })
  const movedWorktree = await effects.measure()
  // Exact shape, so a message that merely mentions the word cannot satisfy it.
  expect((movedWorktree as { detail: string }).detail)
    .toMatch(/Build run identity changed: worktree no longer matches the bound build/)

  await f.store.update(f.options.runId, { worktree: f.options.worktree, branch: 'trident/moved' })
  const movedBranch = await effects.measure()
  expect((movedBranch as { detail: string }).detail)
    .toMatch(/Build run identity changed: branch no longer matches the bound build/)
  // The VALUES are never interpolated — this string reaches inner_result and the chat.
  expect(JSON.stringify(movedBranch)).not.toContain('trident/moved')
  expect(JSON.stringify(movedBranch)).not.toContain(f.options.worktree)
})
