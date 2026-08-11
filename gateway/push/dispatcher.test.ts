/**
 * @neutronai/gateway/push — PushDispatcher tests.
 *
 * This is the TRANSPORT's test. What a notification SAYS is composed elsewhere
 * (`chat-message-push.test.ts`) — the `pushReminder` operation these tests used to
 * drive was deleted on 2026-08-09 because it composed the payload from the reminder
 * ROW, which for a ritual is the dispatch token `ritual:<id>`. Everything the
 * transport owns is still covered here, now driven through `pushAll`:
 *   - empty-token-list short-circuits with attempted=0
 *   - every registered token is POSTed with the given title/body/sound/data
 *   - web rows cannot exist post-migration 0042
 *   - per-ticket errors are logged but PushResult.ok stays true, and a
 *     `DeviceNotRegistered` token is pruned while other failures are not
 *   - thrown Expo errors are downgraded to logger.warn + ok=false
 *   - instance isolation: a send for instance A only sees instance A's tokens
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  ExpoPushError,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoPushSendResult,
  type ExpoPushTicket,
} from './expo-push-client.ts'
import { DevicePushTokenStore } from './store.ts'
import { createPushDispatcher, type PushDispatcherLogger } from './dispatcher.ts'
import { buildChatMessagePushSink } from './chat-message-push.ts'

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

/** One composed chat message, standing in for whatever a producer sends. */
const CHAT_PUSH = {
  title: 'General',
  body: 'walk the dog',
  data: { kind: 'agent_message', message_id: 'p-1' },
}

type LogEntry = { message: string; meta?: Record<string, unknown> }

// `infos` is a SEPARATE array from `entries` on purpose: every existing test
// asserts on `entries` (warnings), and folding the new success tally into the
// same list would change those counts and red them for the wrong reason.
function recordingLogger(): {
  logger: PushDispatcherLogger
  entries: LogEntry[]
  infos: LogEntry[]
} {
  const entries: LogEntry[] = []
  const infos: LogEntry[] = []
  return {
    entries,
    infos,
    logger: {
      warn(message, meta) {
        entries.push({ message, ...(meta !== undefined ? { meta } : {}) })
      },
      info(message, meta) {
        infos.push({ message, ...(meta !== undefined ? { meta } : {}) })
      },
    },
  }
}

