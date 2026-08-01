/**
 * @neutronai/app — THE CONNECTION IS ASSUMED GOOD UNTIL IT HAS BEEN BAD FOR A
 * WHILE (owner defect, 2026-07-31).
 *
 * WHAT HE SAW: "I don't want to see the word 'connecting…' every time I switch
 * projects. Can you just hide it. Instead we could have another more subtle
 * indicator somewhere in the app if we're offline for an extended period.
 * Otherwise just assume we are connected. Users don't need to see this."
 *
 * Opening a project mounts a fresh chat surface, which opens (or re-attaches) a
 * socket, which walks `idle → connecting → open`. The strip transcribed that
 * walk, so routine plumbing was rendered as a status several times a minute.
 *
 * THE TWO CLAIMS THIS FILE PINS, AND THEY PULL IN OPPOSITE DIRECTIONS:
 *
 *   A. SILENCE. A connect or a reconnect says NOTHING — no label, no dimmed
 *      text, no strip. Every test below that asserts an empty tree is guarding
 *      against the old behaviour coming back.
 *
 *   B. NOT DELETED. A connection that is genuinely down for an extended period
 *      still surfaces, and if sends are stacking up behind it the owner is told
 *      how many. Deleting the feature would pass claim A perfectly, so claim B
 *      is what makes claim A worth anything — this is the mutation test, and it
 *      includes the flapping case (`connecting → reconnecting → closed → …`),
 *      which is what a real outage looks like and what a naively-written timer
 *      re-arms forever without ever firing.
 *
 * Time is REAL here (the component takes an `offlineAfterMs` seam, and the tests
 * use a few tens of ms); no fake clock is installed, so nothing in this file can
 * pass because a timer was mocked into firing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement, useState } from 'react';

import { installNativeHarness, resetHarnessGlobals } from './support/native-harness';

installNativeHarness();

const { mountScreen } = await import('./support/mount');
const { View } = await import('./support/stubs/react-native');
const {
  ConnectionNotice,
  connectionNotice,
  isAssumedHealthy,
  OFFLINE_NOTICE_AFTER_MS,
} = await import('../components/ConnectionNotice');

/** Short enough to wait out for real, long enough that a same-tick render
 *  cannot have reached it. */
const FAST_OUTAGE_MS = 25;

