/**
 * Open sidebar topic-rail surface — `GET /api/v1/chat/topics`.
 *
 * THE BUG (Ryan, dogfooding the self-host install): onboarding created N
 * projects in the canonical `projects` table, but the chat sidebar showed
 * nothing. Root cause — the Open composer never mounted a topics surface, so
 * `GET /api/v1/chat/topics` 404'd; and the Managed surface only lists topics
 * with `button_prompts` rows, which brand-new project topics don't have yet.
 *
 * These tests drive the Open-native surface against a REAL `ProjectDb` with
 * applied migrations + real `projects` rows and assert:
 *   1. the owner's projects surface as per-project topic rows in the wire
 *      shape `landing/chat.ts:TopicRail` renders (the headline fix);
 *   2. General is always present and first;
 *   3. per-project topic_id is `web:<user_id>:<project_id>` (the shape the
 *      WS switch + history fetch expect);
 *   4. soft-deleted projects are excluded;
 *   5. auth: a missing/cross-instance claim 401s; non-GET 405s.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import {
  createOpenChatTopicsSurface,
  type OpenUserClaim,
} from '../chat-topics-surface.ts'

const SLUG = 'owner-instance'
const USER = 'owner'

let tmp: string
let db: ProjectDb

async function insertProject(
  id: string,
  name: string,
  opts: { description?: string; updated_at?: string; deleted_at?: string } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO projects (id, name, description, privacy_mode, billing_mode, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'private', 'personal', ?, ?, ?)`,
    [
      id,
      name,
      opts.description ?? null,
      opts.updated_at ?? '2026-01-01T00:00:00Z',
      opts.updated_at ?? '2026-01-01T00:00:00Z',
      opts.deleted_at ?? null,
    ],
  )
}

function req(method = 'GET'): Request {
  return new Request('http://127.0.0.1/api/v1/chat/topics', { method })
}

const okClaim = async (): Promise<OpenUserClaim> => ({ project_slug: SLUG, user_id: USER })

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'open-chat-topics-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('Open chat-topics surface', () => {
  test('lists the owner projects as per-project topic rows + General first', async () => {
    await insertProject('acme', 'Acme', {
      description: 'Gravity-defying fragrance brand',
      updated_at: '2026-02-01T00:00:00Z',
    })
    await insertProject('globex', 'Globex', { updated_at: '2026-03-01T00:00:00Z' })
    await insertProject('initech', 'Initech', { updated_at: '2026-01-15T00:00:00Z' })

    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: okClaim,
      project_slug: SLUG,
    })
    const res = await surface.handler(req())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const body = (await res!.json()) as {
      ok: boolean
      topics: Array<{ topic_id: string; project_id: string | null; name: string }>
    }
    expect(body.ok).toBe(true)

    // General first.
    expect(body.topics[0]!.project_id).toBeNull()
    expect(body.topics[0]!.name).toBe('General')
    expect(body.topics[0]!.topic_id).toBe(`web:${USER}`)

    // Every project surfaces.
    const projectIds = body.topics
      .filter((t) => t.project_id !== null)
      .map((t) => t.project_id)
    expect(projectIds.sort()).toEqual(['acme', 'globex', 'initech'])

    // Per-project topic_id shape the WS switch path expects.
    const acme = body.topics.find((t) => t.project_id === 'acme')!
    expect(acme.topic_id).toBe(`web:${USER}:acme`)
    expect(acme.name).toBe('Acme')

    // Ordered by updated_at DESC after General: globex, acme, initech.
    expect(body.topics.map((t) => t.project_id)).toEqual([
      null,
      'globex',
      'acme',
      'initech',
    ])
  })

  test('description backfills the sidebar preview when there is no chat yet', async () => {
    await insertProject('umbrella', 'Umbrella', { description: 'Boutique scent studio' })
    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: okClaim,
      project_slug: SLUG,
    })
    const res = await surface.handler(req())
    const body = (await res!.json()) as {
      topics: Array<{ project_id: string | null; last_body: string | null }>
    }
    const umbrella = body.topics.find((t) => t.project_id === 'umbrella')!
    expect(umbrella.last_body).toBe('Boutique scent studio')
  })

  test('excludes soft-deleted projects', async () => {
    await insertProject('live', 'Live One')
    await insertProject('gone', 'Deleted One', { deleted_at: '2026-04-01T00:00:00Z' })
    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: okClaim,
      project_slug: SLUG,
    })
    const res = await surface.handler(req())
    const body = (await res!.json()) as {
      topics: Array<{ project_id: string | null }>
    }
    const ids = body.topics.map((t) => t.project_id)
    expect(ids).toContain('live')
    expect(ids).not.toContain('gone')
  })

  test('an owner with zero projects still gets a General row', async () => {
    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: okClaim,
      project_slug: SLUG,
    })
    const res = await surface.handler(req())
    const body = (await res!.json()) as {
      topics: Array<{ project_id: string | null; name: string }>
    }
    expect(body.topics.length).toBe(1)
    expect(body.topics[0]!.project_id).toBeNull()
    expect(body.topics[0]!.name).toBe('General')
  })

  test('401s when the claim is missing', async () => {
    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: async () => null,
      project_slug: SLUG,
    })
    const res = await surface.handler(req())
    expect(res!.status).toBe(401)
  })

  test('401s when the cookie is for a different instance', async () => {
    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: async () => ({ project_slug: 'someone-else', user_id: USER }),
      project_slug: SLUG,
    })
    const res = await surface.handler(req())
    expect(res!.status).toBe(401)
  })

  test('405s on a non-GET method', async () => {
    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: okClaim,
      project_slug: SLUG,
    })
    const res = await surface.handler(req('POST'))
    expect(res!.status).toBe(405)
  })

  test('returns null for a non-topics path so the chain falls through', async () => {
    const surface = createOpenChatTopicsSurface({
      db,
      resolveUserClaim: okClaim,
      project_slug: SLUG,
    })
    const res = await surface.handler(
      new Request('http://127.0.0.1/api/v1/chat/history', { method: 'GET' }),
    )
    expect(res).toBeNull()
  })
})
