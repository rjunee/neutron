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
  status: ReturnType<typeof spyOn>
} {
  const obj = {
    propose: async (_input: RitualProposeInput) => ({
      proposal_id: 'p1',
      ritual_id: 'daily-digest',
      status: 'pending_approval',
      requires_egress_approval: false,
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
  const statusSpy = spyOn(obj, 'status')
  return Object.assign(obj, { propose: proposeSpy, status: statusSpy }) as never
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
    await expect(extras.rituals_status({})).rejects.toThrow(RitualsUnavailableError)
  })

  test('a getter returning null also fails closed', async () => {
    const backend = buildReminderStoreBackend({ project_slug: OWNER, projectDb, rituals: () => null })
    const extras = buildExtraTools({ manifest: loadManifest(), project_slug: OWNER, audit, backend })
    await expect(extras.rituals_propose(PROPOSAL)).rejects.toThrow(RitualsUnavailableError)
  })
})
