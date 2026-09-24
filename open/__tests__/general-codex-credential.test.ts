import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { CodexCredentialService } from '@neutronai/trident/codex-credential.ts'
import { SqliteCodexRotationStore } from '@neutronai/trident/codex-rotation-store.ts'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
const owner = asOwnerHandle('owner')
const auth = (account = 'account-one', revision = 1) => JSON.stringify({ tokens: {
  account_id: account, access_token: `access-${revision}`, refresh_token: `refresh-${revision}`,
} })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'general-codex-credential-'))
  const path = join(root, 'project.db'); seedMigratedDb(path)
  const db = ProjectDb.open(path)
  const store = new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: root, db }) })
  const rotation = new SqliteCodexRotationStore(db)
  const codexHome = join(root, 'codex')
  const service = new CodexCredentialService({ store, rotation, codexHome, probe: async () => ({ kind: 'ok', httpStatus: 200 }) })
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  return { service, rotation, codexHome, store }
}

test('General reuses the configured credential path and accepts refresh without copying; project grants stay explicit', async () => {
  const f = fixture()
  expect(() => f.service.resolveGeneralOwnerCredential(owner)).toThrow()
  expect((await f.service.connect(owner, auth())).ok).toBe(true)
  const initial = f.service.resolveGeneralOwnerCredential(owner)
  expect(initial.codexHome).toBe(f.codexHome)
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'general')).toThrow('Connect')
  const rotated = auth('account-one', 2)
  writeFileSync(join(f.codexHome, 'auth.json'), rotated)
  expect(f.service.resolveGeneralOwnerCredential(owner)).toEqual(initial)
  expect(readFileSync(join(f.codexHome, 'auth.json'), 'utf8')).toBe(rotated)
  expect(existsSync(join(f.codexHome, 'project-owner.json'))).toBe(false)
  writeFileSync(join(f.codexHome, 'auth.json'), auth('foreign'))
  expect(() => f.service.resolveGeneralOwnerCredential(owner)).toThrow('in place')
  unlinkSync(join(f.codexHome, 'auth.json'))
  expect(() => f.service.resolveGeneralOwnerCredential(owner)).toThrow('in place')
  expect(existsSync(join(f.codexHome, 'auth.json'))).toBe(false)
})

test('a project credential cannot authorize General, and selected global revocation cannot fall through to a reviewer seat', async () => {
  const f = fixture()
  expect((await f.service.connect(owner, auth(), { scope: 'project', project_id: 'general' })).ok).toBe(true)
  expect(f.service.resolveProjectOwnerCredential(owner, 'general').credentialIdentity).toBeTruthy()
  expect(() => f.service.resolveGeneralOwnerCredential(owner)).toThrow()
  expect((await f.service.connect(owner, auth('global'))).ok).toBe(true)
  expect(f.service.resolveGeneralOwnerCredential(owner).codexHome).toBe(f.codexHome)
  expect((await f.service.connectAccount(owner, auth('reviewer-alternate'), { slot: 'alternate' })).ok).toBe(true)
  f.rotation.setActiveSlot(owner, 'default', Date.now())
  f.rotation.setCooldown(owner, 'default', { cooling_until: Date.now(), cooling_reason: 'unauthorized' })
  expect(() => f.service.resolveGeneralOwnerCredential(owner)).toThrow()
  f.rotation.setActiveSlot(owner, 'alternate', Date.now())
  expect(f.service.resolveGeneralOwnerCredential(owner).codexHome).toBe(f.service.slotHome('alternate'))
  expect(f.service.resolveProjectOwnerCredential(owner, 'general').credentialIdentity).toBeTruthy()
})

test('removed and expired selected global grants refuse despite an available alternate', async () => {
  const f = fixture()
  await f.service.connectAccount(owner, auth(), { slot: 'default' })
  await f.service.connectAccount(owner, auth('alternate-account'), { slot: 'alternate' })
  f.rotation.setActiveSlot(owner, 'default', Date.now())
  expect(f.service.resolveGeneralOwnerCredential(owner).codexHome).toBe(f.codexHome)
  await f.store.delete(owner, '', 'codex')
  expect(() => f.service.resolveGeneralOwnerCredential(owner)).toThrow()
  expect(f.rotation.getActiveSlot(owner)).toBe('default')
  await f.store.set(owner, { service: 'codex', plaintext: auth(), scope: 'global', project_id: '', label: 'fixture', expires_at: new Date(Date.now() - 1).toISOString() })
  expect(() => f.service.resolveGeneralOwnerCredential(owner)).toThrow()
  f.rotation.setActiveSlot(owner, 'alternate', Date.now())
  expect(f.service.resolveGeneralOwnerCredential(owner).codexHome).toBe(f.service.slotHome('alternate'))
})
