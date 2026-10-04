import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { CodexCredentialService } from './codex-credential.ts'
import { SqliteCodexRotationStore } from './codex-rotation-store.ts'
import { acquireCodexAccountWriteLease } from '@neutronai/runtime/adapters/codex-cli/account-writer-lock.ts'

const roots: string[] = []
const databases: ProjectDb[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const owner = asOwnerHandle('fixture-owner')
function auth(account = 'fixture-account', refresh = 'first', last = '2026-09-01T00:00:00Z') {
  return JSON.stringify({ tokens: { account_id: account, access_token: 'fixture-access', refresh_token: refresh }, last_refresh: last })
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-grant-')); roots.push(root)
  const file = join(root, 'project.db'); seedMigratedDb(file)
  const db = ProjectDb.open(file); databases.push(db)
  let now = Date.parse('2026-10-01T00:00:00Z')
  const store = new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: root, db }), now: () => new Date(now).toISOString() })
  const codexHome = join(root, '.codex')
  let revoked = false
  const service = new CodexCredentialService({ store, codexHome, rotation: new SqliteCodexRotationStore(db), now: () => now,
    probe: async () => revoked ? ({ kind: 'revoked', httpStatus: 401 }) : ({ kind: 'ok', httpStatus: 200 }) })
  return { db, store, service, codexHome, revoke() { revoked = true }, setNow(value: number) { now = value } }
}

test('explicit references share canonical refreshed auth with isolated full project markers and no credential copies', async () => {
  const f = fixture()
  await f.service.connect(owner, auth())
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('Connect')
  const source = f.service.projectAccounts(owner)[0]!
  const authBefore = readFileSync(join(f.codexHome, 'auth.json'), 'utf8')
  expect((await f.service.grantProjectAccount(owner, 'one', source)).ok).toBe(true)
  expect((await f.service.grantProjectAccount(owner, 'two', source)).ok).toBe(true)
  const one = f.service.resolveProjectOwnerCredential(owner, 'one')
  const two = f.service.resolveProjectOwnerCredential(owner, 'two')
  expect(one.codexHome).toBe(f.codexHome)
  expect(two.codexHome).toBe(f.codexHome)
  expect(one.ownerRootDirectory).not.toBe(two.ownerRootDirectory)
  for (const [project, grant] of [['one', one], ['two', two]] as const) {
    expect(JSON.parse(readFileSync(join(grant.ownerRootDirectory!, 'project-owner.json'), 'utf8'))).toBe(project)
    expect(existsSync(join(grant.ownerRootDirectory!, 'auth.json'))).toBe(false)
    const stored = f.store.resolveProject(owner, project, 'codex')!.plaintext
    expect(stored).not.toContain('refresh_token')
    expect(stored).not.toContain('access_token')
  }
  expect(readFileSync(join(f.codexHome, 'auth.json'), 'utf8')).toBe(authBefore)
  writeFileSync(join(f.codexHome, 'auth.json'), auth('fixture-account', 'rotated', '2026-10-02T00:00:00Z'))
  expect(f.service.resolveProjectOwnerCredential(owner, 'one')).toEqual(one)
  expect(f.service.resolveProjectOwnerCredential(owner, 'two')).toEqual(two)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.store.resolve(owner, undefined, 'codex')!.plaintext).toContain('rotated')
  await f.service.disconnect(owner, { scope: 'project', project_id: 'one' })
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('Connect')
  expect(f.service.resolveProjectOwnerCredential(owner, 'two')).toEqual(two)
  expect(readFileSync(join(f.codexHome, 'auth.json'), 'utf8')).toContain('rotated')
  await f.service.grantProjectAccount(owner, 'one', source)
  expect(f.service.resolveProjectOwnerCredential(owner, 'one').projectGrantIdentity).not.toBe(one.projectGrantIdentity)
})

test('foreign owners, source deletion/recreation, account replacement, expired grants and markers refuse', async () => {
  const f = fixture()
  await f.service.connect(owner, auth())
  const source = f.service.projectAccounts(owner)[0]!
  expect((await f.service.grantProjectAccount(asOwnerHandle('foreign'), 'one', source)).ok).toBe(false)
  const expires_at = '2026-10-02T00:00:00Z'
  await f.service.grantProjectAccount(owner, 'one', { ...source, expires_at })
  const credential = f.service.resolveProjectOwnerCredential(owner, 'one')
  writeFileSync(join(credential.ownerRootDirectory!, 'project-owner.json'), JSON.stringify('other'))
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('ownership')
  writeFileSync(join(credential.ownerRootDirectory!, 'project-owner.json'), JSON.stringify('one'))
  writeFileSync(join(f.codexHome, 'auth.json'), auth('fixture-account', 'rotated', '2026-10-01T01:00:00Z'))
  f.service.resolveProjectOwnerCredential(owner, 'one')
  expect(f.store.getMeta(owner, 'one', 'codex')!.expires_at).toBe(expires_at)
  f.setNow(Date.parse(expires_at))
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('Connect')
  f.setNow(Date.parse('2026-10-01T00:00:00Z'))
  await f.service.disconnect(owner)
  await f.service.connect(owner, auth())
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('no longer available')
  await f.service.grantProjectAccount(owner, 'one', f.service.projectAccounts(owner)[0]!)
  await f.service.connect(owner, auth('other-account'))
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('no longer available')
})

