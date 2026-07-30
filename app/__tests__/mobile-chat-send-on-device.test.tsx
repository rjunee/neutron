/**
 * @neutronai/app — THE regression that let mobile chat ship unusable.
 *
 * WHAT SHIPPED. Mobile chat passed unit tests, typecheck and lint, and had never
 * delivered one message from a phone. `SendQueue`'s default id generator called
 * `crypto.randomUUID()`; the device runtime has no `crypto` global (React Native
 * 0.81 installs none, and Expo SDK 54's WinterCG shim stops at `TextDecoder` /
 * `URL` / `structuredClone`), so `enqueue()` threw BEFORE writing the optimistic
 * row, and `use-mobile-chat`'s `void session?.send(...)` swallowed the rejection.
 * The owner got no bubble, no outbound frame, no server row and no log — an app
 * that looked like it was working. Production confirms it: every `client_msg_id`
 * in `app_chat_messages` is a browser UUID, and the mobile sessions appear only as
 * fallback-form `dev-<base36>` device ids, which is itself proof that
 * `crypto.randomUUID` was undefined there.
 *
 * WHY THESE TESTS ARE SHAPED LIKE THIS. Every assertion below goes through the
 * REAL surface, the REAL composer, the REAL session and the REAL send queue, with
 * `globalThis.crypto` REMOVED — because Bun has WebCrypto and that single
 * difference is the entire reason the bug was invisible. The two things asserted
 * after a submit are precisely the two the owner lost:
 *   1. an outbound `user_message` frame on the socket, and
 *   2. a locally-visible bubble (mobile chat is local-first, SPEC § Decisions Log
 *      2026-07-27, so the bubble must not wait on a round-trip).
 *
 * WHAT THIS FILE CANNOT SEE: native layout, a real keyboard, gestures, Hermes
 * semantics, anything in the native binary. See `support/native-harness.ts`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
  withoutWebCrypto,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { SEND_FAILED_MESSAGE } = await import('../lib/chat-core/use-mobile-chat');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';

let restoreCrypto: (() => void) | null = null;

beforeEach(() => {
  // THE DEVICE RUNTIME. Not a detail — this is the condition under which the
  // shipped code failed and every other test in the repo passed.
  restoreCrypto = withoutWebCrypto();
  FakeChatSocket.install();
  clearSessionCache();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
});

afterEach(() => {
  restoreCrypto?.();
  restoreCrypto = null;
  clearSessionCache();
});

afterAll(() => {
  __resetServerConfigForTests();
  // Bun shares one process across ~100 test files: leaving the faked layout rect
  // or the WebSocket recorder installed lands them in whatever runs next.
  resetHarnessGlobals();
});

async function mountChat(projectId: string) {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId }),
    ),
  );
  // The transport only reaches `open` when the socket says so.
  const socket = FakeChatSocket.current();
  await screen.settle();
  socket.onopen?.();
  await screen.settle();
  return { screen, socket };
}

describe('mobile chat send, on a runtime without WebCrypto (i.e. the device)', () => {
  it('a composer submit puts a user_message on the wire', async () => {
    const { screen, socket } = await mountChat('harness-project');

    await screen.type('does this leave the phone?');
    await screen.press('Send');

    const frames = socket.framesOfType('user_message');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.['body']).toBe('does this leave the phone?');
    // The idempotency key must be a real value, not `undefined` — that field is
    // what makes an offline flush and a retry safe.
    expect(typeof frames[0]?.['client_msg_id']).toBe('string');
    expect((frames[0]?.['client_msg_id'] as string).length).toBeGreaterThan(0);
    expect(frames[0]?.['project_id']).toBe('harness-project');

    screen.unmount();
  });

  it('a composer submit shows the message locally, without waiting for the server', async () => {
    const { screen, socket } = await mountChat('harness-project');
    // No inbound echo is delivered in this test ON PURPOSE: the bubble is the
    // optimistic local row, and local-first means it does not depend on the
    // server having answered.
    await screen.type('local-first or nothing');
    await screen.press('Send');

    expect(screen.text()).toContain('local-first or nothing');
    expect(screen.text()).not.toContain('No messages yet');
    expect(socket.closed).toBe(false);

    screen.unmount();
  });

  it('sends from the General scope too (no project_id on the frame)', async () => {
    // General is the no-project scope; a send there must still be a real frame.
    const { screen, socket } = await mountChat('');

    await screen.type('general scope send');
    await screen.press('Send');

    const frames = socket.framesOfType('user_message');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.['body']).toBe('general scope send');
    expect(frames[0]?.['project_id']).toBeUndefined();

    screen.unmount();
  });

  it('clears the composer after a successful send', async () => {
    const { screen } = await mountChat('harness-project');
    await screen.type('sent and gone');
    await screen.press('Send');
    expect(screen.composer().value).toBe('');
    screen.unmount();
  });

  it('queues locally and flushes on connect when the socket opens LATE', async () => {
    // Offline-first: the bubble and the queue must not depend on the socket.
    const screen = await mountScreen(
      createElement(
        AuthSessionProvider,
        { initialUser: OWNER },
        createElement(ChatSyncSurface, { projectId: 'harness-project' }),
      ),
    );
    const socket = FakeChatSocket.current();

    await screen.type('typed before the socket opened');
    await screen.press('Send');

    // Nothing on the wire yet, but the owner can see it.
    expect(socket.framesOfType('user_message')).toHaveLength(0);
    expect(screen.text()).toContain('typed before the socket opened');

    // Connect, then hand over the server's session_ready — that is what drives
    // resume + flush.
    socket.onopen?.();
    await screen.settle();
    socket.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'session_ready',
        user_id: OWNER.id,
        topic_id: `app:${OWNER.id}:harness-project`,
        ts: Date.now(),
      }),
    });
    await screen.settle();

    expect(socket.framesOfType('user_message')).toHaveLength(1);
    screen.unmount();
  });

  it('keeps the typed text when the send could not be queued', async () => {
    // A dropped message must not ALSO destroy what the owner typed. The composer
    // clears on `onSend` resolving true, and that boolean used to be hardcoded.
    const { screen } = await mountChat('harness-project');
    const { sessionCacheKeys, peekSession } = await import('../lib/chat-core/session-cache');
    const session = peekSession(sessionCacheKeys()[0] ?? '');
    const store = (session as unknown as { store: { upsert: unknown } }).store;
    const realUpsert = store.upsert;
    store.upsert = () => Promise.reject(new Error('local store is unwritable'));

    await screen.type('do not eat my sentence');
    await screen.press('Send');

    expect(screen.composer().value).toBe('do not eat my sentence');

    store.upsert = realUpsert;
    screen.unmount();
  });

  it('never silently drops a send: a queue fault is reported to the owner', async () => {
    // The amplifier that made the root cause undiagnosable. Even with the id
    // generator fixed, ANY fault on the enqueue path must become visible rather
    // than vanishing into an unobserved promise rejection.
    const { screen } = await mountChat('harness-project');

    // Break the store the session writes through, from underneath the surface.
    const { sessionCacheKeys, peekSession } = await import('../lib/chat-core/session-cache');
    const session = peekSession(sessionCacheKeys()[0] ?? '');
    expect(session).not.toBeNull();
    const store = (session as unknown as { store: { upsert: unknown } }).store;
    const realUpsert = store.upsert;
    store.upsert = () => Promise.reject(new Error('local store is unwritable'));

    await screen.type('this one cannot be queued');
    await screen.press('Send');

    expect(screen.text()).toContain(SEND_FAILED_MESSAGE);

    store.upsert = realUpsert;
    screen.unmount();
  });
});
