/**
 * `trident/codex-credential.ts` — the connect/status/disconnect service over the
 * #149 ProjectCredentialStore, plus the end-to-end VERIFY: after connect, the
 * per-project CODEX_HOME/auth.json makes `trident/codex-review.sh` see codex as
 * CONNECTED (exit 0), not the exit-10 NOT_CONNECTED branch.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { codexAuthPath, readMaterializedAuth } from './codex-auth.ts'
import { CODEX_CREDENTIAL_SERVICE, CodexCredentialService } from './codex-credential.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REVIEW_SCRIPT = join(HERE, 'codex-review.sh')
const OWNER = 'owner'

let tmp: string
let db: ProjectDb
let store: ProjectCredentialStore
let codexHome: string

function subscriptionAuth(): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref', account_id: 'a' },
    last_refresh: '2026-06-30T00:00:00.000Z',
  })
}

function newService(): CodexCredentialService {
  return new CodexCredentialService({ store, codexHome })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-cred-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const crypto = new SecretsStore({ data_dir: tmp, db })
  store = new ProjectCredentialStore(db, { crypto })
  codexHome = join(tmp, '.codex')
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('CodexCredentialService', () => {
  test('connect: validates + stores encrypted + materializes to CODEX_HOME', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, subscriptionAuth())
    expect(res.ok).toBe(true)
    expect(res.status).toBe('connected')
    expect(res.mode).toBe('subscription')

    // Stored in the #149 store under service 'codex', global scope.
    const resolved = store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)
    expect(resolved).not.toBeNull()
    expect(resolved?.scope).toBe('global')
    // ...encrypted at rest (ciphertext !== plaintext).
    const row = db
      .prepare<{ ciphertext: string }, [string]>(
        `SELECT ciphertext FROM project_credentials WHERE service = ?`,
      )
      .get(CODEX_CREDENTIAL_SERVICE)
    expect(row?.ciphertext).toBeDefined()
    expect(row?.ciphertext).not.toContain('refresh')

    // Materialized to CODEX_HOME/auth.json.
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
  })

  test('connect REJECTS a metered OPENAI_API_KEY — never stored, never materialized', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, 'sk-live-deadbeef0123456789')
    expect(res.ok).toBe(false)
    expect(res.code).toBe('metered_key')
    expect(store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)).toBeNull()
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })

  test('status reflects connected / not_connected', async () => {
    const svc = newService()
    expect(svc.status(OWNER).status).toBe('not_connected')
    await svc.connect(OWNER, subscriptionAuth())
    const s = svc.status(OWNER)
    expect(s.status).toBe('connected')
    expect(s.materialized).toBe(true)
  })

  test('disconnect removes the credential + the auth.json', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    const { ok } = await svc.disconnect(OWNER)
    expect(ok).toBe(true)
    expect(store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)).toBeNull()
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
    expect(svc.status(OWNER).status).toBe('not_connected')
  })

  test('ensureMaterialized self-heals a missing auth.json from the stored credential', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    // Simulate a fresh process / wiped tmp: remove just the on-disk file.
    rmSync(codexAuthPath(codexHome))
    expect(readMaterializedAuth(codexHome)).toBeNull()
    // A NEW service instance (no in-memory state) re-materializes from the store.
    const svc2 = newService()
    expect(svc2.ensureMaterialized(OWNER)).toBe(true)
    expect(readMaterializedAuth(codexHome)).not.toBeNull()
  })

  test('ensureMaterialized is a no-op with no stored credential', () => {
    expect(newService().ensureMaterialized(OWNER)).toBe(false)
  })
})

describe('CodexCredentialService — GLOBAL default + per-project OVERRIDE', () => {
  const PID = 'proj-alpha'
  const projectHome = (): string => join(codexHome, 'projects', PID)

  test('connect defaults to GLOBAL scope', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, subscriptionAuth())
    expect(res.scope).toBe('global')
    expect(store.resolve(OWNER, undefined, CODEX_CREDENTIAL_SERVICE)?.scope).toBe('global')
  })

  test('connect({scope:project}) stores an override + materializes under the project home', async () => {
    const svc = newService()
    const res = await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(res.ok).toBe(true)
    expect(res.scope).toBe('project')
    // Override auth.json lands in the nested project home, NOT the global home.
    expect(existsSync(codexAuthPath(projectHome()))).toBe(true)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
    // Stored at project scope under the REAL project id.
    expect(store.resolve(OWNER, PID, CODEX_CREDENTIAL_SERVICE)?.scope).toBe('project')
  })

  test('status resolves project → global; scope names the source', async () => {
    const svc = newService()
    // Only global connected → a project query resolves the global default.
    await svc.connect(OWNER, subscriptionAuth())
    expect(svc.status(OWNER, { project_id: PID }).scope).toBe('global')
    // Add an override → the project query now resolves the override.
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(svc.status(OWNER, { project_id: PID }).scope).toBe('project')
    // A DIFFERENT project (no override) still resolves the global default.
    expect(svc.status(OWNER, { project_id: 'other' }).scope).toBe('global')
    // The global status is unaffected by the override.
    expect(svc.status(OWNER).scope).toBe('global')
  })

  test('resolveActiveCodexHome: override → global → unset', async () => {
    const svc = newService()
    // Unset → null.
    expect(svc.resolveActiveCodexHome(OWNER, PID)).toBeNull()
    // Global only → the global home for any project.
    await svc.connect(OWNER, subscriptionAuth())
    expect(svc.resolveActiveCodexHome(OWNER, PID)).toBe(codexHome)
    expect(svc.resolveActiveCodexHome(OWNER)).toBe(codexHome)
    // Override → the project home for THAT project (others still global).
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(svc.resolveActiveCodexHome(OWNER, PID)).toBe(projectHome())
    expect(svc.resolveActiveCodexHome(OWNER, 'other')).toBe(codexHome)
  })

  test('resolveActiveCodexHome self-heals a wiped override auth.json', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    rmSync(codexAuthPath(projectHome()))
    expect(readMaterializedAuth(projectHome())).toBeNull()
    // A fresh service re-materializes the override from the store on resolve.
    const svc2 = newService()
    expect(svc2.resolveActiveCodexHome(OWNER, PID)).toBe(projectHome())
    expect(readMaterializedAuth(projectHome())).not.toBeNull()
  })

  test('disconnect override leaves the global default intact', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    const { ok } = await svc.disconnect(OWNER, { scope: 'project', project_id: PID })
    expect(ok).toBe(true)
    expect(existsSync(codexAuthPath(projectHome()))).toBe(false)
    // Global default survives → the project falls back to it.
    expect(existsSync(codexAuthPath(codexHome))).toBe(true)
    expect(svc.status(OWNER, { project_id: PID }).scope).toBe('global')
  })

  test('ensureMaterialized ignores a project override (global-only self-heal)', async () => {
    const svc = newService()
    // Only a project override exists — no global default.
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
    // ensureMaterialized must NOT pull the override into the global home.
    expect(newService().ensureMaterialized(OWNER)).toBe(false)
    expect(existsSync(codexAuthPath(codexHome))).toBe(false)
  })

  test('status reports override_present so the UI can always remove a stale override', async () => {
    const svc = newService()
    // No override → false on a project query; the GLOBAL status never carries it.
    expect(svc.status(OWNER, { project_id: PID }).override_present).toBe(false)
    expect(svc.status(OWNER).override_present).toBeUndefined()
    // A live override → present + scope project.
    await svc.connect(OWNER, subscriptionAuth(), { scope: 'project', project_id: PID })
    const live = svc.status(OWNER, { project_id: PID })
    expect(live.override_present).toBe(true)
    expect(live.scope).toBe('project')
    // Removing it → false again.
    await svc.disconnect(OWNER, { scope: 'project', project_id: PID })
    expect(svc.status(OWNER, { project_id: PID }).override_present).toBe(false)
  })

  test('an EXPIRED override masks itself behind global, but override_present stays true (P2)', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth()) // working global default
    // Store an EXPIRED project override directly (expires_at in the past) — the
    // resolver skips it, so status resolves the global default (scope=global)…
    await store.set(OWNER, {
      service: CODEX_CREDENTIAL_SERVICE,
      plaintext: subscriptionAuth(),
      scope: 'project',
      project_id: PID,
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    const s = svc.status(OWNER, { project_id: PID })
    expect(s.status).toBe('connected')
    expect(s.scope).toBe('global')
    // …but the stale override ROW is still flagged, so the UI can remove it.
    expect(s.override_present).toBe(true)
  })
})

describe('connect → codex-review.sh sees CONNECTED (exit 0)', () => {
  test('after connect, a mock codex on PATH resolves the exit-0 path', async () => {
    const svc = newService()
    await svc.connect(OWNER, subscriptionAuth())

    // Mock codex: `login status` → exit 0 (authed); `exec -` → exit 0 (review OK).
    const bin = join(tmp, 'bin')
    mkdirSync(bin, { recursive: true })
    const mock = join(bin, 'codex')
    writeFileSync(mock, '#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi\nexit 0\n')
    chmodSync(mock, 0o755)
    const diffFile = join(tmp, 'forge.diff')
    writeFileSync(diffFile, 'diff --git a/x b/x\n+change\n')

    const res = spawnSync('bash', [REVIEW_SCRIPT, 'main'], {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
        CODEX_HOME: codexHome,
        NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
        NEUTRON_CODEX_DIFF_FILE: diffFile,
      },
    })
    // exit 0 = CONNECTED (NOT the exit-10 no-auth.json branch).
    expect(res.status).toBe(0)
  })

  test('with NO credential connected, codex-review.sh is exit 10 (not connected)', () => {
    // Empty CODEX_HOME (no auth.json) → the graceful NOT_CONNECTED branch.
    mkdirSync(codexHome, { recursive: true })
    const bin = join(tmp, 'bin2')
    mkdirSync(bin, { recursive: true })
    const res = spawnSync('bash', [REVIEW_SCRIPT, 'main'], {
      cwd: tmp,
      encoding: 'utf8',
      env: { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, CODEX_HOME: codexHome },
    })
    expect(res.status).toBe(10)
  })
})
