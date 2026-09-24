import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRunner, type BoundedWorkRequest, type ProviderObservation } from '../bounded-work.ts'
import { PROVIDERS, type Provider } from '../provider.ts'
import { createProjectRunners, decodeProjectTrailer, type ProjectRunnersOptions } from './project-runners.ts'
import { createCodexHeadlessRunner } from './codex-headless.ts'
import { workerPlacementRig } from '../adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const signal = () => new AbortController().signal
const observed: ProviderObservation = { source: 'claude-repl-jsonl', started_at_ms: 1, finished_at_ms: 2, observed_at_ms: 2,
  model_reported: 'provider-model', thread_id: 'child', usage: { input_tokens: 17, output_tokens: 0,
    cache_read_input_tokens: null, cache_creation_input_tokens: null, cost_usd: null } }
async function fixture(provider: Provider = 'openai-codex') {
  const dir = await mkdtemp(join(tmpdir(), 'project-runners-'))
  directories.push(dir)
  const request: BoundedWorkRequest = {
    run_id: 'run-1', step_id: 'step-1', role: 'build', model_id: 'chosen-model', effort: 'high',
    cwd: dir, writable: true, network: false, tools: 'edit-and-run',
    brief: { path: join(dir, 'brief.md'), integrity: 'host-verified' },
    result: { schema: 'result-v1', path: join(dir, 'result.json') },
    thread: null, budget: { wall_ms: 100 }, needs_approval_decision: false,
  }
  const envelope = { run_id: request.run_id, step_id: request.step_id, schema: request.result.schema,
    kind: 'completed', result: { answer: 'file' }, usage: { input_tokens: 999 }, model_reported: 'forged', thread_id: 'forged' }
  const metadata = { usage: { input_tokens: 12, output_tokens: 3 }, model_reported: 'observed-model', thread_id: 'observed-thread' }
  const calls: Parameters<ProjectRunnersOptions['actingTurn']>[0][] = []
  const options: ProjectRunnersOptions = {
    conversation: { project_id: 'project-1', topic_id: 'project-topic', provider,
      spec: { tools: [], model_preference: ['planning-model'], metering_context: { project_id: 'project-1' } } },
    run_id: request.run_id, state_dir: dir, headless: {},
    trailer: { schemas: new Map([['result-v1', value => JSON.stringify(value) === JSON.stringify(envelope.result)]]), metadata: () => metadata },
    actingTurn: async input => { calls.push(input); await writeFile(request.result.path, JSON.stringify(envelope)); return { kind: 'turn-ended' } },
  }
  const decode = (value: unknown = envelope) => decodeProjectTrailer(JSON.stringify(value), request, options.trailer)
  return { request, envelope, metadata, calls, options, decode, dir }
}

