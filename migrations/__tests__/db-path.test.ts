/**
 * `migrations/db-path.ts` — blank is unset, and the return keeps its bytes.
 *
 * WHY THIS FILE EXISTS AT ALL. Both predicates here were brought onto the
 * "blank is unset" rule and the change was reported as mutation-proved. It was
 * — but only by `open/__tests__/owner-slug-agreement.test.ts`, a suite in
 * another package that pins these two functions as part of a cross-reader
 * AGREEMENT argument. `migrations/` had no test for its own resolver at all.
 *
 * Measured, before this file existed: dropping `.trim()` from
 * {@link resolveNeutronHome} left `bun test migrations/` at **73 pass / 0 fail**.
 * The whole directory that owns the code stayed green while the predicate was
 * broken; only a distant suite went red, and only if you thought to run it.
 *
 * A pin that lives exclusively in a distant file is indistinguishable from no
 * pin at the moment it matters, which is when someone edits THIS file and runs
 * the tests next to it. The agreement suite is still the right home for "these
 * readers agree with each other"; this one is the home for "this reader is
 * correct on its own", and the two are different claims.
 */

import { expect, test, describe } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveNeutronHome, resolveOpenDbPath } from '../db-path.ts'

/** The blank forms. `''` was always handled; the whitespace ones were not. */
const BLANKS: ReadonlyArray<string> = ['', ' ', '   ', '\t', '\n', ' \t\n ']

const DEFAULT_HOME = join(homedir(), 'neutron')

describe('resolveNeutronHome', () => {
  test('a blank NEUTRON_HOME falls through to OWNER_HOME', () => {
    for (const blank of BLANKS) {
      expect(
        resolveNeutronHome({ NEUTRON_HOME: blank, OWNER_HOME: '/srv/owner' } as NodeJS.ProcessEnv),
      ).toBe('/srv/owner')
    }
  })

  test('a blank OWNER_HOME falls through to the ~/neutron default', () => {
    for (const blank of BLANKS) {
      expect(resolveNeutronHome({ OWNER_HOME: blank } as NodeJS.ProcessEnv)).toBe(DEFAULT_HOME)
    }
  })

  test('BOTH blank resolves to the default, not to a whitespace directory', () => {
    for (const blank of BLANKS) {
      // The defect in full: a `length > 0` predicate answers `'   '` as a home,
      // the caller then opens `'   /project.db'` and looks for `'   /.url_slug'`,
      // and a box with a blank-but-present variable silently gets a different
      // database and an anonymous identity.
      expect(
        resolveNeutronHome({ NEUTRON_HOME: blank, OWNER_HOME: blank } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_HOME)
    }
  })

  test('a REAL path wins VERBATIM — padding is data, not blankness', () => {
    // The predicate trims; the RETURN does not. A leading/trailing space is
    // legal in a POSIX path, so trimming the return would silently relocate a
    // real directory. This is the half that a naive "just trim it" fix breaks.
    expect(resolveNeutronHome({ NEUTRON_HOME: ' /srv/padded ' } as NodeJS.ProcessEnv)).toBe(
      ' /srv/padded ',
    )
    expect(resolveNeutronHome({ OWNER_HOME: ' /srv/padded ' } as NodeJS.ProcessEnv)).toBe(
      ' /srv/padded ',
    )
  })

  test('NEUTRON_HOME still outranks OWNER_HOME when both are real', () => {
    // CONTROL for the two fall-through tests above: they must pass because the
    // blank was rejected, not because precedence collapsed.
    expect(
      resolveNeutronHome({ NEUTRON_HOME: '/srv/a', OWNER_HOME: '/srv/b' } as NodeJS.ProcessEnv),
    ).toBe('/srv/a')
  })
})

describe('resolveOpenDbPath', () => {
  test('a blank NEUTRON_DB_PATH falls through to <NEUTRON_HOME>/project.db', () => {
    for (const blank of BLANKS) {
      expect(
        resolveOpenDbPath({
          NEUTRON_DB_PATH: blank,
          NEUTRON_HOME: '/srv/home',
        } as NodeJS.ProcessEnv),
      ).toBe(join('/srv/home', 'project.db'))
    }
  })

  test('a blank pin does not open a file named three spaces', () => {
    // Measured before the fix: `resolveOpenDbPath({NEUTRON_DB_PATH:'   '})` was
    // `'   '`, so SQLite opened a file named three spaces RELATIVE TO THE
    // PROCESS CWD — wherever the service manager happened to start it — while
    // the readers of the same variable in `gateway/boot-listener-registry.ts`
    // and `onboarding/overnight/register.ts` both trimmed and both fell back.
    // One variable, three readers, two answers, and the migration runner
    // writing a different database than the one that boots.
    for (const blank of BLANKS) {
      const got = resolveOpenDbPath({ NEUTRON_DB_PATH: blank } as NodeJS.ProcessEnv)
      expect(got).toBe(join(DEFAULT_HOME, 'project.db'))
      expect(got.trim()).toBe(got)
    }
  })

  test('a REAL pin wins VERBATIM, padding included', () => {
    expect(resolveOpenDbPath({ NEUTRON_DB_PATH: ' /srv/x.db ' } as NodeJS.ProcessEnv)).toBe(
      ' /srv/x.db ',
    )
  })

  test('a real pin outranks NEUTRON_HOME', () => {
    // CONTROL: the fall-through tests above pass because the blank was
    // rejected, not because the pin stopped being read at all.
    expect(
      resolveOpenDbPath({
        NEUTRON_DB_PATH: '/srv/pin.db',
        NEUTRON_HOME: '/srv/home',
      } as NodeJS.ProcessEnv),
    ).toBe('/srv/pin.db')
  })

  test('a blank NEUTRON_DB_PATH AND a blank NEUTRON_HOME compose to the default', () => {
    // The two predicates are separate and each was fixed in a different change;
    // this pins that they still agree when both variables are blank at once.
    expect(
      resolveOpenDbPath({ NEUTRON_DB_PATH: '  ', NEUTRON_HOME: '  ' } as NodeJS.ProcessEnv),
    ).toBe(join(DEFAULT_HOME, 'project.db'))
  })
})
