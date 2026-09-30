import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import { buildLlmCallSubstrate } from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { createPersistentReplSubstrate, bakedChildSinkInfo, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { ephemeralSessions } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { setNativeChildLiveness } from '@neutronai/runtime/adapters/claude-code/persistent/native-child-liveness.ts'
import { herdrHost, HerdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createProjectWorkspaceHost } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspace-host.ts'
import { ProjectWorkspaceManager, type ProjectPanePlacement } from '@neutronai/runtime/adapters/claude-code/persistent/project-workspaces.ts'
import type { HerdrLayoutPaneNode } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-protocol.ts'
import { FakeHerdrWorkspaceServer, until } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { createConversationTerminal } from '../wiring/project-build-terminal.ts'
import { wireSubstrates } from '../wiring/substrates.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'

/** Real workspace manager + Herdr host + persistent adapter. Only the server and
 * native Claude channel are simulated; assertions inspect actual RPCs and panes. */
class ComposeServer extends FakeHerdrWorkspaceServer {
  channels: Array<ReturnType<typeof Bun.serve>> = []
  messages: string[] = []
  closeMode: 'normal' | 'unknown' | 'lost' = 'normal'
  lostWorkerLayout = false
  workerCloses = 0
  override async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const worker = this.panes.get(String(params['pane_id']))?.label === 'Compose · project documents'
    if (method === 'pane.close' && worker) {
      this.workerCloses++
      if (this.closeMode === 'unknown') throw new Error('close reply unavailable')
      if (this.closeMode === 'lost') {
        await super.call(method, params)
        throw new Error('close applied but reply lost')
      }
    }
    const result = await super.call(method, params)
    if (method === 'layout.apply') {
      const argv = (params['root'] as { command: string[] }).command
      const sessionId = argv[argv.indexOf('--session-id') + 1]
      if (argv.includes('--session-id')) {
        const pane = (result as { layout: { root: { pane_id: string } } }).layout.root.pane_id
        if (this.lostWorkerLayout && params['tab_label'] !== 'Chat') throw new Error('worker layout reply lost')
        const { port, token } = bakedChildSinkInfo(argv)
        const post = async (path: string, body: unknown) => {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token }, body: JSON.stringify(body) })
          if (!response.ok) throw new Error(`channel ${path}: ${response.status}`)
        }
        let turns = 0
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => {
          const path = new URL(req.url).pathname
          if (path === '/health') return Response.json({ ok: true })
          if (path === '/message') {
            const body = await req.json() as { text: string; turn_id: string }
            this.messages.push(body.text)
            if (body.text === 'FAIL') this.panes.delete(pane)
            else if (body.text !== 'HANG') await post('/reply', { session_id: sessionId, turn_id: body.turn_id, text: `turn=${turns++} ${body.text}` })
            return Response.json({ status: 'delivered' })
          }
          return new Response('not found', { status: 404 })
        } })
        this.channels.push(server)
        await post('/channel-ready', { session_id: sessionId, channel_port: server.port, pid: this.panes.get(pane)!.shell_pid })
        await post('/channel-bound', { session_id: sessionId })
      }
    }
    return result
  }
}

const rigs: Array<{ root: string; server: ComposeServer }> = []
// Composition suites can leave a process-wide liveness query over their closed
// database. This fixture has no native child; the refusal control below adds one.
beforeEach(() => setNativeChildLiveness(OWNER_USER_ID, undefined))
afterEach(async () => {
  setNativeChildLiveness(OWNER_USER_ID, undefined)
  for (const rig of rigs) rig.server.closeMode = 'normal'
  await shutdownAllPersistentRepls()
  for (const { root, server } of rigs.splice(0)) {
    for (const channel of server.channels) channel.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

function rig(strict = true) {
  const root = mkdtempSync(join(tmpdir(), 'compose-lifecycle-'))
  const server = new ComposeServer()
  server.screen = '❯ '
  rigs.push({ root, server })
  const journal = join(root, 'workspaces.json')
  const host = createProjectWorkspaceHost(journal, { connect: async () => server, pollIntervalMs: 10, outputGateMaxMs: 1 })
  const placements: ProjectPanePlacement[] = []
  const fallback = new HerdrHost({ connect: async () => server, workspaceId: 'ambient-workspace' })
  const context: OpenWiringContext = {
    llmPool: newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'fixture', kind: 'api_key', secret: 'fixture' }] }),
    owner_handle: 'owner', owner_home: root, project_slug: 'owner', env: {}, db: {} as OpenWiringContext['db'],
    admissionGenerationFor: async () => undefined, prewarmSubstrate: async () => {},
    conversationTerminal: createConversationTerminal({ host: strict ? host : null, instanceId: 'owner', selected: herdrHost,
      projectName: () => 'Same display name' })!,
    substrateFactory: opts => {
      if (opts.projectPlacement !== undefined) placements.push(opts.projectPlacement)
      return createPersistentReplSubstrate({ ...opts, ptyHost: opts.ptyHost ?? fallback,
      skipTrustSeed: true, idleQuietMs: 0, captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
      assertConfig: { readyBudgetMs: 1000, readyIntervalMs: 10, healthBudgetMs: 1000, healthIntervalMs: 10 } })
    },
  }
  return { root, server, journal, placements, wired: wireSubstrates(context) }
}
const spec = (prompt: string): AgentSpec => ({ prompt, tools: [], model_preference: ['sonnet'] })
async function collect(handle: SessionHandle): Promise<Event[]> {
  const events: Event[] = []
  for await (const event of handle.events) events.push(event)
  return events
}

