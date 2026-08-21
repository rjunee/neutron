/**
 * `gateway/http/codex-credential-surface.ts` — the Connect Codex HTTP surface.
 * Same bearer auth + owner-boundary as the credentials surface.
 *
 * Codex is a GLOBAL, trident-wide credential: the PRIMARY route is the
 * account-wide `/api/app/codex-auth` (General admin UI). A per-project OVERRIDE
 * route `/api/app/projects/<id>/codex-auth` wins over the global default for
 * that project (store resolver: project → global → unset).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { createAppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { codexAuthPath, codexProjectHome } from '@neutronai/trident/codex-auth.ts'
import { CodexCredentialService } from '@neutronai/trident/codex-credential.ts'
import { SqliteCodexRotationStore } from '@neutronai/trident/codex-rotation-store.ts'
import { createCodexCredentialSurface, type CodexCredentialSurface } from './codex-credential-surface.ts'

const SLUG = 'owner'
const GLOBAL = '/api/app/codex-auth'
const PROJECT = '/api/app/projects/p1/codex-auth'
let tmp: string
let db: ProjectDb
let codexHome: string
let surface: CodexCredentialSurface

function subscriptionAuth(): string {
  return JSON.stringify({
    tokens: { access_token: 'acc', refresh_token: 'ref' },
    last_refresh: '2026-06-30T00:00:00.000Z',
  })
}

function req(method: string, path: string, body?: unknown, withAuth = true): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (withAuth) headers['authorization'] = 'Bearer dev-token'
  return new Request(`http://x${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-surface-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  const crypto = new SecretsStore({ data_dir: tmp, db })
  const store = new ProjectCredentialStore(db, { crypto })
  codexHome = join(tmp, '.codex')
  // THE LIVE SEAT PROBE IS INJECTED, NOT LEFT ON ITS PRODUCTION DEFAULT. This
  // route now asks the ChatGPT backend whether the stored token still works
  // (stored bytes cannot show a server-side revocation), so the default would put
  // a real request on the public internet from a unit test — with the placeholder
  // bundle below, which a real endpoint correctly refuses. These tests are about
  // the HTTP shape; the probe's own behaviour and the fact that this route
  // consults it are asserted in `trident/__tests__/codex-seat-probe.test.ts`.
  const service = new CodexCredentialService({
    store,
    codexHome,
    rotation: new SqliteCodexRotationStore(db),
    probe: async () => ({ kind: 'ok', httpStatus: 200 }),
  })
  const auth = createAppWsAuthResolver({ project_slug: SLUG, bypass: true })
  surface = createCodexCredentialSurface({ service, auth })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('codex-auth HTTP surface — GLOBAL (primary)', () => {
  test('disclaims non-owned paths with null', async () => {
    expect(await surface.handler(req('GET', '/api/app/projects/p1/credentials'))).toBeNull()
    expect(await surface.handler(req('GET', '/api/other'))).toBeNull()
  })

  test('requires a bearer (401 without)', async () => {
    const res = await surface.handler(req('GET', GLOBAL, undefined, false))
    expect(res?.status).toBe(401)
  })

  test('GET → not_connected initially, scope null', async () => {
    const res = await surface.handler(req('GET', GLOBAL))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; status: string; scope: string | null }
    expect(body.ok).toBe(true)
    expect(body.status).toBe('not_connected')
    expect(body.scope).toBeNull()
  })

  test('POST subscription auth → 201 connected + materialized to GLOBAL home; GET reflects it', async () => {
    const res = await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as { status: string; scope: string }
    expect(body.status).toBe('connected')
    expect(body.scope).toBe('global')
    // Materializes to the GLOBAL codex home (not a project subdir).
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)

    const get = await surface.handler(req('GET', GLOBAL))
    const gbody = (await get!.json()) as { status: string; materialized: boolean; scope: string }
    expect(gbody.status).toBe('connected')
    expect(gbody.materialized).toBe(true)
    expect(gbody.scope).toBe('global')
  })

  test('POST metered OPENAI_API_KEY → 400 metered_key, nothing materialized', async () => {
    const res = await surface.handler(req('POST', GLOBAL, { auth: 'sk-live-abc123456789' }))
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('metered_key')
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })

  test('DELETE → 404 when not connected, then 200 after connect', async () => {
    const miss = await surface.handler(req('DELETE', GLOBAL))
    expect(miss?.status).toBe(404)
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    const hit = await surface.handler(req('DELETE', GLOBAL))
    expect(hit?.status).toBe(200)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })
})

describe('codex-auth HTTP surface — PROJECT OVERRIDE', () => {
  test('a connected GLOBAL default is the effective status for a project (scope=global)', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    const get = await surface.handler(req('GET', PROJECT))
    const body = (await get!.json()) as { status: string; scope: string }
    expect(body.status).toBe('connected')
    // Resolved from the GLOBAL default — no project override yet.
    expect(body.scope).toBe('global')
  })

  test('POST to the project route materializes an OVERRIDE under the project home', async () => {
    const res = await surface.handler(req('POST', PROJECT, { auth: subscriptionAuth() }))
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as { scope: string }
    expect(body.scope).toBe('project')
    // Override auth.json lands in the nested project home, NOT the global home.
    expect(existsSync(codexAuthPath(codexProjectHome(codexHome, 'p1')))).toBe(true)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)

    // GET on the project route now resolves the override (project wins).
    const get = await surface.handler(req('GET', PROJECT))
    const gbody = (await get!.json()) as { status: string; scope: string; materialized: boolean }
    expect(gbody.status).toBe('connected')
    expect(gbody.scope).toBe('project')
    expect(gbody.materialized).toBe(true)
  })

  test('override wins over global for that project; removing it falls back to global', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    await surface.handler(req('POST', PROJECT, { auth: subscriptionAuth() }))

    // Project resolves its own override…
    let get = await surface.handler(req('GET', PROJECT))
    expect(((await get!.json()) as { scope: string }).scope).toBe('project')

    // …remove ONLY the override (global default stays).
    const del = await surface.handler(req('DELETE', PROJECT))
    expect(del?.status).toBe(200)
    expect(existsSync(codexAuthPath(codexProjectHome(codexHome, 'p1')))).toBe(false)
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)

    // Effective status now falls back to the global default.
    get = await surface.handler(req('GET', PROJECT))
    const body = (await get!.json()) as { status: string; scope: string }
    expect(body.status).toBe('connected')
    expect(body.scope).toBe('global')
  })

  test('rejects an invalid project id', async () => {
    const res = await surface.handler(req('GET', '/api/app/projects/bad$id/codex-auth'))
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { code: string }
    expect(body.code).toBe('invalid_project_id')
  })
})

describe('codex-auth HTTP surface — MULTIPLE SEATS', () => {
  // MUTATION: drop the slug validation in `connectAccount`.
  test('POST with a malformed account name → 400, and nothing is stored', async () => {
    const res = await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth(), account: 'Work Seat' }))
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('invalid_account')
    expect(existsSync(join(codexHome, 'accounts'))).toBe(false)
  })

  test('POST with an account name → 201, materialized to that seat OWN dir', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    const res = await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth(), account: 'work' }))
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as { status: string; account: string }
    expect(body.status).toBe('connected')
    expect(body.account).toBe('work')
    expect(existsSync(join(codexHome, 'accounts', 'work', 'auth.json'))).toBe(true)
    // The first seat is a separate directory and is untouched.
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
  })

  // MUTATION: rename or drop any of the legacy top-level fields on GET.
  test('GET keeps every legacy top-level field and ADDS the seat list', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth(), account: 'work' }))
    const res = await surface.handler(req('GET', GLOBAL))
    const body = (await res!.json()) as {
      ok: boolean
      status: string
      materialized: boolean
      scope: string
      detail: string
      accounts: { slot: string; active: boolean; cooling: boolean }[]
      active: string
      next: string
      exhausted: boolean
    }
    // A client written before rotation existed must still read what it always read.
    expect(body.ok).toBe(true)
    expect(body.status).toBe('connected')
    expect(body.materialized).toBe(true)
    expect(body.scope).toBe('global')
    expect(typeof body.detail).toBe('string')
    // …and the additive fields.
    expect(body.accounts.map((a) => a.slot).sort()).toEqual(['default', 'work'])
    expect(body.active).toBe('default')
    expect(body.next).toBe('default')
    expect(body.exhausted).toBe(false)
    expect(body.accounts.find((a) => a.slot === 'default')?.active).toBe(true)
  })

  test('GET never leaks token material in the seat list', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth(), account: 'work' }))
    const res = await surface.handler(req('GET', GLOBAL))
    const raw = await res!.text()
    for (const secret of ['access_token', 'refresh_token', '"acc"', '"ref"']) {
      expect(raw).not.toContain(secret)
    }
  })

  test('DELETE ?account=<slot> removes ONE seat and leaves the other connected', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth(), account: 'work' }))
    const res = await surface.handler(req('DELETE', `${GLOBAL}?account=work`))
    expect(res?.status).toBe(200)
    expect(existsSync(join(codexHome, 'accounts', 'work', 'auth.json'))).toBe(false)
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
  })

  test('DELETE for an unknown seat → 404', async () => {
    const res = await surface.handler(req('DELETE', `${GLOBAL}?account=ghost`))
    expect(res?.status).toBe(404)
  })

  test('DELETE with no account still removes the first seat, as it always did', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    const res = await surface.handler(req('DELETE', GLOBAL))
    expect(res?.status).toBe(200)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })

  // MUTATION: route the unqualified DELETE to `disconnect` (first seat only)
  // instead of `disconnectAllAccounts`.
  //
  // This is the shipped "Disconnect Codex" button, which sends no account. If it
  // removed only the first seat, every named seat would stay stored, materialized
  // and SELECTABLE BY TRIDENT while the owner had been told Codex was
  // disconnected — a credential still in use that the UI no longer shows.
  test('DELETE with no account removes EVERY seat, which is what the button says', async () => {
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth() }))
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth(), account: 'work' }))
    await surface.handler(req('POST', GLOBAL, { auth: subscriptionAuth(), account: 'spare' }))

    const res = await surface.handler(req('DELETE', GLOBAL))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { accounts: string[] }
    expect(body.accounts.sort()).toEqual(['default', 'spare', 'work'])

    // Nothing is left on disk for any seat…
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
    expect(existsSync(join(codexHome, 'accounts', 'work', 'auth.json'))).toBe(false)
    expect(existsSync(join(codexHome, 'accounts', 'spare', 'auth.json'))).toBe(false)
    // …and the surface agrees nothing is connected.
    const after = await surface.handler(req('GET', GLOBAL))
    const status = (await after!.json()) as { status: string; accounts: unknown[] }
    expect(status.status).toBe('not_connected')
    expect(status.accounts).toEqual([])
  })
})
