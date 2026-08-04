/**
 * @neutronai/reminders — bounded transient RECOVERY on the ritual background
 * path (ISSUES #489).
 *
 * The two scenarios at the top of the end-to-end block are the ORIGINAL
 * reproductions, kept as regressions and inverted: each one asserted the loss
 * before the fix and asserts the recovery after it. They matter because the two
 * failure surfaces had OPPOSITE bugs, and a fix for either alone reads like a fix
 * for both:
 *
 *   • a transient failure of the SETTLED TURN ran exactly once, recorded one
 *     `failed` row, posted a failure notice, and the brief never happened;
 *   • a transient failure during fire STARTUP re-fired on EVERY tick forever and
 *     left zero rows and zero notices behind it.
 *
 * Nothing here measures elapsed time. Every clock is injected and every backoff
 * assertion compares two logical instants, so the ISSUES #438 wall-clock lint has
 * nothing to catch and these tests cannot rot into machine-speed measurements.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SubstrateCallError } from '@neutronai/runtime/errors.ts'
import { SubagentRegistry } from '@neutronai/runtime/subagent/registry.ts'
import { ApprovalManager, type ApprovalNotifier } from '@neutronai/tools/approval.ts'

import { ReminderStore, type Reminder } from './store.ts'
import { ReminderTickLoop, type ReminderDispatcher } from './tick.ts'
import { createRitualRegistry, type RitualDef, type RitualRegistry } from './rituals.ts'
import { createRitualRunStore, type RitualRunStore } from './ritual-runs.ts'
import { collapseAttemptsToOccurrences } from './ritual-delivery.ts'
import type { ReminderOutbound, ReminderOutboundInput } from './dispatcher.ts'
import {
  createRitualExecutor,
  type RitualExecutorDeps,
  type RitualTurn,
  type RitualTurnResult,
} from './ritual-executor.ts'
import {
  RITUAL_MAX_ATTEMPTS,
  RITUAL_RETRY_BASE_DELAY_MS,
  RITUAL_RETRY_MAX_DELAY_MS,
  RitualAttemptLedger,
  RitualDeliveryLatch,
  classifyRitualFailure,
  classifyRitualTurnFailure,
  ritualRetryDelayMs,
} from './ritual-retry.ts'

// ── the pure policy ─────────────────────────────────────────────────────────

describe('classifyRitualFailure — three-valued, read off the O3 taxonomy', () => {
  test('a stamped RETRYABLE class is transient', () => {
    const err = new SubstrateCallError('cc-llm-call: 429', { code: 'rate_limited', retryable: true })
    expect(classifyRitualFailure(err)).toBe('transient')
  })

  test('a stamped NON-retryable class is permanent — waiting cannot fix it', () => {
    const err = new SubstrateCallError('cc-llm-call: no `claude` on PATH', {
      code: 'binary_not_found',
      retryable: false,
    })
    expect(classifyRitualFailure(err)).toBe('permanent')
  })

  test("the 'unknown' sentinel is INDETERMINATE, not laundered into a class", () => {
    // An event that carried no `code` maps to the sentinel. Reading its
    // `retryable` as a verdict would invent a classification its producer never
    // made.
    const err = new SubstrateCallError('cc-llm-call: something', { retryable: true })
    expect(err.code).toBe('unknown')
    expect(classifyRitualFailure(err)).toBe('indeterminate')
  })

  test('an ORDINARY throw is indeterminate — a programming error must not retry', () => {
    expect(classifyRitualFailure(new Error('undefined is not a function'))).toBe('indeterminate')
    expect(classifyRitualFailure('SQLITE_BUSY: database is locked')).toBe('indeterminate')
  })
})

describe('classifyRitualTurnFailure — the settled-turn side of the same decision', () => {
  test('a stamped retryable failure is transient', () => {
    expect(
      classifyRitualTurnFailure({ status: 'failed', failure: { code: 'rate_limited', retryable: true } }),
    ).toBe('transient')
  })

  test('a stamped non-retryable failure is permanent', () => {
    expect(
      classifyRitualTurnFailure({ status: 'failed', failure: { code: 'auth_invalid', retryable: false } }),
    ).toBe('permanent')
  })

  test('an UNSTAMPED failure is indeterminate, never optimistically retried', () => {
    expect(classifyRitualTurnFailure({ status: 'failed' })).toBe('indeterminate')
  })

  test('timed_out is PERMANENT for a ritual even though turn_timeout is retryable in general', () => {
    // 45 minutes were already spent; another attempt spends another 45.
    expect(
      classifyRitualTurnFailure({ status: 'timed_out', failure: { code: 'turn_timeout', retryable: true } }),
    ).toBe('permanent')
  })
})

describe('ritualRetryDelayMs — pure, exponential, capped', () => {
  test('grows 4x per attempt from the base delay', () => {
    expect(ritualRetryDelayMs(1)).toBe(RITUAL_RETRY_BASE_DELAY_MS)
    expect(ritualRetryDelayMs(2)).toBe(RITUAL_RETRY_BASE_DELAY_MS * 4)
    expect(ritualRetryDelayMs(3)).toBe(RITUAL_RETRY_BASE_DELAY_MS * 16)
  })

  test('never exceeds the ceiling, however large the attempt number', () => {
    expect(ritualRetryDelayMs(99)).toBe(RITUAL_RETRY_MAX_DELAY_MS)
  })

  test('the last allowed re-attempt still lands within the same morning', () => {
    let total = 0
    for (let a = 1; a < RITUAL_MAX_ATTEMPTS; a++) total += ritualRetryDelayMs(a)
    expect(total).toBeLessThanOrEqual(60 * 60_000)
  })
})

describe('RitualAttemptLedger / RitualDeliveryLatch — bounded, per occurrence', () => {
  test('counts per key and forgets on demand', () => {
    const l = new RitualAttemptLedger()
    expect(l.bump('a')).toBe(1)
    expect(l.bump('a')).toBe(2)
    expect(l.bump('b')).toBe(1)
    expect(l.peek('a')).toBe(2)
    l.forget('a')
    expect(l.peek('a')).toBe(0)
    expect(l.peek('b')).toBe(1)
  })

  test('neither structure grows without bound', () => {
    const l = new RitualAttemptLedger()
    for (let i = 0; i < RitualAttemptLedger.LIMIT + 50; i++) l.bump(`k${i}`)
    // The newest key survives; the oldest were evicted (which can only cost an
    // extra attempt, never a duplicate delivery).
    expect(l.peek(`k${RitualAttemptLedger.LIMIT + 49}`)).toBe(1)
    expect(l.peek('k0')).toBe(0)

    const d = new RitualDeliveryLatch()
    for (let i = 0; i < RitualDeliveryLatch.LIMIT + 50; i++) d.mark(`k${i}`)
    expect(d.has(`k${RitualDeliveryLatch.LIMIT + 49}`)).toBe(true)
    expect(d.has('k0')).toBe(false)
  })
})

describe('collapseAttemptsToOccurrences — retries of one morning are one morning', () => {
  test('keeps the newest row per reminder_id and passes through null ids', () => {
    const rows = [
      { status: 'failed' as const, reminder_id: 'r1' },
      { status: 'failed' as const, reminder_id: 'r1' },
      { status: 'finished' as const, reminder_id: 'r0' },
      { status: 'crashed' as const, reminder_id: null },
      { status: 'crashed' as const, reminder_id: null },
    ]
    expect(collapseAttemptsToOccurrences(rows)).toEqual([
      { status: 'failed', reminder_id: 'r1' },
      { status: 'finished', reminder_id: 'r0' },
      { status: 'crashed', reminder_id: null },
      { status: 'crashed', reminder_id: null },
    ])
  })
})

// ── end to end, through the real tick loop + real executor + real DB ─────────

let tmp: string
let db: ProjectDb
let store: ReminderStore
let runs: RitualRunStore
let subagents: SubagentRegistry
let ritualsDir: string
let posts: ReminderOutboundInput[]

const noopNotifier: ApprovalNotifier = { notify: async () => {} }

const RITUAL: RitualDef = {
  id: 'morning-brief',
  description: 'the daily brief',
  scope: 'instance',
  tool_surface: ['Read', 'Glob', 'Grep'],
  egress: 'none',
  silent: false,
}

const BRIEF_TEXT = 'Here is your morning brief.'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-489-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new ReminderStore(db)
  runs = createRitualRunStore(db)
  subagents = new SubagentRegistry()
  ritualsDir = mkdtempSync(join(tmpdir(), 'neutron-489-rituals-'))
  posts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(ritualsDir, { recursive: true, force: true })
})

function ritualRegistry(): RitualRegistry {
  const reg = createRitualRegistry({ rituals_dir: ritualsDir })
  reg.register(RITUAL)
  writeFileSync(join(ritualsDir, `${RITUAL.id}.md`), 'Write the morning brief.', 'utf8')
  return reg
}

const outbound: ReminderOutbound = {
  post: (input) => {
    posts.push(input)
    return true
  },
}

const neverDispatcher: ReminderDispatcher = {
  dispatch: async () => {
    throw new Error('a ritual must never reach the nudge dispatcher')
  },
}

/** A daily (cron) ritual reminder that is already due. */
async function dailyRitualDue(now_ms: number): Promise<Reminder> {
  const r = await store.create({
    owner_slug: 'owner',
    topic_id: null,
    fire_at: Math.floor(now_ms / 1000) - 60,
    message: 'morning brief',
  })
  db.raw().run(`UPDATE reminders SET ritual_id = ?, recurrence_spec = ? WHERE id = ?`, [
    RITUAL.id,
    '0 9 * * *',
    r.id,
  ])
  return { ...r, ritual_id: RITUAL.id, recurrence_spec: '0 9 * * *' }
}

