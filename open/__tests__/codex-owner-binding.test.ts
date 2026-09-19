import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'
import { buildLlmCallSubstrate } from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { CodexOwnerBinding, CodexOwnerBindingFacts, CodexOwnerBootstrap } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { createProjectRunners } from '@neutronai/runtime/workers/project-runners.ts'
import { composeReplModelSurface } from '@neutronai/gateway/composition/repl-model.ts'
import { createAppNativeOwnerControlSurface } from '@neutronai/gateway/http/app-native-owner-control-surface.ts'
import type { ReplModelState } from '@neutronai/runtime/repl-model.ts'
import type { NativeOwnerControlState } from '../wiring/codex-owner-controls.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const spec = (prompt: string): AgentSpec => ({ prompt, tools: [], model_preference: [] })
async function collect(handle: SessionHandle) { const events = []; for await (const event of handle.events) events.push(event); return events }
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'owner-binding-test-')); dirs.push(dir)
  const facts = new Map<CodexOwnerBinding, CodexOwnerBindingFacts>()
  const calls: { project: string; thread: string; prompt: string }[] = []
  const launched: string[] = []
  const rpc: { client: string; method: string; params: Record<string, unknown>; epoch: number | undefined }[] = []
  const replies: { client: string; id: string | number; result: unknown; epoch: number }[] = []
  const emitters = new Map<string, (method: string, params: Record<string, unknown>) => void>()
  const finishers = new Map<string, () => void>()
  let held = false
  let wrongModel = false
  let failReply = false
  const homes = new Map<string, string>()
  let fail = false
  let wrongReceipt = false
  let approval = false
  let capability = true
  let onPrompt: ((prompt: string) => void) | undefined
  const bindings = new CodexOwnerBindings(async projectId => {
    const cwd = join(dir, projectId), codexHome = join(cwd, 'home')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify(projectId))
    homes.set(projectId, codexHome)
    return { cwd, codexHome, env: { OPENAI_API_KEY: 'must-not-reach-native', PATH: process.env.PATH } }
  }, async options => {
    const project = JSON.parse(await Bun.file(join(options.codexHome, 'project-owner.json')).text()) as string
    launched.push(project)
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    if (fail) throw new Error('Existing owner needs explicit recovery')
    const binding = {} as CodexOwnerBinding
    const identity: CodexOwnerBindingFacts = { capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' }, threadId: `native-${project}`, sessionId: `session-${project}`,
      cwd: options.cwd, codexHome: options.codexHome, rolloutPath: join(options.codexHome, 'rollout.jsonl'),
      paneHandle: `pane-${project}`, bindingRevision: `revision-${project}`, generation: 1, brokerGeneration: 1,
      credentialFingerprint: 'fixture', modelProvider: 'fixture', controlSocketPath: options.socketPath,
      nativeMetadata: { sessionId: `session-${project}`, source: 'vscode', originator: 'owner-bootstrap-probe' } }
    if (!capability) Reflect.deleteProperty(identity, 'capabilities')
    facts.set(binding, identity)
    let count = 0
    let epoch = 0
    let model = 'small'
    let phase: 'idle' | 'turn' = 'idle'
    let listener: ((message: Record<string, unknown>) => void) | undefined
    emitters.set(project, (method, params) => listener?.({ id: 'approval', method, params: { threadId: identity.threadId, turnId: `turn-${count}`, ...params } }))
    const finish = (): void => {
      appendFileSync(identity.rolloutPath, line('event_msg', { type: 'task_complete', turn_id: `turn-${count}`, last_agent_message: `reply-${count}` }))
      phase = 'idle'
    }
    finishers.set(project, finish)
    const owner: CodexOwnerBootstrap = { binding, writeTerminal() { throw new Error('Unexpected terminal delivery') }, async close() {},
      broker: { state: () => ({ phase, generation: 1, epoch, activeTurnId: phase === 'turn' ? `turn-${count}` : null, unresolved: null }),
        close() {}, gateway: client => ({ close() {}, reply(id, result, expectedEpoch) {
          replies.push({ client, id, result, epoch: expectedEpoch }); if (failReply) throw new Error('Reply delivery unknown')
        }, subscribe(fn) { listener = fn; return () => { listener = undefined } },
          async request(method, params, expectedEpoch) {
            rpc.push({ client, method, params, epoch: expectedEpoch })
            if (method === 'model/list') return params.cursor ? { data: [{ model: 'large', displayName: 'Large' }], nextCursor: null }
              : { data: [{ model: 'small', displayName: 'Small' }], nextCursor: 'second' }
            expect(params.threadId).toBe(identity.threadId)
            if (method === 'thread/read') return { thread: { ...identity, id: identity.threadId, model } }
            if (method === 'thread/settings/update') { epoch++; if (!wrongModel) model = params.model as string; return {} }
            if (method === 'turn/interrupt') { finish(); return {} }
            expect(method).toBe('turn/start')
            const prompt = (params.input as { text: string }[])[0]!.text
            calls.push({ project, thread: params.threadId as string, prompt })
            const turn = `turn-${++count}`
            epoch++
            phase = 'turn'
            if (count === 1) writeFileSync(identity.rolloutPath, line('session_meta', { id: identity.threadId,
              cwd: identity.cwd, source: identity.nativeMetadata.source, originator: identity.nativeMetadata.originator, session_id: identity.sessionId }))
            appendFileSync(identity.rolloutPath, line('event_msg', { type: 'task_started', turn_id: turn })
              + line('event_msg', { type: 'item_completed', thread_id: identity.threadId, turn_id: turn,
                item: { type: 'UserMessage', id: `user-${count}`, content: [{ type: 'text', text: prompt, text_elements: [] }] } }))
            if (approval) listener?.({ id: 'approval', method: 'item/tool/requestUserInput', params: { threadId: 'foreign-thread', turnId: turn } })
            else {
              onPrompt?.(prompt)
              if (!held) finish()
            }
            return { turn: { id: wrongReceipt ? 'foreign-turn' : turn } }
          },
        }),
      },
    }
    return owner
  }, binding => {
    const identity = facts.get(binding)
    if (!identity) throw new Error('Unattested owner binding')
    return identity
  })
  const chat = buildLlmCallSubstrate({ resolvePool: async () => null, substrate_instance_id: 'owner-test', ownerConversation: true,
    provider: 'openai-codex', startCodexOwner: (id, input) => bindings.start(id, input),
    configuredChat: { env: { NEUTRON_PROJECT_MODELS: '{"project-one":"glm"}' }, fetchImpl: (() => { throw new Error('Unexpected configured API call') }) as unknown as typeof fetch },
  })!
  return { dir, calls, launched, homes, bindings, chat,
    rpc, replies, hold: (value: boolean) => { held = value }, finish: (project = 'project-one') => finishers.get(project)!(),
    question: (method: string, params: Record<string, unknown>, project = 'project-one') => emitters.get(project)!(method, params),
    wrongModel: () => { wrongModel = true },
    failReply: () => { failReply = true },
    fail: () => { fail = true }, wrongReceipt: () => { wrongReceipt = true }, foreignApproval: () => { approval = true },
    noCapability: () => { capability = false },
    onPrompt: (fn: (prompt: string) => void) => { onPrompt = fn } }
}

