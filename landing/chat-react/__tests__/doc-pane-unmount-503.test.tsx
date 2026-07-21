/**
 * REGRESSION (#380, live-hit by Ryan 2026-07-20): the React chat client blanked
 * the ENTIRE app when a single doc/history pane fetch 503'd during a project
 * switch. Console: `503` on `…/docs/file?path=starting-plan.md` + `?path=history.md`,
 * then `Uncaught Error: Tried to unmount a fiber that is already unmounted`, then
 * the top-level boundary caught it and blanked everything.
 *
 * ROOT CAUSE: DocumentsTab's async doc-fetch continuations (`readFile` etc.) ran
 * `setState` even after the pane unmounted. React surfaces that setState-after-
 * unmount as the fiber invariant, thrown from React's own commit/teardown — NOT
 * from a child render — so the per-pane PaneErrorBoundary added in #408 could not
 * catch it. It escaped to the single app-level boundary (ChatApp) → whole screen
 * blank. #408 added the boundary (necessary) but never guarded the continuations
 * (the missing half). This pins BOTH halves.
 *
 * NOTE ON DEPTH: React 19 silently NO-OPs a setState-after-unmount in this
 * happy-dom + `act()` harness (verified: it neither throws nor logs), so the
 * exact fiber invariant is not reproducible here — it needs a real concurrent
 * browser commit. What IS deterministically observable is the DEFENSIVE
 * CONTRACT the fix installs: (1) the in-flight fetch is ABORTED on unmount (so
 * the 503 can't even land), and (2) the pane degrades locally with a retry while
 * its siblings keep rendering. The abort assertion is RED on pre-fix code (no
 * AbortController was threaded → the fetch's `init.signal` is undefined).
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
  wsUrl: 'wss://t/ws',
  topicId: 'app:sam',
  userId: 'sam',
  projectId: 'acme',
  projects: [{ id: 'acme', label: 'Acme' }],
  origin: 'https://sam.neutron.test',
  deviceId: 'd',
  token: 'dev:sam',
}

const HISTORY_TREE = {
  ok: true,
  file_count: 1,
  tree: [
    {
      kind: 'file',
      path: 'history.md',
      name: 'history.md',
      size_bytes: 1,
      modified_at: 1,
      content_type: null,
      referenced_by_count: null,
      origin: null,
      children: [],
    },
  ],
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('doc pane 503 does not blank the app (#380)', () => {
  it('(a)+(b) a 503 doc fetch degrades to a per-pane error+retry; siblings survive', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { DocumentsTab } = await import('../DocumentsTab.tsx')
    const { PaneErrorBoundary } = await import('../PaneErrorBoundary.tsx')

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/docs/tree')) return jsonRes(HISTORY_TREE)
      // The reported failure: the doc/history file read 503s.
      if (url.includes('/docs/file?path=')) return jsonRes({ ok: false, code: 'unavailable', message: 'HTTP 503' }, 503)
      if (url.includes('/docs/comments?path=')) return jsonRes({ ok: true, threads: [], next_cursor: null })
      return jsonRes({ ok: false }, 404)
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // React logs the caught error for a real throw; silence deliberate noise.
    const realErr = console.error
    console.error = (): void => {}
    try {
      await act(async () => {
        root.render(
          <div>
            <div data-testid="chat">chat transcript</div>
            <PaneErrorBoundary label="Documents">
              <DocumentsTab
                projectId="acme"
                config={config}
                fetchImpl={fetchImpl}
                openRequest={{ path: 'history.md', nonce: 1 }}
              />
            </PaneErrorBoundary>
            <div data-testid="rail">project rail</div>
          </div>,
        )
      })
      await act(async () => {
        await tick()
        await tick()
      })
    } finally {
      console.error = realErr
    }

    // (a) The app root SURVIVED — chat + rail still rendered, and the per-pane
    //     boundary did NOT trip to its whole-pane "could not load" fallback.
    expect(container.querySelector('[data-testid="chat"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="rail"]')).not.toBeNull()
    expect(container.querySelector('.pane-error')).toBeNull()

    // (b) The doc pane itself shows an inline error + a retry affordance.
    expect(container.querySelector('.cdoc-file-retry')).not.toBeNull()
    const alert = container.querySelector('.cdoc-view [role="alert"]')
    expect(alert).not.toBeNull()

    await act(async () => root.unmount())
    container.remove()
  })

  it('(c) unmounting mid-flight aborts the in-flight doc fetch and never throws past the pane', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { DocumentsTab } = await import('../DocumentsTab.tsx')
    const { PaneErrorBoundary } = await import('../PaneErrorBoundary.tsx')

    // A deferred file read that never settles until we release it — we hold it
    // open so the pane can unmount WHILE it is still in flight.
    let rejectFile: (e: unknown) => void = () => {}
    const filePromise = new Promise<Response>((_, rej) => {
      rejectFile = rej
    })
    let fileSignal: AbortSignal | undefined
    let fileFetchStarted = false

    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/docs/tree')) return jsonRes(HISTORY_TREE)
      if (url.includes('/docs/file?path=')) {
        fileFetchStarted = true
        // Capture the signal the client threaded through for THIS request.
        fileSignal = init?.signal ?? undefined
        return filePromise
      }
      if (url.includes('/docs/comments?path=')) return jsonRes({ ok: true, threads: [], next_cursor: null })
      return jsonRes({ ok: false }, 404)
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const realErr = console.error
    const errs: string[] = []
    console.error = (...a: unknown[]): void => {
      errs.push(String(a[0] ?? ''))
    }

    let escaped: unknown = null
    try {
      await act(async () => {
        root.render(
          <div>
            <div data-testid="chat">chat transcript</div>
            <PaneErrorBoundary label="Documents">
              <DocumentsTab
                projectId="acme"
                config={config}
                fetchImpl={fetchImpl}
                openRequest={{ path: 'history.md', nonce: 1 }}
              />
            </PaneErrorBoundary>
          </div>,
        )
      })
      // Let the tree render + the file read start; then leave it in flight.
      await act(async () => {
        await tick()
        await tick()
      })
      expect(fileFetchStarted).toBe(true)

      // Project switch / navigation → the pane UNMOUNTS mid-flight.
      await act(async () => {
        root.unmount()
      })

      // Only NOW does the 503 come back — after the pane is gone. Pre-fix this
      // is the setState-after-unmount that blanked the app.
      await act(async () => {
        rejectFile(jsonRes({ ok: false, code: 'unavailable' }, 503))
        await tick()
        await tick()
      })
    } catch (e) {
      escaped = e
    } finally {
      console.error = realErr
    }

    // The fix ABORTED the in-flight fetch on unmount (RED pre-fix: no
    // AbortController was threaded, so `init.signal` was undefined).
    expect(fileSignal).toBeInstanceOf(AbortSignal)
    expect(fileSignal?.aborted).toBe(true)

    // No error escaped `act()` (nothing propagated past the pane boundary), and
    // React logged no component-tree error for the late rejection.
    expect(escaped).toBeNull()
    expect(errs.some((e) => e.includes('unmount') || e.includes('fiber') || e.includes('component'))).toBe(false)

    container.remove()
  })
})
