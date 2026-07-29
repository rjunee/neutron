/**
 * P5.5 — surface-level coverage for the new
 * `POST /api/app/projects/<id>/reminders/<id>/convert-to-task` route.
 *
 * Tests run isolated against `createAppRemindersSurface(...)` (NOT
 * the production composer — that's `reminders-production-composer.
 * test.ts`'s job). Exercise the six branches the brief locks:
 *
 *   1. Happy path (adapter wired, pending reminder, no overrides).
 *   2. Title + priority overrides flow through to the adapter input.
 *   3. Missing adapter → 501 not_implemented.
 *   4. Cross-project reminder id → 404 reminder_not_found.
 *   5. Non-pending reminder → 409 reminder_not_pending.
 *   6. Adapter throws → 500 convert_failed + the inner error message.
 *   7. Invalid title (empty / too long) → 400 invalid_title.
 *   8. Invalid priority (out-of-range / non-integer) → 400 invalid_priority.
 *   9. Missing bearer → 401 missing_bearer.
 *  10. Malformed JSON body → 400 malformed_json.
 *
 * Mirrors the existing `app-reminders-surface.test.ts` harness shape
 * verbatim.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import {
  appProjectTopicId,
  createAppRemindersSurface,
  type ConvertReminderToTaskAdapter,
  type ConvertReminderToTaskInput,
  type ConvertReminderToTaskResult,
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
  adapterCalls: ConvertReminderToTaskInput[]
  close(): Promise<void>
}

const PROJECT_ID = 'demo-project'
const OTHER_PROJECT_ID = 'other-project'
const FIXED_NOW_MS = 1_700_000_000_000
const FIXED_NOW_S = FIXED_NOW_MS / 1000

async function startGateway(opts: {
  adapter?: ConvertReminderToTaskAdapter | null
}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-reminders-convert-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new ReminderStore(db)
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const adapterCalls: ConvertReminderToTaskInput[] = []
  const wrappedAdapter: ConvertReminderToTaskAdapter | undefined =
    opts.adapter === null
      ? undefined
      : opts.adapter !== undefined
        ? async (input) => {
            adapterCalls.push(input)
            return opts.adapter!(input)
          }
        : async (input) => {
            adapterCalls.push(input)
            return {
              task_id: 'task-' + input.reminder_id,
              linked_reminder_id: 'linked-' + input.reminder_id,
              cancelled_reminder_id: input.reminder_id,
            }
          }
  const surface = createAppRemindersSurface({
    store,
    auth,
    now: () => FIXED_NOW_MS,
    ...(wrappedAdapter !== undefined ? { convertReminderToTask: wrappedAdapter } : {}),
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
    adapterCalls,
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

async function seedReminder(
  store: ReminderStore,
  message: string,
  opts: { project_id?: string; project_slug?: string; fire_at_offset?: number } = {},
): Promise<{ id: string }> {
  const created = await store.create({
    owner_slug: opts.project_slug ?? 'demo',
    topic_id: appProjectTopicId(opts.project_id ?? PROJECT_ID),
    fire_at: FIXED_NOW_S + (opts.fire_at_offset ?? 3600),
    message,
  })
  return { id: created.id }
}

describe('app-reminders surface — POST /<id>/convert-to-task (P5.5)', () => {
  let harness: Harness

  afterEach(async () => {
    await harness.close()
  })

  it('happy path: adapter wired + pending reminder → 200 with task_id + post-mutation list', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'remember to call casey')
    // Cancel the underlying reminder in the wrapped adapter so the
    // returned list reflects the convert (the canonical Core does
    // this internally; we stub it here at the surface level).
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST', body: JSON.stringify({}) },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      task_id: string
      linked_reminder_id: string | null
      cancelled_reminder_id: string
      reminders: Array<{ id: string }>
    }
    expect(json.ok).toBe(true)
    expect(json.task_id).toBe('task-' + id)
    expect(json.linked_reminder_id).toBe('linked-' + id)
    expect(json.cancelled_reminder_id).toBe(id)
    // The stubbed adapter doesn't actually cancel the engine row, so
    // the post-mutation list still contains the original — that's
    // fine for the surface-level test (the canonical Core integration
    // test covers the cancel-on-success behavior).
    expect(json.reminders.length).toBe(1)
    expect(harness.adapterCalls).toHaveLength(1)
    expect(harness.adapterCalls[0]?.project_slug).toBe('demo')
    expect(harness.adapterCalls[0]?.project_id).toBe(PROJECT_ID)
    expect(harness.adapterCalls[0]?.reminder_id).toBe(id)
  })

  it('threads title + priority overrides into the adapter input', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'remind')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      {
        method: 'POST',
        body: JSON.stringify({ title: '  Call Casey  ', priority: 1 }),
      },
    )
    expect(res.status).toBe(200)
    expect(harness.adapterCalls[0]?.title).toBe('Call Casey')
    expect(harness.adapterCalls[0]?.priority).toBe(1)
  })

  it('returns 501 not_implemented when the adapter is omitted', async () => {
    harness = await startGateway({ adapter: null })
    const { id } = await seedReminder(harness.store, 'orphan')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST' },
    )
    expect(res.status).toBe(501)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('not_implemented')
  })

  it('returns 404 reminder_not_found for a different project', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'foreign', {
      project_id: OTHER_PROJECT_ID,
    })
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('reminder_not_found')
    expect(harness.adapterCalls).toHaveLength(0)
  })

  it('returns 404 reminder_not_found for an unknown id', async () => {
    harness = await startGateway({})
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/does-not-exist/convert-to-task`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('reminder_not_found')
  })

  it('returns 409 reminder_not_pending for a cancelled reminder', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'will-cancel')
    await harness.store.cancel(id)
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST' },
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('reminder_not_pending')
    expect(harness.adapterCalls).toHaveLength(0)
  })

  it('returns 500 convert_failed when the adapter throws', async () => {
    const failing: ConvertReminderToTaskAdapter = async (): Promise<ConvertReminderToTaskResult> => {
      throw new Error('downstream blew up')
    }
    harness = await startGateway({ adapter: failing })
    const { id } = await seedReminder(harness.store, 'kaboom')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST' },
    )
    expect(res.status).toBe(500)
    const json = (await res.json()) as { code: string; message: string }
    expect(json.code).toBe('convert_failed')
    expect(json.message).toContain('downstream blew up')
  })

  it('rejects an empty title with 400 invalid_title', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'bad-title')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST', body: JSON.stringify({ title: '   ' }) },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_title')
  })

  it('rejects a title longer than 256 chars with 400 invalid_title', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'long-title')
    const tooLong = 'x'.repeat(257)
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST', body: JSON.stringify({ title: tooLong }) },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_title')
  })

  it('rejects out-of-range priority with 400 invalid_priority', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'bad-priority')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST', body: JSON.stringify({ priority: 5 }) },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_priority')
  })

  it('rejects a non-integer priority with 400 invalid_priority', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'bad-priority-float')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST', body: JSON.stringify({ priority: 1.5 }) },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_priority')
  })

  it('requires a Bearer token (401 missing_bearer)', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'no-auth')
    const res = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    )
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('rejects malformed JSON with 400 malformed_json', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'malformed')
    const res = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer dev:sam',
        },
        body: '{not-json',
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('malformed_json')
  })

  it('accepts an empty request body and treats it as no overrides', async () => {
    harness = await startGateway({})
    const { id } = await seedReminder(harness.store, 'empty-body')
    const res = await fetch(
      `${harness.base}/api/app/projects/${PROJECT_ID}/reminders/${id}/convert-to-task`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer dev:sam' },
      },
    )
    expect(res.status).toBe(200)
    expect(harness.adapterCalls[0]?.title).toBeUndefined()
    expect(harness.adapterCalls[0]?.priority).toBeUndefined()
  })
})
