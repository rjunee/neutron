/**
 * #1226 — production owner conversations are placed through the project-workspace
 * manager, for the dispatch's ACTUAL scope.
 *
 * Driven through the production seams: `createWorkerTerminalHost` (the one strict host
 * the composer builds), `createConversationTerminal`, `wireSubstrates` (the live-chat
 * family), the real persistent spawn path (`createPersistentReplSubstrate`, which
 * forwards `projectPlacement` to the host) and the real `ProjectWorkspaceManager`
 * over a scripted Herdr server. Every assertion reads the RPCs actually sent.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { createClaudeCodeSubstrateAuto, type ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { bunTerminalHost } from '@neutronai/runtime/adapters/claude-code/persistent/bun-terminal-host.ts'
import { HerdrHost, herdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createPersistentReplSubstrate } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import type { ConversationTerminal, ProjectWorkspaceLaunch } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspace-host.ts'
import { FakeHerdrWorkspaceServer } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import { createWorkerPlacement } from '@neutronai/runtime/workers/worker-placement.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireSubstrates } from '../wiring/substrates.ts'
import {
  conversationPlacementFor, createConversationTerminal, createWorkerTerminalHost, projectWorkspaceJournalPath, workerPlacementScope,
} from '../wiring/project-build-terminal.ts'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir
}

const NAMES = new Map([['p-one', 'Same Name'], ['p-two', 'Same Name'], ['general', 'Literal General']])
const projectName = (id: string) => NAMES.get(id)
const specFor = (conversationProjectId?: string | null): AgentSpec => ({
  prompt: 'hello', tools: [], model_preference: ['sonnet'],
  ...(conversationProjectId === undefined ? {} : { metering_context: { conversationProjectId } as NonNullable<AgentSpec['metering_context']> }),
})
async function collect(handle: SessionHandle): Promise<Event[]> {
  const events: Event[] = []
  for await (const event of handle.events) events.push(event)
  return events
}
function canned(id: string): SessionHandle {
  return { tool_resolution: 'internal', async respondToTool() {}, async cancel() {},
    events: (async function* (): AsyncGenerator<Event> { yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: id } })() }
}
function context(overrides: Partial<OpenWiringContext>): OpenWiringContext {
  return {
    // A fresh pool per wiring: a refused spawn must not cool the next dispatch's credential.
    llmPool: newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'anthropic:test', kind: 'api_key', secret: 'sk-test' }] }),
    owner_handle: 'owner', owner_home: '/tmp/owner-home', project_slug: 'owner', env: {} as NodeJS.ProcessEnv,
    db: {} as OpenWiringContext['db'], admissionGenerationFor: async () => undefined, prewarmSubstrate: async () => {},
    ...overrides,
  }
}

test('placement scope: null is Neutron General, the literal project id general keeps its own scope', () => {
  expect(conversationPlacementFor({ instanceId: 'owner', conversationProjectId: null, projectName }))
    .toEqual({ instanceId: 'owner', projectId: null, projectLabel: 'Neutron General', role: 'chat' })
  expect(conversationPlacementFor({ instanceId: 'owner', conversationProjectId: 'general', projectName }))
    .toEqual({ instanceId: 'owner', projectId: 'general', projectLabel: 'Literal General', role: 'chat' })
  expect(conversationPlacementFor({ instanceId: 'owner', conversationProjectId: 'beta', projectName: () => { throw new Error('no table') } }))
    .toEqual({ instanceId: 'owner', projectId: 'beta', projectLabel: 'beta', role: 'chat' })
  // Off Herdr nothing is placed; on Herdr without a strict host the placement still travels.
  expect(createConversationTerminal({ host: null, instanceId: 'owner', selected: bunTerminalHost })).toBeUndefined()
  const bare = createConversationTerminal({ host: null, instanceId: 'owner', selected: herdrHost })!
  expect(bare.host).toBeUndefined()
  expect(bare.placementFor(null).projectId).toBeNull()
})

test('the live-chat family alone carries the Chat placement, resolved per dispatch from the exact conversation scope', async () => {
  const root = tempDir('conversation-placement-wiring-')
  const host = createWorkerTerminalHost(root, { selected: herdrHost, connect: async () => new FakeHerdrWorkspaceServer() })!
  const conversationTerminal = createConversationTerminal({ host, instanceId: 'owner', projectName, selected: herdrHost })!
  const captured: ClaudeCodeSubstrateOptions[] = []
  const wired = wireSubstrates(context({ conversationTerminal,
    substrateFactory: opts => { captured.push(opts); return { start: () => canned(opts.substrate_instance_id) } } }))
  const agent = () => captured.filter(o => o.substrate_instance_id === 'cc-agent-owner').at(-1)!

  await collect(wired.liveAgentSubstrate!.start(specFor()))
  expect(agent().projectPlacement).toEqual({ instanceId: 'owner', projectId: null, projectLabel: 'Neutron General', role: 'chat' })
  expect(agent().ptyHost).toBe(host)
  await collect(wired.liveAgentSubstrate!.start(specFor('p-one')))
  expect(agent().projectPlacement).toEqual({ instanceId: 'owner', projectId: 'p-one', projectLabel: 'Same Name', role: 'chat' })
  await collect(wired.makeProjectLiveAgentSubstrate('general')!.start(specFor()))
  // The pool key uses the 'general' sentinel for both; the placement never does.
  expect(agent().project_id).toBe('general')
  expect(agent().projectPlacement).toEqual({ instanceId: 'owner', projectId: 'general', projectLabel: 'Literal General', role: 'chat' })
  await collect(wired.liveAgentSubstrate!.start(specFor(null)))
  expect(agent().project_id).toBe('general')
  expect(agent().projectPlacement!.projectId).toBeNull()

  const before = captured.length
  for (const substrate of [wired.llmCallSubstrate, wired.utilitySubstrate, wired.reminderComposeSubstrate,
    wired.makeComposeSubstrate('p-one'), wired.makeEphemeralSubstrate('cc-trident')('/repo/x'), wired.makeWarmFireSubstrate('/repo/y')]) {
    if (substrate !== null) await collect(substrate.start(specFor('p-one')))
  }
  const others = captured.slice(before)
  expect(others.length).toBeGreaterThanOrEqual(5)
  for (const options of others) {
    expect(options.projectPlacement).toBeUndefined()
    expect(options.ptyHost).toBeUndefined()
  }

  // Without a terminal (off Herdr) the conversation spawn is byte-for-byte unplaced.
  const unplaced: ClaudeCodeSubstrateOptions[] = []
  const plain = wireSubstrates(context({ substrateFactory: opts => { unplaced.push(opts); return { start: () => canned(opts.substrate_instance_id) } } }))
  await collect(plain.liveAgentSubstrate!.start(specFor('p-one')))
  expect(unplaced[0]!.projectPlacement).toBeUndefined()
  expect(unplaced[0]!.ptyHost).toBeUndefined()
})

test('the default Claude factory forwards the placement and host onto the persistent spawn options', () => {
  const cwd = tempDir('conversation-placement-forward-')
  const placement = conversationPlacementFor({ instanceId: 'owner', conversationProjectId: 'p-one', projectName })
  const ptyHost: PtyHost = { async spawn() { throw new Error('never spawned') } }
  const instanceId = `cc-agent-forward-${Date.now()}`
  createClaudeCodeSubstrateAuto({ substrate_instance_id: instanceId, cwd, projectPlacement: placement, ptyHost })
  const registered = [...supervisedBySessionKey].find(([, options]) => options.substrate_instance_id === instanceId)
  // Never leave a supervised `cc-agent-*` row behind: a later census in this process
  // would read it as an unresolved General parent.
  if (registered !== undefined) supervisedBySessionKey.delete(registered[0])
  expect(registered?.[1].projectPlacement).toEqual(placement)
  expect(registered?.[1].ptyHost).toBe(ptyHost)
})

/** The real persistent spawn path, stopped right after the host placed the pane so
 * no model is launched. Everything before it — option forwarding, the strict host,
 * the manager and every RPC — is production code. */
