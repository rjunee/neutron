/**
 * Component test for the web TASKS tab.
 *
 * The tab exists because Tasks reaches BOTH clients as a Core-contributed
 * `app_route` descriptor. Mobile already had a Tasks screen; the browser did
 * not, so wiring the tab without this component would have shipped a working
 * tab on the phone and an empty pane on the web. These assert the tab actually
 * RENDERS TASK DATA and mutates through the same `createAppTasksSurface`
 * endpoints the mobile client uses — not merely that it mounts.
 *
 * Also covers `canRenderTab`, the web half of the renderability rule: the
 * engine serves one tab set to every client, so a descriptor naming a screen
 * this bundle lacks (the Apps launcher) must be dropped rather than rendered.
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

interface Row {
  id: string
  title: string
  status: 'open' | 'done' | 'cancelled'
  priority: number | null
  due_date: string | null
  focus_score?: number | null
}

function task(over: Partial<Row> & { id: string; title: string }): Record<string, unknown> {
  return {
    project_id: PROJECT,
    project_slug: 'sam',
    description: null,
    status: 'open',
    priority: null,
    due_date: null,
    owner_persona: null,
    source: 'app',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    ...over,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type Handler = (url: string, init?: RequestInit) => Response | null

async function mount(handler: Handler) {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { TasksTab } = await import('../TasksTab.tsx')
  const React = await import('react')

  const calls: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const res = handler(url, init)
    if (res !== null) return res
    return json({ ok: false, code: 'request_failed', message: 'no handler' }, 404)
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

describe('web Tasks tab — renders live task data', () => {
  it('lists the open tasks from the app tasks surface', async () => {
    const { container, root, calls } = await mount((url) => {
      if (url.includes(`/api/app/projects/${PROJECT}/tasks?`)) {
        return json({
          ok: true,
          project_id: PROJECT,
          status: 'open',
          order: 'focus_score',
          tasks: [
            task({ id: 't1', title: 'Ship the tabs contract', priority: 1, focus_score: 92 }),
            task({ id: 't2', title: 'Migrate the backlog', due_date: '2026-08-04' }),
          ],
        })
      }
      return null
    })
    try {
      const text = container.textContent ?? ''
      expect(text).toContain('Ship the tabs contract')
      expect(text).toContain('Migrate the backlog')
      // Priority + focus chips come from the row, proving it read the payload
      // rather than just rendering titles.
      expect(text).toContain('P1')
      expect(text).toContain('92')
      // It asks the SAME endpoint (and ordering) the mobile client asks for.
      expect(calls[0]).toContain(`/api/app/projects/${PROJECT}/tasks?status=open`)
      expect(calls[0]).toContain('order=focus_score')
    } finally {
      root.unmount()
    }
  })

  it('creates a task through POST and re-lists', async () => {
    let created: unknown = null
    let listCount = 0
    const { container, root, act } = await mount((url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.endsWith(`/api/app/projects/${PROJECT}/tasks`)) {
        created = JSON.parse(String(init?.body ?? '{}'))
        return json({ ok: true, task: task({ id: 't9', title: 'Buy milk' }) }, 201)
      }
      if (url.includes('/tasks?')) {
        listCount += 1
        return json({
          ok: true,
          project_id: PROJECT,
          status: 'open',
          order: 'focus_score',
          tasks: listCount === 1 ? [] : [task({ id: 't9', title: 'Buy milk' })],
        })
      }
      return null
    })
    try {
      const input = container.querySelector('.ctask-add-input') as HTMLInputElement
      const nativeSetter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        'value',
      )?.set
      await act(async () => {
        nativeSetter?.call(input, 'Buy milk')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const addBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Add',
      ) as HTMLButtonElement
      await act(async () => {
        addBtn.click()
        await tick()
        await tick()
      })
      expect(created).toEqual({ title: 'Buy milk' })
      expect(container.textContent ?? '').toContain('Buy milk')
    } finally {
      root.unmount()
    }
  })

  it('completes a task through the complete endpoint', async () => {
    // Boxed so TS keeps the wider type: the write happens inside the fetch
    // closure, which control-flow analysis does not see before the assert.
    const seen: { completedId: string | null } = { completedId: null }
    const { container, root, act } = await mount((url, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.includes('/complete')) {
        seen.completedId = url.split('/tasks/')[1]?.replace('/complete', '') ?? null
        return json({ ok: true, task: task({ id: 't1', title: 'Done thing', status: 'done' }) })
      }
      if (url.includes('/tasks?')) {
        return json({
          ok: true,
          project_id: PROJECT,
          status: 'open',
          order: 'focus_score',
          tasks: [task({ id: 't1', title: 'Done thing' })],
        })
      }
      return null
    })
    try {
      // Scoped to the ROW actions: the filter chips also carry a "Done" label,
      // and an unscoped lookup would click the filter instead of the task.
      const doneBtn = Array.from(container.querySelectorAll('.ctask-actions button')).find(
        (b) => b.textContent === 'Done',
      ) as HTMLButtonElement
      await act(async () => {
        doneBtn.click()
        await tick()
        await tick()
      })
      expect(seen.completedId).toBe('t1')
    } finally {
      root.unmount()
    }
  })

  it('surfaces a list failure instead of rendering a silently empty tab', async () => {
    const { container, root } = await mount(() =>
      json({ ok: false, code: 'boom', message: 'tasks unavailable' }, 500),
    )
    try {
      expect(container.querySelector('.ctask-error')?.textContent ?? '').toContain(
        'tasks unavailable',
      )
    } finally {
      root.unmount()
    }
  })
})

describe('web renderability rule — canRenderTab', () => {
  it('keeps the Tasks app_route tab (this bundle ships the view)', async () => {
    const { canRenderTab } = await import('../tabs-client.ts')
    expect(
      canRenderTab({
        key: 'core:tasks_core',
        label: 'Tasks',
        scope: 'project',
        source: 'core',
        core_slug: 'tasks_core',
        order: 30,
        mount: { kind: 'app_route', target: `/projects/${PROJECT}/tasks` },
      }),
    ).toBe(true)
  })

  it('DROPS the Apps launcher — a real mobile screen with no web equivalent', async () => {
    const { canRenderTab } = await import('../tabs-client.ts')
    expect(
      canRenderTab({
        key: 'launcher',
        label: 'Apps',
        scope: 'project',
        source: 'builtin',
        order: 12,
        mount: { kind: 'builtin', target: 'launcher' },
      }),
    ).toBe(false)
  })

  it('DROPS an app_route naming a screen this bundle lacks', async () => {
    const { canRenderTab } = await import('../tabs-client.ts')
    expect(
      canRenderTab({
        key: 'core:ledger_core',
        label: 'Ledger',
        scope: 'project',
        source: 'core',
        core_slug: 'ledger_core',
        order: 40,
        mount: { kind: 'app_route', target: `/projects/${PROJECT}/ledger` },
      }),
    ).toBe(false)
  })

  it('always keeps a webview Core tab (any http(s) URL can be framed)', async () => {
    const { canRenderTab } = await import('../tabs-client.ts')
    expect(
      canRenderTab({
        key: 'core:analytics',
        label: 'Analytics',
        scope: 'project',
        source: 'core',
        core_slug: 'analytics',
        order: 100,
        mount: { kind: 'webview', target: 'https://core.example/analytics' },
      }),
    ).toBe(true)
  })
})
