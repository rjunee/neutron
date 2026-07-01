/**
 * landing/chat-react — the React binding for {@link theme.ts}.
 *
 * Owns the live theme state for the app shell: the persisted user PREFERENCE
 * (system / light / dark), the RESOLVED concrete theme, and a setter the
 * top-right toggle drives. When the preference is 'system' it subscribes to the
 * OS `prefers-color-scheme` and re-resolves live, so flipping the OS theme
 * updates the page without a reload. Every change writes `data-theme` on the
 * document root (which the CSS-variable stylesheet keys off) and persists the
 * preference to localStorage.
 *
 * The pre-paint inline script in `chat-react.html` has already set the correct
 * `data-theme` before React mounts (no dark flash); this hook re-applies on
 * mount to stay authoritative and then owns every subsequent change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  THEME_COLORS,
  applyResolvedTheme,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
  type ResolvedTheme,
  type StorageLike,
  type ThemePreference,
} from './theme.ts'

const LIGHT_QUERY = '(prefers-color-scheme: light)'

/** A `MediaQueryList` we can read + (un)subscribe. Kept minimal for testability. */
interface MediaQueryLike {
  matches: boolean
  addEventListener?: (type: 'change', cb: () => void) => void
  removeEventListener?: (type: 'change', cb: () => void) => void
}

interface MetaLike {
  setAttribute(name: string, value: string): void
}

interface WindowLike {
  matchMedia?: (q: string) => MediaQueryLike
  localStorage?: StorageLike
  document?: {
    documentElement: { setAttribute(name: string, value: string): void }
    querySelector?: (sel: string) => MetaLike | null
  }
}

/** Resolve the window once; SSR / test envs without a window degrade gracefully. */
function getWin(injected?: WindowLike): WindowLike | null {
  if (injected !== undefined) return injected
  if (typeof window === 'undefined') return null
  return window as unknown as WindowLike
}

/**
 * Read `localStorage` off the window DEFENSIVELY. Accessing the `localStorage`
 * property itself throws (not just its methods) in some privacy modes and on
 * sandboxed/opaque origins — a throw here would kill the render — so we swallow
 * it and fall back to null (the system default). The stored-preference readers
 * additionally guard the `getItem`/`setItem` calls.
 */
function safeLocalStorage(win: WindowLike | null): StorageLike | null {
  if (win === null) return null
  try {
    return win.localStorage ?? null
  } catch {
    return null
  }
}

function systemPrefersLight(win: WindowLike | null): boolean {
  if (win?.matchMedia === undefined) return false
  try {
    return win.matchMedia(LIGHT_QUERY).matches
  } catch {
    return false
  }
}

export interface UseThemeResult {
  /** The user's stored choice: 'system' | 'light' | 'dark'. */
  preference: ThemePreference
  /** The concrete theme currently applied to the DOM. */
  resolved: ResolvedTheme
  /** Persist a new preference + re-resolve + re-apply. */
  setPreference: (pref: ThemePreference) => void
}

/**
 * @param injectedWindow test-only override — the hook reads `localStorage`,
 *   `matchMedia`, and `document.documentElement` off it. Omitted in the browser.
 */
export function useTheme(injectedWindow?: WindowLike): UseThemeResult {
  const win = useMemo(() => getWin(injectedWindow), [injectedWindow])
  const storage = useMemo(() => safeLocalStorage(win), [win])

  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(storage),
  )
  const [systemLight, setSystemLight] = useState<boolean>(() => systemPrefersLight(win))

  const resolved = resolveTheme(preference, systemLight)

  // Apply the resolved theme to the DOM whenever it changes. The inline script
  // set the initial value pre-paint; this keeps the hook authoritative after —
  // including the browser chrome `theme-color` meta (which the inline script
  // also set once), so a runtime toggle doesn't leave the PWA chrome on the old
  // color until reload.
  useEffect(() => {
    const doc = win?.document
    if (doc === undefined) return
    applyResolvedTheme(doc.documentElement, resolved)
    const meta = doc.querySelector?.('meta[name="theme-color"]')
    meta?.setAttribute('content', THEME_COLORS[resolved])
  }, [win, resolved])

  // Follow the OS ONLY while the preference is 'system' — an explicit override
  // is independent of `prefers-color-scheme`, so we don't need the listener then.
  useEffect(() => {
    if (preference !== 'system' || win?.matchMedia === undefined) return
    let mql: MediaQueryLike
    try {
      mql = win.matchMedia(LIGHT_QUERY)
    } catch {
      return
    }
    // Re-read on mount in case the OS flipped between initial state + effect.
    setSystemLight(mql.matches)
    const onChange = (): void => setSystemLight(mql.matches)
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [preference, win])

  const setPreference = useCallback(
    (pref: ThemePreference): void => {
      writeStoredPreference(storage, pref)
      // Snap the system signal fresh at the moment of choosing so a switch TO
      // 'system' resolves immediately, before the media listener re-subscribes.
      setSystemLight(systemPrefersLight(win))
      setPreferenceState(pref)
    },
    [storage, win],
  )

  return { preference, resolved, setPreference }
}
