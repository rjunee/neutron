/**
 * @neutronai/gateway/push — PushDispatcher tests.
 *
 * Covers:
 *   - empty-token-list short-circuits with attempted=0
 *   - reminder push uses owner token list with title/body/sound/data
 *   - web tokens are filtered out (deferred to follow-up sprint)
 *   - per-ticket errors are logged but PushResult.ok stays true
 *   - thrown Expo errors are downgraded to logger.warn + ok=false
 *   - pushAll mirrors pushReminder over an ad-hoc message
 *   - instance isolation: pushReminder for instance A only sees instance A's tokens
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Reminder } from '@neutronai/reminders/store.ts'
import {
  ExpoPushError,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoPushSendResult,
  type ExpoPushTicket,
} from './expo-push-client.ts'
import { DevicePushTokenStore } from './store.ts'
import { createPushDispatcher, type PushDispatcherLogger } from './dispatcher.ts'

let tmp: string
let db: ProjectDb
let store: DevicePushTokenStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-push-disp-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new DevicePushTokenStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface FakeClient extends ExpoPushClient {
  calls: ExpoPushMessage[][]
}

function fakeClient(
  tickets: ExpoPushTicket[] | ((messages: ExpoPushMessage[]) => ExpoPushTicket[]),
): FakeClient {
  const calls: ExpoPushMessage[][] = []
  return {
    calls,
    async send(messages) {
      calls.push(messages)
      const t = typeof tickets === 'function' ? tickets(messages) : tickets
      const result: ExpoPushSendResult = {
        tickets: t,
        ok: t.every((x) => x.status === 'ok'),
      }
      return result
    },
  }
}

function throwingClient(err: unknown): FakeClient {
  const calls: ExpoPushMessage[][] = []
  return {
    calls,
    async send(messages) {
      calls.push(messages)
      throw err
    },
  }
}

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r-1',
    project_slug: 't1',
    topic_id: 'app-project:demo',
    fire_at: 1700000000,
    message: 'walk the dog',
    status: 'fired',
    recurrence: null,
    recurrence_spec: null,
    source: null,
    created_at: 1699999000,
    fired_at: 1700000005,
    cancelled_at: null,
    ...overrides,
  }
}

function recordingLogger(): { logger: PushDispatcherLogger; entries: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const entries: Array<{ message: string; meta?: Record<string, unknown> }> = []
  return {
    entries,
    logger: {
      warn(message, meta) {
        entries.push({ message, ...(meta !== undefined ? { meta } : {}) })
      },
    },
  }
}

describe('PushDispatcher.pushReminder', () => {
  test('no tokens → attempted=0, no client call', async () => {
    const client = fakeClient([])
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushReminder(makeReminder())
    expect(result.attempted).toBe(0)
    expect(result.delivered).toBe(0)
    expect(result.errored).toBe(0)
    expect(result.ok).toBe(true)
    expect(client.calls.length).toBe(0)
    expect(entries.length).toBe(0)
  })

  test('per-instance fan-out: every token POSTed with shared title/body, sound=default', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'ExponentPushToken[ios]',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'ExponentPushToken[android]',
      platform: 'android',
    })
    const client = fakeClient((msgs) =>
      msgs.map(() => ({ status: 'ok', id: 'tick' })),
    )
    const dispatcher = createPushDispatcher({ store, client })
    const result = await dispatcher.pushReminder(makeReminder())
    expect(result.attempted).toBe(2)
    expect(result.delivered).toBe(2)
    expect(result.ok).toBe(true)
    expect(client.calls.length).toBe(1)
    const msgs = client.calls[0] ?? []
    expect(new Set(msgs.map((m) => m.to))).toEqual(
      new Set(['ExponentPushToken[ios]', 'ExponentPushToken[android]']),
    )
    for (const m of msgs) {
      expect(m.title).toBe('Reminder')
      expect(m.body).toBe('walk the dog')
      expect(m.sound).toBe('default')
      expect(m.data?.kind).toBe('reminder')
      expect(m.data?.reminder_id).toBe('r-1')
      expect(m.data?.project_slug).toBe('t1')
      expect(m.data?.topic_id).toBe('app-project:demo')
    }
  })

  test('reminder_title override overrides the default "Reminder"', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok',
      platform: 'ios',
    })
    const client = fakeClient([{ status: 'ok' }])
    const dispatcher = createPushDispatcher({
      store,
      client,
      reminder_title: 'Neutron',
    })
    await dispatcher.pushReminder(makeReminder())
    expect(client.calls[0]?.[0]?.title).toBe('Neutron')
  })

  test('web platform rows cannot be inserted post-migration 0042', async () => {
    // Web push was removed 2026-05-22 (no customer ask, dead code path).
    // Migration 0042 drops 'web' from the platform CHECK enum, so the
    // store now refuses the insert at the SQLite level — the dispatcher
    // can stop filtering web tokens because they cannot exist in the
    // table. Pin the contract so a future enum-widening sneaks past
    // the test gate.
    await expect(
      store.register({
        project_slug: 't1',
        user_id: 'u',
        device_token: 'web-tok',
        // @ts-expect-error — DevicePushPlatform is now ios|android only;
        // the runtime CHECK constraint enforces the same contract.
        platform: 'web',
      }),
    ).rejects.toThrow(/CHECK constraint failed|constraint failed/i)
    // And the dispatcher's fan-out — with zero rows registered — is a
    // clean no-op rather than the prior "filter web then attempt
    // 0 sends" path.
    const client = fakeClient([])
    const dispatcher = createPushDispatcher({ store, client })
    const result = await dispatcher.pushReminder(makeReminder())
    expect(result.attempted).toBe(0)
    expect(client.calls.length).toBe(0)
  })

  test('instance isolation: pushReminder for instance A does not touch instance B tokens', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'tok-1',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't2',
      user_id: 'u2',
      device_token: 'tok-2',
      platform: 'ios',
    })
    const client = fakeClient([{ status: 'ok' }])
    const dispatcher = createPushDispatcher({ store, client })
    await dispatcher.pushReminder(makeReminder({ project_slug: 't1' }))
    expect(client.calls.length).toBe(1)
    expect(client.calls[0]?.length).toBe(1)
    expect(client.calls[0]?.[0]?.to).toBe('tok-1')
  })

  test('per-ticket error logs warning but PushResult.ok stays true', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok-1',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok-2',
      platform: 'android',
    })
    const client = fakeClient([
      { status: 'ok', id: 'a' },
      {
        status: 'error',
        message: 'DeviceNotRegistered',
        details: { error: 'DeviceNotRegistered' },
      },
    ])
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushReminder(makeReminder())
    expect(result.attempted).toBe(2)
    expect(result.delivered).toBe(1)
    expect(result.errored).toBe(1)
    expect(result.ok).toBe(true)
    expect(entries.length).toBe(1)
    expect(entries[0]?.message).toBe('expo push ticket error')
    expect(entries[0]?.meta?.['error']).toBe('DeviceNotRegistered')
  })

  test('Expo throws ExpoPushError → result.ok=false, no exception escapes', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok',
      platform: 'ios',
    })
    const client = throwingClient(new ExpoPushError('Expo 503', 503))
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushReminder(makeReminder())
    expect(result.ok).toBe(false)
    expect(result.delivered).toBe(0)
    expect(result.errored).toBe(1)
    expect(result.error?.name).toBe('ExpoPushError')
    expect(entries[0]?.message).toBe('expo push send failed')
    expect(entries[0]?.meta?.['status']).toBe(503)
  })

  test('network failure (TypeError) → result.ok=false, logger.warn called', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok',
      platform: 'ios',
    })
    const client = throwingClient(new TypeError('fetch failed'))
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushReminder(makeReminder())
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('TypeError')
    expect(entries.length).toBe(1)
  })

  test('reminder with null topic_id omits the field from the data payload', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok',
      platform: 'ios',
    })
    const client = fakeClient([{ status: 'ok' }])
    const dispatcher = createPushDispatcher({ store, client })
    await dispatcher.pushReminder(makeReminder({ topic_id: null }))
    const data = client.calls[0]?.[0]?.data
    expect(data?.kind).toBe('reminder')
    expect(data?.project_slug).toBe('t1')
    expect(Object.prototype.hasOwnProperty.call(data ?? {}, 'topic_id')).toBe(false)
  })
})

describe('PushDispatcher.pushAll', () => {
  test('fans out arbitrary message to every native token', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok-1',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok-2',
      platform: 'android',
    })
    // Web platform rows are rejected by migration 0042's CHECK constraint
    // (see "web platform rows cannot be inserted" test above); fan-out
    // only ever sees ios + android tokens, no runtime filter required.
    const client = fakeClient([{ status: 'ok' }, { status: 'ok' }])
    const dispatcher = createPushDispatcher({ store, client })
    const result = await dispatcher.pushAll('t1', {
      title: 'Agent says',
      body: 'hello',
      data: { kind: 'agent_message' },
    })
    expect(result.attempted).toBe(2)
    const msgs = client.calls[0] ?? []
    expect(msgs.length).toBe(2)
    expect(msgs.every((m) => m.title === 'Agent says')).toBe(true)
    expect(msgs.every((m) => m.body === 'hello')).toBe(true)
    expect(msgs.every((m) => m.data?.kind === 'agent_message')).toBe(true)
  })

  test('no tokens → attempted=0, no client call', async () => {
    const client = fakeClient([])
    const dispatcher = createPushDispatcher({ store, client })
    const result = await dispatcher.pushAll('t-empty', { body: 'hi' })
    expect(result.attempted).toBe(0)
    expect(client.calls.length).toBe(0)
  })
})

/**
 * ISSUE #39 (2026-05-23) — `pushUser` is the per-user-scoped sibling of
 * `pushAll`. Reads `store.listByUser(project_slug, user_id)` so an owner
 * with multiple users (group projects per master-plan §5.1) only fans
 * the message to THIS user's registered devices. Same chunking +
 * ExpoPushError handling + PushResult shape as the rest of the
 * dispatcher.
 */