for (const provider of ['anthropic', 'openai-codex', 'pi'] as const) {
  test(`${provider} recovery requires exact armed evidence and cannot compose or reserve`, async () => {
    const f = await fixture(provider)
    const runner = (await createProjectRunners(f.options)).inRepl!
    const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(f.dir)).sort()
      .map(async name => [name, await readFile(join(f.dir, name), 'utf8')])))
    // Even a tempting complete result cannot stand in for dispatch authority.
    await writeFile(f.request.result.path, JSON.stringify(f.envelope))
    const before = await snapshot()
    expect((await runner.recover!(f.request, 'in-repl', signal())).kind).toBe('unknown')
    expect(await snapshot()).toEqual(before)
    expect(f.calls).toHaveLength(0)
    const first = await runner.run(f.request, 'in-repl', signal())
    expect(first.kind).toBe('completed')
    expect(f.calls).toHaveLength(1)
    const reservation = join(f.dir, (await readdir(f.dir)).find(name => /-step-.*\.json$/.test(name))!)
    const armed = await readFile(reservation, 'utf8')
    const retained = await snapshot()
    const replacement = (await createProjectRunners(f.options)).inRepl!
    expect(await replacement.recover!(f.request, 'in-repl', signal())).toEqual(first)
    for (const request of [
      { ...f.request, model_id: 'other-model' },
      { ...f.request, brief: { ...f.request.brief, integrity: 'changed-task' } },
      { ...f.request, network: !f.request.network },
      { ...f.request, run_id: 'other-run' },
    ]) expect((await replacement.recover!(request, 'in-repl', signal())).kind).toBe('unknown')
    expect(await replacement.recover!(f.request, 'headless', signal())).toEqual({ kind: 'refused', reason: 'placement-unavailable' })
    expect(await snapshot()).toEqual(retained)
    for (const bytes of [JSON.stringify(f.request), 'unreadable reservation', JSON.stringify({ ...f.request, model_id: 'foreign' }) + '\n#dispatch-armed\n']) {
      await writeFile(reservation, bytes)
      const beforeRefusal = await snapshot()
      expect((await replacement.recover!(f.request, 'in-repl', signal())).kind).toBe('unknown')
      expect(await snapshot()).toEqual(beforeRefusal)
    }
    await writeFile(reservation, armed)
    await unlink(reservation)
    const lost = await snapshot()
    expect((await replacement.recover!(f.request, 'in-repl', signal())).kind).toBe('unknown')
    expect(await snapshot()).toEqual(lost)
    expect(f.calls).toHaveLength(1)
  })

  test(`${provider} dispatches into its own conversation and recovers without replay`, async () => {
    const f = await fixture(provider)
    const first = await createProjectRunners(f.options)
    const result = await first.inRepl!.run(f.request, 'in-repl', signal())
    expect(result).toEqual({ kind: 'completed', result: f.envelope.result, ...f.metadata })
    expect(first.provider).toBe(provider)
    expect(first.inRepl!.provider).toBe(provider)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.conversation).toEqual(f.options.conversation)
    expect(f.calls[0]!.request).toBe(f.request)
    expect(f.calls[0]!.spec.model_preference).toEqual(['chosen-model'])
    const tool = { anthropic: 'Agent tool', 'openai-codex': 'collaboration.spawn_agent tool', pi: 'subagent tool' }[provider]
    expect(f.calls[0]!.spec.prompt).toContain(tool)
    if (provider === 'anthropic') {
      expect(JSON.parse(f.calls[0]!.spec.prompt.split('\n')[1]!).subagent_type).toBe('general-purpose')
      expect(f.calls[0]!.spec.tools).toEqual(f.options.conversation.spec.tools)
    }
    expect(f.calls[0]!.timeout_ms).toBeGreaterThan(0)
    expect(f.calls[0]!.timeout_ms).toBeLessThanOrEqual(f.request.budget.wall_ms)
    if (provider === 'pi') expect(f.calls[0]!.subagent).toMatch(/^bounded-worker-[a-f0-9]{64}$/)
    expect(await readFile(join(f.dir, 'project-run-binding.json'), 'utf8')).toBe(JSON.stringify(['project-1', 'project-topic', provider, 'run-1']))
    const reconstructed = await createProjectRunners(f.options)
    expect(await reconstructed.inRepl!.run(f.request, 'in-repl', signal())).toEqual(result)
    expect(f.calls).toHaveLength(1)
  })
}

test('Codex recovery preserves child transport without preparing or clearing a fresh dispatch', async () => {
  const f = await fixture('openai-codex')
  const preparations: string[] = []
  let clears = 0, publishes = 0
  f.options.codexResultTransport = {
    async prepare(_req, _signal, disposition) {
      preparations.push(disposition)
      return { resultPath: join(f.dir, 'child-result'),
        async clearForDispatch() { clears++ },
        async publish() { publishes++; await writeFile(f.request.result.path, JSON.stringify(f.envelope)); return true },
        close() {} }
    },
  }
  const runner = (await createProjectRunners(f.options)).inRepl!
  expect((await runner.recover!(f.request, 'in-repl', signal())).kind).toBe('unknown')
  expect(preparations).toEqual([])
  expect((await runner.run(f.request, 'in-repl', signal())).kind).toBe('completed')
  await unlink(f.request.result.path)
  const replacement = (await createProjectRunners(f.options)).inRepl!
  expect((await replacement.recover!(f.request, 'in-repl', signal())).kind).toBe('completed')
  expect(preparations).toEqual(['dispatch', 'resume'])
  expect(clears).toBe(1)
  expect(publishes).toBe(2)
  expect(f.calls).toHaveLength(1)
})

test('headless project wrapper preserves recovery and never substitutes run', async () => {
  const f = await fixture('pi')
  let runs = 0, recoveries = 0
  f.options.headless.anthropic = { ...fakeRunner('anthropic', {}),
    async run() { runs++; return { kind: 'unknown', detail: 'run' } },
    async recover() { recoveries++; return { kind: 'blocked', on: 'retained' } },
  }
  f.options.headless['openai-codex'] = fakeRunner('openai-codex', {})
  const runners = await createProjectRunners(f.options)
  expect(runners.headless['openai-codex']!.recover).toBeUndefined()
  expect(await runners.headless.anthropic!.recover!(f.request, 'headless', signal())).toEqual({ kind: 'blocked', on: 'retained' })
  expect(await runners.headless.anthropic!.recover!(f.request, 'in-repl', signal())).toEqual({ kind: 'refused', reason: 'placement-unavailable' })
  expect((await runners.headless.anthropic!.recover!({ ...f.request, run_id: 'foreign' }, 'headless', signal())).kind).toBe('unknown')
  expect(recoveries).toBe(1)
  expect(runs).toBe(0)
})

