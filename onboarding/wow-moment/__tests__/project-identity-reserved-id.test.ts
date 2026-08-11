/**
 * THE RESERVATION MUST NOT MINT A SECOND COLLISION.
 *
 * `general` is both the no-project sentinel and a legal project id, so a name that
 * would slugify to it is suffixed away instead of rejected. The obvious suffix —
 * `general-project` — is REACHABLE by this very function: a project genuinely named
 * "General Project" slugifies to exactly that string. `resolveBindTarget`
 * (`gateway/wiring/project-create.ts`) resolves a colliding slug to the EXISTING
 * project, so two distinct names would have silently become ONE project. The escape
 * hatch for one collision had quietly created another.
 *
 * A TRAILING `-` cannot be produced from any input, because the slugifier trims
 * exactly that immediately before it returns — so the reserved value is unreachable
 * BY CONSTRUCTION rather than by picking a word nobody is expected to type. Same
 * reasoning as the mobile rail's `~general` sentinel (`app/lib/project-rail-view.ts`),
 * a value the id validator itself rejects.
 */

import { describe, expect, test } from 'bun:test'

import { slugifyProjectId } from '../project-identity.ts'

describe('the reserved-id suffix is unreachable', () => {
  test('a name that would mint the sentinel is suffixed away from it', () => {
    expect(slugifyProjectId('General')).not.toBe('general')
    expect(slugifyProjectId('general')).not.toBe('general')
    expect(slugifyProjectId('  GENERAL  ')).not.toBe('general')
  })

  test('"General" and "General Project" remain DIFFERENT projects', () => {
    // The regression this closes: both used to slugify to `general-project`, so
    // creating the second silently bound the owner to the first.
    expect(slugifyProjectId('General')).not.toBe(slugifyProjectId('General Project'))
    expect(slugifyProjectId('General Project')).toBe('general-project')
  })

  test('no ordinary input can produce the reserved id — trailing dashes are trimmed', () => {
    const reserved = slugifyProjectId('General')
    // The property the unreachability rests on, asserted directly rather than by
    // sampling for the one string: whatever a name slugifies to, it never ends in
    // `-` unless it hit the reservation.
    for (const name of [
      'General-',
      'General -',
      'General!!!',
      '  General  ',
      'General Project',
      'General (project)',
      'Anything at all - really',
      'trailing---dashes---',
    ]) {
      const slug = slugifyProjectId(name)
      if (slug !== reserved) expect(slug.endsWith('-')).toBe(false)
    }
    // ...and the reserved value is the one string that breaks that property, which
    // is precisely why nothing else can collide with it.
    expect(reserved.endsWith('-')).toBe(true)
  })

  test('the result is still a legal project id', () => {
    // `sanitizeProjectId` accepts `[A-Za-z0-9_.-]+`; a trailing `-` is in that set,
    // and unlike the mobile rail's `~` this value also has to survive as a real
    // directory component and route segment.
    expect(/^[A-Za-z0-9_.-]+$/.test(slugifyProjectId('General'))).toBe(true)
    expect(slugifyProjectId('General').length).toBeLessThanOrEqual(64)
    expect(encodeURIComponent(slugifyProjectId('General'))).toBe(slugifyProjectId('General'))
  })
})
