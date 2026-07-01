import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'
import { ReminderStore } from '@neutronai/reminders'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
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
  tmp = mkdtempSync(join(tmpdir(), 'reminders-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
  // A `ReminderStore` over the same db gives the tests a side-channel
  // for inspecting raw engine rows independent of the adapter under
  // test (e.g. asserting that the original row was cancelled after a
  // snooze).
  store = new ReminderStore(projectDb)
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeTools(ownerSlug: string = OWNER) {
  const backend = buildReminderStoreBackend({
    project_slug: ownerSlug,
    projectDb,
  })
  const manifest = loadManifest()
  return buildTools({
    manifest,
    project_slug: ownerSlug,
    audit,
    backend,
  })
}

describe('buildTools — capability-gated dispatch', () => {
  test('reminders_create + reminders_list round-trip', async () => {
    const tools = makeTools()

    const r1 = await tools.reminders_create({
      message: 'wake the kids',
      fire_at: 1_700_000_500,
    })
    expect(r1.id).toBeTruthy()
    expect(r1.fire_at).toBe(1_700_000_500)

    const r2 = await tools.reminders_create({
      message: 'preschool pickup',
      fire_at: 1_700_000_100,
    })
    expect(r2.id).toBeTruthy()

    const listed = await tools.reminders_list({})
    expect(listed.results).toHaveLength(2)
    // Soonest-firing first — r2 (fire_at=1_700_000_100) before r1 (1_700_000_500).
    expect(listed.results[0]?.id).toBe(r2.id)
    expect(listed.results[1]?.id).toBe(r1.id)
    expect(listed.results[0]?.message).toBe('preschool pickup')
    expect(listed.results[0]?.status).toBe('pending')

    // Verify a `secret_audit_log` row was written for every dispatch —
    // proves the capability guard ran on the success path.
    const auditRows = await audit.list({ project_slug: OWNER, core_slug: 'reminders_core' })
    const successRows = auditRows.filter((row) => row.outcome === 'ok')
    expect(successRows.length).toBeGreaterThanOrEqual(3)
    const toolNames = new Set(successRows.map((row) => row.label))
    expect(toolNames.has('reminders_create')).toBe(true)
    expect(toolNames.has('reminders_list')).toBe(true)
  })

  test('reminders_create with recurrence persists a RECURRING row (not a one-shot)', async () => {
    const tools = makeTools()
    // The bug: passing a cadence used to silently create a one-shot that fired
    // once and died (the agent then falsely confirmed "every week"). Now it
    // routes through the engine's createRecurring so the tick loop reschedules.
    const r = await tools.reminders_create({
      message: 'weekly standup review',
      fire_at: 1_700_000_900,
      recurrence: 'weekly',
    })
    expect(r.id).toBeTruthy()
    expect(r.fire_at).toBe(1_700_000_900)
    // Inspect the raw engine row via the side-channel store: recurrence is set.
    const row = store.get(r.id)
    expect(row?.recurrence).toBe('weekly')
    expect(row?.status).toBe('pending')

    // A one-shot create (no recurrence) leaves recurrence null — unchanged.
    const oneShot = await tools.reminders_create({ message: 'call dentist', fire_at: 1_700_001_000 })
    expect(store.get(oneShot.id)?.recurrence).toBeNull()
  })

  test('reminders_create with recurrence_spec persists a CRON-recurring row', async () => {
    const tools = makeTools()
    const r = await tools.reminders_create({
      message: 'daily 9am brief',
      fire_at: 1_700_000_900,
      recurrence_spec: '0 9 * * *',
    })
    expect(r.id).toBeTruthy()
    const row = store.get(r.id)
    expect(row?.recurrence_spec).toBe('0 9 * * *')
    expect(row?.recurrence).toBeNull()
    expect(row?.status).toBe('pending')
  })

  test('reminders_create rejects an invalid cron expression', async () => {
    const tools = makeTools()
    await expect(
      tools.reminders_create({ message: 'x', fire_at: 1_700_001_050, recurrence_spec: 'not a cron' }),
    ).rejects.toThrow(/invalid cron/i)
  })

  test('reminders_create rejects passing BOTH recurrence and recurrence_spec', async () => {
    const tools = makeTools()
    await expect(
      tools.reminders_create({
        message: 'x',
        fire_at: 1_700_001_060,
        recurrence: 'weekly',
        recurrence_spec: '0 9 * * *',
      }),
    ).rejects.toThrow(/at most one/i)
  })

  test('snooze preserves a cron reminder’s cadence (does not degrade to one-shot)', async () => {
    const tools = makeTools()
    const r = await tools.reminders_create({
      message: 'daily 9am',
      fire_at: 1_700_000_900,
      recurrence_spec: '0 9 * * *',
    })
    const snoozed = await tools.reminders_snooze({ id: r.id, new_fire_at: 1_700_099_999 })
    const row = store.get(snoozed.id)
    expect(row?.recurrence_spec).toBe('0 9 * * *')
    expect(row?.recurrence).toBeNull()
    // Original is cancelled.
    expect(store.get(r.id)?.status).toBe('cancelled')
  })

  test('update preserves a cron reminder’s cadence while rewriting the body', async () => {
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb })
    const r = await backend.create({
      message: 'old body',
      fire_at: 1_700_000_900,
      recurrence_spec: '0 9 * * 1-5',
    })
    const updated = await backend.update({ id: r.id, message: 'new body' })
    const row = store.get(updated.id)
    expect(row?.message).toBe('new body')
    expect(row?.recurrence_spec).toBe('0 9 * * 1-5')
    expect(row?.recurrence).toBeNull()
    expect(row?.fire_at).toBe(1_700_000_900)
  })

  test('reminders_create rejects an unsupported cadence rather than writing a dead row', async () => {
    const tools = makeTools()
    // 'daily' is NOT representable by the engine's cadence enum; without the
    // guard it would write a row whose next-occurrence delta is undefined → NaN
    // fire_at that never reschedules. Reject it clearly instead.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools.reminders_create({ message: 'daily check-in', fire_at: 1_700_001_100, recurrence: 'daily' as any }),
    ).rejects.toThrow(/unsupported recurrence/i)
  })

  test('reminders_list sorts by fire_at ASCENDING (soonest-firing first) — explicit assertion', async () => {
    // Lock the soonest-first ordering. Reminders are next-actionable
    // by definition, so the launcher MUST surface them in fire-time
    // order ascending — not insertion order, not descending. This is
    // the inverse of Notes Core's newest-first list semantic.
    const tools = makeTools()
    // Insert out of fire_at order: late, early, mid.
    await tools.reminders_create({ message: 'late',  fire_at: 3000 })
    await tools.reminders_create({ message: 'early', fire_at: 1000 })
    await tools.reminders_create({ message: 'mid',   fire_at: 2000 })

    const listed = await tools.reminders_list({})
    expect(listed.results.map((r) => r.message)).toEqual(['early', 'mid', 'late'])
    // Belt-and-suspenders: assert each consecutive fire_at is strictly
    // greater than the previous one.
    const fires = listed.results.map((r) => r.fire_at)
    for (let i = 1; i < fires.length; i++) {
      expect(fires[i]).toBeGreaterThan(fires[i - 1]!)
    }
  })

  test('reminders_list filters by project_id (matched against engine topic_id)', async () => {
    const tools = makeTools()
    await tools.reminders_create({ message: 'global',      fire_at: 1000 })
    await tools.reminders_create({ message: 'p1 morning',  fire_at: 1100, project_id: 'p1' })
    await tools.reminders_create({ message: 'p2 afternoon', fire_at: 1200, project_id: 'p2' })

    const scoped = await tools.reminders_list({ project_id: 'p1' })
    expect(scoped.results).toHaveLength(1)
    expect(scoped.results[0]?.message).toBe('p1 morning')
    expect(scoped.results[0]?.project_id).toBe('p1')

    const unscoped = await tools.reminders_list({})
    expect(unscoped.results.map((r) => r.message)).toEqual([
      'global',
      'p1 morning',
      'p2 afternoon',
    ])
  })

  test('reminders_list honours `limit`, returning the soonest-firing N', async () => {
    const tools = makeTools()
    for (let i = 1; i <= 5; i++) {
      await tools.reminders_create({ message: `r${i}`, fire_at: 1000 + i * 100 })
    }
    const capped = await tools.reminders_list({ limit: 3 })
    // Soonest-three: r1, r2, r3.
    expect(capped.results.map((r) => r.message)).toEqual(['r1', 'r2', 'r3'])
  })

  test('reminders_list manifest input_schema rejects status values other than "pending"', () => {
    // The published manifest used to advertise status: 'pending' |
    // 'fired' | 'cancelled' but the implementation returned [] for
    // anything non-pending — a documented tool-contract lie. r2 tightens
    // the enum to just ['pending'] so callers (and the validator) can't
    // ask for a state the backend doesn't expose.
    const m = loadManifest()
    const list = m.tools.find((t) => t.name === 'reminders_list')
    expect(list).toBeDefined()
    const props = (list?.input_schema as { properties?: Record<string, unknown> } | undefined)
      ?.properties
    const statusProp = props?.['status'] as { enum?: string[] } | undefined
    expect(statusProp).toBeDefined()
    expect(statusProp?.enum).toEqual(['pending'])
    // Belt-and-suspenders: a brand-new manifest schema with the locked
    // enum should still validate clean against the SDK's parseManifest
    // (regression: tighter enum doesn't trip the schema gate).
    expect(() => loadManifest()).not.toThrow()
  })

  test('reminders_snooze cancels original and re-creates with new fire_at', async () => {
    const tools = makeTools()
    const original = await tools.reminders_create({
      message: 'snooze me',
      fire_at: 1_700_000_000,
      project_id: 'p1',
    })
    const snoozed = await tools.reminders_snooze({
      id: original.id,
      new_fire_at: 1_700_500_000,
    })
    expect(snoozed.cancelled_id).toBe(original.id)
    expect(snoozed.id).not.toBe(original.id)
    expect(snoozed.fire_at).toBe(1_700_500_000)

    // Engine state: original is cancelled, new row is pending at new fire_at.
    expect(store.get(original.id)?.status).toBe('cancelled')
    const replacement = store.get(snoozed.id)
    expect(replacement?.status).toBe('pending')
    expect(replacement?.fire_at).toBe(1_700_500_000)
    expect(replacement?.message).toBe('snooze me')
    expect(replacement?.topic_id).toBe('p1')

    // Listing shows ONLY the new row (cancelled rows excluded from
    // listPending) — and fire_at moved forward.
    const listed = await tools.reminders_list({})
    expect(listed.results).toHaveLength(1)
    expect(listed.results[0]?.id).toBe(snoozed.id)
    expect(listed.results[0]?.fire_at).toBe(1_700_500_000)
  })

  test('reminders_snooze PRESERVES recurrence (a snoozed weekly reminder stays weekly)', async () => {
    const tools = makeTools()
    // Now that recurring reminders are reachable, snoozing one must keep its
    // cadence — otherwise it silently degrades to a one-shot after the first
    // snooze and stops repeating (Codex r1 P2).
    const original = await tools.reminders_create({
      message: 'weekly review',
      fire_at: 1_700_000_000,
      recurrence: 'weekly',
    })
    const snoozed = await tools.reminders_snooze({ id: original.id, new_fire_at: 1_700_500_000 })
    const replacement = store.get(snoozed.id)
    expect(replacement?.status).toBe('pending')
    expect(replacement?.fire_at).toBe(1_700_500_000)
    expect(replacement?.recurrence).toBe('weekly')
  })

  test('reminders_snooze rejects a non-pending reminder', async () => {
    const tools = makeTools()
    const r = await tools.reminders_create({ message: 'x', fire_at: 1000 })
    await tools.reminders_cancel({ id: r.id })
    await expect(
      tools.reminders_snooze({ id: r.id, new_fire_at: 5000 }),
    ).rejects.toThrow(/not pending/)
  })

  test('reminders_snooze rejects an unknown id', async () => {
    const tools = makeTools()
    await expect(
      tools.reminders_snooze({ id: 'does-not-exist', new_fire_at: 5000 }),
    ).rejects.toThrow(/not found/)
  })

  test('reminders_cancel removes a pending row from the listing', async () => {
    const tools = makeTools()
    const a = await tools.reminders_create({ message: 'a', fire_at: 1000 })
    const b = await tools.reminders_create({ message: 'b', fire_at: 2000 })
    const cancelled = await tools.reminders_cancel({ id: a.id })
    expect(cancelled.ok).toBe(true)

    const listed = await tools.reminders_list({})
    expect(listed.results.map((r) => r.id)).toEqual([b.id])

    // Second cancel returns ok=false (already cancelled).
    const second = await tools.reminders_cancel({ id: a.id })
    expect(second.ok).toBe(false)
  })

  test('capability gate: tool dispatched against a manifest missing the required capability rejects + audits capability_denied', async () => {
    // Synthesize a manifest with the four tool entries but strip
    // `write:reminders_core.db` from capabilities[]. The guard must
    // reject every WRITE tool (create / snooze / cancel) with
    // `capability_not_declared` and write a `capability_denied` audit
    // row. The READ tool (`list`) keeps working because its gate is
    // `read:reminders_core.db` which is still declared.
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter((c) => c !== 'write:reminders_core.db'),
    }
    const backend = buildReminderStoreBackend({
      project_slug: OWNER,
      projectDb,
    })
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      backend,
    })

    await expect(
      tools.reminders_create({ message: 'x', fire_at: 1 }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(
      tools.reminders_snooze({ id: 'whatever', new_fire_at: 2 }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(
      tools.reminders_cancel({ id: 'whatever' }),
    ).rejects.toThrow(CapabilityDeniedError)

    // `reminders_list` still resolves — read gate is intact, no rows to return.
    const listed = await tools.reminders_list({})
    expect(listed.results).toEqual([])

    // Confirm capability_denied audit rows for the three write tools.
    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'reminders_core',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('reminders_create')).toBe(true)
    expect(labels.has('reminders_snooze')).toBe(true)
    expect(labels.has('reminders_cancel')).toBe(true)
    // `reminders_list` must NOT have a denied row.
    expect(labels.has('reminders_list')).toBe(false)
  })

  test('project isolation: reminders_cancel refuses to cancel another project\'s row', async () => {
    // Codex r1 P1 follow-up. Two instances share the same project DB
    // (per the realmode composer's instance→DB mapping); without an
    // adapter-layer ownership check the engine's id-only `cancel`
    // would happily mutate any row a caller knew the id for. The
    // adapter must read-before-write and refuse on ownership
    // mismatch.
    const ttA = makeTools('owner_a')
    const ttB = makeTools('owner_b')

    const createdByA = await ttA.reminders_create({
      message: 'a-only',
      fire_at: 1_700_000_000,
    })

    // Instance B tries to cancel instance A's reminder.
    const crossInstanceCancel = await ttB.reminders_cancel({ id: createdByA.id })
    expect(crossInstanceCancel.ok).toBe(false)

    // The row in the engine is still pending — proves the cancel was
    // refused at the adapter layer, not just silently no-op'd in the
    // engine.
    expect(store.get(createdByA.id)?.status).toBe('pending')

    // Instance A can still cancel its own row.
    const ownCancel = await ttA.reminders_cancel({ id: createdByA.id })
    expect(ownCancel.ok).toBe(true)
    expect(store.get(createdByA.id)?.status).toBe('cancelled')
  })

  test('project isolation: reminders_snooze refuses to snooze another project\'s row', async () => {
    const ttA = makeTools('owner_a')
    const ttB = makeTools('owner_b')

    const createdByA = await ttA.reminders_create({
      message: 'protected',
      fire_at: 1_700_000_000,
    })

    // Instance B tries to snooze instance A's reminder — must throw
    // (returning the existing id would also leak its existence).
    await expect(
      ttB.reminders_snooze({ id: createdByA.id, new_fire_at: 9_999_999_999 }),
    ).rejects.toThrow(/not found/)

    // The row in the engine is unchanged — adapter rejected before
    // any write happened.
    const row = store.get(createdByA.id)
    expect(row?.status).toBe('pending')
    expect(row?.fire_at).toBe(1_700_000_000)
  })

  test('snooze atomicity: cancel + create commit together via projectDb.transaction', async () => {
    // Codex r1 P2 follow-up. Snooze is documented as atomic; the
    // implementation wraps cancel + create in `projectDb.transaction`.
    // We don't have a non-invasive way to inject a `create` failure
    // mid-transaction here (the engine's create has no failure-inject
    // seam), so this test pins the OBSERVABLE atomic property: after
    // a successful snooze the original is cancelled AND the
    // replacement exists. A future test that wraps `ProjectDb` with a
    // failure-injecting proxy can drive the rollback path; the seam
    // is the public `projectDb.transaction` call which preserves the
    // BEGIN / COMMIT / ROLLBACK semantics from `persistence/db.ts`.
    const tools = makeTools()
    const original = await tools.reminders_create({
      message: 'tx-snooze',
      fire_at: 1_700_000_000,
    })

    const snoozed = await tools.reminders_snooze({
      id: original.id,
      new_fire_at: 1_800_000_000,
    })

    // Both writes happened — neither was lost.
    expect(store.get(original.id)?.status).toBe('cancelled')
    expect(store.get(snoozed.id)?.fire_at).toBe(1_800_000_000)
    expect(store.get(snoozed.id)?.status).toBe('pending')
  })

  test('capability gate: tool name not in manifest.tools[] is rejected by `tool_not_declared`', async () => {
    // Build a guard directly + assert against an undeclared tool. The
    // wrapped handlers exposed by `buildTools` use only the four tool
    // names declared in the manifest, so this verifies the underlying
    // gate behaviour for completeness.
    const m = loadManifest()
    const guard = new CapabilityGuard({
      manifest: m,
      core_slug: 'reminders_core',
      project_slug: OWNER,
      audit,
    })

    const result = guard.check({
      tool_name: 'reminders_unknown_tool',
      capability_required: 'write:reminders_core.db',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tool_not_declared')
    }
  })
})
