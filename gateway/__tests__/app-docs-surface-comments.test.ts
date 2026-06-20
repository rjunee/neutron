/**
 * P7.2 S1 — HTTP surface integration tests for the four comments routes.
 *
 * Round-trips:
 *   - POST /docs/comments       (root + reply via parent_event_id)
 *   - GET  /docs/comments       (list — anchor row + status filter + cursor)
 *   - POST /docs/comments/<id>/reply
 *   - GET  /docs/comments/<id>/thread
 *
 * Plus the negative-path matrix per brief § 10.1:
 *   - missing bearer / instance mismatch
 *   - missing path / missing body
 *   - 413 comment_too_large
 *   - 404 thread_not_found
 *   - 503 comments_unavailable (surface mounted without CommentStore)
 *   - 400 invalid_event_id / invalid_parent_event_id
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { CommentStore } from '../comments/comment-store.ts'
import { createAppDocsSurface } from '../http/app-docs-surface.ts'
import { DocStore } from '../http/doc-store.ts'
import { composeHttpHandler } from '../http/compose.ts'

const PROJECT_ID = 'demo-project'
const PROJECT_SLUG = 'demo'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  store: DocStore
  comments: CommentStore
  owner_home: string
  tmp: string
  close(): Promise<void>
}

async function startGateway(
  opts: { wireComments?: boolean } = {},
): Promise<Harness> {
  const wireComments = opts.wireComments ?? true
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-comments-surface-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
  mkdirSync(docsRoot, { recursive: true })

  const store = new DocStore({ owner_home })
  const comments = new CommentStore({ owner_home })
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const surfaceOpts: Parameters<typeof createAppDocsSurface>[0] = {
    store,
    auth,
    project_slug: PROJECT_SLUG,
  }
  if (wireComments) surfaceOpts.comments = comments
  const surface = createAppDocsSurface(surfaceOpts)
  const composed = composeHttpHandler({
    appDocs: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  // ISSUES #13 — record the active owner_home so `postRoot(base, body)`
  // (the helper-without-override form) can locate the on-disk doc when
  // seeding the OCC baseline. Pagination tests that build their own
  // server pass owner_home explicitly into `postRoot`.
  activeOwnerHome = owner_home
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    store,
    comments,
    owner_home,
    tmp,
    close: async () => {
      comments.closeAll()
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
      activeOwnerHome = null
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

/**
 * Materialise `notes/foo.md` on disk under the test owner_home and
 * return its current mtime in ms. Idempotent — repeated calls only
 * touch the file when it doesn't exist yet, so callers can chain
 * multiple `postRoot(...)`s without invalidating each other's OCC
 * baseline.
 *
 * Required because ISSUES #13 makes `based_on_modified_at` mandatory on
 * root comments — the previous test helper omitted it and relied on
 * the now-rejected "null skips OCC" path.
 */
function seedFooDoc(owner_home: string): number {
  const docsDir = join(owner_home, 'Projects', PROJECT_ID, 'docs', 'notes')
  mkdirSync(docsDir, { recursive: true })
  const absDoc = join(docsDir, 'foo.md')
  try {
    statSync(absDoc)
  } catch {
    writeFileSync(absDoc, '# foo\n', 'utf8')
  }
  return Math.floor(statSync(absDoc).mtimeMs)
}

