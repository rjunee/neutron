/**
 * scripts/__tests__/install-uninstall.test.ts — the guard `install.sh` has been
 * CITING BY THIS EXACT PATH while it did not exist.
 *
 * `install.sh`'s shared-resolver header says, verbatim: "A parity test in
 * scripts/__tests__/install-uninstall.test.ts asserts the two copies match, so
 * install and uninstall always resolve the SAME data dir + DB file." No such
 * file was ever written. That is the aspirational-docblock failure mode rather
 * than a stale one — it does not describe a rule that later decayed, it
 * describes a check that never ran, and it is dangerous precisely because it is
 * specific enough to be trusted: the next person to edit one copy reads that
 * line and believes CI will catch it if the twin drifts. Nothing would have.
 *
 * The two copies happened to be byte-identical when this test was written, so
 * this is not a bug report — it is the missing enforcement, plus behaviour
 * coverage for the property the block exists to hold.
 *
 * THE PROPERTY: the installer must migrate, and the uninstaller must remove,
 * the SAME database file the server opens. That is a cross-language invariant —
 * `install.sh` / `uninstall.sh` in POSIX sh, `resolveOpenDbPath` /
 * `resolveNeutronHome` in TypeScript (`migrations/db-path.ts`) — so asserting
 * the shell resolvers in isolation would pin only half of it. The agreement
 * arms below run BOTH sides on the same inputs and compare the answers, which
 * is the only shape that can fail when one language is changed alone. That is
 * exactly how the split this test now pins got in: the TypeScript predicate was
 * trimmed while the shell predicate was not, and every existing test still
 * passed because no test read both.
 *
 * The shell functions are exercised by slicing the marked block out of the real
 * script and sourcing it, rather than by running the installer, so the arms
 * cover the resolvers without the side effects of an actual install.
 */

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNeutronHome, resolveOpenDbPath } from '@neutronai/migrations/db-path.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const INSTALL = join(ROOT, 'install.sh')
const UNINSTALL = join(ROOT, 'uninstall.sh')

const OPEN_MARKER = '# >>> NEUTRON-SHARED-RESOLVERS v1'
const CLOSE_MARKER = '# <<< NEUTRON-SHARED-RESOLVERS v1'

/** Slice the marked shared-resolver block out of a script. */
function sharedBlock(file: string): string {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(OPEN_MARKER))
  const end = lines.findIndex((l) => l.startsWith(CLOSE_MARKER))
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`shared-resolver markers not found in ${file} (start=${start} end=${end})`)
  }
  return lines.slice(start, end + 1).join('\n')
}

/**
 * Source the shared block in a real `sh` and call one of its functions.
 * `env` fully replaces the environment, so an unset variable is genuinely unset
 * rather than inherited from the test runner.
 */
