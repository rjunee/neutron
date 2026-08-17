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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'
import { migrationContentHash, resolveDeployedCommit } from '../provenance.ts'

const ALPHA = 'CREATE TABLE t1 (id INTEGER);'
const BETA = 'CREATE TABLE t2 (id INTEGER);'
const GAMMA = 'CREATE TABLE t3 (id INTEGER);'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

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

/** A migration tree inside a checkout whose `.git` we lay out by hand. */
function treeInCheckout(name: string, gitFiles: Record<string, string>): string {
  const root = join(tmp, name)
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

test('the mismatch message prints what is on disk against what was recorded', () => {
  const { db, b } = mismatch()
  const message = messageOf(() => applyMigrations(db, b))

  expect(message).toContain('0001_beta.sql')
  expect(message).toContain(migrationContentHash(BETA))
  expect(message).toContain('alpha')
  expect(message).toContain('beta')
  // The row was written WITH provenance, so the message names it. This is the
  // question the original investigation could not answer.
  expect(message).toContain(migrationContentHash(ALPHA))
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

  const json = message.slice(message.indexOf('{'), message.lastIndexOf('}') + 1)
  const entry = JSON.parse(json) as Record<string, unknown>
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