function placingFactory(root: string, fallback: PtyHost) {
  let serial = 0
  return (opts: ClaudeCodeSubstrateOptions): Substrate => {
    const host = opts.ptyHost ?? fallback
    return createPersistentReplSubstrate({
      substrate_instance_id: `${opts.substrate_instance_id}-${++serial}`, cwd: opts.cwd ?? root, skipTrustSeed: true,
      ...(opts.project_id === undefined ? {} : { project_id: opts.project_id }),
      ...(opts.projectPlacement === undefined ? {} : { projectPlacement: opts.projectPlacement }),
      ptyHost: { async spawn(_argv, options) {
        const child = await host.spawn(['claude-stub'], options)
        child.detach?.()
        throw new Error('placement test stops before launching a model')
      } },
    })
  }
}

test('two same-name projects and General each get their own workspace with Chat at tab zero; the worker joins its dispatch Chat; refusals never fall back', async () => {
  const root = tempDir('conversation-placement-e2e-')
  mkdirSync(join(root, 'cwd'))
  const server = new FakeHerdrWorkspaceServer()
  const host = createWorkerTerminalHost(root, { selected: herdrHost, connect: async () => server })!
  const conversationTerminal = createConversationTerminal({ host, instanceId: 'owner', projectName, selected: herdrHost })!
  const inherited = new HerdrHost({ connect: async () => server, workspaceId: 'inherited-workspace' })
  const dispatch = async (scope: string | null, terminal: ConversationTerminal | undefined = conversationTerminal) => {
    const wired = wireSubstrates(context({ ...(terminal === undefined ? {} : { conversationTerminal: terminal }), owner_home: join(root, 'cwd'), substrateFactory: placingFactory(root, inherited) }))
    return collect(wired.liveAgentSubstrate!.start(specFor(scope)))
  }

  for (const scope of ['p-one', 'p-two', null]) {
    const events = await dispatch(scope)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('placement test stops') }))
  }
  const creates = server.callsTo('workspace.create')
  expect(creates.map(call => call.params['label'])).toEqual(['Same Name', 'Same Name', 'Neutron General'])
  expect(new Set(creates.map(call => call.params['cwd']))).toEqual(new Set([join(root, 'cwd')]))
  const workspaces = [...server.workspaces.keys()]
  expect(workspaces).toHaveLength(3)
  const chats = server.callsTo('layout.apply').filter(call => call.params['tab_label'] === 'Chat')
  expect(chats.map(call => call.params['workspace_id'])).toEqual(workspaces)
  for (const chat of chats) expect((chat.params['root'] as { label: string }).label).toBe('Chat')
  const chatTabs = new Map([...server.tabs.values()].filter(tab => tab.label === 'Chat').map(tab => [tab.workspace_id, tab.tab_id]))
  const moved = server.callsTo('tab.move')
  for (const workspace of workspaces) {
    expect(moved).toContainEqual(expect.objectContaining({ params: { tab_id: chatTabs.get(workspace), insert_index: 0 } }))
  }
  // Nothing ever named the inherited workspace.
  expect(server.callsTo('layout.apply').some(call => call.params['workspace_id'] === 'inherited-workspace')).toBe(false)

  // A bounded worker for p-one's dispatch lands in p-one's workspace, beside its Chat.
  const placement = createWorkerPlacement({ host, scope: workerPlacementScope({ instanceId: 'owner', ownerSlug: 'owner', runScopeKey: 'p-one', projectName }) })
  const view = await placement.place({ key: 'k', taskLabel: 'Review · card', cwd: join(root, 'cwd'), viewPath: join(root, 'k.log'), receiptDir: root })
  expect(view.kind).toBe('placed')
  expect(server.workerLayouts().at(-1)!.params['workspace_id']).toBe(workspaces[0])
  expect(server.callsTo('workspace.create')).toHaveLength(3)

  // No strict host on Herdr: the placement travels to the manager-less host, which
  // refuses before any layout — never the inherited workspace.
  const applies = server.callsTo('layout.apply').length
  const refused = await dispatch('p-three', createConversationTerminal({ host: null, instanceId: 'owner', projectName, selected: herdrHost }))
  expect(refused).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('requires a workspace manager') }))
  expect(server.callsTo('layout.apply')).toHaveLength(applies)

  // A mismatched ownership marker refuses: no new Chat, no new workspace.
  server.workspaces.get(workspaces[1]!)!.tokens = { neutron_project_owner: 'foreign' }
  const foreign = await dispatch('p-two')
  expect(foreign).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('ownership mismatch') }))
  expect(server.callsTo('layout.apply')).toHaveLength(applies)
  expect(server.callsTo('workspace.create')).toHaveLength(3)
})

