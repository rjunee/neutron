/**
 * Sidebar topic-rail (2026-05-28 sprint) — `GET /api/v1/chat/topics`
 * surface tests.
 *
 * Round-trips the endpoint through `composeHttpHandler` with a stub
 * `resolveUserClaim` and a real `ButtonStore` over a fresh per-test
 * SQLite file. Mirrors the structure of `chat-history-surface.test.ts`.
 *
 * Per the 2026-05-28 sidebar sprint brief.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ButtonStore } from '../../channels/button-store.ts'
import { buildButtonPrompt } from '../../channels/button-primitive.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeHttpHandler } from '../http/compose.ts'
import {
  createChatTopicsSurface,
  type ChatTopic,
  type UserClaim,
} from '../http/chat-topics-surface.ts'

interface Harness {
  server: import('bun').Server<unknown>
  base: string
  store: ButtonStore
  db: ProjectDb
  tmp: string
  setClaim: (claim: UserClaim | null) => void
  setNames: (names: Map<string, string>) => void
  close(): Promise<void>
}

const PROJECT_SLUG = 'demo'
const USER_ID = 'user-test'

async function startGateway(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-chat-topics-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const store = new ButtonStore({ db })
  let currentClaim: UserClaim | null = { project_slug: PROJECT_SLUG, user_id: USER_ID }
  let currentNames: Map<string, string> = new Map()
  const surface = createChatTopicsSurface({
    store,
    resolveUserClaim: async () => currentClaim,
    project_slug: PROJECT_SLUG,
    resolveProjectNames: async () => currentNames,
  })
  const composed = composeHttpHandler({
    chatTopics: { handler: surface.handler },
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
    db,
    tmp,
    setClaim: (claim) => { currentClaim = claim },
    setNames: (names) => { currentNames = names },
    close: async () => {
      await server.stop(true)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

/**
 * Seed two rows into General + two project topics so the surface has
 * something to enumerate. Timestamps relative to `Date.now()` so the
 * test data never rots per
 * internal design notes.
 */
