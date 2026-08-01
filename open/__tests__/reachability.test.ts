/**
 * THE REACHABILITY GATE, half two — CAN THE OWNER STILL TYPE THESE COMMANDS?
 *
 * Boots the REAL Open composition over a live `Bun.serve`, opens the unified
 * `/ws/app/chat` socket the shipped clients use, and types every command in the
 * inventory as a real user message — with a MOCKED substrate, so there is no
 * `claude` process and no api.anthropic.com in the loop.
 *
 * For each command it asserts the two halves of "reachable":
 *   CLAIMED    — a `chat_command_result` comes back, correlated to the message id.
 *   NOT THE LLM — the mocked model's distinctive reply never comes back for it,
 *                 and no durable agent row is written. A command that is answered
 *                 by the model is a command the owner has lost, even though the
 *                 chat looks like it replied.
 *
 * WHY IT IS SHAPED THIS WAY. `open-code-command-wiring.test.ts` next door is this
 * assertion for ONE command, written after `/code` shipped unreachable — built,
 * unit-tested, and left out of the composer's `buildChainedChatCommandFilter([…])`
 * chain, so its only non-test references were barrel re-exports. That file is the
 * proof the shape works, and it stays: it carries `/code`-specific detail (the
 * over-claim boundary, the cheatsheet body) that does not generalise. THIS file is
 * the generalisation — the same proof for every command at once, driven from data,
 * so the next command is covered by adding a line rather than by writing another
 * 270-line file after the next incident.
 *
 * ONE BOOT FOR ALL COMMANDS. Composing the real graph is the expensive part;
 * doing it per command would triple the cost for nothing.
 *
 * A FAILURE SAYS WHAT THE OWNER LOST, not which frame was missing.
 *
 * MUTATION TEST: delete any filter from the composer's chain and that command's
 * line appears in the failure. Verified against `tridentCodeChatCommandFilter`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { CHAT_COMMANDS } from './reachability-inventory.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** Distinctive mocked-model reply. If this comes back for a command, the command
 *  fell through to the LLM — i.e. its filter is not in the composed chain. */
const AGENT_REPLY_BODY = 'REACHABILITY_PROBE_WENT_TO_THE_MODEL'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

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

interface Harness {
  base: string
  db: ProjectDb
  close(): Promise<void>
}
let harness: Harness | null = null

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
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
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
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
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)))
    } catch {
      /* not our frame shape */
    }
  }
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
  return (
    db
      .raw()
      .query(
        "SELECT count(*) c FROM app_chat_messages WHERE topic_id = 'app:owner' AND role = 'agent'",
      )
      .get() as { c: number }
  ).c
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return false
    await sleep(25)
  }
  return true
}

/**
 * A fresh owner's `on_session_open` seeds an onboarding opener turn that lands its
 * own agent row AND its own frames asynchronously. Wait until both stop moving, so
 * nothing from onboarding is mistaken for a probe's answer.
 */
async function quiesce(db: ProjectDb, sock: OpenSocket): Promise<void> {
  let rows = agentRowCount(db)
  let frames = sock.frames.length
  for (;;) {
    await sleep(700)
    const nextRows = agentRowCount(db)
    const nextFrames = sock.frames.length
    if (nextRows === rows && nextFrames === frames) return
    rows = nextRows
    frames = nextFrames
  }
}

/** How long to wait for the chain to claim a command. Generous: the cost of being
 *  wrong here is a false alarm, and this gate is only worth having if it is
 *  believed when it goes red. */
const CLAIM_TIMEOUT_MS = 10_000

let socket: OpenSocket | null = null
/** id → the owner-facing reason it is unreachable, or null when it is fine. */
const outcome = new Map<string, string | null>()

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-reachability-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'reachability-probe-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-reachability'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']

  harness = await startHarness()
  socket = await openSocket(harness.base)
  await waitFor(() => framesOfType(socket!.frames, 'session_ready').length > 0, 15_000)
  await quiesce(harness.db, socket)

  // Type every command in turn, one settled probe at a time so a slow answer can
  // never be attributed to the next command.
  for (const cap of CHAT_COMMANDS) {
    const id = `probe-${cap.id}`
    const frameMark = socket.frames.length
    const rowBaseline = agentRowCount(harness.db)

    socket.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: cap.probe, client_msg_id: id }))

    const claimed = await waitFor(
      () =>
        framesOfType(socket!.frames, 'chat_command_result').some(
          (f) => f['client_msg_id'] === id,
        ),
      CLAIM_TIMEOUT_MS,
    )
    if (!claimed) {
      // Let the fall-through finish so the report can say WHERE it went — "the
      // model answered instead" is a materially more useful line than "no result".
      await sleep(1_500)
      const wentToModel =
        framesOfType(socket.frames.slice(frameMark), 'agent_message').some(
          (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
        ) || agentRowCount(harness.db) > rowBaseline
      outcome.set(
        cap.id,
        wentToModel ? cap.broken : `${cap.broken} (typing it produced no answer at all)`,
      )
      continue
    }

    // Claimed. Now prove it SHORT-CIRCUITED the model rather than racing it.
    await sleep(1_000)
    const alsoWentToModel =
      framesOfType(socket.frames.slice(frameMark), 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ) || agentRowCount(harness.db) > rowBaseline
    outcome.set(
      cap.id,
      alsoWentToModel
        ? `${cap.command} answered, but the message ALSO reached the model — a build or a reminder can be triggered twice by one command.`
        : null,
    )
  }
}, 180_000)

afterAll(async () => {
  socket?.close()
  await sleep(50)
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('reachability — the chat commands, on a real running instance', () => {
  test('every command the owner can type is still claimed by the composed chain', () => {
    const lost = CHAT_COMMANDS.map((c) => outcome.get(c.id)).filter(
      (v): v is string => typeof v === 'string',
    )
    // The asserted VALUE is the owner-facing report, so it lands in the diff of
    // any runner and a green run prints nothing at all.
    const report = lost.length === 0 ? '' : ['Commands the owner has lost:', ...lost.map((l) => `  • ${l}`)].join('\n')
    expect(report).toBe('')
  })

  test('every command in the inventory was actually probed', () => {
    // Without this, a probe that silently never ran would read as a pass — the
    // failure mode the E2E script next door has (it exits 0 when the server is
    // unreachable, so it has been able to prove nothing for as long as it likes).
    const unprobed = CHAT_COMMANDS.filter((c) => !outcome.has(c.id)).map((c) => c.command)
    expect(unprobed).toEqual([])
  })
})