test('a fresh Codex owner launch carries its exact scope workspace across the helper boundary: null for General, the id for a project', async () => {
  const root = tempDir('conversation-placement-codex-')
  const journalPath = projectWorkspaceJournalPath(root)
  const launches: Array<{ projectId: string | null; projectWorkspace?: ProjectWorkspaceLaunch }> = []
  const home = (name: string, projectId?: string) => {
    const dir = join(root, name); mkdirSync(join(dir, 'home'), { recursive: true, mode: 0o700 })
    if (projectId !== undefined) writeFileSync(join(dir, 'home', 'project-owner.json'), JSON.stringify(projectId), { mode: 0o600 })
    return { cwd: dir, codexHome: join(dir, 'home'), credentialIdentity: 'fixture', env: {} }
  }
  const projects = { general: home('literal-general', 'general'), 'p-one': home('p-one', 'p-one') }
  const generalOwner = home('general-owner')
  const bindings = new CodexOwnerBindings(async projectId => projects[projectId as keyof typeof projects], async options => {
    launches.push({ projectId: options.projectId, ...(options.projectWorkspace ? { projectWorkspace: options.projectWorkspace } : {}) })
    throw new Error('fixture stops before a native owner')
  }, undefined, async () => generalOwner)
  const terminal = createConversationTerminal({ host: null, instanceId: 'owner', projectName, selected: herdrHost })!
  bindings.projectWorkspace = projectId => ({ journalPath, placement: terminal.placementFor(projectId) })
  for (const projectId of [undefined, 'general', 'p-one']) {
    const events = await collect(bindings.start(projectId, specFor()))
    expect(events.at(-1)?.kind).toBe('error')
  }
  expect(launches).toEqual([
    { projectId: null, projectWorkspace: { journalPath, placement: { instanceId: 'owner', projectId: null, projectLabel: 'Neutron General', role: 'chat' } } },
    { projectId: 'general', projectWorkspace: { journalPath, placement: { instanceId: 'owner', projectId: 'general', projectLabel: 'Literal General', role: 'chat' } } },
    { projectId: 'p-one', projectWorkspace: { journalPath, placement: { instanceId: 'owner', projectId: 'p-one', projectLabel: 'Same Name', role: 'chat' } } },
  ])
  expect(JSON.parse(JSON.stringify(launches))).toEqual(launches)
})
