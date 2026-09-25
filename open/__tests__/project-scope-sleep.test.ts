/**
 * #1226 T3 — safe sleep/wake of an owner conversation through the composer's ONE
 * project-scope lifecycle owner.
 *
 * Driven through the production seams: `wireSubstrates` (the live-chat family,
 * which arms/disarms the idle timer), `createProjectScopeLifecycle` (with the pool's
 * real exact retirement), a REAL `ProjectAdmission` over a migrated database (its
 * leases are the awake evidence, read-only), the strict project-workspace host over
 * a scripted Herdr server (the manager's journal and every RPC are production) and
 * the REAL persistent spawn path. Each child is a real dev-channel peer.
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { newCredentialPool, reportFailure, type CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { herdrHost } from '@neutronai/runtime/adapters/claude-code/persistent/herdr-host.ts'
import { createPersistentReplSubstrate, retirePersistentRepl, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { committedDispatches, retiringSessionKeys } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { registerSupervisedSubstrate } from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import { getRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
import { setNativeChildLiveness } from '@neutronai/runtime/adapters/claude-code/persistent/native-child-liveness.ts'
import type { PtyChild, PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import { FakeHerdrWorkspaceServer } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/herdr-workspace-fake-server.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { lifecycleReplHost } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/lifecycle-repl-host.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireSubstrates } from '../wiring/substrates.ts'
import { createConversationTerminal, createWorkerTerminalHost } from '../wiring/project-build-terminal.ts'
import {
  createProjectScopeLifecycle, isInstanceGrantApproval, type ProjectScopeLifecycle, type ProjectScopeLifecycleDeps,
} from '../wiring/project-scope-lifecycle.ts'
import { buildProjectLivenessProbes, type ProjectLivenessSurface } from '../wiring/project-liveness.ts'
import { INSTANCE_GRANT_APPROVALS } from '../composer.ts'
import { HOST_DEPLOY_APPROVAL_TOOL_NAME } from '../host-deploy.ts'
import { mcpServerApprovalToolName } from '@neutronai/gateway/mcp-servers/store.ts'
import { ritualApprovalToolName, ritualEgressApprovalToolName } from '@neutronai/reminders/index.ts'

const dirs: string[] = []
const peers: Array<ReturnType<typeof lifecycleReplHost>> = []
const closers: Array<() => void> = []
afterEach(async () => {
  for (const close of closers.splice(0)) close()
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

type Census = Awaited<ReturnType<ProjectLivenessSurface['census']>>
const censusOf = (verdict: 'idle' | 'busy' | 'unknown', kind = 'participating'): Census => ({
  parent: { kind, sessionKey: 'k', childGeneration: 'g', sessionId: 's', generation: 1, pid: 1 },
  verdict, reasons: [`census ${verdict}`],
  parentTurn: verdict, children: verdict === 'unknown' ? 'unknown' : 'idle', shells: verdict === 'unknown' ? 'unknown' : 'idle',
}) as unknown as Census

/** The strict host places the Chat pane, then the real dev-channel peer serves the
 * child. Killing the child closes its placed pane, as a Herdr child's confirmed
 * `pane.close` does. */
function placedLifecycleHost(server: FakeHerdrWorkspaceServer, strict: PtyHost, peer: PtyHost,
  argvs: string[][]): PtyHost {
  return {
    async spawn(argv, options) {
      argvs.push(argv)
      const placed = await strict.spawn(['claude-stub'], options)
      placed.detach?.()
      const paneHandle = placed.paneHandle!
      const child = await peer.spawn(argv, options)
      return {
        ...child, paneHandle,
        kill(signal?: NodeJS.Signals) {
          if (!child.hasExited()) void server.call('pane.close', { pane_id: paneHandle }).catch(() => {})
          child.kill(signal)
        },
      } satisfies PtyChild
    },
  }
}

