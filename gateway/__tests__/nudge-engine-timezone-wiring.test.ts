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
  persistOwnerTimezoneIfChanged,
  readOwnerTimezone,
  writeOwnerTimezone,
} from '../storage/owner-metadata.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { buildCoreModules } from '../composition/build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'

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

/**
 * Precedence boundary tests for the `resolveTimezone` seam
 * (`buildNudgeEngineHandler` deps). The contract:
 *   1. A `resolveTimezone()` result that is NOT undefined WINS over the static
 *      `timezone` field (per-tick resolution beats an init-time capture).
 *   2. When `resolveTimezone()` returns undefined, the pass falls back to the
 *      static `timezone`.
 *   3. When neither yields a zone, the pass uses `DEFAULT_OWNER_TIMEZONE`.
 * These drive `buildNudgeEngineHandler` directly (no composition) so a future
 * refactor that reverses the precedence or drops the static fallback trips
 * here even if the composition-level tests are untouched.
 */
describe('buildNudgeEngineHandler resolveTimezone precedence', () => {
  let h: Harness

  beforeEach(async () => {
    h = await openHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  async function fireHandler(
    OWNER: string,
    deps: {
      timezone?: string
      resolveTimezone?: () => string | undefined
    },
  ): Promise<string> {
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'focus',
      priority: 3,
    })
    const handlerDeps: Parameters<typeof buildNudgeEngineHandler>[0] = {
      db: h.db,
      llm: constLlm(t1.id),
      now: () => CROSSOVER_NOW_UTC,
    }
    if (deps.timezone !== undefined) handlerDeps.timezone = deps.timezone
    if (deps.resolveTimezone !== undefined) {
      handlerDeps.resolveTimezone = deps.resolveTimezone
    }
    const handler = buildNudgeEngineHandler(handlerDeps)
    const result = await handler({
      job_name: `tasks-nudge-${OWNER}`,
      owner_slug: OWNER,
      fired_at: CROSSOVER_NOW_UTC,
    })
    expect(result.status).toBe('ok')
    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    return pick!.day
  }

  test('resolveTimezone (NYC) WINS over a static timezone (LA)', async () => {
    // Static says LA (2026-05-23); the resolver says NYC (2026-05-24). The
    // resolver must win. Reversing precedence would persist the LA day.
    const day = await fireHandler('t-prec-resolver-wins', {
      timezone: 'America/Los_Angeles',
      resolveTimezone: () => 'America/New_York',
    })
    expect(day).toBe('2026-05-24')
    expect(day).toBe(resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/New_York'))
  })

  test('resolveTimezone → undefined falls back to the static timezone (NYC)', async () => {
    // Resolver yields nothing (e.g. no instance_metadata row); the static
    // timezone (NYC) must be honored, not silently dropped to the LA default.
    const day = await fireHandler('t-prec-static-fallback', {
      timezone: 'America/New_York',
      resolveTimezone: () => undefined,
    })
    expect(day).toBe('2026-05-24')
    expect(day).toBe(resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/New_York'))
  })

  test('resolveTimezone → undefined and NO static → DEFAULT_OWNER_TIMEZONE (LA)', async () => {
    const day = await fireHandler('t-prec-default', {
      resolveTimezone: () => undefined,
    })
    expect(day).toBe('2026-05-23')
    expect(day).toBe(resolveOwnerDay(CROSSOVER_NOW_UTC, DEFAULT_OWNER_TIMEZONE))
  })
})

/**
 * PRODUCTION-WIRING mutation-kill. Unlike the block above (which re-implements
 * the `readOwnerTimezone(...) ?? DEFAULT` resolution inline to document the
 * contract), this drives the REAL `buildCoreModules(...)` composition — the
 * only place ISSUES #40 is actually closed. It fires the composed
 * `tasks.nudge_engine` cron handler for a NYC-zoned instance and asserts the
 * persisted `current_focus_pick.day` is the NYC day, not the LA default.
 *
 * This turns RED if the composer:
 *   - drops the `readOwnerTimezone(input.db, input.project_slug)` read, OR
 *   - stops threading the resolved zone into `nudge_engine.timezone`,
 * because the handler would then fall back to `DEFAULT_OWNER_TIMEZONE` (LA)
 * and persist '2026-05-23' instead of the seeded NYC '2026-05-24'.
 */
function baseCompositionInput(
  db: ProjectDb,
  project_slug: string,
  overrides: Partial<CompositionInput> = {},
): CompositionInput {
  return {
    db,
    project_slug,
    topic_handler: async () => {},
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
    platform: STUB_PLATFORM,
    ...overrides,
  }
}

describe('build-core-modules composes instance_metadata.timezone into the nudge cron', () => {
  let h: Harness

  beforeEach(async () => {
    h = await openHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  /**
   * Compose the real modules, init the tasks module (which registers the
   * nudge cron), run an optional `beforeFire` hook (used to mutate
   * instance_metadata AFTER init — proving per-tick resolution), then fire
   * the composed `tasks.nudge_engine` handler at the crossover instant.
   */
  async function fireComposedNudge(
    project_slug: string,
    llmTaskId: string,
    beforeFire?: () => Promise<void>,
  ): Promise<void> {
    const input = baseCompositionInput(h.db, project_slug, {
      tasks: {
        enable_nudge_engine_cron: true,
        nudge_engine: {
          llm: constLlm(llmTaskId),
          now: () => CROSSOVER_NOW_UTC,
        },
      },
    })
    const mods = buildCoreModules(input)
    // The nudge cron registers into the shared cron registries during
    // `tasksModule.init`, which reads 'cron' + 'reminders' off the graph.
    const cron = await Promise.resolve(mods.cronModule.init({} as ModuleContext))
    const remindersStub = { store: {} as never }
    const ctx: ModuleContext = {
      graph: {
        get: ((name: string) =>
          name === 'cron' ? cron : remindersStub) as never,
        names: () => ['cron', 'reminders'],
      },
      config: {},
    }
    try {
      const tasks = await Promise.resolve(mods.tasksModule.init(ctx))
      // Runs AFTER init — a metadata write here must still be honored by the
      // per-tick resolver, not shadowed by an init-time capture.
      if (beforeFire !== undefined) await beforeFire()
      const handler = cron.handlers.get(NUDGE_ENGINE_HANDLER_NAME)
      expect(handler).toBeDefined()
      const result = await handler!({
        job_name: `tasks-nudge-${project_slug}`,
        owner_slug: project_slug,
        fired_at: CROSSOVER_NOW_UTC,
      })
      expect(result.status).toBe('ok')
      await mods.tasksModule.shutdown?.(tasks)
    } finally {
      await mods.cronModule.shutdown?.(cron)
    }
  }

  test('NYC stored zone → composed cron persists the NYC day', async () => {
    const OWNER = 't-nyc-e2e'
    await writeOwnerTimezone(h.db, OWNER, 'America/New_York')
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'NYC focus',
      priority: 3,
    })

    await fireComposedNudge(OWNER, t1.id)

    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    // NYC day at the crossover instant is 2026-05-24. If the composer drops
    // the readOwnerTimezone wiring the handler defaults to LA and persists
    // '2026-05-23' — flipping this assertion red.
    expect(pick!.day).toBe('2026-05-24')
    expect(pick!.day).toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/New_York'),
    )
    expect(pick!.day).not.toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, DEFAULT_OWNER_TIMEZONE),
    )
  })

  test('ISSUES #40 WRITE-PATH round-trip: a client-reported NYC zone persists → composed cron keys the NYC day (not LA)', async () => {
    // The FULL loop this unit closes: the app-ws surface receives the client's
    // reported IANA zone on connect and calls `persistOwnerTimezoneIfChanged`
    // (the SAME server chokepoint the `on_client_timezone` hook binds). That
    // write is what the #378 read (`readOwnerTimezone`, wired into the composer)
    // consumes — so a non-LA owner's daily nudge keys on THEIR local day.
    const OWNER = 't-client-roundtrip'
    // 1) Client sends "America/New_York" → validated + persisted.
    expect(await persistOwnerTimezoneIfChanged(h.db, OWNER, 'America/New_York')).toBe(
      'written',
    )
    // 2) The nudge cron's read now resolves the owner's actual zone.
    expect(readOwnerTimezone(h.db, OWNER)).toBe('America/New_York')

    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'NYC focus',
      priority: 3,
    })
    // 3) The REAL composed cron keys the pick on the NYC day, not the LA default.
    await fireComposedNudge(OWNER, t1.id)

    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    expect(pick!.day).toBe('2026-05-24')
    expect(pick!.day).toBe(resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/New_York'))
    // Discriminator: had the write path been a no-op (LA default), this would be
    // '2026-05-23'.
    expect(pick!.day).not.toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, DEFAULT_OWNER_TIMEZONE),
    )
  })

  test('timezone written AFTER module init still takes effect on the next tick (per-invocation resolution)', async () => {
    const OWNER = 't-mutable-e2e'
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'Mutable focus',
      priority: 3,
    })

    // No metadata row at init time. The NYC zone is written only AFTER the
    // tasks module (and its nudge handler) has been composed. If the composer
    // captured the zone at init (returning null → LA), the pick would key on
    // the LA day 2026-05-23. The per-tick resolver reads instance_metadata at
    // invocation, so it MUST see NYC and persist 2026-05-24.
    await fireComposedNudge(OWNER, t1.id, async () => {
      await writeOwnerTimezone(h.db, OWNER, 'America/New_York')
    })

    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    expect(pick!.day).toBe('2026-05-24')
    expect(pick!.day).toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/New_York'),
    )
    expect(pick!.day).not.toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, DEFAULT_OWNER_TIMEZONE),
    )
  })

  test('no metadata row → composed cron falls back to LA default (no regression)', async () => {
    const OWNER = 't-no-row-e2e'
    // Deliberately do NOT write instance_metadata — the composer's
    // readOwnerTimezone returns null and the handler keeps DEFAULT (LA).
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'Legacy focus',
      priority: 3,
    })

    await fireComposedNudge(OWNER, t1.id)

    const pick = readPick(h.db, OWNER)
    expect(pick).not.toBeNull()
    // LA day at the crossover instant is 2026-05-23.
    expect(pick!.day).toBe('2026-05-23')
    expect(pick!.day).toBe(
      resolveOwnerDay(CROSSOVER_NOW_UTC, DEFAULT_OWNER_TIMEZONE),
    )
  })

  test('hosted first-handler-wins: the shared handler keys the zone on the DISPATCHED owner, not the composed one', async () => {
    // Mirror the hosted piggy-back model (`registerNudgeEngineCron`): ONE
    // composed handler — registered by instance A (NYC) — services every
    // instance's tick via `ctx.owner_slug`. We fire that A-composed handler
    // for a DIFFERENT owner B (LA), sharing A's db. The pass must resolve B's
    // OWN zone (LA → 2026-05-23), not the composed owner A's NYC zone.
    //
    // Before the owner_slug fix the resolver closed over the composed
    // `input.project_slug` (A/NYC), so B's tick keyed on NYC and persisted
    // 2026-05-24 — this assertion goes red under that regression.
    const A = 'owner-a'
    const B = 'owner-b'
    await writeOwnerTimezone(h.db, A, 'America/New_York')
    await writeOwnerTimezone(h.db, B, 'America/Los_Angeles')
    // Only B needs a task + a matching LLM pick — we assert on B's persisted
    // day. The stub returns B's task id so B's pass lands a pick row.
    const tb = await h.tasks.create({ project_slug: B, title: 'B', priority: 3 })

    const input = baseCompositionInput(h.db, A, {
      tasks: {
        enable_nudge_engine_cron: true,
        nudge_engine: {
          llm: async () => JSON.stringify({ task_id: tb.id, rationale: 'r' }),
          now: () => CROSSOVER_NOW_UTC,
        },
      },
    })
    const mods = buildCoreModules(input)
    const cron = await Promise.resolve(mods.cronModule.init({} as ModuleContext))
    const ctx: ModuleContext = {
      graph: {
        get: ((name: string) =>
          name === 'cron' ? cron : { store: {} as never }) as never,
        names: () => ['cron', 'reminders'],
      },
      config: {},
    }
    try {
      const tasks = await Promise.resolve(mods.tasksModule.init(ctx))
      const handler = cron.handlers.get(NUDGE_ENGINE_HANDLER_NAME)
      expect(handler).toBeDefined()

      // Fire the A-composed handler for owner B.
      const rb = await handler!({
        job_name: `tasks-nudge-${B}`,
        owner_slug: B,
        fired_at: CROSSOVER_NOW_UTC,
      })
      expect(rb.status).toBe('ok')

      const pickB = readPick(h.db, B)
      expect(pickB).not.toBeNull()
      // LA day — proves B's tick resolved B's own zone, not A's NYC.
      expect(pickB!.day).toBe('2026-05-23')
      expect(pickB!.day).toBe(
        resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/Los_Angeles'),
      )
      expect(pickB!.day).not.toBe(
        resolveOwnerDay(CROSSOVER_NOW_UTC, 'America/New_York'),
      )
      await mods.tasksModule.shutdown?.(tasks)
    } finally {
      await mods.cronModule.shutdown?.(cron)
    }
  })
})
