/**
 * Open `/task` chat-command wiring — the anti-"built-but-not-wired" gate for the
 * Tasks Core's chat entry.
 *
 * THE GAP: `wrapWithTasksChatRouter` (`gateway/cores/tasks-chat-router.ts:109`)
 * was fully built, unit-tested twice over
 * (`gateway/__tests__/tasks-core-chat-pick-next-composer.test.ts`,
 * `gateway/__tests__/tasks-chat-router-deep-link.test.ts`), and had ZERO
 * production callers. Its only non-test reference was a type import in
 * `gateway/boot-cores-factories-types.ts`. The composed chain
 * (`open/composer.ts` → `gateway/cores/mount-open-cores.ts:388`) wires calendar,
 * email, reminders and research and has never wired tasks — so every `/task …`
 * the owner typed fell through to `dispatchInbound` and was answered by the
 * model as prose, and every Tasks Core button was dead UI on both clients.
 *
 * A SECOND LINK WAS ALSO MISSING, which is why wiring the router alone would
 * have shipped dead a second time. The router resolves its deps through a
 * `TasksCoreOwnerRegistry`; that interface was declared
 * (`boot-cores-factories-types.ts:31`) and written to
 * (`boot-cores-factories.ts:77`) but NO IMPLEMENTATION of it existed anywhere in
 * the repo, and no composer passed one — so the factory's write was skipped
 * behind its `!== undefined` guard. Both links are exercised here: if the
 * registry were still absent, `deps.resolve` would return null and the router
 * would fall through to the model exactly as before, and test #1 would fail.
 *
 * WHY IT IS NOT IN `reachability-inventory.ts`. That gate scans for chat-command
 * FILTER factories (`open/__tests__/chat-command-filter-scan.ts`) and probes for
 * a `chat_command_result` frame. `/task` is neither: it is a receiver wrapper
 * returning `IncomingEventReceiver`, and it answers with a full `agent_message`
 * envelope. That is deliberate rather than incidental — a
 * `ChatCommandFilterResult` (`contracts/chat-command-filter.ts:35`) has no field
 * for BUTTONS, and the Tasks Core answers `/task` and `/task focus` with button
 * rows. Routing it through the filter chain would have silently dropped every
 * button, so it sits one layer down where the envelope can carry them. The scan
 * therefore cannot see it by construction, which is a blind spot recorded in
 * that scan's own "WHAT THIS READER CANNOT SEE" list, and this file is the
 * cover for it — the same relationship `open-code-command-wiring.test.ts` has
 * with `/code`.
 *
 * Per CLAUDE.md ("done means WIRED + SERVED") a call-site assertion is not
 * enough: this boots the REAL Open composition over a live `Bun.serve`, opens
 * the unified `/ws/app/chat` socket the shipped clients use, and types `/task`
 * as a real user message with a MOCKED substrate (no real `claude`, no
 * api.anthropic.com).
 *
 * It asserts:
 *   #1 `/task help` is CLAIMED — the Tasks Core's cheatsheet comes back. `help`
 *      short-circuits in `executeTaskCommand` before the store is touched
 *      (`cores/free/tasks/src/chat-commands.ts:184`), so the claim does not
 *      depend on any task existing and the probe is read-only on a fresh box.
 *   #2 that turn never reached the model — the mocked substrate's distinctive
 *      reply never comes back for it and no durable agent row is written.
 *   #3 `/taskfoo` is NOT over-claimed — ordinary chat that merely starts with
 *      `/task` still reaches the model, so the fix cannot swallow real messages.
 *
 * MUTATION TESTS. Results exactly as observed, including what they did NOT show:
 *
 *   - drop the `wrapWithTasksChatRouter` wrap in `open/wiring/app-ws.ts` (pass
 *     `appWsReceiver` straight to `new AppWsAdapter`)
 *     → #1 reds on `claimed`: no cheatsheet ever arrives. VERIFIED.
 *   - drop `tasksCoreRegistry` from the `mountOpenCores(...)` call in
 *     `open/composer.ts`
 *     → #1 reds identically, because the registry is never populated and
 *       `deps.resolve` returns null, so the router falls through. VERIFIED.
 *
 * BOTH LINKS MATTER, and that is the point of running two mutations rather than
 * one: either omission alone reproduces the original bug in full, so a gate that
 * only covered the wrap would have gone green on a `/task` that still reached
 * nobody. This is the "found one missing link, briefed only that link" failure
 * repeated one level down, and two mutations are what rule it out.
 *
 * Note what neither mutation demonstrated: #1 aborts at its `claimed`
 * assertion, so the `wentToModel` half never evaluates and #3 stays green
 * throughout (it asserts the model path, which is exactly what an unwired
 * `/task` restores). Recorded rather than rounded up to "both tests red",
 * because a mutation report that overstates its own reach is the same defect as
 * the citations this change is fixing.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** Distinctive mocked-model reply. If this comes back for `/task`, the router is
 *  not in the chain and the message was answered by the model. */
