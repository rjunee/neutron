/**
 * PRODUCTION-WIRING regression test: Neutron's daily rhythm runs on the
 * OWNER's clock, not the HOST's.
 *
 * The bug this pins closed: `open/composer.ts` resolved the HOST's zone
 * (`resolveLocalTimezone` → `process.env.TZ` → the runtime zone) and passed it
 * as `tasks.proactive.timezone`, which `build-core-modules` handed to the
 * morning brief as `briefDeps.tz` and to the idle-nudge sweep as `sweepDeps.tz`.
 * That was the right answer when Neutron ran on the owner's own laptop — the
 * host WAS their machine — and the wrong answer the moment the same code was
 * hosted: a hosted box runs `Etc/UTC` while the owner lives in Pacific, so
 * `morning-brief.ts` `ownerLocalHour(now, tz) < brief_hour` was evaluated in UTC
 * (a 7am brief fired at midnight Pacific) and `resolveOwnerDay(now, tz)` keyed
 * the day — and the sweep's `readTodayPick` lookup — on the wrong date for the
 * ~7-8h the offset spans.
 *
 * The fix layers the seam the P6 nudge cron already uses (ISSUES #40) onto both
 * proactive crons: a PER-TICK `resolveTimezone(owner_slug)` reading
 * `instance_metadata.timezone`, which WINS over the static host-derived `tz`.
 * Per-tick matters — a fresh install has no `instance_metadata` row until the
 * first client reports its zone, so a composition-time read would freeze the
 * host's zone forever.
 *
 * These tests drive the REAL `buildCoreModules(...)` composition and fire the
 * composed cron handlers, because that wiring is the only place the bug lived.
 * Each deliberately sets the stored zone and the static host zone to DIFFERENT
 * values, so the observable outcome discriminates which one was actually used.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { buildCoreModules } from '../composition/build-core-modules.ts'
import type { CompositionInput } from '../composition.ts'
import type { ModuleContext } from '../module-graph.ts'
import {
  IDLE_NUDGE_SWEEP_HANDLER_NAME,
  MORNING_BRIEF_HANDLER_NAME,
} from '../proactive/cron.ts'
import type { OutgoingMessage } from '../proactive/sink.ts'
import { writeOwnerTimezone } from '../storage/owner-metadata.ts'

/** The owner's real zone, stored in `instance_metadata`. */
const OWNER_TZ = 'America/Los_Angeles'
/**
 * The HOST zone the composer would otherwise win with. Deliberately NOT
 * `Etc/UTC` for the brief case so the test also proves the fix is not "UTC is
 * special-cased" — any host zone must lose to the owner's stored zone.
 */
const HOST_TZ_TOKYO = 'Asia/Tokyo'
const HOST_TZ_UTC = 'Etc/UTC'

const GENERAL_TOPIC = 'app:owner-general'

/**
 * 2026-05-24 15:30 UTC. At this instant:
 *   - 'America/Los_Angeles' → 2026-05-24 08:30, day 2026-05-24  → hour 8 ≥ 7 → POST
 *   - 'Asia/Tokyo'          → 2026-05-25 00:30, day 2026-05-25  → hour 0 < 7 → too early
 * Both the POST/too-early decision AND the day key discriminate the zone.
 */
const BRIEF_NOW_UTC = Date.UTC(2026, 4, 24, 15, 30, 0)
const BRIEF_LA_DAY = '2026-05-24'
const BRIEF_TOKYO_DAY = '2026-05-25'

/**
 * 2026-05-24 07:30 UTC. At this instant:
 *   - 'America/Los_Angeles' → 2026-05-24 00:30 → hour 0 < 7 → TOO EARLY
 *   - 'Etc/UTC'             → 2026-05-24 07:30 → hour 7 ≥ 7 → would post
 * This is the live production shape: a hosted UTC box firing the "7am" brief at
 * midnight Pacific.
 */
const MIDNIGHT_PACIFIC_UTC = Date.UTC(2026, 4, 24, 7, 30, 0)

/**
 * 2026-05-24 06:30 UTC. At this instant:
 *   - 'America/Los_Angeles' → 2026-05-23 23:30, day 2026-05-23
 *   - 'Etc/UTC'             → 2026-05-24 06:30, day 2026-05-24
 * Only the owner's day matches a pick seeded for 2026-05-23, so the sweep's
 * posted/no_pick outcome discriminates the zone.
 */
