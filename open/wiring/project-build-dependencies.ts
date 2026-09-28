import { appendFile, lstat, readFile, readdir, realpath, rename, statfs, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { createLogger } from '@neutronai/logger'
import type { SuiteIdentityMeasurement } from '@neutronai/trident/project-suite-receipt.ts'

const log = createLogger('project-build')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export const PROJECT_DEPENDENCIES_TIMEOUT_MS = 10 * 60_000
export const PROJECT_INSTALL_RESERVE_BYTES = 5n * 1024n ** 3n
// One wall budget for the complete byte walk, including local link targets.
// A full installation can exceed five seconds on a busy shared host.
export const PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS = 30_000

/** Measure blocks available to the installer, including filesystem reservations. */
export async function projectInstallAvailableBytes(worktree: string): Promise<bigint | null> {
  try {
    const observed = await statfs(worktree, { bigint: true })
    if (observed.bavail < 0n || observed.bsize <= 0n) return null
    return observed.bavail * observed.bsize
  } catch { return null }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const hostDirectory = fileURLToPath(new URL('../../', import.meta.url))
const hostVerifier = join(hostDirectory, 'scripts/ci/verify-workspace-deps.ts')
const hostInstalledTreeProbe = fileURLToPath(new URL('./project-build-installed-tree.py', import.meta.url))
const RECEIPT_VERSION = 2

// Run resolution in a new host-controlled process: Bun caches resolutions in a
// long-lived host, which could otherwise conceal removal of a local package.
// Resolving does not load project code. Consistently unresolved optional/type
// packages remain unknown; a package resolved outside the tree is never local
// installation evidence, even when the general readiness verifier tolerates it.
const RESOLUTION_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.argv[1]);
const observations = [];
for (const manifestPath of JSON.parse(process.argv[2])) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).sort();
  for (const dependency of dependencies) {
    let target;
    // Bun's importer is a file: a directory can skip its package-local links.
    try { target = Bun.resolveSync(dependency, path.join(root, manifestPath)); }
    catch { observations.push([manifestPath, dependency, null]); continue; }
    const actual = fs.realpathSync(target);
    if (!actual.startsWith(root + path.sep)) process.exit(3);
    observations.push([manifestPath, dependency, path.relative(root, actual)]);
  }
}
console.log(JSON.stringify(observations));
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
  if (!result.ok || result.timed_out || result.stdout.length > 1024 * 1024) return null
  // A successful process is not proof of a complete resolution transcript.
  // Keep unavailable resolution explicit, including repositories without a manifest.
  let observations: unknown
  try { observations = JSON.parse(result.stdout) } catch { return null }
  if (!Array.isArray(observations) || !observations.every(row => Array.isArray(row) && row.length === 3
    && typeof row[0] === 'string' && typeof row[1] === 'string' && (row[2] === null || typeof row[2] === 'string'))) return null
  const root = await realpath(worktree)
  const paths = [...new Set(observations.flatMap(row => row[2] === null ? [] : [resolve(root, row[2])]))].sort()
  const measured = new Map<string, string[]>()
  const deadline = performance.now() + 5000
  // Bound argv as well as the native observation. Optional unresolved packages
  // remain explicit nulls; resolved entrypoints get the same confined byte read.
  for (let offset = 0; offset < paths.length; offset += 64) {
    const fields = await installedEntries(root, paths.slice(offset, offset + 64), deadline, spawnCapture)
    for (let index = 0; index < fields.length; index += 12) {
      if (fields[index + 7] !== 'f') return null
      measured.set(fields[index]!, fields.slice(index + 1, index + 12))
    }
  }
  if (paths.some(path => !measured.has(path))) return null
  return digest(JSON.stringify(observations.map(row => [...row,
    row[2] === null ? null : measured.get(resolve(root, row[2]))])))
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
  const pythonCommand = Bun.which('python3', { PATH: process.env.PATH ?? '' })
  if (!pythonCommand) return null
  const python = await realpath(pythonCommand), pythonTool = await lstat(python)
  hash.update(JSON.stringify([RECEIPT_VERSION, await realpath(worktree), head.stdout.trim(),
    process.platform, process.arch, process.version, Bun.version, executable,
    [tool.dev, tool.ino, tool.size, tool.mtimeMs, tool.ctimeMs], await readFile(hostVerifier, 'utf8'),
    RESOLUTION_PROBE, await readFile(hostInstalledTreeProbe, 'utf8'),
    [python, pythonTool.dev, pythonTool.ino, pythonTool.size, pythonTool.mtimeMs, pythonTool.ctimeMs],
    '--frozen-lockfile', '--ignore-scripts']))
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

