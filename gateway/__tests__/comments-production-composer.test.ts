/**
 * P7.2 S1 — ROUTE-BEHAVIOUR guard for the comments routes, given a
 * correctly-wired surface. Read the next paragraph before trusting the
 * filename.
 *
 * THIS FILE IS NOT A PRODUCTION-COMPOSER GUARD, despite its name and
 * despite what this header claimed until 2026-08-02. It builds its own
 * DocStore + CommentStore + AnchorWalker and threads them into
 * `createAppDocsSurface` by hand, then asserts the routes answer. That
 * proves the SURFACE, and it is worth having — but it is blind to the
 * only question its name implies it answers, "does a composer do this?"
 *
 * It was green for months while the answer was no. `new CommentStore(`
 * had zero non-test call sites in the repo, so `createAppDocsSurface`
 * fell to `opts.comments ?? null` (`app-docs-surface.ts:159`) in the one
 * composer Open has, and all six `/docs/comments*` routes answered 503
 * `comments_unavailable` to a web Documents tab that had been calling
 * them since WAVE 3. Every route assertion below passed throughout,
 * because every one of them ran against a surface this file built.
 *
 * Its old citations pointed at `gateway/index.ts:2989-3007` for the
 * "production" wiring. `gateway/index.ts` is 946 lines and has not
 * composed Open since the OSS split; the line range referred to nothing.
 * A hand-built fixture plus a dangling citation is precisely the shape
 * that survives a real outage, so the citations now point at the live
 * composer and the claim has been narrowed to what is actually checked.
 *
 * The producer-side half — boot `buildOpenGraphComposer`, read what it
 * carries, drive the routes through the composed graph — is
 * `open/__tests__/doc-comments-wiring.test.ts`. Neither file is
 * sufficient alone: this one would miss an unwired composer, and that
 * one would miss a route regression behind a correctly-wired surface.
 *
 * Mirrors the structure of `launcher-production-composer.test.ts` +
 * `tasks-production-composer.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '../composition.ts'
import { AnchorWalker } from '../comments/anchor-walker.ts'
import { CommentStore } from '../comments/comment-store.ts'
import { createAppDocsSurface } from '../http/app-docs-surface.ts'
import { DocStore } from '../http/doc-store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const OWNER = 'comments-composer-project'
const PROJECT = 'demo-project'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  graph: Awaited<ReturnType<typeof composeProductionGraph>>
  db: ProjectDb
  comments: CommentStore
  owner_home: string
  walker: AnchorWalker
  close(): Promise<void>
}

const noOpInputBase = {
  topic_handler: async () => {},
  approval_notifier: { notify: async () => undefined },
  watchdog_notifier: { notify: async () => undefined },
  reminder_dispatcher: { dispatch: async () => undefined },
  heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  platform: STUB_PLATFORM,
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-comments-prod-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })
  mkdirSync(join(owner_home, 'Projects', PROJECT, 'docs'), { recursive: true })
  const db = openMigratedDbAt(join(tmp, 'owner.db'))

  // Build the docs surface in the same SHAPE the live composer uses
  // (`open/composer.ts:1417` CommentStore, `:2684` AnchorWalker +
  // DocStore.onMutationSuccess, `:2694` createAppDocsSurface): DocStore
  // + CommentStore + AnchorWalker, with the walker's `handle` threaded
  // into `DocStore.onMutationSuccess` and the CommentStore threaded into
  // `createAppDocsSurface`.
  //
  // "Same shape" is the honest claim, and it is weaker than it sounds. A
  // rename breaks this construction at compile time, so the two cannot
  // drift in TYPE. They can drift in FACT without a word of warning —
  // the composer can simply stop passing `comments`, which is the state
  // this file sat green through. That direction is checked in
  // `open/__tests__/doc-comments-wiring.test.ts`, not here.
  //
  // If the wiring is correct but the chain drops a route, the per-route
  // asserts below catch it. The walker wiring is exercised by the
  // separate "AnchorWalker reach-through" test further down.
  const auth = createAppWsAuthResolver({ project_slug: OWNER, bypass: true })
  const comments = new CommentStore({ owner_home })
  const walker = new AnchorWalker({
    commentStore: comments,
    owner_home,
  })
  const docsStore = new DocStore({
    owner_home,
    onMutationSuccess: walker.handle,
  })
  const surface = createAppDocsSurface({
    store: docsStore,
    auth,
    project_slug: OWNER,
    comments,
  })

  // Boot the production graph with the docs surface threaded through —
  // the same `app_docs_surface` field `open/composer.ts:2694` fills. If a
  // future CompositionInput field rename / removal drops
  // `app_docs_surface` from the typed shape, this construction breaks at
  // compile time BEFORE the runtime test runs.
  const graph = await composeProductionGraph({
    db,
    project_slug: OWNER,
    ...noOpInputBase,
    app_docs_surface: { handler: surface.handler },
  })

  // ISSUE #32 — serve `graph.fetch` directly. The composed handler is
  // built by `composeProductionGraph` from `composition.app_docs_surface`,
  // so the boot-wiring mapping IS the only path exercised here. A
  // deletion of the `composeInput.appDocs = …` line in
  // `gateway/composition.ts:buildComposedHttpFromComposition` provably
  // breaks this test (closing condition for ISSUE #32).
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error(
      'composeProductionGraph did not expose graph.fetch — production-composer reachability gap (ISSUE #32)',
    )
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket

  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    graph,
    db,
    comments,
    owner_home,
    walker,
    close: async () => {
      comments.closeAll()
      await server.stop(true)
      await graph.shutdown()
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/**
 * Materialise `Projects/<PROJECT>/docs/<rel>` on disk under `owner_home`
 * and return its current mtime in ms (floor — matches the gateway's
 * comparison shape). Required because ISSUES #13 makes
 * `based_on_modified_at` mandatory on root comment POSTs; this helper
 * gives the test a real baseline to thread through. Idempotent —
 * repeated calls only touch the file when it doesn't exist yet.
 */
