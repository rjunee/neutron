/**
 * A migration row must name the build that applied it.
 *
 * The incident these tests exist for: a live instance crash-looped on boot for
 * three hours because `_migrations` held an ordinal under one name while the
 * deployed code carried another. The runner refused, correctly. But the
 * investigation could not answer WHICH BUILD had written the offending row —
 * at the moment it was written, the commit the instance was running contained
 * no migration at that ordinal at all. Nothing on disk recorded the answer, so
 * the class recurred without ever being closed.
 *
 * Two things are pinned here. Provenance is recorded on apply, and survives an
 * install that has no git metadata at all. And the refusal, which must stay
 * exactly as fail-closed as it was, now prints its own recovery: the last test
 * group takes the entry out of the thrown message and proves it resolves the
 * mismatch, so nobody has to reverse-engineer `repairKey` from source again.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'
import { migrationContentHash, resolveDeployedCommit } from '../provenance.ts'

const ALPHA = 'CREATE TABLE t1 (id INTEGER);'
const BETA = 'CREATE TABLE t2 (id INTEGER);'
const GAMMA = 'CREATE TABLE t3 (id INTEGER);'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
/** A second, obviously distinct id — the one an unrelated repo would contribute. */
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

let tmp: string
let savedCommitEnv: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mig-provenance-'))
  // The runner reads the ambient environment. A stray NEUTRON_COMMIT_SHA in the
  // shell running the suite would quietly satisfy the "no git metadata" cases.
  savedCommitEnv = process.env['NEUTRON_COMMIT_SHA']
  delete process.env['NEUTRON_COMMIT_SHA']
})

afterEach(() => {
  if (savedCommitEnv === undefined) delete process.env['NEUTRON_COMMIT_SHA']
  else process.env['NEUTRON_COMMIT_SHA'] = savedCommitEnv
  rmSync(tmp, { recursive: true, force: true })
})

/** A migration tree at `<tmp>/<name>/`. */
function tree(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(dir, file), contents)
  return dir
}

/**
 * A migration tree inside a checkout whose `.git` we lay out by hand.
 *
 * The root `package.json` is not decoration: it is the ownership test the
 * resolver applies before reading any HEAD, so a checkout without it is a
 * checkout this tree does not own. `rootPackage` lets a test build exactly that.
 */
function treeInCheckout(
  name: string,
  gitFiles: Record<string, string>,
  rootPackage: string | null = JSON.stringify({ name: 'neutron' }),
): string {
  const root = join(tmp, name)
  mkdirSync(root, { recursive: true })
  if (rootPackage !== null) writeFileSync(join(root, 'package.json'), rootPackage)
  for (const [path, contents] of Object.entries(gitFiles)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents)
  }
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '0001_alpha.sql'), ALPHA)
  return dir
}

function rows(db: Database): Array<Record<string, unknown>> {
  return db
    .query('SELECT version, name, content_sha256, applied_by_commit FROM _migrations ORDER BY version')
    .all() as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------- provenance

test('an applied row records the content hash of the file that was applied', () => {
  const db = new Database(':memory:')
  applyMigrations(db, tree('a', { '0001_alpha.sql': ALPHA, '0002_gamma.sql': GAMMA }))

  const recorded = rows(db)
  expect(recorded).toHaveLength(2)
  expect(recorded[0]?.['content_sha256']).toBe(createHash('sha256').update(ALPHA, 'utf8').digest('hex'))
  expect(recorded[1]?.['content_sha256']).toBe(createHash('sha256').update(GAMMA, 'utf8').digest('hex'))
})

test('the content hash distinguishes two different migrations sharing a name', () => {
  // The forensic question the incident could not answer. Same ordinal, same
  // slug, different bytes — the name alone says these are identical.
  const one = new Database(':memory:')
  const two = new Database(':memory:')
  applyMigrations(one, tree('one', { '0001_alpha.sql': ALPHA }))
  applyMigrations(two, tree('two', { '0001_alpha.sql': `${ALPHA}\nCREATE TABLE extra (id INTEGER);` }))

  expect(rows(one)[0]?.['name']).toBe(rows(two)[0]?.['name'])
  expect(rows(one)[0]?.['content_sha256']).not.toBe(rows(two)[0]?.['content_sha256'])
})

test('a tree with no git metadata still boots, and says so rather than guessing', () => {
  const db = new Database(':memory:')
  // No package.json anywhere above this tree, so even if the temp directory
  // happened to sit under a checkout, that checkout is not one we own and the
  // resolver refuses it. The assertion does not rest on the machine's layout.
  const dir = tree('bare', { '0001_alpha.sql': ALPHA })

  expect(resolveDeployedCommit({}, dir)).toBeNull()
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['applied_by_commit']).toBeNull()
  // The row is still identified — a tarball install loses the commit, never the hash.
  expect(rows(db)[0]?.['content_sha256']).toBe(migrationContentHash(ALPHA))
})

