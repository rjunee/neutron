/**
 * P7.0 + P7.1 — gateway app-docs surface tests.
 *
 * Round-trips the six docs routes (tree, read, write, move, delete,
 * folder) through `composeHttpHandler` with the dev-bypass auth
 * resolver and a real `DocStore` backed by a per-test tmpdir tree.
 * Mirrors the structure of `gateway/__tests__/app-tasks-surface.test.ts`.
 *
 * The path-safety + symlink-safety tests are the load-bearing ones:
 * the doc store ships with a deliberately tight path validator + a
 * realpath containment check, and these tests confirm a hostile path
 * never escapes the project's docs root no matter how the client
 * structures the request.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { createAppDocsSurface } from '../http/app-docs-surface.ts'
import { DocStore } from '../http/doc-store.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'

// --- in-process handler shim (no socket) -------------------------------------
// These surface tests used to bind a real `Bun.serve({ port: 0 })` and round-
// trip via the global `fetch`, holding a live listener + socket buffers in the
// chunk's RSS until teardown. Instead each harness registers its composed
// handler under a unique in-process base, and `fetch` is shadowed at module
// scope so requests to a registered base dispatch straight to
// `composed.fetch(new Request(...))` — identical assertions, no socket.
// Unrelated URLs fall through to the real fetch.
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

const PROJECT_ID = 'demo-project'
const PROJECT_SLUG = 'demo'

interface Harness {
  base: string
  store: DocStore
  owner_home: string
  docsRoot: string
  tmp: string
  close(): Promise<void>
}

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-docs-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
  mkdirSync(docsRoot, { recursive: true })

  const store = new DocStore({ owner_home })
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surface = createAppDocsSurface({ store, auth, project_slug: PROJECT_SLUG })
  const composed = composeHttpHandler({
    appDocs: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    store,
    owner_home,
    docsRoot,
    tmp,
    close: async () => {
      __composedHandlers.delete(host)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('authorization', 'Bearer dev:sam')
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

describe('app-docs surface — auth', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${harness.base}/api/app/projects/${PROJECT_ID}/docs/tree`)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { ok: boolean; code: string }
    expect(json.ok).toBe(false)
    expect(json.code).toBe('missing_bearer')
  })

  it('rejects an invalid project_id with chars outside [A-Za-z0-9_.-]', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${encodeURIComponent('bad%20id!')}/docs/tree`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_project_id')
  })
})

describe('app-docs surface — GET tree', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('returns an empty tree for a fresh project', async () => {
    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/docs/tree`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; tree: unknown[]; file_count: number }
    expect(json.ok).toBe(true)
    expect(json.tree).toEqual([])
    expect(json.file_count).toBe(0)
  })

  it('returns nested folders + files, sorted folders-first then case-insensitive ASC', async () => {
    writeFileSync(join(harness.docsRoot, 'README.md'), '# README')
    mkdirSync(join(harness.docsRoot, 'notes'))
    writeFileSync(join(harness.docsRoot, 'notes', 'brainstorm.md'), '# Brain')
    writeFileSync(join(harness.docsRoot, 'notes', 'Decisions.md'), '# Decisions')
    mkdirSync(join(harness.docsRoot, 'references'))
    writeFileSync(join(harness.docsRoot, 'references', 'brand-style.md'), '# Brand')
    // Hidden segment — must not appear in the tree.
    mkdirSync(join(harness.docsRoot, '.git'))
    writeFileSync(join(harness.docsRoot, '.git', 'HEAD'), 'ignored')
    // Non-.md file — must not appear.
    writeFileSync(join(harness.docsRoot, 'image.png'), 'binary')

    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/docs/tree`)
    const json = (await res.json()) as {
      tree: { kind: string; path: string; name: string; children: unknown[] }[]
      file_count: number
    }
    // Folders first: notes, references; then file README.md.
    expect(json.tree.map((n) => n.name)).toEqual(['notes', 'references', 'README.md'])
    expect(json.tree[0]?.kind).toBe('folder')
    const notes = json.tree[0]
    expect(notes !== undefined).toBe(true)
    // Within notes, case-insensitive ASC: brainstorm before Decisions.
    const noteChildren = notes!.children as { name: string }[]
    expect(noteChildren.map((c) => c.name)).toEqual(['brainstorm.md', 'Decisions.md'])
    // Four .md files: README, brainstorm, Decisions, brand-style. The
    // hidden .git/HEAD file and the image.png siblings must be excluded.
    expect(json.file_count).toBe(4)
  })

  it('lists .markdown files alongside .md files (round-7 IMPORTANT #1)', async () => {
    // Round-7 IMPORTANT #1 — P7.0 accepted both `.md` and
    // `.markdown` via MARKDOWN_EXTENSIONS. The round-4 walker
    // rewrite + requireMd:true narrowed to `/\.md$/i` only, dropping
    // `.markdown` notes from tree results entirely. The fix
    // reinstates the original constant + uses it from both gates.
    writeFileSync(join(harness.docsRoot, 'README.md'), '# README')
    writeFileSync(join(harness.docsRoot, 'legacy.markdown'), '# Legacy Obsidian note')
    mkdirSync(join(harness.docsRoot, 'notes'))
    writeFileSync(join(harness.docsRoot, 'notes', 'old.markdown'), '# Old')

    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/docs/tree`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      tree: { name: string; children: { name: string }[] }[]
      file_count: number
    }
    const names = json.tree.map((n) => n.name)
    expect(names).toContain('README.md')
    expect(names).toContain('legacy.markdown')
    const notes = json.tree.find((n) => n.name === 'notes')
    expect((notes?.children ?? []).map((c) => c.name)).toContain('old.markdown')
    expect(json.file_count).toBe(3)
  })

  it('omits symlink-escape children from the tree (round-4 BLOCKING #1)', async () => {
    // A markdown symlink inside docs/ that resolves OUTSIDE the docs
    // root must not appear in the tree — even though the reader rejects
    // its content, surfacing it leaks `size_bytes` + `modified_at` for
    // an out-of-tree file. Regression test for P7.0→P7.1: the new
    // async walker dropped the realpath containment check that the
    // P7.0 `walkChildren` had.
    const outside = join(harness.tmp, 'outside-target.md')
    writeFileSync(outside, '# secret')
    symlinkSync(outside, join(harness.docsRoot, 'leak.md'))

    // Real files alongside the leak must still appear.
    writeFileSync(join(harness.docsRoot, 'README.md'), '# README')
    mkdirSync(join(harness.docsRoot, 'notes'))
    writeFileSync(join(harness.docsRoot, 'notes', 'real.md'), '# real')

    const res = await authedFetch(harness.base, `/api/app/projects/${PROJECT_ID}/docs/tree`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      tree: { name: string; children: { name: string }[] }[]
      file_count: number
    }
    const names = json.tree.map((n) => n.name)
    expect(names).not.toContain('leak.md')
    expect(names).toContain('README.md')
    expect(names).toContain('notes')
    // notes/real.md must still be there — confirms the filter only
    // drops escape symlinks, not real files in real subdirs.
    const notes = json.tree.find((n) => n.name === 'notes')
    expect((notes?.children ?? []).map((c) => c.name)).toEqual(['real.md'])
    expect(json.file_count).toBe(2)
  })
})

describe('app-docs surface — read file', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('round-trips a markdown file', async () => {
    writeFileSync(join(harness.docsRoot, 'README.md'), '# Hello\nworld\n')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.md`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      file: { path: string; content: string; size_bytes: number; modified_at: number }
    }
    expect(json.ok).toBe(true)
    expect(json.file.path).toBe('README.md')
    expect(json.file.content).toBe('# Hello\nworld\n')
    expect(json.file.size_bytes).toBeGreaterThan(0)
    expect(typeof json.file.modified_at).toBe('number')
  })

  it('returns 400 with missing path', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_path')
  })

  it('returns 404 when the file does not exist', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=missing.md`,
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('doc_not_found')
  })

  it('rejects .. path-traversal', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('../escape.md')}`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects absolute paths', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('/etc/passwd')}`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects hidden segments', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('.git/HEAD')}`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('hidden_segment')
  })

  it('rejects non-.md extensions', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.txt`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_extension')
  })

  it('reads and writes a .markdown file (round-7 IMPORTANT #1)', async () => {
    // Round-7 IMPORTANT #1 — P7.0 accepted both `.md` and
    // `.markdown` extensions. Round-4's path validator dropped
    // `.markdown` and made existing notes uneditable. End-to-end
    // round-trip for both ends of the surface (read + write).
    writeFileSync(join(harness.docsRoot, 'legacy.markdown'), '# Legacy')
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=legacy.markdown`,
    )
    expect(readRes.status).toBe(200)
    const readJson = (await readRes.json()) as {
      file: { path: string; content: string }
    }
    expect(readJson.file.path).toBe('legacy.markdown')
    expect(readJson.file.content).toBe('# Legacy')

    // PUT a new .markdown file end-to-end.
    const writeRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'fresh.markdown', content: '# Fresh markdown' }),
      },
    )
    expect(writeRes.status).toBe(200)
    const writeJson = (await writeRes.json()) as { file: { path: string } }
    expect(writeJson.file.path).toBe('fresh.markdown')
    expect(existsSync(join(harness.docsRoot, 'fresh.markdown'))).toBe(true)
  })

  it('reads, lists, and writes an .html doc (2026-07-01 HTML render)', async () => {
    // The Documents tab renders `.html`/`.htm` docs as static styled pages, so
    // the store must surface + accept them end-to-end (before this they errored
    // with `invalid_extension: path must end with .md or .markdown`).
    const page = '<!DOCTYPE html><html><head><style>h1{color:red}</style></head><body><h1>Timer</h1></body></html>'
    writeFileSync(join(harness.docsRoot, 'timer.html'), page)

    // READ round-trips the exact bytes.
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=timer.html`,
    )
    expect(readRes.status).toBe(200)
    const readJson = (await readRes.json()) as { file: { path: string; content: string } }
    expect(readJson.file.path).toBe('timer.html')
    expect(readJson.file.content).toBe(page)

    // LIST surfaces the .html leaf in the tree.
    const treeRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/tree`,
    )
    expect(treeRes.status).toBe(200)
    const treeText = await treeRes.text()
    expect(treeText).toContain('timer.html')

    // WRITE a fresh .html (and .htm) doc end-to-end.
    const writeRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'fresh.html', content: '<p>hi</p>' }),
      },
    )
    expect(writeRes.status).toBe(200)
    expect(existsSync(join(harness.docsRoot, 'fresh.html'))).toBe(true)

    const writeHtm = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'legacy.htm', content: '<p>htm</p>' }),
      },
    )
    expect(writeHtm.status).toBe(200)
    expect(existsSync(join(harness.docsRoot, 'legacy.htm'))).toBe(true)
  })

  it('still rejects a non-doc extension (.txt) with invalid_extension', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.txt`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_extension')
  })

  it('rejects symlink escape via a malicious file in docs/', async () => {
    // Create a file outside docs/, then point a symlink at it from inside.
    const outside = join(harness.tmp, 'outside.md')
    writeFileSync(outside, '# secret')
    symlinkSync(outside, join(harness.docsRoot, 'leak.md'))
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=leak.md`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('path_escape')
  })
})

describe('app-docs surface — write file', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('creates a new file end-to-end', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'notes/new.md', content: '# Fresh\n' }),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      file: { path: string; size_bytes: number; modified_at: number }
    }
    expect(json.ok).toBe(true)
    expect(json.file.path).toBe('notes/new.md')

    // Confirm the file landed via a follow-up read.
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('notes/new.md')}`,
    )
    expect(readRes.status).toBe(200)
    const readJson = (await readRes.json()) as { file: { content: string } }
    expect(readJson.file.content).toBe('# Fresh\n')
  })

  it('overwrites an existing file', async () => {
    writeFileSync(join(harness.docsRoot, 'README.md'), '# Old')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'README.md', content: '# New body' }),
      },
    )
    expect(res.status).toBe(200)
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.md`,
    )
    const readJson = (await readRes.json()) as { file: { content: string } }
    expect(readJson.file.content).toBe('# New body')
  })

  it('returns 409 on stale expected_modified_at', async () => {
    writeFileSync(join(harness.docsRoot, 'README.md'), '# Initial')
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.md`,
    )
    const readJson = (await readRes.json()) as { file: { modified_at: number } }
    const current = readJson.file.modified_at
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({
          path: 'README.md',
          content: '# stale write',
          expected_modified_at: current - 60_000,
        }),
      },
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as {
      code: string
      current_modified_at: number
    }
    expect(json.code).toBe('doc_modified_conflict')
    expect(json.current_modified_at).toBe(current)
  })

  it('returns 409 with current_modified_at:null when the file was deleted concurrently and expected_modified_at was supplied (round-5 IMPORTANT #1)', async () => {
    // Round-5 IMPORTANT #1 — when a PUT carries `expected_modified_at`
    // and the file has been concurrently deleted between the caller's
    // read and this write, the previous code silently RECREATED the
    // file (the `current !== null` guard short-circuited the conflict
    // check). Single-writer intent demands a loud failure here so the
    // client can ack the deletion and either drop the edit or recreate
    // via a fresh PUT without `expected_modified_at`.
    writeFileSync(join(harness.docsRoot, 'README.md'), '# Initial')
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.md`,
    )
    const readJson = (await readRes.json()) as { file: { modified_at: number } }
    const original = readJson.file.modified_at

    // Simulate the concurrent delete: another writer (or the user on
    // another device) unlinks the file between the read and the PUT.
    unlinkSync(join(harness.docsRoot, 'README.md'))

    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({
          path: 'README.md',
          content: '# recreated body',
          expected_modified_at: original,
        }),
      },
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as {
      ok: boolean
      code: string
      current_modified_at: number | null
    }
    expect(json.ok).toBe(false)
    expect(json.code).toBe('doc_modified_conflict')
    expect(json.current_modified_at).toBeNull()

    // The file must NOT have been silently recreated on disk.
    expect(existsSync(join(harness.docsRoot, 'README.md'))).toBe(false)
  })

  it('still creates a fresh file when expected_modified_at is omitted, even after a concurrent delete (round-5 IMPORTANT #1)', async () => {
    // The mirror case: client knowingly recreates via a fresh PUT
    // without `expected_modified_at` after seeing the 409. This must
    // succeed and produce a normal create.
    writeFileSync(join(harness.docsRoot, 'README.md'), '# Initial')
    unlinkSync(join(harness.docsRoot, 'README.md'))
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({
          path: 'README.md',
          content: '# fresh body',
        }),
      },
    )
    expect(res.status).toBe(200)
    expect(existsSync(join(harness.docsRoot, 'README.md'))).toBe(true)
  })

  it('accepts a matching expected_modified_at', async () => {
    writeFileSync(join(harness.docsRoot, 'README.md'), '# Initial')
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.md`,
    )
    const readJson = (await readRes.json()) as { file: { modified_at: number } }
    const current = readJson.file.modified_at
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({
          path: 'README.md',
          content: '# Update',
          expected_modified_at: current,
        }),
      },
    )
    expect(res.status).toBe(200)
  })

  it('rejects writes over a 5MB cap with 413', async () => {
    const oversize = 'x'.repeat(5 * 1024 * 1024 + 1)
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'big.md', content: oversize }),
      },
    )
    expect(res.status).toBe(413)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('doc_too_large')
  })

  it('rejects symlink escape on write', async () => {
    // Pre-existing symlink in docs/ pointing outside the docs root —
    // writing through it must NOT clobber the target file outside.
    const outside = join(harness.tmp, 'outside.md')
    writeFileSync(outside, '# original')
    symlinkSync(outside, join(harness.docsRoot, 'leak.md'))
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'leak.md', content: '# overwritten' }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('path_escape')
    // The outside file must still hold its original contents.
    const after = await Bun.file(outside).text()
    expect(after).toBe('# original')
  })
})

describe('app-docs surface — move file', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('renames within docs/', async () => {
    writeFileSync(join(harness.docsRoot, 'old.md'), '# Body')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file/move`,
      {
        method: 'POST',
        body: JSON.stringify({ from_path: 'old.md', to_path: 'new.md' }),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; file: { path: string } }
    expect(json.ok).toBe(true)
    expect(json.file.path).toBe('new.md')

    const readOld = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=old.md`,
    )
    expect(readOld.status).toBe(404)
    const readNew = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=new.md`,
    )
    expect(readNew.status).toBe(200)
  })

  it('relocates between folders', async () => {
    writeFileSync(join(harness.docsRoot, 'top.md'), '# T')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file/move`,
      {
        method: 'POST',
        body: JSON.stringify({ from_path: 'top.md', to_path: 'archive/old.md' }),
      },
    )
    expect(res.status).toBe(200)
    const readNew = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('archive/old.md')}`,
    )
    expect(readNew.status).toBe(200)
  })

  it('refuses to overwrite an existing destination', async () => {
    writeFileSync(join(harness.docsRoot, 'a.md'), '# A')
    writeFileSync(join(harness.docsRoot, 'b.md'), '# B')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file/move`,
      {
        method: 'POST',
        body: JSON.stringify({ from_path: 'a.md', to_path: 'b.md' }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('doc_destination_exists')
  })

  it('rejects to_path escape attempt', async () => {
    writeFileSync(join(harness.docsRoot, 'a.md'), '# A')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file/move`,
      {
        method: 'POST',
        body: JSON.stringify({
          from_path: 'a.md',
          to_path: '../escape.md',
        }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })
})

describe('app-docs surface — delete file', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('removes the file from disk', async () => {
    writeFileSync(join(harness.docsRoot, 'goner.md'), '# G')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=goner.md`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(200)
    const readRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=goner.md`,
    )
    expect(readRes.status).toBe(404)
  })

  it('returns 404 when deleting a missing file', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=nope.md`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(404)
  })
})

describe('app-docs surface — folder ops', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  it('creates a new folder', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/folder`,
      {
        method: 'POST',
        body: JSON.stringify({ path: 'inbox' }),
      },
    )
    expect(res.status).toBe(200)
    const treeRes = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/tree`,
    )
    const treeJson = (await treeRes.json()) as { tree: { name: string; kind: string }[] }
    expect(treeJson.tree.some((n) => n.name === 'inbox' && n.kind === 'folder')).toBe(true)
  })

  it('creates nested folders', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/folder`,
      {
        method: 'POST',
        body: JSON.stringify({ path: 'a/b/c' }),
      },
    )
    expect(res.status).toBe(200)
  })

  it('rejects folder paths that escape', async () => {
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/folder`,
      {
        method: 'POST',
        body: JSON.stringify({ path: '../outside' }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects createFolder when an intermediate dir is a symlink escape (round-2 blocker #1)', async () => {
    // docs/intermediate -> /tmp/outside-folder; createFolder
    // docs/intermediate/sub must NOT mkdir-traverse through it.
    const outside = join(harness.tmp, 'outside-folder')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(harness.docsRoot, 'intermediate'))
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/folder`,
      {
        method: 'POST',
        body: JSON.stringify({ path: 'intermediate/sub' }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('path_escape')
    // The outside dir must NOT have grown a 'sub' child.
    expect(readdirSync(outside)).toEqual([])
  })

  it('deletes an empty folder', async () => {
    mkdirSync(join(harness.docsRoot, 'empty'))
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/folder?path=empty`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(200)
  })

  it('refuses to delete a non-empty folder', async () => {
    mkdirSync(join(harness.docsRoot, 'notes'))
    writeFileSync(join(harness.docsRoot, 'notes', 'a.md'), '# A')
    const res = await authedFetch(
      harness.base,
      `/api/app/projects/${PROJECT_ID}/docs/folder?path=notes`,
      { method: 'DELETE' },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('folder_not_empty')
  })
})

/**
 * Round-2 blocker #3: docs root itself is a symlink (operator-wired
 * legacy Obsidian vault). Per the new policy, the resolved real path
 * becomes the trust anchor and reads/writes/folder-ops succeed
 * normally; the symlink-escape leaf test still rejects.
 */
