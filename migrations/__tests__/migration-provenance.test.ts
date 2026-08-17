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
 * mismatch, so nobody has to reverse-engineer the matcher from source again.
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

  const nested = join(outer, 'vendor', 'neutron', 'migrations')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, '0001_alpha.sql'), ALPHA)

  // POSITIVE CONTROL, and it has to be the NESTED one. A control that resolves
  // from the outer root proves only that the hand-built `.git` is readable — it
  // never walks, so a null below would be equally explained by a walk that
  // never arrived. This control starts where the real assertion starts, three
  // directories down, and differs in exactly one byte-range: the outer root's
  // package name. It resolving is what makes the null attributable to the
  // ownership test rather than to a stalled search.
  const control = join(tmp, 'control-repo')
  const controlNested = join(control, 'vendor', 'neutron', 'migrations')
  mkdirSync(join(control, '.git'), { recursive: true })
  mkdirSync(controlNested, { recursive: true })
  writeFileSync(join(control, '.git', 'HEAD'), `${OTHER_SHA}\n`)
  writeFileSync(join(control, 'package.json'), JSON.stringify({ name: 'neutron' }))
  expect(resolveDeployedCommit({}, controlNested)).toBe(OTHER_SHA)

  expect(resolveDeployedCommit({}, nested)).toBeNull()

  const db = new Database(':memory:')
  expect(applyMigrations(db, nested)).toEqual({ applied: [1], skipped: [] })
  expect(rows(db)[0]?.['applied_by_commit']).toBeNull()
  expect(rows(db)[0]?.['content_sha256']).toBe(migrationContentHash(ALPHA))
})

test('a copy of this tree inside ANOTHER checkout of it records NULL, not the host\'s HEAD', () => {
  // The case the package-name test cannot decide on its own, and the reason the
  // walk is anchored at our root instead of at the nearest `.git`. Both trees
  // are `neutron` — a vendored copy, a scratch clone, a monorepo that vendors
  // us — so ownership-by-name says yes to the HOST. Only reaching the copy's
  // own root FIRST distinguishes them, and the copy has no `.git` of its own,
  // so the honest answer is NULL.
  const host = join(tmp, 'host-neutron')
  mkdirSync(join(host, '.git'), { recursive: true })
  writeFileSync(join(host, '.git', 'HEAD'), `${OTHER_SHA}\n`)
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'neutron' }))

  const copyRoot = join(host, 'vendor', 'neutron-copy')
  const copyMigrations = join(copyRoot, 'migrations')
  mkdirSync(copyMigrations, { recursive: true })
  // The copy's OWN root marker. This is the only thing standing between the
  // walk and the host's HEAD.
  writeFileSync(join(copyRoot, 'package.json'), JSON.stringify({ name: 'neutron' }))
  writeFileSync(join(copyMigrations, '0001_alpha.sql'), ALPHA)

  // POSITIVE CONTROL: the identical layout with the copy's root marker removed
  // is the ordinary "a subdirectory belongs to its enclosing checkout" case and
  // must still resolve — otherwise the null below would just be a broken walk.
  const looseMigrations = join(host, 'vendor', 'loose', 'migrations')
  mkdirSync(looseMigrations, { recursive: true })
  expect(resolveDeployedCommit({}, looseMigrations)).toBe(OTHER_SHA)

  expect(resolveDeployedCommit({}, copyMigrations)).toBeNull()

  // And it boots, with the hash that still identifies the file exactly.
  const db = new Database(':memory:')
  expect(applyMigrations(db, copyMigrations)).toEqual({ applied: [1], skipped: [] })
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

/**
 * A ledger carrying a migration the build does not contain: `alpha` was applied
 * from one tree, and the tree now on disk knows only `beta` and `gamma`.
 *
 * This used to be described as "the mismatch": version 1 recorded as alpha while
 * the code has beta. The ORDINAL coincidence is no longer what makes it a problem —
 * `beta` simply applies, because the ledger has never seen it. What is left, and
 * what these tests pin, is that `alpha` itself is a migration this build cannot
 * explain: it ran here, its schema change is present, and nothing on disk describes
 * it. `alpha` was applied by the runner, so it carries a `content_sha256` and is
 * therefore adjudicable.
 */