test('a checkout with git metadata records the deployed commit', () => {
  const db = new Database(':memory:')
  const dir = treeInCheckout('clone', {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/refs/heads/main': `${SHA}\n`,
  })

  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['applied_by_commit']).toBe(SHA)
})

test('NEUTRON_COMMIT_SHA wins, so a build with no .git can still declare its identity', () => {
  const dir = tree('packaged', { '0001_alpha.sql': ALPHA })
  expect(resolveDeployedCommit({ NEUTRON_COMMIT_SHA: SHA.toUpperCase() }, dir)).toBe(SHA)

  const db = new Database(':memory:')
  process.env['NEUTRON_COMMIT_SHA'] = SHA
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['applied_by_commit']).toBe(SHA)
})

test('commit resolution reads git metadata as files: packed refs, detached HEAD, worktrees', () => {
  expect(
    resolveDeployedCommit({}, treeInCheckout('packed', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`,
    })),
  ).toBe(SHA)

  expect(
    resolveDeployedCommit({}, treeInCheckout('detached', { '.git/HEAD': `${SHA}\n` })),
  ).toBe(SHA)

  // A linked worktree keeps its own HEAD but shares refs/ with the main
  // checkout through `commondir`; resolving only the worktree's own gitdir
  // finds HEAD and then fails to resolve the branch it names.
  const commonDir = join(tmp, 'wt-main', '.git')
  mkdirSync(join(commonDir, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(commonDir, 'refs', 'heads', 'topic'), `${SHA}\n`)
  const linked = treeInCheckout('wt-linked', {
    '.git': `gitdir: ${join(commonDir, 'worktrees', 'linked')}\n`,
  })
  mkdirSync(join(commonDir, 'worktrees', 'linked'), { recursive: true })
  writeFileSync(join(commonDir, 'worktrees', 'linked', 'HEAD'), 'ref: refs/heads/topic\n')
  writeFileSync(join(commonDir, 'worktrees', 'linked', 'commondir'), '../..\n')
  expect(resolveDeployedCommit({}, linked)).toBe(SHA)
})

test('commit resolution is total — malformed git metadata resolves to null, never throws', () => {
  for (const gitFiles of [
    { '.git/HEAD': 'ref: refs/heads/main\n' }, // symbolic ref pointing at nothing
    { '.git/HEAD': 'not-an-object-id\n' },
    { '.git/HEAD': '' },
    { '.git': 'gitdir:\n' }, // pointer file with no target
    { '.git/config': '[core]\n' }, // a .git dir with no HEAD at all
  ]) {
    expect(resolveDeployedCommit({}, treeInCheckout(`broken-${Math.random()}`, gitFiles))).toBeNull()
  }
  // A garbage env value is ignored rather than recorded as a commit.
  expect(resolveDeployedCommit({ NEUTRON_COMMIT_SHA: 'HEAD' }, tmp)).toBeNull()
})

// ------------------------------------------------------------ repo ownership

test('an install nested inside an unrelated repository records NULL, not that repo\'s HEAD', () => {
  // A self-hostable engine gets unpacked anywhere, including inside somebody
  // else's checkout. Walking up for the first `.git` finds THEIR repo and reads
  // THEIR HEAD — a value that is well-formed, plausible, and wrong, which is
  // strictly worse than the NULL this file promises for an unidentifiable build.
  const outer = join(tmp, 'someones-repo')
  mkdirSync(join(outer, '.git'), { recursive: true })
  writeFileSync(join(outer, '.git', 'HEAD'), `${OTHER_SHA}\n`)
  writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'someones-project' }))

  // POSITIVE CONTROL. The same fixture, differing only in the root package
  // name, must resolve — otherwise a null below would prove nothing except that
  // the hand-built `.git` was unreadable.
  const control = join(tmp, 'control-repo')
  mkdirSync(join(control, '.git'), { recursive: true })
  writeFileSync(join(control, '.git', 'HEAD'), `${OTHER_SHA}\n`)
  writeFileSync(join(control, 'package.json'), JSON.stringify({ name: 'neutron' }))
  expect(resolveDeployedCommit({}, control)).toBe(OTHER_SHA)

  const nested = join(outer, 'vendor', 'neutron', 'migrations')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, '0001_alpha.sql'), ALPHA)

  expect(resolveDeployedCommit({}, nested)).toBeNull()

  const db = new Database(':memory:')
  expect(applyMigrations(db, nested)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['applied_by_commit']).toBeNull()
  expect(rows(db)[0]?.['content_sha256']).toBe(migrationContentHash(ALPHA))
})

test('a nested install can still declare its identity through NEUTRON_COMMIT_SHA', () => {
  // The ownership test removes a wrong answer; it must not remove the operator's
  // ability to supply the right one.
  const outer = join(tmp, 'host-repo')
  mkdirSync(join(outer, '.git'), { recursive: true })
  writeFileSync(join(outer, '.git', 'HEAD'), `${OTHER_SHA}\n`)
  const nested = join(outer, 'neutron', 'migrations')
  mkdirSync(nested, { recursive: true })

  expect(resolveDeployedCommit({ NEUTRON_COMMIT_SHA: SHA }, nested)).toBe(SHA)
})

test('a checkout whose root package.json is not ours is not ours', () => {
  // The same repo, one field different. Nothing else distinguishes the two.
  const owned = treeInCheckout('owned', {
    '.git/HEAD': `${SHA}\n`,
  })
  const foreign = treeInCheckout(
    'foreign',
    { '.git/HEAD': `${SHA}\n` },
    JSON.stringify({ name: 'not-neutron' }),
  )
  const unmarked = treeInCheckout('unmarked', { '.git/HEAD': `${SHA}\n` }, null)
  const malformed = treeInCheckout('malformed', { '.git/HEAD': `${SHA}\n` }, '{ not json')

  expect(resolveDeployedCommit({}, owned)).toBe(SHA)
  expect(resolveDeployedCommit({}, foreign)).toBeNull()
  expect(resolveDeployedCommit({}, unmarked)).toBeNull()
  expect(resolveDeployedCommit({}, malformed)).toBeNull()
})

test('this repository is still the tree the resolver recognises', () => {
  // The ownership test keys on the root package name. If that name changes and
  // nothing notices, provenance silently stops resolving in every real install
  // while every test above keeps passing on its own fixtures — the failure mode
  // is total, permanent, and invisible. So assert against the real file.
  const rootPackage: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8'),
  )
  expect((rootPackage as { name?: unknown }).name).toBe('neutron')

  // And end-to-end, when this checkout actually has git metadata to read (a
  // source export legitimately does not): resolving from this tree's own
  // migrations directory yields this tree's HEAD.
  if (existsSync(join(import.meta.dir, '..', '..', '.git'))) {
    expect(resolveDeployedCommit({}, join(import.meta.dir, '..'))).toMatch(/^[0-9a-f]{7,64}$/)
  }
})

// -------------------------------------------------- additive column rollout

test('an existing ledger is upgraded additively; pre-existing rows stay NULL and still boot', () => {
  const db = new Database(':memory:')
  // The ledger exactly as it was before this shipped, with a row already in it.
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL
   )`)
  db.exec('CREATE TABLE t1 (id INTEGER)')
  db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['alpha', 1_700_000_000])

  const dir = tree('upgrade', { '0001_alpha.sql': ALPHA, '0002_gamma.sql': GAMMA })
  expect(applyMigrations(db, dir)).toEqual({ applied: [2], skipped: [1] })

  const recorded = rows(db)
  // Nobody knows what applied the old row. Recording NULL is the honest answer.
  expect(recorded[0]).toEqual({ version: 1, name: 'alpha', content_sha256: null, applied_by_commit: null })
  expect(recorded[1]?.['content_sha256']).toBe(migrationContentHash(GAMMA))
})

test('a ledger carrying only SOME provenance columns is completed, not rejected', () => {
  // The state a lost check-then-ALTER race leaves behind, and the state an
  // interrupted upgrade leaves behind. Each column is considered on its own, so
  // a half-upgraded ledger boots and finishes the job.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL,
     content_sha256 TEXT
   )`)

  const dir = tree('partial', { '0001_alpha.sql': ALPHA })
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })

  const columns = (db.query("SELECT name FROM pragma_table_info('_migrations')").all() as Array<{ name: string }>)
    .map((c) => c.name)
  expect(columns).toContain('content_sha256')
  expect(columns).toContain('applied_by_commit')
  expect(rows(db)[0]?.['content_sha256']).toBe(migrationContentHash(ALPHA))
})

test('bootstrapping the columns is idempotent across repeated runs', () => {
  const db = new Database(':memory:')
  const dir = tree('idem', { '0001_alpha.sql': ALPHA })
  applyMigrations(db, dir)
  expect(applyMigrations(db, dir)).toEqual({ applied: [], skipped: [1] })
  expect(applyMigrations(db, dir)).toEqual({ applied: [], skipped: [1] })

  const columns = db.query("SELECT name FROM pragma_table_info('_migrations')").all() as Array<{ name: string }>
  expect(columns.filter((c) => c.name === 'content_sha256')).toHaveLength(1)
  expect(columns.filter((c) => c.name === 'applied_by_commit')).toHaveLength(1)
})

// -------------------------------------------------- the self-diagnosing error

/** The mismatch the incident produced: version 1 recorded as alpha, code has beta. */
function mismatch(): { db: Database; b: string } {
  const db = new Database(':memory:')
  applyMigrations(db, tree('was', { '0001_alpha.sql': ALPHA }))
  return { db, b: tree('now', { '0001_beta.sql': BETA, '0002_gamma.sql': GAMMA }) }
}

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected a throw, got none')
}

/**
 * The message's labelled blocks, parsed back into `{ section: { field: value } }`.
 *
 * A whole-message `toContain` cannot tell the two hashes apart: swap them, drop
 * a label, or file the recorded values under "on disk" and every such assertion
 * stays green while the operator reads a message that points at the wrong side
 * of the mismatch. Parsing by section is what makes the assertions mean what
 * they say.
 */
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

/**
 * The repairs entry, taken out of the message by its own indentation.
 *
 * Scanning from the first `{` to the last `}` looked equivalent and is not: a
 * brace inside any recorded VALUE breaks it, and the recorded name is operator
 * data. The entry is emitted as a 4-space-indented JSON block, so read exactly
 * that block.
 */
function printedRepairsEntry(message: string): Record<string, unknown> {
  const lines = message.split('\n')
  const start = lines.findIndex((l) => /^ {4}\{$/.test(l))
  const end = lines.findIndex((l, i) => i > start && /^ {4}\}$/.test(l))
  if (start === -1 || end === -1) throw new Error('no indented JSON block in the message')
  const json = lines
    .slice(start, end + 1)
    .map((l) => l.slice(4))
    .join('\n')
  return JSON.parse(json) as Record<string, unknown>
}

test('the mismatch message prints what is on disk against what was recorded', () => {
  const { db, b } = mismatch()
  const parsed = sections(messageOf(() => applyMigrations(db, b)))

  // Each value under the heading it belongs to. Swapping the two hashes, or
  // dropping a label, fails here.
  expect(parsed['on disk']).toEqual({
    file: '0001_beta.sql',
    sha256: migrationContentHash(BETA),
  })
  expect(parsed['recorded']?.['name']).toBe('alpha')
  expect(parsed['recorded']?.['sha256']).toBe(migrationContentHash(ALPHA))
  expect(parsed['recorded']?.['applied']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

test('a recorded commit is printed as the build, and is the one the row carries', () => {
  // The non-null branch. Every other fixture here records NULL, so without this
  // the line that prints an actual build id is never executed by any test.
  const dir = tree('built', { '0001_alpha.sql': ALPHA })
  const db = new Database(':memory:')
  process.env['NEUTRON_COMMIT_SHA'] = SHA
  applyMigrations(db, dir)
  expect(rows(db)[0]?.['applied_by_commit']).toBe(SHA)

  const now = tree('built-now', { '0001_beta.sql': BETA })
  const parsed = sections(messageOf(() => applyMigrations(db, now)))
  expect(parsed['recorded']?.['build']).toBe(SHA)
  expect(parsed['recorded']?.['sha256']).toBe(migrationContentHash(ALPHA))
})

test('a row that predates provenance says so, instead of printing a blank', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL
   )`)
  db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['alpha', 1_700_000_000])

  const message = messageOf(() => applyMigrations(db, tree('now', { '0001_beta.sql': BETA })))
  expect(message).toContain('predates migration provenance')
  expect(message).toContain('2023-11-14') // applied_at, rendered as a real timestamp
  expect(message).not.toContain('no git metadata')
})

