import { makeTridentRun } from './testing/make-trident-run.ts'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRunner, type Provider, type BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { buildRun, type BuildRunInput, type BuildSnapshot } from './build-run.ts'
import { createBuildHost, type BuildHostOptions } from './build-host.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { publicationReadiness, pinnedMergeReadiness } from './gates/release-readiness.ts'
import { MERGE_DIFF_BYTES_MAX } from './merge.ts'

const head = 'a'.repeat(40)
const snapshot: BuildSnapshot = { head, diff: '+code', pr: null }
const published: BuildSnapshot = { ...snapshot, pr: { number: 12, head, state: 'OPEN' } }
const singlePlan = { strategy: 'single' as const, rationale: 'One builder can complete the accepted plan.',
  implementationPlan: '- [ ] implement the task\n', topTask: '- [ ] implement the task',
  executionSpec: 'Implement the task.', complexity: 'mechanical' as const, remainingTasks: 0 }
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'build-host-test-'))
  dirs.push(dir)
  const path = join(dir, 'brief')
  await writeFile(path, `${path}.context.json`)
  const request = {
    model_id: 'test-model', effort: null, cwd: dir, writable: true, network: false,
    tools: 'edit-and-run', brief: { path, integrity: briefIntegrity(`${path}.context.json`) },
    result: { schema: 'test', path: join(dir, 'result') }, thread: null, budget: { wall_ms: 100 },
  } satisfies BuildRunInput['workers']['build']['request']
  const calls: string[][] = []
  let diff = 'M\0src/code.ts\0'
  let drift: 'clear' | 'overlap' | 'unreadable' = 'clear'
  let leakOutput = 'LEAK GATE: INCOMPLETE\nRULES THAT COULD NOT RUN: pii'
  let leakCode = 3
  let selected: typeof singlePlan | null = null
  let elapsed = 0
  const options: BuildHostOptions = {
    mergeReadinessClock: { now: () => elapsed, wait: async ms => { elapsed += ms } },
    reviewReadiness: { observe: async () => ({ kind: 'known', head, configuration: { kind: 'resolved', required: ['checks'] }, mergeability: 'mergeable', checksComplete: true, checks: [{ name: 'checks', state: 'passed' }] }) },
    reviewCi: { observe: async snapshot => ({ kind: 'known', head: snapshot.head, status: 'green', failing: [], base: null }) },
    reviewSuite: { observe: async (snapshot, round) => ({ kind: 'known', runId: 'test', head: snapshot.head, round, strategy: '', scope: 'full-suite', report: null }) },
    // Terminal full-suite evidence. The driver refuses to merge without it, so the
    // fixture must decide what this host reports rather than leave it unwired.
    publicationSuite: { observe: async (snapshot, round) => ({ kind: 'known', runId: 'test', head: snapshot.head, round, strategy: '', scope: 'full-suite', report: null }) },
    reviewed_head: null,
    modes: {
      loadExecutionStrategy: async () => selected === null
        ? { kind: 'known', strategy: null, rationale: null, plan: null, source: null }
        : { kind: 'known', strategy: selected.strategy, rationale: selected.rationale, plan: structuredClone(selected), source: 'planner' },
      selectExecutionStrategy: async value => {
        if (value.strategy !== value.plan.strategy || value.rationale !== value.plan.rationale) return { kind: 'blocked', on: 'invalid selection fixture' }
        selected = structuredClone(value.plan) as typeof singlePlan
        return { kind: 'allow' }
      },
      loadResume: async () => null,
      saveCheckpoint: async () => {},
      regenerateDiff: async () => ({ kind: 'known', diff: snapshot.diff }),
      probePlan: async () => null,
      commitPlan: async () => ({ kind: 'known', head }),
      advanceTask: async () => ({ kind: 'allow' }),
    },
    runners: { pi: fakeRunner('pi') }, replProvider: 'pi',
    workers: Object.fromEntries(['plan', 'build', 'review', 'fix'].map(role => [role, { provider: 'pi', request }])) as BuildHostOptions['workers'],
    effects: {
      prepareWork: async (request, context) => {
        // Match the production context materialization consumed by the host gate.
        await writeFile(`${request.brief.path}.context.json`, JSON.stringify({ request, ...context }))
      }, measure: async () => ({ kind: 'known', value: snapshot }),
      publish: async () => { throw new Error('unexpected publish') }, merge: async () => { throw new Error('unexpected merge') },
    },
    leak: {
      repo_path: dir, branch: 'change', base_sha: 'b'.repeat(40), scratch_dir: join(dir, 'scan'), gate_script: 'trusted-gate',
      run_host: async (argv) => {
        calls.push(argv)
        if (argv.includes('bash')) return { ok: leakCode === 0, exit_code: leakCode, stdout: leakOutput, stderr: '' }
        return { ok: true, exit_code: 0, stdout: '', stderr: '' }
      },
    },
    mutation: {
      run: { id: 'test', slug: 'change', repo_path: dir, branch: 'change' }, base_branch: 'base',
      readClaim: async () => null,
      run_host: async (argv) => {
        calls.push(argv)
        if (argv.includes('gh')) return { ok: true, exit_code: 0, stdout: JSON.stringify({ headRefName: 'change', baseRefName: 'release', baseRefOid: 'b'.repeat(40), isCrossRepository: false, headRefOid: head, state: 'OPEN' }), stderr: '' }
        if (argv.includes('fetch') || argv.includes('ls-remote')) return { ok: true, exit_code: 0, stdout: '', stderr: '' }
        if (argv.includes('rev-parse') && drift === 'unreadable') return { ok: false, exit_code: 128, stdout: '', stderr: '' }
        if (argv.includes('merge-base')) return { ok: drift !== 'unreadable', exit_code: drift === 'unreadable' ? 128 : 0, stdout: drift === 'overlap' ? 'b'.repeat(40) : head, stderr: '' }
        if (argv.includes('--name-only')) return { ok: true, exit_code: 0, stdout: 'src/code.ts\n', stderr: '' }
        if (argv.includes('rev-parse')) return { ok: true, exit_code: 0, stdout: head, stderr: '' }
        if (argv.includes('diff')) {
          const output = argv.find(arg => arg.startsWith('--output='))
          if (output) await writeFile(output.slice('--output='.length), diff)
          return { ok: true, exit_code: 0, stdout: diff, stderr: '' }
        }
        if (argv.includes('check-ref-format')) return { ok: true, exit_code: 0, stdout: '', stderr: '' }
        // G166 (#1133): the publication trailer scan lists the launch-base..head range; the fake
        // repo has no commits to scan, so the range is empty and nothing is read.
        if (argv.includes('rev-list')) return { ok: true, exit_code: 0, stdout: '', stderr: '' }
        throw new Error(`Unexpected command: ${argv.join(' ')}`)
      },
    },
    observeCi: async () => ({ kind: 'completed', conclusion: 'success', headSha: head }),
  }
  const make = () => createBuildHost(options)
  const input = (host: ReturnType<typeof make>): BuildRunInput => ({ run_id: 'test', mode: 'implementation', start: 'fresh', merge_mode: 'pr', repl_provider: options.replProvider, workers: host.workers })
  return { options, make, input, path, calls, setDrift: (value: typeof drift) => { drift = value }, prose: () => { diff = 'M\0README.md\0' }, clean: () => { leakCode = 0; leakOutput = 'LEAK GATE: SILENT' } }
}

test('missing provider is refused by the driver before effects', async () => {
  const f = await fixture()
  f.options.runners = {}
  const host = f.make()
  expect(await buildRun(f.input(host), host.deps, new AbortController().signal)).toMatchObject({ kind: 'refused', reason: 'worker-unsupported' })
  expect(await host.workers.build.runner.run({} as BoundedWorkRequest, 'in-repl', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'provider-not-connected' })
  expect(await host.workers.build.runner.liveness({ run_id: 'test', step_id: 'test' })).toBe('unknown')
})

test('mis-keyed provider is refused without falling back', async () => {
  const f = await fixture()
  f.options.runners.pi = fakeRunner('openai-codex')
  const host = f.make()
  expect(await buildRun(f.input(host), host.deps, new AbortController().signal)).toMatchObject({ kind: 'refused' })
})

