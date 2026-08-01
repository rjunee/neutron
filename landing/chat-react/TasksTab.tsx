/**
 * landing/chat-react — the web TASKS tab.
 *
 * The browser twin of the mobile `app/app/projects/[id]/tasks.tsx` screen, over
 * the SAME `createAppTasksSurface` endpoints (`tasks-client.ts`) and therefore
 * the same canonical `TaskStore` rows the agent's `tasks_core` tools write. A
 * task added here appears in the phone app and in chat, and vice versa.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Tasks reaches the clients as a Core-contributed `app_route` tab, which means
 * ONE engine descriptor is served to both clients and each renders its own
 * native screen. Mobile already had one; the web did not. Shipping the tab
 * without this component would have put a working tab on the phone and an empty
 * pane in the browser — strictly worse than the tab being absent, which is why
 * this lands in the same change as the wiring.
 *
 * ── Server-authoritative, like mobile ───────────────────────────────────────
 * No optimistic mutation. Every write awaits its response and then re-lists, so
 * the rendered order always reflects the engine's `focus_score` ranking rather
 * than a client guess that would drift from the phone's.
 *
 * Styling uses the pre-existing `.ctask-*` block in `landing/chat-react.html`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  WebTasksClient,
  type Task,
  type TaskStatusFilter,
} from './tasks-client.ts'
import type { BootstrapConfig } from './config.ts'

/** Matches the shell's + the sibling tabs' injected-fetch shape. */
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** The three filter chips, mirroring the mobile `TaskFilterChips` set. */
const FILTERS: readonly { key: TaskStatusFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' },
]

/** Mobile hardcodes this ordering too — keep the two clients ranking alike. */
const ORDER = 'focus_score' as const

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : 'Something went wrong'
}

/** `YYYY-MM-DD` → a short human label; passes anything unparseable through. */
function formatDue(due: string): string {
  const parsed = new Date(due)
  if (Number.isNaN(parsed.getTime())) return due
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function TasksTab({
  projectId,
  config,
  fetchImpl,
}: {
  projectId: string
  config: BootstrapConfig
  /** Injected in tests. */
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
  const [draft, setDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Guards a late response from a superseded project/filter overwriting the
  // current list (project switches and rapid filter taps both race).
  const listSeq = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++listSeq.current
    setLoading(true)
    try {
      const rows = await client.list(projectId, { status: filter, order: ORDER })
      if (seq !== listSeq.current) return
      setTasks(rows)
      setListError(null)
    } catch (err) {
      if (seq !== listSeq.current) return
      setListError(errorMessage(err))
    } finally {
      if (seq === listSeq.current) setLoading(false)
    }
  }, [client, projectId, filter])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Run a mutation, surface its error, and re-list on success. */
  const mutate = useCallback(
    async (taskId: string | null, op: () => Promise<unknown>) => {
      setBusyId(taskId)
      setActionError(null)
      try {
        await op()
        await refresh()
      } catch (err) {
        setActionError(errorMessage(err))
      } finally {
        setBusyId(null)
      }
    },
    [refresh],
  )

  const addTask = useCallback(async () => {
    const title = draft.trim()
    if (title.length === 0 || adding) return
    setAdding(true)
    setActionError(null)
    try {
      await client.create(projectId, { title })
      setDraft('')
      await refresh()
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }, [client, projectId, draft, adding, refresh])

  const toggle = useCallback(
    (task: Task) => {
      // Cancelled tasks are terminal — the checkbox is inert, matching mobile.
      if (task.status === 'cancelled') return
      void mutate(task.id, () =>
        task.status === 'done'
          ? client.reopen(projectId, task.id)
          : client.complete(projectId, task.id),
      )
    },
    [client, projectId, mutate],
  )

  const remove = useCallback(
    (task: Task) => {
      void mutate(task.id, () => client.delete(projectId, task.id))
    },
    [client, projectId, mutate],
  )

  return (
    <div className="ctask">
      <div className="ctask-head">
        <div className="ctask-filters" role="group" aria-label="Filter tasks">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`ctask-filter${filter === f.key ? ' ctask-filter-active' : ''}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ctask-add">
          <input
            className="ctask-add-input"
            value={draft}
            placeholder="Add a task…"
            aria-label="New task title"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void addTask()
              }
            }}
          />
          <button
            type="button"
            className="ctask-btn ctask-btn-primary"
            disabled={draft.trim().length === 0 || adding}
            onClick={() => void addTask()}
          >
            Add
          </button>
        </div>
      </div>

      {listError !== null && (
        <div className="ctask-error" role="alert">
          {listError}
        </div>
      )}
      {actionError !== null && (
        <div className="ctask-error" role="alert">
          {actionError}
        </div>
      )}

      <div className="ctask-list">
        {loading && tasks.length === 0 ? (
          <div className="ctask-empty">Loading tasks…</div>
        ) : tasks.length === 0 ? (
          <div className="ctask-empty">
            {filter === 'open' ? 'Nothing open. Add a task above.' : 'No tasks here.'}
          </div>
        ) : (
          <ul className="ctask-ul">
            {tasks.map((task) => {
              const done = task.status === 'done'
              const busy = busyId === task.id
              return (
                <li
                  key={task.id}
                  className={`ctask-row${done || task.status === 'cancelled' ? ' ctask-row-done' : ''}`}
                >
                  {typeof task.focus_score === 'number' && (
                    <div className="ctask-rank" title="Focus score">
                      {Math.round(task.focus_score)}
                    </div>
                  )}
                  <div className="ctask-main">
                    <div className="ctask-title-line">
                      <span className="ctask-title">{task.title}</span>
                      {typeof task.priority === 'number' && (
                        <span className="ctask-chip ctask-chip-prio">P{task.priority}</span>
                      )}
                      {task.due_date !== null && (
                        <span className="ctask-chip ctask-chip-due">
                          {formatDue(task.due_date)}
                        </span>
                      )}
                      {task.status === 'cancelled' && (
                        <span className="ctask-chip">Cancelled</span>
                      )}
                    </div>
                    {task.description !== null && task.description.length > 0 && (
                      <div className="ctask-reason">{task.description}</div>
                    )}
                  </div>
                  <div className="ctask-actions">
                    <button
                      type="button"
                      className="ctask-btn"
                      disabled={busy || task.status === 'cancelled'}
                      onClick={() => toggle(task)}
                    >
                      {done ? 'Reopen' : 'Done'}
                    </button>
                    <button
                      type="button"
                      className="ctask-btn ctask-btn-icon"
                      aria-label={`Delete ${task.title}`}
                      title="Delete"
                      disabled={busy}
                      onClick={() => remove(task)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
