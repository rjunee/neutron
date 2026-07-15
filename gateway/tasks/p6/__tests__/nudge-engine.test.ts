/**
 * Nudge engine integration test. Mocks the LLM (`LlmCallFn`) so the
 * full pass — persona splice → prompt build → LLM call → validate →
 * persist — can be exercised deterministically.
 *
 * Spec: docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md
 * Part A + Part D.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import { PersonaPromptLoader } from '../../../wiring/persona-loader.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import {
  clampRationale,
  localMidnightUtc,
  parseLlmNudgeResponse,
  resolveOwnerDay,
  runNudgePass,
} from '../nudge-engine.ts'
import { NUDGE_RATIONALE_MAX_CHARS } from '../nudge-engine-prompt.ts'

const OWNER = 'demo'

interface Harness {
  db: ProjectDb
  tasks: TaskStore
  owner_home: string
  close(): Promise<void>
}

function openHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-nudge-'))
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const tasks = new TaskStore(db)
  return {
    db,
    tasks,
    owner_home: tmp,
    close: async () => {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

interface RecordedCall {
  system: string
  user: string
  max_tokens: number
}

function recordingLlm(
  responder: (call: RecordedCall) => string | Promise<string>,
): { llm: LlmCallFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const llm: LlmCallFn = async (call) => {
    calls.push(call)
    return responder(call)
  }
  return { llm, calls }
}

describe('parseLlmNudgeResponse', () => {
  it('parses a fenced ```json block', () => {
    const raw = 'Here you go:\n```json\n{"task_id":"a","rationale":"because"}\n```\n'
    expect(parseLlmNudgeResponse(raw)).toEqual({ task_id: 'a', rationale: 'because' })
  })
  it('parses raw JSON without a fence', () => {
    expect(parseLlmNudgeResponse('{"task_id":"x","rationale":"y"}')).toEqual({
      task_id: 'x',
      rationale: 'y',
    })
  })
  it('rejects missing fields', () => {
    expect(parseLlmNudgeResponse('{"task_id":"x"}')).toBeNull()
    expect(parseLlmNudgeResponse('{"rationale":"y"}')).toBeNull()
  })
  it('rejects malformed JSON', () => {
    expect(parseLlmNudgeResponse('not json')).toBeNull()
    expect(parseLlmNudgeResponse('')).toBeNull()
  })
})

describe('clampRationale', () => {
  it('returns short strings unchanged', () => {
    expect(clampRationale('short')).toBe('short')
  })
  it('clamps overlong strings with a trailing ellipsis', () => {
    const long = 'x'.repeat(NUDGE_RATIONALE_MAX_CHARS + 50)
    const clamped = clampRationale(long)
    expect(clamped.length).toBeLessThanOrEqual(NUDGE_RATIONALE_MAX_CHARS)
    expect(clamped).toMatch(/…$/)
  })
})

describe('resolveOwnerDay', () => {
  it('returns YYYY-MM-DD for the LA timezone', () => {
    // 2026-05-23 07:00 UTC = 2026-05-23 00:00 LA
    const day = resolveOwnerDay(Date.UTC(2026, 4, 23, 7, 0, 0), 'America/Los_Angeles')
    expect(day).toBe('2026-05-23')
  })
})

describe('localMidnightUtc', () => {
  it('returns the UTC instant of LA-local midnight for a given day', () => {
    // May 2026 LA = UTC-7 (PDT). LA midnight on 2026-05-23 = 07:00 UTC.
    const iso = localMidnightUtc('2026-05-23', 'America/Los_Angeles', 0)
    expect(iso).toBe('2026-05-23T07:00:00.000Z')
  })

  it('respects dayOffset = -1 (yesterday LA-local)', () => {
    const iso = localMidnightUtc('2026-05-23', 'America/Los_Angeles', -1)
    expect(iso).toBe('2026-05-22T07:00:00.000Z')
  })

  it('respects dayOffset = +1 (tomorrow LA-local)', () => {
    const iso = localMidnightUtc('2026-05-23', 'America/Los_Angeles', 1)
    expect(iso).toBe('2026-05-24T07:00:00.000Z')
  })

  it('handles UTC timezone as a no-op (midnight UTC stays midnight UTC)', () => {
    const iso = localMidnightUtc('2026-05-23', 'UTC', 0)
    expect(iso).toBe('2026-05-23T00:00:00.000Z')
  })

  it('handles Asia/Singapore (UTC+8) correctly', () => {
    // Singapore midnight on 2026-05-23 = 16:00 UTC on 2026-05-22.
    const iso = localMidnightUtc('2026-05-23', 'Asia/Singapore', 0)
    expect(iso).toBe('2026-05-22T16:00:00.000Z')
  })

  it('crosses a DST boundary correctly (PST→PDT)', () => {
    // 2026 PST→PDT transition: 2026-03-08 02:00 PST → 03:00 PDT.
    // 2026-03-07 midnight LA-local = UTC-8 = 08:00 UTC.
    // 2026-03-08 midnight LA-local = UTC-8 (still standard) = 08:00 UTC.
    // 2026-03-09 midnight LA-local = UTC-7 (now daylight) = 07:00 UTC.
    expect(localMidnightUtc('2026-03-07', 'America/Los_Angeles', 0)).toBe(
      '2026-03-07T08:00:00.000Z',
    )
    expect(localMidnightUtc('2026-03-09', 'America/Los_Angeles', 0)).toBe(
      '2026-03-09T07:00:00.000Z',
    )
  })
})

describe('runNudgePass', () => {
  let h: Harness

  beforeEach(() => {
    h = openHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  function freezeNow(): () => number {
    // Fix the wall clock to 2026-05-23 18:00:00 UTC so the LA day is 05-23.
    const fixed = Date.UTC(2026, 4, 23, 18, 0, 0)
    return () => fixed
  }

  it('picks a task, persists the row, returns kind=ok', async () => {
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'Most important',
      priority: 3,
    })
    const t2 = await h.tasks.create({
      project_slug: OWNER,
      title: 'Less important',
      priority: 1,
    })
    const { llm, calls } = recordingLlm(() =>
      JSON.stringify({ task_id: t1.id, rationale: 'P3 leads, do it first' }),
    )
    const result = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    expect(result).toEqual({ kind: 'ok', task_id: t1.id, day: '2026-05-23' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.user).toContain(`\`${t1.id}\``)
    expect(calls[0]!.user).toContain(`\`${t2.id}\``)

    interface PickRow {
      task_id: string
      llm_rationale: string
      top_3_task_ids: string
      llm_model: string
    }
    const row = h.db
      .prepare<PickRow, [string, string]>(
        `SELECT task_id, llm_rationale, top_3_task_ids, llm_model
           FROM current_focus_pick WHERE project_slug = ? AND day = ?`,
      )
      .get(OWNER, '2026-05-23')
    expect(row).not.toBeNull()
    expect(row!.task_id).toBe(t1.id)
    expect(row!.llm_rationale).toBe('P3 leads, do it first')
    const top3 = JSON.parse(row!.top_3_task_ids) as string[]
    expect(top3).toContain(t1.id)
    expect(top3).toContain(t2.id)
  })

  it('is idempotent on same-day re-run (no second LLM call)', async () => {
    const t1 = await h.tasks.create({ project_slug: OWNER, title: 'Just one', priority: 2 })
    const { llm, calls } = recordingLlm(() =>
      JSON.stringify({ task_id: t1.id, rationale: 'r' }),
    )
    const now = freezeNow()
    await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now,
      timezone: 'America/Los_Angeles',
    })
    const second = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now,
      timezone: 'America/Los_Angeles',
    })
    expect(second).toEqual({ kind: 'skipped', reason: 'already_picked_today' })
    expect(calls.length).toBe(1)
  })

  it('skips when no open tasks exist', async () => {
    const { llm, calls } = recordingLlm(() => '{}')
    const result = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'empty_slate' })
    expect(calls.length).toBe(0)
  })

  it('skips when llm is null (no credential)', async () => {
    await h.tasks.create({ project_slug: OWNER, title: 'One', priority: 2 })
    const result = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm: null,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'no_llm' })
  })

  it('skips with parse_error when the LLM returns garbage', async () => {
    await h.tasks.create({ project_slug: OWNER, title: 'One', priority: 2 })
    const { llm } = recordingLlm(() => 'totally not json')
    const result = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'parse_error' })
  })

  it('skips with unknown_task_id when the LLM picks an id not in the slate', async () => {
    await h.tasks.create({ project_slug: OWNER, title: 'One', priority: 2 })
    const { llm } = recordingLlm(() =>
      JSON.stringify({ task_id: 'tsk_unknown', rationale: 'r' }),
    )
    const result = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'unknown_task_id' })
  })

  it('skips with llm_error on LLM timeout', async () => {
    await h.tasks.create({ project_slug: OWNER, title: 'One', priority: 2 })
    const llm: LlmCallFn = () =>
      new Promise(() => {
        /* never resolves */
      })
    const result = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
      timeout_ms: 50,
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'llm_error' })
  })

  it('clamps overlong rationale before persisting', async () => {
    const t1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'One',
      priority: 2,
    })
    const longRationale = 'x'.repeat(NUDGE_RATIONALE_MAX_CHARS + 100)
    const { llm } = recordingLlm(() =>
      JSON.stringify({ task_id: t1.id, rationale: longRationale }),
    )
    await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    interface R {
      llm_rationale: string
    }
    const row = h.db
      .prepare<R, [string]>(
        `SELECT llm_rationale FROM current_focus_pick WHERE project_slug = ?`,
      )
      .get(OWNER)
    expect(row!.llm_rationale.length).toBeLessThanOrEqual(NUDGE_RATIONALE_MAX_CHARS)
  })

  it('splices the persona content into the LLM system prompt', async () => {
    // Write persona files to owner_home/persona.
    mkdirSync(join(h.owner_home, 'persona'), { recursive: true })
    writeFileSync(join(h.owner_home, 'persona', 'SOUL.md'), '# Soul\n\nBe sharp.')
    writeFileSync(join(h.owner_home, 'persona', 'USER.md'), '# User\n\nName: Sam.')

    const t1 = await h.tasks.create({ project_slug: OWNER, title: 'One', priority: 2 })
    const personaLoader = new PersonaPromptLoader({ owner_home: h.owner_home })
    const { llm, calls } = recordingLlm(() =>
      JSON.stringify({ task_id: t1.id, rationale: 'r' }),
    )
    await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      personaLoader,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    expect(calls.length).toBe(1)
    expect(calls[0]!.system).toContain('Be sharp.')
    expect(calls[0]!.system).toContain('Name: Sam.')
    expect(calls[0]!.system).toContain('# Persona')
  })

  it('runs staleness pass before nudge so demoted scores reflect in slate', async () => {
    // Seed two tasks. Pre-stamp one with a 3-skip count so the
    // staleness pass demotes it before the nudge reads the slate.
    const stuck = await h.tasks.create({
      project_slug: OWNER,
      title: 'Stuck',
      priority: 3,
    })
    const fresh = await h.tasks.create({
      project_slug: OWNER,
      title: 'Fresh',
      priority: 2,
    })
    await h.db.run(
      `UPDATE tasks SET focus_score = 10, top3_skip_count = 3 WHERE id = ?`,
      [stuck.id],
    )
    await h.db.run(`UPDATE tasks SET focus_score = 7 WHERE id = ?`, [fresh.id])
    // Seed yesterday's pick so staleness has something to read.
    await h.db.run(
      `INSERT INTO current_focus_pick
        (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at, llm_model, llm_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        OWNER,
        '2026-05-22',
        fresh.id,
        'r',
        JSON.stringify([fresh.id, stuck.id]),
        '2026-05-22T12:00:00Z',
        'm',
      ],
    )

    const { llm, calls } = recordingLlm(() =>
      JSON.stringify({ task_id: fresh.id, rationale: 'fresher' }),
    )
    await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })

    // Stuck task should now be demoted (score 5, demotion_count 1).
    interface R {
      focus_score: number | null
      staleness_demotion_count: number
    }
    const row = h.db
      .prepare<R, [string]>(
        `SELECT focus_score, staleness_demotion_count FROM tasks WHERE id = ?`,
      )
      .get(stuck.id)
    expect(row!.focus_score).toBe(5)
    expect(row!.staleness_demotion_count).toBe(1)
    // And the slate the LLM saw should reflect the post-demotion order:
    // fresh (7) > stuck (5).
    const slateText = calls[0]!.user
    expect(slateText.indexOf(`\`${fresh.id}\``)).toBeLessThan(
      slateText.indexOf(`\`${stuck.id}\``),
    )
  })

  it('handles insert race gracefully (PK collision treated as skip)', async () => {
    const t1 = await h.tasks.create({ project_slug: OWNER, title: 'One', priority: 2 })
    // Pre-seed the row to simulate a race winner.
    await h.db.run(
      `INSERT INTO current_focus_pick
        (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at, llm_model, llm_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [OWNER, '2026-05-23', t1.id, 'first', '[]', '2026-05-23T12:00:00Z', 'm'],
    )
    // The existence check should short-circuit before the LLM call.
    const { llm, calls } = recordingLlm(() =>
      JSON.stringify({ task_id: t1.id, rationale: 'r' }),
    )
    const result = await runNudgePass({
      db: h.db,
      project_slug: OWNER,
      llm,
      now: freezeNow(),
      timezone: 'America/Los_Angeles',
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'already_picked_today' })
    expect(calls.length).toBe(0)
  })
})
