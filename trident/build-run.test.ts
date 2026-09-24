import { reviewArtifact } from './gates/review-artifact.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { fixLineage } from './gates/fix-lineage.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { codexInReplRunner } from '@neutronai/runtime/workers/codex-in-repl.ts'
import { decodeProjectTrailer } from '@neutronai/runtime/workers/project-runners.ts'
import { expect, spyOn, test } from 'bun:test'
import { fakeRunner, type BoundedWorkOutcome, type BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { reviewPanel } from './gates/review-panel.ts'
import { buildRun, type BuildRunDeps, type BuildRunInput, type BuildSnapshot, type ExecutionPlan, type ReviewDecision } from './build-run.ts'

const singlePlan: ExecutionPlan = {
  implementationPlan: '- [ ] T1: implement the change', topTask: '- [ ] T1: implement the change',
  executionSpec: 'Implement the complete accepted plan', complexity: 'mechanical', remainingTasks: 0,
  strategy: 'single', rationale: 'The complete change fits in one implementation turn.',
}

function fixture(landFixes = true) {
  let landed = 10
  const snapshot: BuildSnapshot = { head: 'a'.repeat(40), diff: '+built\n', pr: null }
  const outcomes = new Map<string, BoundedWorkOutcome>()
  const completed = (value: unknown = structuredClone(snapshot)): BoundedWorkOutcome => ({
    kind: 'completed', result: value, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null,
  })
  for (const role of ['plan', 'build', 'review', 'fix']) {
    for (let round = 0; round <= 12; round++) outcomes.set(`run:${role}:${round}`, completed(
      role === 'plan' ? { ...snapshot, payload: { ...singlePlan, ...(round > 0 ? { executionSpec: 'revised execution spec' } : {}) } } : undefined))
  }
  const runner = fakeRunner('anthropic', { outcomes })
  const run = runner.run.bind(runner)
  runner.run = async (request, placement, signal) => {
    if (landFixes && request.role === 'fix' && outcomes.get(request.step_id)?.kind === 'completed') {
      const old = snapshot.head
      // Advance within one hex digit repeated 40 times. Incrementing past 'f'
      // produced '10'.repeat(40) — an 80-character head that is not a full OID,
      // so any fixture needing more than five fix rounds stopped on a lost round
      // instead of on what it was measuring.
      landed = (landed + 1) % 16
      snapshot.head = landed.toString(16).repeat(40)
      for (const outcome of outcomes.values()) {
        if (outcome.kind === 'completed' && outcome.result && typeof outcome.result === 'object' && 'head' in outcome.result && outcome.result.head === old) outcome.result.head = snapshot.head
      }
    }
    return run(request, placement, signal)
  }
  const cross = fakeRunner('openai-codex', { outcomes })
  const crossRun = cross.run.bind(cross)
  cross.run = async (request, placement, signal) => {
    // Existing scenarios script by role/round; retain the actual measured-head
    // request in calls so identity-specific tests can assert the full key.
    const scripted = outcomes.get(request.step_id.replace(/:head:[a-f0-9]+$/, ''))
    if (scripted) outcomes.set(request.step_id, scripted)
    return crossRun(request, placement, signal)
  }
  const request = {
    model_id: 'test', effort: null, cwd: '.', writable: true, network: false, tools: 'edit-and-run',
    brief: { path: 'brief.md', integrity: briefIntegrity('brief.md.context.json') }, result: { path: 'result.json', schema: 'build/1' },
    thread: null, budget: { wall_ms: 1000 },
  } as const
  const input: BuildRunInput = {
    run_id: 'run', mode: 'implementation', start: 'fresh', repl_provider: 'anthropic',
    workers: { plan: { runner, request }, build: { runner, request }, review: { runner: cross, request }, fix: { runner, request } },
  }
  const events: string[] = []
  const decisions: ReviewDecision[] = []
  let reads = 0
  let acceptedPlan = structuredClone(singlePlan)
  const deps: BuildRunDeps = {
    modes: {
      loadExecutionStrategy: async () => ({ kind: 'known', strategy: 'single', rationale: acceptedPlan.rationale, plan: acceptedPlan, source: 'planner' }),
      selectExecutionStrategy: async value => { acceptedPlan = structuredClone(value.plan); return { kind: 'allow' } },
      loadResume: async () => null, saveCheckpoint: async () => {},
      regenerateDiff: async () => ({ kind: 'known', diff: snapshot.diff }),
      probePlan: async () => null, advanceTask: async () => ({ kind: 'allow' }),
      commitPlan: async () => ({ kind: 'unknown', detail: 'Single strategy never commits a task ledger' }),
    },
    readReviewCap: async () => ({ kind: 'known' }),
    checkBuildClaim: async () => { events.push('preserve'); return { kind: 'blocked', on: 'Claim conflicts after preservation' } },
    assignedBranch: 'change',
    // The host composes fixLineage; this fixture models git confirming descent.
    checkFixLineage: (snapshot, pin) => fixLineage(async () => ({ ok: true, exit_code: 0, stdout: '', stderr: '' }), '.', 'change', pin, snapshot.head),
    prepareWork: async () => {},
    // Compose the host gate; this fake host models the context file readback.
    reviewArtifact: (request, snapshot) => reviewArtifact(request, snapshot, async path =>
      path === request.brief.path ? 'brief.md.context.json' : JSON.stringify({ request, snapshot })),
    measure: async () => { reads++; events.push('measure'); return { kind: 'known', value: structuredClone(snapshot) } },
    admissionGate: async () => ({ kind: 'allow' }),
    runLeakGatePreflight: async () => ({ status: 'clean', head: snapshot.head, findings: [], skipped_rules: [], attempts: 0, note: '' }),
    assessMergeDiff: () => ({ allow: true, measured_bytes: 7 }),
    reviewReadiness: async () => ({ kind: 'allow' }),
    reviewCi: async () => ({ kind: 'known', findings: [] }),
    reviewSuite: async () => ({ kind: 'known', findings: [] }),
    publicationSuite: async () => { events.push('publicationSuite'); return { kind: 'known', findings: [] } },
    observeReview: async (snapshot, round) => ({ kind: 'observed', runId: 'run', snapshot, round, verdicts: [], checkpoint: 'argus-approved' }),
    reviewGate: async (_payload, _observation, _snapshot, _round, _used, record) => {
      const decision = decisions.shift() ?? { kind: 'approve' as const }
      record?.('findings' in decision ? { findings: decision.findings, blockingCount: decision.blockingCount ?? decision.findings.length } : { findings: [], blockingCount: 0 })
      return decision
    },
    publishGate: async () => { events.push('publishGate'); return { kind: 'allow' } },
    mergeGate: async () => { events.push('mergeGate'); return { kind: 'allow' } },
    publish: async () => { events.push('publish'); snapshot.pr = { number: 1, head: snapshot.head, state: 'OPEN' }
      for (const outcome of outcomes.values()) {
        if (outcome.kind === 'completed' && outcome.result && typeof outcome.result === 'object' && 'pr' in outcome.result) outcome.result.pr = structuredClone(snapshot.pr)
      }
    },
    merge: async () => { events.push('merge'); snapshot.pr!.state = 'MERGED' },
  }
  return { input, deps, runner, cross, outcomes, completed, snapshot, events, decisions, reads: () => reads,
    run: () => buildRun(input, deps, new AbortController().signal) }
}

test('fresh to merged with a fix, host gates and fake runners', async () => {
  const f = fixture()
  f.decisions.push({ kind: 'fix', findings: ['logic'] }, { kind: 'approve' })
  expect((await f.run()).kind).toBe('merged')
  expect(f.runner.calls.map(c => c.role)).toEqual(['plan', 'build', 'fix'])
  expect(f.cross.calls.map(c => c.step_id.replace(/:head:[a-f0-9]+$/, ''))).toEqual(['run:review:1', 'run:review:2'])
  expect(f.events.filter(e => e !== 'measure')).toEqual(['publishGate', 'publish', 'publishGate', 'publish', 'publicationSuite', 'mergeGate', 'merge'])
  expect(f.reads()).toBe(17)
  expect([...f.runner.calls, ...f.cross.calls].every(c => c.needs_approval_decision === false)).toBe(true)
})

function pendingStrategyFixture(strategy: 'single' | 'task_sequence') {
  const f = modeFixture(strategy)
  delete f.input.executionStrategy // Omitting the hint must still require planner selection.
  let selected: Awaited<ReturnType<NonNullable<BuildRunDeps['modes']>['loadExecutionStrategy']>> = {
    kind: 'known', strategy: null, rationale: null, plan: null, source: null,
  }
  const selections: Parameters<NonNullable<BuildRunDeps['modes']>['selectExecutionStrategy']>[0][] = []
  f.deps.modes!.loadExecutionStrategy = async () => structuredClone(selected)
  f.deps.modes!.selectExecutionStrategy = async value => {
    selections.push(structuredClone(value))
    selected = { kind: 'known', strategy: value.strategy, rationale: value.rationale, plan: value.plan, source: 'planner' }
    return { kind: 'allow' }
  }
  const run = f.runner.run.bind(f.runner)
  f.runner.run = async (request, ...rest) => {
    if (request.role === 'build') {
      expect(selected).toMatchObject({ strategy, source: 'planner', plan: { strategy } })
      expect(selections).toHaveLength(1)
    }
    // The plan starts pending; selecting task_sequence changes subsequent task IDs.
    const normalized = request.step_id.replace(/:task:\d+:/, ':')
    const outcome = f.outcomes.get(normalized)
    if (outcome) f.outcomes.set(request.step_id, outcome)
    return run(request, ...rest)
  }
  return { ...f, selections, selection: () => selected }
}

for (const strategy of ['single', 'task_sequence'] as const)
test(`fresh pending run persists ${strategy} before its only builder dispatch`, async () => {
  const f = pendingStrategyFixture(strategy)
  expect((await f.run()).kind).toBe(strategy === 'single' ? 'merged' : 'continued')
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan', 'build'])
  expect(f.selections).toEqual([{ strategy, rationale: f.plan.rationale, plan: f.plan, refresh: false }])
  expect(f.prepared.find(p => p.role === 'build')).toMatchObject({ previous: f.plan,
    executionStrategy: strategy, suiteScope: strategy === 'single' ? 'host-suite' : 'subset' })
})

for (const strategy of ['single', 'task_sequence'] as const)
test(`unselected pending initial planner resumes and selects ${strategy} without replacing its request`, async () => {
  const f = pendingStrategyFixture(strategy)
  f.outcomes.set('run:plan:0', { kind: 'unknown', detail: 'Initial planner acknowledgment lost' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan', step_id: 'run:plan:0' })
  const original = f.runner.calls[0]
  f.state.resume = structuredClone(f.state.checkpoints.at(-1)!)
  f.input.start = 'resume'
  f.setPlan()
  f.input.workers.plan.runner = { ...f.runner, recover: f.runner.run }
  expect((await f.run()).kind).toBe(strategy === 'single' ? 'merged' : 'continued')
  expect(f.runner.calls.filter(call => call.role === 'plan')).toEqual([original!, original!])
  expect(f.selections).toHaveLength(1)
})

for (const selected of [false, true])
test(`completed checkpoint ${selected ? 'with' : 'without'} selected strategy cannot invent implementation authority`, async () => {
  const f = modeFixture('single')
  delete f.input.executionStrategy
  f.resume('built').remainingTasks = 0
  if (!selected) f.deps.modes!.loadExecutionStrategy = async () => ({ kind: 'known', strategy: null, rationale: null, plan: null, source: null })
  const outcome = await f.run()
  expect(outcome.kind).toBe(selected ? 'merged' : 'unknown')
  expect(f.runner.calls).toEqual([])
  expect(f.cross.calls).toHaveLength(selected ? 1 : 0)
  expect(f.events.includes('merge')).toBe(selected)
})

for (const patch of [
  { strategy: undefined }, { strategy: 'parallel' }, { strategy: null }, { strategy: 1 },
  { rationale: undefined }, { rationale: '' }, { rationale: ' \n ' },
  { implementationPlan: '' }, { topTask: '' }, { executionSpec: '' },
  { remainingTasks: -1 }, { complexity: 'invented' }, { additionalProperty: 'not allowed' },
  { remainingTasks: 1 },
]) test(`closed planner selection refuses malformed proposal ${JSON.stringify(patch)}`, async () => {
  const f = pendingStrategyFixture('single')
  f.setPlan({ ...f.plan, ...patch })
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan' })
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan'])
  expect(f.selections).toEqual([])
  expect(f.selection()).toMatchObject({ strategy: null, plan: null })
})

for (const kind of ['blocked', 'unknown'] as const)
test(`selection persistence ${kind} prevents builder and all publication`, async () => {
  const f = pendingStrategyFixture('single')
  f.deps.modes!.selectExecutionStrategy = async () => kind === 'blocked'
    ? { kind, on: 'Selection compare-and-swap refused' } : { kind, detail: 'Selection write unobserved' }
  expect(await f.run()).toMatchObject(kind === 'blocked'
    ? { kind, phase: 'plan', on: 'Selection compare-and-swap refused' }
    : { kind, phase: 'plan', detail: 'Selection write unobserved' })
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan'])
  expect(f.cross.calls).toEqual([])
  expect(f.events).not.toContain('publish')
})

test('unreadable persisted selection cannot be replaced with a new planner choice', async () => {
  const f = pendingStrategyFixture('single')
  f.deps.modes!.loadExecutionStrategy = async () => ({ kind: 'unknown', detail: 'Selection record is corrupt' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan', detail: 'Selection record is corrupt' })
  expect(f.runner.calls).toEqual([])
  expect(f.selections).toEqual([])
})

for (const patch of [
  { strategy: 'invented' }, { rationale: null }, { rationale: ' ' }, { plan: null },
  { source: null }, { plan: { ...singlePlan, strategy: 'task_sequence' } },
]) test(`corrupt selected evidence prevents reclassification ${JSON.stringify(patch)}`, async () => {
  const f = fixture()
  f.deps.modes!.loadExecutionStrategy = async () => ({ kind: 'known', strategy: 'single', rationale: singlePlan.rationale,
    plan: singlePlan, source: 'planner', ...patch } as Awaited<ReturnType<NonNullable<BuildRunDeps['modes']>['loadExecutionStrategy']>>)
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan', detail: 'Persisted execution strategy is missing valid selection evidence' })
  expect(f.runner.calls).toEqual([])
})

for (const selected of ['single', 'task_sequence'] as const)
test(`launch cannot override persisted ${selected} with a contradictory strategy hint`, async () => {
  const f = modeFixture(selected)
  f.input.executionStrategy = selected === 'single' ? 'task_sequence' : 'single'
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan', detail: 'Execution strategy changed after launch preparation' })
  expect(f.runner.calls).toEqual([])
})

test('selection acknowledgment requires exact durable readback before builder dispatch', async () => {
  for (const patch of [{ strategy: null }, { source: null }, { source: 'legacy' },
    { rationale: 'different rationale' }, { plan: { ...singlePlan, executionSpec: 'different work' } }]) {
    const f = pendingStrategyFixture('single')
    const load = f.deps.modes!.loadExecutionStrategy
    f.deps.modes!.loadExecutionStrategy = async () => {
      const stored = await load()
      return f.selections.length ? { ...stored, ...patch } as Awaited<ReturnType<typeof load>> : stored
    }
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan', detail: 'Execution strategy persistence was not confirmed' })
    expect(f.runner.calls.map(call => call.role)).toEqual(['plan'])
    expect(f.selections).toHaveLength(1)
  }
})

for (const selected of ['single', 'task_sequence'] as const)
test(`existing ${selected} selection refuses planner reclassification`, async () => {
  const f = modeFixture(selected)
  f.setPlan({ ...f.plan, strategy: selected === 'single' ? 'task_sequence' : 'single' })
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan' })
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan'])
  expect(f.cross.calls).toEqual([])
  expect(f.state.advances).toBe(0)
})

test('bounded replanning cannot change the selected strategy or dispatch a second builder', async () => {
  const f = fixture()
  f.decisions.push(gap)
  f.outcomes.set('run:plan:1', f.completed({ ...f.snapshot, payload: { ...singlePlan, strategy: 'task_sequence' } }))
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan', on: 'Planner cannot change the persisted execution strategy' })
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan', 'build', 'plan'])
  expect(f.cross.calls).toHaveLength(1)
  expect(f.events).not.toContain('merge')
})

test('review starts standalone and panel together, drains both, then rechecks CI and revision', async () => {
  for (const fault of ['none', 'standalone', 'panel', 'revision', 'ci'] as const) {
    const f = fixture()
    const started: string[] = [], finished: string[] = []
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    let reached!: () => void
    const both = new Promise<void>(resolve => { reached = resolve })
    const start = (name: string) => { started.push(name); if (started.length === 2) reached() }
    const run = f.cross.run.bind(f.cross)
    f.cross.run = async (...args) => {
      start('standalone'); await barrier; finished.push('standalone')
      if (fault === 'standalone') throw Error('review rejected')
      return run(...args)
    }
    const observe = f.deps.observeReview
    f.deps.observeReview = async (...args) => {
      start('panel'); await barrier; finished.push('panel')
      if (fault === 'panel') throw Error('panel rejected')
      if (fault === 'revision') f.snapshot.head = 'b'.repeat(40)
      return observe(...args)
    }
    f.deps.reviewCi = async () => started.length && fault === 'ci'
      ? { kind: 'blocked', on: 'CI became unavailable' } : { kind: 'known', findings: [] }
    let settled = false
    const pending = f.run().then(value => { settled = true; return value })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([both, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Independent producers did not start')), 1000)
      })])
      expect(started).toEqual(['standalone', 'panel'])
      expect(finished).toEqual([])
      expect(settled).toBe(false)
    } finally { clearTimeout(timer); release(); await pending }
    const result = await pending
    expect(finished).toHaveLength(2)
    expect(result.kind).toBe(fault === 'none' ? 'merged' : fault === 'revision' ? 'failed' : 'blocked')
    if (fault !== 'none') expect(f.events).not.toContain('merge')
  }
})

test('a rejected standalone review cannot return while a sibling still owns live work', async () => {
  const f = fixture()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const observe = f.deps.observeReview
  f.deps.observeReview = async (...args) => { entered(); await held; return observe(...args) }
  f.cross.run = async () => { throw Error('standalone rejected') }
  let settled = false
  const running = f.run().then(value => { settled = true; return value })
  try {
    await started
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(f.events).not.toContain('merge')
  } finally { release() }
  expect(await running).toMatchObject({ kind: 'blocked', on: expect.stringContaining('standalone rejected') })
})

test('unavailable review admission prevents both standalone and panel dispatch', async () => {
  for (const stop of ['readiness', 'ci', 'artifact', 'preparation'] as const) {
    const f = fixture()
    let panels = 0
    f.deps.observeReview = async () => { panels++; throw Error('must not dispatch') }
    if (stop === 'readiness') f.deps.reviewReadiness = async () => ({ kind: 'unknown', detail: 'unavailable' })
    if (stop === 'ci') f.deps.reviewCi = async () => ({ kind: 'blocked', on: 'unavailable' })
    if (stop === 'artifact') f.deps.reviewArtifact = async () => ({ kind: 'blocked', on: 'unavailable' })
    if (stop === 'preparation') f.deps.prepareWork = async req => { if (req.role === 'review') throw Error('unavailable') }
    expect((await f.run()).kind).not.toBe('merged')
    expect(f.cross.calls).toEqual([])
    expect(panels).toBe(0)
  }
})

test('missing review observation host refuses before standalone dispatch', async () => {
  const f = fixture()
  delete (f.deps as Partial<BuildRunDeps>).observeReview
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'review', detail: 'Review observation host is missing' })
  expect(f.cross.calls).toEqual([])
  expect((await fixture().run()).kind).toBe('merged')
})

