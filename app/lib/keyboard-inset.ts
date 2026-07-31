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
 * ON iOS THE FIX IS TO MEASURE IN WINDOW COORDINATES INSTEAD. The keyboard's
 * `endCoordinates.screenY` is a window-space y. So the container's bottom must
 * be window-space too (`measureInWindow`, not `onLayout`), and then the overlap
 * is a subtraction that holds at ANY nesting depth. That is
 * {@link keyboardOverlap}.
 *
 * ANDROID CANNOT USE THAT SUBTRACTION — the two terms are in DIFFERENT
 * COORDINATE SPACES, and believing otherwise is what shipped the composer back
 * under the keyboard a second time (owner, 2026-07-30: *"Text entry window and
 * send button still not visible when keyboard is showing"*). The two Android
 * sources, read this session out of the installed RN 0.81.5:
 *
 *   - `endCoordinates.screenY` is `mVisibleViewArea.bottom`
 *     (`ReactRootView.java:891,913`) — the raw SCREEN y of
 *     `getWindowVisibleDisplayFrame()`.
 *   - `measureInWindow` returns the shadow-tree frame with `includeViewportOffset`
 *     (`ReactCommon/react/renderer/dom/DOM.cpp:508-531`), and Android's viewport
 *     offset is `locationOnScreen.y - visibleWindowFrame.top`
 *     (`ReactSurfaceView.kt:93-105`) — i.e. SCREEN y MINUS THE STATUS BAR.
 *
 * So the container's bottom is reported one status-bar-height ABOVE where the
 * keyboard's `screenY` lives, the subtraction comes out short by exactly that,
 * and the bottom of the composer stays behind the keyboard. Measured on an
 * Android 14 emulator (320x640 mdpi, status bar 24px, IME top at y=405): the
 * surface padded itself by 211px where 235px was needed, leaving `composer-bar`
 * running to y=429 — 24px of it, including the send button's row, behind the
 * keyboard.
 *
 * ANDROID USES {@link androidKeyboardInset} INSTEAD — a single OS-sourced
 * quantity, no cross-space subtraction. See its doc comment.
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

export interface AndroidKeyboardInsetInput {
  /**
   * RN's `endCoordinates.height` from `keyboardDidShow`. `0` (or a hidden
   * keyboard) means no lift.
   */
  keyboardHeight: number;
  /** `useSafeAreaInsets().bottom` — the navigation-bar / gesture-bar inset. */
  safeAreaBottom: number;
}

/**
 * THE ANDROID LIFT. How far the IME covers up from the BOTTOM OF THE WINDOW.
 *
 * Android reports the keyboard in two halves and RN hands us only one of them.
 * `ReactRootView.java:902-904`:
 *
 *   Insets imeInsets  = rootInsets.getInsets(WindowInsets.Type.ime());
 *   Insets barInsets  = rootInsets.getInsets(WindowInsets.Type.systemBars());
 *   int    height     = imeInsets.bottom - barInsets.bottom;
 *
 * `height` is therefore the keyboard MINUS the navigation bar it draws over.
 * The quantity a bottom-anchored surface actually needs is the whole
 * `imeInsets.bottom`, so the navigation bar has to be added back. That is
 * exactly `useSafeAreaInsets().bottom`: safe-area-context reads
 * `statusBars | displayCutout | navigationBars | captionBar`
 * (`react-native-safe-area-context/android/.../SafeAreaUtils.kt:13-25`), whose
 * BOTTOM component is the navigation bar — the same `systemBars().bottom` RN
 * subtracts, and deliberately not the IME.
 *
 *   inset = height + safeAreaBottom = imeInsets.bottom
 *
 * Both terms come from `WindowInsets` on the same window, so this is an
 * addition inside ONE coordinate space — the mistake that
 * {@link keyboardOverlap} makes on Android is not available here.
 *
 * PRECONDITION — the surface's bottom edge IS the window's bottom edge. True
 * today and verified on device: with the keyboard down `chat-keyboard-inset`
 * measures [72,151][320,640] on a 640px-tall screen. It is structural, not
 * incidental: the project shell applies a top inset only
 * (`app/app/projects/[id]/_layout.tsx`) and the chat surface is its last,
 * bottom-most child. If bottom chrome is ever added under the chat surface,
 * subtract its height here — the failure mode of getting that wrong is a
 * visible dead band, not a hidden composer.
 *
 * WHY NOT LET THE OS RESIZE THE WINDOW. `adjustResize` stopped resizing the
 * window once the app went edge-to-edge (`app/app.json` android
 * `edgeToEdgeEnabled: true`, and Android 16 / targetSdk 36 makes edge-to-edge
 * non-optional anyway), so the window now spans the full screen with the
 * keyboard drawn over it. Nothing shrinks on our behalf; the app owes itself
 * this padding.
 *
 * KNOWN LIMIT, and it is RN's, not this function's. On SDK >= 30 `ReactRootView`
 * only emits when the keyboard's VISIBILITY changes — `if (keyboardIsVisible !=
 * mKeyboardIsVisible)`, `ReactRootView.java:897-901`. A keyboard that changes
 * HEIGHT while staying visible (switching to the emoji panel, a suggestion strip
 * appearing) therefore delivers no event at all, and the inset holds its last
 * value until the keyboard hides. Closing that needs a native `WindowInsets`
 * listener — a new native module, so a real build rather than an
 * over-the-air update. Not worth it for the state the owner is actually in;
 * recorded here so the next reader does not re-derive it.
 */
export function androidKeyboardInset({
  keyboardHeight,
  safeAreaBottom,
}: AndroidKeyboardInsetInput): number {
  if (!Number.isFinite(keyboardHeight) || keyboardHeight <= 0) return 0;
  const safe = Number.isFinite(safeAreaBottom) && safeAreaBottom > 0 ? safeAreaBottom : 0;
  return keyboardHeight + safe;
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
