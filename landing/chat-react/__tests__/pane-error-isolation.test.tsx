/**
 * A failing PANE must not blank the whole app.
 *
 * THE BUG (live, Ryan 2026-07-20): clicking to a different project sometimes
 * blanked the ENTIRE screen. Console showed the #354 signature ("Tried to
 * unmount a fiber that is already unmounted") plus a 503 on a `docs/file`
 * fetch.
 *
 * #354's own fix (the memoized adapter in `useNeutronChat.ts`) was intact and
 * its regression test still passed — a DIFFERENT trigger was reaching the same
 * failure. The structural reason ANY such trigger blanked everything: the
 * client had exactly ONE error boundary (`ChatApp.tsx`, wrapping the whole
 * surface) and `DocumentsTab` — which does its own network I/O on project
 * switch — sat inside it unisolated.
 *
 * This pins the ISOLATION rather than any single trigger, so it holds whichever
 * fetch fails: a pane that throws renders its own inline error and its SIBLINGS
 * KEEP RENDERING.
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

function Exploding(): never {
  throw new Error('doc fetch failed (503)')
}

describe('pane error isolation', () => {
  it('a throwing pane does NOT take down its siblings', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { PaneErrorBoundary } = await import('../PaneErrorBoundary.tsx')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // React logs the caught error; silence only for this deliberate throw.
    const spy = console.error
    console.error = (): void => {}
    try {
      await act(async () => {
        root.render(
          <div>
            <div data-testid="sibling-chat">chat transcript</div>
            <PaneErrorBoundary label="Documents">
              <Exploding />
            </PaneErrorBoundary>
            <div data-testid="sibling-rail">project rail</div>
          </div>,
        )
      })
    } finally {
      console.error = spy
    }

    // The pane degraded LOCALLY...
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent ?? '').toContain('Documents')

    // ...and everything around it SURVIVED. Pre-fix the single app-level
    // boundary caught this and replaced the ENTIRE tree — both siblings
    // vanished, which is exactly what the black screen was.
    expect(container.querySelector('[data-testid="sibling-chat"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="sibling-rail"]')).not.toBeNull()

    await act(async () => root.unmount())
    container.remove()
  })

  it('a healthy pane renders its children untouched', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { PaneErrorBoundary } = await import('../PaneErrorBoundary.tsx')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <PaneErrorBoundary label="Documents">
          <div data-testid="docs">docs content</div>
        </PaneErrorBoundary>,
      )
    })

    expect(container.querySelector('[data-testid="docs"]')?.textContent).toBe('docs content')
    expect(container.querySelector('[role="alert"]')).toBeNull()

    await act(async () => root.unmount())
    container.remove()
  })
})