interface Rig {
  pool: CredentialPool
  peer: ReturnType<typeof lifecycleReplHost>
  server: FakeHerdrWorkspaceServer
  shells: Set<string>
  admission: ProjectAdmission
  db: ProjectDb
  argvs: string[][]
  registryPath: string
  transcripts: string
  census: { value: Census | Error | undefined }
  approvals: Array<{ topicId: string | null; instanceGrant?: boolean }>
  foreground: Map<string | null, number>
  logged: Array<{ event: string; fields: Record<string, unknown> | undefined }>
  lifecycle: ProjectScopeLifecycle
  wired: ReturnType<typeof wireSubstrates>
  /** A gateway restart: a fresh lifecycle owner and live-chat family (no process memory). */
  restart(): void
  /** The scope provider the live-chat family resolves per turn (`codex` rigs only). */
  provider: { value: 'anthropic' | 'openai-codex' }
  /** Scopes the (fake) durable Codex owner was started for. */
  codexStarts: Array<string | undefined>
}

async function rig(overrides: Partial<ProjectScopeLifecycleDeps> = {}, options: { codex?: boolean } = {}): Promise<Rig> {
  setNativeChildLiveness(OWNER_USER_ID, undefined)
  const root = tempDir('project-scope-sleep-')
  mkdirSync(join(root, 'cwd'))
  const transcripts = join(root, 'transcripts')
  mkdirSync(transcripts)
  seedMigratedDb(join(root, 'db'))
  const db = ProjectDb.open(join(root, 'db'))
  closers.push(() => db.close())
  for (const [id, name] of NAMES) {
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)')
      .run(id, name, Date.now(), Date.now())
  }
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'this-boot' })
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
  const strict = createWorkerTerminalHost(root, { selected: herdrHost, connect: async () => server })!
  const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const sinkPort = reservation.port!
  await reservation.stop(true)
  const pool = newCredentialPool({ strategy: 'round_robin', credentials: [
    { id: 'anthropic:a', kind: 'api_key', secret: 'sk-a' }, { id: 'anthropic:b', kind: 'api_key', secret: 'sk-b' },
  ] })
  const argvs: string[][] = []
  const placedHost = placedLifecycleHost(server, strict, peer.host, argvs)
  const registryPath = join(root, 'repl-registry.json')
  const factory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    const persistent: PersistentReplSubstrateOptions = {
      substrate_instance_id: opts.substrate_instance_id, cwd: join(root, 'cwd'),
      ...(opts.user_id === undefined ? {} : { user_id: opts.user_id }),
      ...(opts.project_id === undefined ? {} : { project_id: opts.project_id }),
      ...(opts.credential_identity === undefined ? {} : { credential_identity: opts.credential_identity }),
      ...(opts.conversationProjectId === undefined ? {} : { conversationProjectId: opts.conversationProjectId }),
      ...(opts.projectPlacement === undefined ? {} : { projectPlacement: opts.projectPlacement }),
      ptyHost: opts.ptyHost === undefined ? peer.host : placedHost,
      replRegistryPath: registryPath,
      skipTrustSeed: true, idleQuietMs: 0, sinkPort,
      // The session's JSONL transcript lands on disk (as `claude` writes it).
      jsonlExistsProbe: sessionId => {
        writeFileSync(join(transcripts, `${sessionId}.jsonl`), '{"type":"user"}\n')
        return true
      },
    }
    registerSupervisedSubstrate(persistent)
    return createPersistentReplSubstrate(persistent)
  }
  const census: Rig['census'] = { value: censusOf('idle') }
  const approvals: Rig['approvals'] = []
  const foreground = new Map<string | null, number>()
  const logged: Rig['logged'] = []
  const provider: Rig['provider'] = { value: 'anthropic' }
  const codexStarts: Rig['codexStarts'] = []
  const codexCtx: Partial<OpenWiringContext> = options.codex !== true ? {} : {
    providerResolver: () => ({ provider: provider.value, source: 'project' }),
    startCodexOwner: (projectId: string | undefined) => {
      codexStarts.push(projectId)
      return {
        events: (async function* () { yield { kind: 'completion' as const, text: 'codex' } as unknown as Event })(),
        tool_resolution: 'internal' as const, async cancel() {}, async respondToTool() {},
      }
    },
  }
  /** One gateway lifetime's lifecycle owner and live-chat family. A restart builds a
   * FRESH pair over the same durable registry, pool and Herdr server. */
  const wire = () => {
    // The manager's journal is durable; its process state is rebuilt per lifetime.
    const conversationTerminal = createConversationTerminal({ host: strict, instanceId: 'owner', projectName, selected: herdrHost })!
    const lifecycle = createProjectScopeLifecycle({
      admission,
      liveness: () => census.value === undefined ? undefined : {
        census: async () => { if (census.value instanceof Error) throw census.value; return census.value! },
      },
      pendingApprovals: () => approvals,
      topicScope: topicId => topicId === 'web:owner' ? { scope: null }
        : topicId?.startsWith('web:owner:') ? { scope: topicId.slice('web:owner:'.length) } : undefined,
      foregroundMs: scope => foreground.get(scope) ?? null,
      conversationTerminal,
      registryPath,
      idleMs: 60_000,
      log: {
        info: (event, fields) => { logged.push({ event, fields }) },
        warn: (event, fields) => { logged.push({ event, fields }) },
      },
      pollMs: 10, waitMs: 5000,
      ...(options.codex === true ? { providerFor: () => provider.value } : {}),
      ...overrides,
    })
    closers.push(() => lifecycle.close())
    const ctx: OpenWiringContext = {
      llmPool: pool, owner_handle: 'owner', owner_home: join(root, 'cwd'), project_slug: 'owner',
      env: {} as NodeJS.ProcessEnv, db: {} as OpenWiringContext['db'],
      admissionGenerationFor: async () => undefined, prewarmSubstrate: async () => {},
      conversationTerminal, conversationLifecycle: lifecycle, substrateFactory: factory,
      ...codexCtx,
    } as OpenWiringContext
    return { lifecycle, wired: wireSubstrates(ctx) }
  }
  const { lifecycle, wired } = wire()
  const r: Rig = {
    pool, peer, server, shells, admission, db, argvs, registryPath, transcripts, census, approvals,
    foreground, logged, lifecycle, wired, provider, codexStarts,
    restart: () => { const next = wire(); r.lifecycle = next.lifecycle; r.wired = next.wired },
  }
  return r
}

