/**
 * P7.4 Phase 1 — gateway app-docs surface HTTP tests for the new
 * history / version / revert / diff routes.
 *
 * Round-trips the four new routes through `composeHttpHandler` with
 * the dev-bypass auth resolver + a real `DocStore` + a real
 * `DocVersionStore` over a per-test tmpdir tree. Mirrors the structure
 * of `gateway/__tests__/app-docs-surface.test.ts`.
 *
 * The DocStore<->DocVersionStore wiring is exercised end-to-end: a PUT
 * to /docs/file produces a commit; a subsequent GET /docs/history
 * returns it.
 *
 * Tests skip cleanly when `git --version` exits non-zero.
 */

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference types="bun" />

import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { createAppDocsSurface } from '../http/app-docs-surface.ts'
import { DocStore } from '../http/doc-store.ts'
import { DocVersionStore } from '../git/doc-version-store.ts'
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
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

const execFileAsync = promisify(execFile)

const PROJECT_ID = 'demo-project'
const PROJECT_SLUG = 'demo'

let GIT_AVAILABLE = false

beforeAll(async () => {
  try {
    await execFileAsync('git', ['--version'])
    GIT_AVAILABLE = true
  } catch {
    GIT_AVAILABLE = false
    console.warn(
      '[app-docs-surface-history.test] skipping — `git --version` failed.',
    )
  }
})

interface Harness {
  base: string
  store: DocStore
  versionStore: DocVersionStore
  owner_home: string
  docsRoot: string
  projectRoot: string
  tmp: string
  close(): Promise<void>
}

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'p74-history-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const projectRoot = join(owner_home, 'Projects', PROJECT_ID)
  mkdirSync(projectRoot, { recursive: true })
  const docsRoot = join(projectRoot, 'docs')
  mkdirSync(docsRoot, { recursive: true })

  const versionStore = new DocVersionStore({
    owner_home,
    project_slug: PROJECT_SLUG,
  })
  const store = new DocStore({ owner_home, versionStore })
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
    versionStore,
    owner_home,
    docsRoot,
    projectRoot,
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

/** PUT a file via the live gateway. Triggers a versioning commit. */
async function putFile(h: Harness, path: string, content: string): Promise<number> {
  const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/file`, {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { file: { modified_at: number } }
  return json.file.modified_at
}

describe('app-docs surface — GET /history', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns commits for a path in reverse-chronological order', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'notes.md', 'v1')
    await putFile(h, 'notes.md', 'v2')
    await putFile(h, 'notes.md', 'v3')
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('notes.md')}`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      history: { message: string; sha: string }[]
      next_cursor: string | null
    }
    expect(json.history.length).toBe(3)
    expect(json.history[0]?.message).toBe('edit: notes.md')
    expect(json.history[2]?.message).toBe('create: notes.md')
    expect(json.next_cursor).toBeNull()
  })

  it('paginates via cursor', async () => {
    if (!GIT_AVAILABLE) return
    for (let i = 0; i < 5; i++) {
      await putFile(h, 'p.md', `body-${i}`)
    }
    const first = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('p.md')}&limit=2`,
      )
    ).json() as { history: { sha: string }[]; next_cursor: string | null }
    expect(first.history.length).toBe(2)
    expect(first.next_cursor).not.toBeNull()
    const second = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('p.md')}&limit=2&cursor=${first.next_cursor}`,
      )
    ).json() as { history: { sha: string }[] }
    expect(second.history.length).toBe(2)
  })

  it('cursor pagination never drops a commit between pages (Codex r2 IMPORTANT #1)', async () => {
    if (!GIT_AVAILABLE) return
    // Seed 10 commits and walk via limit=3 pages. Pre-fix, the cursor
    // pointed at the FIRST commit not returned and the next page's
    // ${cursor}~1 started at its parent — skipping the cursor itself.
    // With 10 commits at limit=3 the page walk produced 9 commits, not
    // 10. This test catches that gap.
    for (let i = 0; i < 10; i++) {
      await putFile(h, 'walk.md', `body-${i}`)
    }
    // Ground truth: fetch the entire history in one page.
    const truth = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('walk.md')}&limit=50`,
      )
    ).json() as { history: { sha: string }[] }
    expect(truth.history.length).toBe(10)
    const expected = truth.history.map((e) => e.sha)
    // Walk page-by-page.
    const seen: string[] = []
    let cursor: string | null = null
    for (let safety = 0; safety < 10; safety++) {
      const cursorQs = cursor === null ? '' : `&cursor=${cursor}`
      const page = await (
        await authedFetch(
          h.base,
          `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('walk.md')}&limit=3${cursorQs}`,
        )
      ).json() as { history: { sha: string }[]; next_cursor: string | null }
      for (const e of page.history) seen.push(e.sha)
      if (page.next_cursor === null) break
      cursor = page.next_cursor
    }
    expect(seen).toEqual(expected)
  })

  it('returns empty array for a never-touched path', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'a.md', 'body')
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('never.md')}`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { history: unknown[]; next_cursor: string | null }
    expect(json.history).toEqual([])
    expect(json.next_cursor).toBeNull()
  })

  it('rejects ../ traversal with invalid_path', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('../etc/passwd')}`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects hidden segment with hidden_segment', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('.git/HEAD.md')}`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('hidden_segment')
  })

  it('rejects non-markdown extension with invalid_extension', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('image.png')}`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_extension')
  })

  it('rejects malformed cursor with invalid_cursor', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('a.md')}&cursor=not-a-sha`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_cursor')
  })

  it('requires bearer auth', async () => {
    const res = await fetch(
      `${h.base}/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('a.md')}`,
    )
    expect(res.status).toBe(401)
  })
})

