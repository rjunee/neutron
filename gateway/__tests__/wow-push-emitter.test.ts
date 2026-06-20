/**
 * @neutronai/gateway/wow-push-emitter — unit tests
 * (2026-05-22 push-deeplink-wow sprint).
 *
 * Covers:
 *   - Empty token store → dispatcher.pushAll NOT called (early-skip).
 *   - One token → dispatcher.pushAll called exactly once with the
 *     fixed title, body, and `{kind: 'wow_fired', project_id}` data.
 *   - Multiple tokens for the instance → still one dispatch call (the
 *     dispatcher fans out internally).
 *   - Tokens for a DIFFERENT instance → that instance's tokens are NOT
 *     read by `listByOwner(project_slug)`, so pushAll receives the
 *     bare empty-skip semantics for the wrong instance.
 *   - Dispatcher.pushAll throwing propagates (engine wraps in
 *     try/catch separately).
 *
 * Argus r1 BLOCKER (2026-05-22 round 2): the emitter now resolves
 * `project_id` itself given the engine's raw `topic_id` + the
 * instance's canonical projects-store. New cases:
 *
 *   - `topic_id = 'app-project:<X>'` → strip prefix → `X`.
 *   - `topic_id = 'web:<user_id>'` (chat-bridge production path) →
 *     resolve via `projects_store.list(project_slug)` → first row.
 *   - `topic_id = 'web:<user_id>'` AND empty projects list → fall
 *     back to `DEFAULT_WOW_PROJECT_ID = 'neutron'`.
 *   - `topic_id = 'app:<user_id>'` (app-ws production path) → same
 *     projects-store / fallback path as web.
 *   - `topic_id = 'app-project:'` (malformed empty suffix) → falls
 *     through to the projects-store path (the prefix is stripped to
 *     an empty string, which never matches a real project_id).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { DevicePushTokenStore } from '../push/store.ts'
import type { PushDispatcher, PushResult } from '../push/dispatcher.ts'
import {
  DEFAULT_WOW_PROJECT_ID,
  emitWowPush,
  resolveWowPushProjectId,
  WOW_PUSH_BODY,
  WOW_PUSH_TITLE,
  type WowPushProjectsStore,
} from '../wow-push-emitter.ts'

let tmp: string
let db: ProjectDb
let store: DevicePushTokenStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wow-push-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new DevicePushTokenStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface RecordedPush {
  method: 'pushAll' | 'pushUser'
  project_slug: string
  user_id?: string
  message: { title?: string; body: string; data?: Record<string, unknown> }
}

function recordingDispatcher(opts: {
  pushAllResult?: PushResult
  pushAllError?: unknown
}): { dispatcher: PushDispatcher; calls: RecordedPush[] } {
  const calls: RecordedPush[] = []
  const defaultResult: PushResult = {
    attempted: 1,
    delivered: 1,
    errored: 0,
    ok: true,
    error: null,
  }
  const dispatcher: PushDispatcher = {
    async pushAll(project_slug, message) {
      calls.push({ method: 'pushAll', project_slug, message })
      if (opts.pushAllError !== undefined) throw opts.pushAllError
      return opts.pushAllResult ?? defaultResult
    },
    async pushUser(project_slug, user_id, message) {
      calls.push({ method: 'pushUser', project_slug, user_id, message })
      if (opts.pushAllError !== undefined) throw opts.pushAllError
      return opts.pushAllResult ?? defaultResult
    },
    async pushReminder() {
      throw new Error('not used by wow-push tests')
    },
    async onFired() {
      throw new Error('not used by wow-push tests')
    },
  }
  return { dispatcher, calls }
}

async function seedToken(opts: {
  project_slug: string
  user_id: string
  device_token: string
}): Promise<void> {
  await store.register({
    project_slug: opts.project_slug,
    user_id: opts.user_id,
    device_token: opts.device_token,
    platform: 'ios',
  })
}

interface FakeProjectsStoreOpts {
  // `updated_at` is purely documentary in this stub — the resolver
  // never reads it; the SQLite store sorts on it. Including it in the
  // row literal lets the test express the production ordering it is
  // simulating (Argus r2 round 3, 2026-05-23).
  rows?: ReadonlyArray<{ id: string; updated_at?: string }>
  throws?: unknown
}

/**
 * Lightweight `WowPushProjectsStore` stub — no SQLite required. Tests
 * pass a row list to control what `list()` returns; an optional
 * `throws` opt simulates a transient DB outage so the fallback path
 * is exercised.
 */
