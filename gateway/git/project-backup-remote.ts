/** Encrypted transport for the canonical .project-backup history, not a second store. */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

export interface OwnerBackupConfig {
  version: 1
  repository: string
  repositoryId: number
  keyFile: string
  /** Set only after the owner has secured an off-host recovery copy. */
  recoveryConfirmed: true
}

export class EncryptedBackupError extends Error {
  constructor(public readonly reason: string) { super(`Encrypted vault backup refused: ${reason}`) }
}

// Each Git object stays below GitHub's individual-file limit. The whole bundle
// is processed one chunk at a time, never held in memory as one Buffer.
export const MAX_BACKUP_BUNDLE_BYTES = 1024 * 1024 * 1024
export const BACKUP_CHUNK_BYTES = 32 * 1024 * 1024
const MIN_CHUNK_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 4096
const exec = promisify(execFile)
export type BackupCommand = (binary: 'git' | 'gh', args: string[], cwd?: string) => Promise<string>

/** The injection seam replaces commands in tests, never security policy. */
export const runBackupCommand: BackupCommand = async (binary, args, cwd) => {
  try {
    const env = { ...process.env }
    if (binary === 'git') {
      // A caller's repository/index/config overrides must not redirect this transport.
      for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
      Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      })
    }
    const result = await exec(binary, args, {
      cwd, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      env,
    })
    return result.stdout
  } catch {
    // Child errors can include private paths, remote output and credential material.
    throw new EncryptedBackupError(`${binary}_command_failed`)
  }
}

export function validateOwnerBackupConfig(value: unknown): OwnerBackupConfig {
  const c = value as Partial<OwnerBackupConfig> | null
  if (!c || c.version !== 1 || typeof c.repository !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c.repository)
    || !Number.isSafeInteger(c.repositoryId) || (c.repositoryId ?? 0) <= 0
    || typeof c.keyFile !== 'string' || !isAbsolute(c.keyFile)
    || c.recoveryConfirmed !== true) throw new EncryptedBackupError('invalid_config_or_recovery_unconfirmed')
  return c as OwnerBackupConfig
}

export async function readOwnerBackupConfig(ownerHome: string): Promise<OwnerBackupConfig | null> {
  let raw: string
  try { raw = await readFile(join(ownerHome, '.vault-backup', 'config.json'), 'utf8') }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new EncryptedBackupError('config_unreadable')
  }
  try { return validateOwnerBackupConfig(JSON.parse(raw)) }
  catch { throw new EncryptedBackupError('invalid_config_or_recovery_unconfirmed') }
}

/** Exclusive creation: a provisioning retry must never replace the recovery key. */
export async function generateBackupKey(keyFile: string): Promise<void> {
  if (!isAbsolute(keyFile)) throw new EncryptedBackupError('key_path_not_absolute')
  const key = randomBytes(32)
  try { await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 }) }
  catch { throw new EncryptedBackupError('key_creation_failed') }
  finally { key.fill(0) }
}

async function loadKey(config: OwnerBackupConfig, projectDir?: string): Promise<Buffer> {
  try {
    if (projectDir) {
      const rel = relative(await realpath(projectDir), await realpath(config.keyFile))
      if (rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel))) {
        throw new Error('key_inside_vault')
      }
    }
    const handle = await open(config.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size !== 32
        || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_key')
      return await handle.readFile()
    } finally { await handle.close() }
  } catch { throw new EncryptedBackupError('key_missing_or_unsafe') }
}

function context(config: OwnerBackupConfig, projectId: string): Buffer {
  if (!projectId || projectId.length > 1024) throw new EncryptedBackupError('invalid_project_identity')
  return Buffer.from(JSON.stringify(['neutron-vault-backup', 2, config.repositoryId, projectId]))
}

function artifactName(key: Buffer, projectId: string): string {
  return createHmac('sha256', key).update('vault-path\0').update(projectId).digest('hex') + '.nvb'
}

