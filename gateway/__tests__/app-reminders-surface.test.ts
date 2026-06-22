/**
 * P5.4 — gateway app-reminders surface tests.
 *
 * Verifies the four reminders routes (GET list + POST create / snooze /
 * cancel) round-trip through `composeHttpHandler` with the dev-bypass
 * auth resolver and a real `ReminderStore` over a temporary SQLite
 * database (mirrors `reminders/store.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ReminderStore } from '../../reminders/store.ts'
import {
  appProjectTopicId,
  createAppRemindersSurface,
} from '../http/app-reminders-surface.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'

// --- in-process handler shim (no socket) -------------------------------------
// These surface tests used to bind a real `Bun.serve({ port: 0 })` and round-
// trip via the global `fetch`, holding a live listener + socket buffers in the
// chunk's RSS until teardown. Instead each harness registers its composed
// handler under a unique in-process base, and `fetch` is shadowed at module
// scope so requests to a registered base dispatch straight to
// `composed.fetch(new Request(...))` — identical assertions, no socket.
// Unrelated URLs fall through to the real fetch.
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

interface Harness {
  base: string
  store: ReminderStore
  db: ProjectDb
  tmp: string
  close(): Promise<void>
}

const PROJECT_ID = 'demo-project'
const OTHER_PROJECT_ID = 'other-project'

async function startGateway(opts: { now?: () => number } = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-reminders-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new ReminderStore(db)
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppRemindersSurface({
    store,
    auth,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  const composed = composeHttpHandler({
    appReminders: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    store,
    db,
    tmp,
    close: async () => {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:sam')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

// Use a fixed clock so fire_at validation is deterministic.
const FIXED_NOW_MS = 1_700_000_000_000
const FIXED_NOW_S = FIXED_NOW_MS / 1000
const fixedNow = (): number => FIXED_NOW_MS

describe('app-reminders surface — GET list', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway({ now: fixedNow })
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}/reminders`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('returns an empty list for a fresh project', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      reminders: Array<{ id: string }>
      project_id: string
      project_slug: string
    }
    expect(json.ok).toBe(true)
    expect(json.project_id).toBe(PROJECT_ID)
    expect(json.project_slug).toBe('demo')
    expect(json.reminders).toEqual([])
  })

  it('rejects a malformed project_id', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/has%20space/reminders`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_project_id')
  })

  it('rejects unsupported status values', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders?status=fired`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_status')
  })

  it('orders pending reminders by fire_at ascending', async () => {
    // Seed via the store so we don't depend on the create endpoint.
    await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 3000,
      message: 'later',
    })
    await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 1000,
      message: 'soon',
    })
    await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 2000,
      message: 'middle',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { reminders: Array<{ message: string }> }
    expect(json.reminders.map((r) => r.message)).toEqual(['soon', 'middle', 'later'])
  })

  it('isolates reminders by project_id (topic_id encoding)', async () => {
    await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 1000,
      message: 'demo reminder',
    })
    await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(OTHER_PROJECT_ID),
      fire_at: FIXED_NOW_S + 1000,
      message: 'other reminder',
    })
    // Also seed an instance-wide reminder (topic_id NULL) that should NOT
    // appear in either project's tab.
    await harness.store.create({
      project_slug: 'demo',
      topic_id: null,
      fire_at: FIXED_NOW_S + 1000,
      message: 'engine-only reminder',
    })

    const demoRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
    )
    const demoJson = (await demoRes.json()) as { reminders: Array<{ message: string }> }
    expect(demoJson.reminders.map((r) => r.message)).toEqual(['demo reminder'])

    const otherRes = await authedFetch(
      harness.base,
      `/api/app/projects/${OTHER_PROJECT_ID}/reminders`,
    )
    const otherJson = (await otherRes.json()) as { reminders: Array<{ message: string }> }
    expect(otherJson.reminders.map((r) => r.message)).toEqual(['other reminder'])
  })

  // ISSUE #38 — `include_id` widens the response to include one specific
  // reminder even when its status is no longer `pending`. The tick loop
  // calls `markFired` BEFORE the push dispatcher fans out, so a one-shot
  // reminder is `status='fired'` by the time a user taps the push.
  // Without this widening, the reminders tab's
  // `?status=pending`-only fetch can't surface the deep-link target.
  describe('include_id widening (ISSUE #38)', () => {
    it('includes a fired reminder in the same project when ?include_id matches', async () => {
      const created = await harness.store.create({
        project_slug: 'demo',
        topic_id: appProjectTopicId(PROJECT_ID),
        fire_at: FIXED_NOW_S + 60,
        message: 'will fire',
      })
      await harness.store.markFired(created.id)

      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders?include_id=${created.id}`,
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as {
        reminders: Array<{ id: string; status: string; message: string }>
      }
      // Pending list is empty (the row is fired); include_id widens
      // the response to surface it anyway.
      expect(json.reminders).toHaveLength(1)
      expect(json.reminders[0]?.id).toBe(created.id)
      expect(json.reminders[0]?.status).toBe('fired')
      expect(json.reminders[0]?.message).toBe('will fire')
    })

    it('does not duplicate a pending reminder already in the list when include_id matches', async () => {
      const created = await harness.store.create({
        project_slug: 'demo',
        topic_id: appProjectTopicId(PROJECT_ID),
        fire_at: FIXED_NOW_S + 60,
        message: 'still pending',
      })
      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders?include_id=${created.id}`,
      )
      const json = (await res.json()) as {
        reminders: Array<{ id: string; status: string }>
      }
      expect(json.reminders).toHaveLength(1)
      expect(json.reminders[0]?.id).toBe(created.id)
      expect(json.reminders[0]?.status).toBe('pending')
    })

    it('silently ignores include_id pointing to a different project (no cross-topic leak)', async () => {
      const other = await harness.store.create({
        project_slug: 'demo',
        topic_id: appProjectTopicId(OTHER_PROJECT_ID),
        fire_at: FIXED_NOW_S + 60,
        message: 'other project',
      })
      await harness.store.markFired(other.id)

      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders?include_id=${other.id}`,
      )
      const json = (await res.json()) as { reminders: Array<{ id: string }> }
      // No fired demo-project rows + no leak from other-project = empty.
      expect(json.reminders).toEqual([])
    })

    it('silently ignores include_id pointing at a non-existent reminder', async () => {
      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders?include_id=does-not-exist`,
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as { reminders: Array<unknown> }
      expect(json.reminders).toEqual([])
    })

    it('rejects a malformed include_id with 400 invalid_include_id', async () => {
      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders?include_id=has%20space`,
      )
      expect(res.status).toBe(400)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('invalid_include_id')
    })

    it('byte-identical to pre-#38 response when include_id is omitted', async () => {
      // Regression-pin: the default (no include_id) path must NOT
      // change shape — the existing client baseline shouldn't notice.
      await harness.store.create({
        project_slug: 'demo',
        topic_id: appProjectTopicId(PROJECT_ID),
        fire_at: FIXED_NOW_S + 60,
        message: 'pending row',
      })
      const a = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders`,
      )
      const b = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders?status=pending`,
      )
      expect(await a.text()).toBe(await b.text())
    })
  })
})

describe('app-reminders surface — POST create', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway({ now: fixedNow })
  })
  afterEach(async () => {
    await harness.close()
  })

  it('persists a new reminder and returns the post-mutation list', async () => {
    const fire_at = FIXED_NOW_S + 3600
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
      {
        method: 'POST',
        body: JSON.stringify({ message: 'water the plants', fire_at }),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      reminders: Array<{ id: string; message: string; fire_at: number; status: string }>
    }
    expect(json.reminders).toHaveLength(1)
    expect(json.reminders[0]?.message).toBe('water the plants')
    expect(json.reminders[0]?.fire_at).toBe(fire_at)
    expect(json.reminders[0]?.status).toBe('pending')

    // And a fresh GET reflects the same row.
    const get = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
    )
    const getJson = (await get.json()) as {
      reminders: Array<{ message: string }>
    }
    expect(getJson.reminders.map((r) => r.message)).toEqual(['water the plants'])
  })

  it('trims whitespace from message', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: '   feed the dog   ',
          fire_at: FIXED_NOW_S + 60,
        }),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { reminders: Array<{ message: string }> }
    expect(json.reminders[0]?.message).toBe('feed the dog')
  })

  it('rejects malformed payloads', async () => {
    const bad: Array<{ body: string; expectedCode: string }> = [
      { body: 'not-json', expectedCode: 'malformed_json' },
      { body: JSON.stringify({ fire_at: FIXED_NOW_S + 60 }), expectedCode: 'missing_message' },
      { body: JSON.stringify({ message: '' }), expectedCode: 'missing_message' },
      {
        body: JSON.stringify({ message: '   ', fire_at: FIXED_NOW_S + 60 }),
        expectedCode: 'missing_message',
      },
      { body: JSON.stringify({ message: 'x' }), expectedCode: 'missing_fire_at' },
      {
        body: JSON.stringify({ message: 'x', fire_at: 'tomorrow' }),
        expectedCode: 'missing_fire_at',
      },
      {
        body: JSON.stringify({ message: 'x', fire_at: FIXED_NOW_S - 600 }),
        expectedCode: 'fire_at_in_past',
      },
    ]
    for (const { body, expectedCode } of bad) {
      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${PROJECT_ID}/reminders`,
        { method: 'POST', body },
      )
      expect(res.status).toBe(400)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe(expectedCode)
    }
  })

  it('rejects messages over the size cap', async () => {
    const giant = 'x'.repeat(4097)
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
      {
        method: 'POST',
        body: JSON.stringify({ message: giant, fire_at: FIXED_NOW_S + 60 }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_message')
  })
})

describe('app-reminders surface — POST snooze', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway({ now: fixedNow })
  })
  afterEach(async () => {
    await harness.close()
  })

  it('updates fire_at for a pending reminder', async () => {
    const created = await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 60,
      message: 'wake up',
    })
    const new_fire_at = FIXED_NOW_S + 3600
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${created.id}/snooze`,
      { method: 'POST', body: JSON.stringify({ new_fire_at }) },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { reminders: Array<{ id: string; fire_at: number }> }
    const updated = json.reminders.find((r) => r.id === created.id)
    expect(updated?.fire_at).toBe(new_fire_at)
  })

  it('refuses to snooze a reminder from a different project', async () => {
    const otherProjectReminder = await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(OTHER_PROJECT_ID),
      fire_at: FIXED_NOW_S + 60,
      message: 'cross-project leak attempt',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${otherProjectReminder.id}/snooze`,
      {
        method: 'POST',
        body: JSON.stringify({ new_fire_at: FIXED_NOW_S + 3600 }),
      },
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('reminder_not_found')
  })

  it('returns 404 for a non-existent reminder id', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/00000000-ghost/snooze`,
      {
        method: 'POST',
        body: JSON.stringify({ new_fire_at: FIXED_NOW_S + 3600 }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('rejects a malformed reminder id', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/has%20space/snooze`,
      {
        method: 'POST',
        body: JSON.stringify({ new_fire_at: FIXED_NOW_S + 3600 }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_reminder_id')
  })

  it('rejects a snooze into the past', async () => {
    const created = await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 60,
      message: 'x',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${created.id}/snooze`,
      {
        method: 'POST',
        body: JSON.stringify({ new_fire_at: FIXED_NOW_S - 3600 }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('fire_at_in_past')
  })

  it('returns 409 when the reminder is already cancelled', async () => {
    const created = await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 60,
      message: 'x',
    })
    await harness.store.cancel(created.id)
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${created.id}/snooze`,
      {
        method: 'POST',
        body: JSON.stringify({ new_fire_at: FIXED_NOW_S + 3600 }),
      },
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('reminder_not_pending')
  })
})

describe('app-reminders surface — POST cancel', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway({ now: fixedNow })
  })
  afterEach(async () => {
    await harness.close()
  })

  it('removes a pending reminder from the project list', async () => {
    const created = await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 60,
      message: 'x',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${created.id}/cancel`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { reminders: Array<{ id: string }> }
    expect(json.reminders.find((r) => r.id === created.id)).toBeUndefined()

    // The store row itself is `cancelled` (not deleted).
    const row = harness.store.get(created.id)
    expect(row?.status).toBe('cancelled')
  })

  it('refuses to cancel a reminder from a different project', async () => {
    const otherProjectReminder = await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(OTHER_PROJECT_ID),
      fire_at: FIXED_NOW_S + 60,
      message: 'cross-project leak attempt',
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${otherProjectReminder.id}/cancel`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 409 when the reminder is already fired', async () => {
    const created = await harness.store.create({
      project_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 60,
      message: 'x',
    })
    await harness.store.markFired(created.id)
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${created.id}/cancel`,
      { method: 'POST' },
    )
    expect(res.status).toBe(409)
  })
})

describe('app-reminders surface — fall-through behaviour', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway({ now: fixedNow })
  })
  afterEach(async () => {
    await harness.close()
  })

  it('does not claim unrelated /api paths', async () => {
    const res = await fetch(`${harness.base}/api/something/else`)
    expect(res.status).toBe(404)
  })

  it('does not claim /api/app/projects without a /reminders segment', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}`)
    expect(res.status).toBe(404)
  })

  it('returns 405 for an unknown method on the list path', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(405)
  })
})