const SWEEP_NOW_UTC = Date.UTC(2026, 4, 24, 6, 30, 0)
const SWEEP_LA_DAY = '2026-05-23'

interface Harness {
  db: ProjectDb
  tasks: TaskStore
  sent: OutgoingMessage[]
  close(): void
}

function openHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-proactive-tz-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  return {
    db,
    tasks: new TaskStore(db),
    sent: [],
    close: () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

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

/**
 * Compose the real modules with a `tasks.proactive` block whose static
 * `timezone` is the HOST zone, init the tasks module (which registers both
 * proactive crons), then fire one composed handler by name. `beforeFire` runs
 * AFTER init so a metadata write there proves per-tick (not composition-time)
 * resolution.
 */
async function fireComposedProactive(input: {
  h: Harness
  project_slug: string
  handler_name: string
  host_tz: string
  now_ms: number
  beforeFire?: () => Promise<void>
}): Promise<{ status: string; detail?: string }> {
  const { h, project_slug, handler_name, host_tz, now_ms } = input
  const composition = baseCompositionInput(h.db, project_slug, {
    tasks: {
      proactive: {
        timezone: host_tz,
        sink: {
          async send(m: OutgoingMessage): Promise<string> {
            h.sent.push(m)
            return 'sent-id'
          },
        },
        resolveGeneralTopic: (): string => GENERAL_TOPIC,
        listIdleTopics: () => [
          // `last_activity_ms: null` → never spoken in → treated as idle, so
          // the idle gate is not what decides this test.
          { topic_id: GENERAL_TOPIC, project_slug, last_activity_ms: null },
        ],
      },
    },
  })
  const mods = buildCoreModules(composition)
  const cron = await Promise.resolve(mods.cronModule.init({} as ModuleContext))
  const ctx: ModuleContext = {
    graph: {
      get: ((name: string) => {
        if (name === 'cron') return cron
        if (name === 'reminders') return { store: {} as never }
        // The proactive block reads 'channels' for the default router; the
        // override sink above is what actually gets used.
        return { async send(): Promise<string> { return 'router-id' } }
      }) as never,
      names: () => ['cron', 'reminders', 'channels'],
    },
    config: {},
  }
  try {
    const tasks = await Promise.resolve(mods.tasksModule.init(ctx))
    if (input.beforeFire !== undefined) await input.beforeFire()
    const handler = cron.handlers.get(handler_name)
    expect(handler).toBeDefined()
    const result = await handler!({
      job_name: `${handler_name}-${project_slug}`,
      owner_slug: project_slug,
      fired_at: now_ms,
    })
    await mods.tasksModule.shutdown?.(tasks)
    return result
  } finally {
    await mods.cronModule.shutdown?.(cron)
  }
}

/**
 * The composed brief/sweep read wall-clock `Date.now()` (the composer supplies
 * `now: () => Date.now()` and there is no test seam on the proactive block), so
 * these tests move the clock rather than injecting one.
 */
function withFrozenNow<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now
  Date.now = () => nowMs
  return fn().finally(() => {
    Date.now = realNow
  })
}

