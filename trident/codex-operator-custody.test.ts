import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { CodexCredentialService, codexSlotService } from './codex-credential.ts'
import { SqliteCodexRotationStore } from './codex-rotation-store.ts'

const owner = asOwnerHandle('fixture-owner')
const now = Date.parse('2026-09-27T00:00:00Z')
const auth = (id: string, date = '2026-09-26T00:00:00Z', token = 'fixture-refresh') => JSON.stringify({
  tokens: { account_id: id, access_token: 'fixture-access', refresh_token: token }, last_refresh: date,
}, null, 2)
let temp: string, db: ProjectDb, store: ProjectCredentialStore, rotation: SqliteCodexRotationStore, service: CodexCredentialService
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'codex-custody-'))
  seedMigratedDb(join(temp, 'project.db'))
  db = ProjectDb.open(join(temp, 'project.db'))
  store = new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: temp, db }), now: () => new Date(now).toISOString() })
  rotation = new SqliteCodexRotationStore(db)
  service = new CodexCredentialService({ store, rotation, codexHome: join(temp, '.codex'), now: () => now })
})
afterEach(() => { db.close(); rmSync(temp, { recursive: true, force: true }) })
async function pool() {
  await service.connectAccount(owner, auth('first'), { label: 'First' })
  await service.connectAccount(owner, auth('second'), { slot: 'second', label: 'Second' })
  rotation.setActiveSlot(owner, 'default', now)
}
const disk = (slot: string) => readFileSync(join(service.slotHome(slot), 'auth.json'), 'utf8')

test('named rotation frees target quarantine and preserves departure and both live homes', async () => {
  await pool()
  const first = disk('default'), second = disk('second')
  rotation.setCooldown(owner, 'second', { cooling_until: now, cooling_reason: 'unauthorized' })
  expect(await service.rotateAccount(owner, { to: 'second' })).toMatchObject({ ok: true, changed: true, active: 'second' })
  expect(rotation.listSlots(owner).map(s => s.cooling_reason)).toEqual([null, null])
  expect(service.resolveActiveCodexHome(owner)).toBe(service.slotHome('second'))
  expect(disk('default')).toBe(first)
  expect(disk('second')).toBe(second)
  expect(await service.rotateAccount(owner, { to: 'second' })).toMatchObject({ ok: true, changed: false })
  expect(await service.rotateAccount(owner, { to: 'default' })).toMatchObject({ ok: true, active: 'default' })
  const departure = { cooling_until: now + 5000, cooling_reason: 'long-window' as const }
  rotation.setCooldown(owner, 'default', departure)
  expect(await service.rotateAccount(owner, { to: 'second' })).toMatchObject({ ok: true, active: 'second' })
  expect(rotation.listSlots(owner).find(s => s.slot === 'default')).toMatchObject(departure)
})

test('plain rotation preserves departure availability; free one/all releases without moving or reconnecting', async () => {
  await pool()
  const state = rotation.listSlots(owner)
  expect(await service.rotateAccount(owner)).toMatchObject({ ok: true, active: 'second' })
  expect(rotation.listSlots(owner)[0]).toMatchObject({ cooling_reason: null, cooling_until: null })
  rotation.setCooldown(owner, 'default', { cooling_until: now + 1000, cooling_reason: 'manual' })
  expect(await service.rotateAccount(owner)).toMatchObject({ ok: false, code: 'no_eligible_account' })
  expect(await service.freeAccount(owner, 'default')).toMatchObject({ ok: true, changed: true, active: 'second', accounts: ['default'] })
  expect(await service.freeAccount(owner, 'all')).toMatchObject({ ok: true, changed: false, active: 'second' })
  expect(rotation.listSlots(owner).map(s => [s.label, s.connected_at])).toEqual(state.map(s => [s.label, s.connected_at]))
  expect(await service.rotateAccount(owner, { to: 'missing' })).toMatchObject({ ok: false })
  expect(await service.freeAccount(owner, '../escape')).toMatchObject({ ok: false, code: 'invalid_account' })
  expect(rotation.getActiveSlot(owner)).toBe('second')
})

