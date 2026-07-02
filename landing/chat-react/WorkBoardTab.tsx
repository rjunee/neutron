/**
 * landing/chat-react — web WORK BOARD tab content (Work Board Phase 1b).
 *
 * The live work-tracking view for the web project shell: the project's board —
 * what's in progress / next at the top, the completed history collapsed at the
 * bottom — rendered as the builtin `work_board` tab inside `ProjectShell`, the
 * sibling of `TasksTab` / `DocumentsTab`.
 *
 * ── Distinct from Tasks ─────────────────────────────────────────────────────
 * Tasks are editable CARDS with priority/due chips. The Work Board is FLAT
 * one-line rows: a status dot + (when active) an activity glyph + the one-line
 * title. No cards, no chips. It's the orchestrator's external memory made
 * visible, not a to-do manager.
 *
 * ── Order is the engine's ───────────────────────────────────────────────────
 * The store returns active+next first (by `sort_order`) then completed
 * (reverse-chron). The tab NEVER re-sorts — it splits the snapshot by status and
 * renders each lane in the order the server gave. A live `work_board_changed`
 * frame carries the SAME full snapshot, so applying it is a drop-in replacement
 * for a re-fetch (idempotent, order-independent).
 *
 * ── Human read + WRITE (Ryan-locked) ────────────────────────────────────────
 * The owner can add / edit (inline title) / advance status / reorder / delete —
 * every action hits the SAME canonical `WorkBoardStore` the agent's
 * `work_board_*` tools use, so a human write fires the same live push the agent's
 * does. After a mutation the live frame refreshes every device; we also apply the
 * returned row optimistically so the acting device feels instant.
 *
 * ── Live updates ────────────────────────────────────────────────────────────
 * Subscribes to the controller's `onWorkBoardChanged` (the parsed
 * `work_board_changed` frame). Full snapshot, so we replace the list outright. A
 * subtle row flash on change + a live pulse on the active dot are CSS-only and
 * gated by `prefers-reduced-motion` (see `cwb-` styles in chat-react.html).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { BootstrapConfig } from './config.ts'
import {
  WebWorkBoardClient,
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

/** Cycle an item's status forward: upcoming → in_progress → done. */
function nextStatus(status: WorkBoardStatus): WorkBoardStatus {
  if (status === 'upcoming') return 'in_progress'
  if (status === 'in_progress') return 'done'
  return 'done'
}

/** The accessible label + glyph for a row's status dot. */
function statusMeta(status: WorkBoardStatus): { cls: string; label: string } {
  if (status === 'in_progress') return { cls: 'cwb-dot-active', label: 'In progress' }
  if (status === 'done') return { cls: 'cwb-dot-done', label: 'Done' }
  return { cls: 'cwb-dot-upcoming', label: 'Upcoming' }
}

/**
 * The activity glyph for an ACTIVE item, or null when idle. A bound trident run
 * (`linked_run_id`) is a sub-agent (fork `⑂`); an `inline_active` marker is
 * in-topic work (caret `›`). Distinguished by glyph + aria-label, NOT color.
 */
function activityGlyph(item: WorkBoardItem): { glyph: string; label: string } | null {
  if (item.linked_run_id !== null && item.linked_run_id.length > 0) {
    return { glyph: '⑂', label: 'Sub-agent running' }
  }
  if (item.inline_active) {
    return { glyph: '›', label: 'Working inline' }
  }
  return null
}

/** Short UTC datestamp (YYYY-MM-DD) for a completed row; '' when unparseable. */
function formatCompleted(completed_at: string | null): string {
  if (completed_at === null || completed_at.length === 0) return ''
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(completed_at)
  return m !== null ? (m[1] as string) : completed_at
}

/* ── Item 1: live run-progress sub-label ─────────────────────────────────── */

/** Display warn threshold (mirror of `trident/run-progress.ts` STALLED_WARN_MS). */
const STALLED_WARN_MS = 10 * 60_000

const PHASE_GLYPH: Record<RunPhaseLabel, string> = {
  planning: '📝',
  building: '🔨',
  reviewing: '🔍',
  merged: '✅',
  failed: '⚠️',
  cancelled: '🚫',
}

const TERMINAL_PHASE_LABELS: readonly RunPhaseLabel[] = ['merged', 'failed', 'cancelled']

/** Compact `1m` / `4m` / `1h 5m` duration; `<1m` under a minute. */
function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000)
  if (totalMin < 1) return '<1m'
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * The compact sub-label for a bound run — e.g. "🔨 building · round 1 · 4m",
 * "🔍 reviewing · round 2 · 6m", "✅ merged · PR #7", "⚠️ failed". Elapsed +
 * stall ticks live off the run's timestamps (`nowMs`) between server polls.
 */
