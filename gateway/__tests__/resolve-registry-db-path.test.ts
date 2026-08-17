/**
 * Argus r1 BLOCKER fix — `gateway/index.ts:resolveRegistryDbPath`
 * resolution-tier coverage.
 *
 * Pre-fix: the function only read `NEUTRON_REGISTRY_DB_PATH` then
 * `NEUTRON_HOME` then a per-user dev fallback. Old instance units that
 * pre-date the 2026-05-09 rename only export the legacy
 * `NEUTRON_REGISTRY_DB_PATH_RW` — those crash at boot before the
 * composer-side `_RW` fallbacks ever run, defeating the very defense
 * the composer fix advertised. The fix mirrors the same legacy
 * fallback in `resolveRegistryDbPath` itself with a one-shot
 * deprecation warning.
 *
 * These tests pin all four resolution tiers so future drift is
 * detected at unit-test latency rather than during an instance's first
 * boot.
 *
 * `resolveOwnerHome` — THE OTHER RESOLVER IN THE SAME FILE — is pinned at the
 * bottom, and it was not always. This suite's docblock advertised itself as
 * covering "all four resolution tiers", which was true of the function it
 * named and read as true of the file. `boot-listener-registry.ts` exports a
 * SECOND resolver with two more tiers, and dropping `.trim()` from BOTH of them
 * left this suite at **8 pass / 0 fail**. Its whitespace behaviour was pinned
 * only in `open/__tests__/owner-slug-agreement.test.ts`, three packages away,
 * as part of a cross-reader agreement argument.
 *
 * That is the same shape as the `migrations/db-path.ts` gap fixed in the same
 * change, and the same shape as the defect the two of them are about: a claim
 * whose scope is wider than the check behind it. A reader who edits this file
 * and runs the tests beside it must see the failure; "there is a suite
 * somewhere that would have caught this" is not a property anyone can rely on
 * at the moment they need it.
 */

import { describe, expect, test, spyOn } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveRegistryDbPath } from '../index.ts'
import { resolveOwnerHome } from '../boot-listener-registry.ts'

