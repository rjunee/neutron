/**
 * The jump-to-bottom visibility rule.
 *
 * The owner asked for the button to appear "only when you are scrolled up, not in
 * regular usage", and that negative half is what these tests mostly defend. A
 * transcript is never pixel-exact at rest — momentum settles short, FlashList grows
 * `contentSize` as it measures rows it had estimated, and the keyboard changes the
 * viewport mid-gesture — so an exact `atBottom` test would flash the button while
 * he is reading. A button that appears when you did not scroll is worse than none.
 */

import { describe, expect, test } from 'bun:test'

import {
  JUMP_TO_BOTTOM_THRESHOLD_PX,
  distanceFromBottom,
  shouldShowJumpToBottom,
} from '../lib/chat-core/jump-to-bottom'

const VIEWPORT = 800

/** A long transcript, scrolled so that `up` px of content sit below the fold. */
function scrolledUpBy(up: number, contentHeight = 5000): Parameters<typeof shouldShowJumpToBottom>[0] {
  return { contentHeight, offsetY: contentHeight - VIEWPORT - up, viewportHeight: VIEWPORT }
}

describe('shouldShowJumpToBottom — the negative half', () => {
  test('hidden at the exact bottom', () => {
    expect(shouldShowJumpToBottom(scrolledUpBy(0))).toBe(false)
  })

  test('hidden a few pixels short of the bottom (momentum settling)', () => {
    // The case an exact test gets wrong. Scrolling rarely lands on 0.
    expect(shouldShowJumpToBottom(scrolledUpBy(3))).toBe(false)
    expect(shouldShowJumpToBottom(scrolledUpBy(40))).toBe(false)
  })

  test('hidden while overscrolling past the bottom (iOS rubber-band)', () => {
    // offsetY beyond the max yields a NEGATIVE raw distance; clamped to 0.
    const g = { contentHeight: 5000, offsetY: 5000 - VIEWPORT + 120, viewportHeight: VIEWPORT }
    expect(distanceFromBottom(g)).toBe(0)
    expect(shouldShowJumpToBottom(g)).toBe(false)
  })

  test('hidden when the whole transcript fits the screen', () => {
    // Nothing to jump to. `startRenderingFromBottom` pads a short transcript down
    // to hug the composer, so contentHeight can exceed the message stack; a naive
    // distance test would show the button on a two-message conversation.
    expect(
      shouldShowJumpToBottom({ contentHeight: 300, offsetY: 0, viewportHeight: VIEWPORT }),
    ).toBe(false)
    expect(
      shouldShowJumpToBottom({ contentHeight: VIEWPORT, offsetY: 0, viewportHeight: VIEWPORT }),
    ).toBe(false)
  })

  test('hidden when the viewport has not been measured yet', () => {
    // First paint reports 0 before layout. Showing the button then would put it on
    // screen before the transcript is even drawn.
    expect(
      shouldShowJumpToBottom({ contentHeight: 5000, offsetY: 0, viewportHeight: 0 }),
    ).toBe(false)
  })

  test('hidden just BELOW the threshold, shown just above it', () => {
    // Pins the boundary in both directions, so a change to the constant cannot
    // silently widen or narrow the rule without a test noticing.
    expect(shouldShowJumpToBottom(scrolledUpBy(JUMP_TO_BOTTOM_THRESHOLD_PX))).toBe(false)
    expect(shouldShowJumpToBottom(scrolledUpBy(JUMP_TO_BOTTOM_THRESHOLD_PX + 1))).toBe(true)
  })
})

describe('shouldShowJumpToBottom — the positive half', () => {
  test('shown when scrolled up by more than a screen', () => {
    expect(shouldShowJumpToBottom(scrolledUpBy(VIEWPORT))).toBe(true)
  })

  test('shown at the very top of a long transcript', () => {
    expect(
      shouldShowJumpToBottom({ contentHeight: 5000, offsetY: 0, viewportHeight: VIEWPORT }),
    ).toBe(true)
  })

  test('the threshold is about one screen, not a couple of pixels', () => {
    // Guards the intent rather than the number: a threshold of, say, 8px would
    // satisfy every other test here while reintroducing the flashing the owner
    // explicitly asked to avoid.
    expect(JUMP_TO_BOTTOM_THRESHOLD_PX).toBeGreaterThanOrEqual(200)
  })
})

describe('distanceFromBottom', () => {
  test('measures the content below the fold', () => {
    expect(distanceFromBottom({ contentHeight: 5000, offsetY: 1000, viewportHeight: VIEWPORT })).toBe(
      3200,
    )
  })
})
