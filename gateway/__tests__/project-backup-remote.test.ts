import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  generateBackupKey, pushEncryptedProjectBackup, readOwnerBackupConfig,
  restoreEncryptedProjectBackup, runBackupCommand, MAX_ENCRYPTED_BACKUP_BYTES, type BackupCommand, type OwnerBackupConfig,
} from '../git/project-backup-remote.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vault-remote-test-')); dirs.push(root)
  const project = join(root, 'project'); await mkdir(project)
  const keyFile = join(root, 'key'); await generateBackupKey(keyFile)
  const config: OwnerBackupConfig = { version: 1, repository: 'example/vault-fixture', repositoryId: 123,
    keyFile, recoveryConfirmed: true }
  const vaultGit = [`--git-dir=${join(project, '.project-backup')}`, `--work-tree=${project}`]
  const git = (args: string[], cwd?: string) => runBackupCommand('git', args, cwd)
  await git(['init', '--initial-branch=main', `--separate-git-dir=${join(project, '.project-backup')}`, project])
  await writeFile(join(project, '.gitignore'), '.git\n.project-backup/\n')
  await writeFile(join(project, 'notes.md'), 'PRIVATE FIRST VERSION fixture-secret-alpha')
  await git([...vaultGit, 'add', '.'])
  await git([...vaultGit, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'private history'])
  const first = (await git([...vaultGit, 'rev-parse', 'HEAD'])).trim()
  await git([...vaultGit, 'update-ref', 'refs/neutron-legacy/doc-history', first])
  await writeFile(join(project, 'notes.md'), 'PRIVATE SECOND VERSION fixture-secret-beta')
  await git([...vaultGit, 'add', '.'])
  await git([...vaultGit, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'private second history'])
  const seed = join(root, 'seed'); await git(['init', '--initial-branch=main', seed])
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Encrypted storage'], seed)
  const remote = join(root, 'remote.git'); await git(['clone', '--bare', seed, remote])
  let metadata: object = { id: 123, private: true, full_name: config.repository }
  let offline = false
  const calls: string[][] = []
  const command: BackupCommand = async (binary, args, cwd) => {
    calls.push([binary, ...args])
    if (binary === 'gh') {
      if (offline) throw new Error('network unavailable')
      return JSON.stringify(metadata)
    }
    const local = args.map(arg => arg === `git@github.com:${config.repository}.git` ? remote : arg)
    return git(local, cwd)
  }
  return { root, project, config, remote, command, calls, git, first,
    metadata: (value: object) => { metadata = value }, offline: () => { offline = true } }
}

