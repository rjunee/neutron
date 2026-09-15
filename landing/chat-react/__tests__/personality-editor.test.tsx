import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://web.neutron.test/chat?client=react' })
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const config = {
  wsUrl: 'wss://web.neutron.test/ws/app/chat', topicId: 'app:web', userId: 'owner',
  projectId: 'acme', projects: [{ id: 'acme', label: 'Acme' }],
  origin: 'https://web.neutron.test', deviceId: 'dev-test', token: 'dev:owner',
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function typeInto(editor: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(editor, value)
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('web personality editor', () => {
  it('loads all three gateway files and PATCHes the selected draft with its mtime', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
      if (method === 'PATCH') return Response.json({ ok: true, mtime: 22 })
      const name = new URL(url).searchParams.get('name')
      return new Response(`${name} original`, { headers: { 'x-mtime': '11' } })
    }
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const React = await import('react')
    const { PersonalityEditor } = await import('../PersonalityEditor.tsx')
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<PersonalityEditor config={config} fetchImpl={fetchImpl} />); await tick(); await tick() })

    const gets = requests.filter((request) => request.method === 'GET')
    expect(gets.map((request) => new URL(request.url).searchParams.get('name')).sort()).toEqual(['SOUL.md', 'USER.md', 'priority-map.md'].sort())
    const editor = container.querySelector('[data-testid="persona-editor-SOUL.md"]') as HTMLTextAreaElement
    expect(editor.value).toBe('SOUL.md original')
    await act(async () => { typeInto(editor, 'web edit'); await tick() })
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Save') as HTMLButtonElement
    await act(async () => { save.click(); await tick(); await tick() })
    const patch = requests.find((request) => request.method === 'PATCH')
    expect(patch?.url).toEndWith('/api/app/persona/file?name=SOUL.md')
    expect(patch?.body).toEqual({ content: 'web edit', expected_mtime: 11 })
    expect(container.textContent).toContain('Saved')
    await act(async () => { root.unmount() })
  })

  it('classifies mtime_conflict and force-overwrites only after confirmation', async () => {
    const mtimes: number[] = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('original', { headers: { 'x-mtime': '7' } })
      const body = JSON.parse(init?.body as string) as { expected_mtime: number }
      mtimes.push(body.expected_mtime)
      if (body.expected_mtime !== -1) return Response.json({ code: 'mtime_conflict', message: 'changed', current_mtime: 8 }, { status: 409 })
      return Response.json({ ok: true, mtime: 9 })
    }
    const { createRoot } = await import('react-dom/client'); const { act } = await import('react'); const React = await import('react')
    const { PersonalityEditor } = await import('../PersonalityEditor.tsx')
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    await act(async () => { root.render(<PersonalityEditor config={config} fetchImpl={fetchImpl} />); await tick(); await tick() })
    const editor = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => { typeInto(editor, 'changed'); await tick() })
    await act(async () => { (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Save') as HTMLButtonElement).click(); await tick(); await tick() })
    expect(container.querySelector('[data-testid="persona-conflict"]')).not.toBeNull()
    expect(mtimes).toEqual([7])
    await act(async () => { (Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Overwrite anyway') as HTMLButtonElement).click(); await tick(); await tick() })
    expect(mtimes).toEqual([7, -1])
    await act(async () => { root.unmount() })
  })
})