/** The host helper pins ancestry and regular files before reading bytes. Its
 * transient ctime checks catch in-read writes; only the saved regular-file key
 * omits ctime, which also changes when another installation links a cache inode. */
async function installedEntries(root: string, batch: string[], deadline: number,
  run: typeof spawnCapture): Promise<string[]> {
  const remaining = Math.floor(deadline - performance.now())
  if (remaining <= 0) throw Error('deadline')
  const workspace = await lstat(root)
  if (!workspace.isDirectory()) throw Error('workspace-not-directory')
  const python = Bun.which('python3', { PATH: process.env.PATH ?? '' })
  if (!python) throw Error('missing-python')
  const measured = await run([await realpath(python), '-I', '-S', hostInstalledTreeProbe,
    root, String(workspace.dev), String(workspace.ino), JSON.stringify(batch), String(remaining)],
    hostDirectory, { LC_ALL: 'C' }, remaining)
  if (measured.timed_out) throw Error('probe-timeout')
  if (!measured.ok) throw Error('probe-exit')
  if (measured.stdout.length > 64 * 1024 * 1024) throw Error('output-limit')
  if (!measured.stdout.endsWith('\0') || measured.stdout.includes('\uFFFD')) throw Error('invalid-output')
  const fields = measured.stdout.split('\0')
  fields.pop()
  if (fields.length === 0 || fields.length % 12 !== 0) throw Error('invalid-fields')
  for (let index = 0; index < fields.length; index += 12) {
    const path = fields[index]!
    if (!batch.some(base => path === base || path.startsWith(`${base}${sep}`))) throw Error('path-outside-batch')
    if (!fields.slice(index + 1, index + 5).every(value => /^\d+$/.test(value))
      || !fields.slice(index + 5, index + 7).every(value => /^-?\d+$/.test(value))
      || !fields.slice(index + 10, index + 12).every(value => /^\d+$/.test(value))) throw Error('invalid-metadata')
    const kind = fields[index + 7]
    if (kind !== 'f' && kind !== 'd' && kind !== 'l') throw Error('unsupported-entry')
    if (kind === 'f') {
      if (!/^[a-f0-9]{64}$/.test(fields[index + 9]!)) throw Error('missing-content')
      fields[index + 6] = '0'
    } else if (fields[index + 9] !== '') throw Error('unexpected-content')
    if (kind === 'd' && !path.slice(root.length + 1).split(sep).includes('node_modules')) {
      fields[index + 4] = '0'
      fields[index + 5] = '0'
      fields[index + 6] = '0'
    }
  }
  return fields
}

/** A bounded native byte/metadata walk avoids one JS filesystem round trip per file.
 * NUL fields preserve arbitrary whitespace; undecodable names refuse reuse.
 * The helper never follows links: the host validates their targets before measuring
 * additional local roots, so an external tree is never traversed. */
export async function projectInstalledTreeIdentity(worktree: string,
  run: typeof spawnCapture = spawnCapture): Promise<string | null> {
  const started = performance.now()
  const refuse = (reason: string): null => {
    log.warn('suite_installed_identity_unavailable', { workspace: digest(worktree), reason,
      elapsed_ms: Math.round(performance.now() - started) })
    return null
  }
  try {
  const root = await realpath(worktree)
  const modules = join(root, 'node_modules')
  if (!await exists(modules)) return 'absent'
  if (!(await lstat(modules)).isDirectory()) return refuse('modules-not-directory')
  const hash = createHash('sha256')
  const covered: string[] = []
  let pending = [modules]
  const deadline = performance.now() + PROJECT_INSTALLED_IDENTITY_TIMEOUT_MS
  while (pending.length > 0) {
    const batch = pending.sort()
    pending = []
    covered.push(...batch)
    const fields = await installedEntries(root, batch, deadline, run)
    const links: string[] = []
    for (let index = 0; index < fields.length; index += 12) {
      const path = fields[index]!
      const kind = fields[index + 7]
      if (kind === 'l') links.push(path)
    }
    hash.update(fields.join('\0') + '\0')
    // Resolve only links, in bounded groups; ordinary files require no JS stat.
    for (let offset = 0; offset < links.length; offset += 64) {
      if (performance.now() >= deadline) return refuse('deadline')
      const targets = await Promise.all(links.slice(offset, offset + 64).map(path => realpath(path)))
      for (const actual of targets) {
        if (!actual.startsWith(`${root}${sep}`)) return refuse('external-link')
        if (!covered.some(base => actual === base || actual.startsWith(`${base}${sep}`))
          && !pending.includes(actual)) pending.push(actual)
      }
    }
  }
  if (performance.now() >= deadline) return refuse('deadline')
  return hash.digest('hex')
  } catch (error) {
    const reason = error instanceof Error && /^(deadline|probe-timeout|probe-exit|output-limit|invalid-output|invalid-fields|path-outside-batch|invalid-metadata|unsupported-entry|missing-content|unexpected-content|workspace-not-directory|missing-python)$/.test(error.message)
      ? error.message : 'filesystem-or-process-error'
    return refuse(reason)
  }
}

