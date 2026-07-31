/**
 * @neutronai/app — the keyboard-inset arithmetic (`lib/keyboard-inset.ts`).
 *
 * Pure numbers, no DOM, no react-native. The interesting case is the one that
 * shipped broken: a surface nested under ~150pt of chrome. `KeyboardAvoidingView`
 * measures PARENT-relative and therefore subtracted that chrome from its own
 * padding, leaving the composer under the keyboard. Window-space measurement
 * cannot make that mistake, and the third case below is the proof.
 */

import { describe, expect, it } from 'bun:test';

import { androidKeyboardInset, keyboardOverlap } from '../lib/keyboard-inset';

/** iPhone-15-class logical points. */
const SCREEN_H = 852;
const KEYBOARD_H = 336;
const KEYBOARD_TOP = SCREEN_H - KEYBOARD_H; // 516

describe('keyboardOverlap', () => {
  it('is zero when there is no keyboard', () => {
    expect(keyboardOverlap({ containerBottomY: SCREEN_H, keyboardScreenY: null })).toBe(0);
  });

  it('is the full keyboard height for a surface that reaches the bottom of the screen', () => {
    expect(keyboardOverlap({ containerBottomY: SCREEN_H, keyboardScreenY: KEYBOARD_TOP })).toBe(
      KEYBOARD_H,
    );
  });

  it('IS STILL THE FULL KEYBOARD HEIGHT for a surface nested under chrome', () => {
    // THE REGRESSION. The chat surface sits under the shell's status-bar padding,
    // the project header and the tab bar — call it 150pt — but it still extends to
    // the bottom of the SCREEN. `KeyboardAvoidingView` computed
    // `parentRelativeY + height - keyboardTop` = (0 + 702) - 516 = 186pt, i.e.
    // 150pt short, which is more than the composer's own height, so the keyboard
    // covered it entirely. Measuring in WINDOW space gives the right answer no
    // matter how deep the surface is nested.
    const CHROME_ABOVE = 150;
    const parentRelativeBottom = SCREEN_H - CHROME_ABOVE; // what onLayout reported
    const windowBottom = SCREEN_H; // what measureInWindow reports

    const wrong = parentRelativeBottom - KEYBOARD_TOP;
    expect(wrong).toBe(186); // the shipped behaviour, for the record
    expect(keyboardOverlap({ containerBottomY: windowBottom, keyboardScreenY: KEYBOARD_TOP })).toBe(
      KEYBOARD_H,
    );
  });

  it('is zero when the surface ends above the keyboard (Android adjustResize)', () => {
    // The OS already shrank the window, so the surface bottom is above the
    // keyboard top and no padding must be added — no platform branch needed.
    expect(keyboardOverlap({ containerBottomY: KEYBOARD_TOP, keyboardScreenY: KEYBOARD_TOP })).toBe(
      0,
    );
    expect(
      keyboardOverlap({ containerBottomY: KEYBOARD_TOP - 40, keyboardScreenY: KEYBOARD_TOP }),
    ).toBe(0);
  });

  it('is partial when the surface only overlaps part of the keyboard', () => {
    expect(keyboardOverlap({ containerBottomY: 600, keyboardScreenY: KEYBOARD_TOP })).toBe(84);
  });

  it('refuses to pad on an unmeasured (zero-height) container', () => {
    // happy-dom / pre-layout / a detached ref. Padding on a guess would jump the
    // composer on first focus.
    expect(keyboardOverlap({ containerBottomY: 0, keyboardScreenY: KEYBOARD_TOP })).toBe(0);
    expect(keyboardOverlap({ containerBottomY: -10, keyboardScreenY: KEYBOARD_TOP })).toBe(0);
  });

  it('refuses non-finite input rather than producing NaN padding', () => {
    expect(keyboardOverlap({ containerBottomY: Number.NaN, keyboardScreenY: KEYBOARD_TOP })).toBe(0);
    expect(keyboardOverlap({ containerBottomY: SCREEN_H, keyboardScreenY: Number.NaN })).toBe(0);
    expect(
      keyboardOverlap({ containerBottomY: Number.POSITIVE_INFINITY, keyboardScreenY: KEYBOARD_TOP }),
    ).toBe(0);
  });
});

/**
 * THE ANDROID HALF (`androidKeyboardInset`).
 *
 * `keyboardOverlap` above is an iOS-only subtraction. On Android its two terms
 * live in different coordinate spaces — `endCoordinates.screenY` is a raw screen
 * y (`ReactRootView.java:891,913`) while `measureInWindow` is offset by the
 * status bar (`ReactSurfaceView.kt:93-105`) — so it under-padded by exactly the
 * status-bar height and the composer stayed behind the keyboard. Owner,
 * 2026-07-30: *"Text entry window and send button still not visible when
 * keyboard is showing"*.
 *
 * Android therefore adds instead of subtracting, inside ONE space: RN reports
 * the keyboard NET of the navigation bar it draws over
 * (`height = imeInsets.bottom - barInsets.bottom`, `ReactRootView.java:904`), so
 * the bar is added back to reach the window's bottom edge.
 */
describe('androidKeyboardInset', () => {
  /** A gesture-navigation bar, the common case on a modern Android phone. */
  const NAV_BAR_H = 24;

  it('is zero while the keyboard is down', () => {
    expect(androidKeyboardInset({ keyboardHeight: 0, safeAreaBottom: NAV_BAR_H })).toBe(0);
  });

  it('adds the navigation bar back to the keyboard height', () => {
    // THE DEFECT, as one number. RN hands us 336; the IME actually covers
    // 336 + 24 of the window, and the missing 24 is the strip the send button
    // was sitting in.
    expect(androidKeyboardInset({ keyboardHeight: KEYBOARD_H, safeAreaBottom: NAV_BAR_H })).toBe(
      KEYBOARD_H + NAV_BAR_H,
    );
  });

  it('is exactly the keyboard height on a device with no navigation bar', () => {
    // The emulator this was measured on reports no `navigationBars` inset
    // source at all, and there the two agree.
    expect(androidKeyboardInset({ keyboardHeight: KEYBOARD_H, safeAreaBottom: 0 })).toBe(KEYBOARD_H);
  });

  it('tracks a keyboard that changes height', () => {
    expect(androidKeyboardInset({ keyboardHeight: 260, safeAreaBottom: NAV_BAR_H })).toBe(284);
    expect(androidKeyboardInset({ keyboardHeight: 420, safeAreaBottom: NAV_BAR_H })).toBe(444);
  });

  it('never returns negative or NaN padding', () => {
    expect(androidKeyboardInset({ keyboardHeight: -5, safeAreaBottom: NAV_BAR_H })).toBe(0);
    expect(androidKeyboardInset({ keyboardHeight: Number.NaN, safeAreaBottom: NAV_BAR_H })).toBe(0);
    expect(androidKeyboardInset({ keyboardHeight: KEYBOARD_H, safeAreaBottom: Number.NaN })).toBe(
      KEYBOARD_H,
    );
    expect(androidKeyboardInset({ keyboardHeight: KEYBOARD_H, safeAreaBottom: -12 })).toBe(
      KEYBOARD_H,
    );
  });
});
