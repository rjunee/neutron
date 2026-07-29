/**
 * P7.4 Phase 1 — DocVersionStore unit + failure-mode + concurrency tests.
 *
 * Real on-disk tmp dirs; the git binary is exercised directly. The
 * suite skips with a clear message when `git --version` exits non-zero
 * so a CI image without git in PATH stays green but a developer sees
 * the skip line and can install git locally.
 *
 * Coverage:
 *   - init (idempotent, identity, .gitignore content, deferred when
 *     docs/ doesn't exist)
 *   - commit shapes for create / edit / delete / rename / revert
 *   - history pagination + cursor + empty-path no-op
 *   - read_at + author metadata
 *   - revertContent + revertContent of a deleted path
 *   - diff (sha-to-sha, sha-to-head, truncation)
 *   - failure modes: git missing, repo corruption recovery, concurrent
 *     first-init coalescing, concurrent multi-path commit (no
 *     index.lock race)
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  DOC_VERSION_GITIGNORE,
  DocVersionStore,
  InvalidShaError,
  UnknownShaError,
  VersionNotFoundError,
  VersioningUnavailableError,
  formatCommitMessage,
} from '../git/doc-version-store.ts'

const execFileAsync = promisify(execFile)

let GIT_AVAILABLE = false

beforeAll(async () => {
  try {
    await execFileAsync('git', ['--version'])
    GIT_AVAILABLE = true
  } catch {
    GIT_AVAILABLE = false
    console.warn(
      '[doc-version-store.test] skipping — `git --version` failed. Install git locally to run this suite.',
    )
  }
})

interface Harness {
  tmp: string
  owner_home: string
  projectRoot: string
  docsRoot: string
  store: DocVersionStore
}

const PROJECT_SLUG = 'demo'
const PROJECT_ID = 'demo-project'

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'p74-version-store-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const projectRoot = join(owner_home, 'Projects', PROJECT_ID)
  mkdirSync(projectRoot, { recursive: true })
  const docsRoot = join(projectRoot, 'docs')
  mkdirSync(docsRoot, { recursive: true })
  const store = new DocVersionStore({
    owner_home,
    project_slug: PROJECT_SLUG,
  })
  return { tmp, owner_home, projectRoot, docsRoot, store }
}

function cleanup(h: Harness): void {
  rmSync(h.tmp, { recursive: true, force: true })
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

/** Read the current HEAD sha from inside the bare-style dir. */
async function headSha(h: Harness): Promise<string> {
  const out = await git(h.projectRoot, [
    `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
    `--work-tree=${h.docsRoot}`,
    'rev-parse',
    'HEAD',
  ])
  return out.trim()
}

describe('DocVersionStore — init + identity', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('creates .docs-versions/ with HEAD + refs + objects on first init', async () => {
    if (!GIT_AVAILABLE) return
    const ready = await h.store.ensureInit(PROJECT_ID)
    expect(ready).toBe(true)
    const gitDir = join(h.projectRoot, '.docs-versions')
    expect(existsSync(join(gitDir, 'HEAD'))).toBe(true)
    expect(existsSync(join(gitDir, 'objects'))).toBe(true)
    expect(existsSync(join(gitDir, 'refs', 'heads', 'main'))).toBe(true)
  })

  it('is idempotent — second call is a no-op', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const firstHead = await headSha(h)
    await h.store.ensureInit(PROJECT_ID)
    const secondHead = await headSha(h)
    expect(secondHead).toBe(firstHead)
  })

  it('defers init when docs/ does not exist yet', async () => {
    if (!GIT_AVAILABLE) return
    rmSync(h.docsRoot, { recursive: true, force: true })
    const ready = await h.store.ensureInit(PROJECT_ID)
    expect(ready).toBe(false)
    expect(existsSync(join(h.projectRoot, '.docs-versions', 'HEAD'))).toBe(false)
  })

  it('writes .gitignore matching the pinned spec block', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const gitignorePath = join(h.docsRoot, '.gitignore')
    expect(existsSync(gitignorePath)).toBe(true)
    const content = readFileSync(gitignorePath, 'utf8')
    expect(content).toBe(DOC_VERSION_GITIGNORE)
  })

  it('seeds the synthetic per-project identity on the init commit', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    const out = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
      `--work-tree=${h.docsRoot}`,
      'log',
      '-1',
      '--pretty=format:%an <%ae>',
    ])
    expect(out.trim()).toBe(`Neutron Agent <neutron@${PROJECT_SLUG}.local>`)
  })

  it('captures pre-existing docs content in the init baseline commit', async () => {
    if (!GIT_AVAILABLE) return
    writeFileSync(join(h.docsRoot, 'README.md'), '# Pre-existing')
    await h.store.ensureInit(PROJECT_ID)
    const out = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
      `--work-tree=${h.docsRoot}`,
      'show',
      '--name-only',
      '--pretty=format:',
      'HEAD',
    ])
    // Should list README.md and .gitignore.
    const files = out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
    expect(files).toContain('README.md')
    expect(files).toContain('.gitignore')
  })
})

describe('DocVersionStore — commit shapes', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('shapes a create commit message as `create: <path>`', async () => {
    if (!GIT_AVAILABLE) return
    // Real DocStore flow: init runs BEFORE the file lands so init
    // captures only pre-existing content; subsequent commit() picks
    // up the new file as a real diff.
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'notes.md'), 'hello')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'notes.md' })
    const subject = (
      await git(h.projectRoot, [
        `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
        `--work-tree=${h.docsRoot}`,
        'log',
        '-1',
        '--pretty=format:%s',
      ])
    ).trim()
    expect(subject).toBe('create: notes.md')
  })

  it('shapes an edit commit message as `edit: <path>`', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'notes.md'), 'first')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'notes.md' })
    writeFileSync(join(h.docsRoot, 'notes.md'), 'second')
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'notes.md' })
    const subject = (
      await git(h.projectRoot, [
        `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
        `--work-tree=${h.docsRoot}`,
        'log',
        '-1',
        '--pretty=format:%s',
      ])
    ).trim()
    expect(subject).toBe('edit: notes.md')
  })

  it('records a delete as `delete: <path>` and the file is gone at HEAD', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'notes.md'), 'gone soon')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'notes.md' })
    rmSync(join(h.docsRoot, 'notes.md'))
    await h.store.commit(PROJECT_ID, { op: 'delete', path: 'notes.md' })
    const subject = (
      await git(h.projectRoot, [
        `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
        `--work-tree=${h.docsRoot}`,
        'log',
        '-1',
        '--pretty=format:%s',
      ])
    ).trim()
    expect(subject).toBe('delete: notes.md')
    const ls = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
      `--work-tree=${h.docsRoot}`,
      'ls-files',
    ])
    expect(ls).not.toContain('notes.md')
  })

  it('records a rename as `rename: <from> -> <to>`', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'old.md'), 'body')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'old.md' })
    // Simulate the doc-store's rename: actual fs rename has already
    // happened by the time `commit` is called.
    rmSync(join(h.docsRoot, 'old.md'))
    writeFileSync(join(h.docsRoot, 'new.md'), 'body')
    await h.store.commit(PROJECT_ID, { op: 'rename', from: 'old.md', to: 'new.md' })
    const subject = (
      await git(h.projectRoot, [
        `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
        `--work-tree=${h.docsRoot}`,
        'log',
        '-1',
        '--pretty=format:%s',
      ])
    ).trim()
    expect(subject).toBe('rename: old.md -> new.md')
  })

  it('shapes a revert commit message with the short sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'r.md'), 'v1')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'r.md' })
    const target = await headSha(h)
    writeFileSync(join(h.docsRoot, 'r.md'), 'v2')
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'r.md' })
    writeFileSync(join(h.docsRoot, 'r.md'), 'v1') // reverted content
    await h.store.commit(PROJECT_ID, {
      op: 'revert',
      path: 'r.md',
      target_sha: target,
    })
    const subject = (
      await git(h.projectRoot, [
        `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
        `--work-tree=${h.docsRoot}`,
        'log',
        '-1',
        '--pretty=format:%s',
      ])
    ).trim()
    expect(subject).toBe(`revert: r.md to ${target.slice(0, 7)}`)
  })

  it('formatCommitMessage returns the canonical shape for every op', () => {
    expect(formatCommitMessage({ op: 'create', path: 'a.md' })).toBe('create: a.md')
    expect(formatCommitMessage({ op: 'edit', path: 'a.md' })).toBe('edit: a.md')
    expect(formatCommitMessage({ op: 'delete', path: 'a.md' })).toBe('delete: a.md')
    expect(formatCommitMessage({ op: 'rename', from: 'a.md', to: 'b.md' })).toBe(
      'rename: a.md -> b.md',
    )
    expect(
      formatCommitMessage({ op: 'revert', path: 'a.md', target_sha: 'abcdef1234567890abcdef1234567890abcdef12' }),
    ).toBe('revert: a.md to abcdef1')
  })

  it('skips committing when no working-tree change is staged', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'x.md'), 'same')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'x.md' })
    const before = await headSha(h)
    // Same content — `git add` produces no diff against HEAD, so
    // commit() must NOT produce an empty commit.
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'x.md' })
    const after = await headSha(h)
    expect(after).toBe(before)
  })

  it('does NOT commit binary files (they are .gitignore-blocked)', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'image.png'), Buffer.from([0xff, 0xff]))
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'image.png' })
    const ls = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
      `--work-tree=${h.docsRoot}`,
      'ls-files',
    ])
    expect(ls).not.toContain('image.png')
  })
})