/** Let the DETACHED substrate turn settle (the executor never awaits it). */
async function settleDetachedTurn(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 2))
}

interface Harness {
  loop: ReminderTickLoop
  advance: (ms: number) => void
  turnCalls: () => number
  rearmCalls: () => number
}

function harness(input: {
  now: () => number
  setNow: (ms: number) => void
  turn: RitualTurn
  registry?: RitualRegistry
  runs?: RitualRunStore
}): Harness {
  let turnCalls = 0
  let rearmCalls = 0
  const countingTurn: RitualTurn = async (i) => {
    turnCalls++
    return input.turn(i)
  }
  const deps: RitualExecutorDeps = {
    registry: input.registry ?? ritualRegistry(),
    approvals: new ApprovalManager(db, noopNotifier),
    project_slug: 'owner',
    instance_key: 'inst',
    subagents,
    turn: countingTurn,
    runs: input.runs ?? runs,
    outbound,
    resolve_topic: () => 'app:owner',
    resolve_model: () => 'claude-x',
    scope_cwd: () => tmp,
    build_approval_check: () => ({ isApproved: () => true }),
    // The production shape (open/composer.ts): reopen a spent one-shot, then move
    // `fire_at` to the backoff instant.
    rearm: async (reminder, fire_at_sec) => {
      rearmCalls++
      await store.reopen(reminder.id)
      return store.reschedule(reminder.id, fire_at_sec)
    },
    now: input.now,
  }
  const loop = new ReminderTickLoop({
    store,
    dispatcher: neverDispatcher,
    ritual_executor: createRitualExecutor(deps),
    now: input.now,
  })
  return {
    loop,
    advance: (ms) => input.setNow(input.now() + ms),
    turnCalls: () => turnCalls,
    rearmCalls: () => rearmCalls,
  }
}

