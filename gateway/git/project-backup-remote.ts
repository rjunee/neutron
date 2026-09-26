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

const MAGIC = Buffer.from('NVB1')
// GitHub rejects large individual Git objects. Refuse before staging/uploading.
export const MAX_ENCRYPTED_BACKUP_BYTES = 95 * 1024 * 1024
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
  return Buffer.from(JSON.stringify(['neutron-vault-backup', 1, config.repositoryId, projectId]))
}

function artifactName(key: Buffer, projectId: string): string {
  return createHmac('sha256', key).update('vault-path\0').update(projectId).digest('hex') + '.nvb'
}

function encrypt(plain: Buffer, key: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext])
}

function decrypt(envelope: Buffer, key: Buffer, aad: Buffer): Buffer {
  try {
    if (envelope.length < 33 || envelope.length > MAX_ENCRYPTED_BACKUP_BYTES
      || !envelope.subarray(0, 4).equals(MAGIC)) throw new Error('bad_envelope')
    const cipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(4, 16))
    cipher.setAAD(aad)
    cipher.setAuthTag(envelope.subarray(16, 32))
    return Buffer.concat([cipher.update(envelope.subarray(32)), cipher.final()])
  } catch { throw new EncryptedBackupError('authentication_failed') }
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
  await git(command, ['clone', '--no-checkout', '--single-branch', '--branch', 'main',
    `git@github.com:${config.repository}.git`, directory])
}

interface CommonOptions { projectId: string; config: OwnerBackupConfig; command?: BackupCommand }

/** Caller holds the store's project mutex. Nothing under the live vault is staged remotely. */
export async function pushEncryptedProjectBackup(options: CommonOptions & { projectDir: string }): Promise<{
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
    if ((await stat(bundle)).size + 32 > MAX_ENCRYPTED_BACKUP_BYTES) throw new EncryptedBackupError('bundle_too_large')
    // Read the advertised bundle head, not a second resolution of the mutable local ref.
    const advertised = await git(command, ['bundle', 'list-heads', bundle, 'refs/heads/main'])
    const snapshot = advertised.trim().split(' ')[0] ?? ''
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot)) throw new EncryptedBackupError('invalid_bundle_head')
    const plain = await readFile(bundle)
    let encrypted: Buffer
    try { encrypted = encrypt(plain, key, aad) } finally { plain.fill(0) }
    const remote = join(temp, 'remote')
    await cloneRemote(config, remote, command)
    // No checkout: remote-controlled symlinks/attributes can never redirect staging.
    await git(command, ['read-tree', 'HEAD'], remote)
    const name = artifactName(key, options.projectId)
    const blobFile = join(temp, 'encrypted.nvb')
    await writeFile(blobFile, encrypted, { mode: 0o600 })
    const blob = (await git(command, ['hash-object', '-w', '--no-filters', blobFile], remote)).trim()
    await git(command, ['update-index', '--add', '--cacheinfo', `100644,${blob},${name}`], remote)
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
    const info = (await git(command, ['ls-tree', 'HEAD', '--', name], remote)).trim()
    if (!new RegExp(`^100644 blob (?:[a-f0-9]{40}|[a-f0-9]{64})\\t${name.replace('.', '\\.')}$`).test(info)) {
      throw new EncryptedBackupError('encrypted_artifact_missing')
    }
    const size = (await git(command, ['cat-file', '-s', `HEAD:${name}`], remote)).trim()
    if (!/^[0-9]+$/.test(size) || Number(size) > MAX_ENCRYPTED_BACKUP_BYTES) throw new EncryptedBackupError('bundle_too_large')
    // Checkout exactly the validated regular ciphertext file. No other remote paths are materialized.
    await git(command, ['read-tree', 'HEAD'], remote)
    await git(command, ['checkout-index', '--', name], remote)
    const plain = decrypt(await readFile(join(remote, name)), key, aad)
    const bundle = join(temp, 'history.bundle')
    try { await writeFile(bundle, plain, { mode: 0o600 }) } finally { plain.fill(0) }
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
