/**
 * An untracked `.sql` in the migrations directory is not a migration.
 *
 * THE INCIDENT, FOUR TIMES OVER. `loadMigrations` applies every file matching
 * `NNNN_*.sql` that is PRESENT IN THE DIRECTORY — tracked or not. So a stray
 * file that appears there for a moment is applied at boot, recorded in
 * `_migrations` permanently, and then vanishes with the next checkout. What is
 * left is a ledger row naming a migration no commit ever contained, and every
 * later boot refuses on a mismatch that cannot be explained from anything on
 * disk. That took a live instance down twice, most recently for three hours.
 *
 * The check was considered once and declined (PR #352 § 3) on a sound objection:
 * it needs ground truth about "the deployed tree", a tarball install has no git
 * metadata, and a check that is silently inert on much of the fleet is worse
 * than none. The distinction that objection misses is the whole fix — ABSENCE OF
 * GIT METADATA MEANS "CANNOT VERIFY", NOT "NOTHING TO VERIFY". So there are two
 * behaviours here, and the tests below are organised around proving each:
 *
 *   verifiable + untracked → REFUSE, fail-closed, naming the file.
 *   unverifiable           → apply, and RECORD in the row that the file's
 *                            membership of the tree was never established.
 *
 * Each property carries a control that proves the assertion is not vacuous. The
 * refusal's control is the same tree with the same file TRACKED (a check that
 * refuses everything would fail it), and the parser's control is `git ls-files`
 * on this very repository — a hand-built fixture cannot prove that real git
 * output is read correctly, and a parser that misread it would report tracked
 * files as absent and refuse a legitimate boot.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, loadMigrations } from '../runner.ts'
import { migrationContentHash, resolveDeployedTree } from '../provenance.ts'
import { parseGitIndex } from '../git-index.ts'
import { encodeIndex } from './git-index-fixture.ts'

const ALPHA = 'CREATE TABLE alpha (id INTEGER);'
const BETA = 'CREATE TABLE beta (id INTEGER);'
const STRAY = 'CREATE TABLE stray (id INTEGER);'
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

const REPO_ROOT = join(import.meta.dir, '..', '..')

let tmp: string
let savedCommitEnv: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mig-untracked-'))
  // A stray NEUTRON_COMMIT_SHA in the shell running the suite would quietly
  // satisfy the "no build identity" assertions below.
  savedCommitEnv = process.env['NEUTRON_COMMIT_SHA']
  delete process.env['NEUTRON_COMMIT_SHA']
})

afterEach(() => {
  if (savedCommitEnv === undefined) delete process.env['NEUTRON_COMMIT_SHA']
  else process.env['NEUTRON_COMMIT_SHA'] = savedCommitEnv
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * A migration tree inside a checkout whose `.git` is laid out by hand.
 *
 * The root `package.json` is not decoration — it is the ownership test the
 * resolver applies before reading anything, so a checkout without it is a
 * checkout this tree does not own (see `provenance.ts`).
 */
function checkout(
  name: string,
  options: {
    files: Record<string, string>
    tracked?: readonly string[]
    index?: Uint8Array | null
  },
): string {
  const root = join(tmp, name)
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), `${HEAD_SHA}\n`)
  for (const [file, contents] of Object.entries(options.files)) {
    writeFileSync(join(dir, file), contents)
  }
  const index =
    options.index === undefined
      ? encodeIndex([
          { path: 'package.json' },
          ...(options.tracked ?? []).map((f) => ({ path: `migrations/${f}` })),
        ])
      : options.index
  if (index !== null) writeFileSync(join(root, '.git', 'index'), index)
  return dir
}

/** A migration tree with no git metadata anywhere above it. */
function bareTree(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name, 'migrations')
  mkdirSync(dir, { recursive: true })
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(dir, file), contents)
  return dir
}

function rows(db: Database): Array<Record<string, unknown>> {
  return db
    .query(
      'SELECT version, name, content_sha256, applied_by_commit, tree_provenance FROM _migrations ORDER BY version',
    )
    .all() as Array<Record<string, unknown>>
}

function ledgerColumns(db: Database): string[] {
  return (
    db.query("SELECT name FROM pragma_table_info('_migrations')").all() as Array<{ name: string }>
  ).map((c) => c.name)
}

function tableExists(db: Database, name: string): boolean {
  return db.query('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== null
}

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected a throw, got none')
}

/** Where `needle`'s utf8 bytes start in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: string): number {
  const bytes = new TextEncoder().encode(needle)
  outer: for (let i = 0; i + bytes.length <= haystack.length; i++) {
    for (let j = 0; j < bytes.length; j++) {
      if (haystack[i + j] !== bytes[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * The same bytes with a trailing checksum that MATCHES them — i.e. corruption made
 * undetectable. Used to show what the boot would have done with the corrupt path
 * list had the checksum not been verified.
 */
function resealChecksum(bytes: Uint8Array): Uint8Array {
  const split = bytes.length - 20
  const out = Uint8Array.from(bytes)
  out.set(createHash('sha1').update(bytes.subarray(0, split)).digest(), split)
  return out
}

