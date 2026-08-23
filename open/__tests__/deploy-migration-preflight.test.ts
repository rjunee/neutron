/**
 * The per-sha safety check a standing deploy window may never skip.
 *
 * A guard that only ever says yes is decoration, so every refusal case here is
 * paired with a POSITIVE CONTROL on an unmodified tree: if the control ever
 * stops passing, the refusals below stop meaning anything and this file says so
 * loudly rather than staying green.
 *
 * The fixture is a real git repository with a real (tiny) migration tree, built
 * once and mutated per case, because both failure modes are properties of the
 * runner meeting a tree on disk — a mock of either would test the mock. The
 * expected-schema snapshot is GENERATED from the clean tree rather than
 * hand-written, so it cannot drift into agreeing with a bug.
 *
 * The source-scoped wiring assertion at the bottom follows the honest-coverage
 * precedent of `codegen-cancel-composition.test.ts`: this module landing
 * without the composer passing it would leave the window exactly as inert as it
 * was with no module at all.
 */

import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { serializeSchema } from '@neutronai/migrations/schema-serialize.ts'
import {
  createDeployMigrationPreflight,
  missingSchemaLines,
} from '../deploy-migration-preflight.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSER_SRC = readFileSync(join(HERE, '..', 'composer.ts'), 'utf8')

const MIGRATION_ONE = `CREATE TABLE t_one (
  id TEXT PRIMARY KEY,
  created_at REAL NOT NULL
) STRICT;
`

let repo: string
let liveDb: string
let shaClean = ''
let shaCollision = ''
let shaMissingObject = ''

function git(args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function commit(message: string): string {
  git(['add', '-A'])
  git(['commit', '-q', '-m', message])
  return git(['rev-parse', 'HEAD'])
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'preflight-fixture-repo-'))
  const tree = join(repo, 'migrations')
  execFileSync('mkdir', ['-p', tree])
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'preflight@test.invalid'])
  git(['config', 'user.name', 'preflight'])
  writeFileSync(join(tree, '0001_t_one.sql'), MIGRATION_ONE)

  // Generate the snapshot from the tree itself. A hand-written expectation can
  // agree with a bug; a generated one can only disagree with a change.
  const probeDir = mkdtempSync(join(tmpdir(), 'preflight-fixture-probe-'))
  const probe = new Database(join(probeDir, 'probe.db'))
  applyMigrations(probe, tree)
  writeFileSync(join(tree, 'expected-schema.txt'), serializeSchema(probe))
  probe.close()
  rmSync(probeDir, { recursive: true, force: true })

  shaClean = commit('clean tree')

  // A SECOND file at an ordinal the ledger already recorded under another name.
  // This is the 2026-08-17 outage in miniature: the runner refuses rather than
  // silently skipping, and that refusal is what a deploy must never discover at
  // boot with the gateway already down.
  writeFileSync(join(tree, '0001_a_different_name.sql'), MIGRATION_ONE)
  shaCollision = commit('ordinal collision')

  git(['rm', '-q', join('migrations', '0001_a_different_name.sql')])
  // A schema object the target claims but no migration creates. Stands in for
  // the silent case: a table rebuild copies only the columns it NAMES, so the
  // rest are deleted and NOTHING THROWS.
  writeFileSync(
    join(tree, 'expected-schema.txt'),
    `${readFileSync(join(tree, 'expected-schema.txt'), 'utf8')}\n[index] idx_never_created (tbl=t_one)\n`,
  )
  shaMissingObject = commit('claims an object no migration creates')

  // The "live" database this instance would boot against: already carrying the
  // clean tree, exactly like a real box between deploys.
  const liveDir = mkdtempSync(join(tmpdir(), 'preflight-fixture-live-'))
  liveDb = join(liveDir, 'live.db')
  const live = new Database(liveDb)
  applyMigrations(live, join(repo, 'migrations'))
  live.close()
})

function preflight(): (input: { ref: string; sha: string }) => Promise<{
  ok: boolean
  reason: string
}> {
  return createDeployMigrationPreflight({ db_path: liveDb, repo_path: repo })
}

