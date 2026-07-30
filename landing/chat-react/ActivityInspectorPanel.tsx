/**
 * landing/chat-react — the ACTIVITY INSPECTOR panel (SPEC § WAVE 3.5).
 *
 * The tmux replacement. Ryan cannot tell whether a project's agent session is
 * working or hung; in Vajra he attached to tmux, and Neutron's server-side sessions
 * offered no equivalent at all. Clicking the per-project activity dot opens this,
 * which streams the raw substrate + tool events for that scope in realtime.
 *
 * ENTRY POINT IS THE EXISTING DOT (Ryan-locked): no new icon was added. That is
 * deliberate and worth preserving — the dot is precisely the component that has
 * LIED (ISSUES #386: pulsed for days with nothing running), so making the
 * untrustworthy indicator the doorway to the ground truth puts the verification one
 * tap away on the very element that provoked the doubt.
 *
 * THE HEADLINE IS THE PRODUCT. The row list is secondary; what answers "hung or
 * working?" is the two clocks at the top — last event (any, keepalives included ⇒
 * the process is breathing) and last activity (keepalives excluded ⇒ work actually
 * happened). A session that is alive but doing nothing shows a recent "last event"
 * and a stale "last activity", which is exactly the shape a single pulsing dot
 * cannot express.
 *
 * The chat surface keeps showing only its minimal curated messages — that terseness
 * is correct and stays. This is a separate surface.
 *
 * LIVE-ONLY: ~200 rows from the server's in-memory ring, no scrollback, nothing
 * persisted. A restart legitimately shows an empty panel.
 */

import * as React from 'react'

import {
  activityScopeKey,
  describeState,
  formatAge,
  liveAge,
  mergeActivityRow,
  type ActivityRow,
  type ActivitySnapshot,
  type ActivityState,
} from './activity-client.ts'

/** Client-side row cap. Matches the server ring so the panel never holds more
 *  history than the server would replay on a re-open. */
const PANEL_ROW_CAP = 200

/** How often the header clocks re-render. The clocks are the whole point, so they
 *  must keep counting UP even when no event arrives — a frozen "12s ago" on a
 *  wedged session would be the same lie as a frozen dot. */
const CLOCK_TICK_MS = 1000

/** The minimal data source the panel needs. Structural, so tests inject a fake. */
export interface ActivityInspectorSource {
  /** Fetch the current snapshot for a scope. */
  snapshot(project_id: string | null): Promise<ActivitySnapshot>
  /** Subscribe to live rows. The callback's first arg is the frame's scope key. */
  onActivityEvent(fn: (scopeKey: string, ev: ActivityRow) => void): () => void
}

const KIND_GLYPH: Record<ActivityRow['kind'], string> = {
  tool_start: '▸',
  tool_end: '✓',
  token: '💬',
  thinking: '·',
  status: 'ℹ',
  keepalive: '·',
  completion: '■',
  error: '✕',
  turn_start: '▶',
}

function stateClass(state: ActivityState): string {
  return `car-actin-state car-actin-state-${state}`
}

/** hh:mm:ss for a row, in the viewer's locale/zone. */
function rowTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Panel state machine, split out so the fetch/subscribe ORDER is testable without
 * a DOM.
 *
 * ORDER IS LOAD-BEARING: subscribe FIRST, then fetch. The reverse would drop any
 * row that landed between the response and the subscription. Because the two
 * overlap, the same `seq` legitimately arrives twice — `mergeActivityRow` dedupes
 * on `seq`, which is what makes subscribing-first safe rather than duplicative.
 */
