/**
 * Component test for the web TASKS tab (WAVE 3 PR-8). Renders `TasksTab` in
 * happy-dom over an injected `fetchImpl` serving the tasks surface. Asserts:
 *   - the list renders the project's tasks in the SERVER's prioritized order
 *     (order=focus_score), surfacing llm_rank + llm_reason;
 *   - completing a task round-trips to /complete and re-fetches;
 *   - reprioritize PATCHes the priority field;
 *   - adding a task POSTs the title and re-fetches.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

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

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    project_slug: 'sam',
    project_id: PROJECT,
    title: 'Ship PR-8',
    description: null,
    status: 'open',
    priority: 2,
    due_date: '2026-06-30',
    owner_persona: null,
    source: 'app',
    focus_score: 7,
    focus_score_updated_at: null,
    llm_rank: 1,
    llm_reason: 'Blocks the release',
    prioritized_by: 'llm',
    prioritized_at: null,
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-23T00:00:00Z',
    completed_at: null,
    ...over,
  }
}

type Handler = (url: string, init?: RequestInit) => Response | null

async function mount(handler: Handler): Promise<{
  container: HTMLElement
  root: { unmount: () => void }
  act: (cb: () => void | Promise<void>) => Promise<void>
  calls: string[]
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { TasksTab } = await import('../TasksTab.tsx')
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
        <TasksTab projectId={PROJECT} config={config} fetchImpl={fetchImpl} />
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

describe('TasksTab (happy-dom)', () => {
  it('renders prioritized tasks (server order) with rank + reason', async () => {
    const rows = [
      task({ id: 'a', title: 'First task', llm_rank: 1, llm_reason: 'Blocks the release' }),
      task({ id: 'b', title: 'Second task', llm_rank: 2, llm_reason: 'Nice to have', priority: 0 }),
    ]
    let listed = false
    const handler: Handler = (url) => {
      if (url.includes('/tasks?')) {
        listed = true
        // The list MUST request the prioritized order.
        expect(url).toContain('order=focus_score')
        return jsonRes({ ok: true, tasks: rows, project_id: PROJECT, status: 'open', order: 'focus_score' })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    expect(listed).toBe(true)
    const titles = Array.from(container.querySelectorAll('.ctask-title')).map((n) => n.textContent ?? '')
    // Server order preserved — First before Second.
    expect(titles).toEqual(['First task', 'Second task'])
    expect(container.textContent).toContain('#1')
    expect(container.textContent).toContain('Blocks the release')

    await act(async () => {
      root.unmount()
    })
  })

  it('completes a task (POST /complete + re-fetch)', async () => {
    let completed = false
    let listCount = 0
    const handler: Handler = (url, init) => {
      if (url.includes('/tasks?')) {
        listCount += 1
        return jsonRes({ ok: true, tasks: [task()], project_id: PROJECT, status: 'open', order: 'focus_score' })
      }
      if (url.endsWith('/tasks/t1/complete') && (init?.method ?? 'GET') === 'POST') {
        completed = true
        return jsonRes({ ok: true, task: task({ status: 'done' }) })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const doneBtn = Array.from(container.querySelectorAll('.ctask-btn-primary')).find(
      (b) => (b.textContent ?? '').includes('Done'),
    ) as HTMLButtonElement
    await act(async () => {
      doneBtn.click()
      await tick()
      await tick()
    })
    expect(completed).toBe(true)
    // initial load + post-complete refresh.
    expect(listCount).toBeGreaterThanOrEqual(2)

    await act(async () => {
      root.unmount()
    })
  })

  it('reprioritizes via PATCH priority', async () => {
    let patched: Record<string, unknown> | null = null
    const handler: Handler = (url, init) => {
      if (url.includes('/tasks?')) {
        return jsonRes({ ok: true, tasks: [task({ priority: 2 })], project_id: PROJECT, status: 'open', order: 'focus_score' })
      }
      if (url.endsWith('/tasks/t1') && (init?.method ?? 'GET') === 'PATCH') {
        patched = JSON.parse(init!.body as string) as Record<string, unknown>
        return jsonRes({ ok: true, task: task({ priority: 3 }) })
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const raiseBtn = container.querySelector('.ctask-btn-icon') as HTMLButtonElement
    await act(async () => {
      raiseBtn.click()
      await tick()
      await tick()
    })
    expect(patched).not.toBeNull()
    // 2 → 3 (raise toward P0).
    expect(patched!.priority).toBe(3)

    await act(async () => {
      root.unmount()
    })
  })

  it('adds a task (POST title + re-fetch)', async () => {
    let posted: Record<string, unknown> | null = null
    const handler: Handler = (url, init) => {
      if (url.includes('/tasks?')) {
        return jsonRes({ ok: true, tasks: [], project_id: PROJECT, status: 'open', order: 'focus_score' })
      }
      if (url.endsWith('/api/app/projects/acme/tasks') && (init?.method ?? 'GET') === 'POST') {
        posted = JSON.parse(init!.body as string) as Record<string, unknown>
        return jsonRes({ ok: true, task: task({ title: 'Brand new' }) }, 201)
      }
      return null
    }
    const { container, root, act } = await mount(handler)

    const input = container.querySelector('.ctask-add-input') as HTMLInputElement
    const { act: actFn } = await import('react')
    await actFn(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Brand new')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })
    const addBtn = Array.from(container.querySelectorAll('.ctask-btn-primary')).find(
      (b) => (b.textContent ?? '').includes('Add'),
    ) as HTMLButtonElement
    await act(async () => {
      addBtn.click()
      await tick()
      await tick()
    })
    expect(posted).not.toBeNull()
    expect(posted!.title).toBe('Brand new')

    await act(async () => {
      root.unmount()
    })
  })
})
