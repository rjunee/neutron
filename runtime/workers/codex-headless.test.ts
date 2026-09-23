import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRun, type BuildSnapshot, type BuildRunDeps } from '@neutronai/trident/build-run.ts'
import { fakeRunner, type BoundedWorkOutcome } from '../bounded-work.ts'
import type { BoundedWorkRequest } from '../bounded-work.ts'
import { createCodexHeadlessRunner } from './codex-headless.ts'

const measured: BuildSnapshot = { head: 'measured-head', diff: '+built\nline=two\n', pr: null }

function fixture(change: Partial<Record<'HEAD' | 'DIFF' | 'PR', string | null>> = {}, extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-headless-'))
  const script = join(dir, 'wrapper.sh')
  const seen = join(dir, 'seen.env')
  const threads = join(dir, 'threads')
  const fields: Record<string, string> = {
    BRANCH: 'build', HEAD: measured.head, REMOTE_HEAD: '', PR: '', DIFF: 'claim.diff', WORKTREE: dir,
  }
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete fields[key]
    else fields[key] = value
  }
  writeFileSync(join(dir, 'claim.diff'), measured.diff)
  writeFileSync(join(dir, 'source.trailer'), Object.entries(fields).map(([key, value]) => `NEUTRON_CODEX_BUILD_${key}=${value}\n`).join('') + extra)
  // A tempting host snapshot is available in the brief, but is never a claim.
  writeFileSync(join(dir, 'brief'), JSON.stringify({ snapshot: measured }))
  writeFileSync(script, `#!/bin/bash\nenv > ${JSON.stringify(seen)}\nprintf '%s\\n' "$NEUTRON_CODEX_THREAD_ID" >> ${JSON.stringify(threads)}\nprintf '{"type":"thread.started","thread_id":"%s"}\\n' "\${NEUTRON_CODEX_THREAD_ID:-observed-first}"\necho '{"type":"turn.completed","usage":{"input_tokens":23,"output_tokens":7,"cached_input_tokens":11}}'\ncat source.trailer > "$NEUTRON_CODEX_BUILD_TRAILER_FILE"\n`)
  chmodSync(script, 0o755)
  const request = (over: Partial<BoundedWorkRequest> = {}): BoundedWorkRequest => ({
    run_id: 'run-1', step_id: 'step-1', role: 'build', model_id: 'gpt-test', effort: 'high',
    cwd: dir, writable: true, network: false, tools: 'edit-and-run',
    brief: { path: join(dir, 'brief'), integrity: '7:receipt' },
    result: { schema: 'FORGE', path: join(dir, 'trailer') }, thread: null,
    budget: { wall_ms: 5_000 }, needs_approval_decision: false, ...over,
  })
  return { script, seen, threads, request }
}

