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

const REAL_GIT = (spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout ?? 'git').trim()

/** List `<sha> <path>` reachable objects on a bare remote, filtered to a path substring. */
function remoteObjectsMatching(remoteGitDir: string, needle: string): string[] {
  const out = spawnSync(REAL_GIT, ['--git-dir', remoteGitDir, 'rev-list', '--all', '--objects'], {
    encoding: 'utf8',
  }).stdout ?? ''
  return out.split('\n').filter((l) => l.includes(needle))
}

/** Commits on a bare remote (across all refs) that touched a given path. */
function remoteCommitsTouching(remoteGitDir: string, path: string): string[] {
  const out = spawnSync(REAL_GIT, ['--git-dir', remoteGitDir, 'log', '--all', '--pretty=format:%H', '--', path], {
    encoding: 'utf8',
  }).stdout ?? ''
  return out.split('\n').filter((l) => l.length > 0)
}

function runBackup(
  dataDir: string,
  opts: {
    extraEnv?: Record<string, string | undefined>
    stubGitRmFail?: boolean
    /** Make BOTH git-filter-repo and git-filter-branch appear UNAVAILABLE. */
    noPurgeTools?: boolean
  } = {},
) {
  let path = process.env['PATH'] ?? '/usr/bin:/bin'
  if (opts.stubGitRmFail === true) {
    // Shadow `git` with a stub that FAILS on the `rm` subcommand (simulating a
    // locked index / perms error) but proxies every other subcommand to the
    // real git, so the rest of the backup (init/add/commit/ls-files) is real.
    const stubDir = join(dataDir, '.stubbin')
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(join(stubDir, 'git'), `#!/bin/sh\nif [ "$1" = "rm" ]; then exit 1; fi\nexec ${REAL_GIT} "$@"\n`, {
      mode: 0o755,
    })
    path = `${stubDir}${delimiter}${path}`
  }
  if (opts.noPurgeTools === true) {
    // Shim `git` so `git --exec-path` points at an EMPTY dir (hiding the
    // built-in git-filter-branch) and pin PATH so no git-filter-repo is
    // resolvable — both purge tools appear unavailable, forcing the
    // fail-closed fallback. All other git invocations proxy to the real git.
    const stubDir = join(dataDir, '.nopurgebin')
    const emptyExec = join(dataDir, '.emptyexec')
    mkdirSync(stubDir, { recursive: true })
    mkdirSync(emptyExec, { recursive: true })
    writeFileSync(
      join(stubDir, 'git'),
      `#!/bin/sh\nif [ "$1" = "--exec-path" ] && [ "$#" -eq 1 ]; then echo ${emptyExec}; exit 0; fi\nexec ${REAL_GIT} "$@"\n`,
      { mode: 0o755 },
    )
    // Minimal PATH: the shim + system dirs only (never the dev machine's
    // homebrew, where a real git-filter-repo might live).
    path = `${stubDir}${delimiter}/usr/bin${delimiter}/bin`
  }
  return spawnSync('sh', [BACKUP_SH, 'run'], {
    encoding: 'utf8',
    env: {
      PATH: path,
      HOME: dataDir,
      NEUTRON_HOME: dataDir,
      // No NEUTRON_BACKUP_REMOTE by default — local-only, so `run` never
      // attempts network (individual tests opt in via extraEnv).
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
      // stdout); the older-commits caveat is a warn → stderr (the pre-push
      // history gate is what actually purges those before any push).
      expect(res.stdout).toContain('untracked .neutron-aes-key from the backup repo')
      expect(res.stderr).toContain('the pre-push history gate purges those before any push')

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

  // History-purge regression (Codex blocker #5): the index gates keep the key
  // out of the CURRENT commit, but a legacy repo that committed the key under
  // an OLDER backup version still has it in reachable HISTORY. The first push
  // to a newly configured remote would disclose it. The pre-push purge must
  // rewrite history so the PUSHED remote contains the key in NO commit.
  test('a legacy commit with the key is purged from history and never reaches the pushed remote', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neutron-backup-history-'))
    const remoteDir = mkdtempSync(join(tmpdir(), 'neutron-backup-remote-'))
    const remoteGitDir = join(remoteDir, 'remote.git')
    try {
      spawnSync(REAL_GIT, ['init', '--bare', '-q', remoteGitDir])

      const keyBytes = Buffer.alloc(32, 7)
      writeFileSync(join(dataDir, '.neutron-aes-key'), keyBytes, { mode: 0o600 })
      writeFileSync(join(dataDir, 'project.db'), 'db-v1\n')
      writeFileSync(join(dataDir, '.gitignore'), 'logs/\n')

      // LEGACY commit (old backup version) that bundled the key WITH the db.
      spawnSync('git', ['-C', dataDir, 'init', '-q'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.email', 'test@localhost'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.name', 'Test'])
      spawnSync('git', ['-C', dataDir, 'add', '-A'])
      spawnSync('git', ['-C', dataDir, 'commit', '-q', '-m', 'legacy: key + db'])
      // Sanity: the key really is in this legacy history (working-tree repo).
      expect(git(dataDir, ['log', '--all', '--pretty=format:%H', '--', '.neutron-aes-key']).length).toBeGreaterThan(0)

      const res = runBackup(dataDir, { extraEnv: { NEUTRON_BACKUP_REMOTE: remoteGitDir } })
      expect(res.status).toBe(0)

      // THE assertion: across EVERY commit/object on the PUSHED remote, the key
      // is retrievable from NO commit and NO reachable object.
      expect(remoteObjectsMatching(remoteGitDir, '.neutron-aes-key')).toEqual([])
      expect(remoteCommitsTouching(remoteGitDir, '.neutron-aes-key')).toEqual([])
      // project.db DID make it to the remote (the backup still works).
      expect(remoteObjectsMatching(remoteGitDir, 'project.db').length).toBeGreaterThan(0)
      // The local keyfile is intact (history rewrite never touches it on disk).
      expect(readFileSync(join(dataDir, '.neutron-aes-key'))).toEqual(keyBytes)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(remoteDir, { recursive: true, force: true })
    }
  })

  // Fail-CLOSED fallback (Codex blocker #5): if NEITHER git-filter-repo nor
  // git-filter-branch is available to purge a key that lives in history, the
  // backup must ABORT with remediation — never push a history still holding the
  // key. Nothing may reach the remote.
  test('purge tools unavailable → backup aborts with remediation, nothing pushed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'neutron-backup-nopurge-'))
    const remoteDir = mkdtempSync(join(tmpdir(), 'neutron-backup-remote2-'))
    const remoteGitDir = join(remoteDir, 'remote.git')
    try {
      spawnSync(REAL_GIT, ['init', '--bare', '-q', remoteGitDir])

      const keyBytes = Buffer.alloc(32, 9)
      writeFileSync(join(dataDir, '.neutron-aes-key'), keyBytes, { mode: 0o600 })
      writeFileSync(join(dataDir, 'project.db'), 'db-v1\n')
      writeFileSync(join(dataDir, '.gitignore'), 'logs/\n')
      spawnSync('git', ['-C', dataDir, 'init', '-q'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.email', 'test@localhost'])
      spawnSync('git', ['-C', dataDir, 'config', 'user.name', 'Test'])
      spawnSync('git', ['-C', dataDir, 'add', '-A'])
      spawnSync('git', ['-C', dataDir, 'commit', '-q', '-m', 'legacy: key + db'])

      const res = runBackup(dataDir, {
        noPurgeTools: true,
        extraEnv: { NEUTRON_BACKUP_REMOTE: remoteGitDir },
      })

      // Aborted with actionable remediation (mentions the manual purge command).
      expect(res.status).not.toBe(0)
      expect(res.stderr).toContain('refusing to push')
      expect(res.stderr).toContain('filter-repo')

      // NOTHING was pushed — the remote has no refs at all, so the key can't leak.
      const refs = spawnSync(REAL_GIT, ['--git-dir', remoteGitDir, 'for-each-ref'], { encoding: 'utf8' }).stdout ?? ''
      expect(refs.trim()).toBe('')
      expect(remoteObjectsMatching(remoteGitDir, '.neutron-aes-key')).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(remoteDir, { recursive: true, force: true })
    }
  })
})
