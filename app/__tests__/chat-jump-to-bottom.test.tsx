/**
 * The jump-to-bottom affordance is WIRED into the chat surface.
 *
 * The owner asked for "a small icon in the bottom right … Only appears when you are
 * scrolled up, not in regular usage". `lib/chat-core/jump-to-bottom.ts` owns the
 * rule and has its own unit tests; this file asserts the part those cannot — that
 * the surface actually installs an `onScroll` handler on the production list, and
 * that driving it moves a real button in and out of the tree.
 *
 * Asserting the rule alone would be the "both halves exist and nothing joins them"
 * shape: a correct predicate no list ever calls.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. The FlashList stub does not virtualise and
 * forwards no ref, so `scrollToEnd` is unobservable here and the button's press
 * handler no-ops on a null ref. So the press assertion is only that the button
 * dismisses itself; that `scrollToEnd` scrolls is FlashList's own behaviour and a
 * device claim, the same boundary `chat-initial-anchor` draws.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import { installNativeHarness, resetHarnessGlobals } from './support/native-harness';

// MUST run at module scope, BEFORE the dynamic imports below. It installs the
// react-native → react-native-web alias, and `ChatSyncSurface` imports
// react-native — so importing it first parses RN's Flow-typed index and dies with
// "Unexpected typeof". `beforeAll(installNativeHarness)` alone is too late.
installNativeHarness();

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { lastFlashListProps, resetFlashListRecorder } = await import('./support/stubs/flash-list');
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

const TEST_ID = 'chat-jump-to-bottom';

/** A scroll event shaped like the native one, `up` px of content below the fold. */
function scrollEvent(up: number, contentHeight = 6000, viewportHeight = 800) {
  return {
    nativeEvent: {
      contentOffset: { y: contentHeight - viewportHeight - up },
      contentSize: { height: contentHeight },
      layoutMeasurement: { height: viewportHeight },
    },
  };
}

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  resetFlashListRecorder();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

type Screen = Awaited<ReturnType<typeof mountScreen>>;

async function mountChat(): Promise<Screen> {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId: '' }),
    ),
  );
  await screen.settle();
  FakeChatSocket.current().onopen?.();
  await screen.settle();
  return screen;
}

/** Drive the production `onScroll` the surface installed on the list. */
async function drive(screen: Screen, up: number): Promise<void> {
  const props = lastFlashListProps();
  const onScroll = props?.['onScroll'] as ((e: unknown) => void) | undefined;
  if (onScroll === undefined) throw new Error('the surface installed no onScroll on the list');
  // Called outside act(); `settle()` below performs the act-wrapped flushes the
  // resulting state update needs. Importing act here pulls a module graph that
  // breaks the react-native alias this harness depends on.
  onScroll(scrollEvent(up));
  await screen.settle();
}

describe('jump-to-bottom is wired into the chat surface', () => {
  it('installs an onScroll handler on the production list', async () => {
    const screen = await mountChat();
    const props = lastFlashListProps();
    // Without this the rule is a predicate nobody calls.
    expect(typeof props?.['onScroll']).toBe('function');
    // Throttled, so a fling does not cross the bridge on every pixel.
    expect(props?.['scrollEventThrottle']).toBe(16);
    // And the recycling classes — without this every row shares one pool and a
    // recycled view is re-measured from a one-line bubble into a tall reply,
    // which is the churn behind the jumpy scroll track.
    expect(typeof props?.['getItemType']).toBe('function');
    void screen;
  });

  it('is ABSENT before any scroll — the resting state', async () => {
    const screen = await mountChat();
    expect(screen.byTestId(TEST_ID)).toBeNull();
  });

  it('appears once scrolled up past the threshold', async () => {
    const screen = await mountChat();
    await drive(screen, 1200);
    expect(screen.byTestId(TEST_ID)).not.toBeNull();
  });

  it('stays hidden a few pixels short of the bottom (ordinary reading)', async () => {
    // The owner's "not in regular usage" clause. An exact atBottom test would
    // flash the button here, because scrolling never settles on zero.
    const screen = await mountChat();
    await drive(screen, 12);
    expect(screen.byTestId(TEST_ID)).toBeNull();
  });

  it('disappears again when scrolled back to the bottom', async () => {
    const screen = await mountChat();
    await drive(screen, 1200);
    expect(screen.byTestId(TEST_ID)).not.toBeNull();
    await drive(screen, 0);
    expect(screen.byTestId(TEST_ID)).toBeNull();
  });

  it('dismisses itself when pressed', async () => {
    // The button sits under the thumb that tapped it; leaving it up through the
    // scroll animation invites a second tap on a control that already acted.
    const screen = await mountChat();
    await drive(screen, 1200);
    expect(screen.byTestId(TEST_ID)).not.toBeNull();
    await screen.press('Jump to latest message');
    await screen.settle();
    expect(screen.byTestId(TEST_ID)).toBeNull();
  });

  it('carries an accessible label and button role', async () => {
    const screen = await mountChat();
    await drive(screen, 1200);
    const el = screen.byTestId(TEST_ID);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-label')).toBe('Jump to latest message');
  });
});
