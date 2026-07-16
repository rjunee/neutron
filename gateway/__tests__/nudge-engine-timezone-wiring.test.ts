/**
 * Production-wiring regression test for ISSUES #40 — the P6.1 nudge engine
 * MUST read `instance_metadata.timezone` and thread it through to
 * `runNudgePass` so a non-LA owner's `current_focus_pick.day` is keyed on
 * the owner's local wall clock, not the hardcoded
 * `DEFAULT_OWNER_TIMEZONE`.
 *
 * Closing condition: a future refactor that drops the
 * `ownerTimezone = readOwnerTimezone(db, project_slug) ?? DEFAULT_…` line
 * from `gateway/index.ts` boot OR drops the `timezone: ownerTimezone`
 * field from the `nudge_engine` block fails this test by persisting the
 * LA-keyed day instead of the seeded NYC day.
 *
 * Why this lives at `gateway/__tests__/` instead of inside `tasks/p6/`:
 * the unit-level `nudge-engine.test.ts` already covers `runNudgePass(...,
 * timezone)`. THIS test exists to nail down the boot-wiring path that
 * couples `instance_metadata` → `buildNudgeEngineHandler({ timezone })` →
 * `runNudgePass({ timezone })`. Mirrors the production-composer
 * reachability tests in this directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import {
  buildNudgeEngineHandler,
  DEFAULT_OWNER_TIMEZONE,
  NUDGE_ENGINE_HANDLER_NAME,
  resolveOwnerDay,
} from '../tasks/p6/nudge-engine.ts'
import {
  readOwnerTimezone,
  writeOwnerTimezone,
} from '../storage/owner-metadata.ts'

interface Harness {
  db: ProjectDb
  tasks: TaskStore
  close(): Promise<void>
}

async function openHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-nudge-tz-wiring-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const tasks = new TaskStore(db)
  return {
    db,
    tasks,
    close: async () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

interface PickRow {
  day: string
  task_id: string
}

function readPick(db: ProjectDb, project_slug: string): PickRow | null {
  const row = db
    .prepare<PickRow, [string]>(
      `SELECT day, task_id FROM current_focus_pick WHERE project_slug = ? LIMIT 1`,
    )
    .get(project_slug)
  return row ?? null
}

function constLlm(task_id: string, rationale = 'pick rationale'): LlmCallFn {
  return async () => JSON.stringify({ task_id, rationale })
}

/**
 * 2026-05-23 07:30 UTC. At this instant:
 *   - 'America/Los_Angeles' → 2026-05-23 00:30 → day 2026-05-23
 *   - 'America/New_York'    → 2026-05-23 03:30 → day 2026-05-23
 * The post-midnight LA day matches NYC's day here, so they agree. Use
 * the crossover instant below to distinguish.
 */

/**
 * 2026-05-24 03:30 UTC. At this instant:
 *   - 'America/Los_Angeles' → 2026-05-23 20:30 → day 2026-05-23
 *   - 'America/New_York'    → 2026-05-23 23:30 → day 2026-05-23
 * Days still agree. We need a UTC instant where ONLY NYC has rolled
 * over to the next day.
 */

/**
 * 2026-05-24 06:30 UTC. At this instant:
 *   - 'America/Los_Angeles' → 2026-05-23 23:30 → day 2026-05-23
 *   - 'America/New_York'    → 2026-05-24 02:30 → day 2026-05-24
 * NYC has rolled over but LA hasn't. The persisted `day` discriminates
 * which tz the engine actually used.
 */
const CROSSOVER_NOW_UTC = Date.UTC(2026, 4, 24, 6, 30, 0)