const chatLayouts = (r: Rig) => r.server.callsTo('layout.apply').filter(call => call.params['tab_label'] === 'Chat')
const chatCloses = (r: Rig) => r.server.callsTo('pane.close').filter(call => !r.shells.has(String(call.params['pane_id'])))
/** One owner turn, then the pool's committed dispatch leaves (the turn has settled). */
const turn = async (r: Rig, scope: string | null) => {
  const ok = completed(await collect(r.wired.liveAgentSubstrate!.start(specFor(scope))))
  await until(() => [...committedDispatches.values()].every(count => count === 0))
  return ok
}
const livePane = (r: Rig, label = 'Chat') => [...r.server.panes.values()].find(pane => pane.label === label)
const keyOf = (r: Rig, sessionId: string): string | undefined => {
  const found: string[] = []
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    const row = value as Record<string, unknown>
    if (row['sessionId'] === sessionId && typeof row['sessionKey'] === 'string') found.push(row['sessionKey'])
    for (const nested of Object.values(row)) walk(nested)
  }
  walk(JSON.parse(readFileSync(r.registryPath, 'utf8')))
  return found[0]
}

/** Every refusal leaves the Chat exactly as it was. */
function expectUntouched(r: Rig, chatCount = 1) {
  expect(chatCloses(r)).toHaveLength(0)
  expect(r.peer.children.filter(c => !c.child.hasExited())).toHaveLength(chatCount)
  expect(chatLayouts(r)).toHaveLength(chatCount)
}

