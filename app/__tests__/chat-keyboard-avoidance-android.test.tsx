/**
 * @neutronai/app — the chat surface must lift its composer clear of the keyboard
 * ON ANDROID. The iOS half of this lives in `chat-keyboard-avoidance.test.tsx`;
 * `Platform.OS` is a per-FILE harness global, so the two platforms cannot share
 * a file.
 *
 * WHY THIS FILE EXISTS. The keyboard lift was fixed once, on 2026-07-29, with a
 * window-space subtraction (`measureInWindow` bottom minus the keyboard's
 * `screenY`) and a comment asserting it "degrades correctly on Android". It does
 * not. The two terms are in DIFFERENT COORDINATE SPACES there:
 *
 *   - `endCoordinates.screenY` is `mVisibleViewArea.bottom`, a raw SCREEN y
 *     (`react-native/ReactAndroid/.../ReactRootView.java:891,913`).
 *   - `measureInWindow` carries Android's viewport offset, which is
 *     `locationOnScreen.y - visibleWindowFrame.top` — screen y MINUS THE STATUS
 *     BAR (`.../runtime/ReactSurfaceView.kt:93-105`, consumed by
 *     `ReactCommon/react/renderer/dom/DOM.cpp:508`).
 *
 * So the subtraction came out short by exactly the status-bar height and the
 * bottom of the composer stayed behind the keyboard. Measured on an Android 14
 * emulator (320x640 mdpi, status bar 24px, IME top at y=405): the surface padded
 * itself 211px where 235px was needed. Owner, 2026-07-30, on the second attempt:
 * *"Text entry window and send button still not visible when keyboard is
 * showing"*.
 *
 * Android now uses the keyboard's own reported HEIGHT plus the bottom safe-area
 * inset — one coordinate space, no subtraction. The tests below drive the REAL
 * keyboard subscription and assert that number, including the case that
 * discriminates the two implementations: a `screenY` that is deliberately wrong
 * must not move the result at all.
 *
 * HONEST BOUNDARY, unchanged from the iOS file. This proves the WIRING and the
 * ARITHMETIC. It does NOT prove the visual result: the harness fakes every
 * element's layout rect, so "the composer is visible above the keyboard" stays a
 * DEVICE claim, and it is settled with `adb`/`uiautomator` bounds, not here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  HARNESS_SCREEN_HEIGHT,
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('android');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { emitKeyboard, keyboardListenerCount } = await import('./support/stubs/react-native');
const { setHarnessSafeAreaInsets, resetHarnessSafeAreaInsets } = await import(
  './support/stubs/safe-area-context'
);
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

const KEYBOARD_HEIGHT = 336;
const KEYBOARD_TOP = HARNESS_SCREEN_HEIGHT - KEYBOARD_HEIGHT;
/** A gesture-navigation bar. RN reports the keyboard NET of this. */
const NAV_BAR = 24;

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
  // An Android phone: a navigation bar at the bottom, no home indicator.
  setHarnessSafeAreaInsets({ top: 24, bottom: NAV_BAR });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
  resetHarnessSafeAreaInsets();
});

beforeAll(installNativeHarness);

afterAll(() => {
  resetHarnessGlobals();
  resetHarnessSafeAreaInsets();
});

async function mountChat() {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId: 'harness-project' }),
    ),
  );
  FakeChatSocket.current().onopen?.();
  await screen.settle();
  return screen;
}

/** The inset container's applied bottom padding, in px. */
function paddingBottom(screen: { byTestId(id: string): HTMLElement | null }): number {
  const node = screen.byTestId('chat-keyboard-inset');
  if (node === null) throw new Error('the keyboard-inset container is not in the tree');
  const raw = node.style.paddingBottom;
  if (raw === '' || raw === undefined) return 0;
  return Number.parseFloat(raw);
}

describe('chat surface keyboard avoidance (android)', () => {
  it('subscribes to keyboard geometry on mount and unsubscribes on unmount', async () => {
    const before = keyboardListenerCount();
    const screen = await mountChat();
    expect(keyboardListenerCount()).toBeGreaterThan(before);
    screen.unmount();
    await screen.settle();
    expect(keyboardListenerCount()).toBe(before);
  });

  it('adds no padding while the keyboard is down', async () => {
    const screen = await mountChat();
    expect(paddingBottom(screen)).toBe(0);
    screen.unmount();
  });

  it('lifts by the keyboard height PLUS the navigation bar', async () => {
    // THE WHOLE DEFECT IN ONE NUMBER. RN reports 336 because it has already
    // subtracted the 24pt navigation bar the IME draws over; the IME really
    // covers 360 of the window, and the missing 24 is the strip the send button
    // was sitting in.
    const screen = await mountChat();
    emitKeyboard('keyboardDidShow', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();

    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT + NAV_BAR);
    screen.unmount();
  });

  it('IGNORES the keyboard screenY entirely', async () => {
    // The discriminating case. `screenY` is the term that is in the wrong
    // coordinate space on Android, so the implementation must not read it: a
    // deliberately absurd value has to leave the result untouched. Under the
    // window-space subtraction this test reports 852 instead of 360.
    const screen = await mountChat();
    emitKeyboard('keyboardDidShow', 0, KEYBOARD_HEIGHT);
    await screen.settle();

    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT + NAV_BAR);
    screen.unmount();
  });

  it('drops the padding again when the keyboard hides', async () => {
    const screen = await mountChat();
    emitKeyboard('keyboardDidShow', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT + NAV_BAR);

    emitKeyboard('keyboardDidHide', HARNESS_SCREEN_HEIGHT, 0);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(0);
    screen.unmount();
  });

  it('tracks a keyboard that changes height, WHEN ANDROID BOTHERS TO SAY SO', async () => {
    // HONEST SCOPE. This proves the component reacts to a height change; it does
    // NOT claim Android delivers one. RN only emits when the keyboard's
    // VISIBILITY flips (`ReactRootView.java:897-901`), so switching to the emoji
    // panel mid-session fires nothing and the inset holds its last value. That
    // is an RN limitation and closing it needs a native WindowInsets listener.
    const screen = await mountChat();
    emitKeyboard('keyboardDidShow', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT + NAV_BAR);

    const taller = 420;
    emitKeyboard('keyboardDidShow', HARNESS_SCREEN_HEIGHT - taller, taller);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(taller + NAV_BAR);
    screen.unmount();
  });

  it('lifts by exactly the keyboard height on a device with no navigation bar', async () => {
    // The emulator the defect was measured on reports no `navigationBars` inset
    // source at all. There the two numbers agree, which is why a
    // no-navigation-bar device hides the bug's second half.
    setHarnessSafeAreaInsets({ bottom: 0 });
    const screen = await mountChat();
    emitKeyboard('keyboardDidShow', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();

    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT);
    screen.unmount();
  });

  it('keeps the composer usable while the keyboard is up', async () => {
    const screen = await mountChat();
    emitKeyboard('keyboardDidShow', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();

    await screen.type('typed with the keyboard up');
    await screen.press('Send');

    const frames = FakeChatSocket.current().framesOfType('user_message');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.['body']).toBe('typed with the keyboard up');
    screen.unmount();
  });
});