describe('Codex headless WorkerRunner', () => {
  test('a resumed step keeps its own receipt instead of re-dispatching', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    const request = f.request()
    expect((await runner.run(request, 'headless', new AbortController().signal)).kind).toBe('completed')
    const receipt = readFileSync(request.result.path, 'utf8')
    // The gateway is replaced and the step re-entered. Its child is long gone, so a
    // wrapper that exits 0 without writing is all a replay could produce. The receipt
    // already written for THIS step is the answer, and must survive.
    const silent = join(request.cwd, 'silent.sh')
    writeFileSync(silent, '#!/bin/bash\nexit 0\n')
    chmodSync(silent, 0o755)
    const resumed = createCodexHeadlessRunner({ buildScript: silent, probe: { ok: true } })
    expect((await resumed.run(request, 'headless', new AbortController().signal)).kind).toBe('completed')
    expect(readFileSync(request.result.path, 'utf8')).toBe(receipt)
  })

  test('a first dispatch clears a slot left by an earlier round', async () => {
    const f = fixture()
    const request = f.request()
    // `open/wiring/project-build.ts:366` keys the slot by ROLE, so round two of a role
    // meets round one's trailer. An exit-0 child that writes nothing must not be
    // credited with it.
    writeFileSync(request.result.path, 'NEUTRON_CODEX_BUILD_HEAD=round-one-head\n')
    const silent = join(request.cwd, 'silent.sh')
    writeFileSync(silent, '#!/bin/bash\nexit 0\n')
    chmodSync(silent, 0o755)
    const runner = createCodexHeadlessRunner({ buildScript: silent, probe: { ok: true } })
    const outcome = await runner.run(request, 'headless', new AbortController().signal)
    expect(outcome.kind).toBe('unknown')
    expect(outcome).toHaveProperty('detail', expect.stringContaining('without a readable trailer'))
  })

  test('maps the wrapper claim and referenced diff rather than stdout', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    const outcome = await runner.run(f.request(), 'headless', new AbortController().signal)
    expect(outcome.kind).toBe('completed')
    if (outcome.kind === 'completed') expect(outcome.result).toEqual(measured)
  })

  test('scrubs every GitHub credential family at spawn and retains an ordinary control', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({
      buildScript: f.script, probe: { ok: true },
      env: { PATH: process.env.PATH, GH_TOKEN: 'secret', GH_ENTERPRISE_TOKEN: 'secret', GITHUB_TOKEN: 'secret', RUNNER_CONTROL: 'visible' },
    })
    expect((await runner.run(f.request(), 'headless', new AbortController().signal)).kind).toBe('completed')
    const childEnv = readFileSync(f.seen, 'utf8')
    expect(childEnv).toContain('RUNNER_CONTROL=visible')
    expect(childEnv).not.toContain('GH_TOKEN=')
    expect(childEnv).not.toContain('GH_ENTERPRISE_TOKEN=')
    expect(childEnv).not.toContain('GITHUB_TOKEN=')
  })

  test('a second call carries the same durable thread id', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    const first = await runner.run(f.request(), 'headless', new AbortController().signal)
    expect(first.kind === 'completed' && first.thread_id).toBe('observed-first')
    if (first.kind !== 'completed' || !first.thread_id) throw new Error('missing observed thread')
    const restarted = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    const second = await restarted.run(f.request({ step_id: 'step-2', thread: { id: first.thread_id } }), 'headless', new AbortController().signal)
    expect(second.kind === 'completed' && second.thread_id).toBe('observed-first')
    expect(readFileSync(f.threads, 'utf8')).toBe('\nobserved-first\n')
    expect(second).toMatchObject({ usage: { input_tokens: 23, output_tokens: 7, cache_read_input_tokens: 11 }, model_reported: null })
  })

  test('a foreign provider thread cannot be relabelled with the requested id', async () => {
    const f = fixture()
    writeFileSync(f.script, readFileSync(f.script, 'utf8').replace('${NEUTRON_CODEX_THREAD_ID:-observed-first}', 'newest-decoy'))
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    expect(await runner.run(f.request({ thread: { id: 'owned-thread' } }), 'headless', new AbortController().signal))
      .toMatchObject({ kind: 'unknown', detail: expect.stringContaining('matching thread') })
  })

  test('a failed process cannot leave an acceptable receipt on recovery', async () => {
    const f = fixture()
    writeFileSync(f.script, readFileSync(f.script, 'utf8') + '\nexit 5\n')
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    expect((await runner.run(f.request(), 'headless', new AbortController().signal)).kind).toBe('failed')
    expect(await runner.run(f.request(), 'headless', new AbortController().signal))
      .toMatchObject({ kind: 'unknown', detail: expect.stringContaining('no committed receipt') })
    expect(readFileSync(f.threads, 'utf8')).toBe('\n')
  })

  test('restart reuses the observed receipt even after the mutable role slot changes', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    const first = await runner.run(f.request(), 'headless', new AbortController().signal)
    writeFileSync(f.request().result.path, 'foreign-role-slot')
    const restarted = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    expect(await restarted.run(f.request(), 'headless', new AbortController().signal)).toEqual(first)
    expect(readFileSync(f.threads, 'utf8')).toBe('\n')
  })

  test('corrupt observation and changed account identity cannot reuse a receipt', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true }, env: { PATH: process.env.PATH, CODEX_HOME: 'seat-one' } })
    expect((await runner.run(f.request(), 'headless', new AbortController().signal)).kind).toBe('completed')
    const other = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true }, env: { PATH: process.env.PATH, CODEX_HOME: 'seat-two' } })
    expect((await other.run(f.request(), 'headless', new AbortController().signal)).kind).toBe('unknown')
    const receipt = join(f.request().cwd, readdirSync(f.request().cwd).find(name => name.endsWith('.receipt'))!)
    const bytes = JSON.parse(readFileSync(receipt, 'utf8'))
    bytes.observation.usage.input_tokens = 'invented'
    writeFileSync(receipt, JSON.stringify(bytes))
    expect((await runner.run(f.request(), 'headless', new AbortController().signal)).kind).toBe('unknown')
    expect(readFileSync(f.threads, 'utf8')).toBe('\n')
  })

  test('unsupported placement and roles are refused, never failed', async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    expect(runner.supports('build', 'in-repl')).toEqual(expect.objectContaining({ ok: false, reason: 'placement-unavailable' }))
    expect(runner.supports('arbitrate', 'headless')).toEqual(expect.objectContaining({ ok: false, reason: 'capability-unsupported' }))
    expect(await runner.run(f.request({ role: 'arbitrate' }), 'headless', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
  })

  test('an unavailable startup probe refuses admission', () => {
    const runner = createCodexHeadlessRunner({ probe: { ok: false, reason: 'provider-not-connected', detail: 'not logged in' } })
    expect(runner.supports('build', 'headless')).toEqual({ ok: false, reason: 'provider-not-connected', detail: 'not logged in' })
  })

  test('approval decisions cannot be requested from a worker', () => {
    const f = fixture()
    // @ts-expect-error The bounded-work contract deliberately permits only false.
    const invalid: BoundedWorkRequest = f.request({ needs_approval_decision: true })
    expect(invalid.needs_approval_decision as boolean).toBe(true)
  })
})