test('idle retirement: an idle owned Chat sleeps pane-only, keeps its transcript and resumable row, and wakes by --resume in the SAME workspace', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  const first = r.peer.children[0]!
  const pane = livePane(r)!
  const workspace = pane.workspace_id
  await until(() => existsSync(join(r.transcripts, `${first.sessionId}.jsonl`)))
  const key = keyOf(r, first.sessionId)!
  await until(() => getRecord(r.registryPath, key)?.has_session === true)

  const outcome = await r.lifecycle.sleep('p-one')
  expect(outcome).toEqual({ status: 'retired', sessionId: first.sessionId, workspace: 'pane-retired' })
  expect(first.child.hasExited()).toBe(true)
  expect(chatCloses(r).map(call => call.params['pane_id'])).toEqual([pane.pane_id])
  expect(r.server.callsTo('workspace.create')).toHaveLength(1)
  expect(r.server.callsTo('workspace.close')).toHaveLength(0)
  expect(existsSync(join(r.transcripts, `${first.sessionId}.jsonl`))).toBe(true)
  const row = getRecord(r.registryPath, key)!
  expect(row).toEqual(expect.objectContaining({ sessionId: first.sessionId, has_session: true, conversationProjectId: 'p-one' }))
  expect(row.pid).toBeUndefined()
  expect(row.pane_handle).toBeUndefined()
  expect(row.adoption_claim_by).toBeUndefined()
  expect(await r.lifecycle.isAsleep('p-one')).toBe(true)
  expect(r.logged).toContainEqual(expect.objectContaining({ event: 'project_scope_slept' }))

  // Wake is the next admitted dispatch: a fresh Chat at tab zero of the SAME workspace,
  // resuming the SAME conversation.
  expect(await turn(r, 'p-one')).toBe(true)
  expect(r.peer.children).toHaveLength(2)
  expect(r.peer.children[1]!.sessionId).toBe(first.sessionId)
  const resumeArgv = r.argvs[1]!
  expect(resumeArgv[resumeArgv.indexOf('--resume') + 1]).toBe(first.sessionId)
  const chats = chatLayouts(r)
  expect(chats).toHaveLength(2)
  expect(chats[1]!.params['workspace_id']).toBe(workspace)
  expect(r.server.callsTo('workspace.create')).toHaveLength(1)
  expect(await r.lifecycle.isAsleep('p-one')).toBe(false)
})

test('awake refusals from real admission leases: conversation, queuedDispatch, build and liveChild — including a PREVIOUS boot\'s lease', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  const cases: Array<[string, () => Promise<{ release(): Promise<unknown> } | undefined>]> = [
    ['conversation', async () => { const w = await r.admission.admit('p-one', 'conversation', 'chat', 'turn-1'); return w.status === 'admitted' ? w : undefined }],
    ['queuedDispatch', async () => { const w = await r.admission.admit('p-one', 'queuedDispatch', 'wakeup', 'wake-1'); return w.status === 'admitted' ? w : undefined }],
    ['build', async () => { const w = await r.admission.forDispatch('p-one', 'work-board').admit('run-1'); return w.status === 'admitted' ? w : undefined }],
    ['liveChild', async () => { const w = await r.admission.forNativeChild('p-one').admit('run-2', 'step-1'); return w.status === 'admitted' ? w : undefined }],
  ]
  for (const [reason, hold] of cases) {
    const lease = await hold()
    expect(lease).toBeDefined()
    const outcome = await r.lifecycle.sleep('p-one')
    expect(outcome.status).toBe('refused')
    expect((outcome as { reason: string }).reason).toContain(reason)
    expectUntouched(r)
    await lease!.release()
    // A lease for ANOTHER scope never keeps this one awake.
  }
  // A previous gateway's conversation lease survives restart and still refuses.
  const previous = new ProjectAdmission({ db: r.db, ownerHandle: 'owner', bootId: 'previous-boot' })
  const stale = await previous.admit('p-one', 'conversation', 'chat', 'old-turn')
  expect(stale.status).toBe('admitted')
  expect((await r.lifecycle.sleep('p-one')).status).toBe('refused')
  expectUntouched(r)
  await (stale as { release(): Promise<boolean> }).release()
  const other = await r.admission.admit('general', 'build', 'work-board', 'run-other')
  expect(other.status).toBe('admitted')
  expect((await r.lifecycle.sleep('p-one')).status).toBe('retired')
})

