/**
 * The web chat's top-right menu — the twin of the mobile header's ☰.
 *
 * Owner ask, after the mobile consolidation: *"for consistency in the web interface,
 * we should put a hamburger menu in top right and locate the same settings in there.
 * I dont want settings being in two different places in web and mobile that's
 * confusing."*
 *
 * WHAT WAS ACTUALLY WRONG. It was not that web lacked a menu — it was that web and
 * mobile disagreed about what SETTINGS IS. On mobile it is a modal thing you open
 * from a header control; on web it was a TAB, sitting in the same band as Chat and
 * Documents as though "configure this project" were a place you work rather than a
 * thing you go and adjust. So the two clients taught different mental models for the
 * same feature, and the owner uses both in the same hour.
 *
 * So this does not merely ADD an entry point. It MOVES the settings and admin
 * descriptors out of the tab band and into this menu — the band keeps the places you
 * work, the menu holds the things you adjust. Adding the menu while leaving the tabs
 * would have created the third location, which is the opposite of what he asked for.
 *
 * The tabs are still real tabs underneath: choosing a row sets the same active key
 * the band used to set, and the same panel renders. Only the AFFORDANCE moved, which
 * is why no tab registry, descriptor or renderer changes.
 */

import { useEffect, useRef, useState } from 'react'

/** One menu row — a tab descriptor reduced to what a row needs. */
export interface HeaderMenuItem {
  key: string
  label: string
}

export interface HeaderMenuProps {
  items: readonly HeaderMenuItem[]
  onSelect: (key: string) => void
}

export function HeaderMenu({ items, onSelect }: HeaderMenuProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // A menu that outlives a click elsewhere is a stuck overlay. Pointer-down rather
  // than click so it closes on the way DOWN, before the click lands on whatever is
  // underneath — otherwise the first click outside is spent only on dismissing.
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: Event): void => {
      const wrap = wrapRef.current
      if (wrap !== null && e.target instanceof Node && !wrap.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Nothing to hold ⇒ no control. An empty menu button is a promise of nothing.
  if (items.length === 0) return null

  return (
    <div className="car-hmenu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="car-hmenu-btn"
        data-testid="header-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open menu"
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
      {open ? (
        <div className="car-hmenu" role="menu" data-testid="header-menu-sheet">
          {items.map((item) => (
            <button
              type="button"
              key={item.key}
              role="menuitem"
              className="car-hmenu-row"
              data-testid={`header-menu-item-${item.key}`}
              onClick={() => {
                // Close first: the menu must not survive the view it just opened.
                setOpen(false)
                onSelect(item.key)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
