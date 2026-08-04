/**
 * ISSUES #500 — the "Connected accounts" section of the per-project Settings
 * tab. Assertions are on THE WIRE (captured method + URL + body) plus the few
 * strings the owner has to be able to read, because a section that renders a
 * checkbox but PUTs the wrong project — or the wrong account id — would pass a
 * control-presence check and fail these.
 *
 * The one thing that must never appear: the raw hex `account_id`. The label is
 * humanised server-side, and this pins that the browser renders the label and
 * not the key.
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

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

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

const ACCOUNTS_URL = 'https://sam.neutron.test/api/app/projects/acme/accounts'

type Handler = (url: string, init?: RequestInit) => Response | null

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function baseHandler(url: string): Response | null {
  if (url.endsWith('/api/app/projects/acme/credentials')) {
    return json({ ok: true, project: [], global: [] })
  }
  if (url.endsWith('/api/app/projects/acme/settings')) {
    return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
  }
  return null
}

/** Two accounts on Calendar, both on. The hex ids are what must NOT render. */
function accountsBody(overrides?: { firstEnabled?: boolean; secondEnabled?: boolean }) {
  return {
    ok: true,
    project_id: 'acme',
    services: [
      {
        service: 'google_calendar',
        accounts: [
          {
            account_id: 'aaaa1111',
            label: 'personal@example.com',
            account_email: 'personal@example.com',
            enabled: overrides?.firstEnabled ?? true,
          },
          {
            account_id: 'bbbb2222',
            label: 'work@example.com',
            account_email: 'work@example.com',
            enabled: overrides?.secondEnabled ?? true,
          },
        ],
      },
      { service: 'gmail_compose', accounts: [] },
    ],
  }
}

async function mount(handler: Handler): Promise<{
  container: HTMLElement
  root: { unmount: () => void }
  act: (cb: () => void | Promise<void>) => Promise<void>
  requests: Array<{ method: string; url: string; body: unknown }>
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const React = await import('react')

  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
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
  return { container, root: root as unknown as { unmount: () => void }, act, requests }
}

function toggles(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('.cset-acct-toggle')) as HTMLInputElement[]
}

describe('SettingsTab connected accounts (ISSUES #500)', () => {
  it('lists each account by its humanised label — never the hex account id', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/accounts') ? json(accountsBody()) : null,
    )

    expect(container.textContent).toContain('Connected accounts')
    expect(container.textContent).toContain('Google Calendar')
    expect(container.textContent).toContain('personal@example.com')
    expect(container.textContent).toContain('work@example.com')
    // The account key is a SHA-256 prefix. It must not be on screen anywhere.
    expect(container.textContent).not.toContain('aaaa1111')
    expect(container.textContent).not.toContain('bbbb2222')

    const boxes = toggles(container)
    expect(boxes).toHaveLength(2)
    expect(boxes.map((b) => b.checked)).toEqual([true, true])
    root.unmount()
  })

  it('unchecking one PUTs that account disabled for THIS project', async () => {
    const { container, root, act, requests } = await mount((url, init) => {
      if (!url.endsWith('/accounts')) return null
      if (init?.method === 'PUT') return json(accountsBody({ firstEnabled: false }))
      return json(accountsBody())
    })

    await act(async () => {
      toggles(container)[0]!.click()
      await tick()
      await tick()
    })

    const puts = requests.filter((r) => r.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe(ACCOUNTS_URL)
    expect(puts[0]!.body).toEqual({
      service: 'google_calendar',
      account_id: 'aaaa1111',
      enabled: false,
    })

    // The tab re-renders from the SERVER's refreshed view, not a local patch.
    expect(toggles(container).map((b) => b.checked)).toEqual([false, true])
    root.unmount()
  })

  it('re-checking PUTs enabled:true (the toggle is reversible)', async () => {
    const { container, root, act, requests } = await mount((url, init) => {
      if (!url.endsWith('/accounts')) return null
      if (init?.method === 'PUT') return json(accountsBody())
      return json(accountsBody({ firstEnabled: false }))
    })

    await act(async () => {
      toggles(container)[0]!.click()
      await tick()
      await tick()
    })

    const puts = requests.filter((r) => r.method === 'PUT')
    expect(puts[0]!.body).toEqual({
      service: 'google_calendar',
      account_id: 'aaaa1111',
      enabled: true,
    })
    root.unmount()
  })

  it('every account off reads as OFF, not as broken', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/accounts')
        ? json(accountsBody({ firstEnabled: false, secondEnabled: false }))
        : null,
    )

    const notice = container.querySelector('[data-testid="accounts-off-google_calendar"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('Off for this project')
    expect(notice!.textContent).toContain('Google Calendar')
    // …and the rows are still there, so it can be turned back on.
    expect(toggles(container).map((b) => b.checked)).toEqual([false, false])
    root.unmount()
  })

  it('a service with no connected account is not rendered as an empty group', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/accounts') ? json(accountsBody()) : null,
    )
    const groups = Array.from(container.querySelectorAll('.cset-acct-group')) as HTMLElement[]
    expect(groups.map((g) => g.dataset['service'])).toEqual(['google_calendar'])
    root.unmount()
  })

  it('nothing connected anywhere shows the connect-in-Admin empty state', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/accounts')
        ? json({ ok: true, project_id: 'acme', services: [{ service: 'google_calendar', accounts: [] }] })
        : null,
    )
    expect(container.textContent).toContain('No accounts connected yet')
    expect(toggles(container)).toHaveLength(0)
    root.unmount()
  })

  it('a failed load surfaces the error instead of pretending nothing is connected', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith('/accounts') ? json({ ok: false, code: 'boom', message: 'accounts down' }, 500) : null,
    )
    const err = container.querySelector('[aria-label="Connected accounts"] .cset-error')
    expect(err?.textContent).toBe('boom: accounts down')
    root.unmount()
  })
})
