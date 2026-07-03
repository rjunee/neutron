/**
 * landing/chat-react — mobile work-activity signals (FIX #348 pulse + #349
 * job-start drawer).
 *
 * Both mobile behaviours are driven by ONE subscription to the work-board live
 * source (the controller): the pulse wants "is any run live right now?" and the
 * drawer wants "did a NEW run just start?". `useWorkActivity` subscribes once,
 * tracks the set of currently-running item ids per active project, and exposes:
 *
 *   - `running`     — count of live (non-terminal) linked runs → drives the pulse.
 *   - `justStarted` — the most-recently newly-started job (a rising running edge),
 *                     for the top drawer; cleared via `clearStarted`.
 *
 * The very first frame after (re)subscribe only SEEDS the baseline (the live
 * source replays its last snapshot synchronously to a late subscriber), so a
 * pre-existing run on load / project-switch is NOT announced as "just started".
 *
 * `JobStartDrawer` is the mobile-only top sheet: it slides down when a job
 * starts, auto-retracts after ~3s, and can be swiped up (or ✕'d) to dismiss
 * early. Motion is CSS-gated by `prefers-reduced-motion` (show/hide, no slide).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { WorkBoardItem } from './work-board-client.ts'

/** The minimal live-source surface this hook needs (the controller implements
 *  it). Kept local so a test can drive it without the whole controller. */
export interface WorkBoardLiveSource {
  onWorkBoardChanged(
    fn: (items: WorkBoardItem[], projectId: string | undefined) => void,
  ): () => void
}

/** A run's terminal phases — a linked run in one of these is NOT live. Mirrors
 *  `WorkBoardTab`'s `TERMINAL_PHASE_LABELS` (kept local so this hook doesn't
 *  import the JSX tab module). */
const TERMINAL_PHASE_LABELS: readonly string[] = ['merged', 'failed', 'cancelled']

/** True when the item is bound to a still-live (non-terminal) run. Mirror of
 *  `WorkBoardTab.isLinkedRunning`. */
export function itemRunning(item: WorkBoardItem): boolean {
  const linked = item.linked_run_id !== null && item.linked_run_id.length > 0
  if (!linked) return false
  const rp = item.run_progress
  return rp === undefined || !TERMINAL_PHASE_LABELS.includes(rp.phase_label)
}

/** The just-started job surfaced to the drawer. */
export interface StartedJob {
  id: string
  title: string
}

export interface WorkActivity {
  /** Count of currently-live runs on the active project's board (pulse when >0). */
  running: number
  /** The most-recent newly-started job (rising running edge), else null. */
  justStarted: StartedJob | null
  /** Clear the {@link justStarted} signal (drawer dismissed / auto-closed). */
  clearStarted: () => void
}

/**
 * Subscribe to the active project's work board and derive the mobile pulse +
 * drawer signals. Filters frames to `projectId` (the live source multiplexes
 * every project's board), and re-seeds its baseline on a project switch.
 *
 * The baseline is seeded by whatever the live source replays SYNCHRONOUSLY at
 * subscribe (the controller replays its last snapshot to a late subscriber) —
 * that pre-existing state is NOT announced. Every subsequent frame is a real
 * change, so a fresh session's very first live build (no prior snapshot to
 * replay) IS announced (Codex P2: don't swallow the "open page, start first
 * build" case).
 *
 * `announce` gates the drawer signal: when false (e.g. desktop, where the pane
 * owns this), a starting build is NOT retained — so shrinking to mobile later
 * can't surface a stale "building…" drawer for an old event (Codex P2).
 */
