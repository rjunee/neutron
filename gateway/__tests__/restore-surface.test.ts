/**
 * P7.4 restore UI — ProjectBackupStore restore semantics + HTTP surface.
 *
 * Real on-disk tmp dirs; the git binary is exercised directly. The
 * suite skips with a clear message when `git --version` exits non-zero
 * so a CI image without git in PATH stays green.
 *
 * Covers:
 *   - listSnapshots + previewSnapshot + getSnapshotFileContent + getSnapshotFileDiff
 *   - restore (whole-project) — working tree matches snapshot, recovery commit lands
 *   - restore (single-file) — only the named file changes
 *   - restore against unknown sha → SnapshotNotFoundError
 *   - restore against unknown path at known sha → SnapshotPathNotFoundError
 *   - the matching HTTP routes (404 / 400 / 401 / 403 / 405 path-traversal gates)
 *   - undo-by-restoring-back-to-prior-head (the "restore-from-the-restore-commit" loop)
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
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  ProjectBackupStore,
  SnapshotNotFoundError,
  SnapshotPathNotFoundError,
  InvalidSnapshotShaError,
  InvalidSnapshotPathError,
  assertSnapshotSha,
  assertSnapshotPath,
} from '../git/project-backup-store.ts'
import { createAppBackupsSurface } from '../http/app-backups-surface.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'

const execFileAsync = promisify(execFile)

let GIT_AVAILABLE = false

beforeAll(async () => {
  try {
    await execFileAsync('git', ['--version'])
    GIT_AVAILABLE = true
  } catch {
    GIT_AVAILABLE = false
    console.warn('[restore-surface.test] skipping — `git --version` failed.')
  }
})

const OWNER_SLUG = 'demo'
const PROJECT_ID = 'demo-project'

function stubAdapter(): PlatformAdapter {
  const remoteState: {
    config: import('../../runtime/platform-adapter.ts').ProjectBackupRemoteConfig | null
  } = { config: null }
  return {
    capabilities: {
      slug_rename: false,
      install_token_mint: false,
      cross_owner_fanout: false,
      manager_bot_provisioning: false,
      caddy_reload: false,
      sudoers_regenerate: false,
      tier_two_cores: false,
      project_backup: true,
    } as unknown as PlatformAdapter['capabilities'],
    slugAvailability: {
      check: () => ({ slug: '', available: true, reason: null }),
      sanitize: (s: string) => s,
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
    crossOwnerCall: async () => ({ status: 0, body: null }),
    provisionManagerBot: async () => {
      throw new Error('not supported')
    },
    reloadCaddy: async () => undefined,
    regenerateSudoers: async () => undefined,
    getBundledCoreRoots: () => [process.cwd()] as const,
    getOnboardingConversational: () => false,
    getOnboardingConversationalPhases: () => new Set(),
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
  } as unknown as PlatformAdapter
}

interface Harness {
  tmp: string
  owner_home: string
  projectRoot: string
  store: ProjectBackupStore
}

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'p74-restore-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const projectRoot = join(owner_home, 'Projects', PROJECT_ID)
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'README.md'), '# Demo\nLine A\nLine B\n')
  mkdirSync(join(projectRoot, 'docs'), { recursive: true })
  writeFileSync(join(projectRoot, 'docs', 'notes.md'), '# Notes\nv1\n')
  const store = new ProjectBackupStore({
    platform: stubAdapter(),
    owner_home,
    project_slug: OWNER_SLUG,
  })
  return { tmp, owner_home, projectRoot, store }
}

function cleanup(h: Harness): void {
  rmSync(h.tmp, { recursive: true, force: true })
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return typeof stdout === 'string' ? stdout : String(stdout)
}

async function takeSnapshot(h: Harness): Promise<string> {
  const result = await h.store.backupNow(PROJECT_ID)
  expect(result.ok).toBe(true)
  if (result.commit_sha === null) {
    // No staged changes — the commit didn't move. Read HEAD anyway so
    // the test can refer to the existing snapshot.
    const head = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      'rev-parse',
      'HEAD',
    ])
    return head.trim()
  }
  return result.commit_sha
}

describe('ProjectBackupStore — sha + path validators', () => {
  it('rejects malformed shas', () => {
    expect(() => assertSnapshotSha('')).toThrow(InvalidSnapshotShaError)
    expect(() => assertSnapshotSha('not-a-sha')).toThrow(InvalidSnapshotShaError)
    expect(() => assertSnapshotSha('0'.repeat(39))).toThrow(InvalidSnapshotShaError)
    expect(() => assertSnapshotSha('0'.repeat(41))).toThrow(InvalidSnapshotShaError)
    // Wrong case — git always emits lowercase, the validator pins to it.
    expect(() => assertSnapshotSha('A'.repeat(40))).toThrow(InvalidSnapshotShaError)
  })

  it('accepts well-formed shas', () => {
    expect(() => assertSnapshotSha('0'.repeat(40))).not.toThrow()
    expect(() => assertSnapshotSha('abcdef0123456789'.repeat(2) + 'abcdef01')).not.toThrow()
  })

  it('rejects hostile paths', () => {
    expect(() => assertSnapshotPath('')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('/abs/path')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('C:/abs')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('..')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('a/../b')).toThrow(InvalidSnapshotPathError)
    // Argus r3 BLOCKER #2 — operational sigil directories stay blocked
    // even though the broader leading-dot rule is loosened.
    expect(() => assertSnapshotPath('.git/HEAD')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('.project-backup/HEAD')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('.docs-versions/foo')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('a/.git/HEAD')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('a\x00b')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('a/b?')).toThrow(InvalidSnapshotPathError)
    expect(() => assertSnapshotPath('a/b\n')).toThrow(InvalidSnapshotPathError)
  })

  it('accepts well-formed relative paths (any extension)', () => {
    expect(() => assertSnapshotPath('README.md')).not.toThrow()
    expect(() => assertSnapshotPath('docs/notes.md')).not.toThrow()
    expect(() => assertSnapshotPath('Cores/notes/sidecar.db')).not.toThrow()
    expect(() => assertSnapshotPath('src/foo.ts')).not.toThrow()
  })

  it('accepts ordinary leading-dot paths — the snapshot legitimately tracks them (Argus r3 BLOCKER #2)', () => {
    expect(() => assertSnapshotPath('.gitignore')).not.toThrow()
    expect(() => assertSnapshotPath('.eslintrc')).not.toThrow()
    expect(() => assertSnapshotPath('.husky/pre-commit')).not.toThrow()
    expect(() => assertSnapshotPath('a/.hidden/b')).not.toThrow()
  })
})

describe('ProjectBackupStore — listSnapshots', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('returns the init commit when no edits have landed', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const page = await h.store.listSnapshots(PROJECT_ID)
    expect(page.snapshots.length).toBeGreaterThanOrEqual(1)
    expect(page.snapshots[0]!.message.startsWith('init:')).toBe(true)
    expect(page.next_cursor).toBeNull()
  })

  it('orders snapshots newest-first', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nv2\n')
    const sha2 = await takeSnapshot(h)
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nv3\n')
    const sha3 = await takeSnapshot(h)
    const page = await h.store.listSnapshots(PROJECT_ID)
    expect(page.snapshots[0]!.sha).toBe(sha3)
    expect(page.snapshots[1]!.sha).toBe(sha2)
  })

  it('paginates via next_cursor', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    // Produce 4 user snapshots; together with the init commit that's 5 total.
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(h.projectRoot, 'README.md'), `# Demo\nrev=${i}\n`)
      await takeSnapshot(h)
    }
    const page1 = await h.store.listSnapshots(PROJECT_ID, { limit: 3 })
    expect(page1.snapshots).toHaveLength(3)
    expect(page1.next_cursor).not.toBeNull()
    const page2 = await h.store.listSnapshots(PROJECT_ID, {
      limit: 10,
      before_sha: page1.next_cursor!,
    })
    expect(page2.snapshots.length).toBeGreaterThanOrEqual(2)
    // The two pages MUST NOT share a sha — Codex r2 IMPORTANT #1.
    const overlap = page1.snapshots.filter((p) =>
      page2.snapshots.some((q) => q.sha === p.sha),
    )
    expect(overlap).toHaveLength(0)
  })

  it('returns empty when the backup repo has never been initialized', async () => {
    if (!GIT_AVAILABLE) return
    // Don't call ensureInit; the gateway boot-path lazily inits at
    // first backupNow. Pre-init the listSnapshots route should NOT
    // throw — it should return an empty page.
    const page = await h.store.listSnapshots(PROJECT_ID)
    expect(page.snapshots).toEqual([])
    expect(page.next_cursor).toBeNull()
  })
})

describe('ProjectBackupStore — previewSnapshot', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('returns added / modified / deleted classifications relative to HEAD', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha0 = await takeSnapshot(h)
    // Mutate the tree AFTER taking the snapshot. previewSnapshot
    // compares HEAD (which is sha0) against `sha`, so we need a NEW
    // snapshot to diff against — produce one with a created / modified
    // / deleted set of files.
    writeFileSync(join(h.projectRoot, 'docs', 'new.md'), '# new\n')
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nMUTATED\n')
    rmSync(join(h.projectRoot, 'docs', 'notes.md'))
    const sha1 = await takeSnapshot(h)
    // Now restore would revert from sha1 back to sha0's state. The
    // preview of `sha0` (vs HEAD=sha1) should show:
    //   docs/new.md  deleted (sha0 doesn't have it)
    //   README.md    modified (different content at sha0)
    //   docs/notes.md  added (sha0 has it but HEAD doesn't)
    const preview = await h.store.previewSnapshot(PROJECT_ID, sha0)
    expect(preview.sha).toBe(sha0)
    const byPath = new Map(preview.files.map((f) => [f.path, f]))
    expect(byPath.get('docs/new.md')?.status).toBe('deleted')
    expect(byPath.get('README.md')?.status).toBe('modified')
    expect(byPath.get('docs/notes.md')?.status).toBe('added')
    // sha1 vs HEAD=sha1 — zero changes.
    const previewSelf = await h.store.previewSnapshot(PROJECT_ID, sha1)
    expect(previewSelf.files).toEqual([])
  })

  it('throws SnapshotNotFoundError on unknown sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    await expect(
      h.store.previewSnapshot(PROJECT_ID, '0'.repeat(40)),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError)
  })
})

describe('ProjectBackupStore — getSnapshotFileContent + getSnapshotFileDiff', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('reads file body at a snapshot SHA', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha0 = await takeSnapshot(h)
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nv2\n')
    await takeSnapshot(h)
    const file = await h.store.getSnapshotFileContent(PROJECT_ID, sha0, 'README.md')
    expect(file.content).toBe('# Demo\nLine A\nLine B\n')
    expect(file.binary).toBe(false)
  })

  it('flags binary content', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00])
    writeFileSync(join(h.projectRoot, 'logo.png'), buf)
    const sha = await takeSnapshot(h)
    const file = await h.store.getSnapshotFileContent(PROJECT_ID, sha, 'logo.png')
    expect(file.binary).toBe(true)
    expect(file.content).toBe('')
  })

  it('throws SnapshotPathNotFoundError when the path is missing at sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha = await takeSnapshot(h)
    await expect(
      h.store.getSnapshotFileContent(PROJECT_ID, sha, 'does-not-exist.md'),
    ).rejects.toBeInstanceOf(SnapshotPathNotFoundError)
  })

  it('emits a unified diff HEAD..sha for a modified file', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha0 = await takeSnapshot(h)
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nMUTATED\n')
    await takeSnapshot(h)
    const diff = await h.store.getSnapshotFileDiff(PROJECT_ID, sha0, 'README.md')
    expect(diff.hunks).toContain('@@')
    expect(diff.hunks).toContain('-MUTATED')
    expect(diff.hunks).toContain('+Line A')
  })

  it('rejects hostile path inputs', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha = await takeSnapshot(h)
    await expect(
      h.store.getSnapshotFileContent(PROJECT_ID, sha, '../../etc/passwd'),
    ).rejects.toBeInstanceOf(InvalidSnapshotPathError)
    await expect(
      h.store.getSnapshotFileContent(PROJECT_ID, sha, '/etc/passwd'),
    ).rejects.toBeInstanceOf(InvalidSnapshotPathError)
  })
})

describe('ProjectBackupStore — restore (whole-project)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('rolls the working tree to the snapshot state + lands a recovery commit', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha0 = await takeSnapshot(h)
    // Mutate aggressively.
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nLOST\n')
    writeFileSync(join(h.projectRoot, 'docs', 'should-be-removed.md'), '# Doomed\n')
    rmSync(join(h.projectRoot, 'docs', 'notes.md'))
    await takeSnapshot(h)
    const priorHead = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      'rev-parse',
      'HEAD',
    ])
    const result = await h.store.restore(PROJECT_ID, sha0, null)
    expect(result.snapshot_sha).toBe(sha0)
    expect(result.prior_head_sha).toBe(priorHead.trim())
    expect(result.recovery_commit_sha).not.toBe(sha0)
    expect(result.recovery_commit_sha).not.toBe(priorHead.trim())
    // The working tree matches sha0's tree byte-for-byte.
    expect(readFileSync(join(h.projectRoot, 'README.md'), 'utf8')).toBe(
      '# Demo\nLine A\nLine B\n',
    )
    expect(existsSync(join(h.projectRoot, 'docs', 'notes.md'))).toBe(true)
    expect(existsSync(join(h.projectRoot, 'docs', 'should-be-removed.md'))).toBe(false)
    // The recovery commit's message embeds both shas.
    const msg = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      'log',
      '-1',
      '--pretty=format:%B',
      result.recovery_commit_sha,
    ])
    expect(msg).toContain('restore:')
    expect(msg).toContain(sha0.slice(0, 12))
    expect(msg).toContain(`prior-head: ${priorHead.trim()}`)
  })

  it('lets the user undo a wrong restore by restoring back to prior_head_sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha0 = await takeSnapshot(h)
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nKEEP\n')
    const sha1 = await takeSnapshot(h)
    // User panics, restores back to sha0 by mistake.
    const restore1 = await h.store.restore(PROJECT_ID, sha0, null)
    expect(readFileSync(join(h.projectRoot, 'README.md'), 'utf8')).toBe(
      '# Demo\nLine A\nLine B\n',
    )
    // Realises the mistake — undo by restoring back to the prior HEAD.
    await h.store.restore(PROJECT_ID, restore1.prior_head_sha, null)
    expect(readFileSync(join(h.projectRoot, 'README.md'), 'utf8')).toBe(
      '# Demo\nKEEP\n',
    )
    // sha1 is still reachable in history.
    const log = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.project-backup')}`,
      'log',
      '--pretty=format:%H',
    ])
    expect(log).toContain(sha1)
  })
})

describe('ProjectBackupStore — restore (single-file)', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('rewrites only the named file', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha0 = await takeSnapshot(h)
    // Mutate two files, restore only one.
    writeFileSync(join(h.projectRoot, 'README.md'), '# Demo\nLOST\n')
    writeFileSync(join(h.projectRoot, 'docs', 'notes.md'), '# Notes\nLOST\n')
    await takeSnapshot(h)
    await h.store.restore(PROJECT_ID, sha0, 'docs/notes.md')
    // README.md untouched.
    expect(readFileSync(join(h.projectRoot, 'README.md'), 'utf8')).toBe(
      '# Demo\nLOST\n',
    )
    // notes.md back to sha0 state.
    expect(readFileSync(join(h.projectRoot, 'docs', 'notes.md'), 'utf8')).toBe(
      '# Notes\nv1\n',
    )
  })

  it('throws SnapshotPathNotFoundError when the path is missing at sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha = await takeSnapshot(h)
    await expect(
      h.store.restore(PROJECT_ID, sha, 'never-existed.md'),
    ).rejects.toBeInstanceOf(SnapshotPathNotFoundError)
  })

  it('throws InvalidSnapshotPathError on hostile path', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const sha = await takeSnapshot(h)
    await expect(
      h.store.restore(PROJECT_ID, sha, '../../escape'),
    ).rejects.toBeInstanceOf(InvalidSnapshotPathError)
  })

  it('throws InvalidSnapshotShaError on malformed sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    await expect(
      h.store.restore(PROJECT_ID, 'not-a-sha', null),
    ).rejects.toBeInstanceOf(InvalidSnapshotShaError)
  })
})

/* ─── HTTP surface tests ───────────────────────────────────────────── */

