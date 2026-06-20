/**
 * @neutronai/gateway/wow-push-emitter — ISSUE #39 per-user scope regression.
 *
 * Closes ISSUE #39 (2026-05-23) — `wow-push-emitter` previously fanned
 * the wow_fired push to `DevicePushTokenStore.listByOwner`, so user B
 * on a multi-user instance (group projects per master-plan §5.1)
 * received user A's onboarding-completion push. Codex P2 cross-model
 * flagged on PR #281 r3.
 *
 * Fix asserts:
 *
 *   1. emitWowPush({project_slug, user_id: A, ...}) — user A has 2 devices,
 *      user B has 2 devices on the SAME instance; the dispatcher is
 *      driven through `pushUser(project_slug, 'A', ...)` so the resolved
 *      token batch is EXACTLY user A's two devices, NEVER user B's.
 *   2. emitWowPush({project_slug, user_id: null, ...}) — fail-CLOSED guard
 *      (Codex r1 P2 on PR #291): falling back to instance-wide `pushAll`
 *      would re-create the multi-user privacy leak the sprint is
 *      fixing, so the emitter logs a skip warning AND returns without
 *      calling the dispatcher at all. A missing notification is a loud
 *      user-visible bug a human reports; a leaky push arrives BEFORE
 *      anyone reads journald.
 *
 * Companion to `wow-push-emitter.test.ts` (project_id resolution
 * fixture). This file pins the per-user fan-out contract that issue
 * #39's closing condition requires: "multi-user regression test seeds
 * 2 users on one instance; user A's wow_fired fires a push that reaches
 * ONLY user A's devices."
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
  emitWowPush,
  WOW_PUSH_BODY,
  WOW_PUSH_TITLE,
  type WowPushProjectsStore,
} from '../wow-push-emitter.ts'

const OWNER = 'multi-user-project'
const USER_A = 'user-a'
const USER_B = 'user-b'
const A_DEVICE_1 = 'ExponentPushToken[a-iphone]'
const A_DEVICE_2 = 'ExponentPushToken[a-android]'
const B_DEVICE_1 = 'ExponentPushToken[b-iphone]'
const B_DEVICE_2 = 'ExponentPushToken[b-android]'

let tmp: string
let db: ProjectDb
let store: DevicePushTokenStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wow-push-userscope-'))
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
  /**
   * Token set the dispatcher OBSERVED from the store at the moment of
   * the call. Captured here (rather than reading the store post-emit)
   * so the assertion measures what the dispatcher actually fanned out
   * to, not what the store would return at any later read.
   */
  tokens: string[]
}

/**
 * Recording dispatcher that ALSO captures the token set the store
 * would return at dispatch time. This mirrors what production
 * `createPushDispatcher` does internally (it calls
 * `store.listByUser` / `store.listByOwner` and maps every row into
 * an `ExpoPushMessage.to`) — but exposes the observed token list so
 * the test can assert per-user scoping at the surface most users care
 * about: "exactly which device tokens received the push?"
 */
function recordingDispatcher(): {
  dispatcher: PushDispatcher
  calls: RecordedPush[]
} {
  const calls: RecordedPush[] = []
  const defaultResult: PushResult = {
    attempted: 0,
    delivered: 0,
    errored: 0,
    ok: true,
    error: null,
  }
  const dispatcher: PushDispatcher = {
    async pushAll(project_slug, message) {
      const tokens = store.listByOwner(project_slug).map((t) => t.device_token)
      calls.push({ method: 'pushAll', project_slug, message, tokens })
      return { ...defaultResult, attempted: tokens.length, delivered: tokens.length }
    },
    async pushUser(project_slug, user_id, message) {
      const tokens = store
        .listByUser(project_slug, user_id)
        .map((t) => t.device_token)
      calls.push({
        method: 'pushUser',
        project_slug,
        user_id,
        message,
        tokens,
      })
      return { ...defaultResult, attempted: tokens.length, delivered: tokens.length }
    },
    async pushReminder() {
      throw new Error('not used by user-scope tests')
    },
    async onFired() {
      throw new Error('not used by user-scope tests')
    },
  }
  return { dispatcher, calls }
}

