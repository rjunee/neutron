/**
 * landing/chat-react — the desktop WORK slide-out pane (M1 UX redesign PR-4).
 *
 * On desktop (≥1024px) the Work board is NO LONGER a seated tab; it lives in a
 * right-edge slide-out panel INSIDE the chat. The panel is CHROME around the
 * shipped `WorkBoardTab` body (PR-2 rows: dot + tag + round, collapsible Done,
 * drag-reorder, ✕-confirm, ▶ start/retry, add-at-bottom) — the rows are NOT
 * re-implemented here.
 *
 * ── The single manual control: an EDGE-HANDLE ───────────────────────────────
 * There is NO toggle button, NO X, NO close chevron. The ONLY manual open/close
 * affordance is a thin vertical grab-handle riding the pane's left seam (a
 * `<button>` with an aria-label, keyboard-operable). Ryan's sign-off (2026-07-02)
 * overrode the design doc's toggle-chip proposal — this is the entire control
 * surface.
 *
 * ── Auto-open / auto-close is the PRIMARY behavior ──────────────────────────
 * The pane slides open by itself when work is kicked off — a board item gains a
 * live non-terminal run ({@link WorkBoardSummary.running} rises) OR a plain card
 * goes in-flight ({@link WorkBoardSummary.active} rises, i.e. an in_progress /
 * inline_active card with no bound run, #379 defect 3) — and slides closed by
 * itself once ALL work finishes (running + failed + active all zero), after a
 * short 5s settle. A FAILED run keeps it open (attention). A manual handle toggle
 * overrides + persists per-project (localStorage) until the next auto-kickoff.
 * See {@link usePlansPaneController}.
 *
 * ── Geometry (see chat-react.html `.car-plans*`) ────────────────────────────
 * The shell (`.car-app`) is a CSS grid whose 3rd column animates 0 → --pane-width
 * (chat shrinks, never overlaid). The panel itself is a FLOATING card flush to
 * the right edge with top/bottom breathing room, rounded left corners, and a
 * soft shadow — it reads as a panel that slid in next to the chat, not a wall.
 * Motion is `--ease-out`, gated by `prefers-reduced-motion`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { WorkBoardTab, summarize, type WorkBoardSummary } from './WorkBoardTab.tsx'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig } from './config.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** Default settle before an all-clear board auto-closes the pane. */
const AUTO_CLOSE_MS = 5000

/** Per-project localStorage key for the manual open/closed sticky. */
function stickyKey(projectId: string): string {
  return `neutron.plansPane.${projectId}`
}

/** Read the manual sticky: true (pinned open) / false (pinned closed) / null. */
export function readSticky(projectId: string): boolean | null {
  try {
    const v = window.localStorage.getItem(stickyKey(projectId))
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

function writeSticky(projectId: string, open: boolean): void {
  try {
    window.localStorage.setItem(stickyKey(projectId), open ? '1' : '0')
  } catch {
    /* private mode / disabled storage — sticky is best-effort */
  }
}

export interface PaneController {
  /** Whether the pane is currently shown. */
  open: boolean
  /** Manual handle action — flips + pins the state (persisted per-project). */
  toggle: () => void
}

/** The count of live-or-in-flight work that KICKS the pane open — a live trident
 *  run (`running`) OR a plain in-flight card (`active`). A rise in this drives the
 *  auto-open; `failed` keeps it open but does not, on its own, kick it open. */
function engagedCount(summary: WorkBoardSummary): number {
  return summary.running + summary.active
}

/**
 * The open/close state machine for the pane, driven by the live board summary.
 *
 *   - KICKOFF (running OR active rose) → auto-open, drop any manual pin. A plain
 *     in_progress/inline_active card (no bound run) kicks it open too (#379).
 *   - still working (running/active > 0) → stay open (cancel a pending close).
 *   - failed remains                     → stay open (attention).
 *   - all clear (0 running, 0 failed, 0 active) → settle `autoCloseMs` then close,
 *     UNLESS the user has manually pinned it open.
 *   - manual toggle                      → flip + pin (persisted) until next kickoff.
 *
 * `autoCloseMs` is injectable so tests can drive the settle without real time.
 */
export function usePlansPaneController(
  projectId: string,
  summary: WorkBoardSummary,
  autoCloseMs: number = AUTO_CLOSE_MS,
): PaneController {
  const initialSticky = readSticky(projectId)
  const hasWork = summary.running > 0 || summary.failed > 0 || summary.active > 0
  const [open, setOpen] = useState<boolean>(hasWork || initialSticky === true)
  // A manual choice pins the pane against auto-close until the next kickoff. On
  // mount we're pinned only if the open state came from the sticky (not live
  // work — live work stays under auto control so it can auto-close when done).
  const pinnedRef = useRef<boolean>(!hasWork && initialSticky !== null)
  const prevEngagedRef = useRef<number>(engagedCount(summary))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    const prev = prevEngagedRef.current
    const now = engagedCount(summary)
    prevEngagedRef.current = now
    // KICKOFF — the live-or-in-flight count rose (a NEW plan/run/plain-card
    // started, incl. 0→1 and 1→2). Fresh work takes control back from any manual
    // pin and reveals itself.
    if (now > prev) {
      clearTimer()
      pinnedRef.current = false
      setOpen(true)
      return
    }
    // Still working, or a failure demanding attention → keep it open.
    if (now > 0 || summary.failed > 0) {
      clearTimer()
      return
    }
    // All clear. Auto-close after a settle, unless the user pinned it open.
    if (open && !pinnedRef.current && timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setOpen(false)
      }, autoCloseMs)
    }
  }, [summary.running, summary.failed, summary.active, open, autoCloseMs, clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  const toggle = useCallback(() => {
    clearTimer()
    setOpen((o) => {
      const next = !o
      pinnedRef.current = true
      writeSticky(projectId, next)
      return next
    })
  }, [projectId, clearTimer])

  return { open, toggle }
}