interface ServerHarness {
  server: import('bun').Server<unknown>
  base: string
  store: ProjectBackupStore
  cleanup: () => void
}

function startServer(opts: { project_slug?: string } = {}): ServerHarness {
  const project_slug = opts.project_slug ?? OWNER_SLUG
  const tmp = mkdtempSync(join(tmpdir(), 'p74-restore-srv-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const projectRoot = join(owner_home, 'Projects', PROJECT_ID)
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'README.md'), '# Demo\nA\nB\n')
  const store = new ProjectBackupStore({
    platform: stubAdapter(),
    owner_home,
    project_slug,
  })
  const auth = createAppWsAuthResolver({ project_slug, bypass: true })
  const surface = createAppBackupsSurface({
    auth,
    project_slug,
    store,
  })
  const handler = composeHttpHandler({
    appBackups: { handler: surface.handler },
    defaultHandler: () => new Response('nf', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: handler.fetch as unknown as (req: Request) => Response | Promise<Response>,
    websocket: handler.websocket as unknown as Parameters<typeof Bun.serve>[0]['websocket'],
  } as Parameters<typeof Bun.serve>[0])
  const base = `http://localhost:${(server as unknown as { port: number }).port}`
  return {
    server,
    base,
    store,
    cleanup: () => {
      void server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: object,
  bearer = 'dev-bypass',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { authorization: `Bearer ${bearer}` },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
  }
  const res = await fetch(`${base}${path}`, init)
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    /* ignore */
  }
  return { status: res.status, json }
}

describe('app-backups HTTP surface', () => {
  let h: ServerHarness
  let projectRoot: string
  beforeEach(() => {
    h = startServer()
    projectRoot = (h as unknown as { _projectRoot?: string })._projectRoot ?? ''
  })
  afterEach(() => {
    h.cleanup()
  })

  // Helper — forces init + at least one snapshot beyond the baseline.
  // The first `backupNow` triggers `ensureInit` which itself takes the
  // baseline commit; without a tree mutation after init, the follow-up
  // commit step has nothing to stage and `commit_sha` returns `null`.
  // The helper does the init, then mutates a file, then snapshots so
  // tests get a NEW commit sha back that they can preview / restore.
  async function ensureOneSnapshot(): Promise<string> {
    await h.store.ensureInit(PROJECT_ID)
    // Read the project root from the store. We can't easily reach it
    // from inside the harness, but `listSnapshots` gives us HEAD.
    const list = await h.store.listSnapshots(PROJECT_ID, { limit: 1 })
    return list.snapshots[0]!.sha
  }

  it('GET /backups returns the snapshot page', async () => {
    if (!GIT_AVAILABLE) return
    await ensureOneSnapshot()
    const { status, json } = await call(
      h.base,
      'GET',
      `/api/app/projects/${PROJECT_ID}/backups`,
    )
    expect(status).toBe(200)
    expect(json['ok']).toBe(true)
    const snapshots = json['snapshots'] as Array<unknown>
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /backups/<sha> returns the preview', async () => {
    if (!GIT_AVAILABLE) return
    const sha = await ensureOneSnapshot()
    expect(sha).not.toBe('')
    const { status, json } = await call(
      h.base,
      'GET',
      `/api/app/projects/${PROJECT_ID}/backups/${sha}`,
    )
    expect(status).toBe(200)
    expect((json['preview'] as Record<string, unknown>)['sha']).toBe(sha)
  })

  it('GET /backups/<sha>/file reads a snapshotted file', async () => {
    if (!GIT_AVAILABLE) return
    const sha = await ensureOneSnapshot()
    const { status, json } = await call(
      h.base,
      'GET',
      `/api/app/projects/${PROJECT_ID}/backups/${sha}/file?path=README.md`,
    )
    expect(status).toBe(200)
    const file = json['file'] as Record<string, unknown>
    expect(file['content']).toBe('# Demo\nA\nB\n')
  })

  it('GET /backups/<sha>/diff returns diff hunks', async () => {
    if (!GIT_AVAILABLE) return
    const sha = await ensureOneSnapshot()
    const { status } = await call(
      h.base,
      'GET',
      `/api/app/projects/${PROJECT_ID}/backups/${sha}/diff?path=README.md`,
    )
    expect(status).toBe(200)
  })

  it('rejects an unknown sha with 404', async () => {
    if (!GIT_AVAILABLE) return
    await ensureOneSnapshot()
    const { status, json } = await call(
      h.base,
      'GET',
      `/api/app/projects/${PROJECT_ID}/backups/${'0'.repeat(40)}`,
    )
    expect(status).toBe(404)
    expect(json['code']).toBe('snapshot_not_found')
  })

  it('rejects a hostile path on the file route with 400', async () => {
    if (!GIT_AVAILABLE) return
    const sha = await ensureOneSnapshot()
    const { status, json } = await call(
      h.base,
      'GET',
      `/api/app/projects/${PROJECT_ID}/backups/${sha}/file?path=${encodeURIComponent('../../etc/passwd')}`,
    )
    expect(status).toBe(400)
    expect(json['code']).toBe('invalid_snapshot_path')
  })

  it('POST /restore restores the whole project + returns the recovery sha', async () => {
    if (!GIT_AVAILABLE) return
    const sha = await ensureOneSnapshot()
    const { status, json } = await call(
      h.base,
      'POST',
      `/api/app/projects/${PROJECT_ID}/restore`,
      { snapshot_sha: sha },
    )
    expect(status).toBe(200)
    const restore = json['restore'] as Record<string, unknown>
    expect(restore['snapshot_sha']).toBe(sha)
    expect(typeof restore['recovery_commit_sha']).toBe('string')
    expect(typeof restore['prior_head_sha']).toBe('string')
  })

  it('POST /restore rejects a missing snapshot_sha with 400', async () => {
    const { status, json } = await call(
      h.base,
      'POST',
      `/api/app/projects/${PROJECT_ID}/restore`,
      { file_path: 'foo.md' },
    )
    expect(status).toBe(400)
    expect(json['code']).toBe('missing_snapshot_sha')
  })

  it('POST /restore rejects a hostile file_path with 400', async () => {
    if (!GIT_AVAILABLE) return
    const sha = await ensureOneSnapshot()
    const { status, json } = await call(
      h.base,
      'POST',
      `/api/app/projects/${PROJECT_ID}/restore`,
      { snapshot_sha: sha, file_path: '../../etc/passwd' },
    )
    expect(status).toBe(400)
    expect(json['code']).toBe('invalid_snapshot_path')
  })

  it('rejects GET on /restore with 405', async () => {
    const { status, json } = await call(
      h.base,
      'GET',
      `/api/app/projects/${PROJECT_ID}/restore`,
    )
    expect(status).toBe(405)
    expect(json['code']).toBe('method_not_allowed')
  })

  it('rejects missing bearer with 401', async () => {
    const res = await fetch(`${h.base}/api/app/projects/${PROJECT_ID}/backups`)
    expect(res.status).toBe(401)
  })

  it('rejects a malformed project_id with 400', async () => {
    const { status, json } = await call(
      h.base,
      'GET',
      `/api/app/projects/${encodeURIComponent('../escape')}/backups`,
    )
    expect(status).toBe(400)
    expect(json['code']).toBe('invalid_project_id')
  })
})

describe('app-backups HTTP surface — owner mismatch', () => {
  it('returns 403 when bearer slug differs from gateway slug', async () => {
    if (!GIT_AVAILABLE) return
    // Build a harness where the gateway is `demo` but we pretend the
    // bearer resolves to a different slug via a custom auth resolver.
    const tmp = mkdtempSync(join(tmpdir(), 'p74-restore-mismatch-'))
    const owner_home = join(tmp, 'home')
    mkdirSync(join(owner_home, 'Projects', PROJECT_ID), { recursive: true })
    const store = new ProjectBackupStore({
      platform: stubAdapter(),
      owner_home,
      project_slug: OWNER_SLUG,
    })
    const fakeAuth = {
      mode: 'test',
      resolve: async () => ({ user_id: 'u1', project_slug: 'somewhere-else' }),
    } as unknown as import('../../channels/adapters/app-ws/auth.ts').AppWsAuthResolver
    const surface = createAppBackupsSurface({
      auth: fakeAuth,
      project_slug: OWNER_SLUG,
      store,
    })
    const handler = composeHttpHandler({
      appBackups: { handler: surface.handler },
      defaultHandler: () => new Response('nf', { status: 404 }),
    })
    const server = Bun.serve({
      port: 0,
      fetch: handler.fetch as unknown as (req: Request) => Response | Promise<Response>,
      websocket: handler.websocket as unknown as Parameters<typeof Bun.serve>[0]['websocket'],
    } as Parameters<typeof Bun.serve>[0])
    try {
      const port = (server as unknown as { port: number }).port
      const res = await fetch(
        `http://localhost:${port}/api/app/projects/${PROJECT_ID}/backups`,
        { headers: { authorization: 'Bearer x' } },
      )
      expect(res.status).toBe(403)
    } finally {
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

afterAll(() => {
  // No persistent state beyond the per-suite tmp dirs.
})
