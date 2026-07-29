/**
 * The onboarding welcome opener must be emitted EXACTLY ONCE per owner, through
 * the real live-agent seam.
 *
 * THE BUG (live, fresh install 2026-07-18, screenshot-confirmed): the opener
 * ("…what should I call you?") appeared TWICE in the owner's General topic.
 *
 * ROOT CAUSE: `on_session_open` gated the seed on `seededOnboardingTopics`, a
 * per-PROCESS in-memory `Set` (`open/wiring/app-ws.ts`). The opener itself is
 * DURABLE — the live runner persists it as a `button_prompts` row before it
 * sends (`gateway/wiring/build-live-agent-turn.ts:1096` precedes the send at
 * :1126) — so any new process (restart / redeploy / crash / the service bounce a
 * fresh install performs) started with an empty Set, re-seeded on top of the
 * persisted opener, and the client hydrated BOTH.
 *
 * THE FIX: ask the durable store instead. `hasBeenGreeted` reads
 * `buttonStore.latestTurnByTopic` — the same "does this topic already have a
 * turn?" check `ensureProjectOpeningOnEntry` already uses for project openings —
 * and the in-memory map is demoted to a pure SINGLE-FLIGHT latch for connects
 * that race before the first row exists. The old failure-compensating
 * `seededOnboardingTopics.delete(...)` is gone and needs no replacement: a
 * failed seed returns before persisting anything (:1055, :1069), so the durable
 * gate re-fires it on its own.
 *
 * WHY THIS TEST BOOTS THE WHOLE STACK: a test that asserts Set bookkeeping would
 * have passed against the buggy code — the Set was doing exactly what it said.
 * The defect only exists at the level of EMITTED MESSAGES across process
 * lifetimes, so this boots a real composer + production graph + app WebSocket
 * and counts the openers the owner actually receives. The ONLY fake is the
 * substrate (the model itself).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/** The owner's General topic — the only topic the welcome may ever land on. */
const GENERAL_TOPIC = 'app:owner'

/** What the scripted "model" answers a seed turn with. */
const WELCOME_REPLY = 'Hey — welcome in! What should I call you?'

/**
 * The synthetic instruction `on_session_open` sends for the auto-start welcome.
 * Counting the specs carrying it counts SEED DISPATCHES; counting the persisted
 * rows counts what the OWNER SEES. The fix must hold both at one, and the two
 * numbers agreeing is what proves no opener was emitted by some other path.
 */
const SEED_INSTRUCTION = 'just opened the chat to begin onboarding'

let home: IsolatedHome

interface Harness {
  base: string
  /** Every AgentSpec the composer handed the substrate, in order. */
  specs: AgentSpec[]
  close(): Promise<void>
}

/**
 * Records every composed prompt and answers a seed turn with the welcome. This
 * stands in for the MODEL only — every other layer under test is real.
 */
function scriptedSubstrate(specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const text =
        typeof spec.prompt === 'string' && spec.prompt.includes(SEED_INSTRUCTION)
          ? WELCOME_REPLY
          : 'ok'
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text }
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(50)
  }
}

/**
 * Boot a server against the shared on-disk DB. NOTHING is seeded: no
 * `onboarding_state` row at all is what a genuine fresh install looks like, and
 * `isOnboardingActive` reads exactly that ("no state row = fresh install →
 * onboarding", `open/composer.ts:2334-2339`).
 *
 * Calling this a SECOND time on the same DB path is the process-restart
 * simulation: brand-new composer, brand-new graph, brand-new in-memory guard
 * state — same persisted store.
 */
async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())

  const specs: AgentSpec[] = []
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => scriptedSubstrate(specs)) as any,
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
    specs,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* teardown only */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