export function useActivityInspector(
  source: ActivityInspectorSource,
  projectId: string | null,
  open: boolean,
): {
  rows: ActivityRow[]
  snapshot: ActivitySnapshot | null
  error: string | null
  loading: boolean
  /** Client clock, ticking every second so the header ages keep counting. */
  now: number
} {
  const [rows, setRows] = React.useState<ActivityRow[]>([])
  const [snapshot, setSnapshot] = React.useState<ActivitySnapshot | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())
  const scope = activityScopeKey(projectId)

  React.useEffect(() => {
    if (!open) {
      // Closing DISCARDS the panel's rows. Correct for a live-only surface: the
      // server ring is the only history, and re-opening re-reads it.
      setRows([])
      setSnapshot(null)
      setError(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    // 1. Subscribe first (see the order note above).
    const unsub = source.onActivityEvent((frameScope, ev) => {
      // The app-ws topic is per-user, so a SIBLING project's rows arrive on this
      // same socket. Filtering here is required, not defensive.
      if (frameScope !== scope) return
      if (!alive) return
      setRows((prev) => mergeActivityRow(prev, ev, PANEL_ROW_CAP))
    })
    // 2. Then fetch the backlog + the clocks + the derived state.
    void source
      .snapshot(projectId)
      .then((snap) => {
        if (!alive) return
        setSnapshot(snap)
        setRows((prev) => {
          // Merge rather than replace: live rows may already have arrived during
          // the fetch, and they are newer than the snapshot.
          let next = snap.events
          for (const r of prev) next = mergeActivityRow(next, r, PANEL_ROW_CAP)
          return next
        })
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      alive = false
      unsub()
    }
  }, [source, projectId, scope, open])

  React.useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(t)
  }, [open])

  return { rows, snapshot, error, loading, now }
}

export function ActivityInspectorPanel({
  source,
  projectId,
  label,
  open,
  onClose,
}: {
  source: ActivityInspectorSource
  /** The scope being inspected: a project id, or null for General. */
  projectId: string | null
  /** Human label for the header (project name, or "General"). */
  label: string
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const { rows, snapshot, error, loading, now } = useActivityInspector(source, projectId, open)
  const listRef = React.useRef<HTMLDivElement | null>(null)

  // Follow the tail as rows arrive — the panel is a live tail, so the newest row
  // is the one the owner is looking for.
  React.useEffect(() => {
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [rows.length])

  // Escape closes, matching every other transient surface in the shell.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const eventAge = liveAge(rows, snapshot, now, { realOnly: false })
  const activityAge = liveAge(rows, snapshot, now, { realOnly: true })
  const state: ActivityState = snapshot?.state ?? 'idle'

  return (
    <div className="car-actin-backdrop" onClick={onClose} data-testid="activity-backdrop">
      <aside
        className="car-actin"
        role="dialog"
        aria-modal="true"
        aria-label={`Activity for ${label}`}
        onClick={(e) => e.stopPropagation()}
        data-testid="activity-panel"
      >
        <header className="car-actin-head">
          <div className="car-actin-title">
            <span className="car-actin-scope">{label}</span>
            <span className={stateClass(state)} data-testid="activity-state">
              {describeState(state)}
            </span>
          </div>
          <button
            type="button"
            className="car-actin-close"
            onClick={onClose}
            aria-label="Close activity"
          >
            ✕
          </button>
        </header>
        {/* THE ANSWER. Two clocks, always visible, always counting. A recent
            "last event" with a stale "last activity" is a stalled session — the
            distinction a single pulsing dot cannot make. */}
        <div className="car-actin-clocks">
          <span className="car-actin-clock" data-testid="activity-last-event">
            <span className="car-actin-clock-k">last event</span>
            <span className="car-actin-clock-v">{formatAge(eventAge)}</span>
          </span>
          <span className="car-actin-clock" data-testid="activity-last-activity">
            <span className="car-actin-clock-k">last activity</span>
            <span className="car-actin-clock-v">{formatAge(activityAge)}</span>
          </span>
        </div>
        <div className="car-actin-list" ref={listRef}>
          {error !== null ? (
            <p className="car-actin-empty" data-testid="activity-error">
              Could not read activity: {error}
            </p>
          ) : loading && rows.length === 0 ? (
            <p className="car-actin-empty">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="car-actin-empty" data-testid="activity-empty">
              No activity buffered. This view is live-only, so it starts empty after
              a restart and fills as the session works.
            </p>
          ) : (
            rows.map((r) => (
              <div
                key={r.seq}
                className={`car-actin-row${r.synthetic === true ? ' car-actin-row-synthetic' : ''}${
                  r.kind === 'error' ? ' car-actin-row-error' : ''
                }`}
                data-testid={`activity-row-${r.seq}`}
              >
                <span className="car-actin-t">{rowTime(r.at)}</span>
                <span className="car-actin-g" aria-hidden="true">
                  {KIND_GLYPH[r.kind]}
                </span>
                <span className="car-actin-l">{r.label}</span>
                {r.detail !== undefined ? <span className="car-actin-d">{r.detail}</span> : null}
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  )
}
