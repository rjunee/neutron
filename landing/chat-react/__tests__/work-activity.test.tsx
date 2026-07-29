/**
 * Tests for the mobile work-activity signals (FIX #348 pulse + #349 drawer):
 *   - `itemRunning` — the live/terminal predicate;
 *   - `useWorkActivity` — seeds silently on the first frame, then announces a
 *     rising running count as `justStarted`, and resets on a project switch;
 *   - `JobStartDrawer` — slides in on a job, auto-closes, ✕ dismisses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { RunProgress, WorkBoardItem } from '../work-board-client.ts'
import {
  itemRunning,
  useWorkActivity,
  JobStartDrawer,
  type StartedJob,
  type WorkActivity,
  type WorkBoardLiveSource,
} from '../work-activity.tsx'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

/** Flush timers + effects in small steps until `cond()` or the budget runs out
 *  (the drawer's auto-close is a multi-phase effect chain — one long wait can
 *  outrun a React commit cycle, so we pump several short act() flushes). */
async function pollUntil(cond: () => boolean, stepMs = 40, steps = 30): Promise<void> {
  for (let i = 0; i < steps && !cond(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, stepMs))
    })
  }
}

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'w1',
    project_slug: 'sam',
    title: 'Ship it',
    status: 'in_progress',
    sort_order: 1,
    design_doc_ref: null,
    inline_active: false,
    linked_run_id: null,
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
    completed_at: null,
    ...over,
  }
}

const rp = (phase: RunProgress['phase_label']): RunProgress =>
  ({ run_id: 'r', phase_label: phase, step_label: 'building', round: 1, started_at: '', last_advanced_at: '', elapsed_ms: 0, stalled: false, stalled_ms: null, pr: null, verdict: null, failure_reason: null })

/** A controllable live source. `replay` (if set) is delivered SYNCHRONOUSLY on
 *  subscribe — mirroring the controller replaying its last snapshot to a late
 *  subscriber, which must seed the baseline WITHOUT announcing. */
function fakeLive(replay?: { items: WorkBoardItem[]; pid?: string }): {
  source: WorkBoardLiveSource
  emit: (items: WorkBoardItem[], pid?: string) => void
} {
  let cb: ((items: WorkBoardItem[], pid: string | undefined) => void) | null = null
  return {
    source: {
      onWorkBoardChanged(fn) {
        cb = fn
        if (replay !== undefined) fn(replay.items, replay.pid)
        return () => {
          cb = null
        }
      },
    },
    emit: (items, pid) => cb?.(items, pid),
  }
}

describe('itemRunning', () => {
  it('is true for a linked, non-terminal run', () => {
    expect(itemRunning(item({ linked_run_id: 'r1', run_progress: rp('building') }))).toBe(true)
    expect(itemRunning(item({ linked_run_id: 'r1' }))).toBe(true) // linked, no progress yet
  })
  it('is false without a linked run or when terminal', () => {
    expect(itemRunning(item({ linked_run_id: null }))).toBe(false)
    expect(itemRunning(item({ linked_run_id: '' }))).toBe(false)
    expect(itemRunning(item({ linked_run_id: 'r1', run_progress: rp('merged') }))).toBe(false)
    expect(itemRunning(item({ linked_run_id: 'r1', run_progress: rp('failed') }))).toBe(false)
  })
})

/** Mount `useWorkActivity` in a probe component and expose its latest value. */
function mountActivity(source: WorkBoardLiveSource, projectId: string | null, announce = true): {
  root: Root
  latest: () => WorkActivity
  container: HTMLElement
} {
  let latest: WorkActivity = { running: 0, justStarted: null, clearStarted: () => {} }
  function Probe({ announce: a }: { announce: boolean }): React.JSX.Element {
    latest = useWorkActivity(source, projectId, a)
    return <div />
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<Probe announce={announce} />))
  return { root, latest: () => latest, container }
}