/** The message's labelled blocks, as `{ section: { field: value } }`. */
function sections(message: string): Record<string, Record<string, string>> {
  const parsed: Record<string, Record<string, string>> = {}
  let current: Record<string, string> | null = null
  for (const line of message.split('\n')) {
    const header = line.match(/^ {2}(\S.*)$/)
    if (header !== null) {
      current = {}
      parsed[String(header[1])] = current
      continue
    }
    const field = line.match(/^ {4}(\S+) +(.*)$/)
    if (field !== null && current !== null) current[String(field[1])] = String(field[2])
  }
  return parsed
}

// ------------------------------------------- 1. verifiable + untracked refuses

test('an untracked migration file is REFUSED, and the message names it', () => {
  const db = new Database(':memory:')
  const dir = checkout('stray', {
    files: { '0001_alpha.sql': ALPHA, '0002_stray.sql': STRAY },
    tracked: ['0001_alpha.sql'],
  })

  const message = messageOf(() => applyMigrations(db, dir))
  expect(message).toContain('0002_stray.sql')
  expect(message).toContain('NOT part of the deployed tree')
  const parsed = sections(message)
  expect(parsed['on disk']).toEqual({
    file: 'migrations/0002_stray.sql',
    sha256: migrationContentHash(STRAY),
  })
  // The tracked count is the check's own positive control, printed for the
  // operator: a guard that had broken and was refusing everything would say 0.
  expect(parsed['deployed tree']?.['build']).toBe(HEAD_SHA)
  expect(parsed['deployed tree']?.['tracked']).toContain('1 file(s)')
  // The remedy is deleting or committing the file. `repairs.json` would record a
  // row for a migration that does not exist, which is the disease.
  expect(message).toContain('DELETE the file')
  // ADD *and* COMMIT, and the message says why both halves matter. "COMMIT it"
  // alone described a stricter check than the one that fired: what is read is
  // git's index, so `git add` is what satisfies it.
  expect(message).toContain('ADD AND COMMIT it')
  expect(message).toContain("check reads git's index")
  expect(message).toContain('Do NOT reach for migrations/repairs.json')
  // No row is recorded at this ordinal, so the message carries no `recorded` block
  // and none of the already-recorded prose.
  expect(parsed['recorded']).toBeUndefined()
  expect(message).not.toContain('is ALREADY recorded')
})

test('the refusal writes NOTHING — the message says so, and the database agrees', () => {
  // The check runs before the apply loop for exactly this reason. Refusing
  // part-way would leave `0001` applied and recorded while the boot still fails,
  // so a retry would face a half-migrated database.
  const db = new Database(':memory:')
  const dir = checkout('partial', {
    files: { '0001_alpha.sql': ALPHA, '0002_stray.sql': STRAY },
    tracked: ['0001_alpha.sql'],
  })

  expect(() => applyMigrations(db, dir)).toThrow(/0002_stray\.sql/)
  expect(tableExists(db, 'alpha')).toBe(false)
  expect(tableExists(db, 'stray')).toBe(false)
  // NOTHING, as the message claims — not even the ledger. `_migrations` is created
  // on the path that writes a row and on no other, so a refused boot leaves a
  // database that is byte-for-byte what it was. Asserting the whole `sqlite_master`
  // is deliberate: it is the only form of this assertion that cannot be satisfied
  // by a table nobody thought to name.
  expect(db.query('SELECT name FROM sqlite_master').all()).toEqual([])
  expect(messageOf(() => applyMigrations(db, dir))).toContain('nothing has been written')
})

test('a refusal writes nothing EVEN WHEN a repair would be acknowledged first', () => {
  // The ordering bug this pins. `_migration_repairs` DDL and its INSERT used to run
  // BEFORE the tree was resolved, so on any instance carrying acknowledged repairs
  // — this repository ships two — the refusal's "nothing has been written" was
  // false, in exactly the incident-recovery state where an operator reads it.
  const db = new Database(':memory:')
  const applied = checkout('ack-was', {
    files: { '0001_alpha.sql': ALPHA },
    tracked: ['0001_alpha.sql'],
  })
  expect(applyMigrations(db, applied)).toEqual({ applied: [1], skipped: [] })

  // Ordinal 1 now reads as a mismatch (recorded `alpha`, on disk `beta`) with a
  // repairs entry that acknowledges it, AND ordinal 2 is an untracked stray.
  const dir = checkout('ack-now', {
    files: { '0001_beta.sql': BETA, '0002_stray.sql': STRAY },
    tracked: ['0001_beta.sql'],
  })
  writeFileSync(
    join(dir, 'repairs.json'),
    JSON.stringify([
      { version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'test', date: '2026-08-17' },
    ]),
  )

  expect(() => applyMigrations(db, dir)).toThrow(/0002_stray\.sql/)
  // The acknowledgement is the write that used to land first. It has not.
  expect(tableExists(db, '_migration_repairs')).toBe(false)
  expect(tableExists(db, 'beta')).toBe(false)
  // CONTROL: with the stray deleted the acknowledgement DOES land, so the
  // assertion above is the ordering and not a repair that never matched.
  rmSync(join(dir, '0002_stray.sql'))
  expect(applyMigrations(db, dir)).toEqual({ applied: [], skipped: [1] })
  expect(tableExists(db, '_migration_repairs')).toBe(true)
})

