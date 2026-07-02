/**
 * Component test for the per-project SETTINGS tab archive action
 * (archived-projects sprint). Renders `SettingsTab` in happy-dom over an
 * injected `fetchImpl` and asserts:
 *   - the two-step Archive → Confirm flow POSTs /api/app/projects/<id>/archive;
 *   - a successful archive flips the section to the "Project archived" notice;
 *   - Cancel aborts without a POST.
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

type Handler = (url: string, init?: RequestInit) => Response | null

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Minimal responses for SettingsTab's mount-time loads (credentials + settings). */
function baseHandler(url: string): Response | null {
  if (url.endsWith('/api/app/projects/acme/credentials')) {
    return json({ ok: true, project: [], global: [] })
  }
  if (url.endsWith('/api/app/projects/acme/settings')) {
    return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
  }
  return null
}

async function mount(handler: Handler): Promise<{
  container: HTMLElement
  root: { unmount: () => void }
  act: (cb: () => void | Promise<void>) => Promise<void>
  calls: string[]
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const React = await import('react')

  const calls: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const res = handler(url, init) ?? baseHandler(url)
    if (res !== null) return res
    return json({ ok: false, code: 'request_failed' }, 404)
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <React.StrictMode>
        <SettingsTab projectId="acme" config={config} fetchImpl={fetchImpl} />
      </React.StrictMode>,
    )
  })
  await act(async () => {
    await tick()
    await tick()
  })
  return { container, root: root as unknown as { unmount: () => void }, act, calls }
}

function btn(container: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement
}

describe('SettingsTab archive action (happy-dom)', () => {
  it('Archive → Confirm POSTs /archive and shows the archived notice', async () => {
    let archived = false
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith('/api/app/projects/acme/archive') && init?.method === 'POST') {
        archived = true
        return json({ ok: true, archived: true })
      }
      return null
    })

    expect(container.textContent).toContain('Archive project')

    await act(async () => {
      btn(container, 'Archive project').click()
      await tick()
    })
    // Confirmation step visible; no POST yet.
    expect(container.textContent).toContain('Confirm archive')
    expect(archived).toBe(false)

    await act(async () => {
      btn(container, 'Confirm archive').click()
      await tick()
      await tick()
    })

    expect(archived).toBe(true)
    expect(calls.some((c) => c === 'POST https://sam.neutron.test/api/app/projects/acme/archive')).toBe(true)
    expect(container.textContent).toContain('Project archived')
    root.unmount()
  })

  it('Cancel aborts the archive without a POST', async () => {
    let archived = false
    const { container, root, act } = await mount((url, init) => {
      if (url.endsWith('/api/app/projects/acme/archive') && init?.method === 'POST') {
        archived = true
        return json({ ok: true, archived: true })
      }
      return null
    })

    await act(async () => {
      btn(container, 'Archive project').click()
      await tick()
    })
    await act(async () => {
      btn(container, 'Cancel').click()
      await tick()
    })
    expect(archived).toBe(false)
    expect(container.textContent).toContain('Archive project')
    root.unmount()
  })
})

describe('SettingsTab Codex override (happy-dom)', () => {
  it('renders the override section labelled optional', async () => {
    const { container, root } = await mount((url) => {
      if (url.endsWith('/api/app/projects/acme/codex-auth')) {
        return json({ ok: true, status: 'not_connected', scope: null, override_present: false })
      }
      return null
    })
    expect(container.textContent).toContain('Codex review — project override')
    expect(container.textContent).toContain('Optional.')
    // No override row → no remove button.
    expect(btn(container, 'Remove override')).toBeUndefined()
    root.unmount()
  })

  it('saving an override refetches status so "Remove override" appears immediately (P2)', async () => {
    let saved = false
    const { container, root, act } = await mount((url, init) => {
      if (url.endsWith('/api/app/projects/acme/codex-auth') && (init?.method ?? 'GET') === 'GET') {
        // Before save: no override. After save: the refetch reports the override.
        return saved
          ? json({ ok: true, status: 'connected', scope: 'project', override_present: true })
          : json({ ok: true, status: 'not_connected', scope: null, override_present: false })
      }
      if (url.endsWith('/api/app/projects/acme/codex-auth') && init?.method === 'POST') {
        saved = true
        // NOTE: the POST reply intentionally omits `override_present`.
        return json({ ok: true, status: 'connected', mode: 'subscription', scope: 'project' }, 201)
      }
      return null
    })

    expect(btn(container, 'Remove override')).toBeUndefined()
    const textarea = container.querySelector('#cset-codex-auth') as HTMLTextAreaElement
    const setVal = (Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set as (v: string) => void) ?? (() => {})
    await act(async () => {
      setVal.call(textarea, '{"tokens":{"access_token":"a","refresh_token":"r"}}')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })
    await act(async () => {
      btn(container, 'Save project override').click()
      await tick()
      await tick()
    })
    // The refetch populated override_present → the remove affordance is present.
    expect(container.textContent).toContain('Connected (project override)')
    expect(btn(container, 'Remove override')).not.toBeUndefined()
    root.unmount()
  })

  it('removes a STALE/expired override, then reflects the global fallback (not "not connected") (P2)', async () => {
    let deleted = false
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith('/api/app/projects/acme/codex-auth') && (init?.method ?? 'GET') === 'GET') {
        // BEFORE removal: expired override masks itself → resolver reports the
        // global default, but override_present stays true (removable). AFTER
        // removal: the override is gone → plain global fallback.
        return deleted
          ? json({ ok: true, status: 'connected', scope: 'global', override_present: false })
          : json({ ok: true, status: 'connected', scope: 'global', override_present: true })
      }
      if (url.endsWith('/api/app/projects/acme/codex-auth') && init?.method === 'DELETE') {
        deleted = true
        return json({ ok: true, disconnected: true, scope: 'project' })
      }
      return null
    })

    expect(container.textContent).toContain('Override expired — using the global default')
    const remove = btn(container, 'Remove override')
    expect(remove).not.toBeUndefined()
    await act(async () => {
      remove.click()
      await tick()
      await tick()
    })
    expect(deleted).toBe(true)
    expect(
      calls.some((c) => c === 'DELETE https://sam.neutron.test/api/app/projects/acme/codex-auth'),
    ).toBe(true)
    // After removal the effective status is the GLOBAL default — NOT "not connected".
    expect(container.textContent).toContain('Connected (using the global default)')
    expect(container.textContent).not.toContain('○ Not connected')
    // Override row gone → no remove button.
    expect(btn(container, 'Remove override')).toBeUndefined()
    root.unmount()
  })
})
