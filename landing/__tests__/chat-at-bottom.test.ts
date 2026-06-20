/**
 * `isAtBottom` is the predicate that drives the autoscroll state machine.
 *
 *   isAtBottom = (scrollHeight - scrollTop - clientHeight) <= threshold
 *
 * Tests use a duck-typed stub element so we don't need a full DOM here.
 */

import { describe, expect, test } from 'bun:test'
import { isAtBottom } from '../chat.ts'

function stubLog({
  scrollHeight,
  scrollTop,
  clientHeight,
}: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): HTMLElement {
  return { scrollHeight, scrollTop, clientHeight } as unknown as HTMLElement
}

describe('isAtBottom', () => {
  test('exact bottom returns true', () => {
    expect(isAtBottom(stubLog({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }))).toBe(true)
  })

  test('within 32px slack returns true (DPR rounding tolerance)', () => {
    expect(isAtBottom(stubLog({ scrollHeight: 1000, scrollTop: 770, clientHeight: 200 }))).toBe(true)
    expect(isAtBottom(stubLog({ scrollHeight: 1000, scrollTop: 768, clientHeight: 200 }))).toBe(true)
  })

  test('33px from bottom returns false', () => {
    expect(isAtBottom(stubLog({ scrollHeight: 1000, scrollTop: 767, clientHeight: 200 }))).toBe(false)
  })

  test('scrolled to top returns false', () => {
    expect(isAtBottom(stubLog({ scrollHeight: 1000, scrollTop: 0, clientHeight: 200 }))).toBe(false)
  })

  test('content shorter than viewport: trivially at bottom', () => {
    expect(isAtBottom(stubLog({ scrollHeight: 100, scrollTop: 0, clientHeight: 200 }))).toBe(true)
  })

  test('threshold override is honored', () => {
    const log = stubLog({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 })
    expect(isAtBottom(log, 0)).toBe(false)
    expect(isAtBottom(log, 300)).toBe(true)
  })
})