describe('app-docs surface — GET /history/<sha>', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns the file content at the given sha', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'r.md', 'first version')
    const history = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('r.md')}`,
      )
    ).json() as { history: { sha: string; message: string }[] }
    const sha = history.history[0]?.sha
    expect(sha).toBeDefined()
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history/${sha}?path=${encodeURIComponent('r.md')}`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { version: { content: string; sha: string } }
    expect(json.version.content).toBe('first version')
    expect(json.version.sha).toBe(sha as string)
  })

  it('rejects a non-hex sha with invalid_sha (router rejects malformed action)', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history/NOT-A-VALID-SHA?path=${encodeURIComponent('r.md')}`,
    )
    // The DOCS_PATH_RE doesn't match malformed sha sub-segments, so
    // the router falls through to "unknown_docs_route".
    expect(res.status).toBe(404)
  })

  it('returns 404 version_not_found for a nonexistent sha', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'x.md', 'body')
    const bogus = '0'.repeat(40)
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/history/${bogus}?path=${encodeURIComponent('x.md')}`,
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('version_not_found')
  })
})

describe('app-docs surface — POST /revert', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('round-trips: write A, write B, revert to A → file content matches A', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'rt.md', 'A-content')
    const aSha = (
      await (
        await authedFetch(
          h.base,
          `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('rt.md')}`,
        )
      ).json() as { history: { sha: string }[] }
    ).history[0]?.sha
    expect(aSha).toBeDefined()
    await putFile(h, 'rt.md', 'B-content')
    // Revert to A
    const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/revert`, {
      method: 'POST',
      body: JSON.stringify({ path: 'rt.md', target_sha: aSha }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { file: { path: string }; target_sha: string }
    expect(json.target_sha).toBe(aSha as string)
    // Now read the file: content should match A
    const readRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('rt.md')}`,
    )
    const readJson = (await readRes.json()) as { file: { content: string } }
    expect(readJson.file.content).toBe('A-content')
    // History now has 3 commits: create:, edit:, revert:
    const histRes = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('rt.md')}`,
      )
    ).json() as { history: { message: string }[] }
    expect(histRes.history.length).toBe(3)
    expect(histRes.history[0]?.message).toBe(`revert: rt.md to ${aSha!.slice(0, 7)}`)
  })

  it('rejects malformed target_sha with invalid_sha', async () => {
    const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/revert`, {
      method: 'POST',
      body: JSON.stringify({ path: 'rt.md', target_sha: 'not-a-sha' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_sha')
  })

  it('rejects missing target_sha with missing_target_sha', async () => {
    const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/revert`, {
      method: 'POST',
      body: JSON.stringify({ path: 'a.md' }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_target_sha')
  })

  it('honors expected_modified_at — concurrent edit surfaces 409', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'oc.md', 'A')
    const aSha = (
      await (
        await authedFetch(
          h.base,
          `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('oc.md')}`,
        )
      ).json() as { history: { sha: string }[] }
    ).history[0]?.sha as string
    // Capture the mtime as the client would have seen it.
    const readRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('oc.md')}`,
    )
    const readJson = (await readRes.json()) as { file: { modified_at: number } }
    const staleMtime = readJson.file.modified_at
    // Simulate a concurrent edit that lands AFTER the user opened
    // history but BEFORE they pressed Revert.
    await new Promise((r) => setTimeout(r, 50)) // ensure new mtime
    await putFile(h, 'oc.md', 'B')
    // Now revert with the now-stale mtime — should 409.
    const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/revert`, {
      method: 'POST',
      body: JSON.stringify({
        path: 'oc.md',
        target_sha: aSha,
        expected_modified_at: staleMtime,
      }),
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('doc_modified_conflict')
  })

  it('non-existent target_sha returns 404 unknown_sha and the live file is NOT modified (Codex r2 BLOCKING #1)', async () => {
    if (!GIT_AVAILABLE) return
    // Seed a real file with known content
    await putFile(h, 'safe.md', 'live-content-must-survive')
    // Bogus 40-hex sha — passes shape validation, never existed in repo.
    // Pre-fix: revertContent returned `{content: null}` → handler
    // treated as delete-revert → live file silently destroyed.
    const bogus = 'b'.repeat(40)
    const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/revert`, {
      method: 'POST',
      body: JSON.stringify({ path: 'safe.md', target_sha: bogus }),
    })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('unknown_sha')
    // Live file MUST still exist with its original content.
    const readRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('safe.md')}`,
    )
    expect(readRes.status).toBe(200)
    const readJson = (await readRes.json()) as { file: { content: string } }
    expect(readJson.file.content).toBe('live-content-must-survive')
  })

  it('mistyped 40-hex target_sha returns 404 unknown_sha and the live file is NOT modified (Codex r2 BLOCKING #1)', async () => {
    if (!GIT_AVAILABLE) return
    // Seed a real file. Capture its real sha, then mutate one
    // character so the result is shape-valid but never the true commit
    // sha of anything in the repo. This is the stale-UI-pasted-sha
    // case the bug existed for.
    await putFile(h, 'live.md', 'live-content')
    const hist = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('live.md')}`,
      )
    ).json() as { history: { sha: string }[] }
    const realSha = hist.history[0]?.sha as string
    // Flip the first char to something different but still hex.
    const mistyped =
      (realSha[0] === '0' ? '1' : '0') + realSha.slice(1)
    expect(mistyped).not.toBe(realSha)
    const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/revert`, {
      method: 'POST',
      body: JSON.stringify({ path: 'live.md', target_sha: mistyped }),
    })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('unknown_sha')
    const readRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('live.md')}`,
    )
    expect(readRes.status).toBe(200)
    const readJson = (await readRes.json()) as { file: { content: string } }
    expect(readJson.file.content).toBe('live-content')
  })

  it('reverting to a delete sha with stale expected_modified_at returns 409 and does NOT delete (Codex r2 IMPORTANT #2)', async () => {
    if (!GIT_AVAILABLE) return
    // 1. Create file
    await putFile(h, 'del-occ.md', 'original')
    // 2. Delete file
    await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del-occ.md')}`,
      { method: 'DELETE' },
    )
    // 3. Capture the delete-commit sha — this is the target of the revert
    const histAfterDelete = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('del-occ.md')}`,
      )
    ).json() as { history: { sha: string; message: string }[] }
    const deleteSha = histAfterDelete.history[0]?.sha as string
    expect(histAfterDelete.history[0]?.message).toBe('delete: del-occ.md')
    // 4. Recreate file — capture its mtime (this is what the user's
    // history pane sees BEFORE another writer mutates)
    await putFile(h, 'del-occ.md', 'recreated-v1')
    const readRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del-occ.md')}`,
    )
    const readJson = (await readRes.json()) as { file: { modified_at: number } }
    const staleMtime = readJson.file.modified_at
    // 5. Concurrent writer edits the file AFTER the user opened history
    await new Promise((r) => setTimeout(r, 50)) // ensure new mtime
    await putFile(h, 'del-occ.md', 'concurrent-write')
    // 6. User clicks Revert-to-delete with the now-stale mtime. The
    // pre-fix code threaded OCC through the content-revert branch but
    // NOT the delete branch — so this delete would silently clobber
    // the concurrent edit. With the fix, deleteDoc raises
    // DocConflictError → 409.
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/revert`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'del-occ.md',
          target_sha: deleteSha,
          expected_modified_at: staleMtime,
        }),
      },
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('doc_modified_conflict')
    // 7. File must STILL exist with the concurrent-writer's content —
    // the stale revert did NOT delete it.
    const verifyRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del-occ.md')}`,
    )
    expect(verifyRes.status).toBe(200)
    const verifyJson = (await verifyRes.json()) as { file: { content: string } }
    expect(verifyJson.file.content).toBe('concurrent-write')
  })

  it('reverting to a delete sha with matching expected_modified_at proceeds (Codex r2 IMPORTANT #2)', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'del-ok.md', 'original')
    await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del-ok.md')}`,
      { method: 'DELETE' },
    )
    const histAfterDelete = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('del-ok.md')}`,
      )
    ).json() as { history: { sha: string }[] }
    const deleteSha = histAfterDelete.history[0]?.sha as string
    await putFile(h, 'del-ok.md', 'recreated')
    const readRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del-ok.md')}`,
    )
    const readJson = (await readRes.json()) as { file: { modified_at: number } }
    const freshMtime = readJson.file.modified_at
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/revert`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'del-ok.md',
          target_sha: deleteSha,
          expected_modified_at: freshMtime,
        }),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { deleted: boolean; file: unknown }
    expect(json.deleted).toBe(true)
    expect(json.file).toBeNull()
    const verifyRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del-ok.md')}`,
    )
    expect(verifyRes.status).toBe(404)
  })

  it('reverting to a delete sha deletes the current file (Codex r1 P2)', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'del.md', 'original')
    await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del.md')}`, {
      method: 'DELETE',
    })
    // Get the delete-commit sha
    const histAfterDelete = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('del.md')}`,
      )
    ).json() as { history: { sha: string; message: string }[] }
    const deleteSha = histAfterDelete.history[0]?.sha as string
    expect(histAfterDelete.history[0]?.message).toBe('delete: del.md')
    // Recreate the file
    await putFile(h, 'del.md', 'recreated')
    // Revert to the delete sha — should DELETE the file, not write ''.
    const res = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/revert`, {
      method: 'POST',
      body: JSON.stringify({ path: 'del.md', target_sha: deleteSha }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { deleted: boolean; file: unknown }
    expect(json.deleted).toBe(true)
    expect(json.file).toBeNull()
    // Reading the file should now 404.
    const readRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/file?path=${encodeURIComponent('del.md')}`,
    )
    expect(readRes.status).toBe(404)
  })
})

describe('app-docs surface — history --follow across renames (Codex r1 P2)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('history includes pre-rename commits when querying by the new path', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'old-name.md', 'v1')
    await putFile(h, 'old-name.md', 'v2')
    // Rename via the docs surface
    const moveRes = await authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/file/move`, {
      method: 'POST',
      body: JSON.stringify({ from_path: 'old-name.md', to_path: 'new-name.md' }),
    })
    expect(moveRes.status).toBe(200)
    // History for the NEW path should include pre-rename commits.
    const histRes = await (
      await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('new-name.md')}`,
      )
    ).json() as { history: { message: string }[] }
    expect(histRes.history.length).toBeGreaterThanOrEqual(3)
    const messages = histRes.history.map((e) => e.message)
    expect(messages).toContain('rename: old-name.md -> new-name.md')
    expect(messages).toContain('edit: old-name.md')
    expect(messages).toContain('create: old-name.md')
  })
})

describe('app-docs surface — GET /diff', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns hunk text between two shas', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'd.md', 'one\n')
    const hist1 = (
      await (
        await authedFetch(
          h.base,
          `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('d.md')}`,
        )
      ).json() as { history: { sha: string }[] }
    ).history
    const fromSha = hist1[0]?.sha as string
    await putFile(h, 'd.md', 'one\ntwo\n')
    const hist2 = (
      await (
        await authedFetch(
          h.base,
          `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('d.md')}`,
        )
      ).json() as { history: { sha: string }[] }
    ).history
    const toSha = hist2[0]?.sha as string
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/diff?path=${encodeURIComponent('d.md')}&from=${fromSha}&to=${toSha}`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { diff: { hunks: string; truncated: boolean } }
    expect(json.diff.hunks).toContain('@@')
    expect(json.diff.hunks).toContain('+two')
    expect(json.diff.truncated).toBe(false)
  })

  it('supports to=head', async () => {
    if (!GIT_AVAILABLE) return
    await putFile(h, 'h.md', 'foo\n')
    const hist = (
      await (
        await authedFetch(
          h.base,
          `/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('h.md')}`,
        )
      ).json() as { history: { sha: string }[] }
    ).history
    const fromSha = hist[0]?.sha as string
    // PUT another version (becomes HEAD)
    await putFile(h, 'h.md', 'foo\nbar\n')
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/diff?path=${encodeURIComponent('h.md')}&from=${fromSha}&to=head`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { diff: { hunks: string } }
    expect(json.diff.hunks).toContain('+bar')
  })

  it('rejects missing from with missing_from', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/diff?path=${encodeURIComponent('a.md')}`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_from')
  })

  it('rejects malformed from with invalid_sha', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/diff?path=${encodeURIComponent('a.md')}&from=not-a-sha`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_sha')
  })
})

describe('app-docs surface — version-unavailable degradation', () => {
  it('history returns 503 versioning_unavailable when no version store wired', async () => {
    // Construct a surface WITHOUT a version store.
    const tmp = mkdtempSync(join(tmpdir(), 'p74-novs-'))
    try {
      const owner_home = join(tmp, 'home')
      mkdirSync(owner_home, { recursive: true })
      mkdirSync(join(owner_home, 'Projects', PROJECT_ID, 'docs'), { recursive: true })
      const store = new DocStore({ owner_home }) // no versionStore
      const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
      const surface = createAppDocsSurface({ store, auth, project_slug: PROJECT_SLUG })
      const composed = composeHttpHandler({
        appDocs: { handler: surface.handler },
        defaultHandler: () => new Response('not found', { status: 404 }),
      })
      const host = `gw-${++__gatewaySeq}.test`
      __composedHandlers.set(host, composed)
      try {
        const res = await fetch(
          `http://${host}/api/app/projects/${PROJECT_ID}/docs/history?path=${encodeURIComponent('a.md')}`,
          { headers: { authorization: 'Bearer dev:sam' } },
        )
        expect(res.status).toBe(503)
        const json = (await res.json()) as { code: string }
        expect(json.code).toBe('versioning_unavailable')
      } finally {
        __composedHandlers.delete(host)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