async function waitPast(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

describe('connectionNotice — the pure decision', () => {
  it('says NOTHING while a socket is merely negotiating', () => {
    for (const status of ['connecting', 'reconnecting', 'closed'] as const) {
      expect(
        connectionNotice({ status, pending_count: 0, outage_elapsed: false }),
      ).toBeNull();
      // …and not even when sends are queued behind it. A brief blip while the
      // owner is typing is the anxiety being removed; the bubble's own 🕓 glyph
      // is carrying that message's state in the meantime.
      expect(
        connectionNotice({ status, pending_count: 3, outage_elapsed: false }),
      ).toBeNull();
    }
  });

  it('says nothing on a healthy socket, queue or no queue', () => {
    // `open` with a non-empty queue is a normal in-flight send. The per-bubble
    // delivery tick (✓ / ✓✓) reports it; a second, thread-level "Sending 1…"
    // band that appears and disappears on every message is the same noise in a
    // different costume.
    expect(connectionNotice({ status: 'open', pending_count: 0, outage_elapsed: false })).toBeNull();
    expect(connectionNotice({ status: 'open', pending_count: 4, outage_elapsed: false })).toBeNull();
    expect(connectionNotice({ status: 'idle', pending_count: 0, outage_elapsed: false })).toBeNull();
  });

  it('speaks once the outage is no longer plausibly a blip', () => {
    expect(connectionNotice({ status: 'reconnecting', pending_count: 0, outage_elapsed: true })).toBe(
      'Offline',
    );
    expect(connectionNotice({ status: 'closed', pending_count: 0, outage_elapsed: true })).toBe(
      'Offline',
    );
  });

  it('reports HOW MANY sends are stuck, because that is the part that matters', () => {
    expect(
      connectionNotice({ status: 'reconnecting', pending_count: 1, outage_elapsed: true }),
    ).toBe('Offline — 1 message waiting to send');
    expect(
      connectionNotice({ status: 'reconnecting', pending_count: 2, outage_elapsed: true }),
    ).toBe('Offline — 2 messages waiting to send');
  });

  it('CANNOT latch: a healthy status outranks a stale elapsed flag', () => {
    // The failure mode this guards is an indicator that survives the recovery —
    // strictly worse than the label it replaced, because it is now a lie.
    expect(connectionNotice({ status: 'open', pending_count: 2, outage_elapsed: true })).toBeNull();
    expect(connectionNotice({ status: 'idle', pending_count: 2, outage_elapsed: true })).toBeNull();
  });

  it('treats exactly `open` and `idle` as "assume connected"', () => {
    expect(isAssumedHealthy('open')).toBe(true);
    expect(isAssumedHealthy('idle')).toBe(true);
    expect(isAssumedHealthy('connecting')).toBe(false);
    expect(isAssumedHealthy('reconnecting')).toBe(false);
    expect(isAssumedHealthy('closed')).toBe(false);
  });
});

describe('OFFLINE_NOTICE_AFTER_MS', () => {
  it('is at least the reconnect machine’s backoff ceiling', () => {
    // `ChatWsClient`'s default `maxBackoffMs` is 15_000 (chat-core/ws-client.ts).
    // Firing sooner than the ceiling would mean announcing an outage while the
    // client still expects a fast recovery — i.e. on a routine blip.
    expect(OFFLINE_NOTICE_AFTER_MS).toBeGreaterThanOrEqual(15_000);
    // And it must be an order of magnitude above a healthy reconnect, which
    // lands on the first or second backoff round (500 ms, then 1 s) — call the
    // slow end of "healthy" 1.5 s.
    expect(OFFLINE_NOTICE_AFTER_MS).toBeGreaterThanOrEqual(10 * 1_500);
  });
});

describe('ConnectionNotice — what is actually on screen', () => {
  beforeAll(() => {
    resetHarnessGlobals();
  });
  beforeEach(() => {
    resetHarnessGlobals();
  });
  afterEach(() => {
    resetHarnessGlobals();
  });
  afterAll(() => {
    resetHarnessGlobals();
  });

  it('renders NOTHING AT ALL on the connect that every project switch performs', async () => {
    // Mounted inside a slot of its own, and the slot is asserted EMPTY — not
    // merely free of text. "No visible label" would still pass on a strip that
    // renders an empty band and shoves the transcript down by its height; this
    // asserts the component contributed no DOM whatsoever. (The slot exists
    // because the harness now mounts the shell's composer dock alongside every
    // screen — `support/mount.tsx` — so the host is never bare.)
    const screen = await mountScreen(
      createElement(
        View,
        { testID: 'notice-slot' },
        createElement(ConnectionNotice, { status: 'connecting', pendingCount: 0, sendError: null }),
      ),
    );
    const slot = screen.byTestId('notice-slot');
    expect(slot).not.toBeNull();
    expect(slot?.childElementCount).toBe(0);
    expect(slot?.textContent).toBe('');
    expect(screen.byTestId('chat-offline-notice')).toBeNull();
    screen.unmount();
  });

  it('renders nothing on a reconnect either, even with a send queued', async () => {
    const screen = await mountScreen(
      createElement(ConnectionNotice, {
        status: 'reconnecting',
        pendingCount: 2,
        sendError: null,
      }),
    );
    expect(screen.text()).toBe('');
    screen.unmount();
  });

  it('MUTATION GUARD — an extended outage DOES surface, with the queue depth', async () => {
    const screen = await mountScreen(
      createElement(ConnectionNotice, {
        status: 'reconnecting',
        pendingCount: 2,
        sendError: null,
        offlineAfterMs: FAST_OUTAGE_MS,
      }),
    );
    // Still silent the instant it mounts…
    expect(screen.text()).toBe('');
    await waitPast(FAST_OUTAGE_MS * 3);
    // …and speaking once the outage has run long.
    expect(screen.byTestId('chat-offline-notice')).not.toBeNull();
    expect(screen.text()).toBe('Offline — 2 messages waiting to send');
    screen.unmount();
  });

  it('MUTATION GUARD — a FLAPPING outage still surfaces', async () => {
    // The real shape of a dead connection: the client cycles connecting →
    // reconnecting → closed as each backoff round fails. A deadline keyed on the
    // status STRING would be torn down and re-armed on every one of those
    // transitions and would never fire, so this test is the difference between
    // an indicator and an indicator-shaped piece of dead code.
    let drive: ((s: 'connecting' | 'reconnecting' | 'closed' | 'open') => void) | null = null;
    function Probe(): React.JSX.Element | null {
      const [status, setStatus] = useState<'connecting' | 'reconnecting' | 'closed' | 'open'>(
        'connecting',
      );
      drive = setStatus;
      return createElement(ConnectionNotice, {
        status,
        pendingCount: 0,
        sendError: null,
        offlineAfterMs: FAST_OUTAGE_MS,
      });
    }
    const screen = await mountScreen(createElement(Probe));
    // KEEP FLAPPING THROUGHOUT, and never let it rest: the assertion below runs
    // while the status is still churning, so an implementation that only fires
    // once the churn STOPS cannot pass. Each step is well under the deadline, so
    // a re-armed timer would be reset ~12 times and never reach it.
    const cycle = ['reconnecting', 'closed', 'connecting'] as const;
    for (let i = 0; i < 12; i++) {
      await waitPast(Math.round(FAST_OUTAGE_MS / 3));
      await act(async () => {
        drive?.(cycle[i % cycle.length]);
      });
    }
    expect(screen.text()).toBe('Offline');
    screen.unmount();
  });

  it('CLEARS ITSELF the moment the connection is healthy again', async () => {
    let drive: ((s: 'reconnecting' | 'open') => void) | null = null;
    function Probe(): React.JSX.Element | null {
      const [status, setStatus] = useState<'reconnecting' | 'open'>('reconnecting');
      drive = setStatus;
      return createElement(ConnectionNotice, {
        status,
        pendingCount: 1,
        sendError: null,
        offlineAfterMs: FAST_OUTAGE_MS,
      });
    }
    const screen = await mountScreen(createElement(Probe));
    await waitPast(FAST_OUTAGE_MS * 3);
    expect(screen.text()).toBe('Offline — 1 message waiting to send');
    await act(async () => {
      drive?.('open');
    });
    expect(screen.text()).toBe('');
    expect(screen.byTestId('chat-offline-notice')).toBeNull();
    screen.unmount();
  });

  it('a send that could not even be QUEUED is reported INSTANTLY, undelayed', async () => {
    // This one is not throttled and must never be: that failure produces no
    // bubble anywhere, so this strip is the only channel it has.
    const screen = await mountScreen(
      createElement(ConnectionNotice, {
        status: 'open',
        pendingCount: 0,
        sendError: 'Message not sent — your text is still in the box; try again',
      }),
    );
    expect(screen.byTestId('chat-send-error')).not.toBeNull();
    expect(screen.text()).toContain('Message not sent');
    screen.unmount();
  });
});
