/**
 * Component test for the web WORK BOARD tab (Work Board Phase 1b). Renders
 * `WorkBoardTab` in happy-dom over an injected `fetchImpl` serving the
 * work-board surface. Asserts:
 *   - the board renders active+next rows in the SERVER's order, splitting the
 *     completed history into the collapsed disclosure;
 *   - the status dot derives upcoming/in_progress/done; the activity glyph
 *     derives sub-agent (linked_run_id) vs inline (inline_active) with a11y labels;
 *   - adding an item POSTs the title and re-fetches;
 *   - advancing status routes upcoming→in_progress via PATCH and →done via /complete;
 *   - delete round-trips DELETE;
 *   - a live `work_board_changed` snapshot replaces the list without a re-fetch;
 *   - the empty state renders when the board is empty.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { WorkBoardItem } from '../work-board-client.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const PROJECT = 'acme'
const tick = () => new Promise((r) => setTimeout(r, 0))

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

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'w1',
    project_slug: 'sam',
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

type Handler = (url: string, init?: RequestInit) => Response | null

/** A controllable live source: tests grab `emit` to push a snapshot. */
function fakeLive(): {
  source: {
    onWorkBoardChanged(fn: (items: WorkBoardItem[], pid: string | undefined) => void): () => void
  }
  emit: (items: WorkBoardItem[], pid?: string) => void
} {
  let cb: ((items: WorkBoardItem[], pid: string | undefined) => void) | null = null
  return {
    source: {
      onWorkBoardChanged(fn) {
        cb = fn
        return () => {
          cb = null
        }
      },
    },
    emit: (items, pid) => {
      if (cb !== null) cb(items, pid)
    },
  }
}

