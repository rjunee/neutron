import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AgentSpec } from '../substrate.ts'
import type { BoundedWorkOutcome, BoundedWorkRequest } from '../bounded-work.ts'
import { piInReplRunner, type PiInReplOptions } from './pi-in-repl.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-runner-'))
  directories.push(cwd)
  const req: BoundedWorkRequest = {
    run_id: 'run-1', step_id: 'build-1', role: 'build', model_id: 'provider/build-model',
    effort: 'medium', cwd, writable: true, network: false, tools: 'edit-and-run',
    brief: { path: join(cwd, 'brief.md'), integrity: 'host-verified-brief' },
    result: { path: join(cwd, 'trailer.json'), schema: 'test-result-v1' },
    thread: null, budget: { wall_ms: 1000 }, needs_approval_decision: false,
  }
  await writeFile(req.brief.path, 'Produce the file result.')
  const calls: { topic: string; spec: AgentSpec; timeout_ms: number }[] = []
  const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
  const reservation = join(cwd, `pi-step-${key}.json`)
  const options: PiInReplOptions = {
    topic_id: 'project-topic',
    subagent: 'host-bounded-worker',
    state_dir: cwd,
    spec: { tools: [], model_preference: ['planning-model'], metering_context: { project_id: 'project-1' } },
    async composeActingTurn(topic, spec, opts) {
      expect(opts.request).toBeDefined()
      calls.push({ topic, spec, ...opts })
      return JSON.stringify({ kind: 'completed', result: 'fabricated reply' })
    },
    decodeTrailer(bytes, request) {
      const value = JSON.parse(bytes)
      if (value.run_id !== request.run_id || value.step_id !== request.step_id || value.schema !== request.result.schema) throw new Error('Invalid trailer')
      return { kind: 'blocked', on: value.on }
    },
  }
  const run = (runner = piInReplRunner(options), request = req, signal = new AbortController().signal) =>
    runner.run(request, 'in-repl', signal)
  const trailer = async () => {
    await writeFile(`${req.result.path}.tmp`, JSON.stringify({ run_id: req.run_id, step_id: req.step_id, schema: req.result.schema, on: 'file evidence' }))
    await rename(`${req.result.path}.tmp`, req.result.path)
  }
  // A worker writes its trailer DURING its dispatch turn; the slot is empty before it,
  // because a role's slot is reused across rounds and is cleared at dispatch
  // (`runtime/workers/trailer-slot.ts`). Seeding therefore goes through compose.
  const seed = (bytes?: string) => {
    const compose = options.composeActingTurn
    options.composeActingTurn = (async (...args: Parameters<typeof compose>) => {
      if (bytes === undefined) await trailer()
      else await writeFile(req.result.path, bytes)
      return compose(...args)
    }) as typeof compose
  }
  return { req, options, calls, run, trailer, seed, reservation }
}

test('dispatches one explicitly modeled subagent and reads its file, never the reply', async () => {
  const f = await fixture()
  const compose = f.options.composeActingTurn
  f.options.composeActingTurn = async (topic, spec, opts) => {
    expect(await readFile(f.reservation, 'utf8')).toBe(JSON.stringify(f.req))
    const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
    expect(opts.request).toBe(f.req)
    expect(args.agent).toMatch(/^host-bounded-worker-[a-f0-9]{64}$/); expect(opts.subagent).toBe(args.agent)
    expect(args.agentScope).toBe('user')
    expect(args.cwd).toBe(f.req.cwd)
    expect(opts.request.effort).toBe('medium')
    expect(spec.prompt).toContain('subagent')
    expect(args.task).toContain(JSON.stringify(f.req))
    expect(args.task).toContain('harness file tool')
    await f.trailer()
    return compose(topic, spec, opts)
  }
  expect(await f.run()).toEqual({ kind: 'blocked', on: 'file evidence' })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.topic).toBe('project-topic')
  expect(f.calls[0]!.spec.model_preference).toEqual([f.req.model_id])
  expect(f.calls[0]!.spec.metering_context).toEqual({ project_id: 'project-1' })
  expect(f.calls[0]!.spec.tools).toBe(f.options.spec.tools)
  expect(f.calls[0]!.timeout_ms).toBeGreaterThan(0)
})

