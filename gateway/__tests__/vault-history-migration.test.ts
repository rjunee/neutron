import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGitExec } from '../git/git-exec.ts'
import { importLegacyVaultHistories } from '../git/vault-history-migration.ts'
import { DocVersionStore, UnknownShaError } from '../git/doc-version-store.ts'
import { localVaultBackup } from '../../tests/support/vault-backup.ts'
import { LEGACY_DOC_VERSION_GITIGNORE } from '../git/legacy-doc-ignore.ts'

const git = createGitExec('git')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(repoCount: number) {
  const owner = await mkdtemp(join(tmpdir(), 'vault-history-'))
  roots.push(owner)
  const root = join(owner, 'Projects', 'demo')
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'project-repos.json'), JSON.stringify({
    repos: Array.from({ length: repoCount }, (_, i) => ({ name: `code-${i}`, path: `repos/code-${i}`, remote: null })),
    default: repoCount ? 'code-0' : null,
  }))
  for (let i = 0; i < repoCount; i++) {
    await mkdir(join(root, 'repos', `code-${i}`), { recursive: true })
    await writeFile(join(root, 'repos', `code-${i}`, 'private-code.txt'), 'code bytes')
  }
  async function init(dir: string, work: string) {
    await git(['init', '--bare', '--initial-branch=main', dir])
    const args = [`--git-dir=${dir}`, `--work-tree=${work}`]
    await git([...args, 'config', 'core.bare', 'false'])
    await git([...args, 'config', 'user.name', 'Test'])
    await git([...args, 'config', 'user.email', 'test@example.invalid'])
    return async (path: string, content: string, message: string) => {
      await writeFile(join(work, path), content)
      await git([...args, 'add', '--', path], { cwd: work })
      await git([...args, '-c', 'commit.gpgsign=false', 'commit', '-m', message], { cwd: work })
      return (await git([...args, 'rev-parse', 'HEAD'])).stdout.trim()
    }
  }
  const materialize = await init(join(root, '.git'), root)
  const rootSha = await materialize('README.md', 'original root document', 'materialize')
  const edit = await init(join(root, '.docs-versions'), join(root, 'docs'))
  const oldSha = await edit('note.md', 'old doc bytes', 'create old doc')
  const nextSha = await edit('note.md', 'edited old doc bytes', 'edit old doc')
  return { owner, root, rootSha, oldSha, nextSha, edit }
}