function fakeProjectsStore(opts: FakeProjectsStoreOpts = {}): WowPushProjectsStore {
  return {
    async list(_project_slug: string) {
      if (opts.throws !== undefined) throw opts.throws
      return opts.rows ?? []
    },
  }
}

describe('emitWowPush', () => {
  test('skips when no devices are registered for the project', async () => {
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 't-empty',
      user_id: 'u-empty',
      topic_id: 'app-project:neutron',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore({ rows: [{ id: 'neutron' }] }),
    })
    expect(calls).toEqual([])
  })

  test('dispatches a single push with title/body/data when one token is registered (app-project topic strips to pid)', async () => {
    await seedToken({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'ExponentPushToken[abc123]',
    })
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 't1',
      user_id: 'u1',
      topic_id: 'app-project:neutron',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore(),
    })
    expect(calls).toHaveLength(1)
    // ISSUE #39 (2026-05-23) — production callers thread `user_id`, so
    // the emitter routes through `pushUser(project_slug, user, ...)` instead
    // of the instance-wide `pushAll`.
    expect(calls[0]).toEqual({
      method: 'pushUser',
      project_slug: 't1',
      user_id: 'u1',
      message: {
        title: WOW_PUSH_TITLE,
        body: WOW_PUSH_BODY,
        data: { kind: 'wow_fired', project_id: 'neutron' },
      },
    })
  })

  test('fires exactly one dispatcher call for multiple devices (dispatcher fans out internally)', async () => {
    await seedToken({
      project_slug: 't2',
      user_id: 'u1',
      device_token: 'ExponentPushToken[a]',
    })
    await seedToken({
      project_slug: 't2',
      user_id: 'u1',
      device_token: 'ExponentPushToken[b]',
    })
    await seedToken({
      project_slug: 't2',
      user_id: 'u2',
      device_token: 'ExponentPushToken[c]',
    })
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 't2',
      user_id: 'u1',
      topic_id: 'app-project:acme',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore(),
    })
    // The emitter contract is "one call to pushUser, the dispatcher
    // fans out across tokens internally" — anything else would
    // double-fire pushes per device. ISSUE #39 (2026-05-23): user u2's
    // tokens are NOT fanned out to because the dispatcher's
    // `pushUser('t2', 'u1', ...)` walks `listByUser` which only sees
    // u1's two devices.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('pushUser')
    expect(calls[0]?.user_id).toBe('u1')
    expect(calls[0]?.message.data).toEqual({
      kind: 'wow_fired',
      project_id: 'acme',
    })
  })

  test('ignores tokens registered for a different project', async () => {
    await seedToken({
      project_slug: 't-other',
      user_id: 'u-other',
      device_token: 'ExponentPushToken[other]',
    })
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 't-me',
      user_id: 'u-me',
      topic_id: 'app-project:neutron',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore(),
    })
    expect(calls).toEqual([])
  })

  test('propagates pushUser errors to the caller (engine wraps in try/catch)', async () => {
    await seedToken({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'ExponentPushToken[abc]',
    })
    const { dispatcher } = recordingDispatcher({
      pushAllError: new Error('Expo 503'),
    })
    await expect(
      emitWowPush({
        project_slug: 't1',
        user_id: 'u1',
        topic_id: 'app-project:neutron',
        push_dispatcher: dispatcher,
        store,
        projects_store: fakeProjectsStore(),
      }),
    ).rejects.toThrow('Expo 503')
  })

  // Argus r1 BLOCKER (2026-05-22 round 2) — the chat-bridge production
  // path passes `topic_id = 'web:<user_id>'`. The previous version of
  // this emitter (engine-side `stripAppProjectPrefix`) would have
  // surfaced `project_id = 'web:u-XXX'` into the push payload and the
  // deep-link would have routed to `/projects/web%3Au-XXX/chat` — a
  // nonexistent route. The fix resolves via the canonical projects
  // store; the test asserts the push carries a real project_id.
  //
  // Argus r2 round 3 (2026-05-23) — the `rows` shape now mirrors the
  // PRODUCTION seed order produced by `seedDefaults([neutron,
  // acme, northwind])`. Each `upsertSeed` writes a distinct
  // `nowIso()` timestamp, so `ORDER BY updated_at DESC, id ASC`
  // returns `[northwind, acme, neutron]` — northwind is the most
  // recently seeded. A naive `list[0]` would route the wow push to
  // `/projects/northwind/chat`, contradicting the documented neutron
  // target. The resolver MUST prefer `id === 'neutron'` when present.
  test('REGRESSION (web:<user_id> — fresh project production seed order): resolves to neutron, not northwind (list[0])', async () => {
    await seedToken({
      project_slug: 'casey',
      user_id: 'u-web-1',
      device_token: 'ExponentPushToken[web]',
    })
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 'casey',
      user_id: 'u-web-1',
      // The PRODUCTION shape: chat-bridge starts the session with
      // `webTopicId(user_id) = 'web:<user_id>'` and threads that
      // topic_id through engine.start + engine.advance, which then
      // calls the wow push emitter with it. Stripping `app-project:`
      // off this leaves the string UNCHANGED — the bug.
      topic_id: 'web:u-web-1',
      push_dispatcher: dispatcher,
      store,
      // Mirrors the production `ORDER BY updated_at DESC, id ASC`
      // output for the seed sequence `[neutron, acme, northwind]`:
      // northwind seeded last → newest updated_at → list[0].
      projects_store: fakeProjectsStore({
        rows: [
          { id: 'northwind', updated_at: '2026-05-23T00:00:00.003Z' },
          { id: 'acme', updated_at: '2026-05-23T00:00:00.002Z' },
          { id: 'neutron', updated_at: '2026-05-23T00:00:00.001Z' },
        ],
      }),
    })
    expect(calls).toHaveLength(1)
    const data = calls[0]?.message.data as Record<string, unknown>
    expect(data.kind).toBe('wow_fired')
    // CRITICAL: must NOT be the raw topic_id.
    expect(data.project_id).not.toBe('web:u-web-1')
    // CRITICAL (Argus r2 r3): must NOT be `northwind` (the list[0] trap
    // for fresh instances). Must be the documented wow target.
    expect(data.project_id).not.toBe('northwind')
    expect(data.project_id).toBe('neutron')
  })

  test('REGRESSION (web:<user_id> + empty projects list): falls back to DEFAULT_WOW_PROJECT_ID', async () => {
    await seedToken({
      project_slug: 'fresh',
      user_id: 'u-fresh',
      device_token: 'ExponentPushToken[fresh]',
    })
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 'fresh',
      user_id: 'u-fresh',
      topic_id: 'web:u-fresh',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore({ rows: [] }),
    })
    expect(calls).toHaveLength(1)
    expect((calls[0]?.message.data as Record<string, unknown>).project_id).toBe(
      DEFAULT_WOW_PROJECT_ID,
    )
  })

  test('REGRESSION (web:<user_id> + projects_store throws): falls back to DEFAULT_WOW_PROJECT_ID', async () => {
    await seedToken({
      project_slug: 'broken',
      user_id: 'u-broken',
      device_token: 'ExponentPushToken[broken]',
    })
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 'broken',
      user_id: 'u-broken',
      topic_id: 'web:u-broken',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore({ throws: new Error('db locked') }),
    })
    expect(calls).toHaveLength(1)
    expect((calls[0]?.message.data as Record<string, unknown>).project_id).toBe(
      DEFAULT_WOW_PROJECT_ID,
    )
  })

  test('REGRESSION (app:<user_id>): app-ws shape resolves via projects_store, not raw topic_id', async () => {
    await seedToken({
      project_slug: 't-app',
      user_id: 'u-app',
      device_token: 'ExponentPushToken[appws]',
    })
    const { dispatcher, calls } = recordingDispatcher({})
    await emitWowPush({
      project_slug: 't-app',
      user_id: 'u-app',
      topic_id: 'app:u-app',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore({ rows: [{ id: 'northwind' }] }),
    })
    const data = calls[0]?.message.data as Record<string, unknown>
    expect(data.project_id).not.toBe('app:u-app')
    expect(data.project_id).toBe('northwind')
  })
})

