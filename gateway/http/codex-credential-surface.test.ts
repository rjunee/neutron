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
import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { SecretsStore } from '../../auth/secrets-store.ts'
import { ProjectCredentialStore } from '../../project-credentials/store.ts'
import { createAppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import { codexAuthPath, codexProjectHome } from '../../trident/codex-auth.ts'
import { CodexCredentialService } from '../../trident/codex-credential.ts'
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
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const crypto = new SecretsStore({ data_dir: tmp, db })
  const store = new ProjectCredentialStore(db, { crypto })
  codexHome = join(tmp, '.codex')
  const service = new CodexCredentialService({ store, codexHome })
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
