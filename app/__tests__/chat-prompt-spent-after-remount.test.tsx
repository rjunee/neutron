/**
 * @neutronai/app — ISSUES #419: a REMOUNT must not resurrect a spent button.
 *
 * The reported symptom is a rendering lie, not a dispatch bug. #415 already
 * made a second tap inert server-side; what stayed broken is that the surface
 * kept DRAWING the Retry button as live. Its only guard was a session-scoped
 * `chosenByPrompt` `useState`, so the moment the component unmounted — a tab
 * switch, a project switch, a navigation, a fast-refresh — the guard was gone
 * and a tappable Retry came back on an already-answered prompt. A reply row's
 * TTL is ten years, so it never ages out; the owner taps and nothing happens.
 *
 * So the test that matters here is the one that UNMOUNTS AND REMOUNTS. A test
 * that only presses once and checks the row collapsed proves nothing about this
 * defect: the collapse it observes IS the session-local state the bug is about.
 *
 * WHAT THIS FILE PROVES, and what it does not. It mounts the REAL
 * `ChatSyncSurface` over the REAL `MobileChatSession` + chat-core sync engine,
 * presses through the SAME accessibility affordance a thumb uses, and remounts
 * the whole tree — the warm session cache keeps the durable local store alive
 * across the remount, exactly as it does on device. It delivers the
 * `prompt_resolved` frame down the socket; that the GATEWAY actually produces
 * that frame, with those exact fields, is proven separately and end-to-end in
 * `gateway/__tests__/app-ws-prompt-spent-server-state.test.ts` against a real
 * server. Nothing about how it LOOKS on a phone is claimed — this harness has
 * no device, no native layout pass, and no pixels.
 *
 * GENERAL SCOPE, deliberately: `projectId: ''`. The reported Retry bubbles
 * lived in the General transcript, and #415 learned that a project-scoped test
 * can let a mutation survive because the view filtered the row out for an
 * unrelated reason.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';

import { installNativeHarness, resetHarnessGlobals } from './support/native-harness';

installNativeHarness();

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

/** The production Retry affordance, verbatim (`build-live-agent-turn.ts`). */
const RETRY_TURN_VALUE = '__retry_turn__';
const RETRY_LABEL = 'Retry';
const TIMEOUT_BODY = 'That one took too long.';
const PROMPT_ID = 'prompt-419';
const MESSAGE_ID = 'agent-419';

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  clearSessionCache();
  __resetServerConfigForTests();
});

// Bun evaluates every test file's top level before running any test, so the
// top-level arm above can be undone by a sibling harness file's `afterAll`.
beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

type Screen = Awaited<ReturnType<typeof mountScreen>>;

/** Mount the General chat transcript and open its socket. */
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

/** Push a server frame down the socket exactly as the transport receives it. */
async function deliver(screen: Screen, frame: Record<string, unknown>): Promise<void> {
  FakeChatSocket.current().onmessage?.({ data: JSON.stringify(frame) });
  await screen.settle();
}

/** The "that one took too long / tap Retry" bubble, in its wire shape. */
function retryBubble(): Record<string, unknown> {
  return {
    v: 1,
    type: 'agent_message',
    message_id: MESSAGE_ID,
    seq: 1,
    ts: 1_700_000_000_000,
    body: TIMEOUT_BODY,
    prompt_id: PROMPT_ID,
    allow_freeform: true,
    options: [{ label: RETRY_LABEL, body: RETRY_LABEL, value: RETRY_TURN_VALUE }],
  };
}

/**
 * The frame the gateway fans the instant it claims the tap. Field-for-field the
 * shape asserted against a real server in
 * `gateway/__tests__/app-ws-prompt-spent-server-state.test.ts`.
 */
function promptResolved(): Record<string, unknown> {
  return {
    v: 1,
    type: 'prompt_resolved',
    message_id: MESSAGE_ID,
    prompt_id: PROMPT_ID,
    chosen_value: RETRY_TURN_VALUE,
    seq: 1,
    ts: 1_700_000_000_001,
  };
}

/** Is a live, pressable Retry button on screen right now? */
function retryButtonIsLive(screen: Screen): boolean {
  return Array.from(screen.host.querySelectorAll('*')).some(
    (el) =>
      el.getAttribute('aria-label') === RETRY_LABEL &&
      el.getAttribute('aria-disabled') !== 'true',
  );
}

/** Every `button_choice` frame the client actually put on the wire. */
function choiceFrames(): Array<Record<string, unknown>> {
  return FakeChatSocket.current().framesOfType('button_choice');
}

describe('ISSUES #419 — an answered Retry stays answered across a remount', () => {
  it('is drawn LIVE while the prompt is genuinely unanswered', async () => {
    const screen = await mountChat();
    await deliver(screen, retryBubble());
    expect(screen.text()).toContain(TIMEOUT_BODY);
    expect(retryButtonIsLive(screen)).toBe(true);
    screen.unmount();
  });

  it('a REMOUNT after the server records the answer draws it SPENT', async () => {
    const first = await mountChat();
    await deliver(first, retryBubble());
    expect(retryButtonIsLive(first)).toBe(true);

    // The owner taps Retry. The tap reaches the wire, and the row collapses.
    await first.press(RETRY_LABEL);
    expect(choiceFrames()).toContainEqual({
      v: 1,
      type: 'button_choice',
      prompt_id: PROMPT_ID,
      choice_value: RETRY_TURN_VALUE,
    });
    expect(retryButtonIsLive(first)).toBe(false);

    // The server claims the tap and says so.
    await deliver(first, promptResolved());

    // THE REMOUNT. The component and its `chosenByPrompt` are gone; the warm
    // session and its durable local store are not. This is the exact state in
    // which the old surface redrew a live Retry on an answered prompt.
    first.unmount();
    const second = await mountChat();
    await second.settle();

    expect(second.text()).toContain(TIMEOUT_BODY);
    expect(retryButtonIsLive(second)).toBe(false);
    // It reads as answered, not merely absent.
    expect(second.text()).toContain(`→ ${RETRY_LABEL}`);
    second.unmount();
  });

  it('CONTROL — session-local memory alone does NOT survive the remount', async () => {
    // This is the defect, reproduced: tap, then remount WITHOUT the server's
    // record. The optimistic state is the only thing that collapsed the row, and
    // a remount discards it — so the button comes back live. It is here so the
    // test above cannot pass for some unrelated reason: the server's record is
    // load-bearing, and this proves it by removing it.
    const first = await mountChat();
    await deliver(first, retryBubble());
    await first.press(RETRY_LABEL);
    expect(retryButtonIsLive(first)).toBe(false);

    first.unmount();
    const second = await mountChat();
    await second.settle();

    expect(second.text()).toContain(TIMEOUT_BODY);
    expect(retryButtonIsLive(second)).toBe(true);
    second.unmount();
  });

  it('a COLD OPEN whose replay carries the answer draws it SPENT', async () => {
    // A reinstall / second device: nothing local, and no live `prompt_resolved`
    // to catch — the only carrier of the answer is the replayed message itself.
    const screen = await mountChat();
    await deliver(screen, { ...retryBubble(), chosen_value: RETRY_TURN_VALUE });
    expect(screen.text()).toContain(TIMEOUT_BODY);
    expect(retryButtonIsLive(screen)).toBe(false);
    expect(screen.text()).toContain(`→ ${RETRY_LABEL}`);
    screen.unmount();
  });
});
