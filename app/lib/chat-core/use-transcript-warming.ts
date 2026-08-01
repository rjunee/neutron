/**
 * @neutronai/app — the seam that turns the warmer's schedule into real, warm
 * transcripts.
 *
 * WHERE THIS SITS. `transcript-warmer.ts` decides WHETHER and WHEN; this file
 * does the one thing that constitutes a warm, and it does it through EXACTLY the
 * machinery a real visit uses:
 *
 *   acquireSession(topic) → session.start() → session_ready → resume(after_seq)
 *       → applyInbound → the ONE device-wide op-sqlite store
 *
 * Not one line of sync logic is duplicated here, and no second cache is
 * introduced. That is the whole design: the warm and the visit write the same
 * rows through the same `SyncEngine` into the same database
 * (`op-sqlite-store.ts` `sharedMobileStore`), so a warmed scope is
 * indistinguishable from a scope the owner opened a minute ago — because it IS
 * that, minus the owner.
 *
 * WHY THE SESSION IS RELEASED IMMEDIATELY AFTERWARDS. `releaseSession` does not
 * disconnect; it makes the entry idle and lets the LRU keep at most
 * `MAX_WARM_SESSIONS = 3` sockets alive (`session-cache.ts:35`). Warming eight
 * scopes therefore does NOT leave eight sockets open — five of them are evicted
 * on the way through, and that is fine, because the SOCKET was never the point.
 * The rows it pulled stay on disk. Eviction costs the next visit a reconnect
 * (which it would have paid anyway) and costs it no empty-state flash at all,
 * which is the thing being bought.
 *
 * REVALIDATION — the hazard a cache introduces, and how this one avoids it.
 * Nothing here marks a scope "done". A visit to a warmed scope still constructs
 * or re-attaches its session, still drives `start()` unconditionally
 * (`use-mobile-chat.ts:373`), still gets `session_ready`, and still issues
 * `resume` from the LOCAL CURSOR — so the warmed rows are the floor, and
 * everything appended since arrives on the same schedule it does today. The
 * warm can therefore be stale by minutes without ever being WRONG: the owner
 * sees real messages instantly and the tail fills in behind them, instead of
 * seeing "No messages yet" and then real messages. `reconcileServerReset`
 * (`mobile-session.ts:443`) still runs too, so a warmed transcript from a server
 * that has since been wiped is dropped rather than presented as current.
 *
 * WHAT IS NOT WARMED, stated rather than implied. Docs and Tasks tab BODIES are
 * not prefetched: each is a per-mount hook chain with no shared cache to fill
 * (`app/features/docs/`), so warming them would mean inventing a second cache
 * per surface — the dual-mechanism this repo forbids, for a flash nobody has
 * measured. The other two things a project switch needs ARE already warm before
 * the tap: the settings doc (`projects.ts:185` files every solo row the list
 * returns) and the tab set (`projects/[id]/_layout.tsx` `TAB_PREFETCH_LIMIT`).
 * The transcript was the last one, and it was the only one that still flashed.
 */

import { useEffect, useMemo } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { prefixedRandomId, type ConnStatus } from '@neutronai/chat-core';
import { appWsProjectTopicId, appWsTopicId } from '@neutronai/wire-types/topic-id.ts';

import { railIdToScope } from '../project-rail-view';
import { buildWsUrl } from './ws-url';
import { MobileChatSession } from './mobile-session';
import { sharedMobileStore } from './op-sqlite-store';
import { acquireSession, releaseSession } from './session-cache';
import {
  setWarmingActive,
  startWarming,
  subscribeWarmingGate,
  WARM_SCOPE_LIMIT,
} from './transcript-warmer';

/**
 * How long a warm waits for its socket to reach `open` before giving up on that
 * scope. Generous — a cold native load plus a handshake on a slow network is
 * allowed to be slow — but finite, so one unreachable scope cannot hold the
 * queue behind it.
 */