/** A 529 the substrate stamped as `rate_limited` — the busy-upstream shape. */
const OVERLOADED: RitualTurnResult = {
  status: 'failed',
  result: 'cc-llm-call: API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
  failure: { code: 'rate_limited', retryable: true },
}

describe('ISSUES #489 — a transient failure of the SETTLED TURN recovers', () => {
  test('REGRESSION (repro A): an overloaded upstream no longer loses the brief', async () => {
    let now = 1_800_000_000_000
    await dailyRitualDue(now)
    let attempt = 0
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async (): Promise<RitualTurnResult> => {
        attempt++
        return attempt === 1 ? OVERLOADED : { status: 'completed', result: BRIEF_TEXT }
      },
    })

    // 7 a.m.: the fire meets a busy upstream.
    await h.loop.runOnce()
    await settleDetachedTurn()
    expect(h.turnCalls()).toBe(1)
    // NOTHING was said to the owner yet — the ritual has not failed, it is retrying.
    expect(posts).toHaveLength(0)
    expect(h.rearmCalls()).toBe(1)

    // The occurrence is due again at the backoff instant, and NOT before it.
    const rearmed = store.get((await runs.listByRitual(RITUAL.id))[0]!.reminder_id!)!
    expect(rearmed.fire_at).toBe(Math.floor((now + ritualRetryDelayMs(1)) / 1000))
    await h.loop.runOnce()
    expect(h.turnCalls()).toBe(1)

    // Backoff elapses; the re-attempt runs and the brief lands.
    h.advance(ritualRetryDelayMs(1))
    await h.loop.runOnce()
    await settleDetachedTurn()
    expect(h.turnCalls()).toBe(2)
    expect(posts.map((p) => p.body)).toEqual([BRIEF_TEXT])
  }, 30_000)

  test('the retried attempt and the delivery are BOTH on the record, and distinguishable', async () => {
    let now = 1_800_000_000_000
    const reminder = await dailyRitualDue(now)
    let attempt = 0
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async () => (++attempt === 1 ? OVERLOADED : { status: 'completed', result: BRIEF_TEXT }),
    })
    await h.loop.runOnce()
    await settleDetachedTurn()
    h.advance(ritualRetryDelayMs(1))
    await h.loop.runOnce()
    await settleDetachedTurn()

    const rows = runs.listByReminder(reminder.id)
    expect(rows).toHaveLength(2)
    const statuses = rows.map((r) => r.status).sort()
    expect(statuses).toEqual(['failed', 'finished'])
    // `code_ritual_runs` ALONE answers what happened: the failed attempt says a
    // retry was scheduled, so a reader never mistakes it for the run that gave up.
    const failed = rows.find((r) => r.status === 'failed')!
    expect(failed.failure_reason).toContain('retry 1/')
    expect(failed.failure_reason).toContain('transient')
    expect(rows.find((r) => r.status === 'finished')!.output_summary).toBe(BRIEF_TEXT)
  }, 30_000)

  test('a PERMANENT turn failure is not retried — it fails loudly, once', async () => {
    let now = 1_800_000_000_000
    const reminder = await dailyRitualDue(now)
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async (): Promise<RitualTurnResult> => ({
        status: 'failed',
        result: 'cc-llm-call: 401 OAuth access token is invalid',
        failure: { code: 'auth_invalid', retryable: false },
      }),
    })
    await h.loop.runOnce()
    await settleDetachedTurn()
    expect(h.rearmCalls()).toBe(0)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toContain('morning-brief')
    const row = runs.listByReminder(reminder.id)[0]!
    expect(row.status).toBe('failed')
    expect(row.failure_reason).toContain('permanent failure (not retried)')
  }, 30_000)

  test('an UNCLASSIFIED turn failure neither retries nor claims success', async () => {
    let now = 1_800_000_000_000
    const reminder = await dailyRitualDue(now)
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      // No `failure` stamp at all.
      turn: async (): Promise<RitualTurnResult> => ({ status: 'failed', result: 'it broke' }),
    })
    await h.loop.runOnce()
    await settleDetachedTurn()
    expect(h.rearmCalls()).toBe(0)
    expect(posts).toHaveLength(1)
    expect(runs.listByReminder(reminder.id)[0]!.failure_reason).toContain(
      'unclassified failure (not retried)',
    )
  }, 30_000)
})