for (const provider of ['anthropic', 'openai-codex', 'pi'] as const) {
  test(`${provider} waits past another step's trailer`, async () => {
    const f = await fixture(provider)
    const request = { ...f.request, budget: { wall_ms: 500 } }
    f.options.actingTurn = async input => {
      f.calls.push(input)
      await writeFile(f.request.result.path, JSON.stringify({ ...f.envelope, step_id: 'older-step' }))
      void Bun.sleep(25).then(() => writeFile(f.request.result.path, JSON.stringify(f.envelope)))
      return { kind: 'turn-ended' }
    }
    expect(await (await createProjectRunners(f.options)).inRepl!.run(request, 'in-repl', signal()))
      .toEqual({ kind: 'completed', result: f.envelope.result, ...f.metadata })
  })
}

for (const scenario of ['completed', 'malformed', 'interrupted', 'blocked', 'refused'] as const) {
  test(`host usage survives ${scenario} outcomes and restart without dispatch replay`, async () => {
    const f = await fixture('anthropic')
    f.request = { ...f.request, budget: { wall_ms: 1000 } }
    const acting = f.options.actingTurn
    let reads = 0
    f.options.actingTurn = async input => {
      if (scenario === 'completed') return acting(input)
      f.calls.push(input)
      if (scenario === 'malformed') { await writeFile(f.request.result.path, '{'); return { kind: 'turn-ended' } }
      if (scenario === 'interrupted') throw new Error('lost acknowledgement')
      if (scenario === 'blocked') return { kind: 'blocked', on: 'provider limit' }
      return { kind: 'refused', reason: 'capability-unsupported', detail: 'unavailable' }
    }
    f.options.actingTurn.observeUsage = async () => { reads++; return observed }
    const first = await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', signal())
    expect(first.kind).toBe(scenario === 'completed' ? 'completed' : scenario === 'blocked' ? 'blocked' : scenario === 'refused' ? 'refused' : 'unknown')
    expect(first.observation).toEqual(observed)
    const controller = new AbortController(); controller.abort()
    const second = await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', scenario === 'completed' || scenario === 'malformed' ? signal() : controller.signal)
    expect(second.observation).toEqual(observed)
    expect(f.calls).toHaveLength(1)
    expect(reads).toBe(2)
  })
}