test('awake refusals: pending approval, census busy, owner foreground; unattributable approval and uncertain liveness are unknown', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)

  r.approvals.push({ topicId: 'web:owner:p-one' })
  expect(await r.lifecycle.sleep('p-one')).toEqual({ status: 'refused', reason: 'awake: approval' })
  expectUntouched(r)
  r.approvals.splice(0, 1, { topicId: 'telegram:42' })
  expect((await r.lifecycle.sleep('p-one')).status).toBe('unknown')
  expect((await r.lifecycle.awake(null)).status).toBe('unknown')
  expectUntouched(r)
  r.approvals.splice(0)

  r.census.value = censusOf('busy')
  expect(await r.lifecycle.sleep('p-one')).toEqual({ status: 'refused', reason: 'awake: busy' })
  for (const uncertain of [censusOf('unknown', 'ambiguous'), censusOf('idle', 'legacy-unknown'), censusOf('unknown'), new Error('census down'), undefined]) {
    r.census.value = uncertain
    expect((await r.lifecycle.sleep('p-one')).status).toBe('unknown')
  }
  expectUntouched(r)
  r.census.value = censusOf('idle')

  r.foreground.set('p-one', Date.now())
  expect(await r.lifecycle.sleep('p-one')).toEqual({ status: 'refused', reason: 'awake: foreground' })
  expectUntouched(r)
  r.foreground.clear()
  expect((await r.lifecycle.sleep('p-one')).status).toBe('retired')
})

test('a mid-turn owner refuses: sleep never waits a committed turn out and never interrupts it', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  r.peer.holdReplies(() => gate)
  const inFlight = collect(r.wired.liveAgentSubstrate!.start(specFor('p-one')))
  await until(() => r.peer.children[0]!.prompts.length === 2)
  expect(await r.lifecycle.sleep('p-one')).toEqual({ status: 'refused', reason: 'owner still in a turn' })
  expectUntouched(r)
  r.peer.holdReplies()
  release()
  expect(completed(await inFlight)).toBe(true)
  expect(r.peer.children[0]!.child.hasExited()).toBe(false)
})

test('foreign workspace: a changed ownership token refuses BEFORE anything is killed', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  const [workspace] = [...r.server.workspaces.keys()]
  r.server.workspaces.get(workspace!)!.tokens = { neutron_project_owner: 'foreign' }
  const outcome = await r.lifecycle.sleep('p-one')
  expect(outcome.status).toBe('refused')
  expect((outcome as { reason: string }).reason).toContain('ownership mismatch')
  expectUntouched(r)
})

test('unverified slot: a moved Chat pane refuses, nothing is closed', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  const pane = livePane(r)!
  pane.tab_id = 'somewhere-else'
  const outcome = await r.lifecycle.sleep('p-one')
  expect(outcome.status).toBe('refused')
  expect((outcome as { reason: string }).reason).toContain('workspace not verified')
  expectUntouched(r)
})

test('General (null) and the literal project `general` sleep independently', async () => {
  const r = await rig()
  expect(await turn(r, null)).toBe(true)
  expect(await turn(r, 'general')).toBe(true)
  const [general, literal] = r.peer.children
  expect((await r.lifecycle.sleep(null)).status).toBe('retired')
  expect(general!.child.hasExited()).toBe(true)
  expect(literal!.child.hasExited()).toBe(false)
  expect(await r.lifecycle.isAsleep('general')).toBe(false)
  expect((await r.lifecycle.sleep('general')).status).toBe('retired')
  expect(literal!.child.hasExited()).toBe(true)
  expect(r.server.callsTo('workspace.create')).toHaveLength(2)
  expect(r.server.callsTo('workspace.close')).toHaveLength(0)
  expect(await r.lifecycle.sleep(null)).toEqual({ status: 'absent' })
})