export const WARM_OPEN_TIMEOUT_MS = 6_000;

/**
 * Inbound silence that counts as "the replay has landed".
 *
 * A PROXY, and named as one. The protocol has no resume-complete frame — that
 * absence is exactly what #20 reported as the reason the cold-scope empty state
 * could not simply be gated away — so there is nothing to await. Quiet after
 * `open` is the honest available signal, and {@link WARM_TOTAL_BUDGET_MS} is
 * what makes a wrong guess bounded instead of open-ended.
 */
export const WARM_QUIET_MS = 900;

/** Hard ceiling on one warm, whatever the transport is doing. */
export const WARM_TOTAL_BUDGET_MS = 12_000;

/**
 * One device id for every warm this process performs, minted once.
 *
 * The gateway uses the upgrade URL's `device_id` for read-receipt attribution
 * and for its in-memory socket registry only (`app-ws-surface.ts:683`) — nothing
 * is persisted — but a fresh id per scope would still put eight phantom devices
 * in that registry for no reason. A warm never calls `markRead`, so this id
 * never appears in anyone's read aggregate.
 */
let warmDeviceId: string | null = null;
function warmerDeviceId(): string {
  warmDeviceId ??= prefixedRandomId('warm');
  return warmDeviceId;
}

/** The app-ws topic for a rail id, using the SHARED derivation — a third
 *  hand-rolled `app:${…}` template is how #395/#398 recurred. */
function topicForScope(user_id: string, rail_id: string): string {
  const scope = railIdToScope(rail_id);
  return scope.length > 0 ? appWsProjectTopicId(user_id, scope) : appWsTopicId(user_id);
}

/**
 * Warm ONE scope: attach, drive it onto the wire, let the replay land, detach.
 * Resolves when the replay has settled, the budget is spent, or the foreground
 * asked for the runway back — and releases its reference on every one of those
 * paths, because a reference that is taken and not given back pins its entry
 * above the idle set forever (`session-cache.ts:214`).
 */
export async function warmScopeTranscript(
  scope: { base_url: string; token: string; user_id: string; rail_id: string },
  blocked: () => boolean,
): Promise<void> {
  const projectId = railIdToScope(scope.rail_id);
  const topicId = topicForScope(scope.user_id, scope.rail_id);
  const deviceId = warmerDeviceId();
  const session = await acquireSession(topicId, async () => {
    const store = await sharedMobileStore();
    return new MobileChatSession({
      url: buildWsUrl(scope.base_url, scope.token, projectId, deviceId),
      topic_id: topicId,
      ...(projectId.length > 0 ? { project_id: projectId } : {}),
      store,
      device_id: deviceId,
    });
  });
  try {
    // The construction itself can outlast the moment it was allowed to start —
    // a tap during a native store open is exactly that. Do not put a socket on
    // the wire for it.
    if (blocked()) return;
    session.start();
    await awaitReplayQuiet(session, blocked);
  } finally {
    releaseSession(topicId);
  }
}

/**
 * Resolve once this session has plausibly finished replaying — or once the
 * foreground needs the runway, or once the budget is spent.
 */
