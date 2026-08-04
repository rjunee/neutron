/**
 * REGRESSION (#380 sweep): IntegrationsTab's async continuations ran `setState`
 * after the tab unmounted (project switch / tab close). In a real browser commit
 * that setState-after-unmount surfaces as React's teardown-phase fiber invariant,
 * bypasses every error boundary, and blanks the WHOLE root (the class fix in
 * main.tsx now nets it at the root; stopping the setState at the source is the
 * real fix). This pins the defensive contracts the fix installs:
 *   (a) in-flight READS are ABORTED on unmount — the pane threads an
 *       AbortController into GET reads and aborts it in its unmount cleanup, and
 *       every continuation bails on `!mountedRef.current` (RED pre-fix: no
 *       controller → the GET carries no signal, and the cleanup that arms both
 *       guards is what makes this pass);
 *   (b) a failure while MOUNTED degrades to the pane-local error; the pane (and
 *       its siblings) survive.
 *
 * VERIFICATION DEPTH: happy-dom + act() runs React synchronously and silently
 * no-ops a setState-after-unmount, so the browser-only fiber invariant is not
 * reproducible here (same limitation documented in doc-pane-unmount-503.test.tsx).
 * The abort-on-unmount is the deterministically observable mechanism that
 * discriminates the fix's unmount cleanup.
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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const STATUS_URL = 'https://sam.neutron.test/api/cores/integrations'
const ARCHIVED_URL = 'https://sam.neutron.test/api/app/projects/archived'
const CODEX_URL = 'https://sam.neutron.test/api/app/codex-auth'
const START_PREFIX = 'https://sam.neutron.test/api/cores/oauth/google/start'
const DISCONNECT_PREFIX = 'https://sam.neutron.test/api/cores/oauth/google/disconnect/'

/** A not-yet-connected Google service — the server's bare placeholder row. */
const OAUTH_DISCONNECTED = {
  ok: true,
  oauth: [
    {
      kind: 'oauth',
      label: 'google_calendar',
      connected: false,
      scopes: [],
      email: null,
      connected_at: null,
      last_refresh_at: null,
      last_refresh_outcome: null,
      expires_at: null,
      scope: 'calendar.readonly',
      core_slugs: ['calendar-core'],
    },
  ],
  api_keys: [],
}

const OAUTH_CONNECTED = {
  ok: true,
  oauth: [
    {
      ...OAUTH_DISCONNECTED.oauth[0],
      label: 'google_calendar#a1b2c3d4',
      connected: true,
      email: 'sam@example.com',
      connected_at: 1,
      last_refresh_outcome: 'ok',
    },
  ],
  api_keys: [],
}

function findBtn(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  )
  if (found === undefined) throw new Error(`no button with aria-label='${label}'`)
  return found as HTMLButtonElement
}