test('production compose is lazy, project placed, toolless, fresh per call and retired while Chat stays warm', async () => {
  const { server, wired } = rig()
  const first = wired.makeComposeSubstrate('one')!
  const second = wired.makeComposeSubstrate('two')!
  expect(server.calls).toHaveLength(0)
  const chat = wired.makeProjectLiveAgentSubstrate('one')!
  expect(await collect(chat.start(spec('chat first')))).toContainEqual({ kind: 'token', text: 'turn=0 chat first' })
  const chatPane = [...server.panes.values()].find(pane => pane.label === 'Chat')!.pane_id
  for (const [substrate, prompt] of [[first, 'first'], [first, 'again'], [second, 'other project']] as const) {
    expect(await collect(substrate.start(spec(prompt)))).toContainEqual({ kind: 'token', text: `turn=0 ${prompt}` })
    await until(() => [...server.panes.values()].every(pane => pane.label !== 'Compose · project documents') ? true : undefined)
    expect(server.panes.has(chatPane)).toBe(true)
  }
  expect(await collect(chat.start(spec('chat second')))).toContainEqual({ kind: 'token', text: 'turn=1 chat second' })
  const layouts = server.workerLayouts()
  expect(layouts).toHaveLength(3)
  expect(layouts[0]!.params['workspace_id']).toBe(layouts[1]!.params['workspace_id'])
  expect(layouts[2]!.params['workspace_id']).not.toBe(layouts[0]!.params['workspace_id'])
  for (const layout of layouts) {
    expect(layout.params['focus']).toBe(false)
    expect(layout.params['tab_label']).toBe('Compose · project documents')
    const argv = (layout.params['root'] as { command: string[] }).command
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
  }
  expect(() => first.start({ ...spec('resume'), session: { id: 'foreign', last_active_at: 1 } })).toThrow('session-less')
})

test.each(['cancel', 'failure', 'lost-close'] as const)('compose %s retires its worker and leaves the Chat placeholder', async mode => {
  const { server, wired } = rig()
  if (mode === 'lost-close') server.closeMode = 'lost'
  const handle = wired.makeComposeSubstrate('one')!.start(spec(mode === 'cancel' ? 'HANG' : mode === 'failure' ? 'FAIL' : 'ok'))
  const draining = collect(handle)
  if (mode === 'cancel') {
    await until(() => server.messages.length > 0 ? true : undefined)
    await handle.cancel()
  }
  const events = await draining
  if (mode === 'failure') expect(events.some(event => event.kind === 'error')).toBe(true)
  await until(() => ephemeralSessions.size === 0 && [...server.panes.values()].every(pane => pane.label === 'Chat') ? true : undefined)
  expect([...server.panes.values()].map(pane => pane.label)).toEqual(['Chat'])
})

test('unconfirmed close retains cleanup identity and configuration until confirmed exit', async () => {
  const { server, wired } = rig()
  server.closeMode = 'unknown'
  await collect(wired.makeComposeSubstrate('one')!.start(spec('ok')))
  const session = [...ephemeralSessions][0]!
  expect(session).toBeDefined()
  const worker = [...server.panes.values()].find(pane => pane.label === 'Compose · project documents')!
  const config = worker.argv[worker.argv.indexOf('--mcp-config') + 1]!
  await until(() => server.workerCloses >= 2 ? true : undefined)
  // Let both bounded termination waits expire. Refusal must still retain cleanup.
  await Bun.sleep(2100)
  expect(session.hasChildExited()).toBe(false)
  expect(ephemeralSessions.has(session)).toBe(true)
  expect(existsSync(config)).toBe(true)
  server.closeMode = 'normal'
  session.child.kill()
  await until(() => !ephemeralSessions.has(session) ? true : undefined)
  expect(session.hasChildExited()).toBe(true)
  expect(existsSync(config)).toBe(false)
}, 10000)

