/**
 * Tests for the desktop WORK slide-out pane (M1 UX redesign PR-4):
 *   - the auto-open/close controller: opens on a kickoff (running rises), stays
 *     open while running, keeps open on a failure, auto-closes after the settle
 *     once ALL clear, and a manual toggle pins + persists per-project;
 *   - `PlansPane` renders the edge-handle (the ONLY open/close control — no X /
 *     chevron / toggle button), which flips the aria-label + open class;
 *   - a live board with a running item drives the pane open end-to-end
 *     (summarize → controller → onOpenChange).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { NeutronChatController } from '../controller.ts'
import type { RunProgress, WorkBoardItem } from '../work-board-client.ts'
import type { WorkBoardSummary } from '../WorkBoardTab.tsx'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  window.localStorage.clear()
})

const PROJECT = 'acme'
const tick = () => new Promise((r) => setTimeout(r, 0))
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const config = {
  wsUrl: 'wss://t/ws/app/chat',
  topicId: 'app:sam',
  userId: 'sam',
  projectId: PROJECT,
  projects: [{ id: PROJECT, label: 'Acme' }],
  origin: 'https://sam.neutron.test',
  deviceId: 'dev-test',
  token: 'dev:sam',
}

function runProgress(over: Partial<RunProgress> = {}): RunProgress {
  return {
    run_id: 'r1',
    phase_label: 'building',
    step_label: 'building',
    round: 1,
    started_at: '2026-07-02T00:00:00Z',
    last_advanced_at: '2026-07-02T00:00:00Z',
    elapsed_ms: 1000,
    stalled: false,
    stalled_ms: null,
    pr: null,
    verdict: null,
    failure_reason: null,
    ...over,
  }
}

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'w1',
    project_slug: 'acme',
    title: 'Ship the board',
    status: 'upcoming',
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

/** A controllable live source: tests grab `emit` to push a board snapshot. */
function fakeLive(): {
  source: NeutronChatController
  emit: (items: WorkBoardItem[], pid?: string) => void
} {
  let cb: ((items: WorkBoardItem[], pid: string | undefined) => void) | null = null
  const source = {
    onWorkBoardChanged(fn: (items: WorkBoardItem[], pid: string | undefined) => void) {
      cb = fn
      return () => {
        cb = null
      }
    },
  }
  return {
    source: source as unknown as NeutronChatController,
    emit: (items, pid) => {
      if (cb !== null) cb(items, pid)
    },
  }
}

