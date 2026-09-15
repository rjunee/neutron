import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AgentSpec } from '../substrate.ts'
import type { BoundedWorkOutcome, BoundedWorkRequest } from '../bounded-work.ts'
import { codexInReplRunner, type CodexInReplOptions } from './codex-in-repl.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-runner-'))
  directories.push(cwd)
  const req: BoundedWorkRequest = {
    run_id: 'run-1', step_id: 'build-1', role: 'build', model_id: 'gpt-5.6-sol',
    effort: 'medium', cwd, writable: true, network: false, tools: 'edit-and-run',
    brief: { path: join(cwd, 'brief.md'), integrity: 'host-verified-brief' },
    result: { path: join(cwd, 'trailer.json'), schema: 'test-result-v1' },
    thread: null, budget: { wall_ms: 1000 }, needs_approval_decision: false,
  }
  await writeFile(req.brief.path, 'Produce the file result.')
  const calls: { topic: string; spec: AgentSpec; timeout_ms: number }[] = []
  const key = createHash('sha256').update(JSON.stringify([req.run_id, req.step_id])).digest('hex')
  const reservation = join(cwd, `codex-step-${key}.json`)
  const options: CodexInReplOptions = {
    topic_id: 'project-topic',
    state_dir: cwd,
    spec: { tools: [], model_preference: ['planning-model'], metering_context: { project_id: 'project-1' } },
    async composeActingTurn(topic, spec, opts) {
      calls.push({ topic, spec, ...opts })
      return JSON.stringify({ kind: 'completed', result: 'fabricated reply' })
    },
    decodeTrailer(bytes, request) {
      const value = JSON.parse(bytes)
      if (value.run_id !== request.run_id || value.step_id !== request.step_id || value.schema !== request.result.schema) throw new Error('Invalid trailer')
      return { kind: 'blocked', on: value.on }
    },
  }
  const run = (runner = codexInReplRunner(options), request = req, signal = new AbortController().signal) =>
    runner.run(request, 'in-repl', signal)
  const trailer = async () => {
    await writeFile(`${req.result.path}.tmp`, JSON.stringify({ run_id: req.run_id, step_id: req.step_id, schema: req.result.schema, on: 'file evidence' }))
    await rename(`${req.result.path}.tmp`, req.result.path)
  }
  return { req, options, calls, run, trailer, reservation }
}