describe('ISSUES #489 — the attempt cap', () => {
  test('a permanently-busy upstream stops at the cap and says so VISIBLY', async () => {
    let now = 1_800_000_000_000
    const reminder = await dailyRitualDue(now)
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async () => OVERLOADED,
    })

    // Drive far more ticks than the cap allows, advancing past every backoff.
    for (let i = 0; i < RITUAL_MAX_ATTEMPTS + 6; i++) {
      await h.loop.runOnce()
      await settleDetachedTurn()
      h.advance(RITUAL_RETRY_MAX_DELAY_MS + 1000)
    }

    // BOUNDED: exactly the cap, never the 12 ticks we drove.
    expect(h.turnCalls()).toBe(RITUAL_MAX_ATTEMPTS)
    const rows = runs.listByReminder(reminder.id)
    expect(rows).toHaveLength(RITUAL_MAX_ATTEMPTS)
    // VISIBLE: exactly one failure notice, on the attempt that gave up — the
    // earlier ones stayed quiet because they were about to be repeated.
    const failureNotices = posts.filter((p) => p.body.includes("Ritual 'morning-brief' failed"))
    expect(failureNotices).toHaveLength(1)
    // And the terminal row says it exhausted rather than that it merely failed.
    expect(rows.some((r) => (r.failure_reason ?? '').includes('retry exhausted after'))).toBe(true)
  }, 60_000)

  test('one exhausted morning does NOT read as three consecutive failed runs', async () => {
    // The escalation notice exists for "this ritual has been broken for days".
    // Four retries of ONE morning must not counterfeit that.
    let now = 1_800_000_000_000
    await dailyRitualDue(now)
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async () => OVERLOADED,
    })
    for (let i = 0; i < RITUAL_MAX_ATTEMPTS + 2; i++) {
      await h.loop.runOnce()
      await settleDetachedTurn()
      h.advance(RITUAL_RETRY_MAX_DELAY_MS + 1000)
    }
    expect(posts.filter((p) => p.body.includes('consecutive runs'))).toHaveLength(0)
  }, 60_000)
})

