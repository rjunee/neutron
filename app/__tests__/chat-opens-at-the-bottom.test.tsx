/**
 * @neutronai/app — ISSUES #505: a project must OPEN at the bottom, not part-way
 * up the last message.
 *
 * Reported verbatim: *"when I switched to a project it scrolls to the TOP of the
 * last message in the chat, rather than the very bottom. This is a mistake with
 * large messages that are larger than one screen. Should show the BOTTOM. It
 * should only scroll to the top of a message when it's unread (ie show all unread
 * messages). When everything is read it should be positioned at the bottom by
 * default."*
 *
 * So the rule under test is a FUNCTION OF READ STATE, and the naive fix — always
 * scroll to the bottom — trades his rule for a simpler wrong one. The regression
 * arm below exists to catch exactly that: it fails if the unread anchor is lost.
 *
 * HONEST BOUNDARY, stated once. `support/stubs/flash-list.tsx` does not
 * virtualise and has no scroll offset, so "the resting position is the content
 * bottom" is not observable here as a pixel. What IS observable, and what these
 * tests assert, is the position the surface ASKS the list for. The step from that
 * ask to a pixel is FlashList's own documented behaviour, cited line-by-line from
 * its source in `lib/chat-core/chat-initial-anchor.ts` (and from React Native's
 * for the offset clamp). Anything about how it LOOKS on a phone stays a device
 * claim.
 *
 * GENERAL SCOPE (`projectId: ''`) for the mounted arms, matching
 * `chat-prompt-spent-after-remount.test.tsx`: a project-scoped mount can let a
 * mutation survive because the view filtered a row out for an unrelated reason.
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
const {
  CHAT_BOTTOM_ANCHOR_OVERSCROLL_PT,
  anchorScrollProps,
  chatInitialAnchor,
  receiptEligibleMessageId,
} = await import('../lib/chat-core/chat-initial-anchor');

type RenderRow = import('../lib/chat-core/chat-render-model').RenderRow;
type ChatMessage = import('@neutronai/chat-core').ChatMessage;

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};

const THIS_DEVICE = 'dev-this-phone';
const OTHER_DEVICE = 'dev-some-other-phone';

// ─────────────────────────── row builders (pure arms) ───────────────────────────

function agentRow(id: string, read_by: readonly string[] | null): RenderRow {
  const message: ChatMessage = {
    topic_id: 'app:harness-owner',
    client_msg_id: `c-${id}`,
    message_id: id,
    seq: Number(id.replace(/\D/g, '')) || 1,
    role: 'agent',
    body: `agent ${id}`,
    project_id: null,
    attachments: null,
    created_at: 1_700_000_000_000,
    status: 'acked',
    read_by,
  };
  return { kind: 'message', key: `c-${id}`, message };
}

function userRow(id: string): RenderRow {
  const message: ChatMessage = {
    topic_id: 'app:harness-owner',
    client_msg_id: `c-${id}`,
    message_id: id,
    seq: 99,
    role: 'user',
    body: `owner ${id}`,
    project_id: null,
    attachments: null,
    created_at: 1_700_000_000_000,
    status: 'acked',
    read_by: null,
  };
  return { kind: 'message', key: `c-${id}`, message };
}

// ───────────────────────────── mounted-arm plumbing ─────────────────────────────

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

/**
 * THIS device's id, taken from the socket the surface actually opened.
 *
 * It is minted per mount (`use-mobile-chat.ts:151-153`), so a test cannot know it
 * in advance — but it is the same id the gateway attributes receipts to, because
 * the gateway reads it off this very URL (`ws-url.ts:44-56`). Taking it from here
 * is what makes the receipts below the ones a real server would send back.
 */
function deviceIdOnTheWire(): string {
  const url = new URL(FakeChatSocket.current().url.replace(/^ws/, 'http'));
  const id = url.searchParams.get('device_id');
  if (id === null || id.length === 0) throw new Error('the socket carried no device_id');
  return id;
}

function agentMessageFrame(message_id: string, seq: number, body: string): Record<string, unknown> {
  return {
    v: 1,
    type: 'agent_message',
    message_id,
    seq,
    ts: 1_700_000_000_000 + seq,
    body,
  };
}

/** The frame the gateway fans once it has recorded a read (`sync-engine.ts:116-127`). */
function receiptUpdateFrame(message_id: string, read_by: readonly string[]): Record<string, unknown> {
  return { v: 1, type: 'receipt_update', message_id, seq: null, delivered_by: read_by, read_by };
}

