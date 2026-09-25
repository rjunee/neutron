/**
 * gateway/wiring/__tests__/project-admission-fixture.ts — a REAL `ProjectAdmission` for fixtures
 * whose subject is not admission itself (attachments, reflection, overlap, ...).
 *
 * `buildLiveAgentTurn` REQUIRES an admission gate (#1237); there is deliberately no
 * permissive stub. This helper backs a real service with a real migrated database
 * (`seedMigratedDb`, so migration 0158 and the `projects` table are the shipped
 * schema), and seeds a live `projects` row for every project id the fixture names.
 *
 * `projects: 'named'` (the default) seeds the row the first time a fixture's turn
 * names a project, which is what "the fixture names a project id" means for a
 * legacy fixture that invents ids inline. Pass an explicit list to make every
 * other id `unknown`. General (null) needs no row. Each call gets its own owner
 * handle, so fences and leases from one fixture can never reach another even
 * though one database file is shared per process.
 *
 * It lives inside the gateway package (not `tests/support/`) because it imports
 * gateway source; only the two package-less helpers there may be imported relatively.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmission } from '../../project-admission.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'

let shared: { db: ProjectDb; dir: string } | null = null
let counter = 0

function sharedDb(): ProjectDb {
  if (shared === null) {
    const dir = mkdtempSync(join(tmpdir(), 'project-admission-fixture-'))
    const path = join(dir, 'project.db')
    seedMigratedDb(path)
    shared = { db: ProjectDb.open(path), dir }
    const held = shared
    process.on('exit', () => {
      try { held.db.close() } catch { /* already closed */ }
      rmSync(held.dir, { recursive: true, force: true })
    })
  }
  return shared.db
}

/** Insert a live `projects` row (idempotent). */
export function seedProject(db: ProjectDb, id: string): void {
  const now = new Date(0).toISOString()
  db.runSync(
    'INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [id, id, now, now],
  )
}

export interface FixtureAdmission extends Pick<ProjectAdmission, 'admit'> {
  readonly service: ProjectAdmission
  readonly db: ProjectDb
}

export function openAdmission(options: { projects?: 'named' | readonly string[] } = {}): FixtureAdmission {
  const db = sharedDb()
  const service = new ProjectAdmission({
    db, ownerHandle: `fixture-owner-${process.pid}-${++counter}`, bootId: `fixture-boot-${counter}`,
  })
  const projects = options.projects ?? 'named'
  if (projects !== 'named') for (const id of projects) seedProject(db, id)
  return {
    service,
    db,
    admit: (projectId, reason, producer, workRef) => {
      if (projects === 'named' && projectId !== null && projectId !== undefined && projectId.trim() !== '') {
        seedProject(db, projectId)
      }
      return service.admit(projectId, reason, producer, workRef)
    },
  }
}
