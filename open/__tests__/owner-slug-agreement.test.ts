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
import {
  resolveOwnerSlug as gatewayResolveOwnerSlug,
  resolveOwnerSlugSourceFromConfig,
} from '@neutronai/gateway/index.ts'
import { resolveBootConfig } from '@neutronai/config/index.ts'

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
  // Uses the REAL config resolution, not a hand-built partial. The previous
  // version repeated the wrappers' own raw-env construction, so when both were
  // wrong in the same way they agreed — a test can only catch a divergence it
  // does not share.
  return resolveOwnerSlugSourceFromConfig(resolveBootConfig(env)).slug
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
      // ALL THREE, not two. The previous version never called the gateway
      // wrapper, and that is exactly where the next divergence turned up.
      expect(resolveOwnerSlug(env)).toBe(bootSlug(env))
      expect(gatewayResolveOwnerSlug(env)).toBe(bootSlug(env))
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
    expect(gatewayResolveOwnerSlug(env)).toBe('renamed')
  })

  it('agrees when `.url_slug` lives under NEUTRON_HOME rather than OWNER_HOME', () => {
    // The axis that outlived the first collapse: the gateway wrapper hardcoded
    // `neutronHome: undefined`, so with the file under NEUTRON_HOME it returned
    // the stale env value while boot and doctor both read the renamed file.
    writeFileSync(join(home, '.url_slug'), 'renamed\n', 'utf8')
    const env = { NEUTRON_HOME: home, NEUTRON_INSTANCE_SLUG: 'old' } as NodeJS.ProcessEnv
    expect(bootSlug(env)).toBe('renamed')
    expect(resolveOwnerSlug(env)).toBe('renamed')
    expect(gatewayResolveOwnerSlug(env)).toBe('renamed')
  })

  it('agrees that a BLANK `.url_slug` falls through to the env', () => {
    writeFileSync(join(home, '.url_slug'), '   \n', 'utf8')
    const env = { OWNER_HOME: home, NEUTRON_INSTANCE_SLUG: 'from-env' } as NodeJS.ProcessEnv
    expect(resolveOwnerSlug(env)).toBe(bootSlug(env))
    expect(resolveOwnerSlug(env)).toBe('from-env')
  })

  /**
   * ⚠️ THE NEXT TWO PIN `NEUTRON_HOME` TO THE EMPTY TEMP DIR, AND MUST.
   *
   * They are the only assertions in this file with an ABSOLUTE expected value
   * rather than a `resolveOwnerSlug(env) === bootSlug(env)` comparison — and the
   * comparisons are self-hermetic precisely because both sides read the same
   * box. An absolute one is not. With neither `NEUTRON_HOME` nor `OWNER_HOME`
   * set, the home is `join(homedir(), 'neutron')` (`migrations/db-path.ts:41`)
   * and the FILE beats the env (`gateway/index.ts:218` — `.url_slug` >
   * `NEUTRON_INSTANCE_SLUG` > `'dev'`), so on any machine that has
   * `~/neutron/.url_slug` these two read that operator's real instance name and
   * go red for a reason that has nothing to do with the code under test.
   *
   * They passed on the machine they were written on because that file did not
   * happen to exist there. That is a green with a dependency on the developer's
   * home directory, which is the kind of green that later reads as a real
   * failure. The default-home axis itself is still covered — by the relative
   * assertions below, which vary nothing and so cannot be fooled by it.
   */
  it('resolves a blank value to the fallback, not to the blank itself', () => {
    // The specific regression: `neutron doctor` reporting project_slug "   " and
    // recent_events [] while the instance was running perfectly well as `dev`.
    // `home` is freshly made and empty, so there is no `.url_slug` to outrank it.
    const env = { NEUTRON_HOME: home, NEUTRON_INSTANCE_SLUG: '   ' } as NodeJS.ProcessEnv
    expect(resolveOwnerSlug(env)).toBe('dev')
    expect(bootSlug(env)).toBe('dev')
  })

  it('still honours a real slug, so the guard has not simply been disabled', () => {
    const env = { NEUTRON_HOME: home, NEUTRON_INSTANCE_SLUG: 'live-owner' } as NodeJS.ProcessEnv
    expect(resolveOwnerSlug(env)).toBe('live-owner')
    expect(bootSlug(env)).toBe('live-owner')
  })

  /**
   * ASKING WHO I AM MUST NOT REQUIRE THE WHOLE ENVIRONMENT TO BE VALID.
   *
   * The first attempt at the agreement above delegated both wrappers to
   * `resolveBootConfig`, which validates every numeric knob — so an unrelated
   * `NEUTRON_PORT=bad` threw a ZodError out of `neutron doctor`, past the
   * `{ok:false}` contract `collectCliDiagnostics` documents. The agreement was
   * right; the price was not.
   *
   * Both wrappers now take `resolveIdentityConfig`: same three inputs, same
   * body, no unrelated validation.
   */
  it('answers identically whether or not an UNRELATED setting is malformed', () => {
    writeFileSync(join(home, '.url_slug'), 'renamed\n', 'utf8')
    const clean = { NEUTRON_HOME: home, NEUTRON_INSTANCE_SLUG: 'old' } as NodeJS.ProcessEnv
    const malformed = { ...clean, NEUTRON_PORT: 'bad' } as NodeJS.ProcessEnv

    // CONTROL — boot itself STILL fails loudly on the bad knob. The fix narrowed
    // the identity question, it did not silence the validation.
    expect(() => resolveBootConfig(malformed)).toThrow()

    // The identity answer is unchanged, on the file axis (the one that needs the
    // resolved home) and through both wrappers.
    expect(bootSlug(clean)).toBe('renamed')
    expect(resolveOwnerSlug(malformed)).toBe('renamed')
    expect(gatewayResolveOwnerSlug(malformed)).toBe('renamed')
  })

  it('answers identically with a malformed knob and NO identity env at all', () => {
    // The axis that hides behind a default: with neither `NEUTRON_HOME` nor
    // `OWNER_HOME` set, the home is the one `resolveNeutronHome` materialises.
    // Resolving that is exactly what pulled the full config in, so pin that the
    // narrow path still reaches the same answer with the environment broken.
    const clean = {} as NodeJS.ProcessEnv
    const malformed = { NEUTRON_PORT: 'bad' } as NodeJS.ProcessEnv
    expect(resolveOwnerSlug(malformed)).toBe(bootSlug(clean))
    expect(gatewayResolveOwnerSlug(malformed)).toBe(bootSlug(clean))
  })
})