function recordedAnchor(): { index: unknown; viewOffset: unknown } {
  const props = lastFlashListProps();
  if (props === null) throw new Error('FlashList never rendered');
  const params = props['initialScrollIndexParams'] as { viewOffset?: number } | undefined;
  return { index: props['initialScrollIndex'], viewOffset: params?.viewOffset };
}

/** How many rows the list was handed, so "the last one" is not hard-coded. */
function recordedRowCount(): number {
  const props = lastFlashListProps();
  if (props === null) throw new Error('FlashList never rendered');
  return (props['data'] as readonly unknown[] | null)?.length ?? 0;
}

// ───────────────────────────────── the rule ─────────────────────────────────

describe('ISSUES #505 — the opening anchor is a function of read state', () => {
  it('ALL READ → the BOTTOM, and the bottom means the CONTENT bottom', () => {
    // The reported bug: everything read, and the last message is the tall one.
    const rows = [
      agentRow('a1', [THIS_DEVICE]),
      userRow('u1'),
      agentRow('a2', [THIS_DEVICE]),
    ];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'bottom' });

    // "Scroll to the last item" and "scroll to the bottom of the content" are the
    // same thing only when the last item fits on screen — the difference IS the
    // defect. So a bottom anchor must carry the overscroll that reaches past the
    // last row's top edge; an index alone would reproduce the bug.
    const props = anchorScrollProps({ kind: 'bottom' }, rows.length);
    expect(props.initialScrollIndex).toBe(rows.length - 1);
    expect(props.initialScrollIndexParams?.viewOffset).toBe(CHAT_BOTTOM_ANCHOR_OVERSCROLL_PT);
    expect(CHAT_BOTTOM_ANCHOR_OVERSCROLL_PT).toBeGreaterThan(0);
  });

  it('ALL READ + a SHORT last message → still the bottom', () => {
    // Proves the rule is not height-dependent in the wrong direction. Height is
    // never an input to the anchor at all, which is the point: the fix is not
    // "detect a tall message", it is "aim at the content bottom".
    const rows = [agentRow('a1', [THIS_DEVICE]), agentRow('a2', [THIS_DEVICE])];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'bottom' });
    expect(anchorScrollProps(chatInitialAnchor(rows, THIS_DEVICE), rows.length)).toEqual({
      initialScrollIndex: 1,
      initialScrollIndexParams: { viewOffset: CHAT_BOTTOM_ANCHOR_OVERSCROLL_PT },
    });
  });

  it('UNREAD EXIST → the TOP of the FIRST unread, with NO overscroll', () => {
    // THE REGRESSION ARM. "Always scroll to the bottom" passes both tests above
    // and fails this one, which is the trade the owner explicitly ruled out.
    const rows = [
      agentRow('a1', [THIS_DEVICE]),
      agentRow('a2', [THIS_DEVICE]),
      agentRow('a3', null), // ← first unread
      agentRow('a4', null),
    ];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'unread', index: 2 });
    // No overscroll: the top of a row IS its layout offset, so an offset here
    // would push the unread run's first line back off the top of the screen.
    expect(anchorScrollProps({ kind: 'unread', index: 2 }, rows.length)).toEqual({
      initialScrollIndex: 2,
    });
  });

  it('a RECEIPT GAP in old history does NOT drag the anchor back to it (ISSUES #511)', () => {
    // RYAN, 2026-08-07: "switching to general on mobile sometimes jumps WAY far
    // back, to the very beginning of the chat. messages that were read weeks ago".
    //
    // `read_by` is optional and additive, so a message whose receipt never
    // round-tripped to this device is indistinguishable from an unread one. The
    // original rule took the FIRST unread anywhere in the transcript, so ONE such
    // gap in old history pinned the anchor there permanently — while a newer read
    // message satisfied the "do receipts arrive here" guard, so the bottom fallback
    // never engaged. That is the bug, and it is not the rule reaching too far: he
    // confirmed the unread-anchor behaviour is what he wants.
    //
    // The unread run is the TRAILING one. Anything older than the newest message
    // this device has read is read by implication.
    const rows = [
      agentRow('old1', [THIS_DEVICE]),
      agentRow('old2', null), // ← the gap: a receipt that never landed, weeks ago
      agentRow('old3', [THIS_DEVICE]),
      agentRow('recent', [THIS_DEVICE]), // ← the watermark
      agentRow('new1', null), // ← the real unread run starts here
      agentRow('new2', null),
    ];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'unread', index: 4 });
  });

  it('a receipt gap with NOTHING newer unread → the bottom, not the gap', () => {
    // The same gap, but everything after it is read. Opening at the gap would be
    // the reported bug with no unread run to justify it at all.
    const rows = [
      agentRow('old1', [THIS_DEVICE]),
      agentRow('old2', null), // ← gap
      agentRow('old3', [THIS_DEVICE]),
      agentRow('recent', [THIS_DEVICE]),
    ];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'bottom' });
  });

  it('a gap IMMEDIATELY before the watermark is still read-by-implication', () => {
    // Boundary: the newest read row is the last row, so the trailing unread run is
    // empty even though an earlier row looks unread.
    const rows = [agentRow('a1', null), agentRow('a2', [THIS_DEVICE])];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'bottom' });
  });

  it('a read by ANOTHER device does not count as read by THIS one', () => {
    const rows = [agentRow('a1', [THIS_DEVICE]), agentRow('a2', [OTHER_DEVICE])];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'unread', index: 1 });
  });

  it("the owner's OWN messages are never 'unread'", () => {
    // A user row has no `read_by` naming this device and never will; counting it
    // would pin the anchor to the owner's last send forever.
    const rows = [agentRow('a1', [THIS_DEVICE]), userRow('u1')];
    expect(chatInitialAnchor(rows, THIS_DEVICE)).toEqual({ kind: 'bottom' });
    expect(receiptEligibleMessageId(userRow('u1'))).toBeNull();
    expect(receiptEligibleMessageId(agentRow('a1', null))).toBe('a1');
  });

  it('a streaming row is not receipt-eligible', () => {
    const streaming: RenderRow = { kind: 'streaming', key: 's:1', message_id: 'a9', body: 'typing' };
    expect(receiptEligibleMessageId(streaming)).toBeNull();
    expect(chatInitialAnchor([agentRow('a1', [THIS_DEVICE]), streaming], THIS_DEVICE)).toEqual({
      kind: 'bottom',
    });
  });

  it('falls back to the BOTTOM when the read signal cannot be trusted', () => {
    // No rows; no device id yet; and the important one — a transcript in which
    // NOTHING is read by this device. `read_by` is optional and additive, so a
    // history synced before receipts existed presents as entirely unread, and
    // anchoring on that would open at the very first message of a long history.
    expect(chatInitialAnchor([], THIS_DEVICE)).toEqual({ kind: 'bottom' });
    expect(chatInitialAnchor([agentRow('a1', null)], '')).toEqual({ kind: 'bottom' });
    expect(
      chatInitialAnchor([agentRow('a1', null), agentRow('a2', null)], THIS_DEVICE),
    ).toEqual({ kind: 'bottom' });
  });
});