test('the untracked check is per-file, so a stray beside many tracked migrations is still caught', () => {
  const db = new Database(':memory:')
  const dir = checkout('many', {
    files: { '0001_alpha.sql': ALPHA, '0002_beta.sql': BETA, '0003_stray.sql': STRAY },
    tracked: ['0001_alpha.sql', '0002_beta.sql'],
  })

  expect(() => applyMigrations(db, dir)).toThrow(/0003_stray\.sql/)
  expect(sections(messageOf(() => applyMigrations(db, dir)))['deployed tree']?.['tracked']).toContain(
    '2 file(s)',
  )
})

// ---------------------------------------------------- 2. the control: tracked

test('THE CONTROL — the same tree with the file TRACKED applies normally', () => {
  // Without this, every assertion above is equally explained by a check that
  // refuses every file it is shown. One byte-range differs: the index lists
  // `0002_stray.sql` too.
  const db = new Database(':memory:')
  const dir = checkout('tracked', {
    files: { '0001_alpha.sql': ALPHA, '0002_stray.sql': STRAY },
    tracked: ['0001_alpha.sql', '0002_stray.sql'],
  })

  expect(applyMigrations(db, dir)).toEqual({ applied: [1, 2], skipped: [] })
  expect(tableExists(db, 'alpha')).toBe(true)
  expect(tableExists(db, 'stray')).toBe(true)
  for (const row of rows(db)) {
    // The value names its own evidence. What was read is git's INDEX, so the row
    // claims the checkout tracks the file — not that a commit contained it.
    expect(row['tree_provenance']).toBe('tracked-in-index')
    expect(row['applied_by_commit']).toBe(HEAD_SHA)
  }
})

test('an intent-to-add entry does NOT count as tracked — `git add -N` stages no content', () => {
  // The one staging operation that provably stages nothing: git records the path
  // with no blob, so the file is in no tree under any reading. Listing it would let
  // `git add -N` alone satisfy the guard.
  const db = new Database(':memory:')
  const root = join(tmp, 'intent')
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), `${HEAD_SHA}\n`)
  writeFileSync(join(dir, '0001_alpha.sql'), ALPHA)
  const entries = [
    { path: 'package.json' },
    // A tracked sibling, so the DIRECTORY is verifiable and the emptiness rule
    // does not swallow the case.
    { path: 'migrations/README.md' },
    { path: 'migrations/0001_alpha.sql', intentToAdd: true },
  ]
  writeFileSync(join(root, '.git', 'index'), encodeIndex(entries))

  const tree = resolveDeployedTree(dir)
  expect(tree.kind).toBe('verified')
  if (tree.kind === 'verified') expect(tree.tracked.has('0001_alpha.sql')).toBe(false)
  expect(() => applyMigrations(db, dir)).toThrow(/0001_alpha\.sql/)

  // CONTROL: the identical index with the intent-to-add flag cleared applies. So
  // the refusal is the flag, not the extended-entry layout being misparsed — an
  // extended entry carries two extra bytes before its pathname, and a reader that
  // mishandled them would fail this too.
  const control = new Database(':memory:')
  writeFileSync(
    join(root, '.git', 'index'),
    encodeIndex(entries.map((e) => ({ path: e.path })), { version: 3 }),
  )
  expect(applyMigrations(control, dir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(control)[0]?.['tree_provenance']).toBe('tracked-in-index')
})

test('a migration already recorded is not re-refused when a stray copy of it lingers', () => {
  // The deliberate scope boundary. A recorded row is already permanent, so
  // refusing forever over a file that was applied long ago would be a boot
  // outage with no remedy. The guard stops the silent APPLY, which is the only
  // moment the damage is done.
  const db = new Database(':memory:')
  const applied = checkout('was-tracked', {
    files: { '0001_alpha.sql': ALPHA },
    tracked: ['0001_alpha.sql'],
  })
  expect(applyMigrations(db, applied)).toEqual({ applied: [1], skipped: [] })

  // Verifiable, and the file is NOT tracked — the exact condition that refuses
  // above. It is the recorded row, not the tree, that makes this boot.
  const now = checkout('now-untracked', {
    files: { '0001_alpha.sql': ALPHA },
    tracked: ['README.md'],
  })
  expect(applyMigrations(db, now)).toEqual({ applied: [], skipped: [1] })
})

// ------------------------------------------------ 3. unverifiable is recorded

test('a tree with NO git metadata still boots, and records that provenance was not established', () => {
  const db = new Database(':memory:')
  const dir = bareTree('bare', { '0001_alpha.sql': ALPHA })

  expect(resolveDeployedTree(dir)).toEqual({ kind: 'unverifiable', reason: 'no-git-metadata' })
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  const row = rows(db)[0]
  // Not silence, and not a claim of a clean apply: the row says the tree could
  // not be checked, and says why.
  expect(row?.['tree_provenance']).toBe('unverifiable:no-git-metadata')
  expect(row?.['applied_by_commit']).toBeNull()
  // The file is still identified exactly — a tarball install loses the tree, never the hash.
  expect(row?.['content_sha256']).toBe(migrationContentHash(ALPHA))
})

