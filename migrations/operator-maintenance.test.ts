import { expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations, migrateOwnerMarkerPath } from './runner.ts'
import { installOperatorMaintenanceGuard } from './operator-maintenance.ts'

const here = dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(join(here, '0167_operator_maintenance_holds.sql'), 'utf8')

test('fixed additive installer preserves multiline owner and existing rows; idempotence, corruption and rollback are fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-migration-')), path = join(dir, 'db')
  const db = ProjectDb.open(path)
  applyMigrations(db.raw())
  // Build a PRE-upgrade fixture, not a live repair: the ordinary runner created
  // the real marker and all predecessor schema/ledger before these fixture edits.
  await db.exec('DROP TRIGGER project_operator_maintenance_fence_guard; DROP TRIGGER project_operator_maintenance_delete_guard; DROP TABLE project_operator_maintenance_holds')
  await db.run("DELETE FROM _migrations WHERE name = 'operator_maintenance_holds'", [])
  await db.run("INSERT INTO project_admission_fences (scope_key, phase) VALUES (?, 'open')", [JSON.stringify(['fixture-owner', null])])
  const marker = readFileSync(migrateOwnerMarkerPath(path), 'utf8')
  const before = db.all('SELECT * FROM _migrations ORDER BY name')
  const application = db.all('SELECT * FROM project_admission_fences')
  const uid = spyOn(process, 'geteuid').mockReturnValue(0)
  const git = spyOn(childProcess, 'execFileSync').mockImplementation(((_file: string, args?: unknown) => {
    const command = (args as string[])[2]
    if (command === 'rev-parse') return 'a'.repeat(40) + '\n'
    if (command === 'show') return sql
    if (command === 'status') return ''
    throw new Error('Unexpected artifact query')
  }) as typeof childProcess.execFileSync)
  try {
    expect(marker.split('\n').length).toBeGreaterThan(2)
    uid.mockReturnValue(1000)
    await expect(installOperatorMaintenanceGuard(db, here)).rejects.toThrow('requires root')
    uid.mockReturnValue(0)
    await expect(installOperatorMaintenanceGuard(db, dir)).rejects.toThrow('owner mismatch')
    expect(db.all('SELECT * FROM _migrations ORDER BY name')).toEqual(before)
    // A failed ledger write cannot leave the table/guards installed.
    await db.exec(`CREATE TRIGGER test_operator_ledger_failure BEFORE INSERT ON _migrations
      WHEN NEW.name = 'operator_maintenance_holds' BEGIN SELECT RAISE(ABORT, 'fixture ledger failure'); END`)
    await expect(installOperatorMaintenanceGuard(db, here)).rejects.toThrow('fixture ledger failure')
    expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'project_operator_maintenance_holds'")).toBeNull()
    await db.exec('DROP TRIGGER test_operator_ledger_failure')
    const competitor = ProjectDb.open(path)
    competitor.raw().exec('BEGIN IMMEDIATE')
    const installing = installOperatorMaintenanceGuard(db, here)
    try {
      await Bun.sleep(20)
      expect(competitor.get("SELECT 1 FROM sqlite_master WHERE name = 'project_operator_maintenance_holds'")).toBeNull()
    } finally { competitor.raw().exec('COMMIT'); competitor.close() }
    await installing
    expect(readFileSync(migrateOwnerMarkerPath(path), 'utf8')).toBe(marker)
    expect(db.all("SELECT * FROM _migrations WHERE name <> 'operator_maintenance_holds' ORDER BY name")).toEqual(before)
    expect(db.all('SELECT * FROM project_admission_fences')).toEqual(application)
    const installed = db.all('SELECT * FROM _migrations ORDER BY name')
    await installOperatorMaintenanceGuard(db, here)
    expect(db.all('SELECT * FROM _migrations ORDER BY name')).toEqual(installed)
    await db.exec('DROP TRIGGER project_operator_maintenance_fence_guard')
    await expect(installOperatorMaintenanceGuard(db, here)).rejects.toThrow('schema differs')
    expect(db.all('SELECT * FROM _migrations ORDER BY name')).toEqual(installed)
    expect(readFileSync(migrateOwnerMarkerPath(path), 'utf8')).toBe(marker)
  } finally { uid.mockRestore(); git.mockRestore(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
