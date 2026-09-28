/** A real Open graph consumes its previous gateway's project REPL before any turn. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { LIVE_AGENT_TOOL_NAMES } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import { buildLlmCallSubstrate } from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import { getPersistentReplModel, switchPersistentReplModel } from '@neutronai/runtime/adapters/claude-code/persistent/model-control.ts'
import { writeInstanceModelProvider } from '@neutronai/gateway/storage/owner-metadata.ts'
import { deriveReplSupervisionPaths } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { configuredPtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/configured-pty-host.ts'
import { poolKeyFor } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import { pool, sink, supervisedBySessionKey } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import { authFingerprintFor } from '@neutronai/runtime/adapters/claude-code/persistent/repl-session.ts'
import { deriveChildSinkToken } from '@neutronai/runtime/adapters/claude-code/persistent/sink-coordinates.ts'
import { resetBootAdoptionForTests, setReplToolBridge, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import type { AdoptableHost, PtyChild, PtySpawnOpts } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import type { ReplRegistry, ReplRegistryRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { ProjectScopeLifecycle } from '../wiring/project-scope-lifecycle.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { hasUnresolvedNativeChildForChat, setNativeChildLiveness } from '@neutronai/runtime/adapters/claude-code/persistent/native-child-liveness.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const SESSION = 'cccccccc-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-11112222333344445555666677778888'
const GENERATION = 'survivor-generation'
const HANDLE = 'pane:survivor'
const PID = 31337
const PROJECT = 'survivor-project'
const SECOND_SESSION = 'dddddddd-1111-2222-3333-444444444444'
const SECOND_CHANNEL = 'neutron-aaaabbbbccccddddeeeeffff00001111'
const SECOND_GENERATION = 'second-survivor-generation'
const SECOND_HANDLE = 'pane:second-survivor'
const SECOND_PID = 31338
const SECOND_PROJECT = 'second-project'
const API_KEY = 'sk-ant-synthetic-boot-adoption'
const ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
  'NEUTRON_IDENTITY_JWKS_URL', 'NEUTRON_IDENTITY_AUDIENCE',
  'NEUTRON_CORES_GOOGLE_CLIENT_ID', 'NEUTRON_CORES_GOOGLE_CLIENT_SECRET',
  'NEUTRON_CONNECT_PUBLIC_BASE_URL',
  'NEUTRON_PROJECT_MODELS',
] as const

let savedEnv: Record<string, string | undefined> = {}
let fixtureHome: string
let home: string | undefined
let db: ProjectDb | undefined
let graph: Awaited<ReturnType<typeof composeProductionGraph>> | undefined
let devChannel: ReturnType<typeof Bun.serve> | undefined
let secondDevChannel: ReturnType<typeof Bun.serve> | undefined
let restoreHost: (() => void) | undefined

beforeAll(() => { fixtureHome = mkdtempSync(join(tmpdir(), 'neutron-boot-agent-adoption-')) })
afterAll(() => { rmSync(fixtureHome, { recursive: true, force: true }) })

beforeEach(() => {
  setNativeChildLiveness('owner', undefined)
  resetBootAdoptionForTests()
  // The reply sink is a process singleton. Both gateway lifetimes must use its
  // same durable token path, just as a real restart uses one instance home.
  home = fixtureHome
  savedEnv = {}
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env['NEUTRON_HOME'] = home
  process.env['OWNER_HOME'] = home
  process.env['NEUTRON_DB_PATH'] = join(home, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = API_KEY
  for (const key of ENV_KEYS.slice(7)) delete process.env[key]
})

afterEach(async () => {
  if (graph !== undefined) await graph.shutdown()
  graph = undefined
  await shutdownAllPersistentRepls()
  setReplToolBridge(undefined)
  restoreHost?.()
  restoreHost = undefined
  resetBootAdoptionForTests()
  devChannel?.stop(true)
  devChannel = undefined
  secondDevChannel?.stop(true)
  secondDevChannel = undefined
  // Composition registered this fixture's database as the owner's authority.
  // Remove only that owner before closing it; a later standalone wrapper must
  // not inherit a query against a previous test's closed database.
  setNativeChildLiveness('owner', undefined)
  db?.close()
  db = undefined
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  home = undefined
})

function seedProject(id: string, opts: { deleted?: boolean; provider?: string } = {}): void {
  db!.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at, deleted_at, model_provider)
      VALUES (?, ?, 'private', 'personal', ?, ?, ?, ?)`,
    [id, id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
      opts.deleted ? '2026-01-02T00:00:00Z' : null, opts.provider ?? null],
  )
}

function registryRow(key: string, pane: string, generation: string, port: number,
  identity: { session: string; channel: string; pid: number } = { session: SESSION, channel: CHANNEL, pid: PID }): ReplRegistryRecord {
  return {
    sessionKey: key, sessionId: identity.session, cwd: home!, channelName: identity.channel,
    has_session: true, pane_handle: pane, pid: identity.pid, devchannel_port: port,
    child_generation: generation,
    reuse: {
      tool_surface: LIVE_AGENT_TOOL_NAMES.join(','), tool_bridge: true,
      auth_fingerprint: authFingerprintFor({ ANTHROPIC_API_KEY: API_KEY }, deriveReplSupervisionPaths(home!).sinkTokenPath),
    },
  }
}

function patchHost(holdPane?: string): {
  inspections: string[]; attached: string[]; closed: string[]; spawns: () => number;
  survivor: { attachedVia: string | undefined; outputReleased: boolean };
  second: { attachedVia: string | undefined; outputReleased: boolean };
  entered: Promise<void>; release: () => void;
} {
  // Production's pinned host is a module singleton. Replace just its terminal
  // boundary methods; the composer, adoption pass, sink and graph remain real.
  const host = configuredPtyHost as AdoptableHost
  const originals = {
    spawn: host.spawn, inspectHandle: host.inspectHandle,
    attach: host.attach, closeHandle: host.closeHandle,
  }
  const inspections: string[] = []
  const attached: string[] = []
  const closed: string[] = []
  const survivor: { attachedVia: string | undefined; outputReleased: boolean } = { attachedVia: undefined, outputReleased: false }
  const second: { attachedVia: string | undefined; outputReleased: boolean } = { attachedVia: undefined, outputReleased: false }
  let signalEntered: () => void = () => {}
  let releaseAttach: () => void = () => {}
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  const held = new Promise<void>((resolve) => { releaseAttach = resolve })
  let spawns = 0
  host.spawn = async () => { spawns++; throw new Error('a boot adoption must never launch claude') }
  host.inspectHandle = async (pane) => {
    inspections.push(pane)
    if (pane !== HANDLE && pane !== SECOND_HANDLE) return { kind: 'gone' }
    const identity = pane === HANDLE
      ? { pid: PID, session: SESSION, channel: CHANNEL }
      : { pid: SECOND_PID, session: SECOND_SESSION, channel: SECOND_CHANNEL }
    return {
      kind: 'live', pid: identity.pid, label: 'neutron-repl',
      argv: ['claude', '--resume', identity.session, '--dangerously-load-development-channels', `server:${identity.channel}`],
    }
  }
  host.attach = async (pane: string, opts: PtySpawnOpts): Promise<PtyChild> => {
    attached.push(pane)
    if (pane === holdPane) { signalEntered(); await held }
    const live = pane === SECOND_HANDLE ? second : survivor
    const pid = pane === SECOND_HANDLE ? SECOND_PID : PID
    live.attachedVia = pane
    let exited = false
    let resolveExit: (code: number | null) => void = () => {}
    const exit = new Promise<number | null>((resolve) => { resolveExit = resolve })
    return {
      pid, paneHandle: pane, write() {}, writeKey() {},
      kill() { exited = true; resolveExit(null); live.attachedVia = undefined },
      detach() { live.attachedVia = undefined },
      exited: exit, hasExited: () => exited, wasKilledByUs: () => exited,
      beginOutput() { live.outputReleased = true; opts.onScreen?.('❯ ') },
    }
  }
  host.closeHandle = async (pane) => { closed.push(pane) }
  restoreHost = () => {
    host.spawn = originals.spawn
    host.inspectHandle = originals.inspectHandle
    host.attach = originals.attach
    host.closeHandle = originals.closeHandle
  }
  return { inspections, attached, closed, spawns: () => spawns, survivor, second,
    entered, release: () => releaseAttach() }
}

async function drain(handle: SessionHandle): Promise<string> {
  let answer = ''
  for await (const event of handle.events) {
    if (event.kind === 'token') answer += event.text
    if (event.kind === 'error') throw new Error(event.message)
  }
  return answer
}

async function toolCall(credential: string, callId: string, sessionId = SESSION): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${sink.port}/tool-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sink-Token': credential },
    body: JSON.stringify({ session_id: sessionId, tool_name: 'work_board_add',
      args: { title: `board item ${callId}` }, call_id: callId, project_id: 'forged-project' }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

test('production graph grants two project survivors only after bridge wiring, with no turns or spawns', async () => {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  seedProject(PROJECT)
  seedProject(SECOND_PROJECT)
  seedProject('deleted-project', { deleted: true })
  seedProject('other-provider', { provider: 'openai' })
  seedProject('revoked-project')
  seedProject('dead-project')

  const host = patchHost()
  devChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, session_id: SESSION })
    return new Response('not found', { status: 404 })
  } })
  secondDevChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, session_id: SECOND_SESSION })
    return new Response('not found', { status: 404 })
  } })
  const paths = deriveReplSupervisionPaths(home!)
  mkdirSync(paths.stateDir, { recursive: true })
  const keyFor = (project: string, credential = 'anthropic:ANTHROPIC_API_KEY'): string => poolKeyFor({
    substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner',
    project_id: project, credential_identity: credential,
  })
  const goodKey = keyFor(PROJECT)
  const secondKey = keyFor(SECOND_PROJECT)
  const foreignKey = poolKeyFor({ substrate_instance_id: 'cc-agent-owner', cwd: home!,
    user_id: 'another-owner', project_id: PROJECT, credential_identity: 'anthropic:ANTHROPIC_API_KEY' })
  const deadKey = keyFor('dead-project')
  // Bad candidates precede the good row, defeating first-row/opaque-key guessing.
  const badRows: ReplRegistry = {
    [keyFor('revoked-project', 'anthropic:removed')]: registryRow(keyFor('revoked-project', 'anthropic:removed'), 'pane:revoked', 'gen-revoked', devChannel.port!),
    [keyFor('deleted-project')]: registryRow(keyFor('deleted-project'), 'pane:deleted', 'gen-deleted', devChannel.port!),
    [keyFor('other-provider')]: registryRow(keyFor('other-provider'), 'pane:other-provider', 'gen-other', devChannel.port!),
    [keyFor('absent-project')]: registryRow(keyFor('absent-project'), 'pane:absent', 'gen-absent', devChannel.port!),
    [foreignKey]: registryRow(foreignKey, 'pane:foreign', 'gen-foreign', devChannel.port!),
  }
  const registry: ReplRegistry = { ...badRows,
    [deadKey]: registryRow(deadKey, 'pane:gone', 'gen-gone', devChannel.port!),
    [goodKey]: registryRow(goodKey, HANDLE, GENERATION, devChannel.port!),
    [secondKey]: registryRow(secondKey, SECOND_HANDLE, SECOND_GENERATION, secondDevChannel.port!,
      { session: SECOND_SESSION, channel: SECOND_CHANNEL, pid: SECOND_PID }),
  }
  writeFileSync(paths.replRegistryPath, JSON.stringify(registry, null, 2))

  // Only phase-spec prewarm reaches this seam: adoption itself constructs no
  // adapter and starts no turn. A synthetic substrate avoids a live CLI prewarm.
  const constructed: ClaudeCodeSubstrateOptions[] = []
  const fakeFactory = (options: ClaudeCodeSubstrateOptions): Substrate => {
    constructed.push(options)
    return { start: () => ({
      events: (async function* () { yield { kind: 'completion' as const,
        usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: options.substrate_instance_id } })(),
      respondToTool: async () => {}, cancel: async () => {}, tool_resolution: 'internal',
    }) }
  }
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory: fakeFactory })
  const composition = await composer({ db, project_slug: 'owner' })
  const childCredential = deriveChildSinkToken(sink.token, GENERATION)
  const secondCredential = deriveChildSinkToken(sink.token, SECOND_GENERATION)
  expect(host.inspections).toEqual([])
  expect(host.attached).toEqual([])
  expect(pool.has(goodKey)).toBe(false)
  expect(pool.has(secondKey)).toBe(false)

  const onGraphReady = composition.on_graph_ready
  expect(onGraphReady).toBeDefined()
  let observedInGraphReady = false
  composition.on_graph_ready = async () => {
    // `composeProductionGraph` has installed its REAL MCP bridge when it calls
    // this hook. A dead bridge makes the following authorized tool call fail.
    await onGraphReady!()
    observedInGraphReady = true
    expect(host.survivor.attachedVia).toBe(HANDLE)
    expect(host.survivor.outputReleased).toBe(true)
    expect((await pool.get(goodKey))?.child.pid).toBe(PID)
    expect((await pool.get(goodKey))?.child.paneHandle).toBe(HANDLE)
    expect(host.second.attachedVia).toBe(SECOND_HANDLE)
    expect(host.second.outputReleased).toBe(true)
    expect((await pool.get(secondKey))?.child.pid).toBe(SECOND_PID)
    expect((await pool.get(secondKey))?.child.paneHandle).toBe(SECOND_HANDLE)
    const accepted = await toolCall(childCredential, 'good')
    expect(accepted.status).toBe(200)
    expect(accepted.body['ok']).toBe(true)
    const secondAccepted = await toolCall(secondCredential, 'second', SECOND_SESSION)
    expect(secondAccepted.status).toBe(200)
    expect(secondAccepted.body['ok']).toBe(true)
  }
  try {
    graph = await composeProductionGraph(composition)
    expect(observedInGraphReady).toBe(true)
    const item = db.raw().query('SELECT project_slug, title FROM work_board_items WHERE title = ?')
      .get('board item good') as { project_slug: string; title: string } | null
    expect(item?.project_slug).toBe(PROJECT) // forged body project_id was ignored
    const secondItem = db.raw().query('SELECT project_slug FROM work_board_items WHERE title = ?')
      .get('board item second') as { project_slug: string } | null
    expect(secondItem?.project_slug).toBe(SECOND_PROJECT)
    expect((await toolCall(deriveChildSinkToken(sink.token, 'wrong-generation'), 'wrong')).status).toBe(401)
    for (const row of Object.values(badRows)) {
      expect((await toolCall(deriveChildSinkToken(sink.token, row.child_generation!), row.pane_handle!)).status).toBe(401)
      expect(supervisedBySessionKey.has(row.sessionKey)).toBe(false)
    }
    // This project is authorized, but its durable pane is GONE. Merely finding
    // the row must not arm a watchdog that can spawn a new child at boot.
    expect(host.inspections).toContain('pane:gone')
    expect(supervisedBySessionKey.has(deadKey)).toBe(false)
    expect(pool.has(deadKey)).toBe(false)
    expect(host.attached).toEqual([SECOND_HANDLE, HANDLE])
    expect(host.inspections.length).toBeGreaterThan(0)
    expect(host.inspections.every((pane) => pane === HANDLE || pane === SECOND_HANDLE || pane === 'pane:gone')).toBe(true)
    expect(host.closed).toEqual([])
    expect(host.spawns()).toBe(0)
    expect(constructed.some((opts) => opts.substrate_instance_id.startsWith('cc-agent-'))).toBe(false)
    const persisted = JSON.parse(readFileSync(paths.replRegistryPath, 'utf8')) as ReplRegistry
    for (const [key, row] of Object.entries(badRows)) expect(persisted[key]).toEqual(row)
  } finally {
    for (const cleanup of composition.realmode_cleanups ?? []) await cleanup()
  }
}, 60_000)

test('#1226 a live survivor adopted on boot is never slept over: the lifecycle refuses without closing it or spawning a second Chat', async () => {
  process.env['NEUTRON_DB_PATH'] = join(home!, 'sleep-survivor.db')
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  seedProject(PROJECT)
  const host = patchHost()
  devChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, session_id: SESSION })
    return new Response('not found', { status: 404 })
  } })
  const paths = deriveReplSupervisionPaths(home!)
  mkdirSync(paths.stateDir, { recursive: true })
  const key = poolKeyFor({ substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner',
    project_id: PROJECT, credential_identity: 'anthropic:ANTHROPIC_API_KEY' })
  const row = registryRow(key, HANDLE, GENERATION, devChannel.port!)
  writeFileSync(paths.replRegistryPath, JSON.stringify({ [key]: row }, null, 2))
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory: options => ({
    start: () => ({
      events: (async function* () { yield { kind: 'completion' as const,
        usage: { input_tokens: 0, output_tokens: 0 }, substrate_instance_id: options.substrate_instance_id } })(),
      respondToTool: async () => {}, cancel: async () => {}, tool_resolution: 'internal',
    }),
  }) })
  const composition = await composer({ db, project_slug: 'owner' })
  try {
    graph = await composeProductionGraph(composition)
    expect(host.attached).toEqual([HANDLE])
    expect((await pool.get(key))?.child.pid).toBe(PID)
    // The composer's one lifecycle owner (typed on the composition as its narrower port).
    const lifecycle = composition.project_scope_lifecycle as ProjectScopeLifecycle
    expect(lifecycle).toBeDefined()
    // The adopted survivor IS the scope's one owner: nothing is asleep.
    expect(await lifecycle.isAsleep(PROJECT)).toBe(false)
    const outcome = await lifecycle.sleep(PROJECT)
    // A survivor's idleness is not established by this gateway: a pre-#1237 parent's
    // native children held no leases, so the census reads it `legacy-unknown`, and
    // unknown liveness never licenses closure — it is never retired blind.
    expect(outcome.status).toBe('unknown')
    expect((outcome as { reason: string }).reason).toContain('legacy-unknown')
    expect(host.closed).toEqual([])
    expect(host.spawns()).toBe(0)
    expect(host.survivor.attachedVia).toBe(HANDLE)
    expect((await pool.get(key))?.child.pid).toBe(PID)
    const persisted = (JSON.parse(readFileSync(paths.replRegistryPath, 'utf8')) as ReplRegistry)[key]!
    expect(persisted.pane_handle).toBe(HANDLE)
    expect(persisted.asleep_at).toBeUndefined()
    expect(await lifecycle.isAsleep(PROJECT)).toBe(false)
  } finally {
    for (const cleanup of composition.realmode_cleanups ?? []) await cleanup()
  }
}, 60_000)

test('adoption supplies explicit conversation provenance for General and ordinary project callers', async () => {
  const resolved: Array<[string | undefined, string | undefined]> = []
  const wrapper = buildLlmCallSubstrate({
    pool: newCredentialPool({ strategy: 'fill_first', credentials: [
      { id: 'test', kind: 'api_key', secret: API_KEY },
    ] }),
    substrate_instance_id: 'cc-agent-owner',
    providerResolver: (id, scope) => { resolved.push([id, scope]); return 'openai-codex' },
  })!
  await wrapper.adoptExisting([null, 'general', PROJECT, null])
  expect(resolved).toEqual([
    [undefined, 'conversation'], ['general', 'conversation'], [PROJECT, 'conversation'],
  ])
})

for (const selection of ['general-claude', 'project-claude', 'project-configured', 'legacy-general', 'mismatched-general'] as const) {
test(`production boot isolates General and literal-general survivors (${selection})`, async () => {
  const refused = selection === 'legacy-general' || selection === 'mismatched-general'
  process.env['NEUTRON_DB_PATH'] = join(home!, `${selection}.db`)
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  await writeInstanceModelProvider(db, 'owner', selection === 'project-claude' ? 'openai-codex' : 'anthropic')
  seedProject('general', { provider: selection === 'general-claude' || refused ? 'openai-codex' : 'anthropic' })
  if (selection === 'project-configured') process.env['NEUTRON_PROJECT_MODELS'] = '{"general":"glm"}'
  const host = patchHost()
  devChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return Response.json({ ok: true, session_id: SESSION })
  } })
  secondDevChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return Response.json({ ok: true, session_id: SECOND_SESSION })
  } })
  const paths = deriveReplSupervisionPaths(home!)
  mkdirSync(paths.stateDir, { recursive: true })
  const keyFor = (conversationProjectId: string | null) => poolKeyFor({
    substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner',
    project_id: 'general', conversationProjectId, credential_identity: 'anthropic:ANTHROPIC_API_KEY',
  })
  const generalKey = keyFor(null)
  const projectKey = keyFor('general')
  const legacyKey = poolKeyFor({ substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner',
    project_id: 'general', credential_identity: 'anthropic:ANTHROPIC_API_KEY' })
  const rejectedGeneralKey = selection === 'legacy-general' ? legacyKey : generalKey
  expect(generalKey).not.toBe(projectKey)
  expect(generalKey).not.toBe(legacyKey)
  const generalRow = { ...registryRow(rejectedGeneralKey, HANDLE, GENERATION, devChannel.port!),
    ...(selection === 'legacy-general' ? {} : { conversationProjectId: selection === 'mismatched-general' ? 'general' : null }) }
  writeFileSync(paths.replRegistryPath, JSON.stringify({
    [rejectedGeneralKey]: generalRow,
    [projectKey]: registryRow(projectKey, SECOND_HANDLE, SECOND_GENERATION, secondDevChannel.port!,
      { session: SECOND_SESSION, channel: SECOND_CHANNEL, pid: SECOND_PID }),
  }))
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory: options => ({
    start: () => ({
      events: (async function* () { yield { kind: 'completion' as const,
        usage: { input_tokens: 0, output_tokens: 0 }, substrate_instance_id: options.substrate_instance_id } })(),
      respondToTool: async () => {}, cancel: async () => {}, tool_resolution: 'internal',
    }),
  }) })
  const composition = await composer({ db, project_slug: 'owner' })
  expect(host.attached).toEqual([])
  graph = await composeProductionGraph(composition)
  if (refused) {
    expect(host.attached).toEqual([])
    expect(host.inspections).toEqual([])
    expect(supervisedBySessionKey.has(generalKey)).toBe(false)
    // A mismatched row on the NEW key cannot be relabeled even by a real turn.
    // A legacy row occupies a DIFFERENT key; the fresh-start test exercises its
    // ordinary General turn with a fake child that can complete new turns.
    const wrapper = buildLlmCallSubstrate({
      pool: newCredentialPool({ strategy: 'fill_first', credentials: [
        { id: 'anthropic:ANTHROPIC_API_KEY', kind: 'api_key', secret: API_KEY },
      ] }), substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner', project_slug: 'owner',
      enableToolBridge: true,
    })!
    if (selection === 'mismatched-general') {
      await expect(drain(wrapper.start({ prompt: 'hello', tools: [], model_preference: ['opus'],
        metering_context: { project_id: 'general', conversationProjectId: null },
      }))).rejects.toThrow('conversation scope is ambiguous or mismatched')
    } else {
      // Nor may a legacy caller deliberately request the old ambiguous key.
      await expect(drain(wrapper.start({ prompt: 'hello', tools: [], model_preference: ['opus'],
        metering_context: { project_id: 'general' },
      }))).rejects.toThrow('conversation scope is ambiguous or mismatched')
    }
    expect(pool.has(generalKey)).toBe(false)
    await expect(getPersistentReplModel({ userId: 'owner', projectId: null })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(switchPersistentReplModel({ userId: 'owner', projectId: null }, { sessionId: SESSION, model: 'haiku' }))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect((JSON.parse(readFileSync(paths.replRegistryPath, 'utf8')) as ReplRegistry)[rejectedGeneralKey]).toEqual(generalRow)
    expect(host.attached).toEqual([])
    expect(host.closed).toEqual([])
    expect(host.spawns()).toBe(0)
    return
  }
  const isProject = selection === 'project-claude'
  const selectedKey = isProject ? projectKey : generalKey
  const rejectedKey = isProject ? generalKey : projectKey
  expect(host.attached).toEqual([isProject ? SECOND_HANDLE : HANDLE])
  expect((await pool.get(selectedKey))?.child.paneHandle).toBe(isProject ? SECOND_HANDLE : HANDLE)
  expect(supervisedBySessionKey.get(selectedKey)?.conversationProjectId).toBe(isProject ? 'general' : null)
  expect(pool.has(rejectedKey)).toBe(false)
  expect(supervisedBySessionKey.has(rejectedKey)).toBe(false)
  expect(host.inspections).not.toContain(isProject ? HANDLE : SECOND_HANDLE)
  expect(host.spawns()).toBe(0)
  expect(host.closed).toEqual([])
}, 30_000)
}

test.each([false, true])('the first actual wrapper turn joins an in-flight boot adoption instead of spawning over its pane (unresolved child=%s)', async unresolvedChild => {
  const scope = { user_id: 'owner', conversationProjectId: PROJECT }
  expect(hasUnresolvedNativeChildForChat(scope)).toBe(false)
  const host = patchHost(HANDLE)
  devChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/health') return Response.json({ ok: true, session_id: SESSION })
    if (path === '/message' && request.method === 'POST') {
      if (host.survivor.attachedVia !== HANDLE || !host.survivor.outputReleased) {
        return Response.json({ status: 'not attached' }, { status: 503 })
      }
      const message = await request.json() as { text: string; turn_id?: string }
      void fetch(`http://127.0.0.1:${sink.port}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
          'X-Sink-Token': deriveChildSinkToken(sink.token, GENERATION) },
        body: JSON.stringify({ session_id: SESSION, turn_id: message.turn_id,
          text: `same pane ${host.survivor.attachedVia} pid ${PID}: ${message.text}` }),
      })
      return Response.json({ status: 'delivered' })
    }
    return new Response('not found', { status: 404 })
  } })
  const paths = deriveReplSupervisionPaths(home!)
  mkdirSync(paths.stateDir, { recursive: true })
  const key = poolKeyFor({ substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner',
    project_id: PROJECT, credential_identity: 'anthropic:ANTHROPIC_API_KEY' })
  writeFileSync(paths.replRegistryPath, JSON.stringify({
    [key]: { ...registryRow(key, HANDLE, GENERATION, devChannel.port!),
      reuse: { tool_surface: '', tool_bridge: false,
        auth_fingerprint: authFingerprintFor({ ANTHROPIC_API_KEY: API_KEY }, paths.sinkTokenPath) } },
  }))
  let optionOwner = 'boot-discovery'
  const wrapper = buildLlmCallSubstrate({
    pool: newCredentialPool({ strategy: 'fill_first', credentials: [
      { id: 'anthropic:ANTHROPIC_API_KEY', kind: 'api_key', secret: API_KEY },
    ] }),
    substrate_instance_id: 'cc-agent-owner', cwd: home!, owner_handle: 'owner',
    user_id: 'owner', project_slug: 'owner', projectIdResolver: () => PROJECT,
    extra_env: async () => ({ TEST_OPTION_OWNER: optionOwner }),
  })!
  const adoption = wrapper.adoptExisting([PROJECT])
  // Handshake resolves INSIDE the host's held attach, so adoption is genuinely
  // in flight, rather than a timer-based guess that might pass before it starts.
  await host.entered
  let admission: ProjectAdmission | undefined
  if (unresolvedChild) {
    const admissionPath = join(home!, 'native-child-control.db')
    seedMigratedDb(admissionPath)
    db = ProjectDb.open(admissionPath)
    seedProject(PROJECT)
    admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'adoption-control' })
    expect((await admission.forNativeChild(PROJECT).admit('unresolved-run', 'step')).status).toBe('admitted')
    const authority = admission
    setNativeChildLiveness('owner', projectId => authority.listLeases('liveChild').some(lease => lease.scope.projectId === projectId))
    expect(hasUnresolvedNativeChildForChat(scope)).toBe(true)
  }
  optionOwner = 'first-real-turn'
  let settled = false
  const firstTurn = drain(wrapper.start({ prompt: 'continue my work', tools: [],
    model_preference: ['claude-opus-4-7'] })).then(
      answer => { settled = true; return { answer } },
      error => { settled = true; return { error } },
    )
  try {
    expect(settled).toBe(false)
    expect(host.spawns()).toBe(0)
    for (let attempt = 0; attempt < 200 && !supervisedBySessionKey.has(key); attempt++) await Bun.sleep(1)
    const actualTurnOptions = supervisedBySessionKey.get(key)
    expect(actualTurnOptions?.env?.['TEST_OPTION_OWNER']).toBe('first-real-turn')
    host.release()
    await adoption
    // The proactive pass must not overwrite the actual first turn's freshly
    // resolved options, even though both joined the same held adoption promise.
    expect(supervisedBySessionKey.get(key)).toBe(actualTurnOptions)
    expect(supervisedBySessionKey.get(key)?.env?.['TEST_OPTION_OWNER']).toBe('first-real-turn')
    const result = await firstTurn
    let answer: string
    if (unresolvedChild) {
      expect('error' in result ? String(result.error) : result.answer).toContain('native child ownership remains unresolved')
      expect(admission!.listLeases('liveChild')).toHaveLength(1)
      expect(await admission!.forNativeChild(PROJECT).complete('unresolved-run', 'step')).toBe(1)
      answer = await drain(wrapper.start({ prompt: 'continue my work', tools: [], model_preference: ['claude-opus-4-7'] }))
    } else {
      if ('error' in result) throw result.error
      answer = result.answer
    }
    expect(answer).toContain(`same pane ${HANDLE} pid ${PID}`)
    expect(answer).toContain('continue my work')
    expect(host.attached).toEqual([HANDLE])
    expect(host.spawns()).toBe(0)
    expect((await pool.get(key))?.child.pid).toBe(PID)
  } finally {
    host.release()
  }
}, 30_000)

test('stable credential IDs adopt only when the surviving child still has the current secret', async () => {
  const host = patchHost()
  devChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, session_id: SESSION })
    return new Response('not found', { status: 404 })
  } })
  secondDevChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, session_id: SECOND_SESSION })
    return new Response('not found', { status: 404 })
  } })
  const paths = deriveReplSupervisionPaths(home!)
  mkdirSync(paths.stateDir, { recursive: true })
  const keyForCredential = (credential_identity: string) => poolKeyFor({
    substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner',
    project_id: PROJECT, credential_identity,
  })
  const firstId = 'anthropic:first'
  const secondId = 'anthropic:second'
  const staleId = 'anthropic:rotated'
  const missingId = 'anthropic:missing-fingerprint'
  const unusedId = 'anthropic:no-row'
  const legacyId = 'anthropic:legacy-fingerprint'
  const firstSecret = 'sk-ant-current-first'
  const secondSecret = 'sk-ant-current-second'
  const staleCurrentSecret = 'sk-ant-rotated-new'
  const firstKey = keyForCredential(firstId)
  const secondKey = keyForCredential(secondId)
  const staleKey = keyForCredential(staleId)
  const missingKey = keyForCredential(missingId)
  const legacyKey = keyForCredential(legacyId)
  const rowWithFingerprint = (key: string, pane: string, generation: string, port: number,
    session: string, channel: string, pid: number, secret: string): ReplRegistryRecord => ({
      ...registryRow(key, pane, generation, port, { session, channel, pid }),
      reuse: { tool_surface: '', tool_bridge: true,
        auth_fingerprint: authFingerprintFor({ ANTHROPIC_API_KEY: secret }, paths.sinkTokenPath) },
    })
  const firstRow = rowWithFingerprint(firstKey, HANDLE, GENERATION, devChannel.port!,
    SESSION, CHANNEL, PID, firstSecret)
  const secondRow = rowWithFingerprint(secondKey, SECOND_HANDLE, SECOND_GENERATION, secondDevChannel.port!,
    SECOND_SESSION, SECOND_CHANNEL, SECOND_PID, secondSecret)
  const staleRow = rowWithFingerprint(staleKey, 'pane:stale', 'gen-stale', devChannel.port!,
    'eeeeeeee-1111-2222-3333-444444444444', CHANNEL, 31339, 'sk-ant-rotated-old')
  const missingRow = {
    ...rowWithFingerprint(missingKey, 'pane:missing-hash', 'gen-missing', devChannel.port!,
      'ffffffff-1111-2222-3333-444444444444', CHANNEL, 31340, firstSecret),
    reuse: { tool_surface: '', tool_bridge: true },
  } as ReplRegistryRecord
  // The actual old 16-hex fingerprint of firstSecret, recorded by an older
  // gateway. Even an unchanged current token cannot upgrade this evidence by
  // assertion; only independently verified migration could authorize that row.
  const legacyRow = {
    ...rowWithFingerprint(legacyKey, 'pane:legacy', 'gen-legacy', devChannel.port!,
      'bbbbbbbb-1111-2222-3333-444444444444', CHANNEL, 31341, firstSecret),
    reuse: { tool_surface: '', tool_bridge: true, auth_fingerprint: '50750548bf570144' },
  }
  const badRows = { [staleKey]: staleRow, [missingKey]: missingRow, [legacyKey]: legacyRow }
  writeFileSync(paths.replRegistryPath, JSON.stringify({ ...badRows,
    [firstKey]: firstRow, [secondKey]: secondRow }, null, 2))

  const credentials = newCredentialPool({ strategy: 'round_robin', credentials: [
    { id: firstId, kind: 'api_key', secret: firstSecret },
    { id: secondId, kind: 'api_key', secret: secondSecret },
    { id: staleId, kind: 'api_key', secret: staleCurrentSecret },
    { id: missingId, kind: 'api_key', secret: firstSecret },
    { id: unusedId, kind: 'api_key', secret: 'must never be read' },
    { id: legacyId, kind: 'api_key', secret: firstSecret },
  ] })
  let unmatchedSecretReads = 0
  Object.defineProperty(credentials.credentials[4]!, 'secret', { get() {
    unmatchedSecretReads++
    throw new Error('identity-only discovery read an unmatched secret')
  } })
  const accountingBefore = credentials.credentials.map(({ id, use_count, consecutive_failures, cooldown_until }) =>
    ({ id, use_count, consecutive_failures, cooldown_until }))
  const cursorBefore = credentials.cursor
  const dispatched: Array<{ project_id: string | null | undefined }> = []
  setReplToolBridge({
    listToolSchemas: () => [{ name: 'work_board_add', description: 'capture project', input_schema: { type: 'object' } }],
    dispatch: async (input) => { dispatched.push({ project_id: input.project_id }); return { project_id: input.project_id } },
  })
  const wrapper = buildLlmCallSubstrate({ pool: credentials,
    substrate_instance_id: 'cc-agent-owner', cwd: home!, owner_handle: 'owner',
    user_id: 'owner', project_slug: 'owner', enableToolBridge: true,
  })!
  await wrapper.adoptExisting([PROJECT])
  expect(unmatchedSecretReads).toBe(0)
  expect(credentials.cursor).toBe(cursorBefore)
  expect(credentials.credentials.map(({ id, use_count, consecutive_failures, cooldown_until }) =>
    ({ id, use_count, consecutive_failures, cooldown_until }))).toEqual(accountingBefore)

  // Both currently authorized credential IDs succeed; discovery must not stop
  // after the first matching row or collapse separate credentials into one.
  expect((await pool.get(firstKey))?.child.paneHandle).toBe(HANDLE)
  expect((await pool.get(secondKey))?.child.paneHandle).toBe(SECOND_HANDLE)
  expect((await toolCall(deriveChildSinkToken(sink.token, GENERATION), 'first')).status).toBe(200)
  expect((await toolCall(deriveChildSinkToken(sink.token, SECOND_GENERATION), 'second', SECOND_SESSION)).status).toBe(200)
  expect(dispatched).toEqual([{ project_id: PROJECT }, { project_id: PROJECT }])

  // A rotated secret under the SAME STABLE ID is not the child's credential;
  // missing or legacy fingerprint is unknown, not permission to grant. No pane is
  // inspected, closed, attached, registered, or able to call a tool.
  for (const row of Object.values(badRows)) {
    expect(host.inspections).not.toContain(row.pane_handle)
    expect(host.attached).not.toContain(row.pane_handle)
    expect(host.closed).not.toContain(row.pane_handle)
    expect(pool.has(row.sessionKey)).toBe(false)
    expect(supervisedBySessionKey.has(row.sessionKey)).toBe(false)
    expect((await toolCall(deriveChildSinkToken(sink.token, row.child_generation!), row.pane_handle!, row.sessionId)).status).toBe(401)
  }
  const persisted = JSON.parse(readFileSync(paths.replRegistryPath, 'utf8')) as ReplRegistry
  for (const [key, row] of Object.entries(badRows)) expect(persisted[key]).toEqual(row)
  expect(host.spawns()).toBe(0)
}, 30_000)

test('ambient Claude login retains the deliberately empty auth fingerprint', async () => {
  const host = patchHost()
  devChannel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true, session_id: SESSION })
    return new Response('not found', { status: 404 })
  } })
  const paths = deriveReplSupervisionPaths(home!)
  mkdirSync(paths.stateDir, { recursive: true })
  const key = poolKeyFor({ substrate_instance_id: 'cc-agent-owner', cwd: home!, user_id: 'owner',
    project_id: PROJECT, credential_identity: 'anthropic:ambient' })
  const row: ReplRegistryRecord = { ...registryRow(key, HANDLE, GENERATION, devChannel.port!),
    reuse: { tool_surface: '', tool_bridge: true, auth_fingerprint: '' } }
  writeFileSync(paths.replRegistryPath, JSON.stringify({ [key]: row }))
  setReplToolBridge({ listToolSchemas: () => [], dispatch: async () => ({ ambient: true }) })
  const wrapper = buildLlmCallSubstrate({
    pool: newCredentialPool({ strategy: 'fill_first', credentials: [
      { id: 'anthropic:ambient', kind: 'ambient', secret: '' },
    ] }),
    substrate_instance_id: 'cc-agent-owner', cwd: home!, owner_handle: 'owner',
    user_id: 'owner', project_slug: 'owner', enableToolBridge: true,
  })!
  await wrapper.adoptExisting([PROJECT])
  expect((await pool.get(key))?.child.paneHandle).toBe(HANDLE)
  expect(host.spawns()).toBe(0)
  expect((await toolCall(deriveChildSinkToken(sink.token, GENERATION), 'ambient')).status).toBe(200)
}, 30_000)
