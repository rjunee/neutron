/**
 * Component test for the per-project SETTINGS tab. Renders `SettingsTab` in
 * happy-dom over an injected `fetchImpl` and asserts:
 *   - the two-step Archive → Confirm flow POSTs /api/app/projects/<id>/archive;
 *   - a successful archive flips the section to the "Project archived" notice;
 *   - Cancel aborts without a POST;
 *   - the CREDENTIAL SCOPE BOUNDARY (ISSUES #486) — every request this tab can
 *     be driven to emit is project-scoped. These assert on what reaches the
 *     server (captured method + URL + body), not on which controls are on
 *     screen: a UI with no toggle that still posts `scope: 'global'` would pass
 *     a control-presence check and fail these.
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
  /** Every request, with its parsed JSON body — the wire, not the DOM. */
  requests: Array<{ method: string; url: string; body: unknown }>
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const React = await import('react')

  const calls: string[] = []
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    requests.push({
      method: init?.method ?? 'GET',
      url,
      body:
        typeof init?.body === 'string'
          ? ((): unknown => {
              try {
                return JSON.parse(init.body as string)
              } catch {
                return init.body
              }
            })()
          : undefined,
    })
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
  return { container, root: root as unknown as { unmount: () => void }, act, calls, requests }
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
    expect(container.textContent).toContain('Optional / advanced.')
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

describe('SettingsTab credential scope boundary (ISSUES #486)', () => {
  const PROJECT_CREDS = 'https://sam.neutron.test/api/app/projects/acme/credentials'

  /** Serve one project-owned credential and one inherited global default. */
  function credsHandler(onWrite?: (method: string) => void): Handler {
    return (url, init) => {
      if (url.startsWith(PROJECT_CREDS)) {
        const method = init?.method ?? 'GET'
        if (method === 'GET') {
          return json({
            ok: true,
            project_id: 'acme',
            project: [
              {
                id: 'p1',
                owner_slug: 'sam',
                project_id: 'acme',
                scope: 'project',
                service: 'apify',
                label: null,
                created_at: '2026-06-20T00:00:00Z',
                updated_at: '2026-06-20T00:00:00Z',
                expires_at: null,
              },
            ],
            global: [
              {
                id: 'g1',
                owner_slug: 'sam',
                project_id: '',
                scope: 'global',
                service: 'openai',
                label: 'shared',
                created_at: '2026-06-20T00:00:00Z',
                updated_at: '2026-06-20T00:00:00Z',
                expires_at: null,
              },
            ],
          })
        }
        onWrite?.(method)
        return json({ ok: true, credential: { service: 'x' }, deleted: 'x' }, method === 'POST' ? 201 : 200)
      }
      return null
    }
  }

  function setInputValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      ?.set as ((v: string) => void) | undefined
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('the add form posts a project-scoped write and never puts a global scope on the wire', async () => {
    const { container, root, act, requests } = await mount(credsHandler())

    const service = container.querySelector('#cset-service') as HTMLInputElement
    const token = container.querySelector('#cset-token') as HTMLInputElement
    await act(async () => {
      setInputValue(service, 'stripe')
      setInputValue(token, 'sk-live-xxx')
      await tick()
    })
    await act(async () => {
      btn(container, 'Add credential').click()
      await tick()
      await tick()
    })

    const posts = requests.filter((r) => r.method === 'POST' && r.url.includes('/credentials'))
    expect(posts).toHaveLength(1)
    // The URL is the project's, and the body carries no scope at all — there is
    // nothing a project surface could set to reach instance-wide state.
    expect(posts[0]!.url).toBe(PROJECT_CREDS)
    expect(posts[0]!.body).toEqual({ service: 'stripe', token: 'sk-live-xxx' })
    expect(Object.keys(posts[0]!.body as object)).not.toContain('scope')
    root.unmount()
  })

  it('there is no request this tab can emit that carries scope=global', async () => {
    const seen: string[] = []
    const { container, root, act, requests } = await mount(credsHandler((m) => seen.push(m)))

    // Drive every credential control the tab has: fill + submit the form, then
    // click every remove control rendered on the list.
    const service = container.querySelector('#cset-service') as HTMLInputElement
    const token = container.querySelector('#cset-token') as HTMLInputElement
    await act(async () => {
      setInputValue(service, 'stripe')
      setInputValue(token, 'sk-live-xxx')
      await tick()
    })
    await act(async () => {
      btn(container, 'Add credential').click()
      await tick()
      await tick()
    })
    const removes = Array.from(
      container.querySelectorAll('.cset-cred-ul button'),
    ) as HTMLButtonElement[]
    for (const b of removes) {
      await act(async () => {
        b.click()
        await tick()
        await tick()
      })
    }

    const writes = requests.filter((r) => r.method !== 'GET' && r.url.includes('/credentials'))
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(w.url).toStartWith(PROJECT_CREDS)
      expect(w.url).not.toContain('scope=global')
      expect((w.body as Record<string, unknown> | undefined)?.['scope']).toBeUndefined()
    }
    expect(seen.length).toBeGreaterThan(0)
    root.unmount()
  })

  it('shows the inherited global default, read-only, and points at the global surface', async () => {
    const { container, root, act, requests } = await mount(credsHandler())

    // Both rows render — reading the inherited default here is the useful part.
    expect(container.textContent).toContain('openai')
    expect(container.textContent).toContain('global default')
    expect(container.textContent).toContain('Change in General → Admin')

    // …but the inherited row carries NO control. Clicking every button in the
    // list must not produce a delete addressed at the global default.
    const rows = Array.from(container.querySelectorAll('.cset-cred-row')) as HTMLElement[]
    const inherited = rows.find((r) => r.textContent?.includes('global default'))
    expect(inherited).not.toBeUndefined()
    expect(inherited!.querySelectorAll('button')).toHaveLength(0)

    // The project's OWN row still has its remove, and it deletes the project row.
    const own = rows.find((r) => r.textContent?.includes('apify'))
    const ownRemove = own!.querySelector('button') as HTMLButtonElement
    await act(async () => {
      ownRemove.click()
      await tick()
      await tick()
    })
    const deletes = requests.filter((r) => r.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.url).toBe(`${PROJECT_CREDS}/apify`)
    root.unmount()
  })
})
