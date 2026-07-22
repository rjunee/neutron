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
import { SqliteOnboardingStateStore } from '@neutronai/onboarding/interview/sqlite-state-store.ts'
import {
  buildOnboardingFinalize,
  type OnboardingFinalizeDeps,
  type PersonaComposerLike,
} from '@neutronai/gateway/wiring/build-onboarding-finalize.ts'
import {
  buildScaffoldMaterializer,
  ensureProjectRow,
} from '@neutronai/gateway/wiring/project-create.ts'

const GENERAL_TOPIC = 'app:owner'
const CLAIM_URL = 'https://auth.managed.example/claim'

let home: IsolatedHome
let db: ProjectDb
let servers: Array<{ close: () => Promise<void> }> = []
let priorCookieSecret: string | undefined

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
  // Boot needs a signed-owner-session secret (open/composer.ts refuses a
  // predictable fallback). Set it here so this file is runnable in ISOLATION
  // rather than depending on env leakage from a sibling .open.test.ts.
  priorCookieSecret = process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET']
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
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
  if (priorCookieSecret === undefined) delete process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET']
  else process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = priorCookieSecret
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

/** A persona composer that records calls but does no real synthesis. */
function fakePersonaComposer(): PersonaComposerLike {
  return {
    async compose(): Promise<unknown> {
      return { draft_id: 'fake', status: 'committed' }
    },
    async commit(): Promise<unknown> {
      return { committed_at: 0, git_sha: null, paths: [] }
    },
  }
}

/**
 * Run a REAL onboarding finalize (the LIVE `onboarding_completed` emit path) over
 * the shared db, exactly as production does at the terminal transition. Returns
 * how many live frames the emit seam fired.
 */
async function runLiveFinalize(): Promise<number> {
  const nowMs = () => Date.now()
  const stateStore = new SqliteOnboardingStateStore({ db, now: nowMs })
  // Replace the file-level completed seed with a PRE-terminal row so finalize
  // actually runs its terminal transition (and therefore the live emit).
  db.raw().run(`DELETE FROM onboarding_state WHERE project_slug = 'owner' AND user_id = 'owner'`)
  const seeded = await stateStore.upsert({
    owner_slug: 'owner',
    user_id: 'owner',
    phase: 'persona_reviewed',
    phase_state_patch: {
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      primary_projects: ['Topline Revenue'],
    },
  })

  let liveFrames = 0
  const deps: OnboardingFinalizeDeps = {
    owner_home: home.dir,
    owner_slug: 'owner',
    db,
    stateStore,
    personaLoader: { invalidate: (): void => {} },
    ensureProjectRow,
    materializer: buildScaffoldMaterializer({
      owner_home: home.dir,
      project_slug: 'owner',
      db,
      now: nowMs,
    }),
    emitProjectsChanged: (): void => {},
    // The LIVE emit seam — the frame the browser catches at finalize time. This
    // scenario models the browser CONNECTED at finalize, so the frame is
    // DELIVERED (returns true) and finalize writes the durable
    // `onboarding_handoff_emitted_at` stamp alongside it — the behaviour under
    // test. (The zero-socket / not-delivered case is covered in the finalize unit
    // suite, gateway/wiring/__tests__/build-onboarding-finalize.test.ts.)
    emitOnboardingCompleted: (): boolean => {
      liveFrames += 1
      return true
    },
    now: nowMs,
    log: (): void => {},
    personaComposer: fakePersonaComposer(),
  }
  const finalizer = buildOnboardingFinalize(deps)
  const ok = await finalizer.finalize({ user_id: 'owner', topic_id: GENERAL_TOPIC, state: seeded })
  expect(ok).toBe(true)
  return liveFrames
}

describe('#374 Defect 2a — the LIVE-emit finalize is at-most-once with the reconnect replay', () => {
  test('REGRESSION: after a LIVE finalize, the FIRST reconnect does NOT re-fire onboarding_completed', async () => {
    // The scenario the durable-stamp fix (#404) left behind: onboarding finalizes
    // via the LIVE emit (browser connected), then the owner reconnects on the
    // renamed host. Pre-fix the live emit never stamped
    // `onboarding_handoff_emitted_at`, so the reconnect-recovery replay in
    // `open/wiring/app-ws.ts` saw a null stamp + phase='completed' and re-fired
    // the frame ONCE — bouncing the just-completed owner to the claim / manual-
    // link screen. With the live-emit stamp, the reconnect reads a non-null stamp
    // and emits ZERO.
    const liveFrames = await runLiveFinalize()
    expect(liveFrames).toBe(1) // the live emit fired exactly once

    // The durable stamp finalize wrote is what suppresses the replay.
    const stampRow = db
      .raw()
      .query(
        `SELECT onboarding_handoff_emitted_at AS stamp FROM onboarding_state
           WHERE project_slug = 'owner' AND user_id = 'owner'`,
      )
      .get() as { stamp: number | null } | null
    expect(stampRow?.stamp).not.toBeNull()

    // Now the owner reconnects (fresh socket) against the completed+stamped row.
    // Pre-fix (no live-emit stamp) this re-fired once → expect(0) FAILS.
    const boot1 = await boot()
    const reconnectCount = await connectAndCountCompleted(boot1.base)
    expect(reconnectCount).toBe(0)
  }, 45_000)
})
