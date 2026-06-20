/**
 * @neutronai/gateway/http — in-app invite generation tests (M2.4).
 *
 * Covers the pure handler (`handleAppProjectInvite`) against injected
 * contexts AND the HTTP route wired into `createAppProjectsSurface`:
 *   - success returns a valid URL + future expiry + persisted invites row
 *   - only owner/admin can generate (non-owner → 403)
 *   - solo project → 409 not_group; group-without-workspace → 409
 *   - invalid email → 400; missing project → 404
 *   - route returns 501 when invite deps are not configured
 *   - route 401s without a bearer
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, type KeyLike } from 'jose'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  canInviteRole,
  handleAppProjectInvite,
  httpStatusForInvite,
  isPlausibleEmail,
  type AppProjectInviteDeps,
  type InviteContext,
} from '../app-project-invite.ts'
import { createAppProjectsSurface } from '../app-projects-surface.ts'
import { InMemoryProjectSettingsStore } from '../app-projects-surface.ts'
import type { AppWsAuthResolver } from '../../../channels/adapters/app-ws/auth.ts'

let tmp: string
let inviterDb: ProjectDb
let signing_key: { kid: string; privateKey: KeyLike; publicKey: KeyLike }

const FIXED_NOW = 1_900_000_000_000

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-app-invite-'))
  inviterDb = ProjectDb.open(join(tmp, 'inviter.db'))
  applyMigrations(inviterDb.raw())
  const { privateKey, publicKey } = await generateKeyPair('EdDSA')
  signing_key = { kid: 'invite-key-1', privateKey, publicKey }
})

afterEach(() => {
  inviterDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function okContext(): InviteContext {
  return {
    ok: true,
    workspace_instance_slug: 'ws-1',
    workspace_project_id: 'wp-1',
    inviter_role: 'owner',
    inviter_db: inviterDb,
    signing_key,
  }
}

function depsWith(ctx: InviteContext): AppProjectInviteDeps {
  return {
    resolveInviteContext: async () => ctx,
    buildInviteUrl: (token) => `https://sam.neutron.test/invite?invite=${token}`,
    now: () => FIXED_NOW,
  }
}

const baseReq = {
  caller_user_id: 'u-1',
  caller_instance_slug: 'sam',
  project_id: 'neutron',
  invitee_email: 'invited@test.invalid',
}

describe('handleAppProjectInvite', () => {
  test('mints a token: valid URL, future expiry, persisted invites row', async () => {
    const res = await handleAppProjectInvite(baseReq, depsWith(okContext()))
    expect(res.status).toBe('created')
    if (res.status !== 'created') return
    expect(res.invite_url).toContain('/invite?invite=')
    // The minted JWT is appended verbatim by our buildInviteUrl stub.
    expect(res.invite_url.endsWith(res.jti)).toBe(false) // url carries the JWT, not the jti
    expect(res.invite_url.split('invite=')[1]?.split('.').length).toBe(3) // 3-part JWT
    expect(res.expires_at_ms).toBeGreaterThan(FIXED_NOW)
    expect(typeof res.jti).toBe('string')
    // The single-use audit row landed on the inviter DB.
    const row = inviterDb
      .raw()
      .query<{ token_id: string; project_id: string; consumed_at_ms: number | null }, [string]>(
        `SELECT token_id, project_id, consumed_at_ms FROM invites WHERE token_id = ?`,
      )
      .get(res.jti)
    expect(row?.token_id).toBe(res.jti)
    expect(row?.project_id).toBe('wp-1')
    expect(row?.consumed_at_ms).toBeNull()
  })

  test('rejects an invalid email with invalid_email (400) before resolving context', async () => {
    let resolved = false
    const res = await handleAppProjectInvite(
      { ...baseReq, invitee_email: 'not-an-email' },
      {
        resolveInviteContext: async () => {
          resolved = true
          return okContext()
        },
        buildInviteUrl: (t) => t,
      },
    )
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('invalid_email')
    expect(httpStatusForInvite(res)).toBe(400)
    expect(resolved).toBe(false)
  })

  test('non-owner context → forbidden (403)', async () => {
    const res = await handleAppProjectInvite(
      baseReq,
      depsWith({ ok: false, code: 'forbidden', message: 'nope' }),
    )
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('forbidden')
    expect(httpStatusForInvite(res)).toBe(403)
  })

  test('solo project context → not_group (409)', async () => {
    const res = await handleAppProjectInvite(
      baseReq,
      depsWith({ ok: false, code: 'not_group', message: 'solo' }),
    )
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(httpStatusForInvite(res)).toBe(409)
  })

  test('group-without-workspace context → workspace_unavailable (409)', async () => {
    const res = await handleAppProjectInvite(
      baseReq,
      depsWith({ ok: false, code: 'workspace_unavailable', message: 'pending m2.1' }),
    )
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(httpStatusForInvite(res)).toBe(409)
  })

  test('missing project context → project_not_found (404)', async () => {
    const res = await handleAppProjectInvite(
      baseReq,
      depsWith({ ok: false, code: 'project_not_found', message: 'gone' }),
    )
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(httpStatusForInvite(res)).toBe(404)
  })

  test('resolver throwing → mint_failed (500), never throws out', async () => {
    const res = await handleAppProjectInvite(baseReq, {
      resolveInviteContext: async () => {
        throw new Error('db down')
      },
      buildInviteUrl: (t) => t,
    })
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('mint_failed')
    expect(httpStatusForInvite(res)).toBe(500)
  })

  test('defense-in-depth: ok context with a non-owner role still cannot mint', async () => {
    // A miswired resolver returns ok:true but role 'member' — the
    // handler must refuse rather than mint.
    const miswired: InviteContext = {
      ok: true,
      workspace_instance_slug: 'ws-1',
      workspace_project_id: 'wp-1',
      inviter_role: 'member' as unknown as 'owner',
      inviter_db: inviterDb,
      signing_key,
    }
    const res = await handleAppProjectInvite(baseReq, depsWith(miswired))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('forbidden')
  })

  test('owner|admin parity: an admin context mints successfully', async () => {
    // The resolver + handler accept owner OR admin (Argus r1 MINOR —
    // harmonized with the client gate via `canInviteRole`).
    const adminCtx: InviteContext = {
      ok: true,
      workspace_instance_slug: 'ws-1',
      workspace_project_id: 'wp-1',
      inviter_role: 'admin',
      inviter_db: inviterDb,
      signing_key,
    }
    const res = await handleAppProjectInvite(baseReq, depsWith(adminCtx))
    expect(res.status).toBe('created')
  })
})

describe('canInviteRole', () => {
  test('accepts owner and admin, rejects member + anything else', () => {
    expect(canInviteRole('owner')).toBe(true)
    expect(canInviteRole('admin')).toBe(true)
    expect(canInviteRole('member')).toBe(false)
    expect(canInviteRole('')).toBe(false)
    expect(canInviteRole('OWNER')).toBe(false)
  })
})

describe('isPlausibleEmail', () => {
  test('accepts plausible addresses, rejects junk', () => {
    expect(isPlausibleEmail('a@b.co')).toBe(true)
    expect(isPlausibleEmail('  casey@example.com ')).toBe(true)
    expect(isPlausibleEmail('no-at-sign')).toBe(false)
    expect(isPlausibleEmail('a@b')).toBe(false)
    expect(isPlausibleEmail('')).toBe(false)
  })
})

// ─── HTTP route through createAppProjectsSurface ──────────────────────

function fakeAuth(): AppWsAuthResolver {
  return {
    resolve: async (token: string) => {
      if (token === 'good') return { user_id: 'u-1', project_slug: 'sam' }
      return { code: 'bad_token', message: 'nope' }
    },
  } as unknown as AppWsAuthResolver
}

function post(token: string | null, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers['authorization'] = `Bearer ${token}`
  return new Request('http://x/api/app/projects/neutron/invite', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/app/projects/<id>/invite route', () => {
  test('returns 501 invite_not_configured when invite deps absent', async () => {
    const surface = createAppProjectsSurface({
      store: new InMemoryProjectSettingsStore(),
      auth: fakeAuth(),
    })
    const res = await surface.handler(post('good', { invitee_email: 'a@b.co' }))
    expect(res?.status).toBe(501)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('invite_not_configured')
  })

  test('401 without a bearer token', async () => {
    const surface = createAppProjectsSurface({
      store: new InMemoryProjectSettingsStore(),
      auth: fakeAuth(),
      invite: depsWith(okContext()),
    })
    const res = await surface.handler(post(null, { invitee_email: 'a@b.co' }))
    expect(res?.status).toBe(401)
  })

  test('405 on non-POST', async () => {
    const surface = createAppProjectsSurface({
      store: new InMemoryProjectSettingsStore(),
      auth: fakeAuth(),
      invite: depsWith(okContext()),
    })
    const res = await surface.handler(
      new Request('http://x/api/app/projects/neutron/invite', {
        method: 'GET',
        headers: { authorization: 'Bearer good' },
      }),
    )
    expect(res?.status).toBe(405)
  })

  test('200 + invite_url on a successful generate', async () => {
    const surface = createAppProjectsSurface({
      store: new InMemoryProjectSettingsStore(),
      auth: fakeAuth(),
      invite: depsWith(okContext()),
    })
    const res = await surface.handler(post('good', { invitee_email: 'invited@test.invalid' }))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; invite_url: string; jti: string }
    expect(body.ok).toBe(true)
    expect(body.invite_url).toContain('/invite?invite=')
    expect(typeof body.jti).toBe('string')
  })

  test('403 maps from a forbidden context', async () => {
    const surface = createAppProjectsSurface({
      store: new InMemoryProjectSettingsStore(),
      auth: fakeAuth(),
      invite: depsWith({ ok: false, code: 'forbidden', message: 'nope' }),
    })
    const res = await surface.handler(post('good', { invitee_email: 'a@b.co' }))
    expect(res?.status).toBe(403)
  })

  test('400 when invitee_email missing from body', async () => {
    const surface = createAppProjectsSurface({
      store: new InMemoryProjectSettingsStore(),
      auth: fakeAuth(),
      invite: depsWith(okContext()),
    })
    const res = await surface.handler(post('good', { wrong: 'field' }))
    expect(res?.status).toBe(400)
  })
})
