/**
 * ISSUE #41 — chat-bridge escalation routing E2E.
 *
 * The chat composer is per-instance (one engine per WS session, NOT
 * per-project) but inline-comment escalations from the docs UI are
 * per-project. Pre-#41 the chat composer was hardcoded at
 * `gateway/index.ts:ownerChatProjectId = 'default'`, so an escalation
 * from a non-default project landed in THAT project's
 * `.comments/comments.db` sidecar but the chat composer never read it
 * on the next turn — the UI returned 200 and the chat turn was unaware.
 *
 * The fix wires:
 *
 *   1. `WebChatSessionProjectRegistry` per-instance in-memory tracker of
 *      "user_id → current chat project_id".
 *   2. The docs surface's escalate POST handler calls
 *      `setActive(user_id, project_id)` after a successful append.
 *   3. The chat composer's `buildPhaseSpecResolver` accepts a
 *      `() => string | null` closure for `escalation_project_id`; the
 *      production composer wires it against `registry.getActive(user_id)`.
 *      The closure is invoked on EVERY LLM call, so each chat turn
 *      reads pending escalations from THIS user's currently-pinned
 *      project (falling back to `'default'` for users who have not
 *      escalated anything yet in this gateway-process lifetime).
 *
 * This test pins the end-to-end routing flow:
 *
 *   - chat-bridge session in project `foo` → escalate event posted via
 *     the docs surface → registry pins foo → next resolver turn includes
 *     the `<escalated_comment_threads>` envelope sourced from foo's
 *     sidecar.
 *   - same session escalates from project `bar` → registry re-pins to
 *     bar → next resolver turn sources from bar's sidecar AND does NOT
 *     include foo's envelope (cross-project bleed forbidden — both
 *     sidecars share one CommentStore but the per-project sidecar
 *     bookkeeping is intact).
 *
 * Spec-conformance (ISSUE #41 closing condition):
 *   - "user escalates from project `foo`; next chat turn in project
 *      `foo` includes the `<escalated_comment_threads>` envelope" — yes
 *   - "chat turn in project `bar` does NOT include foo's envelope" — yes
 *
 * Out of scope (explicitly per the brief):
 *   - cross-project escalation aggregation
 *   - per-instance default project_id config
 *   - UI changes (the escalate button stays per-project)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ApiKeyStore } from '../../auth/api-key-store.ts'
import { SecretsStore } from '../../auth/secrets-store.ts'
import { CommentStore } from '../comments/comment-store.ts'
import { createAppDocsSurface } from '../http/app-docs-surface.ts'
import { InMemoryWebChatSessionProjectRegistry } from '../http/chat-bridge.ts'
import { DocStore } from '../http/doc-store.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { buildPhaseSpecResolver } from '../realmode-composer/build-phase-spec-resolver.ts'

const PROJECT_SLUG = 'demo'
const USER_ID = 'sam'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  commentStore: CommentStore
  registry: InMemoryWebChatSessionProjectRegistry
  owner_home: string
  tmp: string
  apiKeys: ApiKeyStore
  db: ProjectDb
  close(): Promise<void>
}

async function startHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-chat-bridge-escalation-'))
  const owner_home = join(tmp, 'home')
  mkdirSync(owner_home, { recursive: true })

  // Per-project docs roots — the docs surface needs them on disk for
  // the OCC baseline (the seed comment carries based_on_modified_at
  // sourced from the file mtime).
  for (const project_id of ['foo', 'bar']) {
    const docsDir = join(owner_home, 'Projects', project_id, 'docs', 'notes')
    mkdirSync(docsDir, { recursive: true })
    writeFileSync(join(docsDir, 'doc.md'), `# ${project_id} doc\n`, 'utf8')
  }

  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const secrets = new SecretsStore({ data_dir: tmp, db })
  const apiKeys = new ApiKeyStore({ db, secrets })

  const docsStore = new DocStore({ owner_home })
  const commentStore = new CommentStore({ owner_home })
  const registry = new InMemoryWebChatSessionProjectRegistry()
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })

  const surface = createAppDocsSurface({
    store: docsStore,
    auth,
    project_slug: PROJECT_SLUG,
    comments: commentStore,
    chatSessionProjects: registry,
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

  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    commentStore,
    registry,
    owner_home,
    tmp,
    apiKeys,
    db,
    close: async () => {
      commentStore.closeAll()
      db.close()
      await server.stop(true)
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
  headers.set('authorization', `Bearer dev:${USER_ID}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(`${base}${path}`, { ...init, headers })
}

/** Post a root comment via the docs surface so we have a thread_root_id
 *  to escalate against. Returns the event_id (the same id is the thread
 *  root id for a fresh root post). */
