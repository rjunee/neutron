/**
 * Open `/code` chat-command wiring — the anti-"built-but-not-wired" gate for the
 * Trident build entry.
 *
 * THE GAP: `buildTridentCodeChatCommandFilter` (gateway/boot-chat-command-filters.ts)
 * was fully built and unit-tested, and the whole durable Trident stack behind it
 * — run store, tick loop, delivery, terminal observers — was composed in
 * `open/composer.ts`. But the filter was never added to the composer's
 * `buildChainedChatCommandFilter([...])` chain, so its only non-test references
 * were barrel RE-EXPORTS (`gateway/boot-helpers.ts`, `gateway/index.ts`) — zero
 * production call sites. Every `/code …` the owner typed therefore fell through
 * to `dispatchInbound` and got a chat reply from the model instead of starting a
 * build.
 *
 * Per CLAUDE.md ("done means WIRED + SERVED", and the unit-tests-pass-while-
 * unreachable incident class) a call-site assertion is not enough: this boots the
 * REAL Open composition over a live `Bun.serve`, opens the unified
 * `/ws/app/chat` socket the shipped clients use, and drives `/code` as a real
 * user message with a MOCKED substrate (no real `claude`, no api.anthropic.com).
 *
 * It asserts:
 *   #1 `/code help` is CLAIMED by the filter — the server answers with a
 *      `chat_command_result` carrying the Trident cheatsheet, correlated to the
 *      sender's `client_msg_id`.
 *   #2 that turn never reached the model — no agent turn ran for it (the mocked
 *      substrate's distinctive reply body never appears, and the durable agent
 *      row count is unchanged).
 *   #3 `/codefoo` is NOT over-claimed — it still falls through to the model, so
 *      the fix cannot swallow ordinary chat that merely starts with `/code`.
 *
 * MUTATION TEST: delete `tridentCodeChatCommandFilter` from the composer's chain
 * and #1 fails (no `chat_command_result` ever arrives — the body is dispatched to
 * the substrate instead). That is precisely the gate that was missing when this
 * shipped unreachable.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** Distinctive mocked-model reply. If this comes back for `/code`, the command
 *  fell through to the LLM — i.e. the filter is not wired. */
const AGENT_REPLY_BODY = 'CODE_CMD_WENT_TO_THE_MODEL'
/** A stable fragment of the Trident `/code` HELP_TEXT (trident/code-command.ts). */
const CODE_HELP_MARKER = 'cheatsheet'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness { base: string; db: ProjectDb; close(): Promise<void> }
let harness: Harness | null = null

function recordingSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: AGENT_REPLY_BODY }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock',
        }
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

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-code-cmd-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-code-cmd-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-code-cmd'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
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

async function startHarness(): Promise<Harness> {
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) throw new Error('no fetch/ws')
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => graph.fetch!(req, srv),
    websocket: graph.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try { cleanup() } catch { /* best-effort */ }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

interface OpenSocket {
  ws: WebSocket
  frames: Array<Record<string, unknown>>
  close(): void
}

async function openSocket(base: string): Promise<OpenSocket> {
  const wsUrl = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web&device_id=devA`)
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))) } catch { /* */ } }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
  })
  return { ws, frames, close: () => ws.close() }
}

const framesOfType = (
  frames: Array<Record<string, unknown>>,
  type: string,
): Array<Record<string, unknown>> => frames.filter((f) => f['type'] === type)

/** Agent rows on the owner's General app topic — the durable proof an LLM turn ran. */
function agentRowCount(db: ProjectDb): number {
  return (db.raw()
    .query("SELECT count(*) c FROM app_chat_messages WHERE topic_id = 'app:owner' AND role = 'agent'")
    .get() as { c: number }).c
}

/**
 * A fresh owner's `on_session_open` seeds an onboarding opener turn that lands its
 * own agent row AND its own `agent_message` frames asynchronously. Wait until BOTH
 * the durable row count and the socket frame count stop moving, so nothing from
 * onboarding can be mistaken for a `/code` dispatch below. Returns the settled
 * agent-row baseline and the frame index to measure from.
 */
async function quiesce(db: ProjectDb, sock: OpenSocket): Promise<{ rows: number; frameMark: number }> {
  let rows = agentRowCount(db)
  let frames = sock.frames.length
  for (;;) {
    await sleep(700)
    const nextRows = agentRowCount(db)
    const nextFrames = sock.frames.length
    if (nextRows === rows && nextFrames === frames) {
      return { rows, frameMark: frames }
    }
    rows = nextRows
    frames = nextFrames
  }
}

describe('Open `/code` chat-command wiring (real instance, live socket)', () => {
  test('#1/#2 `/code help` is claimed by the filter and never reaches the model', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)
    const { rows: baseline, frameMark } = await quiesce(harness.db, sock)

    sock.ws.send(JSON.stringify({
      v: 1, type: 'user_message', body: '/code help', client_msg_id: 'code-1',
    }))

    // #1 — the command is CLAIMED: a chat_command_result correlated to our
    // client_msg_id, carrying the Trident cheatsheet. Before the fix this frame
    // never arrived (the body was dispatched to the substrate instead).
    await waitFor(() =>
      framesOfType(sock.frames, 'chat_command_result').some((f) => f['client_msg_id'] === 'code-1'),
    )
    const result = framesOfType(sock.frames, 'chat_command_result')
      .find((f) => f['client_msg_id'] === 'code-1')
    expect(result).toBeDefined()
    expect(String(result!['text'])).toContain(CODE_HELP_MARKER)

    // #2 — it short-circuited the LLM path. Measured only over frames that
    // arrived AFTER the settled onboarding opener (`frameMark`), so the seeded
    // onboarding turn can't be mistaken for a `/code` answer: the mocked model's
    // distinctive reply never came back, and no new durable agent row was written.
    await sleep(1_500)
    const modelAnswered = framesOfType(sock.frames.slice(frameMark), 'agent_message').some(
      (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
    )
    expect(modelAnswered).toBe(false)
    expect(agentRowCount(harness.db)).toBe(baseline)

    sock.close()
    await sleep(50)
  }, 45_000)

  test('#3 `/codefoo` is NOT over-claimed — it still falls through to the model', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)
    const { frameMark } = await quiesce(harness.db, sock)

    sock.ws.send(JSON.stringify({
      v: 1, type: 'user_message', body: '/codefoo not a command', client_msg_id: 'code-2',
    }))

    // The model answers it (shared `parseCodeCommand` grammar: `/code` must be
    // followed by EOL/whitespace), and no command result is emitted for it.
    await waitFor(() =>
      framesOfType(sock.frames.slice(frameMark), 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    )
    const claimed = framesOfType(sock.frames, 'chat_command_result')
      .some((f) => f['client_msg_id'] === 'code-2')
    expect(claimed).toBe(false)

    sock.close()
    await sleep(50)
  }, 45_000)
})