describe('the composed morning brief runs on the OWNER timezone, not the host', () => {
  let h: Harness

  beforeEach(() => {
    h = openHarness()
  })
  afterEach(() => {
    h.close()
  })

  test('stored owner zone WINS over the host zone for the hour gate + day key', async () => {
    const OWNER = 'owner-la'
    await writeOwnerTimezone(h.db, OWNER, OWNER_TZ)

    const result = await withFrozenNow(BRIEF_NOW_UTC, () =>
      fireComposedProactive({
        h,
        project_slug: OWNER,
        handler_name: MORNING_BRIEF_HANDLER_NAME,
        host_tz: HOST_TZ_TOKYO,
        now_ms: BRIEF_NOW_UTC,
      }),
    )

    // 08:30 in LA clears the 7am gate. If the host zone (Tokyo, 00:30 the NEXT
    // day) were used the brief would be `too_early` and the day would be the
    // Tokyo day — so both assertions below discriminate the zone.
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('status=posted')
    expect(result.detail).toContain(`day=${BRIEF_LA_DAY}`)
    expect(result.detail).not.toContain(`day=${BRIEF_TOKYO_DAY}`)
    expect(h.sent).toHaveLength(1)
  })

  test('the live production shape: a UTC host does NOT fire the 7am brief at midnight Pacific', async () => {
    const OWNER = 'owner-la-midnight'
    await writeOwnerTimezone(h.db, OWNER, OWNER_TZ)

    const result = await withFrozenNow(MIDNIGHT_PACIFIC_UTC, () =>
      fireComposedProactive({
        h,
        project_slug: OWNER,
        handler_name: MORNING_BRIEF_HANDLER_NAME,
        host_tz: HOST_TZ_UTC,
        now_ms: MIDNIGHT_PACIFIC_UTC,
      }),
    )

    // 07:30 UTC is 00:30 Pacific. On the host's clock the gate opens; on the
    // owner's it does not. Nothing may be sent.
    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('status=too_early')
    expect(h.sent).toHaveLength(0)
  })

  test('the zone is resolved PER TICK — a row written after boot is honoured without a restart', async () => {
    // A fresh install has no `instance_metadata` row until the first client
    // reports its zone. A composition-time read would freeze the host zone
    // forever; this proves the read happens at fire time.
    const OWNER = 'owner-late-row'

    const result = await withFrozenNow(MIDNIGHT_PACIFIC_UTC, () =>
      fireComposedProactive({
        h,
        project_slug: OWNER,
        handler_name: MORNING_BRIEF_HANDLER_NAME,
        host_tz: HOST_TZ_UTC,
        now_ms: MIDNIGHT_PACIFIC_UTC,
        // Written AFTER `tasksModule.init` has already built the deps.
        beforeFire: async () => {
          await writeOwnerTimezone(h.db, OWNER, OWNER_TZ)
        },
      }),
    )

    expect(result.detail).toContain('status=too_early')
    expect(h.sent).toHaveLength(0)
  })

  test('no stored row → falls back to the host zone (a self-hosted laptop is still right)', async () => {
    // `resolveLocalTimezone` must NOT be deleted: on a self-hosted install the
    // host IS the owner's machine. With no `instance_metadata` row the static
    // host zone is what the brief uses.
    const OWNER = 'owner-no-row'

    const result = await withFrozenNow(MIDNIGHT_PACIFIC_UTC, () =>
      fireComposedProactive({
        h,
        project_slug: OWNER,
        handler_name: MORNING_BRIEF_HANDLER_NAME,
        host_tz: HOST_TZ_UTC,
        now_ms: MIDNIGHT_PACIFIC_UTC,
      }),
    )

    // 07:30 on the host clock clears the 7am gate.
    expect(result.status).toBe('ok')
    expect(result.detail).toContain('status=posted')
    expect(result.detail).toContain('day=2026-05-24')
  })
})

describe('the composed idle-nudge sweep keys its day on the OWNER timezone', () => {
  let h: Harness

  beforeEach(() => {
    h = openHarness()
  })
  afterEach(() => {
    h.close()
  })

  test("the ranker pick for the owner's day is FOUND (the host's day would miss it)", async () => {
    const OWNER = 'owner-sweep-la'
    await writeOwnerTimezone(h.db, OWNER, OWNER_TZ)

    const task = await h.tasks.create({
      project_slug: OWNER,
      title: 'Ship the owner-clock fix',
    })
    await h.db.run(
      `INSERT INTO current_focus_pick
         (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at, llm_model, llm_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        OWNER,
        // Seeded for the OWNER's day. At `SWEEP_NOW_UTC` the host (UTC) is
        // already on 2026-05-24, so a host-keyed lookup returns `no_pick`.
        SWEEP_LA_DAY,
        task.id,
        'Highest leverage right now.',
        JSON.stringify([task.id]),
        new Date(SWEEP_NOW_UTC).toISOString(),
        'claude-haiku-4-5',
      ],
    )

    const result = await withFrozenNow(SWEEP_NOW_UTC, () =>
      fireComposedProactive({
        h,
        project_slug: OWNER,
        handler_name: IDLE_NUDGE_SWEEP_HANDLER_NAME,
        host_tz: HOST_TZ_UTC,
        now_ms: SWEEP_NOW_UTC,
      }),
    )

    expect(result.status).toBe('ok')
    expect(result.detail).toContain('posted=1')
    // The specific failure mode a host-keyed day produces.
    expect(result.detail).toContain('no_pick=0')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.text).toContain('Ship the owner-clock fix')
  })
})