describe('deploy migration preflight', () => {
  test('POSITIVE CONTROL — an unmodified tree passes, so a refusal below means something', async () => {
    const verdict = await preflight()({ ref: 'origin/main', sha: shaClean })
    expect(verdict).toMatchObject({ ok: true })
  })

  test('refuses a tree whose migration replay would fail to boot this instance', async () => {
    const verdict = await preflight()({ ref: 'origin/main', sha: shaCollision })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('would not boot')
    // The CAUSE has to survive into the sentence the owner reads, or the
    // refusal is untriageable and gets overridden.
    expect(verdict.reason).toContain('collision')
  })

  test('refuses a tree that migrates cleanly but leaves an expected object MISSING', async () => {
    const verdict = await preflight()({ ref: 'origin/main', sha: shaMissingObject })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('MISSING')
    expect(verdict.reason).toContain('idx_never_created')
  })

  test('a sha the checkout does not have is a REFUSAL, never a pass', async () => {
    const verdict = await preflight()({ ref: 'origin/main', sha: 'dead1234beef' })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('could not read the migration tree')
  })

  test('a malformed sha never reaches a command line', async () => {
    const verdict = await preflight()({ ref: 'origin/main', sha: 'not a sha; rm -rf /' })
    expect(verdict).toMatchObject({ ok: false })
    expect(verdict.reason).toContain('malformed')
  })

  test('a crash inside the check is a refusal, not a pass', async () => {
    const broken = createDeployMigrationPreflight({
      db_path: '/nonexistent/definitely/not/a.db',
      repo_path: repo,
    })
    const verdict = await broken({ ref: 'origin/main', sha: shaClean })
    expect(verdict.ok).toBe(false)
  })

  test('the live database is never written to', async () => {
    const before = readFileSync(liveDb)
    await preflight()({ ref: 'origin/main', sha: shaClean })
    expect(readFileSync(liveDb).equals(before)).toBe(true)
  })
})

describe('missingSchemaLines is one-directional', () => {
  // Measured on a real instance: the live schema is a strict SUPERSET of the
  // fresh snapshot (`_migration_repairs`, plus an orphan table left behind by a
  // reverted branch deploy). Byte equality would refuse every deploy there, and
  // a guard that always cries wolf gets switched off — which fails exactly as
  // open as no guard at all.
  test('tolerates objects the live database has and the snapshot does not', () => {
    expect(missingSchemaLines('[table] a\n[table] extra\n[table] b', '[table] a\n[table] b')).toEqual([])
  })

  test('catches an object the snapshot expects and the database lacks', () => {
    expect(missingSchemaLines('[table] a', '[table] a\n[table] b')).toEqual(['[table] b'])
  })

  test('ignores blank lines rather than reporting them as missing objects', () => {
    expect(missingSchemaLines('[table] a', '[table] a\n\n  \n')).toEqual([])
  })
})

describe('composer wiring', () => {
  // Without this, the module lands green and the window stays exactly as inert
  // as it was with no module at all — the failure that shipped five times.
  //
  // Asserted as a BOOLEAN, never `expect(SRC).toContain(...)`: composer.ts is
  // ~6000 lines, and a `toContain` failure prints the whole file. Measured at
  // 160KB of noise for a one-line regression, which buries the sentence that
  // says what to do about it.
  const wires = (needle: string): boolean => COMPOSER_SRC.includes(needle)

  test('the composer passes check_preconditions to createHostDeployService', () => {
    expect({
      wired: wires('check_preconditions: createDeployMigrationPreflight('),
      how_to_fix: 'open/composer.ts must pass check_preconditions or the deploy window is inert',
    }).toEqual({
      wired: true,
      how_to_fix: 'open/composer.ts must pass check_preconditions or the deploy window is inert',
    })
  })

  test('the composer imports the preflight', () => {
    expect(wires("from './deploy-migration-preflight.ts'")).toBe(true)
  })

  test('it reads the database this process is open on, not a re-derived path', () => {
    expect(wires('db_path: db.raw().filename')).toBe(true)
  })
})