test('dispatches one explicitly modeled subagent and reads its file, never the reply', async () => {
  const f = await fixture()
  const compose = f.options.composeActingTurn
  f.options.composeActingTurn = async (topic, spec, opts) => {
    const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
    expect(args.model).toBe(f.req.model_id)
    expect(args.task_name).toMatch(/^bounded_[a-f0-9]{64}$/)
    expect(args.fork_turns).toBe('none')
    expect(args.reasoning_effort).toBe('medium')
    expect(spec.prompt).toContain('collaboration.spawn_agent')
    expect(args.message).toContain(JSON.stringify(f.req))
    expect(args.message).toContain('harness file tool')
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
  expect((await f.run()).kind).toBe('blocked')
  const next = { ...f.req, step_id: 'review-2', model_id: 'gpt-6-astra', result: { ...f.req.result, path: join(f.req.cwd, 'second.json') } }
  f.options.composeActingTurn = async (_topic, spec) => {
    expect(JSON.parse(spec.prompt.split('\n')[1]!).model).toBe(next.model_id)
    await writeFile(next.result.path, JSON.stringify({ run_id: next.run_id, step_id: next.step_id, schema: next.result.schema, on: 'second' }))
    return 'done'
  }
  expect(await f.run(codexInReplRunner(f.options), next)).toEqual({ kind: 'blocked', on: 'second' })
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
  expect((await f.run(codexInReplRunner(f.options), req)).kind).toBe('unknown')
  await f.trailer()
  expect(await f.run(codexInReplRunner(f.options), req)).toEqual({ kind: 'blocked', on: 'file evidence' })
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
  expect((await f.run(codexInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
})

test('changing a trailer path cannot dispatch the same step twice', async () => {
  const f = await fixture()
  await f.trailer()
  expect((await f.run()).kind).toBe('blocked')
  const req = { ...f.req, result: { ...f.req.result, path: join(f.req.cwd, 'different.json') } }
  expect((await f.run(codexInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
})

test('a missing trailer is unknown even when the reply claims completion', async () => {
  const f = await fixture()
  const req = { ...f.req, budget: { wall_ms: 100 } }
  expect((await f.run(codexInReplRunner(f.options), req)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
})

test.each(['not json', '{"step_id":"wrong","schema":"test-result-v1"}'])('invalid trailer %s is unknown', async bytes => {
  const f = await fixture()
  await writeFile(f.req.result.path, bytes)
  expect(await f.run()).toEqual({ kind: 'unknown', detail: 'Trailer could not be read or validated.' })
})

test('host decoder owns completed result and measured metadata', async () => {
  const f = await fixture()
  await f.trailer()
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
  const runner = codexInReplRunner(f.options)
  expect(runner.provider).toBe('openai-codex')
  expect(runner.supports('build', 'in-repl')).toEqual({ ok: true })
  expect(runner.supports('build', 'headless').ok).toBe(false)
  expect(await runner.run(f.req, 'headless', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'placement-unavailable' })
  expect(f.calls).toHaveLength(0)
})

test('cancellation before dispatch does not start work', async () => {
  const f = await fixture()
  const ac = new AbortController()
  ac.abort()
  expect((await f.run(codexInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
  await expect(readFile(f.reservation)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cancellation during observation is unknown', async () => {
  const f = await fixture()
  const ac = new AbortController()
  f.options.composeActingTurn = async () => { await f.trailer(); ac.abort(); return 'fired' }
  expect((await f.run(codexInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
})

test('cancellation while reserving the step cannot dispatch', async () => {
  const f = await fixture()
  const ac = new AbortController()
  const outcome = f.run(codexInReplRunner(f.options), f.req, ac.signal)
  ac.abort()
  expect((await outcome).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
})

test('an exhausted budget cannot dispatch', async () => {
  const f = await fixture()
  expect((await f.run(codexInReplRunner(f.options), { ...f.req, budget: { wall_ms: 0 } })).kind).toBe('unknown')
  expect(f.calls).toHaveLength(0)
  await expect(readFile(f.reservation)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a dispatch that never settles is bounded by the observation budget', async () => {
  const f = await fixture()
  f.options.composeActingTurn = () => new Promise(() => {})
  const outcome = f.run(codexInReplRunner(f.options), { ...f.req, budget: { wall_ms: 15 } })
  expect((await outcome).kind).toBe('unknown')
}, 500)

test('cancellation interrupts an unsettled dispatch', async () => {
  const f = await fixture()
  const ac = new AbortController()
  f.options.composeActingTurn = () => { ac.abort(); return new Promise(() => {}) }
  expect((await f.run(codexInReplRunner(f.options), f.req, ac.signal)).kind).toBe('unknown')
}, 500)

test('blind liveness is unknown, including a probe that throws', async () => {
  const f = await fixture()
  const handle = { run_id: f.req.run_id, step_id: f.req.step_id }
  expect(await codexInReplRunner(f.options).liveness(handle)).toBe('unknown')
  f.options.probe = async () => { throw new Error('cannot observe') }
  expect(await codexInReplRunner(f.options).liveness(handle)).toBe('unknown')
})

test.each(['activity', 'nothing', 'unknown'] as const)('preserves an observed liveness answer: %s', async answer => {
  const f = await fixture()
  f.options.probe = async handle => { expect(handle.step_id).toBe(f.req.step_id); return answer }
  expect(await codexInReplRunner(f.options).liveness({ run_id: f.req.run_id, step_id: f.req.step_id })).toBe(answer)
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

test('the same step in another run gets a distinct task and reservation', async () => {
  const f = await fixture()
  const tasks: string[] = []
  f.options.composeActingTurn = async (_topic, spec) => {
    const args = JSON.parse(spec.prompt.split('\n')[1]!)
    tasks.push(args.task_name)
    expect(args).not.toHaveProperty('reasoning_effort')
    const request = JSON.parse(args.message.split('\n')[1].slice('Request (data): '.length))
    await writeFile(request.result.path, JSON.stringify({
      run_id: request.run_id, step_id: request.step_id, schema: request.result.schema, on: 'observed',
    }))
    return 'done'
  }
  const first = { ...f.req, effort: null }
  const second = { ...first, run_id: 'run-2', result: { ...first.result, path: join(f.req.cwd, 'second.json') } }
  expect((await f.run(codexInReplRunner(f.options), first)).kind).toBe('blocked')
  expect((await f.run(codexInReplRunner(f.options), second)).kind).toBe('blocked')
  expect(tasks).toHaveLength(2)
  expect(tasks[0]).not.toBe(tasks[1])
})

test.each(['FINAL_ANSWER: completed', 'child died', 'interrupted', 'spawn rejected'])('%s without a trailer is unknown', async reply => {
  const f = await fixture()
  f.options.composeActingTurn = async () => reply
  expect((await f.run(codexInReplRunner(f.options), { ...f.req, budget: { wall_ms: 20 } })).kind).toBe('unknown')
})

test('an unreadable trailer is unknown', async () => {
  const f = await fixture()
  const request = { ...f.req, result: { ...f.req.result, path: f.req.cwd } }
  expect((await f.run(codexInReplRunner(f.options), request)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
})

test.each(['run_id', 'step_id', 'schema'])('decoder rejects mismatched trailer %s', async field => {
  const f = await fixture()
  await f.trailer()
  const value = JSON.parse(await readFile(f.req.result.path, 'utf8'))
  value[field] = 'wrong'
  await writeFile(f.req.result.path, JSON.stringify(value))
  expect((await f.run()).kind).toBe('unknown')
})

for (const effort of ['xhigh', 'max'] as const) {
  test(`forwards extended effort ${effort} unchanged`, async () => {
    const f = await fixture()
    f.options.composeActingTurn = async (_topic, spec, opts) => {
      const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
      expect(args.reasoning_effort).toBe(effort)
      expect(args.message).toContain(JSON.stringify({ ...f.req, effort }))
      await f.trailer()
      return 'done'
    }
    expect(await f.run(undefined, { ...f.req, effort })).toEqual({ kind: 'blocked', on: 'file evidence' })
  })
}