function runProgressText(rp: RunProgress, nowMs: number): string {
  const startedMs = Date.parse(rp.started_at)
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : rp.elapsed_ms
  const advancedMs = Date.parse(rp.last_advanced_at)
  const sinceAdvance = Number.isFinite(advancedMs) ? Math.max(0, nowMs - advancedMs) : rp.stalled_ms ?? 0
  const terminal = TERMINAL_PHASE_LABELS.includes(rp.phase_label)
  const stalled = !terminal && (rp.stalled || sinceAdvance > STALLED_WARN_MS)

  const parts: string[] = [`${PHASE_GLYPH[rp.phase_label]} ${rp.phase_label}`]
  if (rp.phase_label === 'merged') {
    if (rp.pr !== null) parts.push(`PR #${rp.pr}`)
  } else if (!terminal) {
    parts.push(`round ${rp.round}`)
    parts.push(formatDuration(elapsed))
  }
  let text = parts.join(' · ')
  if (stalled) text += ` · ⚠️ stalled ${formatDuration(sinceAdvance)}`
  return text
}

/** True when the item is bound to a run that is still live (not terminal). */
function isLinkedRunning(item: WorkBoardItem): boolean {
  const linked = item.linked_run_id !== null && item.linked_run_id.length > 0
  if (!linked) return false
  const rp = item.run_progress
  return rp === undefined || !TERMINAL_PHASE_LABELS.includes(rp.phase_label)
}

