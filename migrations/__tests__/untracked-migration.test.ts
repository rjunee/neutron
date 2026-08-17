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
import { applyMigrations } from '../runner.ts'
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
  expect(message).toContain('COMMIT it to the deployed tree')
  expect(message).toContain('Do NOT reach for migrations/repairs.json')
})

test('the refusal applies NOTHING — not the stray, and not the tracked file beside it', () => {
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
  expect(db.query('SELECT version FROM _migrations').all()).toEqual([])
  // And the ledger's SHAPE is untouched: a guard whose job is to change nothing
  // must not have reshaped the database it just declared untrustworthy. (Which
  // is also why the row helper cannot be used above — its select list names
  // columns that, correctly, do not exist yet.)
  expect(ledgerColumns(db)).toEqual(['version', 'name', 'applied_at'])
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
    expect(row['tree_provenance']).toBe('tracked')
    expect(row['applied_by_commit']).toBe(HEAD_SHA)
  }
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
    ['truncated', encodeIndex([{ path: 'migrations/0001_alpha.sql' }]).slice(0, 40), 'unreadable-index'],
    ['garbage', Uint8Array.from(new Array<number>(64).fill(7)), 'unreadable-index'],
  ]

  for (const [name, index, reason] of cases) {
    const db = new Database(':memory:')
    const dir = checkout(name, { files: { '0001_alpha.sql': ALPHA }, index })
    expect(resolveDeployedTree(dir), name).toEqual({ kind: 'unverifiable', reason })
    expect(applyMigrations(db, dir), name).toEqual({ applied: [1], skipped: [] })
    expect(rows(db)[0]?.['tree_provenance'], name).toBe(`unverifiable:${reason}`)
  }
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
  expect(rows(db)[0]?.['tree_provenance']).toBe('tracked')
})

// -------------------------------------- 4. the existing refusal still refuses

test('the name-mismatch refusal STILL FIRES, in a tracked tree and in an unverifiable one', () => {
  // Hardening one guard must not create a false negative in the other. Both
  // trees below carry a genuine mismatch and both must throw, applying nothing.
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
    expect(() => applyMigrations(db, now), label).toThrow(/Migration version 1 was recorded as "alpha"/)
    expect(tableExists(db, 'beta'), label).toBe(false)
    // Still self-diagnosing: the repairs entry it prints is still there.
    expect(messageOf(() => applyMigrations(db, now))).toContain('"recorded_name": "alpha"')
  }
})

test('the mismatch message reports what the recorded row established about the tree', () => {
  // The forensic question the incident could not answer: was the row's file part
  // of the tree that applied it? Three states, three different messages.
  const db = new Database(':memory:')
  applyMigrations(db, checkout('m-was', { files: { '0001_alpha.sql': ALPHA }, tracked: ['0001_alpha.sql'] }))
  const now = checkout('m-now', { files: { '0001_beta.sql': BETA }, tracked: ['0001_beta.sql'] })
  expect(sections(messageOf(() => applyMigrations(db, now)))['recorded']?.['tree']).toBe('tracked')

  const unverified = new Database(':memory:')
  applyMigrations(unverified, bareTree('u-was', { '0001_alpha.sql': ALPHA }))
  expect(
    sections(messageOf(() => applyMigrations(unverified, bareTree('u-now', { '0001_beta.sql': BETA }))))[
      'recorded'
    ]?.['tree'],
  ).toBe('unverifiable:no-git-metadata')

  // A row written by the build that recorded a commit but not yet a tree verdict
  // says exactly that, rather than printing a blank or claiming it predates all
  // provenance — two absences that send the reader to different places.
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
  expect(sections(message)['recorded']?.['tree']).toBe(
    '(not recorded — row predates deployed-tree verification)',
  )
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

// ------------------------------------------------ the parser's own ground truth

test('THE CONTROL — the parser agrees with git ls-files on this repository', () => {
  // A hand-built fixture cannot prove that REAL git output is read correctly,
  // and a parser that misread it would report tracked files as absent — turning
  // this guard into a boot refusal on every correct install. So compare against
  // git's own answer, on a real index, for the whole tree.
  const gitPath = join(REPO_ROOT, '.git')
  if (!existsSync(gitPath)) return // a source export legitimately has none

  // A machine with no `git` on PATH is a supported machine — the fixtures above
  // still cover the logic, this control just cannot run.
  let expected: Set<string>
  try {
    const lsFiles = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: REPO_ROOT })
    if (lsFiles.exitCode !== 0) return
    expected = new Set(lsFiles.stdout.toString().split('\0').filter((p) => p.length > 0))
  } catch {
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

test("this repository's own migration files are all tracked", () => {
  // The invariant the guard enforces, asserted against the real tree — and the
  // end-to-end proof that the check is ACTIVE here rather than silently inert.
  if (!existsSync(join(REPO_ROOT, '.git'))) return

  const tree = resolveDeployedTree(join(REPO_ROOT, 'migrations'))
  expect(tree.kind).toBe('verified')
  if (tree.kind !== 'verified') return
  expect(tree.dirPrefix).toBe('migrations/')
  expect(tree.tracked.has('runner.ts')).toBe(true)
  expect(tree.tracked.has('0001_initial_schema.sql')).toBe(true)
})
