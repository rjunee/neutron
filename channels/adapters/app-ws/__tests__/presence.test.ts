/**
 * `decodeAppWsPresence` — and specifically what it REFUSES.
 *
 * The accept cases are two lines. The reject cases are the point: this decoder's
 * output is the sole input to a branch that DECLINES to notify the owner's phone
 * (`gateway/push/web-presence.ts`), so every value it wrongly reads as
 * `foreground` is a notification he silently never receives. A decoder that
 * treated "not background" as present would turn a typo into permanent silence.
 */

import { describe, expect, test } from 'bun:test'
import { decodeAppWsPresence } from '../envelope.ts'

describe('decodeAppWsPresence', () => {
  test('accepts the two declared states', () => {
    expect(decodeAppWsPresence({ v: 1, type: 'presence', state: 'foreground' })).toEqual({
      v: 1,
      type: 'presence',
      state: 'foreground',
    })
    expect(decodeAppWsPresence({ v: 1, type: 'presence', state: 'background' })).toEqual({
      v: 1,
      type: 'presence',
      state: 'background',
    })
  })

  test('rejects an unknown state rather than defaulting it to present', () => {
    for (const state of ['visible', 'FOREGROUND', 'active', '', 1, true, null, undefined, {}]) {
      expect(decodeAppWsPresence({ v: 1, type: 'presence', state })).toBeNull()
    }
  })

  test('rejects a wrong version, a wrong type, and a non-object', () => {
    expect(decodeAppWsPresence({ v: 2, type: 'presence', state: 'foreground' })).toBeNull()
    expect(decodeAppWsPresence({ v: 1, type: 'ping', state: 'foreground' })).toBeNull()
    expect(decodeAppWsPresence(null)).toBeNull()
    expect(decodeAppWsPresence('presence')).toBeNull()
    expect(decodeAppWsPresence(undefined)).toBeNull()
  })

  test('does not claim frames belonging to the other decoders', () => {
    // Control that the branch ordering in the surface is safe: a presence probe
    // run before the message decoder must not swallow a real user message.
    expect(decodeAppWsPresence({ v: 1, type: 'user_message', body: 'hi' })).toBeNull()
    expect(decodeAppWsPresence({ v: 1, type: 'resume', after_seq: 3 })).toBeNull()
    expect(decodeAppWsPresence({ v: 1, type: 'receipt', message_id: 'm', state: 'read' })).toBeNull()
  })
})
