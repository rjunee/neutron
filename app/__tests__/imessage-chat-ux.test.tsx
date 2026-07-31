/**
 * @neutronai/app — THE four iMessage defects Ryan reported three times.
 *
 * *"Please just make the UX of the chat screen look EXACTLY the same as
 * imessage"* … *"match behavior and also the UX, accounting for the rail and tab
 * bar (that just makes the chat window a bit smaller, but everything else should
 * look the same)."* Four things he named, each with a test below:
 *
 *   1. the composer and send button are not fully visible;
 *   2. too much padding at the bottom of each message bubble;
 *   3. the inspector's ✕ is too close to the top of the screen to tap;
 *   4. "Waking up…" renders as a real chat message.
 *
 * HONEST BOUNDARY, stated once so it is not restated per test. This harness runs
 * the real component tree under react-native-web with a FAKED layout rect and a
 * FAKED safe area (`support/native-harness.ts`, `support/stubs/safe-area-
 * context.ts`). It proves the WIRING and the ARITHMETIC — that the surface reads
 * the safe area at all, that the gap it applies is a function of the sender, that
 * a `system_notice` frame never reaches the transcript. It cannot see a real iOS
 * keyboard, a native layout pass, or a pixel. Anything about how it LOOKS on a
 * phone remains a device claim.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HARNESS_SCREEN_HEIGHT,
  installNativeHarness,
  resetHarnessGlobals,
  setHarnessPlatform,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { emitKeyboard } = await import('./support/stubs/react-native');
const {
  HARNESS_SAFE_AREA_BOTTOM,
  HARNESS_SAFE_AREA_TOP,
  resetHarnessSafeAreaInsets,
  setHarnessSafeAreaInsets,
} = await import('./support/stubs/safe-area-context');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import(
  '../lib/chat-core/op-sqlite-store'
);
const { ActivityInspectorDrawer, MIN_TAP_TARGET_PT } = await import(
  '../components/ActivityInspectorDrawer'
);
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const {
  BUBBLE_GAP_SAME_SENDER_PT,
  BUBBLE_GAP_SENDER_CHANGE_PT,
  BUBBLE_PADDING_V_PT,
  bubbleGapPt,
  bubbleHasTail,
} = await import('../lib/chat-bubble-metrics');
const { COMPOSER_BOTTOM_PADDING_PT, composerBottomInset } = await import('../lib/keyboard-inset');

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const PROJECT = 'harness-project';
const KEYBOARD_HEIGHT = 336;
const KEYBOARD_TOP = HARNESS_SCREEN_HEIGHT - KEYBOARD_HEIGHT;
const COLD_START_ACK = '⏳ Waking up, one moment...';

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  // The durable store is DEVICE-wide (`sharedMobileStore`), and bun shares one
  // process across test files — a suite that mounts chat has to say it wants a
  // clean transcript, or it inherits the previous test's (or file's) rows.
  __resetSharedMobileStoreForTests();
  resetHarnessSafeAreaInsets();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  clearSessionCache();
  resetHarnessSafeAreaInsets();
  __resetServerConfigForTests();
});

// Bun evaluates every test file's top level before running any test, so the
// top-level arm above can be undone by a sibling harness file's `afterAll`.
beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

type Screen = Awaited<ReturnType<typeof mountScreen>>;

async function mountChat(
  projectId: string = PROJECT,
): Promise<{ screen: Screen; socket: InstanceType<typeof FakeChatSocket> }> {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId }),
    ),
  );
  const socket = FakeChatSocket.current();
  await screen.settle();
  socket.onopen?.();
  await screen.settle();
  return { screen, socket };
}

/** Push a server frame down the socket exactly as the transport receives it. */
async function deliver(
  screen: Screen,
  socket: InstanceType<typeof FakeChatSocket>,
  frame: Record<string, unknown>,
): Promise<void> {
  socket.onmessage?.({ data: JSON.stringify(frame) });
  await screen.settle();
}

let seq = 0;
function durableMessage(
  type: 'user_message' | 'agent_message',
  body: string,
): Record<string, unknown> {
  seq += 1;
  return {
    v: 1,
    type,
    message_id: `${type}-${seq}`,
    seq,
    ts: 1_700_000_000_000 + seq,
    body,
    project_id: PROJECT,
  };
}

/** The inline `margin-top` of every bubble row, top to bottom, in px. */
function rowGaps(screen: Screen): number[] {
  return Array.from(
    screen.host.querySelectorAll('[data-testid="chat-bubble-row"]'),
  ).map((el) => {
    const raw = (el as HTMLElement).style.marginTop;
    return raw === '' ? 0 : Number.parseFloat(raw);
  });
}

