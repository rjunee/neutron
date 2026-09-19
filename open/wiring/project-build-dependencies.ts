import { appendFile, lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'

export const PROJECT_DEPENDENCIES_TIMEOUT_MS = 10 * 60_000

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Provision only declared Bun workspaces; other repositories keep their own setup.
 * Always reinstall on recovery: an existing worktree is not an install receipt. */
export async function prepareProjectDependencies(worktree: string, state: string,
  run: typeof spawnCapture = spawnCapture): Promise<void> {
  const manifestPath = join(worktree, 'package.json')
  if (!await exists(manifestPath)) return
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages
  if (!Array.isArray(workspaces) || workspaces.length === 0) return
  const manager = typeof manifest.packageManager === 'string' ? manifest.packageManager : ''
  if (manager && !manager.startsWith('bun@')) return
  if (!manager.startsWith('bun@') && !await exists(join(worktree, 'bun.lock'))
    && !await exists(join(worktree, 'bun.lockb'))) return

  const log = join(state, 'dependencies.log')
  await appendFile(log, '\nPreparing worktree-local Bun dependencies\n', { mode: 0o600 })
  const refuse = async (detail: string): Promise<never> => {
    await appendFile(log, `REFUSED: ${detail}\n`)
    throw new Error(`Build dependency preparation failed: ${detail}; see ${log}`)
  }
  const modules = join(worktree, 'node_modules')
  if (await exists(modules) && !(await lstat(modules)).isDirectory()) {
    await refuse('node_modules must be a worktree-local directory')
  }
  const execute = async (argv: string[], label: string) => {
    await appendFile(log, `${label}\n`)
    // exec makes the bounded host child the installer itself. Its transcript goes
    // straight to disk, and installation never borrows the publisher's credentials.
    const result = await run(['bash', '-c', `exec ${argv.map(quote).join(' ')} >>${quote(log)} 2>&1`],
      worktree, undefined, PROJECT_DEPENDENCIES_TIMEOUT_MS)
    await appendFile(log, `${label}: exit=${result.exit_code}; timed_out=${result.timed_out === true}\n`)
    if (!result.ok || result.exit_code !== 0 || result.timed_out) await refuse(`${label} did not complete successfully`)
  }
  // This host preparation phase must not execute package lifecycle scripts.
  // A project requiring generated artifacts still has to satisfy its full suite.
  await execute(['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], 'bun install')
  // A zero exit is insufficient: a no-op executable must not admit workers into
  // the same empty tree that caused the publication failure.
  if (!await exists(modules) || !(await lstat(modules)).isDirectory() || (await readdir(modules)).length === 0) {
    await refuse('bun install produced no worktree-local dependencies')
  }
  const verifier = join(worktree, 'scripts', 'ci', 'verify-workspace-deps.ts')
  // A repository carrying this verifier opts into the workspace readiness contract.
  // Run the HOST's copy against the worktree; branch-owned scripts must not gain
  // a new execution path in pre-worker preparation.
  if (await exists(verifier)) await execute(['bun', fileURLToPath(new URL('../../scripts/ci/verify-workspace-deps.ts', import.meta.url)), worktree],
    'workspace dependency verification')
  await appendFile(log, 'Worktree-local dependency preparation completed\n')
}