test('terminal publication cannot proceed when the full-suite gate is missing or red', async () => {
  for (const state of ['missing', 'red'] as const) {
    const f = fixture()
    if (state === 'missing') delete (f.deps as { publicationSuite?: unknown }).publicationSuite
    else f.deps.publicationSuite = async () => ({ kind: 'known', findings: [
      { title: 'FULL SUITE NOT PROVEN', evidence: 'terminal run failed', advisory: false },
    ] })
    expect(await f.run()).toMatchObject(state === 'missing'
      ? { kind: 'unknown', phase: 'publish', detail: 'Publication suite host is missing' }
      : { kind: 'blocked', phase: 'publish', on: expect.stringContaining('FULL SUITE NOT PROVEN') })
    expect(f.events.filter(event => event === 'publish')).toHaveLength(1)
    expect(f.events).not.toContain('merge')
  }
})

// Attempt accounting is verified through the production project host.

test('placement is resolved for every role at admission and dispatch', async () => {
  const f = fixture()
  const placements: string[] = []
  for (const role of ['plan', 'build', 'review', 'fix'] as const) {
    const old = f.input.workers[role].runner
    f.input.workers[role].runner = {
      ...old,
      supports: (r, placement) => { placements.push(`${r}:${placement}`); return { ok: true } },
      run: (req, placement, signal) => { placements.push(`${req.role}:${placement}`); return old.run(req, placement, signal) },
    }
  }
  await f.run()
  expect(placements).toEqual(['plan:in-repl', 'build:in-repl', 'review:headless', 'fix:in-repl', 'plan:in-repl', 'build:in-repl', 'review:headless'])
})

// `diff` is NOT in this list, and its absence is the point. The head pins the exact
// commit, so with the host's own base the diff is DETERMINED — a "lying" diff cannot
// describe a different revision, only different git output formatting, and the host
// discards the worker's copy anyway (`snapshot = measured`). The case below covers
// what that previously cost. `head` and `pr` remain claims a trailer really can lie
// about: `pr` is a statement about the world the head does not determine.
for (const [field, value] of [['head', 'b'.repeat(40)], ['pr', { number: 2, head: 'fake', state: 'OPEN' }]] as const) {
  test(`lying ${field} trailer is caught before review`, async () => {
    const f = fixture()
    f.outcomes.set('run:build:0', f.completed({ ...f.snapshot, [field]: value }))
    expect(await f.run()).toMatchObject({ kind: 'failed', cause: 'built-head-unverified', phase: 'build' })
    expect(f.cross.calls).toHaveLength(0)
    expect(f.events).not.toContain('publish')
    expect(f.reads()).toBe(3)
  })
}

// A WORKER'S DIFF THAT DIFFERS ONLY IN FORMATTING MUST NOT STOP THE BUILD.
//
// This is the fifth acceptance dispatch's stop, reproduced. The host measures with
// `--binary --no-ext-diff --no-textconv --full-index`; the brief never stated that
// invocation, so the worker ran a plain `git diff` and returned an abbreviated
// `index 00000000..3936b410` where the host had the full 40-hex pair. Run 5a69ae54:
// 9505 bytes against the host's 9719, first difference at byte 180, in the index
// line and nowhere else. Same commit, same content, different text — and the run
// stopped with "Worker trailer disagrees with host measurement".
//
// The abbreviation below is the real shape, not a token edit: if the check ever
// returns to comparing bytes, this goes red again.
test('a worker diff abbreviated by git formatting still corroborates the measured head', async () => {
  const f = fixture()
  // The HOST's diff, in the shape `--full-index` actually produces.
  const full = 'diff --git a/x.md b/x.md\n'
    + 'new file mode 100644\n'
    + `index ${'0'.repeat(40)}..${'3936b4107891673bd63e5938591a2b4c7d8e9f01'}\n`
    + '--- /dev/null\n+++ b/x.md\n@@ -0,0 +1 @@\n+built\n'
  f.snapshot.diff = full
  // What a worker running a plain `git diff` returns instead: same commit, same
  // content, abbreviated index hashes.
  const abbreviated = full.replace(/index ([0-9a-f]{40})\.\.([0-9a-f]{40})/g,
    (_m, a: string, b: string) => `index ${a.slice(0, 8)}..${b.slice(0, 8)}`)
  // The regex must actually have bitten — otherwise this test asserts that an
  // IDENTICAL diff corroborates, which is true of the old behaviour too and proves
  // nothing. The fixture's default diff ('+built\n') has no index line at all, and
  // that is exactly how this case was tautological on its first draft.
  expect(abbreviated).not.toBe(full)
  expect(abbreviated).toContain(`index ${'0'.repeat(8)}..3936b410\n`)
  f.outcomes.set('run:build:0', f.completed({ ...f.snapshot, diff: abbreviated }))
  const result = await f.run()
  expect(result).not.toMatchObject({ cause: 'built-head-unverified' })
  expect(f.events).toContain('publish')
})
for (const result of [null, {}, { head: 'a'.repeat(40), diff: '+built\n' }]) {
  test(`malformed trailer ${JSON.stringify(result)} is refused`, async () => {
    const f = fixture()
    f.outcomes.set('run:build:0', f.completed(result))
    expect((await f.run()).kind).toBe('failed')
  })
}

for (const kind of ['unknown', 'blocked', 'failed', 'refused'] as const) {
  test(`runner ${kind} retains its meaning and stops downstream work`, async () => {
    const f = fixture()
    const outcome: BoundedWorkOutcome = kind === 'blocked' ? { kind, on: 'clarify spec' }
      : kind === 'failed' ? { kind, class: 'infra', detail: 'broken' }
      : kind === 'refused' ? { kind, reason: 'cli-contract' } : { kind, detail: 'still running' }
    f.outcomes.set('run:build:0', outcome)
    const result = await f.run()
    expect(result.kind).toBe(kind === 'refused' ? 'blocked' : kind)
    if (kind === 'blocked') expect(result).toMatchObject({ recipient: 'orchestrator', on: 'clarify spec' })
    if (kind === 'unknown') expect(result).toMatchObject({ phase: 'build', step_id: 'run:build:0', detail: 'still running' })
    expect(f.runner.calls).toHaveLength(2)
    expect(f.cross.calls).toHaveLength(0)
    expect(f.events).not.toContain('merge')
  })
}

test('admission refuses unavailable future fix capability', async () => {
  const f = fixture()
  f.input.workers.fix.runner = fakeRunner('pi', { supports: () => ({ ok: false, reason: 'placement-unavailable', detail: 'no seat' }) })
  expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'worker-unsupported' })
  expect(f.runner.calls).toHaveLength(0)
})
test('foreign existing PR refuses fresh admission', async () => {
  const f = fixture(); f.snapshot.pr = { number: 1, head: f.snapshot.head, state: 'OPEN' }
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan', on: 'Fresh build already has a PR' })
  expect(f.runner.calls).toHaveLength(0)
})

test('fresh retry continues on the PR proven to belong to its prior run', async () => {
  const f = fixture(); f.snapshot.pr = { number: 17, head: f.snapshot.head, state: 'OPEN' }
  f.input.owned_pr = 17
  for (const outcome of f.outcomes.values()) {
    if (outcome.kind === 'completed' && outcome.result && typeof outcome.result === 'object' && 'pr' in outcome.result) {
      outcome.result.pr = structuredClone(f.snapshot.pr)
    }
  }
  f.deps.publish = async () => { f.events.push('publish') }
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan', 'build'])
})

test('fresh retry admits its prior published PR when checkout is still at base', async () => {
  const f = fixture()
  f.snapshot.pr = { number: 17, head: 'b'.repeat(40), state: 'OPEN' }
  f.input.owned_pr = 17
  expect(f.input.start).toBe('fresh')
  expect(f.snapshot.pr.head).not.toBe(f.snapshot.head)
  for (const outcome of f.outcomes.values()) {
    if (outcome.kind === 'completed' && outcome.result && typeof outcome.result === 'object' && 'pr' in outcome.result) {
      outcome.result.pr = structuredClone(f.snapshot.pr)
    }
  }
  // Model republication advancing the existing PR to this run's reviewed head.
  f.deps.publish = async () => {
    f.events.push('publish')
    f.snapshot.pr!.head = f.snapshot.head
    for (const outcome of f.outcomes.values()) {
      if (outcome.kind === 'completed' && outcome.result && typeof outcome.result === 'object' && 'pr' in outcome.result) {
        outcome.result.pr = structuredClone(f.snapshot.pr)
      }
    }
  }
  expect(await f.run()).toMatchObject({ kind: 'merged', snapshot: { pr: { number: 17 } } })
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan', 'build'])
  expect(f.events).toContain('publish')
})

for (const head of ['a', 'b']) test(`foreign PR with different provenance refuses fresh admission at head ${head}`, async () => {
  const f = fixture()
  f.snapshot.pr = { number: 18, head: head.repeat(40), state: 'OPEN' }
  f.input.owned_pr = 17
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan', on: 'Fresh build already has a PR' })
  expect(f.runner.calls).toHaveLength(0)
})

for (const head of ['a', 'b']) test(`owned closed PR is still refused at head ${head}`, async () => {
  const f = fixture(); f.snapshot.pr = { number: 17, head: head.repeat(40), state: 'CLOSED' }
  f.input.owned_pr = 17
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Fresh build already has a PR' })
  expect(f.runner.calls).toHaveLength(0)
})

test('owned merged PR remains terminal without admitting fresh work', async () => {
  const f = fixture()
  f.snapshot.pr = { number: 17, head: 'b'.repeat(40), state: 'MERGED' }
  f.input.owned_pr = 17
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).toEqual(['measure'])
})

for (const gate of ['admissionGate', 'publishGate', 'mergeGate'] as const) {
  for (const kind of ['unknown', 'blocked'] as const) {
    test(`${gate} ${kind} cannot reach merge`, async () => {
      const f = fixture()
      f.deps[gate] = async () => kind === 'unknown' ? { kind, detail: 'unreadable' } : { kind, on: 'gate' }
      expect((await f.run()).kind).toBe(kind)
      expect(f.events).not.toContain('merge')
    })
  }
}
for (const kind of ['unknown', 'blocked'] as const) {
  test(`review ${kind} cannot merge`, async () => {
    const f = fixture()
    f.decisions.push(kind === 'unknown' ? { kind, detail: 'unreadable' } : { kind, on: 'arbiter' })
    expect((await f.run()).kind).toBe(kind)
    expect(f.events).not.toContain('merge')
  })
}

test('first repeat stops; five rounds stop even with decreasing distinct findings', async () => {
  for (const repeated of [true, false]) {
    const f = fixture()
    f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 5 })
    for (let round = 1; round <= 5; round++) f.decisions.push({ kind: 'fix', findings: [repeated ? 'same-class' : `class-${round}`], blockingCount: 6 - round })
    expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'review', recipient: 'orchestrator' })
    expect(f.cross.calls).toHaveLength(repeated ? 2 : 5)
    expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(repeated ? 1 : 4)
  }
})

for (const read of [1, 3, 4, 5, 6, 7, 8, 9]) {
  test(`unreadable host measurement ${read} preserves uncertainty`, async () => {
    const f = fixture(); const measure = f.deps.measure; let n = 0
    f.deps.measure = async () => ++n === read ? { kind: 'unknown', detail: 'cannot read' } : measure()
    expect((await f.run()).kind).toBe('unknown')
  })
}
test('review cannot change its subject even with a matching trailer', async () => {
  const f = fixture(); const measure = f.deps.measure; let n = 0
  f.deps.measure = async () => { if (++n === 8) f.snapshot.head = 'c'.repeat(40); return measure() }
  f.outcomes.set('run:review:1', f.completed({ ...f.snapshot, head: 'c'.repeat(40) }))
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Reviewed revision changed during review' })
})
for (const status of ['incomplete', 'findings-unresolved', 'gate-error'] as const) {
  test(`leak ${status} logs and publishes after preflight`, async () => {
    const f = fixture(); const leak = f.deps.runLeakGatePreflight
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    f.deps.runLeakGatePreflight = async s => {
      f.events.push('preflight')
      return { ...await leak(s), status, note: 'scan needs attention',
        findings: [{ rule: 'vocabulary', file: 'README.md', line: 7 }] }
    }
    try {
      expect((await f.run()).kind).toBe('merged')
      expect(f.events.filter(e => e === 'preflight' || e === 'publish')).toEqual(['preflight', 'publish'])
      const logged = warning.mock.calls.flat().join(' ')
      expect(logged).toContain(`status=${status}`)
      expect(logged).toContain('scan needs attention')
      expect(logged).toContain('README.md')
      expect(logged).toContain('vocabulary')
    } finally { warning.mockRestore() }
  })
}
for (const status of ['unknown', 'skipped-no-gate'] as const) {
  test(`leak ${status} cannot publish without a scan`, async () => {
    const f = fixture(); const leak = f.deps.runLeakGatePreflight
    f.deps.runLeakGatePreflight = async s => ({ ...await leak(s), status, note: 'scanner unavailable' })
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'publish', step_id: null,
      detail: 'Leak preflight did not run: scanner unavailable' })
    expect(f.events).not.toContain('publish')
  })
}
test('leak preflight invocation throwing stays unknown', async () => {
  const f = fixture()
  f.deps.runLeakGatePreflight = async () => { throw new Error('scanner unavailable') }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'publish', detail: 'scanner unavailable' })
  expect(f.events).not.toContain('publish')
})
test('leak fixer moving the head requires new review', async () => {
  const f = fixture(); const leak = f.deps.runLeakGatePreflight
  f.deps.runLeakGatePreflight = async s => { f.snapshot.head = 'd'.repeat(40); return { ...await leak(s), status: 'fixed' } }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Revision changed during publication preflight' })
})
test('oversized diff stops publication', async () => {
  const f = fixture(); f.deps.assessMergeDiff = () => ({ allow: false, measured_bytes: 999999, reason: 'too large' })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'too large' })
  expect(f.events).not.toContain('publish')
})
for (const action of ['publish', 'merge'] as const) {
  test(`${action} acknowledgement without measured effect is blocked`, async () => {
    const f = fixture(); f.deps[action] = async () => {}
    expect((await f.run()).kind).toBe('blocked')
  })
  test(`${action} exception after possible effect stays unknown`, async () => {
    const f = fixture(); f.deps[action] = async () => { throw new Error('transport lost') }
    expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'transport lost' })
  })
}

for (const gate of ['publishGate', 'mergeGate'] as const) {
  test(`${gate} revision drift is detected before write`, async () => {
    const f = fixture()
    f.deps[gate] = async () => { f.snapshot.head = 'e'.repeat(40); return { kind: 'allow' } }
    expect((await f.run()).kind).toBe('blocked')
    expect(f.events).not.toContain(gate === 'publishGate' ? 'publish' : 'merge')
  })
}
test('host prepares the next brief from measured state and prior work', async () => {
  const f = fixture()
  f.outcomes.set('run:plan:0', f.completed({ ...f.snapshot, payload: singlePlan }))
  f.decisions.push({ kind: 'fix', findings: ['missing validation'] })
  const prepared: { role: string; previous: unknown; findings: readonly string[] }[] = []
  f.deps.prepareWork = async (request, context) => { prepared.push({ role: request.role, previous: context.previous, findings: context.findings }) }
  expect((await f.run()).kind).toBe('merged')
  expect(prepared.find(p => p.role === 'build')?.previous).toEqual(singlePlan)
  expect(prepared.find(p => p.role === 'fix')?.findings).toEqual(['missing validation'])
})
test('G030 caps a planner branch brief before preparing the builder context', async () => {
  const f = modeFixture()
  const brief = `${'a'.repeat(4093)}😀`
  f.setPlan({ ...f.plan, branchBrief: brief })
  expect(await f.run()).toMatchObject({ kind: 'continued' })
  const previous = f.prepared.find(p => p.role === 'build')?.previous as { branchBrief: string }
  expect(Buffer.byteLength(previous.branchBrief, 'utf8')).toBe(4096)
  expect(previous.branchBrief).toEndWith('[branch-state brief truncated at 4096 bytes]')
})

for (const role of ['plan', 'review', 'fix'] as const) {
  test(`${role} unknown preserves its pending step`, async () => {
    const f = fixture()
    if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['logic'] })
    const step = `run:${role}:${role === 'plan' ? 0 : 1}`
    f.outcomes.set(step, { kind: 'unknown', detail: 'unobserved' })
    expect(await f.run()).toMatchObject({ kind: 'unknown', step_id: role === 'review' ? `${step}:head:${f.snapshot.head}` : step, phase: role })
    expect(f.events).not.toContain('merge')
  })
}
test('build head and diff advance from the initial base under host observation', async () => {
  const f = fixture()
  const built = structuredClone(f.snapshot)
  f.snapshot.head = '0'.repeat(40); f.snapshot.diff = ''
  f.outcomes.set('run:plan:0', f.completed({ ...structuredClone(f.snapshot), payload: singlePlan }))
  const measure = f.deps.measure; let reads = 0
  f.deps.measure = async () => {
    if (++reads === 3) Object.assign(f.snapshot, built)
    return measure()
  }
  expect(await f.run()).toMatchObject({ kind: 'merged', snapshot: { head: built.head, diff: built.diff } })
})
test('fixed leak status without revision change remains eligible', async () => {
  const f = fixture(); const leak = f.deps.runLeakGatePreflight
  f.deps.runLeakGatePreflight = async s => ({ ...await leak(s), status: 'fixed' })
  expect((await f.run()).kind).toBe('merged')
})
for (const change of ['head', 'diff', 'pr-head', 'closed'] as const) {
  test(`published ${change} drift cannot merge`, async () => {
    const f = fixture(); const publish = f.deps.publish
    f.deps.publish = async s => {
      await publish(s)
      if (change === 'head') f.snapshot.head = 'f'.repeat(40)
      if (change === 'diff') f.snapshot.diff = '+unreviewed'
      if (change === 'pr-head') f.snapshot.pr!.head = 'f'.repeat(40)
      if (change === 'closed') f.snapshot.pr!.state = 'CLOSED'
    }
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Published PR does not match candidate revision' })
    expect(f.events).not.toContain('merge')
  })
}
for (const change of ['number', 'head'] as const) {
  test(`merged PR ${change} must match the reviewed PR`, async () => {
    const f = fixture(); const merge = f.deps.merge
    f.deps.merge = async s => { await merge(s); if (change === 'number') f.snapshot.pr!.number = 2; else f.snapshot.pr!.head = 'f'.repeat(40) }
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Merge not confirmed for reviewed PR' })
  })
}

