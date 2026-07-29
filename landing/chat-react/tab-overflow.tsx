/**
 * landing/chat-react — section-tab overflow into a "⋯ more" menu (FIX #350).
 *
 * The seated tab band used to scroll horizontally (`overflow-x: auto`) when the
 * tabs didn't fit — awkward on mobile, where the title now sits on its own line
 * and the band gets the full viewport width. Instead we MEASURE: as many tabs as
 * fit render inline; the rest collapse into a right-aligned "⋯" button that opens
 * an accessible dropdown menu.
 *
 * `computeVisibleCount` is the pure fit calculation (unit-tested without a DOM).
 * `useTabOverflow` owns the measurement: a `visibility:hidden` mirror row (all
 * tabs, styled identically) yields stable widths regardless of what's currently
 * inline, and a `ResizeObserver` on the band re-fits on width changes.
 * `OverflowMenu` is the keyboard-accessible "⋯" button + menu.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The greatest N such that the first N tab widths (+ inter-tab gaps) fit in
 * `available`. When they don't all fit, room for the overflow button is reserved
 * so the "⋯" affordance is always reachable. At least one tab (Chat) always
 * stays inline. Returns `widths.length` when everything fits.
 */
export function computeVisibleCount(
  widths: readonly number[],
  available: number,
  overflowWidth: number,
  gap: number,
): number {
  const n = widths.length
  if (n <= 1) return n
  // Unmeasured — no layout yet, a hidden band, or a DOM (jsdom/happy-dom) that
  // reports zero geometry. Don't collapse anything; show every tab inline until
  // a real measurement arrives (otherwise gaps alone would fake an overflow).
  const sumWidths = widths.reduce((acc, w) => acc + (w ?? 0), 0)
  if (available <= 0 || sumWidths <= 0) return n
  // Everything (with gaps between) fits → no overflow, no reserved button.
  let total = 0
  for (let i = 0; i < n; i++) total += (widths[i] ?? 0) + (i > 0 ? gap : 0)
  if (total <= available) return n

  // Overflow: fit as many as possible while leaving room for the "⋯" button.
  const budget = available - overflowWidth - gap
  let used = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const next = used + (widths[i] ?? 0) + (i > 0 ? gap : 0)
    if (next > budget) break
    used = next
    count++
  }
  return Math.max(1, count)
}

/** Inter-tab gap in px — matches `.car-tabs { gap: 2px }` in `chat-react.html`. */
const TAB_GAP = 2
/** Fallback "⋯" button width before it's been measured. */
const DEFAULT_OVERFLOW_W = 46

export interface TabOverflow {
  /** Attach to the visible tab band (`.car-tabs`) — the width we fit against. */
  bandRef: React.RefCallback<HTMLElement>
  /** Attach to the hidden measurement mirror (all tabs at natural width). */
  mirrorRef: React.RefObject<HTMLDivElement | null>
  /** Attach to the rendered "⋯" button so its real width refines the reserve. */
  overflowRef: React.RefObject<HTMLButtonElement | null>
  /** How many leading tabs render inline; the rest go to the menu. */
  visibleCount: number
}

/**
 * Measure the tab band and decide how many tabs fit. `deps` is a cheap identity
 * of the tab set (e.g. the joined keys) so a changed set re-measures.
 */
export function useTabOverflow(tabCount: number, deps: string): TabOverflow {
  const [visibleCount, setVisibleCount] = useState(tabCount)
  const bandEl = useRef<HTMLElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const overflowRef = useRef<HTMLButtonElement | null>(null)

  const recompute = useCallback(() => {
    const band = bandEl.current
    const mirror = mirrorRef.current
    if (band === null || mirror === null) return
    const children = Array.from(mirror.children) as HTMLElement[]
    const widths = children.map((c) => c.getBoundingClientRect().width)
    const overflowW = overflowRef.current?.getBoundingClientRect().width ?? DEFAULT_OVERFLOW_W
    const next = computeVisibleCount(widths, band.clientWidth, overflowW, TAB_GAP)
    setVisibleCount((prev) => (prev === next ? prev : next))
  }, [])

  // Re-measure after layout on mount and whenever the tab set changes.
  useLayoutEffect(() => {
    recompute()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps, tabCount, recompute])

  // Re-fit on band width changes (rotation, split-view, desktop↔mobile).
  useEffect(() => {
    const band = bandEl.current
    if (band === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => recompute())
    ro.observe(band)
    return () => ro.disconnect()
  }, [recompute])

  const bandRef = useCallback<React.RefCallback<HTMLElement>>(
    (el) => {
      bandEl.current = el
    },
    [],
  )

  return { bandRef, mirrorRef, overflowRef, visibleCount }
}

/** One tab's minimal shape for the menu (matches `TabDescriptor`). */
export interface OverflowTab {
  key: string
  label: string
}

/**
 * The "⋯" overflow button + dropdown. Fully keyboard-accessible: the button owns
 * `aria-haspopup`/`aria-expanded`; the menu is `role="menu"` with `menuitem`
 * children; Escape and outside-click close it; opening focuses the first item;
 * closing returns focus to the button. Arrow keys move between items.
 */
export function OverflowMenu({
  tabs,
  activeKey,
  onSelect,
  buttonRef,
}: {
  tabs: readonly OverflowTab[]
  activeKey: string
  onSelect: (key: string) => void
  buttonRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const containsActive = tabs.some((t) => t.key === activeKey)

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [buttonRef])

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (!open) return
    itemRefs.current[0]?.focus()
  }, [open])

  // Outside-click closes (no refocus — the user clicked elsewhere).
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) === true) return
      if (buttonRef.current?.contains(t) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, buttonRef])

  const focusItem = (i: number): void => {
    const n = tabs.length
    const idx = ((i % n) + n) % n
    itemRefs.current[idx]?.focus()
  }

  const onMenuKey = (e: React.KeyboardEvent): void => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusItem(current + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusItem(current - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusItem(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusItem(tabs.length - 1)
    }
  }

  return (
    <div className="car-tabmore">
      <button
        ref={buttonRef}
        type="button"
        className={`car-tab car-tabmore-btn${containsActive ? ' car-tab-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More sections (${tabs.length})`}
        title="More sections"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        ⋯
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="car-tabmore-menu"
          role="menu"
          aria-label="More sections"
          onKeyDown={onMenuKey}
        >
          {tabs.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              type="button"
              role="menuitem"
              className={`car-tabmore-item${t.key === activeKey ? ' car-tabmore-item-active' : ''}`}
              onClick={() => {
                onSelect(t.key)
                close(true)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