async function postRoot(
  base: string,
  body: string,
  /**
   * Optional override for the per-test owner_home. Defaults to the
   * Harness owner_home registered at startup; the pagination tests
   * that spin up their own server pass their custom owner_home so
   * `notes/foo.md` lands in the right tree.
   */
  owner_home?: string,
): Promise<{
  event_id: string
  thread_root_id: string
  status: number
}> {
  const home = owner_home ?? activeOwnerHome
  if (home === null) {
    throw new Error('postRoot: no active owner_home — call startGateway first or pass explicitly')
  }
  const mtime = seedFooDoc(home)
  const res = await authedFetch(
    base,
    `/api/app/projects/${PROJECT_ID}/docs/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        path: 'notes/foo.md',
        anchor_start: 0,
        anchor_end: body.length,
        anchor_text_excerpt: body,
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body,
        // ISSUES #13 — root comments must supply the OCC baseline.
        based_on_modified_at: mtime,
      }),
    },
  )
  const json = (await res.json()) as {
    event: { event_id: string }
    thread_root_id: string
  }
  return {
    event_id: json.event.event_id,
    thread_root_id: json.thread_root_id,
    status: res.status,
  }
}

// The Harness records its owner_home in this module-scoped slot so
// the shared `postRoot` helper resolves the right disk root without
// every caller having to thread it through explicitly. Pagination
// tests that spin their own server pass their custom owner_home via
// `postRoot(base, body, owner_home)` instead.
let activeOwnerHome: string | null = null

describe('app-docs comments — auth + missing-comments', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('rejects unauth requests with 401', async () => {
    const res = await fetch(
      `${h.base}/api/app/projects/${PROJECT_ID}/docs/comments?path=notes/foo.md`,
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 project_mismatch when the bearer project does not match', async () => {
    // The dev resolver returns project_slug=PROJECT_SLUG, so we mount
    // the surface with a different slug to force the mismatch path.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-comments-tm-'))
    const owner_home = join(tmp, 'home')
    mkdirSync(owner_home, { recursive: true })
    const store = new DocStore({ owner_home })
    const comments = new CommentStore({ owner_home })
    const auth = createAppWsAuthResolver({ project_slug: 'somebody-else', bypass: true })
    const surface = createAppDocsSurface({
      store,
      auth,
      project_slug: 'gateway-slug',
      comments,
    })
    const composed = composeHttpHandler({
      appDocs: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => composed.fetch(req, srv),
      websocket: composed.websocket,
    })
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/app/projects/${PROJECT_ID}/docs/comments?path=x.md`,
        { headers: { authorization: 'Bearer dev:sam' } },
      )
      expect(res.status).toBe(403)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('project_mismatch')
    } finally {
      comments.closeAll()
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('app-docs comments — comments_unavailable', () => {
  it('returns 503 when the surface is mounted without a CommentStore', async () => {
    const h = await startGateway({ wireComments: false })
    try {
      const res = await authedFetch(
        h.base,
        `/api/app/projects/${PROJECT_ID}/docs/comments?path=notes/foo.md`,
      )
      expect(res.status).toBe(503)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('comments_unavailable')
    } finally {
      await h.close()
    }
  })
})

describe('app-docs comments — POST + GET roundtrip', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('POST /docs/comments returns a fresh event_id and lists it on GET', async () => {
    const post = await postRoot(h.base, 'is this still accurate?')
    expect(post.status).toBe(200)
    expect(post.event_id.length).toBe(26)
    const list = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent('notes/foo.md')}`,
    )
    expect(list.status).toBe(200)
    const json = (await list.json()) as {
      threads: { thread_root_id: string; anchor: { excerpt: string | null } }[]
    }
    expect(json.threads.length).toBe(1)
    expect(json.threads[0]!.thread_root_id).toBe(post.thread_root_id)
    expect(json.threads[0]!.anchor.excerpt).toBe('is this still accurate?')
  })

  it('POST /docs/comments rejects a missing path field with 400', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body: 'no path' }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_path')
  })

  it('POST /docs/comments rejects a missing body with 400', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ path: 'notes/foo.md' }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_body')
  })

  it('POST /docs/comments returns 413 on a body > 8 KB', async () => {
    const tooLong = 'x'.repeat(8 * 1024 + 1)
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/foo.md',
          anchor_start: 0,
          anchor_end: 1,
          anchor_text_excerpt: 'x',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: tooLong,
        }),
      },
    )
    expect(res.status).toBe(413)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('comment_too_large')
  })

  // ISSUES #13 — root posts must supply the OCC baseline. Pre-fix the
  // wire DTO marked it optional, so any client could omit the field
  // and bypass the `doc_changed_underfoot` check entirely. The reply
  // path (parent_event_id !== null) is intentionally unaffected.
  it('POST /docs/comments without based_on_modified_at on a root post returns 400 missing_based_on_modified_at (ISSUES #13)', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/foo.md',
          anchor_start: 0,
          anchor_end: 3,
          anchor_text_excerpt: 'abc',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: 'no occ baseline',
        }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_based_on_modified_at')
  })

  it('POST /docs/comments with explicit based_on_modified_at: null on a root post still returns 400 (ISSUES #13)', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/foo.md',
          anchor_start: 0,
          anchor_end: 3,
          anchor_text_excerpt: 'abc',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: 'explicit null',
          based_on_modified_at: null,
        }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_based_on_modified_at')
  })

  it('POST /docs/comments rejects a whitespace-only excerpt with 400', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/foo.md',
          anchor_start: 0,
          anchor_end: 3,
          anchor_text_excerpt: '   ',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: 'comment on whitespace',
        }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('whitespace_only_excerpt')
  })
})

describe('app-docs comments — replies', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('POST /docs/comments with parent_event_id appends a reply that inherits the thread', async () => {
    const root = await postRoot(h.base, 'root body')
    const replyRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/foo.md',
          parent_event_id: root.event_id,
          body: 'reply via parent_event_id',
        }),
      },
    )
    expect(replyRes.status).toBe(200)
    const replyJson = (await replyRes.json()) as {
      thread_root_id: string
      event: { event_id: string }
    }
    expect(replyJson.thread_root_id).toBe(root.thread_root_id)

    const threadRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments/${root.event_id}/thread`,
    )
    expect(threadRes.status).toBe(200)
    const tree = (await threadRes.json()) as {
      thread: {
        root: { event_id: string }
        replies: { event_id: string; body: string }[]
        anchor: { reply_count: number }
      }
    }
    expect(tree.thread.root.event_id).toBe(root.event_id)
    expect(tree.thread.replies.length).toBe(1)
    expect(tree.thread.replies[0]!.body).toBe('reply via parent_event_id')
    expect(tree.thread.anchor.reply_count).toBe(1)
  })

  it('POST /docs/comments/<id>/reply shortcut also lands a reply', async () => {
    const root = await postRoot(h.base, 'root body 2')
    const replyRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments/${root.event_id}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({ body: 'reply via shortcut' }),
      },
    )
    expect(replyRes.status).toBe(200)
    const replyJson = (await replyRes.json()) as { thread_root_id: string }
    expect(replyJson.thread_root_id).toBe(root.thread_root_id)
  })

  it('POST /docs/comments with an unknown parent_event_id returns 404', async () => {
    // The CommentStore.appendEvent raises CommentNotFoundError when
    // the parent lookup misses. jsonForError maps that to 404
    // thread_not_found.
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/foo.md',
          parent_event_id: '01HW0000000000000000000099',
          body: 'orphan',
        }),
      },
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('thread_not_found')
  })

  it('POST /docs/comments with a malformed parent_event_id returns 400', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/foo.md',
          parent_event_id: 'not-a-ulid',
          body: 'bad parent',
        }),
      },
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_parent_event_id')
  })

  // Argus r2 IMPORTANT #2 — when a client posts a reply via the body
  // `parent_event_id` route AND supplies a different `path`, the reply
  // must land on the parent's doc (canonical), NOT on the client's
  // claimed doc. The `/reply` shortcut already did this; the body
  // route trusted the client `path` and persisted the reply with a
  // mismatched doc_path that desynced the materialised view. This
  // test creates a root on doc A, posts a body-route reply with
  // parent_event_id from doc A but `path` pointing at doc B, then
  // asserts the persisted row + materialised view both report the
  // reply under doc A — not B.
  it('POST /docs/comments with parent_event_id ignores a client-supplied path and uses the parent thread doc', async () => {
    const rootA = await postRoot(h.base, 'root on A')
    expect(rootA.status).toBe(200)
    const replyRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/bar.md',
          parent_event_id: rootA.event_id,
          body: 'reply claiming doc B',
        }),
      },
    )
    expect(replyRes.status).toBe(200)
    const replyJson = (await replyRes.json()) as {
      thread_root_id: string
      event: { event_id: string; doc_path: string }
    }
    // The thread the reply landed on is still the doc-A thread.
    expect(replyJson.thread_root_id).toBe(rootA.thread_root_id)
    // The persisted row itself carries the canonical doc_path from
    // the parent thread (doc A — `notes/foo.md` per `postRoot`),
    // NOT the body-supplied `notes/bar.md`.
    expect(replyJson.event.doc_path).toBe('notes/foo.md')
    // Listing doc A still shows the thread with reply_count = 1.
    const listA = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent('notes/foo.md')}`,
    )
    expect(listA.status).toBe(200)
    const listAJson = (await listA.json()) as {
      threads: {
        thread_root_id: string
        doc_path: string
        reply_count: number
      }[]
    }
    expect(listAJson.threads.length).toBe(1)
    expect(listAJson.threads[0]!.thread_root_id).toBe(rootA.thread_root_id)
    expect(listAJson.threads[0]!.doc_path).toBe('notes/foo.md')
    expect(listAJson.threads[0]!.reply_count).toBe(1)
    // Listing doc B has nothing — the reply did not land there.
    const listB = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent('notes/bar.md')}`,
    )
    expect(listB.status).toBe(200)
    const listBJson = (await listB.json()) as {
      threads: { thread_root_id: string }[]
    }
    expect(listBJson.threads.length).toBe(0)
  })
})

