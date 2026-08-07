/**
 * Plan task 8 — the reminders-Core `rituals_propose` / `rituals_status` MCP tool
 * surface. Asserts the capability-guarded handlers dispatch the backend methods
 * (audit 'ok'), and that an UNWIRED ritual service surfaces
 * `RitualsUnavailableError` through the guard's error path (fail closed).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import { SecretAuditLog } from '@neutronai/cores-runtime'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import {
  RitualsUnavailableError,
  buildExtraTools,
  buildReminderStoreBackend,
  loadManifest,
  type RemindersRitualService,
  type RitualEnableInput,
  type RitualProposeInput,
} from '../index.ts'

const OWNER = 't1'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'reminders-rituals-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

function stubService(): RemindersRitualService & {
  propose: ReturnType<typeof spyOn>
  enable: ReturnType<typeof spyOn>
  reapprove: ReturnType<typeof spyOn>
  status: ReturnType<typeof spyOn>
} {
  const obj = {
    propose: async (_input: RitualProposeInput) => ({
      proposal_id: 'p1',
      ritual_id: 'daily-digest',
      status: 'pending_approval',
      requires_egress_approval: false,
    }),
    enable: async (_input: RitualEnableInput) => ({
      proposal_id: 'e1',
      ritual_id: 'morning-brief',
      status: 'pending_approval',
      requires_egress_approval: false,
    }),
    reapprove: async (_id: string) => ({
      proposal_id: 'r1',
      ritual_id: 'kaizen',
      status: 'pending_approval',
      requires_egress_approval: true,
    }),
    status: () => [
      {
        ritual_id: 'daily-digest',
        description: 'x',
        scope: 'instance',
        tool_surface: ['Read'],
        egress: 'none',
        approval: 'pending',
        scheduled: false,
      },
    ],
  }
  const proposeSpy = spyOn(obj, 'propose')
  const enableSpy = spyOn(obj, 'enable')
  const reapproveSpy = spyOn(obj, 'reapprove')
  const statusSpy = spyOn(obj, 'status')
  return Object.assign(obj, {
    propose: proposeSpy,
    enable: enableSpy,
    reapprove: reapproveSpy,
    status: statusSpy,
  }) as never
}

const ENABLE: RitualEnableInput = {
  id: 'morning-brief',
  schedule: { fire_at: 1_900_000_000, recurrence_spec: '0 8 * * *' },
}

const PROPOSAL: RitualProposeInput = {
  id: 'daily-digest',
  description: 'summarise the day',
  scope: 'instance',
  tool_surface: ['Read', 'Glob', 'Grep'],
  egress: 'none',
  silent: false,
  prompt: 'read STATUS.md',
  schedule: { fire_at: 1_900_000_000, recurrence_spec: '0 9 * * *' },
}

describe('rituals_propose / rituals_status — wired', () => {
  test('rituals_propose dispatches backend.proposeRitual with audit ok', async () => {
    const svc = stubService()
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => svc })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })

    const res = await extras.rituals_propose(PROPOSAL)
    expect(svc.propose).toHaveBeenCalledTimes(1)
    expect(res.status).toBe('pending_approval')
    expect(res.ritual_id).toBe('daily-digest')
    // guard recorded a tool_call outcome=ok (no denial)
    const denied = await audit.listDenied({ owner_slug: OWNER, core_slug: 'reminders_core' })
    expect(denied.map((r) => r.label)).not.toContain('rituals_propose')
  })

  test('rituals_enable dispatches backend.enableRitual with audit ok', async () => {
    const svc = stubService()
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => svc })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })

    const res = await extras.rituals_enable(ENABLE)
    expect(svc.enable).toHaveBeenCalledTimes(1)
    expect(res.status).toBe('pending_approval')
    expect(res.ritual_id).toBe('morning-brief')
    const denied = await audit.listDenied({ owner_slug: OWNER, core_slug: 'reminders_core' })
    expect(denied.map((r) => r.label)).not.toContain('rituals_enable')
  })

  test('rituals_status dispatches backend.ritualsStatus', async () => {
    const svc = stubService()
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => svc })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })

    const res = await extras.rituals_status({})
    expect(svc.status).toHaveBeenCalledTimes(1)
    expect(res.results).toHaveLength(1)
    expect(res.results[0]!.ritual_id).toBe('daily-digest')
  })
})

describe('rituals_propose / rituals_status — UNWIRED (fail closed)', () => {
  test('no ritual service → RitualsUnavailableError surfaces through the guard', async () => {
    // no `rituals` getter → backend.proposeRitual throws RitualsUnavailableError
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })
    await expect(extras.rituals_propose(PROPOSAL)).rejects.toThrow(RitualsUnavailableError)
    await expect(extras.rituals_enable(ENABLE)).rejects.toThrow(RitualsUnavailableError)
    await expect(extras.rituals_status({})).rejects.toThrow(RitualsUnavailableError)
  })

  test('a getter returning null also fails closed', async () => {
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => null })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })
    await expect(extras.rituals_propose(PROPOSAL)).rejects.toThrow(RitualsUnavailableError)
  })
})

/**
 * #510 — `rituals_reapprove`, the way BACK to a pending approval.
 *
 * The boot sweep deliberately leaves a `pending` grant alone, on the stated ground
 * that "the prompt is already in front of him". That holds for about as long as it
 * takes the chat to scroll. `kaizen`'s two grants were raised 2026-08-03, never
 * answered, and the ritual has never once fired — `rituals_status` could SAY
 * "pending", but the only tappable buttons were in a four-day-old message.
 *
 * So the property under test is not "a method dispatches" but "there is a reachable
 * way to re-raise the prompt, and it does not decide anything on the owner's
 * behalf".
 */