describe('ISSUES #489 — exactly-once delivery across a retry', () => {
  test('a retry attempted AFTER a successful delivery delivers exactly once', async () => {
    let now = 1_800_000_000_000
    const reminder = await dailyRitualDue(now)
    // The turn COMPLETES (and therefore delivers) first, then every later attempt
    // fails transiently — the shape that would double-post if the retry path did
    // not consult what has already been delivered.
    let call = 0
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async (): Promise<RitualTurnResult> =>
        ++call === 1 ? { status: 'completed', result: BRIEF_TEXT } : OVERLOADED,
    })

    await h.loop.runOnce()
    await settleDetachedTurn()
    expect(posts.map((p) => p.body)).toEqual([BRIEF_TEXT])

    // Force the SAME occurrence to fire again (a stale re-arm, a replayed tick, a
    // reboot mid-settle) and fail transiently. It must NOT be re-armed, because
    // the brief for this occurrence is already in front of the owner.
    await store.reopen(reminder.id)
    await store.reschedule(reminder.id, Math.floor(now / 1000) - 1)
    const rearmsBefore = h.rearmCalls()
    await h.loop.runOnce()
    await settleDetachedTurn()

    expect(h.rearmCalls()).toBe(rearmsBefore)
    // EXACTLY ONE delivered row, and exactly one delivery.
    const deliveredRows = runs.listByReminder(reminder.id).filter((r) => r.status === 'finished')
    expect(deliveredRows).toHaveLength(1)
    expect(posts.filter((p) => p.body === BRIEF_TEXT)).toHaveLength(1)
  }, 30_000)

  test('a run store that cannot prove non-delivery refuses the retry rather than risk a duplicate', async () => {
    let now = 1_800_000_000_000
    await dailyRitualDue(now)
    const blindRuns: RitualRunStore = {
      ...runs,
      listByReminder: () => {
        throw new Error('SQLITE_BUSY: database is locked')
      },
    }
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async () => OVERLOADED,
      runs: blindRuns,
    })
    await h.loop.runOnce()
    await settleDetachedTurn()
    // Transient AND under the cap — and still no retry, because "already
    // delivered?" could not be answered.
    expect(h.rearmCalls()).toBe(0)
    expect(posts.filter((p) => p.body.includes('failed'))).toHaveLength(1)
  }, 30_000)
})