test('unavailable observation cannot veto valid completion or grant missing completion', async () => {
  const f = await fixture('anthropic')
  f.options.actingTurn.observeUsage = async () => { throw new Error('unreadable telemetry') }
  expect((await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', signal())).kind).toBe('completed')
})

test('project observation recovery invokes no dispatch and refuses another run', async () => {
  const f = await fixture('anthropic')
  let reads = 0
  f.options.actingTurn.observeUsage = async request => { reads++; expect(request).toBe(f.request); return observed }
  const runner = (await createProjectRunners(f.options)).inRepl!
  expect(await runner.observe!(f.request)).toEqual(observed)
  expect(await runner.observe!({ ...f.request, run_id: 'foreign' })).toBeUndefined()
  expect(f.calls).toHaveLength(0)
  expect(reads).toBe(1)
})

test('headless selection follows project provider and underlying supports', async () => {
  for (const provider of PROVIDERS) {
    const f = await fixture(provider)
    const candidates = Object.fromEntries(PROVIDERS.map(p => [p, fakeRunner(p, {
      outcomes: new Map([[f.request.step_id, { kind: 'blocked' as const, on: 'headless' }]]),
      supports: role => role === 'build' ? { ok: true } : { ok: false, reason: 'capability-unsupported', detail: 'build only' },
    })]))
    f.options.headless = candidates
    const built = await createProjectRunners(f.options)
    expect(Object.keys(built.headless).sort()).toEqual(PROVIDERS.filter(p => p !== provider).sort())
    for (const other of PROVIDERS.filter(p => p !== provider)) {
      const runner = built.headless[other]!
      expect(await runner.run(f.request, 'headless', signal())).toEqual({ kind: 'blocked', on: 'headless' })
      expect(await runner.run(f.request, 'in-repl', signal())).toEqual({ kind: 'refused', reason: 'placement-unavailable' })
      expect(await runner.run({ ...f.request, role: 'review' }, 'headless', signal())).toEqual({ kind: 'refused', reason: 'capability-unsupported' })
      expect(candidates[other]!.calls).toHaveLength(1)
    }
    expect(f.calls).toHaveLength(0)
    if (provider === 'openai') expect(built.inRepl).toBeUndefined()
  }
})

test('missing headless stays unavailable and mismatched headless identity is rejected', async () => {
  const f = await fixture('pi')
  expect((await createProjectRunners(f.options)).headless).toEqual({})
  f.options.headless = { 'openai-codex': fakeRunner('anthropic') }
  await expect(createProjectRunners(f.options)).rejects.toThrow('provider')
})

test('run and placement are checked before dispatch', async () => {
  const f = await fixture()
  const built = await createProjectRunners(f.options)
  expect(await built.inRepl!.run({ ...f.request, run_id: 'other' }, 'in-repl', signal())).toEqual({ kind: 'unknown', detail: 'Request run_id does not match the host run.' })
  expect(await built.inRepl!.run(f.request, 'headless', signal())).toEqual({ kind: 'refused', reason: 'placement-unavailable' })
  expect(f.calls).toHaveLength(0)
})

test('state binding rejects each changed identity and unreadable state', async () => {
  const f = await fixture()
  await createProjectRunners(f.options)
  for (const field of ['project_id', 'topic_id', 'provider'] as const) {
    const conversation = { ...f.options.conversation, [field]: field === 'provider' ? 'pi' : 'different' }
    await expect(createProjectRunners({ ...f.options, conversation })).rejects.toThrow('different project')
  }
  await expect(createProjectRunners({ ...f.options, run_id: 'other-run' })).rejects.toThrow('different project')
  await expect(createProjectRunners({ ...f.options, state_dir: join(f.dir, 'missing') })).rejects.toThrow()
  await writeFile(join(f.dir, 'project-run-binding.json'), 'unreadable binding')
  await expect(createProjectRunners(f.options)).rejects.toThrow('different project')
})

test('uncertain turn stays unknown even with a valid trailer and is never replayed', async () => {
  const f = await fixture('pi')
  const acting = f.options.actingTurn
  f.options.actingTurn = async input => { await acting(input); return { kind: 'unknown', detail: 'terminal event missing' } }
  expect(await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', signal()))
    .toEqual({ kind: 'unknown', detail: 'Dispatch turn completion unknown: terminal event missing' })
  await rm(f.request.result.path)
  expect((await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', signal())).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
})

test('turn ended with no file or unreadable file remains unknown', async () => {
  const f = await fixture()
  f.options.actingTurn = async input => { f.calls.push(input); return { kind: 'turn-ended' } }
  expect((await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', signal())).kind).toBe('unknown')
  const request = { ...f.request, step_id: 'second', result: { ...f.request.result, path: f.dir } }
  expect((await (await createProjectRunners(f.options)).inRepl!.run(request, 'in-repl', signal())).kind).toBe('unknown')
})

test('decoder accepts valid payload with host metadata and valid blocked reason', async () => {
  const f = await fixture()
  expect(f.decode()).toEqual({ kind: 'completed', result: f.envelope.result, ...f.metadata })
  expect(f.decode({ ...f.envelope, kind: 'blocked', on: 'needs tool access' })).toEqual({ kind: 'blocked', on: 'needs tool access' })
})

for (const [field, replacement, detail] of [
  ['schema', 'other', 'schema'],
  ['kind', 'failed', 'outcome kind'], ['result', { answer: 'bad' }, 'schema validation'],
] as const) {
  test(`decoder rejects ${field}`, async () => {
    const f = await fixture()
    expect(f.decode({ ...f.envelope, [field]: replacement })).toEqual({ kind: 'unknown', detail: expect.stringContaining(detail),
      ...(field === 'result' ? { invalid_result: { schema: f.request.result.schema, payload: replacement } } : {}) })
  })
}

test('decoder separates another step from an unreadable identity', async () => {
  const f = await fixture()
  expect(f.decode({ ...f.envelope, run_id: 'other' })).toEqual({ kind: 'not-current-step' })
  expect(f.decode({ ...f.envelope, step_id: 'other' })).toEqual({ kind: 'not-current-step' })
  expect(f.decode({ ...f.envelope, step_id: undefined })).toEqual({ kind: 'unknown', detail: 'Trailer step_id missing or unreadable.' })
})

test('decoder rejects missing validator and accepts missing host observations', async () => {
  const f = await fixture()
  f.options.trailer.schemas = new Map()
  expect(f.decode()).toEqual({ kind: 'unknown', detail: 'Trailer schema has no host validator.' })
  f.options.trailer.schemas = new Map([['result-v1', () => true]])
  f.options.trailer.metadata = () => undefined
  expect(f.decode()).toEqual({ kind: 'completed', result: f.envelope.result, usage: null, model_reported: null, thread_id: null })
})

test('decoder rejects malformed envelope and blocked reasons', async () => {
  const f = await fixture()
  for (const value of [null, [], 4, 'text']) expect(f.decode(value)).toEqual({ kind: 'unknown', detail: 'Trailer object missing.' })
  expect(decodeProjectTrailer('{', f.request, f.options.trailer)).toEqual({
    kind: 'unknown',
    detail: "Trailer JSON or host validation could not be read.: SyntaxError: JSON Parse error: Expected '}'",
  })
  for (const on of [undefined, '', ' ', 4]) expect(f.decode({ ...f.envelope, kind: 'blocked', on })).toEqual({ kind: 'unknown', detail: 'Trailer blocked reason missing.' })
})

test('decoder host exceptions retain their cause and stay unknown', async () => {
  const f = await fixture()
  f.options.trailer.schemas = new Map([['result-v1', () => { throw Error('validator process offline') }]])
  expect(f.decode()).toEqual({
    kind: 'unknown',
    detail: 'Trailer JSON or host validation could not be read.: Error: validator process offline',
  })
})

test('separate projects keep their topics and reservations isolated', async () => {
  const first = await fixture('openai-codex')
  const second = await fixture('pi')
  second.options.conversation = { ...second.options.conversation, project_id: 'project-2', topic_id: 'second-topic' }
  const runners = await Promise.all([createProjectRunners(first.options), createProjectRunners(second.options)])
  await Promise.all(runners.map((built, index) => built.inRepl!.run([first, second][index]!.request, 'in-repl', signal())))
  expect(first.calls[0]!.conversation.topic_id).toBe('project-topic')
  expect(second.calls[0]!.conversation.topic_id).toBe('second-topic')
  expect(first.calls).toHaveLength(1)
  expect(second.calls).toHaveLength(1)
})

test('bridge exception preserves reservation and liveness stays unknown', async () => {
  const f = await fixture()
  f.options.actingTurn = async input => { f.calls.push(input); throw new Error('connection lost') }
  const built = await createProjectRunners(f.options)
  expect((await built.inRepl!.run(f.request, 'in-repl', signal())).kind).toBe('unknown')
  expect((await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', signal())).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
  expect(await built.inRepl!.liveness(f.request)).toBe('unknown')
})

test('missing or throwing telemetry preserves valid results and rejects invalid trailers', async () => {
  const f = await fixture()
  for (const metadata of [() => undefined, () => { throw Error('telemetry unavailable') }]) {
    f.options.trailer.metadata = metadata
    expect(f.decode()).toEqual({ kind: 'completed', result: f.envelope.result, usage: null, model_reported: null, thread_id: null })
    expect(f.decode({ ...f.envelope, result: { answer: 'bad' } }).kind).toBe('unknown')
    expect(f.decode({ ...f.envelope, step_id: 'other' }).kind).toBe('not-current-step')
    expect(decodeProjectTrailer('{', f.request, f.options.trailer).kind).toBe('unknown')
  }
  expect((await (await createProjectRunners(f.options)).inRepl!.run(f.request, 'in-repl', signal())).kind).toBe('completed')
})

test('native same-provider work is never placed; only the cross-provider headless worker gets a tab', async () => {
  const f = await fixture('anthropic')
  const rig = workerPlacementRig(f.dir)
  const wrapper = join(f.dir, 'wrapper.sh')
  await writeFile(wrapper, '#!/bin/bash\necho \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'\n', { mode: 0o755 })
  f.options.headless = { 'openai-codex': createCodexHeadlessRunner({ buildScript: wrapper, probe: { ok: true },
    placement: rig.placement(), taskName: 'native-control' }) }
  const built = await createProjectRunners(f.options)
  // Same provider as the conversation: the native in-REPL child, untouched.
  expect((await built.inRepl!.run(f.request, 'in-repl', signal())).kind).toBe('completed')
  expect(f.calls).toHaveLength(1)
  expect(rig.server.calls).toEqual([])
  expect((await readdir(f.dir)).filter(name => name.endsWith('.placement.json'))).toEqual([])
  // Positive control: the cross-provider worker in the same project IS placed.
  await built.headless['openai-codex']!.run({ ...f.request, step_id: 'step-2', budget: { wall_ms: 5_000 } }, 'headless', signal())
  expect(rig.server.workerLayouts().map(call => call.params['tab_label'])).toEqual(['Build · native-control'])
  expect(f.calls).toHaveLength(1)
})
