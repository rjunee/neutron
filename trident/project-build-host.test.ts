import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { fakeRunner, type Provider } from '@neutronai/runtime/bounded-work.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { TridentRunStore } from './store.ts'
import { TridentAttemptLedger } from './attempt-ledger.ts'
import { createProjectBuildHost, projectBuildRunners, withProductionCleanup, type ProjectBuildHostOptions } from './project-build-host.ts'
import type { BuildRunOutcome } from './build-run.ts'
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
    requestedModels: { plan: 'test', build: 'test', fix: 'test', review: 'test' },
    substrate: { provider: 'pi', inRepl: runner, headless: {} },
    // The real store over the same database, so the composition's write is the
    // write production performs rather than a stub that cannot fail.
    attempts: new TridentAttemptLedger(db),
    production: { store, runId: row.id, projectSlug: 'project', repo: dir, worktree: join(dir, 'work'), branch: 'change',
      baseBranch: 'main', runHost: spawnCapture, ciWorkflow: 'ci.yml', publication: async () => ({ title: 'Build', bodyFile: join(dir, 'body') }) },
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

test('G125 cleanup runs for every build ending and a thrown or aborted build', async () => {
  const snapshot = { head: 'a'.repeat(40), diff: 'change', pr: null }
  const endings: BuildRunOutcome[] = [
    { kind: 'merged', snapshot },
    { kind: 'blocked', phase: 'review', on: 'gate', recipient: 'orchestrator' },
    { kind: 'built', snapshot, cause: 'wave-member-built' },
    { kind: 'continued', snapshot, remainingTasks: 1, cause: 'ralph-task-built' },
    { kind: 'refused', reason: 'worker-unsupported', detail: 'unsupported' },
    { kind: 'failed', phase: 'build', detail: 'worker failed', cause: 'workflow-threw' },
    { kind: 'unknown', phase: 'fix', step_id: 'step', detail: 'unobserved' },
  ]
  let attempts = 0
  for (const ending of endings) {
    const result = await withProductionCleanup(async () => ending, async () => {
      attempts++
      return { kind: 'cleaned', detail: 'RESULT preserved=0 removed=0' }
    })
    expect(result).toEqual({ ...ending, cleanup: { kind: 'cleaned', detail: 'RESULT preserved=0 removed=0' } })
  }
  for (const error of [new Error('host threw'), new DOMException('aborted', 'AbortError')]) {
    const result = await withProductionCleanup(async () => { throw error }, async () => {
      attempts++
      return { kind: 'preserved', detail: 'RESULT preserved=1 removed=0' }
    })
    expect(result).toMatchObject({ kind: 'unknown', detail: expect.stringContaining(error.message), cleanup: { kind: 'preserved' } })
  }
  expect(attempts).toBe(endings.length + 2)
})

test('G127 cleanup failure stays visible without changing the build verdict', async () => {
  const build: BuildRunOutcome = { kind: 'merged', snapshot: { head: 'a'.repeat(40), diff: 'change', pr: null } }
  expect(await withProductionCleanup(async () => build, async () => ({ kind: 'failed', detail: 'script crashed' }))).toEqual({
    ...build, cleanup: { kind: 'failed', detail: 'script crashed' },
  })
})


test('project composition binds review source to admitted run and worktree', async () => {
  const f = await fixture()
  const requests: { run_id: string; cwd: string }[] = []
  f.options.policy.review = {
    evidenceRoot: f.options.production.repo, env: {},
    phaseModels: { review_rubric: { model: 'none' }, review_adversarial: { model: 'sol' },
      review_codex: { model: 'none' }, review_kimi: { model: 'none' } },
    wallMs: 1000, signal: new AbortController().signal,
    runnerFor: (_model, seat) => ({ provider: seat.provider, supports: () => ({ ok: true }),
      liveness: async () => 'unknown', run: async request => {
        requests.push(request)
        return { kind: 'completed', result: { verdict: 'APPROVE', findings: [] },
          usage: { input_tokens: 0, output_tokens: 0 }, model_reported: request.model_id, thread_id: request.thread?.id ?? 'fixture-review-thread' }
      } }),
  }
  const host = await createProjectBuildHost(f.options)
  const snapshot = { head: 'b'.repeat(40), diff: 'measured diff', pr: null }
  expect(await host.deps.reviewGate({ verdict: 'APPROVE', findings: [] },
    await host.deps.observeReview(snapshot, 1), snapshot, 1, 0)).toEqual({ kind: 'approve' })
  expect(requests).toHaveLength(2)
  expect(requests.every(request => request.run_id === f.options.production.runId && request.cwd === f.options.production.worktree)).toBe(true)
})