describe('resolveWowPushProjectId (unit)', () => {
  test('app-project:<X> → X (most direct shape — onboarding via app-reminders)', async () => {
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'app-project:beacon',
      projects_store: fakeProjectsStore(),
    })
    expect(out).toBe('beacon')
  })

  test('app-project: (empty suffix) → falls through to projects_store path (no spoofing)', async () => {
    // An attacker / malformed caller could send the bare prefix.
    // Stripping yields '' which we must NOT use as a project_id (the
    // deep link would route to `/projects//chat`). The resolver
    // ignores it and falls through.
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'app-project:',
      projects_store: fakeProjectsStore({ rows: [{ id: 'neutron' }] }),
    })
    expect(out).toBe('neutron')
  })

  test('web:<user_id> → projects_store.list first row (when neutron is NOT in the list)', async () => {
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'web:u-XXX',
      projects_store: fakeProjectsStore({
        rows: [{ id: 'first' }, { id: 'second' }],
      }),
    })
    expect(out).toBe('first')
  })

  // Argus r2 round 3 (2026-05-23) — fresh-instance production seed-order
  // trap. `seedDefaults([neutron, acme, northwind])` writes each
  // row with its own `nowIso()` timestamp, so `ORDER BY updated_at
  // DESC, id ASC` ranks northwind ahead of neutron in list[0]. The
  // resolver MUST prefer `id === 'neutron'` when present so the wow
  // push deep-links to the documented `/projects/neutron/chat` target.
  test('web:<user_id> → prefers id === neutron over list[0] (fresh-project seed-order trap)', async () => {
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'web:u-fresh',
      projects_store: fakeProjectsStore({
        rows: [
          { id: 'northwind', updated_at: '2026-05-23T00:00:00.003Z' },
          { id: 'acme', updated_at: '2026-05-23T00:00:00.002Z' },
          { id: 'neutron', updated_at: '2026-05-23T00:00:00.001Z' },
        ],
      }),
    })
    expect(out).toBe('neutron')
  })

  // Edge: neutron has been deleted (or this instance never had one).
  // Resolver SHOULD fall through to list[0] — the most-recently
  // updated project is the right contextual home.
  test('web:<user_id> → no neutron in list → falls through to list[0]', async () => {
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'web:u-X',
      projects_store: fakeProjectsStore({
        rows: [
          { id: 'northwind', updated_at: '2026-05-23T00:00:00.002Z' },
          { id: 'acme', updated_at: '2026-05-23T00:00:00.001Z' },
        ],
      }),
    })
    expect(out).toBe('northwind')
  })

  test('web:<user_id> + empty list → DEFAULT_WOW_PROJECT_ID', async () => {
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'web:u-XXX',
      projects_store: fakeProjectsStore({ rows: [] }),
    })
    expect(out).toBe(DEFAULT_WOW_PROJECT_ID)
  })

  test('projects_store throws → DEFAULT_WOW_PROJECT_ID (fail-open, never wedge wow_fired)', async () => {
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'web:u-XXX',
      projects_store: fakeProjectsStore({ throws: new Error('db locked') }),
    })
    expect(out).toBe(DEFAULT_WOW_PROJECT_ID)
  })

  test('first row with empty id → falls through (defensive — projects.id is NOT NULL but the store contract is async)', async () => {
    const out = await resolveWowPushProjectId({
      project_slug: 't',
      topic_id: 'web:u-XXX',
      projects_store: fakeProjectsStore({ rows: [{ id: '' }] }),
    })
    expect(out).toBe(DEFAULT_WOW_PROJECT_ID)
  })
})
