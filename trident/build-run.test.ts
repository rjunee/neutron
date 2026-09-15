import { expect, test } from 'bun:test'
import { fakeRunner, type BoundedWorkOutcome } from '@neutronai/runtime/bounded-work.ts'
import { buildRun, type BuildRunDeps, type BuildRunInput, type BuildSnapshot, type ReviewDecision } from './build-run.ts'

function fixture() {
  const snapshot: BuildSnapshot = { head: 'a'.repeat(40), diff: '+built\n', pr: null }
  const outcomes = new Map<string, BoundedWorkOutcome>()
  const completed = (value: unknown = structuredClone(snapshot)): BoundedWorkOutcome => ({
    kind: 'completed', result: value, usage: { input_tokens: 0, output_tokens: 0 }, model_reported: 'test', thread_id: null,
  })
  for (const role of ['plan', 'build', 'review', 'fix']) {
    for (let round = 0; round <= 5; round++) outcomes.set(`run:${role}:${round}`, completed())
  }
  const runner = fakeRunner('anthropic', { outcomes })
  const cross = fakeRunner('openai-codex', { outcomes })
  const request = {
    model_id: 'test', effort: null, cwd: '.', writable: true, network: false, tools: 'edit-and-run',
    brief: { path: 'brief.md', integrity: 'digest' }, result: { path: 'result.json', schema: 'build/1' },
    thread: null, budget: { wall_ms: 1000 },
  } as const
  const input: BuildRunInput = {
    run_id: 'run', mode: 'pr', start: 'fresh', repl_provider: 'anthropic',
    workers: { plan: { runner, request }, build: { runner, request }, review: { runner: cross, request }, fix: { runner, request } },
  }
  const events: string[] = []
  const decisions: ReviewDecision[] = []
  let reads = 0
  const deps: BuildRunDeps = {
    prepareWork: async () => {},
    measure: async () => { reads++; events.push('measure'); return { kind: 'known', value: structuredClone(snapshot) } },
    admissionGate: async () => ({ kind: 'allow' }),
    runLeakGatePreflight: async () => ({ status: 'clean', head: snapshot.head, findings: [], skipped_rules: [], attempts: 0, note: '' }),
    assessMergeDiff: () => ({ allow: true, measured_bytes: 7 }),
    reviewGate: async () => decisions.shift() ?? { kind: 'approve' },
    publishGate: async () => { events.push('publishGate'); return { kind: 'allow' } },
    mergeGate: async () => { events.push('mergeGate'); return { kind: 'allow' } },
    publish: async () => { events.push('publish'); snapshot.pr = { number: 1, head: snapshot.head, state: 'OPEN' } },
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
  expect(f.cross.calls.map(c => c.step_id)).toEqual(['run:review:1', 'run:review:2'])
  expect(f.events.filter(e => e !== 'measure')).toEqual(['publishGate', 'publish', 'mergeGate', 'merge'])
  expect(f.reads()).toBe(11)
  expect([...f.runner.calls, ...f.cross.calls].every(c => c.needs_approval_decision === false)).toBe(true)
})

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

for (const [field, value] of [['head', 'b'.repeat(40)], ['diff', 'invented'], ['pr', { number: 2, head: 'fake', state: 'OPEN' }]] as const) {
  test(`lying ${field} trailer is caught before review`, async () => {
    const f = fixture()
    f.outcomes.set('run:build:0', f.completed({ ...f.snapshot, [field]: value }))
    expect(await f.run()).toMatchObject({ kind: 'failed', cause: 'built-head-unverified', phase: 'build' })
    expect(f.cross.calls).toHaveLength(0)
    expect(f.events).not.toContain('publish')
    expect(f.reads()).toBe(3)
  })
}
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

for (const mode of ['ralph', 'wave', 'bound_pr'] as const) {
  test(`admission refuses ${mode}`, async () => {
    const f = fixture(); f.input.mode = mode
    expect((await f.run()).kind).toBe('refused')
    expect(f.runner.calls).toHaveLength(0)
    expect(f.reads()).toBe(0)
  })
}
test('admission refuses resume and unavailable future fix capability', async () => {
  const f = fixture(); f.input.start = 'resume'
  expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'resume-unsupported' })
  f.input.start = 'fresh'
  f.input.workers.fix.runner = fakeRunner('pi', { supports: () => ({ ok: false, reason: 'placement-unavailable', detail: 'no seat' }) })
  expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'worker-unsupported' })
  expect(f.runner.calls).toHaveLength(0)
})
test('existing PR refuses fresh admission', async () => {
  const f = fixture(); f.snapshot.pr = { number: 1, head: f.snapshot.head, state: 'OPEN' }
  expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'plan' })
  expect(f.runner.calls).toHaveLength(0)
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
  test(`review ${kind} cannot publish`, async () => {
    const f = fixture()
    f.decisions.push(kind === 'unknown' ? { kind, detail: 'unreadable' } : { kind, on: 'arbiter' })
    expect((await f.run()).kind).toBe(kind)
    expect(f.events).not.toContain('publish')
  })
}