// These exercise the acquisition adapters through the certified gate vocabulary.
import { createProjectObservationSources } from './project-observation-sources.ts'
import { classifyReviewReadiness } from './gates/review-readiness.ts'
import { assessReviewCi } from './gates/review-ci.ts'
import { assessReviewSuite } from './gates/review-suite.ts'

const observedHead = 'b'.repeat(40)
const observedSnapshot = { head: observedHead, diff: 'measured diff', pr: { number: 7, head: observedHead, state: 'OPEN' as const } }
function observationFixture() {
  let now = 0
  const config = { kind: 'resolved' as const, required: ['test'], appBound: [] as string[], produced: ['test'] }
  const raw = { checksComplete: true, headSha: observedHead, mergeable: 'MERGEABLE', rows: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] as unknown }
  const options: Parameters<typeof createProjectObservationSources>[0] = {
    ci: { required: async () => config, readiness: async () => raw }, baseBranch: 'main', ciWorkflow: 'ci.yml', runId: 'run',
    reviewReadinessClock: { now: () => now, wait: async ms => { now += ms } },
    suite: { strategy: 'bun test', scope: 'full-suite', readCheckpoint: async () => ({
      runId: 'run', head: observedHead, round: 1, report: { hostExitCode: 0, suiteOutcome: 'passed' },
    }) },
  }
  const sources = createProjectObservationSources(options)
  const readiness = async (signal = new AbortController().signal) => sources.reviewReadiness.observe(observedSnapshot, signal)
  return { config, raw, options, sources, readiness }
}

test('observation readiness preserves named states, app binding and conflicts', async () => {
  const f = observationFixture()
  expect(classifyReviewReadiness(observedSnapshot, await f.readiness())).toEqual({ kind: 'passed', failed: [] })
  for (const [conclusion, state] of [['FAILURE', 'failed'], ['SKIPPED', 'skipped'], ['SUCCESS', 'passed']] as const) {
    f.raw.rows = [{ name: 'test', status: 'COMPLETED', conclusion }]
    expect(await f.readiness()).toMatchObject({ checks: [{ name: 'test', state }] })
  }
  f.raw.rows = [{ context: 'test', state: 'PENDING' }]
  expect(await f.readiness()).toMatchObject({ checks: [{ name: 'test', state: 'running' }] })
  f.config.appBound = ['test']
  f.raw.rows = [{ context: 'test', state: 'SUCCESS' }]
  expect(classifyReviewReadiness(observedSnapshot, await f.readiness()).kind).toBe('pending')
  f.raw.mergeable = 'CONFLICTING'
  expect(classifyReviewReadiness(observedSnapshot, await f.readiness()).kind).toBe('blocked')
  f.raw.mergeable = 'UNKNOWN'
  expect(classifyReviewReadiness(observedSnapshot, await f.readiness()).kind).toBe('pending')
})

test('observation readiness cannot turn failed acquisition into known checks', async () => {
  const cases: [string, (f: ReturnType<typeof observationFixture>) => void][] = [
    ['workflow', f => { f.options.ciWorkflow = undefined }],
    ['configuration', f => { f.options.ci.required = async () => ({ kind: 'unknown', reason: 'denied' }) }],
    ['readiness', f => { f.options.ci.readiness = async () => ({ unreadable: 'offline' }) }],
    ['head', f => { f.raw.headSha = 'c'.repeat(40) }],
    ['mergeability', f => { f.raw.mergeable = 'invalid' }],
    ['rows', f => { f.raw.rows = null }],
    ['row', f => { f.raw.rows = [{}] }],
    ['exception', f => { f.options.ci.required = async () => { throw Error('denied') } }],
  ]
  for (const [name, change] of cases) {
    const f = observationFixture(); change(f)
    expect((await f.readiness()).kind, name).toBe('unknown')
  }
  const f = observationFixture()
  expect((await f.sources.reviewReadiness.observe({ ...observedSnapshot, pr: null }, new AbortController().signal)).kind).toBe('unknown')
  expect((await f.sources.reviewReadiness.observe({ ...observedSnapshot, head: 'short' }, new AbortController().signal)).kind).toBe('unknown')
  const cancel = new AbortController(); cancel.abort()
  expect((await f.readiness(cancel.signal)).kind).toBe('unknown')
  const during = new AbortController()
  f.options.ci.required = async () => { during.abort(); return f.config }
  expect((await f.readiness(during.signal)).kind).toBe('unknown')
})