describe('app-docs comments — GET /docs/comments listing', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns an empty list with next_cursor=null for a fresh doc', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent('notes/empty.md')}`,
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      threads: unknown[]
      next_cursor: string | null
    }
    expect(json.threads).toEqual([])
    expect(json.next_cursor).toBe(null)
  })

  it('rejects a missing path with 400 missing_path', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
    )
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_path')
  })
})

describe('app-docs comments — GET /docs/comments/<id>/thread', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns 404 thread_not_found for an unknown event_id', async () => {
    // Need to lazy-init the sidecar first so the migration is applied;
    // calling getThread on a fresh project would otherwise 404 with a
    // different shape depending on the SQLite state.
    await h.comments.ensureInit(PROJECT_ID)
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments/01HW0000000000000000000099/thread`,
    )
    expect(res.status).toBe(404)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('thread_not_found')
  })

  it('returns 400 invalid_event_id on a malformed id segment', async () => {
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments/not-a-ulid/thread`,
    )
    // The regex rejects this entirely (no match), so the dispatcher
    // falls through to the generic 404 "unknown_docs_route". Either
    // result is acceptable defensively, but a 400/404 not-200 is the
    // load-bearing assertion.
    expect(res.status === 400 || res.status === 404).toBe(true)
  })
})