test('credential rotation still hands off Chat after a sleep/wake cycle', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  expect((await r.lifecycle.sleep('p-one')).status).toBe('retired')
  expect(await turn(r, 'p-one')).toBe(true)
  reportFailure(r.pool, 'anthropic:a', 429)
  expect(await turn(r, 'p-one')).toBe(true)
  expect(r.peer.children).toHaveLength(3)
  expect(r.peer.children.filter(c => !c.child.hasExited())).toHaveLength(1)
  expect(r.logged).toContainEqual(expect.objectContaining({ event: 'chat_credential_handoff' }))
})

test('idle timer: a settled turn sleeps after idleMs; a dispatch before it fires disarms it', async () => {
  const r = await rig({ idleMs: 150 })
  expect(await turn(r, 'p-one')).toBe(true)
  // A second turn before the timer fires disarms and re-arms it: no close yet.
  await Bun.sleep(60)
  expect(await turn(r, 'p-one')).toBe(true)
  await Bun.sleep(100)
  expect(chatCloses(r)).toHaveLength(0)
  await until(() => chatCloses(r).length === 1, 3000)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
  expect(await r.lifecycle.isAsleep('p-one')).toBe(true)
})

test('restart continuity: a FRESH lifecycle after a gateway restart wakes the slept scope from the durable row — same credential, same session, one Chat', async () => {
  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  const first = r.peer.children[0]!
  const key = keyOf(r, first.sessionId)!
  await until(() => getRecord(r.registryPath, key)?.has_session === true)
  expect((await r.lifecycle.sleep('p-one')).status).toBe('retired')
  // A gateway shutdown with the scope asleep has nothing to hand over or kill.
  await shutdownAllPersistentRepls()
  const row = getRecord(r.registryPath, key)!
  expect(row).toEqual(expect.objectContaining({ sessionId: first.sessionId, has_session: true }))
  expect(typeof row.asleep_at).toBe('number')
  // The restart: no process memory survives. The round-robin pool would hand the next
  // dispatch the OTHER credential; only the durable asleep row pins the old one.
  r.restart()
  expect(await r.lifecycle.isAsleep('p-one')).toBe(true)
  expect(await turn(r, 'p-one')).toBe(true)
  expect(r.peer.children).toHaveLength(2)
  expect(r.peer.children[1]!.sessionId).toBe(first.sessionId)
  const resumeArgv = r.argvs[1]!
  expect(resumeArgv[resumeArgv.indexOf('--resume') + 1]).toBe(first.sessionId)
  expect(keyOf(r, first.sessionId)).toBe(key)
  expect(getRecord(r.registryPath, key)?.asleep_at).toBeUndefined()
  expect(r.peer.children.filter(c => !c.child.hasExited())).toHaveLength(1)
  expect(chatLayouts(r)).toHaveLength(2)
  expect(r.server.callsTo('workspace.create')).toHaveLength(1)
  expect(await r.lifecycle.isAsleep('p-one')).toBe(false)
})

test('race: work admitted after the awake read keeps the Chat — the pool re-reads with the key fenced, lifts its fence and schedules nothing', async () => {
  let lease: { release(): Promise<unknown> } | undefined
  let admissionRef: ProjectAdmission | undefined
  const r = await rig({
    retire: async (sessionKey, sleep) => {
      // A message is admitted between the lifecycle's evidence read and the pool's
      // termination: exactly the window the fenced re-read closes.
      const admitted = await admissionRef!.admit('p-one', 'conversation', 'chat', 'late-turn')
      if (admitted.status === 'admitted') lease = admitted
      return retirePersistentRepl(sessionKey, undefined, sleep)
    },
  })
  admissionRef = r.admission
  expect(await turn(r, 'p-one')).toBe(true)
  const first = r.peer.children[0]!
  const outcome = await r.lifecycle.sleep('p-one')
  expect(outcome).toEqual({ status: 'refused', reason: 'awake: conversation' })
  expect(lease).toBeDefined()
  expectUntouched(r)
  expect(retiringSessionKeys.size).toBe(0)
  const key = keyOf(r, first.sessionId)!
  expect(getRecord(r.registryPath, key)?.asleep_at).toBeUndefined()
  // The admitted turn runs on the SAME Chat, and nothing retires it afterwards.
  expect(await turn(r, 'p-one')).toBe(true)
  await lease!.release()
  await Bun.sleep(100)
  expect(r.peer.children).toHaveLength(1)
  expectUntouched(r)
  expect(first.child.hasExited()).toBe(false)
})