function modeFixture(mode: 'single' | 'task_sequence' | 'wave' | 'bound_pr' = 'task_sequence') {
  const f = fixture()
  f.input.mode = mode === 'single' || mode === 'task_sequence' ? 'implementation' : mode
  const strategy = mode === 'task_sequence' || mode === 'wave' ? 'task_sequence' : 'single'
  if (f.input.mode === 'implementation') f.input.executionStrategy = strategy
  const plan: ExecutionPlan = { implementationPlan: '- [ ] T1: first\n- [ ] T2: second', topTask: '- [ ] T1: first', remainingTasks: strategy === 'single' ? 0 : 1,
    executionSpec: 'implement one task', complexity: 'mechanical', strategy, rationale: 'The selected strategy matches the accepted execution boundaries.' }
  const state: {
    resume: import('./build-run.ts').ResumeCheckpoint | null
    probe: import('./build-run.ts').PlanProbe | null
    regenerated: string
    oldResult: unknown
    advances: number
    /** Every ledger commit the driver asked for, with the head it asked on. */
    commits: { body: string; head: string }[]
    /** The body the fake branch tip already commits, for the idempotent path. */
    committedBody: string | null
    advanced: import('./build-run.ts').BuildSnapshot[]
    checkpoints: import('./build-run.ts').ResumeCheckpoint[]
  } = { resume: null, probe: null, regenerated: f.snapshot.diff, oldResult: { built: true }, advances: 0,
    commits: [], committedBody: null, advanced: [], checkpoints: [] }
  const prepared: { role: string; previous: unknown; planner?: string; findings: readonly string[]; suiteScope?: string }[] = []
  f.deps.prepareWork = async (request, context) => { prepared.push({ role: request.role, ...structuredClone(context) }) }
  // The ledger commit a real host makes: a NEW head on top of the measured one, and
  // every later worker trailer describes that head.
  const ledgerHead = 'c'.repeat(40)
  let acceptedPlan = plan
  f.deps.modes = {
    loadExecutionStrategy: async () => ({ kind: 'known', strategy, rationale: acceptedPlan.rationale, plan: acceptedPlan, source: 'planner' }),
    selectExecutionStrategy: async value => { acceptedPlan = structuredClone(value.plan); return { kind: 'allow' } },
    loadResume: async () => state.resume,
    saveCheckpoint: async checkpoint => { f.events.push(`checkpoint:${checkpoint.stage}:${checkpoint.head}`); state.checkpoints.push(structuredClone(checkpoint)) },
    regenerateDiff: async head => { f.events.push(`diff:${head}`); return { kind: 'known', diff: state.regenerated } },
    probePlan: async () => { f.events.push('probe'); return state.probe },
    commitPlan: async ({ body, snapshot }) => {
      f.events.push('commitPlan')
      state.commits.push({ body, head: snapshot.head })
      if (snapshot.head !== f.snapshot.head) return { kind: 'blocked', on: 'Host observation changed since the gate' }
      if (state.committedBody === body) return { kind: 'known', head: f.snapshot.head }
      const old = f.snapshot.head
      state.committedBody = body
      f.snapshot.head = ledgerHead
      f.snapshot.diff += 'diff --git a/.trident/ledgers/change.md b/.trident/ledgers/change.md\n'
      for (const outcome of f.outcomes.values()) {
        if (outcome.kind === 'completed' && outcome.result && typeof outcome.result === 'object' && 'head' in outcome.result && outcome.result.head === old) outcome.result.head = ledgerHead
      }
      return { kind: 'known', head: ledgerHead }
    },
    advanceTask: async value => {
      f.events.push(`advance:${value.snapshot.head}`)
      state.advanced.push(structuredClone(value.snapshot))
      state.oldResult = null; state.advances++; return { kind: 'allow' }
    },
  }
  const setPlan = (payload: unknown = plan) => f.outcomes.set('run:plan:0', f.completed({ ...f.snapshot, payload }))
  setPlan()
  const resume = (stage: import('./build-run.ts').ResumeCheckpoint['stage'] = 'built', round = 1,
    previousReview: import('./gates/review-progress.ts').ReviewProgress | null = null) => {
    f.input.start = 'resume'
    state.resume = { head: f.snapshot.head, stage, round, findings: [], previousFindings: [], previousReview,
      reviewBaseline: previousReview === null ? 'none' : 'required' }
    return state.resume
  }
  return { ...f, state, plan, prepared, setPlan, resume, ledgerHead, run: () => {
    if (f.input.executionStrategy === 'task_sequence') {
      for (const [key, value] of [...f.outcomes]) {
        if (!key.includes(':task:')) f.outcomes.set(key.replace('run:', `run:task:${f.input.taskIteration ?? 0}:`), value)
      }
    }
    return f.run()
  } }
}

for (const mode of ['task_sequence', 'wave'] as const) {
  test(`G025 G024 ${mode} requires a non-null valid plan before build`, async () => {
    for (const payload of [null, {}, { remainingTasks: -1 }]) {
      const f = modeFixture(mode); f.setPlan(payload)
      expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Planner returned no execution plan' })
      expect(f.runner.calls.map(c => c.role)).toEqual(['plan'])
    }
  })
}

test('G024 wave selects exactly the unchecked pinned task', async () => {
  for (const body of ['- [x] T1: first\n- [ ] T2: second', '- [ ] T2: second', '- [ ] T10: different']) {
    const f = modeFixture('wave'); f.input.pinnedTaskId = 'T1'; f.plan.implementationPlan = body; f.setPlan()
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Plan has no unchecked pinned wave task' })
    expect(f.runner.calls.map(c => c.role)).toEqual(['plan'])
  }
  const f = modeFixture('wave'); f.input.pinnedTaskId = 'T2'
  expect(await f.run()).toMatchObject({ kind: 'built', cause: 'wave-member-built' })
  expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject({ topTask: '- [ ] T2: second', remainingTasks: 0 })
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('publish')
})

test('G034 wave requires a measured full commit even with a matching trailer', async () => {
  for (const head of ['short', 'absent', 'b'.repeat(64)]) {
    const f = modeFixture('wave'); f.input.pinnedTaskId = 'T1'; f.snapshot.head = head; f.setPlan()
    f.outcomes.set('run:build:0', f.completed())
    expect((await f.run()).kind).toBe(head.length === 64 ? 'built' : 'failed')
    expect(f.runner.calls.map(c => c.role)).toEqual(['plan', 'build'])
    expect(f.cross.calls).toHaveLength(0)
  }
})

function cheapFixture() {
  const f = modeFixture(); f.resume('task-built'); f.input.taskIteration = 2
  f.state.probe = { found: true, body: f.plan.implementationPlan,
    sha256: new Bun.CryptoHasher('sha256').update(f.plan.implementationPlan).digest('hex'), uncheckedCount: 2 }
  return f
}

for (const mutation of ['unchanged', 'tick', 'drop', 'reorder', 'false-terminal'] as const) {
  for (const iteration of [2, 5]) {
    test(`task refresh preserves pending identity: ${mutation} iteration ${iteration}`, async () => {
      const f = cheapFixture(); f.input.taskIteration = iteration
      if (mutation !== 'unchanged') f.setPlan({ ...f.plan,
        implementationPlan: mutation === 'tick' ? '- [x] T1: first\n- [ ] T2: second'
          : mutation === 'reorder' ? '- [ ] T2: second\n- [ ] T1: first'
          : mutation === 'false-terminal' ? f.plan.implementationPlan : '- [ ] T2: second',
        topTask: mutation === 'false-terminal' ? f.plan.topTask : '- [ ] T2: second',
        remainingTasks: mutation === 'reorder' ? 1 : 0,
      })
      const outcome = await f.run()
      const refused = iteration === 5 && mutation !== 'unchanged'
      expect(outcome.kind).toBe(refused ? 'blocked' : 'continued')
      expect(f.cross.calls).toHaveLength(0)
      expect(f.state.advances).toBe(refused ? 0 : 1)
      expect(f.events).not.toContain('publish')
      if (refused) {
        expect(f.runner.calls.map(c => c.role)).toEqual(['plan'])
        expect((await f.deps.modes!.loadExecutionStrategy())).toMatchObject({ plan: f.plan })
      } else expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject({
        topTask: '- [ ] T1: first', remainingTasks: 1,
      })
    })
  }
}

test('task refresh allows execution detail revisions without completing tasks', async () => {
  const f = cheapFixture(); f.input.taskIteration = 5
  f.setPlan({ ...f.plan, executionSpec: 'Use the revised implementation approach', rationale: 'Revised details' })
  expect((await f.run()).kind).toBe('continued')
  expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject({
    topTask: f.plan.topTask, executionSpec: 'Use the revised implementation approach' })
  expect(f.cross.calls).toHaveLength(0)
})

test('task refresh preserves a previously accepted terminal task without checkbox syntax', async () => {
  const f = modeFixture()
  f.plan.implementationPlan = '## T1 first'; f.plan.topTask = 'T1 first'; f.plan.remainingTasks = 0
  f.setPlan({ ...f.plan, executionSpec: 'Revised terminal execution details' })
  expect((await f.run()).kind).toBe('merged')
  expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject({ topTask: 'T1 first', remainingTasks: 0 })
})

for (const source of ['planner', 'legacy'] as const) {
  test(`task refresh allows checkpoint-backed terminal advancement (${source})`, async () => {
    const f = cheapFixture(); f.input.taskIteration = 5; f.state.resume!.remainingTasks = 1
    const load = f.deps.modes!.loadExecutionStrategy
    f.deps.modes!.loadExecutionStrategy = async () => ({ ...await load(), source })
    f.setPlan({ ...f.plan, implementationPlan: '- [x] T1: first\n- [ ] T2: second',
      topTask: '- [ ] T2: second', remainingTasks: 0 })
    expect((await f.run()).kind).toBe('merged')
    expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject({ topTask: '- [ ] T2: second', remainingTasks: 0 })
    expect(f.cross.calls).toHaveLength(1)
  })
}

test('task refresh cannot advance on an uncorroborated handoff head', async () => {
  const f = cheapFixture(); f.input.taskIteration = 5; f.state.resume!.remainingTasks = 1
  f.state.resume!.head = 'b'.repeat(40)
  f.outcomes.set('run:plan:1', f.completed({ ...f.snapshot, payload: { ...f.plan,
    implementationPlan: '- [ ] T2: second', topTask: '- [ ] T2: second', remainingTasks: 0 } }))
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Planner cannot change the host-owned pending task sequence' })
  expect(f.runner.calls.map(c => c.role)).toEqual(['plan'])
})

test('task refresh recovery cannot advance twice after the selection was persisted', async () => {
  const f = cheapFixture(); f.input.taskIteration = 5
  f.plan.implementationPlan += '\n- [ ] T3: third'; f.plan.remainingTasks = 2
  f.state.resume!.remainingTasks = 2
  f.setPlan({ ...f.plan, implementationPlan: '- [x] T1: first\n- [ ] T2: second\n- [ ] T3: third',
    topTask: '- [ ] T2: second', remainingTasks: 1 })
  const save = f.deps.modes!.saveCheckpoint
  let interrupted = false
  f.deps.modes!.saveCheckpoint = async checkpoint => {
    if (!checkpoint.pending && !interrupted) { interrupted = true; throw new Error('interrupted after selection') }
    await save(checkpoint)
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'interrupted after selection' })
  expect(f.runner.calls.map(c => c.role)).toEqual(['plan'])
  f.state.resume = structuredClone(f.state.checkpoints.at(-1)!)
  f.input.workers.plan.runner = { ...f.runner, recover: f.runner.run }
  f.runner.calls.length = 0
  expect(await f.run()).toMatchObject({ kind: 'continued', remainingTasks: 1 })
  expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject({ topTask: '- [ ] T2: second', remainingTasks: 1 })
  expect(f.cross.calls).toHaveLength(0)
})

test('task budget preflight refuses an exhausted clean continuation before any worker', async () => {
  const f = cheapFixture()
  f.deps.modes!.selectExecutionStrategy = async () => ({ kind: 'blocked', on: 'task iteration budget is exhausted' })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'task iteration budget is exhausted' })
  expect(f.runner.calls).toEqual([])
  expect(f.prepared).toEqual([])
})

test('task budget preflight permits a clean continuation with remaining budget', async () => {
  const f = cheapFixture()
  expect(await f.run()).toMatchObject({ kind: 'continued', remainingTasks: 1 })
  expect(f.runner.calls.map(c => c.role)).toEqual(['plan', 'build'])
  expect(f.prepared[0]?.planner).toBe('next')
})

test('task budget preflight permits an exhausted intermediate checkpoint to settle without workers', async () => {
  const f = modeFixture()
  f.resume('built').remainingTasks = 1
  f.deps.modes!.selectExecutionStrategy = async () => ({ kind: 'blocked', on: 'task iteration budget is exhausted' })
  expect(await f.run()).toMatchObject({ kind: 'continued', remainingTasks: 1 })
  expect(f.state.commits).toHaveLength(1)
  expect(f.state.advances).toBe(1)
  expect(f.runner.calls).toEqual([])
})

test('G026 clean handoff and positive round outside refresh interval select next planner', async () => {
  for (const round of [0, -1, 1.5, 5, 10, 2]) {
    const f = cheapFixture(); f.input.taskIteration = round
    await f.run()
    expect(f.prepared[0]?.planner).toBe(round === 2 ? 'next' : 'full')
    expect(f.events.includes('probe')).toBe(round === 2)
  }
  for (const stage of ['built', 'task-built-deviated'] as const) {
    const f = cheapFixture(); f.state.resume!.stage = stage
    await f.run()
    expect(f.events).not.toContain('probe')
    expect(f.prepared.every(p => p.planner !== 'next')).toBe(true)
  }
})

test('G027 missing empty exhausted and incoherent plans use full planner', async () => {
  for (const patch of [{ found: false }, { body: '' }, { uncheckedCount: 0 }, { uncheckedCount: 1.5 }]) {
    const f = cheapFixture(); Object.assign(f.state.probe!, patch)
    await f.run()
    expect(f.prepared[0]?.planner).toBe('full')
    expect(f.events).toContain('probe')
  }
})

test('G028 checksum and measured unchecked count must both agree', async () => {
  for (const patch of [{ sha256: 'wrong' }, { uncheckedCount: 1 }]) {
    const f = cheapFixture(); Object.assign(f.state.probe!, patch)
    await f.run()
    expect(f.prepared[0]?.planner).toBe('full')
    expect(f.events).toContain('probe')
  }
})

test('G029 committed body task and count replace cheap planner claims', async () => {
  const f = cheapFixture()
  f.setPlan({ ...f.plan, implementationPlan: 'invented', topTask: 'wrong task', remainingTasks: 0 })
  expect(await f.run()).toMatchObject({ kind: 'continued', remainingTasks: 1 })
  expect(f.prepared[0]?.planner).toBe('next')
  expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject(f.plan)
})

test('G037 intermediate task atomically consumes old result before continuation', async () => {
  const f = modeFixture()
  expect(await f.run()).toMatchObject({ kind: 'continued', cause: 'task-built' })
  expect(f.state.oldResult).toBeNull()
  expect(f.state.advances).toBe(1)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('publish')
  const terminal = modeFixture(); terminal.plan.implementationPlan = '- [ ] T1: first'; terminal.plan.remainingTasks = 0; terminal.setPlan()
  expect((await terminal.run()).kind).toBe('merged')
  expect(terminal.cross.calls).toHaveLength(1)
  expect(terminal.state.advances).toBe(0)
})
for (const kind of ['blocked', 'unknown'] as const) {
  test(`G037 handoff ${kind} never acknowledges continuation`, async () => {
    const f = modeFixture()
    f.deps.modes!.advanceTask = async () => kind === 'blocked' ? { kind, on: 'head moved' } : { kind, detail: 'write unobserved' }
    expect(await f.run()).toMatchObject({ kind })
    expect(f.state.oldResult).not.toBeNull()
    expect(f.cross.calls).toHaveLength(0)
  })
}

// ── THE TASK LEDGER (spec item a-retry-must-resume-from-the-checkpoint, acceptance 2) ──
// G026's cheap planner reads the committed ledger at the tip, and nothing in the
// typed host used to write one, so every continuation re-planned from scratch. The
// driver now refuses a HANDOFF ledger that disagrees with its counts and commits the
// ticked ledger at the handoff, BEFORE `advanceTask` records the head.

test('G025 ledger: a task-sequence handoff plan whose unchecked lines disagree with topTask/remainingTasks is no plan', async () => {
  const ledger = 'Planner returned no execution plan: the task ledger disagrees with topTask/remainingTasks'
  for (const patch of [
    { remainingTasks: 2 },                                   // count says three, the ledger has two
    { implementationPlan: '- [ ] T1: first\n- [ ] T2: second\n- [ ] T3: third' }, // count says two, the ledger has three
    { topTask: '- [ ] T2: second' },                         // the top task is not the first unchecked line
    { topTask: 'T2: second' },                               // …with or without its checkbox marker
    { implementationPlan: '## T1 first\n## T2 second' },     // headings, no boxes: what iteration 1 of this card returned
  ]) {
    const f = modeFixture(); f.setPlan({ ...f.plan, ...patch })
    expect(await f.run(), JSON.stringify(patch)).toMatchObject({ kind: 'blocked', phase: 'plan', on: ledger })
    expect(f.runner.calls.map(c => c.role)).toEqual(['plan'])
    expect(f.state.commits).toEqual([])
  }
  // A whole-plan single build does not derive execution boundaries from checkbox counts.
  const pr = modeFixture('single'); pr.setPlan({ ...pr.plan, topTask: 'Complete both tasks', remainingTasks: 0 })
  expect((await pr.run()).kind).toBe('merged')
  expect(pr.state.commits).toEqual([])
  // Whitespace, or a missing checkbox marker, around an otherwise verbatim top task
  // is not a disagreement: both name the ledger's first unchecked task.
  for (const topTask of ['  - [ ] T1: first  ', 'T1: first']) {
    const same = modeFixture(); same.setPlan({ ...same.plan, topTask })
    expect((await same.run()).kind, topTask).toBe('continued')
    expect(same.state.commits.map(c => c.body)).toEqual(['- [x] T1: first\n- [ ] T2: second'])
  }
})

