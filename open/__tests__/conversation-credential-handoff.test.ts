/**
 * #1226 T2 — a credential rotation of the owner conversation is a VERIFIED Chat
 * handoff, never a second Chat and never a permanent refusal.
 *
 * Driven through the production seams: `wireSubstrates` (the live-chat family),
 * `createProjectScopeLifecycle` (the composer's lifecycle owner, with the pool's real
 * exact retirement), the strict project-workspace host over a scripted Herdr server
 * (`createWorkerTerminalHost` + `createConversationTerminal`, so the manager, journal
 * and every RPC are production) and the REAL persistent spawn path. Each child is a
 * real dev-channel peer (`lifecycleReplHost`), so assertions read actual children,
 * actual kills and the RPCs actually sent.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newCredentialPool, reportFailure, reportSuccess, type CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { herdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createPersistentReplSubstrate, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { committedDispatches, retiringSessionKeys } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { registerSupervisedSubstrate } from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
import { setNativeChildLiveness } from '@neutronai/runtime/adapters/claude-code/persistent/native-child-liveness.ts'
import type { PtyChild, PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import { FakeHerdrWorkspaceServer } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import type { AdmissionLeaseRow } from '@neutronai/gateway/project-admission-store.ts'
import { lifecycleReplHost } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/lifecycle-repl-host.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireSubstrates } from '../wiring/substrates.ts'
import { createConversationTerminal, createWorkerTerminalHost } from '../wiring/project-build-terminal.ts'
import { createProjectScopeLifecycle, type ProjectScopeLifecycleDeps } from '../wiring/project-scope-lifecycle.ts'
import type { ProjectLivenessSurface } from '../wiring/project-liveness.ts'

const dirs: string[] = []
const peers: Array<ReturnType<typeof lifecycleReplHost>> = []
afterEach(async () => {
  // A placed child survives a gateway shutdown by design (its pane outlives us);
  // end every fixture child first so no case inherits another's REPL.
  for (const peer of peers.splice(0)) for (const { child } of peer.children) child.kill()
  await shutdownAllPersistentRepls()
  retiringSessionKeys.clear()
  setNativeChildLiveness(OWNER_USER_ID, undefined)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir
}
async function until(check: () => boolean, limitMs = 5000) {
  const limit = Date.now() + limitMs
  while (!check() && Date.now() < limit) await Bun.sleep(10)
  expect(check()).toBe(true)
}

const NAMES = new Map([['p-one', 'Project One'], ['general', 'Literal General']])
const projectName = (id: string) => NAMES.get(id)
const specFor = (conversationProjectId: string | null): AgentSpec => ({
  prompt: 'hello', tools: [], model_preference: ['sonnet'],
  metering_context: { conversationProjectId } as NonNullable<AgentSpec['metering_context']>,
})
async function collect(handle: SessionHandle): Promise<Event[]> {
  const events: Event[] = []
  for await (const event of handle.events) events.push(event)
  return events
}
const completed = (events: Event[]) => events.some(event => event.kind === 'completion')

/** The strict host places the Chat pane (production manager + journal + RPCs), then
 * the real dev-channel peer serves the child. Killing the child closes its placed
 * pane on the server, as a Herdr child's confirmed `pane.close` does. */
function placedLifecycleHost(server: FakeHerdrWorkspaceServer, strict: PtyHost, peer: PtyHost): PtyHost {
  return {
    async spawn(argv, options) {
      const placed = await strict.spawn(['claude-stub'], options)
      placed.detach?.()
      const paneHandle = placed.paneHandle!
      const child = await peer.spawn(argv, options)
      const wrapped: PtyChild = {
        ...child, paneHandle,
        kill(signal?: NodeJS.Signals) {
          if (!child.hasExited()) void server.call('pane.close', { pane_id: paneHandle }).catch(() => {})
          child.kill(signal)
        },
      }
      return wrapped
    },
  }
}