describe('rituals_reapprove — the way back to a pending approval', () => {
  test('dispatches backend.reapproveRitual with the ritual id', async () => {
    const svc = stubService()
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => svc })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })

    const res = await extras.rituals_reapprove({ id: 'kaizen' })

    expect(svc.reapprove).toHaveBeenCalledTimes(1)
    expect(svc.reapprove.mock.calls[0]?.[0]).toBe('kaizen')
    expect(res.ritual_id).toBe('kaizen')
  })

  test('returns pending_approval — re-raising NEVER approves anything', async () => {
    // The whole point of the grant is that the owner decides. A re-raise that
    // returned an approved status would be the #510 false-completion shape again,
    // this time generated by code rather than written by an agent.
    const svc = stubService()
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => svc })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })

    const res = await extras.rituals_reapprove({ id: 'kaizen' })
    expect(res.status).toBe('pending_approval')
  })

  test('surfaces the egress grant so a two-grant ritual is not reported half-done', async () => {
    // kaizen needs TWO approvals (content + web egress). Reporting only the content
    // grant is how "kaizen is approved" gets said while egress is still pending.
    const svc = stubService()
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => svc })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })

    const res = await extras.rituals_reapprove({ id: 'kaizen' })
    expect(res.requires_egress_approval).toBe(true)
  })

  test('an UNWIRED ritual service fails closed through the guard', async () => {
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => null })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })

    await expect(extras.rituals_reapprove({ id: 'kaizen' })).rejects.toBeInstanceOf(
      RitualsUnavailableError,
    )
  })

  test('the tool is declared in the manifest — install hard-fails otherwise', async () => {
    // The manifest tools[], TOOL_NAMES and the buildExtraTools handlers must stay in
    // lockstep or `install-bundled.ts` rejects the Core with `manifest_incomplete`.
    // A handler nobody declared is a tool no agent can call.
    const manifest = loadManifest()
    const names = (manifest as unknown as { tools: ReadonlyArray<{ name: string }> }).tools.map(
      (t) => t.name,
    )
    expect(names).toContain('rituals_reapprove')
  })
})