export function WorkBoardTab({
  projectId,
  config,
  liveSource,
  fetchImpl,
}: {
  projectId: string
  config: BootstrapConfig
  /** Live `work_board_changed` source (the controller). Optional for tests. */
  liveSource?: WorkBoardLiveSource | null
  /** Injected in tests; defaults to the global fetch inside the client. */
  fetchImpl?: FetchImpl
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

  // Add composer.
  const [newTitle, setNewTitle] = useState('')
  const [adding, setAdding] = useState(false)

  // Inline edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  // Per-row in-flight guard so a double-click can't fire two mutations.
  const [busyId, setBusyId] = useState<string | null>(null)

  // Item 4 — the item pending delete-confirmation (null = no dialog open).
  const [confirmDelete, setConfirmDelete] = useState<WorkBoardItem | null>(null)

  // Item 1 — a ticking clock so a bound run's elapsed/stall sub-label advances
  // live between server polls. Only runs while a run is linked (see the effect).
  const [nowTick, setNowTick] = useState<number>(() => Date.now())

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
      // this socket; drop a snapshot that names a DIFFERENT project (a frame with
      // no project_id is treated as "this project" — single-project instances).
      if (framePid !== undefined && framePid.length > 0 && framePid !== projectId) return
      listSeq.current += 1
      setItems(next)
      setLoading(false)
    })
    return unsub
  }, [liveSource, projectId, listSeq])

  // Item 1 — while any item is bound to a LIVE (non-terminal) run, tick a clock
  // (for the live elapsed/stall sub-label) AND quietly re-poll the board every
  // 15s. Intermediate trident checkpoints (forge-done → reviewing, fix-round-N →
  // building) don't mutate the board row, so they don't fire a
  // `work_board_changed` push; the poll is what surfaces those phase/round/stall
  // changes live. Gated on a LIVE link (via `isLinkedRunning`, not merely a
  // present `linked_run_id`) so a finished/terminal linked run does NOT poll
  // forever (Codex review [P2]).
  const hasLiveRun = useMemo(() => items.some(isLinkedRunning), [items])
  useEffect(() => {
    if (!hasLiveRun) return
    const interval = setInterval(() => {
      setNowTick(Date.now())
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

  // Move an active item up/down by reordering it before/after its neighbor in
  // the active lane. A no-op at the lane edge.
  const move = useCallback(
    (active: WorkBoardItem[], index: number, dir: -1 | 1): void => {
      if (busyId !== null) return
      const target = index + dir
      if (target < 0 || target >= active.length) return
      const item = active[index]!
      const neighbor = active[target]!
      setBusyId(item.id)
      setActionError(null)
      const where = dir === -1 ? { before: neighbor.id } : { after: neighbor.id }
      void client
        .reorder(projectId, item.id, where)
        .then(() => {
          setBusyId(null)
          refresh()
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to reorder item')
        })
    },
    [client, projectId, busyId, refresh],
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

  // Item 4 — open the confirm dialog instead of deleting immediately. Prevents
  // an accidental click from cancelling an expensive running build.
  const requestRemove = useCallback(
    (item: WorkBoardItem): void => {
      if (busyId !== null) return
      setConfirmDelete(item)
    },
    [busyId],
  )

  const active = items.filter((it) => it.status !== 'done')
  const completed = items.filter((it) => it.status === 'done')

  return (
    <div className="cwb">
      <header className="cwb-head">
        <form
          className="cwb-add"
          onSubmit={(e) => {
            e.preventDefault()
            addItem()
          }}
        >
          <input
            className="cwb-add-input"
            placeholder="Add an item…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            aria-label="New work item title"
          />
          <button
            type="submit"
            className="cwb-btn cwb-btn-primary"
            disabled={adding || newTitle.trim().length === 0}
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
      </header>

      {actionError !== null ? <div className="cwb-error">{actionError}</div> : null}

      {confirmDelete !== null ? (
        <div
          className="cwb-confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm delete"
          onClick={() => setConfirmDelete(null)}
        >
          <div className="cwb-confirm" onClick={(e) => e.stopPropagation()}>
            <p className="cwb-confirm-msg">
              {isLinkedRunning(confirmDelete)
                ? 'Cancel this build and remove it?'
                : 'Remove this item?'}
            </p>
            <div className="cwb-confirm-actions">
              <button type="button" className="cwb-btn" onClick={() => setConfirmDelete(null)}>
                Keep
              </button>
              <button
                type="button"
                className="cwb-btn cwb-btn-danger"
                onClick={() => {
                  const item = confirmDelete
                  setConfirmDelete(null)
                  removeItem(item)
                }}
              >
                {isLinkedRunning(confirmDelete) ? 'Cancel build & remove' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="cwb-list" aria-label="Work Board">
        {loading ? (
          <div className="cwb-empty">Loading…</div>
        ) : listError !== null ? (
          <div className="cwb-empty">{listError}</div>
        ) : active.length === 0 && completed.length === 0 ? (
          <div className="cwb-empty cwb-empty-zero">
            No work tracked yet. Ask Neutron to start something, or add an item.
          </div>
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
                  canMoveUp={i > 0}
                  canMoveDown={i < active.length - 1}
                  onAdvance={() => advanceStatus(it)}
                  onStartEdit={() => {
                    setEditingId(it.id)
                    setEditTitle(it.title)
                  }}
                  onChangeEdit={setEditTitle}
                  onSaveEdit={() => saveEdit(it)}
                  onCancelEdit={() => setEditingId(null)}
                  onMoveUp={() => move(active, i, -1)}
                  onMoveDown={() => move(active, i, 1)}
                  onRemove={() => requestRemove(it)}
                  nowMs={nowTick}
                />
              ))}
            </ul>

            {completed.length > 0 ? (
              <div className="cwb-completed">
                <button
                  type="button"
                  className="cwb-completed-toggle"
                  aria-expanded={completedOpen}
                  onClick={() => setCompletedOpen((v) => !v)}
                >
                  <span className="cwb-completed-caret">{completedOpen ? '▾' : '▸'}</span>
                  Completed · {completed.length}
                </button>
                {completedOpen ? (
                  <ul className="cwb-ul cwb-completed-ul" aria-label="Completed">
                    {completed.map((it) => (
                      <li key={it.id} className="cwb-row cwb-row-done">
                        <span className="cwb-dot cwb-dot-done" aria-label="Done" />
                        <span className="cwb-title" title={it.title}>
                          {it.title}
                        </span>
                        <span className="cwb-date">{formatCompleted(it.completed_at)}</span>
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
  canMoveUp,
  canMoveDown,
  onAdvance,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
  onMoveUp,
  onMoveDown,
  onRemove,
  nowMs,
}: {
  item: WorkBoardItem
  busy: boolean
  editing: boolean
  editTitle: string
  canMoveUp: boolean
  canMoveDown: boolean
  onAdvance: () => void
  onStartEdit: () => void
  onChangeEdit: (v: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
  /** Item 1 — a ticking clock so the run sub-label's elapsed/stall advances live. */
  nowMs: number
}): React.JSX.Element {
  const dot = statusMeta(item.status)
  const activity = activityGlyph(item)
  const progress = item.run_progress
  return (
    <li className={`cwb-row cwb-row-${item.status}`}>
      <button
        type="button"
        className={`cwb-dot ${dot.cls}`}
        onClick={onAdvance}
        disabled={busy}
        title={`${dot.label} — advance`}
        aria-label={`${dot.label}. Advance status`}
      />
      {activity !== null ? (
        <span className="cwb-activity" aria-label={activity.label} title={activity.label}>
          {activity.glyph}
        </span>
      ) : null}
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
          {progress !== undefined ? (
            <span
              className={`cwb-run-progress${progress.stalled ? ' cwb-run-progress-stalled' : ''}`}
              aria-label={`Build progress: ${runProgressText(progress, nowMs)}`}
            >
              {runProgressText(progress, nowMs)}
            </span>
          ) : null}
        </span>
      )}
      <div className="cwb-actions">
        <button
          type="button"
          className="cwb-btn cwb-btn-icon"
          onClick={onMoveUp}
          disabled={busy || !canMoveUp}
          title="Move up"
          aria-label="Move up"
        >
          ▲
        </button>
        <button
          type="button"
          className="cwb-btn cwb-btn-icon"
          onClick={onMoveDown}
          disabled={busy || !canMoveDown}
          title="Move down"
          aria-label="Move down"
        >
          ▼
        </button>
        <button
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
    </li>
  )
}