test('adoption persists exact newer live bytes preserving finite grant, labels, history and pointer', async () => {
  await pool()
  const expires = '2026-10-01T00:00:00Z'
  await store.set(owner, { service: 'codex', plaintext: disk('default'), scope: 'global', label: 'Finite grant', expires_at: expires })
  rotation.setCooldown(owner, 'default', { cooling_until: now + 2000, cooling_reason: 'long-window' })
  const state = rotation.listSlots(owner)
  const refreshed = auth('first', '2026-09-27T00:00:00Z', 'fixture-new-refresh') + '\n'
  writeFileSync(join(service.slotHome('default'), 'auth.json'), refreshed)
  writeFileSync(join(service.slotHome('default'), 'history.jsonl'), 'fixture-history')
  expect(await service.adoptAccount(owner, { slot: 'default', accountId: 'first' })).toMatchObject({ ok: true, changed: true, active: 'default' })
  expect(store.resolve(owner, '', 'codex')?.plaintext).toBe(refreshed)
  expect(store.getMeta(owner, '', 'codex')).toMatchObject({ label: 'Finite grant', expires_at: expires })
  expect(rotation.listSlots(owner)).toEqual(state)
  expect(disk('default')).toBe(refreshed)
  expect(readFileSync(join(service.slotHome('default'), 'history.jsonl'), 'utf8')).toBe('fixture-history')
  expect(await service.adoptAccount(owner, { slot: 'default', accountId: 'first' })).toMatchObject({ ok: true, changed: false })
})

test('adoption registers existing canonical homes without reconnecting and preserves both accounts', async () => {
  for (const [slot, id] of [['default', 'first'], ['second', 'second']]) {
    mkdirSync(service.slotHome(slot!), { recursive: true })
    const bytes = auth(id!) + '\n'
    writeFileSync(join(service.slotHome(slot!), 'auth.json'), bytes)
    expect(await service.adoptAccount(owner, { slot: slot!, accountId: id! })).toMatchObject({ ok: true, changed: true })
    expect(store.resolve(owner, '', codexSlotService(slot!))?.plaintext).toBe(bytes)
  }
  expect(await service.rotateAccount(owner, { to: 'second' })).toMatchObject({ ok: true, active: 'second' })
  expect(await service.rotateAccount(owner, { to: 'default' })).toMatchObject({ ok: true, active: 'default' })
})

test.each([
  ['identity', auth('other'), 'account_identity_conflict'],
  ['equal timestamp divergent token', auth('first', '2026-09-26T00:00:00Z', 'fixture-divergent'), 'account_freshness_conflict'],
  ['older disk', auth('first', '2026-09-25T00:00:00Z', 'fixture-old'), 'account_freshness_conflict'],
  ['unknown freshness', auth('first', 'unknown', 'fixture-unknown'), 'account_freshness_conflict'],
])('adoption refuses %s without changing custody', async (_name, bytes, code) => {
  await pool()
  const stored = store.resolve(owner, '', 'codex'), state = rotation.listSlots(owner)
  writeFileSync(join(service.slotHome('default'), 'auth.json'), bytes)
  expect(await service.adoptAccount(owner, { slot: 'default', accountId: 'first' })).toMatchObject({ ok: false, code })
  expect(store.resolve(owner, '', 'codex')).toEqual(stored)
  expect(rotation.listSlots(owner)).toEqual(state)
  expect(disk('default')).toBe(bytes)
})

