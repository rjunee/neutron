/**
 * landing/chat-react — web WORK tab content (M1 UX redesign).
 *
 * The live work-tracking view for the web project shell: the project's board —
 * what's in progress / next at the top, the completed history collapsed at the
 * bottom — rendered as the builtin `work_board` tab (user-facing label "Work")
 * inside `ProjectShell`, the sibling of `DocumentsTab`.
 *
 * ── Distinct from Tasks ─────────────────────────────────────────────────────
 * Tasks are editable CARDS with priority/due chips. The Work list is FLAT
 * one-line rows: `[dot] title … [phase tag] [round] [hover actions]`. No cards,
 * no chips. It's the orchestrator's external memory made visible.
 *
 * ── M1 REDESIGN (Ryan signed-off 2026-07-02) ────────────────────────────────
 * Each row leads with a 9px status DOT that reflects the build lifecycle: a
 * faint gray outline before a build starts, a colored PULSING dot while a bound
 * trident run walks building → reviewing → fixing → merging (the pulse is in the
 * phase TAG's colour), a solid red dot on failure, a solid green dot when done.
 * A small typographic phase TAG (Building / Reviewing / Fixing / Merging /
 * Merged / Didn't finish) + a muted `round N` trail the title; there is NO
 * elapsed-minutes timer and NO emoji-glyph status noise (both deleted — the dot
 * + tag carry that signal). Completed items collapse under a "Done · N"
 * disclosure (default closed) and show a "Merged · Jul 2" datestamp. Rows
 * reorder by DRAG (a ⠿ grip; arrow-keys on the grip for keyboard parity) instead
 * of ▲▼ arrows; delete asks to confirm first; ▶ starts a not-yet-started card
 * and ↻ retries a failed one. The add-something-to-do affordance lives at the
 * BOTTOM of the active/upcoming items, ABOVE the collapsible "Done · N" section
 * (#344).
 *
 * ── Order is the engine's ───────────────────────────────────────────────────
 * The store returns active+next first (by `sort_order`) then completed
 * (reverse-chron). The tab NEVER re-sorts — it splits the snapshot by status and
 * renders each lane in the order the server gave. A live `work_board_changed`
 * frame carries the SAME full snapshot, so applying it is a drop-in replacement
 * for a re-fetch (idempotent, order-independent).
 *
 * ── Human read + WRITE (Ryan-locked) ────────────────────────────────────────
 * The owner can add / edit / advance / reorder / delete / ▶-start — every action
 * hits the SAME canonical `WorkBoardStore` the agent's `work_board_*` tools use,
 * so a human write fires the same live push the agent's does.
 *
 * ── Live updates ────────────────────────────────────────────────────────────
 * Subscribes to the controller's `onWorkBoardChanged` (the parsed
 * `work_board_changed` frame). PR-1's tick fan now pushes a fresh snapshot on
 * every inner-step checkpoint (forge-done → reviewing, fix-round-N → building,
 * argus-approved → merging), so the dot + tag walk live; the 15s poll is a
 * fallback for a dropped frame. The dot pulse is CSS-only + gated by
 * `prefers-reduced-motion` (see `cwb-` styles in chat-react.html).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BootstrapConfig } from './config.ts'
import {
  WebWorkBoardClient,
  docLinkLabel,
  docPathFromDesignRef,
  resolveStepLabel,
  type RunPhaseLabel,
  type RunProgress,
  type WorkBoardItem,
  type WorkBoardStatus,
} from './work-board-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The minimal slice of the controller the tab needs: a subscription to live
 * board snapshots. Typed as an interface (not the concrete controller) so the
 * tab unit-tests with a tiny fake — or `null` for the no-live-source case.
 */
export interface WorkBoardLiveSource {
  onWorkBoardChanged(
    fn: (items: WorkBoardItem[], projectId: string | undefined) => void,
  ): () => void
}

/** Cycle an item's status forward: upcoming → in_progress → done. A failed item
 *  re-queues to upcoming on manual advance (the primary action is the ▶/↻ retry). */