test.each(['unknown', 'normal'] as const)('shutdown preserves unconfirmed compose cleanup or confirms %s closure', async mode => {
  const { server, wired, journal } = rig()
  server.closeMode = 'unknown'
  await collect(wired.makeComposeSubstrate('one')!.start(spec('ok')))
  const session = [...ephemeralSessions][0]!
  expect(session).toBeDefined()
  const worker = [...server.panes.values()].find(pane => pane.label === 'Compose · project documents')!
  const config = worker.argv[worker.argv.indexOf('--mcp-config') + 1]!
  const ownership = readFileSync(journal, 'utf8')
  await until(() => server.workerCloses >= 2 ? true : undefined)
  await Bun.sleep(2100) // The normal finalizer's bounded attempts have expired.
  expect(ephemeralSessions.has(session)).toBe(true)
  server.closeMode = mode
  await shutdownAllPersistentRepls()
  const confirmed = mode === 'normal'
  expect(session.hasChildExited()).toBe(confirmed)
  expect(ephemeralSessions.has(session)).toBe(!confirmed)
  expect(existsSync(config)).toBe(!confirmed)
  expect(server.panes.has(worker.pane_id)).toBe(!confirmed)
  // Shutdown never erases the durable operation receipt/tombstone.
  expect(readFileSync(journal, 'utf8')).toBe(ownership)
  if (!confirmed) {
    server.closeMode = 'normal'
    await shutdownAllPersistentRepls()
    expect(session.hasChildExited()).toBe(true)
    expect(ephemeralSessions.has(session)).toBe(false)
    expect(existsSync(config)).toBe(false)
  }
}, 15000)

test('missing strict manager refuses compose without an ambient layout', async () => {
  const { server, wired } = rig(false)
  const events = await collect(wired.makeComposeSubstrate('one')!.start(spec('ok')))
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('requires a workspace manager') }))
  expect(server.callsTo('layout.apply')).toHaveLength(0)
})

test('lost worker placement records ambiguity and cannot retry that operation as another pane', async () => {
  const { server, wired, journal, placements } = rig()
  server.lostWorkerLayout = true
  const events = await collect(wired.makeComposeSubstrate('one')!.start(spec('ok')))
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('worker layout reply lost') }))
  const rows = JSON.parse(readFileSync(journal, 'utf8')) as Record<string, { workers: Record<string, { state: string }> }>
  expect(Object.values(rows).flatMap(row => Object.values(row.workers).map(worker => worker.state))).toEqual(['ambiguous'])
  expect(server.workerLayouts()).toHaveLength(1)
  const manager = new ProjectWorkspaceManager(journal)
  const root = server.workerLayouts()[0]!.params['root'] as HerdrLayoutPaneNode
  await expect(manager.applyLayout(server, root, placements[0]!)).rejects.toThrow('worker operation ambiguous')
  expect(server.workerLayouts()).toHaveLength(1)
  // The ambiguous worker remains owned in the journal; it is not claimed dead.
  expect([...server.panes.values()].filter(pane => pane.label === 'Compose · project documents')).toHaveLength(1)
})

test('a compose factory pins its project despite conversation metering from another scope', async () => {
  const { wired, placements } = rig()
  await collect(wired.makeComposeSubstrate('target')!.start({ ...spec('ok'),
    metering_context: { conversationProjectId: 'other' } as NonNullable<AgentSpec['metering_context']> }))
  expect(placements).toHaveLength(1)
  expect(placements[0]).toMatchObject({ projectId: 'target', role: 'worker' })
})

test('unresolved native child authority still refuses an ordinary compose turn', async () => {
  const { wired, server } = rig()
  setNativeChildLiveness(OWNER_USER_ID, () => { throw new Error('census unavailable') })
  const events = await collect(wired.makeComposeSubstrate('one')!.start(spec('ok')))
  expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: expect.stringContaining('native child ownership remains unresolved') }))
  expect(server.messages).toEqual([])
  await until(() => ephemeralSessions.size === 0 ? true : undefined)
})

test.each(['warm', 'owner', 'resumable'] as const)('task terminal refuses %s ownership before starting a worker', mode => {
  const worker = buildLlmCallSubstrate({
    pool: newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'fixture', kind: 'api_key', secret: 'fixture' }] }),
    substrate_instance_id: 'task-guard', cwd: '/tmp', ephemeral: mode !== 'warm', ownerConversation: mode === 'owner',
    taskTerminal: { terminal: createConversationTerminal({ host: null, instanceId: 'owner', selected: herdrHost })!,
      projectId: 'one', taskLabel: 'Compose · project documents' },
  })!
  expect(() => worker.start({ ...spec('ok'),
    ...(mode === 'resumable' ? { session: { id: 'foreign', last_active_at: 1 } } : {}),
  })).toThrow('Task terminal requires a disposable session-less worker')
})
