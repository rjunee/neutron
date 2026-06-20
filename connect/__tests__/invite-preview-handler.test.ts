/**
 * M2.6 Ph5 test #2 — the invite-preview read is non-consuming + leak-free.
 *
 * `GET /connect/invite-preview` must return the display fields for a valid
 * invite AND leave it claimable (redeemed_at_ms IS NULL) — preview NEVER
 * consumes the single-use invite (brief § 5 #1). An expired / already-redeemed /
 * unknown token returns a benign 410/404 with no field leak.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ConnectGuestInviteStore } from '../guest-invite-store.ts'
import { buildInvitePreviewHandler } from '../invite-preview-handler.ts'

const PROJECT_ID = 'p-owner-1'
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function makeDb(): ProjectDb {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-ph5-preview-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)
  cleanups.push(() => db.close())
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, 'Owner Project', 'private', 'personal', ?, ?)`,
    [PROJECT_ID, new Date(0).toISOString(), new Date(0).toISOString()],
  )
  return db
}

function preview(handler: (req: Request) => Promise<Response>, tokenHash: string): Promise<Response> {
  return handler(
    new Request(`http://connect.example/connect/v1/connect/invite-preview?token_hash=${tokenHash}`),
  )
}

describe('Ph5 invite-preview — read-only + non-consuming (test #2)', () => {
  test('returns resolved display fields AND leaves the invite claimable', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: PROJECT_ID, access: 'write', ttl_ms: 60_000, now: 1_000 })
    const handler = buildInvitePreviewHandler({
      inviteStore: store,
      db,
      owner_display: 'mona',
      connect_host: 'connect.example.com',
      now: () => 2_000,
    })

    const res = await preview(handler, issued.token_hash)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, string>
    // Real resolved values — never a placeholder (brief § 3.1).
    expect(body['project_name']).toBe('Owner Project')
    expect(body['owner_display']).toBe('mona')
    expect(body['connect_host']).toBe('connect.example.com')
    expect(body['privacy_tier']).toBe('private')
    expect(body['scope']).toBe('write')

    // NON-CONSUMING: the invite is still unredeemed + claimable afterwards.
    const row = store.getByHash(issued.token_hash)
    expect(row).not.toBeNull()
    expect(row!.redeemed_at_ms).toBeNull()
  })

  test('expired invite → 410, no field leak', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: PROJECT_ID, access: 'read', ttl_ms: 1_000, now: 1_000 })
    const handler = buildInvitePreviewHandler({
      inviteStore: store,
      db,
      owner_display: 'mona',
      connect_host: 'connect.example.com',
      now: () => 10_000, // past expiry
    })
    const res = await preview(handler, issued.token_hash)
    expect(res.status).toBe(410)
    const body = (await res.json()) as Record<string, string>
    expect(body['project_name']).toBeUndefined()
    expect(body['owner_display']).toBeUndefined()
  })

  test('unknown token → 404, malformed token_hash → 404 (no detail)', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const handler = buildInvitePreviewHandler({
      inviteStore: store,
      db,
      owner_display: 'mona',
      connect_host: 'connect.example.com',
      now: () => 2_000,
    })
    const unknown = 'a'.repeat(64)
    expect((await preview(handler, unknown)).status).toBe(404)
    expect((await preview(handler, 'not-a-hash')).status).toBe(404)
  })

  test('already-redeemed invite → 410 (gone)', async () => {
    const db = makeDb()
    const store = new ConnectGuestInviteStore(db)
    const issued = await store.issue({ project_id: PROJECT_ID, access: 'write', ttl_ms: 60_000, now: 1_000 })
    // Consume it via the atomic claim.
    await db.transaction((tx) => store.claimInTx(tx, issued.token, 2_000))
    const handler = buildInvitePreviewHandler({
      inviteStore: store,
      db,
      owner_display: 'mona',
      connect_host: 'connect.example.com',
      now: () => 3_000,
    })
    const res = await preview(handler, issued.token_hash)
    expect(res.status).toBe(410)
  })
})