function seedDoc(owner_home: string, rel: string): number {
  const abs = join(owner_home, 'Projects', PROJECT, 'docs', rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  try {
    statSync(abs)
  } catch {
    writeFileSync(abs, '# seed\n', 'utf8')
  }
  return Math.floor(statSync(abs).mtimeMs)
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

let h: Harness
beforeEach(async () => {
  h = await startHarness()
})
afterEach(async () => {
  await h.close()
})

test('production composer mounts GET /api/app/projects/<id>/docs/comments', async () => {
  const res = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments?path=${encodeURIComponent('notes/foo.md')}`,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    threads: unknown[]
    next_cursor: string | null
  }
  expect(body.ok).toBe(true)
  expect(Array.isArray(body.threads)).toBe(true)
})

test('production composer mounts POST /api/app/projects/<id>/docs/comments', async () => {
  const mtime = seedDoc(h.owner_home, 'notes/foo.md')
  const res = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        path: 'notes/foo.md',
        anchor_start: 0,
        anchor_end: 5,
        anchor_text_excerpt: 'hello',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body: 'production composer says hi',
        based_on_modified_at: mtime,
      }),
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    ok: boolean
    event: { event_id: string }
    thread_root_id: string
  }
  expect(body.ok).toBe(true)
  expect(body.event.event_id.length).toBe(26)
  expect(body.thread_root_id).toBe(body.event.event_id)
})

test('production composer mounts POST /api/app/projects/<id>/docs/comments/<id>/reply', async () => {
  // Post root first (need a real event_id to reply to).
  const mtime = seedDoc(h.owner_home, 'notes/foo.md')
  const rootRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        path: 'notes/foo.md',
        anchor_start: 0,
        anchor_end: 5,
        anchor_text_excerpt: 'hello',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body: 'root',
        based_on_modified_at: mtime,
      }),
    },
  )
  const rootBody = (await rootRes.json()) as { event: { event_id: string } }
  const root_id = rootBody.event.event_id
  const replyRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments/${root_id}/reply`,
    {
      method: 'POST',
      body: JSON.stringify({ body: 'reply via shortcut' }),
    },
  )
  expect(replyRes.status).toBe(200)
  const replyBody = (await replyRes.json()) as {
    ok: boolean
    thread_root_id: string
  }
  expect(replyBody.ok).toBe(true)
  expect(replyBody.thread_root_id).toBe(root_id)
})

test('production composer mounts GET /api/app/projects/<id>/docs/comments/<id>/thread', async () => {
  const mtime = seedDoc(h.owner_home, 'notes/foo.md')
  const rootRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        path: 'notes/foo.md',
        anchor_start: 0,
        anchor_end: 5,
        anchor_text_excerpt: 'hello',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body: 'root for thread fetch',
        based_on_modified_at: mtime,
      }),
    },
  )
  const rootBody = (await rootRes.json()) as { event: { event_id: string } }
  const root_id = rootBody.event.event_id
  const threadRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments/${root_id}/thread`,
  )
  expect(threadRes.status).toBe(200)
  const body = (await threadRes.json()) as {
    ok: boolean
    thread: {
      root: { event_id: string; body: string }
      anchor: { thread_root_id: string }
      replies: unknown[]
    }
  }
  expect(body.ok).toBe(true)
  expect(body.thread.root.event_id).toBe(root_id)
  expect(body.thread.root.body).toBe('root for thread fetch')
  expect(body.thread.anchor.thread_root_id).toBe(root_id)
  expect(Array.isArray(body.thread.replies)).toBe(true)
})

test('AnchorWalker is wired into DocStore.onMutationSuccess end-to-end (Argus r1 BLOCKER #1)', async () => {
  // Why this test exists: the recurring anti-pattern Argus has flagged
  // 4× in 6 sprints — a feature ships with unit/integration coverage
  // but the production composer drops the dependency wiring. The P7.2 S2
  // walker's `onMutationSuccess` hook had no end-to-end test of the FULL
  // mutation chain, so a refactor that dropped `onMutationSuccess:
  // walker.handle` would not fail any test even though every doc edit in
  // production would skip re-anchor.
  //
  // Note the limit, same as the header's: the surface under test is
  // hand-built here, so this pins the CHAIN, not the composer. Until
  // 2026-08-02 the live composer built `new DocStore({ owner_home })`
  // with no walker at all (`open/composer.ts`), and this test was green
  // the whole time. The composer now wires it at `open/composer.ts:2684`,
  // and `open/__tests__/doc-comments-wiring.test.ts` is what reds if it
  // stops. Walker integration tests pass
  // because they call `walker.reanchorAfterEdit(...)` directly; the
  // wiring smoke test in `anchor-walker.test.ts` only verifies
  // DocStore fires the hook in isolation. This test exercises the
  // FULL chain: HTTP PUT → DocStore.writeDoc → invokeMutationHook →
  // walker.handle → comment-store events → materialised
  // doc_comment_anchors row at the new offset.
  //
  // 1. Post a comment anchored to "EXCERPT-MARKER" at start=10 in
  //    notes/wired.md (the initial PUT lands the file at the same
  //    path, then we post the comment).
  // 2. Issue a PUT that prepends "PREFIX\n\n" to the body. If the
  //    walker is correctly wired into onMutationSuccess, the
  //    materialised anchor moves to start=18 (10 + len('PREFIX\n\n')).
  //    If the wiring is dropped, the anchor stays at start=10 (the
  //    stale anchor_posted offset) because no walker event ever
  //    landed.
  const initialBody = 'preface\nEXCERPT-MARKER\nepilogue'
  const putRes1 = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/file`,
    {
      method: 'PUT',
      body: JSON.stringify({ path: 'notes/wired.md', content: initialBody }),
    },
  )
  expect(putRes1.status).toBe(200)
  const markerStart = initialBody.indexOf('EXCERPT-MARKER')
  expect(markerStart).toBe(8)
  // The PUT just materialised the file; ISSUES #13 requires the root
  // POST below to thread `based_on_modified_at` so the OCC check has a
  // real baseline.
  const wiredMtime = Math.floor(
    statSync(join(h.owner_home, 'Projects', PROJECT, 'docs', 'notes', 'wired.md')).mtimeMs,
  )
  const postCommentRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        path: 'notes/wired.md',
        anchor_start: markerStart,
        anchor_end: markerStart + 'EXCERPT-MARKER'.length,
        anchor_text_excerpt: 'EXCERPT-MARKER',
        anchor_ctx_before: 'preface\n',
        anchor_ctx_after: '\nepilogue',
        body: 'should follow the doc when prepended',
        based_on_modified_at: wiredMtime,
      }),
    },
  )
  expect(postCommentRes.status).toBe(200)
  const postBody = (await postCommentRes.json()) as {
    thread_root_id: string
  }
  // Issue the doc edit that should trigger the walker.
  const editedBody = 'PREFIX\n\n' + initialBody
  const putRes2 = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/file`,
    {
      method: 'PUT',
      body: JSON.stringify({ path: 'notes/wired.md', content: editedBody }),
    },
  )
  expect(putRes2.status).toBe(200)
  // The walker hook is awaited inside DocStore.writeDoc, so by the time
  // the PUT returns the materialised view already reflects the relocation.
  const listRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments?path=${encodeURIComponent('notes/wired.md')}`,
  )
  const listBody = (await listRes.json()) as {
    threads: ReadonlyArray<{
      thread_root_id: string
      anchor: { current_start: number | null; status: string }
    }>
  }
  expect(listBody.threads.length).toBe(1)
  const t = listBody.threads[0]!
  expect(t.thread_root_id).toBe(postBody.thread_root_id)
  expect(t.anchor.status).toBe('live')
  // 8 (orig marker start) + 8 (len('PREFIX\n\n')) = 16. If the walker
  // hook were unwired this would still be 8.
  expect(t.anchor.current_start).toBe(editedBody.indexOf('EXCERPT-MARKER'))
  expect(t.anchor.current_start).toBe(16)
})

test('AnchorWalker is wired for delete: DELETE /docs/file flips anchors dead via the hook', async () => {
  // Companion to the write reach-through test — covers the delete arm
  // of `DocStore.onMutationSuccess`. A future refactor that dropped
  // the delete-side hook fire would leave anchors live indefinitely
  // even though the file is gone, breaking the in-app comments side
  // pane's "this thread points at a deleted doc" affordance.
  const body = 'lone\nDELETE-MARKER\nstanding'
  const putRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/file`,
    {
      method: 'PUT',
      body: JSON.stringify({ path: 'notes/dead.md', content: body }),
    },
  )
  expect(putRes.status).toBe(200)
  const markerStart = body.indexOf('DELETE-MARKER')
  // PUT materialised the file; ISSUES #13 needs `based_on_modified_at`
  // on the root POST.
  const deadMtime = Math.floor(
    statSync(join(h.owner_home, 'Projects', PROJECT, 'docs', 'notes', 'dead.md')).mtimeMs,
  )
  await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        path: 'notes/dead.md',
        anchor_start: markerStart,
        anchor_end: markerStart + 'DELETE-MARKER'.length,
        anchor_text_excerpt: 'DELETE-MARKER',
        anchor_ctx_before: 'lone\n',
        anchor_ctx_after: '\nstanding',
        body: 'follow the file all the way to its grave',
        based_on_modified_at: deadMtime,
      }),
    },
  )
  // Sanity — anchor lands live first.
  const beforeRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments?path=${encodeURIComponent('notes/dead.md')}`,
  )
  const beforeBody = (await beforeRes.json()) as {
    threads: ReadonlyArray<{ anchor: { status: string } }>
  }
  expect(beforeBody.threads[0]!.anchor.status).toBe('live')
  // Delete the file via the production surface.
  const delRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/file?path=${encodeURIComponent('notes/dead.md')}`,
    { method: 'DELETE' },
  )
  expect(delRes.status).toBe(200)
  const afterRes = await authedFetch(
    h.base,
    `/api/app/projects/${PROJECT}/docs/comments?path=${encodeURIComponent('notes/dead.md')}&include_dead=true`,
  )
  const afterBody = (await afterRes.json()) as {
    threads: ReadonlyArray<{ anchor: { status: string } }>
  }
  expect(afterBody.threads.length).toBe(1)
  expect(afterBody.threads[0]!.anchor.status).toBe('dead')
})

test('every comments route requires a Bearer token (401 missing_bearer)', async () => {
  const paths: ReadonlyArray<[string, string, object | null]> = [
    [
      `/api/app/projects/${PROJECT}/docs/comments?path=notes/foo.md`,
      'GET',
      null,
    ],
    [
      `/api/app/projects/${PROJECT}/docs/comments`,
      'POST',
      {
        path: 'notes/foo.md',
        anchor_start: 0,
        anchor_end: 1,
        anchor_text_excerpt: 'x',
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body: 'x',
      },
    ],
    [
      `/api/app/projects/${PROJECT}/docs/comments/01HW0000000000000000000001/reply`,
      'POST',
      { body: 'x' },
    ],
    [
      `/api/app/projects/${PROJECT}/docs/comments/01HW0000000000000000000001/thread`,
      'GET',
      null,
    ],
  ]
  for (const [path, method, body] of paths) {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
    }
    if (body !== null) init.body = JSON.stringify(body)
    const res = await fetch(`${h.base}${path}`, init)
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
  }
})
