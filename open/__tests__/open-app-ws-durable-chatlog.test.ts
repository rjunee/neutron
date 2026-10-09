/**
 * Open app-ws DURABLE CHAT-LOG + real typing — the anti-"built-but-not-wired"
 * gate for the Telegram-class chat transport (Ryan-directed, 2026-06-29).
 *
 * THE ROOT CAUSE this guards: Open's composer constructed the app-ws adapter
 * with NO durable logs (`new AppWsAdapter({ registry, receiver })`), so the
 * fully-built seq/resume/idempotency/receipt machinery was inert in M1 —
 * `hasChatLog === false` everywhere. The fix wires the four per-topic logs
 * (`AppChatStore`/`AppChatReceiptStore`/`AppChatReactionStore`/`AppChatEditStore`,
 * all on the single-owner project.db) onto the adapter, and adds a
 * server-authoritative `agent_typing` frame around every live-agent turn.
 *
 * This boots the REAL Open composition over a live `Bun.serve`, opens the
 * unified `/ws/app/chat` socket, and asserts — on REAL turns (mocked substrate,
 * synthetic credential so the live-agent path composes) — that:
 *   #1 every user echo + agent reply is persisted to `app_chat_messages` and
 *      carries a monotonic per-topic `seq` on the wire;
 *   #2 a re-sent `client_msg_id` is de-duped — the agent turn does NOT re-run
 *      (the double-dispatch guard trips), no second durable row, no 2nd reply;
 *   #3 a reconnecting / second socket resumes from `after_seq` and gets a
 *      gap-free replay of the persisted transcript; `session_ready` carries
 *      `last_seen_seq`;
 *   #4 the server records + fans a `receipt_update` (the agent-read receipt) for
 *      a freshly-received user message;
 *   #5 the HTTP `/api/app/chat/send` fallback returns the echo (with seq)
 *      IMMEDIATELY — it does NOT block on the (delayed) agent turn;
 *   #6 a real `agent_typing` start→end bracket fans to the socket around the
 *      turn.
 *
 * The substrate is MOCKED (no real `claude`); a synthetic credential makes the
 * live-agent path compose. Non-reminder turns sleep `STEADY_TURN_DELAY_MS` so
 * the fire-and-forget HTTP proof (#5) is deterministic.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { drainRealmodeCleanups } from '@neutronai/gateway/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import * as ambientAuth from '../ambient-claude-auth.ts'
import * as capacity from '@neutronai/runtime/workers/claude-capacity-client.ts'
import { CodexOwnerBindings } from '../wiring/codex-owner-binding.ts'
import { CodexOwnerControls } from '../wiring/codex-owner-controls.ts'
import * as durableOwner from '../wiring/codex-durable-owner.ts'
import { restrictedOwnerFixture } from './fixtures/codex-owner-review.ts'
import { attachCodexOwner } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { readOwnerHelperDescriptor } from '@neutronai/runtime/adapters/codex-cli/persistent/project-owner-helper-protocol.ts'
import { CodexCredentialService } from '@neutronai/trident/codex-credential.ts'
import { WebReplModelClient } from '@neutronai/landing/chat-react/repl-model-client.ts'
import { SqliteProjectSettingsStore } from '@neutronai/gateway/projects/sqlite-store.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const AGENT_REPLY_BODY = 'CHATLOG_TURN_REPLY_OK'
/** Delay the mocked steady-state turn so fire-and-forget (#5) is observable. */
const STEADY_TURN_DELAY_MS = 500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
  // A LIVE instance's identity config leaks in through `process.env` when the
  // suite runs on a provisioned box: `NEUTRON_IDENTITY_JWKS_URL` puts the app-ws
  // auth resolver in `jwks` mode, which rejects the `dev:owner` bearer this
  // harness connects with (`channels/adapters/app-ws/auth.ts`), and all six
  // tests here fail at `ws.onerror`. The two sibling app-ws harnesses that cite
  // this file as their pattern source already scrub both.
  'NEUTRON_IDENTITY_JWKS_URL', 'NEUTRON_IDENTITY_AUDIENCE',
  'OPENAI_API_KEY', 'NEUTRON_MODEL_PROVIDER', 'NEUTRON_PROJECT_MODELS',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

type Composition = Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
interface Harness {
  base: string
  db: ProjectDb
  composition: Composition
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  /** Memoized: a repeat call returns the first teardown, so it never drains twice. */
  close(): Promise<void>
}
let harness: Harness | null = null

/** Mock substrate: a distinctive reply body; non-reminder turns sleep so the
 *  HTTP fire-and-forget proof can observe the response returning first. */