describe('canonical vault history reconciliation', () => {
  for (const count of [0, 2]) {
    test(`preserves legacy and new history through a real bundle restore (${count} code repositories)`, async () => {
      const h = await fixture(count)
      const backup = localVaultBackup(h.owner, 'demo')
      const docs = new DocVersionStore({ owner_home: h.owner, project_slug: 'demo', backupStore: backup })
      expect(await docs.ensureInit('demo')).toBe(true)
      const canonical = join(h.root, '.project-backup')
      expect(await docs.read_at('demo', 'note.md', h.oldSha)).toMatchObject({ content: 'old doc bytes' })
      expect(await docs.read_at('demo', 'note.md', h.nextSha)).toMatchObject({ content: 'edited old doc bytes' })
      expect((await git([`--git-dir=${canonical}`, 'show', `${h.rootSha}:README.md`])).stdout).toBe('original root document')
      expect(existsSync(join(h.root, '.git', 'HEAD'))).toBe(true)
      expect(existsSync(join(h.root, '.docs-versions', 'HEAD'))).toBe(true)
      const sourceHead = await readFile(join(h.root, '.docs-versions', 'refs', 'heads', 'main'), 'utf8')

      await writeFile(join(h.root, 'docs', 'note.md'), 'canonical edit')
      await docs.commit('demo', { op: 'edit', path: 'note.md' })
      const history = await docs.history('demo', 'note.md')
      expect(history.entries.map((entry) => entry.sha)).toContain(h.oldSha)
      expect(history.entries.map((entry) => entry.sha)).toContain(h.nextSha)
      const latest = history.entries[0]!.sha
      expect(await docs.read_at('demo', 'note.md', latest)).toMatchObject({ content: 'canonical edit' })
      expect((await docs.diff('demo', 'note.md', h.oldSha, latest)).hunks).toContain('+canonical edit')
      expect(await docs.revertContent('demo', 'note.md', h.oldSha)).toMatchObject({ deleted: false, content: 'old doc bytes' })
      await expect(docs.revertContent('demo', 'note.md', '0'.repeat(40))).rejects.toBeInstanceOf(UnknownShaError)
      expect(await readFile(join(h.root, '.docs-versions', 'refs', 'heads', 'main'), 'utf8')).toBe(sourceHead)
      const paginated: string[] = []
      let cursor: string | null = null
      do {
        const page = await docs.history('demo', 'note.md', { limit: 1, ...(cursor ? { before_sha: cursor } : {}) })
        paginated.push(...page.entries.map((entry) => entry.sha))
        cursor = page.next_cursor
      } while (cursor)
      expect(paginated).toEqual(history.entries.map((entry) => entry.sha))
      const files = (await git([`--git-dir=${canonical}`, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout
      expect(files).toContain('docs/note.md')
      expect(files).not.toContain('private-code.txt')

      const bundle = join(h.owner, 'vault.bundle')
      await git([`--git-dir=${canonical}`, 'bundle', 'create', bundle, '--all'])
      const restored = join(h.owner, 'restored.git')
      await git(['clone', '--mirror', bundle, restored])
      expect((await git([`--git-dir=${restored}`, 'show', `${h.oldSha}:note.md`])).stdout).toBe('old doc bytes')
      expect((await git([`--git-dir=${restored}`, 'show', `${latest}:docs/note.md`])).stdout).toBe('canonical edit')
      expect((await git([`--git-dir=${restored}`, 'show', `${h.rootSha}:README.md`])).stdout).toBe('original root document')
      const recoveredFiles = join(h.owner, 'restored-files')
      await mkdir(recoveredFiles)
      await git([`--git-dir=${restored}`, `--work-tree=${recoveredFiles}`, 'checkout', 'main', '--', 'docs/note.md'])
      expect(await readFile(join(recoveredFiles, 'docs', 'note.md'), 'utf8')).toBe('canonical edit')
    }, 30_000)
  }

  test('retries preserve earlier imported refs and import later legacy changes', async () => {
    const h = await fixture(0)
    const canonical = join(h.root, '.project-backup')
    await git(['init', '--bare', canonical])
    await importLegacyVaultHistories(h.root, canonical, git)
    const later = await h.edit('note.md', 'late legacy edit', 'late edit')
    await importLegacyVaultHistories(h.root, canonical, git)
    const refs = (await git([`--git-dir=${canonical}`, 'for-each-ref', '--format=%(refname)'])).stdout
    expect(refs).toContain(`refs/vault-history/docs/${h.nextSha}`)
    expect(refs).toContain(`refs/vault-history/docs/${later}`)
    expect((await git([`--git-dir=${canonical}`, 'show', `${h.oldSha}:note.md`])).stdout).toBe('old doc bytes')
  })

  test('a reset legacy branch retains its reflog-only version in the canonical vault', async () => {
    const h = await fixture(0)
    const source = join(h.root, '.docs-versions')
    await git([`--git-dir=${source}`, 'update-ref', 'refs/heads/main', h.oldSha])
    expect((await git([`--git-dir=${source}`, 'rev-parse', 'main'])).stdout.trim()).toBe(h.oldSha)
    expect((await git([`--git-dir=${source}`, 'reflog', 'show', '--all', '--format=%H'])).stdout).toContain(h.nextSha)
    const canonical = join(h.root, '.project-backup')
    await git(['init', '--bare', canonical])
    await importLegacyVaultHistories(h.root, canonical, git)
    expect((await git([`--git-dir=${canonical}`, 'show', `${h.nextSha}:note.md`])).stdout).toBe('edited old doc bytes')
    expect((await git([`--git-dir=${canonical}`, 'for-each-ref', '--format=%(refname)'])).stdout)
      .toContain(`refs/vault-history/docs/${h.nextSha}`)
  })

  test('retiring generated binary ignores preserves owner rules and original ignore history', async () => {
    const h = await fixture(0)
    const original = '# Owner prefix\nowner-private.txt\n' + LEGACY_DOC_VERSION_GITIGNORE + '# Owner suffix\n*.secret\n'
    const originalSha = await h.edit('.gitignore', original, 'legacy generated ignore plus owner rules')
    await writeFile(join(h.root, 'docs', 'image.png'), 'binary fixture')
    await writeFile(join(h.root, 'docs', 'owner-private.txt'), 'private fixture')
    await writeFile(join(h.root, 'docs', 'owner.secret'), 'private fixture')
    const canonical = join(h.root, '.project-backup')
    await git(['init', '--bare', canonical])
    await importLegacyVaultHistories(h.root, canonical, git)
    expect(await readFile(join(h.root, 'docs', '.gitignore'), 'utf8'))
      .toBe('# Owner prefix\nowner-private.txt\n# Owner suffix\n*.secret\n')
    const archive = (await readdir(join(h.root, '.docs-versions'))).find((name) => /^vault-migration-ignore-.*\.txt$/.test(name))
    expect(archive).toBeDefined()
    expect(await readFile(join(h.root, '.docs-versions', archive!), 'utf8')).toBe(original)
    expect((await git([`--git-dir=${canonical}`, 'show', `${originalSha}:.gitignore`])).stdout).toBe(original)
    await git([`--git-dir=${canonical}`, `--work-tree=${h.root}`, 'add', '--', 'docs'], { cwd: h.root })
    const files = (await git([`--git-dir=${canonical}`, 'ls-files'])).stdout
    expect(files).toContain('docs/image.png')
    expect(files).not.toContain('owner-private.txt')
    expect(files).not.toContain('owner.secret')
    await importLegacyVaultHistories(h.root, canonical, git)
    expect(await readFile(join(h.root, 'docs', '.gitignore'), 'utf8'))
      .toBe('# Owner prefix\nowner-private.txt\n# Owner suffix\n*.secret\n')
  })

  test('an owner-edited generated ignore block remains unchanged', async () => {
    const h = await fixture(0)
    const original = LEGACY_DOC_VERSION_GITIGNORE.replace('*.png\n', '')
    await h.edit('.gitignore', original, 'owner changed binary exclusions')
    const canonical = join(h.root, '.project-backup')
    await git(['init', '--bare', canonical])
    await importLegacyVaultHistories(h.root, canonical, git)
    expect(await readFile(join(h.root, 'docs', '.gitignore'), 'utf8')).toBe(original)
    expect((await readdir(join(h.root, '.docs-versions'))).some((name) => name.startsWith('vault-migration-ignore-'))).toBe(false)
  })

  test('a corrupt legacy repository refuses migration without deleting either history', async () => {
    const h = await fixture(0)
    const canonical = join(h.root, '.project-backup')
    await git(['init', '--bare', canonical])
    await writeFile(join(h.root, '.docs-versions', 'HEAD'), 'invalid HEAD')
    await expect(importLegacyVaultHistories(h.root, canonical, git)).rejects.toThrow()
    expect(existsSync(join(h.root, '.docs-versions', 'objects'))).toBe(true)
    expect((await git([`--git-dir=${canonical}`, 'show', `${h.rootSha}:README.md`])).stdout).toBe('original root document')
  })

  test('an unreadable existing historical blob cannot be mistaken for a deleted doc', async () => {
    const h = await fixture(0)
    const canonical = join(h.root, '.project-backup')
    await git(['init', '--bare', canonical])
    await importLegacyVaultHistories(h.root, canonical, git)
    // Inject only the unavailable blob read; the real commit/tree and path remain.
    const docs = new DocVersionStore({
      owner_home: h.owner, project_slug: 'demo',
      backupStore: { ensureInit: async () => true, commitDocument: async () => {} },
    })
    const internals = docs as unknown as { gitExec: typeof git }
    internals.gitExec = async (args, options) => {
      if (args.includes('blob')) throw new Error('missing historical blob')
      return git(args, options)
    }
    await expect(docs.revertContent('demo', 'note.md', h.oldSha)).rejects.toThrow('missing historical blob')
    expect(await docs.revertContent('demo', 'absent.md', h.oldSha)).toMatchObject({ deleted: true })
  })
})
