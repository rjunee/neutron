import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export interface BranchReservation {
  repo_path: string
  branch: string
  token: string
  run_id: string
  purpose: 'admission' | 'salvage'
}

export function canonicalRepositoryPath(path: string): string {
  let directory: string
  try { directory = realpathSync(path) }
  catch (error) {
    // A missing checkout cannot be mutated; retain its absolute identity for
    // admission before materialisation. Permission and other errors are unknown.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
  // Linked worktrees have distinct checkout paths but mutate the same refs.
  // Do not let inherited repository selectors change the identity being read.
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' }
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES']) delete env[key]
  try {
    const common = execFileSync('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { env, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return realpathSync(common)
  } catch (error) {
    const detail = error as { status?: number; stderr?: Buffer }
    // Store callers may reserve a not-yet-initialised directory. It cannot
    // mutate shared Git refs until it is a repository; other failures refuse.
    if (detail.status === 128 && detail.stderr?.toString().includes('not a git repository')) return directory
    throw error
  }
}

export async function reserveBranch(
  db: ProjectDb, input: Omit<BranchReservation, 'token'>,
  eligible: () => boolean = () => true,
): Promise<BranchReservation | null> {
  const reservation = { ...input, repo_path: canonicalRepositoryPath(input.repo_path), token: crypto.randomUUID() }
  return db.transaction(tx => {
    if (!eligible()) return null
    const inserted = tx.runSync(`INSERT OR IGNORE INTO code_trident_branch_reservations
      (repo_path, branch, token, run_id, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [reservation.repo_path, reservation.branch, reservation.token, reservation.run_id, reservation.purpose, new Date().toISOString()])
    return inserted.changes === 1 ? reservation : null
  })
}

export function ownsBranchReservation(db: ProjectDb, reservation: BranchReservation): boolean {
  return db.get(`SELECT token FROM code_trident_branch_reservations
    WHERE repo_path = ? AND branch = ? AND token = ? AND run_id = ? AND purpose = ?`,
  [reservation.repo_path, reservation.branch, reservation.token, reservation.run_id, reservation.purpose]) != null
}

export async function releaseBranch(db: ProjectDb, reservation: BranchReservation): Promise<void> {
  await db.run(`DELETE FROM code_trident_branch_reservations
    WHERE repo_path = ? AND branch = ? AND token = ? AND run_id = ? AND purpose = ?`,
  [reservation.repo_path, reservation.branch, reservation.token, reservation.run_id, reservation.purpose])
}
