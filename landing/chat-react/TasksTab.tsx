/**
 * landing/chat-react — web TASKS tab content (WAVE 3 PR-8).
 *
 * The dynamic React/AJAX Tasks view for the web project shell: the project's
 * open tasks rendered in the LLM-primary prioritized order (PR-7), with
 * agent+user-parity CRUD — add, complete, reprioritize, cancel/delete — over
 * the existing tasks surface (`gateway/http/app-tasks-surface.ts`). Renders as
 * the builtin `tasks` tab inside `ProjectShell` (PR-4), the sibling of the web
 * `DocumentsTab` (PR-5).
 *
 * ── Order is the engine's, not the client's ────────────────────────────────
 * The list fetches with `order='focus_score'`, the prioritized ordering shipped
 * in PR-7 (`tasks/prioritize-llm.ts`): ranked rows first by `llm_rank`, fresh
 * rows interleaved by `focus_score`. The tab NEVER re-sorts — the store is the
 * single source of truth — so what the agent ranked is what the user sees. Each
 * row surfaces its `llm_rank` and the LLM's one-line `llm_reason`.
 *
 * ── Agent + user parity ─────────────────────────────────────────────────────
 * Every mutation hits the same canonical `TaskStore` the agent writes, and the
 * server returns the canonical row, so the UI never second-guesses the store.
 * Reprioritize is a PATCH of the 0-3 `priority` field — the same column the
 * focus-score reads — so a user bump feeds the next prioritize pass. After any
 * mutation the list re-fetches so the order reflects the store immediately.
 *
 * ── Status filter ───────────────────────────────────────────────────────────
 * Defaults to `open` (the actionable set). A toggle switches to `all` so done /
 * cancelled rows are visible; completing a task from the `open` view simply
 * drops it from the list on the next fetch.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { BootstrapConfig } from './config.ts'
import {
  WebTasksClient,
  clampPriority,
  formatDue,
  priorityLabel,
  type Task,
  type TaskStatusFilter,
} from './tasks-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** The list filters the tab exposes. Maps to the surface's `?status=`. */
const FILTERS: ReadonlyArray<{ key: TaskStatusFilter; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'all', label: 'All' },
]

function statusLabel(status: Task['status']): string {
  if (status === 'done') return 'Done'
  if (status === 'cancelled') return 'Cancelled'
  return 'Open'
}