async function postRoot(
  base: string,
  owner_home: string,
  project_id: string,
  anchor_excerpt: string,
  body: string,
): Promise<{ event_id: string; thread_root_id: string }> {
  const docPath = 'notes/doc.md'
  const mtime = Math.floor(
    statSync(join(owner_home, 'Projects', project_id, 'docs', docPath)).mtimeMs,
  )
  const res = await authedFetch(
    base,
    `/api/app/projects/${project_id}/docs/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        path: docPath,
        anchor_start: 0,
        anchor_end: anchor_excerpt.length,
        anchor_text_excerpt: anchor_excerpt,
        anchor_ctx_before: '',
        anchor_ctx_after: '',
        body,
        based_on_modified_at: mtime,
      }),
    },
  )
  if (res.status !== 200) {
    throw new Error(`postRoot failed: status=${res.status} body=${await res.text()}`)
  }
  const json = (await res.json()) as {
    event: { event_id: string }
    thread_root_id: string
  }
  return { event_id: json.event.event_id, thread_root_id: json.thread_root_id }
}

async function postEscalate(
  base: string,
  project_id: string,
  event_id: string,
): Promise<{ escalate_event_id: string; status: number }> {
  const res = await authedFetch(
    base,
    `/api/app/projects/${project_id}/docs/comments/${event_id}/escalate`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  )
  if (res.status !== 200) {
    return { escalate_event_id: '', status: res.status }
  }
  const json = (await res.json()) as { escalate_event_id: string }
  return { escalate_event_id: json.escalate_event_id, status: res.status }
}

/** Build a phase-spec resolver wired against the registry's getActive,
 *  exactly mirroring the production composer at
 *  `gateway/index.ts:2511-2536` (the post-#41 closure-based shape).
 *
 *  Sprint cc-substrate-migration-3-sites (2026-05-31) — resolver now
 *  consumes a `Substrate`. The fake substrate captures `spec.prompt`
 *  (which packs `<composed system>\n\n<user>`) into the supplied array
 *  so existing tests keep their string-array assertion shape. */
async function buildResolver(
  h: Harness,
  captured: string[],
): Promise<NonNullable<Awaited<ReturnType<typeof buildPhaseSpecResolver>>>> {
  const substrate: import('../../runtime/substrate.ts').Substrate = {
    start(spec): import('../../runtime/session-handle.ts').SessionHandle {
      captured.push(spec.prompt)
      const events = (async function* (): AsyncGenerator<
        import('../../runtime/events.ts').Event,
        void,
        void
      > {
        yield { kind: 'token', text: JSON.stringify({ body: 'hi' }) }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'chat-bridge-escalation-fake',
        }
      })()
      return {
        events,
        respondToTool: async () => {
          throw new Error('fake substrate: respondToTool unused')
        },
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
  const ownerChatProjectIdResolver = (): string =>
    h.registry.getActive(USER_ID) ?? 'default'
  const resolver = await buildPhaseSpecResolver({
    substrate,
    log_slug: 't1',
    env: {
      NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
    },
    owner_data_dir: null,
    personaLoader: null,
    commentStore: h.commentStore,
    escalation_project_id: ownerChatProjectIdResolver,
  })
  if (resolver === null) {
    throw new Error('resolver was null; expected a working resolver')
  }
  return resolver
}

const RESOLVE_BUNDLE = {
  project_slug: PROJECT_SLUG,
  topic_id: `web:${USER_ID}`,
  user_id: USER_ID,
  signup_via: 'web' as const,
  telegram_display_name: null,
  phase: 'signup' as const,
  intent: {
    goal: 'g',
    shape: 'free-text' as const,
    allowed_option_values: [] as string[],
    max_body_chars: 200,
  },
  captured: {},
  recent_turns: [] as never[],
  attempt_count: 0,
  rejection_reason: null,
}

describe('chat-bridge escalation routing — ISSUE #41', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('escalate from project foo → next chat turn pulls envelope from foo; switching to bar excludes foo content', async () => {
    // Seed a thread root in each project so we can escalate against
    // them via the HTTP surface (the docs surface needs a real thread
    // root id; getThread() walks to the canonical root and fails on
    // an unknown event_id with 404 thread_not_found).
    const fooRoot = await postRoot(
      h.base,
      h.owner_home,
      'foo',
      'FOO-PROJECT-ANCHOR',
      'foo project body discussion',
    )
    const barRoot = await postRoot(
      h.base,
      h.owner_home,
      'bar',
      'BAR-PROJECT-ANCHOR',
      'bar project body discussion',
    )

    // Sanity: nothing in the registry yet — the resolver should fall
    // back to `default` (and find no pending escalations there).
    expect(h.registry.getActive(USER_ID)).toBeNull()

    // Build the resolver and exercise an initial pre-escalation turn
    // to pin the fallback behaviour: `default` sidecar is empty so
    // no envelope appears.
    const captured: string[] = []
    const resolver = await buildResolver(h, captured)
    await resolver.resolve(RESOLVE_BUNDLE)
    expect(captured.length).toBe(1)
    expect(captured[0]).not.toContain('<escalated_comment_threads>')

    // ── Phase 1: escalate from foo. ─────────────────────────────────
    const escalateFoo = await postEscalate(h.base, 'foo', fooRoot.event_id)
    expect(escalateFoo.status).toBe(200)
    expect(escalateFoo.escalate_event_id.length).toBeGreaterThan(0)
    // The docs surface should have pinned the registry on append.
    expect(h.registry.getActive(USER_ID)).toBe('foo')

    // Next chat turn — the closure resolves to 'foo' and the envelope
    // sources from foo's sidecar (NOT bar, NOT default).
    await resolver.resolve(RESOLVE_BUNDLE)
    expect(captured.length).toBe(2)
    expect(captured[1]).toContain('<escalated_comment_threads>')
    expect(captured[1]).toContain('FOO-PROJECT-ANCHOR')
    expect(captured[1]).toContain('foo project body discussion')
    expect(captured[1]).not.toContain('BAR-PROJECT-ANCHOR')

    // ── Phase 2: same user escalates from bar. ──────────────────────
    const escalateBar = await postEscalate(h.base, 'bar', barRoot.event_id)
    expect(escalateBar.status).toBe(200)
    expect(escalateBar.escalate_event_id.length).toBeGreaterThan(0)
    // Registry now points at bar (last-escalation-wins semantic).
    expect(h.registry.getActive(USER_ID)).toBe('bar')

    // Next chat turn — the closure resolves to 'bar'. Envelope must
    // source from bar's sidecar; foo content from the prior phase
    // MUST NOT leak into this turn even though both sidecars share
    // one CommentStore. This is the load-bearing assertion of
    // ISSUE #41: cross-project bleed is forbidden.
    await resolver.resolve(RESOLVE_BUNDLE)
    expect(captured.length).toBe(3)
    expect(captured[2]).toContain('<escalated_comment_threads>')
    expect(captured[2]).toContain('BAR-PROJECT-ANCHOR')
    expect(captured[2]).toContain('bar project body discussion')
    // Negative assertion — the load-bearing spec-conformance check.
    expect(captured[2]).not.toContain('FOO-PROJECT-ANCHOR')
    expect(captured[2]).not.toContain('foo project body discussion')
  })

  it('escalate POST against a missing chatSessionProjects registry is non-fatal (legacy boot back-compat)', async () => {
    // Spin up a parallel harness whose docs surface does NOT receive
    // chatSessionProjects — proves the optional shape preserves the
    // pre-#41 escalate behaviour (event still lands, no registry
    // mutation expected because there is no registry).
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-chat-bridge-escalation-legacy-'))
    const owner_home = join(tmp, 'home')
    const docsDir = join(owner_home, 'Projects', 'foo', 'docs', 'notes')
    mkdirSync(docsDir, { recursive: true })
    writeFileSync(join(docsDir, 'doc.md'), '# foo doc\n', 'utf8')
    const docsStore = new DocStore({ owner_home })
    const commentStore = new CommentStore({ owner_home })
    const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
    const surface = createAppDocsSurface({
      store: docsStore,
      auth,
      project_slug: PROJECT_SLUG,
      comments: commentStore,
      // chatSessionProjects omitted intentionally — pre-#41 shape.
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
      const base = `http://127.0.0.1:${server.port}`
      const root = await postRoot(
        base,
        owner_home,
        'foo',
        'LEGACY-ANCHOR',
        'legacy body',
      )
      const res = await postEscalate(base, 'foo', root.event_id)
      // Escalate still succeeds — the surface treats chatSessionProjects
      // as an optional convenience, not a load-bearing dependency.
      expect(res.status).toBe(200)
      expect(res.escalate_event_id.length).toBeGreaterThan(0)
    } finally {
      commentStore.closeAll()
      await server.stop(true)
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