test('G025 ledger: single strategy does not impose task-sequence ledger shape', async () => {
  // Single executes the whole plan, independently of its checkbox formatting.
  for (const patch of [
    { implementationPlan: '## T1 first', topTask: 'T1 first', remainingTasks: 0 },
    { implementationPlan: '- [ ] T1: first\n- [ ] T2: second', remainingTasks: 0 },
  ]) {
    const f = modeFixture('single'); f.setPlan({ ...f.plan, ...patch })
    expect((await f.run()).kind, JSON.stringify(patch)).toBe('merged')
    expect(f.state.commits).toEqual([])
  }
})

test('task-sequence handoff commits the ticked ledger and hands the LEDGER head to advanceTask', async () => {
  const f = modeFixture()
  const outcome = await f.run()
  expect(outcome).toMatchObject({ kind: 'continued', remainingTasks: 1, snapshot: { head: f.ledgerHead } })
  // Exactly the top task ticked, rendered from the plan the build executed, on the built head.
  expect(f.state.commits).toEqual([{ body: '- [x] T1: first\n- [ ] T2: second', head: 'a'.repeat(40) }])
  expect(f.state.advanced.map(s => s.head)).toEqual([f.ledgerHead])
  // The checkpoint moves to the ledger commit BEFORE the handoff reads it.
  // (The two `pending` reservations before plan and build carry no head yet.)
  const order = f.events.filter(e => e === 'commitPlan' || (e.startsWith('checkpoint:built:') && !e.endsWith(':null')) || e.startsWith('advance:'))
  expect(order).toEqual([`checkpoint:built:${'a'.repeat(40)}`, 'commitPlan', `checkpoint:built:${f.ledgerHead}`, `advance:${f.ledgerHead}`])
})

test('task-sequence ledger commit that writes nothing keeps the head and makes no second checkpoint', async () => {
  const f = modeFixture(); f.state.committedBody = '- [x] T1: first\n- [ ] T2: second'
  expect(await f.run()).toMatchObject({ kind: 'continued', snapshot: { head: 'a'.repeat(40) } })
  expect(f.state.commits).toHaveLength(1)
  expect(f.state.advanced.map(s => s.head)).toEqual(['a'.repeat(40)])
  expect(f.state.checkpoints.filter(c => c.stage === 'built' && c.pending === undefined && c.head === f.snapshot.head)).toHaveLength(1)
})

test('task-sequence ledger commit refusal or an unmeasured ledger head never hands off', async () => {
  for (const reply of [
    { kind: 'blocked', on: 'Host observation changed since the gate' },
    { kind: 'unknown', detail: 'Task ledger commit was not confirmed' },
    { kind: 'known', head: 'd'.repeat(40) },                 // claims a head the branch is not at
  ] as const) {
    const f = modeFixture()
    f.deps.modes!.commitPlan = async () => reply
    const outcome = await f.run()
    expect(outcome).toMatchObject(reply.kind === 'blocked' ? { kind: 'blocked', phase: 'build', on: reply.on }
      : { kind: 'unknown', phase: 'build', detail: reply.kind === 'unknown' ? reply.detail : 'Task ledger commit is not the measured branch head' })
    expect(f.state.advances).toBe(0)
    expect(f.state.oldResult).not.toBeNull()
  }
})

test('final task-sequence iteration never moves the reviewed head with a ledger commit', async () => {
  // A one-task run: no continuation will read a ledger, so the host adds nothing to
  // the diff the builder's receipts are bound to.
  const single = modeFixture(); single.plan.implementationPlan = '- [ ] T1: first'; single.plan.remainingTasks = 0; single.setPlan()
  expect((await single.run()).kind).toBe('merged')
  expect(single.state.commits).toEqual([])
  // The last iteration of a multi-task run, whose diff already carries the handoff
  // ledger: the reviewed and merged revision is still the BUILDER's head, because
  // every worker receipt review and publication read is bound to that head.
  const last = modeFixture(); last.snapshot.diff = 'diff --git a/.trident/ledgers/change.md b/.trident/ledgers/change.md\n+ledger\n'
  last.plan.implementationPlan = '- [x] T1: first\n- [ ] T2: second'; last.plan.topTask = '- [ ] T2: second'; last.plan.remainingTasks = 0; last.setPlan()
  expect(await last.run()).toMatchObject({ kind: 'merged', snapshot: { head: 'a'.repeat(40) } })
  expect(last.state.commits).toEqual([])
  expect(last.state.advances).toBe(0)
  expect(last.cross.calls.every(c => c.step_id.includes(':review:'))).toBe(true)
  expect(last.events).not.toContain('commitPlan')
})

test('iteration 2 continues from the ledger iteration 1 committed, not a regenerated plan', async () => {
  // Iteration 1: a fresh plan, one task built, the ticked ledger committed.
  const first = modeFixture()
  expect((await first.run()).kind).toBe('continued')
  const committed = first.state.commits[0]!.body
  // Iteration 2: the resumed run at the handoff the first one recorded, with the
  // probe returning exactly the bytes the first iteration committed.
  const f = modeFixture(); f.resume('task-built'); f.input.taskIteration = 1
  f.state.probe = { found: true, body: committed, uncheckedCount: 1,
    sha256: new Bun.CryptoHasher('sha256').update(committed).digest('hex') }
  // The planner is a model: its claim is untrusted and here deliberately wrong.
  f.setPlan({ ...f.plan, implementationPlan: 'a whole new plan', topTask: '- [ ] T9: invented', remainingTasks: 7 })
  expect((await f.run()).kind).toBe('merged')
  expect(f.prepared[0]).toMatchObject({ role: 'plan', planner: 'next', committedPlan: { body: committed } })
  expect(f.prepared.find(p => p.role === 'build')?.previous).toMatchObject({
    implementationPlan: '- [x] T1: first\n- [ ] T2: second', topTask: '- [ ] T2: second', remainingTasks: 0 })
})

test('G038 exact full resume head skips build; moved missing and short heads rebuild', async () => {
  for (const head of [null, 'short', 'b'.repeat(40), 'a'.repeat(40)]) {
    const f = modeFixture('single'); const checkpoint = f.resume('approved', 1, { findings: [], blockingCount: 0 }); checkpoint.head = head
    expect((await f.run()).kind).toBe('merged')
    expect(f.runner.calls.some(c => c.role === 'build')).toBe(head !== f.snapshot.head)
    expect(f.cross.calls.length).toBe(head === f.snapshot.head ? 0 : 1)
  }
})

for (const moved of [false, true]) test(`review recovery ${moved ? 'invalidates a moved head' : 'reuses the exact head'} without resetting its round`, async () => {
  const f = modeFixture('single')
  f.resume('built', 3, { findings: ['prior'], blockingCount: 1 })
  const results = new Map<string, BoundedWorkOutcome>()
  const paid: string[] = []
  const requested: string[] = []
  f.cross.run = async request => {
    requested.push(request.step_id)
    if (!results.has(request.step_id)) {
      paid.push(request.step_id)
      results.set(request.step_id, f.completed())
    }
    return structuredClone(results.get(request.step_id)!)
  }
  let ciReads = 0
  f.deps.reviewCi = async () => ++ciReads === 2
    ? { kind: 'unknown', detail: 'post-review CI unavailable' }
    : { kind: 'known', findings: [] }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'review' })
  const saved = f.state.checkpoints.at(-1)!
  expect(saved.pending).toMatchObject({ phase: 'review', step_id: requested[0]! })
  // The host has reconciled the completed pending worker. Its settled result
  // remains owned by that id; a fresh driver must reuse it only at the same head.
  f.state.resume = { ...saved, pending: undefined }
  if (moved) {
    f.snapshot.head = 'b'.repeat(40)
    f.snapshot.pr!.head = f.snapshot.head
    for (const key of f.outcomes.keys()) f.outcomes.set(key, f.completed({ ...f.snapshot, ...(key.includes(':plan:') ? { payload: singlePlan } : {}) }))
  }
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(paid).toHaveLength(moved ? 2 : 1)
  expect(requested).toEqual([
    `run:review:3:head:${'a'.repeat(40)}`,
    `run:review:3:head:${(moved ? 'b' : 'a').repeat(40)}`,
  ])
  const reservations = f.state.checkpoints.filter(row => row.pending?.phase === 'review')
  expect(reservations.map(row => row.pending!.step_id)).toEqual(requested)
  expect(reservations.every(row => row.round >= 3)).toBe(true)
  expect(f.runner.calls.filter(row => row.role === 'build')).toHaveLength(moved ? 1 : 0)
})

test('G038 absent live head rebuilds but unreadable required head stops', async () => {
  for (const head of ['absent', '']) {
    const f = modeFixture('single'); f.resume(); f.snapshot.head = head; f.setPlan()
    const measure = f.deps.measure; let reads = 0
    f.deps.measure = async () => { if (++reads === 3) f.snapshot.head = 'a'.repeat(40); return measure() }
    expect((await f.run()).kind).toBe(head === 'absent' ? 'merged' : 'failed')
    expect(f.runner.calls.some(c => c.role === 'build')).toBe(head === 'absent')
  }
})

test('G039 only actionable code findings buy a resumed fix', async () => {
  for (const finding of [null, { kind: 'lane', actionable: true, text: 'seat down' },
    { kind: 'code', actionable: false, text: 'advisory' }, { kind: 'code', actionable: true, text: 'bug' }] as const) {
    const f = modeFixture('single'); const checkpoint = f.resume('rejected', 2, { findings: finding ? [finding.text] : [], blockingCount: finding?.actionable ? 1 : 0 })
    checkpoint.findings = finding ? [finding] : []
    expect((await f.run()).kind).toBe('merged')
    const actionable = finding?.kind === 'code' && finding.actionable
    expect(f.runner.calls.map(c => c.role)).toEqual(actionable ? ['fix'] : [])
    expect(f.cross.calls).toHaveLength(1)
    if (actionable) expect(f.prepared[0]?.findings).toEqual(['bug'])
  }
})

test('G040 resume diff is regenerated from pinned OID and empty diff rebuilds', async () => {
  for (const diff of ['', '+built\n']) {
    const f = modeFixture('single'); f.resume(); f.state.regenerated = diff
    expect((await f.run()).kind).toBe('merged')
    expect(f.events).toContain(`diff:${'a'.repeat(40)}`)
    expect(f.runner.calls.some(c => c.role === 'build')).toBe(diff === '')
  }
})

test('G041 resume inherits spent rounds and cannot restart exhausted budget', async () => {
  for (const stage of ['fixed', 'rejected'] as const) {
    const f = modeFixture('single'); const checkpoint = f.resume(stage, 10, { findings: ['prior'], blockingCount: 2 })
    checkpoint.findings = [{ kind: 'code', actionable: true, text: 'bug' }]
    f.decisions.push({ kind: 'fix', findings: ['bug'] })
    expect(await f.run()).toMatchObject({ kind: 'blocked', recipient: 'orchestrator' })
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls.map(c => c.step_id.replace(/:head:[a-f0-9]+$/, ''))).toEqual(stage === 'fixed' ? ['run:review:10'] : [])
  }
  const f = modeFixture('single'); f.resume('fixed', 3, { findings: ['prior'], blockingCount: 2 })
  f.decisions.push({ kind: 'fix', findings: ['new bug'] })
  expect((await f.run()).kind).toBe('merged')
  expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:fix:3'])
  expect(f.cross.calls.map(c => c.step_id.replace(/:head:[a-f0-9]+$/, ''))).toEqual(['run:review:3', 'run:review:4'])
})

test('resume pending worker preserves phase and exact step without dispatch', async () => {
  const f = modeFixture('single'); const checkpoint = f.resume()
  checkpoint.pending = { phase: 'fix', step_id: 'original:fix:3' }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'fix', step_id: 'original:fix:3' })
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
})

for (const role of ['plan', 'build', 'review', 'fix'] as const) for (const reservationState of ['retained', 'missing', 'unarmed', 'foreign'] as const) {
  const missingReservation = reservationState !== 'retained'
  test(`pending ${role} ${missingReservation ? `refuses ${reservationState} reservation` : 'recovers its original file result'} after restart without another provider turn`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'build-recovery-'))
    try {
      const f = modeFixture('single')
      f.input.repl_provider = 'openai-codex'
      if (role === 'fix') f.resume('rejected', 3, { findings: ['logic'], blockingCount: 1 }).findings = [{ kind: 'code', actionable: true, text: 'logic' }]
      let panels = 0
      const observeReview = f.deps.observeReview
      f.deps.observeReview = async (...args) => { panels++; return observeReview(...args) }
      const request = { ...f.input.workers[role].request, cwd: directory,
        brief: { path: join(directory, 'brief.md'), integrity: briefIntegrity(`${join(directory, 'brief.md')}.context.json`) },
        result: { path: join(directory, 'result.json'), schema: 'build/1' } }
      f.deps.reviewArtifact = (req, snapshot) => reviewArtifact(req, snapshot, async path =>
        path === req.brief.path ? `${req.brief.path}.context.json` : JSON.stringify({ request: req, snapshot }))
      let providerTurns = 0
      let original: BoundedWorkRequest | undefined
      let recoveredResult: unknown
      const requests: BoundedWorkRequest[] = []
      const makeRunner = () => {
        const runner = codexInReplRunner({
          state_dir: directory, topic_id: 'project-topic', spec: { tools: [], model_preference: ['test'] },
          composeActingTurn: async (_topic, spec) => {
            providerTurns++
            const args = JSON.parse(spec.prompt.split('\n')[1]!)
            original = JSON.parse(args.message.split('\n').find((line: string) => line.startsWith('Request (data): '))!.slice(16))
            if (role !== 'review') {
              f.snapshot.head = 'b'.repeat(40)
              if (f.snapshot.pr) f.snapshot.pr.head = f.snapshot.head
              for (const outcome of f.outcomes.values()) {
                if (outcome.kind === 'completed' && outcome.result && typeof outcome.result === 'object') Object.assign(outcome.result, structuredClone(f.snapshot))
              }
            }
            recoveredResult = { ...structuredClone(f.snapshot), ...(role === 'plan' ? { payload: f.plan } : {}) }
            await writeFile(request.result.path, JSON.stringify({ ...original, schema: request.result.schema, kind: 'completed', result: recoveredResult }))
            throw new Error('Acknowledgement lost after the original worker wrote its result')
          },
          decodeTrailer: (bytes, req) => decodeProjectTrailer(bytes, req, {
            schemas: new Map([['build/1', (result: unknown) => result !== null && typeof result === 'object']]),
            metadata: () => undefined,
          }),
        })
        const run = runner.run
        runner.run = async (req, placement, signal) => { requests.push(structuredClone(req)); return run(req, placement, signal) }
        const recover = runner.recover!
        runner.recover = async (req, placement, signal) => { requests.push(structuredClone(req)); return recover(req, placement, signal) }
        return runner
      }
      f.input.workers[role] = { request, runner: makeRunner() }
      expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role })
      const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
      expect(saved.pending.recovery.request).toEqual(original)
      expect(saved.pending.recovery.previousReview).toEqual(role === 'fix' ? { findings: ['logic'], blockingCount: 1 } : null)
      const preparedBefore = f.prepared.filter(value => value.role === role).length
      const panelsBefore = panels
      const checkpointsBefore = f.state.checkpoints.length
      const key = createHash('sha256').update(JSON.stringify([original!.run_id, original!.step_id])).digest('hex')
      const reservationPath = join(directory, `codex-step-${key}.json`)
      if (reservationState === 'missing') await rm(reservationPath)
      if (reservationState === 'unarmed') await writeFile(reservationPath, JSON.stringify(original))
      if (reservationState === 'foreign') await writeFile(reservationPath, JSON.stringify({ ...original, step_id: 'other-step' }) + '\n#dispatch-armed\n')
      const reservationBytes = reservationState === 'missing' ? null : await readFile(reservationPath, 'utf8')
      const resultBytes = await readFile(request.result.path, 'utf8')
      f.state.resume = saved
      f.input.start = 'resume'
      if (f.snapshot.pr) f.input.owned_pr = f.snapshot.pr.number
      f.input.workers[role].runner = makeRunner()
      expect(await f.run()).toMatchObject({ kind: missingReservation ? 'unknown' : 'merged' })
      expect(providerTurns).toBe(1)
      expect(requests).toEqual([original!, original!])
      expect(f.prepared.filter(value => value.role === role)).toHaveLength(preparedBefore)
      if (missingReservation) {
        expect(panels).toBe(panelsBefore)
        expect(f.state.checkpoints).toHaveLength(checkpointsBefore)
        expect(f.state.checkpoints.at(-1)?.pending?.step_id).toBe(original!.step_id)
        expect(f.events).not.toContain('merge')
        expect(await readFile(request.result.path, 'utf8')).toBe(resultBytes)
        if (reservationBytes === null) await expect(readFile(reservationPath)).rejects.toMatchObject({ code: 'ENOENT' })
        else expect(await readFile(reservationPath, 'utf8')).toBe(reservationBytes)
      } else {
        expect(f.state.checkpoints.at(-1)?.pending).toBeUndefined()
        expect(f.events).toContain('publicationSuite')
        expect(f.events).toContain('mergeGate')
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}

async function pendingBuildFixture() {
  const f = modeFixture('single')
  const original = f.completed()
  f.outcomes.set('run:build:0', { kind: 'unknown', detail: 'lost acknowledgement' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'build' })
  f.state.resume = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  f.input.start = 'resume'
  f.outcomes.set('run:build:0', original)
  f.input.workers.build.runner = { ...f.runner, recover: f.runner.run }
  f.runner.calls.length = 0
  f.cross.calls.length = 0
  return f
}

