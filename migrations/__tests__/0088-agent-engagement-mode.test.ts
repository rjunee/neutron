/**
 * migration 0088 acceptance suite — Connect per-project agent engagement mode.
 *
 * Pins the schema-level contract for docs/specs/connect-agent-engagement-mode-
 * 2026-06-26.md:
 *
 *   1. `projects.agent_engagement_mode` exists, is NOT NULL, and DEFAULTs to
 *      'all_messages' — so an INSERT that omits it backfills the default
 *      (a fresh group project behaves like a single-person chat).
 *   2. The CHECK constraint accepts the two spec-locked modes
 *      ('tag_gated' | 'all_messages') and rejects anything else.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'

let tmp: string
let db: Database

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-mig-0088-'))
  db = new Database(join(tmp, 'project.db'), { create: true })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function seedProject(id: string, engagement?: string): void {
  const cols = ['id', 'name', 'privacy_mode', 'billing_mode', 'created_at', 'updated_at']
  const vals: Array<string> = [id, id, 'private', 'personal', 't', 't']
  if (engagement !== undefined) {
    cols.push('agent_engagement_mode')
    vals.push(engagement)
  }
  const placeholders = cols.map(() => '?').join(', ')
  db.run(`INSERT INTO projects (${cols.join(', ')}) VALUES (${placeholders})`, vals)
}

test('agent_engagement_mode column exists, NOT NULL, defaults to all_messages', () => {
  applyMigrations(db)

  const col = db
    .query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
      `SELECT name, type, "notnull", dflt_value FROM pragma_table_info('projects')
        WHERE name = 'agent_engagement_mode'`,
    )
    .get()
  expect(col).not.toBeNull()
  expect(col?.type).toBe('TEXT')
  expect(col?.notnull).toBe(1)
  // SQLite renders the textual default with surrounding quotes.
  expect(col?.dflt_value).toBe("'all_messages'")

  // An INSERT that omits the column backfills the default.
  seedProject('p-default')
  const row = db
    .query<{ agent_engagement_mode: string }, [string]>(
      `SELECT agent_engagement_mode FROM projects WHERE id = ?`,
    )
    .get('p-default')
  expect(row?.agent_engagement_mode).toBe('all_messages')
})

test('CHECK accepts tag_gated + all_messages, rejects anything else', () => {
  applyMigrations(db)

  seedProject('p-tag', 'tag_gated')
  seedProject('p-all', 'all_messages')
  const modes = db
    .query<{ agent_engagement_mode: string }, []>(
      `SELECT agent_engagement_mode FROM projects ORDER BY id`,
    )
    .all()
    .map((r) => r.agent_engagement_mode)
  expect(modes).toEqual(['all_messages', 'tag_gated'])

  expect(() => seedProject('p-bad', 'sometimes')).toThrow(/CHECK constraint/i)
})
