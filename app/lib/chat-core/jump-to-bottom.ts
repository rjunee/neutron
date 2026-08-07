/**
 * @neutronai/app — WHEN THE JUMP-TO-BOTTOM AFFORDANCE IS SHOWN.
 *
 * The owner's requirement, verbatim: *"a small icon that appears in the bottom
 * right that you can tap that jumps you to the very bottom … Only appears when you
 * are scrolled up, not in regular usage."*
 *
 * The second sentence is the whole design constraint, and it is the reason this is
 * a threshold rather than `offsetY < maxOffset`. A transcript is never pixel-exact
 * at rest: momentum scrolling settles a few pixels short, `contentSize` grows as
 * FlashList replaces estimated row heights with measured ones, and the keyboard
 * animating in changes `layoutMeasurement` mid-gesture. Any of those leaves a
 * "distance from bottom" of a few pixels while the owner is, to his eye, at the
 * bottom — so an exact test would flash the button during ordinary reading, which
 * is precisely what he asked it not to do.
 *
 * A button that appears when you did not scroll is worse than no button: it is the
 * same class as a gate that always fires, and the owner learns to ignore it.
 *
 * The threshold is deliberately about one screen. Below that, "jump to bottom" is
 * not a meaningful shortcut — one flick covers it — and the button would only be
 * chrome over the newest message.
 */

/** Distance from the bottom, in px, past which the affordance is worth offering. */
export const JUMP_TO_BOTTOM_THRESHOLD_PX = 320

export interface ScrollGeometry {
  /** Total scrollable content height. */
  contentHeight: number
  /** Current scroll offset from the top. */
  offsetY: number
  /** Height of the visible viewport. */
  viewportHeight: number
}

/**
 * How far the viewport's bottom edge sits above the content's bottom edge.
 *
 * Clamped at 0: iOS rubber-band overscroll produces an offset PAST the content
 * bottom, which yields a negative distance, and a negative number compared against
 * a positive threshold happens to work — but only by accident. Clamping says what
 * is meant.
 */
export function distanceFromBottom(g: ScrollGeometry): number {
  const d = g.contentHeight - (g.offsetY + g.viewportHeight)
  return d > 0 ? d : 0
}

/**
 * Should the jump-to-bottom button be visible?
 *
 * Returns false for a transcript SHORTER than the viewport. There is nothing to
 * jump to when everything already fits, and `startRenderingFromBottom` pads a
 * short transcript down to hug the composer — which inflates `contentHeight` with
 * padding rather than messages, so a naive distance test would show the button on
 * a two-message conversation.
 */
export function shouldShowJumpToBottom(
  g: ScrollGeometry,
  thresholdPx: number = JUMP_TO_BOTTOM_THRESHOLD_PX,
): boolean {
  if (g.viewportHeight <= 0) return false
  if (g.contentHeight <= g.viewportHeight) return false
  return distanceFromBottom(g) > thresholdPx
}
