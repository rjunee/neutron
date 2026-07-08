/**
 * P7.4 Phase 2 — ProjectBackupStore tests.
 *
 * Real on-disk tmp dirs; the git binary is exercised directly. The
 * suite skips with a clear message when `git --version` exits non-zero
 * so a CI image without git in PATH stays green but a developer sees
 * the skip line and can install git locally.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  ProjectBackupStore,
  PROJECT_BACKUP_GITIGNORE,
  classifyPushFailure,
} from '../git/project-backup-store.ts'
import type { BackupResult, RestoreResult } from '../git/project-backup-store.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'

const execFileAsync = promisify(execFile)

let GIT_AVAILABLE = false

beforeAll(async () => {
  try {
    await execFileAsync('git', ['--version'])
    GIT_AVAILABLE = true
  } catch {
    GIT_AVAILABLE = false
    console.warn(
      '[project-backup-store.test] skipping — `git --version` failed.',
    )
  }
})

function stubPlatformAdapter(): PlatformAdapter & {
  remoteState: { config: import('@neutronai/runtime/platform-adapter.ts').ProjectBackupRemoteConfig | null }
  capabilitiesMut: { project_backup: boolean }
} {
  const remoteState: { config: import('@neutronai/runtime/platform-adapter.ts').ProjectBackupRemoteConfig | null } = {
    config: null,
  }
  const capabilitiesMut = { project_backup: true }
  const adapter: PlatformAdapter & {
    remoteState: typeof remoteState
    capabilitiesMut: typeof capabilitiesMut
  } = {
    capabilities: {
      slug_rename: false,
      install_token_mint: false,
      connect_fanout: false,
      manager_bot_provisioning: false,
      caddy_reload: false,
      sudoers_regenerate: false,
      tier_two_cores: false,
      get project_backup(): boolean {
        return capabilitiesMut.project_backup
      },
    } as unknown as PlatformAdapter['capabilities'],
    slugAvailability: {
      check: () => ({ slug: '', available: true, reason: null }),
      sanitize: (s) => s,
    },
    resolveOwnerBySlug: () => null,
    resolveOwnerByInternalHandle: () => null,
    renameSlug: async () => ({ status: 'rejected', reason: 'invalid_format' }),
    mintInstallToken: async () => {
      throw new Error('not supported')
    },
    oauthHandoff: async () => {
      throw new Error('not supported')
    },
    connectCall: async () => ({ status: 0, body: null }),
    provisionManagerBot: async () => {
      throw new Error('not supported')
    },
    reloadCaddy: async () => undefined,
    regenerateSudoers: async () => undefined,
    getBundledCoreRoots: () => [process.cwd()] as const,
    getProjectBackupRemoteConfig: async () => remoteState.config,
    setProjectBackupRemoteConfig: async () => {
      throw new Error('not supported in stub')
    },
    clearProjectBackupRemoteConfig: async () => {
      remoteState.config = null
    },
    generateProjectBackupKeypair: async () => {
      throw new Error('not supported in stub')
    },
    remoteState,
    capabilitiesMut,
  }
  return adapter
}

interface Harness {
  tmp: string
  owner_home: string
  projectRoot: string
  store: ProjectBackupStore
  platform: ReturnType<typeof stubPlatformAdapter>
}

const PROJECT_SLUG = 'demo'
const PROJECT_ID = 'demo-project'

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'p74p2-store-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const projectRoot = join(owner_home, 'Projects', PROJECT_ID)
  mkdirSync(projectRoot, { recursive: true })
  // Pre-seed a few common things so the baseline commit isn't empty.
  writeFileSync(join(projectRoot, 'README.md'), '# Demo\n')
  const platform = stubPlatformAdapter()
  const store = new ProjectBackupStore({
    platform,
    owner_home,
    project_slug: PROJECT_SLUG,
  })
  return { tmp, owner_home, projectRoot, store, platform }
}

function cleanup(h: Harness): void {
  rmSync(h.tmp, { recursive: true, force: true })
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return typeof stdout === 'string' ? stdout : String(stdout)
}

async function headSha(h: Harness): Promise<string> {
  const out = await git(h.projectRoot, [
    `--git-dir=${join(h.projectRoot, '.project-backup')}`,
    `--work-tree=${h.projectRoot}`,
    'rev-parse',
    'HEAD',
  ])
  return out.trim()
}

describe('ProjectBackupStore — init + identity', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('creates .project-backup/ with HEAD + refs + objects on first init', async () => {
    if (!GIT_AVAILABLE) return
    const ready = await h.store.ensureInit(PROJECT_ID)
    expect(ready).toBe(true)
    const gitDir = join(h.projectRoot, '.project-backup')
    expect(existsSync(join(gitDir, 'HEAD'))).toBe(true)
    expect(existsSync(join(gitDir, 'objects'))).toBe(true)
    expect(existsSync(join(gitDir, 'refs', 'heads', 'main'))).toBe(true)
  })

  it('is idempotent — second init is a no-op', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const firstHead = await headSha(h)
    await h.store.ensureInit(PROJECT_ID)
    const secondHead = await headSha(h)
    expect(secondHead).toBe(firstHead)
  })

  it('writes the brief-pinned .gitignore at the project root', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const gitignorePath = join(h.projectRoot, '.gitignore')
    expect(existsSync(gitignorePath)).toBe(true)
    const content = require('node:fs').readFileSync(gitignorePath, 'utf8')
    expect(content).toBe(PROJECT_BACKUP_GITIGNORE)
  })

  it('Argus r1 MINOR #6 — backupNow rewrites a user-edited .gitignore back to spec', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const fs = require('node:fs')
    const gitignorePath = join(h.projectRoot, '.gitignore')
    // User (or rogue tooling) drifts the file from spec.
    fs.writeFileSync(gitignorePath, '# user edited this\n*.bogus\n', 'utf8')
    expect(fs.readFileSync(gitignorePath, 'utf8')).not.toBe(PROJECT_BACKUP_GITIGNORE)
    // Next backup tick must reset the file to the canonical body.
    await h.store.backupNow(PROJECT_ID)
    expect(fs.readFileSync(gitignorePath, 'utf8')).toBe(PROJECT_BACKUP_GITIGNORE)
  })

  it('seeds the synthetic Neutron Backup identity', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const out = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'log',
      '-1',
      '--pretty=format:%an <%ae>',
    ])
    expect(out.trim()).toBe(`Neutron Backup <backup@${PROJECT_SLUG}.local>`)
  })
})

describe('ProjectBackupStore — backupNow snapshot pipeline', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('first backup commits the baseline (clean working tree → no extra commit on second call)', async () => {
    if (!GIT_AVAILABLE) return
    const first = await h.store.backupNow(PROJECT_ID)
    expect(first.ok).toBe(true)
    // ensureInit already produced a baseline commit; first backupNow
    // with no changes returns commit_sha=null (nothing new to commit).
    expect(first.commit_sha).toBeNull()
    // Verify the baseline commit captured README.md.
    const log = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'log',
      '--oneline',
    ])
    expect(log.includes('init: project-backup')).toBe(true)
    // Second backupNow with no changes — still no commit.
    const second = await h.store.backupNow(PROJECT_ID)
    expect(second.commit_sha).toBeNull()
  })

  it('changed working tree produces exactly one backup commit', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.backupNow(PROJECT_ID)
    mkdirSync(join(h.projectRoot, 'docs'), { recursive: true })
    writeFileSync(join(h.projectRoot, 'docs', 'newdoc.md'), 'hi')
    mkdirSync(join(h.projectRoot, 'Cores'), { recursive: true })
    writeFileSync(join(h.projectRoot, 'Cores', 'research_core.db'), 'sqlite-mock')
    const result = await h.store.backupNow(PROJECT_ID)
    expect(result.ok).toBe(true)
    expect(result.commit_sha).not.toBeNull()
    // Inspect the commit's filenames.
    const out = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ])
    const files = out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
    expect(files).toContain('docs/newdoc.md')
    expect(files).toContain('Cores/research_core.db')
  })

  it('.gitignore filters node_modules + .docs-versions + log files', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.backupNow(PROJECT_ID)
    mkdirSync(join(h.projectRoot, 'node_modules', 'big-pkg'), { recursive: true })
    writeFileSync(join(h.projectRoot, 'node_modules', 'big-pkg', 'index.js'), 'x')
    mkdirSync(join(h.projectRoot, '.docs-versions'), { recursive: true })
    writeFileSync(join(h.projectRoot, '.docs-versions', 'HEAD'), 'ref: foo')
    writeFileSync(join(h.projectRoot, 'server.log'), 'noise')
    writeFileSync(join(h.projectRoot, 'real.md'), 'real')
    const result = await h.store.backupNow(PROJECT_ID)
    expect(result.commit_sha).not.toBeNull()
    const out = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ])
    const files = out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
    expect(files).toContain('real.md')
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(files.some((f) => f.startsWith('.docs-versions/'))).toBe(false)
    expect(files).not.toContain('server.log')
  })

  it('SQLite WAL files are committed (no binary exclusion at the project-backup level)', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.backupNow(PROJECT_ID)
    mkdirSync(join(h.projectRoot, 'Cores'), { recursive: true })
    writeFileSync(join(h.projectRoot, 'Cores', 'r.db'), 'sqlite')
    writeFileSync(join(h.projectRoot, 'Cores', 'r.db-wal'), 'wal')
    writeFileSync(join(h.projectRoot, 'Cores', 'r.db-shm'), 'shm')
    const result = await h.store.backupNow(PROJECT_ID)
    expect(result.commit_sha).not.toBeNull()
    const out = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ])
    const files = out.split('\n').map((s) => s.trim())
    expect(files).toContain('Cores/r.db')
    expect(files).toContain('Cores/r.db-wal')
    expect(files).toContain('Cores/r.db-shm')
  })

  it('runs only ONE backup when two concurrent backupNow calls fire', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.backupNow(PROJECT_ID)
    writeFileSync(join(h.projectRoot, 'racey.md'), 'race')
    const [a, b, c] = await Promise.all([
      h.store.backupNow(PROJECT_ID),
      h.store.backupNow(PROJECT_ID),
      h.store.backupNow(PROJECT_ID),
    ])
    // All three share the same in-flight promise, so they return
    // IDENTICAL result objects (same commit_sha or all null).
    expect(a.commit_sha).toBe(b.commit_sha)
    expect(b.commit_sha).toBe(c.commit_sha)
    // Count commits: baseline + the single concurrent backup commit.
    const out = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'log',
      '--oneline',
    ])
    const lines = out.split('\n').filter((s) => s.length > 0)
    expect(lines.length).toBe(2)
  })
})

describe('ProjectBackupStore — push pipeline', () => {
  let h: Harness
  let bareDir: string
  beforeEach(() => {
    h = makeHarness()
    bareDir = mkdtempSync(join(tmpdir(), 'p74p2-bare-'))
    // Initialize a bare repo to push against. SSH transport isn't
    // testable without a real ssh daemon, but file:// remotes exercise
    // the full ensureRemote + push flow without that.
    require('node:child_process').execFileSync(
      'git',
      ['init', '--bare', '--initial-branch=main', bareDir],
      { stdio: 'pipe' },
    )
  })
  afterEach(() => {
    cleanup(h)
    rmSync(bareDir, { recursive: true, force: true })
  })

  it('pushes to a configured (file://) remote on backupNow', async () => {
    if (!GIT_AVAILABLE) return
    // Set the remote config to point at the local bare repo. We DO
    // need to override the doPush invocation to NOT inject GIT_SSH_COMMAND
    // for a file:// URL — we'll bypass that by writing the config
    // with a 'file:' URL AND manually setting up the remote.
    h.platform.remoteState.config = {
      remote_url: `file://${bareDir}`,
      ssh_key_path: '/dev/null',
      source: 'user_connected',
      configured_at: new Date().toISOString(),
    }
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.projectRoot, 'pushable.md'), 'content')
    const result = await h.store.backupNow(PROJECT_ID)
    expect(result.ok).toBe(true)
    expect(result.commit_sha).not.toBeNull()
    expect(result.pushed).toBe(true)
    expect(result.push_error).toBeNull()
    // Bare repo should now have the same HEAD as the local repo.
    const bareHead = await git(bareDir, ['rev-parse', 'HEAD'])
    expect(bareHead.trim()).toBe(result.commit_sha!)
  })

  it('push failure does not lose the local commit', async () => {
    if (!GIT_AVAILABLE) return
    // Point at a non-existent remote.
    h.platform.remoteState.config = {
      remote_url: `file:///nonexistent-path-${Math.random()}`,
      ssh_key_path: '/dev/null',
      source: 'user_connected',
      configured_at: new Date().toISOString(),
    }
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.projectRoot, 'orphan.md'), 'data')
    const result = await h.store.backupNow(PROJECT_ID)
    expect(result.commit_sha).not.toBeNull()
    expect(result.pushed).toBe(false)
    expect(result.push_error).not.toBeNull()
    // Local commit MUST survive — verify it's reachable.
    const log = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'log',
      '--oneline',
    ])
    expect(log.includes(result.commit_sha!.slice(0, 7))).toBe(true)
  })
})

describe('ProjectBackupStore — getStatus', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('reports state=configured + remote_url=null on a fresh init with no remote', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.backupNow(PROJECT_ID)
    const status = await h.store.getStatus(PROJECT_ID)
    expect(status.state).toBe('configured')
    expect(status.remote_url).toBeNull()
    expect(status.last_commit_sha).toBeNull()
    expect(status.last_backup_at).toBeNull()
    expect(status.last_check_at).not.toBeNull()
  })

  it('reports last_commit_sha + last_backup_at after a real commit', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.backupNow(PROJECT_ID)
    writeFileSync(join(h.projectRoot, 'after.md'), 'hi')
    const result = await h.store.backupNow(PROJECT_ID)
    const status = await h.store.getStatus(PROJECT_ID)
    expect(status.state).toBe('ok')
    expect(status.last_commit_sha).toBe(result.commit_sha)
    expect(status.last_backup_at).not.toBeNull()
  })
})

describe('ProjectBackupStore — last-attempted sidecar', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('reads null when no sidecar exists yet', async () => {
    if (!GIT_AVAILABLE) return
    const at = await h.store.readLastAttemptedAt(PROJECT_ID)
    expect(at).toBeNull()
  })

  it('round-trips a wall-clock ms timestamp', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const ts = Date.now()
    await h.store.writeLastAttemptedAt(PROJECT_ID, ts)
    const read = await h.store.readLastAttemptedAt(PROJECT_ID)
    expect(read).toBe(ts)
  })
})

describe('classifyPushFailure — taxonomy', () => {
  it('classifies Permission denied (publickey) as auth', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    })
    expect(classifyPushFailure(err).code).toBe('auth')
  })
  it('classifies non-fast-forward as remote_not_empty', () => {
    const err = Object.assign(new Error('failed'), {
      stderr: '! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs',
    })
    expect(classifyPushFailure(err).code).toBe('remote_not_empty')
  })
  it('classifies GH013 / protected branch as branch_protection', () => {
    const err = Object.assign(new Error('failed'), {
      stderr: 'remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: error: cannot create or update ref refs/heads/main: protected branch.',
    })
    expect(classifyPushFailure(err).code).toBe('branch_protection')
  })
  it('classifies connection failures as transient', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), {
      stderr: 'ssh: connect to host github.com port 22: Connection timed out',
    })
    expect(classifyPushFailure(err).code).toBe('transient')
  })
  it('Argus r1 MINOR #3 — classifier matches each transient marker exactly once', () => {
    // Sanity guard against a copy-paste regression where `etimedout`
    // (or any other condition) appears twice in the OR-chain. We
    // grep the source for the markers and assert each is mentioned
    // exactly once. Resolve the source path relative to this test
    // file so the assertion survives `bun test` from any cwd.
    const fs = require('node:fs')
    const path = require('node:path')
    const srcPath = path.resolve(import.meta.dir, '..', 'git', 'project-backup-store.ts')
    const src = fs.readFileSync(srcPath, 'utf8') as string
    const fnStart = src.indexOf('export function classifyPushFailure')
    const fnEnd = src.indexOf('function isUserResolvableTransient', fnStart)
    expect(fnStart).toBeGreaterThan(0)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = src.slice(fnStart, fnEnd)
    for (const marker of [
      'etimedout',
      'connection reset',
      'temporary failure in name resolution',
      'connection refused',
      'connection timed out',
      'network is unreachable',
    ]) {
      const count = (body.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
      expect(count).toBe(1)
    }
  })
  it('falls back to unknown for unrecognized failures', () => {
    const err = Object.assign(new Error('something weird'), { stderr: 'fatal: weird stuff' })
    expect(classifyPushFailure(err).code).toBe('unknown')
  })
})

describe('ProjectBackupStore — Managed lazy provisioning', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('invokes autoProvisionProjectBackupRemote on first backup when no remote exists', async () => {
    if (!GIT_AVAILABLE) return
    let calls = 0
    h.platform.remoteState.config = null
    ;(h.platform as unknown as PlatformAdapter & { autoProvisionProjectBackupRemote: PlatformAdapter['autoProvisionProjectBackupRemote'] }).autoProvisionProjectBackupRemote = async () => {
      calls += 1
      const config: import('@neutronai/runtime/platform-adapter.ts').ProjectBackupRemoteConfig = {
        remote_url: 'git@github.com:neutron-managed/x-y-z-backup.git',
        ssh_key_path: '/tmp/none',
        source: 'managed_provisioned',
        configured_at: new Date().toISOString(),
      }
      h.platform.remoteState.config = config
      return config
    }
    h.platform.capabilitiesMut.project_backup = true
    const result = await h.store.backupNow(PROJECT_ID)
    expect(calls).toBe(1)
    // Push fails (no real remote), but the local commit + lazy
    // provisioning both ran.
    expect(result.commit_sha).toBeNull() // clean working tree
    const status = await h.store.getStatus(PROJECT_ID)
    expect(status.remote_url).toBe('git@github.com:neutron-managed/x-y-z-backup.git')
    expect(status.is_managed_remote).toBe(true)
  })
})

describe('ProjectBackupStore — restore smoke', () => {
  let h: Harness
  let bareDir: string
  beforeEach(() => {
    h = makeHarness()
    bareDir = mkdtempSync(join(tmpdir(), 'p74p2-restore-'))
    require('node:child_process').execFileSync(
      'git',
      ['init', '--bare', '--initial-branch=main', bareDir],
      { stdio: 'pipe' },
    )
  })
  afterEach(() => {
    cleanup(h)
    rmSync(bareDir, { recursive: true, force: true })
  })

  it('clones from the bare-repo remote produces the project content', async () => {
    if (!GIT_AVAILABLE) return
    h.platform.remoteState.config = {
      remote_url: `file://${bareDir}`,
      ssh_key_path: '/dev/null',
      source: 'user_connected',
      configured_at: new Date().toISOString(),
    }
    // Seed some content.
    mkdirSync(join(h.projectRoot, 'docs'), { recursive: true })
    writeFileSync(join(h.projectRoot, 'docs', 'spec.md'), '# Spec')
    mkdirSync(join(h.projectRoot, 'Cores'), { recursive: true })
    writeFileSync(join(h.projectRoot, 'Cores', 'data.db'), 'sqlite')
    const result = await h.store.backupNow(PROJECT_ID)
    expect(result.pushed).toBe(true)
    // Simulate disaster + restore.
    const restoreDir = mkdtempSync(join(tmpdir(), 'p74p2-restore-target-'))
    try {
      await execFileAsync('git', ['clone', `file://${bareDir}`, restoreDir])
      expect(existsSync(join(restoreDir, 'docs', 'spec.md'))).toBe(true)
      expect(existsSync(join(restoreDir, 'Cores', 'data.db'))).toBe(true)
      expect(existsSync(join(restoreDir, 'README.md'))).toBe(true)
    } finally {
      rmSync(restoreDir, { recursive: true, force: true })
    }
  })
})

describe('ProjectBackupStore — restore preserves uncommitted edits (Argus r1 BLOCKER #2)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('whole-project restore stashes the live dirty tree under prior_head_sha so the undo banner can walk back to it', async () => {
    if (!GIT_AVAILABLE) return
    // Snapshot A — baseline `README.md` only. The first backupNow call
    // returns commit_sha=null (the baseline commit was laid down by
    // ensureInit and the tree is already clean), so we read HEAD
    // directly to capture the snapshot SHA.
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    expect(snapshotA).toBeTruthy()

    // The user does some work — adds `notes.md` — and that work has
    // NOT yet been backed up (between 6h ticks). The next user action
    // is a "restore" to snapshot A. Without the implicit pre-restore
    // backupNow, `notes.md` would be wiped by the whole-project restore
    // and the undo banner would have no way to retrieve it.
    writeFileSync(join(h.projectRoot, 'notes.md'), 'work in progress\n')

    // Restore to snapshot A — whole-project.
    const result = await h.store.restore(PROJECT_ID, snapshotA, null)
    expect(result.snapshot_sha).toBe(snapshotA)

    // The working tree is now back at snapshot A — `notes.md` is gone.
    expect(existsSync(join(h.projectRoot, 'notes.md'))).toBe(false)

    // But the `prior_head_sha` recorded in the restore result MUST
    // reference a commit where `notes.md` IS present, so the undo
    // banner can recover it. This is the regression check — the
    // previous behavior set prior_head_sha to snapshot A itself (the
    // last backed-up commit) and the user's `notes.md` was lost.
    expect(result.prior_head_sha).not.toBe(snapshotA)
    const priorTree = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      `${result.prior_head_sha}:notes.md`,
    ])
    expect(priorTree.trim()).toBe('work in progress')
  })

  it('single-file restore commits ONLY the restored path — unrelated dirty edits are preserved on disk + captured under prior_head_sha, never bundled into the recovery commit', async () => {
    if (!GIT_AVAILABLE) return
    // Snapshot A — `foo.md` = A and `bar.md` = A.
    writeFileSync(join(h.projectRoot, 'foo.md'), 'foo A\n')
    writeFileSync(join(h.projectRoot, 'bar.md'), 'bar A\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    expect(snapshotA).toBeTruthy()

    // Snapshot B — `foo.md` = B and `bar.md` = B. The user has been
    // working since snapshot A; this is the new committed state.
    writeFileSync(join(h.projectRoot, 'foo.md'), 'foo B\n')
    writeFileSync(join(h.projectRoot, 'bar.md'), 'bar B\n')
    await h.store.backupNow(PROJECT_ID)

    // Now the user is mid-edit on `bar.md` between 6h ticks — they've
    // written `bar.md` = C in their editor but the backup hasn't run
    // again. They DO NOT want this loose edit to bleed into a restore.
    writeFileSync(join(h.projectRoot, 'bar.md'), 'bar C dirty\n')

    // Restore JUST `foo.md` to snapshot A. The single-file restore
    // contract is "other files stay untouched in the recovery commit"
    // — so the recovery commit MUST only change `foo.md`, never `bar.md`.
    const result = await h.store.restore(PROJECT_ID, snapshotA, 'foo.md')

    // The recovery commit's name-status output should list ONLY `foo.md`.
    const nameStatus = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      '--name-only',
      '--format=',
      result.recovery_commit_sha,
    ])
    const touched = nameStatus
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    expect(touched).toEqual(['foo.md'])

    // The dirty `bar.md` edit is captured at `prior_head_sha` so the
    // undo banner can recover it.
    const priorBar = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      `${result.prior_head_sha}:bar.md`,
    ])
    expect(priorBar.trim()).toBe('bar C dirty')

    // The dirty edit stays in the working tree post-restore.
    const liveBar = require('node:fs').readFileSync(
      join(h.projectRoot, 'bar.md'),
      'utf8',
    )
    expect(liveBar).toBe('bar C dirty\n')
  })
})

describe('ProjectBackupStore — concurrent backupNow during restore (Argus r2 NEW BLOCKER)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('a scheduler-tick backupNow that fires during a restore awaits the restore + leaves the recovery commit parented on prior_head_sha', async () => {
    if (!GIT_AVAILABLE) return
    // Snapshot A — baseline tree.
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    expect(snapshotA).toBeTruthy()

    // Live uncommitted edit between 6h ticks — the implicit pre-restore
    // backupNow will snapshot this into commit X (= prior_head_sha).
    writeFileSync(join(h.projectRoot, 'notes.md'), 'wip\n')

    // Widen the race window so a concurrent backupNow has time to
    // race during restore's destructive ops (read-tree → clean →
    // add → commit). Without the fix on `backupNow`, the scheduler-tick
    // backup that fires here would either (a) race on
    // `.project-backup/index.lock`, OR (b) land a backup commit BETWEEN
    // restore's read-tree and recovery commit — re-parenting the
    // recovery commit on the racing backup instead of `prior_head_sha`.
    //
    // We hook `gitExec` at the first `read-tree` call: by then the
    // implicit pre-restore backupNow has completed (so `inFlight` is
    // empty), `inFlightRestore` IS set (the restore's IIFE is mid-flight),
    // and a racing backupNow would otherwise run unimpeded.
    let racingBackup: Promise<BackupResult> | null = null
    const original = (h.store as unknown as {
      gitExec: (
        args: string[],
        opts?: { allowNonZero?: boolean; cwd?: string },
      ) => Promise<{ stdout: string; stderr: string }>
    }).gitExec.bind(h.store)
    ;(h.store as unknown as {
      gitExec: (
        args: string[],
        opts?: { allowNonZero?: boolean; cwd?: string },
      ) => Promise<{ stdout: string; stderr: string }>
    }).gitExec = async (args, opts) => {
      const result = await original(args, opts)
      if (args.includes('read-tree') && racingBackup === null) {
        // Fire the racing backup AFTER restore's read-tree has rewritten
        // the index/working tree to the snapshot but BEFORE the recovery
        // commit lands. Give it 100ms to acquire the lock + run add -A
        // (the operations that would step on restore's own add/commit
        // sequence without the fix).
        racingBackup = h.store.backupNow(PROJECT_ID)
        await new Promise((r) => setTimeout(r, 100))
      }
      return result
    }

    const restoreResult = await h.store.restore(PROJECT_ID, snapshotA, null)
    expect(racingBackup).not.toBeNull()
    const backupResult = await racingBackup!

    // 1. The racing backupNow MUST complete cleanly — no stage_failed
    //    or commit_failed from racing on `.project-backup/index.lock`.
    expect(backupResult.ok).toBe(true)
    expect(backupResult.push_error).toBeNull()

    // 2. The restore's recovery commit MUST be parented on the SAME
    //    commit captured as `prior_head_sha`. Without the fix the
    //    racing backupNow would slip a commit in between, parenting
    //    the recovery commit one step too far back and breaking the
    //    undo banner's "walk back one commit" semantics.
    const parentSha = (
      await git(h.projectRoot, [
        `--git-dir=${join(h.projectRoot, '.project-backup')}`,
        `--work-tree=${h.projectRoot}`,
        'rev-parse',
        `${restoreResult.recovery_commit_sha}^`,
      ])
    ).trim()
    expect(parentSha).toBe(restoreResult.prior_head_sha)

    // 3. `prior_head_sha` MUST still contain the user's live edit — the
    //    racing backup must not have rewritten history out from under it.
    const priorNotes = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      `${restoreResult.prior_head_sha}:notes.md`,
    ])
    expect(priorNotes.trim()).toBe('wip')
  })
})

describe('ProjectBackupStore — single-file restore on deleted-status diff row (Argus r3 BLOCKER #1)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('restoring a path that is absent at the snapshot removes it from the working tree + lands a recovery commit', async () => {
    if (!GIT_AVAILABLE) return
    // Snapshot A — baseline tree WITHOUT gone.md. The preview surface
    // generates diff rows from `HEAD..sha`, so to produce a row with
    // status='deleted' the file must exist in the live tree / at HEAD
    // but be absent at the requested snapshot.
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    expect(snapshotA).toBeTruthy()

    // Add gone.md, snapshot B (HEAD) — now gone.md exists at HEAD but
    // not at snapshotA. Previewing snapshotA from HEAD=B shows
    // gone.md status='deleted', and the UI offers "Restore this file
    // only" on that row.
    writeFileSync(join(h.projectRoot, 'gone.md'), 'gone\n')
    await h.store.backupNow(PROJECT_ID)
    expect(existsSync(join(h.projectRoot, 'gone.md'))).toBe(true)

    // Restore gone.md to its state at snapshotA. The contract: the
    // file's "state at snapshotA" IS its absence; the recovery commit
    // should reflect a deletion (not a 404).
    const result = await h.store.restore(PROJECT_ID, snapshotA, 'gone.md')

    // 1. gone.md is gone from the live working tree.
    expect(existsSync(join(h.projectRoot, 'gone.md'))).toBe(false)

    // 2. The recovery commit touches ONLY gone.md, as a deletion.
    const nameStatus = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      '--name-status',
      '--format=',
      result.recovery_commit_sha,
    ])
    const lines = nameStatus
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    expect(lines).toEqual(['D\tgone.md'])

    // 3. The prior_head_sha still has gone.md reachable so the undo
    //    banner can recover it.
    const priorGone = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      `${result.prior_head_sha}:gone.md`,
    ])
    expect(priorGone.trim()).toBe('gone')
  })
})

describe('ProjectBackupStore — single-file restore of leading-dot config files (Argus r3 BLOCKER #2)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('restores .eslintrc — a legitimately-tracked leading-dot path — without the path validator rejecting it', async () => {
    if (!GIT_AVAILABLE) return
    // Snapshot A — .eslintrc contains "rule1". The project-backup
    // .gitignore does NOT exclude .eslintrc (it only ignores .git/,
    // .docs-versions/, .project-backup/, and the build-cache dirs),
    // so the snapshot legitimately tracks the file and the preview
    // surface lists it as a restorable diff row.
    writeFileSync(join(h.projectRoot, '.eslintrc'), 'rule1\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    expect(snapshotA).toBeTruthy()

    // Snapshot B — .eslintrc changed to "rule2".
    writeFileSync(join(h.projectRoot, '.eslintrc'), 'rule2\n')
    await h.store.backupNow(PROJECT_ID)

    // Single-file restore .eslintrc to snapshot A. With the previous
    // assertSnapshotPath leading-dot rule this call would 400 with
    // invalid_snapshot_path; the loosened validator must let the
    // restore land.
    const result = await h.store.restore(PROJECT_ID, snapshotA, '.eslintrc')

    // 1. Live .eslintrc is back to "rule1".
    const liveEslint = require('node:fs').readFileSync(
      join(h.projectRoot, '.eslintrc'),
      'utf8',
    )
    expect(liveEslint).toBe('rule1\n')

    // 2. The recovery commit touches ONLY .eslintrc — leading-dot
    //    paths must thread the single-file staging path, not the
    //    whole-project add -A path.
    const nameStatus = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      `--work-tree=${h.projectRoot}`,
      'show',
      '--name-only',
      '--format=',
      result.recovery_commit_sha,
    ])
    const touched = nameStatus
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    expect(touched).toEqual(['.eslintrc'])
  })

  it('still rejects the operational sigil dirs (.git, .project-backup, .docs-versions)', async () => {
    if (!GIT_AVAILABLE) return
    // These three dirs are the snapshot's siblings — restoring under
    // any of them could corrupt git metadata. The path validator
    // keeps the leading-dot allowance from leaking into a hole.
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    for (const sigil of ['.git/HEAD', '.project-backup/HEAD', '.docs-versions/HEAD']) {
      let caught: unknown = null
      try {
        await h.store.restore(PROJECT_ID, snapshotA, sigil)
      } catch (err) {
        caught = err
      }
      expect(caught).not.toBeNull()
      expect((caught as { code?: string }).code).toBe('invalid_snapshot_path')
    }
  })
})

describe('ProjectBackupStore — concurrent restore queue (ISSUE #46)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  // ──────────────────────────────────────────────────────────────────
  // ISSUE #46 — Argus r4 MINOR carry-over from PR #301.
  //
  // Before the fix: `restore()`'s mutex-acquire and `backupNow()`'s
  // cross-serialization probe both did a single `await
  // inFlightRestore.get(project_id)` then fell through to install
  // their own op. When ≥3 restores stacked behind one in-flight op,
  // the 2nd and 3rd waiters resumed from the same await on the same
  // tick, each constructed an op, each called `inFlightRestore.set`,
  // and both races collided on the working tree / index.lock.
  //
  // The fix replaces each single-await with a `while (...) await p`
  // loop that re-reads the map after every wakeup. Below: regression
  // coverage that pins the loop behavior.
  // ──────────────────────────────────────────────────────────────────

  it('5 concurrent restores on the same project serialize cleanly + recovery commits chain back from HEAD', async () => {
    if (!GIT_AVAILABLE) return
    // Seed snapshots A, B, C — distinct trees so each restore's
    // working-tree write is observable.
    writeFileSync(join(h.projectRoot, 'state.md'), 'A\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    writeFileSync(join(h.projectRoot, 'state.md'), 'B\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotB = await headSha(h)
    writeFileSync(join(h.projectRoot, 'state.md'), 'C\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotC = await headSha(h)

    // Fire 5 simultaneous restores. The order of resolution depends on
    // which call wins the inFlightRestore.set race for R1; subsequent
    // restores queue behind it via the loop in restore().
    const targets = [snapshotA, snapshotB, snapshotA, snapshotC, snapshotB]
    const results = await Promise.all(
      targets.map((sha) => h.store.restore(PROJECT_ID, sha, null)),
    )

    expect(results).toHaveLength(5)

    // Every restore returns a valid result.
    for (const r of results) {
      expect(r.recovery_commit_sha).toMatch(/^[0-9a-f]{40}$/)
      expect(r.prior_head_sha).toMatch(/^[0-9a-f]{40}$/)
      expect(r.snapshot_sha).toMatch(/^[0-9a-f]{40}$/)
    }

    // All 5 recovery commits are distinct — if two restores raced
    // (the pre-fix bug), one would have overwritten the other's op
    // entry and we'd see fewer than 5 distinct recovery commits OR
    // duplicated shas.
    const recoveryShas = results.map((r) => r.recovery_commit_sha)
    expect(new Set(recoveryShas).size).toBe(5)

    // Walk back 5 commits from HEAD — they MUST be exactly the 5
    // recovery commits returned by the restores. If a race had let
    // two restores collide, one's recovery commit would be orphaned
    // from the chain (visible as a missing sha in the walk).
    const chain: string[] = []
    let cur = await headSha(h)
    for (let i = 0; i < 5; i++) {
      chain.push(cur)
      cur = (
        await git(h.projectRoot, [
          `--git-dir=${join(h.projectRoot, '.project-backup')}`,
          `--work-tree=${h.projectRoot}`,
          'rev-parse',
          `${cur}^`,
        ])
      ).trim()
    }
    expect(new Set(chain)).toEqual(new Set(recoveryShas))

    // Chain integrity: each commit's parent IS the next commit in the
    // chain (or the prior_head_sha of the FIRST queued restore for
    // the deepest one). Equivalent: walking N+1 steps lands on a
    // commit that is one of the prior_head_shas — proving no
    // unrelated commit slipped in via a race.
    const oneMore = (
      await git(h.projectRoot, [
        `--git-dir=${join(h.projectRoot, '.project-backup')}`,
        `--work-tree=${h.projectRoot}`,
        'rev-parse',
        `${chain[4]!}^`,
      ])
    ).trim()
    expect(results.some((r) => r.prior_head_sha === oneMore)).toBe(true)
  })

  it('5 concurrent restores on DIFFERENT projects run in parallel (no cross-project serialization)', async () => {
    if (!GIT_AVAILABLE) return
    const PIDS = ['p1', 'p2', 'p3', 'p4', 'p5'] as const
    // Seed 5 independent projects under the same owner_home.
    const snapshots: Record<string, string> = {}
    for (const pid of PIDS) {
      const projectDir = join(h.owner_home, 'Projects', pid)
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(join(projectDir, 'README.md'), `# ${pid}\n`)
      writeFileSync(join(projectDir, 'state.md'), `seed-${pid}\n`)
      await h.store.backupNow(pid)
      const headOut = await git(projectDir, [
        `--git-dir=${join(projectDir, '.project-backup')}`,
        `--work-tree=${projectDir}`,
        'rev-parse',
        'HEAD',
      ])
      snapshots[pid] = headOut.trim()
    }

    // Instrument gitExec to record the inFlightRestore map size at
    // each git invocation. Deterministic peak observation — wall-clock
    // timing is too flaky for CI.
    const peakSizes: number[] = []
    type GitExecFn = (
      args: string[],
      opts?: { allowNonZero?: boolean; cwd?: string },
    ) => Promise<{ stdout: string; stderr: string }>
    type StoreInternals = {
      gitExec: GitExecFn
      inFlightRestore: Map<string, Promise<RestoreResult>>
    }
    const internals = h.store as unknown as StoreInternals
    const original = internals.gitExec.bind(h.store)
    internals.gitExec = async (args, opts) => {
      peakSizes.push(internals.inFlightRestore.size)
      return original(args, opts)
    }

    const results = await Promise.all(
      PIDS.map((pid) => h.store.restore(pid, snapshots[pid]!, null)),
    )

    expect(results).toHaveLength(5)
    for (const r of results) {
      expect(r.recovery_commit_sha).toMatch(/^[0-9a-f]{40}$/)
    }
    // Peak concurrent restores > 1 PROVES they ran in parallel. With
    // 5 different project_ids the loop in restore() should never
    // engage (each project's inFlightRestore key is independent),
    // so the map should reach 5 at peak. Loose lower bound = 2 to
    // tolerate scheduler quirks while still catching any regression
    // that accidentally serializes across project_ids.
    expect(Math.max(...peakSizes)).toBeGreaterThan(1)
  })

  it('backupNow + 3 queued restores all complete cleanly (no stage_failed / index.lock races)', async () => {
    if (!GIT_AVAILABLE) return
    // Seed snapshots A + B for the restores to target.
    writeFileSync(join(h.projectRoot, 'state.md'), 'A\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    writeFileSync(join(h.projectRoot, 'state.md'), 'B\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotB = await headSha(h)

    // Fire a racing backupNow AFTER the FIRST restore's `read-tree`
    // has rewritten the index (so `inFlightRestore` is set for R1, and
    // R2 + R3 are queued in the loop). Use a single-fire latch so we
    // don't kick off a second racing backup on subsequent read-tree
    // calls. Counter on the outer call (the user-issued one), not the
    // implicit pre-restore backupNow.
    let racingBackup: Promise<BackupResult> | null = null
    type GitExecFn = (
      args: string[],
      opts?: { allowNonZero?: boolean; cwd?: string },
    ) => Promise<{ stdout: string; stderr: string }>
    const original = (h.store as unknown as { gitExec: GitExecFn }).gitExec.bind(h.store)
    ;(h.store as unknown as { gitExec: GitExecFn }).gitExec = async (args, opts) => {
      const result = await original(args, opts)
      if (args.includes('read-tree') && racingBackup === null) {
        racingBackup = h.store.backupNow(PROJECT_ID)
        await new Promise((r) => setTimeout(r, 100))
      }
      return result
    }

    const restores = await Promise.all([
      h.store.restore(PROJECT_ID, snapshotA, null),
      h.store.restore(PROJECT_ID, snapshotB, null),
      h.store.restore(PROJECT_ID, snapshotA, null),
    ])
    expect(racingBackup).not.toBeNull()
    const backupResult = await racingBackup!

    // The racing backupNow MUST complete cleanly — no stage_failed /
    // commit_failed from racing on `.project-backup/index.lock` with
    // any of the 3 restores' destructive ops.
    expect(backupResult.ok).toBe(true)
    expect(backupResult.push_error).toBeNull()

    // All 3 restores complete with distinct recovery commits — none
    // got clobbered by an inFlightRestore overwrite race.
    expect(restores).toHaveLength(3)
    expect(new Set(restores.map((r) => r.recovery_commit_sha)).size).toBe(3)
    for (const r of restores) {
      expect(r.recovery_commit_sha).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // ISSUE #47 — Residual same-class restore-queue race against the
  // BACKUP mutex (`inFlight`). PR #307's loop fix covered the
  // `inFlightRestore` await; the SECOND await against `inFlight` 25
  // lines below kept the same single-await fall-through pattern.
  //
  // Trigger: a non-restore-originated `backupNow` (scheduler 6h tick
  // OR admin `/run-now`) is in-flight when ≥2 restores arrive
  // concurrently. Both restores fall past the inFlightRestore loop
  // (it's empty — no restore yet), then BOTH `await inflight` on the
  // same backup promise and resume on the same tick, racing into the
  // restore IIFE on the same working tree.
  //
  // Test below seeds a long-running NON-RESTORE-originated backup
  // (instrumented gitExec stub introduces a controllable delay), fires
  // 3 concurrent restores while it's in flight, and asserts that the
  // backup's `commit` lands BEFORE any restore's destructive ops
  // begin — via gitExec call-order instrumentation. Existing test (c)
  // above primed via a restore()-triggered backupNow which only
  // exercises the inFlightRestore path — exactly the path PR #307
  // already covered. This test exercises the inFlight path that the
  // residual race hits.
  //
  // The fix is a combined loop that re-reads BOTH maps after every
  // wake; this test pins that behavior.
  // ──────────────────────────────────────────────────────────────────

  it('ISSUE #47 — non-restore-originated backupNow + 3 concurrent restores: backup commit lands before any restore destructive op + all restores serialize cleanly', async () => {
    if (!GIT_AVAILABLE) return
    // Seed snapshots A + B so the restores have valid targets.
    writeFileSync(join(h.projectRoot, 'state.md'), 'A\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotA = await headSha(h)
    writeFileSync(join(h.projectRoot, 'state.md'), 'B\n')
    await h.store.backupNow(PROJECT_ID)
    const snapshotB = await headSha(h)
    // Dirty the tree so the racing backupNow has actual work to do
    // (commit lands, exercising the index.lock contention surface).
    writeFileSync(join(h.projectRoot, 'state.md'), 'C-pre-restore\n')

    // Call-order instrumentation: every git invocation appends a
    // tagged record. Tags name the op + phase. Order-checks below
    // are deterministic — no wall-clock dependence.
    type GitExecFn = (
      args: string[],
      opts?: { allowNonZero?: boolean; cwd?: string },
    ) => Promise<{ stdout: string; stderr: string }>
    type StoreInternals = {
      gitExec: GitExecFn
      backingUp: Set<string>
      inFlight: Map<string, Promise<BackupResult>>
    }
    const internals = h.store as unknown as StoreInternals
    const original = internals.gitExec.bind(h.store)
    const log: string[] = []
    // Latch: introduce a single delay on the FIRST backup commit
    // (during the racing external backupNow) so 3 concurrent restores
    // have time to enqueue against `inFlight` before that backup
    // releases. Subsequent commits (each restore's pre-restore
    // backupNow + recovery commit) run at normal speed.
    let backupCommitDelayed = false
    internals.gitExec = async (args, opts) => {
      const phase = internals.backingUp.has(PROJECT_ID) ? 'backup' : 'restore'
      const verb = args.find((a) =>
        ['add', 'commit', 'read-tree', 'reset', 'checkout', 'rev-parse', 'cat-file', 'diff', 'rm'].includes(a),
      ) ?? args[args.length - 1]!
      log.push(`${phase}:${verb}`)
      if (
        phase === 'backup' &&
        args.includes('commit') &&
        !backupCommitDelayed
      ) {
        backupCommitDelayed = true
        // Hold the external backup's commit for long enough that all
        // 3 restores have entered the combined wait loop. 150ms is a
        // microtask-eternity; the loop spins purely on microtasks so
        // the gating window is effectively the JS event loop ticks
        // between Promise.all's parallel kick-off and each restore
        // calling `this.inFlight.get(...)`.
        await new Promise((r) => setTimeout(r, 150))
      }
      return original(args, opts)
    }

    // Fire the external (NON-restore-originated) backupNow FIRST,
    // then immediately fire 3 concurrent restores. The backup is
    // in-flight (its delayed commit is mid-await) by the time the
    // restores call `this.inFlight.get(project_id)` — they MUST
    // queue against `inFlight` via the combined loop.
    const racingBackup = h.store.backupNow(PROJECT_ID)
    // Yield one microtask so backupNow can install itself into
    // `inFlight` before the restores' first synchronous map read.
    // `backupNow`'s sync prefix (line 606-660) runs to its first
    // await (`doBackupNow` → `ensureInit` → first gitExec) before
    // returning; `setTimeout(r, 0)` here is a single macrotask hop
    // that covers that. The explicit `inFlight.has` assertion below
    // is the load-bearing gate: if a future `backupNow` refactor
    // adds a sync `await` BEFORE the `inFlight.set` (line 655), this
    // test will loud-fail with "expected true received false"
    // instead of silently passing while exercising the wrong path.
    // If that ever flakes, replace setTimeout(0) with a tight poll:
    // `while (!internals.inFlight.has(PROJECT_ID)) await new Promise(
    //   (r) => setTimeout(r, 0))`.
    await new Promise((r) => setTimeout(r, 0))
    expect(internals.inFlight.has(PROJECT_ID)).toBe(true)

    const restores = await Promise.all([
      h.store.restore(PROJECT_ID, snapshotA, null),
      h.store.restore(PROJECT_ID, snapshotB, null),
      h.store.restore(PROJECT_ID, snapshotA, null),
    ])
    const backupResult = await racingBackup

    // Backup completed cleanly — no stage_failed / commit_failed.
    expect(backupResult.ok).toBe(true)
    expect(backupResult.push_error).toBeNull()

    // All 3 restores returned valid distinct results.
    expect(restores).toHaveLength(3)
    for (const r of restores) {
      expect(r.recovery_commit_sha).toMatch(/^[0-9a-f]{40}$/)
      expect(r.prior_head_sha).toMatch(/^[0-9a-f]{40}$/)
    }
    expect(new Set(restores.map((r) => r.recovery_commit_sha)).size).toBe(3)

    // Backup-then-restore ordering: the external backup's `commit`
    // tag MUST appear in the call log BEFORE the first restore-phase
    // destructive op (`read-tree` for whole-project restore). If the
    // pre-fix bug had let the 2nd / 3rd restore slip past the single
    // `await inflight`, we'd see a `restore:read-tree` interleaved
    // with backup-phase ops.
    const firstBackupCommitIdx = log.findIndex((e) => e === 'backup:commit')
    const firstRestoreReadTreeIdx = log.findIndex(
      (e) => e === 'restore:read-tree',
    )
    expect(firstBackupCommitIdx).toBeGreaterThanOrEqual(0)
    expect(firstRestoreReadTreeIdx).toBeGreaterThanOrEqual(0)
    expect(firstBackupCommitIdx).toBeLessThan(firstRestoreReadTreeIdx)

    // Recovery commit chain integrity: walk 3 commits back from HEAD
    // — they MUST be exactly the 3 recovery commits (no race-induced
    // orphans / clobbered slots).
    const recoveryShas = restores.map((r) => r.recovery_commit_sha)
    const chain: string[] = []
    let cur = await headSha(h)
    for (let i = 0; i < 3; i++) {
      chain.push(cur)
      cur = (
        await git(h.projectRoot, [
          `--git-dir=${join(h.projectRoot, '.project-backup')}`,
          `--work-tree=${h.projectRoot}`,
          'rev-parse',
          `${cur}^`,
        ])
      ).trim()
    }
    expect(new Set(chain)).toEqual(new Set(recoveryShas))
  })
})

afterAll(() => {
  // tmp dirs are cleaned in afterEach
})