describe('ISSUES #489 — the fire-STARTUP path', () => {
  test('REGRESSION (repro B): a startup loss no longer re-fires forever with zero record', async () => {
    let now = 1_800_000_000_000
    const reminder = await dailyRitualDue(now)
    // The run store is transiently unavailable, so no durable row can land for
    // this occurrence and `fire()` takes the startup-loss path. Before the fix
    // this re-fired on all 25 ticks, leaving 0 rows and 0 notices.
    let insertAttempts = 0
    const downRuns: RitualRunStore = {
      ...runs,
      insertRunning: async () => {
        insertAttempts++
        throw new Error('SQLITE_BUSY: database is locked')
      },
      insertFailed: async () => {
        throw new Error('SQLITE_BUSY: database is locked')
      },
    }
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async () => ({ status: 'completed', result: BRIEF_TEXT }),
      runs: downRuns,
    })

    for (let i = 0; i < 25; i++) {
      await h.loop.runOnce()
      await settleDetachedTurn()
      h.advance(30_000)
    }

    // BOUNDED — an unclassified startup fault is `indeterminate`, so it does not
    // retry at all. One attempt, not 25.
    expect(insertAttempts).toBe(1)
    // VISIBLE — the owner is told, which is the property that was missing entirely.
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toContain('morning-brief')
    // And the occurrence is consumed rather than left due forever.
    expect(store.get(reminder.id)!.fire_at).toBeGreaterThan(Math.floor(now / 1000) - 30 * 25)
  }, 60_000)

  test('a STAMPED-transient startup loss re-arms on a backoff and then succeeds', async () => {
    let now = 1_800_000_000_000
    const reminder = await dailyRitualDue(now)
    const real = ritualRegistry()
    let getCalls = 0
    // `validateRitualFire` reads the registry BEFORE anything durable is written,
    // so a throw here is a genuine startup loss. Stamped `rate_limited`, i.e. the
    // one class that earns a re-attempt.
    const flakyRegistry: RitualRegistry = {
      register: (d) => real.register(d),
      unregister: (id) => real.unregister(id),
      list: () => real.list(),
      promptPathFor: (id: string) => real.promptPathFor(id),
      get: (id: string) => {
        getCalls++
        if (getCalls === 1) {
          throw new SubstrateCallError('cc-llm-call: overloaded', {
            code: 'rate_limited',
            retryable: true,
          })
        }
        return real.get(id)
      },
    }
    const h = harness({
      now: () => now,
      setNow: (ms) => {
        now = ms
      },
      turn: async () => ({ status: 'completed', result: BRIEF_TEXT }),
      registry: flakyRegistry,
    })

    await h.loop.runOnce()
    await settleDetachedTurn()
    // Re-armed forward by the tick (NOT by `rearm`, which only the settle path uses).
    expect(h.rearmCalls()).toBe(0)
    const after = store.get(reminder.id)!
    expect(after.status).toBe('pending')
    expect(after.fire_at).toBe(Math.floor((now + ritualRetryDelayMs(1)) / 1000))
    // Not due yet.
    await h.loop.runOnce()
    expect(posts).toHaveLength(0)
    // Backoff elapses → the re-attempt runs and the brief lands.
    h.advance(ritualRetryDelayMs(1))
    await h.loop.runOnce()
    await settleDetachedTurn()
    expect(posts.map((p) => p.body)).toEqual([BRIEF_TEXT])
  }, 30_000)
})