test('instance-grant approvals (no topic, ritual/egress/host-deploy/MCP-server) never keep a scope awake; a topic approval still does', async () => {
  const kinds = INSTANCE_GRANT_APPROVALS
  expect(isInstanceGrantApproval({ topicId: null, toolName: 'anything' }, kinds)).toBe(true)
  for (const toolName of [ritualApprovalToolName('brief'), ritualEgressApprovalToolName('brief'), HOST_DEPLOY_APPROVAL_TOOL_NAME, mcpServerApprovalToolName('files')]) {
    expect(isInstanceGrantApproval({ topicId: 'web:owner:p-one', toolName }, kinds)).toBe(true)
  }
  expect(isInstanceGrantApproval({ topicId: 'web:owner:p-one', toolName: 'Bash' }, kinds)).toBe(false)

  const r = await rig()
  expect(await turn(r, 'p-one')).toBe(true)
  r.approvals.push({ topicId: null, instanceGrant: true }, { topicId: 'telegram:42', instanceGrant: true })
  expect((await r.lifecycle.awake('p-one')).status).toBe('idle')
  expect((await r.lifecycle.awake(null)).status).toBe('idle')
  r.approvals.push({ topicId: 'web:owner:p-one', instanceGrant: false })
  expect(await r.lifecycle.sleep('p-one')).toEqual({ status: 'refused', reason: 'awake: approval' })
  r.approvals.splice(2)
  expect((await r.lifecycle.sleep('p-one')).status).toBe('retired')
})

test('census sessions probe: General and the literal `general` project each read their OWN parent, never both', async () => {
  const r = await rig()
  expect(await turn(r, null)).toBe(true)
  expect(await turn(r, 'general')).toBe(true)
  const [general, literal] = r.peer.children
  const probes = buildProjectLivenessProbes({ admission: r.admission, turnInFlight: () => false })
  const forGeneral = await probes.sessions(null)
  const forLiteral = await probes.sessions('general')
  expect(forGeneral.kind).toBe('answered')
  expect(forLiteral.kind).toBe('answered')
  const ids = (answer: typeof forGeneral) => answer.kind === 'answered' ? answer.live.map(row => row.sessionId) : []
  expect(ids(forGeneral)).toEqual([general!.sessionId])
  expect(ids(forLiteral)).toEqual([literal!.sessionId])
})

test('a gone or placeholder manager sample while the pool shows a live owner is unknown — nothing is killed', async () => {
  for (const status of ['gone', 'placeholder'] as const) {
    const r = await rig({ conversationTerminal: { inspectChat: async () => ({ status }) } })
    expect(await turn(r, 'p-one')).toBe(true)
    const outcome = await r.lifecycle.sleep('p-one')
    expect(outcome.status).toBe('unknown')
    expect((outcome as { reason: string }).reason).toContain(`(${status}) contradicts the live Chat owner`)
    expect(r.peer.children[0]!.child.hasExited()).toBe(false)
    expect(chatCloses(r)).toHaveLength(0)
    await shutdownAllPersistentRepls()
  }
})

test('idle timer re-arms on EVERY exit: a consumer that stops at the completion still leaves the scope to sleep', async () => {
  const r = await rig({ idleMs: 150 })
  const handle = r.wired.liveAgentSubstrate!.start(specFor('p-one'))
  let sawCompletion = false
  for await (const event of handle.events) {
    if (event.kind === 'completion') { sawCompletion = true; break }
  }
  expect(sawCompletion).toBe(true)
  await until(() => [...committedDispatches.values()].every(count => count === 0))
  await until(() => chatCloses(r).length === 1, 3000)
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
  expect(await r.lifecycle.isAsleep('p-one')).toBe(true)
})

