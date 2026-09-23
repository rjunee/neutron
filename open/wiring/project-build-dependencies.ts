import { appendFile, lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'

export const PROJECT_DEPENDENCIES_TIMEOUT_MS = 10 * 60_000

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const hostDirectory = fileURLToPath(new URL('../../', import.meta.url))
const hostVerifier = join(hostDirectory, 'scripts/ci/verify-workspace-deps.ts')
const RECEIPT_VERSION = 2

// Run resolution in a new host-controlled process: Bun caches resolutions in a
// long-lived host, which could otherwise conceal removal of a local package.
// Resolving does not load project code. Consistently unresolved optional/type
// packages remain unknown; a package resolved outside the tree is never local
// installation evidence, even when the general readiness verifier tolerates it.
const RESOLUTION_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.realpathSync(process.argv[1]);
const observations = [];
for (const manifestPath of JSON.parse(process.argv[2])) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).sort();
  for (const dependency of dependencies) {
    let target;
    try { target = Bun.resolveSync(dependency, path.dirname(path.join(root, manifestPath))); }
    catch { observations.push([manifestPath, dependency, null]); continue; }
    const actual = fs.realpathSync(target);
    if (!actual.startsWith(root + path.sep)) process.exit(3);
    const stat = fs.statSync(actual);
    observations.push([manifestPath, dependency, path.relative(root, actual), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  }
}
console.log(crypto.createHash('sha256').update(JSON.stringify(observations)).digest('hex'));
`

async function workspaceManifests(worktree: string, workspaces: unknown[]): Promise<string[] | null> {
  const files = new Set(['package.json'])
  for (const workspace of workspaces) {
    if (typeof workspace !== 'string' || workspace.startsWith('!') || workspace.split('/').includes('..')) return null
    for await (const path of new Bun.Glob(`${workspace}/package.json`).scan({ cwd: worktree, onlyFiles: true })) files.add(path)
  }
  return [...files].sort()
}

async function resolutionKey(worktree: string, workspaces: unknown[], bun: string): Promise<string | null> {
  const manifests = await workspaceManifests(worktree, workspaces)
  if (!manifests) return null
  const result = await spawnCapture([bun, '--config=/dev/null', '--no-env-file', '--eval', RESOLUTION_PROBE,
    worktree, JSON.stringify(manifests)], hostDirectory, undefined, 30_000)
  const key = result.stdout.trim()
  return result.ok && !result.timed_out && /^[a-f0-9]{64}$/.test(key) ? key : null
}

/** The receipt is a host observation, never a tracked project file. Hash all
 * declared workspace manifests, including uncommitted dependency edits. */
async function preparationKey(worktree: string, workspaces: unknown[], executable: string): Promise<string | null> {
  const head = await spawnCapture(['git', 'rev-parse', '--verify', 'HEAD'], worktree)
  if (!head.ok || !/^[a-f0-9]{40,64}$/.test(head.stdout.trim())) return null
  const manifests = await workspaceManifests(worktree, workspaces)
  if (!manifests) return null
  const files = new Set([...manifests, 'bun.lock', 'bun.lockb', 'bunfig.toml', '.npmrc',
    'scripts/ci/verify-workspace-deps.ts'])
  const hash = createHash('sha256')
  const tool = await lstat(executable)
  hash.update(JSON.stringify([RECEIPT_VERSION, await realpath(worktree), head.stdout.trim(),
    process.platform, process.arch, process.version, Bun.version, executable,
    [tool.dev, tool.ino, tool.size, tool.mtimeMs, tool.ctimeMs], await readFile(hostVerifier, 'utf8'),
    RESOLUTION_PROBE, '--frozen-lockfile', '--ignore-scripts']))
  for (const path of [...files].sort()) {
    const full = resolve(worktree, path)
    if (!full.startsWith(`${resolve(worktree)}${sep}`)) return null
    hash.update(JSON.stringify([path, await exists(full)]))
    if (!await exists(full)) continue
    if (!(await lstat(full)).isFile() || !(await realpath(full)).startsWith(`${await realpath(worktree)}${sep}`)) return null
    hash.update(await readFile(full))
  }
  return hash.digest('hex')
}

/** Observe every installed dependency file, not just package entrypoints. ctime
 * and inode prevent restored mtimes from hiding a write or replacement. Internal
 * directory links are traversed once; external targets cannot authorize reuse. */
async function installedTreeKey(worktree: string): Promise<string | null> {
  const root = await realpath(worktree)
  const modules = join(root, 'node_modules')
  if (!await exists(modules)) return 'absent'
  if (!(await lstat(modules)).isDirectory()) return null
  const hash = createHash('sha256')
  const pending = [modules]
  const visited = new Set<string>()
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const path = pending[cursor]!
    const actual = await realpath(path)
    if (!actual.startsWith(`${root}${sep}`)) return null
    const link = await lstat(path, { bigint: true })
    hash.update(JSON.stringify([path.slice(root.length), actual.slice(root.length),
      ...[link.dev, link.ino, link.mode, link.size, link.mtimeNs, link.ctimeNs].map(String)]))
    if (visited.has(actual)) continue
    visited.add(actual)
    const stat = await lstat(actual, { bigint: true })
    hash.update(JSON.stringify([actual.slice(root.length),
      ...[stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]))
    if (stat.isDirectory()) {
      for (const entry of (await readdir(actual)).sort()) pending.push(join(actual, entry))
    } else if (!stat.isFile()) return null
  }
  return hash.digest('hex')
}

/** Fresh host measurement for suite reuse. Unknown or dirty inputs never reuse
 * proof. This shares preparation's manifest/toolchain and local-resolution keys. */
export async function projectSuiteIdentity(worktree: string, expectedHead?: string): Promise<string | null> {
  try {
    const revision = await spawnCapture(['git', 'rev-parse', '--verify', 'HEAD'], worktree)
    if (!revision.ok || (expectedHead !== undefined && revision.stdout.trim() !== expectedHead)) return null
    const clean = await spawnCapture(['git', 'status', '--porcelain', '--untracked-files=all'], worktree)
    if (!clean.ok || clean.stdout.trim()) return null
    const executable = Bun.which('bun', { PATH: process.env.PATH ?? '' })
    if (!executable) return null
    const bun = await realpath(executable)
    const manifestPath = join(worktree, 'package.json')
    const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {}
    const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? []
    if (!Array.isArray(workspaces)) return null
    const key = await preparationKey(worktree, workspaces, bun)
    const resolution = await resolutionKey(worktree, workspaces, bun)
    const installed = await installedTreeKey(worktree)
    // Repositories without a manifest have no package resolution contract.
    if (!key || !installed || (await exists(manifestPath) && !resolution)) return null
    const modules = join(worktree, 'node_modules')
    let installation = null
    if (await exists(modules)) {
      const stat = await lstat(modules)
      if (!stat.isDirectory()) return null
      installation = [stat.dev, stat.ino]
    } else if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length > 0) return null
    const workspace = await lstat(await realpath(worktree))
    return createHash('sha256').update(JSON.stringify([key, resolution, installed, installation,
      workspace.dev, workspace.ino])).digest('hex')
  } catch { return null }
}

/** Provision declared Bun workspaces. Recovery can reuse a measured installation
 * only after checking the same inputs and running the host readiness verifier. */
export async function prepareProjectDependencies(worktree: string, state: string,
  run: typeof spawnCapture = spawnCapture): Promise<void> {
  const receiptPath = join(state, 'dependencies-receipt.json')
  const invalidate = async () => { try { await unlink(receiptPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } }
  let receipt: { version?: number; key?: string; resolution?: string; modulesDevice?: number; modulesInode?: number } | null = null
  if (await exists(receiptPath) && (await lstat(receiptPath)).isFile()) {
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) } catch { /* Corrupt means reinstall. */ }
  }
  // Retire the old success before any fallible preparation, including manifest
  // parsing. A crash or timeout cannot leave that success reusable next time.
  await invalidate()
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
    await invalidate()
    await appendFile(log, `REFUSED: ${detail}\n`)
    throw new Error(`Build dependency preparation failed: ${detail}; see ${log}`)
  }
  const modules = join(worktree, 'node_modules')
  if (await exists(modules) && !(await lstat(modules)).isDirectory()) {
    await refuse('node_modules must be a worktree-local directory')
  }
  const store = join(modules, '.bun')
  if (await exists(store) && !(await lstat(store)).isDirectory()) {
    await refuse('Bun store must be a worktree-local directory')
  }
  const executable = Bun.which('bun', { PATH: process.env.PATH ?? '' })
  if (!executable) return refuse('Bun executable is unavailable')
  const bun = await realpath(executable)
  const verifier = join(worktree, 'scripts', 'ci', 'verify-workspace-deps.ts')
  // Repositories without the host readiness contract still install every time.
  const key = await exists(verifier) ? await preparationKey(worktree, workspaces, bun) : null
  let reuse = false
  if (key && receipt && await exists(modules)) {
    const identity = await lstat(modules)
    reuse = receipt.version === RECEIPT_VERSION && receipt.key === key
      && receipt.modulesDevice === identity.dev && receipt.modulesInode === identity.ino
    if (reuse) reuse = typeof receipt.resolution === 'string' && receipt.resolution === await resolutionKey(worktree, workspaces, bun)
  }
  const execute = async (argv: string[], label: string, cwd = worktree) => {
    await appendFile(log, `${label}\n`)
    // exec makes the bounded host child the installer itself. Its transcript goes
    // straight to disk, and installation never borrows the publisher's credentials.
    const result = await run(['bash', '-c', `exec ${argv.map(quote).join(' ')} >>${quote(log)} 2>&1`],
      cwd, undefined, PROJECT_DEPENDENCIES_TIMEOUT_MS)
    await appendFile(log, `${label}: exit=${result.exit_code}; timed_out=${result.timed_out === true}\n`)
    if (!result.ok || result.exit_code !== 0 || result.timed_out) await refuse(`${label} did not complete successfully`)
  }
  // This host preparation phase must not execute package lifecycle scripts.
  // A project requiring generated artifacts still has to satisfy its full suite.
  if (reuse) await appendFile(log, 'Reusing validated worktree dependency receipt\n')
  else await execute([bun, 'install', '--frozen-lockfile', '--ignore-scripts'], 'bun install')
  // A zero exit is insufficient: a no-op executable must not admit workers into
  // the same empty tree that caused the publication failure.
  if (!await exists(modules) || !(await lstat(modules)).isDirectory() || (await readdir(modules)).length === 0) {
    await refuse('bun install produced no worktree-local dependencies')
  }
  if (await exists(store) && !(await lstat(store)).isDirectory()) {
    await refuse('Bun store must be a worktree-local directory')
  }
  // A repository carrying this verifier opts into the workspace readiness contract.
  // Both the script AND its runtime configuration must belong to the host.
  // A worktree cwd lets bunfig.toml preload branch code before even an absolute
  // host script. Keep that tree as data only, with an explicit empty config and
  // no dotenv loading; resolution inside the verifier still uses its root arg.
  if (await exists(verifier)) await execute([bun, '--config=/dev/null', '--no-env-file', hostVerifier, worktree],
    'workspace dependency verification', hostDirectory)
  // A successful installer must not silently change an input behind the receipt.
  if (key && key === await preparationKey(worktree, workspaces, bun)) {
    const resolution = await resolutionKey(worktree, workspaces, bun)
    if (!resolution) {
      await appendFile(log, 'Dependency resolutions are not confined to this worktree; preparation will not be reused\n')
      await appendFile(log, 'Worktree-local dependency preparation completed without a reusable receipt\n')
      return
    }
    const identity = await lstat(modules)
    const temporary = `${receiptPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: RECEIPT_VERSION, key, resolution,
      modulesDevice: identity.dev, modulesInode: identity.ino }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, receiptPath)
  }
  await appendFile(log, 'Worktree-local dependency preparation completed\n')
}