/* ─── Argus r1 BLOCKING #1 — author identity hardcoded from bearer ──── */

describe('app-docs comments — author identity is server-authoritative', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  async function postWithFields(extra: Record<string, unknown>) {
    // ISSUES #13 — seed the OCC baseline so the new
    // missing_based_on_modified_at guard doesn't 400 these tests
    // before the author-identity check fires.
    const mtime = seedFooDoc(h.owner_home)
    return authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/comments`, {
      method: 'POST',
      body: JSON.stringify({
        path: 'notes/foo.md',
        anchor_start: 0,
        anchor_end: 3,
        anchor_text_excerpt: 'abc',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body: 'identity test',
        based_on_modified_at: mtime,
        ...extra,
      }),
    })
  }

  it("silently overrides body-supplied author_id with the bearer's user_id", async () => {
    const res = await postWithFields({ author_id: 'somebody-else' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      event: { author_id: string; author_kind: string }
    }
    // Bearer is `dev:sam` so resolved.user_id === 'sam'.
    expect(json.event.author_id).toBe('sam')
    expect(json.event.author_kind).toBe('user')
  })

  it("ignores body-supplied author_kind='agent' and pins it to 'user'", async () => {
    const res = await postWithFields({ author_kind: 'agent' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { event: { author_kind: string } }
    expect(json.event.author_kind).toBe('user')
  })

  it("ignores body-supplied author_kind='system' and pins it to 'user'", async () => {
    const res = await postWithFields({ author_kind: 'system' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { event: { author_kind: string } }
    expect(json.event.author_kind).toBe('user')
  })

  it('reply route also pins author_kind+author_id from the bearer', async () => {
    const root = await postRoot(h.base, 'parent root')
    const replyRes = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments/${root.event_id}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({
          body: 'reply with fake identity',
          author_id: 'mallory',
          author_kind: 'system',
        }),
      },
    )
    expect(replyRes.status).toBe(200)
    const replyJson = (await replyRes.json()) as {
      event: { author_id: string; author_kind: string }
    }
    expect(replyJson.event.author_id).toBe('sam')
    expect(replyJson.event.author_kind).toBe('user')
  })
})

/* ─── Argus r1 BLOCKING #2 — path validation on the comments routes ── */

describe('app-docs comments — path validation rejects hostile inputs', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  async function postWithPath(path: string): Promise<Response> {
    return authedFetch(h.base, `/api/app/projects/${PROJECT_ID}/docs/comments`, {
      method: 'POST',
      body: JSON.stringify({
        path,
        anchor_start: 0,
        anchor_end: 1,
        anchor_text_excerpt: 'x',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body: 'should never land',
      }),
    })
  }

  async function listWithPath(path: string): Promise<Response> {
    return authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent(path)}`,
    )
  }

  it('rejects POST with a .. segment as 400 invalid_path', async () => {
    const res = await postWithPath('notes/../secret.md')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects POST with a NUL byte as 400 invalid_path', async () => {
    const res = await postWithPath('notes/foo\0.md')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects POST with a POSIX absolute path as 400 invalid_path', async () => {
    const res = await postWithPath('/etc/passwd.md')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects POST with a Windows-style absolute path as 400 invalid_path', async () => {
    const res = await postWithPath('C:\\Windows\\foo.md')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })

  it('rejects POST with a hidden segment as 400 hidden_segment', async () => {
    const res = await postWithPath('.secret/notes.md')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('hidden_segment')
  })

  it('rejects POST with a non-.md extension as 400 invalid_extension', async () => {
    const res = await postWithPath('notes/foo.txt')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_extension')
  })

  it('GET /docs/comments also rejects a .. path with 400 invalid_path', async () => {
    const res = await listWithPath('notes/../escape.md')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_path')
  })
})

