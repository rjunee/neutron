/**
 * A PUSH TAP LANDS ON THE MESSAGE IT WAS ABOUT (owner-reported, 2026-08-09).
 *
 * *"when I tapped the notification it opened the app but didn't open in the right
 * project (in this case it should have opened in general scrolled to unread
 * messages)"*
 *
 * Two independent links, and either can be absent while the other passes:
 *
 *   1. the ROUTE carries the message id — `push-deep-link-routing.test.ts` and
 *      `push-kind-coverage.test.ts` own that half;
 *   2. the CHAT SURFACE consumes it. `?message_id=` reached the chat route for
 *      months with nothing reading it, so a tap opened the chat and left the owner
 *      wherever he last was. That is what this file is about.
 *
 * WHY IT NEEDS A MOUNTED TEST AND NOT A SOURCE PIN. The dangerous case is a
 * transcript that is ALREADY MOUNTED: `chatInitialAnchor` is frozen once per scope
 * and FlashList applies its initial scroll exactly once, latching
 * `isInitialScrollComplete`. A computed anchor cannot reach that transcript at all,
 * so the fix is an IMPERATIVE scroll on the list ref — and a ref call is invisible
 * to any assertion about source text or the rendered tree. The stub records
 * imperative calls (`support/stubs/flash-list.tsx`); these tests drive the REAL
 * surface and read what it actually asked the list to do.
 *
 * HONEST BOUNDARY, same as `chat-opens-at-the-bottom.test.tsx`: the stub does not
 * virtualise, so "the row is on screen" is not observable here. What is observable
 * is which position the surface ASKED for. That FlashList honours a `scrollToIndex`
 * is its own behaviour and stays a device claim.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createElement, type ReactElement } from 'react';

import { installNativeHarness, resetHarnessGlobals } from './support/native-harness';

installNativeHarness();

const { FakeChatSocket, mountScreen } = await import('./support/mount');
const { flashListImperativeCalls, lastFlashListProps, resetFlashListRecorder } = await import(
  './support/stubs/flash-list'
);
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { __resetSharedMobileStoreForTests } = await import('../lib/chat-core/op-sqlite-store');
const { clearSessionCache } = await import('../lib/chat-core/session-cache');
const { chatDeepLinkAnchor, chatDeepLinkScrollIndex, indexOfChatMessage } = await import(
  '../lib/chat-core/chat-initial-anchor'
);
// The stub BY PATH, not by the `'expo-router'` specifier: the harness aliases that
// specifier at runtime, but `tsc` resolves it to the real package, whose types carry
// none of the routing controls.
const { installRouting, resetRouting, Slot } = await import('./support/stubs/expo-router');
const { GENERAL_PROJECT_ID } = await import('../lib/project-rail-view');
const ProjectChatTab = (await import('../app/projects/[id]/chat')).default;

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

// ───────────────────────────── the rule, in isolation ─────────────────────────

function agentRow(
  id: string,
  read_by: readonly string[] | null,
  extra: Partial<ChatMessage> = {},
): RenderRow {
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
    ...extra,
  };
  return { kind: 'message', key: `c-${id}`, message };
}

describe('indexOfChatMessage — a notification may name either identity', () => {
  it('finds the row by its chat-core message_id', () => {
    const rows = [agentRow('m1', null), agentRow('m2', null)];
    expect(indexOfChatMessage(rows, 'm2')).toBe(1);
  });

  it('finds the row by its durable prompt_id — which is what a fired reminder carries', () => {
    // An out-of-turn post is written by `gateway/http/deliver.ts` as a ButtonStore
    // row, and its `prompt_id` is the only id the gateway has when it composes the
    // notification. Matching only `message_id` would make the anchor a no-op for
    // exactly the notifications this change exists to fix.
    const rows = [agentRow('m1', null), agentRow('m2', null, { prompt_id: 'prompt-77' })];
    expect(indexOfChatMessage(rows, 'prompt-77')).toBe(1);
  });

  it('is -1 for an id not in the transcript, and for the empty string', () => {
    const rows = [agentRow('m1', null)];
    expect(indexOfChatMessage(rows, 'nope')).toBe(-1);
    expect(indexOfChatMessage(rows, '')).toBe(-1);
  });
});

describe('chatDeepLinkAnchor — the unread run wins over the exact message', () => {
  it('a target INSIDE the unread run anchors the run START, not the target', () => {
    // He asked for the unread run to be read from its beginning (ISSUES #505), and a
    // push about the newest message is where that matters most: jumping straight to
    // it would silently skip the messages before it.
    const rows = [
      agentRow('m1', [THIS_DEVICE]), // watermark
      agentRow('m2', null),
      agentRow('m3', null), // ← the pushed one
    ];
    expect(chatDeepLinkAnchor(rows, THIS_DEVICE, 'm3')).toEqual({ kind: 'unread', index: 1 });
  });

  it('a target BEHIND the watermark anchors the target itself', () => {
    // An old notification tapped late. He asked for that message, and there is no
    // unread run to prefer over it.
    const rows = [
      agentRow('m1', [THIS_DEVICE]),
      agentRow('m2', [THIS_DEVICE]),
      agentRow('m3', [THIS_DEVICE]),
    ];
    expect(chatDeepLinkAnchor(rows, THIS_DEVICE, 'm1')).toEqual({ kind: 'unread', index: 0 });
  });

  it('an UNRESOLVABLE target degrades to the ordinary anchor, exactly', () => {
    // The push can arrive before the message syncs. Guessing would be worse than the
    // existing behaviour, so the rule falls back to it unchanged.
    const rows = [agentRow('m1', [THIS_DEVICE]), agentRow('m2', null)];
    expect(chatDeepLinkAnchor(rows, THIS_DEVICE, 'not-here')).toEqual({
      kind: 'unread',
      index: 1,
    });
    const allRead = [agentRow('m1', [THIS_DEVICE])];
    expect(chatDeepLinkAnchor(allRead, THIS_DEVICE, 'not-here')).toEqual({ kind: 'bottom' });
  });
});

describe('chatDeepLinkScrollIndex — what the IMPERATIVE re-anchor asks for', () => {
  it('returns null for an unresolvable target, so nothing is scrolled on a guess', () => {
    const rows = [agentRow('m1', [THIS_DEVICE]), agentRow('m2', null)];
    expect(chatDeepLinkScrollIndex(rows, THIS_DEVICE, 'not-here')).toBeNull();
    expect(chatDeepLinkScrollIndex(rows, THIS_DEVICE, '')).toBeNull();
    expect(chatDeepLinkScrollIndex([], THIS_DEVICE, 'm1')).toBeNull();
  });

  it('agrees with the render path exactly — one rule, two consumers', () => {
    // The render path freezes `chatDeepLinkAnchor`; the effect asks this. If the two
    // could differ, a cold open would race to two positions. Asserted as equality
    // rather than as two literals, so a change to the rule cannot drift them apart.
    const rows = [agentRow('m1', [THIS_DEVICE]), agentRow('m2', null), agentRow('m3', null)];
    const anchor = chatDeepLinkAnchor(rows, THIS_DEVICE, 'm3');
    expect(anchor.kind).toBe('unread');
    expect(chatDeepLinkScrollIndex(rows, THIS_DEVICE, 'm3')).toBe(
      (anchor as { kind: 'unread'; index: number }).index,
    );
  });

  it('a RESOLVED target never yields the bottom — the branch that used to handle it was dead', () => {
    // The effect used to ask `chatDeepLinkAnchor` and then branch on `kind`, with a
    // `scrollToEnd` arm for `bottom`. That arm could not run: once the target
    // resolves, every path through the rule returns `unread`. The sweep below is the
    // proof, so the deletion rests on a measurement rather than on reading the code
    // carefully — and if the rule ever CAN return `bottom` for a resolved target,
    // this reds instead of the surface silently scrolling to index 0.
    const reads: (readonly string[] | null)[] = [null, [], [THIS_DEVICE], ['other-device']];
    let resolvedCases = 0;
    for (const r0 of reads) {
      for (const r1 of reads) {
        for (const r2 of reads) {
          const rows = [agentRow('m1', r0), agentRow('m2', r1), agentRow('m3', r2)];
          for (const target of ['m1', 'm2', 'm3']) {
            for (const device of [THIS_DEVICE, 'unknown-device']) {
              const index = chatDeepLinkScrollIndex(rows, device, target);
              // Every one of these targets IS in the transcript, so a null here would
              // mean the helper refused a resolvable target.
              expect(index).not.toBeNull();
              expect(index).toBeGreaterThanOrEqual(0);
              expect(index).toBeLessThan(rows.length);
              resolvedCases += 1;
            }
          }
        }
      }
    }
    // Guards the guard: a loop that swept nothing would pass every line above.
    expect(resolvedCases).toBe(reads.length ** 3 * 3 * 2);
  });
});

// ───────────────────────────── mounted-arm plumbing ───────────────────────────

beforeEach(() => {
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  resetFlashListRecorder();
  setRuntimeServerConfig({ gateway_base_url: 'https://harness.example.test', auth_base_url: null });
});

afterEach(() => {
  resetRouting();
  clearSessionCache();
  // ALSO on the way OUT, not only on the way in. The durable store is device-wide
  // and Bun shares one process across a file: a store left open by a mounted chat
  // surface makes the NEXT test's mount reuse it and open no socket, and every
  // `FakeChatSocket.current()` after that throws. Measured here, and the same
  // reason `project-switch-reaches-the-wire.test.tsx` resets it in both hooks.
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
});

beforeAll(installNativeHarness);
afterAll(resetHarnessGlobals);

type Screen = Awaited<ReturnType<typeof mountScreen>>;

/** The element tree a push tap re-renders: the same route, a new `?message_id=`. */
function surface(targetMessageId?: string): ReactElement {
  return createElement(
    AuthSessionProvider,
    { initialUser: OWNER },
    createElement(ChatSyncSurface, {
      projectId: '',
      ...(targetMessageId !== undefined ? { targetMessageId } : {}),
    }),
  );
}

