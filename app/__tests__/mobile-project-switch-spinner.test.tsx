/**
 * @neutronai/app — THE permanent project-switch spinner (device defect, 2026-07-30).
 *
 * WHAT RYAN SAW, on the APK, 2026-07-30: "Willow and general work. switching
 * to any other topic just shows a spinner." On his install every project he could
 * open had a real back-and-forth transcript (General 20 rows, Willow 18); every
 * project that spun had EXACTLY ONE row — a seeded agent opening with no user turn
 * before it (`app:owner:acme`, `…:harbor`, `…:orchard`, …, read straight out of
 * `app_chat_messages`).
 *
 * WHY THAT CORRELATION EXISTED — and why it is NOT about turn-pairing. The
 * hydrating spinner came down on exactly two signals, written inline in
 * `use-mobile-chat.ts`:
 *
 *     if (mine.length > 0) setHydrated(true);   // the local store already had it
 *     if (s === 'open')    setHydrated(true);   // the socket reached open
 *
 * and on nothing else. General and Willow satisfied the FIRST one from disk, so
 * they rendered no matter what the transport did. A project whose only message had
 * never synced to the device had nothing on disk — so it depended entirely on the
 * second signal, and any path that left the session off the wire wedged it
 * permanently. (The server is not the culprit: probing a live install, a project
 * socket answers `session_ready` in 10ms and replays the single agent row in 2ms.)
 *
 * SO THE TESTS BELOW REPRODUCE THE FAILING CONDITION, NOT A HEALTHY ONE. Every
 * mounted case here is a transcript of AT MOST one agent message with no user
 * turn, on a session that has not reached `open`. A test that opened the socket
 * over a multi-message transcript would have passed on the shipped code and
 * proved nothing — that is precisely the shape that let this ship.
 *
 * THE INVARIANT: an empty or minimal transcript renders an empty chat. Never an
 * infinite spinner, whatever the cause.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { act, createElement } from 'react';

import {
  installNativeHarness,
  setHarnessPlatform,
  resetHarnessGlobals,
  withoutWebCrypto,
} from './support/native-harness';

installNativeHarness();
setHarnessPlatform('ios');

const { FakeChatSocket, mountScreen, mountThenAbandon } = await import('./support/mount');
const { setRuntimeServerConfig, __resetServerConfigForTests } = await import('../lib/config');
const { AuthSessionProvider } = await import('../lib/session');
const { ChatSyncSurface } = await import('../components/ChatSyncSurface');
const { clearSessionCache, peekSession, sessionRefCount } = await import(
  '../lib/chat-core/session-cache'
);
const { hydrationSettled, HYDRATION_SETTLE_MS, buildRenderRows, emptyStreamState } = await import(
  '../lib/chat-core/chat-render-model'
);

const OWNER = {
  id: 'harness-owner',
  email: 'owner@example.test',
  displayName: 'Harness Owner',
  provider: 'dev' as const,
  token: 'harness-token',
};
const BASE_URL = 'https://harness.example.test';

/** The seeded project opening: ONE agent message, no user turn before it. */
const SEEDED_OPENING_BODY = '# Acme - starting plan';
/** What the markdown renderer puts on screen for it (the `#` becomes a heading). */
const SEEDED_OPENING_TEXT = 'Acme - starting plan';

let restoreCrypto: (() => void) | null = null;

beforeEach(() => {
  // THE DEVICE RUNTIME: React Native installs no `crypto` global, and testing
  // this surface on a runtime that HAS WebCrypto is the exact fidelity gap that
  // let a `crypto.randomUUID()` destroy every mobile send undetected.
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

beforeAll(installNativeHarness);

afterAll(() => {
  __resetServerConfigForTests();
  resetHarnessGlobals();
});

async function mount(projectId: string) {
  const screen = await mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId }),
    ),
  );
  return screen;
}

/**
 * Let the hydration floor elapse, with React able to observe the timer.
 *
 * A REAL wait, not a fake-timer jump: the deadline is armed by the surface's own
 * effect at mount, so any fake clock installed afterwards has nothing to advance
 * — and installing one BEFORE the mount would freeze the harness's own macrotask
 * flush. Waiting is the only formulation that exercises the deadline the shipped
 * code actually arms.
 */
async function passTheHydrationFloor(screen: { settle(): Promise<void> }): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, HYDRATION_SETTLE_MS + 250));
  });
  await screen.settle();
}

function spinning(screen: { byTestId(id: string): unknown }): boolean {
  return screen.byTestId('chat-hydrating') !== null || screen.byTestId('chat-attaching') !== null;
}

describe('a scope whose history cannot arrive must still stop spinning', () => {
  it(
    'ONE seeded agent message, never synced, socket never opens — resolves to the empty chat',
    async () => {
      // THE EXACT FAILING CONDITION. Nothing on disk for this scope (the seeded
      // opening lives only on the server) and the transport never reaches `open`,
      // which is the state every wedged project was in on the device.
      const screen = await mount('acme');
      const socket = FakeChatSocket.current();
      expect(socket.closed).toBe(false);

      // Shipped behaviour up to here: a spinner, and on the old code it never
      // came down again.
      await passTheHydrationFloor(screen);

      expect(spinning(screen)).toBe(false);
      expect(screen.byTestId('chat-empty')).not.toBeNull();
      screen.unmount();
    },
    HYDRATION_SETTLE_MS + 10_000,
  );

  it(
    'a project with ZERO messages and no connection resolves too — same defect, one step further',
    async () => {
      const screen = await mount('harbor');
      await passTheHydrationFloor(screen);

      expect(spinning(screen)).toBe(false);
      expect(screen.text()).toContain('No messages yet');
      screen.unmount();
    },
    HYDRATION_SETTLE_MS + 10_000,
  );

  it('an empty scope whose socket DOES open resolves at once — no waiting on the floor', async () => {
    // The healthy exit, and the one ISSUES #402 added: once the socket is open the
    // resume has been requested, so an empty transcript is genuinely empty and the
    // owner must be told immediately rather than after the floor elapses.
    const screen = await mount('harbor');
    const socket = FakeChatSocket.current();
    await act(async () => {
      socket.onopen?.();
    });
    await screen.settle();

    expect(spinning(screen)).toBe(false);
    expect(screen.byTestId('chat-empty')).not.toBeNull();
    screen.unmount();
  });
});

