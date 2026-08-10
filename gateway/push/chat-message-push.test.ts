/**
 * The notification a chat message wears (owner-reported, 2026-08-09).
 *
 * *"the notification that comes in on Android says 'ritual:kaizen'. … the
 * notification should include at least the first part of the chat message in the
 * notification itself."*
 *
 * So the assertions here are about what the owner SEES and what the tap CARRIES,
 * and they are separate assertions on purpose: a payload can carry a perfect
 * `message_id` while showing him a routing token, and it can show him the right
 * words while carrying nothing a tap can use. Both failures shipped once.
 */
import { describe, expect, test } from 'bun:test'

import { isPushKind, PUSH_KIND_AGENT_MESSAGE } from '@neutronai/wire-types/push-kind.ts'
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'
import {
  buildChatMessagePush,
  buildChatMessagePushSink,
  CHAT_PUSH_BODY_MAX,
  CHAT_PUSH_GENERAL_TITLE,
  chatMessagePushScope,
  chatPushExcerpt,
  type ChatMessagePushFanOut,
} from './chat-message-push.ts'

describe('chatPushExcerpt', () => {
  test('a short body passes through untouched', () => {
    expect(chatPushExcerpt('take a break')).toBe('take a break')
  })

  test('newlines and runs of whitespace collapse to single spaces', () => {
    // A composed ritual is multi-line markdown. A raw newline in a notification
    // body eats one of the two lines Android gives you.
    expect(chatPushExcerpt('line one\n\n  line two\ttab')).toBe('line one line two tab')
  })

  test('truncates on a WORD boundary and says so with an ellipsis', () => {
    const body = `${'alpha '.repeat(40)}omega`
    const out = chatPushExcerpt(body, 20)
    expect(out.endsWith('…')).toBe(true)
    // No half-word: everything before the ellipsis is whole words.
    expect(out.slice(0, -1).trim().split(' ').every((w) => w === 'alpha')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(21)
  })

  test('a single word longer than the whole budget still yields something', () => {
    // There is no boundary to cut on. Returning '' here would be a silent
    // empty notification.
    const out = chatPushExcerpt('x'.repeat(400), 10)
    expect(out).toBe(`${'x'.repeat(10)}…`)
  })

  test('trailing punctuation is not left dangling before the ellipsis', () => {
    expect(chatPushExcerpt('one two, three four', 9)).toBe('one two…')
  })

  test('a blank body excerpts to the empty string rather than whitespace', () => {
    expect(chatPushExcerpt('   \n\t ')).toBe('')
  })

  test('never a BARE ELLIPSIS — a head that is all punctuation keeps its characters', () => {
    // The punctuation strip can empty the head. `…` alone is a buzz with no words,
    // and it slips past the sink's `length === 0` guard because it IS one character
    // long, so the notification would fire saying nothing whatsoever.
    const out = chatPushExcerpt('.'.repeat(200), 20)
    expect(out).not.toBe('…')
    expect(out.length).toBeGreaterThan(1)
    expect(out.endsWith('…')).toBe(true)
  })

  test('never splits an emoji in half at the clip boundary', () => {
    // `slice` counts UTF-16 units, so a fixed budget can land between the halves of
    // a surrogate pair. The orphan renders as the replacement glyph, which reads as
    // a corrupted message rather than a truncated one.
    const out = chatPushExcerpt(`${'a'.repeat(9)}🎉🎉🎉`, 10)
    expect(out).toBe(`${'a'.repeat(9)}…`)
    expect(out).not.toContain('�')
    // And the assertion that generalises: no lone surrogate anywhere in the output.
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = out.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
    }
  })

  test('the default budget is the exported constant', () => {
    const body = 'w '.repeat(400)
    expect(chatPushExcerpt(body).length).toBeLessThanOrEqual(CHAT_PUSH_BODY_MAX + 1)
  })

  test('a nonsense budget never produces the bare ellipsis', () => {
    // The function's stated invariant is "never a buzz with no words", and a budget
    // of 0 / negative / NaN broke it by making every branch return `…` alone.
    // Unreachable from the single call site today, which is exactly why it needed a
    // test rather than a promise — the second call site is where it would have bitten.
    for (const budget of [0, -1, Number.NaN]) {
      const out = chatPushExcerpt('hello world', budget)
      expect(out).not.toBe('…')
      expect(out.replace(/…$/, '').length).toBeGreaterThan(0)
    }
  })
})

