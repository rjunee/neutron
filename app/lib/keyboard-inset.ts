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
