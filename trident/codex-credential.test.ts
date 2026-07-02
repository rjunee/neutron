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
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { SecretsStore } from '../auth/secrets-store.ts'
import { ProjectCredentialStore } from '../project-credentials/store.ts'
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