describe('chatMessagePushScope', () => {
  test('`app:<user>` is the no-project General scope', () => {
    expect(chatMessagePushScope('app:acct-2')).toEqual({ project_id: null })
  })

  test('`app:<user>:<project>` is that project', () => {
    expect(chatMessagePushScope('app:acct-2:beacon')).toEqual({ project_id: 'beacon' })
  })

  test('a non-app topic is General — no other chat exists for a tap to open', () => {
    expect(chatMessagePushScope('web:acct-2:beacon')).toEqual({ project_id: null })
    expect(chatMessagePushScope('12345:6')).toEqual({ project_id: null })
    expect(chatMessagePushScope('')).toEqual({ project_id: null })
  })
})

describe('buildChatMessagePush', () => {
  test('the BODY is the message — this is the reported defect', () => {
    const push = buildChatMessagePush({
      project_id: 'beacon',
      message_id: 'p1',
      body: 'Kaizen review: two things landed today.',
    })
    expect(push.body).toBe('Kaizen review: two things landed today.')
  })

  test('the TITLE names where the message is', () => {
    expect(buildChatMessagePush({ project_id: 'beacon', message_id: 'p1', body: 'x' }).title).toBe(
      'beacon',
    )
    expect(buildChatMessagePush({ project_id: null, message_id: 'p1', body: 'x' }).title).toBe(
      CHAT_PUSH_GENERAL_TITLE,
    )
  })

  test('the kind is one the client actually handles', () => {
    // The list-vs-resolver drift this repo already had once: a `kind` no resolver
    // knows opens the app and routes nowhere.
    const push = buildChatMessagePush({ project_id: null, message_id: 'p1', body: 'x' })
    expect(push.data['kind']).toBe(PUSH_KIND_AGENT_MESSAGE)
    expect(isPushKind(push.data['kind'])).toBe(true)
  })

  test('the tap payload carries the row id, and nothing internal', () => {
    const push = buildChatMessagePush({
      project_id: 'beacon',
      message_id: 'prompt-9',
      body: 'x',
    })
    expect(push.data['message_id']).toBe('prompt-9')
    expect(push.data['project_id']).toBe('beacon')
    // No reminder id, no ritual id, no owner slug: an internal token in a
    // notification payload is how `ritual:kaizen` reached a lock screen.
    expect(Object.keys(push.data).sort()).toEqual(['kind', 'message_id', 'project_id'])
  })

  test('General NAMES ITSELF — the field is always a string, never absent or null', () => {
    // It was the other way round for one round of review: General was encoded by
    // ABSENCE so the gateway would not have to spell the client's route sentinel.
    // That breaks every app bundle already on a device — the released resolver
    // reads `agent_message` with no project as MALFORMED and refuses to route, so
    // the tap would open the app and go nowhere, which is the reported bug. A store
    // app and a self-hosted gateway do not upgrade together, so the payload has to
    // be readable by the client that is already installed.
    const push = buildChatMessagePush({ project_id: null, message_id: 'p1', body: 'x' })
    expect(push.data['project_id']).toBe(GENERAL_RAIL_ID)
    expect(typeof push.data['project_id']).toBe('string')
  })

  test('the General sentinel is the SHARED one, not a second copy', () => {
    // The `~general` / `#general` / `general` confusion of ISSUES #410/#411 came
    // from two definitions drifting. There is one, in `wire-types`, and both sides
    // import it; `app/__tests__/general-scope.test.ts` pins the client's end.
    expect(GENERAL_RAIL_ID).toBe('~general')
  })
})