test('observation CI preserves unknown, pending and named actionable red without base evidence', async () => {
  const f = observationFixture()
  const assess = () => assessReviewCi(f.sources.reviewCi, observedSnapshot, 'a'.repeat(40), 'run')
  expect(await assess()).toEqual({ kind: 'known', findings: [] })
  f.raw.rows = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }]
  expect(await assess()).toMatchObject({ kind: 'known', findings: [{ title: 'CI FAILING: test', advisory: false }] })
  f.raw.rows = []
  expect(await assess()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('Required check test has not run and settled') })
  f.raw.rows = [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }]
  expect(await assess()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('Required check test has not run and settled') })
  f.options.ci.required = async () => ({ kind: 'unknown', reason: 'denied' })
  expect(await assess()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('denied') })
})

test('observation CI re-observes pending readiness and preserves terminal classifications', async () => {
  const f = observationFixture()
  let now = 0
  const waits: number[] = []
  f.options.reviewReadinessClock = { now: () => now, wait: async ms => { waits.push(ms); now += ms } }
  let observations = 0
  f.options.ci.readiness = async () => ({ ...f.raw, mergeable: ++observations === 1 ? 'UNKNOWN' : 'MERGEABLE' })
  expect(await assessReviewCi(f.sources.reviewCi, observedSnapshot, 'a'.repeat(40), 'run')).toEqual({ kind: 'known', findings: [] })
  expect(waits).toEqual([30000])

  f.options.ci.readiness = async () => ({ ...f.raw, mergeable: 'CONFLICTING' })
  expect(await assessReviewCi(f.sources.reviewCi, observedSnapshot, 'a'.repeat(40), 'run')).toEqual({ kind: 'blocked', on: 'Review PR conflicts with base' })
  f.options.ci.required = async () => ({ kind: 'unknown', reason: 'configuration denied' })
  expect(await assessReviewCi(f.sources.reviewCi, observedSnapshot, 'a'.repeat(40), 'run')).toEqual({ kind: 'unknown', detail: 'Review CI: Review readiness configuration: configuration denied' })
})

test('observation suite requires independently acquired identity and preserves report claims', async () => {
  const f = observationFixture()
  const assess = () => assessReviewSuite(f.sources.reviewSuite, observedSnapshot, 1, 'run')
  expect(await assess()).toEqual({ kind: 'known', findings: [] })
  const suite = f.options.suite!
  for (const field of ['runId', 'head', 'round'] as const) {
    suite.readCheckpoint = async () => ({ runId: 'run', head: observedHead, round: 1, report: { hostExitCode: 0 }, [field]: field === 'round' ? 2 : 'wrong' }) as any
    expect((await f.sources.reviewSuite.observe(observedSnapshot, 1)).kind, field).toBe('unknown')
  }
  suite.readCheckpoint = async () => ({ runId: 'run', head: observedHead, round: 1, report: { hostExitCode: 1, suiteOutcome: 'failed-new' } })
  expect(await assess()).toMatchObject({ kind: 'known', findings: [{ title: 'FULL SUITE NOT PROVEN', advisory: false }] })
  suite.readCheckpoint = async () => null
  expect((await assess()).kind).toBe('unknown')
  suite.readCheckpoint = async () => { throw Error('checkpoint offline') }
  expect(await assess()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('checkpoint offline') })
  f.options.suite = undefined
  expect(await assess()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('strategy, dispatched scope and checkpoint reader') })
})

test('production composition driver reaches a review panel through all three observation sources', async () => {
  const f = await fixture()
  const observed = observationFixture()
  await f.options.production.store.update(f.options.production.runId, { merge_mode: 'pr' })
  f.options.production.ciSource = observed.options.ci
  f.options.policy.reviewSuite = { ...observed.options.suite!, readCheckpoint: async () => ({
    runId: f.options.production.runId, head: observedHead, round: 1, report: { hostExitCode: 0 },
  }) }
  const ok = (stdout = '') => ({ ok: true, exit_code: 0, stdout, stderr: '' })
  f.options.production.runHost = async argv => {
    if (argv.includes('check-ref-format') || argv.includes('fetch') || argv.includes('show-ref') || argv.includes('merge-base')) return ok()
    if (argv.includes('rev-parse')) return ok(argv.some(arg => arg.includes('origin/main')) ? 'a'.repeat(40) : observedHead)
    if (argv.includes('diff')) {
      const output = argv.find(arg => arg.startsWith('--output='))!
      await writeFile(output.slice('--output='.length), observedSnapshot.diff)
      return ok()
    }
    if (argv[0] === 'gh') return ok(JSON.stringify([{ number: 7, headRefOid: observedHead, state: 'OPEN',
      headRefName: 'change', baseRefName: 'main', isCrossRepository: false }]))
    if (argv[0] === 'bash') return ok('RESULT preserved=0 removed=0')
    throw Error(`Unexpected host command: ${argv[0]}`)
  }
  f.options.workers.review.request = { ...f.options.workers.review.request, writable: false, tools: 'read-only' }
  f.options.substrate.inRepl = { ...fakeRunner('pi'), run: async () => ({ kind: 'completed',
    result: { ...observedSnapshot, payload: { verdict: 'APPROVE', findings: [] } },
    usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'project-model', thread_id: null }) }
  let panelCalls = 0
  f.options.policy.review = {
    evidenceRoot: f.options.production.repo, env: {},
    phaseModels: { review_rubric: { model: 'none' }, review_adversarial: { model: 'sol' },
      review_codex: { model: 'none' }, review_kimi: { model: 'none' } },
    wallMs: 1000, signal: new AbortController().signal,
    runnerFor: (_model, seat) => ({ ...fakeRunner(seat.provider), run: async () => {
      panelCalls++
      return { kind: 'blocked', on: 'panel reached' }
    } }),
  }
  const host = await createProjectBuildHost(f.options)
  // This test owns observation/panel composition; publication now precedes it.
  // Model an already published candidate while keeping all three sources real.
  host.deps.runLeakGatePreflight = async () => ({ status: 'clean', head: observedHead, findings: [], skipped_rules: [], attempts: 0, note: '' })
  host.deps.publishGate = async () => ({ kind: 'allow' })
  host.deps.publish = async () => {}
  await host.deps.modes!.saveCheckpoint({ head: observedHead, stage: 'built', round: 1, replansUsed: 0, findings: [], previousFindings: [] })
  const result = await host.run({ mode: 'pr', start: 'resume' }, new AbortController().signal)
  expect(panelCalls, JSON.stringify(result)).toBeGreaterThan(0)
  expect(result.kind).toBe('blocked')
})