interface Rig {
  pool: CredentialPool
  peer: ReturnType<typeof lifecycleReplHost>
  server: FakeHerdrWorkspaceServer
  /** Each workspace's initial shell pane, which the manager closes on creation. */
  shells: Set<string>
  leases: AdmissionLeaseRow[]
  logged: Array<{ event: string; fields: Record<string, unknown> | undefined }>
  factorySpawns: ClaudeCodeSubstrateOptions[]
  wire(lifecycleOverrides?: Partial<ProjectScopeLifecycleDeps>): ReturnType<typeof wireSubstrates>
}

async function rig(options: { herdr: boolean }): Promise<Rig> {
  // Composer suites in the same process register a global owner native-child census;
  // this fixture owns that identity (a case that needs one sets it explicitly).
  setNativeChildLiveness(OWNER_USER_ID, undefined)
  const root = tempDir('conversation-handoff-')
  mkdirSync(join(root, 'cwd'))
  const server = new FakeHerdrWorkspaceServer()
  const shells = new Set<string>()
  const answer = server.call.bind(server)
  server.call = async (method, params) => {
    const reply = await answer(method, params)
    if (method === 'workspace.create') shells.add(String((reply['root_pane'] as { pane_id: string }).pane_id))
    return reply
  }
  const peer = lifecycleReplHost()
  peers.push(peer)
  const strict = options.herdr ? createWorkerTerminalHost(root, { selected: herdrHost, connect: async () => server })! : null
  const conversationTerminal = strict === null ? undefined
    : createConversationTerminal({ host: strict, instanceId: 'owner', projectName, selected: herdrHost })!
  const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const sinkPort = reservation.port!
  await reservation.stop(true)
  const pool = newCredentialPool({ strategy: 'round_robin', credentials: [
    { id: 'anthropic:a', kind: 'api_key', secret: 'sk-a' }, { id: 'anthropic:b', kind: 'api_key', secret: 'sk-b' },
  ] })
  const leases: AdmissionLeaseRow[] = []
  const logged: Rig['logged'] = []
  const factorySpawns: ClaudeCodeSubstrateOptions[] = []
  const placedHost = strict === null ? peer.host : placedLifecycleHost(server, strict, peer.host)
  // The real persistent substrate, with the dispatch's exact pool identity.
  const factory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    factorySpawns.push(opts)
    const persistent: PersistentReplSubstrateOptions = {
      substrate_instance_id: opts.substrate_instance_id, cwd: join(root, 'cwd'),
      ...(opts.user_id === undefined ? {} : { user_id: opts.user_id }),
      ...(opts.project_id === undefined ? {} : { project_id: opts.project_id }),
      ...(opts.credential_identity === undefined ? {} : { credential_identity: opts.credential_identity }),
      ...(opts.conversationProjectId === undefined ? {} : { conversationProjectId: opts.conversationProjectId }),
      ...(opts.projectPlacement === undefined ? {} : { projectPlacement: opts.projectPlacement }),
      ptyHost: opts.ptyHost === undefined ? peer.host : placedHost,
      replRegistryPath: join(root, 'repl-registry.json'),
      skipTrustSeed: true, idleQuietMs: 0, sinkPort,
    }
    // As the production factory does (`createClaudeCodeSubstrateAuto`): supervise the
    // exact identity, then build the persistent substrate over it.
    registerSupervisedSubstrate(persistent)
    return createPersistentReplSubstrate(persistent)
  }
  return {
    pool, peer, server, shells, leases, logged, factorySpawns,
    wire(lifecycleOverrides = {}) {
      const conversationLifecycle = createProjectScopeLifecycle({
        admission: {
          listLeases: () => leases,
          hasUnresolvedNativeChildForChat: () => false,
        },
        log: {
          info: (event, fields) => { logged.push({ event, fields }) },
          warn: (event, fields) => { logged.push({ event, fields }) },
        },
        pollMs: 10, waitMs: 5000,
        ...lifecycleOverrides,
      })
      const ctx: OpenWiringContext = {
        llmPool: pool, owner_handle: 'owner', owner_home: join(root, 'cwd'), project_slug: 'owner',
        env: {} as NodeJS.ProcessEnv, db: {} as OpenWiringContext['db'],
        admissionGenerationFor: async () => undefined, prewarmSubstrate: async () => {},
        ...(conversationTerminal === undefined ? {} : { conversationTerminal }),
        conversationLifecycle, substrateFactory: factory,
      }
      return wireSubstrates(ctx)
    },
  }
}