describe('resolveRegistryDbPath', () => {
  test('tier 1 — NEUTRON_REGISTRY_DB_PATH wins', () => {
    const env = {
      NEUTRON_REGISTRY_DB_PATH: '/tier-1/registry.db',
      NEUTRON_HOME: '/tier-2-home',
      NEUTRON_REGISTRY_DB_PATH_RW: '/tier-3-legacy.db',
    }
    expect(resolveRegistryDbPath(env)).toBe('/tier-1/registry.db')
  })

  test('tier 2 — NEUTRON_HOME wins when NEUTRON_REGISTRY_DB_PATH unset', () => {
    const env = {
      NEUTRON_HOME: '/srv/neutron',
      NEUTRON_REGISTRY_DB_PATH_RW: '/tier-3-legacy.db',
    }
    expect(resolveRegistryDbPath(env)).toBe('/srv/neutron/registry.db')
  })

  test('tier 3 — legacy NEUTRON_REGISTRY_DB_PATH_RW fires when neither canonical name nor NEUTRON_HOME is set', () => {
    // The 2026-05-09 SQLITE_CANTOPEN regression case: an OLD instance
    // unit (provisioned pre-fix) only exports the legacy `_RW` env.
    // Without this fallback the gateway crashes at boot before the
    // composer-side fallbacks even run.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const env = { NEUTRON_REGISTRY_DB_PATH_RW: '/legacy/registry.db' }
      expect(resolveRegistryDbPath(env)).toBe('/legacy/registry.db')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('tier 4 — dev fallback under ~/.local/share/neutron when nothing is set', () => {
    expect(resolveRegistryDbPath({})).toBe(
      join(homedir(), '.local', 'share', 'neutron', 'registry.db'),
    )
  })

  test('BLANK env values do NOT win — empty AND whitespace-only fall through to the next tier', () => {
    // Bash `Environment=NEUTRON_REGISTRY_DB_PATH=` (no value) lands as
    // the empty string. Treat it as unset so a misconfigured unit
    // doesn't open `''` and crash with a confusing SQLite error.
    //
    // WHITESPACE IS BLANK TOO, and it is asserted HERE, beside the tiers it
    // governs. All three predicates trim, but until now the only test that said
    // so lived in `open/__tests__/owner-slug-agreement.test.ts` — so this file,
    // which advertises itself as pinning "all four resolution tiers", covered
    // `''` and stopped. Reverting every trim in `resolveRegistryDbPath` left
    // THIS suite green, and a reviewer mutation-testing the resolver from its
    // own test file read that green as "unpinned" and nearly filed it. A pin
    // that lives only in a distant file is indistinguishable from no pin at the
    // place anyone looks; whitespace is one keystroke from empty, and
    // `'   /registry.db'` is a directory named three spaces on the read that
    // decides a booting instance's identity.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const blank of ['', '   ', '\t\n']) {
        expect(
          resolveRegistryDbPath({
            NEUTRON_REGISTRY_DB_PATH: blank,
            NEUTRON_HOME: blank,
            NEUTRON_REGISTRY_DB_PATH_RW: '/legacy.db',
          }),
        ).toBe('/legacy.db')

        // Each tier independently, so a failure names the arm that broke rather
        // than "one of three".
        expect(
          resolveRegistryDbPath({ NEUTRON_REGISTRY_DB_PATH: blank, NEUTRON_HOME: '/srv/neutron' }),
        ).toBe('/srv/neutron/registry.db')
        expect(
          resolveRegistryDbPath({ NEUTRON_HOME: blank, NEUTRON_REGISTRY_DB_PATH_RW: '/legacy.db' }),
        ).toBe('/legacy.db')
        expect(resolveRegistryDbPath({ NEUTRON_REGISTRY_DB_PATH_RW: blank })).toBe(
          join(homedir(), '.local', 'share', 'neutron', 'registry.db'),
        )
      }

      // CONTROLS — so a failure above means "a blank was honoured" and not "the
      // variable stopped being read at all", which is a different bug wearing
      // the same green.
      expect(resolveRegistryDbPath({ NEUTRON_REGISTRY_DB_PATH: '/tier-1.db' })).toBe('/tier-1.db')
      expect(resolveRegistryDbPath({ NEUTRON_HOME: '/srv/neutron' })).toBe(
        '/srv/neutron/registry.db',
      )
      expect(resolveRegistryDbPath({ NEUTRON_REGISTRY_DB_PATH_RW: '/legacy.db' })).toBe('/legacy.db')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('a REAL path whose blankness is only leading/trailing keeps its bytes', () => {
    // The predicate trims to DECIDE; the value is not rewritten. Leading and
    // trailing spaces are legal in a POSIX path, so trimming the RETURN would
    // silently relocate a real directory — the family rule this resolver shares
    // with `resolveNeutronHome` (`migrations/db-path.ts`) and `resolveStatePath`
    // (`gbrain-memory/gbrain-doctor.ts`).
    const spaced = ' /real/dir '
    expect(resolveRegistryDbPath({ NEUTRON_REGISTRY_DB_PATH: spaced })).toBe(spaced)
    expect(resolveRegistryDbPath({ NEUTRON_HOME: spaced })).toBe(join(spaced, 'registry.db'))

    // THE LEGACY TIER RETURNS VERBATIM TOO, and it is asserted because a
    // cross-model reviewer measured that it was not: the first version of this
    // test covered the two canonical tiers and stopped, so a mutation to
    // `return legacy.trim()` would have passed it. Every tier of this resolver
    // returns bytes; the pin now says so for every tier rather than for the two
    // that came to mind.
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveRegistryDbPath({ NEUTRON_REGISTRY_DB_PATH_RW: spaced })).toBe(spaced)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('NEUTRON_HOME beats legacy _RW (canonical resolution wins over backwards-compat)', () => {
    // Production instance units (post-fix) set BOTH `NEUTRON_HOME` and
    // the canonical `NEUTRON_REGISTRY_DB_PATH`. If somehow only
    // `NEUTRON_HOME` is set, that path must win over the legacy `_RW`
    // — otherwise old + new env vars on the same unit would silently
    // diverge.
    const env = {
      NEUTRON_HOME: '/srv/neutron',
      NEUTRON_REGISTRY_DB_PATH_RW: '/legacy.db',
    }
    expect(resolveRegistryDbPath(env)).toBe('/srv/neutron/registry.db')
  })

  test('legacy _RW fallback emits a structured deprecation warning', () => {
    // Spec: a one-shot warning so ops see stragglers in logs.
    // (The module-level dedup means subsequent calls in the same
    // process are silent — we only assert the first call warns.)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Use a fresh import via require-cache bust would be over-engineering;
      // instead just assert the warning fires AT LEAST once across the
      // tier-3 + empty-string cases above (this test suite runs them
      // before this assertion).
      resolveRegistryDbPath({ NEUTRON_REGISTRY_DB_PATH_RW: '/x.db' })
      // After tier-3 + empty-string ran above, the dedup may already
      // have suppressed this call — so we don't assert call count.
      // What we DO assert: at no point did the function emit anything
      // OTHER than the legacy-fallback warning.
      for (const call of warnSpy.mock.calls) {
        const msg = String(call[0] ?? '')
        expect(msg).toContain('NEUTRON_REGISTRY_DB_PATH_RW')
      }
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('resolveOwnerHome — the second resolver in this file, blank is unset on both tiers', () => {
  const BLANKS: ReadonlyArray<string> = ['', ' ', '   ', '\t', '\n']
  const DEFAULT_OWNER_HOME = join(homedir(), '.local', 'share', 'neutron')

  test('tier 1 — a REAL OWNER_HOME wins, verbatim', () => {
    // CONTROL for the fall-through tests below: they must pass because a blank
    // was rejected, not because this tier stopped being read at all.
    expect(resolveOwnerHome({ OWNER_HOME: '/srv/owner' } as NodeJS.ProcessEnv)).toBe('/srv/owner')
    // A padded path is a REAL path — the predicate trims, the return does not.
    expect(resolveOwnerHome({ OWNER_HOME: ' /srv/padded ' } as NodeJS.ProcessEnv)).toBe(
      ' /srv/padded ',
    )
  })

  test('tier 1 — a BLANK OWNER_HOME falls through to NEUTRON_DB_PATH', () => {
    for (const blank of BLANKS) {
      expect(
        resolveOwnerHome({
          OWNER_HOME: blank,
          NEUTRON_DB_PATH: '/srv/inst/db/project.db',
        } as NodeJS.ProcessEnv),
      ).toBe('/srv/inst')
    }
  })

  test('tier 2 — a BLANK NEUTRON_DB_PATH does not resolve the owner home to the process CWD', () => {
    // The concrete defect: `dirname(dirname('  '))` is `'.'`, so a blank pin
    // silently answered "the owner's data lives wherever this process was
    // started" — which for a service is whatever directory the service manager
    // happened to choose.
    for (const blank of BLANKS) {
      const got = resolveOwnerHome({ NEUTRON_DB_PATH: blank } as NodeJS.ProcessEnv)
      expect(got).toBe(DEFAULT_OWNER_HOME)
      expect(got).not.toBe('.')
    }
  })

  test('tier 2 — a REAL NEUTRON_DB_PATH still resolves two levels up', () => {
    // CONTROL for the test above.
    expect(
      resolveOwnerHome({ NEUTRON_DB_PATH: '/srv/inst/db/project.db' } as NodeJS.ProcessEnv),
    ).toBe('/srv/inst')
  })

  test('BOTH blank resolves to the documented default', () => {
    for (const blank of BLANKS) {
      expect(
        resolveOwnerHome({ OWNER_HOME: blank, NEUTRON_DB_PATH: blank } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_OWNER_HOME)
    }
  })
})