async function mount(
  handler: Handler,
  live?: {
    onWorkBoardChanged(fn: (items: WorkBoardItem[], pid: string | undefined) => void): () => void
  },
): Promise<{
  container: HTMLElement
  root: { unmount: () => void }
  act: (cb: () => void | Promise<void>) => Promise<void>
  calls: string[]
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { WorkBoardTab } = await import('../WorkBoardTab.tsx')
  const React = await import('react')

  const calls: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const res = handler(url, init)
    if (res !== null) return res
    return new Response(JSON.stringify({ ok: false, code: 'request_failed' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <React.StrictMode>
        <WorkBoardTab
          projectId={PROJECT}
          config={config}
          {...(live !== undefined ? { liveSource: live } : {})}
          fetchImpl={fetchImpl}
        />
      </React.StrictMode>,
    )
  })
  await act(async () => {
    await tick()
    await tick()
  })
  return {
    container,
    root: root as unknown as { unmount: () => void },
    act: act as unknown as (cb: () => void | Promise<void>) => Promise<void>,
    calls,
  }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A list handler that returns the given board for the GET, null otherwise. */
function listOf(rows: WorkBoardItem[]): Handler {
  return (url, init) => {
    if (url.endsWith('/work-board') && (init?.method ?? 'GET') === 'GET') {
      return jsonRes({ ok: true, items: rows, project_id: PROJECT })
    }
    return null
  }
}

describe('WorkBoardTab (happy-dom)', () => {
  it('renders active rows in server order + the completed disclosure', async () => {
    const rows = [
      item({ id: 'a', title: 'Active one', status: 'in_progress', sort_order: 1 }),
      item({ id: 'b', title: 'Next up', status: 'upcoming', sort_order: 2 }),
      item({ id: 'c', title: 'Old done', status: 'done', completed_at: '2026-06-22T10:00:00Z' }),
    ]
    const { container, root, act } = await mount(listOf(rows))

    const titles = Array.from(container.querySelectorAll('.cwb-ul:not(.cwb-completed-ul) .cwb-title')).map(
      (n) => n.textContent ?? '',
    )
    expect(titles).toEqual(['Active one', 'Next up'])
    // Done lives behind the disclosure (count shown, row hidden until open).
    expect(container.textContent).toContain('Done · 1')
    expect(container.querySelector('.cwb-completed-ul')).toBeNull()

    // Expand the disclosure → the done row + its "Merged · Jun 22" datestamp appear.
    const toggle = container.querySelector('.cwb-completed-toggle') as HTMLButtonElement
    await act(async () => {
      toggle.click()
      await tick()
    })
    expect(container.querySelector('.cwb-completed-ul')).not.toBeNull()
    expect(container.textContent).toContain('Old done')
    expect(container.textContent).toContain('Merged · Jun 22')

    await act(async () => root.unmount())
  })

  it('derives the leading dot colour from the run step + status (no activity glyph)', async () => {
    const rows = [
      item({
        id: 'a',
        title: 'Reviewing row',
        status: 'in_progress',
        linked_run_id: 'run_1',
        run_progress: {
          run_id: 'run_1',
          phase_label: 'reviewing',
          step_label: 'reviewing',
          round: 1,
          started_at: '2026-07-02T00:00:00Z',
          last_advanced_at: '2026-07-02T00:01:00Z',
          elapsed_ms: 60000,
          stalled: false,
          stalled_ms: null,
          pr: null,
          verdict: null,
          failure_reason: null,
        },
      }),
      item({ id: 'c', title: 'Idle upcoming', status: 'upcoming' }),
    ]
    const { container, root, act } = await mount(listOf(rows))

    const dots = Array.from(container.querySelectorAll('.cwb-ul:not(.cwb-completed-ul) .cwb-dot'))
    // A live review step → review-coloured, pulsing dot.
    expect(dots[0]!.className).toContain('cwb-dot-review')
    expect(dots[0]!.className).toContain('cwb-dot-pulse')
    // A never-started card → faint gray outline, no pulse.
    expect(dots[1]!.className).toContain('cwb-dot-upcoming')
    expect(dots[1]!.className).not.toContain('cwb-dot-pulse')
    // The old ⑂/› activity-glyph column is GONE.
    expect(container.querySelector('.cwb-activity')).toBeNull()

    await act(async () => root.unmount())
  })

  it('renders the phase tag + round for a bound run (dot+tag+round, no emoji/timer)', async () => {
    const rows = [
      item({
        id: 'a',
        title: 'Building row',
        status: 'in_progress',
        linked_run_id: 'run_1',
        run_progress: {
          run_id: 'run_1',
          phase_label: 'building',
          step_label: 'fixing',
          round: 2,
          started_at: '2026-07-02T00:00:00Z',
          last_advanced_at: '2026-07-02T00:01:00Z',
          elapsed_ms: 120000,
          stalled: false,
          stalled_ms: null,
          pr: null,
          verdict: null,
          failure_reason: null,
        },
      }),
    ]
    const { container, root, act } = await mount(listOf(rows))
    const tag = container.querySelector('.cwb-tag')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toBe('Fixing')
    expect(tag!.className).toContain('cwb-tag-fix')
    expect(container.querySelector('.cwb-round')!.textContent).toBe('round 2')
    // No emoji glyphs, no elapsed-minutes timer, no old sub-label.
    expect(container.querySelector('.cwb-run-progress')).toBeNull()
    expect(container.textContent).not.toContain('🔨')
    expect(container.textContent).not.toContain('4m')
    await act(async () => root.unmount())
  })

  it('shows a merged tag (no round) for a completed build and a failed tag on failure', async () => {
    const rows = [
      item({
        id: 'a',
        title: 'Failed row',
        status: 'in_progress',
        linked_run_id: 'run_1',
        run_progress: {
          run_id: 'run_1',
          phase_label: 'failed',
          step_label: 'failed',
          round: 3,
          started_at: '2026-07-02T00:00:00Z',
          last_advanced_at: '2026-07-02T00:00:30Z',
          elapsed_ms: 900000,
          stalled: false,
          stalled_ms: null,
          pr: null,
          verdict: null,
          failure_reason: 'tests failed',
        },
      }),
      item({
        id: 'b',
        title: 'Merged row',
        status: 'in_progress',
        linked_run_id: 'run_2',
        run_progress: {
          run_id: 'run_2',
          phase_label: 'merged',
          step_label: 'done',
          round: 1,
          started_at: '2026-07-02T00:00:00Z',
          last_advanced_at: '2026-07-02T00:05:00Z',
          elapsed_ms: 300000,
          stalled: false,
          stalled_ms: null,
          pr: 123,
          verdict: 'APPROVE',
          failure_reason: null,
        },
      }),
    ]
    const { container, root, act } = await mount(listOf(rows))
    const tags = Array.from(container.querySelectorAll('.cwb-tag')).map((n) => n.textContent ?? '')
    expect(tags).toContain('Didn’t finish')
    expect(tags).toContain('Merged')
    // Terminal steps drop the `round N` trail.
    expect(container.querySelector('.cwb-round')).toBeNull()
    await act(async () => root.unmount())
  })

  it('confirm-before-delete uses cancel-build copy for a running item, lighter for idle (item 4)', async () => {
    const rows = [
      item({
        id: 'run',
        title: 'Running build',
        status: 'in_progress',
        linked_run_id: 'run_1',
        run_progress: {
          run_id: 'run_1',
          phase_label: 'building',
          step_label: 'building',
          round: 1,
          started_at: '2026-07-02T00:00:00Z',
          last_advanced_at: '2026-07-02T00:01:00Z',
          elapsed_ms: 60000,
          stalled: false,
          stalled_ms: null,
          pr: null,
          verdict: null,
          failure_reason: null,
        },
      }),
      item({ id: 'idle', title: 'Idle item', status: 'upcoming' }),
    ]
    const { container, root, act } = await mount(listOf(rows))
    const delButtons = Array.from(container.querySelectorAll('.cwb-btn-icon')).filter(
      (b) => (b.getAttribute('aria-label') ?? '') === 'Delete item',
    ) as HTMLButtonElement[]

    // Running item → cancel-build copy.
    await act(async () => {
      delButtons[0]!.click()
      await tick()
    })
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain(
      'Cancel this build and remove it?',
    )
    // Dismiss via the backdrop's Keep button.
    const keep = Array.from(container.querySelectorAll('.cwb-confirm .cwb-btn')).find(
      (b) => (b.textContent ?? '') === 'Keep',
    ) as HTMLButtonElement
    await act(async () => {
      keep.click()
      await tick()
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    // Idle item → lighter copy.
    await act(async () => {
      delButtons[1]!.click()
      await tick()
    })
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Remove this item?')
    await act(async () => root.unmount())
  })

  it('adds an item (POST title + re-fetch)', async () => {
    let posted: Record<string, unknown> | null = null
    let listCount = 0
    const handler: Handler = (url, init) => {
      if (url.endsWith('/work-board') && (init?.method ?? 'GET') === 'GET') {
        listCount += 1
        return jsonRes({ ok: true, items: [], project_id: PROJECT })
      }
      if (url.endsWith('/work-board') && init?.method === 'POST') {
        posted = JSON.parse(init.body as string) as Record<string, unknown>
        return jsonRes({ ok: true, item: item({ title: 'Brand new' }) }, 201)
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const input = container.querySelector('.cwb-add-input') as HTMLInputElement
    const { act: ract } = await import('react')
    await ract(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, 'Brand new')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })
    const addBtn = container.querySelector('.cwb-btn-primary') as HTMLButtonElement
    await act(async () => {
      addBtn.click()
      await tick()
      await tick()
    })
    expect(posted).not.toBeNull()
    expect(posted!.title).toBe('Brand new')
    expect(listCount).toBeGreaterThanOrEqual(2)

    await act(async () => root.unmount())
  })

  it('reorders via the drag grip keyboard (ArrowDown → persist via /reorder)', async () => {
    let reordered: { url: string; body: Record<string, unknown> } | null = null
    const handler: Handler = (url, init) => {
      if (url.endsWith('/work-board') && (init?.method ?? 'GET') === 'GET') {
        return jsonRes({
          ok: true,
          items: [
            item({ id: 'a', title: 'First', status: 'upcoming', sort_order: 1 }),
            item({ id: 'b', title: 'Second', status: 'upcoming', sort_order: 2 }),
          ],
          project_id: PROJECT,
        })
      }
      if (url.includes('/work-board/a/reorder') && init?.method === 'POST') {
        reordered = { url, body: JSON.parse(init.body as string) as Record<string, unknown> }
        return jsonRes({ ok: true, items: [], project_id: PROJECT })
      }
      return null
    }
    const { container, root, act } = await mount(handler)
    const grips = Array.from(container.querySelectorAll('.cwb-drag')) as HTMLButtonElement[]
    // ArrowDown on the first row's grip moves it below its neighbor → {after: 'b'}.
    await act(async () => {
      grips[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      await tick()
      await tick()
    })
    expect(reordered).not.toBeNull()
    expect(reordered!.body).toEqual({ after: 'b' })
    await act(async () => root.unmount())
  })

  it('shows ▶ start on a fresh card and ↻ retry on a card with a prior binding; add-box is at the bottom', async () => {
    const rows = [
      item({ id: 'fresh', title: 'Never started', status: 'upcoming', linked_run_id: null }),
      // A card whose last build FAILED (terminal run_progress, binding detached) →
      // it's startable again, and the control reads ↻ Retry.
      item({
        id: 'failed',
        title: 'Retry me',
        status: 'upcoming',
        linked_run_id: null,
        run_progress: {
          run_id: 'run_old',
          phase_label: 'failed',
          step_label: 'failed',
          round: 1,
          started_at: '2026-07-02T00:00:00Z',
          last_advanced_at: '2026-07-02T00:00:30Z',
          elapsed_ms: 1000,
          stalled: false,
          stalled_ms: null,
          pr: null,
          verdict: null,
          failure_reason: 'tests failed',
        },
      }),
    ]
    const { container, root, act } = await mount(listOf(rows))
    const playBtns = Array.from(container.querySelectorAll('.cwb-btn-play')) as HTMLButtonElement[]
    const labels = playBtns.map((b) => b.getAttribute('aria-label') ?? '')
    expect(labels).toContain('Start build')
    expect(labels).toContain('Retry build')
    expect(playBtns.find((b) => b.getAttribute('aria-label') === 'Start build')!.textContent).toBe('▶')
    expect(playBtns.find((b) => b.getAttribute('aria-label') === 'Retry build')!.textContent).toBe('↻')
    // The add affordance lives in the bottom footer, after the list.
    const foot = container.querySelector('.cwb-foot')
    expect(foot).not.toBeNull()
    expect(foot!.querySelector('.cwb-add-input')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('advances status: upcoming→in_progress via PATCH, in_progress→done via /complete', async () => {
    let patched: Record<string, unknown> | null = null
    let completed = false
    const handler: Handler = (url, init) => {
      if (url.endsWith('/work-board') && (init?.method ?? 'GET') === 'GET') {
        return jsonRes({
          ok: true,
          items: [
            item({ id: 'up', title: 'Upcoming', status: 'upcoming', sort_order: 1 }),
            item({ id: 'ip', title: 'Running', status: 'in_progress', sort_order: 2 }),
          ],
          project_id: PROJECT,
        })
      }
      if (url.endsWith('/work-board/up') && init?.method === 'PATCH') {
        patched = JSON.parse(init.body as string) as Record<string, unknown>
        return jsonRes({ ok: true, item: item({ id: 'up', status: 'in_progress' }) })
      }
      if (url.endsWith('/work-board/ip/complete') && init?.method === 'POST') {
        completed = true
        return jsonRes({ ok: true, item: item({ id: 'ip', status: 'done' }) })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const dots = Array.from(
      container.querySelectorAll('.cwb-ul:not(.cwb-completed-ul) .cwb-dot'),
    ) as HTMLButtonElement[]
    // First row is upcoming → PATCH to in_progress.
    await act(async () => {
      dots[0]!.click()
      await tick()
      await tick()
    })
    expect(patched).not.toBeNull()
    expect(patched!.status).toBe('in_progress')

    // Second row is in_progress → /complete.
    const dots2 = Array.from(
      container.querySelectorAll('.cwb-ul:not(.cwb-completed-ul) .cwb-dot'),
    ) as HTMLButtonElement[]
    await act(async () => {
      dots2[1]!.click()
      await tick()
      await tick()
    })
    expect(completed).toBe(true)

    await act(async () => root.unmount())
  })

  it('deletes an item (DELETE round-trip)', async () => {
    let deleted = false
    const handler: Handler = (url, init) => {
      if (url.endsWith('/work-board') && (init?.method ?? 'GET') === 'GET') {
        return jsonRes({ ok: true, items: [item({ id: 'x', title: 'Doomed' })], project_id: PROJECT })
      }
      if (url.endsWith('/work-board/x') && init?.method === 'DELETE') {
        deleted = true
        return jsonRes({ ok: true, deleted: 'x' })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const delBtn = Array.from(container.querySelectorAll('.cwb-btn-icon')).find(
      (b) => (b.getAttribute('aria-label') ?? '') === 'Delete item',
    ) as HTMLButtonElement
    // Item 4 — the X opens a confirm dialog FIRST; no DELETE fires yet.
    await act(async () => {
      delBtn.click()
      await tick()
    })
    expect(deleted).toBe(false)
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()

    // Confirm — the danger button in the dialog fires the DELETE.
    const confirmBtn = Array.from(
      (dialog as Element).querySelectorAll('.cwb-btn-danger'),
    )[0] as HTMLButtonElement
    await act(async () => {
      confirmBtn.click()
      await tick()
      await tick()
    })
    expect(deleted).toBe(true)
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('applies a live work_board_changed snapshot without a re-fetch', async () => {
    const { source, emit } = fakeLive()
    const { container, root, act } = await mount(
      listOf([item({ id: 'a', title: 'Original' })]),
      source,
    )
    expect(container.textContent).toContain('Original')

    await act(async () => {
      emit(
        [
          item({ id: 'a', title: 'Original' }),
          item({ id: 'b', title: 'Pushed live', status: 'in_progress' }),
        ],
        PROJECT,
      )
      await tick()
    })
    expect(container.textContent).toContain('Pushed live')

    await act(async () => root.unmount())
  })

  it('drops a live snapshot for a DIFFERENT project', async () => {
    const { source, emit } = fakeLive()
    const { container, root, act } = await mount(
      listOf([item({ id: 'a', title: 'Mine' })]),
      source,
    )
    expect(container.textContent).toContain('Mine')

    // A frame tagged for another project must NOT overwrite this tab's board.
    await act(async () => {
      emit([item({ id: 'z', title: 'Other project leak' })], 'some-other-project')
      await tick()
    })
    expect(container.textContent).toContain('Mine')
    expect(container.textContent).not.toContain('Other project leak')

    // A frame for THIS project (PROJECT) still applies.
    await act(async () => {
      emit([item({ id: 'b', title: 'My update' })], PROJECT)
      await tick()
    })
    expect(container.textContent).toContain('My update')

    await act(async () => root.unmount())
  })

  it('renders the empty state when the board is empty', async () => {
    const { container, root, act } = await mount(listOf([]))
    expect(container.querySelector('.cwb-empty-zero')).not.toBeNull()
    expect(container.textContent).toContain('No work tracked yet')
    await act(async () => root.unmount())
  })
})
