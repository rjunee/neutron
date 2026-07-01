/**
 * landing/chat-react — light/dark theme resolution (Ryan-requested, 2026-07-01).
 *
 * The web chat is CSS-variable-driven (see `chat-react.html`): a single stylesheet
 * with a dark `:root` var set and a light `:root[data-theme="light"]` override set.
 * The EFFECTIVE theme is always an explicit `light` | `dark` written to the
 * `data-theme` attribute on the document root — CSS never resolves "system"
 * itself, so it only ever needs two concrete states. This module owns the
 * resolution (persisted preference vs. system `prefers-color-scheme`) so it is
 * pure and unit-testable without a DOM; the React `useTheme` hook and the
 * pre-paint inline script in `chat-react.html` both apply what it computes.
 *
 * Three USER preferences:
 *   - 'system' (DEFAULT) — follow the OS `prefers-color-scheme`, live.
 *   - 'light'            — force iMessage-light regardless of the OS.
 *   - 'dark'             — force the original dark palette regardless of the OS.
 *
 * The RESOLVED theme is always 'light' or 'dark'. Persisted in localStorage so
 * the choice survives reloads.
 */

/** What the user picked. 'system' defers to `prefers-color-scheme`. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** The concrete theme actually applied to the DOM (`data-theme`). */
export type ResolvedTheme = 'light' | 'dark'

/** localStorage key for the persisted {@link ThemePreference}. */
export const THEME_STORAGE_KEY = 'neutron-theme'

/** Absent / unrecognized preference falls back to following the system. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** The browser chrome `theme-color` (PWA/mobile address-bar tint) per resolved
 *  theme. Kept in LOCKSTEP with the pre-paint inline script in `chat-react.html`
 *  so a runtime toggle and a fresh page load agree. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f5f5f7',
  dark: '#0b0d10',
}

/** The minimal `Storage` surface this module touches (so tests can pass a stub
 *  without a real `localStorage`). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The minimal element surface {@link applyResolvedTheme} touches. */
export interface RootLike {
  setAttribute(name: string, value: string): void
}

/** Type guard: is `v` a valid stored {@link ThemePreference}? */
export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system'
}

/**
 * Resolve a preference + the current system signal to a concrete theme.
 *
 * This is the ONE source of truth for "system vs. override vs. persisted": an
 * explicit 'light'/'dark' preference wins outright; 'system' (the default, and
 * anything unrecognized) follows `systemPrefersLight`.
 */
export function resolveTheme(pref: ThemePreference, systemPrefersLight: boolean): ResolvedTheme {
  if (pref === 'light') return 'light'
  if (pref === 'dark') return 'dark'
  return systemPrefersLight ? 'light' : 'dark'
}

/**
 * Read the persisted preference, defaulting to 'system' when absent, unreadable,
 * or corrupt. Never throws — a sandboxed / disabled `localStorage` (getItem
 * raises) degrades to the system default.
 */
export function readStoredPreference(storage: StorageLike | null | undefined): ThemePreference {
  if (storage === null || storage === undefined) return DEFAULT_PREFERENCE
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : DEFAULT_PREFERENCE
  } catch {
    return DEFAULT_PREFERENCE
  }
}

/** Persist the chosen preference (including 'system', so a user can explicitly
 *  return to following the OS). Never throws — a write failure is non-fatal. */
export function writeStoredPreference(
  storage: StorageLike | null | undefined,
  pref: ThemePreference,
): void {
  if (storage === null || storage === undefined) return
  try {
    storage.setItem(THEME_STORAGE_KEY, pref)
  } catch {
    /* private-mode / quota — the in-memory preference still drives this session. */
  }
}

/**
 * The toggle's cycle order: system → light → dark → system. Starting from
 * 'system' the first tap picks the OPPOSITE of whatever the system currently
 * shows would be surprising, so we cycle deterministically through all three and
 * let the label communicate the current mode.
 */
export function cyclePreference(pref: ThemePreference): ThemePreference {
  if (pref === 'system') return 'light'
  if (pref === 'light') return 'dark'
  return 'system'
}

/** Write the resolved theme to the document root's `data-theme`. */
export function applyResolvedTheme(root: RootLike, resolved: ResolvedTheme): void {
  root.setAttribute('data-theme', resolved)
}
