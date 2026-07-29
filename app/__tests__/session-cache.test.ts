/**
 * ISSUES #402 (second half) — switching projects must reuse a warm session
 * rather than rebuilding the store + socket + handshake + resume every time.
 *
 * These tests drive the cache with a stand-in session, because the real
 * `MobileChatSession` opens a WebSocket. What matters here is the CONTRACT:
 * a hit does not construct, a release does not stop, and the idle set stays
 * bounded so the cache cannot become a socket leak.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  acquireSession,
  releaseSession,
  clearSessionCache,
  sessionCacheKeys,
  setCacheActive,
  MAX_WARM_SESSIONS,
} from '../lib/chat-core/session-cache';
import type { MobileChatSession } from '../lib/chat-core/mobile-session';

interface FakeSession {
  readonly id: string;
  stopped: number;
  active: boolean[];
}

function fake(id: string): { session: MobileChatSession; probe: FakeSession } {
  const probe: FakeSession = { id, stopped: 0, active: [] };
  const session = {
    topic_id: id,
    stop: (): void => {
      probe.stopped += 1;
    },
    setActive: (a: boolean): void => {
      probe.active.push(a);
    },
  } as unknown as MobileChatSession;
  return { session, probe };
}

beforeEach(() => {
  clearSessionCache();
});

describe('warm session cache', () => {
  test('a second acquire of the same topic REUSES the session — no rebuild', async () => {
    let built = 0;
    const make = async (): Promise<MobileChatSession> => {
      built += 1;
      return fake('app:owner:willow').session;
    };

    const first = await acquireSession('app:owner:willow', make);
    const second = await acquireSession('app:owner:willow', make);

    expect(built).toBe(1);
    expect(second).toBe(first);
  });

  test('releasing the last reference keeps the session ALIVE — that is the point', async () => {
    const { session, probe } = fake('app:owner');
    await acquireSession('app:owner', async () => session);

    releaseSession('app:owner');

    expect(probe.stopped).toBe(0);
    expect(sessionCacheKeys()).toContain('app:owner');
  });

  test('returning to a released topic re-attaches to the SAME session', async () => {
    let built = 0;
    const { session } = fake('app:owner:work');
    const make = async (): Promise<MobileChatSession> => {
      built += 1;
      return session;
    };

    await acquireSession('app:owner:work', make);
    releaseSession('app:owner:work');
    const again = await acquireSession('app:owner:work', make);

    expect(built).toBe(1);
    expect(again).toBe(session);
  });

  test('the idle set is BOUNDED — the oldest release is evicted and stopped', async () => {
    const probes: FakeSession[] = [];
    for (let i = 0; i < MAX_WARM_SESSIONS + 1; i += 1) {
      const key = `app:owner:p${String(i)}`;
      const { session, probe } = fake(key);
      probes.push(probe);
      await acquireSession(key, async () => session);
      releaseSession(key);
    }

    // Oldest release evicted; the rest stay warm.
    expect(probes[0]?.stopped).toBe(1);
    expect(sessionCacheKeys()).not.toContain('app:owner:p0');
    expect(sessionCacheKeys().length).toBe(MAX_WARM_SESSIONS);
  });

  test('a session still held by a live view is NEVER evicted', async () => {
    const held = fake('app:owner:held');
    await acquireSession('app:owner:held', async () => held.session);
    // Never released — a view is on screen.

    for (let i = 0; i < MAX_WARM_SESSIONS + 2; i += 1) {
      const key = `app:owner:q${String(i)}`;
      const { session } = fake(key);
      await acquireSession(key, async () => session);
      releaseSession(key);
    }

    expect(held.probe.stopped).toBe(0);
    expect(sessionCacheKeys()).toContain('app:owner:held');
  });

  test('sign-out stops every cached session — a socket must not outlive its bearer', async () => {
    const a = fake('app:owner');
    const b = fake('app:owner:willow');
    await acquireSession('app:owner', async () => a.session);
    await acquireSession('app:owner:willow', async () => b.session);

    clearSessionCache();

    expect(a.probe.stopped).toBe(1);
    expect(b.probe.stopped).toBe(1);
    expect(sessionCacheKeys()).toEqual([]);
  });

  test('simultaneous mounts of the same topic share ONE construction', async () => {
    let built = 0;
    const make = async (): Promise<MobileChatSession> => {
      built += 1;
      await Promise.resolve();
      return fake('app:owner:race').session;
    };

    const [x, y] = await Promise.all([
      acquireSession('app:owner:race', make),
      acquireSession('app:owner:race', make),
    ]);

    expect(built).toBe(1);
    expect(x).toBe(y);
  });

  test('backgrounding quiets WARM sockets, not just the visible one', async () => {
    const visible = fake('app:owner');
    const warm = fake('app:owner:willow');
    await acquireSession('app:owner', async () => visible.session);
    await acquireSession('app:owner:willow', async () => warm.session);
    releaseSession('app:owner:willow'); // warm, no view on screen

    setCacheActive(false);

    expect(warm.probe.active).toEqual([false]);
    expect(visible.probe.active).toEqual([false]);
  });
});
