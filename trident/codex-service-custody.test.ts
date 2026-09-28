import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { CodexCustodyAdmissionError } from '@neutronai/project-credentials/codex-custody-gate.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { CodexCredentialService } from './codex-credential.ts'
import { SqliteCodexRotationStore } from './codex-rotation-store.ts'
import { codexProjectHome } from './codex-auth.ts'

const owner = asOwnerHandle('fixture-owner'), other = asOwnerHandle('other-owner')
const now = Date.parse('2026-09-28T00:00:00Z')
const auth = (id: string, refreshed = '2026-09-26T00:00:00Z') => JSON.stringify({
  tokens: { account_id: id, access_token: `fixture.${Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString('base64url')}.fixture`, refresh_token: 'fixture-refresh' }, last_refresh: refreshed,
})
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
let temp: string, db: ProjectDb, store: ProjectCredentialStore, rotation: SqliteCodexRotationStore, service: CodexCredentialService, crypto: SecretsStore
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'codex-service-gate-'))
  seedMigratedDb(join(temp, 'project.db')); db = ProjectDb.open(join(temp, 'project.db'))
  crypto = new SecretsStore({ data_dir: temp, db })
  store = new ProjectCredentialStore(db, { crypto, now: () => new Date(now).toISOString() })
  rotation = new SqliteCodexRotationStore(db)
  service = new CodexCredentialService({ store, rotation, codexHome: join(temp, '.codex'), now: () => now })
})
afterEach(() => { db.close(); rmSync(temp, { recursive: true, force: true }) })
const rows = () => db.prepare<Record<string, unknown>, []>('SELECT * FROM project_credentials ORDER BY id').all()

test.each(['codex', 'codex-acct-second', ' CODEX ', ' Codex-Acct-SECOND '])('generic %s writes refuse while owned writes and ordinary reads still work', async raw => {
  const name = raw.trim().toLowerCase(), input = { service: raw, plaintext: auth('first'), scope: 'global' as const }
  await expect(store.set(owner, input)).rejects.toMatchObject({ code: 'reserved_service' })
  await expect(store.setReserved(owner, input)).rejects.toMatchObject({ code: 'reserved_service' })
  expect(rows()).toEqual([])
  await store.setCodex(owner, input)
  expect(store.resolve(owner, '', name)?.plaintext).toBe(input.plaintext)
  expect(store.listGlobal(owner).map(row => row.service)).toEqual([name])
  const before = rows()
  await expect(store.set(owner, { ...input, plaintext: auth('different') })).rejects.toMatchObject({ code: 'reserved_service' })
  await expect(store.delete(owner, '', raw)).rejects.toMatchObject({ code: 'reserved_service' })
  await expect(store.deleteReserved(owner, '', raw)).rejects.toMatchObject({ code: 'reserved_service' })
  expect(rows()).toEqual(before)
  expect(await store.deleteCodex(owner, '', raw)).toBe(true)
  expect(await store.deleteCodex(owner, '', raw)).toBe(false)
})

test('shared stores fence Codex writes while other credentials and owners remain writable', async () => {
  const second = new ProjectCredentialStore(db, { crypto })
  await store.setCodex(owner, { service: 'codex', plaintext: auth('first'), scope: 'project', project_id: 'project-one' })
  const lease = await store.codexCustody.beginMaintenance(owner).drained
  expect(second.codexCustody).toBe(store.codexCustody)
  expect(second.resolveProject(owner, 'project-one', 'codex')?.plaintext).toBe(auth('first'))
  expect(second.listForProject(owner, 'project-one').map(row => row.service)).toEqual(['codex'])
  await expect(second.setCodex(owner, { service: 'codex', plaintext: auth('changed'), scope: 'global' })).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
  await expect(second.deleteCodex(owner, 'project-one', 'codex')).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
  for (const name of ['codex-extra', 'my-codex', 'unrelated']) {
    await second.set(owner, { service: name, plaintext: 'synthetic-unrelated-token', scope: 'global' })
    expect(await second.delete(owner, '', name)).toBe(true)
  }
  await second.setCodex(other, { service: 'codex', plaintext: auth('other'), scope: 'global' })
  expect(second.resolve(other, '', 'codex')?.plaintext).toBe(auth('other'))
  await expect(second.setCodex(owner, { service: 'unrelated', plaintext: 'synthetic-token', scope: 'global' })).rejects.toMatchObject({ code: 'invalid_service' })
  lease.release()
  expect(await second.deleteCodex(owner, 'project-one', 'codex')).toBe(true)
})

test('maintenance drains an admitted account queue and refuses a later same-tick connect', async () => {
  const held = pending<void>(), reached = pending<void>(), original = db.run.bind(db)
  let first = true
  const delay = spyOn(db, 'run').mockImplementation(async (sql, values) => {
    if (first && sql.includes('INSERT INTO project_credentials')) { first = false; reached.resolve(); await held.promise }
    return original(sql, values)
  })
  try {
    const one = service.connectAccount(owner, auth('first'))
    await reached.promise
    const two = service.connectAccount(owner, auth('second'), { slot: 'second' })
    const request = store.codexCustody.beginMaintenance(owner)
    await expect(service.connectAccount(owner, auth('third'), { slot: 'third' })).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
    expect(store.codexCustody.inspect(owner).admission).toBe('draining')
    held.resolve()
    expect((await one).ok).toBe(true); expect((await two).ok).toBe(true)
    const lease = await request.drained
    expect(store.listGlobal(owner).map(row => row.service)).toEqual(['codex', 'codex-acct-second'])
    expect(readFileSync(join(service.slotHome('second'), 'auth.json'), 'utf8')).toContain('second')
    lease.release()
    expect((await service.connectAccount(owner, auth('third'), { slot: 'third' })).ok).toBe(true)
  } finally { held.resolve(); delay.mockRestore() }
})