/** The composer bar's applied bottom padding, in px. */
function composerPaddingBottom(screen: Screen): number {
  const node = screen.byTestId('composer-bar');
  if (node === null) throw new Error('the composer bar is not in the tree');
  const raw = node.style.paddingBottom;
  return raw === '' ? 0 : Number.parseFloat(raw);
}

/* ══ DEFECT 1 — the composer and send button are not fully visible ══════════ */

describe('defect 1 — the composer clears BOTH the keyboard and the home indicator', () => {
  it('adds the home-indicator inset while the keyboard is down', () => {
    // The half nothing covered before: with no keyboard, the surface runs to the
    // physical bottom of the screen (the shell applies no bottom inset anywhere),
    // so a fixed 16pt of composer padding put the send button under a 34pt home
    // indicator.
    expect(composerBottomInset({ keyboardInset: 0, safeAreaBottom: 34 })).toBe(
      COMPOSER_BOTTOM_PADDING_PT + 34,
    );
  });

  it('does NOT add it again while the keyboard is up (no double-offset)', () => {
    // The keyboard covers the home indicator and the surface is already lifted by
    // the full overlap. Adding the safe area on top parks the bar on a dead band.
    expect(composerBottomInset({ keyboardInset: KEYBOARD_HEIGHT, safeAreaBottom: 34 })).toBe(
      COMPOSER_BOTTOM_PADDING_PT,
    );
  });

  it('is inert on a device with no bottom inset', () => {
    expect(composerBottomInset({ keyboardInset: 0, safeAreaBottom: 0 })).toBe(
      COMPOSER_BOTTOM_PADDING_PT,
    );
  });

  it('the mounted surface actually READS the safe area (keyboard down)', async () => {
    const { screen } = await mountChat();
    // Not "some padding" — the padding must be at least the home indicator, which
    // is what a hard-coded constant can never be.
    expect(composerPaddingBottom(screen)).toBeGreaterThanOrEqual(HARNESS_SAFE_AREA_BOTTOM);
    expect(composerPaddingBottom(screen)).toBe(
      COMPOSER_BOTTOM_PADDING_PT + HARNESS_SAFE_AREA_BOTTOM,
    );
    screen.unmount();
  });

  it('the mounted surface drops the inset when the keyboard comes up', async () => {
    const { screen } = await mountChat();
    emitKeyboard('keyboardWillChangeFrame', KEYBOARD_TOP, KEYBOARD_HEIGHT);
    await screen.settle();
    // Still lifted clear of the keyboard by the surface's own inset (that is
    // `chat-keyboard-avoidance.test.tsx`); the BAR itself must not also carry the
    // home indicator, or it floats.
    expect(composerPaddingBottom(screen)).toBe(COMPOSER_BOTTOM_PADDING_PT);
    expect(composerPaddingBottom(screen)).toBeLessThan(HARNESS_SAFE_AREA_BOTTOM);
    screen.unmount();
  });

  it('tracks a device with a larger bottom inset', async () => {
    setHarnessSafeAreaInsets({ bottom: 48 });
    const { screen } = await mountChat();
    expect(composerPaddingBottom(screen)).toBe(COMPOSER_BOTTOM_PADDING_PT + 48);
    screen.unmount();
  });
});

/* ══ DEFECT 2 — too much padding at the bottom of each message bubble ═══════ */

describe('defect 2 — iMessage bubble rhythm', () => {
  it('spaces a same-sender run tightly and breaks at a sender change', () => {
    expect(bubbleGapPt('user', 'user')).toBe(BUBBLE_GAP_SAME_SENDER_PT);
    expect(bubbleGapPt('agent', 'agent')).toBe(BUBBLE_GAP_SAME_SENDER_PT);
    expect(bubbleGapPt('user', 'agent')).toBe(BUBBLE_GAP_SENDER_CHANGE_PT);
    expect(bubbleGapPt('agent', 'user')).toBe(BUBBLE_GAP_SENDER_CHANGE_PT);
    // The first row has no leading gap — the list's own padding owns the top.
    expect(bubbleGapPt(null, 'agent')).toBe(0);
    // The break has to be several times the run gap or the two read the same.
    expect(BUBBLE_GAP_SENDER_CHANGE_PT).toBeGreaterThanOrEqual(BUBBLE_GAP_SAME_SENDER_PT * 3);
  });

  it('gives one tail per same-sender RUN, not one per bubble', () => {
    expect(bubbleHasTail('user', 'user')).toBe(false); // mid-run
    expect(bubbleHasTail('user', 'agent')).toBe(true); // end of run
    expect(bubbleHasTail('agent', null)).toBe(true); // newest row
  });

  it('keeps the bubble padding tighter than the old uniform 8pt box', () => {
    expect(BUBBLE_PADDING_V_PT).toBeLessThan(8);
  });

  it('applies those gaps to the REAL rendered rows', async () => {
    const { screen, socket } = await mountChat();
    await deliver(screen, socket, durableMessage('user_message', 'first'));
    await deliver(screen, socket, durableMessage('user_message', 'second'));
    await deliver(screen, socket, durableMessage('agent_message', 'reply'));
    await deliver(screen, socket, durableMessage('agent_message', 'and more'));

    // first(none) · same-sender · SENDER CHANGE · same-sender
    expect(rowGaps(screen)).toEqual([
      0,
      BUBBLE_GAP_SAME_SENDER_PT,
      BUBBLE_GAP_SENDER_CHANGE_PT,
      BUBBLE_GAP_SAME_SENDER_PT,
    ]);
    screen.unmount();
  });

  it('shows ONE delivery status for the whole thread, not a tick per bubble', async () => {
    // The delivery ladder used to render INSIDE every outgoing bubble — an extra
    // text row in every message's padded box, which is most of the bottom space
    // Ryan was pointing at. iMessage reports the newest outgoing message only.
    const { screen, socket } = await mountChat();
    await deliver(screen, socket, durableMessage('user_message', 'one'));
    await deliver(screen, socket, durableMessage('user_message', 'two'));
    await deliver(screen, socket, durableMessage('user_message', 'three'));

    const ticks = screen.host.querySelectorAll('[aria-label^="delivery: "]');
    expect(ticks).toHaveLength(1);
    screen.unmount();
  });
});