interface Sock {
  ws: WebSocket
  frames: Array<Record<string, unknown>>
}
async function openSocket(base: string): Promise<Sock> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/app/chat?token=dev:owner&platform=web`)
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)))
    } catch {
      /* non-JSON frame */
    }
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
  })
  await waitFor(() => frames.some((f) => f['type'] === 'session_ready'))
  return { ws, frames }
}

/**
 * The DURABLE opener count — every `button_prompts` row on the General topic
 * whose body is the welcome. This is what the client hydrates on reload, so it
 * is the number the owner sees in the screenshot. Opened on its own connection
 * so it never races the harness's own handle.
 */
function persistedOpenerCount(): number {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  try {
    const rows = db
      .raw()
      .query('SELECT body FROM button_prompts WHERE topic_id = ?')
      .all(GENERAL_TOPIC) as Array<{ body: string | null }>
    return rows.filter((r) => (r.body ?? '').includes('What should I call you?')).length
  } finally {
    db.close()
  }
}

/** Live `agent_message` frames carrying the welcome, as pushed to this socket. */
const liveOpenerCount = (sock: Sock): number =>
  sock.frames.filter(
    (f) => f['type'] === 'agent_message' && String(f['body'] ?? '').includes('What should I call you?'),
  ).length

/**
 * Seed DISPATCHES this process made — CHAT TURNS carrying the auto-start
 * instruction. The `<role>general-agent</role>` clause is what separates a real
 * dispatched turn from the reflection extractor, which runs afterwards on its
 * own tiny prompt and quotes the same exchange back (it would otherwise inflate
 * every count by one).
 */
const seedDispatchCount = (h: Harness): number =>
  h.specs.filter(
    (s) =>
      typeof s.prompt === 'string' &&
      s.prompt.includes(SEED_INSTRUCTION) &&
      s.prompt.includes('<role>general-agent</role>'),
  ).length

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      // A synthetic key is what makes the LLM pool non-null → `appWsChatTurn` is
      // non-null → the seed path exists at all. Without it there is nothing to test.
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-welcome-seed-once',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
    },
  })
})

const openHarnesses: Harness[] = []
afterEach(async () => {
  while (openHarnesses.length > 0) {
    const h = openHarnesses.pop()!
    await h.close()
  }
  home.restore()
})

async function boot(): Promise<Harness> {
  const h = await startHarness()
  openHarnesses.push(h)
  return h
}

describe('Open onboarding — the welcome opener is emitted exactly once (live seam)', () => {
  test('a single connect emits exactly one opener', async () => {
    const h = await boot()
    const sock = await openSocket(h.base)

    await waitFor(() => persistedOpenerCount() === 1)
    // Let any follow-on traffic settle so a second opener would have landed by now.
    await sleep(500)

    expect(persistedOpenerCount()).toBe(1)
    expect(liveOpenerCount(sock)).toBe(1)
    expect(seedDispatchCount(h)).toBe(1)

    sock.ws.close()
    await sleep(50)
  }, 45_000)

  test('two rapid CONCURRENT connects to the same topic emit exactly one opener', async () => {
    const h = await boot()
    // Both sockets open before either seed can persist a row — the durable gate
    // alone cannot see the other's opener yet, so this is what the single-flight
    // latch exists for.
    const [a, b] = await Promise.all([openSocket(h.base), openSocket(h.base)])

    await waitFor(() => persistedOpenerCount() >= 1)
    await sleep(800)

    // ONE durable opener, and only ONE dispatch reached the substrate at all —
    // the second connect awaited the first rather than composing its own turn.
    expect(persistedOpenerCount()).toBe(1)
    expect(seedDispatchCount(h)).toBe(1)
    // The live push is fanned to the topic, so both sockets may render it; what
    // must never happen is either socket seeing it twice.
    expect(liveOpenerCount(a)).toBeLessThanOrEqual(1)
    expect(liveOpenerCount(b)).toBeLessThanOrEqual(1)

    a.ws.close()
    b.ws.close()
    await sleep(50)
  }, 45_000)

  test('REGRESSION: a reconnect after a PROCESS RESTART does not re-seed', async () => {
    // Process 1 — fresh install, owner connects, gets greeted.
    const first = await boot()
    const sock1 = await openSocket(first.base)
    await waitFor(() => persistedOpenerCount() === 1)
    sock1.ws.close()
    await sleep(50)

    // The restart: tear the whole process down (server + composition + graph),
    // leaving ONLY the persisted store. Every in-memory guard is now empty —
    // this is precisely the state in which the old per-process `Set` re-seeded.
    await first.close()
    openHarnesses.pop()

    // Process 2 — same DB, brand-new guard state, owner reconnects.
    const second = await boot()
    const sock2 = await openSocket(second.base)
    await sleep(1_000)

    // Still exactly one opener in the durable store the client hydrates from…
    expect(persistedOpenerCount()).toBe(1)
    // …and the new process never even dispatched a seed turn: the durable gate
    // answered before the substrate was touched.
    expect(seedDispatchCount(second)).toBe(0)
    expect(liveOpenerCount(sock2)).toBe(0)

    sock2.ws.close()
    await sleep(50)
  }, 60_000)
})