// ─────────────────────────────── the wiring ───────────────────────────────

describe('ISSUES #505 — the surface hands FlashList that anchor', () => {
  it('an all-read transcript re-opens aimed PAST the last row', async () => {
    const first = await mountChat();
    const device = deviceIdOnTheWire();
    await deliver(first, agentMessageFrame('m1', 1, 'first reply'));
    await deliver(first, agentMessageFrame('m2', 2, 'a very tall second reply'));
    // The owner reads both; the server fans the receipts back.
    await deliver(first, receiptUpdateFrame('m1', [device]));
    await deliver(first, receiptUpdateFrame('m2', [device]));

    // THE COLD OPEN. A project switch remounts this surface over the warm session
    // and its durable store — the exact path the report describes.
    first.unmount();
    const second = await mountChat();
    await second.settle();

    expect(second.text()).toContain('a very tall second reply');
    const anchor = recordedAnchor();
    expect(anchor.index).toBe(recordedRowCount() - 1);
    expect(anchor.viewOffset).toBe(CHAT_BOTTOM_ANCHOR_OVERSCROLL_PT);
    second.unmount();
  });

  it('an UNREAD tail re-opens at the top of the first unread row', async () => {
    const first = await mountChat();
    const device = deviceIdOnTheWire();
    await deliver(first, agentMessageFrame('m1', 1, 'first reply'));
    await deliver(first, agentMessageFrame('m2', 2, 'second reply'));
    await deliver(first, agentMessageFrame('m3', 3, 'third reply'));
    // Only the first is read. m2 and m3 are the unread run.
    await deliver(first, receiptUpdateFrame('m1', [device]));

    first.unmount();
    const second = await mountChat();
    await second.settle();

    const anchor = recordedAnchor();
    expect(recordedRowCount()).toBe(3);
    // Index 1 == m2, the FIRST unread — not the bottom, and not m1.
    expect(anchor.index).toBe(1);
    expect(anchor.viewOffset).toBeUndefined();
    second.unmount();
  });
});