function shResolve(call: string, env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-shared-resolvers-'))
  try {
    const lib = join(dir, 'lib.sh')
    writeFileSync(lib, `${sharedBlock(INSTALL)}\n`)
    const out = execFileSync('sh', ['-eu', '-c', `. "${lib}"\n${call}`], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
      encoding: 'utf8',
    })
    // The resolvers `printf '%s\n'`, so exactly one trailing newline is theirs.
    return out.replace(/\n$/, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('shared resolver block: install.sh ⇄ uninstall.sh', () => {
  test('the two copies are byte-identical (the claim install.sh makes about this file)', () => {
    expect(sharedBlock(UNINSTALL)).toBe(sharedBlock(INSTALL))
  })

  test('the marker pair exists in both scripts', () => {
    for (const f of [INSTALL, UNINSTALL]) {
      const text = readFileSync(f, 'utf8')
      expect(text).toContain(OPEN_MARKER)
      expect(text).toContain(CLOSE_MARKER)
    }
  })
})

describe('blank is unset — shell side', () => {
  test('a whitespace-only NEUTRON_DB_PATH falls through to <home>/project.db', () => {
    expect(
      shResolve('resolve_db_target /data/neutron ""', { HOME: '/root', NEUTRON_DB_PATH: '   ' }),
    ).toBe('/data/neutron/project.db')
  })

  test('a whitespace-only NEUTRON_HOME falls through to $HOME/neutron', () => {
    expect(shResolve('resolve_neutron_home ""', { HOME: '/root', NEUTRON_HOME: '   ' })).toBe(
      '/root/neutron',
    )
  })

  test('a whitespace-only OWNER_HOME falls through too', () => {
    expect(shResolve('resolve_neutron_home ""', { HOME: '/root', OWNER_HOME: '\t\t' })).toBe(
      '/root/neutron',
    )
  })

  test('a tab/newline-only value is blank as well, not just spaces', () => {
    expect(
      shResolve('resolve_db_target /data/neutron ""', { HOME: '/root', NEUTRON_DB_PATH: '\t\n ' }),
    ).toBe('/data/neutron/project.db')
  })

  test('a REAL value still wins, and is passed through verbatim', () => {
    expect(
      shResolve('resolve_db_target /data/neutron ""', { HOME: '/root', NEUTRON_DB_PATH: '/x/y.db' }),
    ).toBe('/x/y.db')
    expect(shResolve('resolve_neutron_home ""', { HOME: '/root', NEUTRON_HOME: '/srv/n' })).toBe(
      '/srv/n',
    )
  })

  test('a value with INTERIOR spaces is a real path and survives untrimmed', () => {
    // The rule is "blank is unset", not "strip whitespace". Only the emptiness
    // TEST trims; the value itself must reach SQLite byte-for-byte or a legal
    // path like `/Volumes/My Disk/n.db` would silently open a different file.
    expect(
      shResolve('resolve_db_target /data/neutron ""', {
        HOME: '/root',
        NEUTRON_DB_PATH: '/vol/my disk/n.db',
      }),
    ).toBe('/vol/my disk/n.db')
  })

  test('surrounding whitespace on a real value is NOT stripped from the result', () => {
    expect(
      shResolve('resolve_db_target /data/neutron ""', { HOME: '/root', NEUTRON_DB_PATH: ' /x.db' }),
    ).toBe(' /x.db')
  })
})

describe('installer ⇄ server agreement (the invariant the block exists for)', () => {
  // Each case is run through BOTH languages and the answers compared. A change
  // to one side alone fails here; that is the whole point of the arm.
  //
  // HOME is pinned to `homedir()` in every case because the two sides reach the
  // fallback by different routes: the shell block ends at `$HOME/neutron`, while
  // `resolveNeutronHome` ends at `join(homedir(), 'neutron')` — and `homedir()`
  // reads the passwd entry, so it does NOT follow an overridden `HOME`. Pinning
  // them to the same base is what makes the comparison a test of the PREDICATES
  // rather than an accident of how each language finds the user's home.
  const HOME = homedir()
  const cases: Array<{ name: string; env: Record<string, string> }> = [
    { name: 'nothing pinned', env: { HOME } },
    { name: 'whitespace-only NEUTRON_DB_PATH', env: { HOME, NEUTRON_DB_PATH: '   ' } },
    { name: 'real NEUTRON_DB_PATH', env: { HOME, NEUTRON_DB_PATH: '/x/y.db' } },
    { name: 'whitespace-only NEUTRON_HOME', env: { HOME, NEUTRON_HOME: '  ' } },
    { name: 'real NEUTRON_HOME', env: { HOME, NEUTRON_HOME: '/srv/n' } },
    { name: 'whitespace-only OWNER_HOME', env: { HOME, OWNER_HOME: '  ' } },
    { name: 'real OWNER_HOME', env: { HOME, OWNER_HOME: '/srv/owner' } },
  ]

  for (const c of cases) {
    test(`db path agrees: ${c.name}`, () => {
      const home = shResolve('resolve_neutron_home ""', c.env)
      const shellDb = shResolve(`resolve_db_target "${home}" ""`, c.env)
      expect(shellDb).toBe(resolveOpenDbPath(c.env as NodeJS.ProcessEnv))
    })

    test(`home agrees: ${c.name}`, () => {
      expect(shResolve('resolve_neutron_home ""', c.env)).toBe(
        resolveNeutronHome(c.env as NodeJS.ProcessEnv),
      )
    })
  }
})