function nextStatus(status: WorkBoardStatus): WorkBoardStatus {
  if (status === 'upcoming') return 'in_progress'
  if (status === 'in_progress') return 'done'
  if (status === 'failed') return 'upcoming'
  return 'done'
}

/** Human status label (a11y on the advance dot). */
function statusLabel(status: WorkBoardStatus): string {
  if (status === 'in_progress') return 'In progress'
  if (status === 'done') return 'Done'
  if (status === 'failed') return 'Failed'
  return 'Upcoming'
}

const TERMINAL_PHASE_LABELS: readonly RunPhaseLabel[] = ['merged', 'failed', 'cancelled']

/** True when the item is bound to a run that is still live (not terminal). */
function isLinkedRunning(item: WorkBoardItem): boolean {
  const linked = item.linked_run_id !== null && item.linked_run_id.length > 0
  if (!linked) return false
  const rp = item.run_progress
  return rp === undefined || !TERMINAL_PHASE_LABELS.includes(rp.phase_label)
}

/**
 * True when the ▶/↻ (start/retry) control should render: the item is NOT
 * in_progress and NOT done and has NO live linked run. That's an `upcoming` card
 * that has never been dispatched (START) OR whose last build failed/stopped
 * (RETRY). A live build shows the dot pulse + the X-cancel instead.
 */
function canPlay(item: WorkBoardItem): boolean {
  return item.status !== 'in_progress' && item.status !== 'done' && !isLinkedRunning(item)
}

/** ▶ vs ↻ — a card that carries a (now-detached) binding or a failed run RETRIES. */
function isRetry(item: WorkBoardItem): boolean {
  if (item.linked_run_id !== null && item.linked_run_id.length > 0) return true
  return item.run_progress?.step_label === 'failed'
}

/* ── M1 redesign — dot / tag / round derivations ─────────────────────────── */

interface PhaseTag {
  label: string
  cls: string
}

/**
 * The phase TAG for a bound run's inner step, or null when the item has no run
 * progress (a plain upcoming card shows just the gray dot + title). Sentence-case
 * copy, tinted capsule; failure uses the Alina-friendly "Didn't finish".
 */
function stepTag(rp: RunProgress | undefined): PhaseTag | null {
  if (rp === undefined) return null
  switch (resolveStepLabel(rp)) {
    case 'building':
      return { label: 'Building', cls: 'cwb-tag-build' }
    case 'reviewing':
      return { label: 'Reviewing', cls: 'cwb-tag-review' }
    case 'fixing':
      return { label: 'Fixing', cls: 'cwb-tag-fix' }
    case 'merging':
      return { label: 'Merging', cls: 'cwb-tag-merge' }
    case 'done':
      return { label: 'Merged', cls: 'cwb-tag-merge' }
    case 'failed':
      return { label: 'Failed', cls: 'cwb-tag-failed' }
  }
}

/** The failure-reason one-liner (#340) — shown on a failed item's meta line so
 *  the owner sees WHY it failed (a merge conflict question, a hang, exhausted
 *  rounds) without opening anything. Null unless the bound run is in the failed
 *  step. */
function failureReasonText(rp: RunProgress | undefined): string | null {
  if (rp === undefined || resolveStepLabel(rp) !== 'failed') return null
  const reason = rp.failure_reason
  return reason !== null && reason.length > 0 ? reason : null
}

interface DotState {
  cls: string
  pulse: boolean
}

/**
 * The leading dot's colour class + whether it pulses. A live run's step drives
 * the colour (pulsing while building/reviewing/fixing/merging, solid on
 * done/failed); otherwise it falls back to the item's status (done → green,
 * in_progress → running blue, upcoming → faint gray outline).
 */
