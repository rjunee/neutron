/**
 * @neutronai/app — WORK BOARD pure presentation helpers (Work Board Phase 1b;
 * M1 redesign row derivations).
 *
 * Framework-free derivations the row/screen render from. Factored out so the
 * status-dot / phase-tag / round / datestamp logic + the reorder neighbor calc
 * are unit-testable without rendering React Native.
 *
 * The dot / tag / round / retry derivations mirror the web tab's helpers
 * field-for-field (`landing/chat-react/WorkBoardTab.tsx`): `stepTag`,
 * `dotState`, `roundText`, `canPlay`, `isRetry`, `formatCompletedShort`.
 */

import { resolveStepLabel } from './work-board-client';
import type { RunPhaseLabel, RunProgress, WorkBoardItem, WorkBoardStatus } from './work-board-client';
import type { PhaseColor } from './theme';

/* ── owner-facing failure copy ───────────────────────────────────────────── */

/**
 * Which failure the owner is looking at. A failed LOAD replaces the whole board
 * pane, so it has to explain what they are looking at; a failed ACTION is a
 * banner above a board they can still see, so it names the action.
 */
export type BoardErrorKind = 'load' | 'action';

/**
 * Owner-facing copy for a Work Board failure — NEVER the raw error.
 *
 * The rule this enforces: an internal validator string is not a user interface.
 * On device the General Work tab rendered its entire pane as
 * `invalid_project_id: project_id must be 1-128 chars from [A-Za-z0-9_.-]`,
 * because the screen painted `err.message` directly. Even with the underlying
 * scope bug fixed, ANY future server-side rejection would do the same, so the
 * pane no longer has a path to a raw message at all: it renders only what this
 * function returns.
 *
 * Codes come from the gateway's stable `{ ok:false, code, message }` envelope
 * (`gateway/http/surface-kit.ts` — the codes are explicitly pinned as wire
 * contract), so switching on them is safe. Anything unrecognised gets the
 * generic line rather than leaking the message.
 *
 * NO CODE ⇒ TRANSPORT. `GatewayHttpClient.req` throws exactly two shapes: a
 * coded {@link GatewayClientError} built from the response envelope, or the raw
 * `fetch` rejection (the mobile client does not set `guardNetworkErrors`). So an
 * error carrying no `code` is a connection failure, and saying so is accurate
 * rather than a guess.
 */
export function boardErrorCopy(err: unknown, kind: BoardErrorKind): string {
  const generic =
    kind === 'load'
      ? 'Couldn’t load the work board. Pull down or tap Retry.'
      : 'That didn’t go through. Try again.';
  const code = readErrorCode(err);
  if (code === null) {
    return kind === 'load'
      ? 'Couldn’t reach your Neutron server. Check the connection and tap Retry.'
      : 'Couldn’t reach your Neutron server — that change wasn’t saved.';
  }
  switch (code) {
    case 'missing_bearer':
    case 'invalid_token':
    case 'expired_token':
    case 'unauthorized':
      return 'Your session expired — sign in again.';
    case 'network':
      return kind === 'load'
        ? 'Couldn’t reach your Neutron server. Check the connection and tap Retry.'
        : 'Couldn’t reach your Neutron server — that change wasn’t saved.';
    case 'item_not_found':
      return 'That item is already gone — the board refreshed.';
    case 'already_running':
      return 'That item is already running.';
    case 'dispatch_unavailable':
      return 'This server can’t run that kind of work yet.';
    case 'invalid_title':
      return 'Give the item a shorter title (up to 256 characters).';
    default:
      return generic;
  }
}

/** The stable server `code` off a thrown client error, or null when absent. */
function readErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** Human label for a status (a11y on the advance control). */
export function statusLabel(status: WorkBoardStatus): string {
  if (status === 'in_progress') return 'In progress';
  if (status === 'done') return 'Done';
  if (status === 'failed') return 'Failed';
  return 'Upcoming';
}

/** Cycle a status forward: upcoming → in_progress → done (done stays done). A
 *  failed item re-queues to upcoming on manual advance (the primary action is
 *  the ▶/↻ retry). */
export function nextStatus(status: WorkBoardStatus): WorkBoardStatus {
  if (status === 'upcoming') return 'in_progress';
  if (status === 'in_progress') return 'done';
  if (status === 'failed') return 'upcoming';
  return 'done';
}