test('two owner turns, build dispatch and another turn share one native owner; second project is isolated', async () => {
  const f = fixture()
  const chat = (project: string, prompt: string) => collect(f.chat.start({ ...spec(prompt), metering_context: { project_id: project } }))
  expect((await chat('project-one', 'one')).at(-1)).toMatchObject({ kind: 'completion', session: { id: 'native-project-one' } })
  expect((await chat('project-one', 'two')).at(-1)).toMatchObject({ kind: 'completion', session: { id: 'native-project-one' } })
  const cwd = join(f.dir, 'project-one')
  const result = join(cwd, 'result.json')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'step', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: result, schema: 'fixture' }, thread: { id: 'native-project-one' }, budget: { wall_ms: 2000 }, needs_approval_decision: false }
  f.onPrompt(() => writeFileSync(result, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'step', kind: 'completed', result: {} })))
  const acting = f.bindings.actingTurn('project-one', 'chat-topic-not-a-native-thread', cwd, [cwd])
  const turn = { conversation: { project_id: 'project-one', topic_id: 'chat-topic-not-a-native-thread', provider: 'openai-codex' as const, spec: spec('') },
    request, spec: spec('Invoke the collaboration.spawn_agent tool exactly once'), timeout_ms: 2000, signal: new AbortController().signal }
  expect(await acting(turn)).toEqual({ kind: 'turn-ended' })
  expect((await chat('project-one', 'after build')).at(-1)).toMatchObject({ kind: 'completion', session: { id: 'native-project-one' } })
  expect((await chat('project-two', 'isolated')).at(-1)).toMatchObject({ kind: 'completion', session: { id: 'native-project-two' } })
  expect(f.launched).toEqual(['project-one', 'project-two'])
  expect(f.calls.map(call => call.thread)).toEqual(['native-project-one', 'native-project-one', 'native-project-one', 'native-project-one', 'native-project-two'])
  expect(await acting({ ...turn, request: { ...request, thread: { id: turn.conversation.topic_id } } })).toMatchObject({ kind: 'refused' })
  expect(f.calls).toHaveLength(5)
})

