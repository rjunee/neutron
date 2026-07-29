import { describe, expect, it } from 'bun:test'

import { parseSessionReadyMaxSeq } from '../types.ts'

describe('parseSessionReadyMaxSeq — stale-store reset signal (M1)', () => {
  it('extracts last_seen_seq from a session_ready frame', () => {
    expect(parseSessionReadyMaxSeq({ v: 1, type: 'session_ready', last_seen_seq: 42 })).toBe(42)
  })

  it('truncates a fractional seq to an integer', () => {
    expect(parseSessionReadyMaxSeq({ type: 'session_ready', last_seen_seq: 7.9 })).toBe(7)
  })

  it('returns 0 when the server explicitly reports an empty topic', () => {
    expect(parseSessionReadyMaxSeq({ type: 'session_ready', last_seen_seq: 0 })).toBe(0)
  })

  it('returns null when last_seen_seq is absent (omitted on a fresh/no-log topic)', () => {
    expect(parseSessionReadyMaxSeq({ v: 1, type: 'session_ready', user_id: 'sam' })).toBeNull()
  })

  it('returns null for a non-session_ready frame', () => {
    expect(parseSessionReadyMaxSeq({ type: 'agent_message', last_seen_seq: 9 })).toBeNull()
  })

  it('returns null for malformed / non-numeric / non-finite values', () => {
    expect(parseSessionReadyMaxSeq({ type: 'session_ready', last_seen_seq: 'nope' })).toBeNull()
    expect(parseSessionReadyMaxSeq({ type: 'session_ready', last_seen_seq: NaN })).toBeNull()
    expect(parseSessionReadyMaxSeq({ type: 'session_ready', last_seen_seq: Infinity })).toBeNull()
    expect(parseSessionReadyMaxSeq(null)).toBeNull()
    expect(parseSessionReadyMaxSeq('session_ready')).toBeNull()
    expect(parseSessionReadyMaxSeq(undefined)).toBeNull()
  })
})