describe('usePlansPaneController (auto-open/close state machine)', () => {
  async function mountController(): Promise<{
    setSummary: (s: WorkBoardSummary) => Promise<void>
    click: () => Promise<void>
    advance: (ms: number) => Promise<void>
    isOpen: () => boolean
    unmount: () => Promise<void>
  }> {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { usePlansPaneController } = await import('../PlansPane.tsx')
    const React = await import('react')

    let summary: WorkBoardSummary = { running: 0, failed: 0 }
    let rerender: () => void = () => {}

    function Harness(): React.JSX.Element {
      const [, force] = React.useState(0)
      rerender = () => force((n) => n + 1)
      const { open, toggle } = usePlansPaneController(PROJECT, summary, 20)
      return (
        <button data-open={open ? '1' : '0'} onClick={toggle}>
          toggle
        </button>
      )
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness />)
    })
    const btn = () => container.querySelector('button') as HTMLButtonElement
    return {
      setSummary: async (s) => {
        summary = s
        await act(async () => {
          rerender()
          await tick()
        })
      },
      click: async () => {
        await act(async () => {
          btn().click()
          await tick()
        })
      },
      advance: async (ms) => {
        await act(async () => {
          await wait(ms)
        })
      },
      isOpen: () => btn().getAttribute('data-open') === '1',
      unmount: async () => {
        await act(async () => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  it('starts closed, opens on a kickoff, stays open while running', async () => {
    const c = await mountController()
    expect(c.isOpen()).toBe(false)
    await c.setSummary({ running: 1, failed: 0 }) // kickoff
    expect(c.isOpen()).toBe(true)
    await c.setSummary({ running: 2, failed: 0 }) // another kickoff — still open
    expect(c.isOpen()).toBe(true)
    await c.unmount()
  })

  it('auto-closes after the settle once ALL runs are clear', async () => {
    const c = await mountController()
    await c.setSummary({ running: 1, failed: 0 })
    expect(c.isOpen()).toBe(true)
    await c.setSummary({ running: 0, failed: 0 }) // all clear → settle timer armed
    expect(c.isOpen()).toBe(true) // still open during the settle
    await c.advance(40)
    expect(c.isOpen()).toBe(false) // auto-closed
    await c.unmount()
  })

  it('a FAILED run keeps the pane open (attention, no auto-close)', async () => {
    const c = await mountController()
    await c.setSummary({ running: 1, failed: 0 })
    await c.setSummary({ running: 0, failed: 1 }) // last run failed
    await c.advance(40)
    expect(c.isOpen()).toBe(true)
    await c.unmount()
  })

  it('a manual toggle pins the pane (persists, no auto-close on an idle board)', async () => {
    const c = await mountController()
    await c.click() // manual open on an idle (0,0) board
    expect(c.isOpen()).toBe(true)
    expect(window.localStorage.getItem(`neutron.plansPane.${PROJECT}`)).toBe('1')
    await c.advance(40) // idle board would auto-close if unpinned — pinned stays open
    expect(c.isOpen()).toBe(true)
    await c.click() // manual close
    expect(c.isOpen()).toBe(false)
    expect(window.localStorage.getItem(`neutron.plansPane.${PROJECT}`)).toBe('0')
    await c.unmount()
  })
})

describe('PlansPane (edge-handle + live wiring)', () => {
  async function mountPane(): Promise<{
    container: HTMLElement
    act: (cb: () => void | Promise<void>) => Promise<void>
    emit: (items: WorkBoardItem[], pid?: string) => void
    openChanges: boolean[]
    unmount: () => void
  }> {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { PlansPane } = await import('../PlansPane.tsx')
    const React = await import('react')

    const live = fakeLive()
    const openChanges: boolean[] = []
    // The board list 404s — the handle/header chrome is independent of board data.
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <PlansPane
          projectId={PROJECT}
          config={config}
          controller={live.source}
          fetchImpl={fetchImpl}
          onOpenChange={(o) => openChanges.push(o)}
          autoCloseMs={20}
        />,
      )
    })
    await act(async () => {
      await tick()
    })
    return {
      container,
      act,
      emit: live.emit,
      openChanges,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  it('renders the edge-handle as the ONLY open/close control and toggles it', async () => {
    const p = await mountPane()
    const handle = p.container.querySelector('.car-plans-handle') as HTMLButtonElement
    expect(handle).not.toBeNull()
    expect(handle.tagName).toBe('BUTTON')
    expect(handle.getAttribute('aria-label')).toBe('Show work')
    // The header reads WORK (caps via CSS; textContent stays "Work"), and there
    // is NO close chevron / X / toggle button — the handle is the only control.
    expect(p.container.querySelector('.car-plans-head')?.textContent).toContain('Work')
    const buttons = Array.from(p.container.querySelectorAll('button'))
    const closers = buttons.filter((b) => /close|hide|✕|×|chevron|›|‹/i.test(b.getAttribute('aria-label') ?? ''))
    expect(closers).toEqual([]) // no aria-labelled close control other than the handle's dynamic label

    await p.act(async () => {
      handle.click()
      await tick()
    })
    expect(handle.getAttribute('aria-label')).toBe('Hide work')
    expect((p.container.querySelector('.car-plans-col') as HTMLElement).className).toContain(
      'car-plans-open',
    )
    p.unmount()
  })

  it('auto-opens when a live board reports a running item', async () => {
    const p = await mountPane()
    expect((p.container.querySelector('.car-plans-col') as HTMLElement).className).not.toContain(
      'car-plans-open',
    )
    await p.act(async () => {
      p.emit(
        [item({ status: 'in_progress', linked_run_id: 'r1', run_progress: runProgress() })],
        PROJECT,
      )
      await tick()
    })
    expect((p.container.querySelector('.car-plans-col') as HTMLElement).className).toContain(
      'car-plans-open',
    )
    expect(p.openChanges.at(-1)).toBe(true)
    // The header count reflects the running roll-up.
    expect(p.container.querySelector('.car-plans-cnt')?.textContent).toContain('1 running')
    p.unmount()
  })
})