interface ChunkManifest {
  version: 2
  bytes: number
  chunkBytes: number
  count: number
  nonce: string
  tag: string
}

const chunkName = (index: number) => `${String(index).padStart(6, '0')}.chunk`
const layoutAAD = (aad: Buffer, manifest: ChunkManifest) => Buffer.from(JSON.stringify([
  aad.toString('utf8'), manifest.version, manifest.bytes, manifest.chunkBytes, manifest.count,
]))

function validateManifest(value: unknown): ChunkManifest {
  const m = value as ChunkManifest | null
  if (!m || m.version !== 2 || !Number.isSafeInteger(m.bytes) || m.bytes < 1
    || m.bytes > MAX_BACKUP_BUNDLE_BYTES || !Number.isSafeInteger(m.chunkBytes)
    || m.chunkBytes < MIN_CHUNK_BYTES || m.chunkBytes > BACKUP_CHUNK_BYTES
    || m.count !== Math.ceil(m.bytes / m.chunkBytes)
    || typeof m.nonce !== 'string' || !/^[a-f0-9]{24}$/.test(m.nonce)
    || typeof m.tag !== 'string' || !/^[a-f0-9]{32}$/.test(m.tag)) {
    throw new EncryptedBackupError('invalid_chunk_manifest')
  }
  return m
}

async function encryptBundle(bundle: string, directory: string, key: Buffer, aad: Buffer,
  bytes: number, chunkBytes: number): Promise<ChunkManifest> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES || chunkBytes > BACKUP_CHUNK_BYTES) {
    throw new EncryptedBackupError('invalid_chunk_size')
  }
  const manifest: ChunkManifest = { version: 2, bytes, chunkBytes,
    count: Math.ceil(bytes / chunkBytes), nonce: randomBytes(12).toString('hex'), tag: '' }
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(manifest.nonce, 'hex'))
  cipher.setAAD(layoutAAD(aad, manifest))
  await mkdir(directory, { mode: 0o700 })
  const input = await open(bundle, 'r')
  const buffer = Buffer.alloc(Math.min(bytes, chunkBytes))
  try {
    for (let i = 0; i < manifest.count; i++) {
      const length = Math.min(chunkBytes, bytes - i * chunkBytes)
      let offset = 0
      while (offset < length) {
        const read = await input.read(buffer, offset, length - offset, i * chunkBytes + offset)
        if (!read.bytesRead) throw new EncryptedBackupError('bundle_changed_during_read')
        offset += read.bytesRead
      }
      await writeFile(join(directory, chunkName(i)), cipher.update(buffer.subarray(0, length)), { mode: 0o600 })
    }
    cipher.final()
    manifest.tag = cipher.getAuthTag().toString('hex')
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
    return manifest
  } finally { buffer.fill(0); await input.close() }
}

async function decryptBundle(directory: string, bundle: string, manifest: ChunkManifest, key: Buffer, aad: Buffer): Promise<void> {
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.nonce, 'hex'))
  cipher.setAAD(layoutAAD(aad, manifest))
  cipher.setAuthTag(Buffer.from(manifest.tag, 'hex'))
  const output = await open(bundle, 'wx', 0o600)
  try {
    for (let i = 0; i < manifest.count; i++) {
      const encrypted = await readFile(join(directory, chunkName(i)))
      if (encrypted.length !== Math.min(manifest.chunkBytes, manifest.bytes - i * manifest.chunkBytes)) {
        throw new EncryptedBackupError('chunk_set_incomplete')
      }
      const plain = cipher.update(encrypted)
      try { await output.writeFile(plain) } finally { plain.fill(0) }
    }
    // Plaintext is private scratch until this succeeds; Git is invoked only afterwards.
    cipher.final()
  } catch { throw new EncryptedBackupError('authentication_failed') }
  finally { await output.close() }
}

