/**
 * landing/chat-react — the top-right light/dark theme toggle.
 *
 * A single button that cycles the theme PREFERENCE: system → light → dark →
 * system (see {@link cyclePreference}). The glyph shows what's currently on
 * screen (sun for light, moon for dark) with a small "Auto" marker when the
 * preference is 'system' (following the OS). All the resolution + persistence
 * lives in {@link useTheme} / {@link theme.ts}; this is purely the control.
 */

import { useTheme } from './useTheme.ts'
import { cyclePreference, type ThemePreference, type ResolvedTheme } from './theme.ts'

/** The three explicit preferences, in display order, for the settings control. */
const THEME_OPTIONS: readonly ThemePreference[] = ['system', 'light', 'dark']

/** Human label for a preference — used in the tooltip + accessible name. */
function preferenceLabel(pref: ThemePreference): string {
  if (pref === 'light') return 'Light'
  if (pref === 'dark') return 'Dark'
  return 'System'
}

/** The glyph reflects the RESOLVED theme (what the user sees), not the raw
 *  preference — so 'system' resolved to light still shows the sun. */
function glyph(resolved: ResolvedTheme): string {
  return resolved === 'light' ? '☀' : '☾'
}

export function ThemeToggle(): React.JSX.Element {
  const { preference, resolved, setPreference } = useTheme()
  const next = cyclePreference(preference)
  const label = `Theme: ${preferenceLabel(preference)}${preference === 'system' ? ` (${resolved})` : ''}`

  return (
    <button
      type="button"
      className="car-theme-toggle"
      onClick={() => setPreference(next)}
      title={`${label} — tap for ${preferenceLabel(next)}`}
      aria-label={`${label}. Switch to ${preferenceLabel(next)}.`}
    >
      <span className="car-theme-glyph" aria-hidden="true">
        {glyph(resolved)}
      </span>
      {preference === 'system' ? (
        <span className="car-theme-auto" aria-hidden="true">
          Auto
        </span>
      ) : null}
    </button>
  )
}

/**
 * FIX #350 — the LABELED light/dark control for the settings surface. The
 * top-bar cycling {@link ThemeToggle} was removed from every viewport; the
 * theme preference now lives here (General → Admin → Appearance) as an explicit
 * three-way segmented control so the choice is discoverable, not a mystery cycle.
 * Shares the exact same {@link useTheme} state (localStorage + `data-theme`), so
 * it drives the whole UI's theme the same way the old toggle did.
 */
export function ThemeControl(): React.JSX.Element {
  const { preference, resolved, setPreference } = useTheme()
  return (
    <div className="car-theme-seg" role="radiogroup" aria-label="Theme">
      {THEME_OPTIONS.map((opt) => {
        const selected = preference === opt
        const suffix = opt === 'system' ? ` (${resolved})` : ''
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`car-theme-seg-btn${selected ? ' car-theme-seg-btn-on' : ''}`}
            onClick={() => setPreference(opt)}
          >
            {preferenceLabel(opt)}
            {suffix}
          </button>
        )
      })}
    </div>
  )
}