function dotState(item: WorkBoardItem): DotState {
  const rp = item.run_progress
  if (rp !== undefined) {
    switch (resolveStepLabel(rp)) {
      case 'building':
        return { cls: 'cwb-dot-build', pulse: true }
      case 'reviewing':
        return { cls: 'cwb-dot-review', pulse: true }
      case 'fixing':
        return { cls: 'cwb-dot-fix', pulse: true }
      case 'merging':
        return { cls: 'cwb-dot-merge', pulse: true }
      case 'done':
        return { cls: 'cwb-dot-done', pulse: false }
      case 'failed':
        return { cls: 'cwb-dot-failed', pulse: false }
    }
  }
  if (item.status === 'done') return { cls: 'cwb-dot-done', pulse: false }
  if (item.status === 'in_progress') return { cls: 'cwb-dot-build', pulse: true }
  return { cls: 'cwb-dot-upcoming', pulse: false }
}

/** `round N` for a live (non-terminal) run; null once merged/failed or when idle. */
function roundText(rp: RunProgress | undefined): string | null {
  if (rp === undefined) return null
  const step = resolveStepLabel(rp)
  if (step === 'done' || step === 'failed') return null
  return `round ${rp.round}`
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
] as const

/** Short "Jul 2" datestamp for a completed row; '' when unparseable. */
function formatCompletedShort(completed_at: string | null): string {
  if (completed_at === null || completed_at.length === 0) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(completed_at)
  if (m === null) return ''
  const month = MONTHS[Number(m[2]) - 1] ?? m[2]
  return `${month} ${Number(m[3])}`
}

/**
 * A live-activity roll-up of the board, consumed by the desktop slide-out pane
 * (PR-4) to drive its header count + auto-open/close: `running` = items bound to
 * a live (non-terminal) run; `failed` = items whose last run didn't finish. The
 * pane opens when `running` rises, stays open while `running > 0` or `failed >
 * 0`, and auto-closes only once BOTH are zero (all merged/cancelled). Pure so it
 * unit-tests directly.
 */
export interface WorkBoardSummary {
  running: number
  failed: number
}

export function summarize(items: readonly WorkBoardItem[]): WorkBoardSummary {
  let running = 0
  let failed = 0
  for (const it of items) {
    if (isLinkedRunning(it)) {
      running += 1
    } else if (it.run_progress !== undefined && resolveStepLabel(it.run_progress) === 'failed') {
      failed += 1
    }
  }
  return { running, failed }
}