describe('PushDispatcher.pushUser', () => {
  test('per-user fan-out: only THIS user\'s tokens are POSTed', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-a-1',
      platform: 'ios',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-a-2',
      platform: 'android',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'user-b',
      device_token: 'tok-b-1',
      platform: 'ios',
    })
    const client = fakeClient([{ status: 'ok' }, { status: 'ok' }])
    const dispatcher = createPushDispatcher({ store, client })
    const result = await dispatcher.pushUser('t1', 'user-a', {
      title: '🚀 Your first task is done!',
      body: 'Tap to see what your agent built.',
      data: { kind: 'wow_fired', project_id: 'neutron' },
    })
    expect(result.attempted).toBe(2)
    expect(result.delivered).toBe(2)
    expect(result.ok).toBe(true)
    const msgs = client.calls[0] ?? []
    expect(msgs.length).toBe(2)
    expect(new Set(msgs.map((m) => m.to))).toEqual(
      new Set(['tok-a-1', 'tok-a-2']),
    )
    // CRITICAL: user-b's token is NOT in the fan-out.
    expect(new Set(msgs.map((m) => m.to))).not.toContain('tok-b-1')
  })

  test('no tokens for the user → attempted=0, no client call (still skips even when instance has tokens)', async () => {
    // Instance has tokens but the targeted user_id has none. Must NOT
    // fall through to an instance-wide fan-out (the regression #39 fix
    // would re-leak other users' devices otherwise).
    await store.register({
      project_slug: 't1',
      user_id: 'user-b',
      device_token: 'tok-b-1',
      platform: 'ios',
    })
    const client = fakeClient([])
    const dispatcher = createPushDispatcher({ store, client })
    const result = await dispatcher.pushUser('t1', 'user-a', {
      body: 'hi',
    })
    expect(result.attempted).toBe(0)
    expect(client.calls.length).toBe(0)
  })

  test('Expo throws → result.ok=false, no exception escapes (shared dispatch path)', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'user-a',
      device_token: 'tok-a-1',
      platform: 'ios',
    })
    const client = throwingClient(new ExpoPushError('Expo 503', 503))
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushUser('t1', 'user-a', {
      body: 'hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('ExpoPushError')
    expect(entries[0]?.message).toBe('expo push send failed')
    expect(entries[0]?.meta?.['status']).toBe(503)
  })

  test('cross-project isolation: pushUser(tA, uX) does not see (tB, uX) tokens', async () => {
    await store.register({
      project_slug: 'tA',
      user_id: 'shared-uid',
      device_token: 'tok-A',
      platform: 'ios',
    })
    await store.register({
      project_slug: 'tB',
      user_id: 'shared-uid',
      device_token: 'tok-B',
      platform: 'ios',
    })
    const client = fakeClient([{ status: 'ok' }])
    const dispatcher = createPushDispatcher({ store, client })
    await dispatcher.pushUser('tA', 'shared-uid', { body: 'hi' })
    expect(client.calls.length).toBe(1)
    expect(client.calls[0]?.length).toBe(1)
    expect(client.calls[0]?.[0]?.to).toBe('tok-A')
  })
})
