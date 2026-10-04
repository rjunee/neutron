import { expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ProjectAdmissionStore } from '@neutronai/gateway/project-admission-store.ts'
import { applyMigrations, migrateOwnerMarkerPath } from './runner.ts'
import { installOperatorMaintenanceGuard, operatorMaintenanceArtifact } from './operator-maintenance.ts'

const here = dirname(fileURLToPath(import.meta.url))
const sql = readFileSync(join(here, '0167_operator_maintenance_holds.sql'), 'utf8')

test('fixed operator bootstrap preserves the entire old ledger, remains old-boot compatible, then normal migration records genuine provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operator-bootstrap-')), path = join(dir, 'db'), oldTree = join(dir, 'old-migrations')
  mkdirSync(oldTree)
  for (const file of readdirSync(here)) if (/^\d{4}_.*\.sql$/.test(file) && file !== '0167_operator_maintenance_holds.sql') copyFileSync(join(here, file), join(oldTree, file))
  copyFileSync(join(here, 'repairs.json'), join(oldTree, 'repairs.json'))
  const db = ProjectDb.open(path), store = new ProjectAdmissionStore(db)
  // The runner/provenance/index implementation and every pre-167 SQL file are
  // unchanged from the old build. This full old file set exercises its real guards.
  applyMigrations(db.raw(), oldTree)
  const scope = { ownerHandle: 'fixture-owner', projectId: null }, other = { ...scope, projectId: 'other' }
  await store.register(scope); await store.register(other)
  const marker = readFileSync(migrateOwnerMarkerPath(path), 'utf8'), before = db.all('SELECT * FROM _migrations ORDER BY name')
  const uid = spyOn(process, 'geteuid').mockReturnValue(0)
  let protectedArtifact = true
  const originalStat = fs.lstatSync
  const protection = spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
    const info = originalStat(path)
    return Object.assign(info, { uid: protectedArtifact ? 0 : 1000, mode: info.mode & ~0o022 })
  }) as typeof fs.lstatSync)
  const git = spyOn(childProcess, 'execFileSync').mockImplementation(((_file: string, args?: unknown) => {
    switch ((args as string[])[2]) {
      case 'rev-parse': return 'a'.repeat(40) + '\n'
      case 'show': return sql
      case 'status': return ''
      case 'ls-files': return 'migrations/0167_operator_maintenance_holds.sql\0open/operator-maintenance.ts\0'
      default: throw new Error('Unexpected artifact query')
    }
  }) as typeof childProcess.execFileSync)
  try {
    const source = operatorMaintenanceArtifact(), operationId = crypto.randomUUID()
    const acquire = (tx: ProjectDb) => store.holdOperatorMaintenanceInTransaction(tx, scope, operationId).then(Boolean)
    expect(marker.split('\n').length).toBeGreaterThan(2)
    uid.mockReturnValue(1000)
    await expect(installOperatorMaintenanceGuard(db, here, source, acquire)).rejects.toThrow('requires root')
    uid.mockReturnValue(0)
    protectedArtifact = false
    expect(() => operatorMaintenanceArtifact()).toThrow('unprotected')
    protectedArtifact = true
    await expect(installOperatorMaintenanceGuard(db, dir, source, acquire)).rejects.toThrow('owner mismatch')
    await expect(installOperatorMaintenanceGuard(db, here, { ...source, contentSha256: 'b'.repeat(64) }, acquire)).rejects.toThrow('changed after audit')
    await expect(installOperatorMaintenanceGuard(db, here, { ...source, commit: 'b'.repeat(40) }, acquire)).rejects.toThrow('changed after audit')
    await expect(installOperatorMaintenanceGuard(db, here, source, async () => false)).rejects.toThrow('already fenced')
    expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'project_operator_maintenance_holds'")).toBeNull()
    expect(store.inspect(scope)?.phase).toBe('open')
    const competitor = ProjectDb.open(path)
    competitor.raw().exec('BEGIN IMMEDIATE')
    const installing = installOperatorMaintenanceGuard(db, here, source, acquire)
    try { await Bun.sleep(20); expect(competitor.get("SELECT 1 FROM sqlite_master WHERE name = 'project_operator_maintenance_holds'")).toBeNull() }
    finally { competitor.raw().exec('COMMIT'); competitor.close() }
    await installing
    expect(store.operatorMaintenanceFor(scope, operationId)).not.toBeNull()
    expect(store.inspect(other)?.phase).toBe('open')
    expect(db.all('SELECT * FROM _migrations ORDER BY name')).toEqual(before)
    expect(readFileSync(migrateOwnerMarkerPath(path), 'utf8')).toBe(marker)
    expect(applyMigrations(db.raw(), oldTree).applied).toEqual([])
    expect(db.all('SELECT * FROM _migrations ORDER BY name')).toEqual(before)
    expect(store.operatorMaintenanceFor(scope, operationId)).not.toBeNull()
    await installOperatorMaintenanceGuard(db, here, source, tx => store.holdOperatorMaintenanceInTransaction(tx, other, crypto.randomUUID()).then(Boolean))
    expect(db.all('SELECT * FROM _migrations ORDER BY name')).toEqual(before)
    expect(applyMigrations(db.raw()).applied).toEqual([167])
    // The old unknown-ledger refusal remains intact after a genuine NEW-build
    // migration. Compatibility comes from not writing that row during bootstrap.
    expect(() => applyMigrations(db.raw(), oldTree)).toThrow()
    expect(db.all("SELECT * FROM _migrations WHERE name <> 'operator_maintenance_holds' ORDER BY name")).toEqual(before)
    expect(store.operatorMaintenanceFor(scope, operationId)).not.toBeNull()
    const installed = db.all('SELECT * FROM _migrations ORDER BY name')
    await db.exec('DROP TRIGGER project_operator_maintenance_fence_guard')
    await expect(installOperatorMaintenanceGuard(db, here, source, acquire)).rejects.toThrow('schema differs')
    expect(db.all('SELECT * FROM _migrations ORDER BY name')).toEqual(installed)
  } finally { uid.mockRestore(); git.mockRestore(); protection.mockRestore(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
