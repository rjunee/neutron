import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'
import { ReminderStore } from '@neutronai/reminders'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import {
  CORE_SOURCE_TAG,
  buildExtraTools,
  buildReminderStoreBackend,
  buildTools,
  loadManifest,
} from '../index.ts'

const OWNER = 't1'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
let store: ReminderStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'reminders-update-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
  store = new ReminderStore(projectDb)
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeFull(ownerSlug: string = OWNER) {
  const backend = buildReminderStoreBackend({
    project_slug: ownerSlug,
    projectDb,
  })
  const manifest = loadManifest()
  return {
    backend,
    manifest,
    legacy: buildTools({ manifest, project_slug: ownerSlug, audit, backend }),
    extras: buildExtraTools({ manifest, project_slug: ownerSlug, audit, backend }),
  }
}

describe('reminders_update — happy path', () => {
  test('cancels original + creates replacement with new message + preserves topic_id + fire_at', async () => {
    const { extras, legacy } = makeFull()
    const original = await legacy.reminders_create({
      message: 'walk the dogs',
      fire_at: 1_700_000_000,
      project_id: 'neutron',
    })
    const result = await extras.reminders_update({
      id: original.id,
      message: 'walk the dogs and bring leashes',
    })
    expect(result.replaced_id).toBe(original.id)
    expect(result.id).not.toBe(original.id)
    expect(result.message).toBe('walk the dogs and bring leashes')

    // Engine state: original cancelled; replacement preserves fire_at +
    // topic_id + source (= CORE_SOURCE_TAG since original was Core-owned).
    expect(store.get(original.id)?.status).toBe('cancelled')
    const replacement = store.get(result.id)
    expect(replacement?.status).toBe('pending')
    expect(replacement?.message).toBe('walk the dogs and bring leashes')
    expect(replacement?.fire_at).toBe(1_700_000_000)
    expect(replacement?.topic_id).toBe('neutron')
    expect(replacement?.source).toBe(CORE_SOURCE_TAG)
  })
})

describe('reminders_update — error paths', () => {
  test('rejects unknown id with "not found"', async () => {
    const { extras } = makeFull()
    await expect(
      extras.reminders_update({ id: 'does-not-exist', message: 'x' }),
    ).rejects.toThrow(/not found/)
  })

  test('rejects non-pending row', async () => {
    const { extras, legacy } = makeFull()
    const r = await legacy.reminders_create({ message: 'x', fire_at: 100 })
    await legacy.reminders_cancel({ id: r.id })
    await expect(
      extras.reminders_update({ id: r.id, message: 'y' }),
    ).rejects.toThrow(/not pending/)
  })

  test('cross-project id is surfaced as "not found"', async () => {
    const a = makeFull('owner_a')
    const b = makeFull('owner_b')
    const created = await a.legacy.reminders_create({
      message: 'a-only',
      fire_at: 1_700_000_000,
    })
    await expect(
      b.extras.reminders_update({ id: created.id, message: 'pwned' }),
    ).rejects.toThrow(/not found/)
    // Original row is unchanged at the engine level.
    const row = store.get(created.id)
    expect(row?.status).toBe('pending')
    expect(row?.message).toBe('a-only')
  })
})

describe('reminders_update — source preservation invariants', () => {
  test('Core-owned row stays tagged as @neutronai/reminders-core', async () => {
    const { extras, legacy } = makeFull()
    const original = await legacy.reminders_create({
      message: 'a',
      fire_at: 1_700_000_000,
    })
    const result = await extras.reminders_update({
      id: original.id,
      message: 'b',
    })
    expect(store.get(result.id)?.source).toBe(CORE_SOURCE_TAG)
  })

  test('organic engine row (source=NULL) stays NULL on update', async () => {
    // An organic engine row — gateway reminder-agents, wow-moment
    // nudges. Update via the Core's adapter MUST preserve the NULL
    // source so the uninstall sweep does NOT cancel a reminder the
    // Core never owned (symmetric inverse of the snooze r3 invariant).
    const { extras } = makeFull()
    const organic = await store.create({
      project_slug: OWNER,
      topic_id: null,
      fire_at: 1_700_000_500,
      message: 'organic',
    })
    expect(store.get(organic.id)?.source).toBeNull()
    const result = await extras.reminders_update({
      id: organic.id,
      message: 'organic — updated',
    })
    const replacement = store.get(result.id)
    expect(replacement?.source).toBeNull()
    expect(replacement?.message).toBe('organic — updated')
  })

  test('preserves recurrence on a recurring row (uses createRecurring)', async () => {
    const { extras } = makeFull()
    const recurring = await store.createRecurring({
      project_slug: OWNER,
      topic_id: null,
      fire_at: 1_700_000_000,
      message: 'weekly thing',
      recurrence: 'weekly',
    })
    const result = await extras.reminders_update({
      id: recurring.id,
      message: 'weekly thing v2',
    })
    const replacement = store.get(result.id)
    expect(replacement?.recurrence).toBe('weekly')
    expect(replacement?.message).toBe('weekly thing v2')
    expect(store.get(recurring.id)?.status).toBe('cancelled')
  })
})

describe('reminders_update — capability gate', () => {
  test('manifest missing write:reminders_core.db rejects with CapabilityDeniedError + audit row', async () => {
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'write:reminders_core.db'),
    }
    const backend = buildReminderStoreBackend({
      project_slug: OWNER,
      projectDb,
    })
    const extras = buildExtraTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      backend,
    })
    await expect(
      extras.reminders_update({ id: 'whatever', message: 'x' }),
    ).rejects.toThrow(CapabilityDeniedError)
    const denied = await audit.listDenied({
      owner_slug: OWNER,
      core_slug: 'reminders_core',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('reminders_update')).toBe(true)
  })
})