function unexplainedRow(): { db: Database; b: string } {
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
function printedRepairsEntries(message: string): Array<Record<string, unknown>> {
  const lines = message.split('\n')
  const start = lines.findIndex((l) => /^ {4}\[$/.test(l))
  const end = lines.findIndex((l, i) => i > start && /^ {4}\]$/.test(l))
  if (start === -1 || end === -1) throw new Error('no indented JSON block in the message')
  const json = lines
    .slice(start, end + 1)
    .map((l) => l.slice(4))
    .join('\n')
  return JSON.parse(json) as Array<Record<string, unknown>>
}

/** A ledger with the provenance columns and one hand-written row. */
function ledgerWith(
  db: Database,
  row: { name: string; applied_at: number; content_sha256: string | null },
): void {
  db.exec(`CREATE TABLE _migrations (
     version INTEGER NOT NULL,
     name TEXT NOT NULL PRIMARY KEY,
     applied_at REAL NOT NULL,
     content_sha256 TEXT,
     applied_by_commit TEXT,
     tree_provenance TEXT
   )`)
  db.run(
    'INSERT INTO _migrations (version, name, applied_at, content_sha256) VALUES (1, ?, ?, ?)',
    [row.name, row.applied_at, row.content_sha256],
  )
}

test('the unexplained-row message prints what was recorded, and names the row', () => {
  const { db, b } = unexplainedRow()
  const message = messageOf(() => applyMigrations(db, b))
  const parsed = sections(message)

  // Each value under the heading it belongs to. Dropping a label, or filing the
  // recorded hash anywhere else, fails here.
  expect(parsed['recorded "alpha"']?.['ordinal']).toBe('1')
  expect(parsed['recorded "alpha"']?.['sha256']).toBe(migrationContentHash(ALPHA))
  expect(parsed['recorded "alpha"']?.['applied']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  // And it says what it means, so nobody reads it as an ordinal complaint.
  expect(message).toContain('NO migration file in this build corresponds to')
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
  expect(parsed['recorded "alpha"']?.['build']).toBe(SHA)
  expect(parsed['recorded "alpha"']?.['sha256']).toBe(migrationContentHash(ALPHA))
})

test('a row that predates provenance is TOLERATED, not refused', () => {
  // THE PROPERTY THAT KEEPS THIS CHANGE DEPLOYABLE. Migration files really have
  // been deleted from this repository — 0059 with the content-sync mesh rip, and
  // 0064–0068 in the A2 collapse — so every long-lived instance carries rows naming
  // migrations the build no longer contains. All of them predate provenance and
  // have no hash. Adjudicating them would refuse the oldest databases in the fleet
  // over evidence that is a NULL, with nothing for the operator to verify.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL
   )`)
  db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['deleted_long_ago', 1_700_000_000])

  // Boots, and the migration the build DOES have applies — sharing the ordinal with
  // that row is not a fault, because the ordinal is not an identity.
  expect(applyMigrations(db, tree('now', { '0001_beta.sql': BETA }))).toEqual({
    applied: [1],
    skipped: [],
  })
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).not.toBeNull()
  // The old row was neither rewritten nor removed.
  expect(
    db.query("SELECT version FROM _migrations WHERE name = 'deleted_long_ago'").get(),
  ).toEqual({ version: 1 })
})

test('a row with a hash but no commit is reported as an unidentifiable BUILD, not a blank', () => {
  // A tarball install records the hash and no commit, and the message must say
  // which absence this is rather than printing an empty field.
  const { db, b } = unexplainedRow()
  const message = messageOf(() => applyMigrations(db, b))

  expect(message).toContain(migrationContentHash(ALPHA))
  expect(message).toContain('the build carried no git metadata')
})

test('the entries printed in the message are the entries that resolve the refusal', () => {
  // Recovery must not require reverse-engineering the repair matcher from source. So take
  // the JSON the runner printed, paste it in, and the same tree must boot.
  const { db, b } = unexplainedRow()
  const message = messageOf(() => applyMigrations(db, b))

  const entries = printedRepairsEntries(message)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ version: 1, recorded_name: 'alpha' })
  expect(typeof entries[0]?.['file_name']).toBe('string')
  expect(typeof entries[0]?.['note']).toBe('string')
  expect(typeof entries[0]?.['date']).toBe('string')

  writeFileSync(join(b, 'repairs.json'), JSON.stringify(entries, null, 2))
  // The orphan is acknowledged, and the two migrations this build DOES contain then
  // apply — which is the substantive difference from the ordinal-keyed runner, where
  // acknowledging the row also suppressed the file that shared its number.
  expect(applyMigrations(db, b)).toEqual({ applied: [1, 2], skipped: [] })
  // Fail-closed semantics intact: the row was acknowledged, never renamed.
  expect(db.query("SELECT version FROM _migrations WHERE name = 'alpha'").get()).toEqual({
    version: 1,
  })
})

test('every unexplained row is reported at once, so one pass resolves them all', () => {
  // Otherwise recovery is one refused boot per row, and the operator learns about
  // the second orphan only after fixing the first.
  const db = new Database(':memory:')
  applyMigrations(db, tree('two-was', { '0001_alpha.sql': ALPHA, '0002_gamma.sql': GAMMA }))
  const now = tree('two-now', { '0001_beta.sql': BETA })

  const message = messageOf(() => applyMigrations(db, now))
  expect(message).toContain('records 2 migrations that NO migration file')
  expect(printedRepairsEntries(message)).toEqual([
    expect.objectContaining({ version: 1, recorded_name: 'alpha' }),
    expect.objectContaining({ version: 2, recorded_name: 'gamma' }),
  ])
})

test('the guard STILL REFUSES an unexplained row — no false negative', () => {
  // Identity reconciliation must not have softened the fail-closed half. Every one
  // of these leaves the row unexplained and every one must throw, applying nothing.
  const { db, b } = unexplainedRow()
  expect(() => applyMigrations(db, b)).toThrow(/NO migration file in this build corresponds to/)
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't3'").get()).toBeNull()
  expect(db.query("SELECT 1 FROM _migrations WHERE name = 'beta'").get()).toBeNull()

  // An entry naming a DIFFERENT recorded row must not launder this one.
  writeFileSync(
    join(b, 'repairs.json'),
    JSON.stringify([{ version: 1, recorded_name: 'delta', file_name: '', note: 'other', date: '2026-08-16' }]),
  )
  expect(() => applyMigrations(db, b)).toThrow(/NO migration file in this build/)

  // WHAT DOES *NOT* HOLD, stated positively so nobody re-adds it as an assertion: an
  // entry whose `version` is wrong still acknowledges the row. The match is on the
  // NAME — specifically, on the ledger recording that name at an ordinal other than
  // the one this build assigns it, which is what an orphan like `alpha` is. Requiring
  // the (version, name) PAIR is what made a shipped acknowledgement go inert on the
  // boot after a rekey collapsed the row it named (see CASE 8 in
  // ordinal-identity.test.ts): the collapse keeps the earliest-applied row and drops
  // the others, which sit at a different ordinal by definition. The ordinal is kept on
  // the entry as the context it always was — it records the number the row was written
  // under and is printed in the refusal — and it is not a key. The sibling test below
  // pins the other edge, where the name alone would be too wide.
  writeFileSync(
    join(b, 'repairs.json'),
    JSON.stringify([{ version: 9, recorded_name: 'alpha', file_name: '', note: 'other', date: '2026-08-16' }]),
  )
  // `file_name` is "", so the entry acknowledges the row ALONE and suppresses nothing:
  // both migrations this build contains then apply.
  expect(applyMigrations(db, b)).toEqual({ applied: [1, 2], skipped: [] })

  // And the recorded row is untouched through all of it.
  expect(db.query("SELECT version FROM _migrations WHERE name = 'alpha'").get()).toEqual({
    version: 1,
  })
})

test('a repair does NOT activate on a ledger this build fully accounts for', () => {
  // THE OTHER EDGE, and it is the one the NAME ALONE gets wrong. A repair is about a
  // row this build cannot account for on its own, so an entry whose `recorded_name` is
  // a migration in THIS build, recorded at the ordinal this build gives it, describes
  // nothing here and must stay inert.
  //
  // MEASURED ON THE SHIPPED DATA, not hypothesised. Entry 125's `recorded_name` is
  // `code_trident_runs_fix_round_contract`, which is a real file in this tree at 0124.
  // With a name-only match that entry fired on any instance that had recorded 0124 and
  // not yet run 0125, suppressing 0125 permanently and leaving its name unrecorded in
  // the ledger for good — on a database the incident was never about. The schema still
  // converged, because 0131 rebuilds that table on every path, which is precisely what
  // would have kept the widening invisible.
  //
  // THIS TEST CAN FAIL FOR THE REASON UNDER TEST: widen the match to the name alone and
  // `gamma` is suppressed, so `t3` is never created.
  const db = new Database(':memory:')
  // `beta` is recorded at ordinal 1 — exactly where this build numbers it.
  expect(applyMigrations(db, tree('accounted-was', { '0001_beta.sql': BETA }))).toEqual({
    applied: [1],
    skipped: [],
  })

  const now = tree('accounted-now', {
    '0001_beta.sql': BETA,
    '0002_gamma.sql': GAMMA,
    'repairs.json': JSON.stringify([
      { version: 1, recorded_name: 'beta', file_name: 'gamma', note: 'describes nothing here', date: '2026-08-17' },
    ]),
  })
  expect(applyMigrations(db, now)).toEqual({ applied: [2], skipped: [1] })
  // `gamma` really ran, so the entry suppressed nothing...
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't3'").get()).not.toBeNull()
  // ...and nothing was acknowledged, so the table an acknowledgement writes to was
  // never created at all.
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = '_migration_repairs'").get()).toBeNull()
})

test('an applied_at outside the Date range prints the raw value instead of destroying the message', () => {
  // `Number.isFinite` passes a value like 9e12 seconds, and `new Date(x*1000)`
  // then throws RangeError out of `toISOString()`. That replaces the entire
  // self-diagnosing message — names, hashes, repairs entries — with a bare
  // RangeError, leaving the operator worse off than before this work.
  // NaN is not in this list because it cannot reach the reader: SQLite binds it
  // as NULL and `applied_at` is NOT NULL, so the INSERT is what fails.
  for (const appliedAt of [9e12, 1e300, -1e300, Number.POSITIVE_INFINITY]) {
    const db = new Database(':memory:')
    ledgerWith(db, { name: 'alpha', applied_at: appliedAt, content_sha256: migrationContentHash(ALPHA) })

    const message = messageOf(() => applyMigrations(db, tree(`wide-${appliedAt}`, { '0001_beta.sql': BETA })))
    expect(message).toContain('NO migration file in this build corresponds to')
    // Either total-function answer is fine; what must never happen is a RangeError
    // instead of a message. Infinity is not finite so it reads "(unknown)"; a merely
    // out-of-range finite value prints itself, because a nonsense timestamp is
    // forensic evidence and must not be swallowed.
    expect(sections(message)['recorded "alpha"']?.['applied']).toMatch(
      /out of range — recorded as|\(unknown\)/,
    )
    expect(printedRepairsEntries(message)).toEqual([
      expect.objectContaining({ version: 1, recorded_name: 'alpha' }),
    ])
  }

  // The boundary itself is a real timestamp and is still rendered as one.
  const db = new Database(':memory:')
  ledgerWith(db, { name: 'alpha', applied_at: 8.64e12, content_sha256: migrationContentHash(ALPHA) })
  const parsed = sections(messageOf(() => applyMigrations(db, tree('edge', { '0001_beta.sql': BETA }))))
  expect(parsed['recorded "alpha"']?.['applied']).toBe(new Date(8.64e15).toISOString())
})

test('the refusal changes nothing — not even the shape of the ledger', () => {
  // A guard whose job is to change nothing must not have reshaped the schema of
  // the database it just declared untrustworthy. Reading the ledger has to cost
  // no write, or the refusal path mutates on its way out — and after this change
  // that includes NOT rekeying it, which is the one non-additive step the runner
  // has. The ledger here is version-keyed, so a rekey would be visible.
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL,
     content_sha256 TEXT
   )`)
  db.exec('CREATE TABLE t1 (id INTEGER)')
  db.run(
    'INSERT INTO _migrations (version, name, applied_at, content_sha256) VALUES (1, ?, ?, ?)',
    ['alpha', 1_700_000_000, migrationContentHash(ALPHA)],
  )
  const before = db.query("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()

  expect(() => applyMigrations(db, tree('refused', { '0001_beta.sql': BETA }))).toThrow(
    /NO migration file in this build/,
  )

  expect(db.query("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()).toEqual(before)
  const columns = (db.query("SELECT name FROM pragma_table_info('_migrations')").all() as Array<{ name: string }>)
    .map((c) => c.name)
  expect(columns).not.toContain('applied_by_commit')
  expect(columns).not.toContain('tree_provenance')
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