async function verifyDestination(config: OwnerBackupConfig, command: BackupCommand): Promise<void> {
  let repository: { id?: number; private?: boolean; full_name?: string; archived?: boolean; disabled?: boolean }
  try { repository = JSON.parse(await command('gh', ['api', '--hostname', 'github.com', `repos/${config.repository}`])) }
  catch { throw new EncryptedBackupError('destination_unverified') }
  if (repository.id !== config.repositoryId || repository.private !== true
    || repository.full_name?.toLowerCase() !== config.repository.toLowerCase()
    || repository.archived || repository.disabled) throw new EncryptedBackupError('destination_identity_or_privacy_changed')
}

const git = (command: BackupCommand, args: string[], cwd?: string) => command('git', [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
  '-c', 'protocol.ext.allow=never', ...args,
], cwd)

async function cloneRemote(config: OwnerBackupConfig, directory: string, command: BackupCommand): Promise<void> {
  await verifyDestination(config, command)
  await git(command, ['clone', '--depth', '1', '--no-checkout', '--single-branch', '--branch', 'main',
    `git@github.com:${config.repository}.git`, directory])
}

interface CommonOptions { projectId: string; config: OwnerBackupConfig; command?: BackupCommand }

/** Caller holds the store's project mutex. Nothing under the live vault is staged remotely. */
export async function pushEncryptedProjectBackup(options: CommonOptions & {
  projectDir: string
  /** Smaller chunks are useful for constrained hosts; the same size bounds apply. */
  chunkBytes?: number
}): Promise<{
  pushed: true; commit: string; snapshot: string
}> {
  const config = validateOwnerBackupConfig(options.config)
  const aad = context(config, options.projectId)
  const key = await loadKey(config, options.projectDir)
  const command = options.command ?? runBackupCommand
  const temp = await mkdtemp(join(tmpdir(), 'neutron-vault-export-'))
  try {
    const bundle = join(temp, 'history.bundle')
    const gitDir = join(resolve(options.projectDir), '.project-backup')
    await git(command, [`--git-dir=${gitDir}`, 'bundle', 'create', bundle, '--all'])
    const bytes = (await stat(bundle)).size
    if (bytes < 1 || bytes > MAX_BACKUP_BUNDLE_BYTES) throw new EncryptedBackupError('bundle_too_large')
    // Read the advertised bundle head, not a second resolution of the mutable local ref.
    const advertised = await git(command, ['bundle', 'list-heads', bundle, 'refs/heads/main'])
    const snapshot = advertised.trim().split(' ')[0] ?? ''
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot)) throw new EncryptedBackupError('invalid_bundle_head')
    const encryptedDir = join(temp, 'encrypted')
    const manifest = await encryptBundle(bundle, encryptedDir, key, aad, bytes, options.chunkBytes ?? BACKUP_CHUNK_BYTES)
    const remote = join(temp, 'remote')
    await cloneRemote(config, remote, command)
    // No checkout: remote-controlled symlinks/attributes can never redirect staging.
    await git(command, ['read-tree', 'HEAD'], remote)
    const name = artifactName(key, options.projectId)
    // Remove the previous complete chunk set from the index before replacing it.
    // Without this, a smaller subsequent export would retain stale tail chunks.
    const previous = (await git(command, ['ls-files', '-z', '--', name], remote)).split('\0').filter(Boolean)
    for (const path of previous) await git(command, ['update-index', '--force-remove', '--', path], remote)
    for (const file of ['manifest.json', ...Array.from({ length: manifest.count }, (_, i) => chunkName(i))]) {
      const blob = (await git(command, ['hash-object', '-w', '--no-filters', join(encryptedDir, file)], remote)).trim()
      await git(command, ['update-index', '--add', '--cacheinfo', `100644,${blob},${name}/${file}`], remote)
    }
    await git(command, ['-c', 'user.name=Neutron Vault Backup', '-c', 'user.email=vault-backup@localhost',
      'commit', '-m', 'Encrypted vault snapshot'], remote)
    const commit = (await git(command, ['rev-parse', 'HEAD'], remote)).trim()
    await verifyDestination(config, command)
    await git(command, ['push', 'origin', 'HEAD:refs/heads/main'], remote)
    return { pushed: true, commit, snapshot }
  } finally {
    key.fill(0)
    await rm(temp, { recursive: true, force: true })
  }
}

