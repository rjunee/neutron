/**
 * @neutronai/cores-runtime — shared install-lifecycle test harness.
 *
 * Refactor X4 (item 5). Six bundled cores carried a byte-identical
 * install-lifecycle test scaffold (each core's
 * `__tests__/install-lifecycle.test.ts`): a tmp `ProjectDb` + `SecretsStore` +
 * `SecretAuditLog` + `CoreInstallationsStore`, a `NoopPrompter`, and a
 * `copy<core>IntoFixture` helper that copies the Core dir into an isolated
 * fixture the bundled-registry walk can read. This is that ONE shared
 * scaffold; each Core's test keeps only its own assertions (+ a custom
 * prompter iff it declares secrets).
 *
 * NOTE: framework-agnostic on purpose — no `bun:test` import. The Core's
 * test drives `create`/`destroy` from its own `beforeEach`/`afterEach`.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Database } from 'bun:sqlite'

import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { CoreInstallationsStore } from '../installations-store.ts'
import type { SecretsPrompter } from '../lifecycle.ts'
import { SecretAuditLog } from '../secret-audit.ts'

/**
 * A prompter that declines every secret prompt. The common case — most
 * bundled cores declare zero secrets, so no interactive value is ever
 * needed for an install round-trip.
 */
export class NoopPrompter implements SecretsPrompter {
  async promptApiKey(): Promise<string | null> {
    return null
  }
  async promptOauthToken(): Promise<{
    access_token: string
    expires_at?: number
  } | null> {
    return null
  }
  async promptOauthClient(): Promise<{
    client_id: string
    client_secret: string
  } | null> {
    return null
  }
}

export interface InstallLifecycleEnv {
  /** Root tmp dir — remove on teardown. */
  tmp: string
  /** `<tmp>/data` — the Core data dir passed to `installCore`. */
  dataDir: string
  projectDb: ProjectDb
  secretsStore: SecretsStore
  audit: SecretAuditLog
  installations: CoreInstallationsStore
}

/**
 * Build a fresh install-lifecycle environment: a tmp dir, a migrated
 * `project.db`, and the four runtime stores an install round-trip needs.
 * `prefix` names the `mkdtemp` template (e.g. `'codegen-install-'`).
 */
export function createInstallLifecycleEnv(prefix: string): InstallLifecycleEnv {
  const tmp = mkdtempSync(join(tmpdir(), prefix))
  const dataDir = join(tmp, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  const projectDb = ProjectDb.open(dbPath)
  const secretsStore = new SecretsStore({ data_dir: dataDir, db: projectDb })
  const audit = new SecretAuditLog({ db: projectDb })
  const installations = new CoreInstallationsStore({ db: projectDb })
  return { tmp, dataDir, projectDb, secretsStore, audit, installations }
}

/** Close the env's DB handle + remove its tmp dir. */
export function destroyInstallLifecycleEnv(env: InstallLifecycleEnv): void {
  env.projectDb.close()
  rmSync(env.tmp, { recursive: true, force: true })
}

/**
 * Copy a Core's source directory into an isolated fixture under
 * `<fixtureRoot>/cores/<mountedAs>/` so the bundled-Core registry can walk a
 * real `package.json`. Skips `__tests__` + `node_modules` so the walk
 * doesn't try to validate test files. Returns the mounted Core dir.
 */
export function copyCoreIntoFixture(
  coreSrcDir: string,
  fixtureRoot: string,
  mountedAs: string,
): string {
  const dest = join(fixtureRoot, 'cores', mountedAs)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(coreSrcDir, dest, {
    recursive: true,
    filter: (src) => {
      if (src.endsWith('__tests__')) return false
      if (src.endsWith('node_modules')) return false
      return true
    },
  })
  return dest
}