test('recovery refusal is sticky and never retries a fresh owner or another provider', async () => {
  const f = fixture(); f.fail()
  for (let index = 0; index < 2; index++) expect((await collect(f.bindings.start('project-one', spec('hello')))).at(-1)).toMatchObject({ kind: 'error', message: 'Existing owner needs explicit recovery' })
  expect(f.launched).toEqual(['project-one']); expect(f.calls).toHaveLength(0)
})

test('unattested native subagent capability refuses build while owner chat remains usable', async () => {
  const f = fixture(); f.noCapability()
  expect((await collect(f.bindings.start('project-one', spec('hello')))).at(-1)?.kind).toBe('completion')
  const outcome = await f.bindings.actingTurn('project-one', 'topic', join(f.dir, 'project-one'), [])({} as Parameters<ReturnType<CodexOwnerBindings['actingTurn']>>[0])
  expect(outcome).toEqual({ kind: 'refused', reason: 'capability-unsupported', detail: 'Codex owner lacks attested native subagent capability' })
  expect((await collect(f.bindings.start('project-one', spec('again')))).at(-1)?.kind).toBe('completion')
  expect(f.calls).toHaveLength(2); expect(f.launched).toHaveLength(1)
})

test('missing child trailer fences later chat even when the native parent completed', async () => {
  const f = fixture()
  await collect(f.bindings.start('project-one', spec('hello')))
  const cwd = join(f.dir, 'project-one')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'missing', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: join(cwd, 'missing.json'), schema: 'fixture' }, thread: null, budget: { wall_ms: 30 }, needs_approval_decision: false }
  const turn = { conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex' as const, spec: spec('') },
    request, spec: spec('dispatch'), timeout_ms: 30, signal: new AbortController().signal }
  expect((await f.bindings.actingTurn('project-one', 'topic', cwd, [cwd])(turn)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(2)
  expect((await collect(f.bindings.start('project-one', spec('must not dispatch')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(2)
})

test.each(['valid', 'invalid-payload', 'malformed-envelope'] as const)('host-decoded child %s controls later chat and distinct-step dispatch', async result => {
  const valid = result === 'valid'
  const f = fixture()
  await collect(f.bindings.start('project-one', spec('hello')))
  const cwd = join(f.dir, 'project-one')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'first', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: join(cwd, 'result.json'), schema: 'fixture' }, thread: null, budget: { wall_ms: 2000 }, needs_approval_decision: false }
  f.onPrompt(() => writeFileSync(request.result.path, result === 'malformed-envelope' ? '{}' : JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'first', kind: 'completed', result: valid ? { accepted: true } : {} })))
  const runners = await createProjectRunners({
    conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
    run_id: 'run', state_dir: cwd, actingTurn: f.bindings.actingTurn('project-one', 'topic', cwd, [cwd]),
    trailer: { schemas: new Map([['fixture', value => (value as { accepted?: boolean })?.accepted === true]]), metadata: () => undefined }, headless: {},
  })
  const worker = f.bindings.guardBuildRunner('project-one', runners.inRepl!)
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe(valid ? 'completed' : 'unknown')
  expect(f.calls).toHaveLength(2)
  expect((await collect(f.bindings.start('project-one', spec('after payload')))).at(-1)?.kind).toBe(valid ? 'completion' : 'error')
  expect(f.calls).toHaveLength(valid ? 3 : 2)
  if (!valid) {
    expect((await worker.run({ ...request, step_id: 'second', result: { ...request.result, path: join(cwd, 'second.json') } }, 'in-repl', new AbortController().signal)).kind).not.toBe('completed')
    expect(f.calls).toHaveLength(2)
  }
})