test('every index shape this parser cannot read is recorded as unverifiable, and still boots', () => {
  // Each of these is a real shape git writes (`feature.manyFiles`,
  // `core.splitIndex`, `index.sparse`) or a real accident (a truncated file).
  // None of them may refuse a boot, and none may pass as a clean apply.
  const cases: ReadonlyArray<readonly [string, Uint8Array | null, string]> = [
    ['no-index', null, 'no-index'],
    ['v4', encodeIndex([{ path: 'migrations/0001_alpha.sql' }], { version: 4 }), 'unsupported-index-version'],
    [
      'split',
      encodeIndex([{ path: 'migrations/0001_alpha.sql' }], { extensions: [['link', 4]] }),
      'split-index',
    ],
    [
      'sparse',
      encodeIndex([{ path: 'migrations/', mode: 0o040000 }]),
      'sparse-index',
    ],
    // A truncated file fails its own checksum before the walk ever starts, which is
    // a better diagnosis than the strict-landing failure it used to produce.
    [
      'truncated',
      encodeIndex([{ path: 'migrations/0001_alpha.sql' }]).slice(0, 40),
      'index-checksum-mismatch',
    ],
    ['garbage', Uint8Array.from(new Array<number>(64).fill(7)), 'unreadable-index'],
    // `index.skipHash` (which `feature.manyFiles` turns on) makes git write no
    // trailing hash at all, so nothing on disk proves the paths are intact.
    [
      'skip-hash',
      encodeIndex([{ path: 'migrations/0001_alpha.sql' }], { checksum: 'zero' }),
      'index-hash-skipped',
    ],
  ]

  for (const [name, index, reason] of cases) {
    const db = new Database(':memory:')
    const dir = checkout(name, { files: { '0001_alpha.sql': ALPHA }, index })
    expect(resolveDeployedTree(dir), name).toEqual({ kind: 'unverifiable', reason })
    expect(applyMigrations(db, dir), name).toEqual({ applied: [1], skipped: [] })
    expect(rows(db)[0]?.['tree_provenance'], name).toBe(`unverifiable:${reason}`)
  }
})

test('a same-length byte flip inside a pathname is unverifiable, NOT a false refusal', () => {
  // The failure that hides behind a valid-looking parse. Flipping one byte in a
  // pathname leaves every entry length untouched, so the walk lands exactly on the
  // trailing checksum and returns an authoritative-looking list holding a
  // corrupted name — after which the real file reads as untracked and a legitimate
  // deploy refuses to boot. Only the file's own checksum can tell.
  const good = encodeIndex([
    { path: 'package.json' },
    { path: 'migrations/0001_alpha.sql' },
  ])
  const flipped = Uint8Array.from(good)
  const target = indexOfBytes(flipped, 'migrations/0001_alpha.sql')
  expect(target).toBeGreaterThan(0)
  // Same length, so the layout is byte-identical: `0001_alpha` becomes `0001_Alpha`.
  flipped[target + 'migrations/0001_'.length] = 'A'.charCodeAt(0)
  expect(flipped.length).toBe(good.length)

  const db = new Database(':memory:')
  const dir = checkout('corrupt', { files: { '0001_alpha.sql': ALPHA }, index: flipped })
  expect(resolveDeployedTree(dir)).toEqual({
    kind: 'unverifiable',
    reason: 'index-checksum-mismatch',
  })
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['tree_provenance']).toBe('unverifiable:index-checksum-mismatch')

  // CONTROL — and it is the whole test. The unflipped fixture verifies and applies,
  // which proves the checksum check is not simply rejecting everything; and the
  // flipped one WOULD have refused this exact boot, which is what makes the
  // degrade-to-unverifiable above the fix rather than a shrug. The second half is
  // shown by parsing the flipped bytes with the trailer repaired to match them.
  const control = new Database(':memory:')
  const controlDir = checkout('corrupt-control', {
    files: { '0001_alpha.sql': ALPHA },
    index: good,
  })
  expect(applyMigrations(control, controlDir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(control)[0]?.['tree_provenance']).toBe('tracked-in-index')

  const resealed = resealChecksum(flipped)
  const wouldRefuse = checkout('corrupt-unsealed', {
    files: { '0001_alpha.sql': ALPHA },
    index: resealed,
  })
  expect(() => applyMigrations(new Database(':memory:'), wouldRefuse)).toThrow(/0001_alpha\.sql/)
})