test('a row with a hash but no commit is reported as an unidentifiable BUILD, not a missing row', () => {
  // Two different absences that send the reader to different places. A tarball
  // install records the hash and no commit; saying that row "predates
  // provenance" would be a message describing a state the data contradicts.
  const { db, b } = mismatch()
  const message = messageOf(() => applyMigrations(db, b))

  expect(message).toContain(migrationContentHash(ALPHA))
  expect(message).toContain('the build carried no git metadata')
  expect(message).not.toContain('predates migration provenance')
})

test('the entry printed in the message is the entry that resolves the mismatch', () => {
  // The whole point of the change: recovery must not require reverse-engineering
  // repairKey() from source. So take the JSON the runner printed, paste it in
  // unmodified, and the same tree must boot.
  const { db, b } = mismatch()
  const message = messageOf(() => applyMigrations(db, b))

  const entry = printedRepairsEntry(message)
  expect(entry).toMatchObject({ version: 1, recorded_name: 'alpha', file_name: 'beta' })
  expect(typeof entry['note']).toBe('string')
  expect(typeof entry['date']).toBe('string')

  writeFileSync(join(b, 'repairs.json'), JSON.stringify([entry], null, 2))
  expect(applyMigrations(db, b)).toEqual({ applied: [2], skipped: [1] })
  // Fail-closed semantics intact: acknowledged, never applied, never renamed.
  expect(db.query('SELECT name FROM _migrations WHERE version = 1').get()).toEqual({ name: 'alpha' })
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()
})