function fakeProjectsStore(rows: ReadonlyArray<{ id: string }> = [
  { id: 'neutron' },
]): WowPushProjectsStore {
  return {
    async list(_project_slug: string) {
      return rows
    },
  }
}

async function seedMultiUserOwner(): Promise<void> {
  // Two users on the same instance, two devices each — the multi-user
  // shape the master-plan §5.1 group-project Sprint Year-1 designs
  // against.
  await store.register({
    project_slug: OWNER,
    user_id: USER_A,
    device_token: A_DEVICE_1,
    platform: 'ios',
  })
  await store.register({
    project_slug: OWNER,
    user_id: USER_A,
    device_token: A_DEVICE_2,
    platform: 'android',
  })
  await store.register({
    project_slug: OWNER,
    user_id: USER_B,
    device_token: B_DEVICE_1,
    platform: 'ios',
  })
  await store.register({
    project_slug: OWNER,
    user_id: USER_B,
    device_token: B_DEVICE_2,
    platform: 'android',
  })
}

interface WarnEntry {
  message: string
  args: unknown[]
}

function captureConsoleWarn(): { entries: WarnEntry[]; restore: () => void } {
  const entries: WarnEntry[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    entries.push({
      message: typeof args[0] === 'string' ? args[0] : String(args[0]),
      args,
    })
  }
  return {
    entries,
    restore: () => {
      console.warn = original
    },
  }
}

