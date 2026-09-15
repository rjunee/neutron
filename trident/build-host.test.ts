import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRunner, type Provider, type BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { buildRun, type BuildRunInput, type BuildSnapshot } from './build-run.ts'
import { createBuildHost, type BuildHostOptions } from './build-host.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { MERGE_DIFF_BYTES_MAX } from './merge.ts'

const head = 'a'.repeat(40)
const snapshot: BuildSnapshot = { head, diff: '+code', pr: null }
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'build-host-test-'))
  dirs.push(dir)
  const path = join(dir, 'brief')
  await writeFile(path, 'build brief')
  const request = {
    model_id: 'test-model', effort: null, cwd: dir, writable: true, network: false,
    tools: 'edit-and-run', brief: { path, integrity: briefIntegrity('build brief') },
    result: { schema: 'test', path: join(dir, 'result') }, thread: null, budget: { wall_ms: 100 },
  } satisfies BuildRunInput['workers']['build']['request']
  const calls: string[][] = []
  let diff = 'M\0src/code.ts\0'
  let drift: 'clear' | 'overlap' | 'unreadable' = 'clear'
  let leakOutput = 'LEAK GATE: INCOMPLETE\nRULES THAT COULD NOT RUN: pii'
  let leakCode = 3
  const options: BuildHostOptions = {
    runners: { pi: fakeRunner('pi') }, replProvider: 'pi',
    workers: Object.fromEntries(['plan', 'build', 'review', 'fix'].map(role => [role, { provider: 'pi', request }])) as BuildHostOptions['workers'],
    effects: {
      prepareWork: async () => {}, measure: async () => ({ kind: 'known', value: snapshot }),
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
        if (argv.includes('rev-parse') && drift === 'unreadable') return { ok: false, exit_code: 128, stdout: '', stderr: '' }
        if (argv.includes('merge-base')) return { ok: drift !== 'unreadable', exit_code: drift === 'unreadable' ? 128 : 0, stdout: drift === 'overlap' ? 'b'.repeat(40) : head, stderr: '' }
        if (argv.includes('--name-only')) return { ok: true, exit_code: 0, stdout: 'src/code.ts\n', stderr: '' }
        if (argv.includes('rev-parse')) return { ok: true, exit_code: 0, stdout: head, stderr: '' }
        if (argv.includes('diff')) return { ok: true, exit_code: 0, stdout: diff, stderr: '' }
        if (argv.includes('check-ref-format')) return { ok: true, exit_code: 0, stdout: '', stderr: '' }
        throw new Error(`Unexpected command: ${argv.join(' ')}`)
      },
    },
    observeCi: async () => ({ kind: 'completed', conclusion: 'success', headSha: head }),
  }
  const make = () => createBuildHost(options)
  const input = (host: ReturnType<typeof make>): BuildRunInput => ({ run_id: 'test', mode: 'pr', start: 'fresh', repl_provider: options.replProvider, workers: host.workers })
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

test('unreadable admission and complete admission policy stay unknown', async () => {
  const f = await fixture()
  const host = f.make()
  expect(await host.deps.admissionGate(f.input(host))).toMatchObject({ kind: 'unknown', detail: 'Complete project admission policy is not wired' })
  expect(await buildRun(f.input(host), host.deps, new AbortController().signal)).toMatchObject({ kind: 'unknown', phase: 'plan' })
  await rm(f.path)
  expect(await host.deps.admissionGate(f.input(host))).toMatchObject({ kind: 'unknown', detail: 'plan brief could not be read' })
})

test('malformed review stays unknown and blocking severity blocks', async () => {
  const f = await fixture()
  const { deps } = f.make()
  expect(await deps.reviewGate(null, snapshot, 1)).toMatchObject({ kind: 'unknown', detail: 'Review trailer not-object at $' })
  const finding = { severity: 'major', title: 'bug', evidence: 'code.ts:1', file: 'code.ts', symbol: 'f', rule: 'correctness', line: 1 }
  expect(await deps.reviewGate({ verdict: 'APPROVE', findings: [finding] }, snapshot, 1)).toMatchObject({ kind: 'blocked' })
  for (const severity of ['minor', 'nit']) expect(await deps.reviewGate({ verdict: 'APPROVE', findings: [{ ...finding, severity }] }, snapshot, 1)).toMatchObject({ kind: 'unknown', detail: 'Review panel provenance, cross-model seats and arbitration are not wired' })
  expect(await deps.reviewGate({ verdict: 'APPROVE', findings: [] }, snapshot, 1)).toMatchObject({ kind: 'unknown' })
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
  expect(await deps.publishGate(snapshot)).toMatchObject({ kind: 'unknown', detail: 'Complete publication readiness is not wired' })
  expect(await deps.publishGate({ ...snapshot, head: 'c'.repeat(40) })).toMatchObject({ kind: 'blocked', on: expect.stringContaining('branch tip') })
})

test('CI unreadable stays unknown; red, absent, running and wrong head block', async () => {
  const f = await fixture()
  for (const observation of [
    { kind: 'absent' }, { kind: 'running', headSha: head },
    { kind: 'completed', headSha: head, conclusion: 'failure' },
    { kind: 'completed', headSha: 'other', conclusion: 'success' },
  ] as const) {
    f.options.observeCi = async () => observation
    expect(await f.make().deps.mergeGate(snapshot)).toMatchObject({ kind: 'blocked' })
  }
  f.options.observeCi = async () => ({ kind: 'unreadable', reason: 'offline' })
  expect(await f.make().deps.mergeGate(snapshot)).toEqual({ kind: 'unknown', detail: 'offline' })
  f.options.observeCi = async () => ({ kind: 'completed', headSha: head, conclusion: 'success' })
  expect(await f.make().deps.mergeGate(snapshot)).toEqual({ kind: 'unknown', detail: 'Atomic pinned-head merge eligibility is not wired' })
})

test('base drift preserves uncertainty and blocks overlapping changes', async () => {
  const f = await fixture()
  f.setDrift('unreadable')
  expect(await f.make().deps.mergeGate(snapshot)).toEqual({ kind: 'unknown', detail: 'Base drift could not be assessed' })
  f.setDrift('overlap')
  expect(await f.make().deps.mergeGate(snapshot)).toEqual({ kind: 'blocked', on: 'Base drift overlaps reviewed changes' })
  f.setDrift('clear')
  expect(await f.make().deps.mergeGate(snapshot)).toEqual({ kind: 'unknown', detail: 'Atomic pinned-head merge eligibility is not wired' })
})
