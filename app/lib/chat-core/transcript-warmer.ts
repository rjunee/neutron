/**
 * @neutronai/app — the background warmer's SCHEDULER: what may run, when, and
 * what must stand aside for the thing the owner is actually looking at.
 *
 * WHY THIS EXISTS. Switching projects was made to feel like a tap rather than a
 * load (#20): the tab set and the settings doc are now both answered from
 * memory, so a rail tap repaints the chrome zero times. One residual survived
 * that work and was reported rather than hidden — a scope this device has NEVER
 * VISITED has no rows in the on-device store, so `hydrationSettled` takes its
 * `status === 'open'` branch (`chat-render-model.ts:81`) the moment the socket
 * comes up, the surface renders "No messages yet" with an honest empty
 * transcript, and the resume replay lands a beat later and replaces it. The
 * empty state is not wrong; it is just PREMATURE, and there is no
 * resume-complete frame in the protocol to gate it on.
 *
 * The fix the owner asked for is not a better gate, it is having the data
 * already: "pre-cache everything in the background. First download the active
 * project, but as you have time in the background just download all the other
 * tabs etc so switching is instant." A scope whose transcript is already on disk
 * takes the `message_count > 0` branch instead, one store read after attach —
 * so there is no window in which an empty state can be shown at all.
 *
 * WHAT THIS FILE IS, AND IS NOT. It is ONLY the schedule: an ordered queue, a
 * bound, and a gate. It holds no data and is no kind of cache — the warmed
 * transcript lands in the ONE device-wide store (`op-sqlite-store.ts`
 * `sharedMobileStore`) through the ordinary session/resume path, which is also
 * the path a real visit uses. There is deliberately no second cache and no
 * second copy of the sync logic; see `use-transcript-warming.ts` for the seam
 * that drives a real session, and this file for the discipline around it.
 *
 * THE ONE RULE THAT MATTERS. Background work exists to make the foreground
 * faster. A prefetch that delays the transcript the owner is waiting on has made
 * the app WORSE at the exact thing it was supposed to improve, and it would do
 * so invisibly — there is no symptom to notice, only a slightly slower app. So
 * the gate is not advisory: nothing is dequeued while the visible chat is still
 * hydrating, and a warm already in flight ABANDONS itself the moment the
 * foreground goes busy again. Both halves are asserted (and mutation-tested) in
 * `__tests__/transcript-warmer.test.ts` — the yield is the guarantee that
 * silently regresses, because a broken one still passes every "did it warm?"
 * assertion.
 */

/**
 * How many scopes get their transcript pulled ahead of the tap.
 *
 * This is the expensive prefetch, and deliberately a much smaller window than
 * the tab-set prefetch beside it (`projects/[id]/_layout.tsx`
 * `TAB_PREFETCH_LIMIT = 12`): a tab set is one small JSON GET, whereas warming a
 * scope opens a WebSocket and pulls a cold resume — the topic's WHOLE transcript,
 * drained in `DEFAULT_REPLAY_LIMIT = 500`-message pages rather than capped at one
 * page (`persistence/app-chat-store.ts` `DEFAULT_REPLAY_LIMIT`, cited by name
 * rather than line because the line has already rotted twice). The rail is
 * activity-sorted, so eight
 * covers the working set the owner actually switches within on a phone; a ninth
 * project still opens exactly as it does today. "Download all the other tabs" is
 * the intent, not a licence to sync a device without limit.
 */
export const WARM_SCOPE_LIMIT = 8;

/**
 * How long the warmer waits after being handed a rail before its first pull.
 *
 * Longer than the tab prefetch's 600 ms on purpose. The gate below already
 * refuses to run while the visible chat is hydrating, so this delay is not the
 * mechanism — it is the margin: the first seconds after a cold open are when the
 * device is doing the most work it will ever do (native module load, schema
 * open, first socket, first paint), and none of it should share a runway with a
 * pull for a tap that has not happened.
 */
export const WARM_FIRST_DELAY_MS = 2_000;

/**
 * Quiet time between two warms. Keeps a rail of eight from arriving as a burst
 * of eight sockets — the gateway is a single box the owner is also talking to.
 */
