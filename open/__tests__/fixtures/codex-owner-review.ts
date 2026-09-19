import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { CodexOwnerBinding, CodexOwnerBindingFacts } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { createProjectControlBroker } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-broker.ts'
import { connectCodexOwnerHelper } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-client.ts'
import { helperIdentity, socketIdentity, type Rpc } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { OwnerHelperRegistry } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-registry.ts'
import { CodexOwnerBindings } from '../../wiring/codex-owner-binding.ts'

/** Real broker, authenticated private helper transport and Open binding. Only
 * native RPC/model execution is a process fixture; native sandbox enforcement
 * still requires the separate real-binary smoke, never this fixture alone. */
export async function restrictedOwnerFixture(options: {
  projectId: string
  cwd: string
  execute(prompt: string): Promise<void>
  drop?: string
  forbiddenEdit?: boolean
  childSettlesAfterMs?: number
  badRestore?: boolean
  busyPrepare?: boolean
  coldRollout?: boolean
  corruptRollout?: boolean
  foreignRollout?: boolean
  modelFault?: 'busy' | 'native-refusal' | 'lost'
  wrongSchema?: boolean
}) {
  const root = mkdtempSync('/tmp/open-review-owner-'), codexHome = join(root, 'home')
  mkdirSync(codexHome, { mode: 0o700 })
  writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify(options.projectId))
  const rolloutPath = join(codexHome, 'rollout.jsonl')
  const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n'
  const metadata = line('session_meta', { id: 'owner', cwd: options.cwd, session_id: 'owner-session', source: 'vscode', originator: 'fixture' })
  if (!options.coldRollout) writeFileSync(rolloutPath, options.corruptRollout ? '{}' : options.foreignRollout ? metadata.replace('"owner"', '"foreign-owner"') : metadata)
  let receive: (message: unknown) => void = () => {}, counter = 0, observation = 0, restored = false
  let defaultPermissions: unknown = null
  let model = 'small'
  const profiles: Record<string, unknown> = {}, native: Rpc[] = [], wire: Rpc[] = [], children: BoundedWorkRequest[] = [], errors: unknown[] = []
  const before = { thread: { id: 'owner' }, cwd: options.cwd,
    sandbox: { type: 'workspaceWrite', writableRoots: [options.cwd], networkAccess: true },
    activePermissionProfile: { id: ':workspace' }, approvalPolicy: 'on-request', approvalsReviewer: 'user', runtimeWorkspaceRoots: [options.cwd] }
  const event = (method: string, threadId: string, id: string) => receive({ method, params: { threadId, turn: { id } } })
  const pending = new Set<Promise<void>>()
  const broker = await createProjectControlBroker({ socketPath: join(root, 'broker.sock'), cwd: options.cwd, codexHome, threadId: 'owner', upstream: {
    close() {}, listen(fn) { receive = fn }, send(message) {
      native.push(message)
      if (!message.method) return
      const params = message.params as Rpc
      let result: unknown = {}
      if (message.method === 'model/list') result = { data: [{ model: 'small', displayName: 'Small' }, { model: 'large', displayName: 'Large' }], nextCursor: null }
      if (message.method === 'thread/read') result = { thread: { id: 'owner', model, cwd: options.cwd, sessionId: 'owner-session', modelProvider: 'fixture' } }
      if (message.method === 'thread/resume') result = options.badRestore && restored ? { ...before, approvalPolicy: 'never' } : before
      if (message.method === 'thread/settings/update') restored = true
      if (message.method === 'thread/settings/update' && typeof params.model === 'string') {
        if (options.modelFault === 'native-refusal') { queueMicrotask(() => receive({ id: message.id, error: { code: -32001, message: 'Delivered native refusal' } })); return }
        model = params.model
      }
      if (message.method === 'config/read') result = { config: { mcp_servers: {}, permissions: structuredClone(profiles), default_permissions: defaultPermissions } }
      if (message.method === 'config/batchWrite') for (const edit of params.edits as Rpc[]) {
        const key = edit.keyPath as string
        if (key === 'default_permissions') defaultPermissions = edit.value
        else if (edit.value === null) delete profiles[key.slice('permissions.'.length)]
        else profiles[key.slice('permissions.'.length)] = structuredClone(edit.value)
      }
      if (message.method === 'turn/start') {
        const turnId = `parent-${++counter}`, childId = `child-${counter}`
        result = { turn: { id: turnId } }
        const prompt = (params.input as { text: string }[])[0]!.text
        const work = (async () => {
          await Bun.sleep(1)
          if (counter === 1 && options.coldRollout) writeFileSync(rolloutPath, metadata)
          event('turn/started', 'owner', turnId)
          appendFileSync(rolloutPath, line('event_msg', { type: 'task_started', turn_id: turnId })
            + line('event_msg', { type: 'item_completed', thread_id: 'owner', turn_id: turnId,
              item: { type: 'UserMessage', id: `user-${counter}`, content: [{ type: 'text', text: prompt, text_elements: [] }] } }))
          const dispatchPrefix = 'Execute the prompt in this JSON dispatch specification: '
          let child: BoundedWorkRequest | undefined
          if (prompt.startsWith(dispatchPrefix)) {
            const spec = JSON.parse(prompt.slice(dispatchPrefix.length))
            const args = JSON.parse(spec.prompt.slice(spec.prompt.indexOf('\n') + 1))
            child = JSON.parse(args.message.split('\n').find((text: string) => text.startsWith('Request (data): ')).slice('Request (data): '.length))
            children.push(child!)
            event('turn/started', childId, 'child-turn')
            receive({ method: 'item/completed', params: { threadId: 'owner', turnId,
              item: { type: 'subAgentActivity', kind: 'started', agentThreadId: childId } } })
          }
          appendFileSync(rolloutPath, line('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: 'dispatch complete' }))
          event('turn/completed', 'owner', turnId)
          if (child) {
            if (child.role === 'review' || child.role === 'synthesis') {
              const stage = join(child.result.path, '..')
              assert.equal(typeof params.permissions, 'string', 'native review must use a provisioned permission profile')
              assert.deepEqual(profiles[params.permissions as string], { filesystem: { ':root': 'read', [stage]: 'write' }, network: { enabled: child.network } })
              assert.equal(params.approvalPolicy, 'never')
              assert.equal(params.sandboxPolicy, undefined)
              if (options.forbiddenEdit) {
                // The simulated native filesystem consults the REAL installed
                // profile. An injected repository write is denied, not executed.
                const grant = profiles[params.permissions as string] as { filesystem: Record<string, string> }
                assert.notEqual(grant.filesystem[options.cwd], 'write')
                writeFileSync(child.result.path, '{}')
              } else {
                await options.execute(prompt)
                if (options.wrongSchema) {
                  const result = JSON.parse(readFileSync(child.result.path, 'utf8'))
                  writeFileSync(child.result.path, JSON.stringify({ ...result, schema: 'foreign-schema' }))
                }
              }
            } else await options.execute(prompt)
            await Bun.sleep(options.childSettlesAfterMs ?? 0)
            event('turn/completed', childId, 'child-turn')
          }
        })().catch(error => { errors.push(error) })
        pending.add(work); void work.finally(() => pending.delete(work))
      }
      queueMicrotask(() => receive({ id: message.id, result }))
    },
  } })
  if (options.modelFault === 'busy') {
    const gateway = broker.gateway.bind(broker)
    broker.gateway = clientId => {
      const writer = gateway(clientId)
      return { ...writer, async request(method, params, epoch) {
        if (method === 'thread/settings/update' && typeof params.model === 'string') {
          const terminal = gateway('competing-model-terminal')
          await terminal.request('turn/start', { threadId: 'owner', input: [{ type: 'text', text: 'COMPETING_TERMINAL' }] }, broker.state().epoch)
          terminal.close()
        }
        return writer.request(method, params, epoch)
      } }
    }
  }
  if (options.busyPrepare) {
    const prepare = broker.reviewPermissions.bind(broker)
    let first = true
    broker.reviewPermissions = async (request, epoch) => {
      if (first) {
        first = false
        const terminal = broker.gateway('competing-terminal')
        await terminal.request('turn/start', { threadId: 'owner', input: [{ type: 'text', text: 'COMPETING_TERMINAL' }] }, broker.state().epoch)
        terminal.close()
      }
      return prepare(request, epoch)
    }
  }
  const assertOwner = () => { if (broker.state().phase === 'closed') throw new Error('Stale native owner binding') }
  const registry = new OwnerHelperRegistry(broker, assertOwner)
  const facts: CodexOwnerBindingFacts = { threadId: 'owner', sessionId: 'owner-session', cwd: options.cwd, codexHome, rolloutPath,
    paneHandle: 'test-pane', bindingRevision: 'a'.repeat(64), generation: 1, brokerGeneration: broker.state().generation,
    credentialFingerprint: 'b'.repeat(64), modelProvider: 'fixture', controlSocketPath: join(root, 'broker.sock'),
    nativeMetadata: { sessionId: 'owner-session', source: 'vscode', originator: 'fixture' },
    capabilities: { multiAgentV2: true, evidence: 'native-thread-feature-report' } }
  const helper = helperIdentity(), token = 'c'.repeat(64), socketPath = join(root, 'helper.sock'), descriptorPath = join(root, 'helper.json')
  const server = Bun.serve({ unix: socketPath, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/owner' || request.headers.has('origin')
      || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Refused', { status: 403 })
    try {
      assertOwner()
      const raw = await request.json() as Rpc
      wire.push(raw)
      const result = raw.operation === 'attach' ? { facts, helper, challenge: raw.challenge, ...registry.attach() }
        : await registry.handle(raw, request.signal)
      if (raw.operation === options.drop || options.modelFault === 'lost' && raw.method === 'thread/settings/update') return new Response('{"lost":')
      return Response.json({ ...result, state: broker.state(), observation: ++observation })
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: 409 }) }
  } })
  chmodSync(socketPath, 0o600)
  writeFileSync(descriptorPath, JSON.stringify({ version: 1, facts, helper, socketPath, socketIdentity: socketIdentity(socketPath), token }), { mode: 0o600 })
  const connection = await connectCodexOwnerHelper({ descriptorPath, expected: facts, timeoutMs: 2000 })
  const binding = {} as CodexOwnerBinding
  let opens = 0
  const bindings = new CodexOwnerBindings(async projectId => {
    assert.equal(projectId, options.projectId)
    return { cwd: options.cwd, codexHome, env: {} }
  }, async () => {
    opens++
    return { binding, broker: connection.broker, refreshState: connection.refreshState, replyApproval: connection.replyApproval,
      writeTerminal() { throw new Error('Must not create another native session') }, async close() { connection.close() } }
  }, received => { assert.equal(received, binding); connection.assertCurrent(); return facts })
  return { bindings, native, wire, children, errors, codexHome, profiles, opens: () => opens,
    artifact(path: string) { return JSON.parse(readFileSync(path, 'utf8')) },
    async close() { await Promise.allSettled(pending); await bindings.close(); connection.close(); registry.destroy(); broker.close(); server.stop(true); rmSync(root, { recursive: true, force: true }) } }
}
