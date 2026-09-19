import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://test.example/chat' })
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const state = (currentModel: string, sessionId = 'session-1') => ({
  harness: 'codex', sessionId, currentModel,
  availableModels: [{ id: 'cheap', label: 'Cheap' }, { id: 'deep', label: 'Deep' }],
  status: 'ready',
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})

describe('web REPL model switch', () => {
  it('uses the scoped bearer route and last-read session', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return json(init?.method === 'POST' ? state('deep') : state('cheap'))
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="project-1" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    const select = host.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('cheap')
    expect(select.disabled).toBe(false)
    expect(calls[0]?.url).toBe('https://test.example/api/app/projects/project-1/repl-model')
    expect((calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer secret')
    await act(async () => {
      select.value = 'deep'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()
    })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ model: 'deep', sessionId: 'session-1' })
    expect(select.value).toBe('deep')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('keeps the authoritative model and shows a rejected switch, then refreshes', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    let reads = 0
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') return json({ ok: false, code: 'stale_session', message: 'Session changed' }, 409)
      reads++
      return json(state('cheap', `session-${reads}`))
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId={null} origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    const select = host.querySelector('select') as HTMLSelectElement
    await act(async () => {
      select.value = 'deep'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()
    })
    expect(select.value).toBe('cheap')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Session changed')
    expect(reads).toBe(2)
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('does not claim a switch when POST returns a different current model', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => json(state(init?.method === 'POST' ? 'cheap' : 'cheap'))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="a" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    const select = host.querySelector('select') as HTMLSelectElement
    await act(async () => { select.value = 'deep'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick() })
    expect(select.value).toBe('cheap')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Switch not confirmed')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('refuses a successful-looking acknowledgement for a different session', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    let reads = 0
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') return json(state('deep', 'session-2'))
      reads++
      return json(state('cheap', reads === 1 ? 'session-1' : 'session-2'))
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="a" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    const select = host.querySelector('select') as HTMLSelectElement
    await act(async () => { select.value = 'deep'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick() })
    expect(reads).toBe(2)
    expect(select.value).toBe('cheap')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Session changed')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('uses the reserved General scope and disables switching when the harness is busy', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    const calls: string[] = []
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url)
      return json({ ...state('deep'), status: 'busy', detail: 'Finish the current turn first' })
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId={null} origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    expect(calls).toEqual(['https://test.example/api/app/projects/~general/repl-model'])
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('deep')
    expect((host.querySelector('select') as HTMLSelectElement).disabled).toBe(true)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Finish the current turn first')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('renders the empty-session Codex unsupported HTTP state as unsupported', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    const fetchImpl = async (): Promise<Response> => json({
      harness: 'codex', sessionId: '', currentModel: null,
      availableModels: [], status: 'unsupported',
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="a" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    const select = host.querySelector('select') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.selectedOptions[0]?.textContent).toBe('Unsupported')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('refuses an empty session on a switchable ready response', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    const fetchImpl = async (): Promise<Response> => json({ ...state('cheap'), sessionId: '' })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="a" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    expect((host.querySelector('select') as HTMLSelectElement).disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Invalid model response')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('refreshes a busy reading to ready in the mounted control', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    let reads = 0
    const fetchImpl = async (): Promise<Response> => {
      reads++
      return json({ ...state('cheap'), status: reads === 1 ? 'busy' : 'ready' })
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="a" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    const select = host.querySelector('select') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); await tick() })
    expect(reads).toBe(2)
    expect(select.disabled).toBe(false)
    expect(host.querySelector('button')).toBeNull()
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('offers retry after an initial GET error', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    let reads = 0
    const fetchImpl = async (): Promise<Response> => {
      reads++
      return reads === 1 ? json({ ok: false, code: 'unavailable', message: 'Harness offline' }, 503) : json(state('cheap'))
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="a" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Harness offline')
    expect((host.querySelector('select') as HTMLSelectElement).disabled).toBe(true)
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); await tick() })
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('cheap')
    expect((host.querySelector('select') as HTMLSelectElement).disabled).toBe(false)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('does not let a pending refresh overwrite a later switch', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { ReplModelControl } = await import('../ReplModelControl.tsx')
    let reads = 0
    let posts = 0
    let resolveRefresh!: (response: Response) => void
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') {
        posts++
        return posts === 1 ? json({ ok: false, code: 'busy', message: 'Try again' }, 409) : json(state('deep'))
      }
      reads++
      if (reads === 3) return new Promise<Response>((resolve) => { resolveRefresh = resolve })
      return json(state('cheap'))
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ReplModelControl projectId="a" origin="https://test.example" token="secret" fetchImpl={fetchImpl} />); await tick() })
    const select = host.querySelector('select') as HTMLSelectElement
    await act(async () => { select.value = 'deep'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick() })
    expect(posts).toBe(1)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Try again')
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); await tick() })
    expect(reads).toBe(3)
    expect(select.disabled).toBe(true)
    await act(async () => { select.value = 'deep'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick() })
    expect(posts).toBe(1)
    await act(async () => { resolveRefresh(json(state('cheap'))); await tick() })
    expect(select.disabled).toBe(false)
    await act(async () => { select.value = 'deep'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick() })
    expect(posts).toBe(2)
    expect(select.value).toBe('deep')
    await act(async () => { root.unmount() })
    host.remove()
  })
})