test('G046 observation carries incomplete evidence into waiting', async () => {
  const f = observationFixture()
  f.raw.checksComplete = false
  expect(await f.readiness()).toMatchObject({ kind: 'known', checksComplete: false })
  expect(classifyReviewReadiness(observedSnapshot, await f.readiness()).kind).toBe('pending')
  f.raw.checksComplete = true
  expect(classifyReviewReadiness(observedSnapshot, await f.readiness()).kind).toBe('passed')
})

for (const scenario of ['same head', 'changed head', 'subset', 'different strategy', 'missing publication source', 'wrong run', 'wrong round', 'red suite', 'later subset', 'later unknown', 'publication subset'] as const) {
  test(`publication reuses review evidence: ${scenario}`, async () => {
    const f = await fixture()
    const subject = { head: 'b'.repeat(40), diff: '+code', pr: null }
    let reviewRuns = 0
    let publicationRuns = 0
    f.options.policy.reviewSuite = {
      strategy: 'bun test', scope: scenario === 'subset' ? 'subset' : 'full-suite',
      readCheckpoint: async (snapshot, round) => {
        reviewRuns++
        return { runId: scenario === 'wrong run' ? 'wrong' : f.options.production.runId,
          head: snapshot.head, round: scenario === 'wrong round' ? round + 1 : round,
          report: { hostExitCode: scenario === 'red suite' ? 1 : 0 } }
      },
    }
    if (scenario !== 'missing publication source') f.options.policy.publicationSuite = {
      strategy: scenario === 'different strategy' ? 'bash full.sh' : 'bun test', scope: scenario === 'publication subset' ? 'subset' : 'full-suite',
      readCheckpoint: async (snapshot, round) => {
        publicationRuns++
        return { runId: f.options.production.runId, head: snapshot.head, round, report: { hostExitCode: 0 } }
      },
    }
    const host = await createProjectBuildHost(f.options)
    await host.deps.reviewSuite!(subject, 2)
    if (scenario === 'subset') {
      subject.head = 'c'.repeat(40)
      await host.deps.reviewSuite!(subject, 3)
    }
    if (scenario === 'later subset') {
      f.options.policy.reviewSuite.scope = 'subset'
      await host.deps.reviewSuite!(subject, 3)
    }
    if (scenario === 'later unknown') {
      f.options.policy.reviewSuite.readCheckpoint = async () => null
      await host.deps.reviewSuite!(subject, 3)
    }
    const result = await host.deps.publicationSuite(scenario === 'changed head' ? { ...subject, head: 'c'.repeat(40) } : subject)
    expect(reviewRuns).toBe(scenario === 'later subset' || scenario === 'subset' ? 2 : 1)
    if (scenario === 'missing publication source') {
      expect(result.kind).toBe('unknown')
      expect(publicationRuns).toBe(0)
    } else if (scenario === 'red suite') {
      expect(result).toMatchObject({ kind: 'known', findings: [{ advisory: false, title: 'FULL SUITE NOT PROVEN' }] })
      expect(publicationRuns).toBe(0)
    } else {
      expect(result).toEqual({ kind: 'known', findings: [] })
      expect(publicationRuns).toBe(scenario === 'same head' ? 0 : 1)
    }
  })
}