/* ══ DEFECT 3 — the inspector's ✕ is unreachable and the panel is cramped ═══ */

describe('defect 3 — the activity inspector is reachable and legible', () => {
  const INSPECTOR_SRC = readFileSync(
    join(import.meta.dir, '..', 'components', 'ActivityInspectorDrawer.tsx'),
    'utf8',
  );

  const inertSource = {
    snapshot: async () => ({ scope_key: 'general', state: 'idle' as const, events: [] }),
    subscribe: () => () => undefined,
  };

  async function mountInspector(): Promise<Screen> {
    return mountScreen(
      createElement(ActivityInspectorDrawer, {
        open: true,
        onClose: () => undefined,
        source: inertSource as never,
        projectId: null,
        label: 'General',
        reduceMotionOverride: true,
      }),
    );
  }

  it('pads the header by the REAL safe-area top, not a hard-coded 32pt', async () => {
    const screen = await mountInspector();
    const close = screen.byTestId('activity-drawer-close');
    expect(close).not.toBeNull();
    const header = close?.parentElement as HTMLElement | null;
    expect(header).not.toBeNull();
    const paddingTop = Number.parseFloat((header as HTMLElement).style.paddingTop || '0');
    // 32pt (the shipped value) is SHORTER than the notch on every modern iPhone,
    // which is exactly why the ✕ could not be tapped.
    expect(paddingTop).toBeGreaterThan(HARNESS_SAFE_AREA_TOP);
    screen.unmount();
  });

  it('follows a device with a different top inset', async () => {
    setHarnessSafeAreaInsets({ top: 20 }); // a notchless phone
    const screen = await mountInspector();
    const header = screen.byTestId('activity-drawer-close')?.parentElement as HTMLElement;
    expect(Number.parseFloat(header.style.paddingTop)).toBeGreaterThan(20);
    expect(Number.parseFloat(header.style.paddingTop)).toBeLessThan(HARNESS_SAFE_AREA_TOP);
    screen.unmount();
  });

  it('sizes the close button to the HIG minimum tap target', () => {
    // The rendered size comes from a `StyleSheet.create` class, which the DOM
    // harness cannot read back — so the invariant is pinned at the constant AND
    // at the style that must consume it (same technique as the bubble-width
    // suite's structural half).
    expect(MIN_TAP_TARGET_PT).toBeGreaterThanOrEqual(44);
    expect(INSPECTOR_SRC).toContain('width: MIN_TAP_TARGET_PT');
    expect(INSPECTOR_SRC).toContain('height: MIN_TAP_TARGET_PT');
  });

  it('has no 11pt text left in the row list', () => {
    // The event rows were 11pt monospace — under the smallest size in the type
    // scale, and unreadable at arm's length on a phone.
    expect(INSPECTOR_SRC).not.toMatch(/fontSize:\s*1[12]\b/);
  });
});

/* ══ DEFECT 4 — "Waking up…" renders as a real chat message ═════════════════ */