async function mountChat(targetMessageId?: string): Promise<Screen> {
  const screen = await mountScreen(surface(targetMessageId));
  await screen.settle();
  await openSocket(screen);
  return screen;
}

/**
 * Every socket callback goes through `screen.dispatch`, which runs it inside an act
 * window. Calling `onmessage` directly sets state from outside React, so the render
 * it causes is scheduled on React's own terms and "had the effect run by the next
 * line?" becomes a race. This suite asserts on the ORDER of scrolls against frames
 * arriving, so that race would make it pass or fail by timing rather than by
 * behaviour — the kind of green that means nothing.
 */
async function openSocket(screen: Screen): Promise<void> {
  await screen.dispatch(() => {
    FakeChatSocket.current().onopen?.();
  });
}

async function deliver(screen: Screen, frame: Record<string, unknown>): Promise<void> {
  await screen.dispatch(() => {
    FakeChatSocket.current().onmessage?.({ data: JSON.stringify(frame) });
  });
}

function deviceIdOnTheWire(): string {
  const url = new URL(FakeChatSocket.current().url.replace(/^ws/, 'http'));
  const id = url.searchParams.get('device_id');
  if (id === null || id.length === 0) throw new Error('the socket carried no device_id');
  return id;
}

function agentMessageFrame(message_id: string, seq: number, body: string): Record<string, unknown> {
  return { v: 1, type: 'agent_message', message_id, seq, ts: 1_700_000_000_000 + seq, body };
}