/* ─── Argus r1 IMPORTANT — composite cursor (last_reply_at + thread_root_id) ── */

describe('app-docs comments — pagination preserves rows on tied last_reply_at', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('surfaces all 3 threads across page_size=1 pages when timestamps collide', async () => {
    // Pin `now()` so every thread shares the same `last_reply_at`. Without
    // the composite (last_reply_at, thread_root_id) key, the cursor
    // walks past two of three rows silently.
    const fixedTs = 1_700_000_000_000
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-comments-tied-'))
    const owner_home = join(tmp, 'home')
    mkdirSync(owner_home, { recursive: true })
    const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
    mkdirSync(docsRoot, { recursive: true })

    const store = new DocStore({ owner_home })
    const comments = new CommentStore({ owner_home, now: () => fixedTs })
    const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
    const surface = createAppDocsSurface({
      store,
      auth,
      project_slug: PROJECT_SLUG,
      comments,
    })
    const composed = composeHttpHandler({
      appDocs: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => composed.fetch(req, srv),
      websocket: composed.websocket,
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      // Three roots — same ms timestamp, distinct event_ids.
      const e1 = await postRoot(base, 'first', owner_home)
      const e2 = await postRoot(base, 'second', owner_home)
      const e3 = await postRoot(base, 'third', owner_home)
      const all_ids = new Set([
        e1.thread_root_id,
        e2.thread_root_id,
        e3.thread_root_id,
      ])

      const seen = new Set<string>()
      let cursor: string | null = null
      // Bounded walk — at most 6 pages even on a regression (we expect 4
      // here: 3 result pages + a final empty/null page).
      for (let i = 0; i < 6; i += 1) {
        const url =
          cursor === null
            ? `${base}/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent('notes/foo.md')}&limit=1`
            : `${base}/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent('notes/foo.md')}&limit=1&cursor=${encodeURIComponent(cursor)}`
        const res = await authedFetch(base, url.replace(base, ''))
        expect(res.status).toBe(200)
        const json = (await res.json()) as {
          threads: { thread_root_id: string }[]
          next_cursor: string | null
        }
        for (const t of json.threads) seen.add(t.thread_root_id)
        cursor = json.next_cursor
        if (cursor === null) break
      }
      expect(seen.size).toBe(3)
      expect(seen).toEqual(all_ids)
    } finally {
      comments.closeAll()
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('next_cursor encoded as <ms>_<ulid> tuple', async () => {
    const fixedTs = 1_700_000_000_000
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-comments-tuple-'))
    const owner_home = join(tmp, 'home')
    mkdirSync(owner_home, { recursive: true })
    const docsRoot = join(owner_home, 'Projects', PROJECT_ID, 'docs')
    mkdirSync(docsRoot, { recursive: true })

    const store = new DocStore({ owner_home })
    const comments = new CommentStore({ owner_home, now: () => fixedTs })
    const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
    const surface = createAppDocsSurface({
      store,
      auth,
      project_slug: PROJECT_SLUG,
      comments,
    })
    const composed = composeHttpHandler({
      appDocs: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => composed.fetch(req, srv),
      websocket: composed.websocket,
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      await postRoot(base, 'one', owner_home)
      await postRoot(base, 'two', owner_home)
      const res = await authedFetch(
        base,
        `/api/app/projects/${PROJECT_ID}/docs/comments?path=${encodeURIComponent('notes/foo.md')}&limit=1`,
      )
      const json = (await res.json()) as { next_cursor: string | null }
      expect(json.next_cursor).not.toBeNull()
      // Tuple shape: digits, underscore, 26-char ULID.
      expect(json.next_cursor).toMatch(/^[0-9]+_[0-9A-HJKMNP-TV-Z]{26}$/)
    } finally {
      comments.closeAll()
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

/* ─── Argus r1 MINOR — 409 doc_changed_underfoot on stale based_on_modified_at ── */

describe('app-docs comments — doc_changed_underfoot 409', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('POST with stale based_on_modified_at returns 409 doc_changed_underfoot', async () => {
    // Materialise an on-disk markdown file so statDoc has a real mtime
    // to read.
    const absDoc = join(h.owner_home, 'Projects', PROJECT_ID, 'docs', 'notes', 'occ.md')
    mkdirSync(join(h.owner_home, 'Projects', PROJECT_ID, 'docs', 'notes'), {
      recursive: true,
    })
    writeFileSync(absDoc, '# OCC fixture\n', 'utf8')
    // Force the on-disk mtime FORWARD relative to the stale cursor the
    // client supplies. We pick a 5-minute gap so the mtime is
    // unambiguous regardless of FS resolution.
    const realMtime = Math.floor(statSync(absDoc).mtimeMs)
    const stale = realMtime - 5 * 60 * 1000

    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/occ.md',
          anchor_start: 0,
          anchor_end: 3,
          anchor_text_excerpt: 'OCC',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: 'should fail',
          based_on_modified_at: stale,
        }),
      },
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as {
      code: string
      current_modified_at: number | null
    }
    expect(json.code).toBe('doc_changed_underfoot')
    expect(json.current_modified_at).toBe(realMtime)
  })

  it('POST with matching based_on_modified_at lands (200 OK)', async () => {
    const absDoc = join(h.owner_home, 'Projects', PROJECT_ID, 'docs', 'notes', 'occ-ok.md')
    mkdirSync(join(h.owner_home, 'Projects', PROJECT_ID, 'docs', 'notes'), {
      recursive: true,
    })
    writeFileSync(absDoc, '# OK\n', 'utf8')
    const fresh = Math.floor(statSync(absDoc).mtimeMs)
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/occ-ok.md',
          anchor_start: 0,
          anchor_end: 2,
          anchor_text_excerpt: 'OK',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: 'should land',
          based_on_modified_at: fresh,
        }),
      },
    )
    expect(res.status).toBe(200)
  })

  // Argus r2 IMPORTANT #1 — the deleted-doc 409 path. The r1 fix had
  // `statDoc` throw `DocNotFoundError` BEFORE the inner stat() try/catch
  // could fire, so the `current === null` branch in `handlePostComment`
  // was unreachable: a stale comment targeting a deleted doc bubbled
  // out as a 404 instead of the spec'd 409
  // `doc_changed_underfoot{current_modified_at:null}`. The fix catches
  // `DocNotFoundError` inside `statDocModifiedAt` and returns null so
  // the OCC mismatch surfaces as 409.
  it('POST with based_on_modified_at after the doc was deleted returns 409 with current_modified_at:null', async () => {
    const absDoc = join(
      h.owner_home,
      'Projects',
      PROJECT_ID,
      'docs',
      'notes',
      'deleted.md',
    )
    mkdirSync(join(h.owner_home, 'Projects', PROJECT_ID, 'docs', 'notes'), {
      recursive: true,
    })
    writeFileSync(absDoc, '# soon to be gone\n', 'utf8')
    const mtime = Math.floor(statSync(absDoc).mtimeMs)
    // First post lands while the doc exists — proves the surface
    // was working before the delete.
    const first = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/deleted.md',
          anchor_start: 0,
          anchor_end: 5,
          anchor_text_excerpt: 'soon',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: 'first',
          based_on_modified_at: mtime,
        }),
      },
    )
    expect(first.status).toBe(200)
    // Delete the doc out from under the client. The stale
    // based_on_modified_at the client still holds points at the
    // now-vanished file.
    unlinkSync(absDoc)
    const res = await authedFetch(
      h.base,
      `/api/app/projects/${PROJECT_ID}/docs/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          path: 'notes/deleted.md',
          anchor_start: 0,
          anchor_end: 5,
          anchor_text_excerpt: 'soon',
          anchor_ctx_before: '',
          anchor_ctx_after: '',
          body: 'second after delete',
          based_on_modified_at: mtime,
        }),
      },
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as {
      code: string
      current_modified_at: number | null
    }
    expect(json.code).toBe('doc_changed_underfoot')
    expect(json.current_modified_at).toBeNull()
  })
})