test('a migration tree the checkout does not track AT ALL is unverifiable, not refused', () => {
  // The install shape that would otherwise be destroyed by this check: a
  // migration tree living somewhere git ignores — copied into `node_modules/` by
  // a package install, staged in a build directory, unpacked beside a checkout.
  // Every file there is "untracked", and refusing them all would take down an
  // install that is perfectly correct.
  const db = new Database(':memory:')
  const dir = checkout('ignored', { files: { '0001_alpha.sql': ALPHA }, tracked: [] })

  expect(resolveDeployedTree(dir)).toEqual({
    kind: 'unverifiable',
    reason: 'directory-not-tracked',
  })
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['tree_provenance']).toBe('unverifiable:directory-not-tracked')

  // CONTROL: the identical fixture with one sibling tracked verifies, and then
  // refuses the same file. So the pass above is the emptiness rule, not a
  // resolver that never manages to verify anything.
  const withSibling = checkout('ignored-control', {
    files: { '0001_alpha.sql': ALPHA },
    tracked: ['README.md'],
  })
  expect(resolveDeployedTree(withSibling).kind).toBe('verified')
  expect(() => applyMigrations(new Database(':memory:'), withSibling)).toThrow(/0001_alpha\.sql/)
})

test('a sidecar migration tree is resolved against its own directory, not the root', () => {
  // `applyProjectScopedMigrations` points the runner at `migrations/comments/`.
  // A check that compared basenames against the whole index, or that only
  // understood the top-level directory, would refuse every sidecar migration.
  const root = join(tmp, 'sidecar')
  const dir = join(root, 'migrations', 'comments')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), `${HEAD_SHA}\n`)
  writeFileSync(join(dir, '0001_alpha.sql'), ALPHA)
  writeFileSync(join(dir, '0002_stray.sql'), STRAY)
  writeFileSync(
    join(root, '.git', 'index'),
    encodeIndex([
      { path: 'migrations/0001_initial_schema.sql' },
      { path: 'migrations/comments/0001_alpha.sql' },
    ]),
  )

  const db = new Database(':memory:')
  expect(() => applyMigrations(db, dir)).toThrow(/0002_stray\.sql/)
  rmSync(join(dir, '0002_stray.sql'))
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['tree_provenance']).toBe('tracked-in-index')
})

// -------------------------------------- 4. the existing refusal still refuses

test('the unexplained-row refusal STILL FIRES, in a tracked tree and in an unverifiable one', () => {
  // Hardening one guard must not create a false negative in the other. Both trees
  // below leave `alpha` recorded and undescribed, and both must throw, applying
  // nothing — including where the tree cannot be verified at all, because this
  // refusal reads the ledger and not the checkout.
  for (const label of ['tracked', 'unverifiable'] as const) {
    const db = new Database(':memory:')
    const was =
      label === 'tracked'
        ? checkout(`was-${label}`, { files: { '0001_alpha.sql': ALPHA }, tracked: ['0001_alpha.sql'] })
        : bareTree(`was-${label}`, { '0001_alpha.sql': ALPHA })
    applyMigrations(db, was)

    const now =
      label === 'tracked'
        ? checkout(`now-${label}`, { files: { '0001_beta.sql': BETA }, tracked: ['0001_beta.sql'] })
        : bareTree(`now-${label}`, { '0001_beta.sql': BETA })
    expect(() => applyMigrations(db, now), label).toThrow(
      /NO migration file in this build corresponds to/,
    )
    expect(tableExists(db, 'beta'), label).toBe(false)
    // Still self-diagnosing: the repairs entry it prints is still there.
    expect(messageOf(() => applyMigrations(db, now))).toContain('"recorded_name": "alpha"')
  }
})

