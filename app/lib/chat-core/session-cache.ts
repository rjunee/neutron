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

/**
 * How long a session construction may take before the key is FREED for a fresh
 * attempt.
 *
 * WHY A DEADLINE EXISTS AT ALL (the project that could never be opened,
 * 2026-07-31). `pending` was cleared only when the construction SETTLED. A
 * factory that neither resolves nor rejects therefore pinned its key forever:
 * every later mount of that project took the `pending` branch, awaited a promise
 * that would never answer, and returned nothing — so `start()` was never
 * reached and the client never even ATTEMPTED a socket for that scope. On the
 * owner's device that read as a permanent spinner on every project except the
 * two whose sessions had been built before the wedge, and the server's session
 * log agreed: across fifteen minutes of switching, not one connection was opened
 * for any other topic. A cache that can enter a state no later attempt can leave
 * is not a cache; the deadline is what makes "unconnectable forever" impossible
 * rather than merely unlikely.
 *
 * Generous on purpose — a cold native-module load plus a schema open on a slow
 * device must NOT be cut off. This bounds a hang, it does not police latency.
 */
export const SESSION_BUILD_TIMEOUT_MS = 8_000;

const entries = new Map<string, Entry>();
/** In-flight constructions, so two simultaneous mounts share one session. */
const pending = new Map<string, Promise<MobileChatSession>>();
let tick = 0;

/**
 * `promise`, but rejecting once `ms` has passed.
 *
 * The underlying construction is deliberately NOT cancelled — there is nothing
 * to cancel a native module load with. If it does eventually resolve, its
 * session is simply orphaned: it was never `start()`ed and it holds no resource
 * of its own (the durable store is shared, see `op-sqlite-store.ts`), so letting
 * it be collected is the whole cleanup.
 */
function withDeadline(
  promise: Promise<MobileChatSession>,
  ms: number,
): Promise<MobileChatSession> {
  return new Promise<MobileChatSession>((resolve, reject) => {
    const handle: unknown = setTimeout(() => {
      reject(new Error(`session construction did not settle within ${String(ms)}ms`));
    }, ms);
    // A pending deadline must never keep the host process (or a test runner)
    // alive on its own.
    (handle as { unref?: () => void }).unref?.();
    promise.then(
      (session) => {
        clearTimeout(handle as never);
        resolve(session);
      },
      (err: unknown) => {
        clearTimeout(handle as never);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Acquire the session for `key`, constructing it via `factory` on a miss.
 * Every successful acquire MUST be paired with a {@link releaseSession}.
 *
 * Rejects when the construction fails or exceeds {@link SESSION_BUILD_TIMEOUT_MS}
 * — and leaves NOTHING behind when it does, so the next acquire of the same key
 * starts from scratch. The caller must handle that rejection; a mount that
 * swallows it is a project the owner cannot open.
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

  // A construction already in flight is JOINED rather than duplicated — and the
  // promise held in `pending` already carries the deadline, so a waiter can
  // never outlive the attempt it joined.
  const inFlight = pending.get(key);
  if (inFlight !== undefined) {
    const session = await inFlight;
    // The construction that owns `pending` installs the entry; a racing waiter
    // only adds its own reference.
    const now = entries.get(key);
    if (now !== undefined) now.refs += 1;
    return session;
  }

  const build = withDeadline(factory(), SESSION_BUILD_TIMEOUT_MS);
  pending.set(key, build);
  try {
    const session = await build;
    entries.set(key, { session, refs: 1, lastReleased: 0 });
    return session;
  } finally {
    // Only retract OUR attempt: a later acquire may already have started a fresh
    // one under this key after our deadline fired.
    if (pending.get(key) === build) pending.delete(key);
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
 * How many live views currently hold `key` (0 = idle-but-warm; absent = 0).
 *
 * Test/diagnostic, and load-bearing as an assertion: a reference that is taken
 * and never given back pins its entry above the idle set forever, so it is never
 * evicted — and the acquisition that leaks it is the one that also never reached
 * `start()`, which is how a cached-but-dark session came to exist at all
 * (the permanent project-switch spinner, 2026-07-30). A refcount is the only
 * place that leak is observable.
 */
export function sessionRefCount(key: string): number {
  return entries.get(key)?.refs ?? 0;
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