function awaitReplayQuiet(
  session: { subscribe: (l: { onChange?: () => void; onStatus?: (s: ConnStatus) => void }) => () => void; status: () => ConnStatus },
  blocked: () => boolean,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (quiet !== null) clearTimeout(quiet);
      clearTimeout(budget);
      unsubscribeGate();
      unsubscribe();
      resolve();
    };
    const budget = setTimeout(finish, WARM_TOTAL_BUDGET_MS);
    (budget as unknown as { unref?: () => void }).unref?.();
    const armQuiet = (): void => {
      if (quiet !== null) clearTimeout(quiet);
      quiet = setTimeout(finish, WARM_QUIET_MS);
      (quiet as unknown as { unref?: () => void }).unref?.();
    };
    const onOpenOrChange = (): void => {
      armQuiet();
    };
    const unsubscribe = session.subscribe({
      onChange: onOpenOrChange,
      onStatus: (s) => {
        if (s === 'open') onOpenOrChange();
        // A transport that has definitively given up has nothing left to
        // replay; there is no point holding the queue for its full budget.
        if (s === 'closed') finish();
      },
    });
    // THE YIELD, mid-flight. The gate fires on the transition, so a project
    // switch abandons this warm within a tick rather than at the next budget
    // boundary — the socket stays cached and idle, and the queue stands down.
    const unsubscribeGate = subscribeWarmingGate(() => {
      if (blocked()) finish();
    });
    if (blocked()) {
      finish();
      return;
    }
    // A session that was already open (a scope re-queued after an eviction that
    // did not happen) emits no further `open`, so seed from the live snapshot or
    // this would sit out its whole budget waiting for a transition that already
    // happened.
    if (session.status() === 'open') armQuiet();
    const openDeadline = setTimeout(() => {
      if (session.status() !== 'open') finish();
    }, WARM_OPEN_TIMEOUT_MS);
    (openDeadline as unknown as { unref?: () => void }).unref?.();
  });
}

export interface TranscriptWarmingOptions {
  base_url: string;
  /** Null while signed out — warming is off until there is an identity. */
  user: { id: string; token: string } | null;
  /** Rail ids, in the order the rail shows them (activity-sorted). */
  scopes: readonly string[];
  /** The scope on screen. Skipped: its own view is already loading it. */
  activeScope: string;
  /** Test seam — overrides the per-scope warm. */
  warm?: (rail_id: string, blocked: () => boolean) => Promise<void>;
  /** Test seam — overrides the schedule's first delay. */
  firstDelayMs?: number;
  /** Test seam — overrides the gap between scopes. */
  gapMs?: number;
}

/**
 * Mount the background warmer for this rail. One call site (the project shell);
 * everything else — priority, bounds, the gate, the lifecycle — lives below it.
 */
export function useTranscriptWarming(opts: TranscriptWarmingOptions): void {
  const { base_url, user, activeScope, warm, firstDelayMs, gapMs } = opts;
  const user_id = user?.id ?? '';
  const token = user?.token ?? '';
  // The rail refetches on every switch and hands back a fresh array of the same
  // ids, so the schedule keys on the CONTENT — otherwise every tap would restart
  // the first-delay timer and the queue would never get to run at all.
  const scopesKey = opts.scopes.join(',');
  const targets = useMemo(
    () => scopesKey.split(',').filter((id) => id.length > 0),
    [scopesKey],
  );

  useEffect(() => {
    const onAppState = (next: AppStateStatus): void => {
      setWarmingActive(next === 'active');
    };
    const sub = AppState.addEventListener('change', onAppState);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (user_id.length === 0 || token.length === 0) return;
    // The ACTIVE scope is not warmed: its own view is already on the wire for
    // it, and queueing it would have the warmer racing the foreground for the
    // one scope the owner is looking at — precisely the inversion this is
    // supposed to prevent.
    const queue = targets.filter((id) => id !== activeScope).slice(0, WARM_SCOPE_LIMIT);
    if (queue.length === 0) return;
    const stop = startWarming({
      scopes: queue,
      warm:
        warm ??
        ((rail_id, blocked) =>
          warmScopeTranscript({ base_url, token, user_id, rail_id }, blocked)),
      ...(firstDelayMs !== undefined ? { firstDelayMs } : {}),
      ...(gapMs !== undefined ? { gapMs } : {}),
    });
    return stop;
    // `activeScope` is read only to skip the scope the foreground owns.
    // Re-running the whole schedule on every switch would re-arm the first
    // delay forever; the queue is keyed on the rail's content instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base_url, user_id, token, targets, warm, firstDelayMs, gapMs]);
}
