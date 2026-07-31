/**
 * @neutronai/app — the chat surface must lift its composer clear of the keyboard.
 *
 * Ryan, on device: *"the mobile keyboard just covers the text entry box. You can't
 * see it at all."* The surface used a `KeyboardAvoidingView`, which measures
 * itself PARENT-relative and so under-padded by exactly the chrome above it (the
 * shell's status-bar padding + the project header + the tab bar). Nothing in a
 * pure-helper suite can see that, which is why it survived every gate and was
 * only found by a thumb.
 *
 * These tests drive the REAL keyboard subscription (`Keyboard.addListener`, faked
 * at the module boundary so events actually fire — react-native-web's `Keyboard`
 * never emits) and assert the padding the surface applies, plus that the
 * subscription is torn down on unmount.
 *
 * HONEST BOUNDARY. This proves the WIRING and the ARITHMETIC: the surface reacts
 * to keyboard geometry and pads by the measured overlap. It does NOT prove the
 * visual result — the harness fakes every element's layout rect
 * (`installLayoutMetrics`), and no JS-level harness can render a real iOS
 * keyboard. "The composer is visible above the keyboard" stays a DEVICE claim.
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
setHarnessPlatform('ios');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { emitKeyboard, keyboardListenerCount } = await import('./support/stubs/react-native');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import(
  '../lib/chat-core/op-sqlite-store'
);
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

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  // The durable store is DEVICE-wide (`sharedMobileStore`), and bun shares one
  // process across test files — a suite that mounts chat has to say it wants a
  // clean transcript, or it inherits the previous test's (or file's) rows.
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
});

// Bun evaluates EVERY test file's top level before running ANY test, so the
// top-level call above cannot be the only arming point: a sibling harness file's
// `afterAll` reset would then run between this file's evaluation and its tests.
// Re-arm immediately before this suite executes.
beforeAll(installNativeHarness);

afterAll(() => {
  // Bun shares one process across ~100 test files: leaving the faked layout rect
  // or the WebSocket recorder installed lands them in whatever runs next.
  resetHarnessGlobals();
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

describe('chat surface keyboard avoidance', () => {
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

  it('lifts the surface by the FULL keyboard overlap when the keyboard comes up', async () => {
    const screen = await mountChat();

    await screen.settle();
    emitKeyboard('keyboardWillChangeFrame', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();

    // The whole defect in one number: under `KeyboardAvoidingView` this was short
    // by the chrome above the surface.
    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT);
    screen.unmount();
  });

  it('drops the padding again when the keyboard hides', async () => {
    const screen = await mountChat();
    emitKeyboard('keyboardWillChangeFrame', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT);

    emitKeyboard('keyboardWillHide', HARNESS_SCREEN_HEIGHT, 0);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(0);
    screen.unmount();
  });

  it('tracks a keyboard that changes height (autocomplete bar, emoji switch)', async () => {
    const screen = await mountChat();
    emitKeyboard('keyboardWillChangeFrame', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(KEYBOARD_HEIGHT);

    const taller = 400;
    emitKeyboard('keyboardWillChangeFrame', HARNESS_SCREEN_HEIGHT - taller, taller);
    await screen.settle();
    expect(paddingBottom(screen)).toBe(taller);
    screen.unmount();
  });

  it('keeps the composer usable while the keyboard is up', async () => {
    // The composer must still be reachable and functional with the keyboard
    // showing — the state the owner is actually in when he types.
    const screen = await mountChat();
    emitKeyboard('keyboardWillChangeFrame', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();

    await screen.type('typed with the keyboard up');
    await screen.press('Send');

    const frames = FakeChatSocket.current().framesOfType('user_message');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.['body']).toBe('typed with the keyboard up');
    screen.unmount();
  });
});