for (const progress of ['missing', 'null', 'invalid', 'valid'] as const) test(`pending fix requires ${progress} review progress to preserve the repeated-finding gate`, async () => {
  const f = modeFixture('single')
  f.decisions.push({ kind: 'fix', findings: ['repeat'], blockingCount: 1 })
  f.outcomes.set('run:fix:1', { kind: 'unknown', detail: 'lost acknowledgement' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'fix' })
  const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  expect(saved.pending.recovery.previousReview).toEqual({ findings: ['repeat'], blockingCount: 1 })
  if (progress === 'missing') delete saved.pending.recovery.previousReview
  if (progress === 'null') saved.pending.recovery.previousReview = null
  if (progress === 'invalid') saved.pending.recovery.previousReview = { findings: [' '], blockingCount: 1 }
  f.state.resume = JSON.parse(JSON.stringify(saved))
  f.input.start = 'resume'
  f.decisions.push({ kind: 'fix', findings: ['repeat'], blockingCount: 1 }, { kind: 'approve' })
  f.outcomes.set('run:fix:1', f.completed())
  let recovered = 0
  f.input.workers.fix.runner = { ...f.runner, recover: async (...args) => { recovered++; return f.runner.run(...args) } }
  f.runner.calls.length = 0
  f.cross.calls.length = 0
  const checkpoints = f.state.checkpoints.length
  const outcome = await f.run()
  expect(outcome.kind).toBe(progress === 'valid' ? 'blocked' : 'unknown')
  expect(recovered).toBe(progress === 'valid' ? 1 : 0)
  expect(f.runner.calls.map(request => request.step_id)).toEqual(progress === 'valid' ? ['run:fix:1'] : [])
  expect(f.cross.calls).toHaveLength(progress === 'valid' ? 1 : 0)
  expect(f.events).not.toContain('merge')
  if (progress === 'valid') expect(outcome).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
  else {
    expect(outcome).toMatchObject({ kind: 'unknown', phase: 'fix', step_id: 'run:fix:1' })
    expect(f.state.checkpoints).toHaveLength(checkpoints)
    expect(f.state.checkpoints.at(-1)?.pending?.step_id).toBe('run:fix:1')
  }
})

for (const role of ['plan', 'build', 'review'] as const) test(`pending ${role} rejects an omitted prior-review field before recovery`, async () => {
  const f = modeFixture('single')
  const key = `run:${role}:${role === 'review' ? 1 : 0}`
  f.outcomes.set(key, { kind: 'unknown', detail: 'lost acknowledgement' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role })
  const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  expect(saved.pending.recovery.previousReview).toBeNull()
  delete saved.pending.recovery.previousReview
  f.state.resume = JSON.parse(JSON.stringify(saved))
  f.input.start = 'resume'
  let recovered = 0
  const runner = f.input.workers[role].runner
  f.input.workers[role].runner = { ...runner, recover: async () => { recovered++; return f.completed() } }
  f.runner.calls.length = 0
  f.cross.calls.length = 0
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role, step_id: saved.pending.step_id })
  expect(recovered).toBe(0)
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('merge')
})

for (const scenario of [
  { after: 're-plan', role: 'plan', round: 1 },
  { after: 're-plan', role: 'build', round: 1 },
  { after: 're-plan', role: 'review', round: 2 },
  { after: 'fix', role: 'review', round: 2 },
] as const) for (const history of ['missing', 'null', 'valid'] as const) {
  test(`pending ${scenario.role}:${scenario.round} after ${scenario.after} requires ${history} review history`, async () => {
    const f = modeFixture('single')
    f.decisions.push(scenario.after === 'fix' ? { kind: 'fix', findings: ['repeat'], blockingCount: 2 }
      : { kind: 're-plan', findings: ['repeat'], blockingCount: 2, whatIsMissing: 'design' })
    const step = `run:${scenario.role}:${scenario.round}`
    f.outcomes.set(step, { kind: 'unknown', detail: 'lost acknowledgement' })
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: scenario.role })
    const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
    expect(saved.pending.recovery.previousReview).toEqual({ findings: ['repeat'], blockingCount: 2 })
    expect(saved.replansUsed).toBe(scenario.after === 'fix' ? 0 : 1)
    if (history === 'missing') delete saved.pending.recovery.previousReview
    if (history === 'null') saved.pending.recovery.previousReview = null
    f.state.resume = JSON.parse(JSON.stringify(saved))
    f.input.start = 'resume'
    f.outcomes.set(step, f.completed({ ...f.snapshot, ...(scenario.role === 'plan' ? { payload: f.plan } : {}) }))
    const runner = f.input.workers[scenario.role].runner
    let recovered = 0
    f.input.workers[scenario.role].runner = { ...runner, recover: async (...args) => { recovered++; return runner.run(...args) } }
    f.decisions.push({ kind: 'fix', findings: ['repeat'], blockingCount: 2 }, { kind: 'approve' })
    f.runner.calls.length = 0
    f.cross.calls.length = 0
    const checkpoints = f.state.checkpoints.length
    const result = await f.run()
    expect(result.kind).toBe(history === 'valid' ? 'blocked' : 'unknown')
    expect(recovered).toBe(history === 'valid' ? 1 : 0)
    expect(f.runner.calls.some(request => request.role === 'fix')).toBe(false)
    expect(f.events).not.toContain('merge')
    if (history === 'valid') expect(result).toMatchObject({ on: 'Review requires orchestrator arbitration: repeated finding' })
    else {
      expect(f.runner.calls).toHaveLength(0)
      expect(f.cross.calls).toHaveLength(0)
      expect(f.state.checkpoints).toHaveLength(checkpoints)
    }
  })
}

for (const after of ['fix', 're-plan'] as const) for (const history of ['missing', 'null', 'missing-marker', 'invalid-marker', 'erased', 'valid'] as const) {
  test(`completed ${after} checkpoint keeps ${history} history before its next review`, async () => {
    const f = modeFixture('single')
    f.decisions.push(after === 'fix' ? { kind: 'fix', findings: ['repeat'], blockingCount: 2 }
      : { kind: 're-plan', findings: ['repeat'], blockingCount: 2, whatIsMissing: 'design' })
    let readiness = 0
    f.deps.reviewReadiness = async () => ++readiness === 2 ? { kind: 'unknown', detail: 'interrupted before review' } : { kind: 'allow' }
    expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'interrupted before review' })
    const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
    expect(saved).toMatchObject({ round: 2, previousReview: { findings: ['repeat'], blockingCount: 2 } })
    expect(saved.pending).toBeUndefined()
    if (history === 'missing') delete saved.previousReview
    if (history === 'null') saved.previousReview = null
    if (history === 'missing-marker') delete saved.reviewBaseline
    if (history === 'invalid-marker') saved.reviewBaseline = 'invented'
    if (history === 'erased') { saved.reviewBaseline = 'none'; saved.previousReview = null }
    f.state.resume = JSON.parse(JSON.stringify(saved))
    f.input.start = 'resume'
    f.decisions.push({ kind: 'fix', findings: ['repeat'], blockingCount: 2 }, { kind: 'approve' })
    f.runner.calls.length = 0
    f.cross.calls.length = 0
    const checkpoints = f.state.checkpoints.length
    const prepared = f.prepared.length
    const result = await f.run()
    expect(result.kind).toBe(history === 'valid' ? 'blocked' : 'unknown')
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls).toHaveLength(history === 'valid' ? 1 : 0)
    expect(f.events).not.toContain('merge')
    if (history === 'valid') expect(result).toMatchObject({ on: 'Review requires orchestrator arbitration: repeated finding' })
    else {
      expect(f.state.checkpoints).toHaveLength(checkpoints)
      expect(f.prepared).toHaveLength(prepared)
    }
  })
}

for (const history of ['missing', 'null', 'valid'] as const) test(`moved-head rebuild requires ${history} history before writing a later-round request`, async () => {
  const f = modeFixture('single')
  const saved = f.resume('approved', 1, { findings: [], blockingCount: 0 })
  if (history === 'missing') delete saved.previousReview
  if (history === 'null') saved.previousReview = null
  f.state.resume = JSON.parse(JSON.stringify(saved))
  f.snapshot.head = 'b'.repeat(40)
  for (const key of f.outcomes.keys()) f.outcomes.set(key, f.completed({ ...f.snapshot, ...(key.includes(':plan:') ? { payload: singlePlan } : {}) }))
  expect(await f.run()).toMatchObject({ kind: history === 'valid' ? 'merged' : 'unknown' })
  if (history === 'valid') expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:plan:1', 'run:build:1'])
  else {
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls).toHaveLength(0)
    expect(f.state.checkpoints).toHaveLength(0)
    expect(f.prepared).toHaveLength(0)
  }
})

for (const loseAck of [false, true]) test(`G038 generated pre-review checkpoint permits moved-head plan one, lost ack=${loseAck}`, async () => {
  const f = modeFixture('single')
  f.deps.reviewReadiness = async () => ({ kind: 'unknown', detail: 'stopped before first review' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'stopped before first review' })
  const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  expect(saved).toMatchObject({ stage: 'built', round: 1, replansUsed: 0, previousReview: null, reviewBaseline: 'none' })
  expect(saved.pending).toBeUndefined()
  expect(f.cross.calls).toHaveLength(0)
  f.state.resume = saved
  f.input.start = 'resume'
  f.snapshot.head = 'b'.repeat(40)
  if (f.snapshot.pr) f.snapshot.pr.head = f.snapshot.head
  for (const key of f.outcomes.keys()) f.outcomes.set(key, f.completed({ ...f.snapshot, ...(key.includes(':plan:') ? { payload: singlePlan } : {}) }))
  f.deps.reviewReadiness = async () => ({ kind: 'allow' })
  f.runner.calls.length = 0
  if (loseAck) {
    f.outcomes.set('run:plan:1', { kind: 'unknown', detail: 'lost acknowledgement' })
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan', step_id: 'run:plan:1', detail: 'lost acknowledgement' })
    const pending = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
    expect(pending.pending.recovery).toMatchObject({ round: 1, previousReview: null, reviewBaseline: 'none' })
    f.state.resume = pending
    f.outcomes.set('run:plan:1', f.completed({ ...f.snapshot, payload: singlePlan }))
    f.input.workers.plan.runner = { ...f.runner, recover: f.runner.run }
    f.runner.calls.length = 0
  }
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:plan:1', 'run:build:1'])
  expect(f.cross.calls.map(request => request.step_id)).toEqual([`run:review:1:head:${f.snapshot.head}`])
  expect(f.state.checkpoints.at(-1)).toMatchObject({ stage: 'approved', previousReview: null, reviewBaseline: 'none' })
})

for (const role of ['plan', 'build', 'review', 'fix'] as const) for (const marker of ['missing', 'invalid', 'contradictory'] as const) {
  test(`pending ${role} rejects ${marker} baseline provenance before recovery`, async () => {
    const f = modeFixture('single')
    if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['repeat'], blockingCount: 1 })
    const step = `run:${role}:${role === 'fix' || role === 'review' ? 1 : 0}`
    f.outcomes.set(step, { kind: 'unknown', detail: 'lost acknowledgement' })
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role })
    const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
    // Damage both copies: consistency with the other row must not manufacture provenance.
    for (const row of [saved, saved.pending.recovery]) {
      if (marker === 'missing') delete row.reviewBaseline
      else row.reviewBaseline = marker === 'invalid' ? 'invented' : role === 'fix' ? 'none' : 'required'
    }
    f.state.resume = JSON.parse(JSON.stringify(saved))
    f.input.start = 'resume'
    let recovered = 0
    f.input.workers[role].runner = { ...f.input.workers[role].runner, recover: async () => { recovered++; return f.completed() } }
    f.runner.calls.length = 0
    f.cross.calls.length = 0
    const count = f.state.checkpoints.length
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role })
    expect(recovered).toBe(0)
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls).toHaveLength(0)
    expect(f.state.checkpoints).toHaveLength(count)
    expect(f.events).not.toContain('merge')
  })
}

for (const role of ['fix', 'plan', 'build', 'review'] as const) test(`pending ${role} cannot erase established provenance with a coherent none pair`, async () => {
  const f = modeFixture('single')
  f.decisions.push(role === 'fix' ? { kind: 'fix', findings: ['repeat'], blockingCount: 1 }
    : { kind: 're-plan', findings: ['repeat'], blockingCount: 1, whatIsMissing: 'design' })
  const step = `run:${role}:${role === 'review' ? 2 : 1}`
  f.outcomes.set(step, { kind: 'unknown', detail: 'lost acknowledgement' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role })
  const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  for (const row of [saved, saved.pending.recovery]) { row.reviewBaseline = 'none'; row.previousReview = null }
  f.state.resume = saved
  f.input.start = 'resume'
  let recovered = 0
  f.input.workers[role].runner = { ...f.input.workers[role].runner, recover: async () => { recovered++; return f.completed() } }
  f.runner.calls.length = 0
  f.cross.calls.length = 0
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role })
  expect(recovered).toBe(0)
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('merge')
})

test('a round-zero rebuild can legitimately retain prior review history', async () => {
  const f = modeFixture('single')
  f.resume('fixed', 3, { findings: ['prior'], blockingCount: 2 })
  f.snapshot.head = 'absent'
  f.outcomes.set('run:plan:0', { kind: 'unknown', detail: 'still planning' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'still planning' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:plan:0'])
  expect(f.state.checkpoints.at(-1)?.pending?.recovery).toMatchObject({ round: 0, previousReview: { findings: ['prior'], blockingCount: 2 } })
  f.state.resume = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  f.input.workers.plan.runner = { ...f.runner, recover: f.runner.run }
  f.runner.calls.length = 0
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'still planning' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:plan:0'])
})

for (const change of ['missing-request', 'wrong-request', 'wrong-step', 'model', 'brief', 'policy', 'provider', 'round-cap'] as const) {
  test(`pending recovery refuses ${change} before another worker or publication`, async () => {
    const f = await pendingBuildFixture()
    const pending = f.state.resume!.pending!
    if (change === 'missing-request') delete pending.recovery
    if (change === 'wrong-request') pending.recovery!.request = { ...pending.recovery!.request, model_id: 'other-model' }
    if (change === 'wrong-step') pending.step_id = 'other:build:0'
    if (change === 'model') f.input.workers.build.request = { ...f.input.workers.build.request, model_id: 'changed-model' }
    if (change === 'brief') f.input.workers.plan.request = { ...f.input.workers.plan.request, brief: { path: 'brief.md', integrity: 'changed-task' } }
    if (change === 'policy') f.input.workers.build.request = { ...f.input.workers.build.request, network: true }
    if (change === 'provider') f.input.workers.build.runner = { ...f.runner, provider: 'openai-codex' }
    if (change === 'round-cap') f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 4 })
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'build', step_id: pending.step_id })
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls).toHaveLength(0)
    expect(f.events).not.toContain('publish')
    expect(f.events).not.toContain('merge')
  })
}

test('pending build result cannot apply to a different measured head', async () => {
  const f = await pendingBuildFixture()
  f.snapshot.head = 'c'.repeat(40)
  expect(await f.run()).toMatchObject({ kind: 'failed', cause: 'built-head-unverified' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:build:0'])
  expect(f.events).not.toContain('publish')
  expect(f.cross.calls).toHaveLength(0)
})

test('writable pending planner cannot apply an old result to a moved head', async () => {
  const f = modeFixture('single')
  const original = f.outcomes.get('run:plan:0')!
  f.outcomes.set('run:plan:0', { kind: 'unknown', detail: 'lost acknowledgement' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan' })
  f.state.resume = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  f.input.start = 'resume'
  f.input.workers.plan.runner = { ...f.runner, recover: f.runner.run }
  f.outcomes.set('run:plan:0', original)
  f.snapshot.head = 'c'.repeat(40)
  f.runner.calls.length = 0
  expect(await f.run()).toMatchObject({ kind: 'failed', cause: 'built-head-unverified' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:plan:0'])
  expect(f.events).not.toContain('publish')
  expect(f.cross.calls).toHaveLength(0)
})

test('pending recovery cannot fall back to ordinary run when the runner lacks recovery', async () => {
  const f = await pendingBuildFixture()
  delete f.input.workers.build.runner.recover
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'build', detail: 'Pending worker runner cannot recover without dispatch' })
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('publish')
})

test('unresolved pending build remains unknown and cannot buy a new step', async () => {
  const f = await pendingBuildFixture()
  f.outcomes.set('run:build:0', { kind: 'unknown', detail: 'still running' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', step_id: 'run:build:0', detail: 'still running' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:build:0'])
  expect(f.events).not.toContain('publish')
  expect(f.cross.calls).toHaveLength(0)
})

for (const role of ['plan', 'review'] as const) test(`read-only pending ${role} cannot recover across head movement`, async () => {
  const f = modeFixture('single')
  f.input.workers[role].request = { ...f.input.workers[role].request, writable: false }
  const key = `run:${role}:${role === 'plan' ? 0 : 1}`
  f.outcomes.set(key, { kind: 'unknown', detail: 'lost acknowledgement' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role })
  f.state.resume = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  f.input.start = 'resume'
  f.snapshot.head = 'c'.repeat(40)
  if (f.snapshot.pr) f.snapshot.pr.head = f.snapshot.head
  f.outcomes.set(key, f.completed())
  f.runner.calls.length = 0
  f.cross.calls.length = 0
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role, detail: 'Pending worker input revision changed before recovery' })
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('merge')
})

test('recovered pending build still requires the publication suite', async () => {
  const f = await pendingBuildFixture()
  f.deps.publicationSuite = async () => ({ kind: 'unknown', detail: 'full suite receipt missing' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'full suite receipt missing' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:build:0'])
  expect(f.events).not.toContain('merge')
})

test('pending review cannot be discarded by a publication nomination repair', async () => {
  const f = modeFixture('single')
  f.outcomes.set('run:review:1', { kind: 'unknown', detail: 'still running' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'review' })
  const pending = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  f.state.resume = pending
  f.input.start = 'resume'
  f.deps.publishGate = async () => ({ kind: 'repair-nomination', finding: 'nomination changed' })
  f.runner.calls.length = 0
  f.cross.calls.length = 0
  const checkpoints = f.state.checkpoints.length
  const outcome = await f.run()
  expect(f.state.checkpoints).toHaveLength(checkpoints)
  expect(f.state.checkpoints.at(-1)?.pending).toEqual(pending.pending)
  expect(outcome).toMatchObject({ kind: 'unknown', detail: 'Pending worker must be reconciled before nomination repair' })
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('merge')
})

test('interrupted nomination repair retains its own review progress before a resumed fix', async () => {
  const f = modeFixture('single')
  f.resume('approved', 1, { findings: ['old'], blockingCount: 2 })
  f.deps.publishGate = async () => ({ kind: 'repair-nomination', finding: 'nomination' })
  const save = f.deps.modes!.saveCheckpoint
  f.deps.modes!.saveCheckpoint = async value => {
    await save(value)
    if (value.stage === 'rejected' && !value.pending) throw new Error('interrupted after nomination checkpoint')
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'interrupted after nomination checkpoint' })
  const saved = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  expect(saved.previousReview).toEqual({ findings: ['nomination'], blockingCount: 1 })
  f.state.resume = saved
  f.deps.modes!.saveCheckpoint = save
  f.deps.publishGate = async () => ({ kind: 'allow' })
  f.decisions.push({ kind: 'fix', findings: ['nomination'], blockingCount: 1 }, { kind: 'approve' })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
  expect(f.runner.calls.map(request => request.step_id)).toEqual(['run:fix:1'])
  expect(f.events).not.toContain('merge')
})

for (const remainingTasks of [0, 1]) test(`pending task-sequence build preserves its validated remainder ${remainingTasks}`, async () => {
  const f = modeFixture()
  if (remainingTasks === 0) { f.plan.implementationPlan = '- [ ] T1: first'; f.plan.remainingTasks = 0 }
  f.setPlan({ ...f.plan, remainingTasks })
  f.outcomes.set('run:build:0', { kind: 'unknown', detail: 'lost acknowledgement' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'build' })
  f.state.resume = JSON.parse(JSON.stringify(f.state.checkpoints.at(-1)!))
  f.input.start = 'resume'
  f.outcomes.set('run:build:0', f.completed())
  f.input.workers.build.runner = { ...f.runner, recover: f.runner.run }
  f.runner.calls.length = 0
  expect(await f.run()).toMatchObject({ kind: remainingTasks ? 'continued' : 'merged' })
  expect(f.runner.calls.map(request => request.role)).toEqual(['build'])
  expect(f.prepared.filter(value => value.role === 'build').map(value => value.suiteScope)).toEqual([remainingTasks ? 'subset' : 'host-suite'])
  expect(f.state.advances).toBe(remainingTasks ? 1 : 0)
  expect(f.events.includes('publicationSuite')).toBe(remainingTasks === 0)
})

for (const start of ['fresh', 'resume'] as const) {
  test(`G019 driver refuses bound_pr before any build or release effect on ${start}`, async () => {
    const f = modeFixture('bound_pr')
    f.input.start = start
    // A valid build fixture makes removal of the refusal reach real effects.
    if (start === 'resume') f.resume('approved')
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'bound_pr requires the retained review-only executor' })
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls).toHaveLength(0)
    expect(f.events).toEqual([])
  })
}

