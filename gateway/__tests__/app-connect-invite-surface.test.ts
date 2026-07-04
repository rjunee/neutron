/**
 * test #1 — the owner issues a by-link collaborator connect-invite via the route.
 *
 * `POST /api/app/projects/<id>/connect-invites { delivery:'link', scope:'write' }`
 * → a `connect_guest_invites` row (HASH ONLY — the raw token never lands in the
 * DB), the response carries a one-time accept URL containing the raw token, and
 * a non-owner caller gets 403 (the owner/admin gate). Delivery is a method, not a
 * tier — both deliveries land the same role='collaborator'.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '../../channels/index.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'
import {
  createAppProjectsSurface,
  type AppConnectSurfaceDeps,
  type ProjectSettings,
  type ProjectSettingsStore,
} from '../http/app-projects-surface.ts'
import { canInviteRole } from '../http/app-project-invite.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ConnectGuestInviteStore, hashInviteToken } from '../../connect/guest-invite-store.ts'

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

const PROJECT_SLUG = 'demo'
const PROJECT_ID = 'neutron' // seeded with sam=owner, nova=member

interface Harness {
  base: string
  db: ProjectDb
  close(): Promise<void>
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

async function start(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-ph5-issue-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const db = ProjectDb.open(dbPath)

  // Explicit membership fixture — R6 removed the KNOWN_PROJECTS demo seed that
  // used to give sam=owner / nova=member, so the connect-invite authz (which
  // resolves the caller's role from project.members) needs them seeded here.
  const seededProject: ProjectSettings = {
    id: PROJECT_ID,
    name: 'Neutron',
    description: '',
    persona: '',
    emoji: '⚛️',
    privacy_mode: 'private',
    billing_mode: 'personal',
    agent_engagement_mode: 'all_messages',
    members: [
      { user_id: 'sam', name: 'Sam', role: 'owner' },
      { user_id: 'nova', name: 'Nova', role: 'member' },
    ],
  }
  const store: ProjectSettingsStore = {
    get: async () => ({ ...seededProject, members: [...seededProject.members] }),
    update: async () => ({ ...seededProject, members: [...seededProject.members] }),
    list: async () => [
      { ...seededProject, members: [...seededProject.members], last_activity_at: '', unread_count: 0 },
    ],
    archive: async () => true,
    restore: async () => true,
    listArchived: async () => [],
  }
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })

  // Connect deps over a REAL guest-invite store; authz via the settings store.
  const connect: AppConnectSurfaceDeps = {
    invite: {
      buildGuestAcceptUrl: (raw) => `https://connect.test/connect/accept#${raw}`,
      buildTrustedAcceptUrl: (t) => `https://connect.test/invite?invite=${t}`,
      resolveContext: async ({ caller_user_id, caller_instance_slug, project_id }) => {
        const project = await store.get(caller_instance_slug, project_id)
        if (project === null) return { ok: false, code: 'project_not_found', message: 'no project' }
        const me = project.members.find((m) => m.user_id === caller_user_id)
        if (me === undefined || !canInviteRole(me.role)) {
          return { ok: false, code: 'forbidden', message: 'owner/admin only' }
        }
        return { ok: true, inviter_role: 'owner', owner_db: db, project_id }
      },
    },
    listMembers: async () => ({ ok: true, members: [] }),
    revokeMember: async () => ({ ok: true, revoked: true }),
  }

  const surface = createAppProjectsSurface({ store, auth, connect })
  const composed = composeHttpHandler({
    appProjects: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  cleanups.push(() => {
    __composedHandlers.delete(host)
    db.close()
  })
  return { base: `http://${host}`, db, close: async () => { __composedHandlers.delete(host) } }
}

function post(base: string, path: string, user: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer dev:${user}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Ph5 owner connect-invite issuance (test #1)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await start()
  })

  it('owner issues a by-link invite → hash-only DB row + one-time accept URL with raw token', async () => {
    const res = await post(h.base, `/api/app/projects/${PROJECT_ID}/connect-invites`, 'sam', {
      delivery: 'link',
      scope: 'write',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; delivery: string; accept_url: string; scope: string }
    expect(body.ok).toBe(true)
    expect(body.delivery).toBe('link')
    expect(body.scope).toBe('write')

    // The accept URL carries the raw token in the fragment.
    const rawToken = body.accept_url.split('#')[1] ?? ''
    expect(rawToken.length).toBeGreaterThan(20)

    // The DB row stores ONLY the hash — the raw token is never persisted.
    const rowByHash = new ConnectGuestInviteStore(h.db).getByHash(hashInviteToken(rawToken))
    expect(rowByHash).not.toBeNull()
    expect(rowByHash!.project_id).toBe(PROJECT_ID)
    expect(rowByHash!.access).toBe('write')
    // No column anywhere holds the raw token.
    const leak = h.db
      .raw()
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM connect_guest_invites WHERE token_hash = ?`,
      )
      .get(rawToken)
    expect(leak!.n).toBe(0)
  })

  it('a non-owner (plain member) caller gets 403', async () => {
    const res = await post(h.base, `/api/app/projects/${PROJECT_ID}/connect-invites`, 'nova', {
      delivery: 'link',
      scope: 'read',
    })
    expect(res.status).toBe(403)
  })

  it('by-email delivery with no signing key configured → 409 workspace_unavailable (honest, not a silent fail)', async () => {
    const res = await post(h.base, `/api/app/projects/${PROJECT_ID}/connect-invites`, 'sam', {
      delivery: 'email',
      scope: 'write',
      invitee_email: 'bob@other.org',
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('workspace_unavailable')
  })
})
