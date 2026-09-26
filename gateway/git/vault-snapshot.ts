import { Database } from 'bun:sqlite'
import { lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectRepos } from '@neutronai/contracts/project-repos.ts'
import type { GitExecFn } from './git-exec.ts'

const metadata = new Set(['.git', '.project-backup', '.docs-versions', 'node_modules'])
const sqliteHeader = Buffer.from('SQLite format 3\0')

export async function enumerateVaultProjects(ownerHome: string): Promise<string[]> {
  try {
    return (await readdir(join(ownerHome, 'Projects'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Discover repository boundaries without traversing symlinks or their contents. */
export async function vaultExcludedRepos(root: string, projectId: string): Promise<string[]> {
  const excluded = new Set(readProjectRepos(root, projectId).repos.map(repo => repo.path))
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (!entry.isDirectory() || metadata.has(entry.name)) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (excluded.has(path)) continue
      if (existsSync(join(root, path, '.git'))) { excluded.add(path); continue }
      await walk(path)
    }
  }
  await walk('')
  return [...excluded].sort()
}

/** Literal anchored gitignore patterns; repository names may contain glob characters. */
export function ignoreVaultRepo(path: string): string {
  if (/[\r\n]/.test(path)) throw new Error('Repository path cannot be represented in vault exclusions')
  return '/' + path.replace(/[\\*?\[\]!# ]/g, '\\$&') + '/'
}

/** Stage a consistent database image, never the database's live bytes or WAL. */
async function stageDatabase(root: string, path: string, args: string[], git: GitExecFn): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'vault-sqlite-'))
  try {
    const snapshot = join(scratch, 'snapshot.db')
    const db = new Database(join(root, path), { readonly: true })
    try {
      db.exec('PRAGMA busy_timeout=5000')
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
    } finally { db.close() }
    const { stdout } = await git([...args, 'hash-object', '-w', '--', snapshot], { cwd: root })
    await git([...args, 'update-index', '--add', '--cacheinfo', '100644', stdout.trim(), path], { cwd: root })
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** Rebuild the index from eligible paths: previously tracked exclusions cannot bypass policy. */
export async function stageVaultSnapshot(root: string, args: string[], git: GitExecFn): Promise<void> {
  await git([...args, 'read-tree', '--empty'], { cwd: root })
  const { stdout } = await git([...args, 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: root })
  for (const path of stdout.split('\0').filter(Boolean)) {
    // A nested .gitignore cannot opt a live journal back into a snapshot.
    if (/(?:-wal|-shm|-journal)$/.test(path)) continue
    const absolute = join(root, path)
    const stat = await lstat(absolute)
    // ls-files reports embedded repositories as directories even when their marker
    // appeared after discovery. Refuse the snapshot instead of inventing a gitlink.
    if (stat.isDirectory()) throw new Error(`Repository boundary changed during backup: ${path}`)
    let sqlite = false
    if (stat.isFile()) {
      const file = await open(absolute, 'r')
      try {
        const header = Buffer.alloc(16)
        const { bytesRead } = await file.read(header, 0, 16, 0)
        sqlite = bytesRead === 16 && header.equals(sqliteHeader)
      } finally { await file.close() }
    }
    if (sqlite) await stageDatabase(root, path, args, git)
    else await git([...args, '--literal-pathspecs', 'add', '--', path], { cwd: root })
  }
  const staged = await git([...args, 'ls-files', '--stage'], { cwd: root })
  if (staged.stdout.split('\n').some(line => line.startsWith('160000 '))) {
    throw new Error('Vault snapshot contains an embedded repository')
  }
}