export function useWorkActivity(
  source: WorkBoardLiveSource | null | undefined,
  projectId: string | null | undefined,
  announce = true,
): WorkActivity {
  const [running, setRunning] = useState(0)
  const [justStarted, setJustStarted] = useState<StartedJob | null>(null)
  const prevRunningIds = useRef<Set<string>>(new Set())
  const primed = useRef(false)
  const announceRef = useRef(announce)
  announceRef.current = announce
  const pid = projectId ?? ''

  useEffect(() => {
    // A project switch resets the baseline.
    prevRunningIds.current = new Set()
    primed.current = false
    setRunning(0)
    setJustStarted(null)
    if (source === null || source === undefined) return
    const unsub = source.onWorkBoardChanged((items, framePid) => {
      if ((framePid ?? '') !== pid) return
      const runningItems = items.filter(itemRunning)
      const ids = new Set(runningItems.map((i) => i.id))
      if (primed.current && announceRef.current && ids.size > prevRunningIds.current.size) {
        // The running count ROSE — a new run started. Announce the first id that
        // wasn't running a frame ago (0→1 and 1→2 both count).
        const fresh = runningItems.find((i) => !prevRunningIds.current.has(i.id))
        if (fresh !== undefined) setJustStarted({ id: fresh.id, title: fresh.title })
      }
      prevRunningIds.current = ids
      setRunning(ids.size)
    })
    // Any SYNCHRONOUS replay above has now seeded the baseline; treat every later
    // frame as a real change. Without this, a fresh session with nothing to
    // replay would silently seed (and swallow) the user's first build.
    primed.current = true
    return unsub
  }, [source, pid])

  // Drop a pending announcement when announcing is disabled (desktop), so it
  // can't resurface stale if announcing re-enables (the viewport shrinks).
  useEffect(() => {
    if (!announce) setJustStarted(null)
  }, [announce])

  const clearStarted = useCallback(() => setJustStarted(null), [])
  return { running, justStarted, clearStarted }
}

/** Slide-out duration — kept in lockstep with the `--ease-out` transition on
 *  `.car-jobdrawer` in `chat-react.html` so the parent signal clears only after
 *  the retract animation has finished. */
const DRAWER_SLIDE_MS = 300

/**
 * FIX #349 — the mobile "job starting" top sheet. Renders only when `job` is
 * non-null; slides down on mount, auto-retracts after `autoCloseMs`, and clears
 * the parent signal (`onDismiss`) once retracted. Swipe-up or ✕ dismisses early.
 */
export function JobStartDrawer({
  job,
  onDismiss,
  autoCloseMs = 3000,
}: {
  job: StartedJob | null
  onDismiss: () => void
  autoCloseMs?: number
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const touchStartY = useRef<number | null>(null)
  const jobKey = job?.id ?? null

  // A new job → slide in, then arm the auto-retract.
  useEffect(() => {
    if (jobKey === null) return
    setOpen(true)
    const t = setTimeout(() => setOpen(false), autoCloseMs)
    return () => clearTimeout(t)
  }, [jobKey, autoCloseMs])

  // Once retracted (but the signal is still set), clear it after the slide-out
  // so the element unmounts cleanly rather than snapping away mid-transition.
  useEffect(() => {
    if (open || jobKey === null) return
    const t = setTimeout(onDismiss, DRAWER_SLIDE_MS)
    return () => clearTimeout(t)
  }, [open, jobKey, onDismiss])

  if (job === null) return null

  const dismiss = (): void => setOpen(false)

  return (
    <div
      className={`car-jobdrawer${open ? ' car-jobdrawer-open' : ''}`}
      role="status"
      aria-live="polite"
      onTouchStart={(e) => {
        touchStartY.current = e.touches[0]?.clientY ?? null
      }}
      onTouchMove={(e) => {
        if (touchStartY.current === null) return
        const dy = (e.touches[0]?.clientY ?? 0) - touchStartY.current
        // A deliberate upward swipe dismisses early.
        if (dy < -24) {
          touchStartY.current = null
          dismiss()
        }
      }}
    >
      <span className="car-jobdrawer-dot" aria-hidden="true" />
      <div className="car-jobdrawer-main">
        <span className="car-jobdrawer-title">{job.title}</span>
        <span className="car-jobdrawer-sub">building…</span>
      </div>
      <button
        type="button"
        className="car-jobdrawer-x"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
