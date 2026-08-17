/**
 * `SqliteProjectSettingsStore.setContent` — the writer for `description` and
 * `persona`.
 *
 * WHY IT WAS ADDED. `projects.persona` is read and fully wired into the live
 * agent turn, but nothing could write it after insert: `update()` accepts only
 * privacy/engagement/name/emoji and `upsertSeed` is INSERT-only. The value a row
 * was born with was the value it kept forever.
 *
 * That made the M2 the legacy harness importer one-shot — a project's `one_liner` and its
 * `PROMPT.md` persona had to be right on the FIRST run or be unfixable without
 * hand-editing SQLite. A dry-run → inspect → real-run flow needs the importer to
 * CONVERGE on its source, so re-runnability is the property under test here, not
 * merely "the UPDATE works".
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SqliteProjectSettingsStore } from '../sqlite-store.ts'
import { buildDefaultSettings } from '../../http/app-projects-surface.ts'
import { openMigratedDbAt } from '../../../tests/support/migrated-db.ts'

const OWNER = 'set-content'

let tmp: string
let db: ProjectDb
let store: SqliteProjectSettingsStore

/** A project exists only after a WRITE (ISSUES #412), so seed explicitly. */
async function seed(id: string): Promise<void> {
  await store.seedDefaults([buildDefaultSettings(id)])
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-setcontent-'))
  db = openMigratedDbAt(join(tmp, 'owner.db'))
  store = new SqliteProjectSettingsStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('persona is written AND survives a fresh store over the same DB', async () => {
  // The whole point: persona must reach the column, because that column is what
  // the live turn reads. An in-memory-only write would look identical here
  // without the reopen.
  await seed('tabs')
  const res = await store.setContent(OWNER, 'tabs', { persona: 'You are the Tabs operator.' })
  expect(res?.persona).toBe('You are the Tabs operator.')

  const reopened = new SqliteProjectSettingsStore(db)
  expect((await reopened.get(OWNER, 'tabs'))?.persona).toBe('You are the Tabs operator.')
})

test('description is written independently of persona', async () => {
  await seed('willow')
  await store.setContent(OWNER, 'willow', { persona: 'P' })
  await store.setContent(OWNER, 'willow', { description: 'D' })
  const got = await store.get(OWNER, 'willow')
  // Setting one must not blank the other — the importer writes them from two
  // different the legacy harness sources (STATUS.md one_liner vs PROMPT.md) and may have only
  // one of them for a given project.
  expect(got?.persona).toBe('P')
  expect(got?.description).toBe('D')
})

test('RE-RUN CONVERGES — a second import with corrected content overwrites', async () => {
  // This is the property the whole method exists for. Create-only semantics
  // would leave run 1's mistake permanent.
  await seed('neutron')
  await store.setContent(OWNER, 'neutron', { persona: 'wrong', description: 'wrong' })
  await store.setContent(OWNER, 'neutron', { persona: 'right', description: 'right' })
  const got = await store.get(OWNER, 'neutron')
  expect(got?.persona).toBe('right')
  expect(got?.description).toBe('right')
})

test('it CREATES NOTHING — an unknown id returns null and no row appears', async () => {
  // Twin of ISSUES #412: a converge-on-existing writer must not become a second
  // back door that manufactures projects.
  expect(await store.setContent(OWNER, 'ghost', { persona: 'x' })).toBeNull()
  expect(await store.list(OWNER)).toHaveLength(0)
})

test('a soft-deleted project is NOT resurrected', async () => {
  await seed('gone')
  // Nothing in this store WRITES `deleted_at` — it only filters on it (another
  // module owns project deletion), so the state is set directly. That is the
  // point: the guard must hold against a row soft-deleted by any path.
  db.raw().run(
    "UPDATE projects SET persona = 'original', deleted_at = '2026-07-28T00:00:00Z' WHERE id = 'gone'",
  )
  expect(await store.setContent(OWNER, 'gone', { persona: 'x' })).toBeNull()
  // ...and it stays out of the rail.
  expect(await store.list(OWNER)).toHaveLength(0)

  // THE ASSERTION THAT ACTUALLY PINS THE GUARD, added after a mutation survived.
  // Returning null is NOT evidence the row was left alone: the UPDATE's
  // `WHERE id = ?` carries no `deleted_at` filter, so without the early return
  // the write LANDS on the soft-deleted row and only the subsequent `readRow`
  // (which does filter) makes the method report null. The caller sees "no such
  // project" while the deleted project's persona has silently changed. Read the
  // raw column, unfiltered, to prove nothing was touched.
  const raw = db
    .raw()
    .query<{ persona: string | null }, []>("SELECT persona FROM projects WHERE id = 'gone'")
    .get()
  expect(raw?.persona).toBe('original')
})

test('an empty string writes NULL, matching upsertSeed\'s convention', async () => {
  // A persona that was never set and one explicitly set to "" must read back
  // identically; otherwise the resolver sees "" as a real (empty) persona.
  await seed('music')
  await store.setContent(OWNER, 'music', { persona: 'temp' })
  await store.setContent(OWNER, 'music', { persona: '' })
  expect((await store.get(OWNER, 'music'))?.persona).toBe('')

  const raw = db
    .raw()
    .query<{ persona: string | null }, []>("SELECT persona FROM projects WHERE id = 'music'")
    .get()
  expect(raw?.persona).toBeNull()
})

test('an empty patch does not stamp updated_at — a no-op must not reorder the rail', async () => {
  // `list()` orders by activity/updated; a no-op write that bumped the timestamp
  // would silently float a project to the top of Ryan's rail during an import
  // that changed nothing about it.
  await seed('magic')
  const before = db
    .raw()
    .query<{ updated_at: string }, []>("SELECT updated_at FROM projects WHERE id = 'magic'")
    .get()
  await store.setContent(OWNER, 'magic', {})
  const after = db
    .raw()
    .query<{ updated_at: string }, []>("SELECT updated_at FROM projects WHERE id = 'magic'")
    .get()
  expect(after?.updated_at).toBe(before!.updated_at)
})

test('setContent leaves name, emoji and privacy untouched', async () => {
  // It must be a CONTENT writer, not a general-purpose row writer — the settings
  // drawer owns those other fields and an importer must not clobber them.
  await seed('cc')
  await store.update(OWNER, 'cc', { name: 'CC', emoji: '🧘', privacy_mode: 'private' })
  await store.setContent(OWNER, 'cc', { persona: 'p', description: 'd' })
  const got = await store.get(OWNER, 'cc')
  expect(got?.name).toBe('CC')
  expect(got?.emoji).toBe('🧘')
  expect(got?.privacy_mode).toBe('private')
})