test('chat cannot interleave while a completed native parent awaits its child result', async () => {
  const f = fixture()
  await collect(f.bindings.start('project-one', spec('hello')))
  const cwd = join(f.dir, 'project-one')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'pending', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: join(cwd, 'pending.json'), schema: 'fixture' }, thread: null, budget: { wall_ms: 2000 }, needs_approval_decision: false }
  const pending = f.bindings.actingTurn('project-one', 'topic', cwd, [cwd])({
    conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
    request, spec: spec('dispatch'), timeout_ms: 2000, signal: new AbortController().signal,
  })
  for (let attempt = 0; f.calls.length < 2 && attempt < 100; attempt++) await Bun.sleep(1)
  expect(f.calls).toHaveLength(2)
  expect((await collect(f.bindings.start('project-one', spec('must wait')))).at(-1)).toMatchObject({ kind: 'error', message: 'Codex owner build result is still pending' })
  expect(f.calls).toHaveLength(2)
  writeFileSync(request.result.path, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'pending', kind: 'completed', result: {} }))
  expect(await pending).toEqual({ kind: 'turn-ended' })
  expect((await collect(f.bindings.start('project-one', spec('now ready')))).at(-1)?.kind).toBe('completion')
})

test.each(['wrongReceipt', 'foreignApproval'] as const)('%s quarantines the shared binding for chat and build', async mode => {
  const f = fixture(); f[mode]()
  expect((await collect(f.bindings.start('project-one', spec('hello')))).some(event => event.kind === 'error')).toBe(true)
  expect((await collect(f.bindings.start('project-one', spec('again')))).some(event => event.kind === 'error')).toBe(true)
  expect(f.launched).toHaveLength(1); expect(f.calls).toHaveLength(1)
})

test('missing owner binding refuses before configured tiers, headless Codex or Claude', async () => {
  const chat = buildLlmCallSubstrate({ resolvePool: async () => null, substrate_instance_id: 'missing', ownerConversation: true,
    provider: 'openai-codex', configuredChat: { env: { NEUTRON_PROJECT_MODELS: '{"project-one":"glm"}' } } })!
  expect(await collect(chat.start({ ...spec('hello'), metering_context: { project_id: 'project-one' } }))).toEqual([
    { kind: 'error', retryable: false, message: 'Codex owner conversation binding is unavailable' },
  ])
})

test('foreign project marker and forged factory binding never submit native work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-marker-test-')); dirs.push(dir)
  writeFileSync(join(dir, 'project-owner.json'), JSON.stringify('other-project'))
  let launches = 0
  const bindings = new CodexOwnerBindings(async () => ({ cwd: dir, codexHome: dir, env: {} }), async () => {
    launches++; return { binding: {}, async close() {} } as CodexOwnerBootstrap
  })
  expect((await collect(bindings.start('project-one', spec('hello')))).at(-1)).toMatchObject({ kind: 'error', message: 'Codex owner credential home belongs to another project' })
  expect(launches).toBe(0)
  writeFileSync(join(dir, 'project-owner.json'), JSON.stringify('project-two'))
  expect((await collect(bindings.start('project-two', spec('hello')))).at(-1)).toMatchObject({ kind: 'error', message: 'Unattested owner binding' })
  expect(launches).toBe(1)
})

