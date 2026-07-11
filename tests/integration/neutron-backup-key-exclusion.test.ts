/**
 * S3(a) — secrets-at-rest hygiene: `neutron-backup.sh` bundled the AES key
 * (`.neutron-aes-key`, the file that decrypts every row in
 * `auth/secrets-store.ts`'s `secrets` table) WITH the ciphertext
 * (`project.db`) it backs up, and pushed both to the configured remote —
 * defeating encryption-at-rest for anyone with read access to that remote.
 *
 * This suite drives `neutron-backup.sh run` for real (a throwaway
 * `NEUTRON_HOME`, no remote configured so nothing leaves the machine) and
 * asserts:
 *   1. a FRESH backup never tracks `.neutron-aes-key`, only `project.db`.
 *   2. an EXISTING install whose `.gitignore` predates this fix — and whose
 *      local backup repo already committed the key — gets self-healed: the
 *      key is un-tracked going forward and `.gitignore` is patched, without
 *      touching the key file's on-disk bytes (it must stay usable locally).
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKUP_SH = join(HERE, '..', '..', 'neutron-backup.sh')

function git(dataDir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dataDir, ...args], { encoding: 'utf8' })
  return (res.stdout ?? '').trim()
}

function runBackup(dataDir: string, extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync('sh', [BACKUP_SH, 'run'], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: dataDir,
      NEUTRON_HOME: dataDir,
      // No NEUTRON_BACKUP_REMOTE — local-only, so `run` never attempts network.
      ...extraEnv,
    },
  })
}

describe('neutron-backup.sh — AES key excluded from the backup bundle (S3a)', () => {
  test('a fresh backup tracks project.db but NEVER .neutron-aes-key', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neutron-backup-fresh-'))
    try {
      writeFileSync(join(dataDir, '.neutron-aes-key'), Buffer.alloc(32, 7), { mode: 0o600 })
      writeFileSync(join(dataDir, 'project.db'), 'not-a-real-sqlite-file-but-thats-fine\n')

      const res = runBackup(dataDir)
      expect(res.status).toBe(0)

      const tracked = git(dataDir, ['ls-files']).split('\n').filter((l) => l.length > 0)
      expect(tracked).toContain('project.db')
      expect(tracked).toContain('.gitignore')
      expect(tracked).not.toContain('.neutron-aes-key')

      const gitignore = readFileSync(join(dataDir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('.neutron-aes-key')

      // The key is still present LOCALLY (only excluded from the backup repo).
      expect(readFileSync(join(dataDir, '.neutron-aes-key')).length).toBe(32)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('self-heals a pre-existing install: un-tracks an already-committed key + patches .gitignore', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neutron-backup-preexisting-'))
    try {
      const keyBytes = Buffer.alloc(32, 9)
      writeFileSync(join(dataDir, '.neutron-aes-key'), keyBytes, { mode: 0o600 })
      writeFileSync(join(dataDir, 'project.db'), 'legacy-bundle\n')
      // Simulate the OLD (pre-S3) .gitignore that never excluded the key.
      writeFileSync(join(dataDir, '.gitignore'), 'logs/\n*.log\n*.pid\n*-wal\n*-shm\n')

      // Simulate a prior run that committed BOTH the key and the db together.
      spawnSync('git', ['-C', dataDir, 'init', '-q'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.email', 'test@localhost'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.name', 'Test'])
      spawnSync('git', ['-C', dataDir, 'add', '-A'])
      spawnSync('git', ['-C', dataDir, 'commit', '-q', '-m', 'legacy pre-fix backup (key + db)'])
      const before = git(dataDir, ['ls-files']).split('\n')
      expect(before).toContain('.neutron-aes-key') // sanity: the legacy bug really did track it

      const res = runBackup(dataDir)
      expect(res.status).toBe(0)
      expect(res.stderr).toContain('untracked it going forward')

      const after = git(dataDir, ['ls-files']).split('\n').filter((l) => l.length > 0)
      expect(after).not.toContain('.neutron-aes-key')
      expect(after).toContain('project.db')

      const gitignore = readFileSync(join(dataDir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('.neutron-aes-key')

      // The key file itself is untouched on disk (un-tracking is a git-index
      // operation only — never delete the working-tree file).
      expect(readFileSync(join(dataDir, '.neutron-aes-key'))).toEqual(keyBytes)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
