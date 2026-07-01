/**
 * Component test for the web ADMIN / INTEGRATIONS tab. Renders `IntegrationsTab`
 * in happy-dom over an injected `fetchImpl` serving the integrations surface.
 * Asserts:
 *   - the OAuth accounts + API-key slots render from GET /api/cores/integrations;
 *   - typing a value + Save POSTs to /api/cores/api-keys/<label> and the slot
 *     flips to "Stored";
 *   - Clear DELETEs and the slot flips back to "Not set";
 *   - a load failure surfaces the error state.
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

const tick = () => new Promise((r) => setTimeout(r, 0))

const config = {
  wsUrl: 'wss://t/ws/app/chat',
  topicId: 'app:sam',
  userId: 'sam',
  projectId: 'acme',
  projects: [{ id: 'acme', label: 'Acme' }],
  origin: 'https://sam.neutron.test',
  deviceId: 'dev-test',
  token: 'dev:sam',
}

const STATUS = {
  ok: true,
  oauth: [
    {
      kind: 'oauth',
      label: 'google:gmail',
      connected: true,
      scopes: ['gmail.readonly'],
      email: 'sam@example.com',
      connected_at: 1,
      last_refresh_at: null,
      last_refresh_outcome: 'ok',
      expires_at: null,
      scope: 'gmail.readonly',
      core_slugs: ['gmail-core'],
    },
  ],
  api_keys: [
    {
      kind: 'api_key',
      label: 'openai',
      name: 'OpenAI API Key',
      core_slugs: ['llm-core'],
      required: true,
      install_prompt: 'Paste your OpenAI key.',
      connected: false,
    },
  ],
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
  const { IntegrationsTab } = await import('../IntegrationsTab.tsx')
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
        <IntegrationsTab projectId="acme" config={config} fetchImpl={fetchImpl} />
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
    act,
    calls,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('IntegrationsTab render (happy-dom)', () => {
  it('lists OAuth accounts + API-key slots and reflects connected state', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/api/cores/integrations') ? json(STATUS) : null,
    )
    expect(container.textContent).toContain('google:gmail')
    expect(container.textContent).toContain('sam@example.com')
    expect(container.textContent).toContain('OpenAI API Key')
    expect(container.textContent).toContain('Paste your OpenAI key.')
    // OAuth slot connected → badge "Connected"; API-key slot not set → "Not set".
    expect(container.textContent).toContain('Connected')
    expect(container.textContent).toContain('Not set')
    root.unmount()
  })

  it('Save POSTs the typed value and flips the slot to Stored', async () => {
    const posted: Array<{ url: string; body: unknown }> = []
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/cores/api-keys/openai') && init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body as string) })
        return json({ ok: true, label: 'openai', connected: true })
      }
      return null
    })

    const input = container.querySelector('.cint-key-input') as HTMLInputElement
    const setVal = (Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set as (v: string) => void) ?? (() => {})
    await act(async () => {
      setVal.call(input, 'sk-secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
      await tick()
      await tick()
    })

    expect(posted).toHaveLength(1)
    expect(posted[0]!.body).toEqual({ value: 'sk-secret' })
    expect(calls.some((c) => c === 'POST https://sam.neutron.test/api/cores/api-keys/openai')).toBe(
      true,
    )
    // Slot flipped to Stored after the successful POST.
    expect(container.textContent).toContain('Stored')
    root.unmount()
  })

  it('Clear DELETEs a stored key and flips the slot to Not set', async () => {
    const connected = { ...STATUS, api_keys: [{ ...STATUS.api_keys[0]!, connected: true }] }
    let deleted = false
    const { container, root, act } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(connected)
      if (url.endsWith('/api/cores/api-keys/openai') && init?.method === 'DELETE') {
        deleted = true
        return json({ ok: true, label: 'openai', deleted: true })
      }
      return null
    })

    expect(container.textContent).toContain('Stored')
    const clearBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear',
    ) as HTMLButtonElement
    await act(async () => {
      clearBtn.click()
      await tick()
      await tick()
    })
    expect(deleted).toBe(true)
    expect(container.textContent).toContain('Not set')
    root.unmount()
  })

  it('shows an error state when the status load fails', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/api/cores/integrations')
        ? json({ ok: false, code: 'unauthorized', message: 'nope' }, 401)
        : null,
    )
    expect(container.textContent).toContain('unauthorized')
    root.unmount()
  })

  it('lists archived projects and restores one (POST /restore) removing it from the list', async () => {
    let restored = false
    const archivedBody = {
      archived: [
        { id: 'summer', name: 'Summer Trip', emoji: '🏖️', archived_at: '2026-06-30T12:00:00.000Z' },
      ],
    }
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/app/projects/archived')) return json(archivedBody)
      if (url.endsWith('/api/app/projects/summer/restore') && init?.method === 'POST') {
        restored = true
        return json({ ok: true, restored: true })
      }
      return null
    })

    expect(container.textContent).toContain('Archived projects')
    expect(container.textContent).toContain('Summer Trip')

    const restoreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Restore',
    ) as HTMLButtonElement
    await act(async () => {
      restoreBtn.click()
      await tick()
      await tick()
    })

    expect(restored).toBe(true)
    expect(calls.some((c) => c === 'POST https://sam.neutron.test/api/app/projects/summer/restore')).toBe(true)
    // Dropped from the archived list after a successful restore.
    expect(container.textContent).not.toContain('Summer Trip')
    root.unmount()
  })

  it('shows an empty state when there are no archived projects', async () => {
    const { container, root } = await mount((url) => {
      if (url.endsWith('/api/cores/integrations')) return json(STATUS)
      if (url.endsWith('/api/app/projects/archived')) return json({ archived: [] })
      return null
    })
    expect(container.textContent).toContain('No archived projects.')
    root.unmount()
  })
})
