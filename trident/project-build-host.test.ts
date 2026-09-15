import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { fakeRunner, type Provider } from '@neutronai/runtime/bounded-work.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { TridentPhaseUsageStore } from './phase-usage.ts'
import { createProjectBuildHost, projectBuildRunners, type ProjectBuildHostOptions } from './project-build-host.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { workContextPath } from './production-host-effects.ts'
import { spawnCapture } from './git-mode.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

for (const provider of ['anthropic', 'openai-codex', 'pi'] as const) {
  test(`project runners keep ${provider} inside its REPL and others headless`, () => {
    const providers: Provider[] = ['anthropic', 'openai-codex', 'pi']
    const inside = fakeRunner(provider)
    const headless = Object.fromEntries(providers.map(p => [p, fakeRunner(p)]))
    const selected = projectBuildRunners({ provider, inRepl: inside, headless }, providers)
    expect(selected[provider]).toBe(inside)
    for (const other of providers.filter(p => p !== provider)) expect(selected[other]).toBe(headless[other])
    const missing = projectBuildRunners({ provider, inRepl: undefined, headless }, providers)
    expect(missing[provider]).toBeUndefined()
    expect(projectBuildRunners({ provider, inRepl: fakeRunner(providers.find(p => p !== provider)!), headless: {} }, providers)).toEqual({})
  })
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'project-build-host-'))
  seedMigratedDb(join(dir, 'project.db'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  cleanups.push(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
  const store = new TridentRunStore(db)
  const row = await store.create({ slug: 'build', project_slug: 'project', repo_path: dir, task: 'Build' })
  await store.update(row.id, { branch: 'change', worktree: join(dir, 'work'), base_sha: 'a'.repeat(40) })
  const path = join(dir, 'brief')
  await writeFile(path, 'Implement the task')
  const request = { model_id: 'project-model', effort: null, cwd: join(dir, 'work'), writable: true, network: false,
    tools: 'edit-and-run' as const, brief: { path, integrity: briefIntegrity('Implement the task') },
    result: { schema: 'build', path: join(dir, 'result') }, thread: null, budget: { wall_ms: 100 } }
  const placements: string[] = []
  const runner = fakeRunner('pi', { supports: (_role, placement) => { placements.push(placement); return { ok: true } } })
  const options: ProjectBuildHostOptions = {
    substrate: { provider: 'pi', inRepl: runner, headless: {} },
    // The real store over the same database, so the composition's write is the
    // write production performs rather than a stub that cannot fail.
    phaseUsage: new TridentPhaseUsageStore(db),
    production: { store, runId: row.id, projectSlug: 'project', repo: dir, worktree: join(dir, 'work'), branch: 'change',
      baseBranch: 'main', runHost: spawnCapture, ciWorkflow: 'ci.yml', publication: { title: 'Build', bodyFile: join(dir, 'body') } },
    policy: { leak: { scratch_dir: join(dir, 'scan') }, mutation: { readClaim: async () => null } },
    workers: { plan: { provider: 'pi', request }, build: { provider: 'pi', request },
      review: { provider: 'pi', request }, fix: { provider: 'pi', request } },
  }
  return { options, path, placements }
}

test('project composition renders per-role context briefs and pins placement', async () => {
  const f = await fixture()
  const host = await createProjectBuildHost(f.options)
  const paths = new Set<string>()
  for (const [role, worker] of Object.entries(host.workers)) {
    const brief = worker.request.brief
    paths.add(brief.path)
    const text = await readFile(brief.path, 'utf8')
    expect(text).toContain(workContextPath(brief.path))
    expect(briefIntegrity(text)).toBe(brief.integrity)
    expect(worker.runner.supports(role as 'build', 'headless')).toEqual({ ok: true })
  }
  expect(paths.size).toBe(4)
  expect(f.placements).toEqual(['in-repl', 'in-repl', 'in-repl', 'in-repl'])
  expect(await readFile(f.path, 'utf8')).toBe('Implement the task')
})

test('project composition refuses a missing provider by name before host commands', async () => {
  const f = await fixture()
  f.options.substrate.inRepl = undefined
  const host = await createProjectBuildHost(f.options)
  expect(await host.run({ mode: 'pr', start: 'fresh' }, new AbortController().signal)).toMatchObject({
    kind: 'refused', reason: 'worker-unsupported', detail: expect.stringContaining('pi'),
  })
})

test('project composition refuses changed source integrity and absent launch pin', async () => {
  const f = await fixture()
  await writeFile(f.path, 'Changed task')
  await expect(createProjectBuildHost(f.options)).rejects.toThrow('integrity mismatch')
  await writeFile(f.path, 'Implement the task')
  await f.options.production.store.update(f.options.production.runId, { base_sha: null })
  await expect(createProjectBuildHost(f.options)).rejects.toThrow('initialized run')
})

test('project reconstruction supplies persisted modes and refuses altered host briefs', async () => {
  const f = await fixture()
  const host = await createProjectBuildHost(f.options)
  const checkpoint = { head: null, stage: 'built' as const, round: 3, replansUsed: 1, findings: [], previousFindings: [] }
  await host.deps.modes!.saveCheckpoint!(checkpoint)
  const restarted = await createProjectBuildHost(f.options)
  expect(await restarted.deps.modes!.loadResume()).toEqual(checkpoint)
  await writeFile(host.workers.fix.request.brief.path, 'altered')
  await expect(createProjectBuildHost(f.options)).rejects.toThrow()
})

test('project Ralph state read failure is unknown', async () => {
  const f = await fixture()
  const host = await createProjectBuildHost(f.options)
  await f.options.production.store.recordStageEvent(f.options.production.runId, 'build-mode-state', '{}')
  expect(await host.run({ mode: 'ralph', start: 'resume' }, new AbortController().signal)).toMatchObject({
    kind: 'unknown', detail: expect.stringContaining('valid identity or state'),
  })
})