function recordingSubstrate(): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      const isReminder = spec.prompt.includes('reminder agent')
      const out = isReminder ? 'ok' : AGENT_REPLY_BODY
      async function* gen(): AsyncGenerator<Event> {
        if (!isReminder) await sleep(STEADY_TURN_DELAY_MS)
        yield { kind: 'token', text: out }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

let unregisteredRoute: ReturnType<typeof spyOn>
beforeEach(() => {
  // Synthetic self-host credentials and offline boots cannot inherit a host route.
  unregisteredRoute = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-chatlog-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-chatlog'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
  delete process.env['NEUTRON_IDENTITY_JWKS_URL']
  delete process.env['NEUTRON_IDENTITY_AUDIENCE']
})

afterEach(async () => {
  unregisteredRoute.mockRestore()
  if (harness !== null) { await harness.close(); harness = null }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

async function startHarness(options: { nativeProject?: boolean; typingProject?: boolean } = {}): Promise<Harness> {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  if (options.nativeProject !== undefined) await new SqliteProjectSettingsStore(db).update('owner', 'native-project', {
    name: 'Native project', model_provider: options.nativeProject ? 'openai-codex' : 'anthropic',
  })
  if (options.typingProject) await new SqliteProjectSettingsStore(db).update('owner', 'typing-project', {
    name: 'Typing project',
  })
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: () => recordingSubstrate(),
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) throw new Error('no fetch/ws')
  const server = Bun.serve({ port: 0, fetch: (req, srv) => graph.fetch!(req, srv), websocket: graph.websocket })
  let closing: Promise<void> | null = null
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    composition,
    graph,
    close: () => (closing ??= (async () => {
      await server.stop(true)
      // AWAIT the production drain (forward order, continue-after-rejection) so
      // every composed loop's in-flight tick settles BEFORE the DB closes. The
      // list is read at close time: the quiesce regressions below edit it in place.
      await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
      try {
        await graph.shutdown()
      } finally {
        db.close()
      }
    })()),
  }
}

interface OpenSocket {
  ws: WebSocket
  frames: Array<Record<string, unknown>>
  close(): void
}

async function openSocket(base: string, query = 'token=dev:owner&platform=web&device_id=devA'): Promise<OpenSocket> {
  const wsUrl = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/app/chat?${query}`)
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))) } catch { /* */ } }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
  })
  return { ws, frames, close: () => ws.close() }
}

const framesOfType = (frames: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> =>
  frames.filter((f) => f['type'] === type)

describe('Open app-ws durable chat-log + typing (real instance)', () => {
  test('browser client consumes native model epoch acknowledgements through the composed Open route', async () => {
    const projectId = 'native-project'
    const cwd = join(tmpDir, 'Projects', projectId)
    mkdirSync(cwd, { recursive: true })
    // Only the subscription lookup and native process launch are fixtures. The
    // production owner binding, controls, helper transport and HTTP route execute.
    const native = await restrictedOwnerFixture({ projectId, cwd, async execute() {} })
    const credential = spyOn(CodexCredentialService.prototype, 'resolveProjectOwnerCredential').mockImplementation((_owner, id) => {
      expect(id).toBe(projectId)
      return { codexHome: native.codexHome, credentialIdentity: 'fixture' }
    })
    const launch = spyOn(durableOwner, 'openDurableCodexOwner').mockImplementation(async options => {
      expect(options.projectId).toBe(projectId)
      expect(options.cwd).toBe(cwd)
      const descriptorPath = join(native.codexHome, '..', 'helper.json')
      return attachCodexOwner({ descriptorPath, expected: readOwnerHelperDescriptor(descriptorPath).facts })
    })
    let socket: OpenSocket | undefined
    try {
      harness = await startHarness({ nativeProject: true })
      const client = new WebReplModelClient({ base_url: harness.base, token: 'dev:owner' })
      await expect(client.current(projectId)).rejects.toThrow()
      expect(launch).not.toHaveBeenCalled()
      socket = await openSocket(harness.base, `token=dev:owner&platform=web&device_id=native-model&project_id=${projectId}`)
      await waitFor(() => framesOfType(socket!.frames, 'session_ready').length > 0)
      socket.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'start native model conversation', client_msg_id: 'native-model-start' }))
      await waitFor(() => framesOfType(socket!.frames, 'agent_message').some(frame => String(frame.body).includes('dispatch complete')))
      const before = await client.current(projectId)
      expect(before).toMatchObject({ harness: 'codex', currentModel: 'small', status: 'ready' })
      expect(before.conversationId).toBeTruthy()
      const after = await client.switch(projectId, 'large', before.sessionId)
      expect(after.currentModel).toBe('large')
      expect(after.conversationId).toBe(before.conversationId)
      expect(after.sessionId).not.toBe(before.sessionId)
      const switches = () => native.native.filter(message => message.method === 'thread/settings/update')
      expect(switches()).toHaveLength(1)
      await expect(client.switch(projectId, 'small', before.sessionId)).rejects.toThrow('Refresh before switching')
      const unauthenticated = new WebReplModelClient({ base_url: harness.base, token: 'invalid' })
      await expect(unauthenticated.switch(projectId, 'small', after.sessionId)).rejects.toThrow()
      await expect(client.switch('missing-project', 'small', after.sessionId)).rejects.toThrow()
      expect(switches()).toHaveLength(1)
      const second = await client.switch(projectId, 'small', after.sessionId)
      expect(second.currentModel).toBe('small')
      expect(second.conversationId).toBe(before.conversationId)
      expect(second.sessionId).not.toBe(after.sessionId)
      expect(switches()).toHaveLength(2)
      expect(launch).toHaveBeenCalledTimes(1)
    } finally {
      socket?.close()
      if (harness) { await harness.close(); harness = null }
      launch.mockRestore(); credential.mockRestore()
      await native.close()
    }
  }, 30_000)

  test('composed native model and turn-control routes require owner scope and share the selected project binding', async () => {
    const calls: unknown[][] = []
    const identity = { projectId: 'native-project', threadId: 'native-thread', bindingRevision: 'revision', generation: 1, epoch: 2, turnId: 'turn' }
    const model = spyOn(CodexOwnerControls.prototype, 'model').mockImplementation(async (...args) => {
      calls.push(['model', ...args])
      return { harness: 'codex', sessionId: 'conditional-native-state', currentModel: args[1]?.model ?? 'small', availableModels: [{ id: 'small', label: 'Small' }, { id: 'large', label: 'Large' }], status: 'ready' }
    })
    const read = spyOn(CodexOwnerControls.prototype, 'state').mockImplementation(async projectId => {
      calls.push(['state', projectId]); return { ...identity, status: 'turn', pending: [] }
    })
    const act = spyOn(CodexOwnerControls.prototype, 'act').mockImplementation(async (...args) => {
      calls.push(['act', ...args]); return { ...identity, status: 'idle', pending: [] }
    })
    try {
      harness = await startHarness({ nativeProject: true })
      const request = (path: string, body?: unknown, token = 'dev:owner') => fetch(`${harness!.base}/api/app/projects/${path}`, {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      })
      expect((await request('native-project/repl-model', undefined, 'invalid')).status).toBe(401)
      expect((await request('missing/repl-control')).status).toBe(404)
      expect(calls).toHaveLength(0)
      expect(await (await request('native-project/repl-model')).json()).toMatchObject({ currentModel: 'small' })
      expect(await (await request('native-project/repl-model', { model: 'large', sessionId: 'conditional-native-state' })).json()).toMatchObject({ currentModel: 'large' })
      expect((await request('native-project/repl-control')).status).toBe(200)
      expect((await request('native-project/repl-control', { ...identity, action: 'interrupt' })).status).toBe(200)
      expect(calls).toEqual([
        ['model', 'native-project'], ['model', 'native-project', { model: 'large', sessionId: 'conditional-native-state' }],
        ['state', 'native-project'], ['act', 'native-project', { ...identity, action: 'interrupt' }],
      ])
    } finally { model.mockRestore(); read.mockRestore(); act.mockRestore() }
  }, 30_000)

  for (const nativeProject of [false, true]) test(`credential-less composed chat uses ${nativeProject ? 'the selected native project' : 'the honest Claude-null refusal'}`, async () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.NEUTRON_PROJECT_MODELS
    process.env.NEUTRON_MODEL_PROVIDER = 'anthropic'
    const ambient = spyOn(ambientAuth, 'detectAmbientClaudeAuthCached').mockReturnValue(false)
    const nativeCalls: Array<string | undefined> = []
    let nativeOwner: CodexOwnerBindings | undefined
    const native = spyOn(CodexOwnerBindings.prototype, 'start').mockImplementation(function (this: CodexOwnerBindings, projectId, spec) {
      nativeOwner = this
      nativeCalls.push(projectId)
      return recordingSubstrate().start(spec)
    })
    let socket: OpenSocket | undefined
    let mobile: OpenSocket | undefined
    try {
      harness = await startHarness({ nativeProject })
      socket = await openSocket(harness.base, 'token=dev:owner&platform=web&device_id=native&project_id=native-project')
      await waitFor(() => framesOfType(socket!.frames, 'session_ready').length > 0)
      socket.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'native chat intake', client_msg_id: 'native-ws' }))
      await waitFor(() => framesOfType(socket!.frames, 'agent_message').length > 0)
      const reply = framesOfType(socket.frames, 'agent_message').map(frame => String(frame.body)).join('\n')
      if (nativeProject) {
        expect(reply).toContain(AGENT_REPLY_BODY)
        expect(nativeCalls).toEqual(['native-project'])
        await nativeOwner!.onOwnerQuestion!('native-project', { requestId: 'native-approval', method: 'item/commandExecution/requestApproval',
          params: { threadId: 'native-thread', turnId: 'native-turn', command: 'echo bounded', reason: 'Native owner needs a decision' } })
        await waitFor(() => framesOfType(socket!.frames, 'agent_message').some(frame => String(frame.body).includes('Native owner needs a decision')))
        const question = framesOfType(socket.frames, 'agent_message').find(frame => String(frame.body).includes('Native owner needs a decision'))!
        expect(question.body).toContain('echo bounded')
        expect(question.seq).toBeGreaterThan(0)
        expect(question.project_id).toBe('native-project')
        mobile = await openSocket(harness.base, 'token=dev:owner&platform=ios&device_id=native-mobile')
        await waitFor(() => framesOfType(mobile!.frames, 'session_ready').length > 0)
        const response = await fetch(`${harness.base}/api/app/chat/send`, { method: 'POST',
          headers: { authorization: 'Bearer dev:owner', 'content-type': 'application/json' },
          body: JSON.stringify({ body: 'native HTTP intake', client_msg_id: 'native-http', project_id: 'native-project' }) })
        expect(response.status).toBe(200)
        await waitFor(() => nativeCalls.length === 2)
        expect(nativeCalls).toEqual(['native-project', 'native-project'])
        await waitFor(() => framesOfType(mobile!.frames, 'agent_message').some(frame => String(frame.body).includes(AGENT_REPLY_BODY)))
      } else {
        expect(reply).toContain('no AI credential configured')
        expect(nativeCalls).toEqual([])
      }
    } finally { socket?.close(); mobile?.close(); native.mockRestore(); ambient.mockRestore() }
  }, 30_000)

  test('connect-time typing is targeted, non-durable, and leaves the next turn usable', async () => {
    harness = await startHarness({ typingProject: true })
    const projectQuery = 'token=dev:owner&platform=web&device_id=devA&project_id=typing-project'
    const first = await openSocket(harness.base, projectQuery)
    await waitFor(() => framesOfType(first.frames, 'session_ready').length > 0)
    // Negative case: a quiet topic does not manufacture a typing INDICATOR on
    // connect. It DOES now answer explicitly, and the distinction is the whole
    // point of the reconnect snapshot: `end` turns an indicator off, `start`
    // turns one on. This assertion used to demand silence, which was correct
    // only while silence was the sole way to avoid a spurious indicator — and
    // silence is exactly what strands a client that missed the real `end` while
    // disconnected, because nothing ever contradicts its stale belief.
    //
    // So the property is asserted rather than the old spelling: NO `start` for a
    // quiet topic, and the explicit idle answer present and scoped to this topic.
    const connectFrames = framesOfType(first.frames, 'agent_typing')
    expect(connectFrames.filter((f) => f['state'] === 'start')).toEqual([])
    expect(connectFrames.map((f) => f['state'])).toEqual(['end'])
    expect(connectFrames[0]?.['project_id']).toBe('typing-project')

    first.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'long turn', client_msg_id: 'catchup-1' }))
    await waitFor(() => framesOfType(first.frames, 'agent_typing').some((f) => f['state'] === 'start'))

    const second = await openSocket(
      harness.base,
      'token=dev:owner&platform=web&device_id=devB&project_id=typing-project',
    )
    await waitFor(() => framesOfType(second.frames, 'agent_typing').some((f) => f['state'] === 'start'))
    await waitFor(() => framesOfType(second.frames, 'agent_typing').some((f) => f['state'] === 'end'))

    // Catch-up is not a refcount transition: after the real end, another real
    // turn must still produce a new visible start on this same socket.
    const startsBefore = framesOfType(second.frames, 'agent_typing').filter((f) => f['state'] === 'start').length
    first.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'next turn', client_msg_id: 'catchup-2' }))
    await waitFor(
      () => framesOfType(second.frames, 'agent_typing').filter((f) => f['state'] === 'start').length > startsBefore,
    )
    await waitFor(() => framesOfType(second.frames, 'agent_typing').filter((f) => f['state'] === 'end').length >= 2)

    // Construct a positive replay, then prove the ephemeral frame is absent.
    const replay = await openSocket(
      harness.base,
      'token=dev:owner&platform=web&device_id=devC&project_id=typing-project',
    )
    await waitFor(() => framesOfType(replay.frames, 'session_ready').length > 0)
    replay.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))
    await waitFor(() => framesOfType(replay.frames, 'agent_message').length > 0)
    // The property is that typing is EPHEMERAL — never stored, never replayed.
    // The connect-time snapshot below is a LIVE frame answering "is a turn
    // running right now", so it is not a counter-example to that; the durable
    // check immediately after is the one that proves it, straight off the table.
    // Asserting silence here would now fail on the snapshot and say nothing about
    // durability, which is the thing worth guarding.
    const replayTyping = framesOfType(replay.frames, 'agent_typing')
    expect(replayTyping.map((f) => f['state'])).toEqual(['end'])
    const durableTyping = harness.db.raw()
      .query("SELECT count(*) c FROM app_chat_messages WHERE topic_id = 'app:owner:typing-project' AND body LIKE '%agent_typing%'")
      .get() as { c: number }
    expect(durableTyping.c).toBe(0)

    first.close(); second.close(); replay.close()
    await sleep(50)
  }, 30_000)

  test('#1/#4/#6 a real turn persists with seq, fans receipts + typing', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)

    // session_ready first.
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)

    // Send a real user message; wait for the agent reply to settle.
    sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hello one', client_msg_id: 'c-1' }))
    await waitFor(() =>
      framesOfType(sock.frames, 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    )

    // #1 — the user echo carries a monotonic seq + matching client_msg_id.
    const echo = framesOfType(sock.frames, 'user_message').find((f) => f['client_msg_id'] === 'c-1')
    expect(echo).toBeDefined()
    expect(typeof echo!['seq']).toBe('number')
    expect((echo!['seq'] as number) > 0).toBe(true)

    // #1 — persisted to the durable log under the owner's app topic.
    const userRow = harness.db.raw()
      .query("SELECT seq, role, body FROM app_chat_messages WHERE topic_id = 'app:owner' AND client_msg_id = 'c-1'")
      .all() as Array<{ seq: number; role: string; body: string }>
    expect(userRow.length).toBe(1)
    expect(userRow[0]!.role).toBe('user')

    // #1 — the agent reply is also persisted (agent role) with its own seq.
    const agentRows = harness.db.raw()
      .query("SELECT seq FROM app_chat_messages WHERE topic_id = 'app:owner' AND role = 'agent'")
      .all() as Array<{ seq: number }>
    expect(agentRows.length).toBeGreaterThan(0)

    // #6 — a server-authoritative typing bracket fanned around the turn.
    const typing = framesOfType(sock.frames, 'agent_typing')
    expect(typing.some((f) => f['state'] === 'start')).toBe(true)
    await waitFor(() => framesOfType(sock.frames, 'agent_typing').some((f) => f['state'] === 'end'))

    // #4 — the agent-read receipt fanned for the user's message.
    const receipts = framesOfType(sock.frames, 'receipt_update')
    expect(receipts.some((f) => Array.isArray(f['read_by']) && (f['read_by'] as string[]).includes('agent'))).toBe(true)

    sock.close()
    await sleep(50)
  }, 30_000)

  test('#2 a re-sent client_msg_id does NOT re-run the agent turn', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)

    const agentRowCount = (): number =>
      (harness!.db.raw()
        .query("SELECT count(*) c FROM app_chat_messages WHERE topic_id = 'app:owner' AND role = 'agent'")
        .get() as { c: number }).c

    // A fresh owner's on_session_open seeds an onboarding opener turn that lands
    // its OWN agent row asynchronously. Let it settle so it can't be mistaken
    // for a re-dispatch below (quiesce: agent row count stable for a beat).
    await sleep(STEADY_TURN_DELAY_MS + 600)
    let stable = agentRowCount()
    await waitFor(() => {
      const now = agentRowCount()
      if (now === stable) return true
      stable = now
      return false
    }, 6_000)

    // First real send of the client_msg_id → exactly one new agent reply.
    sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'dedup me', client_msg_id: 'dup-1' }))
    await waitFor(() => agentRowCount() === stable + 1)
    const baseline = agentRowCount()

    // Re-send the SAME client_msg_id (offline-queue flush / double-tap / WS↔HTTP
    // race). Give the (would-be) second turn ample time to fire if broken.
    sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'dedup me', client_msg_id: 'dup-1' }))
    await sleep(STEADY_TURN_DELAY_MS + 800)

    // Exactly ONE durable user row for the client_msg_id (idempotent append) …
    const userRows = harness.db.raw()
      .query("SELECT count(*) c FROM app_chat_messages WHERE topic_id = 'app:owner' AND client_msg_id = 'dup-1'")
      .get() as { c: number }
    expect(userRows.c).toBe(1)
    // … and the agent turn did NOT re-run (the double-dispatch guard tripped).
    expect(agentRowCount()).toBe(baseline)

    sock.close()
    await sleep(50)
  }, 30_000)

  test('#3 a reconnecting socket resumes a gap-free transcript', async () => {
    harness = await startHarness()
    const sock1 = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock1.frames, 'session_ready').length > 0)
    sock1.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'persist me', client_msg_id: 'r-1' }))
    await waitFor(() =>
      framesOfType(sock1.frames, 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    )
    sock1.close()
    await sleep(50)

    // A fresh socket (reconnect / 2nd device) — session_ready carries the
    // current high-water seq, then a resume from 0 replays the whole transcript.
    const sock2 = await openSocket(harness.base, 'token=dev:owner&platform=web&device_id=devB')
    await waitFor(() => framesOfType(sock2.frames, 'session_ready').length > 0)
    const ready = framesOfType(sock2.frames, 'session_ready')[0]!
    expect(typeof ready['last_seen_seq']).toBe('number')
    expect((ready['last_seen_seq'] as number) > 0).toBe(true)

    const beforeResume = sock2.frames.length
    sock2.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))
    // The replay re-emits the persisted user echo + agent reply to THIS socket.
    await waitFor(() =>
      sock2.frames.slice(beforeResume).some(
        (f) => f['type'] === 'user_message' && f['client_msg_id'] === 'r-1',
      ),
    )
    const replayed = sock2.frames.slice(beforeResume)
    expect(replayed.some((f) => f['type'] === 'user_message' && f['client_msg_id'] === 'r-1')).toBe(true)
    expect(
      replayed.some(
        (f) => f['type'] === 'agent_message' && typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    ).toBe(true)

    sock2.close()
    await sleep(50)
  }, 30_000)

  test('#5 HTTP /api/app/chat/send returns the echo immediately (fire-and-forget)', async () => {
    harness = await startHarness()
    // A live socket to observe the agent reply arriving AFTER the HTTP response.
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)

    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:owner', 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'http hello', client_msg_id: 'h-1' }),
    })
    // SAMPLED THE INSTANT THE RESPONSE LANDED — this is the ordering the test is
    // actually about, captured as an ordering rather than as a duration.
    const agentRepliesAtResponse = framesOfType(sock.frames, 'agent_message').length
    const json = (await res.json()) as { ok: boolean; echo?: { seq?: number; client_msg_id?: string } }

    // The response returned the durable echo (with seq) WITHOUT blocking on the
    // ~500ms agent turn — the whole point of the fire-and-forget change.
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(typeof json.echo?.seq).toBe('number')
    expect(json.echo?.client_msg_id).toBe('h-1')
    // RETURNED BEFORE THE TURN FINISHED — stated as the ordering it is. The turn
    // announces its completion by fanning an `agent_message` over the socket, so
    // "no agent reply had been fanned yet when the HTTP response landed" IS the
    // fire-and-forget claim, directly. The bound this replaces
    // (`elapsed < STEADY_TURN_DELAY_MS`, i.e. 500 ms) tested the same thing by
    // proxy and reddened whenever a loaded runner made the HTTP round-trip take
    // longer than the agent's simulated think time — a machine verdict, not a
    // code one. An ordering cannot be flipped by load, because contention slows
    // the response and the turn together. ISSUES #438.
    expect(agentRepliesAtResponse).toBe(0)

    // The turn still ran — its reply fans over the WS afterwards.
    await waitFor(() =>
      framesOfType(sock.frames, 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    )

    sock.close()
    await sleep(50)
  }, 30_000)

  test('#7 the FIRST session_ready on a fresh topic carries last_seen_seq:0 (M1 reset signal)', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)
    // The first connect's session_ready is emitted BEFORE the async onboarding
    // opener persists, so the durable log is still empty. With a durable log
    // wired the surface now ALWAYS reports last_seen_seq — INCLUDING 0 — so a
    // stale client whose local cursor is ahead recognises the seq regression and
    // wipes its old transcript. (Previously the field was omitted on 0, which a
    // client couldn't distinguish from a no-durable-log deployment.)
    const ready = framesOfType(sock.frames, 'session_ready')[0]!
    expect(ready['last_seen_seq']).toBe(0)
    sock.close()
    await sleep(50)
  }, 30_000)
})

// ── Harness-close quiesce regressions (#1389) ──────────────────────────────
//
// The harness close above used to CALL each composed `realmode_cleanups` entry
// in a synchronous `try { cleanup() }` loop without awaiting it, then shut the
// graph down and closed SQLite — a loop tick in flight at teardown could write
// to a closed DB. These regressions boot THIS harness, hold a REAL composed
// DB-using tick (the Open composer's `chunked-upload-sweeper`, whose tick awaits
// `markExpired` on an expired `uploading` row — chunked-upload-sweeper.ts) at an
// explicit barrier, start the harness's own `close()`, and record an ordered
// event trace of what the close does while the tick is held.
//
// The instrumentation is deliberately LOCAL to this file (the integration
// fixtures own `tests/support/held-sweeper-teardown.ts`; this card must not wait
// on or edit it). MODULE IDENTITY IS LOAD-BEARING: the prototype patches must
// hit the SAME module records the composer built its instances from, so both
// classes are resolved from the composer's upload wiring directory rather than
// via a bare specifier here (a partial install can resolve a bare
// `@neutronai/loop` to a different copy, and a patch on it captures nothing).

const SWEEPER_LOOP = 'chunked-upload-sweeper'
const WIRING_DIR = join(HERE, '..', 'wiring')
const SWEEPER_MODULE_PATH = Bun.resolveSync('@neutronai/gateway/upload/chunked-upload-sweeper.ts', WIRING_DIR)

/** The slice of `SupervisedLoop` driven here, typed structurally (no type import of `@neutronai/loop`). */
interface HeldLoop {
  start(): void
  stop(): Promise<void>
  runOnce(): Promise<{ readonly ran: boolean; readonly skipped: boolean }>
  stats(): { readonly running: boolean }
}
const { SupervisedLoop: SweeperLoopClass } = (await import(
  Bun.resolveSync('@neutronai/loop', dirname(SWEEPER_MODULE_PATH))
)) as { SupervisedLoop: { prototype: HeldLoop } }
const { SqliteUploadSessionStore: WiredUploadStore } = (await import(
  Bun.resolveSync('@neutronai/gateway/upload/upload-session-store.ts', WIRING_DIR)
)) as typeof import('@neutronai/gateway/upload/upload-session-store.ts')

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Boot the REAL harness while capturing the composer's started sweeper loop instance. */
async function startHarnessCapturingSweeper(): Promise<{ h: Harness; loop: HeldLoop }> {
  const proto = SweeperLoopClass.prototype
  const realStart = proto.start
  const loops: HeldLoop[] = []
  proto.start = function capturingStart(this: HeldLoop): void {
    if ((this as unknown as { name: string }).name === SWEEPER_LOOP) loops.push(this)
    return realStart.call(this)
  }
  let h: Harness
  try {
    h = await startHarness()
  } finally {
    proto.start = realStart
  }
  // Hand the booted stack to afterEach BEFORE any precondition can throw.
  harness = h
  if (loops.length !== 1) throw new Error(`expected exactly one started '${SWEEPER_LOOP}' loop, captured ${loops.length}`)
  return { h, loop: loops[0]! }
}

function readUploadStatus(db: ProjectDb, uploadId: string): { status: string; expires_at: number } | null {
  return (db.raw()
    .query('SELECT status, expires_at FROM upload_sessions WHERE upload_id = ?')
    .get(uploadId) as { status: string; expires_at: number } | null) ?? null
}

function dbIsClosed(db: ProjectDb): boolean {
  try { db.raw().query('SELECT 1').get(); return false } catch { return true }
}

interface QuiesceReport {
  sweeperIndex: number | null
  loopActiveBefore: boolean | null
  loopRunningWhileHeld: boolean
  whileHeld: string[]
  teardownSettledWhileHeld: boolean
  dbStatusWhileHeld: string | null
  dbReadErrorWhileHeld: string | null
  write: { changed: boolean | null; statusAfterWrite: string | null; error: string | null }
  writeEnteredCount: number
  tickResult: { ran: boolean; skipped: boolean } | null
  teardownError: string | null
  trace: string[]
  counts: number[]
  loopActiveAfter: boolean | null
  dbClosedAfter: boolean
  unhandled: string[]
}

let seededSeq = 0

/**
 * Hold one real sweeper tick at the `markExpired` barrier, run the harness's
 * ACTUAL `close()` against it, and report what the close did. It never waits on
 * time — only on events (the held write entered; the close reached the held
 * loop's stop, or settled). Every patch is installed inside the `try` whose
 * `finally` releases the barrier, awaits the tick and the close, and restores.
 */
async function driveHeldClose(h: Harness, loop: HeldLoop): Promise<QuiesceReport> {
  const { db, composition, graph } = h
  const cleanups = composition.realmode_cleanups
  if (cleanups === undefined || cleanups.length === 0) throw new Error('composition has no realmode_cleanups')

  // Premise: a known expired row still `uploading`, so the tick reaches the DB write.
  const uploadId = `chatlog-held-${process.pid}-${++seededSeq}`
  const now = Date.now()
  db.raw().run(
    `INSERT INTO upload_sessions
       (upload_id, project_slug, source, filename, total_bytes,
        bytes_received, mime_type, status, created_at, expires_at)
     VALUES (?, 'owner', 'chatgpt', 'export.zip', 1024, 0, 'application/zip', 'uploading', ?, ?)`,
    [uploadId, now - 120_000, now - 60_000],
  )
  const seeded = readUploadStatus(db, uploadId)
  expect(seeded?.status).toBe('uploading')
  expect(seeded!.expires_at).toBeLessThan(Date.now())

  const descriptor = composition.loop_registry?.get(SWEEPER_LOOP)
  const loopActive = (): boolean | null => descriptor?.isActive?.() ?? null

  const trace: string[] = []
  const unhandled: string[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(errText(reason)) }
  const counts = cleanups.map(() => 0)
  const originals = cleanups.slice()
  const st: { currentIndex: number | null; sweeperIndex: number | null; teardownSettled: boolean } =
    { currentIndex: null, sweeperIndex: null, teardownSettled: false }
  const entered = deferred()
  const barrier = deferred()
  const stopEntered = deferred()
  let writeEnteredCount = 0
  const report: QuiesceReport = {
    sweeperIndex: null, loopActiveBefore: loopActive(), loopRunningWhileHeld: false, whileHeld: [],
    teardownSettledWhileHeld: false, dbStatusWhileHeld: null, dbReadErrorWhileHeld: null,
    write: { changed: null, statusAfterWrite: null, error: null }, writeEnteredCount: 0,
    tickResult: null, teardownError: null, trace, counts, loopActiveAfter: null, dbClosedAfter: false, unhandled,
  }
  const restorers: Array<() => void> = []
  let tickP: Promise<{ ran: boolean; skipped: boolean }> | null = null
  let teardownP: Promise<void> | null = null
  try {
    // Count + trace every registered cleanup; a rejection is RETHROWN so the
    // drain's continue-after-rejection is what is exercised.
    restorers.push(() => { for (let i = 0; i < originals.length && i < cleanups.length; i++) cleanups[i] = originals[i]! })
    for (let i = 0; i < cleanups.length; i++) {
      const original = originals[i]!
      cleanups[i] = async (): Promise<void> => {
        counts[i] = (counts[i] ?? 0) + 1
        st.currentIndex = i
        trace.push(`cleanup:${i}:enter`)
        try {
          await original()
          trace.push(`cleanup:${i}:settle`)
        } catch (err) {
          trace.push(`cleanup:${i}:reject`)
          throw err
        }
      }
    }

    const realLoopStop = loop.stop
    restorers.push(() => { delete (loop as unknown as Record<string, unknown>)['stop'] })
    ;(loop as unknown as { stop: () => Promise<void> }).stop = async (): Promise<void> => {
      trace.push('loop:stop-entered')
      if (st.sweeperIndex === null) st.sweeperIndex = st.currentIndex
      stopEntered.resolve()
      await realLoopStop.call(loop)
      trace.push('loop:stop-settled')
    }

    const graphOwn = graph as { shutdown: () => Promise<void> }
    const hadOwnShutdown = Object.prototype.hasOwnProperty.call(graph, 'shutdown')
    const realShutdown = graph.shutdown
    restorers.push(() => {
      if (hadOwnShutdown) graphOwn.shutdown = realShutdown
      else delete (graph as unknown as Record<string, unknown>)['shutdown']
    })
    graphOwn.shutdown = (): Promise<void> => { trace.push('graph:shutdown'); return realShutdown.call(graph) }

    const dbOwn = db as unknown as { close: () => void }
    const hadOwnClose = Object.prototype.hasOwnProperty.call(db, 'close')
    const realClose = db.close
    restorers.push(() => {
      if (hadOwnClose) dbOwn.close = realClose
      else delete (db as unknown as Record<string, unknown>)['close']
    })
    dbOwn.close = (): void => { trace.push('db:close'); realClose.call(db) }

    const storeProto = WiredUploadStore.prototype
    const realMarkExpired = storeProto.markExpired
    restorers.push(() => { storeProto.markExpired = realMarkExpired })
    storeProto.markExpired = async function heldMarkExpired(
      this: InstanceType<typeof WiredUploadStore>, id: string,
    ): Promise<boolean> {
      if (id !== uploadId) return realMarkExpired.call(this, id)
      writeEnteredCount += 1
      trace.push('tick:markExpired-entered')
      entered.resolve()
      await barrier.promise
      try {
        const changed = await realMarkExpired.call(this, id)
        report.write.changed = changed
        report.write.statusAfterWrite = readUploadStatus(db, id)?.status ?? null
        trace.push('tick:markExpired-done')
        return changed
      } catch (err) {
        // The sweeper swallows this — success is asserted from this record.
        report.write.error = errText(err)
        trace.push('tick:markExpired-threw')
        throw err
      }
    }

    process.on('unhandledRejection', onUnhandled)
    restorers.push(() => { process.off('unhandledRejection', onUnhandled) })

    // Drive one tick through the captured loop's public runOnce (the in-flight
    // promise its stop() awaits) and wait for it to enter the held write.
    const tick = loop.runOnce()
    tickP = tick
    const reached = await Promise.race([entered.promise.then(() => true), tick.then(() => false)])
    if (!reached) throw new Error(`the driven tick settled without reaching markExpired(${uploadId})`)
    report.loopRunningWhileHeld = loop.stats().running

    teardownP = h.close().then(
      () => { st.teardownSettled = true; trace.push('teardown:settled') },
      (err: unknown) => { st.teardownSettled = true; report.teardownError = errText(err); trace.push('teardown:rejected') },
    )
    await Promise.race([stopEntered.promise, teardownP])

    // ── while the tick is held ──
    report.sweeperIndex = st.sweeperIndex
    const v = report.whileHeld
    if (!trace.includes('loop:stop-entered')) v.push('close never reached the held loop stop')
    if (trace.includes('graph:shutdown')) v.push('graph:shutdown while the tick was held')
    if (trace.includes('db:close')) v.push('db:close while the tick was held')
    if (st.sweeperIndex !== null) {
      for (const e of trace) {
        const m = /^cleanup:(\d+):enter$/.exec(e)
        if (m !== null && Number(m[1]) > st.sweeperIndex) v.push(`${e} while the tick was held`)
      }
    }
    report.teardownSettledWhileHeld = st.teardownSettled
    try { report.dbStatusWhileHeld = readUploadStatus(db, uploadId)?.status ?? null } catch (err) {
      report.dbReadErrorWhileHeld = errText(err)
    }
  } finally {
    barrier.resolve()
    if (teardownP !== null) await teardownP
    if (tickP !== null) { try { report.tickResult = await tickP } catch { /* runOnce never rejects */ } }
    report.writeEnteredCount = writeEnteredCount
    report.loopActiveAfter = loopActive()
    // One macrotask turn so a rejection from the drive reaches the collector.
    await new Promise<void>((r) => setImmediate(r))
    for (const restore of restorers.reverse()) restore()
  }
  report.dbClosedAfter = dbIsClosed(db)
  return report
}

/** The consuming contract: ordering while held first, then the real write, final order, exact-once counts. */
function expectQuiescedClose(r: QuiesceReport): void {
  expect(r.loopActiveBefore).toBe(true)
  expect(r.loopRunningWhileHeld).toBe(true)
  expect(r.whileHeld).toEqual([])
  expect(r.sweeperIndex).not.toBeNull()
  expect(r.teardownSettledWhileHeld).toBe(false)
  expect(r.dbReadErrorWhileHeld).toBeNull()
  expect(r.dbStatusWhileHeld).toBe('uploading')
  expect(r.writeEnteredCount).toBe(1)
  expect(r.write).toEqual({ changed: true, statusAfterWrite: 'expired', error: null })
  expect(r.tickResult).toEqual({ ran: true, skipped: false })
  expect(r.teardownError).toBeNull()
  const at = (e: string): number => r.trace.indexOf(e)
  expect(at('tick:markExpired-done')).toBeGreaterThanOrEqual(0)
  expect(at('tick:markExpired-done')).toBeLessThan(at('loop:stop-settled'))
  expect(at('loop:stop-settled')).toBeLessThan(at('graph:shutdown'))
  expect(at('graph:shutdown')).toBeLessThan(at('db:close'))
  expect(r.trace.filter((e) => e === 'db:close')).toHaveLength(1)
  expect(r.counts.length).toBeGreaterThan(0)
  expect(r.counts).toEqual(r.counts.map(() => 1))
  expect(r.loopActiveAfter).toBe(false)
  expect(r.dbClosedAfter).toBe(true)
  expect(r.unhandled).toEqual([])
}

describe('durable chat-log harness close quiesces composed loops before DB close', () => {
  test('harness close quiesces a held composed sweeper tick before DB close', async () => {
    const { h, loop } = await startHarnessCapturingSweeper()
    const report = await driveHeldClose(h, loop)
    harness = null
    expectQuiescedClose(report)
  }, 30_000)

  test('an earlier rejecting cleanup does not skip the later held cleanup or close the DB early', async () => {
    const { h, loop } = await startHarnessCapturingSweeper()
    // Registered AHEAD of every composed cleanup: one async rejection, one sync throw.
    h.composition.realmode_cleanups!.unshift(
      async () => { throw new Error('earlier-async-reject') },
      () => { throw new Error('earlier-sync-throw') },
    )
    const report = await driveHeldClose(h, loop)
    harness = null
    expectQuiescedClose(report)
    const at = (e: string): number => report.trace.indexOf(e)
    // Registration order kept: both earlier cleanups rejected, in order, before the sweeper stop.
    expect(at('cleanup:0:reject')).toBeGreaterThanOrEqual(0)
    expect(at('cleanup:0:reject')).toBeLessThan(at('cleanup:1:enter'))
    // Presence first: indexOf returns -1 for a missing event, which would pass the
    // ordering assertion below vacuously.
    expect(at('cleanup:1:reject')).toBeGreaterThanOrEqual(0)
    expect(at('cleanup:1:reject')).toBeLessThan(at('loop:stop-entered'))
    expect(report.sweeperIndex).toBeGreaterThan(1)
    expect(report.counts[0]).toBe(1)
    expect(report.counts[1]).toBe(1)
  }, 30_000)

  test('an empty cleanup list still closes normally (control)', async () => {
    const { h } = await startHarnessCapturingSweeper()
    const list = h.composition.realmode_cleanups!
    const saved = list.splice(0, list.length)
    // Quiesce the composed loops OUTSIDE the close under test so nothing leaks
    // or touches the DB after it closes.
    await drainRealmodeCleanups(saved)
    const trace: string[] = []
    const graphOwn = h.graph as { shutdown: () => Promise<void> }
    const hadOwnShutdown = Object.prototype.hasOwnProperty.call(h.graph, 'shutdown')
    const realShutdown = h.graph.shutdown
    const dbOwn = h.db as unknown as { close: () => void }
    const hadOwnClose = Object.prototype.hasOwnProperty.call(h.db, 'close')
    const realClose = h.db.close
    let closeError: string | null = null
    try {
      graphOwn.shutdown = (): Promise<void> => { trace.push('graph:shutdown'); return realShutdown.call(h.graph) }
      dbOwn.close = (): void => { trace.push('db:close'); realClose.call(h.db) }
      await h.close()
      trace.push('close:settled')
    } catch (err) {
      closeError = errText(err)
    } finally {
      harness = null
      if (hadOwnShutdown) graphOwn.shutdown = realShutdown
      else delete (h.graph as unknown as Record<string, unknown>)['shutdown']
      if (hadOwnClose) dbOwn.close = realClose
      else delete (h.db as unknown as Record<string, unknown>)['close']
    }
    expect(closeError).toBeNull()
    expect(trace).toEqual(['graph:shutdown', 'db:close', 'close:settled'])
    expect(dbIsClosed(h.db)).toBe(true)
  }, 30_000)
})