for (const mode of ['task_sequence', 'wave'] as const) {
  test(`${mode} still corroborates worker trailers and preserves worker unknown`, async () => {
    for (const unknown of [false, true]) {
      const f = modeFixture(mode); f.input.pinnedTaskId = 'T1'
      f.outcomes.set('run:build:0', unknown ? { kind: 'unknown', detail: 'running' } : f.completed({ ...f.snapshot, head: 'lie' }))
      expect(await f.run()).toMatchObject(unknown ? { kind: 'unknown', step_id: mode === 'task_sequence' ? 'run:task:0:build:0' : 'run:build:0' } : { kind: 'failed', cause: 'built-head-unverified' })
      expect(f.cross.calls).toHaveLength(0)
      expect(f.events).not.toContain('publish')
    }
  })
}

test('task-sequence step identities include the task iteration', async () => {
  const f = cheapFixture(); await f.run()
  expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:task:2:plan:0', 'run:task:2:build:0'])
})

test('wave resume still builds its pinned task without review', async () => {
  const f = modeFixture('wave'); f.input.pinnedTaskId = 'T1'; f.resume('approved')
  expect((await f.run()).kind).toBe('built')
  expect(f.runner.calls.map(c => c.role)).toEqual(['plan', 'build'])
  expect(f.cross.calls).toHaveLength(0)
})

test('mode host and valid recorded rounds are required', async () => {
  const missing = modeFixture(); delete missing.deps.modes
  expect(await missing.run()).toMatchObject({ kind: 'blocked', on: 'Mode host is required' })
  for (const round of [-1, 1.5]) {
    const f = modeFixture('single'); f.resume('built', round)
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Invalid recorded review round' })
    expect(f.runner.calls).toHaveLength(0)
  }
})

test('resume regenerated diff disagreement blocks and unreadable diff remains unknown', async () => {
  const f = modeFixture('single'); f.resume(); f.state.regenerated = 'different'
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Regenerated diff disagrees with host measurement' })
  expect(f.runner.calls).toHaveLength(0)
  f.deps.modes!.regenerateDiff = async () => ({ kind: 'unknown', detail: 'read failed' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'read failed' })
  expect(f.cross.calls).toHaveLength(0)
})

test('resume rejection retains previous finding classes at round three', async () => {
  const f = modeFixture('single'); const checkpoint = f.resume('rejected', 3, { findings: ['same class'], blockingCount: 1 })
  checkpoint.findings = [{ kind: 'code', actionable: true, text: 'same class' }]
  checkpoint.previousFindings = ['same class']
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
  expect(f.runner.calls).toHaveLength(0)
})

function localFixture() {
  const f = fixture()
  f.input.merge_mode = 'local'
  let landed = false
  f.deps.merge = async () => { f.events.push('local-merge'); landed = true }
  f.deps.confirmLocalMerge = async () => landed ? { kind: 'allow' } : { kind: 'blocked', on: 'not landed' }
  return f
}

test('local mode reaches merged with no PR and no publication effect', async () => {
  const f = localFixture()
  expect(await f.run()).toMatchObject({ kind: 'merged', snapshot: { pr: null } })
  expect(f.events.filter(e => e !== 'measure')).toEqual(['publicationSuite', 'publishGate', 'mergeGate', 'local-merge'])
})

test('local mode requires independent merge confirmation', async () => {
  const f = localFixture()
  f.deps.merge = async () => {}
  expect(await f.run()).toMatchObject({ kind: 'blocked', recipient: 'orchestrator', on: 'not landed' })
  f.deps.confirmLocalMerge = async () => ({ kind: 'unknown', detail: 'unreadable' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'merge' })
  delete f.deps.confirmLocalMerge
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'Local merge confirmation source is missing' })
})

test('local mode preserves worker uncertainty and rejects invented trailers', async () => {
  for (const unknown of [true, false]) {
    const f = localFixture()
    f.outcomes.set('run:build:0', unknown ? { kind: 'unknown', detail: 'running' } : f.completed({ ...f.snapshot, head: 'lie' }))
    expect(await f.run()).toMatchObject(unknown ? { kind: 'unknown', step_id: 'run:build:0' } : { kind: 'failed', cause: 'built-head-unverified' })
    expect(f.events).not.toContain('local-merge')
  }
})

test('local mode rejects PR identity and changed landing revision', async () => {
  const bound = localFixture(); bound.input.mode = 'bound_pr'
  expect(await bound.run()).toMatchObject({ kind: 'blocked', on: 'bound_pr requires the retained review-only executor' })
  const existing = localFixture(); existing.input.start = 'resume'
  existing.deps.modes = { ...existing.deps.modes!, loadResume: async () => null }
  existing.snapshot.pr = { number: 1, head: existing.snapshot.head, state: 'OPEN' }
  expect(await existing.run()).toMatchObject({ kind: 'blocked', on: 'Local build has a PR' })
  const moved = localFixture(); moved.deps.merge = async () => { moved.snapshot.head = 'b'.repeat(40) }
  expect(await moved.run()).toMatchObject({ kind: 'blocked', on: 'Local revision changed during merge' })
})

test('PR mode still requires a real PR after publication', async () => {
  const f = fixture(); f.deps.publish = async () => {}
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Published PR does not match candidate revision' })
  expect(f.events).not.toContain('merge')
})


test('local revision is pinned across the publication boundary', async () => {
  const f = localFixture()
  const measure = f.deps.measure
  let reads = 0
  f.deps.measure = async () => {
    if (++reads === 8) f.snapshot.head = 'b'.repeat(40)
    return measure()
  }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Local revision changed before merge' })
  expect(f.events).not.toContain('local-merge')
})

const gap: ReviewDecision = { kind: 're-plan', whatIsMissing: 'revise the execution spec', findings: ['old'], blockingCount: 2 }
for (const payload of [null, {}, 'not a plan', { executionSpec: 42 }, { executionSpec: '' }, { executionSpec: ' \n ' }]) {
  test(`G075 unusable re-plan escalates before rebuild: ${JSON.stringify(payload)}`, async () => {
    const f = fixture(); f.decisions.push(gap)
    f.outcomes.set('run:plan:1', f.completed({ ...f.snapshot, payload }))
    expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan', recipient: 'orchestrator', on: expect.stringContaining('design-gap: re-plan-failed') })
    expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:plan:0', 'run:build:0', 'run:plan:1'])
    expect(f.cross.calls).toHaveLength(1)
    expect(f.events).not.toContain('merge')
  })
}
test('G075 thrown re-planner escalates before rebuild', async () => {
  const f = fixture(); f.decisions.push(gap)
  const runner = f.input.workers.plan.runner
  f.input.workers.plan.runner = { ...runner, run: async (request, placement, signal) => {
    if (request.step_id === 'run:plan:1') throw new Error('planner unavailable')
    return runner.run(request, placement, signal)
  } }
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan', on: 'design-gap: re-plan-failed: planner threw before producing a revised execution spec: Error: planner unavailable' })
  expect(f.runner.calls.filter(c => c.role === 'build')).toHaveLength(1)
  expect(f.cross.calls).toHaveLength(1)
})
test('G075 terminal planner failure escalates while running work remains unknown', async () => {
  for (const outcome of [
    { kind: 'failed', class: 'infra', detail: 'planner unavailable' },
    { kind: 'unknown', detail: 'planner still running' },
  ] satisfies BoundedWorkOutcome[]) {
    const f = fixture(); f.decisions.push(gap); f.outcomes.set('run:plan:1', outcome)
    expect(await f.run()).toMatchObject(outcome.kind === 'failed'
      ? { kind: 'blocked', on: 'design-gap: re-plan-failed: infra: planner unavailable' }
      : { kind: 'unknown', step_id: 'run:plan:1', detail: 'planner still running' })
    expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:plan:0', 'run:build:0', 'run:plan:1'])
    expect(f.cross.calls).toHaveLength(1)
  }
})
test('G075 revised execution spec reaches rebuild', async () => {
  const f = fixture(); f.decisions.push(gap, { kind: 'fix', findings: ['new'] }, { kind: 'approve' })
  const prepared: unknown[] = []
  f.deps.prepareWork = async (request, context) => {
    if (request.step_id === 'run:build:1') prepared.push(context.previous)
  }
  expect((await f.run()).kind).toBe('merged')
  expect(prepared).toEqual([{ ...singlePlan, executionSpec: 'revised execution spec' }])
})
test('G075 unreadable re-plan measurement remains unknown', async () => {
  const f = fixture(); f.decisions.push(gap)
  let replanning = false
  f.deps.prepareWork = async request => { replanning = request.step_id === 'run:plan:1' }
  const measure = f.deps.measure
  f.deps.measure = async () => {
    if (replanning) throw new Error('revision observation unavailable')
    return measure()
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'plan', step_id: 'run:plan:1', detail: 'revision observation unavailable' })
  expect(f.runner.calls.filter(c => c.role === 'build')).toHaveLength(1)
})
test('G077 final-round design gap stops; a spare round admits replacement', async () => {
  for (const round of [4, 5]) {
    const f = fixture(); f.input.start = 'resume'
    f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 5 })
    f.deps.modes = {
      ...f.deps.modes!,
      loadResume: async () => ({ head: f.snapshot.head, stage: 'built', round, findings: [], previousFindings: [], reviewBaseline: 'required', previousReview: { findings: ['prior'], blockingCount: 3 } }),
      regenerateDiff: async () => ({ kind: 'known', diff: f.snapshot.diff }),
      probePlan: async () => null, advanceTask: async () => ({ kind: 'allow' }),
      commitPlan: async () => ({ kind: 'unknown', detail: 'pr mode never commits a ledger' }),
      saveCheckpoint: async () => {},
    }
    f.decisions.push(gap)
    expect(await f.run()).toMatchObject(round === 5
      ? { kind: 'blocked', phase: 'review', recipient: 'orchestrator', on: `design-gap: re-plan-unreachable: ${gap.whatIsMissing}; no round left for the bounded re-plan` }
      : { kind: 'merged' })
    expect(f.runner.calls.map(c => c.step_id)).toEqual(round === 5 ? [] : ['run:plan:4', 'run:build:4'])
    expect(f.cross.calls.map(c => c.step_id.replace(/:head:[a-f0-9]+$/, ''))).toEqual(round === 5 ? ['run:review:5'] : ['run:review:4', 'run:review:5'])
  }
})
test('design gap re-plans once and continues with fresh measurements and spent rounds', async () => {
  const f = fixture()
  f.decisions.push(gap, { kind: 'fix', findings: ['new'] }, { kind: 'approve' })
  const counts: number[] = []
  const gate = f.deps.reviewGate
  f.deps.reviewGate = (payload, observation, snapshot, round, used, record) => { counts.push(used!); return gate(payload, observation, snapshot, round, used, record) }
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:plan:0', 'run:build:0', 'run:plan:1', 'run:build:1', 'run:fix:2'])
  expect(f.cross.calls.map(c => c.step_id.replace(/:head:[a-f0-9]+$/, ''))).toEqual(['run:review:1', 'run:review:2', 'run:review:3'])
  expect(counts).toEqual([0, 1, 1])
  expect(f.reads()).toBe(24)
})
test('host refuses a second re-plan even when worker claims zero spent', async () => {
  const f = fixture()
  f.outcomes.set('run:review:2', f.completed({ ...f.snapshot, payload: { replansUsed: 0 } }))
  f.deps.reviewGate = async (_payload, _observation, _snapshot, _round, used, record) => { record?.({ findings: gap.findings, blockingCount: 2 }); return { ...gap, whatIsMissing: `host count ${used}` } }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('already spent'), recipient: 'orchestrator' })
  expect(f.runner.calls.filter(c => c.role === 'plan')).toHaveLength(2)
})
for (const decision of [
  { kind: 'fix', findings: ['old'], blockingCount: 1 },
  { kind: 'fix', findings: ['new'], blockingCount: 2 },
] satisfies ReviewDecision[]) {
  test(`post-re-plan trigger stops: ${decision.findings[0]}`, async () => {
    const f = fixture(); f.decisions.push(gap, decision)
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: `Review requires orchestrator arbitration: ${decision.findings[0] === 'old' ? 'repeated finding' : 'no-progress'}` })
    expect(f.runner.calls.some(c => c.role === 'fix')).toBe(false)
  })
}
for (const role of ['plan', 'build'] as const) {
  test(`re-plan ${role} claim is measured again`, async () => {
    const f = fixture(); f.decisions.push(gap)
    f.outcomes.set(`run:${role}:1`, f.completed({ ...f.snapshot, head: 'invented' }))
    expect(await f.run()).toMatchObject({ kind: 'failed', phase: role, cause: 'built-head-unverified' })
  })
}

test('resume keeps the host re-plan count and rejects invalid counts', async () => {
  for (const used of [1, 2]) {
    const f = fixture(); f.input.start = 'resume'
    f.deps.modes = {
      ...f.deps.modes!,
      saveCheckpoint: async () => {},
      loadResume: async () => ({ head: f.snapshot.head, stage: 'built', round: 2, replansUsed: used, findings: [], previousFindings: [], reviewBaseline: 'required', previousReview: { findings: ['prior'], blockingCount: 3 } }),
      regenerateDiff: async () => ({ kind: 'known', diff: f.snapshot.diff }),
      probePlan: async () => null, advanceTask: async () => ({ kind: 'allow' }),
      commitPlan: async () => ({ kind: 'unknown', detail: 'pr mode never commits a ledger' }),
    }
    f.decisions.push(gap)
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: used === 1 ? expect.stringContaining('already spent') : 'Invalid recorded re-plan count' })
  }
})
test('resumed rejection after re-plan stops before another fix', async () => {
  const f = fixture(); f.input.start = 'resume'
  f.deps.modes = {
      ...f.deps.modes!,
    saveCheckpoint: async () => {},
    loadResume: async () => ({ head: f.snapshot.head, stage: 'rejected', round: 2, replansUsed: 1, findings: [{ kind: 'code', actionable: true, text: 'old' }], previousFindings: ['old'], reviewBaseline: 'required', previousReview: { findings: ['old'], blockingCount: 1 } }),
    regenerateDiff: async () => ({ kind: 'known', diff: f.snapshot.diff }),
    probePlan: async () => null, advanceTask: async () => ({ kind: 'allow' }),
    commitPlan: async () => ({ kind: 'unknown', detail: 'pr mode never commits a ledger' }),
  }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('post-re-plan trigger') })
  expect(f.runner.calls).toHaveLength(0)
})

for (const field of ['head', 'diff'] as const) test(`G035 fresh review refuses missing ${field} before spending panel`, async () => {
  const f = fixture()
  f.deps.prepareWork = async request => {
    if (request.role === 'build') { f.snapshot[field] = ''; f.outcomes.set(request.step_id, f.completed(f.snapshot)) }
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'review', detail: expect.stringContaining('diff artifact') })
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('publish')
})

test('G043 fix erasing the diff cannot spend another panel', async () => {
  const f = fixture()
  f.decisions.push({ kind: 'fix', findings: ['code'] })
  f.deps.prepareWork = async request => {
    if (request.role === 'fix') { f.snapshot.head = 'b'.repeat(40); f.snapshot.diff = ''; f.outcomes.set(request.step_id, f.completed(f.snapshot)) }
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'review', detail: expect.stringContaining('diff artifact') })
  expect(f.cross.calls).toHaveLength(1)
  expect(f.events).not.toContain('merge')
})

test('readiness runs before each paid panel and cannot default to permission', async () => {
  for (const kind of ['blocked', 'unknown', 'missing'] as const) {
    const f = fixture()
    if (kind === 'missing') delete f.deps.reviewReadiness
    else f.deps.reviewReadiness = async () => kind === 'blocked' ? { kind, on: 'conflicts' } : { kind, detail: 'checks unreadable' }
    expect(await f.run()).toMatchObject({ kind: kind === 'blocked' ? 'blocked' : 'unknown', phase: 'review' })
    expect(f.cross.calls).toHaveLength(0)
  }
  const f = fixture(); let admissions = 0
  f.deps.reviewReadiness = async () => { admissions++; return { kind: 'allow' } }
  f.decisions.push({ kind: 'fix', findings: ['code'] }, { kind: 'approve' })
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(admissions).toBe(2)
})

test('readiness cannot dispatch review after its measured subject changes', async () => {
  const f = fixture()
  f.deps.reviewReadiness = async () => { f.snapshot.head = 'b'.repeat(40); return { kind: 'allow' } }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Revision changed during review readiness' })
  expect(f.cross.calls).toHaveLength(0)
})