const chatLayouts = (server: FakeHerdrWorkspaceServer) =>
  server.callsTo('layout.apply').filter(call => call.params['tab_label'] === 'Chat')
const credentialsServed = (r: Rig) =>
  r.factorySpawns.filter(o => o.substrate_instance_id === 'cc-agent-owner').map(o => o.credential_identity)
const useCount = (pool: CredentialPool, id: string) => pool.credentials.find(c => c.id === id)!.use_count
/** Closes of anything but a workspace's initial shell pane (the manager retires it). */
const chatCloses = (r: Rig) => r.server.callsTo('pane.close').filter(call => !r.shells.has(String(call.params['pane_id'])))
const alive = (r: Rig) => r.peer.children.filter(c => !c.child.hasExited())

test('pin: consecutive turns for one scope stay on the Chat owner credential under round_robin', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.peer.children).toHaveLength(1)
  expect(r.peer.children[0]!.prompts).toHaveLength(2)
  expect(chatLayouts(r.server)).toHaveLength(1)
  expect(credentialsServed(r)).toEqual(['anthropic:a', 'anthropic:a'])
  expect(useCount(r.pool, 'anthropic:a')).toBe(2)
  expect(useCount(r.pool, 'anthropic:b')).toBe(0)
  expect(chatCloses(r)).toHaveLength(0)
})

test('rotation handoff: the old exact Chat is retired, then a fresh Chat is placed at tab zero of the SAME workspace', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  const [firstChat] = chatLayouts(r.server)
  const workspace = firstChat!.params['workspace_id']
  const oldPane = [...r.server.panes.values()].find(pane => pane.label === 'Chat')!.pane_id
  reportFailure(r.pool, 'anthropic:a', 429)
  const events = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(completed(events)).toBe(true)
  expect(r.peer.children).toHaveLength(2)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
  expect(r.peer.children[1]!.child.hasExited()).toBe(false)
  expect(r.peer.children[1]!.prompts).toHaveLength(1)
  expect(r.server.callsTo('pane.close').map(call => call.params['pane_id'])).toContain(oldPane)
  const chats = chatLayouts(r.server)
  expect(chats).toHaveLength(2)
  expect(chats[1]!.params['workspace_id']).toBe(workspace)
  expect(r.server.callsTo('workspace.create')).toHaveLength(1)
  const newChat = [...r.server.panes.values()].find(pane => pane.label === 'Chat')!
  expect(newChat.pane_id).not.toBe(oldPane)
  expect(r.server.callsTo('tab.move')).toContainEqual(expect.objectContaining({ params: { tab_id: newChat.tab_id, insert_index: 0 } }))
  expect(credentialsServed(r)).toEqual(['anthropic:a', 'anthropic:b'])
  const handoff = r.logged.find(entry => entry.event === 'chat_credential_handoff')
  expect(handoff?.fields).toEqual(expect.objectContaining({
    scope: 'p-one', from_credential: 'anthropic:a', to_credential: 'anthropic:b', session_id: r.peer.children[0]!.sessionId,
  }))
})