describe('defect 4 — the cold-start ack is a transient pill, never a message', () => {
  it('renders the ack as the system pill and NOT as a chat bubble', async () => {
    const { screen, socket } = await mountChat();
    await deliver(screen, socket, durableMessage('agent_message', 'a real earlier reply'));
    // A send opens a NEW turn — the previous turn's "reply started" latch must not
    // suppress this turn's ack (web parity: the controller re-arms on send).
    await screen.type('and now a cold one');
    await screen.press('Send');
    const bubblesBefore = rowGaps(screen).length;
    expect(bubblesBefore).toBe(2); // the earlier reply + the optimistic send

    // Exactly what the gateway emits: a live-only `agent_message` carrying
    // `system_notice: true` and NO `seq` (`build-live-agent-turn.ts`).
    await deliver(screen, socket, {
      v: 1,
      type: 'agent_message',
      message_id: 'wake-1',
      ts: 1_700_000_009_999,
      body: COLD_START_ACK,
      system_notice: true,
    });

    expect(screen.byTestId('chat-system-notice')).not.toBeNull();
    expect(screen.text()).toContain('Waking up');
    // THE defect: it must not have become a row in the transcript.
    expect(rowGaps(screen)).toHaveLength(bubblesBefore);
    screen.unmount();
  });

  it('clears the pill when the real reply starts streaming', async () => {
    const { screen, socket } = await mountChat();
    await deliver(screen, socket, {
      v: 1,
      type: 'agent_message',
      message_id: 'wake-2',
      ts: 1,
      body: COLD_START_ACK,
      system_notice: true,
    });
    expect(screen.byTestId('chat-system-notice')).not.toBeNull();

    await deliver(screen, socket, {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'stream-1',
      body_delta: 'Here is the answer',
      ts: 2,
      project_id: PROJECT,
    });

    expect(screen.byTestId('chat-system-notice')).toBeNull();
    // And it left NOTHING behind — a persisted ack would still be on screen.
    expect(screen.text()).not.toContain('Waking up');
    screen.unmount();
  });

  it('drops a LATE ack that lands after the reply has begun', async () => {
    // The gateway's ack is a delayed `setTimeout`, so on a slow-then-fast turn it
    // can arrive just after the answer. Re-arming then leaves a "Waking up…"
    // hanging BELOW the reply (web FIX #347).
    const { screen, socket } = await mountChat();
    await deliver(screen, socket, {
      v: 1,
      type: 'agent_message_partial',
      message_id: 'stream-2',
      body_delta: 'answer first',
      ts: 1,
      project_id: PROJECT,
    });
    await deliver(screen, socket, {
      v: 1,
      type: 'agent_message',
      message_id: 'wake-3',
      ts: 2,
      body: COLD_START_ACK,
      system_notice: true,
    });

    expect(screen.byTestId('chat-system-notice')).toBeNull();
    expect(screen.text()).not.toContain('Waking up');
    screen.unmount();
  });

  it('recognises the ack from its BODY when the server sends no flag', async () => {
    // Servers older than FIX #333 emit the ack with no `system_notice` field. The
    // web client has always matched the body; the shared predicate means the
    // native client now does too, instead of persisting it.
    const { screen, socket } = await mountChat();
    await deliver(screen, socket, {
      v: 1,
      type: 'agent_message',
      message_id: 'wake-4',
      ts: 1,
      body: COLD_START_ACK,
      project_id: PROJECT,
    });

    expect(screen.byTestId('chat-system-notice')).not.toBeNull();
    expect(rowGaps(screen)).toHaveLength(0);
    screen.unmount();
  });

  it('never becomes a durable row in the GENERAL scope either', async () => {
    // THE scope the defect is actually visible in. A project view filters the ack
    // out incidentally (it carries no `project_id`, so `matchesProject` rejects
    // it), which means a project-scoped assertion alone would keep passing even
    // if the row were still being written. General is where a persisted ack has
    // always been on screen — and it survives a reload, because it is in the
    // local store.
    const { screen, socket } = await mountChat('');
    await deliver(screen, socket, {
      v: 1,
      type: 'agent_message',
      message_id: 'wake-general',
      ts: 1,
      body: COLD_START_ACK,
      system_notice: true,
    });

    expect(screen.byTestId('chat-system-notice')).not.toBeNull();
    expect(rowGaps(screen)).toHaveLength(0);
    screen.unmount();
  });

  it('leaves an ORDINARY agent message alone', async () => {
    // The guard must not swallow real replies — the failure mode that would be
    // far worse than the bug it fixes. Asserted on the ROW, not on the body text:
    // an agent body renders through `RenderMarkdown`, which a sibling suite
    // replaces process-globally with a null-rendering stub
    // (`docs-panes-render.test.ts`), so a text assertion here would be
    // order-dependent. The user message below carries the text proof — a user
    // body renders as a plain `Text`.
    const { screen, socket } = await mountChat();
    await deliver(screen, socket, durableMessage('user_message', 'a question'));
    await deliver(screen, socket, durableMessage('agent_message', 'a completely normal reply'));

    expect(screen.byTestId('chat-system-notice')).toBeNull();
    expect(rowGaps(screen)).toHaveLength(2);
    expect(screen.text()).toContain('a question');
    screen.unmount();
  });
});