describe('useWorkActivity', () => {
  it('seeds a REPLAYED pre-existing run silently (not announced)', async () => {
    // The controller replays its last snapshot synchronously to a late
    // subscriber — that pre-existing run is the baseline, not a new start.
    const live = fakeLive({ items: [item({ id: 'a', linked_run_id: 'r1' })], pid: 'acme' })
    const h = mountActivity(live.source, 'acme')
    await act(async () => {
      await tick()
    })
    expect(h.latest().running).toBe(1)
    expect(h.latest().justStarted).toBeNull()
    act(() => h.root.unmount())
  })

  it('seeds the first MATCHING frame (a run already there is not announced), then announces a later rise', async () => {
    const live = fakeLive() // no replay → the first live frame IS the seed
    const h = mountActivity(live.source, 'acme')
    await act(async () => {
      live.emit([item({ id: 'a', title: 'Pre-existing', linked_run_id: 'r1' })], 'acme')
      await tick()
    })
    // The first matching frame only seeds — no false drawer for a pre-existing run.
    expect(h.latest().running).toBe(1)
    expect(h.latest().justStarted).toBeNull()
    // A subsequent rise (a genuinely new run) IS announced.
    await act(async () => {
      live.emit(
        [item({ id: 'a', linked_run_id: 'r1' }), item({ id: 'b', title: 'New run', linked_run_id: 'r2' })],
        'acme',
      )
      await tick()
    })
    expect(h.latest().justStarted).toEqual({ id: 'b', title: 'New run' } as StartedJob)
    act(() => h.root.unmount())
  })

  it('does NOT falsely announce on a project switch whose replay was another project (Codex P2)', async () => {
    // The controller replays its LAST snapshot — here another project's board —
    // which the pid filter drops. The new project's first matching frame (an
    // already-running build) must SEED, not open the drawer.
    const live = fakeLive({ items: [item({ id: 'other', linked_run_id: 'rX' })], pid: 'other' })
    const h = mountActivity(live.source, 'acme')
    await act(async () => {
      live.emit([item({ id: 'a', title: 'Already building', linked_run_id: 'r1' })], 'acme')
      await tick()
    })
    expect(h.latest().running).toBe(1)
    expect(h.latest().justStarted).toBeNull()
    act(() => h.root.unmount())
  })

  it('announces a RISING running count as justStarted', async () => {
    const live = fakeLive({ items: [], pid: 'acme' }) // replayed empty baseline
    const h = mountActivity(live.source, 'acme')
    await act(async () => {
      live.emit([item({ id: 'a', title: 'New build', linked_run_id: 'r1' })], 'acme')
      await tick()
    })
    expect(h.latest().running).toBe(1)
    expect(h.latest().justStarted).toEqual({ id: 'a', title: 'New build' } as StartedJob)
    act(() => h.root.unmount())
  })

  it('with announce=false (desktop) never sets justStarted, but still tracks running', async () => {
    const live = fakeLive()
    const h = mountActivity(live.source, 'acme', false)
    await act(async () => {
      live.emit([item({ id: 'a', title: 'Desktop build', linked_run_id: 'r1' })], 'acme')
      await tick()
    })
    expect(h.latest().running).toBe(1) // pulse still works
    expect(h.latest().justStarted).toBeNull() // no stale drawer to resurface on resize
    act(() => h.root.unmount())
  })

  it('ignores frames for a DIFFERENT project', async () => {
    const live = fakeLive({ items: [], pid: 'acme' })
    const h = mountActivity(live.source, 'acme')
    await act(async () => {
      live.emit([item({ id: 'x', linked_run_id: 'r1' })], 'other')
      await tick()
    })
    expect(h.latest().running).toBe(0)
    expect(h.latest().justStarted).toBeNull()
    act(() => h.root.unmount())
  })
})

describe('JobStartDrawer', () => {
  it('renders the job title + building… when a job is present, nothing when null', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => root.render(<JobStartDrawer job={null} onDismiss={() => {}} />))
    expect(container.querySelector('.car-jobdrawer')).toBeNull()

    act(() => root.render(<JobStartDrawer job={{ id: 'a', title: 'My build' }} onDismiss={() => {}} />))
    const drawer = container.querySelector('.car-jobdrawer')
    expect(drawer).not.toBeNull()
    expect(container.querySelector('.car-jobdrawer-title')?.textContent).toBe('My build')
    expect(container.querySelector('.car-jobdrawer-sub')?.textContent).toBe('building…')
    act(() => root.unmount())
  })

  it('auto-dismisses after autoCloseMs', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let dismissed = false
    act(() =>
      root.render(
        <JobStartDrawer job={{ id: 'a', title: 'X' }} onDismiss={() => { dismissed = true }} autoCloseMs={10} />,
      ),
    )
    await pollUntil(() => dismissed)
    expect(dismissed).toBe(true)
    act(() => root.unmount())
  })

  it('the ✕ button retracts the drawer', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let dismissed = false
    act(() =>
      root.render(
        <JobStartDrawer job={{ id: 'a', title: 'X' }} onDismiss={() => { dismissed = true }} autoCloseMs={99999} />,
      ),
    )
    const x = container.querySelector('.car-jobdrawer-x') as HTMLButtonElement
    act(() => x.click())
    await pollUntil(() => dismissed)
    expect(dismissed).toBe(true)
    act(() => root.unmount())
  })
})
