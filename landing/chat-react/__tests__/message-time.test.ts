import { describe, expect, it } from 'bun:test'

import {
  buildMetaIndex,
  formatDayDivider,
  formatMessageDateTitle,
  formatMessageTime,
} from '../ChatApp.tsx'
import type { RenderMessage } from '../controller.ts'

// FIX #338 — per-message timestamps + date-on-hover + day dividers.
// The helpers are pure (clock injected) so they test deterministically. Use a
// fixed local wall-clock instant; `new Date(y, m, d, …)` builds in LOCAL time so
// the assertions match the local-time formatting the helpers use.
const AT = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

function msg(over: Partial<RenderMessage>): RenderMessage {
  return {
    id: 'm', messageId: 'm', role: 'user', text: 'x', status: 'acked', streaming: false,
    attachments: null, createdAt: 0, timestampMs: null, delivery: null, reactions: [],
    edited: false, deleted: false, options: null, promptId: null, allowFreeform: null,
    kind: null, uploadAffordance: null, chosenValue: null, ...over,
  }
}

describe('formatMessageTime', () => {
  it('renders 24h HH:MM', () => {
    expect(formatMessageTime(AT(2026, 7, 3, 14, 32))).toBe('14:32')
    expect(formatMessageTime(AT(2026, 7, 3, 9, 5))).toBe('09:05')
    expect(formatMessageTime(AT(2026, 7, 3, 0, 0))).toBe('00:00')
  })
  it('returns "" for an unparseable time', () => {
    expect(formatMessageTime(Number.NaN)).toBe('')
  })
})

describe('formatMessageDateTitle', () => {
  it('renders a full 12h date+time for the hover tooltip', () => {
    expect(formatMessageDateTitle(AT(2026, 7, 3, 14, 32))).toBe('Jul 3, 2026, 2:32 PM')
    expect(formatMessageDateTitle(AT(2026, 1, 9, 0, 7))).toBe('Jan 9, 2026, 12:07 AM')
    expect(formatMessageDateTitle(AT(2026, 12, 25, 12, 0))).toBe('Dec 25, 2026, 12:00 PM')
  })
})

describe('formatDayDivider', () => {
  const now = new Date(AT(2026, 7, 3, 10, 0))
  it('labels today / yesterday', () => {
    expect(formatDayDivider(AT(2026, 7, 3, 8, 0), now)).toBe('Today')
    expect(formatDayDivider(AT(2026, 7, 2, 23, 59), now)).toBe('Yesterday')
  })
  it('labels an older same-year day with weekday + month + date', () => {
    expect(formatDayDivider(AT(2026, 6, 29, 12, 0), now)).toBe('Mon Jun 29')
  })
  it('includes the year for a different-year day', () => {
    expect(formatDayDivider(AT(2025, 12, 31, 12, 0), now)).toBe('Wed Dec 31, 2025')
  })
})

describe('buildMetaIndex', () => {
  const now = new Date(AT(2026, 7, 3, 10, 0))

  it('tags each durable message with a time + only opens a divider on a day change', () => {
    const messages = [
      msg({ id: 'a', timestampMs: AT(2026, 7, 2, 9, 0) }),
      msg({ id: 'b', timestampMs: AT(2026, 7, 2, 9, 5) }),
      msg({ id: 'c', timestampMs: AT(2026, 7, 3, 8, 0) }),
    ]
    const map = buildMetaIndex(messages, now)
    expect(map.get('a')?.dayDivider).toBe('Yesterday')
    expect(map.get('a')?.timeLabel).toBe('09:00')
    expect(map.get('a')?.dateTitle).toBe('Jul 2, 2026, 9:00 AM')
    // Same day as 'a' → no divider.
    expect(map.get('b')?.dayDivider).toBeNull()
    expect(map.get('b')?.timeLabel).toBe('09:05')
    // New calendar day → a fresh divider.
    expect(map.get('c')?.dayDivider).toBe('Today')
  })

  it('gives ephemeral (null-timestamp) bubbles no time + no divider, without advancing the day cursor', () => {
    const messages = [
      msg({ id: 'a', timestampMs: AT(2026, 7, 3, 8, 0) }),
      msg({ id: 'stream', timestampMs: null }),
      msg({ id: 'b', timestampMs: AT(2026, 7, 3, 8, 1) }),
    ]
    const map = buildMetaIndex(messages, now)
    expect(map.get('a')?.dayDivider).toBe('Today')
    expect(map.get('stream')).toEqual({ timeLabel: '', dateTitle: '', dayDivider: null })
    // 'b' is the same day as 'a'; the ephemeral bubble between them didn't reset the cursor.
    expect(map.get('b')?.dayDivider).toBeNull()
  })
})
