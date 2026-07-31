/**
 * @neutronai/app — THE project that could never be opened (device defect, 2026-07-31).
 *
 * WHAT THE OWNER SAW, on the build carrying the previous fix: "I can't switch
 * between projects, just seeing spinners. I can see general, and sometimes
 * <one project> if I click out and back in. Can't see anything in any other
 * projects."
 *
 * WHAT THE SERVER SAW — the evidence that decides this. Before that build, every
 * project DID open a session (`session_open topic=app:owner:<project>`, four
 * distinct scopes inside one minute). After it, across fifteen minutes of the
 * owner actively switching projects, the server logged session opens for exactly
 * TWO topics, ever: the General scope and the one project that already worked.
 * No other project opened a session AT ALL. The client had stopped even
 * ATTEMPTING to connect for them — so this is not a hydration bug, not a render
 * bug, and not a server bug. Nothing was reaching the transport.
 *
 * WHERE THAT STATE LIVED. The warm session cache cleared its `pending` entry only
 * when a construction SETTLED. A factory that neither resolves nor rejects
 * therefore pinned its key permanently: every later mount of that project took
 * the `pending` branch, awaited a promise that would never answer, and never
 * reached `start()`. One bad construction and that scope was unreachable for the
 * life of the process — which is exactly the shape of "never, for fifteen
 * minutes, for these projects and not those".
 *
 * WHY THE TESTS BELOW LOOK LIKE THIS. The load-bearing ones assert that a SOCKET
 * EXISTS for the project — the thing the server log says was missing. A test that
 * asserted the spinner eventually comes down would have passed on the shipped
 * code (the previous fix added a hydration floor, so it always does) while the
 * owner still could not open a single project. The bookkeeping question ("did the
 * reference come back?") is not the product question ("is this project on the
 * wire?"), and only the second one is a fix.
 *
 * ALSO PINNED HERE: the previously-suspected culprit — a mount abandoned while
 * its session was still being constructed — is NOT terminal. That case recovers
 * on the next mount, and the first test proves it, so the next reader does not
 * spend the investigation there again.
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
const { acquireSession, releaseSession, clearSessionCache, sessionCacheKeys, SESSION_BUILD_TIMEOUT_MS } =
  await import('../lib/chat-core/session-cache');
const { sharedMobileStore, __resetSharedMobileStoreForTests } = await import(
  '../lib/chat-core/op-sqlite-store'
);
const { ATTACH_RETRY_DELAY_MS } = await import('../lib/chat-core/use-mobile-chat');

type Session = import('../lib/chat-core/mobile-session').MobileChatSession;

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
  // THE DEVICE RUNTIME: React Native installs no `crypto` global, and testing
  // this surface on one that HAS WebCrypto is the fidelity gap that let a
  // `crypto.randomUUID()` destroy every mobile send undetected.
  restoreCrypto = withoutWebCrypto();
  FakeChatSocket.install();
  clearSessionCache();
  __resetSharedMobileStoreForTests();
  __resetServerConfigForTests();
  setRuntimeServerConfig({ gateway_base_url: BASE_URL, auth_base_url: null });
});

afterEach(() => {
  restoreCrypto?.();
  restoreCrypto = null;
  clearSessionCache();
  __resetSharedMobileStoreForTests();
});

beforeAll(installNativeHarness);

afterAll(() => {
  __resetServerConfigForTests();
  resetHarnessGlobals();
});

/** A stand-in session: the cache's contract is about bookkeeping, not sockets. */
function fake(id: string): { session: Session; stopped: () => number } {
  let stopped = 0;
  const session = {
    topic_id: id,
    stop: (): void => {
      stopped += 1;
    },
    setActive: (): void => {},
    start: (): void => {},
  } as unknown as Session;
  return { session, stopped: () => stopped };
}

/**
 * Await `p`, but FAIL rather than hang.
 *
 * The defect under test is a promise that never answers, so the un-clamped form
 * of every assertion here is a wedged test runner — an unusable signal that
 * reads as "still running" instead of "broken". The clamp is what turns the bug
 * into a failure.
 */
async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(new Error(`did not settle within ${String(ms)}ms`)), ms);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/** Sockets this run opened for `projectId` (the query string carries the scope). */
function socketsFor(projectId: string): number {
  return FakeChatSocket.opened.filter((s) => s.url.includes(`project_id=${projectId}`)).length;
}

async function mount(projectId: string) {
  return mountScreen(
    createElement(
      AuthSessionProvider,
      { initialUser: OWNER },
      createElement(ChatSyncSurface, { projectId }),
    ),
  );
}

/** Let real time pass with React able to observe the timers the surface armed. */
async function waitReal(ms: number, screen?: { settle(): Promise<void> }): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
  await screen?.settle();
}