async function seedTopics(
  store: ButtonStore,
  count_per_topic: number,
): Promise<void> {
  const now = Date.now()
  const farFuture = now + 24 * 60 * 60 * 1_000
  const general = `web:${USER_ID}`
  const projectA = `${general}:project-a`
  const projectB = `${general}:project-b`
  let cursor = 0
  for (const topic of [general, projectA, projectB]) {
    for (let i = 0; i < count_per_topic; i++) {
      const created = now - cursor * 60_000
      cursor++
      const prompt = buildButtonPrompt({
        body: `${topic} turn ${i}`,
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
      // Push expires_at into the far future so unresolved rows survive
      // the ghost-row filter when the surface gates by `expires_at > now`.
      const rawDb = (store as unknown as { db: ProjectDb }).db.raw()
      rawDb.prepare('UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?').run(
        farFuture,
        prompt.prompt_id,
      )
    }
  }
}

interface TopicsResponse {
  ok?: boolean
  code?: string
  topics?: ChatTopic[]
}

describe('chat-topics surface — GET /api/v1/chat/topics', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await startGateway()
  })
  afterEach(async () => {
    await harness.close()
  })

  test('valid claim → 200 with General + per-project rows', async () => {
    await seedTopics(harness.store, 2)
    harness.setNames(new Map([
      ['project-a', 'Project Alpha'],
      ['project-b', 'Project Beta'],
    ]))
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TopicsResponse
    expect(body.ok).toBe(true)
    expect(body.topics).toBeDefined()
    expect(body.topics!.length).toBe(3)
    // General must be first regardless of recency.
    expect(body.topics![0]!.project_id).toBeNull()
    expect(body.topics![0]!.name).toBe('General')
    expect(body.topics![0]!.topic_id).toBe(`web:${USER_ID}`)
    // Per-project rows surface their resolved names from the resolver.
    const names = body.topics!.slice(1).map((t) => t.name).sort()
    expect(names).toEqual(['Project Alpha', 'Project Beta'])
  })

  test('unread_count tracks unresolved + unexpired rows only', async () => {
    await seedTopics(harness.store, 3)
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    const body = (await res.json()) as TopicsResponse
    // Every seeded row is unresolved + far-future expiry → unread_count
    // matches the seed count for each topic.
    const general = body.topics!.find((t) => t.project_id === null)!
    expect(general.unread_count).toBe(3)
    const projectRows = body.topics!.filter((t) => t.project_id !== null)
    for (const row of projectRows) {
      expect(row.unread_count).toBe(3)
    }
  })

  test('per-project name falls back to humanised slug when resolver returns empty map', async () => {
    await seedTopics(harness.store, 1)
    // resolveProjectNames is left as the default empty Map — the surface
    // should humanise the slug as a fallback.
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    const body = (await res.json()) as TopicsResponse
    const project = body.topics!.find((t) => t.project_id === 'project-a')
    expect(project).toBeDefined()
    expect(project!.name).toBe('Project A')
  })

  test('no rows → still returns a synthesised General row', async () => {
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TopicsResponse
    expect(body.topics!.length).toBe(1)
    expect(body.topics![0]!.project_id).toBeNull()
    expect(body.topics![0]!.name).toBe('General')
    expect(body.topics![0]!.unread_count).toBe(0)
    expect(body.topics![0]!.last_body).toBeNull()
    expect(body.topics![0]!.last_created_at).toBeNull()
  })

  test('null claim → 401 unauthorized', async () => {
    harness.setClaim(null)
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as TopicsResponse
    expect(body.ok).toBe(false)
    expect(body.code).toBe('unauthorized')
  })

  test('mismatched project_slug → 401 project_mismatch', async () => {
    harness.setClaim({ project_slug: 'someone-else', user_id: USER_ID })
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    expect(res.status).toBe(401)
    const body = (await res.json()) as TopicsResponse
    expect(body.ok).toBe(false)
    expect(body.code).toBe('project_mismatch')
  })

  test('cross-user topic isolation — u-1 and u-10 do NOT see each other', async () => {
    // Seed prompts for THIS test user `user-test` then write a row
    // for a different user whose id is a STRICT prefix-collision risk.
    await seedTopics(harness.store, 1)
    // Build a separate prompt for a user whose id starts with the
    // same first few chars as USER_ID to verify the strict
    // `topic_id = ? OR LIKE ? || ':%'` filter excludes it.
    const collider = `web:${USER_ID}-extra:project-a`
    const otherPrompt = buildButtonPrompt({
      body: 'collider body',
      options: [{ label: 'A', body: 'yes', value: 'yes' }],
    })
    await harness.store.emit(otherPrompt, { topic_id: collider })
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    const body = (await res.json()) as TopicsResponse
    // The collider topic_id must NOT appear in this user's topic list.
    const colliderRow = body.topics!.find((t) => t.topic_id === collider)
    expect(colliderRow).toBeUndefined()
  })

  test('Argus r1 BLOCKER 2 — SQL LIKE wildcard in user_id does not leak another user’s topics', async () => {
    // Argus r1 BLOCKER 2 regression: prior code used
    // `topic_id LIKE 'web:<user_id>:%'` without escaping. SQLite
    // treats `_` as a single-char wildcard, so a synthetic-e2e or
    // dev `sub` claim of `u_1` would LIKE-match `uA1`. The fix
    // moved to a range-bound comparison; this test pins that
    // behaviour.
    const wildcardUser = 'u_1'
    const colliderUser = 'uA1'
    const wildcardClaim: UserClaim = { project_slug: PROJECT_SLUG, user_id: wildcardUser }
    harness.setClaim(wildcardClaim)

    // Seed a prompt on the wildcard user's project topic so they have
    // something legitimate to enumerate.
    const wildcardProject = `web:${wildcardUser}:project-a`
    const ownPrompt = buildButtonPrompt({
      body: 'own body',
      options: [{ label: 'A', body: 'yes', value: 'yes' }],
    })
    await harness.store.emit(ownPrompt, { topic_id: wildcardProject })

    // Seed a prompt for the LIKE-wildcard collider — `u_1`'s SQL
    // LIKE pattern would have matched `uA1` historically.
    const colliderTopic = `web:${colliderUser}:project-a`
    const colliderPrompt = buildButtonPrompt({
      body: 'collider body',
      options: [{ label: 'A', body: 'yes', value: 'yes' }],
    })
    await harness.store.emit(colliderPrompt, { topic_id: colliderTopic })

    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    const body = (await res.json()) as TopicsResponse

    // `u_1`'s own General + project-a rows surface; `uA1`'s topic
    // must NOT appear.
    expect(body.topics!.find((t) => t.topic_id === wildcardProject)).toBeDefined()
    expect(body.topics!.find((t) => t.topic_id === colliderTopic)).toBeUndefined()
    // Defence-in-depth: ensure no row carries the other user's prefix.
    const leaked = body.topics!.find((t) => t.topic_id.startsWith(`web:${colliderUser}`))
    expect(leaked).toBeUndefined()
  })

  test('Argus r1 minor — unread badge increments on switch-back when prompts land while user is on a different topic', async () => {
    // Argus r1 minor regression: while a user is bound to project A
    // (active_topic_id=web:<u>:project-a), new prompts can still
    // accrue on the General topic (e.g. background engine emit,
    // import-progress emit, cross-topic notification). The sidebar's
    // per-topic `unread_count` is the user's only signal that
    // anything happened. This test pins the increment behaviour:
    // emit a prompt on General → sidebar reports `unread_count=1`
    // for General even though the active socket sits on project A.
    const general = `web:${USER_ID}`
    const projectA = `${general}:project-a`

    // Bootstrap project-A so it appears in the rail.
    const projectPrompt = buildButtonPrompt({
      body: 'project-a seed',
      options: [{ label: 'A', body: 'continue', value: 'continue' }],
    })
    await harness.store.emit(projectPrompt, { topic_id: projectA })
    // Resolve the project-A prompt so the test's General-unread
    // signal isn't drowned out — the user is "caught up" on
    // project A and only General is unread.
    const now = Date.now()
    const farFuture = now + 24 * 60 * 60 * 1_000
    harness.db.raw().prepare('UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?').run(
      farFuture,
      projectPrompt.prompt_id,
    )
    await harness.store.resolve({
      choice: {
        prompt_id: projectPrompt.prompt_id,
        choice_value: 'continue',
        chosen_at: now,
        speaker_user_id: USER_ID,
        channel_kind: 'app-socket',
      },
    })

    // Take a baseline read — General has zero unread.
    const baseline = await fetch(`${harness.base}/api/v1/chat/topics`)
    const baselineBody = (await baseline.json()) as TopicsResponse
    const generalBefore = baselineBody.topics!.find((t) => t.topic_id === general)
    expect(generalBefore).toBeDefined()
    expect(generalBefore!.unread_count).toBe(0)

    // While the user is "on project A", an engine emit lands on
    // General. (We simulate the emit directly — the production path
    // is identical: ButtonStore.emit writes the row regardless of
    // which socket is bound.)
    const generalPrompt = buildButtonPrompt({
      body: 'new General prompt',
      options: [{ label: 'A', body: 'yes', value: 'yes' }],
    })
    await harness.store.emit(generalPrompt, { topic_id: general })
    harness.db.raw().prepare('UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?').run(
      farFuture,
      generalPrompt.prompt_id,
    )

    // The user switches back to General → fetch the sidebar again →
    // General now reports unread_count=1.
    const after = await fetch(`${harness.base}/api/v1/chat/topics`)
    const afterBody = (await after.json()) as TopicsResponse
    const generalAfter = afterBody.topics!.find((t) => t.topic_id === general)
    expect(generalAfter).toBeDefined()
    expect(generalAfter!.unread_count).toBe(1)
    expect(generalAfter!.last_body).toBeDefined()
    expect(generalAfter!.last_body!).toContain('new General prompt')
    // Project A's unread stays at zero — we resolved its only row.
    const projectAfter = afterBody.topics!.find((t) => t.topic_id === projectA)
    expect(projectAfter!.unread_count).toBe(0)
  })

  test('non-GET method → 405', async () => {
    const res = await fetch(`${harness.base}/api/v1/chat/topics`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