export const WARM_GAP_MS = 750;

/** A warm attempt. `blocked()` reports whether the foreground now needs the
 *  runway back; an implementation MUST check it and return early when it does. */
export type WarmFn = (scope_id: string, blocked: () => boolean) => Promise<void>;

export interface StartWarmingOptions {
  /** Scopes to warm, in priority order (the caller sorts; the rail is already
   *  activity-sorted). Already-warmed and duplicate ids are dropped. */
  scopes: readonly string[];
  /** Performs one warm. Injected so the schedule is testable without a socket. */
  warm: WarmFn;
  /** Override {@link WARM_SCOPE_LIMIT}. */
  limit?: number;
  /** Override {@link WARM_FIRST_DELAY_MS}. */
  firstDelayMs?: number;
  /** Override {@link WARM_GAP_MS}. */
  gapMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Is the visible chat still working? Starts `false` because nothing is on screen
 * before the first mount — `useMobileChat` raises it on attach and lowers it when
 * that scope's hydration settles, so the flag tracks the surface the owner is
 * looking at rather than a guess about it.
 */
let foregroundBusy = false;
/** Is the app foregrounded? Warming is suspended outright when it is not. */
let appActive = true;

/** Scopes warmed (or attempted) in THIS process. A failed attempt counts: a
 *  scope that cannot be warmed must not be retried in a loop, and its cost is
 *  exactly the cost of the visit that would have happened anyway. */
const warmed = new Set<string>();
/** The pending work, in priority order. */
const queue: string[] = [];
/** Resolvers parked on {@link warmingBlocked} going false. */
const waiters = new Set<() => void>();
/** Notified on every gate transition, so an in-flight warm can bail promptly. */
const gateListeners = new Set<() => void>();

interface Runner {
  warm: WarmFn;
  gapMs: number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
}

let runner: Runner | null = null;
/** Bumped by {@link stopWarming}; every await in the loop re-checks it, so a
 *  stop can never be outlived by the tick that was already in flight. */
let generation = 0;
let draining = false;
/** Timers the schedule is currently parked on, with the resolver each one owes.
 *  A stop clears the timer AND settles the resolver — a cancelled tick that
 *  merely drops its timer leaves the drain suspended on a promise nothing will
 *  ever resolve, which is a coroutine that can never be collected. */
const parkedTimers = new Map<unknown, () => void>();

/** Whether background work must stand aside right now. */
export function warmingBlocked(): boolean {
  return foregroundBusy || !appActive;
}

/**
 * Raise/lower the foreground flag. Called by `useMobileChat`: raised when a
 * scope attaches, lowered when that scope's hydration settles.
 */
export function setForegroundBusy(busy: boolean): void {
  if (foregroundBusy === busy) return;
  foregroundBusy = busy;
  notifyGate();
}

/**
 * AppState bridge. Backgrounding suspends the schedule entirely — the warm
 * sockets are already quieted by `setCacheActive` (`session-cache.ts:183`), and
 * opening NEW ones for a screen nobody is looking at is exactly the
 * battery-for-latency trade that cache refused to make silently.
 */
export function setWarmingActive(active: boolean): void {
  if (appActive === active) return;
  appActive = active;
  notifyGate();
}

/** Subscribe to gate transitions. Returns the unsubscribe. */
export function subscribeWarmingGate(listener: () => void): () => void {
  gateListeners.add(listener);
  return (): void => {
    gateListeners.delete(listener);
  };
}

function notifyGate(): void {
  if (!warmingBlocked()) {
    const parked = [...waiters];
    waiters.clear();
    for (const resolve of parked) resolve();
  }
  for (const listener of [...gateListeners]) listener();
}

/**
 * Enqueue `scopes` and (re)start the drain. Safe to call on every render pass:
 * ids already warmed or already queued are dropped, and a drain already running
 * simply picks up the additions.
 *
 * Returns the stop function. Call it on sign-out / teardown; it cancels the
 * pending tick and forgets the queue, but deliberately does NOT forget what has
 * already been warmed (that lives on disk, and re-pulling it would be pure cost).
 */
export function startWarming(opts: StartWarmingOptions): () => void {
  const limit = opts.limit ?? WARM_SCOPE_LIMIT;
  runner = {
    warm: opts.warm,
    gapMs: opts.gapMs ?? WARM_GAP_MS,
    setTimeoutFn: opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeoutFn: opts.clearTimeoutFn ?? ((h) => clearTimeout(h as never)),
  };
  for (const scope of opts.scopes.slice(0, limit)) {
    if (scope.length === 0) continue;
    if (warmed.has(scope) || queue.includes(scope)) continue;
    queue.push(scope);
  }
  if (queue.length > 0 && !draining) {
    const gen = generation;
    const active = runner;
    draining = true;
    void pause(active, opts.firstDelayMs ?? WARM_FIRST_DELAY_MS).then(() => {
      if (gen !== generation) {
        draining = false;
        return;
      }
      return drain(gen);
    });
  }
  return stopWarming;
}

/** Cancel the schedule. Idempotent. */
export function stopWarming(): void {
  generation += 1;
  queue.length = 0;
  const timers = [...parkedTimers.entries()];
  parkedTimers.clear();
  for (const [handle, resolve] of timers) {
    runner?.clearTimeoutFn(handle);
    resolve();
  }
  draining = false;
  runner = null;
  const parked = [...waiters];
  waiters.clear();
  for (const resolve of parked) resolve();
}

async function drain(gen: number): Promise<void> {
  try {
    while (gen === generation) {
      const active = runner;
      if (active === null) return;
      // THE YIELD, half one. Nothing is dequeued while the foreground is
      // working — not "the request is sent but deprioritised", not "one more
      // then we stop". A tap that lands here waits for the visible scope to
      // settle before any background socket is opened.
      await waitUntilRunnable(gen);
      if (gen !== generation) return;
      const scope = queue.shift();
      if (scope === undefined) return;
      if (warmed.has(scope)) continue;
      warmed.add(scope);
      try {
        // THE YIELD, half two: `warmingBlocked` is handed IN, so the attempt
        // can abandon itself mid-flight rather than only being prevented from
        // starting. A resume replay takes hundreds of ms; a gate checked only
        // at the top would let one run straight through a project switch.
        await active.warm(scope, warmingBlocked);
      } catch {
        // FAIL INVISIBLY. This is work for a tap that has not happened; the
        // owner asked for nothing here and must be told nothing. An unwarmed
        // scope resolves its own transcript on arrival, exactly as today.
      }
      if (gen !== generation) return;
      await pause(active, active.gapMs);
    }
  } finally {
    draining = false;
  }
}

function waitUntilRunnable(gen: number): Promise<void> {
  if (!warmingBlocked() || gen !== generation) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiters.add(resolve);
  }).then(() => waitUntilRunnable(gen));
}