test('busy owner: the handoff waits for the in-flight turn, never spawns a second Chat meanwhile, and a bounded wait reports busy', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  r.peer.holdReplies(() => gate)
  const inFlight = collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  await until(() => r.peer.children[0]!.prompts.length === 2)
  reportFailure(r.pool, 'anthropic:a', 429)

  // A bounded wait on a still-busy owner: nothing spawned, nothing placed, nothing closed.
  const impatient = r.wire({ waitMs: 50 })
  const busy = await collect(impatient.liveAgentSubstrate!.start(specFor('p-one')))
  expect(busy).toEqual([expect.objectContaining({ kind: 'error', code: 'chat_handoff_busy', retryable: true })])
  expect(r.peer.children).toHaveLength(1)
  expect(chatLayouts(r.server)).toHaveLength(1)
  expect(chatCloses(r)).toHaveLength(0)
  expect(r.pool.credentials.find(c => c.id === 'anthropic:b')!.consecutive_failures).toBe(0)

  const rotated = collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  await Bun.sleep(150)
  expect(r.peer.children).toHaveLength(1)
  expect(r.peer.children[0]!.child.hasExited()).toBe(false)
  expect(chatCloses(r)).toHaveLength(0)
  expect(chatLayouts(r.server)).toHaveLength(1)
  r.peer.holdReplies()
  release()
  expect(completed(await inFlight)).toBe(true)
  expect(completed(await rotated)).toBe(true)
  expect(r.peer.children).toHaveLength(2)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
  expect(alive(r)).toHaveLength(1)
  expect(chatLayouts(r.server)).toHaveLength(2)
})

test('an unresolved native child refuses the handoff: the old Chat stays, nothing is placed, the credential is not faulted', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  r.leases.push({ scope: { ownerHandle: 'owner', projectId: 'p-one' }, reason: 'liveChild', workRef: 'child-1' } as unknown as AdmissionLeaseRow)
  reportFailure(r.pool, 'anthropic:a', 429)
  const events = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(events).toEqual([expect.objectContaining({ kind: 'error', code: 'chat_handoff_refused', retryable: true })])
  expect(r.peer.children).toHaveLength(1)
  expect(r.peer.children[0]!.child.hasExited()).toBe(false)
  expect(chatCloses(r)).toHaveLength(0)
  expect(chatLayouts(r.server)).toHaveLength(1)
  expect(r.pool.credentials.find(c => c.id === 'anthropic:b')!.consecutive_failures).toBe(0)
  expect(r.logged).toContainEqual(expect.objectContaining({ event: 'chat_handoff_refused' }))
  // A lease for ANOTHER scope never blocks this one.
  r.leases.splice(0, 1, { scope: { ownerHandle: 'owner', projectId: 'p-two' }, reason: 'liveChild', workRef: 'child-2' } as unknown as AdmissionLeaseRow)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
})

test('the pool\'s own native-child census also refuses retirement (same admission, second authority)', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  setNativeChildLiveness(OWNER_USER_ID, () => true, () => true)
  reportFailure(r.pool, 'anthropic:a', 429)
  const events = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(events).toEqual([expect.objectContaining({ kind: 'error', code: 'chat_handoff_refused' })])
  expect(r.peer.children[0]!.child.hasExited()).toBe(false)
  expect(chatCloses(r)).toHaveLength(0)
})

test('unknown liveness never licenses closure: an unknown census leaves the old Chat untouched', async () => {
  const r = await rig({ herdr: true })
  const census: ProjectLivenessSurface = { census: async () => ({
    parent: { kind: 'legacy-unknown', sessionKey: 'k', childGeneration: 'g', sessionId: 's' },
    verdict: 'unknown', reasons: ['legacy parent'],
  }) as unknown as Awaited<ReturnType<ProjectLivenessSurface['census']>> }
  const wired = r.wire({ liveness: () => census })
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  reportFailure(r.pool, 'anthropic:a', 429)
  const events = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(events).toEqual([expect.objectContaining({ kind: 'error', code: 'chat_handoff_unknown' })])
  expect(r.peer.children).toHaveLength(1)
  expect(r.peer.children[0]!.child.hasExited()).toBe(false)
  expect(chatCloses(r)).toHaveLength(0)
})

test('foreign workspace after a legitimate retirement: the new placement refuses visibly, one kill, no second workspace, no duplicate', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  const [workspace] = [...r.server.workspaces.keys()]
  r.server.workspaces.get(workspace!)!.tokens = { neutron_project_owner: 'foreign' }
  reportFailure(r.pool, 'anthropic:a', 429)
  const events = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('ownership mismatch') }))
  expect(chatCloses(r)).toHaveLength(1)
  expect(r.peer.children).toHaveLength(1)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
  expect(r.server.callsTo('workspace.create')).toHaveLength(1)
  expect(chatLayouts(r.server)).toHaveLength(1)
  // A following turn still refuses: it never spawns a duplicate or a second workspace.
  reportSuccess(r.pool, 'anthropic:b')
  const again = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(again.some(event => event.kind === 'error')).toBe(true)
  expect(r.peer.children).toHaveLength(1)
  expect(chatCloses(r)).toHaveLength(1)
  expect(r.server.callsTo('workspace.create')).toHaveLength(1)
  expect(chatLayouts(r.server)).toHaveLength(1)
})

