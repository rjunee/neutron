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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveOwnerSlug } from '../owner-identity.ts'
import { resolveOwnerSlugSourceFromConfig } from '@neutronai/gateway/index.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-slug-agreement-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * Ask the BOOT resolver the same question the CLI is about to be asked.
 *
 * ⚠️ THE FIRST VERSION OF THIS HELPER PINNED `ownerHome: undefined`, and a
 * review pointed out that this deliberately removed the very boundary the file
 * claims to guard: with `.url_slug` excluded, the two resolvers agreed on the
 * env axis while still disagreeing on the file axis. A test written around the
 * half you just fixed proves the half you just fixed.
 */
function bootSlug(env: NodeJS.ProcessEnv): string {
  return resolveOwnerSlugSourceFromConfig({
    instanceSlug: env['NEUTRON_INSTANCE_SLUG'],
    neutronHome: env['NEUTRON_HOME'],
    ownerHome: env['OWNER_HOME'],
  } as unknown as Parameters<typeof resolveOwnerSlugSourceFromConfig>[0]).slug
}

describe('the boot resolver and the CLI resolver agree', () => {
  // Absent, empty, whitespace, the fallback spelled explicitly, and an ordinary
  // slug. The middle three are the ones that have actually diverged.
  const CASES: Array<string | undefined> = [undefined, '', '   ', '\t\n', 'dev', 'live-owner']

  for (const value of CASES) {
    it(`agrees for ${value === undefined ? 'an absent value' : JSON.stringify(value)}`, () => {
      const env = (value === undefined
        ? {}
        : { NEUTRON_INSTANCE_SLUG: value }) as NodeJS.ProcessEnv
      expect(resolveOwnerSlug(env)).toBe(bootSlug(env))
    })
  }

  it('agrees when a RENAMED instance has `.url_slug` and a stale env var', () => {
    // The axis the first version of this test excluded. An orchestrator rename
    // writes the new name to `.url_slug` while the env still carries the old
    // one; boot prefers the file. A CLI that read only the env would resolve the
    // OLD name and filter every event and job by an identity nothing writes
    // under — reporting an empty instance for a system running perfectly well.
    writeFileSync(join(home, '.url_slug'), 'renamed\n', 'utf8')
    const env = { OWNER_HOME: home, NEUTRON_INSTANCE_SLUG: 'old' } as NodeJS.ProcessEnv
    expect(bootSlug(env)).toBe('renamed')
    expect(resolveOwnerSlug(env)).toBe('renamed')
  })

  it('agrees that a BLANK `.url_slug` falls through to the env', () => {
    writeFileSync(join(home, '.url_slug'), '   \n', 'utf8')
    const env = { OWNER_HOME: home, NEUTRON_INSTANCE_SLUG: 'from-env' } as NodeJS.ProcessEnv
    expect(resolveOwnerSlug(env)).toBe(bootSlug(env))
    expect(resolveOwnerSlug(env)).toBe('from-env')
  })

  it('resolves a blank value to the fallback, not to the blank itself', () => {
    // The specific regression: `neutron doctor` reporting project_slug "   " and
    // recent_events [] while the instance was running perfectly well as `dev`.
    const env = { NEUTRON_INSTANCE_SLUG: '   ' } as NodeJS.ProcessEnv
    expect(resolveOwnerSlug(env)).toBe('dev')
    expect(bootSlug(env)).toBe('dev')
  })

  it('still honours a real slug, so the guard has not simply been disabled', () => {
    const env = { NEUTRON_INSTANCE_SLUG: 'live-owner' } as NodeJS.ProcessEnv
    expect(resolveOwnerSlug(env)).toBe('live-owner')
    expect(bootSlug(env)).toBe('live-owner')
  })
})
