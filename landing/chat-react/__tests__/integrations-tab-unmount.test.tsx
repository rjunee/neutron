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
})
