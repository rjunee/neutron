/**
 * The Managed post-onboarding claim redirect must fire AT MOST ONCE PER OWNER —
 * durably, across page reloads — not once per page load.
 *
 * THE BUG (live, Ryan's managed instance 2026-07-19): after claiming a personal
 * URL the owner was locked out by an infinite loop — chat → the claim page
 * ("Your personal URL is already set") → "Open my workspace" → chat → claim,
 * forever, on a completely healthy instance.
 *
 * ROOT CAUSE: `on_session_open` (`open/wiring/app-ws.ts`) replays a one-shot
 * `onboarding_completed` frame on EVERY connect whose persisted phase is
 * `completed` when a claim URL is configured. The React client navigates to the
 * claim page on that frame, deduped by `claimRedirected` — a field on the
 * CONTROLLER INSTANCE, so it only dedupes within one page load. Every reload
 * built a fresh controller and re-armed it.
 *
 * The pre-fix code justified this with a comment asserting the loop was
 * impossible because "once the owner claims they move to a host without the
 * env". That is FALSE: claiming renames `url_slug`, it does NOT change the
 * tenant process or its environment, so the SAME process — still carrying
 * NEUTRON_POST_ONBOARDING_CLAIM_URL — serves the claimed host.
 *
 * THE FIX: gate the replay on the durable `onboarding_handoff_emitted_at` stamp
 * (migration 0052 — a column the schema has always carried and NOTHING ever
 * wrote), and stamp it after a successful send.
 *
 * WHY THIS TEST BOOTS THE STACK AND RECONNECTS: the defect is invisible to any
 * single-connect check and to every unauthenticated HTTP probe — the status
 * codes are 200/302 either way. It only exists ACROSS a reload. So this boots a
 * real composer + production graph + app WebSocket and counts the frames the
 * owner actually receives over TWO successive connects.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'

const GENERAL_TOPIC = 'app:owner'
const CLAIM_URL = 'https://auth.neutron.computer/claim'

let home: IsolatedHome
let db: ProjectDb
let servers: Array<{ close: () => Promise<void> }> = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Boot {
  base: string
  close: () => Promise<void>
}

async function boot(): Promise<Boot> {
  const specs: AgentSpec[] = []
  const composer = buildOpenGraphComposer({
    env: { ...process.env, NEUTRON_POST_ONBOARDING_CLAIM_URL: CLAIM_URL },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => ({
      spawn: async (spec: AgentSpec) => {
        specs.push(spec)
        return {
          events: (async function* () {})(),
          send: async () => {},
          close: async () => {},
        }
      },
    })) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => graph.fetch!(req, srv),
    websocket: graph.websocket!,
  })
  const b: Boot = {
    base: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true)
      for (const c of composition.realmode_cleanups ?? []) {
        try {
          c()
        } catch {
          /* teardown */
        }
      }
      await graph.shutdown()
    },
  }
  servers.push(b)
  return b
}

/** Connect, collect frames for a beat, return how many `onboarding_completed` arrived. */
async function connectAndCountCompleted(base: string): Promise<number> {
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
  // Wait for the session to be live, then let the replay (if any) land.
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && !frames.some((f) => f['type'] === 'session_ready')) {
    await sleep(25)
  }
  await sleep(900)
  const count = frames.filter((f) => f['type'] === 'onboarding_completed').length
  ws.close()
  await sleep(80)
  return count
}

beforeEach(async () => {
  home = createIsolatedHome({ slug: 'owner' })
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  // The owner has FINISHED onboarding — the state the loop occurred in.
  db.raw().run(
    `INSERT INTO onboarding_state (project_slug, user_id, phase, phase_state_json,
       started_at, last_advanced_at, completed_at, persona_files_committed, wow_fired)
     VALUES ('owner','owner','completed','{}',?,?,?,1,1)`,
    [Date.now(), Date.now(), Date.now()],
  )
})

afterEach(async () => {
  for (const s of servers) await s.close().catch(() => {})
  servers = []
  db.close()
  home.restore()
})

describe('Managed claim redirect — at most once per OWNER, not per page load', () => {
  test('REGRESSION: a RECONNECT (page reload) does NOT re-fire the claim redirect', async () => {
    const first = await boot()
    const firstCount = await connectAndCountCompleted(first.base)
    // The owner is entitled to the signal exactly once.
    expect(firstCount).toBe(1)

    // A page reload = a fresh socket against the SAME server + SAME durable row.
    // Pre-fix this fired again (the client latch is per page load), producing the
    // chat → claim → chat → claim loop that locked the owner out.
    const secondCount = await connectAndCountCompleted(first.base)
    expect(secondCount).toBe(0)
  }, 45_000)

  test('the durable stamp is what makes it one-shot (survives a process restart)', async () => {
    const first = await boot()
    expect(await connectAndCountCompleted(first.base)).toBe(1)
    await first.close()

    // A genuinely new process — the in-memory latch cannot help here at all.
    const second = await boot()
    expect(await connectAndCountCompleted(second.base)).toBe(0)
  }, 45_000)
})
