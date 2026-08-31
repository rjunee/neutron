/**
 * @neutronai/app — the FIRST tap is eaten while the keyboard is open.
 *
 * Reported: *"tapping an icon closes the keyboard but doesn't register the actual
 * tap; I have to tap a second time"*.
 *
 * ROOT CAUSE. React Native defaults every scrollable to
 * `keyboardShouldPersistTaps="never"`, so with the keyboard up the first touch
 * outside the input is consumed by the keyboard dismissal and never reaches the
 * `Pressable` underneath. The fix is `"handled"` — NOT `"always"`, which would
 * also stop a tap on empty space from dismissing the keyboard at all.
 *
 * HONEST BOUNDARY, stated once. This test pins the ASK: the prop the chat surface
 * hands FlashList. That the prop then reaches the inner ScrollView is FlashList's
 * own behaviour (`dist/recyclerview/RecyclerView.js:357` spreads the rest props
 * onto its CompatScrollView), and whether a first tap is actually DELIVERED with a
 * real keyboard on screen is a DEVICE claim this suite cannot make — nothing here
 * exercises native touch delivery.
 *
 * The sibling edits on `ProjectRail` and `ProjectTabBar` are deliberately NOT
 * asserted here: the harness resolves `ScrollView` to react-native-web, which
 * swallows `keyboardShouldPersistTaps` without emitting a DOM attribute, so there
 * is nothing observable to assert. Those two sites are pinned at SOURCE level by
 * the `scripts/ci/keyboard-taps-check.mjs` lint gate instead.
 *
 * GENERAL SCOPE (`projectId: ''`) for the mount, matching
 * `chat-opens-at-the-bottom.test.tsx`, which is the working mount of this surface.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import { installNativeHarness, resetHarnessGlobals } from './support/native-harness';

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

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  // The durable store is DEVICE-wide and bun shares one process across test
  // files, so a suite that mounts chat has to say it wants a clean transcript.
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

async function deliver(screen: Screen, frame: Record<string, unknown>): Promise<void> {
  FakeChatSocket.current().onmessage?.({ data: JSON.stringify(frame) });
  await screen.settle();
}

function agentMessageFrame(message_id: string, seq: number, body: string): Record<string, unknown> {
  return { v: 1, type: 'agent_message', message_id, seq, ts: 1_700_000_000_000 + seq, body };
}

describe('the transcript keeps taps alive while the keyboard is open', () => {
  it('hands FlashList keyboardShouldPersistTaps="handled"', async () => {
    const screen = await mountChat();
    await deliver(screen, agentMessageFrame('m1', 1, 'first reply'));
    await deliver(screen, agentMessageFrame('m2', 2, 'second reply'));
    await screen.settle();

    const props = lastFlashListProps();
    expect(props).not.toBeNull();
    // "handled": a tap that lands on a child goes to the child; a tap on empty
    // space still dismisses the keyboard. "always" would break the second half.
    expect(props?.keyboardShouldPersistTaps).toBe('handled');
    screen.unmount();
  });
});