test('adoption refuses duplicate accounts, expired grants and another owner identity', async () => {
  await pool()
  mkdirSync(service.slotHome('third'), { recursive: true })
  writeFileSync(join(service.slotHome('third'), 'auth.json'), auth('first'))
  expect(await service.adoptAccount(owner, { slot: 'third', accountId: 'first' })).toMatchObject({ ok: false, code: 'duplicate_account' })
  await store.set(owner, { service: 'codex', plaintext: disk('default'), scope: 'global', expires_at: '2026-09-25T00:00:00Z' })
  expect(await service.adoptAccount(owner, { slot: 'default', accountId: 'first' })).toMatchObject({ ok: false, code: 'account_grant_unavailable' })
  expect(await service.adoptAccount(owner, { slot: 'second', accountId: 'wrong' })).toMatchObject({ ok: false, code: 'account_identity_conflict' })
})

test('free all releases both quarantines and selection metadata never chooses an eligible successor', async () => {
  await pool()
  for (const slot of ['default', 'second']) rotation.setCooldown(owner, slot, { cooling_until: now, cooling_reason: 'unauthorized' })
  const before = rotation.listSlots(owner)
  expect(service.accountSelection(owner).active).toBe('default')
  expect(rotation.listSlots(owner)).toEqual(before)
  expect(await service.freeAccount(owner, 'all')).toMatchObject({ ok: true, changed: true, status: 'freed', active: 'default', accounts: ['default', 'second'] })
  expect(rotation.listSlots(owner).map(s => s.cooling_reason)).toEqual([null, null])
  expect(await service.freeAccount(owner, 'all')).toMatchObject({ changed: false, status: 'already_free', active: 'default' })
})

test('named release survives the first consuming harvest of an existing capped rollout', async () => {
  await pool()
  const sessions = join(service.slotHome('second'), 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, 'rollout.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 100, window_minutes: 300, resets_at: (now + 3600000) / 1000 },
  } } }) + '\n')
  rotation.setCooldown(owner, 'second', { cooling_until: now + 3600000, cooling_reason: 'short-window' })
  expect(await service.rotateAccount(owner, { to: 'second' })).toMatchObject({ ok: true })
  expect(service.resolveActiveCodexHome(owner)).toBe(service.slotHome('second'))
  expect(rotation.listSlots(owner).find(s => s.slot === 'second')?.cooling_reason).toBeNull()
})

test('initial adoption retains default selection, legacy cooling and usage floor without resetting existing custody', async () => {
  mkdirSync(service.slotHome('default'), { recursive: true })
  writeFileSync(join(service.slotHome('default'), 'auth.json'), auth('first'))
  const input = { slot: 'default', accountId: 'first', initial: {
    label: 'Former account name', coolingUntil: now + 3600000, usageSince: now - 5000, active: true,
  } }
  expect(await service.adoptAccount(owner, input)).toMatchObject({ ok: true, active: 'default', changed: true })
  expect(rotation.listSlots(owner)[0]).toMatchObject({ label: input.initial.label, cooling_until: input.initial.coolingUntil, connected_at: input.initial.usageSince })
  expect(store.getMeta(owner, '', 'codex')?.label).toBe(input.initial.label)
  await service.freeAccount(owner, 'default')
  expect(await service.adoptAccount(owner, { ...input, initial: { ...input.initial, label: 'Do not relabel', usageSince: now - 10000 } })).toMatchObject({ ok: true, changed: false })
  expect(rotation.listSlots(owner)[0]).toMatchObject({ label: input.initial.label, cooling_until: null, connected_at: input.initial.usageSince })
  expect(await service.adoptAccount(owner, { ...input, initial: { usageSince: now - 1000 } })).toMatchObject({ ok: true, changed: true })
  expect(rotation.listSlots(owner)[0]?.connected_at).toBe(now - 1000)
})

test('initial selection conflict and malformed legacy metadata refuse before persistence', async () => {
  await pool()
  rotation.setActiveSlot(owner, 'second', now)
  const original = store.resolve(owner, '', 'codex')
  expect(await service.adoptAccount(owner, { slot: 'default', accountId: 'first', initial: { active: true } })).toMatchObject({ ok: false, code: 'account_selection_conflict' })
  expect(await service.adoptAccount(owner, { slot: 'second', accountId: 'second', initial: { active: true } })).toMatchObject({ ok: false, code: 'account_selection_conflict' })
  for (const initial of [{ coolingUntil: -1 }, { usageSince: NaN }, { quarantine: true }, { active: 'yes' }, null]) {
    expect(await service.adoptAccount(owner, { slot: 'default', accountId: 'first', initial: initial as never })).toMatchObject({ ok: false, code: 'invalid_initial_state' })
  }
  expect(store.resolve(owner, '', 'codex')).toEqual(original)
  expect(rotation.getActiveSlot(owner)).toBe('second')
})

