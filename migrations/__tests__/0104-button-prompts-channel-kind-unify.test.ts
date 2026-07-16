/**
 * N6 — migration 0104 acceptance suite (button_prompts channel-kind unify).
 *
 * Pins the data contract for the ChannelKind persisted-value unification:
 *   1. A pre-migration row carrying the legacy hyphen 'app-socket' in
 *      `resolution_channel_kind` is normalized to the canonical 'app_socket'.
 *   2. The migration is idempotent — running the exact shipped SQL a second
 *      time is a no-op (matches zero rows, mutates nothing).
 *   3. Already-canonical + unrelated tokens ('app_socket', 'telegram', the
 *      retained synthetic 'webhook', NULL) are left untouched.
 *
 * The .sql is read from disk and executed verbatim so the test tracks the
 * shipped statement, not a hand-copied paraphrase.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../runner.ts'

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL('../0104_button_prompts_channel_kind_unify.sql', import.meta.url)),
  'utf8',
)

let tmp: string
let db: Database

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0104-'))
  db = new Database(join(tmp, 'project.db'), { create: true })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function insertRow(prompt_id: string, channel_kind: string | null): void {
  db.run(
    `INSERT INTO button_prompts
       (prompt_id, topic_id, body, options_json, allow_freeform,
        expires_at, created_at, resolved_at, resolution_value,
        resolution_channel_kind)
     VALUES (?, 't', 'b', '[]', 0, ?, ?, ?, 'a', ?)`,
    [prompt_id, 9_999_999, 1_000, 1_000, channel_kind],
  )
}

function channelKindOf(prompt_id: string): string | null {
  const row = db
    .query<{ resolution_channel_kind: string | null }, [string]>(
      `SELECT resolution_channel_kind FROM button_prompts WHERE prompt_id = ?`,
    )
    .get(prompt_id)
  return row?.resolution_channel_kind ?? null
}

test('normalizes legacy hyphen rows + leaves canonical/unrelated rows untouched', () => {
  applyMigrations(db) // 0104 runs here against an empty table (no-op)
  insertRow('legacy', 'app-socket')
  insertRow('canonical', 'app_socket')
  insertRow('telegram', 'telegram')
  insertRow('webhook', 'webhook') // retained synthetic marker
  insertRow('null-kind', null)

  db.run(MIGRATION_SQL)

  expect(channelKindOf('legacy')).toBe('app_socket')
  expect(channelKindOf('canonical')).toBe('app_socket')
  expect(channelKindOf('telegram')).toBe('telegram')
  expect(channelKindOf('webhook')).toBe('webhook')
  expect(channelKindOf('null-kind')).toBeNull()
})

test('idempotent — re-running the shipped SQL is a no-op', () => {
  applyMigrations(db)
  insertRow('legacy', 'app-socket')

  db.run(MIGRATION_SQL)
  expect(channelKindOf('legacy')).toBe('app_socket')

  // Second run: nothing left to normalize, value stays canonical, and the
  // statement reports zero changes.
  const result = db.run(MIGRATION_SQL)
  expect(result.changes).toBe(0)
  expect(channelKindOf('legacy')).toBe('app_socket')
})