test('live provider switch Claude -> Codex: the Claude Chat is handed off RESUMABLY before the Codex owner starts; switching back resumes it', async () => {
  const r = await rig({}, { codex: true })
  expect(await turn(r, 'p-one')).toBe(true)
  const first = r.peer.children[0]!
  const key = keyOf(r, first.sessionId)!
  await until(() => getRecord(r.registryPath, key)?.has_session === true)
  r.provider.value = 'openai-codex'
  expect(completed(await collect(r.wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.codexStarts).toEqual(['p-one'])
  expect(first.child.hasExited()).toBe(true)
  expect(chatCloses(r)).toHaveLength(1)
  expect(getRecord(r.registryPath, key)).toEqual(expect.objectContaining({ sessionId: first.sessionId, asleep_at: expect.any(Number) }))
  expect(r.logged).toContainEqual(expect.objectContaining({ event: 'chat_credential_handoff' }))
  // With no Claude owner, a Codex scope has no exact retirement authority.
  expect(await r.lifecycle.sleep('p-one')).toEqual({ status: 'refused', reason: 'codex owner: no exact retirement authority' })
  r.provider.value = 'anthropic'
  expect(await turn(r, 'p-one')).toBe(true)
  expect(r.peer.children).toHaveLength(2)
  expect(r.peer.children[1]!.sessionId).toBe(first.sessionId)
  const resumeArgv = r.argvs[1]!
  expect(resumeArgv[resumeArgv.indexOf('--resume') + 1]).toBe(first.sessionId)
})

test('Claude -> Codex: a REFUSED handoff is final (non-retryable, reason carried), a busy one retryable; neither starts Codex nor closes the Chat', async () => {
  const r = await rig({ waitMs: 50 }, { codex: true })
  expect(await turn(r, 'p-one')).toBe(true)
  r.provider.value = 'openai-codex'
  r.census.value = { ...censusOf('busy'), parentTurn: 'idle', children: 'busy', shells: 'idle' } as Census
  expect(await collect(r.wired.liveAgentSubstrate!.start(specFor('p-one')))).toEqual([expect.objectContaining({
    kind: 'error', code: 'chat_handoff_refused', retryable: false, message: expect.stringContaining('native child work in progress') })])
  r.census.value = { ...censusOf('busy'), parentTurn: 'idle', children: 'idle', shells: 'busy' } as Census
  expect(await collect(r.wired.liveAgentSubstrate!.start(specFor('p-one')))).toEqual([expect.objectContaining({
    kind: 'error', code: 'chat_handoff_busy', retryable: true })])
  expect(r.codexStarts).toEqual([])
  expectUntouched(r)
  // Control: a positively idle census hands off and starts the Codex owner.
  r.census.value = censusOf('idle')
  expect(completed(await collect(r.wired.liveAgentSubstrate!.start(specFor('p-one'))))).toBe(true)
  expect(r.codexStarts).toEqual(['p-one'])
})

test('Codex refusal is decided by the FOUND owner: a Claude owner left in a scope now set to Codex still sleeps', async () => {
  const r = await rig({}, { codex: true })
  expect(await turn(r, 'p-one')).toBe(true)
  r.provider.value = 'openai-codex'
  const outcome = await r.lifecycle.sleep('p-one')
  expect(outcome).toEqual({ status: 'retired', sessionId: r.peer.children[0]!.sessionId, workspace: 'pane-retired' })
  expect(r.peer.children[0]!.child.hasExited()).toBe(true)
})

test('a live manager Chat that is NOT the pool owner\'s pane is unknown: nothing is killed', async () => {
  const sample: { value: { status: 'none' } | { status: 'live'; pane: string } } = { value: { status: 'none' } }
  const r = await rig({ conversationTerminal: { inspectChat: async () => sample.value } })
  expect(await turn(r, 'p-one')).toBe(true)
  sample.value = { status: 'live', pane: 'some-other-pane' }
  const outcome = await r.lifecycle.sleep('p-one')
  expect(outcome.status).toBe('unknown')
  expect((outcome as { reason: string }).reason).toContain("is not the live owner's pane")
  expect(r.peer.children[0]!.child.hasExited()).toBe(false)
  expect(chatCloses(r)).toHaveLength(0)
})