describe('readOwnerTimezone', () => {
  let h: Harness

  beforeEach(async () => {
    h = await openHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  test('returns null when no instance_metadata row exists', () => {
    expect(readOwnerTimezone(h.db, 't-nyc')).toBeNull()
  })

  test('returns the timezone string when present', async () => {
    await writeOwnerTimezone(h.db, 't-nyc', 'America/New_York')
    expect(readOwnerTimezone(h.db, 't-nyc')).toBe('America/New_York')
  })

  test('returns null when row exists but timezone column is NULL', async () => {
    await h.db.run(
      `INSERT INTO instance_metadata (instance_slug, timezone) VALUES (?, NULL)`,
      ['t-nyc'],
    )
    expect(readOwnerTimezone(h.db, 't-nyc')).toBeNull()
  })
})

describe('nudge engine wiring threads instance_metadata.timezone end-to-end', () => {
  let h: Harness

  beforeEach(async () => {
    h = await openHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  test('non-LA project: NYC tz flows through to current_focus_pick.day', async () => {
    const OWNER = 't-nyc'
    await writeOwnerTimezone(h.db, OWNER, 'America/New_York')
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'NYC focus',
      priority: 3,
    })

    // The production boot resolves `ownerTimezone` once and threads it
    // into `nudge_engine.timezone`. Mirror that exact sequence so a future
    // refactor of either step (the read OR the wiring) trips this test.
    const ownerTimezone =
      readOwnerTimezone(h.db, OWNER) ?? DEFAULT_OWNER_TIMEZONE
    expect(ownerTimezone).toBe('America/New_York')

    const handler = buildNudgeEngineHandler({
      db: h.db,
      llm: constLlm(t1.id),
      now: () => CROSSOVER_NOW_UTC,
      timezone: ownerTimezone,
    })

    const result = await handler({
      job_name: 'tasks-nudge-t-nyc',
      owner_slug: OWNER,
      fired_at: CROSSOVER_NOW_UTC,
    })
    expect(result.status).toBe('ok')

    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    // NYC day at the crossover instant is 2026-05-24. If the wiring drops
    // the `timezone` field the engine falls back to DEFAULT_OWNER_TIMEZONE
    // (LA) and persists '2026-05-23' here — flipping this assertion red.
    expect(pick!.day).toBe('2026-05-24')
    expect(pick!.day).toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/New_York'),
    )
  })

  test('LA project: LA tz still flows through (no regression)', async () => {
    const OWNER = 't-la'
    await writeOwnerTimezone(h.db, OWNER, 'America/Los_Angeles')
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'LA focus',
      priority: 3,
    })

    const ownerTimezone =
      readOwnerTimezone(h.db, OWNER) ?? DEFAULT_OWNER_TIMEZONE
    expect(ownerTimezone).toBe('America/Los_Angeles')

    const handler = buildNudgeEngineHandler({
      db: h.db,
      llm: constLlm(t1.id),
      now: () => CROSSOVER_NOW_UTC,
      timezone: ownerTimezone,
    })

    const result = await handler({
      job_name: 'tasks-nudge-t-la',
      owner_slug: OWNER,
      fired_at: CROSSOVER_NOW_UTC,
    })
    expect(result.status).toBe('ok')

    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    expect(pick!.day).toBe('2026-05-23')
    expect(pick!.day).toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/Los_Angeles'),
    )
  })

  test('instance without metadata row → DEFAULT_OWNER_TIMEZONE (LA)', async () => {
    const OWNER = 't-no-row'
    // Deliberately do NOT seed instance_metadata. The boot wiring must
    // fall back to `DEFAULT_OWNER_TIMEZONE` so legacy instances
    // provisioned before migration 0050 keep working.
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'Legacy focus',
      priority: 3,
    })

    const ownerTimezone =
      readOwnerTimezone(h.db, OWNER) ?? DEFAULT_OWNER_TIMEZONE
    expect(ownerTimezone).toBe(DEFAULT_OWNER_TIMEZONE)
    expect(ownerTimezone).toBe('America/Los_Angeles')

    const handler = buildNudgeEngineHandler({
      db: h.db,
      llm: constLlm(t1.id),
      now: () => CROSSOVER_NOW_UTC,
      timezone: ownerTimezone,
    })

    const result = await handler({
      job_name: 'tasks-nudge-t-no-row',
      owner_slug: OWNER,
      fired_at: CROSSOVER_NOW_UTC,
    })
    expect(result.status).toBe('ok')

    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    // LA day at crossover instant — verifies the legacy default path.
    expect(pick!.day).toBe('2026-05-23')
  })

  test('handler name is stable (sanity guard against rename drift)', () => {
    expect(NUDGE_ENGINE_HANDLER_NAME).toBe('tasks.nudge_engine')
  })
})