test('General (null) and the literal project `general` hand off independently: neither retires the other\'s owner', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor(null))))).toBe(true)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('general'))))).toBe(true)
  expect(r.peer.children).toHaveLength(2)
  const [general, literal] = r.peer.children
  expect(credentialsServed(r)).toEqual(['anthropic:a', 'anthropic:b'])
  expect(r.server.callsTo('workspace.create').map(call => call.params['label'])).toEqual(['Neutron General', 'Literal General'])

  // General rotates off `a`: only General's owner is retired.
  reportFailure(r.pool, 'anthropic:a', 429)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor(null))))).toBe(true)
  expect(general!.child.hasExited()).toBe(true)
  expect(literal!.child.hasExited()).toBe(false)
  expect(r.peer.children).toHaveLength(3)

  // The literal project rotates off `b` (back to `a`, whose retired key is readmitted).
  reportSuccess(r.pool, 'anthropic:a')
  reportFailure(r.pool, 'anthropic:b', 429)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('general'))))).toBe(true)
  expect(literal!.child.hasExited()).toBe(true)
  expect(r.peer.children[2]!.child.hasExited()).toBe(false)
  expect(r.peer.children).toHaveLength(4)
  expect(alive(r)).toHaveLength(2)
  expect(r.server.callsTo('workspace.create')).toHaveLength(2)
})

test('off Herdr the rotation still retires the old REPL: one conversation per scope everywhere', async () => {
  const r = await rig({ herdr: false })
  const wired = r.wire()
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  reportFailure(r.pool, 'anthropic:a', 429)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.peer.children).toHaveLength(2)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
  expect(alive(r)).toHaveLength(1)
  // Rotating back re-admits the first credential's retired key: never a permanent refusal.
  reportSuccess(r.pool, 'anthropic:a')
  reportFailure(r.pool, 'anthropic:b', 429)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.peer.children).toHaveLength(3)
  expect(alive(r)).toHaveLength(1)
  expect(credentialsServed(r)).toEqual(['anthropic:a', 'anthropic:b', 'anthropic:a'])
  await until(() => [...committedDispatches.values()].every(count => count === 0))
})

type Census = Awaited<ReturnType<ProjectLivenessSurface['census']>>
const participating = (parts: { parentTurn: string; children: string; shells: string; verdict: string }): Census => ({
  parent: { kind: 'participating', sessionKey: 'k', childGeneration: 'g', sessionId: 's', generation: 1, pid: 1 },
  reasons: ['probe'], ...parts,
}) as unknown as Census

test('handoff census: a busy verdict never masks unknown descendants, and busy children or shells never license retirement', async () => {
  const r = await rig({ herdr: true })
  let current = participating({ parentTurn: 'idle', children: 'idle', shells: 'idle', verdict: 'idle' })
  const wired = r.wire({ liveness: () => ({ census: async () => current }), waitMs: 100 })
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  reportFailure(r.pool, 'anthropic:a', 429)
  const cases: Array<[Parameters<typeof participating>[0], string]> = [
    [{ parentTurn: 'busy', children: 'idle', shells: 'unknown', verdict: 'busy' }, 'chat_handoff_unknown'],
    [{ parentTurn: 'idle', children: 'unknown', shells: 'busy', verdict: 'busy' }, 'chat_handoff_unknown'],
    [{ parentTurn: 'idle', children: 'idle', shells: 'busy', verdict: 'busy' }, 'chat_handoff_busy'],
    [{ parentTurn: 'idle', children: 'busy', shells: 'idle', verdict: 'busy' }, 'chat_handoff_refused'],
  ]
  for (const [parts, code] of cases) {
    current = participating(parts)
    const events = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
    expect(events).toEqual([expect.objectContaining({ kind: 'error', code, retryable: true })])
    expect(r.peer.children).toHaveLength(1)
    expect(r.peer.children[0]!.child.hasExited()).toBe(false)
    expect(chatCloses(r)).toHaveLength(0)
    expect(chatLayouts(r.server)).toHaveLength(1)
  }
  // Positively idle in every part: the rotation hands off.
  current = participating({ parentTurn: 'idle', children: 'idle', shells: 'idle', verdict: 'idle' })
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
  expect(alive(r)).toHaveLength(1)
})

