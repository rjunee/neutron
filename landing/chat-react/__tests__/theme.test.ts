/**
 * Theme-resolution unit tests (system vs. explicit override vs. persisted).
 *
 * These lock the ONE source of truth (`theme.ts`) that both the React `useTheme`
 * hook and the pre-paint inline script in `chat-react.html` mirror: an explicit
 * 'light'/'dark' preference always wins; 'system' (the default, and anything
 * unrecognized) follows `prefers-color-scheme`; the choice round-trips through
 * localStorage and degrades safely when storage is unavailable.
 */

import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_PREFERENCE,
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  cyclePreference,
  isThemePreference,
  readStoredPreference,
  resolveTheme,
  writeStoredPreference,
  type StorageLike,
  type ThemePreference,
} from '../theme.ts'

/** In-memory Storage stub. `throwing: true` simulates a sandboxed/disabled
 *  localStorage where getItem/setItem raise (private mode, blocked cookies). */
function memStorage(seed: Record<string, string> = {}, throwing = false): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem(k: string): string | null {
      if (throwing) throw new Error('denied')
      return map.get(k) ?? null
    },
    setItem(k: string, v: string): void {
      if (throwing) throw new Error('denied')
      map.set(k, v)
    },
  }
}

describe('resolveTheme (system vs override)', () => {
  it('an explicit override wins regardless of the system signal', () => {
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it("'system' follows prefers-color-scheme", () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })

  it('defaults to following the system (dark when the OS is not light)', () => {
    expect(DEFAULT_PREFERENCE).toBe('system')
    expect(resolveTheme(DEFAULT_PREFERENCE, false)).toBe('dark')
  })
})

describe('isThemePreference', () => {
  it('accepts only the three valid preferences', () => {
    for (const v of ['light', 'dark', 'system'] as const) expect(isThemePreference(v)).toBe(true)
  })
  it('rejects anything else', () => {
    for (const v of [null, undefined, '', 'LIGHT', 'auto', 42, {}]) {
      expect(isThemePreference(v)).toBe(false)
    }
  })
})

describe('readStoredPreference (persisted)', () => {
  it('returns the stored preference when valid', () => {
    expect(readStoredPreference(memStorage({ [THEME_STORAGE_KEY]: 'light' }))).toBe('light')
    expect(readStoredPreference(memStorage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark')
    expect(readStoredPreference(memStorage({ [THEME_STORAGE_KEY]: 'system' }))).toBe('system')
  })
  it('falls back to system when absent, corrupt, null, or throwing', () => {
    expect(readStoredPreference(memStorage())).toBe('system')
    expect(readStoredPreference(memStorage({ [THEME_STORAGE_KEY]: 'bogus' }))).toBe('system')
    expect(readStoredPreference(null)).toBe('system')
    expect(readStoredPreference(undefined)).toBe('system')
    expect(readStoredPreference(memStorage({}, true))).toBe('system')
  })
})

describe('writeStoredPreference (persist)', () => {
  it('persists the chosen preference under the theme key', () => {
    const s = memStorage()
    writeStoredPreference(s, 'dark')
    expect(s.map.get(THEME_STORAGE_KEY)).toBe('dark')
    // Round-trips back through the reader.
    expect(readStoredPreference(s)).toBe('dark')
  })
  it('persists an explicit return to system', () => {
    const s = memStorage({ [THEME_STORAGE_KEY]: 'light' })
    writeStoredPreference(s, 'system')
    expect(readStoredPreference(s)).toBe('system')
  })
  it('never throws when storage is unavailable', () => {
    expect(() => writeStoredPreference(null, 'light')).not.toThrow()
    expect(() => writeStoredPreference(memStorage({}, true), 'light')).not.toThrow()
  })
})

describe('cyclePreference (toggle order)', () => {
  it('cycles system → light → dark → system', () => {
    const order: ThemePreference[] = ['system', 'light', 'dark', 'system']
    let pref: ThemePreference = 'system'
    for (let i = 1; i < order.length; i++) {
      pref = cyclePreference(pref)
      expect(pref).toBe(order[i]!)
    }
  })
})

describe('applyResolvedTheme', () => {
  it('writes the resolved theme to the root data-theme attribute', () => {
    const calls: Array<[string, string]> = []
    applyResolvedTheme({ setAttribute: (n, v) => calls.push([n, v]) }, 'light')
    expect(calls).toEqual([['data-theme', 'light']])
  })
})

describe('end-to-end: persisted + system resolution', () => {
  it('a persisted override resolves independently of the system, but system tracks the OS', () => {
    const s = memStorage({ [THEME_STORAGE_KEY]: 'dark' })
    // persisted 'dark' → dark even when the OS is light
    expect(resolveTheme(readStoredPreference(s), true)).toBe('dark')
    // switch to system, OS light → light; OS dark → dark
    writeStoredPreference(s, 'system')
    expect(resolveTheme(readStoredPreference(s), true)).toBe('light')
    expect(resolveTheme(readStoredPreference(s), false)).toBe('dark')
  })
})