const AGENT_REPLY_BODY = 'TASK_PROBE_WENT_TO_THE_MODEL'

/** A line only the Tasks Core's help response produces. */
const CHEATSHEET_MARKER = 'Tasks Core commands:'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
  seedMigratedDb(process.env['NEUTRON_DB_PATH'] as string)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH'] as string)
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
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
let socket: OpenSocket | null = null

async function openSocket(base: string): Promise<OpenSocket> {
  const wsUrl = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web&device_id=devA`)
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)) as Record<string, unknown>)
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

/** Agent rows on the owner's General app topic — durable proof an LLM turn ran. */
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
 * A fresh owner's `on_session_open` seeds an onboarding opener that lands its own
 * frames and rows asynchronously. Settle before probing so none of it is mistaken
 * for an answer — with a CEILING, because a loop that waits for quiet on a
 * contended runner can wait forever, and a gate that hangs is neither a pass nor
 * a red anyone can read.
 */
async function quiesce(db: ProjectDb, sock: OpenSocket): Promise<void> {
  const deadline = Date.now() + 20_000
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

interface ProbeResult {
  /** An `agent_message` carrying the Tasks Core cheatsheet came back. */
  readonly claimed: boolean
  /** The mocked model answered it (or a durable agent row appeared). */
  readonly wentToModel: boolean
}

/** Type one body at the socket and wait for it to settle. */
async function typeOne(id: string, body: string): Promise<ProbeResult> {
  const sock = socket as OpenSocket
  const db = (harness as Harness).db
  const frameMark = sock.frames.length
  const rowBaseline = agentRowCount(db)

  sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body, client_msg_id: id }))

  const bodiesSince = (): string[] =>
    sock.frames
      .slice(frameMark)
      .filter((f) => f['type'] === 'agent_message')
      .map((f) => (typeof f['body'] === 'string' ? (f['body'] as string) : ''))

  const claimed = await waitFor(
    () => bodiesSince().some((b) => b.includes(CHEATSHEET_MARKER)),
    10_000,
  )
  // Settle either way. On a claim this proves the router SHORT-CIRCUITED the
  // model rather than racing it; on a miss it lets the failure say WHERE the
  // message went, which is a materially more useful line than "no result".
  await sleep(claimed ? 1_000 : 1_500)
  const wentToModel =
    bodiesSince().some((b) => b.includes(AGENT_REPLY_BODY)) || agentRowCount(db) > rowBaseline
  return { claimed, wentToModel }
}

beforeAll(async () => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-task-command-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'task-command-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-task-command'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
  delete process.env['NOTIFY_SOCKET']

  harness = await startHarness()
  socket = await openSocket(harness.base)
  await waitFor(() => socket!.frames.some((f) => f['type'] === 'session_ready'), 15_000)
  await quiesce(harness.db, socket)
}, 120_000)

afterAll(async () => {
  socket?.close()
  await harness?.close()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('/task reaches the Tasks Core through the composed chain', () => {
  test('#1 `/task help` is claimed by the router, not answered by the model', async () => {
    const result = await typeOne('probe-task-help', '/task help')
    expect(result.claimed).toBe(true)
    // #2, asserted on the same turn because they are two halves of one claim: a
    // command the model answers is a command the owner has lost, even though
    // the chat looks like it replied.
    expect(result.wentToModel).toBe(false)
  }, 40_000)

  test('#3 `/taskfoo` is NOT over-claimed and still reaches the model', async () => {
    // The control. Without it, a router that claimed every body starting with
    // `/task` would pass #1 while swallowing ordinary chat — a worse bug than
    // the one being fixed, and invisible to a test that only probes the happy
    // path.
    const result = await typeOne('probe-taskfoo', '/taskfoo is not a command')
    expect(result.claimed).toBe(false)
    expect(result.wentToModel).toBe(true)
  }, 40_000)
})