function pause(active: Runner, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // `handle` is captured, not read at schedule time, because an injected
    // timer may fire SYNCHRONOUSLY (test harnesses do) — parking a handle that
    // has already fired would leave a dead entry a stop then tries to cancel.
    let fired = false;
    let handle: unknown = null;
    handle = active.setTimeoutFn(() => {
      fired = true;
      if (handle !== null) parkedTimers.delete(handle);
      resolve();
    }, ms);
    if (!fired) parkedTimers.set(handle, resolve);
  });
}

/** Test/diagnostic: scopes warmed (or attempted) so far this process. */
export function warmedScopes(): readonly string[] {
  return [...warmed];
}

/**
 * Cancel the schedule AND forget what has been warmed. For sign-out and identity
 * rotation, alongside `clearSessionCache` — the ledger says "this device already
 * has that scope on disk", which is a claim about an identity, not about a
 * project id. A project id that survives a sign-in as someone else must be
 * pulled fresh rather than assumed present.
 */
export function forgetWarmedScopes(): void {
  stopWarming();
  warmed.clear();
}

/** Test-only — real builds never call this. */
export function __resetTranscriptWarmerForTests(): void {
  stopWarming();
  generation = 0;
  warmed.clear();
  gateListeners.clear();
  foregroundBusy = false;
  appActive = true;
}