test('the unexplained-row message reports what the recorded row established about the tree', () => {
  // The forensic question the incident could not answer: was the row's file part
  // of the tree that applied it? Three states, three different messages.
  const db = new Database(':memory:')
  applyMigrations(db, checkout('m-was', { files: { '0001_alpha.sql': ALPHA }, tracked: ['0001_alpha.sql'] }))
  const now = checkout('m-now', { files: { '0001_beta.sql': BETA }, tracked: ['0001_beta.sql'] })
  expect(sections(messageOf(() => applyMigrations(db, now)))['recorded "alpha"']?.['tree']).toBe(
    'tracked-in-index',
  )

  const unverified = new Database(':memory:')
  applyMigrations(unverified, bareTree('u-was', { '0001_alpha.sql': ALPHA }))
  expect(
    sections(messageOf(() => applyMigrations(unverified, bareTree('u-now', { '0001_beta.sql': BETA }))))[
      'recorded "alpha"'
    ]?.['tree'],
  ).toBe('unverifiable:no-git-metadata')

  // A row written by the build that recorded a commit but not yet a tree verdict
  // says exactly that, rather than printing a blank. Note the row still carries a
  // `content_sha256` — that is what makes it adjudicable at all.
  const legacy = new Database(':memory:')
  legacy.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL,
     content_sha256 TEXT,
     applied_by_commit TEXT
   )`)
  legacy.run(
    'INSERT INTO _migrations (version, name, applied_at, content_sha256) VALUES (1, ?, ?, ?)',
    ['alpha', 1_700_000_000, migrationContentHash(ALPHA)],
  )
  const message = messageOf(() => applyMigrations(legacy, bareTree('l-now', { '0001_beta.sql': BETA })))
  expect(sections(message)['recorded "alpha"']?.['tree']).toBe(
    '(not recorded — row predates deployed-tree verification)',
  )
})

test('an untracked stray at an ALREADY-RECORDED ordinal is diagnosed as the stray', () => {
  // The presentation the last outage actually arrived in. The ordinal being occupied
  // is no longer a refusal of its own, so there is only one finding left here — but
  // the message must still SAY what shares the number, or an operator who sees a
  // taken ordinal alongside "not tracked" goes hunting a second problem.
  const db = new Database(':memory:')
  const applied = checkout('recorded-was', {
    files: { '0001_alpha.sql': ALPHA },
    tracked: ['0001_alpha.sql'],
  })
  expect(applyMigrations(db, applied)).toEqual({ applied: [1], skipped: [] })

  // Ordinal 1 is recorded as `alpha`; the file on disk is `beta` AND untracked.
  const dir = checkout('recorded-now', {
    files: { '0001_beta.sql': BETA },
    tracked: ['README.md'],
  })
  const message = messageOf(() => applyMigrations(db, dir))
  expect(message).toContain('NOT part of the deployed tree')
  expect(message).toContain('0001_beta.sql')
  expect(message).not.toContain('"recorded_name"') // no repairs.json entry to paste
  // It still names the row that shares the ordinal, as context.
  expect(message).toContain('Ordinal 1 is ALREADY recorded, under the name "alpha"')
  expect(sections(message)['recorded']).toEqual({ name: 'alpha', applied: expect.any(String) })
  expect(tableExists(db, 'beta')).toBe(false)

  // CONTROL: with the SAME ledger and the file TRACKED, the untracked refusal must
  // fall silent and the other one speak — so the reclassification is the tree
  // verdict, not the untracked message swallowing everything at a taken ordinal.
  const tracked = checkout('recorded-now-tracked', {
    files: { '0001_beta.sql': BETA },
    tracked: ['0001_beta.sql'],
  })
  const unexplained = messageOf(() => applyMigrations(db, tracked))
  expect(unexplained).toContain('NO migration file in this build corresponds to')
  expect(unexplained).not.toContain('NOT part of the deployed tree')
  expect(unexplained).toContain('"recorded_name": "alpha"')
})

test('an acknowledged repair still wins over the untracked verdict', () => {
  // The deliberate precedence. A repairs entry is an explicit, hand-verified
  // operator decision about one ordinal; overriding it would convert a documented
  // recovery into a boot outage with no remedy — including on this repository's own
  // two entries.
  const db = new Database(':memory:')
  const applied = checkout('ack-win-was', {
    files: { '0001_alpha.sql': ALPHA },
    tracked: ['0001_alpha.sql'],
  })
  applyMigrations(db, applied)

  const dir = checkout('ack-win-now', { files: { '0001_beta.sql': BETA }, tracked: ['README.md'] })
  writeFileSync(
    join(dir, 'repairs.json'),
    JSON.stringify([
      { version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'test', date: '2026-08-17' },
    ]),
  )
  expect(applyMigrations(db, dir)).toEqual({ applied: [], skipped: [1] })
})

test('the column is added additively; a pre-existing row stays NULL and still boots', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL
   )`)
  db.exec(ALPHA)
  db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', [
    'alpha',
    1_700_000_000,
  ])

  const dir = bareTree('upgrade', { '0001_alpha.sql': ALPHA, '0002_beta.sql': BETA })
  expect(applyMigrations(db, dir)).toEqual({ applied: [2], skipped: [1] })
  expect(ledgerColumns(db)).toContain('tree_provenance')
  expect(rows(db)[0]?.['tree_provenance']).toBeNull()
  expect(rows(db)[1]?.['tree_provenance']).toBe('unverifiable:no-git-metadata')
})

// ------------------------------------- a stray that collides with a real ordinal

/**
 * The shape ordinals 122 and 124 actually took on the live instance: a stray did
 * not arrive at a FREE ordinal, it landed on one a real migration already owned.
 * That trips the ordinal-collision guard first, and the collision message sends
 * the operator hunting a duplicate they never committed while the real remedy —
 * delete the stray — goes unsaid. Fail-closed either way; the diagnosis is the
 * whole value.
 */
test('a stray colliding with a tracked file is diagnosed as the stray, not as a collision', () => {
  const dir = checkout('collide', {
    files: { '0001_alpha.sql': ALPHA, '0001_stray.sql': STRAY },
    tracked: ['0001_alpha.sql'],
  })
  const message = messageOf(() => applyMigrations(new Database(':memory:'), dir))
  expect(message).toContain('0001_stray.sql')
  expect(message).toMatch(/NOT part of the deployed tree/)
  // The point of the change: the WRONG diagnosis is gone, not merely outranked.
  expect(message).not.toMatch(/ordinal collision/)
})