describe('app-docs surface — symlinked docs root (round-2 blocker #3)', () => {
  let host: string
  let base: string
  let tmp: string
  let realDocs: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-app-docs-symroot-'))
    const owner_home = join(tmp, 'home')
    mkdirSync(owner_home, { recursive: true })
    // The "real" docs folder lives outside Projects/<id>/; the docs
    // root inside the Projects/<id>/ tree is a symlink to it.
    realDocs = join(tmp, 'elsewhere', 'docs')
    mkdirSync(realDocs, { recursive: true })
    const linkParent = join(owner_home, 'Projects', PROJECT_ID)
    mkdirSync(linkParent, { recursive: true })
    symlinkSync(realDocs, join(linkParent, 'docs'))

    const store = new DocStore({ owner_home })
    const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
    const surface = createAppDocsSurface({ store, auth, project_slug: PROJECT_SLUG })
    const composed = composeHttpHandler({
      appDocs: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    host = `gw-${++__gatewaySeq}.test`
    __composedHandlers.set(host, composed)
    base = `http://${host}`
  })

  afterEach(async () => {
    __composedHandlers.delete(host)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reads, writes, and lists files through a symlinked docs root', async () => {
    writeFileSync(join(realDocs, 'README.md'), '# Hello via symlink')
    const readRes = await authedFetch(
      base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=README.md`,
    )
    expect(readRes.status).toBe(200)
    const readJson = (await readRes.json()) as { file: { content: string } }
    expect(readJson.file.content).toBe('# Hello via symlink')

    const writeRes = await authedFetch(
      base,
      `/api/app/projects/${PROJECT_ID}/docs/file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: 'notes/new.md', content: '# fresh' }),
      },
    )
    expect(writeRes.status).toBe(200)
    expect(readdirSync(join(realDocs, 'notes'))).toEqual(['new.md'])

    const treeRes = await authedFetch(
      base,
      `/api/app/projects/${PROJECT_ID}/docs/tree`,
    )
    const treeJson = (await treeRes.json()) as { file_count: number }
    expect(treeJson.file_count).toBe(2)
  })

  it('creates folders through a symlinked docs root', async () => {
    const res = await authedFetch(
      base,
      `/api/app/projects/${PROJECT_ID}/docs/folder`,
      {
        method: 'POST',
        body: JSON.stringify({ path: 'inbox' }),
      },
    )
    expect(res.status).toBe(200)
    expect(readdirSync(realDocs)).toContain('inbox')
  })

  it('still rejects leaf symlink escape when docs root is itself a symlink', async () => {
    const outside = join(tmp, 'leak-target.md')
    writeFileSync(outside, '# secret')
    symlinkSync(outside, join(realDocs, 'leak.md'))
    const res = await authedFetch(
      base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=leak.md`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('path_escape')
  })
})