test('the guard STILL REFUSES a genuine mismatch — no false negative', () => {
  // The hardening must not soften the check it hardens. Every one of these is
  // a real mismatch and every one must throw and apply nothing.
  const { db, b } = mismatch()
  expect(() => applyMigrations(db, b)).toThrow(/Migration version 1 was recorded as "alpha"/)
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't3'").get()).toBeNull()
  expect(db.query('SELECT version FROM _migrations WHERE version = 2').get()).toBeNull()

  // An entry for a DIFFERENT mismatch must not launder this one.
  writeFileSync(
    join(b, 'repairs.json'),
    JSON.stringify([{ version: 1, recorded_name: 'alpha', file_name: 'delta', note: 'other', date: '2026-08-16' }]),
  )
  expect(() => applyMigrations(db, b)).toThrow(/recorded as "alpha"/)

  // Nor an entry for a different version.
  writeFileSync(
    join(b, 'repairs.json'),
    JSON.stringify([{ version: 9, recorded_name: 'alpha', file_name: 'beta', note: 'other', date: '2026-08-16' }]),
  )
  expect(() => applyMigrations(db, b)).toThrow(/recorded as "alpha"/)

  // And the recorded row is untouched through all of it.
  expect(db.query('SELECT name FROM _migrations WHERE version = 1').get()).toEqual({ name: 'alpha' })
})

