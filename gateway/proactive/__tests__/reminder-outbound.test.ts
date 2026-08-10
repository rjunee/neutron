/**
 * F5 — `buildButtonStoreReminderOutbound` delegates a fired reminder to the ONE
 * {@link Deliver} seam. These pin the boundary the F5 rewrite created: the exact
 * topic/body/`reply`-durability it forwards, and that `post` reports the DURABLE
 * outcome (`persisted`) — a live-push failure never costs the guarantee.
 */
import { describe, expect, it } from 'bun:test'

import { buildButtonStoreReminderOutbound } from '../reminder-outbound.ts'
import type { Deliver, DeliveryEnvelope } from '../../http/deliver.ts'
import type { ChatMessagePushInput } from '../../push/chat-message-push.ts'

/** Record what the notification sink was asked to send. */
function recordingPush(): {
  chat_push: (input: ChatMessagePushInput) => Promise<void>
  sent: ChatMessagePushInput[]
} {
  const sent: ChatMessagePushInput[] = []
  return {
    chat_push: async (input): Promise<void> => {
      sent.push(input)
    },
    sent,
  }
}

/** The row a RITUAL fire hands the outbound: the stored `message` is the dispatch
 *  token `ritual:<id>` and the BODY is what the turn composed. */
const RITUAL_POST = {
  topic_id: 'app:owner',
  owner_slug: 'owner',
  body: 'Kaizen review: two things landed, one is blocked on the importer.',
  reminder_id: 'r-ritual',
}

describe('buildButtonStoreReminderOutbound → Deliver seam', () => {
  it('forwards the topic + body with durability:reply and returns the durable result', async () => {
    const calls: Array<{ topic: string; env: DeliveryEnvelope }> = []
    const deliver: Deliver = async (topic, env) => {
      calls.push({ topic, env })
      return { prompt_id: 'p1', persisted: true, delivered_live: true }
    }
    const ro = buildButtonStoreReminderOutbound({ deliver })
    const ok = await ro.post({ topic_id: 'app:owner', owner_slug: 'owner', body: 'take a break', reminder_id: 'r1' })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.topic).toBe('app:owner')
    expect(calls[0]!.env).toEqual({ body: 'take a break', durability: 'reply' })
  })

  it('persisted:false → post returns false (no durable row was written)', async () => {
    const deliver: Deliver = async () => ({ prompt_id: null, persisted: false, delivered_live: false })
    const ro = buildButtonStoreReminderOutbound({ deliver })
    expect(await ro.post({ topic_id: 'app:owner', owner_slug: 'owner', body: 'hi', reminder_id: 'r1' })).toBe(false)
  })

  it('a LIVE-PUSH failure still returns post(true) — the durable row is the guarantee', async () => {
    // delivered_live:false (offline / no live socket) but persisted:true → the
    // reminder IS durably recorded; post reports success independent of live delivery.
    const deliver: Deliver = async () => ({ prompt_id: 'p1', persisted: true, delivered_live: false })
    const ro = buildButtonStoreReminderOutbound({ deliver })
    expect(await ro.post({ topic_id: 'app:owner', owner_slug: 'owner', body: 'hi', reminder_id: 'r1' })).toBe(true)
  })
})

/**
 * THE NOTIFICATION IS COMPOSED FROM THE DELIVERED MESSAGE (owner-reported,
 * 2026-08-09: his phone said `ritual:kaizen`).
 *
 * The old push was built in the reminder TICK from the reminder ROW, whose
 * `message` for a ritual IS that token. These assert the property that makes the
 * new path correct rather than merely different: what the owner is notified with
 * is the text that reached his chat, and the notification points at the row it
 * became.
 */
describe('the chat-message notification', () => {
  it('carries the POSTED body and the durable row id — never the ritual token', async () => {
    const deliver: Deliver = async () => ({
      prompt_id: 'prompt-77',
      persisted: true,
      delivered_live: true,
    })
    const push = recordingPush()
    const ro = buildButtonStoreReminderOutbound({ deliver, chat_push: push.chat_push })

    await ro.post(RITUAL_POST)

    expect(push.sent).toHaveLength(1)
    expect(push.sent[0]!.body).toBe(RITUAL_POST.body)
    // The row id is what lets the tap land ON the message rather than merely in
    // the project — `prompt_id` is the identity the client carries onto the row.
    expect(push.sent[0]!.message_id).toBe('prompt-77')
    // MUTATION-SENSITIVE, and the point of the whole change: the reminder's stored
    // dispatch token must not appear anywhere in what the owner is shown.
    expect(push.sent[0]!.body).not.toContain('ritual:')
  })

  it('a General delivery (bare `app:<user>`) notifies with no project — General is not a project', async () => {
    const deliver: Deliver = async () => ({ prompt_id: 'p1', persisted: true, delivered_live: true })
    const push = recordingPush()
    const ro = buildButtonStoreReminderOutbound({ deliver, chat_push: push.chat_push })
    await ro.post(RITUAL_POST)
    expect(push.sent[0]!.project_id).toBeNull()
  })

  it('a project delivery (`app:<user>:<project>`) notifies with that project', async () => {
    const deliver: Deliver = async () => ({ prompt_id: 'p1', persisted: true, delivered_live: true })
    const push = recordingPush()
    const ro = buildButtonStoreReminderOutbound({ deliver, chat_push: push.chat_push })
    await ro.post({ ...RITUAL_POST, topic_id: 'app:owner:beacon' })
    expect(push.sent[0]!.project_id).toBe('beacon')
  })

  it('NO notification when the durable row was not written', async () => {
    // A notification pointing at a transcript that has no such row is worse than
    // no notification: the tap lands nowhere and the owner cannot tell why.
    const deliver: Deliver = async () => ({ prompt_id: null, persisted: false, delivered_live: false })
    const push = recordingPush()
    const ro = buildButtonStoreReminderOutbound({ deliver, chat_push: push.chat_push })
    await ro.post(RITUAL_POST)
    expect(push.sent).toEqual([])
  })

  it('NO notification when the delivery has no row id to anchor on', async () => {
    const deliver: Deliver = async () => ({ prompt_id: null, persisted: true, delivered_live: true })
    const push = recordingPush()
    const ro = buildButtonStoreReminderOutbound({ deliver, chat_push: push.chat_push })
    await ro.post(RITUAL_POST)
    expect(push.sent).toEqual([])
  })

  it('a THROWING sink cannot double-post the reminder', async () => {
    // If this escaped, the tick would read it as "the post did not happen", revert
    // its claim, and post the SAME message again next tick (#319). A failed
    // notification must cost the notification and nothing else.
    const deliver: Deliver = async () => ({ prompt_id: 'p1', persisted: true, delivered_live: true })
    const ro = buildButtonStoreReminderOutbound({
      deliver,
      chat_push: async () => {
        throw new Error('expo unreachable')
      },
    })
    expect(await ro.post(RITUAL_POST)).toBe(true)
  })

  it('no sink wired → the post behaves exactly as it did before push existed', async () => {
    const deliver: Deliver = async () => ({ prompt_id: 'p1', persisted: true, delivered_live: true })
    const ro = buildButtonStoreReminderOutbound({ deliver })
    expect(await ro.post(RITUAL_POST)).toBe(true)
  })
})