test('each distinct dispatch explicitly overrides the planning model', async () => {
  const f = await fixture()
  f.options.composeActingTurn = async (_topic, spec, opts) => {
    expect(spec.model_preference).toEqual([f.req.model_id])
    expect(opts.request).toBe(f.req)
    await f.trailer()
    return 'done'
  }
  expect((await f.run()).kind).toBe('blocked')
  const next = { ...f.req, step_id: 'review-2', model_id: 'provider/review-model', result: { ...f.req.result, path: join(f.req.cwd, 'second.json') } }
  f.options.composeActingTurn = async (_topic, spec, opts) => {
    expect(spec.model_preference).toEqual([next.model_id])
    expect(opts.request).toBe(next)
    await writeFile(next.result.path, JSON.stringify({ run_id: next.run_id, step_id: next.step_id, schema: next.result.schema, on: 'second' }))
    return 'done'
  }
  expect(await f.run(piInReplRunner(f.options), next)).toEqual({ kind: 'blocked', on: 'second' })
})

test('waits for a trailer written after the dispatch turn ends', async () => {
  const f = await fixture()
  let finish!: () => void
  const composed = new Promise<void>(resolve => { finish = resolve })
  f.options.composeActingTurn = async () => { finish(); return 'fired' }
  const outcome = f.run()
  await composed
  await f.trailer()
  expect(await outcome).toEqual({ kind: 'blocked', on: 'file evidence' })
})

test('retry after runner replacement reads the trailer without redispatch', async () => {
  const f = await fixture()
  const req = { ...f.req, budget: { wall_ms: 100 } }
  expect((await f.run(piInReplRunner(f.options), req)).kind).toBe('unknown')
  await f.trailer()
  expect(await f.run(piInReplRunner(f.options), req)).toEqual({ kind: 'blocked', on: 'file evidence' })
  expect(f.calls).toHaveLength(1)
})

