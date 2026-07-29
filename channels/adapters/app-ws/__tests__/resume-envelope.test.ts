import { describe, expect, it } from 'bun:test'

import { decodeAppWsInbound, decodeAppWsResume } from '../envelope.ts'

describe('decodeAppWsResume — resume control frame', () => {
  it('decodes a well-formed resume request', () => {
    expect(decodeAppWsResume({ v: 1, type: 'resume', after_seq: 7 })).toEqual({
      v: 1,
      type: 'resume',
      after_seq: 7,
    })
  })

  it('clamps a negative / fractional after_seq to a non-negative integer', () => {
    expect(decodeAppWsResume({ v: 1, type: 'resume', after_seq: -3 })?.after_seq).toBe(0)
    expect(decodeAppWsResume({ v: 1, type: 'resume', after_seq: 4.9 })?.after_seq).toBe(4)
  })

  it('rejects a resume with a non-numeric / missing after_seq', () => {
    expect(decodeAppWsResume({ v: 1, type: 'resume', after_seq: 'x' })).toBeNull()
    expect(decodeAppWsResume({ v: 1, type: 'resume' })).toBeNull()
  })

  it('returns null for a non-resume frame (message decoder owns those)', () => {
    expect(decodeAppWsResume({ v: 1, type: 'user_message', body: 'hi' })).toBeNull()
  })

  it('decodeAppWsInbound still ignores resume frames (separation of concerns)', () => {
    expect(decodeAppWsInbound({ v: 1, type: 'resume', after_seq: 2 })).toBeNull()
    expect(
      decodeAppWsInbound({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c1' }),
    ).toMatchObject({ type: 'user_message', body: 'hi', client_msg_id: 'c1' })
  })
})