describe('DocVersionStore — history + read_at + diff', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('history returns commits in reverse-chronological order', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    for (const body of ['v1', 'v2', 'v3']) {
      writeFileSync(join(h.docsRoot, 'h.md'), body)
      await h.store.commit(PROJECT_ID, {
        op: body === 'v1' ? 'create' : 'edit',
        path: 'h.md',
      })
    }
    const page = await h.store.history(PROJECT_ID, 'h.md')
    // Three commits — newest first.
    expect(page.entries.length).toBe(3)
    expect(page.entries[0]?.message).toBe('edit: h.md')
    expect(page.entries[2]?.message).toBe('create: h.md')
    expect(page.next_cursor).toBeNull()
  })

  it('history pagination — cursor walks backwards', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(h.docsRoot, 'p.md'), `body-${i}`)
      await h.store.commit(PROJECT_ID, {
        op: i === 0 ? 'create' : 'edit',
        path: 'p.md',
      })
    }
    const first = await h.store.history(PROJECT_ID, 'p.md', { limit: 2 })
    expect(first.entries.length).toBe(2)
    expect(first.next_cursor).not.toBeNull()
    const second = await h.store.history(PROJECT_ID, 'p.md', {
      limit: 2,
      before_sha: first.next_cursor!,
    })
    expect(second.entries.length).toBe(2)
    // The two pages must contain distinct shas.
    const seen = new Set(first.entries.map((e) => e.sha))
    for (const e of second.entries) {
      expect(seen.has(e.sha)).toBe(false)
    }
  })

  it('history returns an empty array for an untouched path', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'real.md'), 'body')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'real.md' })
    const page = await h.store.history(PROJECT_ID, 'never-touched.md')
    expect(page.entries).toEqual([])
    expect(page.next_cursor).toBeNull()
  })

  it('read_at returns the file content + author_date + message at a sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'r.md'), 'first body')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'r.md' })
    const sha = await headSha(h)
    writeFileSync(join(h.docsRoot, 'r.md'), 'second body')
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'r.md' })
    const v = await h.store.read_at(PROJECT_ID, 'r.md', sha)
    expect(v.content).toBe('first body')
    expect(v.message).toBe('create: r.md')
    expect(v.size_bytes).toBe(Buffer.byteLength('first body', 'utf8'))
    expect(typeof v.author_date).toBe('string')
    expect(v.author_date.length).toBeGreaterThan(0)
  })

  it('read_at throws VersionNotFoundError for a bogus sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'x.md'), 'body')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'x.md' })
    const bogus = '0'.repeat(40)
    await expect(h.store.read_at(PROJECT_ID, 'x.md', bogus)).rejects.toThrow(
      VersionNotFoundError,
    )
  })

  it('read_at rejects malformed sha with InvalidShaError', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'x.md'), 'body')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'x.md' })
    await expect(h.store.read_at(PROJECT_ID, 'x.md', 'not-a-sha')).rejects.toThrow(
      InvalidShaError,
    )
  })

  it('revertContent returns the file body at the target sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'r.md'), 'original')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'r.md' })
    const target = await headSha(h)
    writeFileSync(join(h.docsRoot, 'r.md'), 'modified')
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'r.md' })
    const rev = await h.store.revertContent(PROJECT_ID, 'r.md', target)
    expect(rev.content).toBe('original')
    expect(rev.target_short_sha).toBe(target.slice(0, 7))
  })

  it('revertContent returns null content when the path was a delete at that sha', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'd.md'), 'original')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'd.md' })
    rmSync(join(h.docsRoot, 'd.md'))
    await h.store.commit(PROJECT_ID, { op: 'delete', path: 'd.md' })
    const deleteSha = await headSha(h)
    const rev = await h.store.revertContent(PROJECT_ID, 'd.md', deleteSha)
    expect(rev.content).toBeNull()
    // Codex r2 BLOCKING #1 — `deleted: true` is the explicit signal
    // the surface uses to route to the delete branch; without it, the
    // unknown-sha case looked identical to a legitimate delete-revert.
    expect(rev.deleted).toBe(true)
  })

  it('revertContent throws UnknownShaError for a sha that does not exist (Codex r2 BLOCKING #1)', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'r.md'), 'body')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'r.md' })
    // 40-hex but never existed in the repo — the previous code
    // silently returned `{content: null}` and the surface treated
    // that as a delete-revert, destroying the live doc.
    const bogus = 'a'.repeat(40)
    await expect(
      h.store.revertContent(PROJECT_ID, 'r.md', bogus),
    ).rejects.toThrow(UnknownShaError)
  })

  it('revertContent returns content + deleted:false for a valid sha at a tracked path (Codex r2 BLOCKING #1)', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'r.md'), 'original')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'r.md' })
    const target = await headSha(h)
    writeFileSync(join(h.docsRoot, 'r.md'), 'modified')
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'r.md' })
    const rev = await h.store.revertContent(PROJECT_ID, 'r.md', target)
    expect(rev.content).toBe('original')
    expect(rev.deleted).toBe(false)
  })

  it('history pagination — never drops a commit between pages (Codex r2 IMPORTANT #1)', async () => {
    if (!GIT_AVAILABLE) return
    // Seed 10 commits on the same file and walk the full history in
    // 3-commit pages. The pre-fix cursor scheme set
    // `next_cursor = all[limit]` (the first NOT returned) and the next
    // page started from `${cursor}~1`, skipping the cursor itself —
    // losing one commit per page boundary. With 10 commits at limit=3
    // that meant page 1 [c0,c1,c2], page 2 SHOULD be [c3,c4,c5] but
    // came back as [c4,c5,c6], etc. This test fails on the old code
    // and passes on the fixed `next_cursor = last-returned-entry` scheme.
    await h.store.ensureInit(PROJECT_ID)
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(h.docsRoot, 'p.md'), `body-${i}`)
      await h.store.commit(PROJECT_ID, {
        op: i === 0 ? 'create' : 'edit',
        path: 'p.md',
      })
    }
    // Collect the FULL ordered list of shas as the ground truth.
    const truth = await h.store.history(PROJECT_ID, 'p.md', { limit: 50 })
    expect(truth.entries.length).toBe(10)
    const expected = truth.entries.map((e) => e.sha)
    // Walk via 3-commit pages.
    const seen: string[] = []
    let cursor: string | null = null
    for (let safety = 0; safety < 10; safety++) {
      const opts: { limit: number; before_sha?: string } = { limit: 3 }
      if (cursor !== null) opts.before_sha = cursor
      const page = await h.store.history(PROJECT_ID, 'p.md', opts)
      for (const entry of page.entries) seen.push(entry.sha)
      if (page.next_cursor === null) break
      cursor = page.next_cursor
    }
    // Every sha from the ground-truth list MUST appear in the page
    // walk, in the same order, with no duplicates and no skips.
    expect(seen).toEqual(expected)
  })

  it('diff returns hunk text between two shas', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'd.md'), 'line one\nline two\n')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'd.md' })
    const fromSha = await headSha(h)
    writeFileSync(join(h.docsRoot, 'd.md'), 'line one\nline two changed\n')
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'd.md' })
    const toSha = await headSha(h)
    const d = await h.store.diff(PROJECT_ID, 'd.md', fromSha, toSha)
    expect(d.from).toBe(fromSha)
    expect(d.to).toBe(toSha)
    expect(d.hunks).toContain('@@')
    expect(d.hunks).toContain('+line two changed')
    expect(d.truncated).toBe(false)
  })

  it('diff supports to=head against the working tree', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'w.md'), 'foo\n')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'w.md' })
    const fromSha = await headSha(h)
    // Modify working tree but DON'T commit
    writeFileSync(join(h.docsRoot, 'w.md'), 'foo\nbar\n')
    const d = await h.store.diff(PROJECT_ID, 'w.md', fromSha, 'head')
    expect(d.to).toBe('head')
    expect(d.hunks).toContain('+bar')
  })
})