describe('emitWowPush — ISSUE #39 per-user scope', () => {
  test('user A wow_fired push reaches ONLY user A devices, NOT user B devices', async () => {
    await seedMultiUserOwner()
    const { dispatcher, calls } = recordingDispatcher()
    await emitWowPush({
      project_slug: OWNER,
      user_id: USER_A,
      topic_id: 'app-project:neutron',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore(),
    })
    // Exactly one dispatcher call.
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    // Routed through pushUser, not pushAll. This is the closing
    // condition: scope the fan-out at the dispatcher API level rather
    // than rely on a future per-token filter.
    expect(call.method).toBe('pushUser')
    expect(call.user_id).toBe(USER_A)
    expect(call.project_slug).toBe(OWNER)
    // CRITICAL: the dispatcher observed exactly user A's two devices,
    // never user B's. listByUser returns rows in updated_at DESC order
    // (see DevicePushTokenStore.listByUser at gateway/push/store.ts:178),
    // so the Set comparison is the order-independent contract.
    expect(new Set(call.tokens)).toEqual(new Set([A_DEVICE_1, A_DEVICE_2]))
    expect(call.tokens).toHaveLength(2)
    expect(call.tokens).not.toContain(B_DEVICE_1)
    expect(call.tokens).not.toContain(B_DEVICE_2)
    // Payload shape preserved end-to-end.
    expect(call.message).toEqual({
      title: WOW_PUSH_TITLE,
      body: WOW_PUSH_BODY,
      data: { kind: 'wow_fired', project_id: 'neutron' },
    })
  })

  test('user B wow_fired push reaches ONLY user B devices (symmetric case)', async () => {
    await seedMultiUserOwner()
    const { dispatcher, calls } = recordingDispatcher()
    await emitWowPush({
      project_slug: OWNER,
      user_id: USER_B,
      topic_id: 'app-project:neutron',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore(),
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.method).toBe('pushUser')
    expect(call.user_id).toBe(USER_B)
    expect(new Set(call.tokens)).toEqual(new Set([B_DEVICE_1, B_DEVICE_2]))
    expect(call.tokens).not.toContain(A_DEVICE_1)
    expect(call.tokens).not.toContain(A_DEVICE_2)
  })

  test('null user_id fails CLOSED: skips push + warn log captured (Codex r1 P2 — no project-wide fallback fan-out)', async () => {
    await seedMultiUserOwner()
    const { dispatcher, calls } = recordingDispatcher()
    const warn = captureConsoleWarn()
    try {
      await emitWowPush({
        project_slug: OWNER,
        user_id: null,
        topic_id: 'app-project:neutron',
        push_dispatcher: dispatcher,
        store,
        projects_store: fakeProjectsStore(),
      })
    } finally {
      warn.restore()
    }
    // Fail-closed contract: the dispatcher MUST NOT be called. The
    // original PR shape fell back to `pushAll` which preserved the
    // multi-user privacy leak (Codex r1 P2 on PR #291). A missing
    // notification is a noticeable user-facing regression a human
    // reports; a leaky push arrives BEFORE anyone reads logs.
    expect(calls).toEqual([])
    // The warn log surfaces the regression in journald (grep target
    // `no user_id on emit input`).
    expect(
      warn.entries.some((e) =>
        e.message.includes(
          '[wow-push] no user_id on emit input — skipping push to avoid project-wide fan-out',
        ),
      ),
    ).toBe(true)
  })

  test('empty string user_id ALSO fails closed (defensive — null-coalesce trap)', async () => {
    await seedMultiUserOwner()
    const { dispatcher, calls } = recordingDispatcher()
    const warn = captureConsoleWarn()
    try {
      await emitWowPush({
        project_slug: OWNER,
        user_id: '',
        topic_id: 'app-project:neutron',
        push_dispatcher: dispatcher,
        store,
        projects_store: fakeProjectsStore(),
      })
    } finally {
      warn.restore()
    }
    // Empty string is not a real user identity — the row at
    // `device_push_tokens.user_id = ''` would never match anything.
    // Treating it as "no user_id" surfaces the warn AND keeps the
    // emitter fail-closed instead of silently delivering zero pushes
    // via a broken pushUser call (or worse, fanning out via pushAll).
    expect(calls).toEqual([])
    expect(
      warn.entries.some((e) =>
        e.message.includes('[wow-push] no user_id on emit input'),
      ),
    ).toBe(true)
  })

  test('user_id set + no devices for THAT user → skip (still no fallback fan-out)', async () => {
    // User B has tokens but user A has NONE. The early-skip via
    // listByUser must short-circuit; we must NOT fall back to a
    // instance-wide pushAll just because user A is dark. That would
    // re-leak user B's devices to a user A wow_fired transition.
    await store.register({
      project_slug: OWNER,
      user_id: USER_B,
      device_token: B_DEVICE_1,
      platform: 'ios',
    })
    const { dispatcher, calls } = recordingDispatcher()
    await emitWowPush({
      project_slug: OWNER,
      user_id: USER_A,
      topic_id: 'app-project:neutron',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore(),
    })
    // No dispatcher call at all — user A has no devices.
    expect(calls).toEqual([])
  })

  test('cross-instance isolation preserved: user with same user_id on a different instance is unaffected', async () => {
    // Same user_id on TWO instances. Today the multi-instance gateway
    // mints distinct `user_id` per instance, but the persistence path
    // (project_slug, device_token) is the unique key — the assertion
    // here is that `listByUser` filters on BOTH (project_slug, user_id)
    // so the wow push for instance A's user A doesn't reach instance B's
    // user A.
    await store.register({
      project_slug: OWNER,
      user_id: USER_A,
      device_token: A_DEVICE_1,
      platform: 'ios',
    })
    await store.register({
      project_slug: 'other-project',
      user_id: USER_A,
      device_token: 'ExponentPushToken[other-project-same-user]',
      platform: 'ios',
    })
    const { dispatcher, calls } = recordingDispatcher()
    await emitWowPush({
      project_slug: OWNER,
      user_id: USER_A,
      topic_id: 'app-project:neutron',
      push_dispatcher: dispatcher,
      store,
      projects_store: fakeProjectsStore(),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.tokens).toEqual([A_DEVICE_1])
    expect(calls[0]?.tokens).not.toContain(
      'ExponentPushToken[other-project-same-user]',
    )
  })
})