/** The count chip in the pane header: "2 running" / "1 failed" / "1 active" / nothing. */
function headerCount(summary: WorkBoardSummary): { text: string; dot: string } | null {
  if (summary.running > 0) {
    return { text: `${summary.running} running`, dot: 'cwb-dot-build' }
  }
  if (summary.failed > 0) {
    return { text: `${summary.failed} failed`, dot: 'cwb-dot-failed' }
  }
  if (summary.active > 0) {
    // #379 — a plain in-flight card (in_progress / inline_active, no bound run).
    return { text: `${summary.active} active`, dot: 'cwb-dot-build' }
  }
  return null
}

export function PlansPane({
  projectId,
  config,
  controller,
  fetchImpl,
  onOpenDoc,
  onOpenChange,
  autoCloseMs,
}: {
  projectId: string
  config: BootstrapConfig
  controller: NeutronChatController
  fetchImpl?: FetchImpl
  onOpenDoc?: (projectId: string, path: string) => void
  /** Report the open state up to the shell so it can size the grid column
   *  (chat shrinks) in lock-step with the panel's slide. */
  onOpenChange?: (open: boolean) => void
  /** Test seam — override the auto-close settle. */
  autoCloseMs?: number
}): React.JSX.Element {
  const [summary, setSummary] = useState<WorkBoardSummary>({ running: 0, failed: 0, active: 0 })
  const onSummary = useCallback((s: WorkBoardSummary) => setSummary(s), [])
  const { open, toggle } = usePlansPaneController(
    projectId,
    summary,
    autoCloseMs ?? AUTO_CLOSE_MS,
  )

  // Keep the shell's grid column in sync with the panel's open state.
  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  const count = headerCount(summary)

  return (
    <div className={`car-plans-col${open ? ' car-plans-open' : ''}`}>
      {/* The ONLY manual control — an edge-handle riding the pane's left seam.
          No toggle button, no X, no close chevron anywhere (Ryan's sign-off). */}
      <button
        type="button"
        className="car-plans-handle"
        aria-label={open ? 'Hide work' : 'Show work'}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="car-plans-handle-glyph" aria-hidden="true">
          {open ? '›' : '‹'}
        </span>
      </button>
      <aside className="car-plans" aria-label="Work">
        <header className="car-plans-head">
          <span className="car-plans-ttl">Work</span>
          {count !== null ? (
            <span className="car-plans-cnt">
              <span className={`cwb-dot ${count.dot}`} aria-hidden="true" />
              {count.text}
            </span>
          ) : null}
        </header>
        <WorkBoardTab
          projectId={projectId}
          config={config}
          liveSource={controller}
          onSummary={onSummary}
          {...(fetchImpl !== undefined ? { fetchImpl } : {})}
          {...(onOpenDoc !== undefined ? { onOpenDoc } : {})}
        />
      </aside>
    </div>
  )
}