describe('DocVersionStore — concurrency', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('two concurrent commits on different paths both land', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'a.md'), 'a')
    writeFileSync(join(h.docsRoot, 'b.md'), 'b')
    await Promise.all([
      h.store.commit(PROJECT_ID, { op: 'create', path: 'a.md' }),
      h.store.commit(PROJECT_ID, { op: 'create', path: 'b.md' }),
    ])
    const log = await git(h.projectRoot, [
      `--git-dir=${join(h.projectRoot, '.docs-versions')}`,
      `--work-tree=${h.docsRoot}`,
      'log',
      '--pretty=format:%s',
    ])
    const subjects = log.split('\n').filter((s) => s.length > 0)
    expect(subjects).toContain('create: a.md')
    expect(subjects).toContain('create: b.md')
  })

  it('concurrent first-init coalesces into one git init', async () => {
    if (!GIT_AVAILABLE) return
    const [r1, r2] = await Promise.all([
      h.store.ensureInit(PROJECT_ID),
      h.store.ensureInit(PROJECT_ID),
    ])
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(existsSync(join(h.projectRoot, '.docs-versions', 'HEAD'))).toBe(true)
  })

  // D4 keyed-mutex adoption proof (refactor plan 2026-07-02 § D4).
  // `withCommitLock` moved from a hand-rolled chained-promise map to the
  // generic `gateway/http/keyed-mutex.ts` (which was itself modeled on
  // the hand-rolled original). This test pins the THREE semantics the
  // swap must preserve — it was written against the pre-swap
  // implementation and passes unchanged against both:
  //   1. mutual exclusion per project (no interleaving),
  //   2. arrival-order FIFO within a project,
  //   3. per-project granularity (other projects are NOT blocked).
  // No git involved — the lock is exercised directly so the assertion
  // is about the lock, not about subprocess timing.
  it('D4 — commit lock serializes same-project sections in arrival order; different projects run in parallel', async () => {
    type LockFn = <T>(project_id: string, fn: () => Promise<T>) => Promise<T>
    const lock = (
      h.store as unknown as { withCommitLock: LockFn }
    ).withCommitLock.bind(h.store) as LockFn
    const events: string[] = []
    let releaseA!: () => void
    const aHolds = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const a = lock('p1', async () => {
      events.push('a-start')
      await aHolds
      events.push('a-end')
    })
    const b = lock('p1', async () => {
      events.push('b-start')
    })
    const c = lock('p2', async () => {
      events.push('c-start')
    })
    // p2 proceeds while p1's first holder is parked → per-project
    // granularity. b must NOT have started — a still holds p1.
    await c
    expect(events).toContain('a-start')
    expect(events).toContain('c-start')
    expect(events).not.toContain('b-start')
    releaseA()
    await Promise.all([a, b])
    // a's section fully completes before b's begins (mutual exclusion
    // + FIFO: b entered the queue before a released).
    expect(events.indexOf('a-end')).toBeGreaterThan(events.indexOf('a-start'))
    expect(events.indexOf('b-start')).toBeGreaterThan(events.indexOf('a-end'))
  })

  it('D4 — commit lock releases on throw and the queue keeps draining', async () => {
    type LockFn = <T>(project_id: string, fn: () => Promise<T>) => Promise<T>
    const lock = (
      h.store as unknown as { withCommitLock: LockFn }
    ).withCommitLock.bind(h.store) as LockFn
    const failing = lock('p1', async () => {
      throw new Error('boom')
    })
    let ran = false
    const next = lock('p1', async () => {
      ran = true
    })
    await expect(failing).rejects.toThrow('boom')
    await next
    expect(ran).toBe(true)
  })
})

