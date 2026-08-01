/**
 * @neutronai/app — the composer's action button SWAPS BY CONTENT.
 *
 * The reference (WhatsApp on Android) keeps one circular control to the right of
 * the capsule and changes what it is: a microphone while the field is empty, a
 * send button once there is something to send. That swap is the affordance, and
 * it is the detail that separates "feels like the reference" from "has the same
 * parts arranged differently" — so it gets a test rather than a screenshot.
 *
 * HONEST BOUNDARY. This asserts WHICH CONTROL IS MOUNTED, not how it looks. The
 * harness fakes every layout rect, so geometry — capsule radius, the button's
 * alignment to the last line, optical centring of the glyph — is a DEVICE claim
 * settled with `uiautomator` bounds and screenshots, not here.
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

describe('composer action button', () => {
  it('is the microphone while the field is empty', async () => {
    const screen = await mountChat();

    expect(screen.byTestId('composer-voice')).not.toBeNull();
    expect(screen.byTestId('composer-send-plane')).toBeNull();

    screen.unmount();
  });

  it('becomes the send button as soon as there is something to send', async () => {
    const screen = await mountChat();

    await screen.type('hello');

    expect(screen.byTestId('composer-send-plane')).not.toBeNull();
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
    expect(screen.byTestId('composer-send-plane')).toBeNull();

    screen.unmount();
  });

  it('says so rather than pretending, when no recorder is wired behind the mic', async () => {
    // The recorder is a separate module and is not wired into the chat surface
    // yet. Until it is, pressing the mic has to ADMIT that — a control that
    // looks live and silently does nothing is the failure being avoided.
    const screen = await mountChat();

    expect(screen.byTestId('composer-voice-notice')).toBeNull();
    await screen.press('Record voice message');

    expect(screen.byTestId('composer-voice-notice')).not.toBeNull();

    screen.unmount();
  });

  it('still keeps the paperclip reachable inside the capsule', async () => {
    // The attachment control moved INSIDE the field in this change; it must not
    // have been lost on the way.
    const screen = await mountChat();

    expect(screen.byTestId('composer-attach')).not.toBeNull();

    screen.unmount();
  });
});
