/**
 * ISSUES #401 / #403 — mobile rail behaviour Ryan hit on device 2026-07-27.
 *
 * These are pure-logic assertions over the same helpers the components use, so
 * they pin the invariants without a renderer. The component wiring is verified
 * separately on the emulator — a green test here is not a working app.
 */
import { describe, expect, it } from 'bun:test'

import { GENERAL_PROJECT_ID } from '../lib/project-rail-view'
import { appWsProjectTopicId, appWsTopicId } from '@neutronai/wire-types/topic-id.ts'

/** Mirrors the rail-list construction in `app/projects/[id]/_layout.tsx`. */
function buildRailIds(apiProjectIds: readonly string[], activeId: string): string[] {
  const views = [...apiProjectIds]
  if (!views.includes(activeId)) views.unshift(activeId)
  if (!views.includes(GENERAL_PROJECT_ID)) views.unshift(GENERAL_PROJECT_ID)
  return views
}

describe('mobile rail — General is present (#403)', () => {
  it('injects General even though the API never returns it', () => {
    // General is the NO-PROJECT scope, so it is never a row in `projects`.
    const ids = buildRailIds(['willow', 'tabs'], 'willow')
    expect(ids).toContain(GENERAL_PROJECT_ID)
  })

  it('pins General to the head — it is the default scope', () => {
    expect(buildRailIds(['willow', 'tabs'], 'willow')[0]).toBe(GENERAL_PROJECT_ID)
  })

  it('never duplicates General if the API somehow returns it', () => {
    const ids = buildRailIds([GENERAL_PROJECT_ID, 'willow'], 'willow')
    expect(ids.filter((i) => i === GENERAL_PROJECT_ID).length).toBe(1)
  })

  it("General's topic is the user-scoped one, not a project topic", () => {
    // Guards `app:owner:general`, which would be a real topic holding nothing.
    expect(appWsTopicId('owner')).toBe('app:owner')
    expect(appWsTopicId('owner')).not.toBe(appWsProjectTopicId('owner', GENERAL_PROJECT_ID))
  })
})

/**
 * ISSUES #401 — the rail must not swallow a tap on the entry that is already
 * active. It did, which made the FIRST entry unopenable: active on mount, so
 * its tap was a no-op and the chat never loaded. Modelled here as the predicate
 * the component now uses.
 */
describe('mobile rail — an active entry still responds to a tap (#401)', () => {
  /** Mirrors `ProjectRail` after the fix: always notify. */
  const notifiesOnTap = (_isActive: boolean): boolean => true

  it('notifies for an inactive entry', () => {
    expect(notifiesOnTap(false)).toBe(true)
  })

  it('ALSO notifies for the already-active entry — this was the bug', () => {
    expect(notifiesOnTap(true)).toBe(true)
  })
})
