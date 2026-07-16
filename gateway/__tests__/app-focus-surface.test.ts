/**
 * P5.5 — gateway app-focus surface tests.
 *
 * Verifies that `GET /api/app/focus` aggregates the authenticated
 * owner's tasks + reminders into the cross-project today list per
 * SPEC.md § Phases→Steps / P5.5 and
 * docs/engineering-plan.md § B.P5.
 *
 * Test plane mirrors the launcher surface tests
 * (`gateway/__tests__/app-launcher-surface.test.ts`):
 *   - boots a real `composeHttpHandler` chain
 *   - real per-instance ProjectDb + TaskStore + ReminderStore (in tmpdir)
 *   - dev-bypass auth resolver
 *   - hits routes via fetch + the chain's bound port
 *
 * Behavioural-spec gates verified:
 *   - instance isolation (token-bound slug never sees a different slug)
 *   - sort: bucket (overdue → today → soon) → priority DESC → due_at ASC
 *   - empty-state (no tasks + no reminders → empty list)
 *   - high-priority task without a near due_date surfaces in "soon"
 *   - method gating (POST returns 405; non-owned paths fall through)
 *   - auth gating (missing / malformed bearer → 401)
 *   - reminder project_id is extracted from the synthetic app-socket
 *     topic id `app:<instance>:<project_id>:<user_id>` so taps can route
 *     back to the originating project
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'

import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import {
  createAppFocusSurface,
  type FocusItem,
  type FocusResponse,
} from '../http/app-focus-surface.ts'

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

const OWNER = 'demo'
const OTHER_OWNER = 'other'
const PROJECT_A = 'acme'
const PROJECT_B = 'neutron'

interface Harness {
  base: string
  db: ProjectDb
  tasks: TaskStore
  reminders: ReminderStore
  tmp: string
  setNow: (ms: number) => void
  close(): Promise<void>
}

const FROZEN_NOW = Date.parse('2026-05-18T12:00:00.000Z')

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-focus-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const tasks = new TaskStore(db)
  const reminders = new ReminderStore(db)
  let now = FROZEN_NOW
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const surface = createAppFocusSurface({
    tasks,
    reminders,
    auth,
    now: () => now,
  })
  const composed = composeHttpHandler({
    appFocus: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    db,
    tasks,
    reminders,
    tmp,
    setNow: (ms: number) => {
      now = ms
    },
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
  return fetch(`${base}${path}`, { ...init, headers })
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

describe('app-focus surface — auth + method gating', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token (401)', async () => {
    const res = await fetch(`${harness.base}/api/app/focus`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('rejects a non-bearer auth scheme (401)', async () => {
    const res = await fetch(`${harness.base}/api/app/focus`, {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  })

  it('rejects POST with 405', async () => {
    const res = await authedFetch(harness.base, '/api/app/focus', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(405)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('method_not_allowed')
  })

  it('does not claim unrelated /api paths (compose-chain falls through)', async () => {
    const res = await fetch(`${harness.base}/api/something/else`)
    expect(res.status).toBe(404)
  })

  it('does not claim /api/app/focus-anything (exact-match only)', async () => {
    const res = await fetch(`${harness.base}/api/app/focus-extra`)
    expect(res.status).toBe(404)
  })
})

describe('app-focus surface — empty state', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('returns an empty today list when no tasks + no reminders exist', async () => {
    const res = await authedFetch(harness.base, '/api/app/focus')
    expect(res.status).toBe(200)
    const json = (await res.json()) as FocusResponse
    expect(json.ok).toBe(true)
    expect(json.project_slug).toBe(OWNER)
    expect(json.today).toEqual([])
    expect(typeof json.now).toBe('string')
  })
})

describe('app-focus surface — aggregation + sort', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('sorts items: overdue → today → soon, then priority DESC, then due_at ASC', async () => {
    // overdue, P0 — first by bucket alone
    const overdue = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'overdue invoice',
      due_date: iso(FROZEN_NOW - 2 * 60 * 60 * 1000),
    })
    // today, P3 — beats today P1 on priority
    const todayHigh = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'today high',
      priority: 3,
      due_date: iso(FROZEN_NOW + 6 * 60 * 60 * 1000),
    })
    const todayLow = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_B,
      title: 'today low',
      priority: 1,
      due_date: iso(FROZEN_NOW + 3 * 60 * 60 * 1000),
    })
    // soon — surfaced only via high-priority path (no due_date)
    const soonHigh = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_B,
      title: 'high priority no date',
      priority: 2,
    })
    // not surfaced — low priority, far future due
    await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'next week thing',
      priority: 0,
      due_date: iso(FROZEN_NOW + 7 * 24 * 60 * 60 * 1000),
    })

    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    expect(json.today.map((i) => i.id)).toEqual([
      overdue.id,
      todayHigh.id,
      todayLow.id,
      soonHigh.id,
    ])
    expect(json.today.map((i) => i.bucket)).toEqual([
      'overdue',
      'today',
      'today',
      'soon',
    ])
    // Project ids are preserved for tap-routing.
    expect(json.today.map((i) => i.project_id)).toEqual([
      PROJECT_A,
      PROJECT_A,
      PROJECT_B,
      PROJECT_B,
    ])
  })

  it('aggregates pending reminders firing in the next 24h alongside tasks', async () => {
    // Task: today, P2
    const task = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'finish brief',
      priority: 2,
      due_date: iso(FROZEN_NOW + 4 * 60 * 60 * 1000),
    })
    // Reminder firing in 2h, originating from PROJECT_B's app-socket topic.
    const reminderTopic = `app:${OWNER}:${PROJECT_B}:sam`
    const reminder = await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: reminderTopic,
      fire_at: (FROZEN_NOW + 2 * 60 * 60 * 1000) / 1000,
      message: 'check on the launch checklist',
    })
    // Reminder past 24h horizon — must NOT surface.
    await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: reminderTopic,
      fire_at: (FROZEN_NOW + 3 * 24 * 60 * 60 * 1000) / 1000,
      message: 'next-week ping',
    })

    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    expect(json.today.length).toBe(2)
    const ids = json.today.map((i) => i.id)
    expect(ids).toContain(task.id)
    expect(ids).toContain(reminder.id)
    const reminderItem = json.today.find((i) => i.id === reminder.id) as FocusItem
    expect(reminderItem.kind).toBe('reminder')
    expect(reminderItem.project_id).toBe(PROJECT_B)
    expect(reminderItem.source).toBe('reminders')
    expect(reminderItem.title).toContain('launch checklist')
    expect(reminderItem.bucket).toBe('today')
    // task should sort first because its bucket is "today" + priority 2 vs
    // reminder priority null; both bucket=today, prio 2 > prio 0 default.
    expect(json.today[0]?.id).toBe(task.id)
    expect(json.today[1]?.id).toBe(reminder.id)
  })

  it('extracts project_id from the P5.4 app-project:<id> topic shape (Codex r1 P1)', async () => {
    // Reminders created via the P5.4 Reminders tab store topic_id as
    // `app-project:<project_id>` (helper `appProjectTopicId` in
    // gateway/http/app-reminders-surface.ts). The pre-fix Focus
    // surface only matched the older `app:<instance>:<project>:<user>`
    // shape, so these reminders rendered as instance-level and tapping
    // missed the originating project. This regression pin asserts
    // both shapes resolve to the same project_id.
    const r1 = await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: `app-project:${PROJECT_A}`,
      fire_at: (FROZEN_NOW + 60 * 60 * 1000) / 1000,
      message: 'from reminders tab',
    })
    const r2 = await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: `app:${OWNER}:${PROJECT_A}:sam`,
      fire_at: (FROZEN_NOW + 2 * 60 * 60 * 1000) / 1000,
      message: 'from chat',
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    const i1 = json.today.find((i) => i.id === r1.id) as FocusItem
    const i2 = json.today.find((i) => i.id === r2.id) as FocusItem
    expect(i1?.project_id).toBe(PROJECT_A)
    expect(i2?.project_id).toBe(PROJECT_A)
  })

  it('surfaces reminders with a non-app-socket topic_id as instance-level (project_id="")', async () => {
    const reminder = await harness.reminders.create({
      owner_slug: OWNER,
      // Telegram thread id, not the app-socket synthetic format.
      topic_id: '123456789',
      fire_at: (FROZEN_NOW + 60 * 60 * 1000) / 1000,
      message: 'instance-level ping',
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    const item = json.today.find((i) => i.id === reminder.id) as FocusItem
    expect(item).toBeDefined()
    expect(item.project_id).toBe('')
  })

  it('preserves origin_source on aggregated items', async () => {
    const task = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'from chat',
      priority: 3,
      source: 'chat',
    })
    const reminder = await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: `app:${OWNER}:${PROJECT_A}:sam`,
      fire_at: (FROZEN_NOW + 60 * 60 * 1000) / 1000,
      message: 'check email',
      source: '@neutronai/reminders-core',
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    const taskItem = json.today.find((i) => i.id === task.id) as FocusItem
    const reminderItem = json.today.find((i) => i.id === reminder.id) as FocusItem
    expect(taskItem.origin_source).toBe('chat')
    expect(reminderItem.origin_source).toBe('@neutronai/reminders-core')
  })

  it('truncates oversized reminder body in the title', async () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(20)
    const reminder = await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: `app:${OWNER}:${PROJECT_A}:sam`,
      fire_at: (FROZEN_NOW + 60 * 60 * 1000) / 1000,
      message: long,
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    const item = json.today.find((i) => i.id === reminder.id) as FocusItem
    expect(item.title.length).toBeLessThanOrEqual(80)
    expect(item.title.endsWith('...')).toBe(true)
  })
})

describe('app-focus surface — project isolation', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('never returns another project\'s tasks even when they live in the same db', async () => {
    // The harness shares a single project DB (each instance runs
    // its own DB, but the TaskStore enforces
    // project_slug filtering regardless — verify that filter is what
    // the surface relies on).
    await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'mine',
      priority: 3,
      due_date: iso(FROZEN_NOW + 60 * 60 * 1000),
    })
    await harness.tasks.create({
      project_slug: OTHER_OWNER,
      project_id: PROJECT_A,
      title: 'theirs',
      priority: 3,
      due_date: iso(FROZEN_NOW + 60 * 60 * 1000),
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    expect(json.today.map((i) => i.title)).toEqual(['mine'])
  })

  it('never returns another project\'s reminders', async () => {
    await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: `app:${OWNER}:${PROJECT_A}:sam`,
      fire_at: (FROZEN_NOW + 60 * 60 * 1000) / 1000,
      message: 'mine',
    })
    await harness.reminders.create({
      owner_slug: OTHER_OWNER,
      topic_id: `app:${OTHER_OWNER}:${PROJECT_A}:casey`,
      fire_at: (FROZEN_NOW + 60 * 60 * 1000) / 1000,
      message: 'theirs',
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    expect(json.today.length).toBe(1)
    expect(json.today[0]?.title).toBe('mine')
  })
})

describe('app-focus surface — bucket boundaries', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('classifies completed/cancelled tasks as excluded (status=open filter)', async () => {
    const open = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'open thing',
      priority: 3,
      due_date: iso(FROZEN_NOW + 60 * 60 * 1000),
    })
    const done = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'done thing',
      priority: 3,
      due_date: iso(FROZEN_NOW + 60 * 60 * 1000),
    })
    await harness.tasks.complete(done.id)
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    expect(json.today.map((i) => i.id)).toEqual([open.id])
  })

  it('handles a task with a malformed due_date as if no due_date were set', async () => {
    const task = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'malformed',
      priority: 3,
      due_date: 'not-a-date',
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    const item = json.today.find((i) => i.id === task.id) as FocusItem
    expect(item).toBeDefined()
    // Surfaced via the high-priority path; bucket=soon; due_at=null.
    expect(item.bucket).toBe('soon')
    expect(item.due_at).toBeNull()
  })

  it('surfaces a high-priority dateless task even when more than one page of dated tasks precedes it (Codex r1 P2)', async () => {
    // Codex r1 P2: TaskStore.list orders open rows as (dated ASC,
    // then dateless DESC). The pre-fix aggregator did a single
    // `limit: 200` call, so a high-priority dateless task could be
    // silently dropped if >200 dated open rows preceded it.
    // The page-walking fix scans up to MAX_TASKS_SCANNED rows.
    //
    // Seeding 300 dated tasks (firmly past the 250-row TASK_PAGE_SIZE
    // boundary) proves the page-walk crosses the page boundary AND
    // surfaces the high-priority dateless row.
    for (let i = 0; i < 300; i += 1) {
      await harness.tasks.create({
        project_slug: OWNER,
        project_id: PROJECT_A,
        title: `low priority dated #${i}`,
        priority: 0,
        // All far-future, so none pass the dueSoon filter.
        due_date: iso(FROZEN_NOW + (10 + i) * 24 * 60 * 60 * 1000),
      })
    }
    const target = await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_B,
      title: 'high-prio dateless behind the dated wall',
      priority: 3,
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    const ids = json.today.map((i) => i.id)
    expect(ids).toContain(target.id)
    // It's the ONLY task that should surface (all 300 dated ones are
    // far in the future + low-priority so they're filtered out).
    expect(json.today.length).toBe(1)
    expect(json.today[0]?.bucket).toBe('soon')
  })

  it('caps the response at MAX_FOCUS_ITEMS_RETURNED (sort survives the truncation)', async () => {
    // 120 high-priority dateless tasks. Cap is 100. The 100 returned
    // should all be priority 3 (highest); the 20 priority-1 tasks
    // get dropped at the tail of the merged sort.
    for (let i = 0; i < 100; i += 1) {
      await harness.tasks.create({
        project_slug: OWNER,
        project_id: PROJECT_A,
        title: `prio 3 #${i}`,
        priority: 3,
      })
    }
    for (let i = 0; i < 20; i += 1) {
      await harness.tasks.create({
        project_slug: OWNER,
        project_id: PROJECT_B,
        title: `prio 2 #${i}`,
        priority: 2,
      })
    }
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    expect(json.today.length).toBe(100)
    expect(json.today.every((i) => i.priority === 3)).toBe(true)
  })

  it('includes a reminder whose fire_at sits exactly on the horizon boundary', async () => {
    // The aggregator's SQL filter is `fire_at <= now + 24h`. A reminder
    // landing AT now + 24h precisely must be included (closed interval).
    const exactlyAtHorizon = (FROZEN_NOW + 24 * 60 * 60 * 1000) / 1000
    const r = await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: `app-project:${PROJECT_A}`,
      fire_at: exactlyAtHorizon,
      message: 'on the line',
    })
    // And one a second past the boundary — must be excluded.
    const past = await harness.reminders.create({
      owner_slug: OWNER,
      topic_id: `app-project:${PROJECT_A}`,
      fire_at: exactlyAtHorizon + 1,
      message: 'just over',
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    const ids = json.today.map((i) => i.id)
    expect(ids).toContain(r.id)
    expect(ids).not.toContain(past.id)
  })

  it('excludes a low-priority task without a near due_date', async () => {
    await harness.tasks.create({
      project_slug: OWNER,
      project_id: PROJECT_A,
      title: 'no priority, no date',
      // priority left null
    })
    const res = await authedFetch(harness.base, '/api/app/focus')
    const json = (await res.json()) as FocusResponse
    expect(json.today).toEqual([])
  })
})