function controlSurfaces(f: ReturnType<typeof fixture>) {
  const auth = { mode: 'hs256' as const, resolve: async (token: string) => token === 'invalid'
    ? { code: 'invalid_signature' as const, message: 'Invalid bearer' }
    : { user_id: token, project_slug: 'instance', mode: 'hs256' as const } }
  const model = composeReplModelSurface({ auth, ownerUserId: 'owner', ownerSlug: 'instance',
    projectExists: async id => ['project-one', 'project-two'].includes(id), provider: () => 'openai-codex',
    readClaude: async () => { throw new Error('Unexpected Claude') }, switchClaude: async () => { throw new Error('Unexpected Claude') },
    readCodex: id => f.bindings.controls.model(id), switchCodex: (id, request) => f.bindings.controls.model(id, request),
  })
  const turn = createAppNativeOwnerControlSurface({ auth,
    canAccess: async (user, owner, id) => user === 'owner' && owner === 'instance' && ['project-one', 'project-two'].includes(id),
    read: id => f.bindings.controls.state(id), act: (id, request) => f.bindings.controls.act(id, request),
  })
  return async (kind: 'model' | 'control', body?: unknown, project = 'project-one', token: string | null = 'owner') => {
    const request = new Request(`http://localhost/api/app/projects/${project}/repl-${kind}`, {
      method: body === undefined ? 'GET' : 'POST', headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return (await (kind === 'model' ? model : turn).handler(request))!
  }
}

test('native model API authenticates, lists all native pages, switches both directions and preserves exact owner', async () => {
  const f = fixture(), api = controlSurfaces(f)
  for (const token of [null, 'invalid']) expect((await api('model', undefined, 'project-one', token)).status).toBe(401)
  expect((await api('model', undefined, 'project-one', 'stranger')).status).toBe(404)
  expect((await api('model', undefined, 'missing')).status).toBe(404)
  expect((await api('model')).status).toBe(503)
  expect(f.launched).toHaveLength(0)
  await collect(f.bindings.start('project-one', spec('before switch')))
  let state = await (await api('model')).json() as ReplModelState
  expect(state).toMatchObject({ harness: 'codex', currentModel: 'small', status: 'ready', availableModels: [{ id: 'small', label: 'Small' }, { id: 'large', label: 'Large' }] })
  const old = state.sessionId
  expect((await api('model', { model: 'invented', sessionId: old })).status).toBe(400)
  expect(f.rpc.filter(call => call.method === 'thread/settings/update')).toHaveLength(0)
  const up = await api('model', { model: 'large', sessionId: old })
  expect(up.status).toBe(200); state = await up.json() as ReplModelState
  expect(state.currentModel).toBe('large'); expect(state.sessionId).not.toBe(old)
  expect((await api('model', { model: 'small', sessionId: old })).status).toBe(409)
  await collect(f.bindings.start('project-one', spec('use larger model')))
  expect(f.rpc.findLast(call => call.method === 'turn/start')?.params.model).toBe('large')
  state = await (await api('model')).json() as ReplModelState
  await collect(f.bindings.start('project-two', spec('isolated')))
  expect((await api('model', { model: 'small', sessionId: state.sessionId }, 'project-two')).status).toBe(409)
  expect(await (await api('model', { model: 'small', sessionId: state.sessionId })).json()).toMatchObject({ currentModel: 'small' })
  expect((await collect(f.bindings.start('project-one', spec('after switch')))).at(-1)).toMatchObject({ kind: 'completion', session: { id: 'native-project-one' } })
  expect(f.launched).toEqual(['project-one', 'project-two'])
  expect(f.rpc.filter(call => call.method === 'thread/settings/update').map(call => call.params)).toEqual([
    { threadId: 'native-project-one', model: 'large' }, { threadId: 'native-project-one', model: 'small' },
  ])
})

test('native switch requires confirmed model state and quarantines an uncertain update', async () => {
  const f = fixture(), api = controlSurfaces(f)
  await collect(f.bindings.start('project-one', spec('hello')))
  const { sessionId } = await (await api('model')).json() as ReplModelState
  f.wrongModel()
  expect((await api('model', { model: 'large', sessionId })).status).toBe(503)
  expect((await collect(f.bindings.start('project-one', spec('no reuse')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(1)
})

test('native controls revalidate the full project credential-home marker without spawning', async () => {
  const f = fixture(), api = controlSurfaces(f)
  await collect(f.bindings.start('project-one', spec('hello')))
  expect((await api('model')).status).toBe(200)
  const before = f.rpc.length
  writeFileSync(join(f.homes.get('project-one')!, 'project-owner.json'), JSON.stringify('project-two'))
  expect((await api('model')).status).toBe(503)
  expect((await api('control')).status).toBe(503)
  expect(f.rpc).toHaveLength(before)
  expect(f.launched).toEqual(['project-one'])
})

test.each(['accept', 'decline'] as const)('native %s approval is authenticated, exact-turn owned, one-shot and visible in the chat stream', async decision => {
  const f = fixture(), api = controlSurfaces(f)
  f.hold(true)
  const events: Awaited<ReturnType<typeof collect>> = []
  const draining = (async () => { for await (const event of f.bindings.start('project-one', spec('question')).events) events.push(event) })()
  for (let attempt = 0; f.calls.length < 1 && attempt < 100; attempt++) await Bun.sleep(1)
  f.question('item/commandExecution/requestApproval', { command: 'echo bounded', reason: 'Needs an owner decision', availableDecisions: ['accept', 'decline'] })
  for (let attempt = 0; !events.some(event => event.kind === 'tool_call') && attempt < 100; attempt++) await Bun.sleep(1)
  expect(events.some(event => event.kind === 'tool_call' && event.tool_name === 'codex_owner_question')).toBe(true)
  for (const token of [null, 'invalid']) expect((await api('control', undefined, 'project-one', token)).status).toBe(401)
  expect((await api('control', undefined, 'project-one', 'stranger')).status).toBe(404)
  const state = await (await api('control')).json() as NativeOwnerControlState
  expect(state.pending).toHaveLength(1)
  const action = { ...state, action: 'reply', requestId: 'approval', result: { decision } }
  for (const change of [{ projectId: 'project-two' }, { threadId: 'topic' }, { turnId: 'old' }, { bindingRevision: 'old' }, { epoch: state.epoch - 1 }, { generation: state.generation + 1 }]) {
    expect([400, 409]).toContain((await api('control', { ...action, ...change })).status)
  }
  expect(f.replies).toHaveLength(0)
  expect((await api('control', { ...action, result: { decision: 'acceptForSession' } })).status).toBe(503)
  const model = await (await api('model')).json() as ReplModelState
  expect(model.status).toBe('busy')
  expect((await api('model', { model: 'large', sessionId: model.sessionId })).status).toBe(409)
  expect((await api('control', action)).status).toBe(200)
  expect(f.replies).toEqual([{ client: f.rpc.find(call => call.method === 'turn/start')!.client, id: 'approval', result: { decision }, epoch: state.epoch }])
  expect((await api('control', action)).status).toBe(409)
  f.finish(); await draining
  f.hold(false)
  expect((await collect(f.bindings.start('project-one', spec('next')))).at(-1)?.kind).toBe('completion')
})

test('native interrupt routes through the original writer and a stale turn cannot interrupt its successor', async () => {
  const f = fixture(), api = controlSurfaces(f)
  f.hold(true)
  const draining = collect(f.bindings.start('project-one', spec('hold')))
  for (let attempt = 0; f.calls.length < 1 && attempt < 100; attempt++) await Bun.sleep(1)
  const state = await (await api('control')).json() as NativeOwnerControlState
  const action = { ...state, action: 'interrupt' }
  expect((await api('control', { ...action, turnId: 'other' })).status).toBe(409)
  expect(f.rpc.filter(call => call.method === 'turn/interrupt')).toHaveLength(0)
  expect((await api('control', action)).status).toBe(200)
  await draining
  const next = collect(f.bindings.start('project-one', spec('successor')))
  for (let attempt = 0; f.calls.length < 2 && attempt < 100; attempt++) await Bun.sleep(1)
  expect((await api('control', action)).status).toBe(409)
  expect(f.rpc.filter(call => call.method === 'turn/interrupt')).toEqual([{
    client: f.rpc.find(call => call.method === 'turn/start')!.client, method: 'turn/interrupt',
    params: { threadId: state.threadId, turnId: state.turnId }, epoch: state.epoch,
  }])
  f.finish(); await next
})

test.each(['file', 'question', 'uncertain-reply'] as const)('native %s uses a validated answer and never retries uncertain delivery', async mode => {
  const f = fixture(), api = controlSurfaces(f)
  f.hold(true)
  const draining = collect(f.bindings.start('project-one', spec('question')))
  for (let attempt = 0; f.calls.length < 1 && attempt < 100; attempt++) await Bun.sleep(1)
  f.question(mode === 'question' ? 'item/tool/requestUserInput' : 'item/fileChange/requestApproval',
    mode === 'question' ? { questions: [{ id: 'choice', question: 'Which option?' }] } : { reason: 'One file change' })
  const state = await (await api('control')).json() as NativeOwnerControlState
  const answer = mode === 'question' ? { answers: { choice: { answers: ['first'] } } } : { decision: 'decline' }
  const action = { ...state, action: 'reply', requestId: 'approval', result: answer }
  expect((await api('control', { ...action, result: { answers: { foreign: { answers: ['wrong'] } } } })).status).toBe(503)
  expect(f.replies).toHaveLength(0)
  if (mode === 'uncertain-reply') f.failReply()
  expect((await api('control', action)).status).toBe(mode === 'uncertain-reply' ? 503 : 200)
  expect(f.replies).toHaveLength(1)
  expect((await api('control', action)).status).toBe(mode === 'uncertain-reply' ? 503 : 409)
  expect(f.replies).toHaveLength(1)
  if (mode !== 'uncertain-reply') f.finish()
  const events = await draining
  expect(events.some(event => event.kind === 'error')).toBe(mode === 'uncertain-reply')
})
