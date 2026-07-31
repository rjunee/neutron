/**
 * @neutronai/app — SCOPE liveness for the Work surface ("is anything happening
 * right now?").
 *
 * The Work tab already pulses PER ITEM (`work-board-helpers.dotState` →
 * `WorkBoardRow`'s pulse loop), but only for a card bound to a live trident /
 * dispatch run. A plain chat turn — the overwhelmingly common way work actually
 * happens — moves nothing on this surface, so the owner watching the Work tab
 * saw a completely still screen while the agent was mid-turn. This module is the
 * missing derivation: the SAME `activity_event` stream + `/activity` snapshot the
 * Activity Inspector consumes, folded into one honest verdict for the surface.
 *
 * ── Why not just read the snapshot's `state` ────────────────────────────────
 * `ActivityInspectorDrawer` renders `snapshot?.state ?? 'idle'`, fetched ONCE
 * when the drawer opens. That is fine for a drawer the owner opens, reads and
 * closes; it is useless for a tab that sits on screen for minutes, because the
 * verdict would freeze at its mount-time value and a "Working" strip that cannot
 * stop saying Working is precisely the lie this indicator exists to avoid. So the
 * screen keeps the snapshot as the AUTHORITY (it is the only thing that knows
 * `turns_in_flight`, and it is re-fetched on a slow poll to self-heal) and folds
 * the live rows on top for instant reaction.
 *
 * ── The derivation mirrors the server, deliberately ─────────────────────────
 * `deriveInspectorState` (`open/activity-inspector.ts`) is the canonical answer to
 * "hung or working?", including the two-clock rule that makes `wedged` real: the
 * ~10 s keepalive advances the LIVENESS clock but not the REAL-ACTIVITY clock, so
 * a stalled turn cannot masquerade as a working one. Re-deriving that client-side
 * with different thresholds would produce a strip that disagrees with the
 * inspector two taps away, so the thresholds and the ORDER of the checks are
 * copied from it verbatim rather than re-invented.
 *
 * ── What the live rows can and cannot tell us ───────────────────────────────
 * VERIFIED against `open/activity-inspector.ts`: `turnStarted` records a
 * non-synthetic `turn_start` row, but `turnFinished` records NOTHING — there is no
 * `turn_end` event kind. The end-of-turn signal available to a client is the
 * substrate's `completion` event (`activityRowFromSubstrateEvent`), which is not
 * a guaranteed bracket for an aborted turn. So `completion` is treated as an
 * optimistic end (it makes the strip disappear the instant a turn finishes) and
 * the snapshot poll is the authority that corrects it. An `error` row is NOT
 * treated as terminal — the substrate can emit one mid-turn — and the 30 s
 * no-events-at-all rule stops us claiming "Working" over a dead socket regardless.
 */

import { liveAge, type ActivityRow, type ActivitySnapshot, type ActivityState } from './activity-client';

/**
 * No REAL activity for this long, with a turn in flight, ⇒ stalled. Mirrors
 * `open/activity-inspector.ts` `WEDGE_AFTER_MS`; the two must move together or
 * the strip and the inspector disagree about the same session.
 */
export const WEDGE_AFTER_MS = 90_000;

/** No events AT ALL (not even the ~10 s keepalive) for this long ⇒ not
 *  responding. Mirrors `open/activity-inspector.ts` `DEAD_AFTER_MS`. */
export const DEAD_AFTER_MS = 30_000;

/** How often the screen re-fetches the authoritative snapshot. Slow on purpose:
 *  the live rows give instant start/stop, and this exists only to correct a
 *  missed `completion`, so paying for it more often would be noise. */
export const ACTIVITY_POLL_MS = 15_000;

export interface WorkActivityInput {
  /** Latest snapshot for this scope, or null before the first fetch lands. */
  snapshot: ActivitySnapshot | null;
  /** Live rows held by the screen, `seq`-ordered (`mergeActivityRow` keeps them so). */
  rows: readonly ActivityRow[];
  /** Client clock. */
  now: number;
}

/**
 * Whether a turn is in flight, preferring live evidence over the (possibly
 * stale) snapshot.
 *
 * Rows older than the snapshot are ignored: the snapshot carries the server's
 * `turns_in_flight` as of `snapshot.now`, so a `turn_start` from BEFORE that
 * moment is already accounted for in it, and re-reading it would resurrect a turn
 * the snapshot knows has ended. Both clocks are the SERVER's (`row.at` and
 * `snapshot.now`), so this comparison is skew-free — which is why the row's `at`
 * is used here and never `Date.now()`.
 */
function turnInFlight(snapshot: ActivitySnapshot | null, rows: readonly ActivityRow[]): boolean {
  const floor = snapshot === null ? Number.NEGATIVE_INFINITY : snapshot.now;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined) continue;
    if (row.at < floor) break;
    if (row.kind === 'turn_start') return true;
    if (row.kind === 'completion') return false;
  }
  return snapshot?.turn_in_flight ?? false;
}

/**
 * The scope's live state, from the snapshot plus every row seen since.
 *
 * Check order is load-bearing and copied from `deriveInspectorState`: `idle`
 * first (a resting scope has stale clocks BY DEFINITION — the last event could be
 * hours old — and reading those as `wedged` would make every quiet project
 * scream), then `dead` before `wedged` because "no signal at all" is the worse
 * news.
 */
export function workActivityState(input: WorkActivityInput): ActivityState {
  const { snapshot, rows, now } = input;
  if (!turnInFlight(snapshot, rows)) return 'idle';
  const eventAge = liveAge(rows, snapshot, now, { realOnly: false });
  // In flight but we have never seen an event: the turn was just injected and the
  // first keepalive is up to 10 s out. Working, not dead.
  if (eventAge === null) return 'working';
  if (eventAge >= DEAD_AFTER_MS) return 'dead';
  const realAge = liveAge(rows, snapshot, now, { realOnly: true });
  if (realAge === null) return 'working';
  if (realAge >= WEDGE_AFTER_MS) return 'wedged';
  return 'working';
}

/** Short copy for the Work surface's status strip. Deliberately terser than the
 *  inspector's sentence — this is a one-line strip above a board, not a panel
 *  the owner opened to be told what they are looking at. */
export function workActivityLabel(state: ActivityState): string {
  switch (state) {
    case 'idle':
      return 'Idle';
    case 'working':
      return 'Working';
    case 'wedged':
      return 'Stalled — no activity';
    case 'dead':
      return 'Not responding';
  }
}

/**
 * Whether the strip renders at all, and whether its dot PULSES.
 *
 * A pulse is a claim that something is moving, so only `working` earns one. A
 * stalled or dead session shows a static dot: animating those would say "alive"
 * about the exact sessions that are not, which is the failure mode the Activity
 * Inspector was built to kill. `idle` shows nothing — the strip appearing IS the
 * signal, and a permanent "Idle" row would just be chrome on a small screen.
 */
export function workActivityIndicator(
  state: ActivityState,
): { visible: false } | { visible: true; pulse: boolean; label: string } {
  if (state === 'idle') return { visible: false };
  return { visible: true, pulse: state === 'working', label: workActivityLabel(state) };
}
