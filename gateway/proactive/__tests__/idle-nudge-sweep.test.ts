/**
 * Idle-topic nudge-sweep tests. Exercises the pure quality gate, the real
 * `current_focus_pick` ⋈ `tasks` read, and the full `runIdleNudgeSweep` path
 * against a REAL in-memory DB + recording sink:
 *   • posts a nudge for an IDLE topic that has a fresh ranker pick;
 *   • SKIPS an ACTIVE topic (recent activity);
 *   • SKIPS an EMPTY topic (no pick / picked task no longer open);
 *   • dedupes — does not re-nudge the same idle topic about the same task.
 *
 * Spec: gap-audit P0-5 (WAVE 2 Track A).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { TaskStore } from '../../../tasks/store.ts'
import type { OutgoingMessage } from '../sink.ts'
import { ProactiveStateStore } from '../state-store.ts'
import {
  buildLlmNudgeRater,
  composeNudge,
  evaluateNudgeGate,
  evaluateQualityGate,
  NUDGE_QUALITY_FLOOR,
  parseNudgeRating,
  readTodayPick,
  runIdleNudgeSweep,
  type IdleNudgeSweepDeps,
  type NudgeRater,
  type ProactiveTopicCandidate,
  type TodayPick,
} from '../idle-nudge-sweep.ts'

const TZ = 'America/Los_Angeles'
// 2026-06-20 18:00 UTC = 11:00 LA → owner-local day 2026-06-20.
const NOW_MS = Date.UTC(2026, 5, 20, 18, 0, 0)
const DAY = '2026-06-20'
const IDLE_MS = 4 * 60 * 60 * 1000

interface Harness {
  db: ProjectDb
  tasks: TaskStore
  store: ProactiveStateStore
  sent: OutgoingMessage[]
  sink: { send(m: OutgoingMessage): Promise<string> }
  close(): void
}

function open(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-proactive-nudge-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const sent: OutgoingMessage[] = []
  return {
    db,
    tasks: new TaskStore(db),
    store: new ProactiveStateStore(db),
    sent,
    sink: {
      async send(m: OutgoingMessage): Promise<string> {
        sent.push(m)
        return 'sent-id'
      },
    },
    close: () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function seedPick(
  h: Harness,
  project_slug: string,
  task_id: string,
  title: string,
  rationale = 'Highest leverage: unblocks the rest.',
): Promise<void> {
  await h.tasks.create({ id: task_id, project_slug, title })
  await h.db.run(
    `INSERT INTO current_focus_pick
       (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at, llm_model, llm_request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [project_slug, DAY, task_id, rationale, JSON.stringify([task_id]), new Date(NOW_MS).toISOString(), 'claude-haiku-4-5'],
  )
}

let h: Harness
beforeEach(() => {
  h = open()
})
afterEach(() => {
  h.close()
})

describe('readTodayPick (real DB read)', () => {
  it('returns the pick joined to its open task', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const pick = readTodayPick(h.db, 'neutron', DAY)
    expect(pick).toEqual({ task_id: 't1', title: 'Wire the sweep', rationale: 'Highest leverage: unblocks the rest.' })
  })

  it('returns null when there is no pick for the day', () => {
    expect(readTodayPick(h.db, 'neutron', DAY)).toBeNull()
  })

  it('returns null when the picked task is no longer open', async () => {
    await seedPick(h, 'neutron', 't1', 'Done already')
    await h.db.run(`UPDATE tasks SET status = 'done' WHERE id = ?`, ['t1'])
    expect(readTodayPick(h.db, 'neutron', DAY)).toBeNull()
  })
})

describe('evaluateNudgeGate (pure quality gate)', () => {
  const pick: TodayPick = { task_id: 't1', title: 'x', rationale: 'y' }
  const idleCandidate: ProactiveTopicCandidate = {
    topic_id: '-100:1',
    project_slug: 'p',
    last_activity_ms: NOW_MS - IDLE_MS - 1000,
  }

  it('posts for an idle topic with a fresh pick and no prior nudge', () => {
    expect(
      evaluateNudgeGate({ candidate: idleCandidate, pick, prior: null, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: true })
  })

  it('skips an active topic (recent activity)', () => {
    const active = { ...idleCandidate, last_activity_ms: NOW_MS - 60_000 }
    expect(
      evaluateNudgeGate({ candidate: active, pick, prior: null, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: false, reason: 'active' })
  })

  it('skips when there is no pick', () => {
    expect(
      evaluateNudgeGate({ candidate: idleCandidate, pick: null, prior: null, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: false, reason: 'no_pick' })
  })

  it('dedupes the same task when the user has not returned', () => {
    const prior = { last_nudged_task_id: 't1', last_activity_at_ms: idleCandidate.last_activity_ms }
    expect(
      evaluateNudgeGate({ candidate: idleCandidate, pick, prior, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: false, reason: 'already_nudged' })
  })

  it('re-nudges the same task once the user has returned and gone idle again', () => {
    const prior = { last_nudged_task_id: 't1', last_activity_at_ms: NOW_MS - IDLE_MS - 100_000 }
    const candidate = { ...idleCandidate, last_activity_ms: NOW_MS - IDLE_MS - 1000 }
    expect(
      evaluateNudgeGate({ candidate, pick, prior, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: true })
  })

  it('re-nudges after a null-watermark first nudge once known activity appears', () => {
    // First nudge fired with unknown activity → watermark stored as null.
    // The user later returns (known timestamp) and goes idle again: that must
    // count as advancement, not stay deduped forever (Codex review P2).
    const prior = { last_nudged_task_id: 't1', last_activity_at_ms: null }
    const candidate = { ...idleCandidate, last_activity_ms: NOW_MS - IDLE_MS - 1000 }
    expect(
      evaluateNudgeGate({ candidate, pick, prior, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: true })
  })

  it('still dedupes a null-watermark nudge while activity stays unknown', () => {
    const prior = { last_nudged_task_id: 't1', last_activity_at_ms: null }
    const candidate = { ...idleCandidate, last_activity_ms: null }
    expect(
      evaluateNudgeGate({ candidate, pick, prior, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: false, reason: 'already_nudged' })
  })

  it('treats unknown last-activity (null) as idle', () => {
    const candidate = { ...idleCandidate, last_activity_ms: null }
    expect(
      evaluateNudgeGate({ candidate, pick, prior: null, now_ms: NOW_MS, idle_threshold_ms: IDLE_MS }),
    ).toEqual({ post: true })
  })
})

describe('composeNudge (pure)', () => {
  it('renders one task + rationale, concise', () => {
    const body = composeNudge('neutron', { task_id: 't1', title: 'Wire the sweep', rationale: 'Unblocks delivery.' })
    expect(body).toBe('👋 One thing for neutron: Wire the sweep\nUnblocks delivery.')
  })
})

function deps(
  topics: ProactiveTopicCandidate[],
  over: Partial<IdleNudgeSweepDeps> = {},
): IdleNudgeSweepDeps {
  return {
    db: h.db,
    store: h.store,
    sink: h.sink,
    listTopics: () => topics,
    now: () => NOW_MS,
    tz: TZ,
    idle_threshold_ms: IDLE_MS,
    ...over,
  }
}

describe('runIdleNudgeSweep (gate + POST)', () => {
  it('posts a nudge for an idle topic with a fresh pick', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const r = await runIdleNudgeSweep(
      deps([{ topic_id: '-100:1', project_slug: 'neutron', last_activity_ms: NOW_MS - IDLE_MS - 1000 }]),
    )
    expect(r.posted).toBe(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('One thing for neutron: Wire the sweep')
    expect(h.sent[0]!.topic.channel_topic_id).toBe('-100:1')
  })

  it('SKIPS an active topic and an empty topic in the same sweep', async () => {
    // 'neutron' has a pick but its topic is ACTIVE; 'empty' is idle but has NO pick.
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const r = await runIdleNudgeSweep(
      deps([
        { topic_id: '-100:active', project_slug: 'neutron', last_activity_ms: NOW_MS - 60_000 },
        { topic_id: '-100:empty', project_slug: 'empty', last_activity_ms: NOW_MS - IDLE_MS - 1000 },
      ]),
    )
    expect(r.posted).toBe(0)
    expect(r.skip_reasons.active).toBe(1)
    expect(r.skip_reasons.no_pick).toBe(1)
    expect(h.sent).toHaveLength(0)
  })

  it('dedupes across sweeps — the same idle topic is nudged once per pick', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const candidate = { topic_id: '-100:1', project_slug: 'neutron', last_activity_ms: NOW_MS - IDLE_MS - 1000 }
    const first = await runIdleNudgeSweep(deps([candidate]))
    expect(first.posted).toBe(1)
    // Second sweep: same pick, no fresh activity → skipped as already_nudged.
    const second = await runIdleNudgeSweep(deps([candidate], { now: () => NOW_MS + 60_000 }))
    expect(second.posted).toBe(0)
    expect(second.skip_reasons.already_nudged).toBe(1)
    expect(h.sent).toHaveLength(1)
  })

  it('counts a per-topic deliver failure without aborting the sweep', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const failingSink = {
      async send(): Promise<string> {
        throw new Error('telegram 500')
      },
    }
    const r = await runIdleNudgeSweep(
      deps([{ topic_id: '-100:1', project_slug: 'neutron', last_activity_ms: NOW_MS - IDLE_MS - 1000 }], {
        sink: failingSink,
      }),
    )
    expect(r.posted).toBe(0)
    expect(r.skip_reasons.deliver_failed).toBe(1)
    // Ledger not written → the next sweep retries.
    expect(h.store.getTopicState('-100:1')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// P1-4 — dual-rating ≥7 quality gate (Vajra parity). Without it the sweep
// nudges every idle topic with a pick; with it a candidate must ALSO clear a
// leverage + gratitude floor of 7 (a null rating abstains).
// ───────────────────────────────────────────────────────────────────────────

describe('evaluateQualityGate (pure ≥7 dual-rating)', () => {
  it('posts only when BOTH dimensions clear the floor', () => {
    expect(evaluateQualityGate({ leverage: 7, gratitude: 7 })).toEqual({ post: true })
    expect(evaluateQualityGate({ leverage: 10, gratitude: 8 })).toEqual({ post: true })
  })
  it('rejects when EITHER dimension is below the floor', () => {
    expect(evaluateQualityGate({ leverage: 6, gratitude: 9 })).toEqual({
      post: false,
      reason: 'low_quality',
    })
    expect(evaluateQualityGate({ leverage: 9, gratitude: 6 })).toEqual({
      post: false,
      reason: 'low_quality',
    })
  })
  it('rejects a null rating (the LLM abstained → output NONE)', () => {
    expect(evaluateQualityGate(null)).toEqual({ post: false, reason: 'low_quality' })
  })
  it('the floor is 7 (Vajra parity)', () => {
    expect(NUDGE_QUALITY_FLOOR).toBe(7)
  })
})

describe('parseNudgeRating', () => {
  it('parses the strict LEVERAGE=/GRATITUDE= lines', () => {
    expect(parseNudgeRating('LEVERAGE=9\nGRATITUDE=8')).toEqual({ leverage: 9, gratitude: 8 })
    expect(parseNudgeRating('leverage = 7\ngratitude = 10')).toEqual({ leverage: 7, gratitude: 10 })
  })
  it('returns null on missing / out-of-range / garbled output', () => {
    expect(parseNudgeRating('LEVERAGE=9')).toBeNull()
    expect(parseNudgeRating('LEVERAGE=0\nGRATITUDE=8')).toBeNull()
    expect(parseNudgeRating('LEVERAGE=11\nGRATITUDE=8')).toBeNull()
    expect(parseNudgeRating('no rating here')).toBeNull()
  })
})

describe('buildLlmNudgeRater', () => {
  it('rates via the LLM and parses the verdict', async () => {
    const rater = buildLlmNudgeRater(async () => 'LEVERAGE=8\nGRATITUDE=9')
    const rating = await rater({
      project_slug: 'neutron',
      pick: { task_id: 't1', title: 'Ship it', rationale: 'Top priority.' },
      candidate: { topic_id: '-100:1', project_slug: 'neutron', last_activity_ms: null },
    })
    expect(rating).toEqual({ leverage: 8, gratitude: 9 })
  })
  it('abstains (null) when the LLM throws', async () => {
    const rater = buildLlmNudgeRater(async () => {
      throw new Error('llm down')
    })
    const rating = await rater({
      project_slug: 'neutron',
      pick: { task_id: 't1', title: 'Ship it', rationale: 'Top priority.' },
      candidate: { topic_id: '-100:1', project_slug: 'neutron', last_activity_ms: null },
    })
    expect(rating).toBeNull()
  })
})

describe('runIdleNudgeSweep — ≥7 quality gate gates the POST', () => {
  const idleTopic: ProactiveTopicCandidate = {
    topic_id: '-100:1',
    project_slug: 'neutron',
    last_activity_ms: NOW_MS - IDLE_MS - 1000,
  }
  // A rater that always returns a fixed rating.
  const fixedRater = (r: { leverage: number; gratitude: number } | null): NudgeRater =>
    async () => r

  it('REJECTS a <7 candidate (does not post, counts low_quality)', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const r = await runIdleNudgeSweep(
      deps([idleTopic], { rateNudge: fixedRater({ leverage: 5, gratitude: 9 }) }),
    )
    expect(r.posted).toBe(0)
    expect(r.skip_reasons.low_quality).toBe(1)
    expect(h.sent).toHaveLength(0)
    // Not recorded → no dedupe pollution; a later high-quality pick can post.
    expect(h.store.getTopicState('-100:1')).toBeNull()
  })

  it('REJECTS when the rater abstains (null)', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const r = await runIdleNudgeSweep(deps([idleTopic], { rateNudge: fixedRater(null) }))
    expect(r.posted).toBe(0)
    expect(r.skip_reasons.low_quality).toBe(1)
    expect(h.sent).toHaveLength(0)
  })

  it('POSTS a ≥7 candidate that also clears idle + dedupe', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const r = await runIdleNudgeSweep(
      deps([idleTopic], { rateNudge: fixedRater({ leverage: 8, gratitude: 8 }) }),
    )
    expect(r.posted).toBe(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('One thing for neutron: Wire the sweep')
  })

  it('a rater that throws is treated as abstain (skip, sweep continues)', async () => {
    await seedPick(h, 'neutron', 't1', 'Wire the sweep')
    const r = await runIdleNudgeSweep(
      deps([idleTopic], {
        rateNudge: async () => {
          throw new Error('rater boom')
        },
      }),
    )
    expect(r.posted).toBe(0)
    expect(r.skip_reasons.low_quality).toBe(1)
  })
})
