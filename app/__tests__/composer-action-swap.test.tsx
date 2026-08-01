/**
 * @neutronai/app — the composer's iMessage arrangement, and the action control
 * that SWAPS BY CONTENT inside the field.
 *
 * Two claims are pinned here, and they are the two a restyle keeps breaking.
 *
 * THE ARRANGEMENT. iMessage puts the send control INSIDE the text field at its
 * trailing edge, and exactly one app/plus control OUTSIDE it on the leading
 * side. The pass this replaces had the opposite shape — a large circular button
 * outside the field to the right, with a paperclip stuffed inside it — so
 * "inside vs outside" is not a detail here, it is the difference between the two
 * designs. It is a DOM-containment fact, not a pixel one, so it is testable.
 *
 * THE SWAP. One in-field slot holds a microphone while the field is empty and
 * the send arrow once there is something to send. That swap is the affordance,
 * and it is what separates "feels like iMessage" from "has the same parts
 * arranged differently".
 *
 * HONEST BOUNDARY. This asserts WHICH CONTROL IS MOUNTED and WHERE IT SITS IN
 * THE TREE, not how it looks. The harness fakes every layout rect, so geometry —
 * the pill's radius, the arrow's optical centring, the button staying pinned to
 * the last line as the field grows — is a DEVICE claim, settled with a
 * screenshot, and it is NOT settled here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import { installNativeHarness, resetHarnessGlobals, setHarnessPlatform } from './support/native-harness';

installNativeHarness();
setHarnessPlatform('android');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { harnessAudioState, resetHarnessAudio } = await import('./support/stubs/expo-audio');

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
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

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

describe('the composer is arranged the way iMessage is', () => {
  it('keeps the send control INSIDE the text field', async () => {
    // The whole point of the restyle. A send button that is a SIBLING of the
    // field rather than a DESCENDANT of it is the arrangement this replaced.
    const screen = await mountChat();

    await screen.type('hello');

    const field = screen.byTestId('composer-field');
    const arrow = screen.byTestId('composer-send-arrow');
    expect(field).not.toBeNull();
    expect(arrow).not.toBeNull();
    expect(field?.contains(arrow)).toBe(true);

    screen.unmount();
  });

  it('keeps the microphone INSIDE the field too — it shares the send slot', async () => {
    const screen = await mountChat();

    const field = screen.byTestId('composer-field');
    const mic = screen.byTestId('composer-voice');
    expect(field).not.toBeNull();
    expect(mic).not.toBeNull();
    expect(field?.contains(mic)).toBe(true);

    screen.unmount();
  });

  it('puts the one attachment control OUTSIDE the field, on the leading side', async () => {
    // iMessage's leading `+`. Outside the pill — and there is only ONE control
    // there, which is why the paperclip became this rather than joining it.
    const screen = await mountChat();

    const field = screen.byTestId('composer-field');
    const plus = screen.byTestId('composer-attach');
    expect(field).not.toBeNull();
    expect(plus).not.toBeNull();
    expect(field?.contains(plus)).toBe(false);

    screen.unmount();
  });
});

describe('the in-field action control swaps by content', () => {
  it('is the microphone while the field is empty', async () => {
    const screen = await mountChat();

    expect(screen.byTestId('composer-voice')).not.toBeNull();
    expect(screen.byTestId('composer-send-arrow')).toBeNull();

    screen.unmount();
  });

  it('becomes the send arrow as soon as there is something to send', async () => {
    const screen = await mountChat();

    await screen.type('hello');

    expect(screen.byTestId('composer-send-arrow')).not.toBeNull();
    expect(screen.byTestId('composer-voice')).toBeNull();

    screen.unmount();
  });

  it('goes back to the microphone once the draft is sent', async () => {
    const screen = await mountChat();

    await screen.type('hello');
    await screen.press('Send');
    await screen.settle();

    // The send cleared the draft, so the empty state — and the mic — is back.
    expect(screen.byTestId('composer-voice')).not.toBeNull();
    expect(screen.byTestId('composer-send-arrow')).toBeNull();

    screen.unmount();
  });

  it('has a real recorder behind the mic — no "not available yet" notice', async () => {
    // THE INVERSE OF WHAT THIS CASE USED TO ASSERT. It previously pinned the
    // composer's honesty while `ChatSyncSurface` passed no `onVoice*` handlers:
    // an unwired mic had to ADMIT it. The handlers are wired now, so the notice
    // appearing would mean the wiring had been lost again — which is precisely
    // the regression worth a test, since nothing else about the button changes.
    resetHarnessAudio();
    const screen = await mountChat();

    expect(screen.byTestId('composer-voice-notice')).toBeNull();
    await screen.press('Record voice message');
    await screen.settle();

    expect(screen.byTestId('composer-voice-notice')).toBeNull();
    expect(harnessAudioState().record_calls).toBe(1);

    screen.unmount();
  });

  it('still keeps the attachment control reachable', async () => {
    // It changed shape (paperclip inside the field → `+` outside it); it must
    // not have been lost on the way.
    const screen = await mountChat();

    expect(screen.byTestId('composer-attach')).not.toBeNull();

    screen.unmount();
  });
});