function receiptUpdateFrame(message_id: string, read_by: readonly string[]): Record<string, unknown> {
  return { v: 1, type: 'receipt_update', message_id, seq: null, delivered_by: read_by, read_by };
}

/** The imperative scrolls the surface asked the REAL list for, oldest first. */
function scrollToIndexAsks(): readonly { method: string; arg?: unknown }[] {
  return flashListImperativeCalls().filter((c) => c.method === 'scrollToIndex');
}

/** The rows the list was actually handed, so an expectation is never re-derived
 *  from what the test hopes was rendered. */
function renderedRows(): readonly RenderRow[] {
  const props = lastFlashListProps();
  if (props === null) throw new Error('FlashList never rendered');
  return (props['data'] as readonly RenderRow[] | null) ?? [];
}

// ─────────────────────────────── the wiring ───────────────────────────────

/**
 * ONE mounted test carrying five arms, because they are one SEQUENCE.
 *
 * The arms are not independent scenarios that happen to share setup — several of
 * them are only meaningful against a session that has already lived: "nothing moved
 * before a target arrived", "the target was honoured ONCE and later traffic did not
 * yank him back", "a second, older target is honoured after the first was spent".
 * None of those can be stated across separate mounts, because each would start from
 * a transcript with no history to be wrong about.
 */
