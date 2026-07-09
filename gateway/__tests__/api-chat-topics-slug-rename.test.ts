/**
 * Slug-rename instance-identity regression (2026-06-10 P0).
 *
 * Reproduces the live prod bug: after the post-onboarding slug picker
 * renames an owner's `url_slug` (t-33333333 → kairos), the browser's
 * session cookie carries the NEW url_slug while the per-instance gateway
 * stays bound to the frozen `internal_handle`
 * (`NEUTRON_INSTANCE_SLUG=t-33333333`). The cookie→claim resolver returns
 * `project_slug = row.url_slug` ("kairos"), the sidebar surface's
 * defense-in-depth guard compares it RAW against `opts.project_slug`
 * ("t-33333333"), and every `GET /api/v1/chat/topics` 401s with
 * `project_mismatch` — the sidebar renders only its client-default
 * General row even though the project DB holds live project rows.
 *
 * INVARIANT under test: a url_slug rename must NEVER break cookie-authed
 * HTTP requests. The instance-identity match must compare the STABLE
 * `internal_handle`, never the renameable `url_slug`.
 *
 * The harness wires the REAL production chain end-to-end:
 *   real OwnersRegistry (insert + updateUrlSlug rename)
 *   → real signSessionCookie(new url_slug)
 *   → cookie→claim resolution as `gateway/index.ts` composes it
 *   → real createChatTopicsSurface / createChatHistorySurface bound to
 *     the internal handle (exactly how the composer passes
 *     `project_slug` from NEUTRON_INSTANCE_SLUG).
 *
 * Timestamps are `Date.now()`-relative per the test-data-rot rule.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { signSessionCookie } from '@neutronai/landing/session-cookie.ts'
import type { CookieClaimRegistry } from '../http/cookie-user-claim.ts'
import { composeHttpHandler } from '../http/compose.ts'
import {
  createChatTopicsSurface,
  type ChatTopic,
} from '../http/chat-topics-surface.ts'
import { createChatHistorySurface } from '../http/chat-history-surface.ts'
import { buildCookieUserClaim } from '../http/cookie-user-claim.ts'
import { buildOwnerHandleResolver } from '../http/auth-helpers.ts'

/** Frozen registry PK — what NEUTRON_INSTANCE_SLUG carries in prod. */
const INTERNAL_HANDLE = 't-33333333'
/** User-chosen subdomain after the post-onboarding rename. */
const RENAMED_URL_SLUG = 'kairos'
const OWNER_USER_ID = 'user-owner-1'
const COOKIE_SECRET = 'test-cookie-secret-32-chars-long!!'

/**
 * ISSUES #219 — the production instances registry lives in a Managed-carved
 * registry module the Open split strips, but the Open production code under
 * test (`buildCookieUserClaim` + the instance-handle resolver) consumes it
 * through the narrow `CookieClaimRegistry` lookup contract only
 * (`getByInternalHandle` → {internal_handle, url_slug, owner_user_id},
 * `getBySlug` → {internal_handle}). This in-memory fake satisfies that exact
 * contract and keeps the same `insert` / `updateUrlSlug` fixture API the test
 * uses to build the renamed-instance prod shape — so the resolvers run the
 * identical canonical-internal-handle comparison without a Managed import.
 */
interface FakeInstanceRow {
  internal_handle: string
  url_slug: string
  owner_user_id: string | null
}

class FakeInstancesRegistry implements CookieClaimRegistry {
  private readonly byHandle = new Map<string, FakeInstanceRow>()

  insert(row: {
    internal_handle: string
    url_slug: string
    owner_user_id: string | null
    [key: string]: unknown
  }): void {
    this.byHandle.set(row.internal_handle, {
      internal_handle: row.internal_handle,
      url_slug: row.url_slug,
      owner_user_id: row.owner_user_id,
    })
  }

  /** Mirrors the registry's CAS rename: only commits when the current
   *  url_slug matches `casExpected`. */
  updateUrlSlug(
    internal_handle: string,
    new_url_slug: string,
    casExpected: string,
  ): boolean {
    const row = this.byHandle.get(internal_handle)
    if (row === undefined || row.url_slug !== casExpected) return false
    row.url_slug = new_url_slug
    return true
  }

  getByInternalHandle(internal_handle: string): FakeInstanceRow | undefined {
    return this.byHandle.get(internal_handle)
  }

  getBySlug(url_slug: string): { internal_handle: string } | undefined {
    for (const row of this.byHandle.values()) {
      if (row.url_slug === url_slug) return { internal_handle: row.internal_handle }
    }
    return undefined
  }
}

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  store: ButtonStore
  registry: FakeInstancesRegistry
  close(): Promise<void>
}