describe('encrypted project vault remote', () => {
  test('fresh clone restores current bytes AND historical bytes; only encrypted payload reaches remote', async () => {
    const f = await fixture()
    const pushed = await pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'private-project', config: f.config, command: f.command })
    expect(pushed.pushed).toBe(true)
    const names = (await f.git([`--git-dir=${f.remote}`, 'ls-tree', '-r', '--name-only', 'main'])).trim().split('\n')
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.nvb$/)
    const fresh = join(f.root, 'fresh')
    await f.git(['clone', f.remote, fresh])
    const ciphertext = await readFile(join(fresh, names[0]!))
    expect(ciphertext.subarray(0, 4).toString()).toBe('NVB1')
    expect(ciphertext.includes(Buffer.from('fixture-secret'))).toBe(false)
    expect(ciphertext.includes(Buffer.from('private-project'))).toBe(false)
    // Positive control: same scan recognizes known plaintext in the source.
    expect((await readFile(join(f.project, 'notes.md'))).includes(Buffer.from('fixture-secret'))).toBe(true)
    const destination = join(f.root, 'restored')
    const restored = await restoreEncryptedProjectBackup({ projectId: 'private-project', destination, config: f.config, command: f.command })
    expect(restored.snapshot).toBe(pushed.snapshot)
    expect(await readFile(join(destination, 'notes.md'), 'utf8')).toContain('fixture-secret-beta')
    expect(await f.git([`--git-dir=${join(destination, '.project-backup')}`, 'show', `${f.first}:notes.md`])).toContain('fixture-secret-alpha')
    expect((await f.git([`--git-dir=${join(destination, '.project-backup')}`, 'rev-parse', 'refs/neutron-legacy/doc-history'])).trim()).toBe(f.first)
    expect(await f.git([`--git-dir=${join(destination, '.project-backup')}`, 'remote'])).toBe('')
    const again = await pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'private-project', config: f.config, command: f.command })
    expect(again.snapshot).toBe(pushed.snapshot)
    expect(again.commit).not.toBe(pushed.commit)
  })

  test.each([
    { id: 123, private: false, full_name: 'example/vault-fixture' },
    { id: 456, private: true, full_name: 'example/vault-fixture' },
    { id: 123, private: true, full_name: 'example/wrong-fixture' },
  ])('refuses untrusted destination before any clone or push: %j', async (metadata) => {
    const f = await fixture(); f.metadata(metadata)
    await expect(pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: f.command })).rejects.toThrow('destination_identity_or_privacy_changed')
    expect(f.calls.some(call => call.includes('clone') || call.includes('push'))).toBe(false)
  })

  test('network failure remains a failure, never plaintext fallback', async () => {
    const f = await fixture(); f.offline()
    await expect(pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: f.command })).rejects.toThrow('destination_unverified')
    expect(f.calls.some(call => call.includes('push'))).toBe(false)
  })

  test('privacy is rechecked immediately before push; an upload failure is not a success', async () => {
    const f = await fixture()
    let checks = 0
    const changed: BackupCommand = async (binary, args, cwd) => {
      if (binary === 'gh' && ++checks === 2) f.metadata({ id: 123, private: false, full_name: f.config.repository })
      return f.command(binary, args, cwd)
    }
    await expect(pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: changed })).rejects.toThrow('destination_identity_or_privacy_changed')
    expect(checks).toBe(2)
    expect(f.calls.some(call => call.includes('push'))).toBe(false)
    f.metadata({ id: 123, private: true, full_name: f.config.repository })
    const failed: BackupCommand = async (binary, args, cwd) => {
      if (binary === 'git' && args.includes('push')) throw new Error('upload failed')
      return f.command(binary, args, cwd)
    }
    await expect(pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: failed })).rejects.toThrow('upload failed')
    expect((await f.git([`--git-dir=${f.remote}`, 'ls-tree', '-r', '--name-only', 'main'])).trim()).toBe('')
  })

  test('oversize export is refused before clone; small real export remains writable', async () => {
    const f = await fixture()
    const oversized: BackupCommand = async (binary, args, cwd) => {
      const result = await f.command(binary, args, cwd)
      const create = args.indexOf('create')
      if (binary === 'git' && args.includes('bundle') && create >= 0) {
        await truncate(args[create + 1]!, MAX_ENCRYPTED_BACKUP_BYTES)
      }
      return result
    }
    await expect(pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: oversized })).rejects.toThrow('bundle_too_large')
    expect(f.calls.some(call => call.includes('clone'))).toBe(false)
    expect((await pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: f.command })).pushed).toBe(true)
  })

  test('authenticated project binding rejects a valid ciphertext copied over another project', async () => {
    const f = await fixture()
    await pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'a', config: f.config, command: f.command })
    await pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'b', config: f.config, command: f.command })
    const clone = join(f.root, 'substitution'); await f.git(['clone', f.remote, clone])
    const names = (await readdir(clone)).filter(name => name.endsWith('.nvb'))
    expect(names).toHaveLength(2)
    await writeFile(join(clone, names[1]!), await readFile(join(clone, names[0]!)))
    await f.git(['add', '.'], clone)
    await f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Substitution'], clone)
    await f.git(['push', 'origin', 'main'], clone)
    const outcomes = await Promise.allSettled(['a', 'b'].map(projectId => restoreEncryptedProjectBackup({ projectId,
      destination: join(f.root, `restore-${projectId}`), config: f.config, command: f.command })))
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.message).toContain('authentication_failed')
  })

  test('missing, public-readable, symlinked and in-vault keys refuse before commands; key generator cannot overwrite', async () => {
    const f = await fixture()
    const original = await readFile(f.config.keyFile)
    await expect(generateBackupKey(f.config.keyFile)).rejects.toThrow('key_creation_failed')
    expect(await readFile(f.config.keyFile)).toEqual(original)
    const run = (keyFile: string) => pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: { ...f.config, keyFile }, command: f.command })
    await expect(run(join(f.root, 'missing'))).rejects.toThrow('key_missing_or_unsafe')
    await chmod(f.config.keyFile, 0o644)
    await expect(run(f.config.keyFile)).rejects.toThrow('key_missing_or_unsafe')
    await chmod(f.config.keyFile, 0o600)
    await symlink(f.config.keyFile, join(f.root, 'symlink'))
    await expect(run(join(f.root, 'symlink'))).rejects.toThrow('key_missing_or_unsafe')
    await writeFile(join(f.project, 'key'), original, { mode: 0o600 })
    await expect(run(join(f.project, 'key'))).rejects.toThrow('key_missing_or_unsafe')
    expect(f.calls).toHaveLength(0)
  })

  test('ciphertext corruption fails authentication and leaves restore destination absent', async () => {
    const f = await fixture()
    await pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: f.command })
    const corrupt = join(f.root, 'corrupt'); await f.git(['clone', f.remote, corrupt])
    const name = (await readdir(corrupt)).find(name => name.endsWith('.nvb'))!
    const bytes = await readFile(join(corrupt, name)); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await writeFile(join(corrupt, name), bytes)
    await f.git(['add', name], corrupt)
    await f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Damaged payload'], corrupt)
    await f.git(['push', 'origin', 'main'], corrupt)
    const destination = join(f.root, 'refused')
    await expect(restoreEncryptedProjectBackup({ projectId: 'p', destination, config: f.config, command: f.command })).rejects.toThrow('authentication_failed')
    expect((await readdir(f.root)).includes('refused')).toBe(false)
  })

  test('refuses wrong recovery key, wrong project and existing destination', async () => {
    const f = await fixture()
    await pushEncryptedProjectBackup({ projectDir: f.project, projectId: 'p', config: f.config, command: f.command })
    const keyFile = join(f.root, 'wrong-key'); await generateBackupKey(keyFile)
    const destination = join(f.root, 'refused')
    await expect(restoreEncryptedProjectBackup({ projectId: 'p', destination, config: { ...f.config, keyFile }, command: f.command })).rejects.toThrow('encrypted_artifact_missing')
    await expect(restoreEncryptedProjectBackup({ projectId: 'other', destination, config: f.config, command: f.command })).rejects.toThrow('encrypted_artifact_missing')
    await expect(restoreEncryptedProjectBackup({ projectId: 'p', destination: f.project, config: f.config, command: f.command })).rejects.toThrow('destination_exists')
    expect(await readFile(join(f.project, 'notes.md'), 'utf8')).toContain('fixture-secret-beta')
  })

  test('config omission is local-only; malformed and unconfirmed configuration refuse', async () => {
    const f = await fixture()
    expect(await readOwnerBackupConfig(f.root)).toBeNull()
    await mkdir(join(f.root, '.vault-backup'))
    const path = join(f.root, '.vault-backup', 'config.json')
    await writeFile(path, '{broken')
    await expect(readOwnerBackupConfig(f.root)).rejects.toThrow('invalid_config')
    await writeFile(path, JSON.stringify({ ...f.config, recoveryConfirmed: false }))
    await expect(readOwnerBackupConfig(f.root)).rejects.toThrow('recovery_unconfirmed')
    await writeFile(path, JSON.stringify(f.config))
    expect(await readOwnerBackupConfig(f.root)).toEqual(f.config)
  })
})