describe('the surface CONSUMES the pushed message id', () => {
  it('a push tap re-anchors the transcript, once, and only when one is pushed', async () => {
    const screen = await mountChat();
    const device = deviceIdOnTheWire();
    await deliver(screen, agentMessageFrame('m1', 1, 'first reply'));
    await deliver(screen, receiptUpdateFrame('m1', [device]));
    await deliver(screen, agentMessageFrame('m2', 2, 'second reply'));
    await deliver(screen, agentMessageFrame('m3', 3, 'the ritual post'));
    expect(screen.text()).toContain('the ritual post');

    // ARM 1 — THE REGRESSION ARM for ISSUES #505/#511. An ordinary open must be
    // byte-identical to before: the frozen anchor decides, and nothing scrolls
    // imperatively. A version of this change that re-anchored unconditionally
    // passes every arm below and fails this one.
    expect(scrollToIndexAsks()).toEqual([]);

    // ARM 2 — an UNRESOLVABLE target WAITS rather than jumping somewhere arbitrary.
    // A notification routinely beats its own message to the device.
    await screen.rerender(surface('m9'));
    expect(scrollToIndexAsks()).toEqual([]);

    // ARM 3 — THE CASE THE FROZEN ANCHOR CANNOT REACH, and the one the owner hit:
    // the app was already open on this chat, so FlashList has spent its one initial
    // scroll and only a call on the ref can move the transcript. m3 is the newest of
    // an unread run starting at index 1, and the run's START is where he asked to
    // land — *"scrolled to unread messages"* — not the exact row.
    await screen.rerender(surface('m3'));
    expect(chatDeepLinkAnchor(renderedRows(), device, 'm3')).toEqual({
      kind: 'unread',
      index: 1,
    });
    expect(scrollToIndexAsks().at(-1)).toEqual({
      method: 'scrollToIndex',
      arg: { index: 1, animated: true },
    });

    // ARM 4 — honoured ONCE. Later traffic must not yank the owner back to it after
    // he has started reading.
    const spent = scrollToIndexAsks().length;
    await deliver(screen, agentMessageFrame('m4', 4, 'a later reply'));
    await deliver(screen, receiptUpdateFrame('m3', [device]));
    expect(scrollToIndexAsks().slice(spent)).toEqual([]);

    // ARM 5 — a message BEHIND the watermark anchors itself, driven through the same
    // mounted surface. Everything is read by now except m4, so a tap on m1's
    // notification must land on m1 rather than on the unread tail.
    await deliver(screen, receiptUpdateFrame('m2', [device]));
    await deliver(screen, receiptUpdateFrame('m4', [device]));
    const beforeOld = scrollToIndexAsks().length;
    await screen.rerender(surface('m1'));
    expect(chatDeepLinkAnchor(renderedRows(), device, 'm1')).toEqual({
      kind: 'unread',
      index: 0,
    });
    expect(scrollToIndexAsks().slice(beforeOld)).toEqual([
      { method: 'scrollToIndex', arg: { index: 0, animated: true } },
    ]);

    // ARM 6 — THE SAME TARGET, ARRIVING TWICE. This surface is not remounted by a
    // project switch (`projects/[id]` does not diverge on the dynamic segment, and
    // FlashList carries no `key`), so target-X → a render with no target → target-X
    // again reaches the SAME component instance. The middle render carries no target,
    // which is the moment the latch has to be released: without that release the second
    // arrival hit the `honouredDeepLink === deepLinkTarget` early return and the
    // transcript did not move at all.
    //
    // WHAT THIS ARM DOES NOT PROVE, stated because the version of this comment written
    // alongside the fix claimed it: the two arrivals here are `rerender` calls, NOT two
    // notification taps. A real second tap of the SAME notification never reaches this
    // component — `installPushTapHandler`'s `dispatch` helper (`app/lib/push.ts`) returns
    // on a seen `request.identifier`, BEFORE `resolvePushRoute`, so no route is pushed and no
    // `?message_id=` is re-supplied (7-day TTL; warm taps do not dismiss). This arm
    // therefore proves the latch releases on a targetless visit — which is real and is
    // what the mutation kills — and says nothing about tap-twice reachability. The
    // dedupe gap is filed as #182.
    //
    // Asserted as a NEW ask appended after the no-target render, not as a count, so a
    // fix that re-anchored on the empty render instead would not pass by accident.
    const beforeRevisit = scrollToIndexAsks().length;
    await screen.rerender(surface());
    expect(scrollToIndexAsks().slice(beforeRevisit)).toEqual([]);
    await screen.rerender(surface('m1'));
    expect(scrollToIndexAsks().slice(beforeRevisit)).toEqual([
      { method: 'scrollToIndex', arg: { index: 0, animated: true } },
    ]);
    screen.unmount();
  });
});

