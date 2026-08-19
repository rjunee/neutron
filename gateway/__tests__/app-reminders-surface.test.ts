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

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
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
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
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
  seedMigratedDb(join(tmp, 'owner.db'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
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
      owner_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 3000,
      message: 'later',
    })
    await harness.store.create({
      owner_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 1000,
      message: 'soon',
    })
    await harness.store.create({
      owner_slug: 'demo',
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
      owner_slug: 'demo',
      topic_id: appProjectTopicId(PROJECT_ID),
      fire_at: FIXED_NOW_S + 1000,
      message: 'demo reminder',
    })
    await harness.store.create({
      owner_slug: 'demo',
      topic_id: appProjectTopicId(OTHER_PROJECT_ID),
      fire_at: FIXED_NOW_S + 1000,
      message: 'other reminder',
    })
    // Also seed an instance-wide reminder (topic_id NULL) that should NOT
    // appear in either project's tab.
    await harness.store.create({
      owner_slug: 'demo',
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
        owner_slug: 'demo',
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
        owner_slug: 'demo',
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
        owner_slug: 'demo',
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
        owner_slug: 'demo',
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
      owner_slug: 'demo',
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
      owner_slug: 'demo',
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
      owner_slug: 'demo',
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
      owner_slug: 'demo',
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
      owner_slug: 'demo',
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
      owner_slug: 'demo',
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
      owner_slug: 'demo',
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

/**
 * THE NO-PROJECT SCOPE IS NOT A PROJECT CALLED `general`.
 *
 * The rail spells General `~general`, and this surface used to see only whatever
 * the client collapsed that to — the literal `general`, which is a legal project
 * id. On an instance that HAS a project of that name the two rail entries
 * resolved to one `app-project:general` topic, so they shared a pending list AND
 * its create / snooze / cancel. Reads make that a visibility bug; the writes are
 * what make it a data bug.
 *
 * Driven end-to-end through the composed handler rather than by unit-testing
 * `resolveScopeSegment`, because the interesting claim is not "the function
 * returns a different string" — it is "a create in one scope is invisible and
 * immutable in the other", which only the store can answer.
 */
describe('app-reminders surface — the reserved General segment', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway({ now: fixedNow })
  })
  afterEach(async () => {
    await harness.close()
  })

  const GENERAL_SEGMENT = '~general'
  /** The one id that collides: a real project whose id IS the old General segment. */
  const COLLIDING_PROJECT_ID = 'general'

  async function create(segment: string, message: string): Promise<Response> {
    return await authedFetch(harness.base, `/api/app/projects/${segment}/reminders`, {
      method: 'POST',
      body: JSON.stringify({ message, fire_at: FIXED_NOW_S + 3600 }),
    })
  }

  async function list(segment: string): Promise<Array<{ id: string; message: string }>> {
    const res = await authedFetch(harness.base, `/api/app/projects/${segment}/reminders`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      reminders: Array<{ id: string; message: string }>
    }
    return json.reminders
  }

  it('accepts the sentinel that sanitizeProjectId rejects, and echoes it back', async () => {
    // `~` is outside `[A-Za-z0-9_.-]`, so before the reservation this was a 400 —
    // which is what put an error banner where General's reminders belong.
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${GENERAL_SEGMENT}/reminders`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; project_id: string }
    expect(json.ok).toBe(true)
    expect(json.project_id).toBe(GENERAL_SEGMENT)
  })

  it('still rejects every OTHER out-of-alphabet segment — the match is exact', async () => {
    // A prefix or a `startsWith` here would hand `~generalize` the General scope,
    // and silently: it would 200 rather than 400. Both directions pinned.
    for (const bad of ['~generalize', '~general-2', '~gen', '~', 'has%20space']) {
      const res = await authedFetch(harness.base, `/api/app/projects/${bad}/reminders`)
      expect(res.status).toBe(400)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('invalid_project_id')
    }
  })

  it('lands the General scope on its own topic, which no project id can spell', async () => {
    await create(GENERAL_SEGMENT, 'general scope row')
    const rows = harness.store.listPendingByTopic(
      'demo',
      appProjectTopicId(GENERAL_SEGMENT),
    )
    expect(rows.map((r) => r.message)).toEqual(['general scope row'])
    // And nothing landed on the topic the collision used to share.
    expect(
      harness.store.listPendingByTopic('demo', appProjectTopicId(COLLIDING_PROJECT_ID)),
    ).toEqual([])
  })

  it('a create in each scope is invisible in the other — THE COLLISION, closed', async () => {
    expect((await create(GENERAL_SEGMENT, 'from the General tab')).status).toBe(200)
    expect((await create(COLLIDING_PROJECT_ID, 'from the general project')).status).toBe(
      200,
    )
    expect((await list(GENERAL_SEGMENT)).map((r) => r.message)).toEqual([
      'from the General tab',
    ])
    expect((await list(COLLIDING_PROJECT_ID)).map((r) => r.message)).toEqual([
      'from the general project',
    ])
  })

  /**
   * Drive snooze + cancel from `attacker_segment` at a row that belongs to
   * `victim_segment`, and assert the row survives untouched.
   *
   * Parameterised because "neither scope" is a claim about BOTH directions and
   * the first version of this test only ever created a General row — so it
   * proved General-attacked-via-the-project and left the mirror image, a General
   * URL reaching into the real project, entirely unexercised. A one-directional
   * reservation would have passed it.
   */
  async function assertCannotReachAcross(
    victim_segment: string,
    attacker_segment: string,
    message: string,
  ): Promise<void> {
    expect((await create(victim_segment, message)).status).toBe(200)
    const victim_row = (await list(victim_segment))[0]
    if (victim_row === undefined) throw new Error(`the ${victim_segment} create did not land`)

    // The mutating half of the finding. Pre-fix these were the SAME URL, so a
    // cancel meant for one scope destroyed a row belonging to the other.
    for (const action of ['snooze', 'cancel'] as const) {
      const res = await authedFetch(
        harness.base,
        `/api/app/projects/${attacker_segment}/reminders/${victim_row.id}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify({ new_fire_at: FIXED_NOW_S + 7200 }),
        },
      )
      expect(res.status).toBe(404)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('reminder_not_found')
    }
    // Still pending, still the victim's, untouched by either attempt.
    expect((await list(victim_segment)).map((r) => r.id)).toEqual([victim_row.id])
  }

  it("the project cannot snooze or cancel the General scope's row", async () => {
    await assertCannotReachAcross(GENERAL_SEGMENT, COLLIDING_PROJECT_ID, 'from the General tab')
  })

  it("the General scope cannot snooze or cancel the project's row", async () => {
    // The direction the original test never built a row for. It is not symmetric
    // by inspection: General's segment is reserved by an exact-match branch that
    // runs BEFORE `sanitizeProjectId`, so this path exercises different code than
    // its mirror and has to be asserted rather than assumed.
    await assertCannotReachAcross(
      COLLIDING_PROJECT_ID,
      GENERAL_SEGMENT,
      'from the general project',
    )
  })

  it("the include_id widening does not leak the other scope's row either", async () => {
    // `include_id` is caller-controlled and admits a non-pending row, so it is the
    // one path that could re-open the collision after the topic split. It re-checks
    // `extra.topic_id === topic_id`, and this is the pin on that.
    await create(GENERAL_SEGMENT, 'from the General tab')
    const general_row = (await list(GENERAL_SEGMENT))[0]
    if (general_row === undefined) throw new Error('the General create did not land')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${COLLIDING_PROJECT_ID}/reminders?status=pending&include_id=${general_row.id}`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { reminders: Array<{ id: string }> }
    expect(json.reminders).toEqual([])
  })
})