test('adoption reports partial custody when selection changes during persistence and preserves that pointer', async () => {
  await pool()
  rotation.removeSlot(owner, 'default')
  const bytes = auth('first', '2026-09-27T00:00:00Z', 'fixture-new-refresh')
  writeFileSync(join(service.slotHome('default'), 'auth.json'), bytes)
  const persist = store.set.bind(store)
  const spy = spyOn(store, 'set').mockImplementation(async (account, input) => {
    const result = await persist(account, input)
    rotation.setActiveSlot(owner, 'second', now)
    return result
  })
  try {
    expect(await service.adoptAccount(owner, { slot: 'default', accountId: 'first', initial: { active: true } })).toMatchObject({ ok: false, code: 'account_selection_changed' })
    expect(rotation.getActiveSlot(owner)).toBe('second')
    expect(store.resolve(owner, '', 'codex')?.plaintext).toBe(bytes)
    expect(disk('default')).toBe(bytes)
  } finally { spy.mockRestore() }
})

test.each([true, false])('plain rotation skips an expired successor, later healthy account present=%s', async (healthy) => {
  await pool()
  await store.set(owner, { service: codexSlotService('second'), plaintext: disk('second'), scope: 'global', expires_at: '2026-09-26T00:00:00Z' })
  if (healthy) await service.connectAccount(owner, auth('third'), { slot: 'third' })
  const states = rotation.listSlots(owner)
  const expired = store.getMeta(owner, '', codexSlotService('second'))
  expect(await service.rotateAccount(owner)).toMatchObject(healthy
    ? { ok: true, active: 'third', status: 'rotated' }
    : { ok: false, code: 'no_eligible_account' })
  expect(rotation.getActiveSlot(owner)).toBe(healthy ? 'third' : 'default')
  expect(rotation.listSlots(owner)).toEqual(states)
  expect(store.getMeta(owner, '', codexSlotService('second'))).toEqual(expired)
  expect(store.resolve(owner, '', codexSlotService('second'))).toBeNull()
})

test.each(['remove', 'disconnect', 'all'] as const)('adoption cannot resurrect custody after queued %s', async (operation) => {
  await pool()
  const refreshed = auth('first', '2026-09-27T00:00:00Z', 'fixture-latest')
  writeFileSync(join(service.slotHome('default'), 'auth.json'), refreshed)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const admitted = new Promise<void>(resolve => { entered = resolve })
  const transaction = db.transaction(async () => { entered(); await held })
  await admitted
  const removal = operation === 'remove' ? service.removeAccount(owner, 'default')
    : operation === 'disconnect' ? service.disconnect(owner) : service.disconnectAllAccounts(owner)
  const adoption = service.adoptAccount(owner, { slot: 'default', accountId: 'first' })
  // A different owner can complete an independent no-op while this owner's
  // destructive write is queued behind the database barrier.
  const independent = await Promise.race([
    service.freeAccount(asOwnerHandle('other-owner'), 'all'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('owner queues were coupled')), 1000)),
  ]).finally(release)
  expect(independent).toMatchObject({ ok: true, changed: false })
  await transaction
  expect(await removal).toMatchObject({ ok: true })
  expect(await adoption).toMatchObject({ ok: false, code: 'account_auth_unavailable' })
  expect(store.resolve(owner, '', 'codex')).toBeNull()
  expect(service.ensureMaterialized(owner)).toBe(false)
  expect(store.getMeta(owner, '', 'codex')).toBeNull()
})
