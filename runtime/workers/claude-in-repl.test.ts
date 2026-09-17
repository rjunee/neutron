import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { reserveTrailerSlot } from './trailer-slot.ts'
import type { AgentSpec } from '../substrate.ts'
import type { BoundedWorkOutcome, BoundedWorkRequest } from '../bounded-work.ts'
import { claudeInReplRunner, type ClaudeInReplOptions } from './claude-in-repl.ts'
import { SUBAGENT_TOOL_NAME } from './claude-tool-contract.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-runner-'))
  directories.push(cwd)
  const req: BoundedWorkRequest = {
    run_id: 'run-1', step_id: 'build-1', role: 'build', model_id: 'claude-sonnet-4-6',
    effort: 'medium', cwd, writable: true, network: false, tools: 'edit-and-run',
    brief: { path: join(cwd, 'brief.md'), integrity: 'host-verified-brief' },
    result: { path: join(cwd, 'trailer.json'), schema: 'test-result-v1' },
    thread: null, budget: { wall_ms: 1000 }, needs_approval_decision: false,
  }
  await writeFile(req.brief.path, 'Produce the file result.')
  const calls: { topic: string; spec: AgentSpec; timeout_ms: number }[] = []
  const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
  const reservation = join(cwd, `claude-step-${key}.json`)
  const options: ClaudeInReplOptions = {
    topic_id: 'project-topic',
    state_dir: cwd,
    spec: { tools: [], model_preference: ['planning-model'], metering_context: { project_id: 'project-1' } },
    async composeActingTurn(topic, spec, opts) {
      calls.push({ topic, spec, ...opts })
      return JSON.stringify({ kind: 'completed', result: 'fabricated reply' })
    },
    decodeTrailer(bytes, request) {
      const value = JSON.parse(bytes)
      if (value.step_id !== request.step_id || value.schema !== request.result.schema) throw new Error('Invalid trailer')
      return { kind: 'blocked', on: value.on }
    },
  }
  const run = (runner = claudeInReplRunner(options), request = req, signal = new AbortController().signal) =>
    runner.run(request, 'in-repl', signal)
  const trailer = async () => {
    await writeFile(`${req.result.path}.tmp`, JSON.stringify({ step_id: req.step_id, schema: req.result.schema, on: 'file evidence' }))
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
    const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
    expect(args.model).toBe(f.req.model_id)
    expect(args.subagent_type).toBe('general-purpose')
    expect(args.run_in_background).toBe(true)
    expect(args.prompt).toContain(JSON.stringify(f.req))
    expect(args.prompt).toContain('harness file tool')
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
  f.options.composeActingTurn = async (_topic, spec) => {
    const args = JSON.parse(spec.prompt.split('\n')[1]!)
    expect(args.model).toBe(f.req.model_id)
    await f.trailer()
    return 'done'
  }
  await f.run()
  const next = { ...f.req, step_id: 'review-2', model_id: 'claude-opus-4-6', result: { ...f.req.result, path: join(f.req.cwd, 'second.json') } }
  f.options.composeActingTurn = async (_topic, spec) => {
    expect(JSON.parse(spec.prompt.split('\n')[1]!).model).toBe(next.model_id)
    await writeFile(next.result.path, JSON.stringify({ step_id: next.step_id, schema: next.result.schema, on: 'second' }))
    return 'done'
  }
  expect(await f.run(claudeInReplRunner(f.options), next)).toEqual({ kind: 'blocked', on: 'second' })
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
  expect((await f.run(claudeInReplRunner(f.options), req)).kind).toBe('unknown')
  await f.trailer()
  expect(await f.run(claudeInReplRunner(f.options), req)).toEqual({ kind: 'blocked', on: 'file evidence' })
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
  expect((await f.run(claudeInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
})

test('changing a trailer path cannot dispatch the same step twice', async () => {
  const f = await fixture()
  f.seed()
  expect((await f.run()).kind).toBe('blocked')
  const req = { ...f.req, result: { ...f.req.result, path: join(f.req.cwd, 'different.json') } }
  expect((await f.run(claudeInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
})

test('a missing trailer is unknown even when the reply claims completion', async () => {
  const f = await fixture()
  const req = { ...f.req, budget: { wall_ms: 100 } }
  expect((await f.run(claudeInReplRunner(f.options), req)).kind).toBe('unknown')
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
  const runner = claudeInReplRunner(f.options)
  expect(runner.provider).toBe('anthropic')
  expect(runner.supports('build', 'in-repl')).toEqual({ ok: true })
  expect(runner.supports('build', 'headless').ok).toBe(false)
  expect(await runner.run(f.req, 'headless', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'placement-unavailable' })
  expect(f.calls).toHaveLength(0)
})

test('cancellation before dispatch does not start work', async () => {
  const f = await fixture()
  const ac = new AbortController()
  ac.abort()
  expect((await f.run(claudeInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
  await expect(readFile(f.reservation)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cancellation during observation is unknown', async () => {
  const f = await fixture()
  const ac = new AbortController()
  f.options.composeActingTurn = async () => { await f.trailer(); ac.abort(); return 'fired' }
  expect((await f.run(claudeInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
})

test('cancellation while reserving the step cannot dispatch', async () => {
  const f = await fixture()
  const ac = new AbortController()
  const outcome = f.run(claudeInReplRunner(f.options), f.req, ac.signal)
  ac.abort()
  expect((await outcome).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
})

test('an exhausted budget cannot dispatch', async () => {
  const f = await fixture()
  expect((await f.run(claudeInReplRunner(f.options), { ...f.req, budget: { wall_ms: 0 } })).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
  await expect(readFile(f.reservation)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a dispatch that never settles is bounded by the observation budget', async () => {
  const f = await fixture()
  f.options.composeActingTurn = () => new Promise(() => {})
  const outcome = f.run(claudeInReplRunner(f.options), { ...f.req, budget: { wall_ms: 15 } })
  expect((await outcome).kind).toBe('unknown')
}, 500)

test('cancellation interrupts an unsettled dispatch', async () => {
  const f = await fixture()
  const ac = new AbortController()
  f.options.composeActingTurn = () => { ac.abort(); return new Promise(() => {}) }
  expect((await f.run(claudeInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
}, 500)

test('blind liveness is unknown, including a probe that throws', async () => {
  const f = await fixture()
  const handle = { run_id: f.req.run_id, step_id: f.req.step_id }
  expect(await claudeInReplRunner(f.options).liveness(handle)).toBe('unknown')
  f.options.probe = async () => { throw new Error('cannot observe') }
  expect(await claudeInReplRunner(f.options).liveness(handle)).toBe('unknown')
})

test.each(['activity', 'nothing', 'unknown'] as const)('preserves an observed liveness answer: %s', async answer => {
  const f = await fixture()
  f.options.probe = async handle => { expect(handle.step_id).toBe(f.req.step_id); return answer }
  expect(await claudeInReplRunner(f.options).liveness({ run_id: f.req.run_id, step_id: f.req.step_id })).toBe(answer)
})

// #1109. This test USED to assert the list contains `'Task'` — and so it passed
// precisely BECAUSE the bug existed: Claude Code 2.1.273 renamed the subagent
// tool to `Agent`, the grant list still said `Task`, and every trident dispatch
// was refused with `No such tool available: Agent`. A guard cannot catch a rename
// it is pinning. It now asserts the two AGREE, derived from one constant, so a
// future rename breaks the test instead of the product.
test('the granted tool surface carries the very tool the dispatch asks for', async () => {
  const source = await readFile(new URL('../../gateway/wiring/build-live-agent-turn.ts', import.meta.url), 'utf8')
  const block = source.match(/export const LIVE_AGENT_TOOL_NAMES = \[([\s\S]*?)\] as const/)![1]!
  // Assert about the ENTRIES, not the prose: a comment explaining the old name
  // would otherwise fail the negative below, which says nothing about the grant.
  const names = block.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  expect(names).toContain("'Read'")
  // The grant imports the constant rather than restating the name.
  expect(names).toContain('SUBAGENT_TOOL_NAME')
  expect(names).not.toContain("'Task'")
  // And the dispatch prompt asks for that same constant, not a literal.
  const worker = await readFile(new URL('./claude-in-repl.ts', import.meta.url), 'utf8')
  expect(worker).toContain('Invoke the ${SUBAGENT_TOOL_NAME} tool exactly once')
  // The grant must import the CONTRACT module, not the worker implementation:
  // pulling claude-in-repl.ts into the gateway drags node:fs/promises and
  // node:crypto along for one string.
  const grantSource = await readFile(new URL('../../gateway/wiring/build-live-agent-turn.ts', import.meta.url), 'utf8')
  expect(grantSource).toContain("from '@neutronai/runtime/workers/claude-tool-contract.ts'")
  expect(worker).not.toContain('Invoke the Agent tool exactly once')
})

test('the subagent tool name is the one this CLI actually exposes', () => {
  // Pinned as a constant, not a relation: 2.1.273 exposes `Agent`. If a later
  // release renames it again, this is the line that has to change, and the
  // dispatch prompt and grant list follow it automatically.
  expect(SUBAGENT_TOOL_NAME).toBe('Agent')
})

for (const effort of ['xhigh', 'max'] as const) {
  test(`forwards extended effort ${effort} unchanged`, async () => {
    const f = await fixture()
    f.options.composeActingTurn = async (_topic, spec, opts) => {
      const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
      expect(args.prompt).toContain(JSON.stringify({ ...f.req, effort }))
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
  await writeFile(f.req.result.path, JSON.stringify({ step_id: 'build-0', schema: f.req.result.schema, on: 'round one' }))
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
  // A real resume: the step was dispatched — which is what ARMS its reservation and
  // clears its slot — its worker wrote the trailer, and the gateway was then replaced.
  // Its own validated answer must survive, and it must not be dispatched again.
  expect(await reserveTrailerSlot(f.reservation, JSON.stringify(f.req), f.req.result.path)).toEqual({ kind: 'dispatch' })
  await f.trailer()
  expect(await f.run()).toEqual({ kind: 'blocked', on: 'file evidence' })
  expect(f.calls).toHaveLength(0)
})

test('a step held by another instance is unknown, not answered from the stale slot', async () => {
  const f = await fixture()
  // Its owner reserved the step and has not armed it. Taking it over on that guess would
  // run the bounded task twice against one trailer, so this instance reports what it
  // actually knows — and never hands back the round-one trailer sitting in the slot.
  await writeFile(f.reservation, JSON.stringify(f.req))
  await writeFile(f.req.result.path, JSON.stringify({ step_id: 'build-0', schema: f.req.result.schema, on: 'round one' }))
  const outcome = await f.run()
  expect(outcome.kind).toBe('unknown')
  expect(outcome).toHaveProperty('detail', expect.stringContaining('not yet dispatched'))
  expect(f.calls).toHaveLength(0)
  expect(JSON.parse(await readFile(f.req.result.path, 'utf8')).on).toBe('round one')
})
