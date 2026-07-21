/**
 * REGRESSION (#380, live-hit by Ryan 2026-07-20): the React chat client blanked
 * the ENTIRE app when a single doc/history pane fetch 503'd during a project
 * switch. Console: `503` on `…/docs/file?path=starting-plan.md` + `?path=history.md`,
 * then `Uncaught Error: Tried to unmount a fiber that is already unmounted`, then
 * the whole screen blanked.
 *
 * ROOT CAUSE: DocumentsTab's async continuations (`readFile`, `resolveComment`,
 * …) ran `setState` even after the pane unmounted. In a real concurrent-browser
 * commit React surfaces that setState-after-unmount as the fiber invariant,
 * thrown from React's own commit/teardown phase — NOT from a child render. The
 * per-pane `PaneErrorBoundary` (added #408, and it DOES wrap this tab in
 * `ProjectShell`) only catches errors thrown during a child RENDER, so a
 * teardown-phase invariant bypasses it; with nothing able to catch it — and no
 * boundary above `ProjectShell` at the root either — React unmounts the WHOLE
 * root. That is the blank screen. #408's isolation was necessary but could NOT
 * catch this class; the only real fix is to stop the setState-at-the-source.
 *
 * ── VERIFICATION DEPTH (read this before trusting the suite) ──────────────────
 * jsdom/happy-dom + `act()` runs React SYNCHRONOUSLY and, verified empirically,
 * React 19 SILENTLY NO-OPS a setState-after-unmount here (it neither throws the
 * fiber invariant nor logs) — so the exact crash is NOT reproducible in this
 * harness (same limitation the codebase already documents in
 * `pane-switch-no-crash.test.tsx`). A truly setState-after-unmount is therefore
 * unobservable via React alone in jsdom. What IS deterministically observable —
 * and what these tests pin as DISCRIMINATING regressions (each goes RED if its
 * half of the fix is removed) — is the defensive contract the fix installs:
 *   (c) in-flight READS are ABORTED on unmount (RED pre-fix: no signal threaded);
 *   (d) the `mountedRef` guard BAILS a continuation after unmount, so it performs
 *       no post-unmount work — proven through a write continuation whose body
 *       fires an OBSERVABLE downstream fetch (`loadComments`). RED if the unmount
 *       cleanup that flips `mountedRef` is removed (Argus's exact mutation), even
 *       though setState-after-unmount itself stays invisible in jsdom.
 * (a)+(b) pin the app-survives / per-pane-retry contract through the real
 * DocumentsTab wiring (not a synthetic throwing component).
 * NO real headless browser was exercised — jsdom only. The fiber invariant's
 * reproduction lives in a browser; this suite pins the mechanisms that prevent
 * it from ever being reached.
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

  it('(c) unmounting mid-flight aborts the in-flight doc READ and never throws past the pane', async () => {
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
        // Capture the signal the client threaded through for THIS read (GET).
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

    // The fix ABORTED the in-flight READ on unmount (RED pre-fix: no
    // AbortController was threaded, so `init.signal` was undefined). readFile is
    // a GET, so abort-reads-only still cancels it.
    expect(fileSignal).toBeInstanceOf(AbortSignal)
    expect(fileSignal?.aborted).toBe(true)

    // No error escaped `act()` (nothing propagated past the pane boundary), and
    // React logged no component-tree error for the late rejection.
    expect(escaped).toBeNull()
    expect(errs.some((e) => e.includes('unmount') || e.includes('fiber') || e.includes('component'))).toBe(false)

    container.remove()
  })

  it('(d) DISCRIMINATING mountedRef: a write continuation that settles AFTER unmount does no post-unmount work (RED if the unmount cleanup that arms mountedRef is removed)', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { DocumentsTab } = await import('../DocumentsTab.tsx')
    const { PaneErrorBoundary } = await import('../PaneErrorBoundary.tsx')

    // One loaded doc with one ACTIVE comment thread. Resolving the thread is the
    // probe: `resolveComment.then` — guarded by `mountedRef` — calls
    // `loadComments`, which fires an OBSERVABLE `/docs/comments?path=` refetch.
    // If the guard is disarmed, that refetch fires AFTER unmount; the guard makes
    // it never happen. (setState-after-unmount is invisible in jsdom — a
    // downstream fetch is not, so this is the one observable that discriminates
    // the guard's removal.)
    const ROOT_EVENT = {
      event_id: 'T1',
      event_kind: 'comment_posted' as const,
      doc_path: 'history.md',
      thread_root_id: 'T1',
      parent_event_id: null,
      anchor_start: 0,
      anchor_end: 4,
      anchor_text_excerpt: 'note',
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: 1,
      author_kind: 'user' as const,
      author_id: 'sam',
      body: 'a comment',
      metadata_json: null,
      created_at: 1,
    }
    const ACTIVE_THREAD = {
      thread_root_id: 'T1',
      doc_path: 'history.md',
      anchor: {
        current_start: 0,
        current_end: 4,
        status: 'live' as const,
        drift_hint_start: null,
        drift_hint_end: null,
        excerpt: 'note',
      },
      root: ROOT_EVENT,
      reply_count: 0,
      last_reply_at: 1,
      latest_event_kind: 'comment_posted' as const,
    }
    const THREAD_TREE = {
      ok: true,
      thread: {
        root: ROOT_EVENT,
        anchor: {
          thread_root_id: 'T1',
          doc_path: 'history.md',
          current_start: 0,
          current_end: 4,
          status: 'live' as const,
          drift_hint_start: null,
          drift_hint_end: null,
          last_rebuilt_from: 'x',
          last_rebuilt_at: 1,
          reply_count: 0,
          last_reply_at: 1,
        },
        replies: [],
      },
    }

    let unmounted = false
    let releaseResolve: () => void = () => {}
    const resolvePromise = new Promise<Response>((res) => {
      releaseResolve = () => res(jsonRes({ ok: true, resolve_event_id: 'r1', resolved_at: 2 }))
    })
    // `'unset'` distinguishes "never called" from "called with undefined signal".
    let resolveSignal: AbortSignal | undefined | 'unset' = 'unset'
    const commentsRefetchAfterUnmount: string[] = []

    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      if (unmounted && method === 'GET' && url.includes('/docs/comments?path=')) {
        commentsRefetchAfterUnmount.push(url)
      }
      if (url.endsWith('/docs/tree')) return jsonRes(HISTORY_TREE)
      if (url.includes('/docs/file?path=')) {
        return jsonRes({ ok: true, file: { path: 'history.md', content: 'hello', size_bytes: 5, modified_at: 1 } })
      }
      if (url.includes('/docs/comments/') && url.endsWith('/resolve')) {
        resolveSignal = init?.signal ?? undefined
        return resolvePromise // held open until releaseResolve()
      }
      if (url.includes('/docs/comments/') && url.endsWith('/thread')) return jsonRes(THREAD_TREE)
      if (url.includes('/docs/comments?path=')) return jsonRes({ ok: true, threads: [ACTIVE_THREAD], next_cursor: null })
      return jsonRes({ ok: false }, 404)
    }

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <PaneErrorBoundary label="Documents">
          <DocumentsTab
            projectId="acme"
            config={config}
            fetchImpl={fetchImpl}
            openRequest={{ path: 'history.md', nonce: 1 }}
          />
        </PaneErrorBoundary>,
      )
    })
    await act(async () => {
      await tick()
      await tick()
    })

    // Expand the thread, then click Resolve → resolveComment (POST) goes in
    // flight and is HELD.
    const head = container.querySelector('.cdoc-thread-head') as HTMLButtonElement | null
    expect(head).not.toBeNull()
    await act(async () => {
      head?.click()
      await tick()
    })
    const resolveBtn = Array.from(container.querySelectorAll('.cdoc-btn')).find(
      (b) => (b.textContent ?? '').trim() === 'Resolve',
    ) as HTMLButtonElement | undefined
    expect(resolveBtn).not.toBeUndefined()
    await act(async () => {
      resolveBtn?.click()
      await tick()
    })

    // The write is now in flight. Unmount the pane WHILE it is pending.
    await act(async () => {
      root.unmount()
    })
    unmounted = true

    // Only NOW does the write settle — after the pane is gone. Its `.then` would,
    // unguarded, call loadComments and fire a `/docs/comments` refetch.
    await act(async () => {
      releaseResolve()
      await tick()
      await tick()
    })

    // GUARD PROVEN: the continuation bailed → zero post-unmount comment refetch.
    // Disarm the guard (drop `mountedRef.current = false` from the unmount
    // cleanup) and this array gets the refetch → RED.
    expect(commentsRefetchAfterUnmount).toEqual([])

    // ABORT-READS-ONLY PROVEN: the write carried NO abort signal (a read would),
    // so a Save/Resolve the user fired is never dropped by a fast unmount.
    expect(resolveSignal).toBeUndefined()

    container.remove()
  })
})