test('round three repeats stop; five rounds stop even with distinct findings', async () => {
  for (const repeated of [true, false]) {
    const f = fixture()
    for (let round = 1; round <= 5; round++) f.decisions.push({ kind: 'fix', findings: [repeated ? 'same-class' : `class-${round}`] })
    expect(await f.run()).toMatchObject({ kind: 'blocked', phase: 'review', recipient: 'orchestrator' })
    expect(f.cross.calls).toHaveLength(repeated ? 3 : 5)
    expect(f.runner.calls.filter(c => c.role === 'fix')).toHaveLength(repeated ? 2 : 4)
  }
})

for (const read of [1, 3, 5, 6, 7, 8, 9]) {
  test(`unreadable host measurement ${read} preserves uncertainty`, async () => {
    const f = fixture(); const measure = f.deps.measure; let n = 0
    f.deps.measure = async () => ++n === read ? { kind: 'unknown', detail: 'cannot read' } : measure()
    expect((await f.run()).kind).toBe('unknown')
  })
}
test('review cannot change its subject even with a matching trailer', async () => {
  const f = fixture(); const measure = f.deps.measure; let n = 0
  f.deps.measure = async () => { if (++n === 4) f.snapshot.head = 'c'.repeat(40); return measure() }
  f.outcomes.set('run:review:1', f.completed({ ...f.snapshot, head: 'c'.repeat(40) }))
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Reviewed revision changed during review' })
})
for (const status of ['incomplete', 'findings-unresolved', 'skipped-no-gate', 'gate-error'] as const) {
  test(`leak ${status} cannot publish`, async () => {
    const f = fixture(); const leak = f.deps.runLeakGatePreflight
    f.deps.runLeakGatePreflight = async s => ({ ...await leak(s), status })
    expect((await f.run()).kind).toBe('blocked')
    expect(f.events).not.toContain('publish')
  })
}
test('leak fixer moving the head requires new review', async () => {
  const f = fixture(); const leak = f.deps.runLeakGatePreflight
  f.deps.runLeakGatePreflight = async s => { f.snapshot.head = 'd'.repeat(40); return { ...await leak(s), status: 'fixed' } }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Revision changed after review' })
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
  f.outcomes.set('run:plan:0', f.completed({ ...f.snapshot, payload: { plan: 'implement spec' } }))
  f.decisions.push({ kind: 'fix', findings: ['missing validation'] })
  const prepared: { role: string; previous: unknown; findings: readonly string[] }[] = []
  f.deps.prepareWork = async (request, context) => { prepared.push({ role: request.role, previous: context.previous, findings: context.findings }) }
  expect((await f.run()).kind).toBe('merged')
  expect(prepared.find(p => p.role === 'build')?.previous).toEqual({ plan: 'implement spec' })
  expect(prepared.find(p => p.role === 'fix')?.findings).toEqual(['missing validation'])
})

for (const role of ['plan', 'review', 'fix'] as const) {
  test(`${role} unknown preserves its pending step`, async () => {
    const f = fixture()
    if (role === 'fix') f.decisions.push({ kind: 'fix', findings: ['logic'] })
    const step = `run:${role}:${role === 'plan' ? 0 : 1}`
    f.outcomes.set(step, { kind: 'unknown', detail: 'unobserved' })
    expect(await f.run()).toMatchObject({ kind: 'unknown', step_id: step, phase: role })
    expect(f.events).not.toContain('publish')
  })
}
test('build head and diff advance from the initial base under host observation', async () => {
  const f = fixture()
  const built = structuredClone(f.snapshot)
  f.snapshot.head = '0'.repeat(40); f.snapshot.diff = ''
  f.outcomes.set('run:plan:0', f.completed(structuredClone(f.snapshot)))
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
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Published PR does not match reviewed revision' })
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
