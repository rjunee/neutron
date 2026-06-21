/**
 * WAVE 2 Track A (P0-4) — coverage for the per-project persona resolver that
 * reads `projects.persona` for the live-agent turn (`open/project-persona-
 * resolver.ts`). REAL migrated project.db so the read exercises the same SQL +
 * soft-delete predicate the gateway runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { buildProjectPersonaResolver } from '../project-persona-resolver.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ppr-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function insertProject(over: {
  id: string
  persona?: string | null
  deleted_at?: string | null
}): void {
  db.prepare<unknown, [string, string, string | null, string | null]>(
    `INSERT INTO projects (id, name, persona, privacy_mode, billing_mode, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'private', 'personal', '2026-06-21T00:00:00Z', '2026-06-21T00:00:00Z', ?)`,
  ).run(over.id, over.id, over.persona ?? null, over.deleted_at ?? null)
}

describe('buildProjectPersonaResolver', () => {
  test("returns the trimmed persona for a live project", () => {
    insertProject({ id: 'gondor', persona: '  Aragorn — steward of the white city  ' })
    const resolve = buildProjectPersonaResolver(db)
    expect(resolve('gondor')).toBe('Aragorn — steward of the white city')
  })

  test('returns null for an unknown project id', () => {
    const resolve = buildProjectPersonaResolver(db)
    expect(resolve('nonexistent')).toBeNull()
  })

  test('returns null when persona is NULL', () => {
    insertProject({ id: 'rohan', persona: null })
    const resolve = buildProjectPersonaResolver(db)
    expect(resolve('rohan')).toBeNull()
  })

  test('returns null when persona is empty / whitespace-only', () => {
    insertProject({ id: 'mordor', persona: '   ' })
    const resolve = buildProjectPersonaResolver(db)
    expect(resolve('mordor')).toBeNull()
  })

  test('ignores a soft-deleted project (deleted_at set)', () => {
    insertProject({ id: 'isengard', persona: 'Saruman', deleted_at: '2026-06-21T01:00:00Z' })
    const resolve = buildProjectPersonaResolver(db)
    expect(resolve('isengard')).toBeNull()
  })

  test('a closed db (read throws) degrades to null, never throws', () => {
    insertProject({ id: 'rivendell', persona: 'Elrond' })
    const resolve = buildProjectPersonaResolver(db)
    db.close()
    expect(resolve('rivendell')).toBeNull()
    // Re-open so the afterEach close() is a no-op-safe double close.
    db = ProjectDb.open(join(tmp, 'owner.db'))
  })
})