describe('PushDispatcher — the Expo transport', () => {
  test('no tokens → attempted=0, no client call', async () => {
    const client = fakeClient([])
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
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
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
    expect(result.attempted).toBe(2)
    expect(result.delivered).toBe(2)
    expect(result.ok).toBe(true)
    expect(client.calls.length).toBe(1)
    const msgs = client.calls[0] ?? []
    expect(new Set(msgs.map((m) => m.to))).toEqual(
      new Set(['ExponentPushToken[ios]', 'ExponentPushToken[android]']),
    )
    for (const m of msgs) {
      // The transport forwards the composed message VERBATIM. It does not author
      // a title, a body or a `kind` of its own any more — that authorship is what
      // put `ritual:kaizen` on the owner's lock screen, and it now lives in
      // `chat-message-push.ts` where the message is actually in hand.
      expect(m.title).toBe(CHAT_PUSH.title)
      expect(m.body).toBe(CHAT_PUSH.body)
      expect(m.sound).toBe('default')
      expect(m.data).toEqual(CHAT_PUSH.data)
    }
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
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
    expect(result.attempted).toBe(0)
    expect(client.calls.length).toBe(0)
  })

  test('instance isolation: a send for instance A does not touch instance B tokens', async () => {
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
    await dispatcher.pushAll('t1', CHAT_PUSH)
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
    // Ticket i belongs to message i, and the messages come out of
    // `store.listByOwner`, which is `ORDER BY updated_at DESC` (store.ts:165) —
    // NOT registration order. Both rows above are written in the same
    // millisecond, so that ORDER BY is a tie and SQLite may return them either
    // way round. A positional `[ok, error]` array therefore lands the error on
    // whichever token sorted first, so the wrong row gets pruned whenever the
    // tie breaks that way and the `tok-2` assertion below fails.
    //
    // It is INTERMITTENT, and measurably so: it failed on CI run 30740607248
    // (shard 4/4) and then passed on run 30741274758 with the same code, while
    // failing on every local run on one dev mac. That spread is the signature of
    // a tie-break, not of a broken assertion — which is exactly why the fix is
    // to remove the ordering dependence rather than to pin an order.
    //
    // Address the tokens BY NAME: the assertion is about WHICH token gets
    // pruned, so it must not rest on an order the query never promised.
    const client = fakeClient((messages) =>
      messages.map((m) =>
        m.to === 'tok-2'
          ? {
              status: 'error' as const,
              message: 'DeviceNotRegistered',
              details: { error: 'DeviceNotRegistered' },
            }
          : { status: 'ok' as const, id: 'a' },
      ),
    )
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
    expect(result.attempted).toBe(2)
    expect(result.delivered).toBe(1)
    expect(result.errored).toBe(1)
    expect(result.ok).toBe(true)
    expect(entries[0]?.message).toBe('expo push ticket error')
    expect(entries[0]?.meta?.['error']).toBe('DeviceNotRegistered')
    // The ticket error is also ACTED on: a `DeviceNotRegistered` token is
    // deleted, so the dead device is retried at most once rather than on every
    // reminder for the life of the install. `tok-1` (ok) is untouched.
    expect(entries.map((e) => e.message)).toEqual([
      'expo push ticket error',
      'expo push token pruned',
    ])
    expect(store.getByDeviceToken('t1', 'tok-2')).toBeNull()
    expect(store.getByDeviceToken('t1', 'tok-1')).not.toBeNull()
  })

  test('a NON-DeviceNotRegistered ticket error leaves the token registered', async () => {
    // Rate limits, oversized messages and credential problems are transient or
    // sender-side. Pruning on those would silently end push for the owner's live
    // phone until their next sign-in.
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok-1',
      platform: 'ios',
    })
    const client = fakeClient([
      { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } },
    ])
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
    expect(result.errored).toBe(1)
    expect(entries.map((e) => e.message)).toEqual(['expo push ticket error'])
    expect(store.getByDeviceToken('t1', 'tok-1')).not.toBeNull()
  })

  test('a SHORT ticket list prunes NOTHING — index i no longer names message i', async () => {
    // THE PRUNE IS AN INDEX JOIN, AND A SHORT RESPONSE BREAKS THE JOIN. The client
    // appends the tickets Expo returned rather than padding the gaps, so one
    // missing ticket shifts every later one left by one — and a
    // `DeviceNotRegistered` then names a token that is alive. Two devices, ONE
    // returned ticket, and it is an error: the old code read `messages[0].to` and
    // deleted whichever token the query happened to return first.
    //
    // ASSERTED BY NAME, NOT BY ORDER, for the same reason the prune test above is:
    // `listByProject` promises no ordering, so "the wrong one was deleted" is only
    // checkable as "NEITHER was deleted". That also makes this the assertion that
    // dies when the length guard is removed — with the guard gone exactly one of
    // these two lookups goes null, whichever one the tie-break picked.
    for (const device_token of ['tok-1', 'tok-2']) {
      await store.register({ project_slug: 't1', user_id: 'u', device_token, platform: 'ios' })
    }
    const client = fakeClient([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ])
    const { logger, entries } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
    // The shortfall is VISIBLE in the tally, which is what makes it diagnosable:
    // two attempted, one ticket back, so `delivered + errored < attempted`.
    expect(result.attempted).toBe(2)
    expect(result.delivered).toBe(0)
    expect(result.errored).toBe(1)
    expect(result.ok).toBe(true)
    expect(store.getByDeviceToken('t1', 'tok-1')).not.toBeNull()
    expect(store.getByDeviceToken('t1', 'tok-2')).not.toBeNull()
    // And it is SAID OUT LOUD — a silent skip would leave a growing token table
    // with nothing in the journal to explain why pruning stopped.
    expect(entries.map((e) => e.message)).toEqual([
      'expo push ticket error',
      'expo push ticket count does not match messages — skipping token prune',
    ])
    const skip = entries[1]
    expect(skip?.meta?.['messages']).toBe(2)
    expect(skip?.meta?.['tickets']).toBe(1)
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
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
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
    const result = await dispatcher.pushAll('t1', CHAT_PUSH)
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('TypeError')
    expect(entries.length).toBe(1)
  })

  test('a message with no data omits the field entirely', async () => {
    // The transport must not invent a `data` bag. A payload with a `data: {}` the
    // producer never asked for is a payload the tap resolver has to reject.
    await store.register({
      project_slug: 't1',
      user_id: 'u',
      device_token: 'tok',
      platform: 'ios',
    })
    const client = fakeClient([{ status: 'ok' }])
    const dispatcher = createPushDispatcher({ store, client })
    await dispatcher.pushAll('t1', { body: 'bare' })
    const msg = client.calls[0]?.[0]
    expect(msg?.body).toBe('bare')
    expect(Object.prototype.hasOwnProperty.call(msg ?? {}, 'data')).toBe(false)
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


describe('PushDispatcher — the success tally (push observability)', () => {
  // WHY: this path logged ONLY on failure, so silence carried two opposite
  // meanings — "delivered fine" and "never ran at all". Diagnosing a live push
  // failure came down to asking the owner whether his phone buzzed, because
  // nothing in the journal could tell those apart. These pin the line that
  // removes the ambiguity.
  test('a fully successful send emits a tally with counts', async () => {
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'ExponentPushToken[android]',
      platform: 'android',
    })
    const client = fakeClient([{ status: 'ok', id: 't-1' }])
    const { logger, entries, infos } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })

    const result = await dispatcher.pushAll('t1', CHAT_PUSH)

    expect(result.delivered).toBe(1)
    // The point of the change: a SUCCESS is now visible, not inferred from the
    // absence of a warning.
    expect(infos.length).toBe(1)
    expect(infos[0]?.message).toBe('expo push sent')
    expect(infos[0]?.meta).toMatchObject({ attempted: 1, delivered: 1, errored: 0 })
    expect(entries.length).toBe(0)
  })

  test('the tally NEVER carries token material', async () => {
    // A token in a log is a credential in a log. The recipient is identified by
    // project_slug, which is the granularity the store queries at anyway.
    const token = 'ExponentPushToken[secret-value-here]'
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: token,
      platform: 'android',
    })
    const client = fakeClient([{ status: 'ok', id: 't-1' }])
    const { logger, infos } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })

    await dispatcher.pushAll('t1', CHAT_PUSH)

    const serialised = JSON.stringify(infos)
    expect(serialised).not.toContain(token)
    expect(serialised).not.toContain('secret-value-here')
  })

  test('a PARTIAL failure still emits the tally, alongside the warning', async () => {
    // The mixed case is the one worth seeing: without a tally, two tokens where
    // one failed looks identical in the journal to two where both did.
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'ExponentPushToken[aaa]',
      platform: 'android',
    })
    await store.register({
      project_slug: 't1',
      user_id: 'u1',
      device_token: 'ExponentPushToken[bbb]',
      platform: 'android',
    })
    const client = fakeClient([
      { status: 'ok', id: 't-1' },
      { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
    ])
    const { logger, entries, infos } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })

    await dispatcher.pushAll('t1', CHAT_PUSH)

    expect(infos[0]?.meta).toMatchObject({ attempted: 2, delivered: 1, errored: 1 })
    expect(entries.some((e) => e.message === 'expo push ticket error')).toBe(true)
  })

  test('zero tokens emits NO tally — there was no send to report', async () => {
    // A fresh install has no devices; a tally there would claim a send happened
    // when the dispatcher deliberately makes no HTTP call at all.
    const client = fakeClient([])
    const { logger, infos } = recordingLogger()
    const dispatcher = createPushDispatcher({ store, client, logger })

    const result = await dispatcher.pushAll('t1', CHAT_PUSH)

    expect(result.attempted).toBe(0)
    expect(infos.length).toBe(0)
    expect(client.calls.length).toBe(0)
  })

  describe('`delivered` counts ACCEPTED tickets — it is never attempted-minus-errored', () => {
    // WHY THIS BLOCK EXISTS. `delivered` used to be computed as
    // `messages.length - errored.length`, which equals the accepted count ONLY when
    // Expo returns one ticket per message. On a 200 that carries FEWER tickets the
    // subtraction reports every message as delivered while nothing was accepted —
    // and `chat-message-push.ts` stamps the durable row `delivered_at` off this
    // number, which permanently silences the idempotent re-emit. The fail-closed
    // guard added there was reading a fail-OPEN input, so the zero-delivery stamp it
    // exists to prevent came straight back by this route.
    const twoDevices = async (): Promise<void> => {
      await store.register({
        project_slug: 't1',
        user_id: 'u1',
        device_token: 'ExponentPushToken[aaa]',
        platform: 'android',
      })
      await store.register({
        project_slug: 't1',
        user_id: 'u1',
        device_token: 'ExponentPushToken[bbb]',
        platform: 'ios',
      })
    }

    test('an EMPTY ticket array on a 200 delivered to nobody', async () => {
      await twoDevices()
      const client = fakeClient([])
      const dispatcher = createPushDispatcher({ store, client })

      const result = await dispatcher.pushAll('t1', CHAT_PUSH)

      // The HTTP call happened and did not throw, so `ok` stays true — that is the
      // whole reason `ok` cannot be the field a delivery is judged on.
      expect(result.ok).toBe(true)
      expect(result.attempted).toBe(2)
      expect(result.delivered).toBe(0)
      expect(client.calls.length).toBe(1)
    })

    test('a SHORT ticket array counts only what came back ok', async () => {
      await twoDevices()
      // One ticket for two messages: the second was never acknowledged, so it was
      // not delivered. Subtraction would have said 2.
      const client = fakeClient([{ status: 'ok', id: 't-1' }])
      const dispatcher = createPushDispatcher({ store, client })

      const result = await dispatcher.pushAll('t1', CHAT_PUSH)

      expect(result.delivered).toBe(1)
      expect(result.errored).toBe(0)
      // The shortfall is visible in the tally rather than hidden inside it.
      expect(result.delivered + result.errored).toBeLessThan(result.attempted)
    })

    test('POSITIVE CONTROL: one ticket per message still reports a full delivery', async () => {
      // The guard must not have been bought by making every send read as a failure.
      // This is the case that must keep passing when the others are made to red.
      await twoDevices()
      const client = fakeClient((msgs) => msgs.map(() => ({ status: 'ok', id: 'tick' })))
      const dispatcher = createPushDispatcher({ store, client })

      const result = await dispatcher.pushAll('t1', CHAT_PUSH)

      expect(result.attempted).toBe(2)
      expect(result.delivered).toBe(2)
      expect(result.errored).toBe(0)
    })

    test('POSITIVE CONTROL: one accepted ticket among failures IS a delivery', async () => {
      await twoDevices()
      const client = fakeClient([
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok', id: 't-2' },
      ])
      const dispatcher = createPushDispatcher({ store, client })

      const result = await dispatcher.pushAll('t1', CHAT_PUSH)

      expect(result.delivered).toBe(1)
      expect(result.errored).toBe(1)
    })

    describe('the REAL sink against the REAL dispatcher — the two halves must agree', () => {
      // THE UNION HAZARD, which is the one this whole lane exists for
      // (`wire-types/push-kind.ts` records the incident it is named after): a SENDER
      // and a CONSUMER that are each independently green can still be disjoint.
      //
      // It happened again here, exactly as documented. `chat-message-push.ts` was
      // made to fail CLOSED on `PushResult.delivered`, and its tests proved that
      // against a HAND-WRITTEN `{ ok, delivered }` fake. The dispatcher's tests
      // proved its own tally. Both green — and the tally was computed by subtracting
      // errors from messages sent, so a 200 that accepted nothing reported a full
      // delivery and the fail-closed guard passed it straight through. Neither side's
      // fixture could see it, because the defect lived in the space between them.
      //
      // So this block wires the real sink to the real dispatcher and asserts the
      // ANSWER THE ROW IS STAMPED FROM, not the intermediate number. A fake on either
      // side would recreate the blind spot.
      const sinkOver = (
        tickets: ExpoPushTicket[] | ((m: ExpoPushMessage[]) => ExpoPushTicket[]),
      ): ReturnType<typeof buildChatMessagePushSink> =>
        buildChatMessagePushSink({
          fanOut: createPushDispatcher({ store, client: fakeClient(tickets) }),
          project_slug: 't1',
        })

      const MSG = { project_id: null, message_id: 'p-1', body: 'the composed body' }

      test('an empty ticket array is NOT a delivery, so the row is never stamped', async () => {
        await twoDevices()
        expect(await sinkOver([])(MSG)).toBe(false)
      })

      test('a short ticket array with one accepted ticket IS a delivery', async () => {
        await twoDevices()
        expect(await sinkOver([{ status: 'ok', id: 't-1' }])(MSG)).toBe(true)
      })

      test('zero registered devices is NOT a delivery — the fresh-install case', async () => {
        // No `twoDevices()`. The dispatcher short-circuits before Expo is called and
        // returns `ok: true, delivered: 0`; stamping on that silences the re-emit
        // forever on a box that has never registered a phone.
        expect(await sinkOver([])(MSG)).toBe(false)
      })

      test('an all-errored batch is NOT a delivery', async () => {
        await twoDevices()
        const sink = sinkOver((msgs) =>
          msgs.map(() => ({
            status: 'error' as const,
            details: { error: 'DeviceNotRegistered' },
          })),
        )
        expect(await sink(MSG)).toBe(false)
      })

      test('POSITIVE CONTROL: a normal send IS a delivery', async () => {
        await twoDevices()
        const sink = sinkOver((msgs) => msgs.map(() => ({ status: 'ok' as const, id: 'tick' })))
        expect(await sink(MSG)).toBe(true)
      })
    })
  })
})