describe('DocVersionStore — failure modes', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => cleanup(h))

  it('git binary missing — every operation no-ops or surfaces unavailable', async () => {
    // Point gitBinary at a path that definitely doesn't exist.
    const broken = new DocVersionStore({
      owner_home: h.owner_home,
      project_slug: PROJECT_SLUG,
      gitBinary: '/path/does/not/exist/git-binary-missing',
    })
    expect(await broken.isGitAvailable()).toBe(false)
    // ensureInit returns false; no .docs-versions/ is created.
    expect(await broken.ensureInit(PROJECT_ID)).toBe(false)
    expect(existsSync(join(h.projectRoot, '.docs-versions'))).toBe(false)
    // commit is a silent no-op (does not throw).
    writeFileSync(join(h.docsRoot, 'x.md'), 'body')
    await broken.commit(PROJECT_ID, { op: 'create', path: 'x.md' })
    // history / read_at / diff throw VersioningUnavailableError.
    await expect(broken.history(PROJECT_ID, 'x.md')).rejects.toThrow(
      VersioningUnavailableError,
    )
    await expect(
      broken.read_at(PROJECT_ID, 'x.md', '0'.repeat(40)),
    ).rejects.toThrow(VersioningUnavailableError)
    await expect(
      broken.diff(PROJECT_ID, 'x.md', '0'.repeat(40), 'head'),
    ).rejects.toThrow(VersioningUnavailableError)
  })

  it('repo corruption — renames the broken dir aside and reinits', async () => {
    if (!GIT_AVAILABLE) return
    await h.store.ensureInit(PROJECT_ID)
    writeFileSync(join(h.docsRoot, 'r.md'), 'first')
    await h.store.commit(PROJECT_ID, { op: 'create', path: 'r.md' })
    // Trash the HEAD file to simulate corruption.
    const gitDir = join(h.projectRoot, '.docs-versions')
    writeFileSync(join(gitDir, 'HEAD'), 'fatal-corrupt-content-not-a-ref')
    // Next commit triggers the recovery path.
    writeFileSync(join(h.docsRoot, 'r.md'), 'second')
    await h.store.commit(PROJECT_ID, { op: 'edit', path: 'r.md' })
    // A broken sibling must appear (rename), and a fresh .docs-versions/
    // must be back in place.
    const siblings = readdirSync(h.projectRoot)
    const brokenDirs = siblings.filter((s) => s.startsWith('.docs-versions.broken-'))
    expect(brokenDirs.length).toBeGreaterThan(0)
    expect(existsSync(join(h.projectRoot, '.docs-versions', 'HEAD'))).toBe(true)
  })
})

describe('DocVersionStore — assertShaShape', () => {
  it('throws on non-hex sha-shaped strings', async () => {
    const h = makeHarness()
    try {
      if (!GIT_AVAILABLE) return
      await h.store.ensureInit(PROJECT_ID)
      writeFileSync(join(h.docsRoot, 'a.md'), 'body')
      await h.store.commit(PROJECT_ID, { op: 'create', path: 'a.md' })
      await expect(h.store.read_at(PROJECT_ID, 'a.md', 'ZZZZZ')).rejects.toThrow(
        InvalidShaError,
      )
      await expect(
        h.store.read_at(PROJECT_ID, 'a.md', 'ABCDEF1234567890abcdef1234567890abcdef12'),
      ).rejects.toThrow(InvalidShaError) // uppercase rejected
    } finally {
      cleanup(h)
    }
  })
})

afterAll(() => {
  // best-effort — tests already clean their own tmp dirs
})
