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
    const identity: CodexOwnerBindingFacts & { capabilities: { multiAgentV2: boolean } } = { capabilities: { multiAgentV2: capability }, threadId: `native-${project}`, sessionId: `session-${project}`,
      cwd: options.cwd, codexHome: options.codexHome, rolloutPath: join(options.codexHome, 'rollout.jsonl'),
      paneHandle: `pane-${project}`, bindingRevision: `revision-${project}`, generation: 1, brokerGeneration: 1,
      credentialFingerprint: 'fixture', modelProvider: 'fixture', controlSocketPath: options.socketPath,
      nativeMetadata: { sessionId: `session-${project}`, source: 'vscode', originator: 'owner-bootstrap-probe' } }
    facts.set(binding, identity)
    let count = 0
    let phase: 'idle' | 'turn' = 'idle'
    let listener: ((message: Record<string, unknown>) => void) | undefined
    const owner: CodexOwnerBootstrap = { binding, writeTerminal() { throw new Error('Unexpected terminal delivery') }, async close() {},
      broker: { state: () => ({ phase, generation: 1, epoch: count, activeTurnId: phase === 'turn' ? `turn-${count}` : null, unresolved: null }),
        close() {}, gateway: () => ({ close() {}, reply() {}, subscribe(fn) { listener = fn; return () => { listener = undefined } },
          async request(method, params) {
            expect(params.threadId).toBe(identity.threadId)
            if (method === 'turn/interrupt') { phase = 'idle'; return {} }
            expect(method).toBe('turn/start')
            const prompt = (params.input as { text: string }[])[0]!.text
            calls.push({ project, thread: params.threadId as string, prompt })
            const turn = `turn-${++count}`
            phase = 'turn'
            if (count === 1) writeFileSync(identity.rolloutPath, line('session_meta', { id: identity.threadId,
              cwd: identity.cwd, source: identity.nativeMetadata.source, originator: identity.nativeMetadata.originator, session_id: identity.sessionId }))
            appendFileSync(identity.rolloutPath, line('event_msg', { type: 'task_started', turn_id: turn })
              + line('event_msg', { type: 'item_completed', thread_id: identity.threadId, turn_id: turn,
                item: { type: 'UserMessage', id: `user-${count}`, content: [{ type: 'text', text: prompt, text_elements: [] }] } }))
            if (approval) listener?.({ id: 'approval', method: 'item/tool/requestUserInput', params: { threadId: identity.threadId, turnId: turn } })
            else {
              onPrompt?.(prompt)
              appendFileSync(identity.rolloutPath, line('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: `reply-${count}` }))
              phase = 'idle'
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
    fail: () => { fail = true }, wrongReceipt: () => { wrongReceipt = true }, approval: () => { approval = true },
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

test.each(['wrongReceipt', 'approval'] as const)('%s quarantines the shared binding for chat and build', async mode => {
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
