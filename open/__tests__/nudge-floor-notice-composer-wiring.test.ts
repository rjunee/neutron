/**
 * THE PRODUCTION WIRING OF THE NUDGE LANE'S FLOOR-CLAMP SINK, pinned end to end.
 *
 * THE GAP THIS CLOSES. The nudge lane shares `PROFILE_WARM_CHAT`, so it carries
 * `frontier_model_floor` and `applyModelFloor` CAN clamp it. It was built with no
 * notice sink at all, which made that clamp a stderr line on a box nobody reads —
 * the exact silent degradation the floor notice exists to end, reintroduced on a
 * new lane. The fix gives the lane a JOURNAL-ONLY sink: recorded, never bubbled.
 *
 * That fix has two halves and only one of them was pinned. The wiring tests build
 * their own context and INJECT both sink bags, so they prove `wireSubstrates`
 * routes whatever it is handed — and stay green when the composer stops handing it
 * anything. Deleting the composer's single `backgroundNoticeSinks` thread left 862
 * tests passing across 105 files while returning the timer-driven lane to a
 * stderr-only clamp. A seam that only one line reaches, and no test drives that
 * line, is not wired; it is coincidence.
 *
 * So this file drives the REAL `buildOpenGraphComposer` over a live server, with a
 * capturing `substrateFactory` in place of `claude`, and reads the options the
 * production composition actually handed each lane:
 *
 *   • the chat lane's sink BUBBLES — asserted as a live `system_notice` frame on a
 *     connected `/ws/app/chat` socket. This is the POSITIVE CONTROL: without it,
 *     "the nudge lane produced no bubble" could just mean this harness cannot see
 *     bubbles at all, and the whole file would prove nothing.
 *   • the nudge lane's sink EXISTS and does NOT bubble — no frame, from the same
 *     socket, in the same test, after the control has proven the socket works.
 *   • both JOURNAL. Best-effort, said exactly: `emitSystemEventSafe` swallows a
 *     write failure and an unregistered ambient sink is a no-op, so what is
 *     asserted is that the attempt reaches a registered sink — which is what makes
 *     a clamp findable afterwards instead of existing only on stderr.
 *
 * The nudge lane's options are only observable once something composes on it, so
 * the test fires a REAL reminder through the real tick loop and dispatcher to get
 * there. That is deliberate: it is the same path the incident took.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb, SystemEventsStore, pushSystemEventSink } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { drainRealmodeCleanups } from '@neutronai/gateway/index.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

import { buildOpenGraphComposer } from '../composer.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
  // THE HARNESS PASSES THE REAL `process.env` TO THE REAL COMPOSER, so any ambient
  // provider selection is a live input to the thing under test. With
  // `NEUTRON_MODEL_PROVIDER=openai` exported, the composer builds the OpenAI lanes,
  // the injected Claude `substrateFactory` is never called, and this file fails with
  // `waitFor timed out` — a wiring-failure message for an environment problem, which
  // is the one wrong conclusion it must not produce. Cleared here so the run is
  // hermetic on the Claude path it is written to test.
  'NEUTRON_MODEL_PROVIDER',
  'OPENAI_API_KEY',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string | null = null

interface Harness {
  base: string
  db: ProjectDb
  captured: ClaudeCodeSubstrateOptions[]
  close(): Promise<void>
}
let harness: Harness | null = null
let clearSink: (() => void) | null = null

/** Canned substrate — every lane composes a short body and completes. */
function cannedSubstrate(): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'ok' }
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-nudge-floor-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
  delete process.env['NEUTRON_MODEL_PROVIDER']
  delete process.env['OPENAI_API_KEY']
})