/** Split a board snapshot into the active lane + the completed history. */
export function splitBoard(items: readonly WorkBoardItem[]): {
  active: WorkBoardItem[];
  completed: WorkBoardItem[];
} {
  const active: WorkBoardItem[] = [];
  const completed: WorkBoardItem[] = [];
  for (const it of items) {
    if (it.status === 'done') completed.push(it);
    else active.push(it);
  }
  return { active, completed };
}

/**
 * The reorder target for moving the active item at `index` by `dir` (-1 up, +1
 * down). Returns `{ before }` / `{ after }` of the neighbor, or null at a lane
 * edge (no-op). Kept for the grip's accessibility-action (increment/decrement)
 * a11y-parity path.
 */
export function reorderTarget(
  active: readonly WorkBoardItem[],
  index: number,
  dir: -1 | 1,
): { before: string } | { after: string } | null {
  const target = index + dir;
  if (target < 0 || target >= active.length) return null;
  const neighbor = active[target];
  if (neighbor === undefined) return null;
  return dir === -1 ? { before: neighbor.id } : { after: neighbor.id };
}

/**
 * The reorder target for DROPPING `sourceId` onto `targetId` — mirror of the
 * web tab's drag-drop `reorderTo` computation. Dragging up (source was after
 * target) places the source BEFORE the target; dragging down places it AFTER.
 * Null when the ids are equal or either is missing from `active` (no-op).
 */
export function dragReorderTarget(
  active: readonly WorkBoardItem[],
  sourceId: string,
  targetId: string,
): { before: string } | { after: string } | null {
  if (sourceId === targetId) return null;
  const from = active.findIndex((a) => a.id === sourceId);
  const to = active.findIndex((a) => a.id === targetId);
  if (from < 0 || to < 0 || from === to) return null;
  return from < to ? { after: targetId } : { before: targetId };
}

/* ── M1 redesign — phase color key + dot / tag / round derivations ───────── */

/** The coarse phase color bucket a run step (or terminal state) maps to. */
export type PhaseColorKey = 'build' | 'review' | 'fix' | 'merge' | 'failed';

/** Look up a phase color key's tokens from the theme's `PHASE` map. */
export type PhaseColorLookup = Record<PhaseColorKey, PhaseColor>;

export interface PhaseTag {
  label: string;
  colorKey: PhaseColorKey;
}

/**
 * The phase TAG for a bound run's inner step, or null when the item has no run
 * progress (a plain upcoming card shows just the gray dot + title). Sentence-
 * case copy, tinted capsule; failure uses "Didn't finish" (curly apostrophe —
 * matches the web copy exactly).
 */
export function stepTag(rp: RunProgress | undefined): PhaseTag | null {
  if (rp === undefined) return null;
  switch (resolveStepLabel(rp)) {
    case 'building':
      return { label: 'Building', colorKey: 'build' };
    case 'reviewing':
      return { label: 'Reviewing', colorKey: 'review' };
    case 'fixing':
      return { label: 'Fixing', colorKey: 'fix' };
    case 'merging':
      return { label: 'Merging', colorKey: 'merge' };
    case 'done':
      return { label: 'Merged', colorKey: 'merge' };
    case 'failed':
      return { label: 'Failed', colorKey: 'failed' };
  }
}

/** The failure-reason one-liner (#340) — shown on a failed item's meta line so
 *  the owner sees WHY it failed without opening anything. Null unless the bound
 *  run is in the failed step. Mirror of the web helper. */
export function failureReasonText(rp: RunProgress | undefined): string | null {
  if (rp === undefined || resolveStepLabel(rp) !== 'failed') return null;
  const reason = rp.failure_reason;
  return reason !== null && reason.length > 0 ? reason : null;
}

/** The leading dot's color bucket, or 'upcoming' (faint gray outline, no fill). */
export type DotColorKey = 'upcoming' | PhaseColorKey;

export interface DotState {
  colorKey: DotColorKey;
  pulse: boolean;
}

/**
 * The leading dot's colour bucket + whether it pulses. A live run's step
 * drives the colour (pulsing while building/reviewing/fixing/merging, solid on
 * done/failed); otherwise it falls back to the item's status: done → green,
 * failed → solid failed (amber/red), in_progress → build blue pulsing ONLY
 * while a live bound run exists (static otherwise), upcoming → faint gray
 * outline.
 */
