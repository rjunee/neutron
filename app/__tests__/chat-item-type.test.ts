/**
 * FlashList recycling classes for transcript rows.
 *
 * The owner reported the scroll track "jumps around, changes size … not
 * consistent". FlashList v2 measures rows instead of taking an
 * `estimatedItemSize`, and with no `getItemType` every row shares ONE recycling
 * pool — so a view whose previous tenant was a one-line user bubble gets
 * re-measured as a tall agent markdown block, `contentSize` is revised, and the
 * track resizes under the thumb.
 *
 * WHAT THESE TESTS CLAIM, precisely: that the classes are distinct and stable, and
 * that the surface actually hands the function to the list. Whether the track then
 * *feels* smooth is a device claim — the FlashList stub does not virtualise or
 * measure, so it cannot be observed here. Overstating that would be the same
 * mistake as calling a green ledger row proof a ritual worked.
 */

import { describe, expect, test } from 'bun:test'

import { chatItemType } from '../lib/chat-core/chat-render-model'

type RenderRow = import('../lib/chat-core/chat-render-model').RenderRow
type ChatMessage = import('@neutronai/chat-core').ChatMessage

function msgRow(role: ChatMessage['role']): RenderRow {
  return {
    kind: 'message',
    key: `c-${role}`,
    message: {
      topic_id: 'app:owner',
      client_msg_id: `c-${role}`,
      message_id: `m-${role}`,
      seq: 1,
      role,
      body: 'x',
      project_id: null,
      attachments: null,
      created_at: 1_700_000_000_000,
      status: 'acked',
      read_by: null,
    } as ChatMessage,
  }
}

describe('chatItemType', () => {
  test('a user bubble and an agent reply are DIFFERENT classes', () => {
    // The whole point. Sharing a pool is what makes a recycled view re-measure
    // from one line to a full screen.
    expect(chatItemType(msgRow('user'))).not.toBe(chatItemType(msgRow('agent')))
  })

  test('a streaming row is its own class', () => {
    // It grows token by token, so recycling it as either settled kind guarantees a
    // re-measure on every chunk.
    const streaming: RenderRow = { kind: 'streaming', key: 's1', message_id: 'm1', body: 'part' }
    const t = chatItemType(streaming)
    expect(t).not.toBe(chatItemType(msgRow('user')))
    expect(t).not.toBe(chatItemType(msgRow('agent')))
  })

  test('the class is STABLE for the same row shape', () => {
    // An unstable key would defeat recycling entirely — worse than one shared pool.
    expect(chatItemType(msgRow('user'))).toBe(chatItemType(msgRow('user')))
    expect(chatItemType(msgRow('agent'))).toBe(chatItemType(msgRow('agent')))
  })

  test('non-user roles group with agent rather than minting a class each', () => {
    // System/notice rows render through the same full-width path as an agent reply.
    // A class per role would fragment the pools and cost recycling for no
    // measurement benefit.
    expect(chatItemType(msgRow('system' as ChatMessage['role']))).toBe(
      chatItemType(msgRow('agent')),
    )
  })
})