describe('the single seeded agent message itself', () => {
  it('renders as one row once it arrives — an unpaired agent turn is NOT dropped', async () => {
    const screen = await mount('acme');
    const socket = FakeChatSocket.current();

    await act(async () => {
      socket.onopen?.();
    });
    await screen.settle();
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: 'session_ready',
          user_id: OWNER.id,
          topic_id: `app:${OWNER.id}:acme`,
          ts: Date.now(),
          last_seen_seq: 1,
        }),
      });
    });
    await screen.settle();
    // The resume replay: exactly one agent row, carrying the prompt metadata the
    // server actually stores on these openings, and NO user message anywhere.
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: 'agent_message',
          body: SEEDED_OPENING_BODY,
          message_id: '59c10dd6-af35-42c9-9369-a2af00d31df7',
          ts: Date.now(),
          seq: 1,
          project_id: 'acme',
          prompt_id: '0cb7f965-f1a6-4a2a-aa04-73d227fafb95',
          allow_freeform: true,
        }),
      });
    });
    await screen.settle();

    expect(screen.text()).toContain(SEEDED_OPENING_TEXT);
    expect(spinning(screen)).toBe(false);
    expect(screen.byTestId('chat-empty')).toBeNull();
    screen.unmount();
  });

  it('the render model keeps an agent message that has no preceding user turn', () => {
    const rows = buildRenderRows(
      [
        {
          topic_id: `app:${OWNER.id}:acme`,
          client_msg_id: '',
          message_id: 'seeded-1',
          seq: 1,
          role: 'agent',
          body: SEEDED_OPENING_BODY,
          project_id: 'acme',
          attachments: null,
          created_at: 1,
          status: 'acked',
        },
      ],
      emptyStreamState(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('message');
  });
});

describe('a CACHED session that is not on the wire must be reconnected on attach', () => {
  it('re-entering a project drives its session onto the wire even on a cache hit', async () => {
    // THE MECHANISM behind the wedge. The attach used to connect only a session
    // it had just CONSTRUCTED (`if (isNew) active.start()`), so a cached session
    // that was not live stayed dark on every subsequent visit — and the scope it
    // belonged to could then only hydrate from disk, which is exactly what these
    // projects had nothing of.
    const first = await mount('acme');
    const cached = peekSession(`app:${OWNER.id}:acme`);
    expect(cached).not.toBeNull();
    first.unmount();

    // Put the cached session in the state the abandoned-construction path leaves
    // it in: present in the cache, not on the wire.
    cached?.stop();
    const socketsBefore = FakeChatSocket.opened.length;

    const second = await mount('acme');
    expect(FakeChatSocket.opened.length).toBeGreaterThan(socketsBefore);
    second.unmount();
  });

  it('a mount abandoned MID-CONSTRUCTION gives its reference back', async () => {
    // HOW A CACHED-BUT-DARK SESSION IS BORN. `acquireSession` awaits a native
    // module load + a schema open; a rail tap can outrun that. The view unmounts,
    // its cleanup runs while the acquired key is still unknown, and the
    // construction then resolves into a `disposed` view. The reference it took is
    // never given back — so the entry sits above the idle set forever, and since
    // that same path also never reached `start()`, the session it pins has no
    // socket. Every later attach then found a cache hit and left it dark.
    const topic = `app:${OWNER.id}:orchard`;

    // Render + unmount WITHOUT awaiting: the effect starts the acquisition and the
    // cleanup runs before it can resolve. That is the race, not a simulation of it.
    mountThenAbandon(
      createElement(
        AuthSessionProvider,
        { initialUser: OWNER },
        createElement(ChatSyncSurface, { projectId: 'orchard' }),
      ),
    );

    // Now let the abandoned construction land.
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(sessionRefCount(topic)).toBe(0);
  });
});

describe('hydrationSettled — the rule, stated once', () => {
  const open = { message_count: 0, status: 'open' as const, elapsed_ms: 0 };
  const idle = { message_count: 0, status: 'idle' as const, elapsed_ms: 0 };

  it('settles when the local store already holds this scope', () => {
    expect(hydrationSettled({ ...idle, message_count: 1 })).toBe(true);
  });

  it('settles when the socket reaches open — an empty transcript is then genuinely empty', () => {
    expect(hydrationSettled(open)).toBe(true);
  });

  it('settles when the transport is closed — a spinner over a dead socket is a lie', () => {
    expect(hydrationSettled({ ...idle, status: 'closed' })).toBe(true);
  });

  it('does NOT settle early on an un-fetched, still-connecting scope (ISSUES #402)', () => {
    expect(hydrationSettled({ ...idle, status: 'connecting' })).toBe(false);
    expect(hydrationSettled({ ...idle, status: 'reconnecting' })).toBe(false);
    expect(hydrationSettled(idle)).toBe(false);
  });

  it('ALWAYS settles at the floor, whatever the transport is doing', () => {
    for (const status of ['idle', 'connecting', 'reconnecting'] as const) {
      expect(hydrationSettled({ message_count: 0, status, elapsed_ms: HYDRATION_SETTLE_MS })).toBe(
        true,
      );
    }
  });
});
