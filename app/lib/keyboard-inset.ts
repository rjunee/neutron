/**
 * @neutronai/app — the keyboard-inset arithmetic. Pure, so it is testable
 * without a device, a DOM, or react-native.
 *
 * WHY THIS EXISTS — `KeyboardAvoidingView` UNDER-PADS A NESTED SURFACE.
 * RN's `KeyboardAvoidingView` measures itself with `onLayout`, whose
 * `nativeEvent.layout.y` is PARENT-RELATIVE, and then computes its padding as
 * `frame.y + frame.height - keyboardScreenY`. That identity only holds when the
 * KAV is the full-screen root. The chat surface is not: it sits inside the
 * project shell's status-bar padding, under the project header, and under the
 * tab bar. Every one of those offsets is missing from `frame.y`, so the computed
 * padding was short by exactly the chrome above the surface — around 150pt on a
 * modern iPhone, which is more than the composer's own height. Net effect on
 * device: the keyboard came up and completely covered the input. Ryan: *"the
 * mobile keyboard just covers the text entry box. You can't see it at all."*
 *
 * THE FIX IS TO MEASURE IN WINDOW COORDINATES INSTEAD. The keyboard's
 * `endCoordinates.screenY` is a window-space y. So the container's bottom must
 * be window-space too (`measureInWindow`, not `onLayout`), and then the overlap
 * is a subtraction that holds at ANY nesting depth.
 *
 * It also degrades correctly on Android. With `adjustResize` / edge-to-edge the
 * OS already shrinks the window, so the measured container bottom is ALREADY
 * above the keyboard, the subtraction yields ≤ 0, and no padding is added — no
 * platform branch, no double-padding.
 */

export interface KeyboardOverlapInput {
  /**
   * Bottom edge of the surface in WINDOW coordinates (`measureInWindow` y +
   * height). Must not include any inset this function previously returned, or
   * the two feed back on each other.
   */
  containerBottomY: number;
  /**
   * Top edge of the keyboard in window coordinates — RN's
   * `endCoordinates.screenY`. `null` means no keyboard (hidden / dismissed).
   */
  keyboardScreenY: number | null;
}

/**
 * How much bottom padding the surface needs so the keyboard covers none of it.
 * Zero whenever the keyboard is hidden, below the surface, or the measurement is
 * not yet trustworthy.
 */
export function keyboardOverlap({
  containerBottomY,
  keyboardScreenY,
}: KeyboardOverlapInput): number {
  if (keyboardScreenY === null) return 0;
  if (!Number.isFinite(containerBottomY) || !Number.isFinite(keyboardScreenY)) return 0;
  // A zero/negative bottom means the view has not been laid out yet. Padding on
  // a guess would jump the composer around on first focus, so wait.
  if (containerBottomY <= 0) return 0;
  const overlap = containerBottomY - keyboardScreenY;
  return overlap > 0 ? overlap : 0;
}

/**
 * THE COMPOSER'S OWN BOTTOM PADDING — the second half of "the composer and send
 * button are not fully visible" (Ryan, 2026-07-30).
 *
 * {@link keyboardOverlap} handles the keyboard. It does NOT handle the case the
 * owner is in most of the time: keyboard DOWN. The chat surface runs to the
 * physical bottom of the screen — the project shell hard-codes a top inset
 * (`app/app/projects/[id]/_layout.tsx` `container.paddingTop`) and applies no
 * bottom inset at all, and nothing in the app had ever read
 * `react-native-safe-area-context` (it was a declared dependency with zero
 * imports). So the composer's 16pt bottom padding was sitting UNDER an iPhone's
 * 34pt home indicator: the send button and the bottom of the text field were
 * genuinely clipped before the keyboard was ever involved.
 *
 * AND IT MUST NOT DOUBLE-OFFSET. When the keyboard is up it covers the home
 * indicator, the surface is already lifted by the full overlap, and adding the
 * safe-area inset on top of that parks the composer on a dead band of
 * background — the "accounting for the rail and tab bar" half of the ask. So the
 * safe-area inset applies ONLY while the keyboard is down. This is the same
 * either/or `KeyboardAvoidingView` + `SafeAreaView` get wrong together.
 */
export interface ComposerBottomInsetInput {
  /** What {@link keyboardOverlap} returned. `> 0` means the keyboard is up. */
  keyboardInset: number;
  /** `useSafeAreaInsets().bottom` — the home indicator / gesture bar. */
  safeAreaBottom: number;
}

/**
 * The composer's resting bottom padding with the keyboard up: iMessage sits the
 * bar right on the keyboard, with only enough room not to touch it.
 */
export const COMPOSER_BOTTOM_PADDING_PT = 8;

export function composerBottomInset({
  keyboardInset,
  safeAreaBottom,
}: ComposerBottomInsetInput): number {
  const safe =
    Number.isFinite(safeAreaBottom) && safeAreaBottom > 0 ? safeAreaBottom : 0;
  if (keyboardInset > 0) return COMPOSER_BOTTOM_PADDING_PT;
  return COMPOSER_BOTTOM_PADDING_PT + safe;
}