describe('IntegrationsTab unmount safety (#380 sweep)', () => {
  it('(a) unmounting mid-flight ABORTS the in-flight integrations READ and never throws past the pane (RED pre-fix)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { IntegrationsTab } = await import('../IntegrationsTab.tsx')
    const React = await import('react')

    let statusSignal: AbortSignal | undefined
    let statusStarted = false
    const held = new Promise<Response>(() => {}) // never settles until abort
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === STATUS_URL && (init?.method ?? 'GET') === 'GET') {
        statusStarted = true
        statusSignal = init?.signal ?? undefined
        return held
      }
      if (url === ARCHIVED_URL) return json({ ok: true, archived: [] })
      if (url === CODEX_URL) return json({ status: 'not_connected' })
      return json({ ok: false }, 404)
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const realErr = console.error
    const errs: string[] = []
    console.error = (...a: unknown[]): void => void errs.push(String(a[0] ?? ''))
    let escaped: unknown = null
    try {
      await act(async () => {
        root.render(
          <React.StrictMode>
            <IntegrationsTab config={config} fetchImpl={fetchImpl} />
          </React.StrictMode>,
        )
      })
      await act(async () => {
        await tick()
        await tick()
      })
      expect(statusStarted).toBe(true)
      await act(async () => {
        root.unmount()
        await tick()
      })
    } catch (e) {
      escaped = e
    } finally {
      console.error = realErr
    }

    // The pane threaded an AbortController into the GET read and aborted it on
    // unmount (RED pre-fix: no controller → `init.signal` undefined). getStatus
    // is a GET, so abort-reads-only still cancels it.
    expect(statusSignal).toBeInstanceOf(AbortSignal)
    expect(statusSignal?.aborted).toBe(true)
    expect(escaped).toBeNull()
    expect(errs.some((e) => e.includes('unmount') || e.includes('fiber'))).toBe(false)
    container.remove()
  })

  it('(b) an integrations load failure while mounted degrades to the pane-local error; the pane + siblings survive', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { IntegrationsTab } = await import('../IntegrationsTab.tsx')
    const React = await import('react')

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === STATUS_URL) return json({ ok: false, code: 'unavailable', message: 'HTTP 503' }, 503)
      if (url === ARCHIVED_URL) return json({ ok: true, archived: [] })
      if (url === CODEX_URL) return json({ status: 'not_connected' })
      return json({ ok: false }, 404)
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <div>
          <div data-testid="sibling">sibling still here</div>
          <React.StrictMode>
            <IntegrationsTab config={config} fetchImpl={fetchImpl} />
          </React.StrictMode>
        </div>,
      )
    })
    await act(async () => {
      await tick()
      await tick()
    })

    // Sibling survived + the pane rendered its inline load error (degraded
    // locally, not a blanked app) and still shows its own chrome.
    expect(container.querySelector('[data-testid="sibling"]')).not.toBeNull()
    expect(container.querySelector('.cdoc-comments-error')).not.toBeNull()
    expect(container.textContent).toContain('Integrations')
    await act(async () => root.unmount())
    container.remove()
  })

  // ── (c)/(d) the OAuth connect + disconnect paths, added with the Admin tab's
  // Connect/Disconnect controls. Both are async continuations that setState, so
  // they are exactly the shape the #380 regression had; and Connect additionally
  // NAVIGATES, which must not fire for a tab the owner has already left.
  it('(c) unmounting mid-connect neither navigates nor setStates after unmount', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { IntegrationsTab } = await import('../IntegrationsTab.tsx')
    const React = await import('react')

    let releaseStart: (r: Response) => void = () => {}
    const heldStart = new Promise<Response>((r) => {
      releaseStart = r
    })
    let startSignal: AbortSignal | undefined
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.startsWith(START_PREFIX)) {
        startSignal = init?.signal ?? undefined
        return await heldStart
      }
      if (url === STATUS_URL) return json(OAUTH_DISCONNECTED)
      if (url === ARCHIVED_URL) return json({ ok: true, archived: [] })
      if (url === CODEX_URL) return json({ status: 'not_connected' })
      return json({ ok: false }, 404)
    }

    const navigations: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const realErr = console.error
    const errs: string[] = []
    console.error = (...a: unknown[]): void => void errs.push(String(a[0] ?? ''))
    let escaped: unknown = null
    try {
      await act(async () => {
        root.render(
          <React.StrictMode>
            <IntegrationsTab
              config={config}
              fetchImpl={fetchImpl}
              navigate={(u) => void navigations.push(u)}
              confirmImpl={() => true}
            />
          </React.StrictMode>,
        )
      })
      await act(async () => {
        await tick()
        await tick()
      })

      await act(async () => {
        findBtn(container, 'Connect Google Calendar').click()
        await tick()
      })

      // Leave the tab while the start round-trip is still in flight, THEN let
      // it settle.
      await act(async () => {
        root.unmount()
        await tick()
      })
      await act(async () => {
        releaseStart(
          json({ ok: true, authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', state: 's', expires_at: 9 }),
        )
        await tick()
        await tick()
      })
    } catch (e) {
      escaped = e
    } finally {
      console.error = realErr
    }

    // /start is a GET, so the pane's read-abort covers it on unmount…
    expect(startSignal).toBeInstanceOf(AbortSignal)
    expect(startSignal?.aborted).toBe(true)
    // …and either way the continuation bails: no navigation is forced on an
    // owner who already left the tab, and nothing setStates on a gone pane.
    expect(navigations).toEqual([])
    expect(escaped).toBeNull()
    expect(errs.some((e) => e.includes('unmount') || e.includes('fiber'))).toBe(false)
    container.remove()
  })

  it('(d) a disconnect POST fired just before unmount still REACHES the server, and its continuation setStates nothing', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { IntegrationsTab } = await import('../IntegrationsTab.tsx')
    const React = await import('react')

    let releaseDisc: (r: Response) => void = () => {}
    const heldDisc = new Promise<Response>((r) => {
      releaseDisc = r
    })
    let discSignal: AbortSignal | undefined | null = null
    let discReached = false
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.startsWith(DISCONNECT_PREFIX)) {
        discReached = true
        discSignal = init?.signal ?? undefined
        return await heldDisc
      }
      if (url === STATUS_URL) return json(OAUTH_CONNECTED)
      if (url === ARCHIVED_URL) return json({ ok: true, archived: [] })
      if (url === CODEX_URL) return json({ status: 'not_connected' })
      return json({ ok: false }, 404)
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const realErr = console.error
    const errs: string[] = []
    console.error = (...a: unknown[]): void => void errs.push(String(a[0] ?? ''))
    let escaped: unknown = null
    try {
      await act(async () => {
        root.render(
          <React.StrictMode>
            <IntegrationsTab
              config={config}
              fetchImpl={fetchImpl}
              navigate={() => {}}
              confirmImpl={() => true}
            />
          </React.StrictMode>,
        )
      })
      await act(async () => {
        await tick()
        await tick()
      })

      await act(async () => {
        findBtn(container, 'Disconnect Google Calendar (sam@example.com)').click()
        await tick()
      })
      await act(async () => {
        root.unmount()
        await tick()
      })
      await act(async () => {
        releaseDisc(json({ ok: true, disconnected: ['google_calendar#a1b2c3d4'], affected_cores: [] }))
        await tick()
        await tick()
      })
    } catch (e) {
      escaped = e
    } finally {
      console.error = realErr
    }

    // A WRITE the owner already fired is never aborted — it must still land on
    // the server. Only its continuation is suppressed.
    expect(discReached).toBe(true)
    expect(discSignal).toBeUndefined()
    expect(escaped).toBeNull()
    expect(errs.some((e) => e.includes('unmount') || e.includes('fiber'))).toBe(false)
    container.remove()
  })
})