test('duplicate project paste refuses while an independent account still connects', async () => {
  const f = fixture()
  await f.service.connect(owner, auth())
  expect(await f.service.connect(owner, auth(), { scope: 'project', project_id: 'one' })).toMatchObject({ ok: false, code: 'existing_account_requires_grant' })
  expect((await f.service.connect(owner, auth('independent'), { scope: 'project', project_id: 'one' })).ok).toBe(true)
  expect(f.service.resolveProjectOwnerCredential(owner, 'one').credentialIdentity).toBeTruthy()
  expect((await f.service.connect(owner, auth('independent'), { scope: 'project', project_id: 'two' })).ok).toBe(false)
  expect((await f.service.connect(owner, auth('independent'))).ok).toBe(false)
  expect((await f.service.connectAccount(owner, auth('independent'), { slot: 'named' })).ok).toBe(false)
  expect((await f.service.connect(owner, auth('second-independent'), { scope: 'project', project_id: 'two' })).ok).toBe(true)
})

test('a revoked selected account refuses existing and fresh project grants without changing authority', async () => {
  const f = fixture()
  await f.service.connect(owner, auth())
  const source = f.service.projectAccounts(owner)[0]!
  expect((await f.service.grantProjectAccount(owner, 'one', source)).ok).toBe(true)
  f.revoke()
  await f.service.refreshSeatLiveness(owner, { scope: 'project', project_id: 'one' })
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('revoked')
  expect((await f.service.grantProjectAccount(owner, 'two', source)).ok).toBe(false)
  expect(f.store.getMeta(owner, 'two', 'codex')).toBeNull()
})

test('concurrent project and global admissions cannot create two refresh authorities for one account', async () => {
  const f = fixture()
  const projectRace = await Promise.all(['one', 'two'].map(project_id => f.service.connect(owner, auth(), { scope: 'project', project_id })))
  expect(projectRace.filter(result => result.ok)).toHaveLength(1)
  expect(f.store.listCodexCustody(owner)).toHaveLength(1)
  await f.service.disconnect(owner, { scope: 'project', project_id: projectRace[0]!.ok ? 'one' : 'two' })
  const mixedRace = await Promise.all([
    f.service.connect(owner, auth(), { scope: 'project', project_id: 'three' }),
    f.service.connectAccount(owner, auth(), { slot: 'named' }),
  ])
  expect(mixedRace.filter(result => result.ok)).toHaveLength(1)
  expect(f.store.listCodexCustody(owner)).toHaveLength(1)
  const distinct = await Promise.all(['four', 'five'].map(project_id =>
    f.service.connect(owner, auth(`independent-${project_id}`), { scope: 'project', project_id })))
  expect(distinct.every(result => result.ok)).toBe(true)
})

test('concurrent project selection and independent connect leave one coherent credential authority', async () => {
  const f = fixture()
  await f.service.connect(owner, auth())
  const source = f.service.projectAccounts(owner)[0]!
  for (const reversed of [false, true]) {
    const project = reversed ? 'direct-first' : 'grant-first'
    const select = () => f.service.grantProjectAccount(owner, project, source)
    const connect = () => f.service.connect(owner, auth(`independent-${project}`), { scope: 'project', project_id: project })
    const results = await Promise.all((reversed ? [connect, select] : [select, connect]).map(run => run()))
    expect(results.some(result => result.ok)).toBe(true)
    const binding = f.service.resolveProjectOwnerCredential(owner, project)
    const stored = f.store.resolveProject(owner, project, 'codex')!.plaintext
    expect(stored).not.toContain('codex-project-grant')
    expect(readFileSync(join(binding.codexHome, 'auth.json'), 'utf8')).toContain(`independent-${project}`)
  }
})

