/**
 * `decodeUpdate` — group chats and media messages.
 *
 * Pins: a text message decodes exactly as before (no `attachments` key); a media
 * message with or without a caption decodes to an event carrying file
 * references; an album item carries its `media_group_id`; a message with neither
 * text nor a file (a sticker) is still ignored; the chat id and type ride on
 * `adapter_metadata`.
 */

import { describe, expect, test } from 'bun:test'

import { decodeUpdate, isTelegramAttachmentRef, type TelegramUpdate } from '../webhook-server.ts'

const opts = { bot_user_id: 1, secret_token: 'sec', receiver: { receive: async () => undefined } }
const from = { id: 42, first_name: 'Test', last_name: 'Parent' }
const group = { id: -100500, type: 'group' as const }

function update(message: Record<string, unknown>): TelegramUpdate {
  return { update_id: 1, message: { message_id: 7, from, chat: group, date: 1700000000, ...message } } as TelegramUpdate
}

describe('decodeUpdate — media', () => {
  test('a plain text message keeps its shape', () => {
    const e = decodeUpdate(update({ text: 'hello' }), opts)
    expect(e?.body).toEqual({ text: 'hello' })
    expect(e?.channel_topic_id).toBe('-100500')
    expect(e?.adapter_metadata).toMatchObject({ chat_id: '-100500', chat_type: 'group', message_id: 7 })
  })

  test('a photo with a caption carries the largest rendition', () => {
    const e = decodeUpdate(
      update({
        caption: 'both pages',
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
          { file_id: 'large', file_unique_id: 'l', width: 1280, height: 960, file_size: 120000 },
        ],
      }),
      opts,
    )
    expect(e?.body.text).toBe('both pages')
    expect(e?.body.attachments).toEqual([{ kind: 'photo', file_id: 'large', file_unique_id: 'l', file_size: 120000 }])
    expect(isTelegramAttachmentRef(e?.body.attachments?.[0])).toBe(true)
  })

  test('a voice note with no text still makes an event', () => {
    const e = decodeUpdate(update({ voice: { file_id: 'v1', mime_type: 'audio/ogg', duration: 4 } }), opts)
    expect(e?.body.text).toBe('')
    expect(e?.body.attachments).toEqual([{ kind: 'voice', file_id: 'v1', mime_type: 'audio/ogg' }])
  })

  test('documents and videos decode; album items carry the group id', () => {
    const doc = decodeUpdate(update({ document: { file_id: 'd1', file_name: 'notes.pdf', mime_type: 'application/pdf' } }), opts)
    expect(doc?.body.attachments?.[0]).toMatchObject({ kind: 'document', file_name: 'notes.pdf' })
    const vid = decodeUpdate(update({ media_group_id: 'g1', video: { file_id: 'm1', mime_type: 'video/mp4' } }), opts)
    expect(vid?.body.attachments?.[0]).toMatchObject({ kind: 'video', file_id: 'm1' })
    expect(vid?.adapter_metadata?.['media_group_id']).toBe('g1')
  })

  test('a message with neither text nor a file is ignored', () => {
    expect(decodeUpdate(update({ sticker: { file_id: 's' } }), opts)).toBeNull()
  })

  test("the bot's own media message is ignored", () => {
    const own = { update_id: 2, message: { message_id: 8, from: { id: 1, is_bot: true }, chat: group, date: 1, photo: [{ file_id: 'p' }] } }
    expect(decodeUpdate(own as TelegramUpdate, opts)).toBeNull()
  })

  test('an edit is marked as an edit', () => {
    const e = decodeUpdate({ update_id: 3, edited_message: { message_id: 9, from, chat: group, date: 1, text: 'fixed' } }, opts)
    expect(e?.adapter_metadata?.['edited']).toBe(true)
  })
})