test.each(['pi', 'openai-codex'] as const)('recovery preserves prescribed placement for %s without a run fallback', async provider => {
  const f = await fixture(), placements: string[] = []
  const raw = fakeRunner(provider)
  f.options.runners[provider] = { ...raw, recover: async (_request, placement) => {
    placements.push(placement); return { kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null }
  } }
  f.options.workers.build.provider = provider
  const host = f.make(), request: BoundedWorkRequest = { ...host.workers.build.request, run_id: 'run', step_id: 'build:0', role: 'build', needs_approval_decision: false }
  expect((await host.workers.build.runner.recover!(request, 'headless', new AbortController().signal)).kind).toBe('completed')
  expect(placements).toEqual([provider === 'pi' ? 'in-repl' : 'headless']); expect(raw.calls).toHaveLength(0)
  f.options.runners[provider] = raw
  expect((await f.make().workers.build.runner.recover!(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(raw.calls).toHaveLength(0)
})

for (const provider of ['pi', 'openai-codex'] satisfies Provider[]) {
  test(`placement follows project provider for ${provider}`, async () => {
    const f = await fixture()
    const placements: string[] = []
    f.options.runners[provider] = {
      ...fakeRunner(provider),
      supports: (_role, placement) => { placements.push(placement); return { ok: true } },
      run: async (_request, placement) => { placements.push(placement); return { kind: 'unknown', detail: 'turn' } },
    }
    for (const role of ['plan', 'build', 'review', 'fix'] as const) f.options.workers[role].provider = provider
    const host = f.make()
    for (const role of ['plan', 'build', 'review', 'fix'] as const) {
      const runner = host.workers[role].runner
      expect(runner.supports(role, 'headless')).toEqual({ ok: true })
      await runner.run({} as BoundedWorkRequest, 'headless', new AbortController().signal)
    }
    expect(placements).toEqual(Array(8).fill(provider === 'pi' ? 'in-repl' : 'headless'))
  })
}

test('brief integrity blocks changed bytes including the fix brief', async () => {
  const f = await fixture()
  const host = f.make()
  host.workers.fix.request = { ...host.workers.fix.request, brief: { path: f.path, integrity: 'wrong' } }
  expect(await host.deps.admissionGate(f.input(host))).toEqual({ kind: 'blocked', on: 'fix brief integrity mismatch' })
})

test('unreadable admission and missing project source stay unknown', async () => {
  const f = await fixture()
  const host = f.make()
  expect(await host.deps.admissionGate(f.input(host))).toMatchObject({ kind: 'unknown', detail: 'Project admission observation source is missing' })
  expect(await buildRun(f.input(host), host.deps, new AbortController().signal)).toMatchObject({ kind: 'unknown', phase: 'plan' })
  await rm(f.path)
  expect(await host.deps.admissionGate(f.input(host))).toMatchObject({ kind: 'unknown', detail: expect.stringMatching(/^plan brief could not be read: Error: ENOENT/) })
})

test('malformed review and missing panel evidence are infrastructure blocks', async () => {
  const f = await fixture()
  const { deps } = f.make()
  expect(await deps.reviewGate(null, await deps.observeReview(snapshot, 1), snapshot, 1)).toMatchObject({ kind: 'blocked', on: 'infra-only: Review trailer not-object at $' })
  const finding = { severity: 'major', title: 'bug', evidence: 'code.ts:1', file: 'code.ts', symbol: 'f', rule: 'correctness', line: 1 }
  expect(await deps.reviewGate({ verdict: 'APPROVE', findings: [finding] }, await deps.observeReview(snapshot, 1), snapshot, 1)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
  for (const severity of ['minor', 'nit']) expect(await deps.reviewGate({ verdict: 'APPROVE', findings: [{ ...finding, severity }] }, await deps.observeReview(snapshot, 1), snapshot, 1)).toMatchObject({ kind: 'blocked', on: 'infra-only: Review panel observation source is missing' })
  expect(await deps.reviewGate({ verdict: 'APPROVE', findings: [] }, await deps.observeReview(snapshot, 1), snapshot, 1)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
})

test('leak preflight preserves incomplete and clean outcomes at snapshot head', async () => {
  const f = await fixture()
  const { deps } = f.make()
  expect(await deps.runLeakGatePreflight(snapshot)).toMatchObject({ status: 'incomplete', head, skipped_rules: ['pii'] })
  f.clean()
  expect(await deps.runLeakGatePreflight(snapshot)).toMatchObject({ status: 'clean', head })
  expect(f.calls.some(argv => argv.includes('--detach') && argv.includes(head))).toBe(true)
})

test('complete diff size gate blocks oversized bytes', async () => {
  const { deps } = (await fixture()).make()
  expect(deps.assessMergeDiff('ok')).toEqual({ allow: true, measured_bytes: 2 })
  expect(deps.assessMergeDiff('x'.repeat(MERGE_DIFF_BYTES_MAX + 1))).toMatchObject({ allow: false })
})

test('mutation proof blocks missing nomination and pins the reviewed head', async () => {
  const f = await fixture()
  const { deps } = f.make()
  expect(await deps.publishGate(snapshot)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('nominated no mutation') })
  f.prose()
  expect(await deps.publishGate(snapshot)).toMatchObject({ kind: 'allow' })
  expect(await deps.publishGate({ ...snapshot, head: 'c'.repeat(40) })).toMatchObject({ kind: 'blocked', on: expect.stringContaining('branch tip') })
})

test('publication mutation uses the launch pin without probing mutable base refs', async () => {
  const f = await fixture()
  f.prose()
  const run = f.options.mutation.run_host
  f.options.mutation.run_host = async (argv, cwd) => {
    if (argv.includes('rev-parse') && argv.includes('--quiet')
      && argv.some(arg => arg === 'refs/remotes/origin/base^{commit}' || arg === 'refs/heads/base^{commit}')) {
      throw new Error('base ref probe must be lazy')
    }
    return run(argv, cwd)
  }
  expect(await f.make().deps.publishGate(snapshot)).toEqual({ kind: 'allow' })
  const diffs = f.calls.filter(argv => argv.includes('diff') && argv.includes('--name-status'))
  expect(diffs).toHaveLength(1)
  expect(diffs[0]).toContain(`${f.options.leak.base_sha}...${head}`)
})

test('CI red and wrong head block; absent, running and unreadable defer on exhaustion', async () => {
  const f = await fixture()
  for (const observation of [
    { kind: 'completed', headSha: head, conclusion: 'failure' },
    { kind: 'completed', headSha: 'other', conclusion: 'success' },
    { kind: 'configuration-error', headSha: head, reason: 'missing required check' },
  ] as const) {
    f.options.observeCi = async () => observation
    expect(await f.make().deps.mergeGate(published)).toMatchObject({ kind: 'blocked' })
  }
  for (const observation of [{ kind: 'absent' }, { kind: 'running', headSha: head }, { kind: 'unreadable', reason: 'offline' }] as const) {
    f.options.observeCi = async () => observation
    expect(await f.make().deps.mergeGate(published)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('budget exhausted') })
  }
  f.options.observeCi = async () => ({ kind: 'completed', headSha: head, conclusion: 'success' })
  expect(await f.make().deps.mergeGate(published)).toEqual({ kind: 'allow' })
})

test('base drift preserves uncertainty and blocks overlapping changes', async () => {
  const f = await fixture()
  f.setDrift('unreadable')
  expect(await f.make().deps.mergeGate(published)).toEqual({ kind: 'unknown', detail: 'Base drift could not be assessed' })
  f.setDrift('overlap')
  expect(await f.make().deps.mergeGate(published)).toEqual({ kind: 'blocked', on: 'Base drift overlaps reviewed changes' })
  f.setDrift('clear')
  expect(await f.make().deps.mergeGate(published)).toEqual({ kind: 'allow' })
})

const commandResult = (stdout = '', exit_code = 0) => ({ ok: exit_code === 0, exit_code, stdout, stderr: '' })

test('publication readiness measures local head, remote state and first-push ancestry', async () => {
  const f = await fixture()
  const baseRun = f.options.mutation.run_host
  const check = (run = baseRun, value = snapshot) => publicationReadiness(run, 'repo', 'change', 'main', 'b'.repeat(40), value, 'run')
  expect(await check()).toEqual({ kind: 'allow' })
  for (const result of [commandResult('', 128), commandResult('short')]) {
    expect(await check(async (argv, cwd) => argv.includes('rev-parse') ? result : baseRun(argv, cwd))).toMatchObject({ kind: 'unknown' })
  }
  expect(await check(baseRun, { ...snapshot, head: 'c'.repeat(40) })).toMatchObject({ kind: 'blocked' })
  for (const result of [commandResult('', 128), commandResult('not-an-oid refs/heads/change'), commandResult(`${head}\trefs/heads/other`)]) {
    expect(await check(async (argv, cwd) => argv.includes('ls-remote') ? result : baseRun(argv, cwd))).toMatchObject({ kind: 'unknown' })
  }
  for (const [code, kind] of [[1, 'blocked'], [128, 'unknown']] as const) {
    expect(await check(async (argv, cwd) => argv.includes('--is-ancestor') ? commandResult('', code) : baseRun(argv, cwd))).toMatchObject({ kind })
  }
  let ancestryCalls = 0
  expect(await check(async (argv, cwd) => {
    if (argv.includes('ls-remote')) return commandResult(`${head}\trefs/heads/change\n`)
    if (argv.includes('--is-ancestor')) { ancestryCalls++; return commandResult('', 1) }
    return baseRun(argv, cwd)
  })).toEqual({ kind: 'allow' })
  expect(ancestryCalls).toBe(0)
  expect(await check(async () => { throw new Error('offline') })).toMatchObject({ kind: 'unknown' })
})

test('publication thrown host cause is bounded and normal refusal text is unchanged', async () => {
  expect(await publicationReadiness(async () => { throw new Error('recognisable publication failure') }, 'repo', 'change', 'main', 'b'.repeat(40), snapshot, 'run')).toEqual({
    kind: 'unknown', detail: 'Publication host observation failed: Error: recognisable publication failure',
  })
  const f = await fixture()
  expect(await publicationReadiness(f.options.mutation.run_host, 'repo', 'change', 'main', 'b'.repeat(40), { ...snapshot, head: 'c'.repeat(40) }, 'run')).toEqual({
    kind: 'blocked', on: 'Publication branch differs from reviewed head',
  })
})

test('merge eligibility refuses absent, malformed, closed or mismatched review pins', async () => {
  const f = await fixture()
  for (const value of [snapshot, { ...published, head: 'short' },
    ...[0, -1, 1.5, NaN].map(number => ({ ...published, pr: { ...published.pr!, number } })),
    { ...published, pr: { ...published.pr!, state: 'CLOSED' as const } },
    { ...published, pr: { ...published.pr!, head: 'c'.repeat(40) } },
  ]) {
    expect(await pinnedMergeReadiness(f.options.mutation.run_host, 'repo', value, 'run')).toMatchObject({ kind: 'blocked' })
  }
  expect(await pinnedMergeReadiness(f.options.mutation.run_host, 'repo', published, 'run')).toEqual({ kind: 'allow' })
})

test('merge eligibility measures actual PR refs and rejects unreadable or foreign observations', async () => {
  const f = await fixture()
  const baseRun = f.options.mutation.run_host
  const pr = { headRefName: 'change', baseRefName: 'release', isCrossRepository: false, headRefOid: head, state: 'OPEN' }
  const cases = [
    { result: commandResult('', 1), kind: 'unknown' },
    { result: commandResult('not-json'), kind: 'unknown' },
    ...[null, {}, { ...pr, headRefName: '' }, { ...pr, baseRefName: '' }, { ...pr, isCrossRepository: null }]
      .map(value => ({ result: commandResult(JSON.stringify(value)), kind: 'unknown' })),
    ...[{ ...pr, isCrossRepository: true }, { ...pr, headRefOid: 'c'.repeat(40) }, { ...pr, state: 'CLOSED' }]
      .map(value => ({ result: commandResult(JSON.stringify(value)), kind: 'blocked' })),
  ]
  for (const { result, kind } of cases) {
    const run: typeof baseRun = (argv, cwd) => argv.includes('gh') ? Promise.resolve(result) : baseRun(argv, cwd)
    expect(await pinnedMergeReadiness(run, 'repo', published, 'run')).toMatchObject({ kind })
  }
  expect(await pinnedMergeReadiness(baseRun, 'repo', published, 'run')).toEqual({ kind: 'allow' })
  expect(f.calls).toContainEqual(['git', '-C', 'repo', 'fetch', 'origin', '+refs/heads/release:refs/remotes/origin/release', '+refs/heads/change:refs/remotes/origin/change'])
  expect(f.calls).toContainEqual(['git', '-C', 'repo', 'merge-base', 'refs/remotes/origin/release', 'refs/remotes/origin/change'])
})

test('merge eligibility preserves refresh, size and fetched-head gates', async () => {
  const f = await fixture()
  const baseRun = f.options.mutation.run_host
  for (const token of ['check-ref-format', 'fetch', 'diff']) {
    const run: typeof baseRun = (argv, cwd) => argv.includes(token) ? Promise.resolve(commandResult('', 128)) : baseRun(argv, cwd)
    expect(await pinnedMergeReadiness(run, 'repo', published, 'run')).toMatchObject({ kind: 'unknown' })
  }
  expect(await pinnedMergeReadiness(async (argv, cwd) => {
    if (!argv.includes('diff')) return baseRun(argv, cwd)
    await writeFile(argv.find(arg => arg.startsWith('--output='))!.slice('--output='.length), 'x'.repeat(MERGE_DIFF_BYTES_MAX + 1))
    return commandResult('truncated stdout')
  }, 'repo', published, 'run')).toMatchObject({ kind: 'blocked' })
  expect(await pinnedMergeReadiness(async (argv, cwd) => argv.includes('diff')
    ? commandResult('stdout is not a written diff') : baseRun(argv, cwd), 'repo', published, 'run')).toMatchObject({ kind: 'unknown' })
  expect(await pinnedMergeReadiness(async (argv, cwd) => argv.includes('rev-parse') && argv.some(arg => arg.includes('refs/remotes/origin/change'))
    ? commandResult('c'.repeat(40)) : baseRun(argv, cwd), 'repo', published, 'run')).toMatchObject({ kind: 'blocked', on: 'Fetched PR head differs from reviewed head' })
  expect(await pinnedMergeReadiness(async () => { throw new Error('offline') }, 'repo', published, 'run')).toMatchObject({ kind: 'unknown' })
  expect(await pinnedMergeReadiness(baseRun, 'repo', published, 'run')).toEqual({ kind: 'allow' })
})

test('merge thrown host cause is bounded and normal refusal text is unchanged', async () => {
  expect(await pinnedMergeReadiness(async () => { throw new Error('recognisable merge failure') }, 'repo', published, 'run')).toEqual({
    kind: 'unknown', detail: 'Merge host observation could not be decoded: Error: recognisable merge failure',
  })
  expect(await pinnedMergeReadiness(async () => commandResult(), 'repo', snapshot, 'run')).toEqual({
    kind: 'blocked', on: 'Merge requires a PR number and full reviewed head OID',
  })
})

test('host publication readiness is reached after a measured prose exemption', async () => {
  const f = await fixture()
  f.prose()
  const baseRun = f.options.mutation.run_host
  f.options.mutation.run_host = (argv, cwd) => argv.includes('--is-ancestor')
    ? Promise.resolve(commandResult('', 1)) : baseRun(argv, cwd)
  expect(await f.make().deps.publishGate(snapshot)).toEqual({ kind: 'blocked', on: 'Publication branch does not contain the pinned launch base' })
  f.options.mutation.run_host = baseRun
  expect(await f.make().deps.publishGate(snapshot)).toEqual({ kind: 'allow' })
})

test('host merge eligibility is reached after green CI', async () => {
  const f = await fixture()
  expect(await f.make().deps.mergeGate(snapshot)).toEqual({ kind: 'blocked', on: 'Merge requires an open PR at the reviewed head' })
  expect(await f.make().deps.mergeGate(published)).toEqual({ kind: 'allow' })
})


test('host admission and review reach authoritative policy sources', async () => {
  const f = await fixture()
  f.options.admission = {
    observe: async input => ({ runId: input.run_id, repo: 'repo', branch: 'change', baseBranch: 'main', prior: null }),
    run: async argv => commandResult(argv.includes('rev-parse') ? head : ''),
  }
  const payload = { verdict: 'APPROVE', findings: [] }
  f.options.review = {
    seats: [{ id: 'core', provider: 'pi', modelId: 'core-model', role: 'core', enabled: true }],
    readSeat: async (_seat, value, round) => ({ runId: 'test', head: value.head, round, provider: 'pi', modelId: 'core-model', status: 'completed', payload }),
    retrySeat: async () => { throw Error('unexpected retry') },
    readSynthesis: async (value, round) => ({ runId: 'test', head: value.head, round, checkpoint: 'argus-approved', payload }),
  }
  const host = f.make()
  expect(await host.deps.admissionGate(f.input(host))).toEqual({ kind: 'allow' })
  const progress: unknown[] = []
  expect(await host.deps.reviewGate(payload, await host.deps.observeReview(snapshot, 1), snapshot, 1, 0, value => progress.push(value))).toEqual({ kind: 'approve' })
  expect(progress).toEqual([{ findings: [], blockingCount: 0 }])
  f.options.review.readSynthesis = async () => null
  expect(await host.deps.reviewGate(payload, await host.deps.observeReview(snapshot, 1), snapshot, 1)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('infra-only:') })
})

test('fresh null reviewed_head reaches allow and publishes through the driver', async () => {
  const f = await fixture()
  f.prose()
  f.clean()
  const payload = { verdict: 'APPROVE', findings: [] }
  f.options.admission = {
    observe: async input => ({ runId: input.run_id, repo: 'repo', branch: 'change', baseBranch: 'main', prior: null }),
    run: async argv => commandResult(argv.includes('rev-parse') ? head : ''),
  }
  f.options.review = {
    seats: [{ id: 'core', provider: 'pi', modelId: 'core-model', role: 'core', enabled: true }],
    readSeat: async (_seat, value, round) => ({ runId: 'test', head: value.head, round, provider: 'pi', modelId: 'core-model', status: 'completed', payload }),
    retrySeat: async () => { throw Error('unexpected retry') },
    readSynthesis: async (value, round) => ({ runId: 'test', head: value.head, round, checkpoint: 'argus-approved', payload }),
  }
  f.options.runners.pi = {
    ...fakeRunner('pi'),
    run: async request => ({ kind: 'completed', result: { ...snapshot, payload: request.role === 'plan' ? singlePlan : payload }, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test-model', thread_id: null }),
  }
  let publications = 0
  f.options.effects.publish = async value => { expect(value).toEqual(snapshot); publications++ }
  const host = f.make()
  expect(f.options.reviewed_head).toBeNull()
  expect(await host.deps.publishGate(snapshot)).toEqual({ kind: 'allow' })
  // Stop after publication: this fixture deliberately does not create a remote PR.
  expect(await buildRun(f.input(host), host.deps, new AbortController().signal)).toEqual({
    kind: 'blocked', phase: 'publish', on: 'Published PR does not match candidate revision', recipient: 'orchestrator',
  })
  expect(publications).toBe(1)
})

// Usage attribution is covered through the durable project host in attempt-accounting.test.ts.
test('host propagates G084 refusals after proof and readiness allow', async () => {
  const f = await fixture()
  f.prose()
  const pin = 'd'.repeat(40)
  const baseRun = f.options.mutation.run_host
  f.options.reviewed_head = 'deadbeef'
  expect(await f.make().deps.publishGate(snapshot)).toMatchObject({ kind: 'blocked', on: expect.stringContaining('not a full') })
  f.options.reviewed_head = pin
  for (const [stderr, kind] of [['', 'blocked'], ['fatal: missing object', 'unknown']] as const) {
    f.options.mutation.run_host = (argv, cwd) => argv.includes('--is-ancestor') && argv.includes(pin)
      ? Promise.resolve({ ok: false, exit_code: stderr ? 128 : 1, stdout: '', stderr }) : baseRun(argv, cwd)
    expect(await f.make().deps.publishGate(snapshot)).toMatchObject({ kind })
  }
  f.options.mutation.run_host = baseRun
  expect(await f.make().deps.publishGate(snapshot)).toEqual({ kind: 'allow' })
})

test('publication refusal retains bounded control diagnostics without raw branch output', async () => {
  const f = await fixture()
  const claim = { file: 'src/code.ts', find: 'original', replace: 'broken',
    guard: ['bun', 'test', 'guard.test.ts'], control: ['bun', 'test', 'control.test.ts'] }
  const { MUTATION_PROOF_SCHEMA, MUTATION_PROVER_VERSION } = await import('./mutation-prover.ts')
  const observation = { argv: claim.guard, exit_code: 1, timed_out: false,
    output_sha256: 'c'.repeat(64), failure_kind: 'database-schema-mismatch' as const }
  f.options.mutation.readClaim = async () => claim
  f.options.mutation.prover = {
    prove: async () => ({ schema: MUTATION_PROOF_SCHEMA, prover_version: MUTATION_PROVER_VERSION,
      run_id: 'test', claimed: claim, proof_token: 'd'.repeat(64), proved: false,
      reason: 'the control did not stay GREEN under the mutation', observed: {
        head_sha: head, file: claim.file, file_sha256_before: 'a'.repeat(64), file_sha256_mutated: 'b'.repeat(64),
        file_sha256_restored: 'a'.repeat(64), guard_mutated: observation, control_mutated: { ...observation, argv: claim.control },
        guard_restored: { ...observation, exit_code: 0 },
      } }),
    verify: () => ({ ok: false, reason: 'evidence does not claim proved' }),
  }
  const verdict = await f.make().deps.publishGate(snapshot)
  expect(verdict.kind).toBe('blocked')
  if (verdict.kind !== 'blocked') throw new Error('expected refusal')
  expect(verdict.on).toContain('control_mutated: exit=1, timed_out=false, kind=database-schema-mismatch')
  expect(verdict.on).toContain(`output_sha256=${'c'.repeat(64)}`)
  expect(verdict.on.length).toBeLessThan(1000)
})

test('local host gates use local evidence without remote publication or CI', async () => {
  const f = await fixture(); f.prose()
  f.options.local = { baseBranch: 'base', worktree: f.options.leak.repo_path }
  const baseRun = f.options.mutation.run_host
  f.options.admission = {
    observe: async () => ({ runId: 'test', repo: f.options.leak.repo_path, branch: 'change', baseBranch: 'base', prior: null }),
    run: async (argv, cwd) => argv.includes('show-ref') ? commandResult() : baseRun(argv, cwd),
  }
  f.options.local.worktree = join(f.options.leak.repo_path, 'isolated')
  f.options.mutation.run_host = async (argv, cwd) => {
    if (argv.includes('--show-toplevel')) return commandResult(f.options.local!.worktree)
    if (argv.includes('--git-common-dir')) return commandResult('common')
    return baseRun(argv, cwd)
  }
  f.options.observeCi = async () => { throw new Error('local mode queried remote CI') }
  const composed = f.make()
  const { deps } = composed
  expect(await deps.admissionGate({ ...f.input(composed), merge_mode: 'local' })).toEqual({ kind: 'allow' })
  expect(await deps.publishGate(snapshot, 'local')).toEqual({ kind: 'allow' })
  expect(await deps.mergeGate(snapshot, 'local')).toEqual({ kind: 'allow' })
  expect(f.calls.some(argv => argv.includes('ls-remote') || argv.includes('gh') || argv.includes('fetch'))).toBe(false)
  f.setDrift('overlap')
  expect(await deps.mergeGate(snapshot, 'local')).toMatchObject({ kind: 'blocked', on: 'Local base drift overlaps reviewed changes' })
  f.setDrift('unreadable')
  expect(await deps.mergeGate(snapshot, 'local')).toMatchObject({ kind: 'unknown' })
  delete f.options.local
  expect(await deps.mergeGate(snapshot, 'local')).toMatchObject({ kind: 'unknown', detail: 'Local merge configuration is missing' })
  delete f.options.admission
  expect(await deps.admissionGate({ ...f.input(composed), merge_mode: 'local' })).toMatchObject({ kind: 'unknown', detail: 'Project admission observation source is missing' })
})

test('local host confirmation measures retained branch and base ancestry', async () => {
  const f = await fixture()
  f.options.local = { baseBranch: 'base', worktree: 'isolated' }
  const baseRun = f.options.mutation.run_host
  f.options.admission = {
    observe: async () => ({ runId: 'test', repo: f.options.leak.repo_path, branch: 'change', baseBranch: 'base', prior: null }),
    run: async (argv, cwd) => argv.includes('show-ref') ? commandResult() : baseRun(argv, cwd),
  }
  for (const code of [0, 1, 128]) {
    f.options.mutation.run_host = (argv, cwd) => argv.includes('--is-ancestor') ? Promise.resolve(commandResult('', code)) : baseRun(argv, cwd)
    expect(await f.make().deps.confirmLocalMerge!(snapshot)).toMatchObject({ kind: code === 0 ? 'allow' : code === 1 ? 'blocked' : 'unknown' })
  }
  f.options.mutation.run_host = async () => commandResult('b'.repeat(40))
  expect(await f.make().deps.confirmLocalMerge!(snapshot)).toMatchObject({ kind: 'blocked' })
  f.options.mutation.run_host = async () => commandResult('', 128)
  expect(await f.make().deps.confirmLocalMerge!(snapshot)).toMatchObject({ kind: 'unknown', detail: 'Local branch confirmation could not be read' })
  delete f.options.local
  expect(await f.make().deps.confirmLocalMerge!(snapshot)).toMatchObject({ kind: 'unknown', detail: 'Local merge configuration is missing' })
})


test('composed local host reaches merged with no PR', async () => {
  const f = await fixture(); f.prose(); f.clean()
  f.options.local = { baseBranch: 'base', worktree: join(f.options.leak.repo_path, 'isolated') }
  const baseRun = f.options.mutation.run_host
  f.options.admission = {
    observe: async () => ({ runId: 'test', repo: f.options.leak.repo_path, branch: 'change', baseBranch: 'base', prior: null }),
    run: async (argv, cwd) => argv.includes('show-ref') ? commandResult() : baseRun(argv, cwd),
  }
  let landed = false
  f.options.mutation.run_host = async (argv, cwd) => {
    if (argv.includes('--show-toplevel')) return commandResult(f.options.local!.worktree)
    if (argv.includes('--git-common-dir')) return commandResult('common')
    if (argv.includes('--is-ancestor')) return commandResult('', landed ? 0 : 1)
    return baseRun(argv, cwd)
  }
  const payload = { verdict: 'APPROVE', findings: [] }
  const outcomes = new Map<string, import('@neutronai/runtime/bounded-work.ts').BoundedWorkOutcome>()
  for (const [role, round] of [['plan', 0], ['build', 0], ['review', 1]] as const) {
    outcomes.set(`test:${role}:${round}${role === 'review' ? `:head:${head}` : ''}`, { kind: 'completed', result: { ...snapshot, payload: role === 'plan' ? singlePlan : payload },
      usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test-model', thread_id: null })
  }
  f.options.runners.pi = fakeRunner('pi', { outcomes })
  f.options.review = {
    seats: [{ id: 'core', provider: 'pi', modelId: 'test-model', role: 'core', enabled: true }],
    readSeat: async () => ({ runId: 'test', head, round: 1, provider: 'pi', modelId: 'test-model', status: 'completed', payload }),
    retrySeat: async () => {},
    readSynthesis: async () => ({ runId: 'test', head, round: 1, checkpoint: 'argus-approved', payload }),
  }
  f.options.effects.merge = async () => { landed = true }
  f.options.observeCi = async () => { throw new Error('unexpected remote CI') }
  const composed = f.make()
  expect(await buildRun({ ...f.input(composed), merge_mode: 'local' }, composed.deps, new AbortController().signal)).toMatchObject({ kind: 'merged', snapshot: { pr: null } })
  expect(landed).toBe(true)
})

test('fresh local admission allows the host to provision its branch and worktree later', async () => {
  const f = await fixture()
  const baseRun = f.options.mutation.run_host
  f.options.admission = {
    observe: async () => ({ runId: 'test', repo: f.options.leak.repo_path, branch: 'new-change', baseBranch: 'base', prior: null }),
    run: async (argv, cwd) => argv.includes('show-ref') ? commandResult('', 1) : baseRun(argv, cwd),
  }
  f.options.effects.measure = async () => { throw new Error('branch has not been provisioned yet') }
  const composed = f.make()
  expect(await composed.deps.admissionGate({ ...f.input(composed), merge_mode: 'local' })).toEqual({ kind: 'allow' })
})

test('review composition carries host re-plan usage independently of worker data', async () => {
  const f = await fixture()
  const payload = { verdict: 'REQUEST_CHANGES', findings: [], escalate: { kind: 'design-gap', whatIsMissing: 'execution spec needs revision' } }
  f.options.review = {
    seats: [{ id: 'core', provider: 'pi', modelId: 'test', role: 'core', enabled: true }],
    readSeat: async () => ({ runId: 'test', head, round: 1, provider: 'pi', modelId: 'test', status: 'completed', payload }),
    retrySeat: async () => {},
    readSynthesis: async () => ({ runId: 'test', head, round: 1, checkpoint: 'reviewed', payload }),
  }
  const { deps } = f.make()
  expect(await deps.reviewGate(payload, await deps.observeReview(snapshot, 1), snapshot, 1, 0)).toMatchObject({ kind: 're-plan' })
  expect(await deps.reviewGate(payload, await deps.observeReview(snapshot, 1), snapshot, 1, 1)).toMatchObject({ kind: 'blocked' })
})

async function boundFixture(failure = false, keepMergeGate = false) {
  const f = await fixture()
  const effects: string[] = []
  const commands: string[][] = []
  let panels = 0
  let current = structuredClone(snapshot)
  const runner = fakeRunner('pi')
  runner.run = async request => {
    effects.push(request.role)
    return { kind: 'completed', result: { ...structuredClone(current), payload: request.role === 'plan' ? singlePlan : null }, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null }
  }
  f.options.runners = { pi: runner }
  f.options.effects = {
    prepareWork: async (request, context) => {
      // Match the production context materialization consumed by the host gate.
      await writeFile(`${request.brief.path}.context.json`, JSON.stringify({ request, ...context }))
    },
    measure: async () => ({ kind: 'known', value: structuredClone(current) }),
    publish: async () => { effects.push('publish'); current = structuredClone(published) },
    merge: async () => { effects.push('merge'); current.pr!.state = 'MERGED' },
  }
  f.options.boundReview = {
    run: makeTridentRun({ id: 'test', bound_pr: 12, repo_path: f.options.leak.repo_path }),
    deps: {
      scratch_path: join(f.options.leak.repo_path, 'detached'),
      run_host: async argv => {
        commands.push(argv)
        let stdout = ''
        if (argv[0] === 'gh' && argv[2] === 'view') stdout = JSON.stringify({ headRefOid: head, headRefName: 'existing', baseRefName: 'main' })
        if (argv[0] === 'gh' && argv[2] === 'diff') stdout = '+code'
        if (argv.includes('merge-base')) stdout = 'b'.repeat(40)
        return { ok: true, stdout, stderr: '', exit_code: 0 }
      },
      run_review_panel: async () => {
        panels++
        return { ok: !failure, verdict: failure ? null : 'APPROVE', findings: [], reviewed_sha: head, block_kind: null, terminal_cause: null }
      },
    },
  }
  const host = f.make()
  // Reachable permissive build control: a routing regression must actually build,
  // publish and merge, rather than stop at an unrelated admission or leak gate.
  host.deps.admissionGate = async () => ({ kind: 'allow' })
  host.deps.reviewGate = async (_payload, _observation, _snapshot, _round, _used, record) => { record?.({ findings: [], blockingCount: 0 }); return { kind: 'approve' } }
  host.deps.runLeakGatePreflight = async () => ({ status: 'clean', head, findings: [], skipped_rules: [], attempts: 0, note: '' })
  host.deps.publishGate = async () => ({ kind: 'allow' })
  if (!keepMergeGate) host.deps.mergeGate = async () => ({ kind: 'allow' })
  const input: BuildRunInput = { ...f.input(host), mode: 'bound_pr', bound_pr: 12 }
  return { host, input, effects, commands, options: f.options, panels: () => panels }
}

for (const settles of ['green', 'red', 'pending', 'abort'] as const) {
  test(`refreshed merge CI ${settles} preserves one approved build and host suite`, async () => {
    const f = await boundFixture(false, true)
    const controller = new AbortController()
    let suites = 0, probes = 0, elapsed = 0
    const waits: number[] = []
    const checkpoints: { stage: string; round: number }[] = []
    f.options.modes!.saveCheckpoint = async value => { checkpoints.push(value) }
    f.options.publicationSuite.observe = async (snapshot, round) => {
      suites++
      return { kind: 'known', runId: 'test', head: snapshot.head, round,
        strategy: 'full test suite', scope: 'full-suite', report: { hostExitCode: 0 } }
    }
    f.options.mergeReadinessClock = {
      now: () => elapsed,
      wait: async ms => {
        waits.push(ms); elapsed += ms
        if (settles === 'abort') controller.abort()
      },
    }
    f.options.observeCi = async value => {
      expect(value).toEqual(published)
      expect(suites).toBe(1)
      expect(checkpoints.at(-1)).toMatchObject({ stage: 'approved', round: 1 })
      probes++
      return probes === 1 || settles === 'pending' || settles === 'abort'
        ? { kind: 'running', headSha: head }
        : { kind: 'completed', headSha: head, conclusion: settles === 'green' ? 'success' : 'failure' }
    }
    const outcome = await f.host.run({ ...f.input, mode: 'implementation', merge_mode: 'pr' }, controller.signal)
    expect(outcome).toMatchObject(settles === 'green' ? { kind: 'merged' }
      : settles === 'red' ? { kind: 'blocked', phase: 'merge', on: 'CI: red' }
        : { kind: 'unknown', phase: 'merge', detail: expect.stringContaining(settles === 'abort' ? 'cancelled' : 'budget exhausted') })
    expect(suites).toBe(1)
    expect(f.effects).toEqual(['plan', 'build', 'publish', 'review', ...(settles === 'green' ? ['merge'] : [])])
    expect(waits).toEqual(Array(settles === 'pending' ? 30 : 1).fill(30000))
    expect(probes).toBe(settles === 'pending' ? 30 : settles === 'abort' ? 1 : 2)
  })
}

for (const change of ['head', 'closed', 'base-overlap', 'base-unreadable', 'conflict', 'stable-base'] as const) {
  test(`refreshed merge CI reassesses ${change} after waiting`, async () => {
    const f = await fixture()
    let refreshed = false
    let elapsed = 0
    f.options.mergeReadinessClock = { now: () => elapsed, wait: async ms => { elapsed += ms; refreshed = true } }
    f.options.observeCi = async () => ({ kind: refreshed && change !== 'conflict' ? 'completed' : 'running', headSha: head, conclusion: 'success' })
    const run = f.options.mutation.run_host
    f.options.mutation.run_host = async (argv, cwd, env, timeout) => {
      if (refreshed) {
        if (change === 'base-overlap') f.setDrift('overlap')
        if (change === 'base-unreadable') f.setDrift('unreadable')
        if (argv.includes('gh') && (change === 'head' || change === 'closed')) {
          return commandResult(JSON.stringify({ headRefName: 'change', baseRefName: 'release', isCrossRepository: false,
            headRefOid: change === 'head' ? 'c'.repeat(40) : head, state: change === 'closed' ? 'CLOSED' : 'OPEN' }))
        }
      }
      return run(argv, cwd, env, timeout)
    }
    if (change === 'conflict') {
      const observe = f.options.reviewReadiness!.observe
      f.options.reviewReadiness!.observe = async (value, signal) => refreshed
        ? { kind: 'known', head, configuration: { kind: 'resolved', required: ['checks'] }, mergeability: 'conflicting', checksComplete: true, checks: [] }
        : observe(value, signal)
    }
    const outcome = await f.make().deps.mergeGate(published)
    expect(outcome).toMatchObject({ kind: change === 'stable-base' ? 'allow' : change === 'base-unreadable' ? 'unknown' : 'blocked' })
    expect(elapsed).toBe(30000)
    expect(f.calls.filter(argv => argv.includes('fetch'))).toHaveLength(change === 'head' || change === 'closed' ? 1 : 2)
  })
}

test('refreshed merge CI cannot merge a different PR selected during the wait', async () => {
  const f = await boundFixture(false, true)
  const measure = f.options.effects.measure
  let changed = false, elapsed = 0, probes = 0
  // The host captured effects at construction; replace its measurement dependency.
  f.host.deps.measure = async () => {
    const value = await measure()
    if (changed && value.kind === 'known' && value.value.pr) value.value.pr.number++
    return value
  }
  f.options.mergeReadinessClock = { now: () => elapsed, wait: async ms => { elapsed += ms; changed = true } }
  f.options.observeCi = async () => ++probes === 1
    ? { kind: 'running', headSha: head } : { kind: 'completed', headSha: head, conclusion: 'success' }
  expect(await f.host.run({ ...f.input, mode: 'implementation', merge_mode: 'pr' }, new AbortController().signal))
    .toMatchObject({ kind: 'blocked', phase: 'merge', on: 'Revision changed during merge gates' })
  expect(f.effects).toEqual(['plan', 'build', 'publish', 'review'])
})

for (const changesBase of [false, true]) {
  test(`merge CI ${changesBase ? 'discards' : 'accepts'} green when base ${changesBase ? 'moves' : 'stays'} during acquisition`, async () => {
    const f = await fixture()
    let base = 'b'.repeat(40), elapsed = 0, probes = 0
    const waits: number[] = []
    f.options.mergeReadinessClock = { now: () => elapsed, wait: async ms => { waits.push(ms); elapsed += ms } }
    const run = f.options.mutation.run_host
    f.options.mutation.run_host = async (argv, cwd, env, timeout) => {
      const result = await run(argv, cwd, env, timeout)
      if (argv.includes('headRefOid,baseRefOid,state')) return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), baseRefOid: base }) }
      return result
    }
    f.options.observeCi = async () => {
      probes++
      if (changesBase && probes === 1) base = 'c'.repeat(40)
      // The first green result describes the old base. Its replacement checks are
      // still running on the next acquisition, so using it would merge too early.
      return probes === 2 ? { kind: 'running', headSha: head } : { kind: 'completed', headSha: head, conclusion: 'success' }
    }
    expect(await f.make().deps.mergeGate(published)).toEqual({ kind: 'allow' })
    expect(probes).toBe(changesBase ? 3 : 1)
    expect(waits).toEqual(changesBase ? [30000, 30000] : [])
  })
}

test('merge readiness refuses an unreadable base revision', async () => {
  const f = await fixture(), run = f.options.mutation.run_host
  for (const baseRefOid of [undefined, '', 'short']) {
    f.options.mutation.run_host = async (argv, cwd, env, timeout) => {
      const result = await run(argv, cwd, env, timeout)
      return argv.includes('headRefOid,baseRefOid,state')
        ? { ...result, stdout: JSON.stringify({ headRefOid: head, state: 'OPEN', baseRefOid }) } : result
    }
    expect(await f.make().deps.mergeGate(published)).toEqual({ kind: 'unknown', detail: 'Merge PR base revision is missing or malformed' })
  }
})

for (const failure of [false, true]) {
  test(`G019 host retained review ${failure ? 'failure' : 'success'} terminates without build publish or merge`, async () => {
    const f = await boundFixture(failure)
    const outcome = await f.host.run(f.input, new AbortController().signal)
    expect(f.panels()).toBe(1)
    expect(f.effects).toEqual([])
    expect(outcome).toMatchObject({ status: failure ? 'failure' : 'success', pr: 12 })
  })
}

test('G019 routing fixture positive control reaches build publish and merge for pr mode', async () => {
  const f = await boundFixture()
  expect(await f.host.run({ ...f.input, mode: 'implementation', merge_mode: 'pr' }, new AbortController().signal)).toMatchObject({ kind: 'merged' })
  expect(f.effects).toEqual(['plan', 'build', 'publish', 'review', 'merge'])
  expect(f.panels()).toBe(0)
})

for (const mismatch of ['missing', 'run', 'pr'] as const) {
  test(`G019 host rejects ${mismatch} bound review context`, async () => {
    const f = await boundFixture()
    if (mismatch === 'run') f.input.run_id = 'different'
    if (mismatch === 'pr') f.input.bound_pr = 13
    if (mismatch === 'missing') {
      const base = await fixture()
      f.host = base.make()
    }
    expect(await f.host.run(f.input, new AbortController().signal)).toMatchObject({ kind: 'blocked', phase: 'review', on: 'Bound review context is missing or mismatched' })
    expect(f.panels()).toBe(0)
    expect(f.commands).toEqual([])
    expect(f.effects).toEqual([])
  })
}

for (const failure of ['missing-gate', 'worktree', 'throw'] as const) {
  test(`leak preflight reports unknown when ${failure} prevents a scan`, async () => {
    const f = await fixture()
    const run = f.options.leak.run_host
    let scans = 0
    f.options.leak.run_host = async (argv, ...rest) => {
      if (failure === 'missing-gate' && argv[0] === 'test') return { ok: false, exit_code: 1, stdout: '', stderr: '' }
      if (failure === 'worktree' && argv.includes('add')) return { ok: false, exit_code: 128, stdout: '', stderr: 'worktree unavailable' }
      if (argv.includes('bash')) {
        scans++
        if (failure === 'throw') throw new Error('scanner unavailable')
      }
      return run(argv, ...rest)
    }
    const result = await f.make().deps.runLeakGatePreflight(snapshot)
    expect(result.status).toBe('unknown')
    expect(result.note.length).toBeGreaterThan(0)
    expect(scans).toBe(failure === 'throw' ? 1 : 0)
  })
}
for (const status of ['findings-unresolved', 'gate-error'] as const) {
  test(`leak preflight preserves observed ${status} for advisory publication`, async () => {
    const f = await fixture()
    const run = f.options.leak.run_host
    f.options.leak.run_host = async (argv, ...rest) => argv.includes('bash')
      ? { ok: false, exit_code: status === 'gate-error' ? 2 : 1,
          stdout: status === 'gate-error' ? '' : 'LEAK GATE: FAIL\n  [vocabulary] README.md:7:sample', stderr: 'scan report' }
      : run(argv, ...rest)
    const result = await f.make().deps.runLeakGatePreflight(snapshot)
    expect(result.status).toBe(status)
    if (status === 'findings-unresolved') expect(result.findings).toEqual([{ rule: 'vocabulary', file: 'README.md', line: 7 }])
  })
}

test('host review readiness uses independent facts and fails closed when unwired', async () => {
  const f = await fixture()
  expect(await f.make().deps.reviewReadiness!(snapshot, new AbortController().signal)).toEqual({ kind: 'allow' })
  f.options.reviewReadiness = { observe: async () => ({ kind: 'unknown', detail: 'required configuration unreadable' }) }
  expect(await f.make().deps.reviewReadiness!(snapshot, new AbortController().signal)).toEqual({ kind: 'unknown', detail: 'required configuration unreadable' })
  delete f.options.reviewReadiness
  expect(await f.make().deps.reviewReadiness!(snapshot, new AbortController().signal)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('source is missing') })
})

test('host composes suite observations with host run and round identity', async () => {
  const f = await fixture()
  expect(await f.make().deps.reviewSuite!(snapshot, 2)).toEqual({ kind: 'known', findings: [] })
  f.options.reviewSuite = { observe: async (subject, round) => ({ kind: 'known', runId: 'test', head: subject.head, round, strategy: 'full suite', scope: 'full-suite', report: { hostExitCode: 1, suiteOutcome: 'not-run' } }) }
  expect(await f.make().deps.reviewSuite!(snapshot, 2)).toMatchObject({ kind: 'known', findings: [{ title: 'FULL SUITE NOT PROVEN', advisory: false }] })
  f.options.mutation.run.id = 'other'
  expect(await f.make().deps.reviewSuite!(snapshot, 2)).toMatchObject({ kind: 'unknown' })
  delete f.options.reviewSuite
  expect(await f.make().deps.reviewSuite!(snapshot, 2)).toMatchObject({ kind: 'unknown' })
})

for (const cap of [undefined, 2, 7]) {
  test(`G076 host threads run row cap ${String(cap)} into the driver`, async () => {
    const f = await fixture()
    f.options.mutation.run.max_rounds = cap
    const calls: string[] = []
    // G042 stops a fix round that leaves the measured head where it was, so this
    // fixer moves the head the way a real one does. Without it the run ends on
    // lost work instead of on the cap this test exists to count.
    let pr: BuildSnapshot['pr'] = null
    let landed = 0
    const head = () => landed === 0 ? snapshot.head : `${'c'.repeat(39)}${landed % 10}`
    f.options.runners.pi = {
      ...fakeRunner('pi'),
      run: async request => {
        calls.push(request.step_id)
        if (request.role === 'fix') landed++
        return { kind: 'completed', result: { ...snapshot, head: head(), pr,
          payload: request.role === 'plan' ? singlePlan : { round: 0, max_rounds: 100 } },
          usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null }
      },
    }
    const host = f.make()
    host.deps.admissionGate = async () => ({ kind: 'allow' })
    host.deps.measure = async () => ({ kind: 'known', value: { ...snapshot, head: head(), pr } })
    // Publication now precedes review. Script its policy/effect while this test
    // measures only the persisted cap and keeps the PR at the published head.
    host.deps.publishGate = async () => ({ kind: 'allow' })
    host.deps.publish = async candidate => { pr = { number: 1, head: candidate.head, state: 'OPEN' } }
    host.deps.runLeakGatePreflight = async candidate => ({ status: 'clean', head: candidate.head, findings: [], skipped_rules: [], attempts: 0, note: '' })
    // Readiness observes its own revision and refuses one that has moved; this
    // test moves the head deliberately, so readiness is scripted here and is
    // certified by its own tests instead.
    host.deps.reviewReadiness = async () => ({ kind: 'allow' })
    // A real panel reports its findings to the host; this stub must too, or the
    // driver's progress gate has nothing to read and this test stops on that
    // instead of on the cap it exists to measure.
    host.deps.reviewGate = async (_payload, _observation, _snapshot, round, _used, record) => {
      record?.({ findings: [`bug-${round}`], blockingCount: 0 })
      return { kind: 'fix', findings: [`bug-${round}`] }
    }
    expect(await host.run(f.input(host), new AbortController().signal)).toMatchObject({
      kind: 'blocked', on: expect.stringContaining('round ceiling'),
    })
    expect(calls.filter(call => call.includes(':review:'))).toEqual(
      Array.from({ length: cap ?? 10 }, (_, i) => `test:review:${i + 1}:head:${i === 0 ? snapshot.head : `${'c'.repeat(39)}${i % 10}`}`))
  })
}

test('G076 host refuses a missing or mismatched cap row', async () => {
  for (const missing of [false, true]) {
    const f = await fixture()
    if (missing) f.options.mutation.run = undefined as unknown as BuildHostOptions['mutation']['run']
    else f.options.mutation.run.id = 'other-run'
    const host = f.make()
    host.deps.admissionGate = async () => ({ kind: 'allow' })
    expect(await host.run(f.input(host), new AbortController().signal)).toMatchObject({
      kind: 'unknown', detail: 'Review round cap run row is missing or mismatched',
    })
  }
})

test('G100 composed host preserves a real Git branch before reporting conflict', async () => {
  const f = await fixture()
  const repo = f.options.mutation.run.repo_path
  const remote = join(repo, 'origin.git')
  const run: BuildHostOptions['mutation']['run_host'] = async (argv, cwd) => {
    const child = Bun.spawn(argv, { cwd: cwd ?? repo, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit_code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { ok: exit_code === 0, stdout, stderr, exit_code }
  }
  const git = async (...args: string[]) => {
    const result = await run(['git', ...args], repo)
    expect(result.ok).toBe(true)
    return result.stdout.trim()
  }
  await git('init', '-b', 'change')
  await git('init', '--bare', remote)
  await git('remote', 'add', 'origin', remote)
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base')
  const old = await git('rev-parse', 'HEAD')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'built')
  const built = await git('rev-parse', 'HEAD')
  f.options.mutation.run_host = run
  // #1133 (G166): the composed host hands the preservation push the run's launch base (the
  // same `leak.base_sha` pin `publishGate` scans from), so the scan window is base..built.
  f.options.leak.base_sha = old
  const deps = f.make().deps
  expect(await deps.checkBuildClaim!(old.slice(0, 7), { ...snapshot, head: built })).toEqual({ kind: 'blocked', on: expect.stringContaining('; branch preserved on origin') })
  expect(await git('--git-dir', remote, 'rev-parse', 'refs/heads/change')).toBe(built)
  expect(await git('rev-parse', 'refs/heads/change')).toBe(built)
  expect(await deps.checkBuildClaim!(built.slice(0, 7), { ...snapshot, head: built })).toEqual({ kind: 'allow' })
  expect(await deps.checkBuildClaim!('deadbeef', { ...snapshot, head: built })).toEqual({ kind: 'allow' })
})

test('G100/G166 composed host threads the launch base into the preservation scan: a carrier is preserved and named', async () => {
  const f = await fixture()
  const repo = f.options.mutation.run.repo_path
  const remote = join(repo, 'origin.git')
  const run: BuildHostOptions['mutation']['run_host'] = async (argv, cwd) => {
    const child = Bun.spawn(argv, { cwd: cwd ?? repo, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit_code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { ok: exit_code === 0, stdout, stderr, exit_code }
  }
  const git = async (...args: string[]) => {
    const result = await run(['git', ...args], repo)
    expect(result.ok).toBe(true)
    return result.stdout.trim()
  }
  await git('init', '-b', 'change')
  await git('init', '--bare', remote)
  await git('remote', 'add', 'origin', remote)
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base')
  const old = await git('rev-parse', 'HEAD')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'built', '-m', 'Claude-Session: https://claude.ai/code/session_01HOST')
  const built = await git('rev-parse', 'HEAD')
  f.options.mutation.run_host = run
  f.options.leak.base_sha = old
  const deps = f.make().deps
  // Owner decision 2026-09-19: G100 preserves; the G166 scan on this path names the carrier.
  expect(await deps.checkBuildClaim!(old.slice(0, 7), { ...snapshot, head: built })).toEqual({
    kind: 'blocked',
    on: expect.stringContaining(`; branch preserved on origin; preserved range: Publication branch carries a Claude-Session trailer on 1 commit(s) above the launch base: ${built}`),
  })
  expect(await git('--git-dir', remote, 'rev-parse', 'refs/heads/change')).toBe(built)
})

test('G023 host derives branch assignment from the run', async () => {
  const f = await fixture()
  f.options.mutation.run.branch = 'assigned'
  expect(f.make().deps.assignedBranch).toBe('assigned')
  f.options.mutation.run.branch = null
  expect(f.make().deps.assignedBranch).toBe(`trident/${f.options.mutation.run.slug}`)
})

test('G055 G056 host composes measured CI with its pinned base', async () => {
  const f = await fixture()
  f.options.reviewCi = { observe: async value => ({ kind: 'known', head: value.head, status: 'red', failing: ['unit'], base: { head: f.options.leak.base_sha, status: 'red', failing: ['unit'] } }) }
  expect(await f.make().deps.reviewCi!(snapshot)).toMatchObject({ kind: 'known', findings: [{ advisory: true }] })
  f.options.reviewCi = { observe: async () => ({ kind: 'unknown', detail: 'CI unavailable' }) }
  expect(await f.make().deps.reviewCi!(snapshot)).toMatchObject({ kind: 'unknown' })
})

// A LOCAL RUN HAS NO PR, SO G055 MUST NOT ASK FOR ONE.
//
// `createProjectObservationSources`' CI source reads its rows off `snapshot.pr`
// (`project-observation-sources.ts:32`) and `readPr` pins that to `null` for a local
// run by construction (`production-host-effects.ts:183-185`). So G055 answered
// `Review readiness PR or full head is missing` — `unknown`, which is fail-closed —
// for EVERY local build. `merge_mode` defaults to `'local'` (`trident/store.ts:867`),
// so the DEFAULT mode could not reach review at all.
//
// The `pr` mode arm is the positive control: the same source, the same snapshot, must
// still be consulted and must still be able to answer `unknown`. Without it this would
// pass just as well if local routing swallowed every mode.
test('G055 a local run reports no CI to observe, while pr mode still consults the source', async () => {
  const f = await fixture()
  let consulted = 0
  f.options.reviewCi = { observe: async () => { consulted++; return { kind: 'unknown', detail: 'CI unavailable' } } }
  const host = f.make()

  // Local: answered without consulting a source that cannot describe a local run.
  expect(await host.deps.reviewCi!({ ...snapshot, pr: null }, 'local')).toEqual({ kind: 'known', findings: [] })
  expect(consulted).toBe(0)

  // pr: the source is consulted and its `unknown` still propagates.
  expect(await host.deps.reviewCi!(snapshot, 'pr')).toMatchObject({ kind: 'unknown' })
  expect(consulted).toBe(1)
})

test('G084 host composes live lineage independently of the constructor pin', async () => {
  const f = await fixture()
  const host = f.make()
  expect(f.options.reviewed_head).toBeNull()
  for (const pin of ['b'.repeat(40), 'c'.repeat(40)]) {
    expect(await host.deps.checkFixLineage!(snapshot, pin)).toEqual({ kind: 'allow' })
    expect(f.calls.at(-1)).toEqual(['git', '-C', f.options.mutation.run.repo_path, 'merge-base', '--is-ancestor', pin, head])
  }
  expect(await host.deps.checkFixLineage!(snapshot, 'deadbeef')).toMatchObject({ kind: 'blocked' })
  f.options.mutation.run_host = async () => ({ ok: false, exit_code: 1, stdout: '', stderr: '' })
  expect(await host.deps.checkFixLineage!(snapshot, 'b'.repeat(40))).toMatchObject({ kind: 'blocked' })
})

test('G102 host composes readback of the prepared review context', async () => {
  const f = await fixture()
  const host = f.make()
  const request: BoundedWorkRequest = { ...host.workers.review.request,
    run_id: 'test', step_id: 'test:review:1', role: 'review', needs_approval_decision: false }
  expect(await host.deps.reviewArtifact!(request, snapshot)).toMatchObject({ kind: 'unknown' })
  await host.deps.prepareWork(request, { snapshot, previous: null, findings: [] })
  expect(await host.deps.reviewArtifact!(request, snapshot)).toEqual({ kind: 'allow' })
  await writeFile(`${request.brief.path}.context.json`, JSON.stringify({ request, snapshot: { ...snapshot, diff: '+stale' } }))
  expect(await host.deps.reviewArtifact!(request, snapshot)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('measured revision') })
})

test('#1133 G166 round 31: the pr-mode publish gate asks ORIGIN for the run\'s own base branch, so the scan window can exclude what origin already publishes', async () => {
  const f = await fixture()
  f.prose()
  expect(f.options.mutation.base_branch).toBe('base')
  expect(await f.make().deps.publishGate(snapshot)).toEqual({ kind: 'allow' })
  // The base branch is the run's (`mutation.base_branch`), not a default and not the PR head.
  expect(f.calls.filter(argv => argv.includes('ls-remote')).map(argv => argv.at(-1))).toEqual(['refs/heads/change', 'refs/heads/base'])
})
