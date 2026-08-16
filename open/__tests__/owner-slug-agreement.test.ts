/**
 * TWO ANSWERS TO "WHO AM I" IS NOT A SECOND OPINION.
 *
 * `gateway/index.ts` resolves the boot slug and freezes it; `open/owner-identity.ts`
 * resolves it again for the banner, the self-instance row and `neutron doctor`.
 * Both read `NEUTRON_INSTANCE_SLUG`, and the second one's docblock has always
 * PROMISED it mirrors the first.
 *
 * It stopped being true the moment boot started trimming: an empty or whitespace
 * value is not an identity, so boot resolved `'   '` to the `'dev'` fallback while
 * the CLI copy kept returning `'   '`. `neutron doctor` then filtered events and
 * jobs by a slug nothing had ever written under and reported an empty instance —
 * a diagnostic quietly lying about the system it exists to diagnose, which is
 * worse than no diagnostic.
 *
 * The promise is now enforced instead of asserted in prose. If a future change
 * teaches one of them something the other does not know, this goes red.
 */

import { describe, expect, it } from 'bun:test'

import { resolveOwnerSlug } from '../owner-identity.ts'
import { resolveOwnerSlugSourceFromConfig } from '@neutronai/gateway/index.ts'

/** The boot resolver, asked with no `.url_slug` file so only the env matters. */
function bootSlug(instanceSlug: string | undefined): string {
  return resolveOwnerSlugSourceFromConfig({
    instanceSlug,
    neutronHome: undefined,
    ownerHome: undefined,
  } as unknown as Parameters<typeof resolveOwnerSlugSourceFromConfig>[0]).slug
}

describe('the boot resolver and the CLI resolver agree', () => {
  // Absent, empty, whitespace, the fallback spelled explicitly, and an ordinary
  // slug. The middle three are the ones that have actually diverged.
  const CASES: Array<string | undefined> = [undefined, '', '   ', '\t\n', 'dev', 'live-owner']

  for (const value of CASES) {
    it(`agrees for ${value === undefined ? 'an absent value' : JSON.stringify(value)}`, () => {
      const fromCli = resolveOwnerSlug(
        value === undefined ? {} : ({ NEUTRON_INSTANCE_SLUG: value } as NodeJS.ProcessEnv),
      )
      expect(fromCli).toBe(bootSlug(value))
    })
  }

  it('resolves a blank value to the fallback, not to the blank itself', () => {
    // The specific regression: `neutron doctor` reporting project_slug "   " and
    // recent_events [] while the instance was running perfectly well as `dev`.
    expect(resolveOwnerSlug({ NEUTRON_INSTANCE_SLUG: '   ' } as NodeJS.ProcessEnv)).toBe('dev')
    expect(bootSlug('   ')).toBe('dev')
  })

  it('still honours a real slug, so the guard has not simply been disabled', () => {
    expect(resolveOwnerSlug({ NEUTRON_INSTANCE_SLUG: 'live-owner' } as NodeJS.ProcessEnv)).toBe(
      'live-owner',
    )
    expect(bootSlug('live-owner')).toBe('live-owner')
  })
})