test('THE CONTROL — two TRACKED files at one ordinal still report the collision', () => {
  // Without this, the test above passes just as well against a guard that stopped
  // checking ordinal collisions altogether — which would be a real regression, since
  // two committed files at one ordinal is a mistake in this repository and naming
  // both is the only useful message for it.
  const dir = checkout('collide-both-tracked', {
    files: { '0001_alpha.sql': ALPHA, '0001_beta.sql': BETA },
    tracked: ['0001_alpha.sql', '0001_beta.sql'],
  })
  const message = messageOf(() => applyMigrations(new Database(':memory:'), dir))
  expect(message).toContain('Migration ordinal collision at version 1')
  expect(message).toContain('0001_alpha.sql')
  expect(message).toContain('0001_beta.sql')
})

test('THE CONTROL — with no git metadata a collision still reports the collision', () => {
  // The deferral is bought with the tree verdict, so where there is none the old
  // message must survive untouched. An install that cannot check is not an install
  // that stops checking what it can.
  const dir = bareTree('collide-bare', { '0001_alpha.sql': ALPHA, '0001_beta.sql': BETA })
  expect(messageOf(() => applyMigrations(new Database(':memory:'), dir))).toContain(
    'Migration ordinal collision at version 1',
  )
})

// ------------------------------------------------ the parser's own ground truth

/**
 * Say out loud that a control did not run — and FAIL where it should have.
 *
 * A control that returns early reads as a pass, which is this repository's own
 * rule-7 trap: the tool could not answer and the silence looked like an answer.
 * The controls that call this legitimately cannot run everywhere — a source
 * export has no `.git`, and a machine may have no `git` on PATH — so on such a
 * machine the skip is a warning, VISIBLE in the output rather than
 * indistinguishable from a verified run.
 *
 * IN CI IT IS A HARD FAILURE, and that is the half that was missing. A warning is
 * only a signal if something reads it, and nothing reads CI's stdout on a green
 * run; a control that quietly stopped executing would have looked exactly like a
 * control that passed, for as long as it took someone to notice. CI checks out
 * with real git metadata and a real `git` binary (`actions/checkout`), so a skip
 * there is not an unsupported machine — it is the control not running, which is
 * the one thing a control may never do silently. This is what makes the guard's
 * own coverage assertable instead of advisory.
 *
 * Keyed on `CI`, which every CI provider sets and no developer machine does. It
 * gates nothing in the product and adds no second code path to it — this is the
 * test suite deciding how loudly to complain about its own environment.
 */
function controlDidNotRun(name: string, why: string): void {
  const what = `CONTROL DID NOT EXECUTE — ${name}: ${why}`
  const ci = process.env['CI']
  if (ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0') {
    throw new Error(
      `${what}. CI has a real checkout and a real git, so this is a broken control, not an unsupported machine.`,
    )
  }
  console.warn(`${what}. Fixtures still cover the logic.`)
}

test('THE CONTROL — the parser agrees with git ls-files on this repository', () => {
  // A hand-built fixture cannot prove that REAL git output is read correctly,
  // and a parser that misread it would report tracked files as absent — turning
  // this guard into a boot refusal on every correct install. So compare against
  // git's own answer, on a real index, for the whole tree. This is also the only
  // check that the verified trailing checksum is computed the way GIT computes it:
  // an encoder and a parser agreeing on a wrong hash would pass every fixture and
  // reject every real index.
  const gitPath = join(REPO_ROOT, '.git')
  if (!existsSync(gitPath)) {
    controlDidNotRun('parser vs git ls-files', 'this tree has no .git (a source export)')
    return
  }

  // A machine with no `git` on PATH is a supported machine — the fixtures above
  // still cover the logic, this control just cannot run.
  let expected: Set<string>
  try {
    const lsFiles = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: REPO_ROOT })
    if (lsFiles.exitCode !== 0) {
      controlDidNotRun('parser vs git ls-files', `git ls-files exited ${lsFiles.exitCode}`)
      return
    }
    expected = new Set(lsFiles.stdout.toString().split('\0').filter((p) => p.length > 0))
  } catch (err) {
    controlDidNotRun('parser vs git ls-files', `git could not be spawned (${String(err)})`)
    return
  }

  // `.git` is a directory in a clone and a `gitdir:` pointer FILE in a linked
  // worktree or a submodule checkout. Both shapes must find the index.
  const pointer = statSync(gitPath).isFile()
    ? readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    : undefined
  const parsed = parseGitIndex(readFileSync(join(pointer ?? gitPath, 'index')))
  if (!parsed.ok) throw new Error(`this repository's own index did not parse: ${parsed.reason}`)

  expect(parsed.paths.size).toBe(expected.size)
  for (const path of expected) expect(parsed.paths.has(path)).toBe(true)
})

