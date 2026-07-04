/**
 * HTTP-surface regression test for ISSUES #40.
 *
 * `GET /api/app/focus/current` looks up `current_focus_pick` by
 * `(project_slug, day)` where `day` is `resolveOwnerDay(now, timezone)`.
 * Production wires `timezone` from `instance_metadata.timezone` per the boot
 * shell in `gateway/index.ts`. Before this fix the surface fell back to
 * the LA-hardcoded `DEFAULT_OWNER_TIMEZONE`, so any non-LA instance whose
 * nudge cron wrote a row keyed on today-in-their-zone hit a 404 from the
 * surface (which was looking up today-in-LA).
 *
 * This test pins the end-to-end behavior at a UTC instant that
 * deliberately straddles the LA / NYC day boundary:
 *   2026-05-29 05:00 UTC = 2026-05-28 22:00 LA = 2026-05-29 01:00 NYC.
 * A row with `day=2026-05-29` is the "today" pick for a NYC-zoned instance at
 * that instant. The LA-keyed lookup would see "today = 2026-05-28" and
 * return 404 — exactly the bug ISSUES #40 documents.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../../channels/index.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { TaskStore } from '../../../tasks/store.ts'
import {
  createAppFocusCurrentSurface,
  type FocusCurrentResponse,
} from '../app-focus-current-surface.ts'

const OWNER = 'demo'

/**
 * 2026-05-29 05:00 UTC — both LA and NYC are in DST.
 *   - LA  = UTC-7 → 2026-05-28 22:00 → day 2026-05-28
 *   - NYC = UTC-4 → 2026-05-29 01:00 → day 2026-05-29
 */
const STRADDLE_NOW_UTC = Date.UTC(2026, 4, 29, 5, 0, 0)

// --- in-process handler shim (no socket) -------------------------------------
// This surface test used to bind a real `Bun.serve({ port: 0 })` and round-trip
// via the global `fetch`, holding a live listener in the chunk's RSS until
// teardown. Instead each harness registers its dispatch fn (the same
// `surface.handler(req) ?? 404` the socket used) under a unique in-process base,
// and `fetch` is shadowed at module scope so requests to a registered base
// dispatch straight to it — identical assertions, no socket. Unrelated URLs fall
// through to the real fetch.
const __dispatchers = new Map<string, (req: Request) => Promise<Response>>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  const dispatch = __dispatchers.get(new URL(req.url).host)
  if (dispatch !== undefined) return dispatch(req)
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  db: ProjectDb
  tasks: TaskStore
  base: string
  close(): Promise<void>
}

async function startGateway(timezone: string): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-focus-current-tz-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const tasks = new TaskStore(db)
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const surface = createAppFocusCurrentSurface({
    db,
    auth,
    now: () => STRADDLE_NOW_UTC,
    timezone,
  })
  const host = `gw-${++__gatewaySeq}.test`
  __dispatchers.set(host, async (req) => {
    const res = await surface.handler(req)
    return res ?? new Response('not found', { status: 404 })
  })
  return {
    db,
    tasks,
    base: `http://${host}`,
    close: async () => {
      __dispatchers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function seedPickForToday(
  db: ProjectDb,
  task_id: string,
  day: string,
  rationale = 'pick for the day',
): Promise<void> {
  await db.run(
    `INSERT INTO current_focus_pick
      (project_slug, day, task_id, llm_rationale, top_3_task_ids,
       created_at, llm_model, llm_request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      OWNER,
      day,
      task_id,
      rationale,
      JSON.stringify([task_id]),
      `${day}T12:00:00.000Z`,
      'claude-haiku-4-5',
    ],
  )
}

describe('GET /api/app/focus/current resolves day in the owner timezone', () => {
  let h: Harness

  afterEach(async () => {
    await h.close()
  })

  it('NYC-zoned surface returns 200 for a pick keyed on the NYC day', async () => {
    h = await startGateway('America/New_York')
    const t = await h.tasks.create({
      project_slug: OWNER,
      title: 'NYC pick',
      priority: 3,
    })
    // NYC day at STRADDLE_NOW_UTC = 2026-05-29 → row matches → 200.
    await seedPickForToday(h.db, t.id, '2026-05-29', 'NYC pick rationale')

    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as FocusCurrentResponse
    expect(body.ok).toBe(true)
    expect(body.pick.day).toBe('2026-05-29')
    expect(body.pick.task_id).toBe(t.id)
    expect(body.pick.llm_rationale).toBe('NYC pick rationale')
  })

  it('LA-zoned surface 404s on the same row (LA day is 2026-05-28)', async () => {
    h = await startGateway('America/Los_Angeles')
    const t = await h.tasks.create({
      project_slug: OWNER,
      title: 'LA pick',
      priority: 3,
    })
    // Seed under the NYC day key; an LA-zoned surface sees today as
    // 2026-05-28 at STRADDLE_NOW_UTC and finds no row → 404.
    await seedPickForToday(h.db, t.id, '2026-05-29', 'NYC pick rationale')

    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('no_pick_today')
  })

  it('NYC-zoned surface 404s when only an LA-day row exists', async () => {
    h = await startGateway('America/New_York')
    const t = await h.tasks.create({
      project_slug: OWNER,
      title: 'NYC pick miss',
      priority: 3,
    })
    // Inverse of the row above: only the LA day (2026-05-28) is seeded.
    // NYC day is 2026-05-29 at the straddle instant → no match → 404.
    // This guards the "fall back to LA was masking the bug" failure
    // mode where the wiring silently used the wrong tz.
    await seedPickForToday(h.db, t.id, '2026-05-28', 'LA pick rationale')

    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('no_pick_today')
  })

  it('LA-zoned surface returns 200 for an LA-day row (no regression)', async () => {
    h = await startGateway('America/Los_Angeles')
    const t = await h.tasks.create({
      project_slug: OWNER,
      title: 'LA happy path',
      priority: 3,
    })
    await seedPickForToday(h.db, t.id, '2026-05-28', 'LA pick rationale')

    const res = await fetch(`${h.base}/api/app/focus/current`, {
      headers: { authorization: 'Bearer dev' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as FocusCurrentResponse
    expect(body.pick.day).toBe('2026-05-28')
    expect(body.pick.task_id).toBe(t.id)
  })
})