test('an applied_at outside the Date range prints the raw value instead of destroying the message', () => {
  // `Number.isFinite` passes a value like 9e12 seconds, and `new Date(x*1000)`
  // then throws RangeError out of `toISOString()`. That replaces the entire
  // self-diagnosing message — version, names, hashes, repairs entry — with a
  // bare RangeError, leaving the operator worse off than before this work.
  // NaN is not in this list because it cannot reach the reader: SQLite binds it
  // as NULL and `applied_at` is NOT NULL, so the INSERT is what fails.
  for (const appliedAt of [9e12, 1e300, -1e300, Number.POSITIVE_INFINITY]) {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE _migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at REAL NOT NULL
     )`)
    db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['alpha', appliedAt])

    const message = messageOf(() => applyMigrations(db, tree(`wide-${appliedAt}`, { '0001_beta.sql': BETA })))
    expect(message).toContain('Migration version 1 was recorded as "alpha"')
    expect(sections(message)['on disk']?.['sha256']).toBe(migrationContentHash(BETA))
    expect(printedRepairsEntry(message)).toMatchObject({ version: 1, recorded_name: 'alpha', file_name: 'beta' })
  }

  // The boundary itself is a real timestamp and is still rendered as one.
  const db = new Database(':memory:')
  db.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at REAL NOT NULL)')
  db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['alpha', 8.64e12])
  const parsed = sections(messageOf(() => applyMigrations(db, tree('edge', { '0001_beta.sql': BETA }))))
  expect(parsed['recorded']?.['applied']).toBe(new Date(8.64e15).toISOString())
})

test('the refusal changes nothing — not even the shape of the ledger', () => {
  // A guard whose job is to change nothing must not have reshaped the schema of
  // the database it just declared untrustworthy. Reading the ledger has to cost
  // no write, or the refusal path mutates on its way out.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL
   )`)
  db.exec('CREATE TABLE t1 (id INTEGER)')
  db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['alpha', 1_700_000_000])
  const before = db.query("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()

  expect(() => applyMigrations(db, tree('refused', { '0001_beta.sql': BETA }))).toThrow(/recorded as "alpha"/)

  expect(db.query("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()).toEqual(before)
  const columns = (db.query("SELECT name FROM pragma_table_info('_migrations')").all() as Array<{ name: string }>)
    .map((c) => c.name)
  expect(columns).not.toContain('content_sha256')
  expect(columns).not.toContain('applied_by_commit')
})

test('a fully migrated database can still be opened read-only and checked', () => {
  // Forensics on a backup is exactly when this runs against a read-only handle,
  // and it is exactly the situation this whole change exists to serve. Nothing
  // pending must mean nothing written.
  // Deliberately a ledger from BEFORE provenance shipped: that is the handle
  // an upgrade would want to reshape, so it is the one that proves reading is
  // read-only. A ledger the new code wrote already has the columns and would
  // pass whatever the ordering.
  const path = join(tmp, 'ro.db')
  const dir = tree('ro', { '0001_alpha.sql': ALPHA })
  const rw = new Database(path, { create: true })
  rw.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL
   )`)
  rw.exec(ALPHA)
  rw.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['alpha', 1_700_000_000])
  rw.close()

  const ro = new Database(path, { readonly: true })
  expect(applyMigrations(ro, dir)).toEqual({ applied: [], skipped: [1] })
  // And the handle really was left alone: the columns are still absent, which
  // is only possible if reading the ledger did not try to reshape it.
  const columns = (ro.query("SELECT name FROM pragma_table_info('_migrations')").all() as Array<{ name: string }>)
    .map((c) => c.name)
  expect(columns).toEqual(['version', 'name', 'applied_at'])
  ro.close()
})

test('on a fresh install EVERY row carries provenance, including ordinals below the last', () => {
  // Why the columns are bootstrapped by the runner rather than by a NNNN_*.sql
  // file. Each row is written inside its own migration's transaction, so an
  // ALTER at ordinal N would land AFTER rows 1..N-1 were already inserted, and
  // every fresh install would come up with a provenance-less history — on the
  // population where the record is easiest to get right, and on exactly the
  // kind of low ordinal (124) the motivating incident was about.
  const db = new Database(':memory:')
  const dir = tree('fresh', {
    '0001_alpha.sql': ALPHA,
    '0002_beta.sql': BETA,
    '0003_gamma.sql': GAMMA,
  })
  process.env['NEUTRON_COMMIT_SHA'] = SHA
  expect(applyMigrations(db, dir)).toEqual({ applied: [1, 2, 3], skipped: [] })

  const recorded = rows(db)
  expect(recorded).toHaveLength(3)
  for (const row of recorded) {
    expect(row['content_sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(row['applied_by_commit']).toBe(SHA)
  }
})

test('recording provenance did not make a matching re-run throw', () => {
  // The other direction of false positive: a normal boot must stay silent even
  // though the recorded hash and the on-disk hash are now both available.
  const db = new Database(':memory:')
  const dir = tree('steady', { '0001_alpha.sql': ALPHA })
  applyMigrations(db, dir)
  // A migration edited after it was applied (a comment fix) is NOT a mismatch —
  // the name is the contract, and widening the refusal to the hash would break
  // real installs on boot. Recorded here so the semantics are deliberate.
  writeFileSync(join(dir, '0001_alpha.sql'), `-- clarifying comment\n${ALPHA}`)
  expect(applyMigrations(db, dir)).toEqual({ applied: [], skipped: [1] })
})
