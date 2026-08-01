/**
 * @neutronai/app — THE COMPOSER MUST NOT BE INSIDE THE RAIL'S COLUMN.
 *
 * Owner, 2026-07-31: *"would it be possible to have the text entry box take the
 * full width of the screen instead of being shortened by the project rail?"* The
 * composer was the last child of the chat surface, and the shell renders that
 * surface in the column to the RIGHT of the 72pt project rail, so the input was
 * inset by the rail while the transcript above it was not.
 *
 * WHAT THIS FILE CAN PROVE, and it is a placement claim rather than a pixel one:
 * that the composer renders OUTSIDE the column the rail constrains, and inside
 * the shell's full-width bottom band. Under the harness that is a containment
 * question about real DOM nodes produced by the real component tree — which is
 * exactly the thing a negative-margin "fix" would fail, because it would leave
 * the composer a descendant of the column.
 *
 * WHAT IT CANNOT PROVE. Width in pixels. The harness reports every element as the
 * same faked rect (`native-harness.ts` `installLayoutMetrics`), so "the bar is
 * 393pt wide and starts at x=0" is a DEVICE claim, settled with a screenshot and
 * `uiautomator` bounds, not here.
 *
 * The keyboard case is here for a different reason: moving the composer moved the
 * measured container with it, and the lift has already regressed twice. The
 * arithmetic is pinned in `chat-keyboard-avoidance{,-android}.test.tsx`; what is
 * pinned HERE is that the node the padding lands on is the one now living in the
 * band — a lift applied to a container the composer no longer sits in would pass
 * those files and still bury the input.
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
const { View, emitKeyboard } = await import('./support/stubs/react-native');
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

/** The rail's width in the shell — the strip the composer used to give up. */
const RAIL_WIDTH = 72;
const KEYBOARD_HEIGHT = 336;
const KEYBOARD_TOP = HARNESS_SCREEN_HEIGHT - KEYBOARD_HEIGHT;

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
  setHarnessSafeAreaInsets({ top: 24, bottom: 0 });
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

/**
 * The shell's mobile arrangement, reduced to the part that constrains width: a
 * row of [rail | main column], with the chat surface inside the column. The
 * harness supplies the shell's other half — the full-width band BELOW this row —
 * around everything it mounts (`support/mount.tsx`).
 */
async function mountShellRow() {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(
        View,
        { style: { flexDirection: 'row', flex: 1 }, testID: 'shell-rail-row' },
        createElement(View, { style: { width: RAIL_WIDTH }, testID: 'shell-rail' }),
        createElement(
          View,
          { style: { flex: 1 }, testID: 'shell-rail-main' },
          createElement(ChatSyncSurface, { projectId: 'harness-project' }),
        ),
      ),
    ),
  );
  FakeChatSocket.current().onopen?.();
  await screen.settle();
  return screen;
}

function required(node: HTMLElement | null, id: string): HTMLElement {
  if (node === null) throw new Error(`"${id}" is not in the tree`);
  return node;
}

describe('the composer spans the viewport, not the rail-constrained column', () => {
  it('renders the composer bar OUTSIDE the column the rail narrows', async () => {
    const screen = await mountShellRow();

    const bar = required(screen.byTestId('composer-bar'), 'composer-bar');
    const column = required(screen.byTestId('shell-rail-main'), 'shell-rail-main');
    const row = required(screen.byTestId('shell-rail-row'), 'shell-rail-row');

    // The whole defect, as a containment question: while the bar was a
    // descendant of the column, the rail's 72pt came out of its width and no
    // styling on the bar itself could give it back.
    expect(column.contains(bar)).toBe(false);
    expect(row.contains(bar)).toBe(false);

    screen.unmount();
  });

  it('renders it inside the shell band, which is a SIBLING of the rail row', async () => {
    const screen = await mountShellRow();

    const bar = required(screen.byTestId('composer-bar'), 'composer-bar');
    const dock = required(screen.byTestId('composer-dock'), 'composer-dock');
    const row = required(screen.byTestId('shell-rail-row'), 'shell-rail-row');

    expect(dock.contains(bar)).toBe(true);
    // A band nested in the row would be constrained all over again.
    expect(row.contains(dock)).toBe(false);

    screen.unmount();
  });

  it('keeps the text field and the send control reachable from the band', async () => {
    // Placement is only worth anything if the controls still work from there:
    // the composer is now mounted in a part of the tree the chat surface does
    // not own, so this presses the real button through the real handlers.
    const screen = await mountShellRow();

    await screen.type('sent from the docked composer');
    await screen.press('Send');

    const frames = FakeChatSocket.current().framesOfType('user_message');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.['body']).toBe('sent from the docked composer');

    screen.unmount();
  });

  it('lifts the DOCKED composer when the keyboard opens', async () => {
    const screen = await mountShellRow();
    const dock = required(screen.byTestId('composer-dock'), 'composer-dock');

    emitKeyboard('keyboardDidShow', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();

    const inset = required(screen.byTestId('chat-keyboard-inset'), 'chat-keyboard-inset');
    // The padded node has to be the one in the band. Padding a container the
    // composer no longer lives in lifts empty space and buries the input.
    expect(dock.contains(inset)).toBe(true);
    expect(Number.parseFloat(inset.style.paddingBottom)).toBe(KEYBOARD_HEIGHT);

    emitKeyboard('keyboardDidHide', HARNESS_SCREEN_HEIGHT, 0);
    await screen.settle();
    expect(inset.style.paddingBottom === '' ? 0 : Number.parseFloat(inset.style.paddingBottom)).toBe(
      0,
    );

    screen.unmount();
  });

  it('draws nothing when the screen has no composer to publish', async () => {
    // The band is shell chrome: it is mounted under every tab, and a Documents or
    // Tasks screen must not pay a bar — or a strip of background — for it.
    const screen = await mountScreen(
      createElement(
        AuthSessionProvider,
        { initialUser: OWNER },
        createElement(View, { testID: 'shell-rail-row' }),
      ),
    );

    const dock = required(screen.byTestId('composer-dock'), 'composer-dock');
    expect(dock.childElementCount).toBe(0);
    expect(screen.byTestId('composer-bar')).toBeNull();

    screen.unmount();
  });
});