// Exercise the real private corroborates predicate through its driver.
async function compare(outcome: BoundedWorkOutcome, measured: BuildSnapshot) {
  const initial = { ...measured, pr: null }
  const plan = fakeRunner('anthropic', { outcomes: new Map([
    ['run:plan:0', { kind: 'completed', result: initial, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null }],
  ]) })
  const build = fakeRunner('openai-codex', { outcomes: new Map([['run:build:0', outcome]]) })
  let reads = 0
  const deps: BuildRunDeps = {
    // Terminal full-suite evidence; the driver refuses to merge without a source.
    publicationSuite: async () => ({ kind: 'known' as const, findings: [] }),
    readReviewCap: async () => ({ kind: 'known' }),
    // G023: the builder's branch is the host's assignment, and a missing one is
    // `unknown` rather than agreement. Production takes it from the run row; this
    // helper is comparing trailers, so it supplies the assignment the same way.
    assignedBranch: 'change',
    prepareWork: async () => {},
    measure: async () => ({ kind: 'known', value: ++reads < 3 ? initial : measured }),
    admissionGate: async () => ({ kind: 'allow' }),
    runLeakGatePreflight: async () => { throw new Error('unexpected gate') },
    assessMergeDiff: () => { throw new Error('unexpected gate') },
    observeReview: async () => { throw new Error('unexpected review observation') },
    reviewGate: async () => { throw new Error('unexpected review') },
    publishGate: async () => { throw new Error('unexpected publication') },
    mergeGate: async () => { throw new Error('unexpected merge') },
    publish: async () => { throw new Error('unexpected publication') },
    merge: async () => { throw new Error('unexpected merge') },
    recordPhaseUsage: async () => {},
  }
  const request = fixture().request()
  return buildRun({
    run_id: 'run', mode: 'pr', start: 'fresh', repl_provider: 'anthropic',
    workers: {
      plan: { runner: plan, request }, build: { runner: build, request },
      review: { runner: fakeRunner('anthropic'), request }, fix: { runner: build, request },
    },
  }, deps, new AbortController().signal)
}

test('baseline flat claim fails real corroboration even for matching facts', async () => {
  const outcome: BoundedWorkOutcome = {
    kind: 'completed', result: { HEAD: 'measured-head', STATUS: 'ok' },
    usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null,
  }
  expect(await compare(outcome, { head: 'measured-head', diff: '+built\n', pr: null }))
    .toMatchObject({ kind: 'failed', phase: 'build', cause: 'built-head-unverified' })
  expect(await compare({ ...outcome, result: { head: 'measured-head', diff: '+built\n', pr: null } },
    { head: 'measured-head', diff: '+built\n', pr: null }))
    .toMatchObject({ kind: 'unknown', phase: 'review' })
})