test('THE CONTROL — REAL git agrees about all four states, on an index git wrote itself', () => {
  // The hand-built fixture cannot prove the intent-to-add decoding is right: an
  // encoder and a parser agreeing on a WRONG extended-entry layout would pass every
  // fixture in this file. So let git build the index — `git add -N` also forces
  // index version 3, so this is the only place a real extended entry is read — and
  // assert all four states at once, since the value of the guard is exactly that it
  // separates them.
  const repo = join(tmp, 'realgit')
  mkdirSync(join(repo, 'migrations'), { recursive: true })
  const git = (...args: string[]): boolean => {
    const r = Bun.spawnSync(['git', ...args], { cwd: repo })
    return r.exitCode === 0
  }
  try {
    if (!git('init', '-q', '.')) {
      controlDidNotRun('real git four states', 'git init failed (no usable git)')
      return
    }
  } catch (err) {
    controlDidNotRun('real git four states', `git could not be spawned (${String(err)})`)
    return
  }
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'neutron' }))
  const dir = join(repo, 'migrations')
  writeFileSync(join(dir, 'README.md'), 'x\n')
  writeFileSync(join(dir, '0001_committed.sql'), ALPHA)
  writeFileSync(join(dir, '0002_intent.sql'), BETA)
  writeFileSync(join(dir, '0003_never_added.sql'), STRAY)
  writeFileSync(join(dir, '0004_staged.sql'), BETA)
  git('add', 'package.json', 'migrations/README.md', 'migrations/0001_committed.sql')
  if (!git('commit', '-qm', 'init')) {
    controlDidNotRun('real git four states', 'git commit failed')
    return
  }
  git('add', '-N', 'migrations/0002_intent.sql')
  git('add', 'migrations/0004_staged.sql')

  const tree = resolveDeployedTree(dir)
  // The index git wrote parses, checksum and all — the negative controls in this
  // file only mean something if a REAL index still reads clean.
  expect(tree.kind).toBe('verified')
  if (tree.kind !== 'verified') return
  expect(tree.tracked.has('0001_committed.sql')).toBe(true)
  // `git add -N` records a path with NO staged content, so it is in no tree.
  expect(tree.tracked.has('0002_intent.sql')).toBe(false)
  // Never told git about — every occurrence of the incident class.
  expect(tree.tracked.has('0003_never_added.sql')).toBe(false)
  // THE DOCUMENTED RESIDUAL, asserted rather than left implicit: the index is the
  // STAGED tree, so a file `git add`ed and never committed reads as tracked. That is
  // why the recorded value is `tracked-in-index` and not a claim about a commit.
  expect(tree.tracked.has('0004_staged.sql')).toBe(true)

  // And end to end. BOTH untracked files refuse, reported in ordinal order, which is
  // what makes the refusal deterministic rather than dependent on directory order.
  expect(() => applyMigrations(new Database(':memory:'), dir)).toThrow(/0002_intent\.sql/)
  rmSync(join(dir, '0002_intent.sql'))
  expect(() => applyMigrations(new Database(':memory:'), dir)).toThrow(/0003_never_added\.sql/)
  rmSync(join(dir, '0003_never_added.sql'))
  // With both gone, the committed file AND the staged-uncommitted one apply — the
  // control that this whole fixture is not simply refusing everything.
  const db = new Database(':memory:')
  expect(applyMigrations(db, dir)).toEqual({ applied: [1, 4], skipped: [] })
  for (const row of rows(db)) expect(row['tree_provenance']).toBe('tracked-in-index')
})

test("this repository's own migration files are all tracked", () => {
  // The invariant the guard enforces, asserted against the real tree — and the
  // end-to-end proof that the check is ACTIVE here rather than silently inert.
  if (!existsSync(join(REPO_ROOT, '.git'))) {
    controlDidNotRun("this repository's own migrations", 'this tree has no .git (a source export)')
    return
  }

  const migrationsDir = join(REPO_ROOT, 'migrations')
  const tree = resolveDeployedTree(migrationsDir)
  expect(tree.kind).toBe('verified')
  if (tree.kind !== 'verified') return
  expect(tree.dirPrefix).toBe('migrations/')
  expect(tree.tracked.has('runner.ts')).toBe(true)

  // THE INVARIANT, ENUMERATED — and this is the assertion that can actually FAIL
  // on the defect. Naming one or two files by hand proved only that the resolver
  // answers about this tree; it could not fail on the real shape of the incident,
  // which is ONE untracked `NNNN_*.sql` among the many files here. Without the
  // enumeration below, an untracked migration committed to this repository passes
  // CI and first announces itself as a production boot refusal — the guard
  // catching us in the field instead of at review time.
  //
  // The set comes from `loadMigrations`, the PRODUCTION loader, rather than from a
  // second copy of its filename pattern: the question this test has to ask is
  // "is every file the runner would APPLY tracked", so asking the runner is the
  // only phrasing that cannot drift away from it.
  const willApply = loadMigrations(migrationsDir).map((m) => m.fileName)

  // Two controls, because the filter that follows is satisfied by doing nothing.
  // An enumeration that found no files, or a `tracked` set that contained every
  // string, would both leave it green while checking nothing at all.
  expect(willApply.length).toBeGreaterThan(50)
  expect(willApply).toContain('0001_initial_schema.sql')
  expect(tree.tracked.has('9999_no_such_migration.sql')).toBe(false)

  // Listed, not counted: a failure has to name the file to be actionable.
  expect(willApply.filter((f) => !tree.tracked.has(f))).toEqual([])
})
