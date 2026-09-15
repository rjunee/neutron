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

test('admission refuses unavailable future fix capability', async () => {
  const f = fixture()
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

function modeFixture(mode: BuildRunInput['mode'] = 'ralph') {
  const f = fixture()
  f.input.mode = mode
  const plan = { implementationPlan: '- [ ] T1: first\n- [ ] T2: second', topTask: '- [ ] T1: first', remainingTasks: 1, executionSpec: 'implement one task' }
  const state: {
    resume: import('./build-run.ts').ResumeCheckpoint | null
    probe: import('./build-run.ts').PlanProbe | null
    regenerated: string
    oldResult: unknown
    advances: number
  } = { resume: null, probe: null, regenerated: f.snapshot.diff, oldResult: { built: true }, advances: 0 }
  const prepared: { role: string; previous: unknown; planner?: string; findings: readonly string[] }[] = []
  f.deps.prepareWork = async (request, context) => { prepared.push({ role: request.role, ...structuredClone(context) }) }
  f.deps.modes = {
    loadResume: async () => state.resume,
    regenerateDiff: async head => { f.events.push(`diff:${head}`); return { kind: 'known', diff: state.regenerated } },
    probePlan: async () => { f.events.push('probe'); return state.probe },
    advanceRalph: async () => { state.oldResult = null; state.advances++; return { kind: 'allow' } },
  }
  const setPlan = (payload: unknown = plan) => f.outcomes.set('run:plan:0', f.completed({ ...f.snapshot, payload }))
  setPlan()
  const resume = (stage: import('./build-run.ts').ResumeCheckpoint['stage'] = 'built', round = 1) => {
    f.input.start = 'resume'
    state.resume = { head: f.snapshot.head, stage, round, findings: [], previousFindings: [] }
    return state.resume
  }
  return { ...f, state, plan, prepared, setPlan, resume, run: () => {
    if (f.input.mode === 'ralph') {
      for (const [key, value] of [...f.outcomes]) {
        if (!key.includes(':task:')) f.outcomes.set(key.replace('run:', `run:task:${f.input.ralphRound ?? 0}:`), value)
      }
    }
    return f.run()
  } }
}

for (const mode of ['ralph', 'wave'] as const) {
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
  const f = modeFixture(); f.resume('ralph-task-built'); f.input.ralphRound = 2
  f.state.probe = { found: true, body: f.plan.implementationPlan,
    sha256: new Bun.CryptoHasher('sha256').update(f.plan.implementationPlan).digest('hex'), uncheckedCount: 2 }
  return f
}

test('G026 clean handoff and positive round outside refresh interval select next planner', async () => {
  for (const round of [0, -1, 1.5, 5, 10, 2]) {
    const f = cheapFixture(); f.input.ralphRound = round
    await f.run()
    expect(f.prepared[0]?.planner).toBe(round === 2 ? 'next' : 'full')
    expect(f.events.includes('probe')).toBe(round === 2)
  }
  for (const stage of ['built', 'ralph-task-built-deviated'] as const) {
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
  expect(await f.run()).toMatchObject({ kind: 'continued', cause: 'ralph-task-built' })
  expect(f.state.oldResult).toBeNull()
  expect(f.state.advances).toBe(1)
  expect(f.cross.calls).toHaveLength(0)
  expect(f.events).not.toContain('publish')
  const terminal = modeFixture(); terminal.plan.remainingTasks = 0; terminal.setPlan()
  expect((await terminal.run()).kind).toBe('merged')
  expect(terminal.cross.calls).toHaveLength(1)
  expect(terminal.state.advances).toBe(0)
})
for (const kind of ['blocked', 'unknown'] as const) {
  test(`G037 handoff ${kind} never acknowledges continuation`, async () => {
    const f = modeFixture()
    f.deps.modes!.advanceRalph = async () => kind === 'blocked' ? { kind, on: 'head moved' } : { kind, detail: 'write unobserved' }
    expect(await f.run()).toMatchObject({ kind })
    expect(f.state.oldResult).not.toBeNull()
    expect(f.cross.calls).toHaveLength(0)
  })
}

test('G038 exact full resume head skips build; moved missing and short heads rebuild', async () => {
  for (const head of [null, 'short', 'b'.repeat(40), 'a'.repeat(40)]) {
    const f = modeFixture('pr'); const checkpoint = f.resume('approved'); checkpoint.head = head
    expect((await f.run()).kind).toBe('merged')
    expect(f.runner.calls.some(c => c.role === 'build')).toBe(head !== f.snapshot.head)
    expect(f.cross.calls.length).toBe(head === f.snapshot.head ? 0 : 1)
  }
})

test('G038 absent live head rebuilds but unreadable required head stops', async () => {
  for (const head of ['absent', '']) {
    const f = modeFixture('pr'); f.resume(); f.snapshot.head = head; f.setPlan()
    const measure = f.deps.measure; let reads = 0
    f.deps.measure = async () => { if (++reads === 3) f.snapshot.head = 'a'.repeat(40); return measure() }
    expect((await f.run()).kind).toBe(head === 'absent' ? 'merged' : 'failed')
    expect(f.runner.calls.some(c => c.role === 'build')).toBe(head === 'absent')
  }
})

test('G039 only actionable code findings buy a resumed fix', async () => {
  for (const finding of [null, { kind: 'lane', actionable: true, text: 'seat down' },
    { kind: 'code', actionable: false, text: 'advisory' }, { kind: 'code', actionable: true, text: 'bug' }] as const) {
    const f = modeFixture('pr'); const checkpoint = f.resume('rejected', 2)
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
    const f = modeFixture('pr'); f.resume(); f.state.regenerated = diff
    expect((await f.run()).kind).toBe('merged')
    expect(f.events).toContain(`diff:${'a'.repeat(40)}`)
    expect(f.runner.calls.some(c => c.role === 'build')).toBe(diff === '')
  }
})

test('G041 resume inherits spent rounds and cannot restart exhausted budget', async () => {
  for (const stage of ['fixed', 'rejected'] as const) {
    const f = modeFixture('pr'); const checkpoint = f.resume(stage, 5)
    checkpoint.findings = [{ kind: 'code', actionable: true, text: 'bug' }]
    f.decisions.push({ kind: 'fix', findings: ['bug'] })
    expect(await f.run()).toMatchObject({ kind: 'blocked', recipient: 'orchestrator' })
    expect(f.runner.calls).toHaveLength(0)
    expect(f.cross.calls.map(c => c.step_id)).toEqual(stage === 'fixed' ? ['run:review:5'] : [])
  }
  const f = modeFixture('pr'); f.resume('fixed', 3)
  f.decisions.push({ kind: 'fix', findings: ['new bug'] })
  expect((await f.run()).kind).toBe('merged')
  expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:fix:3'])
  expect(f.cross.calls.map(c => c.step_id)).toEqual(['run:review:3', 'run:review:4'])
})

test('resume pending worker preserves phase and exact step without dispatch', async () => {
  const f = modeFixture('pr'); const checkpoint = f.resume()
  checkpoint.pending = { phase: 'fix', step_id: 'original:fix:3' }
  expect(await f.run()).toMatchObject({ kind: 'unknown', phase: 'fix', step_id: 'original:fix:3' })
  expect(f.runner.calls).toHaveLength(0)
  expect(f.cross.calls).toHaveLength(0)
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

for (const mode of ['ralph', 'wave'] as const) {
  test(`${mode} still corroborates worker trailers and preserves worker unknown`, async () => {
    for (const unknown of [false, true]) {
      const f = modeFixture(mode); f.input.pinnedTaskId = 'T1'
      f.outcomes.set('run:build:0', unknown ? { kind: 'unknown', detail: 'running' } : f.completed({ ...f.snapshot, head: 'lie' }))
      expect(await f.run()).toMatchObject(unknown ? { kind: 'unknown', step_id: mode === 'ralph' ? 'run:task:0:build:0' : 'run:build:0' } : { kind: 'failed', cause: 'built-head-unverified' })
      expect(f.cross.calls).toHaveLength(0)
      expect(f.events).not.toContain('publish')
    }
  })
}

test('Ralph step identities include the task iteration', async () => {
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
    const f = modeFixture('pr'); f.resume('built', round)
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Invalid recorded review round' })
    expect(f.runner.calls).toHaveLength(0)
  }
})

test('resume regenerated diff disagreement blocks and unreadable diff remains unknown', async () => {
  const f = modeFixture('pr'); f.resume(); f.state.regenerated = 'different'
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Regenerated diff disagrees with host measurement' })
  expect(f.runner.calls).toHaveLength(0)
  f.deps.modes!.regenerateDiff = async () => ({ kind: 'unknown', detail: 'read failed' })
  expect(await f.run()).toMatchObject({ kind: 'unknown', detail: 'read failed' })
  expect(f.cross.calls).toHaveLength(0)
})

test('resume rejection retains previous finding classes at round three', async () => {
  const f = modeFixture('pr'); const checkpoint = f.resume('rejected', 3)
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
  expect(f.events.filter(e => e !== 'measure')).toEqual(['publishGate', 'mergeGate', 'local-merge'])
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
  existing.deps.modes = { loadResume: async () => null } as NonNullable<BuildRunDeps['modes']>
  existing.snapshot.pr = { number: 1, head: existing.snapshot.head, state: 'OPEN' }
  expect(await existing.run()).toMatchObject({ kind: 'blocked', on: 'Local build has a PR' })
  const moved = localFixture(); moved.deps.merge = async () => { moved.snapshot.head = 'b'.repeat(40) }
  expect(await moved.run()).toMatchObject({ kind: 'blocked', on: 'Local revision changed during merge' })
})

test('PR mode still requires a real PR after publication', async () => {
  const f = fixture(); f.deps.publish = async () => {}
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Published PR does not match reviewed revision' })
  expect(f.events).not.toContain('merge')
})


test('local revision is pinned across the publication boundary', async () => {
  const f = localFixture()
  const measure = f.deps.measure
  let reads = 0
  f.deps.measure = async () => {
    if (++reads === 7) f.snapshot.head = 'b'.repeat(40)
    return measure()
  }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: 'Local revision changed before merge' })
  expect(f.events).not.toContain('local-merge')
})

const gap: ReviewDecision = { kind: 're-plan', whatIsMissing: 'revise the execution spec', findings: ['old'], blockingCount: 2 }
test('design gap re-plans once and continues with fresh measurements and spent rounds', async () => {
  const f = fixture()
  f.decisions.push(gap, { kind: 'fix', findings: ['new'] }, { kind: 'approve' })
  const counts: number[] = []
  const gate = f.deps.reviewGate
  f.deps.reviewGate = (payload, snapshot, round, used) => { counts.push(used!); return gate(payload, snapshot, round, used) }
  expect(await f.run()).toMatchObject({ kind: 'merged' })
  expect(f.runner.calls.map(c => c.step_id)).toEqual(['run:plan:0', 'run:build:0', 'run:plan:1', 'run:build:1', 'run:fix:2'])
  expect(f.cross.calls.map(c => c.step_id)).toEqual(['run:review:1', 'run:review:2', 'run:review:3'])
  expect(counts).toEqual([0, 1, 1])
  expect(f.reads()).toBe(14)
})
test('host refuses a second re-plan even when worker claims zero spent', async () => {
  const f = fixture()
  f.outcomes.set('run:review:2', f.completed({ ...f.snapshot, payload: { replansUsed: 0 } }))
  f.deps.reviewGate = async (_payload, _snapshot, _round, used) => ({ ...gap, whatIsMissing: `host count ${used}` })
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('already spent'), recipient: 'orchestrator' })
  expect(f.runner.calls.filter(c => c.role === 'plan')).toHaveLength(2)
})
for (const decision of [
  { kind: 'fix', findings: ['old'], blockingCount: 1 },
  { kind: 'fix', findings: ['new'], blockingCount: 2 },
] satisfies ReviewDecision[]) {
  test(`post-re-plan trigger stops: ${decision.findings[0]}`, async () => {
    const f = fixture(); f.decisions.push(gap, decision)
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('post-re-plan trigger') })
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
      loadResume: async () => ({ head: f.snapshot.head, stage: 'built', round: 2, replansUsed: used, findings: [], previousFindings: [] }),
      regenerateDiff: async () => ({ kind: 'known', diff: f.snapshot.diff }),
      probePlan: async () => null, advanceRalph: async () => ({ kind: 'allow' }),
    }
    f.decisions.push(gap)
    expect(await f.run()).toMatchObject({ kind: 'blocked', on: used === 1 ? expect.stringContaining('already spent') : 'Invalid recorded re-plan count' })
  }
})
test('resumed rejection after re-plan stops before another fix', async () => {
  const f = fixture(); f.input.start = 'resume'
  f.deps.modes = {
    loadResume: async () => ({ head: f.snapshot.head, stage: 'rejected', round: 2, replansUsed: 1, findings: [{ kind: 'code', actionable: true, text: 'old' }], previousFindings: ['old'] }),
    regenerateDiff: async () => ({ kind: 'known', diff: f.snapshot.diff }),
    probePlan: async () => null, advanceRalph: async () => ({ kind: 'allow' }),
  }
  expect(await f.run()).toMatchObject({ kind: 'blocked', on: expect.stringContaining('post-re-plan trigger') })
  expect(f.runner.calls).toHaveLength(0)
})
