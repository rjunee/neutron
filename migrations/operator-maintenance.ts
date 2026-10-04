import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrationContentHash } from './provenance.ts'
import { migrateOwnerMarkerPath } from './runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = '0167_operator_maintenance_holds.sql'
export interface OperatorMaintenanceArtifact { commit: string; contentSha256: string }

function artifact(): OperatorMaintenanceArtifact & { sql: string } {
  if (process.geteuid?.() !== 0) throw new Error('Operator maintenance requires root')
  const root = dirname(HERE)
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  const commit = git(['rev-parse', 'HEAD'])
  const sql = readFileSync(join(HERE, FILE), 'utf8')
  if (!/^[a-f0-9]{40}$/.test(commit) || git(['show', `HEAD:migrations/${FILE}`]) !== sql.trimEnd()
    || git(['status', '--porcelain', '--untracked-files=no']) !== '') throw new Error('Maintenance artifact is not a clean committed tree')
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean), protectedPaths = new Set<string>()
  if (!files.includes(`migrations/${FILE}`) || !files.includes('open/operator-maintenance.ts')) throw new Error('Maintenance artifact is incomplete')
  for (const file of files) {
    let cursor = join(root, file)
    while (!protectedPaths.has(cursor)) {
      const info = lstatSync(cursor)
      if (info.uid !== 0 || info.isSymbolicLink() || (info.mode & 0o022) !== 0
        || (cursor === join(root, file) ? !info.isFile() : !info.isDirectory())) throw new Error('Maintenance artifact is unprotected')
      protectedPaths.add(cursor)
      if (cursor === '/') break
      cursor = dirname(cursor)
    }
  }
  return { commit, sql, contentSha256: migrationContentHash(sql) }
}

/** Actual source identity recorded in the protected operator audit BEFORE SQL.
 * It is not a canonical migration receipt; the ordinary new runner owns that. */
export function operatorMaintenanceArtifact(): OperatorMaintenanceArtifact {
  const { commit, contentSha256 } = artifact()
  return { commit, contentSha256 }
}

function schemaObjects(sql: string): Array<{ normalized: string; name: string }> {
  return sql.replace(/--[^\n]*/g, '').split(/;\s*(?=CREATE|$)/).map(s => s.trim()).filter(Boolean).map(statement => {
    const normalized = statement.replace(/\s+/g, ' ').replace(/ IF NOT EXISTS /i, ' ').replace(/;$/, '')
    return { normalized, name: /^CREATE (?:TABLE|TRIGGER) (\w+)/i.exec(normalized)![1]! }
  })
}

export function assertOperatorMaintenanceSchema(db: ProjectDb, auditedArtifact: OperatorMaintenanceArtifact): void {
  const source = artifact()
  if (source.commit !== auditedArtifact.commit || source.contentSha256 !== auditedArtifact.contentSha256) throw new Error('Maintenance artifact changed after audit')
  for (const { name, normalized } of schemaObjects(source.sql)) {
    const actual = db.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', [name])?.sql
    if (!actual || actual.replace(/\s+/g, ' ').replace(/ IF NOT EXISTS /i, ' ').replace(/;$/, '') !== normalized) throw new Error('Maintenance schema differs from artifact')
  }
}

/** Fixed additive compatibility bootstrap, not the normal migration runner.
 * Preserve EVERY canonical ledger row so the old running build can still boot.
 * The new runner later really executes this idempotent SQL and records its own
 * provenance. Owner directory is derived from the observed gateway, not a free
 * request field; the caller rechecks that process inside this transaction.
 * Guard schema and exact hold commit together, or neither changes. */
export async function installOperatorMaintenanceGuard(db: ProjectDb, observedOwnerDirectory: string,
  auditedArtifact: OperatorMaintenanceArtifact, acquireHold: (tx: ProjectDb) => Promise<boolean>): Promise<void> {
  const source = artifact()
  if (source.commit !== auditedArtifact.commit || source.contentSha256 !== auditedArtifact.contentSha256) throw new Error('Maintenance artifact changed after audit')
  if (!db.path || db.path === ':memory:') throw new Error('Maintenance requires a file-backed database')
  const owner = readFileSync(migrateOwnerMarkerPath(realpathSync(db.path)), 'utf8').split('\n')[0]!.trim()
  if (realpathSync(owner) !== realpathSync(observedOwnerDirectory)) throw new Error('Migration owner mismatch')
  await db.transaction(async tx => {
    // Writer lock without matching or modifying any canonical ledger row.
    await tx.run('UPDATE _migrations SET name = name WHERE 0', [])
    const columns = tx.all<{ name: string; pk: number }>("SELECT name, pk FROM pragma_table_info('_migrations')")
    if (columns.find(c => c.name === 'name')?.pk !== 1 || columns.some(c => c.name !== 'name' && c.pk !== 0)
      || ['version', 'applied_at', 'content_sha256', 'applied_by_commit', 'tree_provenance'].some(name => !columns.some(c => c.name === name))) {
      throw new Error('Maintenance requires the current name-keyed migration ledger')
    }
    const objects = schemaObjects(source.sql)
    const existing = objects.map(({ name }) => tx.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', [name])?.sql)
    if (existing.some(Boolean) && !existing.every(Boolean)) throw new Error('Maintenance schema differs from artifact')
    if (!existing.some(Boolean)) await tx.exec(source.sql)
    assertOperatorMaintenanceSchema(tx, auditedArtifact)
    if (!await acquireHold(tx)) throw new Error('Scope is already fenced')
  })
}
