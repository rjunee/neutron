/**
 * `gateway/storage/owner-metadata.ts` — the owner's chosen transcriber, stored
 * on `instance_metadata` (migration 0111).
 *
 * The rule worth a test is what a NON-value means. `null` has to mean "never
 * chosen" for three distinct on-disk situations — no row, a NULL column, and a
 * column holding something this code does not recognise — because the resolver
 * treats "unchosen" as a question to ask rather than one to answer. If an
 * unreadable value were coerced into `'local'` or `'openai'`, a box would
 * silently start transcribing somewhere the owner never picked, which is the
 * exact behaviour the setting exists to remove.
 *
 * The other half is that this column and `timezone` share one row: writing
 * either must not erase the other.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import {
  readOwnerTimezone,
  readTranscriptionBackend,
  writeOwnerTimezone,
  writeTranscriptionBackend,
} from '../storage/owner-metadata.ts'

const SLUG = 'alice'

let dir: string
let db: ProjectDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-asr-meta-'))
  db = ProjectDb.open(join(dir, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('no row at all reads as unchosen', () => {
  expect(readTranscriptionBackend(db, SLUG)).toBeNull()
})

test('a row whose column was never written reads as unchosen', async () => {
  // The timezone path creates the row without touching this column.
  await writeOwnerTimezone(db, SLUG, 'America/Los_Angeles')
  expect(readTranscriptionBackend(db, SLUG)).toBeNull()
})

test('a written choice round-trips', async () => {
  await writeTranscriptionBackend(db, SLUG, 'openai')
  expect(readTranscriptionBackend(db, SLUG)).toBe('openai')
  await writeTranscriptionBackend(db, SLUG, 'local')
  expect(readTranscriptionBackend(db, SLUG)).toBe('local')
})

test('a value this code does not recognise reads as unchosen, NOT as a backend', async () => {
  // A downgrade, a hand-edited DB, or a future value written by a newer build.
  // Coercing it to either live option would resolve the owner's question by
  // guessing — the one thing this setting is not allowed to do.
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, transcription_backend) VALUES (?, ?)`,
    [SLUG, 'deepgram'],
  )
  expect(readTranscriptionBackend(db, SLUG)).toBeNull()
})

test('the choice is per instance slug — one owner cannot read another', async () => {
  await writeTranscriptionBackend(db, SLUG, 'openai')
  expect(readTranscriptionBackend(db, 'someone-else')).toBeNull()
})

test('the choice and the timezone share a row without clobbering each other', async () => {
  await writeOwnerTimezone(db, SLUG, 'Asia/Singapore')
  await writeTranscriptionBackend(db, SLUG, 'openai')
  expect(readOwnerTimezone(db, SLUG)).toBe('Asia/Singapore')
  expect(readTranscriptionBackend(db, SLUG)).toBe('openai')

  // ...and in the other order, on an existing row.
  await writeOwnerTimezone(db, SLUG, 'Europe/Lisbon')
  expect(readTranscriptionBackend(db, SLUG)).toBe('openai')
  expect(readOwnerTimezone(db, SLUG)).toBe('Europe/Lisbon')
})