export function TasksTab({
  projectId,
  config,
  fetchImpl,
}: {
  projectId: string
  config: BootstrapConfig
  /** Injected in tests; defaults to the global fetch inside WebTasksClient. */
  fetchImpl?: FetchImpl
}): React.JSX.Element {
  const client = useMemo(
    () =>
      new WebTasksClient(
        fetchImpl !== undefined
          ? { base_url: config.origin, token: config.token, fetchImpl }
          : { base_url: config.origin, token: config.token },
      ),
    [config.origin, config.token, fetchImpl],
  )

  const [tasks, setTasks] = useState<Task[]>([])
  const [filter, setFilter] = useState<TaskStatusFilter>('open')
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Add-task composer.
  const [newTitle, setNewTitle] = useState('')
  const [adding, setAdding] = useState(false)

  // Per-row in-flight guard so a double-click can't fire two mutations.
  const [busyId, setBusyId] = useState<string | null>(null)

  // Monotonic guard so a slow list fetch can't land after a newer one (rapid
  // filter toggles / project switches / StrictMode double-invoke).
  const listSeq = useMemo(() => ({ current: 0 }), [])

  const refresh = useCallback(
    (which: TaskStatusFilter): void => {
      const seq = (listSeq.current += 1)
      setLoading(true)
      setListError(null)
      void client
        .list(projectId, which, 'focus_score')
        .then((rows) => {
          if (seq !== listSeq.current) return
          setTasks(rows)
          setLoading(false)
        })
        .catch((err: unknown) => {
          if (seq !== listSeq.current) return
          setTasks([])
          setLoading(false)
          setListError(err instanceof Error ? err.message : 'failed to load tasks')
        })
    },
    [client, projectId, listSeq],
  )

  // Reset + load whenever the project or filter changes. A stale task list from
  // project A must never linger under project B's id.
  useEffect(() => {
    setTasks([])
    setActionError(null)
    setNewTitle('')
    setBusyId(null)
    refresh(filter)
  }, [refresh, filter, projectId])

  const addTask = useCallback((): void => {
    const title = newTitle.trim()
    if (title.length === 0 || adding) return
    setAdding(true)
    setActionError(null)
    void client
      .create(projectId, { title })
      .then(() => {
        setAdding(false)
        setNewTitle('')
        refresh(filter)
      })
      .catch((err: unknown) => {
        setAdding(false)
        setActionError(err instanceof Error ? err.message : 'failed to add task')
      })
  }, [client, projectId, newTitle, adding, filter, refresh])

  const completeTask = useCallback(
    (task: Task): void => {
      if (busyId !== null) return
      setBusyId(task.id)
      setActionError(null)
      void client
        .complete(projectId, task.id)
        .then(() => {
          setBusyId(null)
          refresh(filter)
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to complete task')
        })
    },
    [client, projectId, busyId, filter, refresh],
  )

  // Reprioritize: nudge the 0-3 priority. `delta` of +1 raises (toward P0),
  // -1 lowers. A no-op at the band edge keeps the click from round-tripping.
  const reprioritize = useCallback(
    (task: Task, delta: number): void => {
      if (busyId !== null) return
      const current = task.priority ?? 0
      const next = clampPriority(current + delta)
      if (next === null || next === task.priority) return
      setBusyId(task.id)
      setActionError(null)
      void client
        .update(projectId, task.id, { priority: next })
        .then(() => {
          setBusyId(null)
          refresh(filter)
        })
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to reprioritize task')
        })
    },
    [client, projectId, busyId, filter, refresh],
  )

  const removeTask = useCallback(
    (task: Task): void => {
      if (busyId !== null) return
      setBusyId(task.id)
      setActionError(null)
      const done = (): void => {
        setBusyId(null)
        refresh(filter)
      }
      // Open tasks cancel (soft, reversible-by-the-agent); already-closed rows
      // delete (hard) so the "All" view can prune them.
      const op = task.status === 'open' ? client.cancel(projectId, task.id) : client.delete(projectId, task.id)
      void op
        .then(done)
        .catch((err: unknown) => {
          setBusyId(null)
          setActionError(err instanceof Error ? err.message : 'failed to remove task')
        })
    },
    [client, projectId, busyId, filter, refresh],
  )

  return (
    <div className="ctask">
      <header className="ctask-head">
        <div className="ctask-filters" role="tablist" aria-label="Task filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`ctask-filter${filter === f.key ? ' ctask-filter-active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <form
          className="ctask-add"
          onSubmit={(e) => {
            e.preventDefault()
            addTask()
          }}
        >
          <input
            className="ctask-add-input"
            placeholder="Add a task…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            aria-label="New task title"
          />
          <button
            type="submit"
            className="ctask-btn ctask-btn-primary"
            disabled={adding || newTitle.trim().length === 0}
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
      </header>

      {actionError !== null ? <div className="ctask-error">{actionError}</div> : null}

      <div className="ctask-list" aria-label="Tasks">
        {loading ? (
          <div className="ctask-empty">Loading…</div>
        ) : listError !== null ? (
          <div className="ctask-empty">{listError}</div>
        ) : tasks.length === 0 ? (
          <div className="ctask-empty">
            {filter === 'open' ? 'No open tasks. Add one above.' : 'No tasks yet.'}
          </div>
        ) : (
          <ul className="ctask-ul">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                busy={busyId === t.id}
                onComplete={() => completeTask(t)}
                onRaise={() => reprioritize(t, +1)}
                onLower={() => reprioritize(t, -1)}
                onRemove={() => removeTask(t)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TaskRow({
  task,
  busy,
  onComplete,
  onRaise,
  onLower,
  onRemove,
}: {
  task: Task
  busy: boolean
  onComplete: () => void
  onRaise: () => void
  onLower: () => void
  onRemove: () => void
}): React.JSX.Element {
  const done = task.status !== 'open'
  const prio = priorityLabel(task.priority)
  const due = formatDue(task.due_date)
  return (
    <li className={`ctask-row${done ? ' ctask-row-done' : ''}`}>
      <div className="ctask-rank" title={task.prioritized_by === 'llm' ? 'LLM rank' : 'rank'}>
        {task.llm_rank !== null ? `#${task.llm_rank}` : '—'}
      </div>
      <div className="ctask-main">
        <div className="ctask-title-line">
          <span className="ctask-title">{task.title}</span>
          {prio.length > 0 ? <span className="ctask-chip ctask-chip-prio">{prio}</span> : null}
          {due.length > 0 ? <span className="ctask-chip ctask-chip-due">{due}</span> : null}
          {done ? <span className="ctask-chip ctask-chip-status">{statusLabel(task.status)}</span> : null}
        </div>
        {task.llm_reason !== null && task.llm_reason.length > 0 ? (
          <div className="ctask-reason" title="Why this rank">
            {task.llm_reason}
          </div>
        ) : null}
      </div>
      <div className="ctask-actions">
        {!done ? (
          <>
            <button
              type="button"
              className="ctask-btn ctask-btn-icon"
              onClick={onRaise}
              disabled={busy || (task.priority ?? 0) >= 3}
              title="Raise priority"
              aria-label="Raise priority"
            >
              ▲
            </button>
            <button
              type="button"
              className="ctask-btn ctask-btn-icon"
              onClick={onLower}
              disabled={busy || (task.priority ?? 0) <= 0}
              title="Lower priority"
              aria-label="Lower priority"
            >
              ▼
            </button>
            <button
              type="button"
              className="ctask-btn ctask-btn-primary"
              onClick={onComplete}
              disabled={busy}
              title="Complete task"
            >
              Done
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="ctask-btn"
          onClick={onRemove}
          disabled={busy}
          title={done ? 'Delete task' : 'Cancel task'}
          aria-label={done ? 'Delete task' : 'Cancel task'}
        >
          {done ? 'Delete' : 'Cancel'}
        </button>
      </div>
    </li>
  )
}