test('suite step feeds panel and fix briefs and overrides approving panels every round', async () => {
  const f = fixture(); const order: string[] = []
  const briefs: { role: string; findings: readonly string[] }[] = []
  f.deps.prepareWork = async (request, context) => { briefs.push({ role: request.role, findings: [...context.findings] }) }
  f.deps.reviewSuite = async (snapshot, round) => {
    expect(snapshot.head).toBe(f.snapshot.head); order.push(`suite:${round}`)
    return { kind: 'known', findings: round === 1 ? [{ title: 'FULL SUITE NOT PROVEN', evidence: 'run full suite', advisory: false }] : [] }
  }
  f.deps.reviewGate = async (_, _observation, __, round, _used, record) => { order.push(`panel:${round}`); record?.({ findings: [], blockingCount: 0 }); return { kind: 'approve' } }
  expect((await f.run()).kind).toBe('merged')
  expect(order).toEqual(['suite:1', 'panel:1', 'suite:2', 'panel:2'])
  for (const role of ['review', 'fix']) expect(briefs.find(b => b.role === role)?.findings).toContain('FULL SUITE NOT PROVEN: run full suite')
  expect(f.runner.calls.map(c => c.role)).toEqual(['plan', 'build', 'fix'])
})
test('suite missing or unreadable host cannot dispatch panel or merge', async () => {
  for (const missing of [true, false]) {
    const f = fixture()
    if (missing) delete f.deps.reviewSuite
    else f.deps.reviewSuite = async () => ({ kind: 'unknown', detail: 'suite checkpoint unreadable' })
    expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'review', detail: expect.stringContaining('suite') })
    expect(f.cross.calls).toHaveLength(0)
    expect(f.events).not.toContain('merge')
  }
})
test('suite advisory transcription reaches panel before approval', async () => {
  const f = fixture(); let seen: readonly string[] = []
  f.deps.reviewSuite = async () => ({ kind: 'known', findings: [{ title: 'PRE-EXISTING', evidence: 'base comparison', advisory: true }] })
  f.deps.prepareWork = async (request, context) => { if (request.role === 'review') seen = [...context.findings] }
  expect((await f.run()).kind).toBe('merged')
  expect(seen).toContain('PRE-EXISTING: base comparison')
})

function progressPanel(f: ReturnType<typeof fixture>, rounds: { severity: string; rule: string }[][]) {
  for (let round = 1; round <= rounds.length; round++) {
    const payload = { verdict: 'REQUEST_CHANGES', findings: rounds[round - 1]!.map(item => ({ ...item, file: 'code.ts', symbol: 'f', title: item.rule, evidence: 'code.ts:1', line: 1 })) }
    f.outcomes.set(`run:review:${round}`, f.completed({ ...f.snapshot, payload }))
  }
  f.deps.reviewGate = (payload, _observation, snapshot, round, used, record) => reviewPanel({
    seats: [{ id: 'core', provider: 'pi', modelId: 'model', role: 'core', enabled: true }],
    readSeat: async () => ({ runId: 'run', head: snapshot.head, round, provider: 'pi', modelId: 'model', status: 'completed', payload }),
    retrySeat: async () => {},
    readSynthesis: async () => ({ runId: 'run', head: snapshot.head, round, checkpoint: 'argus-approved', payload }),
  }, payload, snapshot, round, 'run', used, undefined, record)
}

test('G070 all-minor repeated finding stops before approval after a suite-driven fix', async () => {
  const f = fixture()
  progressPanel(f, [[{ severity: 'minor', rule: 'recurring' }], [{ severity: 'minor', rule: 'recurring' }]])
  f.deps.reviewSuite = async (_snapshot, round) => ({ kind: 'known', findings: round === 1 ? [{ title: 'SUITE', evidence: 'required test failed', advisory: false }] : [] })
  const briefed: string[] = []
  f.deps.prepareWork = async (request, context) => { if (request.role === 'fix') briefed.push(...context.findings) }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
  expect(briefed).toContain('code.ts:f:recurring')
  expect(f.cross.calls).toHaveLength(2)
  expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(1)
  expect(f.events).not.toContain('merge')
})

test('G070 resolved minor finding allows approval after a fix', async () => {
  const f = fixture()
  progressPanel(f, [[{ severity: 'major', rule: 'first' }, { severity: 'minor', rule: 'minor' }], [{ severity: 'minor', rule: 'different' }]])
  expect(await f.run()).toMatchObject({ kind: 'merged' })
})

for (const second of [1, 2]) test(`G071 distinct findings with count ${second} stop at second code round`, async () => {
  const f = fixture()
  progressPanel(f, [[{ severity: 'major', rule: 'first' }], Array.from({ length: second }, (_, i) => ({ severity: 'major', rule: `new-${i}` }))])
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: no-progress' })
  expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(1)
  expect(f.events).not.toContain('merge')
})

test('G071 decreasing distinct code counts allow the next fix', async () => {
  const f = fixture()
  progressPanel(f, [[{ severity: 'major', rule: 'first' }, { severity: 'major', rule: 'second' }], [{ severity: 'major', rule: 'new' }], [{ severity: 'nit', rule: 'style' }]])
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(2)
})

test('progress missing observation cannot approve', async () => {
  const f = fixture(); f.deps.reviewGate = async () => ({ kind: 'approve' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('Review progress needs') })
  expect(f.events).not.toContain('merge')
})


test('G070 suite blocker recurrence stops while preexisting advisory evidence permits progress', async () => {
  for (const advisory of [false, true]) {
    const f = fixture()
    f.deps.reviewSuite = async () => ({ kind: 'known', findings: [{ title: 'SUITE', evidence: 'base comparison', advisory }] })
    expect(await f.run()).toMatchObject(advisory ? { kind: 'merged' } : { kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
    expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(advisory ? 0 : 1)
  }
})

test('G070 repeated nits do not enter fix arithmetic', async () => {
  const f = fixture()
  progressPanel(f, [[{ severity: 'nit', rule: 'style' }], [{ severity: 'nit', rule: 'style' }]])
  f.deps.reviewSuite = async (_snapshot, round) => ({ kind: 'known', findings: round === 1 ? [{ title: 'SUITE', evidence: 'required test failed', advisory: false }] : [] })
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(1)
})

test('G070 resumed fix retains its briefed identities for the next panel', async () => {
  const f = modeFixture('single'); const checkpoint = f.resume('rejected', 1, { findings: ['code.ts:f:recurring'], blockingCount: 1 })
  checkpoint.findings = [{ kind: 'code', actionable: true, text: 'code.ts:f:recurring' }]
  checkpoint.previousFindings = []
  progressPanel(f, [[], [{ severity: 'minor', rule: 'recurring' }]])
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
  expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(1)
})

for (const cap of [1, 2, 7, 12]) {
  test(`G076 configured cap ${cap} counts exact host rounds despite worker claims`, async () => {
    const f = fixture()
    f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: cap })
    const rounds: number[] = []
    f.deps.reviewGate = async (_payload, _observation, _snapshot, round, _used, record) => {
      rounds.push(round)
      record?.({ findings: [`unique-${round}`], blockingCount: 0 })
      return { kind: 'fix', findings: [`unique-${round}`] }
    }
    for (let round = 1; round <= 12; round++) {
      f.outcomes.set(`run:review:${round}`, f.completed({ ...f.snapshot, payload: { round: 0, max_rounds: 100 } }))
    }
    expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'review', on: expect.stringContaining('round ceiling') })
    expect(rounds).toEqual(Array.from({ length: cap }, (_, i) => i + 1))
    expect(f.runner.calls.filter(c => c.role === 'fix').map(c => c.step_id)).toEqual(
      Array.from({ length: cap - 1 }, (_, i) => `run:fix:${i + 1}`))
    expect(f.events).not.toContain('merge')
  })
}

test('G076 approval on the last configured round can publish', async () => {
  const f = fixture()
  f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 2 })
  f.decisions.push({ kind: 'fix', findings: ['bug'] }, { kind: 'approve' })
  expect((await f.run()).kind).toBe('merged')
  expect(f.cross.calls.map(c => c.step_id.replace(/:head:[a-f0-9]+$/, ''))).toEqual(['run:review:1', 'run:review:2'])
})

test('G076 unreadable cap never dispatches work', async () => {
  for (const read of [undefined, async () => ({ kind: 'unknown' as const, detail: 'offline' }),
    async () => { throw new Error('read failed') }]) {
    const f = fixture()
    if (read) f.deps.readReviewCap = read
    else {
      // @ts-expect-error Required for typed callers; exercise an untyped caller's omission.
      delete f.deps.readReviewCap
    }
    expect((await f.run()).kind).toBe('unknown')
    expect(f.runner.calls).toHaveLength(0)
  }
})
for (const cap of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '7']) {
  test(`G076 malformed cap ${String(cap)} stays unknown`, async () => {
    const f = fixture()
    f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: cap as number })
    expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'Review round cap is invalid' })
    expect(f.runner.calls).toHaveLength(0)
  })
}

test('G076 resumed rejection consumes exactly one remaining round', async () => {
  for (const round of [6, 7]) {
    const f = modeFixture('single'); const checkpoint = f.resume('rejected', round, { findings: ['bug'], blockingCount: 1 })
    checkpoint.findings = [{ kind: 'code', actionable: true, text: 'bug' }]
    f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 7 })
    expect((await f.run()).kind).toBe(round === 6 ? 'merged' : 'blocked')
    expect(f.runner.calls.map(c => c.step_id)).toEqual(round === 6 ? ['run:fix:6'] : [])
    expect(f.cross.calls.map(c => c.step_id.replace(/:head:[a-f0-9]+$/, ''))).toEqual(round === 6 ? ['run:review:7'] : [])
  }
})

test('G076 over-budget resume refuses before review', async () => {
  const f = modeFixture('single'); f.resume('fixed', 8, { findings: ['prior'], blockingCount: 1 })
  f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 7 })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('round ceiling') })
  expect(f.cross.calls).toHaveLength(0)
})

test('G076 re-plan cannot buy work after the final review', async () => {
  const f = fixture()
  f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 1 })
  f.decisions.push({ kind: 're-plan', findings: ['gap'], whatIsMissing: 'design' })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('re-plan-unreachable') })
  expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:plan:0', 'run:build:0'])
})

test('G032 local build and fix require full heads within three observations', async () => {
  for (const role of ['build', 'fix'] as const) {
    for (const bad of ['short', '', 'absent', 'a'.repeat(39)]) {
      const f = localFixture()
      if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['repair'] })
      const measure = f.deps.measure
      let attempts = 0
      f.deps.measure = async () => {
        if (f.runner.calls.at(-1)?.role === role && (role === 'build' || f.cross.calls.length === 1)) {
          attempts++
          return { kind: 'known', value: { ...f.snapshot, head: bad } }
        }
        return measure()
      }
      f.outcomes.set(`run:${role}:${role === 'build' ? 0 : 1}`, f.completed({ ...f.snapshot, head: bad }))
      expect(await f.run()).toMatchObject({ kind: 'unknown', phase: role, detail: expect.stringContaining('full commit OID') })
      expect(attempts).toBe(3)
      expect(f.cross.calls).toHaveLength(role === 'build' ? 0 : 1)
      expect(f.events).not.toContain('merge')
    }
  }
})

test('G032 transient unreadable observations recover on the third read', async () => {
  for (const role of ['build', 'fix'] as const) {
    const f = localFixture()
    if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['repair'] })
    const measure = f.deps.measure
    let attempts = 0
    f.deps.measure = async () => {
      if (f.runner.calls.at(-1)?.role === role && attempts < 3) {
        if (++attempts < 3) return { kind: 'unknown', detail: 'head unreadable' }
      }
      return measure()
    }
    expect((await f.run()).kind).toBe('merged')
    expect(attempts).toBe(3)
  }
})

test('G100 waits for preservation before refusing build and fix claims', async () => {
  for (const role of ['build', 'fix'] as const) {
    const f = fixture()
    if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['repair'] })
    // The claimed head must differ from where the fixture LANDS the fix, not just
    // from where it started: 'b' is exactly the head the fixture advances to, so
    // the fix read as lost work and stopped before the claim this test measures.
    f.outcomes.set(`run:${role}:${role === 'build' ? 0 : 1}`, f.completed({ ...f.snapshot, head: 'e'.repeat(40) }))
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.deps.checkBuildClaim = async () => { entered(); await pending; f.events.push('receipt'); return { kind: 'blocked', on: 'preserved conflict' } }
    let done = false
    const result = f.run().then(value => { done = true; return value })
    await started
    expect(done).toBe(false)
    expect(f.cross.calls).toHaveLength(role === 'build' ? 0 : 1)
    release()
    expect(await result).toMatchObject({ kind: 'failed', phase: role, cause: 'built-head-unverified' })
    expect(f.events).toContain('receipt')
  }
})

for (const role of ['build', 'fix'] as const) test(`G023 driver checks ${role} branch independently of a valid head`, async () => {
  for (const branch of ['other', 'change']) {
    const f = fixture()
    if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['repair'] })
    f.outcomes.set(`run:${role}:${role === 'build' ? 0 : 1}`, f.completed({ ...f.snapshot, payload: { branch } }))
    expect(await f.run()).toMatchObject(branch === 'other' ? { kind: 'blocked', on: 'Reported builder branch disagrees with assigned branch' } : { kind: 'merged' })
    if (branch === 'other') expect(f.events).not.toContain('merge')
  }
})

test('G023 driver missing assignment remains unknown', async () => {
  const f = fixture(); delete f.deps.assignedBranch
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'Assigned builder branch is missing' })
  expect(f.cross.calls).toHaveLength(0)
})

test('G036 initial confirmed merge wins over fresh PR refusal and pending resume', async () => {
  for (const pending of [false, true]) {
    const f = modeFixture('single')
    if (pending) f.resume('rejected').pending = { phase: 'fix', step_id: 'existing' }
    f.snapshot.pr = { number: 7, head: f.snapshot.head, state: 'MERGED' }
    f.snapshot.head = 'absent'
    expect(await f.run()).toMatchObject({ kind: 'merged' })
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls).toHaveLength(0)
    expect(f.events).not.toContain('publish')
  }
})

for (const role of ['build', 'fix'] as const) test(`G036 merge during ${role} wins over missing head and stale trailer`, async () => {
  const f = fixture(false)
  if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['repair'] })
  f.deps.prepareWork = async request => {
    if (request.role === role) {
      f.snapshot.pr = { number: f.snapshot.pr?.number ?? 7, head: f.snapshot.head, state: 'MERGED' }
      f.snapshot.head = 'absent'
      f.snapshot.diff = ''
    }
  }
  expect(await f.run()).toMatchObject({ kind: 'merged', snapshot: { head: 'absent' } })
  expect(f.cross.calls).toHaveLength(role === 'fix' ? 1 : 0)
  expect(f.events.filter(e => e === 'publish')).toHaveLength(role === 'fix' ? 1 : 0)
})

for (const head of ['a'.repeat(40), '', 'absent']) test(`G042 driver stops lost fix with measured head ${head || 'unreadable'}`, async () => {
  const f = fixture(false)
  f.decisions.push({ kind: 'fix', findings: ['repair'] })
  f.deps.prepareWork = async request => { if (request.role === 'fix') f.snapshot.head = head }
  expect(await f.run()).toMatchObject({ kind: 'failed', cause: 'round-lost-work', phase: 'fix' })
  expect(f.cross.calls).toHaveLength(1)
  expect(f.events).not.toContain('merge')
})

test('G042 resumed fix stops before another panel when no commit lands', async () => {
  const f = modeFixture('single'); f.resume('rejected', 1, { findings: ['repair'], blockingCount: 1 }).findings = [{ kind: 'code', actionable: true, text: 'repair' }]
  const run = f.runner.run
  // Override the fixture's committing fixer with a completed no-op.
  f.runner.run = async (request, placement, signal) => request.role === 'fix' ? f.completed({ ...f.snapshot }) : run(request, placement, signal)
  expect(await f.run()).toMatchObject({ kind: 'failed', cause: 'round-lost-work' })
  expect(f.cross.calls).toHaveLength(0)
})

test('G055 driver forces new CI repair despite panel approval and refreshes after fix', async () => {
  const f = fixture(); let reads = 0
  const briefs: string[] = []
  f.deps.reviewCi = async () => ({ kind: 'known', findings: ++reads <= 2 ? [{ title: 'CI FAILING', evidence: 'unit', advisory: false }] : [] })
  f.deps.prepareWork = async (_request, context) => { briefs.push(...context.findings) }
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(reads).toBe(4)
  expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(1)
  expect(briefs).toContain('CI FAILING: unit')
})

test('G055 advisory CI cannot merge or consume a fix', async () => {
  const f = fixture()
  f.deps.reviewCi = async () => ({ kind: 'known', findings: [{ title: 'CI FAILING', evidence: 'base red', advisory: true }] })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('review-advisory-only') })
  expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(0)
  expect(f.events).not.toContain('merge')
})

test('G056 missing or deferred CI cannot approve, including changes during the panel', async () => {
  for (const point of ['missing', 'before', 'after']) {
    const f = fixture(); let reads = 0
    if (point === 'missing') delete f.deps.reviewCi
    else f.deps.reviewCi = async () => ++reads === (point === 'before' ? 1 : 2) ? { kind: 'unknown', detail: 'CI deferred peer: pending' } : { kind: 'known', findings: [] }
    expect(await f.run()).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('CI') })
    expect(f.cross.calls).toHaveLength(point === 'after' ? 1 : 0)
    expect(f.events).not.toContain('merge')
  }
})

test('G056 records an unverified worker APPROVE only in deferred CI detail', async () => {
  const f = fixture(); let reads = 0
  f.outcomes.set('run:review:1', f.completed({
    ...f.snapshot,
    payload: { verdict: 'APPROVE', findings: [] },
  }))
  f.deps.reviewCi = async () => ++reads === 2
    ? { kind: 'unknown', detail: 'Review CI readiness deferred: Review PR mergeability is not established; budget exhausted' }
    : { kind: 'known', findings: [] }

  expect(await f.run()).toEqual({
    kind: 'unknown',
    phase: 'review',
    step_id: `run:review:1:head:${'a'.repeat(40)}`,
    detail: 'Review CI readiness deferred: Review PR mergeability is not established; budget exhausted. Review worker reported APPROVE; host receipt not obtained.',
  })
  expect(f.events).not.toContain('merge')
})

test('G056 does not attribute a non-APPROVE worker trailer to deferred CI', async () => {
  const f = fixture(); let reads = 0
  f.outcomes.set('run:review:1', f.completed({
    ...f.snapshot,
    payload: { verdict: 'REQUEST_CHANGES', findings: [] },
  }))
  f.deps.reviewCi = async () => ++reads === 2
    ? { kind: 'unknown', detail: 'Review CI readiness deferred: Review PR mergeability is not established; budget exhausted' }
    : { kind: 'known', findings: [] }

  expect(await f.run()).toEqual({
    kind: 'unknown',
    phase: 'review',
    step_id: `run:review:1:head:${'a'.repeat(40)}`,
    detail: 'Review CI readiness deferred: Review PR mergeability is not established; budget exhausted',
  })
})

