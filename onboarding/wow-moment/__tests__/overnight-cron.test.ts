/**
 * `wow_overnight_handler` — the production cron handler behind action
 * 07's `wow-overnight-<internal_handle>` job (2026-06-10
 * wow-hang-resilience sprint; prod incident t-33333333: the job was
 * registered but the handler never was, so every scheduler tick logged
 * "skipping job … handler wow_overnight_handler not registered").
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { CronHandlerRegistry, type CronHandlerContext } from '../../../cron/handlers.ts'
import {
  WOW_OVERNIGHT_HANDLER_NAME,
  buildWowOvernightHandler,
  composeMorningCheckin,
  registerWowOvernightHandler,
} from '../overnight-cron.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wow-overnight-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const CTX: CronHandlerContext = {
  job_name: 'wow-overnight-t-casey-0001',
  project_slug: 't-casey-0001',
  fired_at: 1_700_000_000_000,
}

function seedCompletedRow(phase_state: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO onboarding_state
       (project_slug, user_id, phase, phase_state_json, started_at, last_advanced_at, completed_at, wow_fired)
     VALUES ('casey', 'u-1', 'completed', ?, 1, 2, 3, 1)`,
  ).run(JSON.stringify(phase_state))
}

describe('wow_overnight_handler', () => {
  test('delivers the morning check-in to the onboarding topic when a session is live', async () => {
    seedCompletedRow({
      topic_id: 'web:u-1',
      primary_projects_confirmed: ['Topline', 'Acme', 'Neutron'],
    })
    const delivered: Array<{ topic_id: string; body: string }> = []
    const handler = buildWowOvernightHandler({
      db,
      deliver: (input) => {
        delivered.push(input)
        return true
      },
    })
    const result = await handler(CTX)
    expect(result.status).toBe('ok')
    expect(delivered.length).toBe(1)
    expect(delivered[0]!.topic_id).toBe('web:u-1')
    expect(delivered[0]!.body).toContain('Morning')
    expect(delivered[0]!.body).toContain('Topline')
    expect(delivered[0]!.body).toContain('Neutron')
  })

  test('no active session → skipped (interval job retries tomorrow), never error', async () => {
    seedCompletedRow({ topic_id: 'web:u-1', primary_projects_confirmed: ['Topline'] })
    const handler = buildWowOvernightHandler({ db, deliver: () => false })
    const result = await handler(CTX)
    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('no active session')
  })

  test('no completed onboarding row → skipped with explanatory detail', async () => {
    const handler = buildWowOvernightHandler({ db, deliver: () => true })
    const result = await handler(CTX)
    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('no completed onboarding row')
  })

  test('no deliver surface wired → skipped (registration-only mode)', async () => {
    seedCompletedRow({ topic_id: 'web:u-1' })
    const handler = buildWowOvernightHandler({ db })
    const result = await handler(CTX)
    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('no deliver surface')
  })

  test('a throwing deliver surface is converted to status error — the handler NEVER throws', async () => {
    seedCompletedRow({ topic_id: 'web:u-1' })
    const handler = buildWowOvernightHandler({
      db,
      deliver: () => {
        throw new Error('WS registry exploded')
      },
    })
    const result = await handler(CTX)
    expect(result.status).toBe('error')
    expect(result.detail).toContain('WS registry exploded')
  })

  test('registerWowOvernightHandler is idempotent on repeat calls', () => {
    const handlers = new CronHandlerRegistry()
    const handler = buildWowOvernightHandler({ db })
    registerWowOvernightHandler({ handlers, handler })
    // Second call must not throw (CronHandlerRegistry.register throws on
    // duplicates; the helper guards).
    registerWowOvernightHandler({ handlers, handler })
    expect(handlers.get(WOW_OVERNIGHT_HANDLER_NAME)).toBeDefined()
  })

  test('composeMorningCheckin is honest — surfaces stored projects, claims no analysis', () => {
    const body = composeMorningCheckin({
      primary_projects_confirmed: ['Topline', 'Acme'],
    })
    expect(body).toContain('Projects on deck (2):')
    expect(body).toContain('- Topline')
    // It must NOT fabricate background-analysis claims — the overnight
    // work pipeline is future work.
    expect(body.toLowerCase()).not.toContain('analysis')
    expect(body.toLowerCase()).not.toContain('i reviewed')
    // Zero-project shape stays coherent.
    const empty = composeMorningCheckin({})
    expect(empty).toContain('Morning')
    expect(empty).not.toContain('Projects on deck')
  })
})