describe('buildChatMessagePushSink', () => {
  function fake(): { fanOut: ChatMessagePushFanOut; calls: unknown[]; failWith?: Error } {
    const calls: unknown[] = []
    return {
      calls,
      fanOut: {
        pushAll: async (project_slug, message) => {
          calls.push({ project_slug, message })
          // A fake that wants to model a DELIVERY has to say so. This used to
          // resolve `undefined` and read as success, which is exactly how the
          // zero-delivery stamp survived a whole review round: the tests could not
          // tell "Expo accepted this for a device" from "nothing was sent". The sink
          // now fails closed, so the count is part of the fixture.
          return { attempted: 1, delivered: 1, errored: 0, ok: true, error: null }
        },
      },
    }
  }

  test('fans the composed notification to the instance the device rows are keyed by', async () => {
    const f = fake()
    const sink = buildChatMessagePushSink({ fanOut: f.fanOut, project_slug: 'owner' })
    await sink({ project_id: 'beacon', message_id: 'p1', body: 'hello there' })
    expect(f.calls).toEqual([
      {
        project_slug: 'owner',
        message: {
          title: 'beacon',
          body: 'hello there',
          data: { kind: PUSH_KIND_AGENT_MESSAGE, message_id: 'p1', project_id: 'beacon' },
        },
      },
    ])
  })

  test('a body with nothing in it sends NO notification, and reports not-sent', async () => {
    // A buzz with no words tells the owner nothing he cannot already see in chat.
    const f = fake()
    const sink = buildChatMessagePushSink({ fanOut: f.fanOut, project_slug: 'owner' })
    expect(await sink({ project_id: null, message_id: 'p1', body: '   \n ' })).toBe(false)
    expect(f.calls).toEqual([])
  })

  test('a transport failure is swallowed and logged, never thrown at the producer', async () => {
    const logged: string[] = []
    const sink = buildChatMessagePushSink({
      fanOut: {
        pushAll: async () => {
          throw new Error('expo 503')
        },
      },
      project_slug: 'owner',
      log: (m) => logged.push(m),
    })
    // Swallowed, AND reported as not-sent — `deliver` reads this to decide whether to
    // record the row as one the owner has seen. Returning `true` here would suppress
    // the notification on the retry of a message that never reached him.
    expect(await sink({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(false)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('expo 503')
  })

  test('an accepted fan-out reports SENT', async () => {
    const f = fake()
    const sink = buildChatMessagePushSink({ fanOut: f.fanOut, project_slug: 'owner' })
    expect(await sink({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(true)
  })

  test('an Expo OUTAGE reports not-sent even though pushAll RESOLVED', async () => {
    // The trap this exists for: `PushDispatcher.pushAll` catches its own network
    // failure and resolves with `ok: false` rather than throwing
    // (`gateway/push/dispatcher.ts` `PushResult`). A sink that only watched for a
    // throw would call an outage a delivered notification, and `deliver` would stamp
    // the row as seen for a buzz that never happened — silencing the retry.
    const logged: string[] = []
    const sink = buildChatMessagePushSink({
      fanOut: {
        pushAll: async () => ({ attempted: 1, delivered: 0, errored: 0, ok: false, error: null }),
      },
      project_slug: 'owner',
      log: (m) => logged.push(m),
    })
    expect(await sink({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(false)
    expect(logged).toHaveLength(1)
  })

  // ── ok:true AND NOBODY REACHED ────────────────────────────────────────────────
  // The bug three reviewers confirmed independently. `ok` means only "no HTTP/network
  // exception", and there are two ordinary paths where it is `true` with a delivered
  // count of zero. On both, an `ok`-only sink answers `true`, `deliver` stamps
  // `delivered_at`, and the idempotent re-emit is silenced FOREVER for a message the
  // owner never received — the precise failure `gateway/http/deliver.ts` claims to
  // prevent. These are not edge cases: the first is the state of every fresh install.

  test('NO REGISTERED DEVICE reports not-sent, even though pushAll resolved ok', async () => {
    // `dispatch` short-circuits before Expo is ever called:
    // `{ attempted: 0, delivered: 0, errored: 0, ok: true }` (`gateway/push/dispatcher.ts`).
    // Nobody was reached, so nothing may be recorded as seen.
    const logged: string[] = []
    const sink = buildChatMessagePushSink({
      fanOut: {
        pushAll: async () => ({ attempted: 0, delivered: 0, errored: 0, ok: true, error: null }),
      },
      project_slug: 'owner',
      log: (m) => logged.push(m),
    })
    expect(await sink({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(false)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('reached no device')
  })

  test('EVERY TICKET ERRORED reports not-sent, even though pushAll resolved ok', async () => {
    // Expo returned tickets, so `ok` stays true — but every one was an error (the
    // whole batch `DeviceNotRegistered` after a reinstall, say). Delivered is what
    // decides.
    const sink = buildChatMessagePushSink({
      fanOut: {
        pushAll: async () => ({ attempted: 2, delivered: 0, errored: 2, ok: true, error: null }),
      },
      project_slug: 'owner',
    })
    expect(await sink({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(false)
  })

  test('ONE accepted ticket among failures IS a delivery', async () => {
    // The owner's other phone got it. That is a real notification, and re-buzzing him
    // on the next re-emit would be the opposite mistake.
    const sink = buildChatMessagePushSink({
      fanOut: {
        pushAll: async () => ({ attempted: 2, delivered: 1, errored: 1, ok: true, error: null }),
      },
      project_slug: 'owner',
    })
    expect(await sink({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(true)
  })

  test('a fan-out that reports NO COUNT fails closed', async () => {
    // An unreported count has not proven that anything was accepted. Reading it as
    // success is what the previous contract did ("anything without an explicit
    // `ok: false` counts as accepted"), and that default is the enabler of every
    // case above.
    const sink = buildChatMessagePushSink({
      fanOut: { pushAll: async () => ({ ok: true }) },
      project_slug: 'owner',
    })
    expect(await sink({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(false)
    const undef = buildChatMessagePushSink({
      fanOut: { pushAll: async () => undefined },
      project_slug: 'owner',
    })
    expect(await undef({ project_id: null, message_id: 'p1', body: 'hi' })).toBe(false)
  })
})