describe('a project whose first session construction WEDGES', () => {
  it(
    'still gets onto the wire — the owner is not locked out of it for the life of the process',
    async () => {
      // THE FAILING CONDITION, end to end. An earlier attempt for this scope is
      // stuck mid-construction and will never answer (on the device: a store
      // open that does not come back). Under the shipped code every later mount
      // joined that dead promise, so this project never opened a socket again —
      // the permanent spinner, and the silence in the server's session log.
      const topic = `app:${OWNER.id}:orchard`;
      void acquireSession(topic, () => new Promise<Session>(() => {})).catch(() => {
        /* the abandoned attempt; nobody is waiting on it */
      });
      await Promise.resolve();

      const screen = await mount('orchard');
      expect(socketsFor('orchard')).toBe(0); // still inside the wedged attempt

      // The construction deadline retracts the dead attempt, the surface reports
      // the failure instead of swallowing it, and the retry rebuilds.
      await waitReal(SESSION_BUILD_TIMEOUT_MS + 250, screen);
      await waitReal(ATTACH_RETRY_DELAY_MS + 250, screen);

      expect(socketsFor('orchard')).toBeGreaterThan(0);
      screen.unmount();
    },
    SESSION_BUILD_TIMEOUT_MS + ATTACH_RETRY_DELAY_MS + 20_000,
  );

  it(
    'does not pin the cache key — the attempt after it builds a fresh session',
    async () => {
      const key = 'app:owner:stuck';
      void acquireSession(key, () => new Promise<Session>(() => {})).catch(() => {
        /* the wedged attempt */
      });
      await Promise.resolve();

      // A mount that arrives DURING the wedge joins it, and must therefore end —
      // bounded — rather than wait out the life of the process.
      const joined = acquireSession(key, async () => fake(key).session).then(
        () => 'built' as const,
        () => 'gave-up' as const,
      );
      expect(await within(SESSION_BUILD_TIMEOUT_MS + 4_000, joined)).toBe('gave-up');

      // And the key is FREE. This is the assertion the shipped code could not
      // satisfy at any point in the future: `pending` was cleared only on settle,
      // so a wedged construction owned that project forever.
      const session = await within(2_000, acquireSession(key, async () => fake(key).session));

      expect(session).not.toBeNull();
      expect(sessionCacheKeys()).toContain(key);
    },
    SESSION_BUILD_TIMEOUT_MS + 20_000,
  );
});

describe('a mount abandoned MID-CONSTRUCTION (the suspect that was NOT the cause)', () => {
  it('re-entering that project puts it on the wire', async () => {
    // Render + unmount without awaiting: the effect starts the acquisition and
    // the cleanup runs before it can resolve. That is the rail tap outrunning a
    // session construction, not a simulation of it. It recovers — asserted here
    // so this path is not re-suspected.
    mountThenAbandon(
      createElement(
        AuthSessionProvider,
        { initialUser: OWNER },
        createElement(ChatSyncSurface, { projectId: 'orchard' }),
      ),
    );
    for (let i = 0; i < 3; i++) await waitReal(0);

    const before = socketsFor('orchard');
    const screen = await mount('orchard');

    expect(socketsFor('orchard')).toBeGreaterThan(before);
    screen.unmount();
  });
});

describe('every project connects', () => {
  it('visiting more projects than the warm cache holds opens a socket for each one', async () => {
    // The owner's actual session shape: a run of scopes, several of which the
    // device has never synced. Every one of them must reach the transport.
    for (const project of ['willow', 'acme', 'orchard', 'harbor', 'juniper']) {
      const screen = await mount(project);
      expect(socketsFor(project)).toBeGreaterThan(0);
      screen.unmount();
      await waitReal(0);
    }
  });

  it('a scope with ZERO messages connects too — nothing here depends on local history', async () => {
    const screen = await mount('juniper');
    expect(socketsFor('juniper')).toBeGreaterThan(0);
    expect(screen.text()).not.toContain('project_id');
    screen.unmount();
  });
});

describe('the durable store is the DEVICE’s, not the topic’s', () => {
  it('is built once and shared, so a new project pays no native open at all', async () => {
    const first = await sharedMobileStore();
    const second = await sharedMobileStore();

    expect(second).toBe(first);
  });

  it('a failed build is not memoised — the next caller gets a real attempt', async () => {
    __resetSharedMobileStoreForTests();
    const before = await sharedMobileStore();
    __resetSharedMobileStoreForTests();
    const after = await sharedMobileStore();

    expect(after).not.toBe(before);
  });
});

describe('a mount that JOINS an in-flight construction', () => {
  it('is tracked by the cache, so sign-out can still stop its socket', async () => {
    // The join path now shares the owning attempt's deadline, so it is worth
    // pinning that it still ends with ONE tracked entry: a session outside
    // `entries` is invisible to eviction, to the AppState fan-out and to
    // `clearSessionCache` — which is how a socket authenticated as the previous
    // identity survived a sign-out (ISSUES #398).
    const key = 'app:owner:shared';
    const built = fake(key);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const owner = acquireSession(key, async () => {
      await gate;
      return built.session;
    });
    await Promise.resolve();
    const waiter = acquireSession(key, async () => fake('never-built').session);
    await Promise.resolve();
    release();
    await owner;
    await waiter;
    releaseSession(key); // the owning view leaves; the waiter is still on screen

    expect(sessionCacheKeys()).toContain(key);
    clearSessionCache();
    expect(built.stopped()).toBe(1);
  });
});