/** Fresh host measurement for suite reuse. Unknown or dirty inputs never reuse
 * proof. This shares preparation's manifest/toolchain and local-resolution keys. */
export async function projectSuiteIdentity(worktree: string, expectedHead?: string): Promise<string | null> {
  return (await projectSuiteIdentityMeasurement(worktree, expectedHead))?.identity ?? null
}

/** The aggregate and its diagnostic components come from one measurement. */
export async function projectSuiteIdentityMeasurement(worktree: string, expectedHead?: string): Promise<SuiteIdentityMeasurement | null> {
  const started = performance.now()
  let probe = 'revision'
  const refuse = (reason: string): null => {
    log.warn('suite_identity_unavailable', { workspace: digest(worktree), probe, reason,
      elapsed_ms: Math.round(performance.now() - started) })
    return null
  }
  try {
    const revision = await spawnCapture(['git', 'rev-parse', '--verify', 'HEAD'], worktree)
    if (!revision.ok) return refuse('unreadable')
    if (expectedHead !== undefined && revision.stdout.trim() !== expectedHead) return refuse('head-mismatch')
    probe = 'git-status'
    const clean = await spawnCapture(['git', 'status', '--porcelain', '--untracked-files=all'], worktree)
    if (!clean.ok) return refuse('unreadable')
    if (clean.stdout.trim()) return refuse('dirty')
    probe = 'runtime'
    const executable = Bun.which('bun', { PATH: process.env.PATH ?? '' })
    if (!executable) return refuse('missing-executable')
    const bun = await realpath(executable)
    probe = 'manifest'
    const manifestPath = join(worktree, 'package.json')
    const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {}
    const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? []
    if (!Array.isArray(workspaces)) return refuse('invalid-workspaces')
    probe = 'preparation'
    const key = await preparationKey(worktree, workspaces, bun)
    if (!key) return refuse('unavailable')
    probe = 'resolution'
    const resolution = await resolutionKey(worktree, workspaces, bun)
    if (await exists(manifestPath) && !resolution) return refuse('unavailable')
    probe = 'installed-tree'
    const installed = await projectInstalledTreeIdentity(worktree)
    // Repositories without a manifest have no package resolution contract.
    if (!installed) return refuse('unavailable')
    probe = 'installation'
    const modules = join(worktree, 'node_modules')
    let installation = null
    if (await exists(modules)) {
      const stat = await lstat(modules)
      if (!stat.isDirectory()) return refuse('modules-not-directory')
      installation = [stat.dev, stat.ino]
    } else if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length > 0) return refuse('missing-dependencies')
    probe = 'workspace'
    const workspace = await lstat(await realpath(worktree))
    const identity = createHash('sha256').update(JSON.stringify([key, resolution, installed, installation,
      workspace.dev, workspace.ino])).digest('hex')
    log.info('suite_identity_measured', { workspace: digest(worktree), identity, preparation: key,
      resolution, installed, installation: digest(JSON.stringify(installation)),
      workspace_identity: digest(JSON.stringify([workspace.dev, workspace.ino])),
      elapsed_ms: Math.round(performance.now() - started) })
    return { identity, components: { preparation: key, resolution: resolution ?? digest('null'),
      installed: installed === 'absent' ? digest('absent') : installed,
      installation: digest(JSON.stringify(installation)),
      workspace: digest(JSON.stringify([workspace.dev, workspace.ino])) } }
  } catch { return refuse('filesystem-or-process-error') }
}

/** Provision declared Bun workspaces. Recovery can reuse a measured installation
 * only after checking the same inputs and running the host readiness verifier. */
export async function prepareProjectDependencies(worktree: string, state: string,
  run: typeof spawnCapture = spawnCapture,
  measureAvailableBytes: typeof projectInstallAvailableBytes = projectInstallAvailableBytes): Promise<void> {
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
  else {
    let available: bigint | null = null
    try { available = await measureAvailableBytes(worktree) } catch { /* Unknown refuses admission. */ }
    if (typeof available !== 'bigint' || available < 0n) {
      await refuse('available disk space is unknown; dependency install paused')
    }
    if (available! < PROJECT_INSTALL_RESERVE_BYTES) {
      await refuse(`available disk space ${available} bytes is below the 5 GiB reserve; dependency install paused`)
    }
    await execute([bun, 'install', '--frozen-lockfile', '--ignore-scripts'], 'bun install')
  }
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
