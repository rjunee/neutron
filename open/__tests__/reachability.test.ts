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
 * IT ALSO TYPES THE COMMANDS THAT DO NOT WORK. `CHAT_COMMANDS_KNOWN_UNREACHABLE`
 * lists filters that exist in the repo and reach no composed chain — `/scrape`
 * today. Those get the OPPOSITE assertion: they must still be unclaimed. An
 * admission that a command is broken is worth nothing if nothing checks it is
 * still true, and the failure mode it guards against is the good one — somebody
 * wires the command and the note stays behind saying it does not work, leaving
 * the newly-working command unwatched. Which is where `/code` was.
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

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import {
  CHAT_COMMANDS,
  CHAT_COMMANDS_KNOWN_UNREACHABLE,
} from './reachability-inventory.ts'

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
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
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
 *
 * HARD DEADLINE, deliberately. The natural way to write this is "loop until it
 * settles", and on a contended runner a background tick that keeps writing would
 * make that loop never end — turning a gate that is supposed to say yes or no into
 * one that hangs. A hang is the worst outcome available here: it is not a pass, it
 * is not a red anyone can read, and it burns a runner until something else kills
 * it. So settling is best-effort with a ceiling; past the ceiling we take the
 * current marks and carry on, and every probe below measures from ITS OWN mark
 * anyway, so an unsettled start costs precision, not correctness.
 */
const QUIESCE_CEILING_MS = 20_000

async function quiesce(db: ProjectDb, sock: OpenSocket): Promise<void> {
  const deadline = Date.now() + QUIESCE_CEILING_MS
  let rows = agentRowCount(db)
  let frames = sock.frames.length
  while (Date.now() < deadline) {
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
/** id → the reason a KNOWN-BROKEN command is no longer broken, or null. */
const pinnedOutcome = new Map<string, string | null>()

/** What one typed message did. */
interface ProbeResult {
  /** A `chat_command_result` came back, correlated to this message. */
  readonly claimed: boolean
  /** The mocked model answered it (or a durable agent row appeared). */
  readonly wentToModel: boolean
}

/** Type one body at the socket and wait for it to settle. */
async function typeOne(id: string, body: string): Promise<ProbeResult> {
  const sock = socket!
  const db = harness!.db
  const frameMark = sock.frames.length
  const rowBaseline = agentRowCount(db)

  sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body, client_msg_id: id }))

  const claimed = await waitFor(
    () =>
      framesOfType(sock.frames, 'chat_command_result').some((f) => f['client_msg_id'] === id),
    CLAIM_TIMEOUT_MS,
  )
  // Settle either way. On a claim this is what proves the chain SHORT-CIRCUITED
  // the model rather than racing it; on a miss it is what lets the report say
  // WHERE the message went, which is a materially more useful line than "no
  // result".
  await sleep(claimed ? 1_000 : 1_500)
  const wentToModel =
    framesOfType(sock.frames.slice(frameMark), 'agent_message').some(
      (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
    ) || agentRowCount(db) > rowBaseline
  return { claimed, wentToModel }
}

/**
 * Env setup ONLY. Everything that can block — composing the graph, opening the
 * socket, typing the commands — lives in the test below rather than here.
 *
 * WHY THAT SPLIT MATTERS. Bun enforces the per-test timeout on `test()`, and a
 * `beforeAll` that never resolves has nothing stopping it: the file would hang
 * rather than fail, burning a CI runner and reporting neither green nor red. A
 * gate whose failure mode is "hangs forever" is worse than no gate — it is the
 * permanently-inconclusive check that trains everyone to stop looking. So the
 * blocking work sits under a deadline the runner actually enforces.
 */
beforeAll(() => {
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
})

/** Boot the instance and type every command. Bounded at every step. */
async function probeEveryCommand(): Promise<void> {
  harness = await startHarness()
  socket = await openSocket(harness.base)
  await waitFor(() => framesOfType(socket!.frames, 'session_ready').length > 0, 15_000)
  await quiesce(harness.db, socket)

  // Type every command in turn, one settled probe at a time so a slow answer can
  // never be attributed to the next command.
  for (const cap of CHAT_COMMANDS) {
    const { claimed, wentToModel } = await typeOne(`probe-${cap.id}`, cap.probe)
    if (!claimed) {
      outcome.set(
        cap.id,
        wentToModel ? cap.broken : `${cap.broken} (typing it produced no answer at all)`,
      )
      continue
    }
    outcome.set(
      cap.id,
      wentToModel
        ? `${cap.command} answered, but the message ALSO reached the model — a build or a reminder can be triggered twice by one command.`
        : null,
    )
  }

  // The commands the inventory says are BROKEN today. Typed for the same reason
  // the working ones are: an admission that a command does not work is worth
  // nothing unless something keeps checking it is still true. The day one of
  // these is claimed, somebody wired it — and it needs a real probe, not a
  // stale note saying it does not work.
  for (const cap of CHAT_COMMANDS_KNOWN_UNREACHABLE) {
    const { claimed } = await typeOne(`pinned-${cap.id}`, cap.probe)
    pinnedOutcome.set(
      cap.id,
      claimed
        ? `${cap.command} is claimed by the composed chain now, but the inventory still lists it as unreachable (${cap.filter}). Somebody wired it — move it out of CHAT_COMMANDS_KNOWN_UNREACHABLE and into CHAT_COMMANDS with a probe, so it is watched like every other working command.`
        : null,
    )
  }
}

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
  test('every command the owner can type is still claimed by the composed chain', async () => {
    await probeEveryCommand()
    const lost = CHAT_COMMANDS.map((c) => outcome.get(c.id)).filter(
      (v): v is string => typeof v === 'string',
    )
    // The asserted VALUE is the owner-facing report, so it lands in the diff of
    // any runner and a green run prints nothing at all.
    const report =
      lost.length === 0 ? '' : ['Commands the owner has lost:', ...lost.map((l) => `  • ${l}`)].join('\n')
    expect(report).toBe('')
    // Composing the graph, booting the server and typing the inventory settles in
    // ~15s locally; the ceiling is loose enough that a contended runner is not a
    // false red, and tight enough that a wedge is reported rather than hung on.
  }, 150_000)

  test('every command in the inventory was actually probed', () => {
    // Without this, a probe that silently never ran would read as a pass — the
    // failure mode the E2E script next door has (it exits 0 when the server is
    // unreachable, so it has been able to prove nothing for as long as it likes).
    const unprobed = CHAT_COMMANDS.filter((c) => !outcome.has(c.id)).map((c) => c.command)
    expect(unprobed).toEqual([])
  })

  test('the commands the inventory admits are broken are still broken', () => {
    // The inverted assertion, and the one that keeps an admission honest. An
    // entry in CHAT_COMMANDS_KNOWN_UNREACHABLE is a documented hole; without
    // this, the day it gets filled the note would stay behind saying the command
    // does not work, and the command would go back to being unwatched — which is
    // the state `/code` was in.
    const fixed = CHAT_COMMANDS_KNOWN_UNREACHABLE.map((c) => pinnedOutcome.get(c.id)).filter(
      (v): v is string => typeof v === 'string',
    )
    expect(fixed.length === 0 ? '' : fixed.join('\n')).toBe('')
  })

  test('every known-unreachable command was actually probed', () => {
    const unprobed = CHAT_COMMANDS_KNOWN_UNREACHABLE.filter(
      (c) => !pinnedOutcome.has(c.id),
    ).map((c) => c.command)
    expect(unprobed).toEqual([])
  })
})
