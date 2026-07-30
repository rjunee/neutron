/**
 * Warm session cache — keeps recently-visited chat sessions alive so switching
 * projects is instant.
 *
 * WHY THIS EXISTS. `useMobileChat` used to construct a `MobileChatSession` in an
 * effect keyed on `projectId` and `stop()` it on cleanup. Every project switch
 * therefore paid: open the sqlite store, open a WebSocket, complete the
 * handshake, send `resume`, wait for the replay. Ryan on device: "switching
 * between projects is slow, flickers, briefly shows the no message error, then
 * loads." The flicker is fixed separately (the hydration flag); the COST is
 * fixed here, by not throwing the session away in the first place.
 *
 * THE SHAPE. Sessions are keyed by `topic_id` and reference-counted. Releasing
 * the last reference does NOT stop the session — it becomes IDLE and stays
 * connected, so returning to that project re-attaches to a live socket with its
 * transcript already resumed. Idle sessions are evicted least-recently-used
 * beyond {@link MAX_WARM_SESSIONS}, which is what keeps this a cache and not a
 * leak: a device visiting twenty projects holds at most a few sockets, not
 * twenty.
 *
 * WHAT THIS IS NOT. The genuinely optimal design is ONE multiplexed socket that
 * subscribes to many topics, which would make warm-ness free. That needs a
 * server-side subscription frame — the app-ws binds exactly one topic per
 * connection from its query string — so it is a protocol change, not a client
 * change. This cache is the correct client-only increment; the multiplexing
 * work is tracked separately rather than pretended away.
 */
import type { MobileChatSession } from './mobile-session';

/**
 * How many IDLE sessions stay connected. Three covers the realistic
 * back-and-forth (General ↔ the project being worked ↔ one more) without
 * holding a socket open for every project ever opened.
 */
export const MAX_WARM_SESSIONS = 3;

interface Entry {
  readonly session: MobileChatSession;
  /** Live views holding this session. 0 = idle-but-warm, eligible for eviction. */
  refs: number;
  /** Monotonic tick of last release, for LRU ordering among idle entries. */
  lastReleased: number;
}

const entries = new Map<string, Entry>();
/** In-flight constructions, so two simultaneous mounts share one session. */
const pending = new Map<string, Promise<MobileChatSession>>();
let tick = 0;

/**
 * Acquire the session for `key`, constructing it via `factory` on a miss.
 * Every successful acquire MUST be paired with a {@link releaseSession}.
 */
export async function acquireSession(
  key: string,
  factory: () => Promise<MobileChatSession>,
): Promise<MobileChatSession> {
  const hit = entries.get(key);
  if (hit !== undefined) {
    hit.refs += 1;
    return hit.session;
  }

  const inFlight = pending.get(key);
  if (inFlight !== undefined) {
    const session = await inFlight;
    // The construction that owns `pending` installs the entry; a racing waiter
    // only adds its own reference.
    const now = entries.get(key);
    if (now !== undefined) now.refs += 1;
    return session;
  }

  const build = factory();
  pending.set(key, build);
  try {
    const session = await build;
    entries.set(key, { session, refs: 1, lastReleased: 0 });
    return session;
  } finally {
    pending.delete(key);
  }
}

/**
 * Drop one reference. The session stays CONNECTED when the count reaches zero —
 * that is the entire point — and is only stopped if evicting it keeps the idle
 * set within {@link MAX_WARM_SESSIONS}.
 */
export function releaseSession(key: string): void {
  const entry = entries.get(key);
  if (entry === undefined) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  tick += 1;
  entry.lastReleased = tick;
  evictIdleBeyondLimit();
}

function evictIdleBeyondLimit(): void {
  const idle = [...entries.entries()]
    .filter(([, e]) => e.refs === 0)
    .sort((a, b) => a[1].lastReleased - b[1].lastReleased);
  for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - MAX_WARM_SESSIONS))) {
    entry.session.stop();
    entries.delete(key);
  }
}

/**
 * Fan an AppState transition out to EVERY cached session, warm ones included.
 *
 * Without this, backgrounding the app would only quiet the session the visible
 * view happens to hold, leaving the other warm sockets heartbeating in the
 * background — the cache would be trading switch latency for battery, which is
 * not a trade worth making silently.
 */
export function setCacheActive(active: boolean): void {
  for (const entry of entries.values()) entry.session.setActive(active);
}

/**
 * Stop and forget every session. For sign-out and identity rotation: a cached
 * socket authenticated as the previous identity must never survive into the
 * next one (the failure shape behind ISSUES #398).
 */
export function clearSessionCache(): void {
  for (const entry of entries.values()) entry.session.stop();
  entries.clear();
  pending.clear();
  tick = 0;
}

/** Test/diagnostic view of what is currently held. */
export function sessionCacheKeys(): readonly string[] {
  return [...entries.keys()];
}

/**
 * Test/diagnostic handle on a cached session WITHOUT taking a reference.
 * Deliberately read-only in intent: the device harness uses it to fault-inject
 * into the live session the mounted surface is actually using, which is the only
 * way to prove a send failure becomes visible to the owner rather than vanishing.
 */
export function peekSession(key: string): MobileChatSession | null {
  return entries.get(key)?.session ?? null;
}