async function startRenamedOwnerGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-slug-rename-'))
  // --- registry with a RENAMED instance row (the prod shape) ---
  const registry = new FakeInstancesRegistry()
  registry.insert({
    internal_handle: INTERNAL_HANDLE,
    url_slug: INTERNAL_HANDLE, // first-issued slug == internal handle
    kind: 'user',
    tier: 'managed-shared',
    port: 48211,
    owner_user_id: OWNER_USER_ID,
    status: 'active',
    owner_home: join(tmp, 'owner-home'),
    systemd_unit: `neutron-instance@${INTERNAL_HANDLE}.service`,
    subdomain: INTERNAL_HANDLE,
  })
  const renamed = await registry.updateUrlSlug(
    INTERNAL_HANDLE,
    RENAMED_URL_SLUG,
    INTERNAL_HANDLE,
  )
  if (!renamed) throw new Error('test setup: registry rename failed')

  // --- per-instance button store with live project rows ---
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new ButtonStore({ db })

  // --- cookie→claim + instance-identity resolver: the REAL production
  // modules, wired exactly as gateway/index.ts composes them. The
  // gateway env carries the INTERNAL handle (NEUTRON_INSTANCE_SLUG). ---
  const resolveUserClaim = buildCookieUserClaim({
    cookie_secret: COOKIE_SECRET,
    internal_handle: INTERNAL_HANDLE,
    registry,
  })
  const resolveOwnerHandle = buildOwnerHandleResolver(registry)

  const topicsSurface = createChatTopicsSurface({
    store,
    resolveUserClaim,
    project_slug: INTERNAL_HANDLE,
    resolveOwnerHandle,
  })
  const historySurface = createChatHistorySurface({
    store,
    resolveUserClaim,
    project_slug: INTERNAL_HANDLE,
    resolveOwnerHandle,
  })
  const composed = composeHttpHandler({
    chatTopics: { handler: topicsSurface.handler },
    chatHistory: { handler: historySurface.handler },
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
    store,
    registry,
    close: async () => {
      await server.stop(true)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/** Seed one General + two project topics for the owner (rot-proof timestamps). */
async function seedTopics(store: ButtonStore): Promise<void> {
  const now = Date.now()
  const farFuture = now + 24 * 60 * 60 * 1_000
  const general = `web:${OWNER_USER_ID}`
  let cursor = 0
  for (const topic of [general, `${general}:project-a`, `${general}:project-b`]) {
    const created = now - cursor * 60_000
    cursor++
    const prompt = buildButtonPrompt({
      body: `${topic} seed`,
      options: [
        { label: 'A', body: 'yes', value: 'yes' },
        { label: 'B', body: 'no', value: 'no' },
      ],
    })
    const seedStore = new ButtonStore({
      db: (store as unknown as { db: ProjectDb }).db,
      now: () => created,
    })
    await seedStore.emit(prompt, { topic_id: topic })
    const rawDb = (store as unknown as { db: ProjectDb }).db.raw()
    rawDb
      .prepare('UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?')
      .run(farFuture, prompt.prompt_id)
  }
}

function cookieHeaderFor(slug: string): string {
  const c = signSessionCookie(slug, COOKIE_SECRET, Date.now())
  return `${c.name}=${c.value}`
}

describe('slug-rename project-identity match — cookie-authed surfaces', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await startRenamedOwnerGateway()
    await seedTopics(harness.store)
  })

  afterEach(async () => {
    await harness.close()
  })

  test('REPRO: cookie minted with the RENAMED url_slug still lists project topics (not 401 project_mismatch)', async () => {
    const res = await fetch(`${harness.base}/api/v1/chat/topics`, {
      headers: { cookie: cookieHeaderFor(RENAMED_URL_SLUG) },
    })
    const body = (await res.json()) as {
      ok?: boolean
      code?: string
      topics?: ChatTopic[]
    }
    // The live P0: this came back 401 {code:"project_mismatch"} and the
    // sidebar rendered only its client-default General row.
    expect(body.code).not.toBe('project_mismatch')
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    const projectIds = (body.topics ?? [])
      .map((t) => t.project_id)
      .filter((p): p is string => p !== null)
    expect(projectIds.sort()).toEqual(['project-a', 'project-b'])
  })

  test('cookie minted with the INTERNAL handle (pre-rename session) still authenticates', async () => {
    // A browser session from BEFORE the rename carries the old slug —
    // which for a first rename is the internal handle itself. Rename
    // must not log that session out either.
    const res = await fetch(`${harness.base}/api/v1/chat/topics`, {
      headers: { cookie: cookieHeaderFor(INTERNAL_HANDLE) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean }
    expect(body.ok).toBe(true)
  })

  test('chat-history surface honors the renamed-slug cookie too', async () => {
    const res = await fetch(
      `${harness.base}/api/v1/chat/history?topic_id=${encodeURIComponent(`web:${OWNER_USER_ID}`)}`,
      { headers: { cookie: cookieHeaderFor(RENAMED_URL_SLUG) } },
    )
    const body = (await res.json()) as { ok?: boolean; code?: string }
    expect(body.code).not.toBe('project_mismatch')
    expect(res.status).toBe(200)
  })

  test('cookie for a DIFFERENT project is still rejected (cross-project guard intact)', async () => {
    await harness.registry.insert({
      internal_handle: 't-66666666',
      url_slug: 'other-project',
      kind: 'user',
      tier: 'managed-shared',
      port: 48212,
      owner_user_id: 'user-other',
      status: 'active',
      owner_home: '/tmp/other',
      systemd_unit: 'neutron-instance@t-66666666.service',
      subdomain: 't-66666666',
    })
    const res = await fetch(`${harness.base}/api/v1/chat/topics`, {
      headers: { cookie: cookieHeaderFor('other-project') },
    })
    expect(res.status).toBe(401)
  })

  test('garbage / unknown slug cookie is rejected', async () => {
    const res = await fetch(`${harness.base}/api/v1/chat/topics`, {
      headers: { cookie: cookieHeaderFor('never-existed') },
    })
    expect(res.status).toBe(401)
  })
})