/** Restore only into a new directory; existing vaults are never overlaid or replaced. */
export async function restoreEncryptedProjectBackup(options: CommonOptions & { destination: string }): Promise<{
  restored: true; snapshot: string
}> {
  const config = validateOwnerBackupConfig(options.config)
  const aad = context(config, options.projectId)
  const key = await loadKey(config)
  const command = options.command ?? runBackupCommand
  const destination = resolve(options.destination)
  const temp = await mkdtemp(join(dirname(destination), '.neutron-vault-restore-'))
  try {
    try { await lstat(destination); throw new EncryptedBackupError('destination_exists') }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
    const remote = join(temp, 'remote')
    await cloneRemote(config, remote, command)
    const name = artifactName(key, options.projectId)
    const tree = await git(command, ['ls-tree', '-r', '-l', 'HEAD', '--', name], remote)
    const entries = new Map<string, number>()
    for (const line of tree.split('\n').filter(Boolean)) {
      const entry = /^100644 blob (?:[a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+)\t(.+)$/.exec(line)
      if (!entry || !entry[2]?.startsWith(name + '/')) throw new EncryptedBackupError('invalid_chunk_tree')
      entries.set(entry[2].slice(name.length + 1), Number(entry[1]))
    }
    const manifestSize = entries.get('manifest.json')
    if (manifestSize === undefined) throw new EncryptedBackupError('encrypted_artifact_missing')
    if (manifestSize < 1 || manifestSize > MAX_MANIFEST_BYTES) throw new EncryptedBackupError('invalid_chunk_manifest')
    let manifest: ChunkManifest
    try { manifest = validateManifest(JSON.parse(await git(command, ['show', `HEAD:${name}/manifest.json`], remote))) }
    catch { throw new EncryptedBackupError('invalid_chunk_manifest') }
    if (entries.size !== manifest.count + 1) throw new EncryptedBackupError('chunk_set_incomplete')
    for (let i = 0; i < manifest.count; i++) {
      if (entries.get(chunkName(i)) !== Math.min(manifest.chunkBytes, manifest.bytes - i * manifest.chunkBytes)) {
        throw new EncryptedBackupError('chunk_set_incomplete')
      }
    }
    // Only validated, bounded regular ciphertext files are materialized.
    await git(command, ['read-tree', 'HEAD'], remote)
    for (let i = 0; i < manifest.count; i++) await git(command, ['checkout-index', '--', `${name}/${chunkName(i)}`], remote)
    const bundle = join(temp, 'history.bundle')
    await decryptBundle(join(remote, name), bundle, manifest, key, aad)
    const restored = join(temp, 'restored')
    await mkdir(restored, { mode: 0o700 })
    const gitDir = join(restored, '.project-backup')
    await git(command, ['clone', '--mirror', '--branch', 'main', bundle, gitDir])
    await git(command, [`--git-dir=${gitDir}`, 'fsck', '--full'])
    await git(command, [`--git-dir=${gitDir}`, 'config', 'core.bare', 'false'])
    // Removing a mirror remote with `remote remove` would also remove its refs.
    await git(command, [`--git-dir=${gitDir}`, 'config', '--remove-section', 'remote.origin'])
    await git(command, [`--git-dir=${gitDir}`, `--work-tree=${restored}`, 'checkout', '-f', 'main'])
    const snapshot = (await git(command, [`--git-dir=${gitDir}`, 'rev-parse', 'refs/heads/main'])).trim()
    // mkdir reserves the target; rename then replaces only our own empty directory.
    await mkdir(destination, { mode: 0o700 })
    await rename(restored, destination)
    return { restored: true, snapshot }
  } finally {
    key.fill(0)
    await rm(temp, { recursive: true, force: true })
  }
}
