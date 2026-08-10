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

  test('the default budget is the exported constant', () => {
    const body = 'w '.repeat(400)
    expect(chatPushExcerpt(body).length).toBeLessThanOrEqual(CHAT_PUSH_BODY_MAX + 1)
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

  test('General OMITS project_id rather than sending null', () => {
    // Absence is the wire encoding for "the no-project scope"; the client owns
    // General's route spelling. A literal `null` would be decoded as a string by
    // nothing and route nowhere.
    const push = buildChatMessagePush({ project_id: null, message_id: 'p1', body: 'x' })
    expect('project_id' in push.data).toBe(false)
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

  test('a body with nothing in it sends NO notification', async () => {
    // A buzz with no words tells the owner nothing he cannot already see in chat.
    const f = fake()
    const sink = buildChatMessagePushSink({ fanOut: f.fanOut, project_slug: 'owner' })
    await sink({ project_id: null, message_id: 'p1', body: '   \n ' })
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
    await sink({ project_id: null, message_id: 'p1', body: 'hi' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('expo 503')
  })
})
