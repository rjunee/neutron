/**
 * ThemeToggle wiring test (happy-dom): the top-right control mounts, reflects the
 * initial persisted/system preference, and clicking it cycles the preference,
 * flips `document.documentElement[data-theme]`, and persists to localStorage —
 * the end-to-end proof that the button + useTheme + theme.ts are wired together.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import { THEME_STORAGE_KEY } from '../theme.ts'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat' })
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** Force `matchMedia('(prefers-color-scheme: light)')` to a fixed value. */
function setSystemLight(light: boolean): void {
  window.matchMedia = ((q: string) => ({
    matches: light && q.includes('light'),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

async function mount(): Promise<void> {
  const { createRoot } = await import('react-dom/client')
  const React = await import('react')
  const { ThemeToggle } = await import('../ThemeToggle.tsx')
  const { act } = await import('react')
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(React.createElement(ThemeToggle))
  })
}

async function click(): Promise<void> {
  const { act } = await import('react')
  const btn = container.querySelector('.car-theme-toggle') as HTMLButtonElement
  await act(async () => {
    btn.click()
  })
}

describe('ThemeToggle (happy-dom)', () => {
  it('defaults to system: shows the resolved glyph + an Auto marker', async () => {
    setSystemLight(false) // OS dark
    await mount()
    const btn = container.querySelector('.car-theme-toggle') as HTMLButtonElement
    expect(btn).not.toBeNull()
    // system + OS dark → moon glyph, Auto marker present
    expect(btn.querySelector('.car-theme-glyph')?.textContent).toBe('☾')
    expect(btn.querySelector('.car-theme-auto')).not.toBeNull()
  })

  it('cycles system → light → dark, flipping data-theme + persisting each step', async () => {
    setSystemLight(false) // OS dark, so system resolves to dark
    await mount()
    // system (resolved dark)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    // → light
    await click()
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    // → dark
    await click()
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    // → back to system (resolves to dark under OS-dark)
    await click()
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('respects a persisted override on mount, independent of the system', async () => {
    setSystemLight(true) // OS light
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    await mount()
    // persisted dark wins over OS-light
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    const btn = container.querySelector('.car-theme-toggle') as HTMLButtonElement
    expect(btn.querySelector('.car-theme-auto')).toBeNull() // not following system
  })
})
