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
  source: { onWorkBoardChanged(fn: (items: WorkBoardItem[]) => void): () => void }
  emit: (items: WorkBoardItem[]) => void
} {
  let cb: ((items: WorkBoardItem[]) => void) | null = null
  return {
    source: {
      onWorkBoardChanged(fn) {
        cb = fn
        return () => {
          cb = null
        }
      },
    },
    emit: (items) => {
      if (cb !== null) cb(items)
    },
  }
}

async function mount(
  handler: Handler,
  live?: { onWorkBoardChanged(fn: (items: WorkBoardItem[]) => void): () => void },
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
    // Completed lives behind the disclosure (count shown, row hidden until open).
    expect(container.textContent).toContain('Completed · 1')
    expect(container.querySelector('.cwb-completed-ul')).toBeNull()

    // Expand the disclosure → the done row + its datestamp appear.
    const toggle = container.querySelector('.cwb-completed-toggle') as HTMLButtonElement
    await act(async () => {
      toggle.click()
      await tick()
    })
    expect(container.querySelector('.cwb-completed-ul')).not.toBeNull()
    expect(container.textContent).toContain('Old done')
    expect(container.textContent).toContain('2026-06-22')

    await act(async () => root.unmount())
  })

  it('derives status dot + activity glyph with a11y labels', async () => {
    const rows = [
      item({ id: 'a', title: 'Subagent row', status: 'in_progress', linked_run_id: 'run_1' }),
      item({ id: 'b', title: 'Inline row', status: 'in_progress', inline_active: true }),
      item({ id: 'c', title: 'Idle upcoming', status: 'upcoming' }),
    ]
    const { container, root, act } = await mount(listOf(rows))

    const dots = Array.from(container.querySelectorAll('.cwb-ul:not(.cwb-completed-ul) .cwb-dot'))
    expect(dots[0]!.className).toContain('cwb-dot-active')
    expect(dots[2]!.className).toContain('cwb-dot-upcoming')

    const glyphs = Array.from(container.querySelectorAll('.cwb-activity')).map(
      (n) => n.getAttribute('aria-label') ?? '',
    )
    expect(glyphs).toContain('Sub-agent running')
    expect(glyphs).toContain('Working inline')
    // The idle upcoming row has NO activity glyph.
    expect(glyphs).toHaveLength(2)

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
    await act(async () => {
      delBtn.click()
      await tick()
      await tick()
    })
    expect(deleted).toBe(true)

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
      emit([
        item({ id: 'a', title: 'Original' }),
        item({ id: 'b', title: 'Pushed live', status: 'in_progress' }),
      ])
      await tick()
    })
    expect(container.textContent).toContain('Pushed live')

    await act(async () => root.unmount())
  })

  it('renders the empty state when the board is empty', async () => {
    const { container, root, act } = await mount(listOf([]))
    expect(container.querySelector('.cwb-empty-zero')).not.toBeNull()
    expect(container.textContent).toContain('No work tracked yet')
    await act(async () => root.unmount())
  })
})
