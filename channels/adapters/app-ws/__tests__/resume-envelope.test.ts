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

  // The BACKWARDS bound. Every assertion above predates it, so the branch that
  // decodes it shipped unpinned: the decoder could have dropped `before_seq`
  // entirely and this file would still have been green, which would have made the
  // backwards walk inert while the whole client-side walk kept "working" (it would
  // just be answered with the same newest page forever).
  describe('before_seq — the backwards bound', () => {
    it('decodes a backwards resume, carrying the bound through', () => {
      // MUTATION-PROVED: delete the `before_seq` block in `decodeAppWsResume` and
      // this fails on a missing key rather than a wrong value.
      expect(decodeAppWsResume({ v: 1, type: 'resume', after_seq: 0, before_seq: 631 })).toEqual({
        v: 1,
        type: 'resume',
        after_seq: 0,
        before_seq: 631,
      })
    })

    it('clamps a negative / fractional bound the same way the cursor is clamped', () => {
      // An unclamped bound reaches SQL as the upper end of a range query.
      expect(
        decodeAppWsResume({ v: 1, type: 'resume', after_seq: 0, before_seq: -9 })?.before_seq,
      ).toBe(0)
      expect(
        decodeAppWsResume({ v: 1, type: 'resume', after_seq: 0, before_seq: 12.7 })?.before_seq,
      ).toBe(12)
    })

    it('DROPS a malformed bound instead of rejecting the frame', () => {
      // The compatibility posture that matters: a garbage `before_seq` must not cost
      // the client its FORWARD resume, or one bad frame stops the transcript syncing
      // at all rather than merely failing to walk backwards.
      const decoded = decodeAppWsResume({ v: 1, type: 'resume', after_seq: 5, before_seq: 'x' })
      expect(decoded).toEqual({ v: 1, type: 'resume', after_seq: 5 })
      expect(decodeAppWsResume({ v: 1, type: 'resume', after_seq: 5, before_seq: null })).toEqual({
        v: 1,
        type: 'resume',
        after_seq: 5,
      })
      expect(
        decodeAppWsResume({ v: 1, type: 'resume', after_seq: 5, before_seq: Number.NaN }),
      ).toEqual({ v: 1, type: 'resume', after_seq: 5 })
    })

    it('omits the key entirely on a plain forward resume', () => {
      // An older client's forward resume must stay byte-identical — `before_seq`
      // absent, not present-and-zero, because zero is a real bound meaning "nothing".
      const decoded = decodeAppWsResume({ v: 1, type: 'resume', after_seq: 3 })
      expect(decoded).not.toBeNull()
      expect('before_seq' in (decoded ?? {})).toBe(false)
    })
  })

  it('decodeAppWsInbound still ignores resume frames (separation of concerns)', () => {
    expect(decodeAppWsInbound({ v: 1, type: 'resume', after_seq: 2 })).toBeNull()
    expect(
      decodeAppWsInbound({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c1' }),
    ).toMatchObject({ type: 'user_message', body: 'hi', client_msg_id: 'c1' })
  })
})
