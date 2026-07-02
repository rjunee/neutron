/**
 * `gateway/http/codex-credential-surface.ts` — the admin-panel Connect Codex
 * HTTP surface. Same bearer auth + owner-boundary as the credentials surface.
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
import { codexAuthPath } from '../../trident/codex-auth.ts'
import { CodexCredentialService } from '../../trident/codex-credential.ts'
import { createCodexCredentialSurface, type CodexCredentialSurface } from './codex-credential-surface.ts'

const SLUG = 'owner'
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

describe('codex-auth HTTP surface', () => {
  test('disclaims non-owned paths with null', async () => {
    expect(await surface.handler(req('GET', '/api/app/projects/p1/credentials'))).toBeNull()
  })

  test('requires a bearer (401 without)', async () => {
    const res = await surface.handler(req('GET', '/api/app/projects/p1/codex-auth', undefined, false))
    expect(res?.status).toBe(401)
  })

  test('GET → not_connected initially', async () => {
    const res = await surface.handler(req('GET', '/api/app/projects/p1/codex-auth'))
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; status: string }
    expect(body.ok).toBe(true)
    expect(body.status).toBe('not_connected')
  })

  test('POST subscription auth → 201 connected + materialized; GET reflects it', async () => {
    const res = await surface.handler(
      req('POST', '/api/app/projects/p1/codex-auth', { auth: subscriptionAuth() }),
    )
    expect(res?.status).toBe(201)
    const body = (await res!.json()) as { ok: boolean; status: string }
    expect(body.status).toBe('connected')
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)

    const get = await surface.handler(req('GET', '/api/app/projects/p1/codex-auth'))
    const gbody = (await get!.json()) as { status: string; materialized: boolean }
    expect(gbody.status).toBe('connected')
    expect(gbody.materialized).toBe(true)
  })

  test('POST metered OPENAI_API_KEY → 400 metered_key, nothing materialized', async () => {
    const res = await surface.handler(
      req('POST', '/api/app/projects/p1/codex-auth', { auth: 'sk-live-abc123456789' }),
    )
    expect(res?.status).toBe(400)
    const body = (await res!.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('metered_key')
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })

  test('DELETE → 404 when not connected, then 200 after connect', async () => {
    const miss = await surface.handler(req('DELETE', '/api/app/projects/p1/codex-auth'))
    expect(miss?.status).toBe(404)
    await surface.handler(req('POST', '/api/app/projects/p1/codex-auth', { auth: subscriptionAuth() }))
    const hit = await surface.handler(req('DELETE', '/api/app/projects/p1/codex-auth'))
    expect(hit?.status).toBe(200)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })
})
