import { afterEach, expect, spyOn, test } from 'bun:test'
import * as codexActing from '@neutronai/runtime/workers/codex-acting-turn.ts'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'
import { buildLlmCallSubstrate } from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { CodexOwnerBinding, CodexOwnerBindingFacts, CodexOwnerBootstrap } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { fakeRunner, type BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import { createProjectRunners } from '@neutronai/runtime/workers/project-runners.ts'
import { codexBuildResultTransport } from '../wiring/codex-build-result.ts'
import { restrictedOwnerFixture } from './fixtures/codex-owner-review.ts'
import { composeReplModelSurface } from '@neutronai/gateway/composition/repl-model.ts'
import { createAppNativeOwnerControlSurface } from '@neutronai/gateway/http/app-native-owner-control-surface.ts'
import type { ReplModelState } from '@neutronai/runtime/repl-model.ts'
import type { NativeOwnerControlState } from '../wiring/codex-owner-controls.ts'
import { recoverDurableOwnerRetirement } from '../wiring/codex-durable-owner.ts'
import { helperIdentity } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const spec = (prompt: string): AgentSpec => ({ prompt, tools: [], model_preference: [] })
async function collect(handle: SessionHandle) { const events = []; for await (const event of handle.events) events.push(event); return events }
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n'

test('General owner dispatch, native controls and MCP approval scope remain distinct from project general', async () => {
  const f = fixture(false, true)
  const mcpScopes: (string | null)[] = []
  f.bindings.resolveApprovedServers = async scope => { mcpScopes.push(scope); return [] }
  expect((await collect(f.chat.start(spec('General turn')))).at(-1)?.kind).toBe('completion')
  expect((await collect(f.bindings.start('general', spec('project turn')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toEqual([null, 'general'])
  expect(f.calls.map(call => call.project)).toEqual([null, 'general'])
  expect(mcpScopes).toEqual([null, 'general'])
  const generalModel = await f.bindings.controls.model(null)
  const projectModel = await f.bindings.controls.model('general')
  expect(generalModel.sessionId).not.toBe(projectModel.sessionId)
  expect((await f.bindings.controls.state(null)).projectId).toBeNull()
  expect((await f.bindings.controls.state('general')).projectId).toBe('general')
  const api = controlSurfaces(f)
  expect((await api('model', undefined, '~general')).status).toBe(200)
  const generalControl = await (await api('control', undefined, '~general')).json() as NativeOwnerControlState
  expect(generalControl.projectId).toBeNull()
  expect((await api('control', { ...generalControl, projectId: 'general', action: 'interrupt', turnId: 'foreign' }, '~general')).status).toBe(400)
  expect((await api('control', undefined, '~general', 'stranger')).status).toBe(404)
  f.authorize(false)
  expect(await collect(f.chat.start(spec('revoked')))).toContainEqual(expect.objectContaining({ kind: 'error' }))
  await expect(f.bindings.controls.model(null)).rejects.toThrow('credential')
  expect(f.calls).toHaveLength(2)
  await f.bindings.close()
})

test('General missing credential, changed account and project marker confusion refuse before native delivery', async () => {
  const missing = fixture()
  expect(await collect(missing.chat.start(spec('missing General')))).toContainEqual(expect.objectContaining({ kind: 'error' }))
  expect(missing.launched).toEqual([])
  await missing.bindings.close()
  const f = fixture(false, true)
  await collect(f.chat.start(spec('positive General')))
  f.credential('replacement-account')
  expect(await collect(f.chat.start(spec('wrong account')))).toContainEqual(expect.objectContaining({ kind: 'error' }))
  f.credential('fixture-credential')
  writeFileSync(join(f.homes.get(null)!, 'project-owner.json'), JSON.stringify('general'))
  expect(await collect(f.chat.start(spec('project marker')))).toContainEqual(expect.objectContaining({ kind: 'error' }))
  expect(f.calls).toHaveLength(1)
  expect(f.launched).toEqual([null])
  await f.bindings.close()
})

test('pre-gateway owner survives an explicit installed-MCP upgrade refusal without replacement', async () => {
  const f = fixture()
  f.bindings.resolveApprovedServers = async () => []
  expect((await collect(f.bindings.start('project-one', spec('before')))).at(-1)?.kind).toBe('completion')
  f.bindings.resolveApprovedServers = async () => [{ name: 'approved', command: 'must-not-execute', args: [], env_names: [], env: {} }]
  const refused = await collect(f.bindings.start('project-one', spec('unavailable gateway')))
  expect(refused).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('explicit upgrade') }))
  expect(f.calls).toHaveLength(1)
  f.bindings.resolveApprovedServers = async () => []
  expect((await collect(f.bindings.start('project-one', spec('after')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toEqual(['project-one'])
  await f.bindings.close()
})

function fixture(remote = false, general = false) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-binding-test-')); dirs.push(dir)
  const facts = new Map<CodexOwnerBinding, CodexOwnerBindingFacts>()
  const owners = new Map<string, CodexOwnerBootstrap>()
  const calls: { project: string | null; thread: string; prompt: string }[] = []
  const launched: (string | null)[] = []
  const rpc: { client: string; method: string; params: Record<string, unknown>; epoch: number | undefined }[] = []
  const replies: { client: string; id: string | number; result: unknown; epoch: number }[] = []
  const emitters = new Map<string | null, (method: string, params: Record<string, unknown>) => void>()
  const finishers = new Map<string | null, () => void>()
  let held = false
  let wrongModel = false
  let failReply = false
  let interruptFault: 'lost' | 'wrong-turn' | 'child' | 'unsolicited' | undefined
  const homes = new Map<string | null, string>()
  let fail = false
  let authorized = true
  let credentialIdentity = 'fixture-credential'
  let wrongReceipt = false
  let approval = false
  let capability = true
  let terminalLag = 0
  let projectGate: Promise<void> | undefined
  let openingGate: Promise<void> | undefined
  let modelGate: Promise<void> | undefined
  let onPrompt: ((prompt: string) => void) | undefined
  const resolveProject = async (projectId: string | null) => {
    await projectGate
    if (!authorized) throw new Error('No connected project credential')
    const cwd = join(dir, projectId ?? 'general-owner-fixture'), codexHome = join(cwd, 'home')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    if (projectId !== null && !existsSync(join(codexHome, 'project-owner.json'))) writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify(projectId))
    homes.set(projectId, codexHome)
    return { cwd, codexHome, credentialIdentity, env: { OPENAI_API_KEY: 'must-not-reach-native', PATH: process.env.PATH } }
  }
  const bindings = new CodexOwnerBindings(resolveProject, async options => {
    const project = options.projectId
    launched.push(project)
    await openingGate
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    if (fail) throw new Error('Existing owner needs explicit recovery')
    const binding = {} as CodexOwnerBinding
    const identity: CodexOwnerBindingFacts = { capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' }, threadId: `native-${project}`, sessionId: `session-${project}`,
      cwd: options.cwd, codexHome: options.codexHome, rolloutPath: join(options.codexHome, 'rollout.jsonl'),
      paneHandle: `pane-${project}`, bindingRevision: createHash('sha256').update(`${project}:${launched.length}`).digest('hex'), generation: 1, brokerGeneration: 1,
      credentialFingerprint: 'fixture', modelProvider: 'fixture', controlSocketPath: options.socketPath,
      nativeMetadata: { sessionId: `session-${project}`, source: 'vscode', originator: 'owner-bootstrap-probe' } }
    if (!capability) Reflect.deleteProperty(identity, 'capabilities')
    facts.set(binding, identity)
    let count = calls.filter(call => call.project === project).length
    let epoch = 0
    let model = 'small'
    let phase: 'idle' | 'turn' = 'idle'
    let completedRemotely = false
    let listener: ((message: Record<string, unknown>) => void) | undefined
    emitters.set(project, (method, params) => listener?.({ id: 'approval', method, params: { threadId: identity.threadId, turnId: `turn-${count}`, ...params } }))
    const finish = (): void => {
      appendFileSync(identity.rolloutPath, line('event_msg', { type: 'task_complete', turn_id: `turn-${count}`, last_agent_message: `reply-${count}` }))
      if (remote) completedRemotely = true
      else phase = 'idle'
    }
    finishers.set(project, finish)
    const owner: CodexOwnerBootstrap = { binding, writeTerminal() { throw new Error('Unexpected terminal delivery') }, async close() {},
      broker: { state: () => ({ phase, generation: 1, epoch, activeTurnId: phase === 'turn' ? `turn-${count}` : null, unresolved: null }),
        close() {}, gateway: client => ({ close() {}, reply(id, result, expectedEpoch) {
          if (remote) throw new Error('Remote approval requires awaited replyApproval')
          replies.push({ client, id, result, epoch: expectedEpoch }); if (failReply) throw new Error('Reply delivery unknown')
        }, subscribe(fn) { listener = fn; return () => { listener = undefined } },
          async request(method, params, expectedEpoch) {
            rpc.push({ client, method, params, epoch: expectedEpoch })
            if (method === 'model/list') return params.cursor ? { data: [{ model: 'large', displayName: 'Large' }], nextCursor: null }
              : { data: [{ model: 'small', displayName: 'Small' }], nextCursor: 'second' }
            expect(params.threadId).toBe(identity.threadId)
            if (method === 'thread/read') { await modelGate; return { thread: { ...identity, id: identity.threadId, model } } }
            if (method === 'thread/settings/update') { epoch++; if (!wrongModel) model = params.model as string; return {} }
            if (method === 'turn/interrupt') {
              if (interruptFault === 'child') appendFileSync(identity.rolloutPath, line('event_msg', {
                type: 'item_completed', thread_id: identity.threadId, turn_id: `turn-${count}`,
                item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: 'child', agent_path: '/root/child' },
              }))
              appendFileSync(identity.rolloutPath, line('event_msg', { type: 'turn_aborted',
                turn_id: interruptFault === 'wrong-turn' ? 'foreign-turn' : `turn-${count}`, reason: 'interrupted' }))
              if (remote) completedRemotely = true
              else phase = 'idle'
              if (interruptFault === 'lost') throw new Error('Interrupt acknowledgement lost')
              return {}
            }
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
    if (remote) Object.assign(owner, {
      async refreshState() { if (completedRemotely && terminalLag-- <= 0) { phase = 'idle'; completedRemotely = false }; return owner.broker.state() },
      async replyApproval(client: string, id: string | number, result: unknown, expectedEpoch: number) {
        await Bun.sleep(1)
        replies.push({ client, id, result, epoch: expectedEpoch })
        if (failReply) throw new Error('Reply delivery unknown')
      },
    })
    owners.set(options.codexHome, owner)
    return owner
  }, binding => {
    const identity = facts.get(binding)
    if (!identity) throw new Error('Unattested owner binding')
    return identity
  }, general ? () => resolveProject(null) : undefined)
  const chat = buildLlmCallSubstrate({ resolvePool: async () => null, substrate_instance_id: 'owner-test', ownerConversation: true,
    provider: 'openai-codex', startCodexOwner: (id, input) => bindings.start(id, input),
    configuredChat: { env: { NEUTRON_PROJECT_MODELS: '{"project-one":"glm"}' }, fetchImpl: (() => { throw new Error('Unexpected configured API call') }) as unknown as typeof fetch },
  })!
  return { dir, calls, launched, homes, bindings, chat,
    owner: (projectId: string | null) => owners.get(homes.get(projectId)!)!,
    factsFor: (projectId: string | null) => facts.get(owners.get(homes.get(projectId)!)!.binding)!,
    nativeTurn: async (projectId = 'project-one') => {
      const owner = owners.get(homes.get(projectId)!)!, identity = facts.get(owner.binding)!
      return owner.broker.gateway('terminal-native').request('turn/start', { threadId: identity.threadId, input: [{ text: 'terminal input' }] }, owner.broker.state().epoch)
    },
    authorize: (value: boolean) => { authorized = value },
    credential: (value: string) => { credentialIdentity = value },
    delayTerminalState: (reads: number) => { terminalLag = reads },
    gateProject: (gate: Promise<void> | undefined) => { projectGate = gate },
    gateOpening: (gate: Promise<void> | undefined) => { openingGate = gate },
    gateModel: (gate: Promise<void> | undefined) => { modelGate = gate },
    restart: () => new CodexOwnerBindings(async projectId => ({ cwd: join(dir, projectId), codexHome: homes.get(projectId)!, credentialIdentity, env: {} }),
      async options => owners.get(options.codexHome)!, binding => facts.get(binding)!),
    rpc, replies, hold: (value: boolean) => { held = value }, finish: (project = 'project-one') => finishers.get(project)!(),
    question: (method: string, params: Record<string, unknown>, project = 'project-one') => emitters.get(project)!(method, params),
    wrongModel: () => { wrongModel = true },
    failReply: () => { failReply = true },
    interruptFault: (value: typeof interruptFault) => { interruptFault = value },
    abortNative: () => {
      const owner = owners.get(homes.get('project-one')!)!, identity = facts.get(owner.binding)!
      return owner.broker.gateway('terminal-native').request('turn/interrupt', {
        threadId: identity.threadId, turnId: owner.broker.state().activeTurnId,
      }, owner.broker.state().epoch)
    },
    fail: () => { fail = true }, recoverOpening: () => { fail = false }, wrongReceipt: () => { wrongReceipt = true }, foreignApproval: () => { approval = true },
    noCapability: () => { capability = false },
    onPrompt: (fn: (prompt: string) => void) => { onPrompt = fn } }
}

test('retirement refuses an admitted conversation, then permits exact idle retirement and lazy wake', async () => {
  const f = fixture(false, true)
  expect(await f.bindings.retireScope(null)).toEqual({ status: 'absent' })
  expect(f.launched).toHaveLength(0)
  f.hold(true)
  const conversation = collect(f.bindings.start('project-one', spec('held conversation')))
  while (!f.calls.length) await Bun.sleep(1)
  let retirements = 0
  const owner = f.owner('project-one')
  owner.retire = async () => {
    retirements++
    return { status: 'retired', receipt: { version: 1,
      facts: f.factsFor('project-one'),
      terminal: { pid: 1, boot: 'fixture', start: '1' }, native: { identity: { pid: 2, boot: 'fixture', start: '2' }, code: 0, signal: null } } }
  }
  expect((await f.bindings.retireScope('project-one')).status).toBe('busy')
  expect(retirements).toBe(0)
  f.finish(); await conversation
  expect((await f.bindings.retireScope('project-one')).status).toBe('retired')
  expect(retirements).toBe(1)
  expect(f.launched).toEqual(['project-one'])
  f.hold(false)
  expect((await collect(f.bindings.start('project-one', spec('wake')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toEqual(['project-one', 'project-one'])
  await f.bindings.close()
})

test('empty frontend cache refuses durable surviving ownership and accepts positively absent scope', async () => {
  const f = fixture()
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    expect(await f.bindings.retireScope('project-one')).toEqual({ status: 'absent' })
    const identity = helperIdentity(child.pid)
    writeFileSync(join(f.homes.get('project-one')!, '.neutron-owner-launch.json'), JSON.stringify({ helper: identity }), { mode: 0o600 })
    expect(await f.bindings.retireScope('project-one')).toMatchObject({ status: 'unknown', reason: expect.stringContaining('attachment') })
    expect(helperIdentity(child.pid)).toEqual(identity)
    expect(f.launched).toHaveLength(0)
  } finally { child.kill(); await child.exited; await f.bindings.close() }
})

test('late durable retirement receipt recovers through the consuming binding after frontend loss', async () => {
  const f = fixture(true)
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    await collect(f.bindings.start('project-one', spec('before lost retirement reply')))
    const owner = f.owner('project-one'), facts = f.factsFor('project-one'), home = f.homes.get('project-one')!
    const helper = helperIdentity(child.pid)
    owner.recoverRetirement = () => recoverDurableOwnerRetirement(home, facts)
    owner.retire = async () => {
      Object.assign(owner, { async refreshState() { throw new Error('Frontend transport was lost') } })
      return { status: 'unknown', reason: 'Retirement reply lost before reservation appeared' }
    }
    expect((await f.bindings.retireScope('project-one')).status).toBe('unknown')
    expect((await f.bindings.retireScope('project-one')).status).toBe('unknown')
    writeFileSync(join(home, '.neutron-owner-authority.json'), JSON.stringify({ facts, helper }), { mode: 0o600 })
    writeFileSync(join(home, '.neutron-owner-retired.json'), JSON.stringify({ version: 1, facts, helper,
      terminal: helper, native: { identity: helper, code: null, signal: 'SIGTERM' } }), { mode: 0o600 })
    // A receipt alone cannot license release while its exact helper is alive.
    expect((await f.bindings.retireScope('project-one')).status).toBe('unknown')
    child.kill(); await child.exited
    expect((await f.bindings.retireScope('project-one')).status).toBe('retired')
    expect(f.launched).toEqual(['project-one'])
    expect((await collect(f.bindings.start('project-one', spec('after recovered retirement')))).at(-1)?.kind).toBe('completion')
    expect(f.launched).toEqual(['project-one', 'project-one'])
  } finally { child.kill(); await child.exited; await f.bindings.close() }
})

test('inaccessible successor journals remain unknown, never absent after frontend restart', async () => {
  const f = fixture()
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  let next: string | undefined
  let restarted: CodexOwnerBindings | undefined
  try {
    await collect(f.bindings.start('project-one', spec('predecessor')))
    const facts = f.factsFor('project-one'), home = f.homes.get('project-one')!, helper = helperIdentity(child.pid)
    child.kill(); await child.exited
    writeFileSync(join(home, '.neutron-owner-authority.json'), JSON.stringify({ facts, helper }), { mode: 0o600 })
    writeFileSync(join(home, '.neutron-owner-retired.json'), JSON.stringify({ version: 1, facts, helper,
      terminal: helper, native: { identity: helper, code: null, signal: 'SIGTERM' } }), { mode: 0o600 })
    next = join(home, '.neutron-owner-generations', facts.bindingRevision)
    mkdirSync(next, { recursive: true, mode: 0o700 })
    restarted = f.restart()
    expect(await restarted.retireScope('project-one')).toEqual({ status: 'absent' })
    writeFileSync(join(next, '.neutron-owner-launch.json'), '{}', { mode: 0o600 })
    chmodSync(next, 0)
    expect(await restarted.retireScope('project-one')).toMatchObject({ status: 'unknown', reason: expect.stringContaining('EACCES') })
    chmodSync(next, 0o700)
    expect(await restarted.retireScope('project-one')).toMatchObject({ status: 'unknown', reason: expect.stringContaining('attachment') })
    expect(f.launched).toEqual(['project-one'])
  } finally {
    if (next) chmodSync(next, 0o700)
    child.kill(); await child.exited; await restarted?.close(); await f.bindings.close()
  }
})

test('retirement admission fences its exact scope and re-admits after a clean busy refusal', async () => {
  const f = fixture(false, true)
  await collect(f.chat.start(spec('initial General')))
  await collect(f.bindings.start('general', spec('initial literal project')))
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.owner(null).retire = async () => { entered(); await gate; return { status: 'busy', reason: 'native work arrived' } }
  const retiring = f.bindings.retireScope(null)
  await started
  expect(await collect(f.chat.start(spec('fenced General')))).toContainEqual(expect.objectContaining({ kind: 'error' }))
  expect((await collect(f.bindings.start('general', spec('unrelated project stays usable')))).at(-1)?.kind).toBe('completion')
  expect(f.calls.filter(call => call.project === null)).toHaveLength(1)
  release()
  expect((await retiring).status).toBe('busy')
  expect((await collect(f.chat.start(spec('General resumes after refusal')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toEqual([null, 'general'])
  await f.bindings.close()
})

async function consumingBuild(f: ReturnType<typeof fixture>, options: { cwd?: string; roots?: string[]; wall?: number; transport?: boolean } = {}) {
  const cwd = join(f.dir, 'project-one')
  mkdirSync(cwd, { recursive: true })
  const state = options.transport ? join(f.dir, 'owner-home', '.trident', 'project-builds', 'run') : cwd
  mkdirSync(state, { recursive: true })
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'preflight', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: join(state, options.transport ? 'build.result' : 'result.json'), schema: 'fixture' }, thread: null, budget: { wall_ms: options.wall ?? 1000 }, needs_approval_decision: false }
  const trailer = { schemas: new Map([['fixture', (value: unknown) => !!value && typeof value === 'object' && 'answer' in value && typeof value.answer === 'string']]), metadata: () => undefined }
  const runners = await createProjectRunners({ conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
    run_id: 'run', state_dir: state, actingTurn: f.bindings.actingTurn('project-one', 'topic', options.cwd ?? cwd, options.roots ?? [cwd]),
    ...(options.transport ? { codexResultTransport: codexBuildResultTransport({ projectId: 'project-one', projectDir: cwd, stateDir: state, runId: 'run', trailer }) } : {}),
    trailer, headless: {} })
  return { request, rawWorker: runners.inRepl!, worker: f.bindings.guardBuildRunner('project-one', runners.inRepl!) }
}

test('cached owner rechecks credential authorization and account identity before chat, controls and build recovery', async () => {
  const f = fixture()
  await collect(f.bindings.start('project-one', spec('initial')))
  const calls = f.calls.length
  f.authorize(false)
  expect(await collect(f.bindings.start('project-one', spec('revoked')))).toContainEqual(expect.objectContaining({
    kind: 'error', message: expect.stringContaining('No connected project credential'),
  }))
  await expect(f.bindings.controls.model('project-one')).rejects.toThrow('No connected project credential')
  f.authorize(true)
  f.credential('different-account')
  expect(await collect(f.bindings.start('project-one', spec('foreign account')))).toContainEqual(expect.objectContaining({
    kind: 'error', message: expect.stringContaining('credential identity changed'),
  }))
  const build = await consumingBuild(f)
  expect(await build.worker.run(build.request, 'in-repl', new AbortController().signal)).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('credential identity changed') })
  expect(f.calls).toHaveLength(calls)
  expect(f.launched).toEqual(['project-one'])
  f.credential('fixture-credential')
  expect((await collect(f.bindings.start('project-one', spec('restored original account')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toEqual(['project-one'])
  await f.bindings.close()
})

test('recovery passes owner credential, cancellation, and durable uncertainty fences without invoking run', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('warm owner')))
  const { request } = await consumingBuild(f)
  let recoveries = 0
  const raw = fakeRunner('openai-codex')
  const worker = f.bindings.guardBuildRunner('project-one', { ...raw, recover: async () => {
    recoveries++; return { kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null }
  } })
  f.authorize(false)
  expect((await worker.recover!(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(recoveries).toBe(0)
  f.authorize(true)
  expect((await worker.recover!(request, 'in-repl', AbortSignal.abort())).kind).toBe('unknown')
  expect(recoveries).toBe(0)
  expect((await worker.recover!(request, 'in-repl', new AbortController().signal)).kind).toBe('completed')
  expect(recoveries).toBe(1); expect(raw.calls).toHaveLength(0); expect(f.calls).toHaveLength(1)
  expect((await f.bindings.guardBuildRunner('project-one', raw).recover!(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(raw.calls).toHaveLength(0)
  writeFileSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'), '{}')
  expect((await worker.recover!(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(recoveries).toBe(1); expect(raw.calls).toHaveLength(0)
  await f.bindings.close()
})

test('recovery shares the restricted review queue with run and subsequent recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-recovery-queue-')); dirs.push(dir)
  const native = await restrictedOwnerFixture({ projectId: 'review-project', cwd: dir, execute: async () => {} })
  try {
    await native.bindings.prepareReview('review-project')
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const calls: string[] = []
    const completed = { kind: 'completed', result: {}, usage: null, model_reported: null, thread_id: null } as const
    const worker = native.bindings.guardBuildRunner('review-project', { ...fakeRunner('openai-codex'),
      run: async () => { calls.push('run'); entered(); await gate; return completed },
      recover: async req => { calls.push(req.step_id); return completed },
    })
    const request: BoundedWorkRequest = { run_id: 'run', step_id: 'review:0', role: 'review', model_id: 'gpt-test', effort: null,
      cwd: dir, writable: false, network: false, tools: 'read-only', brief: { path: join(dir, 'brief'), integrity: 'fixture' },
      result: { path: join(dir, 'result'), schema: 'fixture' }, thread: null, budget: { wall_ms: 2000 }, needs_approval_decision: false }
    const first = worker.run(request, 'in-repl', new AbortController().signal)
    await started
    const second = worker.recover!({ ...request, step_id: 'review:1' }, 'in-repl', new AbortController().signal)
    const third = worker.recover!({ ...request, step_id: 'review:2', role: 'synthesis' }, 'in-repl', new AbortController().signal)
    await Bun.sleep(10)
    expect(calls).toEqual(['run'])
    release()
    expect((await Promise.all([first, second, third])).map(result => result.kind)).toEqual(['completed', 'completed', 'completed'])
    expect(calls).toEqual(['run', 'review:1', 'review:2']); expect(native.children).toHaveLength(0)
  } finally { await native.close() }
})

test.each([false, true])('real owner consumer publishes child result before accepting outcome (transfer failure %s)', async failTransfer => {
  const f = fixture(true)
  const { request, worker, rawWorker } = await consumingBuild(f, { transport: true })
  let childPath = ''
  f.onPrompt(prompt => {
    const dispatch = JSON.parse(prompt.slice('Execute the prompt in this JSON dispatch specification: '.length))
    const args = JSON.parse(dispatch.prompt.slice(dispatch.prompt.indexOf('\n') + 1))
    const child = JSON.parse(args.message.split('\n').find((line: string) => line.startsWith('Request (data): ')).slice('Request (data): '.length))
    childPath = child.result.path
    expect(childPath.startsWith(join(f.dir, 'project-one', '.neutron'))).toBe(true)
    writeFileSync(childPath, JSON.stringify({ schema: 'fixture', run_id: request.run_id, step_id: request.step_id, kind: 'completed', result: { answer: 'native child' } }))
    if (failTransfer) mkdirSync(request.result.path)
  })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe(failTransfer ? 'unknown' : 'completed')
  expect(childPath).not.toBe(request.result.path)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(failTransfer)
  if (failTransfer) {
    rmSync(request.result.path, { recursive: true })
    expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
    expect(existsSync(request.result.path)).toBe(false)
    const replacement = f.restart()
    const guarded = replacement.guardBuildRunner('project-one', rawWorker)
    expect((await guarded.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
    expect(existsSync(request.result.path)).toBe(false)
    expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(true)
    await replacement.close()
  }
  f.onPrompt(() => {})
  expect((await collect(f.bindings.start('project-one', spec('chat after transfer')))).at(-1)?.kind).toBe(failTransfer ? 'error' : 'completion')
  const restarted = f.restart()
  if (!failTransfer) {
    writeFileSync(join(f.homes.get('project-one')!, '.neutron-owner-launch.json'), '{}')
    expect((await restarted.guardBuildRunner('project-one', rawWorker).run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  }
  expect((await collect(restarted.start('project-one', spec('restart after transfer')))).at(-1)?.kind).toBe(failTransfer ? 'error' : 'completion')
  if (!failTransfer) expect((await restarted.guardBuildRunner('project-one', rawWorker).run(request, 'in-repl', new AbortController().signal)).kind).toBe('completed')
  expect(f.calls).toHaveLength(failTransfer ? 1 : 3)
  await restarted.close()
})

test('build admission during a known active owner chat does not fence that live conversation', async () => {
  const f = fixture(true)
  f.hold(true)
  const chatting = collect(f.bindings.start('project-one', spec('live chat')))
  while (f.calls.length === 0) await Bun.sleep(1)
  const { request, worker } = await consumingBuild(f, { transport: true })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
  f.hold(false); f.finish()
  expect((await chatting).at(-1)?.kind).toBe('completion')
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  expect((await collect(f.bindings.start('project-one', spec('chat after concurrent admission')))).at(-1)?.kind).toBe('completion')
  expect(f.calls).toHaveLength(2)
})

test('marker-free warm TUI activity refuses build without poisoning the next owner chat', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('warm owner')))
  f.hold(true); await f.nativeTurn()
  const { request, worker } = await consumingBuild(f, { transport: true })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(2)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  f.hold(false); f.finish()
  expect((await collect(f.bindings.start('project-one', spec('chat after terminal')))).at(-1)?.kind).toBe('completion')
  expect(f.calls).toHaveLength(3)
})

test.each(['valid', 'busy', 'unknown-prepare', 'restore-lost', 'ack-lost', 'cold', 'corrupt', 'foreign', 'foreign-stage'] as const)('private helper restricts review, waits and restores before next chat: %s', async fault => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-review-consumer-')); dirs.push(dir)
  const cwd = join(dir, 'project'), state = join(dir, 'home', 'run')
  mkdirSync(cwd); mkdirSync(state, { recursive: true })
  const native = await restrictedOwnerFixture({ projectId: 'review-project', cwd, childSettlesAfterMs: 80,
    ...(fault === 'busy' ? { busyPrepare: true } : {}), ...(fault === 'unknown-prepare' ? { drop: 'reviewPrepare' } : {}),
    ...(fault === 'restore-lost' ? { drop: 'reviewRestore' } : {}), ...(fault === 'ack-lost' ? { drop: 'reviewAcknowledge' } : {}), async execute(prompt) {
    const spec = JSON.parse(prompt.slice('Execute the prompt in this JSON dispatch specification: '.length))
    const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
    const child = JSON.parse(args.message.split('\n').find((line: string) => line.startsWith('Request (data): ')).slice('Request (data): '.length))
    writeFileSync(child.result.path, JSON.stringify({ run_id: child.run_id, step_id: child.step_id, schema: child.result.schema, kind: 'completed', result: { answer: 'reviewed' } }))
  }, ...(fault === 'cold' ? { coldRollout: true } : {}), ...(fault === 'corrupt' ? { corruptRollout: true } : {}), ...(fault === 'foreign' ? { foreignRollout: true } : {}) })
  try {
    await native.bindings.prepareReview('review-project')
    const trailer = { schemas: new Map([['fixture', (value: unknown) => !!value && typeof value === 'object' && 'answer' in value && typeof value.answer === 'string']]), metadata: () => undefined }
    const request: BoundedWorkRequest = { run_id: 'run', step_id: 'review-one', role: 'review', model_id: 'gpt-5.5', effort: null,
      cwd, writable: false, network: false, tools: 'read-only', brief: { path: join(state, 'review.brief'), integrity: 'fixture' },
      result: { path: join(state, 'review.result'), schema: 'fixture' }, thread: null, budget: { wall_ms: 2000 }, needs_approval_decision: false }
    const acting = native.bindings.actingTurn('review-project', 'topic', cwd, [cwd])
    const foreignStage = join(cwd, '.neutron', 'build-results', 'f'.repeat(64))
    if (fault === 'foreign-stage') mkdirSync(foreignStage, { recursive: true })
    const runners = await createProjectRunners({ conversation: { project_id: 'review-project', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
      run_id: 'run', state_dir: state, trailer, headless: {}, actingTurn: turn => acting(fault === 'foreign-stage'
        ? { ...turn, request: { ...turn.request, result: { ...turn.request.result, path: join(foreignStage, 'result.json') } } } : turn),
      codexResultTransport: codexBuildResultTransport({ projectId: 'review-project', projectDir: cwd, stateDir: state, runId: 'run', trailer }) })
    const worker = native.bindings.guardBuildRunner('review-project', runners.inRepl!)
    if (fault !== 'valid') {
      expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe(['cold', 'foreign-stage'].includes(fault) ? 'refused' : 'unknown')
      expect(native.children).toHaveLength(fault === 'restore-lost' || fault === 'ack-lost' ? 1 : 0)
      expect(existsSync(join(native.codexHome, '.neutron-owner-work.json'))).toBe(!['busy', 'cold', 'foreign-stage'].includes(fault))
      await Bun.sleep(20)
      expect((await collect(native.bindings.start('review-project', spec('chat after admission race')))).at(-1)?.kind)
        .toBe(['busy', 'cold', 'foreign-stage'].includes(fault) ? 'completion' : 'error')
      if (fault === 'busy' || fault === 'cold') expect((await worker.run({ ...request, step_id: fault === 'cold' ? request.step_id : 'review-after-busy' }, 'in-repl', new AbortController().signal)).kind).toBe('completed')
      expect(native.opens()).toBe(1)
      return
    }
    const results = await Promise.all([worker.run(request, 'in-repl', new AbortController().signal),
      worker.run({ ...request, step_id: 'review-two' }, 'in-repl', new AbortController().signal)])
    expect(results.map(result => result.kind)).toEqual(['completed', 'completed'])
    expect(native.errors).toEqual([])
    expect(native.children).toHaveLength(2)
    expect(native.wire.filter(message => String(message.operation).startsWith('review')).map(message => message.operation)).toEqual([
      'reviewPrepare', 'reviewStart', 'reviewWaitSettled', 'reviewRestore', 'reviewAcknowledge', 'reviewRelease',
      'reviewPrepare', 'reviewStart', 'reviewWaitSettled', 'reviewRestore', 'reviewAcknowledge', 'reviewRelease',
    ])
    expect(existsSync(join(native.codexHome, '.neutron-owner-work.json'))).toBe(false)
    expect((await collect(native.bindings.start('review-project', spec('next chat')))).at(-1)?.kind).toBe('completion')
    expect(native.opens()).toBe(1)
  } finally { await native.close() }
})

test.each(['review', 'synthesis'] as const)('unattested Codex %s isolation refuses admission and direct dispatch without opening an owner', async role => {
  const f = fixture(true)
  const { request, worker } = await consumingBuild(f, { transport: true })
  const readonly = { ...request, role, writable: false, tools: 'read-only' as const }
  expect(worker.supports(role, 'in-repl')).toMatchObject({ ok: false, reason: 'capability-unsupported' })
  expect((await worker.run(readonly, 'in-repl', new AbortController().signal)).kind).toBe('refused')
  expect((await f.bindings.actingTurn('project-one', 'topic', request.cwd, [request.cwd])({
    conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
    request: readonly, spec: spec('must not dispatch'), timeout_ms: 1000, signal: new AbortController().signal,
  })).kind).toBe('refused')
  expect(f.launched).toHaveLength(0); expect(f.calls).toHaveLength(0)
  expect((await collect(f.bindings.start('project-one', spec('ordinary owner chat')))).at(-1)?.kind).toBe('completion')
})

test('missing-credential consuming build can connect then chat without gateway restart', async () => {
  const f = fixture(true)
  f.authorize(false)
  const { request, worker } = await consumingBuild(f)
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.launched).toHaveLength(0); expect(f.calls).toHaveLength(0)
  f.authorize(true)
  expect((await collect(f.bindings.start('project-one', spec('connected after build preflight')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toHaveLength(1)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
})

test.each(['cwd', 'roots'] as const)('cold owner rejects consuming wrong %s before opening and permits correct chat', async field => {
  const f = fixture(true)
  const { request, worker } = await consumingBuild(f, field === 'cwd' ? { cwd: f.dir } : { roots: [f.dir] })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.launched).toHaveLength(0); expect(f.calls).toHaveLength(0)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  expect((await collect(f.bindings.start('project-one', spec('correct first owner chat')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toHaveLength(1); expect(f.calls).toHaveLength(1)
})

test.each(['cwd', 'roots'] as const)('known idle owner survives consuming wrong %s preflight without a work marker', async field => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('warm owner')))
  const { request, worker } = await consumingBuild(f, field === 'cwd' ? { cwd: f.dir } : { roots: [f.dir] })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  expect((await collect(f.bindings.start('project-one', spec('correct owner chat')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toHaveLength(1)
})

test('uncertain consuming build opening stays fenced even after the opener becomes healthy', async () => {
  const f = fixture(true); f.fail()
  const { request, worker } = await consumingBuild(f)
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.launched).toHaveLength(1); expect(f.calls).toHaveLength(0)
  f.recoverOpening()
  expect((await collect(f.bindings.start('project-one', spec('must not reopen')))).at(-1)).toMatchObject({ kind: 'error', message: 'Codex owner requires native reconciliation' })
  expect(f.launched).toHaveLength(1)
})

test('uncertain consuming build native submission stays fenced across chat and restart', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('warm owner')))
  f.wrongReceipt()
  const { request, worker } = await consumingBuild(f)
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(2)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(true)
  expect((await collect(f.bindings.start('project-one', spec('must not reuse')))).at(-1)?.kind).toBe('error')
  const restarted = f.restart()
  expect((await collect(restarted.start('project-one', spec('must not replay')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(2)
  await restarted.close()
})

test('a resolver finishing after consuming worker timeout cannot open an owner later', async () => {
  const f = fixture(true)
  let release!: () => void
  f.gateProject(new Promise<void>(resolve => { release = resolve }))
  const { request, worker } = await consumingBuild(f, { wall: 25 })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.launched).toHaveLength(0)
  release(); f.gateProject(undefined)
  await Bun.sleep(5)
  expect(f.launched).toHaveLength(0)
  expect((await collect(f.bindings.start('project-one', spec('new legitimate chat')))).at(-1)).toMatchObject({ kind: 'completion' })
  expect(f.launched).toHaveLength(1)
})

test('an opening already attempted before consuming timeout stays fenced after it returns', async () => {
  const f = fixture(true)
  let release!: () => void
  f.gateOpening(new Promise<void>(resolve => { release = resolve }))
  const { request, worker } = await consumingBuild(f, { wall: 25 })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.launched).toHaveLength(1); expect(f.calls).toHaveLength(0)
  release(); f.gateOpening(undefined)
  await Bun.sleep(10)
  expect((await collect(f.bindings.start('project-one', spec('must not renew after opening')))).at(-1)).toMatchObject({ kind: 'error', message: 'Codex owner requires native reconciliation' })
  expect(f.launched).toHaveLength(1); expect(f.calls).toHaveLength(0)
})

test('a native model read finishing after consuming timeout cannot deliver a late turn', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('warm owner')))
  let release!: () => void
  f.gateModel(new Promise<void>(resolve => { release = resolve }))
  const { request, worker } = await consumingBuild(f, { wall: 25 })
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
  release(); f.gateModel(undefined)
  await Bun.sleep(10)
  expect(f.calls).toHaveLength(1)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  expect((await collect(f.bindings.start('project-one', spec('new legitimate chat')))).at(-1)).toMatchObject({ kind: 'completion' })
  expect(f.launched).toHaveLength(1)
})

test.each(['signal', 'budget'] as const)('native build consumes the bridge %s and interrupts only its submitted parent', async cause => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('warm owner')))
  f.hold(true)
  const stop = new AbortController()
  const original = codexActing.createCodexActingTurn
  const bridge = spyOn(codexActing, 'createCodexActingTurn').mockImplementation(binding => original({ ...binding,
    session: { ...binding.session!, submitLine: (prompt, dispatch) => binding.session!.submitLine(prompt, {
      signal: cause === 'signal' ? stop.signal : dispatch.signal,
      timeout_ms: cause === 'budget' ? 35 : dispatch.timeout_ms,
    }) },
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  if (cause === 'signal') f.onPrompt(() => { timer = setTimeout(() => stop.abort(), 35) })
  try {
    const { request, worker } = await consumingBuild(f, { wall: 1500 })
    expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe('unknown')
    expect(f.rpc.filter(call => call.method === 'turn/interrupt').map(call => call.params)).toEqual([
      { threadId: 'native-project-one', turnId: 'turn-2' },
    ])
    expect(f.calls).toHaveLength(2)
    expect((await collect(f.bindings.start('project-one', spec('must not reuse uncertain build')))).at(-1)?.kind).toBe('error')
    expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(true)
    expect(f.launched).toEqual(['project-one'])
  } finally { clearTimeout(timer); bridge.mockRestore(); await f.bindings.close() }
})

test('zero managed delivery does not renew a host view when a foreign native turn became active', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('warm owner')))
  let release!: () => void
  f.gateModel(new Promise<void>(resolve => { release = resolve }))
  const reads = f.rpc.filter(call => call.method === 'thread/read').length
  const { request, worker } = await consumingBuild(f, { wall: 60 })
  const pending = worker.run(request, 'in-repl', new AbortController().signal)
  while (f.rpc.filter(call => call.method === 'thread/read').length === reads) await Bun.sleep(1)
  f.hold(true)
  await f.nativeTurn()
  expect((await pending).kind).toBe('unknown')
  release(); f.gateModel(undefined)
  await Bun.sleep(10)
  expect(f.calls).toHaveLength(2)
  expect((await collect(f.bindings.start('project-one', spec('must not replace native turn')))).at(-1)?.kind).toBe('error')
  f.finish(); f.hold(false)
  expect((await f.bindings.controls.state('project-one')).status).toBe('idle')
  expect((await collect(f.bindings.start('project-one', spec('must not renew refused view')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(2); expect(f.launched).toHaveLength(1)
})

test('actual successful native delivery retains its stable conversation host view', async () => {
  const f = fixture(true)
  const views = Reflect.get(f.bindings, 'conversationHosts') as Map<string, unknown>
  expect((await collect(f.bindings.start('project-one', spec('one')))).at(-1)?.kind).toBe('completion')
  const before = views.get('project-one')
  expect(before).toBeDefined()
  expect((await collect(f.bindings.start('project-one', spec('two')))).at(-1)?.kind).toBe('completion')
  expect(views.get('project-one')).toBe(before)
  expect(f.calls.map(call => call.thread)).toEqual(['native-project-one', 'native-project-one'])
  expect(f.launched).toHaveLength(1)
})

test('cold boot without credentials does not fence a later connected native owner', async () => {
  const f = fixture(true)
  f.authorize(false)
  await f.bindings.reconcile(['project-one'])
  expect((await collect(f.bindings.start('project-one', spec('before credentials connect')))).at(-1)?.kind).toBe('error')
  expect(f.launched).toHaveLength(0)
  f.authorize(true)
  expect((await collect(f.bindings.start('project-one', spec('first authorized turn')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toEqual(['project-one'])
})

test('an actual uncertain owner journal at boot stays fenced before any later launch', async () => {
  const f = fixture(true)
  const home = join(f.dir, 'project-one', 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, '.neutron-owner-launch.json'), '{}', { mode: 0o600 })
  f.fail()
  await f.bindings.reconcile(['project-one'])
  expect(f.launched).toHaveLength(1)
  expect((await collect(f.bindings.start('project-one', spec('must refuse')))).at(-1)?.kind).toBe('error')
  expect(f.launched).toHaveLength(1)
  expect(f.calls).toHaveLength(0)
})

test('remote completion refreshes terminal state before releasing and clearing the durable work marker', async () => {
  const f = fixture(true)
  f.delayTerminalState(2)
  for (const prompt of ['one', 'two']) {
    expect((await collect(f.bindings.start('project-one', spec(prompt)))).at(-1)?.kind).toBe('completion')
    expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  }
  expect(f.launched).toEqual(['project-one'])
  await f.bindings.close()
})

test('remote owner approval awaits the retained helper writer rather than the synchronous gateway shim', async () => {
  const f = fixture(true)
  f.hold(true)
  const events = collect(f.bindings.start('project-one', spec('approval')))
  while (!f.calls.length) await Bun.sleep(1)
  f.question('item/commandExecution/requestApproval', { availableDecisions: ['accept'] })
  const before = await f.bindings.controls.state('project-one')
  expect(before.pending).toHaveLength(1)
  await f.bindings.controls.act('project-one', { ...before, turnId: before.turnId!, action: 'reply', requestId: 'approval', result: { decision: 'accept' } })
  expect(f.replies).toHaveLength(1)
  expect(f.replies[0]?.client).toBe(f.rpc.find(call => call.method === 'turn/start')?.client)
  await expect(f.bindings.controls.act('project-one', { ...before, turnId: before.turnId!, action: 'reply', requestId: 'approval', result: { decision: 'accept' } })).rejects.toThrow()
  f.finish()
  expect((await events).at(-1)?.kind).toBe('completion')
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  await f.bindings.close()
})

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
  const outcome = await f.bindings.actingTurn('project-one', 'topic', join(f.dir, 'project-one'), [])({ timeout_ms: 1000, request: { budget: { wall_ms: 1000 } }, signal: new AbortController().signal } as Parameters<ReturnType<CodexOwnerBindings['actingTurn']>>[0])
  expect(outcome).toEqual({ kind: 'refused', reason: 'capability-unsupported', detail: 'Codex owner lacks attested native subagent capability' })
  expect((await collect(f.bindings.start('project-one', spec('again')))).at(-1)?.kind).toBe('completion')
  expect(f.calls).toHaveLength(2); expect(f.launched).toHaveLength(1)
})

test.each([false, true])('missing child trailer fences later chat even when native parent completed (failed tag %s)', async failedTag => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('hello')))
  const cwd = join(f.dir, 'project-one')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'missing', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: join(cwd, 'missing.json'), schema: 'fixture' }, thread: null, budget: { wall_ms: 30 }, needs_approval_decision: false }
  const runners = await createProjectRunners({ conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
    run_id: 'run', state_dir: cwd, actingTurn: f.bindings.actingTurn('project-one', 'topic', cwd, [cwd]),
    trailer: { schemas: new Map([['fixture', () => true]]), metadata: () => undefined }, headless: {} })
  const runner = runners.inRepl!
  const worker = f.bindings.guardBuildRunner('project-one', failedTag ? { ...runner, async run(...args) {
    expect((await runner.run(...args)).kind).toBe('unknown')
    return { kind: 'failed', class: 'timeout', detail: 'Timeout classification is not native terminal evidence' }
  } } : runner)
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe(failedTag ? 'failed' : 'unknown')
  expect(f.calls).toHaveLength(2)
  expect((await collect(f.bindings.start('project-one', spec('must not dispatch')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(2)
  await f.bindings.close()
  const restarted = f.restart()
  expect((await collect(restarted.start('project-one', spec('must not replay after restart')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(2)
  await restarted.close()
})

test.each(['valid', 'invalid-payload', 'malformed-envelope', 'settled-infra', 'settled-timeout', 'settled-killed'] as const)('host-decoded child %s controls later chat and distinct-step dispatch', async result => {
  const settledFailure = result.startsWith('settled-')
  const valid = result === 'valid' || settledFailure
  const f = fixture(true)
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
  const runner = runners.inRepl!
  const worker = f.bindings.guardBuildRunner('project-one', settledFailure ? { ...runner, async run(...args) {
    const completed = await runner.run(...args)
    expect(completed.kind).toBe('completed')
    return { kind: 'failed', class: result.slice('settled-'.length) as 'infra' | 'timeout' | 'killed', detail: 'Host failure after verified terminal child' }
  } } : runner)
  expect((await worker.run(request, 'in-repl', new AbortController().signal)).kind).toBe(settledFailure ? 'failed' : valid ? 'completed' : 'unknown')
  expect(f.calls).toHaveLength(2)
  expect((await collect(f.bindings.start('project-one', spec('after payload')))).at(-1)?.kind).toBe(valid ? 'completion' : 'error')
  expect(f.calls).toHaveLength(valid ? 3 : 2)
  if (!valid) {
    expect((await worker.run({ ...request, step_id: 'second', result: { ...request.result, path: join(cwd, 'second.json') } }, 'in-repl', new AbortController().signal)).kind).not.toBe('completed')
    expect(f.calls).toHaveLength(2)
  }
  await f.bindings.close()
  const restarted = f.restart()
  expect((await collect(restarted.start('project-one', spec('after gateway restart')))).at(-1)?.kind).toBe(valid ? 'completion' : 'error')
  expect(f.calls).toHaveLength(valid ? 4 : 2)
  expect(f.launched).toHaveLength(1)
  await restarted.close()
})

test('pre-aborted consuming build never dispatches or fences the live owner, including after restart', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('hello')))
  const cwd = join(f.dir, 'project-one')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'pre-aborted', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: join(cwd, 'result.json'), schema: 'fixture' }, thread: null, budget: { wall_ms: 2000 }, needs_approval_decision: false }
  const runners = await createProjectRunners({ conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
    run_id: 'run', state_dir: cwd, actingTurn: f.bindings.actingTurn('project-one', 'topic', cwd, [cwd]),
    trailer: { schemas: new Map([['fixture', () => true]]), metadata: () => undefined }, headless: {} })
  const worker = f.bindings.guardBuildRunner('project-one', runners.inRepl!)
  expect((await worker.run(request, 'in-repl', AbortSignal.abort())).kind).toBe('unknown')
  expect(f.calls).toHaveLength(1)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  expect((await collect(f.bindings.start('project-one', spec('still usable')))).at(-1)?.kind).toBe('completion')
  await f.bindings.close()
  const restarted = f.restart()
  expect((await collect(restarted.start('project-one', spec('usable after restart')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toHaveLength(1)
  await restarted.close()
})

test('chat cannot interleave while a completed native parent awaits its child result', async () => {
  const f = fixture(true)
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
  // Wait for the actual parent lease release, not merely its dispatch receipt.
  while ((await f.bindings.controls.state('project-one')).status !== 'idle') await Bun.sleep(1)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(true)
  const restartWhileChildPending = f.restart()
  expect((await collect(restartWhileChildPending.start('project-one', spec('must not replay pending child')))).at(-1)?.kind).toBe('error')
  await restartWhileChildPending.close()
  expect((await collect(f.bindings.start('project-one', spec('must wait')))).at(-1)).toMatchObject({ kind: 'error', message: 'Codex owner build result is still pending' })
  expect(f.calls).toHaveLength(2)
  writeFileSync(request.result.path, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'pending', kind: 'completed', result: {} }))
  expect(await pending).toEqual({ kind: 'turn-ended' })
  expect((await collect(f.bindings.start('project-one', spec('now ready')))).at(-1)?.kind).toBe('completion')
  const after = f.restart()
  expect((await collect(after.start('project-one', spec('restart after completed child')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toHaveLength(1)
  await after.close()
})

test('remote outer decoder pending keeps the durable marker after native parent and child finish', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('hello')))
  const cwd = join(f.dir, 'project-one')
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'pending-decoder', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: join(cwd, 'result.json'), schema: 'fixture' }, thread: null, budget: { wall_ms: 2000 }, needs_approval_decision: false }
  f.onPrompt(() => writeFileSync(request.result.path, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: request.step_id, kind: 'completed', result: { accepted: true } })))
  const runners = await createProjectRunners({ conversation: { project_id: 'project-one', topic_id: 'topic', provider: 'openai-codex', spec: spec('') },
    run_id: 'run', state_dir: cwd, actingTurn: f.bindings.actingTurn('project-one', 'topic', cwd, [cwd]),
    trailer: { schemas: new Map([['fixture', () => true]]), metadata: () => undefined }, headless: {} })
  let release!: () => void, decoding = false
  const barrier = new Promise<void>(resolve => { release = resolve })
  const worker = f.bindings.guardBuildRunner('project-one', { ...runners.inRepl!, async run(...args) {
    const outcome = await runners.inRepl!.run(...args)
    decoding = true
    await barrier
    return outcome
  } })
  const result = worker.run(request, 'in-repl', new AbortController().signal)
  while (!decoding) await Bun.sleep(1)
  expect((await f.bindings.controls.state('project-one')).status).toBe('idle')
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(true)
  const restarted = f.restart()
  expect((await collect(restarted.start('project-one', spec('must not replay before host acceptance')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(2)
  release()
  expect((await result).kind).toBe('completed')
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  const after = f.restart()
  expect((await collect(after.start('project-one', spec('host accepted')))).at(-1)?.kind).toBe('completion')
  expect(f.launched).toHaveLength(1)
  await restarted.close(); await after.close(); await f.bindings.close()
})

test('marker-free native terminal turn still refuses restart adoption while active', async () => {
  const f = fixture(true)
  await collect(f.bindings.start('project-one', spec('hello')))
  f.hold(true)
  await f.nativeTurn()
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  const restarted = f.restart()
  expect((await collect(restarted.start('project-one', spec('must not interrupt terminal')))).at(-1)).toMatchObject({ kind: 'error', message: 'Codex surviving turn requires native reconciliation' })
  expect(f.calls).toHaveLength(2)
  await restarted.close(); await f.bindings.close()
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
  const bindings = new CodexOwnerBindings(async () => ({ cwd: dir, codexHome: dir, credentialIdentity: 'fixture', env: {} }), async () => {
    launches++; return { binding: {}, async close() {} } as CodexOwnerBootstrap
  })
  expect((await collect(bindings.start('project-one', spec('hello')))).at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('another project') })
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
    canAccess: async (user, owner, id) => user === 'owner' && owner === 'instance' && (id === null || ['project-one', 'project-two'].includes(id)),
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

test.each(['busy', 'native-refusal', 'lost'] as const)('model switch through helper distinguishes zero-reservation admission from native uncertainty: %s', async modelFault => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-model-race-')); dirs.push(dir)
  const native = await restrictedOwnerFixture({ projectId: 'model-project', cwd: dir, modelFault, async execute() {} })
  try {
    expect((await collect(native.bindings.start('model-project', spec('warm chat')))).at(-1)?.kind).toBe('completion')
    const current = await native.bindings.controls.model('model-project')
    await expect(native.bindings.controls.model('model-project', { sessionId: current.sessionId, model: 'large' })).rejects.toThrow()
    await Bun.sleep(20)
    expect(existsSync(join(native.codexHome, '.neutron-owner-work.json'))).toBe(modelFault !== 'busy')
    expect(native.native.filter(message => message.method === 'thread/settings/update' && (message.params as Record<string, unknown>).model === 'large'))
      .toHaveLength(modelFault === 'busy' ? 0 : 1)
    expect((await collect(native.bindings.start('model-project', spec('next valid chat')))).at(-1)?.kind).toBe(modelFault === 'busy' ? 'completion' : 'error')
    expect(native.opens()).toBe(1)
  } finally { await native.close() }
})

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
  const conversation = state.conversationId
  expect((await api('model', { model: 'invented', sessionId: old })).status).toBe(400)
  expect(f.rpc.filter(call => call.method === 'thread/settings/update')).toHaveLength(0)
  const up = await api('model', { model: 'large', sessionId: old })
  expect(up.status).toBe(200); state = await up.json() as ReplModelState
  expect(state.currentModel).toBe('large'); expect(state.sessionId).not.toBe(old)
  expect(state.conversationId).toBe(conversation)
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

test.each([false, true])('native interrupt preserves successor chat and model controls (remote %s)', async remote => {
  const f = fixture(remote), api = controlSurfaces(f)
  if (remote) f.delayTerminalState(2)
  f.hold(true)
  const draining = collect(f.bindings.start('project-one', spec('hold')))
  for (let attempt = 0; f.calls.length < 1 && attempt < 100; attempt++) await Bun.sleep(1)
  const state = await (await api('control')).json() as NativeOwnerControlState
  const action = { ...state, action: 'interrupt' }
  expect((await api('control', { ...action, turnId: 'other' })).status).toBe(409)
  expect(f.rpc.filter(call => call.method === 'turn/interrupt')).toHaveLength(0)
  expect((await api('control', action)).status).toBe(200)
  const interrupted = await draining
  expect(interrupted.at(-1)).toMatchObject({ kind: 'error', code: 'aborted' })
  expect(interrupted.some(event => event.kind === 'completion')).toBe(false)
  expect((await api('model')).status).toBe(200)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(false)
  const next = collect(f.bindings.start('project-one', spec('successor')))
  for (let attempt = 0; f.calls.length < 2 && attempt < 100; attempt++) await Bun.sleep(1)
  expect((await api('control', action)).status).toBe(409)
  expect(f.rpc.filter(call => call.method === 'turn/interrupt')).toEqual([{
    client: f.rpc.find(call => call.method === 'turn/start')!.client, method: 'turn/interrupt',
    params: { threadId: state.threadId, turnId: state.turnId }, epoch: state.epoch,
  }])
  f.finish(); expect((await next).at(-1)).toMatchObject({ kind: 'completion', session: { id: state.threadId } })
  expect(f.launched).toEqual(['project-one'])
})

test('revoking the credential refuses new work but preserves exact-turn interruption', async () => {
  const f = fixture(), api = controlSurfaces(f)
  f.hold(true)
  const draining = collect(f.bindings.start('project-one', spec('hold')))
  for (let attempt = 0; f.calls.length < 1 && attempt < 100; attempt++) await Bun.sleep(1)
  const state = await (await api('control')).json() as NativeOwnerControlState
  f.authorize(false)
  expect((await api('model')).status).toBe(503)
  expect((await api('control', { ...state, action: 'interrupt' })).status).toBe(200)
  expect((await draining).at(-1)).toMatchObject({ kind: 'error', code: 'aborted' })
  expect(f.rpc.filter(call => call.method === 'turn/interrupt')).toHaveLength(1)
  await f.bindings.close()
})

test('revoking a grant refuses approval but preserves the exact pending decline', async () => {
  const f = fixture(), api = controlSurfaces(f)
  f.hold(true)
  const draining = collect(f.bindings.start('project-one', spec('question')))
  for (let attempt = 0; f.calls.length < 1 && attempt < 100; attempt++) await Bun.sleep(1)
  f.question('item/commandExecution/requestApproval', { availableDecisions: ['accept', 'decline'] })
  const state = await (await api('control')).json() as NativeOwnerControlState
  expect(state.pending).toHaveLength(1)
  const action = { ...state, action: 'reply', requestId: 'approval' }
  f.authorize(false)
  expect((await api('control', { ...action, result: { decision: 'accept' } })).status).toBe(503)
  expect(f.replies).toHaveLength(0)
  expect((await api('control', { ...action, result: { decision: 'decline' } })).status).toBe(200)
  expect(f.replies).toHaveLength(1)
  expect(f.replies[0]?.result).toEqual({ decision: 'decline' })
  f.finish()
  expect((await draining).at(-1)?.kind).toBe('completion')
  await f.bindings.close()
})

test.each(['lost', 'wrong-turn', 'child', 'unsolicited'] as const)('native abort retains uncertainty fence: %s', async fault => {
  const f = fixture(true), api = controlSurfaces(f)
  f.hold(true); f.interruptFault(fault)
  const draining = collect(f.bindings.start('project-one', spec('hold')))
  for (let attempt = 0; f.calls.length < 1 && attempt < 100; attempt++) await Bun.sleep(1)
  const state = await (await api('control')).json() as NativeOwnerControlState
  if (fault === 'unsolicited') await f.abortNative()
  else expect((await api('control', { ...state, action: 'interrupt' })).status).toBe(fault === 'lost' ? 503 : 200)
  expect((await draining).some(event => event.kind === 'completion')).toBe(false)
  expect((await api('model')).status).toBe(503)
  expect(existsSync(join(f.homes.get('project-one')!, '.neutron-owner-work.json'))).toBe(true)
  f.hold(false)
  expect((await collect(f.bindings.start('project-one', spec('successor')))).at(-1)?.kind).toBe('error')
  expect(f.calls).toHaveLength(1)
  const restarted = f.restart()
  expect((await collect(restarted.start('project-one', spec('restart successor')))).at(-1)?.kind).toBe('error')
  await restarted.close()
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
