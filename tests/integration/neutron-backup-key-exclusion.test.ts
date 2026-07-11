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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKUP_SH = join(HERE, '..', '..', 'neutron-backup.sh')

function git(dataDir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dataDir, ...args], { encoding: 'utf8' })
  return (res.stdout ?? '').trim()
}

function runBackup(
  dataDir: string,
  opts: { extraEnv?: Record<string, string | undefined>; stubGitRmFail?: boolean } = {},
) {
  let path = process.env['PATH'] ?? '/usr/bin:/bin'
  if (opts.stubGitRmFail === true) {
    // Shadow `git` with a stub that FAILS on the `rm` subcommand (simulating a
    // locked index / perms error) but proxies every other subcommand to the
    // real git, so the rest of the backup (init/add/commit/ls-files) is real.
    const realGit = (spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout ?? 'git').trim()
    const stubDir = join(dataDir, '.stubbin')
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(join(stubDir, 'git'), `#!/bin/sh\nif [ "$1" = "rm" ]; then exit 1; fi\nexec ${realGit} "$@"\n`, {
      mode: 0o755,
    })
    path = `${stubDir}${delimiter}${path}`
  }
  return spawnSync('sh', [BACKUP_SH, 'run'], {
    encoding: 'utf8',
    env: {
      PATH: path,
      HOME: dataDir,
      NEUTRON_HOME: dataDir,
      // No NEUTRON_BACKUP_REMOTE — local-only, so `run` never attempts network.
      ...opts.extraEnv,
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
      // Success is reported ONLY after the index is verified key-free (info →
      // stdout); the "rotate the key" caveat is a warn → stderr.
      expect(res.stdout).toContain('untracked .neutron-aes-key from the backup repo')
      expect(res.stderr).toContain('rotate the key if the backup remote is not fully trusted')

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

  // Fail-CLOSED boundary (Codex blocker #2): if `git rm --cached` cannot untrack
  // the key (index lock / perms / any git error), the backup must ABORT before
  // add/commit/push — it must NEVER report success and re-commit/push a bundle
  // that still contains the AES key. Force it by shadowing `git` so `git rm`
  // fails while the key is tracked.
  test('git rm --cached FAILURE aborts the backup before it can commit/push the key', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neutron-backup-rmfail-'))
    try {
      const keyBytes = Buffer.alloc(32, 3)
      writeFileSync(join(dataDir, '.neutron-aes-key'), keyBytes, { mode: 0o600 })
      writeFileSync(join(dataDir, 'project.db'), 'legacy-bundle\n')
      writeFileSync(join(dataDir, '.gitignore'), 'logs/\n')

      // Prior (pre-fix) run that committed the key into the index.
      spawnSync('git', ['-C', dataDir, 'init', '-q'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.email', 'test@localhost'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.name', 'Test'])
      spawnSync('git', ['-C', dataDir, 'add', '-A'])
      spawnSync('git', ['-C', dataDir, 'commit', '-q', '-m', 'legacy: key + db'])
      const commitsBefore = git(dataDir, ['rev-list', '--count', 'HEAD'])
      expect(git(dataDir, ['ls-files']).split('\n')).toContain('.neutron-aes-key')

      const res = runBackup(dataDir, { stubGitRmFail: true })

      // Aborted loudly.
      expect(res.status).not.toBe(0)
      expect(res.stderr).toContain('refusing to back up')
      expect(res.stderr).toContain('STILL tracked')

      // Authoritative outcome: NO new backup commit was created (the abort
      // happened before `git add`/commit), and the key is still tracked at the
      // pre-existing commit — never re-committed/pushed by this run. The whole
      // point: a tracked key is never bundled again behind a false success.
      expect(git(dataDir, ['rev-list', '--count', 'HEAD'])).toBe(commitsBefore)
      expect(git(dataDir, ['ls-files']).split('\n')).toContain('.neutron-aes-key')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  // Authoritative-gate regression (Codex blocker #3): a NEGATED .gitignore pair
  // (`.neutron-aes-key` then `!.neutron-aes-key`) leaves the key UN-ignored —
  // Git applies the LAST matching rule — so `git add -A` STAGES it even though
  // the exact exclusion line is present and the key started untracked. The
  // pre-add checks all pass; only the post-add gate (force un-stage + verify
  // before commit) keeps the key out of the bundle. Assert the produced commit
  // does NOT contain the key.
  test('a NEGATED .gitignore rule cannot smuggle the key into the committed bundle', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neutron-backup-negated-'))
    try {
      const keyBytes = Buffer.alloc(32, 5)
      writeFileSync(join(dataDir, '.neutron-aes-key'), keyBytes, { mode: 0o600 })
      writeFileSync(join(dataDir, 'project.db'), 'db-content\n')
      // The exact exclusion line IS present, but a later negation un-ignores it.
      writeFileSync(join(dataDir, '.gitignore'), 'logs/\n.neutron-aes-key\n!.neutron-aes-key\n')

      // Fresh repo, key initially UNTRACKED (so the tracked-key path is not what
      // saves us here — the post-add gate is).
      spawnSync('git', ['-C', dataDir, 'init', '-q'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.email', 'test@localhost'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.name', 'Test'])

      const res = runBackup(dataDir)
      expect(res.status).toBe(0)

      // THE assertion: whatever got committed, the key is NOT in the index and
      // NOT in the committed tree — never bundled, never pushable.
      expect(git(dataDir, ['ls-files']).split('\n')).not.toContain('.neutron-aes-key')
      const headTree = git(dataDir, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n')
      expect(headTree).not.toContain('.neutron-aes-key')
      expect(headTree).toContain('project.db')

      // The local key file is untouched (the gate is index-only).
      expect(readFileSync(join(dataDir, '.neutron-aes-key'))).toEqual(keyBytes)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