test('a Chat spawn in flight is not absence: ownerFor reports it, a different key is busy, the same key is ready', async () => {
  const lifecycle = createProjectScopeLifecycle({
    admission: { listLeases: () => [], hasUnresolvedNativeChildForChat: () => false },
    sessions: async () => ({ live: [], unresolved: 1, pending: [{ sessionKey: 'key-a',
      options: { conversationProjectId: 'p-one', credential_identity: 'anthropic:a' } as unknown as PersistentReplSubstrateOptions }] }),
    log: { info() {}, warn() {} },
  })
  expect(await lifecycle.ownerFor('p-one')).toEqual({ kind: 'owner', sessionKey: 'key-a', credentialId: 'anthropic:a', sessionId: '', spawning: true })
  // Another scope never sees it.
  expect(await lifecycle.ownerFor(null)).toEqual({ kind: 'none' })
  const other = await lifecycle.handoffChat('p-one', { sessionKey: 'key-b', credentialId: 'anthropic:b' })
  expect(other).toEqual({ status: 'busy', reason: 'a Chat spawn for the scope is still in flight' })
  expect(await lifecycle.handoffChat('p-one', { sessionKey: 'key-a', credentialId: 'anthropic:a' })).toEqual({ status: 'ready' })
})

test('ambiguous owners (documented bypass): the dispatch is pinned to a survivor credential, never growing the set; none usable spawns as before', async () => {
  const r = await rig({ herdr: false })
  const survivor = (credential: string) => ({ sessionKey: `survivor-${credential}`,
    options: { conversationProjectId: 'p-one', credential_identity: credential } as unknown as PersistentReplSubstrateOptions,
    session: { sessionId: `s-${credential}`, child: {} } as never })
  const wired = r.wire({ sessions: async () => ({ live: [survivor('anthropic:b'), survivor('anthropic:b')], unresolved: 0 }) })
  // Round-robin alone would pick `a`; the survivors' credential is the pin.
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(credentialsServed(r)).toEqual(['anthropic:b'])
  expect(r.logged.filter(entry => entry.event.startsWith('chat_handoff'))).toEqual([])
  // No survivor credential usable: the pre-#1226 path (the strategy chooses).
  reportFailure(r.pool, 'anthropic:b', 429)
  expect(completed(await collect(wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(credentialsServed(r)).toEqual(['anthropic:b', 'anthropic:a'])
})

test('Codex -> Claude switch: a Chat held by a live non-Claude owner refuses the Claude spawn with its recovery path; nothing is closed', async () => {
  const r = await rig({ herdr: true })
  const wired = r.wire({ conversationTerminal: { inspectChat: async () => ({ status: 'live', pane: 'codex-tui' }) } })
  const events = await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(events).toEqual([expect.objectContaining({ kind: 'error', code: 'chat_handoff_refused', retryable: true,
    message: expect.stringContaining('switch the project back to Codex') })])
  expect(r.peer.children).toHaveLength(0)
  expect(r.factorySpawns).toHaveLength(0)
  expect(chatLayouts(r.server)).toHaveLength(0)
  expect(r.server.callsTo('pane.close')).toHaveLength(0)
  // Once that Chat is gone (switched back and ended, or retired), Claude spawns normally.
  const freed = r.wire({ conversationTerminal: { inspectChat: async () => ({ status: 'gone' }) } })
  expect(completed(await collect(freed.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.peer.children).toHaveLength(1)
})