export function dotState(item: WorkBoardItem): DotState {
  const rp = item.run_progress;
  if (rp !== undefined) {
    switch (resolveStepLabel(rp)) {
      case 'building':
        return { colorKey: 'build', pulse: true };
      case 'reviewing':
        return { colorKey: 'review', pulse: true };
      case 'fixing':
        return { colorKey: 'fix', pulse: true };
      case 'merging':
        return { colorKey: 'merge', pulse: true };
      case 'done':
        return { colorKey: 'merge', pulse: false };
      case 'failed':
        return { colorKey: 'failed', pulse: false };
    }
  }
  if (item.status === 'done') return { colorKey: 'merge', pulse: false };
  // The lost failure (owner defect 2026-08-12): a failed card whose run
  // progress is unavailable (a research/dispatch run is not a trident row;
  // the link may have been cleared by reconcile) still paints the durable
  // failed lane. `status='failed'` is written only by the terminal reconcile
  // (`work-board/store.ts` detachRun), so this is positive data — the row is
  // NOT inferring failure from the absence of run_progress.
  if (item.status === 'failed') return { colorKey: 'failed', pulse: false };
  // A pulse is a claim that something is moving (work-board-activity.ts):
  // either a LIVE bound run OR an inline agent action (`inline_active`). The
  // status lane alone never earns a pulse — a runless, non-inline in_progress
  // card renders a STATIC dot.
  if (item.status === 'in_progress') return { colorKey: 'build', pulse: isLinkedRunning(item) || item.inline_active };
  return { colorKey: 'upcoming', pulse: false };
}

/** `round N` for a live (non-terminal) run; null once merged/failed or when idle. */
export function roundText(rp: RunProgress | undefined): string | null {
  if (rp === undefined) return null;
  const step = resolveStepLabel(rp);
  if (step === 'done' || step === 'failed') return null;
  return `round ${rp.round}`;
}

const TERMINAL_PHASE_LABELS: readonly RunPhaseLabel[] = ['merged', 'failed', 'cancelled'];

/**
 * True when the item is bound to a run that is still live (not terminal).
 *
 * The durable terminal lane (`status='failed'`, written only by detachRun
 * #340) wins over the missing-rp inference. attachRun atomically sets
 * `status='in_progress'` with every fresh binding, so this cannot mask a live
 * run. A bound run that died without a terminal write is out of scope (#534).
 */
export function isLinkedRunning(item: WorkBoardItem): boolean {
  const linked = item.linked_run_id !== null && item.linked_run_id.length > 0;
  if (!linked) return false;
  if (item.status === 'failed') return false;
  const rp = item.run_progress;
  return rp === undefined || !TERMINAL_PHASE_LABELS.includes(rp.phase_label);
}

/**
 * True when the ▶/↻ (start/retry) control should render. Gated on the LIVE
 * run, not the status lane: an in_progress card whose run is dead must offer
 * ↻ (owner defect 2026-08-12 — the old `status !== 'in_progress'` clause made
 * a failed-run in_progress card unrecoverable from the UI). `done` and a live
 * linked run suppress the control per spec.
 *
 * DELIBERATE SPEC EXTENSION — `inline_active` (third suppressor): the spec's
 * two-clause form (`!isLinkedRunning && status !== 'done'`) does not mention
 * inline_active. This extension prevents launching a competing Trident build
 * while an inline agent action is already executing. The old staleness caveat is
 * RESOLVED: the SERVER now derives `inline_active` from inspector evidence at
 * every read boundary (WS `work_board_changed` frame, HTTP list + echoes, rail
 * extras, per-turn fragment, agent `work_board_list`), so a crashed session's
 * stale flag heals on the wire within `INLINE_EVIDENCE_WINDOW_MS` (90 s) and the
 * permanent pulse+no-▶ state can no longer occur. This client keeps reading the
 * wire field unchanged.
 */
export function canPlay(item: WorkBoardItem): boolean {
  return item.status !== 'done' && !isLinkedRunning(item) && !item.inline_active;
}

/** ▶ vs ↻ — a card that carries a (now-detached) binding, a failed run, or a
 *  durable `status='failed'` lane RETRIES. The last check covers the runless
 *  failed card whose link was cleared by reconcile. */
export function isRetry(item: WorkBoardItem): boolean {
  if (item.linked_run_id !== null && item.linked_run_id.length > 0) return true;
  if (item.run_progress?.step_label === 'failed') return true;
  return item.status === 'failed';
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Short "Jul 2" datestamp for a completed row; '' when unparseable. */
export function formatCompletedShort(completed_at: string | null): string {
  if (completed_at === null || completed_at.length === 0) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(completed_at);
  if (m === null) return '';
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}`;
}