test.each(['default', 'second'])('%s harvest persistence is included in the drain', async slot => {
  await service.connectAccount(owner, auth('first'))
  await service.connectAccount(owner, auth('second'), { slot: 'second' })
  rotation.setActiveSlot(owner, slot, now)
  const id = slot === 'default' ? 'first' : 'second', name = slot === 'default' ? 'codex' : 'codex-acct-second'
  const file = join(service.slotHome(slot), 'auth.json'), bytes = auth(id, '2026-09-27T00:00:00Z') + '\n'
  writeFileSync(file, bytes)
  const held = pending<void>(), reached = pending<void>(), original = db.run.bind(db)
  const delay = spyOn(db, 'run').mockImplementation(async (sql, values) => {
    if (sql.includes('INSERT INTO project_credentials')) { reached.resolve(); await held.promise }
    return original(sql, values)
  })
  try {
    service.resolveActiveCodexHome(owner)
    await reached.promise
    const request = store.codexCustody.beginMaintenance(owner)
    expect(store.codexCustody.inspect(owner).admission).toBe('draining')
    expect(store.resolve(owner, '', name)?.plaintext).not.toContain('2026-09-27')
    held.resolve()
    const lease = await request.drained
    expect(store.resolve(owner, '', name)?.plaintext).toContain('2026-09-27')
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    const before = rows(), metadata = rotation.listSlots(owner)
    expect(() => service.resolveActiveCodexHome(owner)).toThrow(CodexCustodyAdmissionError)
    expect(() => service.accountsView(owner)).toThrow(CodexCustodyAdmissionError)
    expect(() => service.everySeatRevoked(owner)).toThrow(CodexCustodyAdmissionError)
    expect(() => service.ensureMaterialized(owner)).toThrow(CodexCustodyAdmissionError)
    await expect(service.freeAccount(owner, 'all')).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
    await expect(service.rotateAccount(owner, { to: 'second' })).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
    await expect(service.disconnectAllAccounts(owner)).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
    await expect(service.adoptAccount(owner, { slot, accountId: id })).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
    expect(service.accountSelection(owner).active).toBe(slot)
    expect(rows()).toEqual(before); expect(rotation.listSlots(owner)).toEqual(metadata)
    lease.release()
  } finally { held.resolve(); delay.mockRestore() }
})

test('inflight status probe drains its metadata write and later polling cannot write while held', async () => {
  const result = pending<{ kind: 'revoked'; httpStatus: number }>()
  service = new CodexCredentialService({ store, rotation, codexHome: join(temp, '.codex'), now: () => now, probe: () => result.promise })
  await service.connectAccount(owner, auth('first'))
  const probe = service.refreshSeatLiveness(owner)
  const request = store.codexCustody.beginMaintenance(owner)
  expect(store.codexCustody.inspect(owner).admission).toBe('draining')
  result.resolve({ kind: 'revoked', httpStatus: 401 })
  await probe
  const lease = await request.drained, before = rotation.listSlots(owner)
  expect(before[0]?.cooling_reason).toBe('unauthorized')
  await expect(service.refreshSeatLiveness(owner)).rejects.toBeInstanceOf(CodexCustodyAdmissionError)
  expect(rotation.listSlots(owner)).toEqual(before)
  expect(() => service.status(owner)).toThrow(CodexCustodyAdmissionError)
  lease.release()
  expect(service.status(owner).status).toBe('revoked')
})

test('project status cannot create a custody marker during maintenance, then resumes after release', async () => {
  const projectId = 'not-yet-materialized'
  await store.setCodex(owner, { service: 'codex', plaintext: auth('project-account'), scope: 'project', project_id: projectId })
  const home = codexProjectHome(service.slotHome('default'), projectId)
  expect(existsSync(home)).toBe(false)
  const lease = await store.codexCustody.beginMaintenance(owner).drained
  expect(() => service.status(owner, { scope: 'project', project_id: projectId })).toThrow(CodexCustodyAdmissionError)
  expect(() => service.projectOwnerCredentialStatus(owner, projectId)).toThrow(CodexCustodyAdmissionError)
  expect(existsSync(home)).toBe(false)
  expect(store.resolveProject(owner, projectId, 'codex')?.plaintext).toBe(auth('project-account'))
  lease.release()
  expect(service.projectOwnerCredentialStatus(owner, projectId).configured).toBe(true)
  expect(readFileSync(join(home, 'project-owner.json'), 'utf8')).toBe(JSON.stringify(projectId) + '\n')
  expect(service.status(owner, { scope: 'project', project_id: projectId }).scope).toBe('project')
})