test('a different request cannot reuse a reserved trailer', async () => {
  const f = await fixture()
  await writeFile(f.reservation, JSON.stringify({ ...f.req, step_id: 'other-step' }))
  await f.trailer()
  expect((await f.run()).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
})

test('an unreadable reservation is unknown and cannot dispatch', async () => {
  const f = await fixture()
  f.options.state_dir = join(f.req.cwd, 'missing')
  const req = { ...f.req, result: { ...f.req.result, path: join(f.req.cwd, 'missing', 'trailer') } }
  expect((await f.run(piInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
})

test('changing a trailer path cannot dispatch the same step twice', async () => {
  const f = await fixture()
  f.seed()
  expect((await f.run()).kind).toBe('blocked')
  const req = { ...f.req, result: { ...f.req.result, path: join(f.req.cwd, 'different.json') } }
  expect((await f.run(piInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
})

test('a missing trailer is unknown even when the reply claims completion', async () => {
  const f = await fixture()
  const req = { ...f.req, budget: { wall_ms: 100 } }
  expect((await f.run(piInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
})

test.each(['not json', '{"step_id":"wrong","schema":"test-result-v1"}'])('invalid trailer %s is unknown', async bytes => {
  const f = await fixture()
  f.seed(bytes)
  expect(await f.run()).toEqual({ kind: 'unknown', detail: 'Trailer could not be read or validated.' })
})

test('host decoder owns completed result and measured metadata', async () => {
  const f = await fixture()
  f.seed()
  const completed: BoundedWorkOutcome = {
    kind: 'completed', result: { verified: true }, usage: { input_tokens: 17, output_tokens: 4 },
    model_reported: f.req.model_id, thread_id: 'observed-thread',
  }
  f.options.decodeTrailer = bytes => { expect(JSON.parse(bytes).on).toBe('file evidence'); return completed }
  expect(await f.run()).toBe(completed)
})

test('a thrown dispatch does not assert failure or redispatch', async () => {
  const f = await fixture()
  let calls = 0
  f.options.composeActingTurn = async () => { calls++; throw new Error('connection lost') }
  expect((await f.run()).kind).toBe('unknown')
  await f.trailer()
  expect((await f.run()).kind).toBe('blocked')
  expect(calls).toBe(1)
})

test('headless placement is refused before dispatch', async () => {
  const f = await fixture()
  const runner = piInReplRunner(f.options)
  expect(runner.provider).toBe('pi')
  expect(runner.supports('build', 'in-repl')).toEqual({ ok: true })
  expect(runner.supports('build', 'headless').ok).toBe(false)
  expect(await runner.run(f.req, 'headless', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'placement-unavailable' })
  expect(f.calls).toHaveLength(0)
})

test('cancellation before dispatch does not start work', async () => {
  const f = await fixture()
  const ac = new AbortController()
  ac.abort()
  expect((await f.run(piInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
  await expect(readFile(f.reservation)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cancellation during observation is unknown', async () => {
  const f = await fixture()
  const ac = new AbortController()
  f.options.composeActingTurn = async () => { await f.trailer(); ac.abort(); return 'fired' }
  expect((await f.run(piInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
})

test('cancellation while reserving the step cannot dispatch', async () => {
  const f = await fixture()
  const ac = new AbortController()
  const outcome = f.run(piInReplRunner(f.options), f.req, ac.signal)
  ac.abort()
  expect((await outcome).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
})

test('an exhausted budget cannot dispatch', async () => {
  const f = await fixture()
  expect((await f.run(piInReplRunner(f.options), { ...f.req, budget: { wall_ms: 0 } })).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
  await expect(readFile(f.reservation)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a dispatch that never settles is bounded by the observation budget', async () => {
  const f = await fixture()
  f.options.composeActingTurn = () => new Promise(() => {})
  const outcome = f.run(piInReplRunner(f.options), { ...f.req, budget: { wall_ms: 15 } })
  expect((await outcome).kind).toBe('unknown')
}, 500)

test('cancellation interrupts an unsettled dispatch', async () => {
  const f = await fixture()
  const ac = new AbortController()
  f.options.composeActingTurn = () => { ac.abort(); return new Promise(() => {}) }
  expect((await f.run(piInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
}, 500)

test('blind liveness is unknown, including a probe that throws', async () => {
  const f = await fixture()
  const handle = { run_id: f.req.run_id, step_id: f.req.step_id }
  expect(await piInReplRunner(f.options).liveness(handle)).toBe('unknown')
  f.options.probe = async () => { throw new Error('cannot observe') }
  expect(await piInReplRunner(f.options).liveness(handle)).toBe('unknown')
})

test.each(['activity', 'nothing', 'unknown'] as const)('preserves an observed liveness answer: %s', async answer => {
  const f = await fixture()
  f.options.probe = async handle => { expect(handle.step_id).toBe(f.req.step_id); return answer }
  expect(await piInReplRunner(f.options).liveness({ run_id: f.req.run_id, step_id: f.req.step_id })).toBe(answer)
})

test('concurrent runner instances reserve one dispatch', async () => {
  const f = await fixture()
  const compose = f.options.composeActingTurn
  f.options.composeActingTurn = async (...args) => {
    await f.trailer()
    return compose(...args)
  }
  const outcomes = await Promise.all([f.run(), f.run()])
  // A loser can observe a partially written reservation and conservatively return unknown.
  expect(outcomes.some(outcome => outcome.kind === 'blocked')).toBe(true)
  expect(outcomes.every(outcome => ['blocked', 'unknown'].includes(outcome.kind))).toBe(true)
  expect(f.calls).toHaveLength(1)
  expect((await f.run()).kind).toBe('blocked')
  expect(f.calls).toHaveLength(1)
})

test('the same step in another run gets a distinct definition and reservation', async () => {
  const f = await fixture()
  const tasks: string[] = []
  f.options.composeActingTurn = async (_topic, spec, opts) => {
    const args = JSON.parse(spec.prompt.split('\n')[1]!)
    tasks.push(args.agent)
    expect(opts.request.effort).toBeNull()
    const request = JSON.parse(args.task.split('\n')[1].slice('Request (data): '.length))
    await writeFile(request.result.path, JSON.stringify({
      run_id: request.run_id, step_id: request.step_id, schema: request.result.schema, on: 'observed',
    }))
    return 'done'
  }
  const first = { ...f.req, effort: null }
  const second = { ...first, run_id: 'run-2', result: { ...first.result, path: join(f.req.cwd, 'second.json') } }
  expect((await f.run(piInReplRunner(f.options), first)).kind).toBe('blocked')
  expect((await f.run(piInReplRunner(f.options), second)).kind).toBe('blocked')
  expect(tasks).toHaveLength(2)
  expect(tasks[0]).not.toBe(tasks[1])
})

test.each(['FINAL_ANSWER: completed', 'child died', 'interrupted', 'spawn rejected'])('%s without a trailer is unknown', async reply => {
  const f = await fixture()
  f.options.composeActingTurn = async () => reply
  expect((await f.run(piInReplRunner(f.options), { ...f.req, budget: { wall_ms: 20 } })).kind).toBe('unknown')
})

test('an unreadable trailer is unknown', async () => {
  const f = await fixture()
  const request = { ...f.req, result: { ...f.req.result, path: f.req.cwd } }
  const outcome = await f.run(piInReplRunner(f.options), request)
  expect(outcome.kind).toBe('unknown')
  // Caught while clearing the slot, BEFORE dispatch: a path that is a directory can
  // never hold this step's trailer, and the detail says so rather than reporting the
  // silence of a worker that was never worth spawning.
  expect(f.calls).toHaveLength(0)
  expect(outcome).toHaveProperty('detail', expect.stringContaining(request.result.path))
})

test.each(['run_id', 'step_id', 'schema'])('decoder rejects mismatched trailer %s', async field => {
  const f = await fixture()
  // The worker writes a trailer whose <field> does not match its own request.
  const value: Record<string, unknown> = { run_id: f.req.run_id, step_id: f.req.step_id, schema: f.req.result.schema, on: 'file evidence' }
  value[field] = 'wrong'
  f.seed(JSON.stringify(value))
  expect((await f.run()).kind).toBe('unknown')
})

test('ephemeral extension children cannot resume a child thread', async () => {
  const f = await fixture()
  const req = { ...f.req, thread: { id: 'prior-child' } }
  expect(await f.run(piInReplRunner(f.options), req)).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
  expect(f.calls).toHaveLength(0)
  await expect(readFile(f.reservation)).rejects.toMatchObject({ code: 'ENOENT' })
})

for (const effort of ['xhigh', 'max'] as const) {
  test(`forwards extended effort ${effort} unchanged`, async () => {
    const f = await fixture()
    f.options.composeActingTurn = async (_topic, spec, opts) => {
      const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
      expect(opts.request.effort).toBe(effort)
      expect(args.task).toContain(JSON.stringify({ ...f.req, effort }))
      await f.trailer()
      return 'done'
    }
    expect(await f.run(undefined, { ...f.req, effort })).toEqual({ kind: 'blocked', on: 'file evidence' })
  })
}

test("a second round of the same role is not answered by the previous round's trailer", async () => {
  const f = await fixture()
  // `open/wiring/project-build.ts:366` keys the result slot by ROLE, while
  // `trident/build-run.ts:319` gives every ROUND of that role its own `step_id`. Round
  // two therefore dispatches against the path round one already wrote. Seed it with a
  // trailer that was perfectly valid for round one.
  await writeFile(f.req.result.path, JSON.stringify({ run_id: f.req.run_id, step_id: 'build-0', schema: f.req.result.schema, on: 'round one' }))
  let slotAtDispatch: string | undefined
  const compose = f.options.composeActingTurn
  f.options.composeActingTurn = async (topic, spec, opts) => {
    // Must be absent here: a slot still holding round one makes the acting turn read
    // the dispatch as already ended before any worker of this round has run
    // (`runtime/workers/claude-acting-turn.ts:200`).
    slotAtDispatch = await readFile(f.req.result.path, 'utf8').catch((error: NodeJS.ErrnoException) => error.code)
    // This round's worker takes a moment, as a real one does. The poll must not
    // answer from whatever is in the slot before it lands.
    setTimeout(() => { void f.trailer() }, 60)
    return compose(topic, spec, opts)
  }
  expect(await f.run()).toEqual({ kind: 'blocked', on: 'file evidence' })
  expect(slotAtDispatch).toBe('ENOENT')
})

test('a resumed step keeps the trailer already written for it', async () => {
  const f = await fixture()
  // The reservation exists, so this is the SAME step re-entered after a gateway
  // replacement — not a new round. Its own validated answer must survive.
  await writeFile(f.reservation, JSON.stringify(f.req))
  await f.trailer()
  expect(await f.run()).toEqual({ kind: 'blocked', on: 'file evidence' })
  expect(f.calls).toHaveLength(0)
})