export function WorkBoardTab({
  projectId,
  config,
  liveSource,
  fetchImpl,
  onOpenDoc,
  onSummary,
}: {
  projectId: string
  config: BootstrapConfig
  /** Live `work_board_changed` source (the controller). Optional for tests. */
  liveSource?: WorkBoardLiveSource | null
  /** Injected in tests; defaults to the global fetch inside the client. */
  fetchImpl?: FetchImpl
  /** Open a project doc in the Documents tab (card ▸ spec-doc link). Optional —
   *  when absent, the doc link falls back to a non-navigating label. */
  onOpenDoc?: (projectId: string, path: string) => void
  /** PR-4 — report a live-activity roll-up ({@link WorkBoardSummary}) on every
   *  board change, so the desktop slide-out pane can drive its header count and
   *  auto-open/close. Memoize the callback (else it fires every render). */
  onSummary?: (summary: WorkBoardSummary) => void
}): React.JSX.Element {
  const client = useMemo(
    () =>
      new WebWorkBoardClient(
        fetchImpl !== undefined
          ? { base_url: config.origin, token: config.token, fetchImpl }
          : { base_url: config.origin, token: config.token },
      ),
    [config.origin, config.token, fetchImpl],
  )

  const [items, setItems] = useState<WorkBoardItem[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [completedOpen, setCompletedOpen] = useState(false)

  // Add composer (bottom of the active items, above Done — #344).
  const [newTitle, setNewTitle] = useState('')
  const [adding, setAdding] = useState(false)

  // Inline edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  // Per-row in-flight guard so a double-click can't fire two mutations.
  const [busyId, setBusyId] = useState<string | null>(null)

  // The item pending delete-confirmation (null = no dialog open).
  const [confirmDelete, setConfirmDelete] = useState<WorkBoardItem | null>(null)

  // Drag-to-reorder state: the row being dragged + the row it's hovering over.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // Monotonic guard so a slow list fetch can't land after a newer one (rapid
  // project switches / StrictMode double-invoke).
  const listSeq = useMemo(() => ({ current: 0 }), [])

  // `quiet` (background poll) skips the loading flip so a periodic refetch never
  // flashes the "Loading…" placeholder over a populated board.
  const refresh = useCallback(
    (quiet = false): void => {
      const seq = (listSeq.current += 1)
      if (!quiet) setLoading(true)
      setListError(null)
      void client
        .list(projectId)
        .then((rows) => {
          if (seq !== listSeq.current) return
          setItems(rows)
          setLoading(false)
        })
        .catch((err: unknown) => {
          if (seq !== listSeq.current) return
          if (!quiet) {
            setItems([])
            setListError(err instanceof Error ? err.message : 'failed to load the board')
          }
          setLoading(false)
        })
    },
    [client, projectId, listSeq],
  )

  // Reset + load whenever the project changes. A stale board from project A must
  // never linger under project B's id.
  useEffect(() => {
    setItems([])
    setActionError(null)
    setNewTitle('')
    setEditingId(null)
    setBusyId(null)
    setConfirmDelete(null)
    setDragId(null)
    setDragOverId(null)
    refresh()
  }, [refresh, projectId])

  // Live snapshots — replace the list outright (full-snapshot, idempotent). The
  // controller replays the last snapshot synchronously to a late subscriber, so
  // a tab mounted after the frame still catches up. A NEW listSeq bump prevents
  // an in-flight initial fetch from clobbering a fresher live snapshot.
  useEffect(() => {
    if (liveSource === undefined || liveSource === null) return
    const unsub = liveSource.onWorkBoardChanged((next, framePid) => {
      // The app-ws topic is per-user, so a sibling project's board can arrive on
      // this socket. A frame's board is `framePid` (absent/empty ⇒ the General
      // board, whose projectId is ''); apply it ONLY when it matches THIS tab's
      // project, so a General/sibling board can't overwrite a per-project view.
      if ((framePid ?? '') !== projectId) return
      listSeq.current += 1
      setItems(next)
      setLoading(false)
    })
    return unsub
  }, [liveSource, projectId, listSeq])

  // While any item is bound to a LIVE (non-terminal) run, quietly re-poll the
  // board every 15s as a FALLBACK. PR-1's tick fan pushes a `work_board_changed`
  // snapshot on every inner-step checkpoint, so the dot + tag normally walk live;
  // this poll only covers a dropped frame / socket blip. Gated on a LIVE link
  // (via `isLinkedRunning`) so a finished/terminal run does NOT poll forever.
  const hasLiveRun = useMemo(() => items.some(isLinkedRunning), [items])

  // PR-4 — surface the live-activity roll-up to the desktop slide-out pane on
  // every board change (initial load, live snapshot, or poll). The pane keys its
  // auto-open/close + header count off this; `summarize` is pure so the effect
  // stays cheap.
  useEffect(() => {
    onSummary?.(summarize(items))
  }, [items, onSummary])
  useEffect(() => {
    if (!hasLiveRun) return
    const interval = setInterval(() => {
      refresh(true)
    }, 15_000)
    return () => clearInterval(interval)
  }, [hasLiveRun, refresh])

  const addItem = useCallback((): void => {
    const title = newTitle.trim()
    if (title.length === 0 || adding) return
    setAdding(true)
    setActionError(null)
    void client
      .create(projectId, { title })
      .then(() => {
        setAdding(false)
        setNewTitle('')
        refresh()
      })
      .catch((err: unknown) => {
        setAdding(false)
        setActionError(err instanceof Error ? err.message : 'failed to add item')
      })
  }, [client, projectId, newTitle, adding, refresh])

  const advanceStatus = useCallback(
    (item: WorkBoardItem): void => {
      if (busyId !== null) return
      const target = nextStatus(item.status)
      if (target === item.status) return
      setBusyId(item.id)
      setActionError(null)
      const op =
        target === 'done'
          ? client.complete(projectId, item.id)
          : client.update(projectId, item.id, { status: target })
      void op
        .then(() => {
          setBusyId(null)
          refresh()
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to update item')
        })
    },
    [client, projectId, busyId, refresh],
  )

  const saveEdit = useCallback(
    (item: WorkBoardItem): void => {
      const title = editTitle.trim()
      if (title.length === 0) {
        setEditingId(null)
        return
      }
      if (title === item.title) {
        setEditingId(null)
        return
      }
      setBusyId(item.id)
      setActionError(null)
      void client
        .update(projectId, item.id, { title })
        .then(() => {
          setBusyId(null)
          setEditingId(null)
          refresh()
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to rename item')
        })
    },
    [client, projectId, editTitle, refresh],
  )

  const removeItem = useCallback(
    (item: WorkBoardItem): void => {
      if (busyId !== null) return
      setBusyId(item.id)
      setActionError(null)
      void client
        .delete(projectId, item.id)
        .then(() => {
          setBusyId(null)
          refresh()
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to delete item')
        })
    },
    [client, projectId, busyId, refresh],
  )

  // ▶ START / ↻ RETRY — dispatch a build bound to this card, using its SAVED spec
  // (its plans/ doc, else its title). The card flips to a live build (dot pulse +
  // the run tag) on the next snapshot; we also poll (hasLiveRun). No confirm on
  // ▶ — starting is cheap + intended (RETRY re-uses the same spec).
  const startBuild = useCallback(
    (item: WorkBoardItem): void => {
      if (busyId !== null) return
      setBusyId(item.id)
      setActionError(null)
      void client
        .start(projectId, item.id)
        .then(() => {
          setBusyId(null)
          refresh()
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to start build')
        })
    },
    [client, projectId, busyId, refresh],
  )

  const openDoc = useCallback(
    (item: WorkBoardItem): void => {
      const path = docPathFromDesignRef(item.design_doc_ref)
      if (path !== null && onOpenDoc !== undefined) onOpenDoc(projectId, path)
    },
    [onOpenDoc, projectId],
  )

  // Item 4 — open the INLINE confirm (rendered within the item's own row, not a
  // screen-takeover modal) instead of deleting immediately. Prevents an
  // accidental click from cancelling an expensive running build. Only ONE row can
  // be in confirm state at a time (single `confirmDelete` state), so opening a
  // second confirm cancels the first.
  const requestRemove = useCallback(
    (item: WorkBoardItem): void => {
      if (busyId !== null) return
      setConfirmDelete(item)
    },
    [busyId],
  )
  const cancelRemove = useCallback((): void => setConfirmDelete(null), [])
  const confirmRemove = useCallback(
    (item: WorkBoardItem): void => {
      setConfirmDelete(null)
      removeItem(item)
    },
    [removeItem],
  )

  const active = items.filter((it) => it.status !== 'done')
  const completed = items.filter((it) => it.status === 'done')

  // Drag-to-reorder — persist via the existing reorder route. Dropping the
  // dragged row onto a neighbor places it before (dragging up) or after (dragging
  // down) that neighbor, mirroring the old ▲▼ semantics. Bounds + no-ops are
  // handled by the before/after computation (a drop on itself is a no-op).
  const reorderTo = useCallback(
    (sourceId: string, targetId: string): void => {
      if (busyId !== null || sourceId === targetId) return
      const from = active.findIndex((a) => a.id === sourceId)
      const to = active.findIndex((a) => a.id === targetId)
      if (from < 0 || to < 0 || from === to) return
      const where = from < to ? { after: targetId } : { before: targetId }
      setBusyId(sourceId)
      setActionError(null)
      void client
        .reorder(projectId, sourceId, where)
        .then(() => {
          setBusyId(null)
          refresh()
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to reorder item')
        })
    },
    [active, busyId, client, projectId, refresh],
  )

  // Keyboard reorder (arrow keys on the drag grip) — a11y parity for the removed
  // ▲▼ buttons. Move the active item at `index` by `dir` (-1 up / +1 down).
  const moveByKey = useCallback(
    (index: number, dir: -1 | 1): void => {
      const target = index + dir
      if (target < 0 || target >= active.length) return
      const item = active[index]
      const neighbor = active[target]
      if (item === undefined || neighbor === undefined) return
      reorderTo(item.id, neighbor.id)
    },
    [active, reorderTo],
  )

  // Item #344 — the add-something-to-do composer now sits at the BOTTOM of the
  // active/upcoming items and ABOVE the collapsible "Done · N" section (it used
  // to be a pinned footer BELOW Done). Rendered in-flow so it scrolls with the
  // list; shared between the populated and empty branches.
  const addForm = (
    <form
      className="cwb-add"
      onSubmit={(e) => {
        e.preventDefault()
        addItem()
      }}
    >
      <input
        className="cwb-add-input"
        placeholder="Add something to do…"
        value={newTitle}
        onChange={(e) => setNewTitle(e.target.value)}
        aria-label="New work item"
      />
      <button
        type="submit"
        className="cwb-btn cwb-btn-primary"
        disabled={adding || newTitle.trim().length === 0}
      >
        {adding ? 'Adding…' : 'Add'}
      </button>
    </form>
  )

  return (
    <div className="cwb">
      {actionError !== null ? <div className="cwb-error">{actionError}</div> : null}

      <div className="cwb-list" aria-label="Work">
        {loading ? (
          <div className="cwb-empty">Loading…</div>
        ) : listError !== null ? (
          <div className="cwb-empty">{listError}</div>
        ) : active.length === 0 && completed.length === 0 ? (
          <>
            <div className="cwb-empty cwb-empty-zero">
              No work tracked yet. Ask Neutron to start something, or add an item.
            </div>
            {addForm}
          </>
        ) : (
          <>
            <ul className="cwb-ul" aria-label="Active and upcoming">
              {active.map((it, i) => (
                <WorkBoardRow
                  key={it.id}
                  item={it}
                  busy={busyId === it.id}
                  editing={editingId === it.id}
                  editTitle={editTitle}
                  index={i}
                  laneCount={active.length}
                  dragging={dragId === it.id}
                  dragOver={dragOverId === it.id && dragId !== it.id}
                  onAdvance={() => advanceStatus(it)}
                  onStartEdit={() => {
                    setEditingId(it.id)
                    setEditTitle(it.title)
                  }}
                  onChangeEdit={setEditTitle}
                  onSaveEdit={() => saveEdit(it)}
                  onCancelEdit={() => setEditingId(null)}
                  onRemove={() => requestRemove(it)}
                  confirming={confirmDelete?.id === it.id}
                  onConfirmRemove={() => confirmRemove(it)}
                  onCancelRemove={cancelRemove}
                  onPlay={() => startBuild(it)}
                  onDragStart={() => setDragId(it.id)}
                  onDragEnterRow={() => {
                    if (dragId !== null && dragId !== it.id) setDragOverId(it.id)
                  }}
                  onDropRow={() => {
                    if (dragId !== null) reorderTo(dragId, it.id)
                    setDragId(null)
                    setDragOverId(null)
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setDragOverId(null)
                  }}
                  onMoveUp={() => moveByKey(i, -1)}
                  onMoveDown={() => moveByKey(i, 1)}
                  {...(onOpenDoc !== undefined ? { onOpenDoc: () => openDoc(it) } : {})}
                />
              ))}
            </ul>

            {/* #344 — add box at the bottom of active items, ABOVE Done. */}
            {addForm}

            {completed.length > 0 ? (
              <div className="cwb-completed">
                <button
                  type="button"
                  className="cwb-completed-toggle"
                  aria-expanded={completedOpen}
                  onClick={() => setCompletedOpen((v) => !v)}
                >
                  <span className="cwb-completed-caret">{completedOpen ? '▾' : '▸'}</span>
                  Done · {completed.length}
                </button>
                {completedOpen ? (
                  <ul className="cwb-ul cwb-completed-ul" aria-label="Done">
                    {completed.map((it) => (
                      <li key={it.id} className="cwb-row cwb-row-done">
                        <div className="cwb-row-line1">
                          <span className="cwb-dot cwb-dot-done" aria-label="Done" />
                          <span className="cwb-title" title={it.title}>
                            {it.title}
                          </span>
                          {confirmDelete?.id === it.id ? (
                            <InlineConfirm
                              running={false}
                              onConfirm={() => confirmRemove(it)}
                              onCancel={cancelRemove}
                            />
                          ) : (
                            <button
                              type="button"
                              className="cwb-btn cwb-btn-icon"
                              onClick={() => requestRemove(it)}
                              disabled={busyId === it.id}
                              title="Delete item"
                              aria-label="Delete item"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        {/* A completed row always carries its "Merged · <date>" on line 2. */}
                        <div className="cwb-row-meta">
                          <span className="cwb-date">
                            Merged · {formatCompletedShort(it.completed_at)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function WorkBoardRow({
  item,
  busy,
  editing,
  editTitle,
  index,
  laneCount,
  dragging,
  dragOver,
  onAdvance,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
  onRemove,
  confirming,
  onConfirmRemove,
  onCancelRemove,
  onPlay,
  onOpenDoc,
  onDragStart,
  onDragEnterRow,
  onDropRow,
  onDragEnd,
  onMoveUp,
  onMoveDown,
}: {
  item: WorkBoardItem
  busy: boolean
  editing: boolean
  editTitle: string
  index: number
  laneCount: number
  dragging: boolean
  dragOver: boolean
  onAdvance: () => void
  onStartEdit: () => void
  onChangeEdit: (v: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onRemove: () => void
  /** Item 4 — this row is showing its inline delete-confirm strip. */
  confirming: boolean
  /** Confirm the delete (fires the DELETE / cancels a linked run per #174). */
  onConfirmRemove: () => void
  /** Dismiss the inline confirm without deleting. */
  onCancelRemove: () => void
  /** ▶/↻ — START/RETRY a build from the card's saved spec. */
  onPlay: () => void
  /** Open the card's linked spec-doc in the Documents tab; undefined = no nav. */
  onOpenDoc?: () => void
  onDragStart: () => void
  onDragEnterRow: () => void
  onDropRow: () => void
  onDragEnd: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}): React.JSX.Element {
  const dot = dotState(item)
  const tag = stepTag(item.run_progress)
  const round = roundText(item.run_progress)
  const failReason = failureReasonText(item.run_progress)
  const docLabel = docLinkLabel(item.design_doc_ref)
  const showPlay = canPlay(item)
  const retry = isRetry(item)

  // Item 4 — the phase TAG (+ round) moves to a SECOND line, muted, but ONLY when
  // the item has a run to report on. A bare queued/not-started card (no bound run
  // → no tag) stays single-line: just the title. `hasStatus` gates the meta line.
  const hasStatus = tag !== null

  // Item 2 (a11y) — when the inline confirm closes via Cancel, return focus to the
  // ✕ that opened it (on Confirm the row unmounts, so this is a no-op there).
  const deleteBtnRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(confirming)
  useEffect(() => {
    if (wasConfirming.current && !confirming) deleteBtnRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  return (
    <li
      className={`cwb-row cwb-row-${item.status}${dragging ? ' cwb-row-dragging' : ''}${dragOver ? ' cwb-row-dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        onDragEnterRow()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropRow()
      }}
    >
      <div className="cwb-row-line1">
        <button
          type="button"
          className={`cwb-dot ${dot.cls}${dot.pulse ? ' cwb-dot-pulse' : ''}`}
          onClick={onAdvance}
          disabled={busy}
          title={`${statusLabel(item.status)} — advance`}
          aria-label={`${statusLabel(item.status)}. Advance status`}
        />
        {editing ? (
          <input
            className="cwb-edit-input"
            value={editTitle}
            autoFocus
            onChange={(e) => onChangeEdit(e.target.value)}
            onBlur={onSaveEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSaveEdit()
              else if (e.key === 'Escape') onCancelEdit()
            }}
            aria-label="Edit item title"
          />
        ) : (
          <span className="cwb-title-col">
            <button
              type="button"
              className="cwb-title cwb-title-btn"
              onClick={onStartEdit}
              title={item.title}
            >
              {item.title}
            </button>
            {docLabel !== null ? (
              onOpenDoc !== undefined ? (
                <button
                  type="button"
                  className="cwb-doc-link"
                  onClick={onOpenDoc}
                  title={`Open spec: ${docLabel}`}
                  aria-label={`Open spec doc: ${docLabel}`}
                >
                  📄 {docLabel}
                </button>
              ) : (
                <span className="cwb-doc-link cwb-doc-link-static" title={`Spec: ${docLabel}`}>
                  📄 {docLabel}
                </span>
              )
            ) : null}
          </span>
        )}
        {confirming ? (
          <InlineConfirm
            running={isLinkedRunning(item)}
            onConfirm={onConfirmRemove}
            onCancel={onCancelRemove}
          />
        ) : (
          <div className="cwb-actions">
            <button
              type="button"
              className="cwb-drag"
              draggable
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  onMoveUp()
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  onMoveDown()
                }
              }}
              disabled={busy}
              title="Drag to reorder"
              aria-label={`Reorder ${item.title}. Item ${index + 1} of ${laneCount}. Use arrow keys to move.`}
            >
              ⠿
            </button>
            {showPlay ? (
              <button
                type="button"
                className="cwb-btn cwb-btn-icon cwb-btn-play"
                onClick={onPlay}
                disabled={busy}
                title={retry ? 'Retry build' : 'Start build'}
                aria-label={retry ? 'Retry build' : 'Start build'}
              >
                {retry ? '↻' : '▶'}
              </button>
            ) : null}
            <button
              ref={deleteBtnRef}
              type="button"
              className="cwb-btn cwb-btn-icon"
              onClick={onRemove}
              disabled={busy}
              title="Delete item"
              aria-label="Delete item"
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {hasStatus ? (
        <div className="cwb-row-meta">
          {tag !== null ? <span className={`cwb-tag ${tag.cls}`}>{tag.label}</span> : null}
          {round !== null ? <span className="cwb-round">{round}</span> : null}
          {failReason !== null ? (
            <span className="cwb-fail-reason" title={failReason}>
              {failReason}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * Item 4 (item 2 in the redesign polish) — the INLINE delete confirm, rendered
 * WITHIN a work-board row's own line 1 (no backdrop, no `aria-modal`, no screen
 * takeover — the rest of the board stays visible + interactive). A `role="group"`
 * cluster: a short prompt + Cancel + a destructive Remove. Autofocuses Cancel on
 * open (the safe default) and Escape cancels; the row restores focus to its ✕ on
 * dismiss. Only one row is ever in confirm state (single `confirmDelete`).
 */
function InlineConfirm({
  running,
  onConfirm,
  onCancel,
}: {
  running: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  return (
    <div
      className="cwb-confirm-inline"
      role="group"
      aria-label="Confirm remove"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <span className="cwb-confirm-inline-msg">{running ? 'Cancel build?' : 'Remove?'}</span>
      <button ref={cancelRef} type="button" className="cwb-btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="cwb-btn cwb-btn-danger" onClick={onConfirm}>
        {running ? 'Cancel & remove' : 'Remove'}
      </button>
    </div>
  )
}
