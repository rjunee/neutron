import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrationContentHash } from './provenance.ts'
import { migrateOwnerMarkerPath } from './runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = '0167_operator_maintenance_holds.sql'
const NAME = 'operator_maintenance_holds'

/** Root's single additive live-upgrade operation. This is NOT the boot runner:
 * it cannot select SQL, run pending migrations, repair a ledger, or change its
 * owner marker. The canonical runner consumes this exact row on the next boot.
 * The caller protects the artifact and operator input before opening the DB. */
export async function installOperatorMaintenanceGuard(db: ProjectDb, deployedMigrations: string): Promise<void> {
  if (process.geteuid?.() !== 0) throw new Error('Operator maintenance requires root')
  if (!db.path || db.path === ':memory:') throw new Error('Maintenance requires a file-backed database')
  const owner = readFileSync(migrateOwnerMarkerPath(realpathSync(db.path)), 'utf8').split('\n')[0]!.trim()
  if (realpathSync(owner) !== realpathSync(deployedMigrations)) throw new Error('Migration owner mismatch')
  const root = dirname(HERE)
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  const commit = git(['rev-parse', 'HEAD'])
  const sql = readFileSync(join(HERE, FILE), 'utf8')
  if (!/^[a-f0-9]{40}$/.test(commit) || git(['show', `HEAD:migrations/${FILE}`]) !== sql.trimEnd()
    || git(['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error('Maintenance artifact is not a clean committed tree')
  const hash = migrationContentHash(sql)
  await db.transaction(async tx => {
    // Obtain SQLite's writer lock before reading eligibility/schema.
    await tx.run('UPDATE _migrations SET name = name WHERE 0', [])
    const columns = tx.all<{ name: string; pk: number }>("SELECT name, pk FROM pragma_table_info('_migrations')")
    if (columns.find(c => c.name === 'name')?.pk !== 1 || columns.some(c => c.name !== 'name' && c.pk !== 0)
      || ['version', 'applied_at', 'content_sha256', 'applied_by_commit', 'tree_provenance'].some(name => !columns.some(c => c.name === name))) {
      throw new Error('Maintenance requires the current name-keyed migration ledger')
    }
    const recorded = tx.get<{ version: number; content_sha256: string; applied_by_commit: string; tree_provenance: string }>(
      'SELECT version, content_sha256, applied_by_commit, tree_provenance FROM _migrations WHERE name = ?', [NAME])
    if (recorded) {
      if (recorded.version !== 167 || recorded.content_sha256 !== hash || !/^[a-f0-9]{40}$/.test(recorded.applied_by_commit)
        || recorded.tree_provenance !== 'tracked-in-index') throw new Error('Maintenance migration identity differs')
    } else {
      // Refuse a partial/manual installation rather than stamping provenance
      // onto an existing unknown schema. This operation only creates new objects.
      const existing = tx.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE name IN
        ('project_operator_maintenance_holds', 'project_operator_maintenance_fence_guard', 'project_operator_maintenance_delete_guard')`)
      if (existing.length) throw new Error('Unrecorded maintenance schema exists')
      await tx.exec(sql)
      await tx.run(`INSERT INTO _migrations (version, name, applied_at, content_sha256, applied_by_commit, tree_provenance)
        VALUES (167, ?, ?, ?, ?, 'tracked-in-index')`, [NAME, Date.now() / 1000, hash, commit])
    }
    // SQLite stores CREATE SQL without IF NOT EXISTS and its terminal semicolon.
    // Compare every object, including trigger bodies, against these exact bytes.
    for (const statement of sql.replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE|$)/).map(s => s.trim()).filter(Boolean)) {
      const normalized = statement.replace(/\s+/g, ' ').replace(/ IF NOT EXISTS /i, ' ').replace(/;$/, '')
      const name = /^CREATE (?:TABLE|TRIGGER) (\w+)/i.exec(normalized)?.[1]
      const actual = name && tx.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', [name])?.sql
      if (!actual || actual.replace(/\s+/g, ' ').replace(/ IF NOT EXISTS /i, ' ').replace(/;$/, '') !== normalized) throw new Error('Maintenance schema differs from artifact')
    }
  })
}