test('G100 missing preservation stays unknown and resolved same claims continue', async () => {
  for (const resolution of ['missing', 'unknown', 'allow'] as const) {
    const f = fixture()
    f.outcomes.set('run:build:0', f.completed({ ...f.snapshot, head: 'aaaaaaa' }))
    if (resolution === 'missing') delete f.deps.checkBuildClaim
    else f.deps.checkBuildClaim = async () => resolution === 'allow' ? { kind: 'allow' } : { kind: 'unknown', detail: 'receipt missing' }
    const result = await f.run()
    expect(result.kind).toBe(resolution === 'allow' ? 'merged' : 'unknown')
    if (resolution === 'missing') expect(result).toMatchObject({ detail: 'Build claim resolution and preservation source is missing' })
    expect(f.cross.calls.length).toBe(resolution === 'allow' ? 1 : 0)
  }
})


test('G032 local full SHA-256 heads remain accepted', async () => {
  const f = localFixture()
  f.snapshot.head = 'a'.repeat(64)
  for (const key of f.outcomes.keys()) f.outcomes.set(key, f.completed({ ...f.snapshot, ...(key.includes(':plan:') ? { payload: singlePlan } : {}) }))
  expect((await f.run()).kind).toBe('merged')
})

test('G055 CI blockers join repeat arithmetic even when both panels approve', async () => {
  const f = fixture()
  f.deps.reviewCi = async () => ({ kind: 'known', findings: [{ title: 'CI FAILING', evidence: 'unit', advisory: false }] })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' })
  expect(f.cross.calls).toHaveLength(2)
})

test('G036 local mode cannot use PR merge confirmation', async () => {
  const f = fixture(); f.input.merge_mode = 'local'
  f.deps.confirmLocalMerge = async () => ({ kind: 'allow' })
  f.snapshot.pr = { number: 7, head: f.snapshot.head, state: 'MERGED' }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Local build has a PR' })
})

test('G036 merge probe uncertainty preserves the pending worker identity', async () => {
  const f = modeFixture('single')
  f.resume('rejected').pending = { phase: 'fix', step_id: 'existing-fix' }
  f.deps.measure = async () => ({ kind: 'unknown', detail: 'merge probe unavailable' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'fix', step_id: 'existing-fix' })
  expect(f.runner.calls).toHaveLength(0)
})

test('G084 each fix proves descent from the immediately preceding review', async () => {
  for (const abandonSecond of [false, true]) {
    const f = fixture()
    f.decisions.push({ kind: 'fix', findings: ['first', 'second'] }, { kind: 'fix', findings: ['third'] }, { kind: 'approve' })
    const pins: string[][] = []
    f.deps.checkFixLineage = (produced, pin) => fixLineage(async argv => {
      pins.push(argv.slice(-2))
      const ok = !abandonSecond || pin !== 'b'.repeat(40)
      return { ok, exit_code: ok ? 0 : 1, stdout: '', stderr: '' }
    }, '.', 'change', pin, produced.head)
    expect(await f.run()).toMatchObject(abandonSecond
      ? { kind: 'blocked', phase: 'fix', recipient: 'orchestrator', on: expect.stringContaining('does not descend') }
      : { kind: 'merged' })
    expect(pins).toEqual([['a'.repeat(40), 'b'.repeat(40)], ['b'.repeat(40), 'c'.repeat(40)]])
    expect(f.cross.calls).toHaveLength(abandonSecond ? 2 : 3)
    expect(f.events.includes('merge')).toBe(!abandonSecond)
  }
})

test('G084 resumed fix uses the recorded reviewed head and refuses unreadable ancestry', async () => {
  const f = modeFixture('single')
  f.resume('rejected', 1, { findings: ['bug'], blockingCount: 1 }).findings = [{ kind: 'code', actionable: true, text: 'bug' }]
  const pins: string[] = []
  f.deps.checkFixLineage = async (_produced, pin) => {
    pins.push(pin)
    return { kind: 'unknown', detail: 'ancestry object unavailable' }
  }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'fix', detail: 'ancestry object unavailable' })
  expect(pins).toEqual(['a'.repeat(40)])
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('publish')
})

test('G084 missing lineage host cannot accept a fix', async () => {
  const f = fixture()
  f.decisions.push({ kind: 'fix', findings: ['bug'] })
  delete f.deps.checkFixLineage
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'fix', detail: 'Fix lineage host is missing' })
  expect(f.cross.calls).toHaveLength(1)
  expect(f.events).not.toContain('merge')
})

test('G060 thrown review round becomes an infrastructure block', async () => {
  const f = fixture()
  f.cross.run = async () => { throw new Error('review transport failed') }
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'review', recipient: 'orchestrator', on: 'infra-only: Review producer failed during the review join: Error: review transport failed' })
  expect(f.runner.calls.map(call => call.role)).toEqual(['plan', 'build'])
  expect(f.events).not.toContain('merge')
})

test('G057 G060 driver routes incomplete panel facts to the orchestrator', async () => {
  for (const missing of ['seat', 'synthesis']) {
    const f = fixture()
    const approve = { verdict: 'APPROVE', findings: [] }
    f.deps.reviewGate = (_payload, _observation, snapshot, round) => reviewPanel({
      seats: [{ id: 'core', provider: 'pi', modelId: 'review-model', role: 'core', enabled: true }],
      readSeat: async () => missing === 'seat' ? null : { runId: 'run', head: snapshot.head, round, provider: 'pi', modelId: 'review-model', status: 'completed', payload: approve },
      retrySeat: async () => {}, readSynthesis: async () => null,
    }, approve, snapshot, round, 'run')
    expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'review', recipient: 'orchestrator', on: expect.stringContaining('infra-only:') })
    expect(f.events).not.toContain('merge')
    expect(f.runner.calls.map(call => call.role)).toEqual(['plan', 'build'])
  }
})

for (const fault of ['missing', 'unknown', 'blocked'] as const) test(`G102 driver refuses ${fault} artifact before dispatch`, async () => {
  const f = fixture()
  const prepared: string[] = []
  f.deps.prepareWork = async request => { prepared.push(request.role) }
  if (fault === 'missing') delete f.deps.reviewArtifact
  else f.deps.reviewArtifact = async () => fault === 'unknown'
    ? { kind: 'unknown', detail: 'artifact unreadable' } : { kind: 'blocked', on: 'artifact disagrees' }
  expect(await f.run()).toMatchObject({ kind: fault === 'blocked' ? 'blocked' : 'unknown', phase: 'review' })
  expect(prepared).toEqual(['plan', 'build', 'review'])
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('merge')
})

test('G102 driver checks artifact after preparation and before every review', async () => {
  const f = fixture()
  let preparedStep = ''
  const checks: string[] = []
  f.deps.prepareWork = async request => { preparedStep = request.step_id }
  const check = f.deps.reviewArtifact!
  f.deps.reviewArtifact = async (request, snapshot) => {
    expect(preparedStep).toBe(request.step_id)
    expect(f.cross.calls).toHaveLength(checks.length)
    checks.push(request.step_id)
    return check(request, snapshot)
  }
  f.decisions.push({ kind: 'fix', findings: ['repair'] }, { kind: 'approve' })
  expect((await f.run()).kind).toBe('merged')
  expect(checks).toEqual([`run:review:1:head:${'a'.repeat(40)}`, `run:review:2:head:${'b'.repeat(40)}`])
})

test('null usage does not veto an otherwise validated build and fix', async () => {
  const f = fixture()
  f.outcomes.set('run:build:0', { kind: 'completed', result: structuredClone(f.snapshot), usage: null, model_reported: null, thread_id: null })
  f.decisions.push({ kind: 'fix', findings: ['logic'] }, { kind: 'approve' })
  expect((await f.run()).kind).toBe('merged')
})

// Keep acquisition/classification real: only the external CI transport is a fixture.
import { createProjectObservationSources } from './project-observation-sources.ts'
import { awaitReviewReadiness } from './gates/review-readiness.ts'
import { assessReviewCi } from './gates/review-ci.ts'
import { assessReviewSuite } from './gates/review-suite.ts'

for (const status of ['green', 'red', 'unobserved', 'lost-after-panel', 'pending-after-panel'] as const) {
  test(`fresh PR production observations: ${status}`, async () => {
    const f = fixture()
    f.deps.readReviewCap = async () => ({ kind: 'known', max_rounds: 1 })
    const observed: number[] = []
    let now = 0
    const readinessWaits: number[] = []
    let postPanelPending = true
    const sources = createProjectObservationSources({
      baseBranch: 'main', ciWorkflow: 'ci.yml', runId: 'run',
      reviewReadinessClock: { now: () => now, wait: async ms => { readinessWaits.push(ms); now += ms } },
      ci: {
        required: async () => ({ kind: 'resolved', required: ['test'], appBound: [], produced: ['test'] }),
        readiness: async pr => {
          observed.push(pr)
          if (status === 'unobserved' || (status === 'lost-after-panel' && f.cross.calls.length > 0)) return { unreadable: 'CI unavailable' }
          const mergeable = status === 'pending-after-panel' && f.cross.calls.length > 0 && postPanelPending ? (postPanelPending = false, 'UNKNOWN') : 'MERGEABLE'
          return { headSha: f.snapshot.head, mergeable, checksComplete: true,
            rows: [{ name: 'test', status: 'COMPLETED', conclusion: status === 'red' ? 'FAILURE' : 'SUCCESS' }] }
        },
      },
      suite: { strategy: 'bun test', scope: 'full-suite', readCheckpoint: async (snapshot, round) => ({
        runId: 'run', head: snapshot.head, round, report: { hostExitCode: 0, suiteOutcome: 'passed' },
      }) },
    })
    f.deps.reviewReadiness = (snapshot, signal) => awaitReviewReadiness(sources.reviewReadiness, snapshot, signal)
    f.deps.reviewCi = snapshot => assessReviewCi(sources.reviewCi, snapshot, 'f'.repeat(40), 'run')
    f.deps.reviewSuite = (snapshot, round) => assessReviewSuite(sources.reviewSuite, snapshot, round, 'run')
    expect(f.snapshot.pr).toBeNull()
    // Positive control: this exact production source refuses the unpublished subject.
    expect(await sources.reviewCi.observe(structuredClone(f.snapshot))).toMatchObject({ kind: 'unknown' })
    const result = await f.run()
    expect(f.events.filter(e => e === 'publish')).toHaveLength(1)
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every(pr => pr === 1)).toBe(true)
    expect(f.cross.calls).toHaveLength(status === 'unobserved' ? 0 : 1)
    if (status === 'green' || status === 'pending-after-panel') expect(result.kind).toBe('merged')
    else {
      expect(result).toMatchObject({ kind: status === 'red' ? 'blocked' : 'unknown', phase: 'review' })
      expect(f.events).not.toContain('merge')
    }
    expect(readinessWaits).toEqual(status === 'pending-after-panel' ? [30000] : [])
  })
}

test('publication keeps the existing PR identity on a fix', async () => {
  const f = fixture()
  f.decisions.push({ kind: 'fix', findings: ['repair'] })
  const publish = f.deps.publish
  let calls = 0
  f.deps.publish = async snapshot => {
    await publish(snapshot)
    if (++calls === 2) f.snapshot.pr!.number = 2
  }
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'publish', on: 'Published PR does not match candidate revision' })
  expect(f.cross.calls).toHaveLength(1)
  expect(f.events).not.toContain('merge')
})

test('publication refreshes the PR head before each fix review', async () => {
  const f = fixture()
  f.decisions.push({ kind: 'fix', findings: ['repair'] })
  const heads: string[] = []
  f.deps.reviewReadiness = async snapshot => {
    expect(snapshot.pr).toEqual({ number: 1, head: snapshot.head, state: 'OPEN' })
    heads.push(snapshot.head)
    return { kind: 'allow' }
  }
  expect((await f.run()).kind).toBe('merged')
  expect(heads).toEqual(['a'.repeat(40), 'b'.repeat(40)])
  expect(f.events.filter(e => e === 'publish')).toHaveLength(2)
})

test('PR identity cannot change between approval and merge', async () => {
  const f = fixture()
  const review = f.deps.reviewGate
  f.deps.reviewGate = async (...args) => {
    const result = await review(...args)
    f.snapshot.pr!.number = 2
    return result
  }
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'merge', on: 'Published PR does not match reviewed revision' })
  expect(f.events).not.toContain('merge')
})

test('suite scope follows the validated task and assigns terminal builds and fixes to host proof', async () => {
  for (const mode of ['task_sequence', 'single'] as const) {
    for (const remainingTasks of [0, 2]) {
      const f = modeFixture(mode)
      // G025 refuses a ledger whose boxes disagree with its counts, so the fixture's
      // plan lists exactly remainingTasks + 1 unchecked tasks.
      f.plan.implementationPlan = ['- [ ] T1: first', '- [ ] T2: second', '- [ ] T3: third'].slice(0, remainingTasks + 1).join('\n')
      f.plan.remainingTasks = mode === 'single' ? 0 : remainingTasks
      f.setPlan()
      f.decisions.push({ kind: 'fix', findings: ['repair behavior'] }, { kind: 'approve' })
      const outcome = await f.run()
      const intermediate = mode === 'task_sequence' && remainingTasks > 0
      expect(outcome.kind).toBe(intermediate ? 'continued' : 'merged')
      expect(f.prepared.find(p => p.role === 'build')?.suiteScope).toBe(intermediate ? 'subset' : 'host-suite')
      if (!intermediate) expect(f.prepared.find(p => p.role === 'fix')?.suiteScope).toBe('host-suite')
      expect(f.prepared.find(p => p.role === 'plan')?.suiteScope).toBeUndefined()
    }
  }
})

test('suite scope uses the measured remaining count rather than a cheap planner claim', async () => {
  for (const measuredCount of [1, 2]) {
    const f = cheapFixture()
    const body = measuredCount === 1 ? '- [ ] T2: last task' : f.plan.implementationPlan
    f.state.probe = { found: true, body, uncheckedCount: measuredCount,
      sha256: new Bun.CryptoHasher('sha256').update(body).digest('hex') }
    f.setPlan({ ...f.plan, remainingTasks: measuredCount === 1 ? 99 : 0 })
    expect((await f.run()).kind).toBe(measuredCount === 1 ? 'merged' : 'continued')
    expect(f.prepared.find(p => p.role === 'build')?.suiteScope).toBe(measuredCount === 1 ? 'host-suite' : 'subset')
  }
})

test('completed task-sequence build checkpoints retain the validated terminal remainder before publication can fail', async () => {
  for (const remainingTasks of [0, 2]) {
    const f = modeFixture()
    f.plan.implementationPlan = ['- [ ] T1: first', '- [ ] T2: second', '- [ ] T3: third'].slice(0, remainingTasks + 1).join('\n')
    f.plan.remainingTasks = remainingTasks
    f.setPlan()
    const saved: import('./build-run.ts').ResumeCheckpoint[] = []
    f.deps.modes!.saveCheckpoint = async state => { saved.push(structuredClone(state)) }
    f.deps.publishGate = async () => ({ kind: 'blocked', on: 'publication proof unavailable' })
    expect((await f.run()).kind).toBe(remainingTasks === 0 ? 'blocked' : 'continued')
    expect(saved.at(-1)).toMatchObject({ stage: 'built', head: f.snapshot.head, remainingTasks })
    expect(saved.at(-1)?.pending).toBeUndefined()
  }
})

test('terminal retry repeats publication proof and review without planning or rebuilding', async () => {
  const f = modeFixture()
  f.plan.remainingTasks = 0
  f.resume().remainingTasks = 0
  expect((await f.run()).kind).toBe('merged')
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls.map(call => call.role)).toEqual(['review'])
  expect(f.events).toContain('publishGate')
  expect(f.events).toContain('publicationSuite')
})

test('same-run task-sequence intermediate checkpoint resumes its handoff without reviewing', async () => {
  const f = modeFixture()
  f.resume().remainingTasks = 1
  expect(await f.run()).toMatchObject({ kind: 'continued', remainingTasks: 1 })
  expect(f.runner.calls).toEqual([])
  expect(f.cross.calls).toEqual([])
  expect(f.state.commits).toEqual([{ body: '- [x] T1: first\n- [ ] T2: second', head: 'a'.repeat(40) }])
  expect(f.state.advanced.map(snapshot => snapshot.head)).toEqual([f.ledgerHead])
  expect(f.events).not.toContain('publishGate')
  expect(f.events).not.toContain('merge')
})

test('same-run task-sequence terminal checkpoint preserves review without rebuilding', async () => {
  const f = modeFixture()
  f.plan.remainingTasks = 0
  f.plan.implementationPlan = '- [ ] T1: first'
  f.resume().remainingTasks = 0
  expect((await f.run()).kind).toBe('merged')
  expect(f.runner.calls).toEqual([])
  expect(f.cross.calls.map(call => call.role)).toEqual(['review'])
  expect(f.state.commits).toEqual([])
  expect(f.state.advances).toBe(0)
  expect(f.events).toContain('publishGate')
})

test('migrated terminal task-sequence checkpoint resumes fresh review without an invented plan', async () => {
  const f = modeFixture()
  f.resume().remainingTasks = 0
  f.deps.modes!.loadExecutionStrategy = async () => ({ kind: 'known', strategy: 'task_sequence',
    source: 'legacy', rationale: 'Migrated selection', plan: null })
  expect((await f.run()).kind).toBe('merged')
  expect(f.runner.calls).toEqual([])
  expect(f.cross.calls.map(call => call.role)).toEqual(['review'])
  expect(f.state.commits).toEqual([])
  expect(f.state.advances).toBe(0)
  expect(f.events).toContain('publishGate')
  expect(f.events).toContain('publicationSuite')
})

for (const missing of ['count', 'plan', 'legacy-count', 'count-agreement', 'zero-count-agreement', 'legacy-zero-count-agreement', 'ledger-agreement'] as const)
test(`same-run task-sequence checkpoint refuses missing ${missing}`, async () => {
  const f = modeFixture()
  const checkpoint = f.resume()
  if (missing !== 'count') checkpoint.remainingTasks = missing === 'count-agreement' ? 2 : 1
  if (missing === 'zero-count-agreement' || missing === 'legacy-zero-count-agreement') checkpoint.remainingTasks = 0
  if (missing === 'legacy-count') delete checkpoint.remainingTasks
  if (missing === 'plan' || missing === 'legacy-count' || missing === 'legacy-zero-count-agreement') {
    f.deps.modes!.loadExecutionStrategy = async () => ({ kind: 'known',
      strategy: 'task_sequence', source: 'legacy', rationale: 'Migrated selection',
      plan: missing === 'legacy-zero-count-agreement' ? f.plan : null })
  }
  if (missing === 'ledger-agreement') f.plan.implementationPlan = '- [ ] T1: first'
  expect(await f.run()).toMatchObject({ kind: 'unknown',
    detail: 'Task-sequence built checkpoint cannot establish its remaining task handoff' })
  expect(f.runner.calls).toEqual([])
  expect(f.cross.calls).toEqual([])
  expect(f.state.commits).toEqual([])
  expect(f.state.advances).toBe(0)
  expect(f.events).not.toContain('publishGate')
  expect(f.events).not.toContain('merge')
})