afterEach(async () => {
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  if (clearSink !== null) {
    clearSink()
    clearSink = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  // Only if setup got far enough to make one. `rmSync(undefined)` throws a
  // `TypeError` from teardown, which REPLACES whatever setup actually failed with
  // a message about the wrong thing entirely.
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 40_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

async function startHarness(): Promise<Harness> {
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
  // The ambient journal sink the real boot pushes (`gateway/index.ts`). Without it
  // every `emitSystemEventSafe` is a documented no-op, so this is what the harness
  // has to supply for the journal half to be observable at all.
  clearSink = pushSystemEventSink(new SystemEventsStore({ db }))
  const captured: ClaudeCodeSubstrateOptions[] = []
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (opts: ClaudeCodeSubstrateOptions): Substrate => {
      captured.push(opts)
      return cannedSubstrate()
    },
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
    captured,
    close: async () => {
      await server.stop(true)
      await graph.shutdown()
      // The PRODUCTION drain, not a local loop. A `realmode_cleanup` is typed
      // `() => void | Promise<void>` and `gateway/index.ts` awaits each one before
      // `db.close()` for a reason — the async ones have in-flight work. Calling
      // them un-awaited here let that work reach a closed SQLite handle after the
      // test finished. Reusing the real drain also keeps the ordering identical to
      // boot's, which is the ordering this file claims to exercise.
      await drainRealmodeCleanups(composition.realmode_cleanups ?? [])
      db.close()
    },
  }
}

const NOTICE = {
  sessionKey: 'owner:proj:main',
  source: 'resume',
  requested: 'claude-fast-tier',
  floor: 'claude-best-tier',
} as const

describe('the REAL composer wires the nudge lane a floor sink that records without interrupting', () => {
  test('chat lane bubbles, nudge lane does not, and both reach the journal', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-nudge-floor-notice'
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    const frames: Array<Record<string, unknown>> = []
    ws.onmessage = (e) => {
      try {
        frames.push(JSON.parse(String(e.data)) as Record<string, unknown>)
      } catch {
        /* non-JSON frames are not this test's business */
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })

    // An ordinary turn constructs the owner's chat lane…
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user_message',
        body: 'hello',
        client_msg_id: 'c-nudge-floor-1',
      }),
    )
    await waitFor(
      () => harness!.captured.some((o) => o.substrate_instance_id === 'cc-agent-owner'),
      20_000,
    )

    // …and a REAL fired reminder constructs the background one. Nothing shorter
    // reaches it: the lane's options exist only once something composes on it.
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user_message',
        body: '/remind drink water in 5 minutes',
        client_msg_id: 'c-nudge-floor-2',
      }),
    )
    await waitFor(
      () =>
        (harness!.db.raw().query('SELECT count(*) c FROM reminders').get() as { c: number }).c > 0,
      20_000,
    )
    const row = harness!.db.raw().query('SELECT id FROM reminders LIMIT 1').get() as { id: string }
    harness!.db
      .raw()
      .run('UPDATE reminders SET fire_at = ? WHERE id = ?', [
        Math.floor(Date.now() / 1000) - 5,
        row.id,
      ])
    // The composition's reminder tick is on a 30s interval, so this waits for a real
    // sweep rather than poking the dispatcher directly — the compose has to happen on
    // the production path for the lane's options to be the production ones. Generous
    // because CI is slower than a laptop and a timeout here would read as a wiring
    // failure rather than a slow tick.
    await waitFor(
      () => harness!.captured.some((o) => o.substrate_instance_id === 'cc-nudge-owner'),
      90_000,
    )

    const agent = harness.captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')!
    const nudge = harness.captured.find((o) => o.substrate_instance_id === 'cc-nudge-owner')!

    // BOTH floored lanes carry a clamp sink out of the real composition. This is
    // the assertion the deleted composer thread survived.
    expect(typeof agent.onModelFloorApplied).toBe('function')
    expect(typeof nudge.onModelFloorApplied).toBe('function')
    expect(nudge.onModelFloorApplied).not.toBe(agent.onModelFloorApplied)

    // POSITIVE CONTROL — the chat lane's sink reaches the owner's chat as a
    // transient `system_notice` pill. Everything below is only meaningful because
    // this passes on the same socket in the same test.
    const beforeChat = frames.length
    agent.onModelFloorApplied!(NOTICE)
    await waitFor(
      () =>
        frames
          .slice(beforeChat)
          .some(
            (f) =>
              f['system_notice'] === true &&
              typeof f['body'] === 'string' &&
              (f['body'] as string).includes(NOTICE.floor),
          ),
      10_000,
    )

    // THE SUBJECT — the same notice on the nudge lane reaches no chat surface. A
    // timer must not be able to push a bubble at him, which is why the lane has its
    // own sink rather than the chat lane's.
    const beforeNudge = frames.length
    nudge.onModelFloorApplied!(NOTICE)
    await sleep(1_500)
    // Matched on the CLAMP COPY, not on `system_notice` alone. The transient pill
    // shape is shared — the cold-start "Waking up…" ack is also a
    // `durability: 'none'` `system_notice` — so counting every pill would let an
    // unrelated ack racing into this window fail the test with a message that reads
    // "the nudge lane bubbles", which is the one wrong conclusion this file must not
    // produce. The floor body is fixed copy naming the floor model, so the narrower
    // filter still sees a real clamp bubble: under the mutation that hands this lane
    // the chat `deliver`, ten of these arrive.
    const bubbles = frames
      .slice(beforeNudge)
      .filter(
        (f) =>
          f['system_notice'] === true &&
          typeof f['body'] === 'string' &&
          (f['body'] as string).includes(NOTICE.floor),
      )
    expect(bubbles).toEqual([])

    // BOTH REACHED THE JOURNAL — best-effort, so what this proves is that the
    // attempt lands on a registered sink, not that a row is guaranteed. Two rows:
    // the clamp is recorded on either lane, which is the half of the fix that ends
    // the silence.
    await waitFor(() => {
      const { c } = harness!.db
        .raw()
        .query("SELECT count(*) c FROM system_events WHERE event_name = 'model_floor_applied'")
        .get() as { c: number }
      return c >= 2
    }, 10_000)
    const journal = harness.db
      .raw()
      .query(
        "SELECT payload_json FROM system_events WHERE event_name = 'model_floor_applied' ORDER BY ts",
      )
      .all() as Array<{ payload_json: string }>
    expect(journal.length).toBeGreaterThanOrEqual(2)
    for (const r of journal) {
      const payload = JSON.parse(r.payload_json) as Record<string, unknown>
      expect(payload['floor_model']).toBe(NOTICE.floor)
      expect(payload['requested_model']).toBe(NOTICE.requested)
    }

    ws.close()
    await sleep(50)
  }, 180_000)
})
