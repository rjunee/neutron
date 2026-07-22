/**
 * REGRESSION (#380 sweep): SettingsTab's async continuations ran `setState` after
 * the tab unmounted (project switch / tab close). In a real browser commit that
 * setState-after-unmount surfaces as React's teardown-phase fiber invariant,
 * bypasses every error boundary, and blanks the WHOLE root (the class fix in
 * main.tsx now nets it at the root; stopping the setState at the source is the
 * real fix). This pins the two defensive contracts the fix installs:
 *   (a) DISCRIMINATING alive-ref: a write (POST /credentials) that settles AFTER
 *       unmount does NO post-unmount work — its `.then` calls `loadCreds()`, an
 *       OBSERVABLE GET refetch; the mountedRef guard makes it never fire. RED if
 *       the unmount cleanup that arms `mountedRef` is removed. (setState-after-
 *       unmount is invisible in happy-dom — a downstream fetch is not, so this is
 *       the observable that discriminates the guard's removal.)
 *   (b) in-flight READS are ABORTED on unmount (RED pre-fix: no signal threaded);
 *   (c) a failure while MOUNTED degrades to the pane-local error, pane survives.
 *
 * VERIFICATION DEPTH: happy-dom + act() runs React synchronously and silently
 * no-ops a setState-after-unmount (it neither throws the fiber invariant nor
 * logs), so the exact crash is not reproducible here (same limitation documented
 * in doc-pane-unmount-503.test.tsx). These tests pin the mechanisms that prevent
 * the crash from ever being reached, not the browser-only crash itself.
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

const CREDS_URL = 'https://sam.neutron.test/api/app/projects/acme/credentials'
const SETTINGS_URL = 'https://sam.neutron.test/api/app/projects/acme/settings'
const CODEX_URL = 'https://sam.neutron.test/api/app/projects/acme/codex-auth'

describe('SettingsTab unmount safety (#380 sweep)', () => {
  it('(a) DISCRIMINATING: a credential DELETE that settles AFTER unmount does not refetch the list', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { SettingsTab } = await import('../SettingsTab.tsx')
    const React = await import('react')

    // The probe: `removeCredential.then` — guarded by `mountedRef` — calls
    // `loadCreds()`, which fires an OBSERVABLE GET /credentials refetch. If the
    // guard is disarmed, that refetch fires AFTER unmount; the guard makes it
    // never happen. (setState-after-unmount is invisible in happy-dom — a
    // downstream fetch is not, so this is the observable that discriminates.)
    let resolveDelete: (r: Response) => void = () => {}
    const deletePromise = new Promise<Response>((res) => {
      resolveDelete = res
    })
    let credsGets = 0
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      if (url === CREDS_URL && method === 'GET') {
        credsGets += 1
        return json({ ok: true, project: [{ service: 'openai', scope: 'project', label: null }], global: [] })
      }
      if (url.includes('/api/app/projects/acme/credentials/openai') && method === 'DELETE') return deletePromise
      if (url === SETTINGS_URL) return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
      if (url === CODEX_URL) return json({ status: 'not_connected' })
      return json({ ok: false }, 404)
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
    // Baseline: mount-time load(s) of the creds list (StrictMode may double-invoke).
    const getsAfterMount = credsGets
    expect(getsAfterMount).toBeGreaterThanOrEqual(1)
    const removeBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Remove openai credential',
    ) as HTMLButtonElement
    expect(removeBtn).not.toBeUndefined()

    // Click Remove → DELETE is held in flight.
    await act(async () => {
      removeBtn.click()
      await tick()
    })
    // Unmount WHILE the DELETE is in flight, THEN let it succeed.
    await act(async () => {
      root.unmount()
    })
    await act(async () => {
      resolveDelete(json({ ok: true }))
      await tick()
      await tick()
    })

    // The write's `.then` bailed on the mountedRef guard, so `loadCreds()` never
    // fired its GET refetch after unmount. RED if the unmount cleanup that arms
    // `mountedRef` is removed.
    expect(credsGets).toBe(getsAfterMount)
    container.remove()
  })

  it('(b) unmounting mid-flight ABORTS the in-flight credentials READ (RED pre-fix)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { SettingsTab } = await import('../SettingsTab.tsx')
    const React = await import('react')

    let credsSignal: AbortSignal | undefined
    let credsStarted = false
    const held = new Promise<Response>(() => {}) // never settles until abort
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === CREDS_URL && (init?.method ?? 'GET') === 'GET') {
        credsStarted = true
        credsSignal = init?.signal ?? undefined
        return held
      }
      if (url === SETTINGS_URL) return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
      if (url === CODEX_URL) return json({ status: 'not_connected' })
      return json({ ok: false }, 404)
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const realErr = console.error
    const errs: string[] = []
    console.error = (...a: unknown[]): void => void errs.push(String(a[0] ?? ''))
    try {
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
      expect(credsStarted).toBe(true)
      await act(async () => {
        root.unmount()
        await tick()
      })
    } finally {
      console.error = realErr
    }

    // The pane threaded an AbortController into the GET read and aborted it on
    // unmount (RED pre-fix: no controller → signal undefined).
    expect(credsSignal).toBeInstanceOf(AbortSignal)
    expect(credsSignal?.aborted).toBe(true)
    expect(errs.some((e) => e.includes('unmount') || e.includes('fiber'))).toBe(false)
    container.remove()
  })

  it('(c) a credentials load failure while mounted degrades to the pane-local error; the pane survives', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { SettingsTab } = await import('../SettingsTab.tsx')
    const React = await import('react')

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === CREDS_URL) return json({ ok: false, code: 'unavailable', message: 'HTTP 503' }, 503)
      if (url === SETTINGS_URL) return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
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
            <SettingsTab projectId="acme" config={config} fetchImpl={fetchImpl} />
          </React.StrictMode>
        </div>,
      )
    })
    await act(async () => {
      await tick()
      await tick()
    })

    // Sibling survived + the pane rendered its inline creds error (degraded
    // locally, not a blanked app).
    expect(container.querySelector('[data-testid="sibling"]')).not.toBeNull()
    expect(container.querySelector('.cset-error')).not.toBeNull()
    expect(container.textContent).toContain('Credentials')
    await act(async () => root.unmount())
    container.remove()
  })
})