async function runTrailer(change: Parameters<typeof fixture>[0] = {}, extra = '') {
  const f = fixture(change, extra)
  return createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    .run(f.request(), 'headless', new AbortController().signal)
}

test('mapped claim agrees with independent host measurement', async () => {
  expect(await compare(await runTrailer(), measured)).toMatchObject({ kind: 'unknown', phase: 'review' })
})

// `diff` is NOT here, and its absence is deliberate. The head pins the exact commit,
// so with the host's own base the diff is DETERMINED — a differing diff cannot
// describe a different revision, only different git output formatting. Acceptance
// run 5a69ae54 stopped on exactly that: the host measures with `--full-index` and the
// worker returned an abbreviated `index 00000000..3936b410`, same commit, same
// content. The host discards the worker's copy regardless (`snapshot = measured`).
//
// A MISSING or EMPTY diff is a different thing and is still caught — see the
// `missing ${field} stays unknown` and `empty ${field} is unknown` loops below,
// which keep DIFF. Malformed is not the same as formatted differently.
for (const field of ['head', 'pr'] as const) {
  test(`mapped claim disagrees when host ${field} differs`, async () => {
    const different = { ...measured, [field]: field === 'pr' ? { number: 9, head: 'other', state: 'OPEN' } : 'other' }
    expect(await compare(await runTrailer(), different))
      .toMatchObject({ kind: 'failed', phase: 'build', cause: 'built-head-unverified' })
  })
}

for (const field of ['HEAD', 'DIFF', 'PR'] as const) {
  test(`missing ${field} stays unknown despite matching measured snapshot in brief`, async () => {
    const outcome = await runTrailer({ [field]: null })
    expect(outcome).toEqual({ kind: 'unknown', detail: `Codex trailer is missing NEUTRON_CODEX_BUILD_${field}` })
    expect(await compare(outcome, measured)).toMatchObject({ kind: 'unknown', phase: 'build' })
  })
}

for (const field of ['HEAD', 'DIFF'] as const) {
  test(`empty ${field} is unknown`, async () => {
    expect(await runTrailer({ [field]: '' }))
      .toEqual({ kind: 'unknown', detail: `Codex trailer has empty NEUTRON_CODEX_BUILD_${field}` })
  })
}

test('PR number alone lacks the compared PR head and state', async () => {
  expect(await runTrailer({ PR: '42' }))
    .toEqual({ kind: 'unknown', detail: 'Codex trailer is missing pr.head and pr.state for NEUTRON_CODEX_BUILD_PR' })
})

test('unreadable diff artifact is unknown', async () => {
  expect(await runTrailer({ DIFF: 'missing.diff' }))
    .toEqual({ kind: 'unknown', detail: expect.stringMatching(/^Codex trailer NEUTRON_CODEX_BUILD_DIFF artifact is unreadable: Error: ENOENT/) })
})

test('duplicate fields are ambiguous even when one value matches', async () => {
  expect(await runTrailer({}, 'NEUTRON_CODEX_BUILD_HEAD=other\n'))
    .toEqual({ kind: 'unknown', detail: 'Codex trailer repeats NEUTRON_CODEX_BUILD_HEAD' })
})

test('malformed line is unknown', async () => {
  expect(await runTrailer({}, 'not a field\n'))
    .toEqual({ kind: 'unknown', detail: 'Codex wrapper wrote a malformed trailer' })
})

test('unreadable trailer stays unknown', async () => {
  const f = fixture()
  writeFileSync(f.script, '#!/bin/bash\nexit 0\n')
  const outcome = await createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    .run(f.request(), 'headless', new AbortController().signal)
  expect(outcome).toEqual({ kind: 'unknown', detail: expect.stringMatching(/^Codex wrapper exited successfully without a readable trailer: Error: ENOENT/) })
})

for (const effort of ['xhigh', 'max'] as const) {
  test(`headless forwards extended effort ${effort} unchanged`, async () => {
    const f = fixture()
    const runner = createCodexHeadlessRunner({ buildScript: f.script, probe: { ok: true } })
    expect((await runner.run(f.request({ effort }), 'headless', new AbortController().signal)).kind).toBe('completed')
    expect(readFileSync(f.seen, 'utf8').split('\n').find(line => line.startsWith('CODEX_BUILD_EFFORT='))).toBe(`CODEX_BUILD_EFFORT=${effort}`)
  })
}