/**
 * THE ROUTE HANDS THE PARAM DOWN — the link that was missing entirely.
 *
 * `resolvePushRoute` has emitted `?message_id=` since 2026-05, and nothing read it
 * (grep-verified: `chat.tsx` declared only `{ id, prefill, autosend }`). A surface
 * that consumes `targetMessageId` correctly is worth nothing if the route never
 * supplies one, and that gap is invisible to both halves' own tests — the exact
 * shape of the push-kind drift recorded in `wire-types/push-kind.ts`.
 *
 * So this mounts the REAL route component over the routing harness at the REAL path
 * `resolvePushRoute` produces, and asserts the transcript moves. Nothing here
 * hand-passes a prop.
 */
describe('the chat ROUTE reads ?message_id= off the URL', () => {
  it('a tap URL drives the anchor with no prop passed by hand', async () => {
    installRouting({
      path: `/projects/${GENERAL_PROJECT_ID}/chat?message_id=m3`,
      routes: { chat: ProjectChatTab as never },
    });
    const screen = await mountScreen(
      createElement(AuthSessionProvider, { initialUser: OWNER }, createElement(Slot, null)),
    );
    await screen.settle();
    await openSocket(screen);

    const device = deviceIdOnTheWire();
    await deliver(screen, agentMessageFrame('m1', 1, 'first reply'));
    await deliver(screen, receiptUpdateFrame('m1', [device]));
    await deliver(screen, agentMessageFrame('m2', 2, 'second reply'));
    await deliver(screen, agentMessageFrame('m3', 3, 'the ritual post'));

    // The unread run starts at m2 (index 1) and m3 is inside it, so the tap lands on
    // the run's start — reached entirely from the URL.
    expect(scrollToIndexAsks().at(-1)).toEqual({
      method: 'scrollToIndex',
      arg: { index: 1, animated: true },
    });
    screen.unmount();
  });
});