test('queued same-account harvest cannot recreate a revoked project grant', async () => {
  const f = fixture()
  const target = { scope: 'project' as const, project_id: 'one' }
  await f.service.connect(owner, auth(), target)
  const binding = f.service.resolveProjectOwnerCredential(owner, 'one')
  writeFileSync(join(binding.codexHome, 'auth.json'), auth('fixture-account', 'new', '2026-10-02T00:00:00Z'))
  // Queue deletion first, then schedule a read's asynchronous harvest while the
  // old row is still visible. It must recheck authority after deletion settles.
  const deleting = f.service.disconnect(owner, target)
  f.service.resolveProjectOwnerCredential(owner, 'one')
  expect(await deleting).toEqual({ ok: true })
  // The following queued mutation drains the preceding refresh callback.
  await f.service.connectAccount(owner, auth('distinct'), { slot: 'named' })
  expect(f.store.getMeta(owner, 'one', 'codex')).toBeNull()
  expect(() => f.service.resolveProjectOwnerCredential(owner, 'one')).toThrow('Connect')
  expect(existsSync(join(binding.codexHome, 'auth.json'))).toBe(false)
})

test('busy native account refuses credential mutations and self-heal but metadata-only project revocation remains available', async () => {
  const f = fixture()
  await f.service.connect(owner, auth())
  const source = f.service.projectAccounts(owner)[0]!
  await f.service.grantProjectAccount(owner, 'one', source)
  const before = f.store.resolve(owner, undefined, 'codex')!.plaintext
  const diskBefore = readFileSync(join(f.codexHome, 'auth.json'), 'utf8')
  const lease = acquireCodexAccountWriteLease(f.codexHome)
  try {
    await expect(f.service.connect(owner, auth('replacement'))).rejects.toMatchObject({ code: 'accountBusy' })
    await expect(f.service.disconnect(owner)).rejects.toMatchObject({ code: 'accountBusy' })
    expect(f.store.resolve(owner, undefined, 'codex')!.plaintext).toBe(before)
    expect(readFileSync(join(f.codexHome, 'auth.json'), 'utf8')).toBe(diskBefore)
    expect(await f.service.disconnect(owner, { scope: 'project', project_id: 'one' })).toEqual({ ok: true })
    expect(f.store.getMeta(owner, 'one', 'codex')).toBeNull()
    expect(readFileSync(join(f.codexHome, 'auth.json'), 'utf8')).toBe(diskBefore)
    unlinkSync(join(f.codexHome, 'auth.json'))
    expect(() => f.service.ensureMaterialized(owner)).toThrow()
    expect(existsSync(join(f.codexHome, 'auth.json'))).toBe(false)
  } finally { lease.close() }
  expect(f.service.ensureMaterialized(owner)).toBe(true)
  expect((await f.service.connect(owner, auth('replacement'))).ok).toBe(true)
  expect((await f.service.disconnect(owner)).ok).toBe(true)
})

test('disconnect-all admits every account before deletion and independent project writes honor the account lease', async () => {
  const f = fixture()
  await f.service.connect(owner, auth())
  await f.service.connectAccount(owner, auth('named'), { slot: 'named' })
  const namedHome = join(f.codexHome, 'accounts', 'named')
  const lease = acquireCodexAccountWriteLease(namedHome)
  try {
    await expect(f.service.disconnectAllAccounts(owner)).rejects.toMatchObject({ code: 'accountBusy' })
    await expect(f.service.connectAccount(owner, auth('replacement'), { slot: 'named' })).rejects.toMatchObject({ code: 'accountBusy' })
    expect(f.store.getMeta(owner, '', 'codex')).not.toBeNull()
    expect(f.store.getMeta(owner, '', 'codex-acct-named')).not.toBeNull()
    expect(existsSync(join(f.codexHome, 'auth.json'))).toBe(true)
    expect(existsSync(join(namedHome, 'auth.json'))).toBe(true)
  } finally { lease.close() }
  expect((await f.service.disconnectAllAccounts(owner)).removed).toHaveLength(2)
  await f.service.connect(owner, auth('independent'), { scope: 'project', project_id: 'one' })
  const project = f.service.resolveProjectOwnerCredential(owner, 'one')
  const projectLease = acquireCodexAccountWriteLease(project.codexHome)
  try {
    await expect(f.service.disconnect(owner, { scope: 'project', project_id: 'one' })).rejects.toMatchObject({ code: 'accountBusy' })
    await expect(f.service.connect(owner, auth('replacement'), { scope: 'project', project_id: 'one' })).rejects.toMatchObject({ code: 'accountBusy' })
    expect(f.service.resolveProjectOwnerCredential(owner, 'one')).toEqual(project)
  } finally { projectLease.close() }
  expect((await f.service.disconnect(owner, { scope: 'project', project_id: 'one' })).ok).toBe(true)
})
