import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { LlmCallFn } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import { FAST_MODEL } from '@neutronai/runtime/models.ts'
import { TaskStore } from '../store.ts'
import {
  DEFAULT_TASK_PRIORITIZE_MODEL,
  TASK_PRIORITIZE_HANDLER_NAME,
  buildPrioritizeUserPrompt,
  buildTaskPrioritizeHandler,
  parseRanking,
  prioritizeTasksForProject,
  registerTaskPrioritizeCron,
} from '../prioritize-llm.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-prioritize-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Build an LLM stub that returns the given ranking JSON verbatim. */
function llmReturning(body: string): LlmCallFn {
  return async () => body
}

/** An LLM stub that ranks the candidates in the order their ids appear in `order`. */
function llmRankingIds(order: string[], reason = 'Do it'): LlmCallFn {
  return async () =>
    JSON.stringify({
      ranking: order.map((id) => ({ id, reason: `${reason}: ${id}` })),
    })
}

describe('prioritizeTasksForProject — LLM-primary path', () => {
  test('ranks open tasks in the LLM-returned order and stamps the columns', async () => {
    const store = new TaskStore(db)
    // Create in an order that is NOT the LLM order, so we prove the LLM
    // ordering wins (not insertion / focus order).
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 3 })
    const b = await store.create({ project_slug: 't1', title: 'B', priority: 0 })
    const c = await store.create({ project_slug: 't1', title: 'C', priority: 1 })

    // LLM puts B first, then C, then A — deliberately fighting focus_score.
    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: llmRankingIds([b.id, c.id, a.id]),
      model: 'test-model',
    })

    expect(result.scanned).toBe(3)
    expect(result.ranked).toBe(3)
    expect(result.prioritized_by).toBe('llm')
    expect(result.model_id).toBe('test-model')

    const rowB = store.get(b.id)
    const rowC = store.get(c.id)
    const rowA = store.get(a.id)
    expect(rowB?.llm_rank).toBe(1)
    expect(rowC?.llm_rank).toBe(2)
    expect(rowA?.llm_rank).toBe(3)
    expect(rowB?.prioritized_by).toBe('llm')
    expect(rowB?.llm_reason).toContain(b.id)
    expect(rowB?.prioritized_at).not.toBeNull()
  })

  test('rendered focus_score order follows the LLM ranking after a pass', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 3 })
    const b = await store.create({ project_slug: 't1', title: 'B', priority: 0 })

    // Before any pass, focus_score order = focus_score DESC → A (P3) first.
    const before = store.list({ project_slug: 't1', order: 'focus_score' })
    expect(before.map((r) => r.id)).toEqual([a.id, b.id])

    // LLM flips it: B should now render first.
    await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: llmRankingIds([b.id, a.id]),
    })
    const after = store.list({ project_slug: 't1', order: 'focus_score' })
    expect(after.map((r) => r.id)).toEqual([b.id, a.id])
  })

  test('ranks the FULL open set even when it exceeds the prompt cap (no stale tail)', async () => {
    const store = new TaskStore(db)
    // 4 open tasks but only the top-2 by focus go to the LLM (limit=2).
    const p3 = await store.create({ project_slug: 't1', title: 'p3', priority: 3 })
    const p2 = await store.create({ project_slug: 't1', title: 'p2', priority: 2 })
    const p1 = await store.create({ project_slug: 't1', title: 'p1', priority: 1 })
    const p0 = await store.create({ project_slug: 't1', title: 'p0', priority: 0 })

    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: llmRankingIds([p2.id, p3.id]), // LLM reorders the top-2
      limit: 2,
    })
    // Every open row is ranked this pass — no NULL llm_rank survives.
    expect(result.scanned).toBe(4)
    expect(result.ranked).toBe(4)
    for (const id of [p3.id, p2.id, p1.id, p0.id]) {
      expect(store.get(id)?.llm_rank).not.toBeNull()
    }
    // Head = LLM order; tail = deterministic focus order (p1 > p0).
    expect(store.get(p2.id)?.llm_rank).toBe(1)
    expect(store.get(p3.id)?.llm_rank).toBe(2)
    expect(store.get(p1.id)?.llm_rank).toBe(3)
    expect(store.get(p0.id)?.llm_rank).toBe(4)
  })

  test('a second pass clears prior ranks (no stale rank pins a dropped task)', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 3 })
    const b = await store.create({ project_slug: 't1', title: 'B', priority: 0 })
    // Pass 1: LLM pins B first.
    await prioritizeTasksForProject({ db, project_slug: 't1', llm: llmRankingIds([b.id, a.id]) })
    expect(store.get(b.id)?.llm_rank).toBe(1)
    // Pass 2 with no LLM → deterministic: A (P3) must reclaim rank 1, B drops to 2.
    await prioritizeTasksForProject({ db, project_slug: 't1', llm: null })
    expect(store.get(a.id)?.llm_rank).toBe(1)
    expect(store.get(b.id)?.llm_rank).toBe(2)
    expect(store.get(a.id)?.prioritized_by).toBe('deterministic')
  })

  test('a task created AFTER a pass interleaves by focus_score (not buried)', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 2 })
    const b = await store.create({ project_slug: 't1', title: 'B', priority: 1 })
    const c = await store.create({ project_slug: 't1', title: 'C', priority: 0 })
    // Rank the existing three (deterministic: A>B>C).
    await prioritizeTasksForProject({ db, project_slug: 't1', llm: null })

    // A new URGENT task arrives after the pass — llm_rank stays NULL.
    const urgent = await store.create({ project_slug: 't1', title: 'urgent', priority: 3 })
    expect(store.get(urgent.id)?.llm_rank).toBeNull()

    // It must NOT sort dead-last; with P3 (highest focus) it interleaves
    // near the top, ahead of the lower-focus ranked rows.
    const order = store.list({ project_slug: 't1', order: 'focus_score' }).map((r) => r.id)
    // urgent (fresh, P3) is not last; it sits ahead of B and C at minimum.
    expect(order.indexOf(urgent.id)).toBeLessThan(order.indexOf(b.id))
    expect(order.indexOf(urgent.id)).toBeLessThan(order.indexOf(c.id))
    expect(order[order.length - 1]).toBe(c.id) // lowest focus stays last
  })

  test('ids the LLM omits are appended in deterministic order (no NULL gaps)', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 3 })
    const b = await store.create({ project_slug: 't1', title: 'B', priority: 0 })
    const c = await store.create({ project_slug: 't1', title: 'C', priority: 2 })

    // LLM only ranks B; A and C must still get ranks (focus order: A>C).
    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: llmRankingIds([b.id]),
    })
    expect(result.ranked).toBe(3)
    expect(result.prioritized_by).toBe('llm')
    expect(store.get(b.id)?.llm_rank).toBe(1)
    // A (P3) outranks C (P2) in the deterministic tail.
    expect(store.get(a.id)?.llm_rank).toBe(2)
    expect(store.get(c.id)?.llm_rank).toBe(3)
    // Tail entries carry no LLM reason.
    expect(store.get(a.id)?.llm_reason).toBeNull()
  })
})

describe('prioritizeTasksForProject — deterministic fallback', () => {
  test('no LLM configured → ranks by focus_score, prioritized_by=deterministic', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 1 })
    const b = await store.create({ project_slug: 't1', title: 'B', priority: 3 })

    const result = await prioritizeTasksForProject({ db, project_slug: 't1', llm: null })
    expect(result.prioritized_by).toBe('deterministic')
    expect(result.model_id).toBeNull()
    expect(result.ranked).toBe(2)
    // B (P3) outranks A (P1).
    expect(store.get(b.id)?.llm_rank).toBe(1)
    expect(store.get(a.id)?.llm_rank).toBe(2)
    expect(store.get(b.id)?.prioritized_by).toBe('deterministic')
    expect(store.get(b.id)?.llm_reason).toBeNull()
  })

  test('LLM throws → falls back to deterministic order', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 1 })
    const b = await store.create({ project_slug: 't1', title: 'B', priority: 3 })
    const throwingLlm: LlmCallFn = async () => {
      throw new Error('boom')
    }
    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: throwingLlm,
    })
    expect(result.prioritized_by).toBe('deterministic')
    expect(store.get(b.id)?.llm_rank).toBe(1)
    expect(store.get(a.id)?.llm_rank).toBe(2)
  })

  test('LLM timeout → falls back to deterministic order', async () => {
    const store = new TaskStore(db)
    await store.create({ project_slug: 't1', title: 'A', priority: 1 })
    const hangingLlm: LlmCallFn = () => new Promise<string>(() => {})
    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: hangingLlm,
      timeout_ms: 20,
    })
    expect(result.prioritized_by).toBe('deterministic')
    expect(result.ranked).toBe(1)
  })

  test('unparseable LLM output → falls back to deterministic order', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 1 })
    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: llmReturning('I cannot rank these tasks, sorry.'),
    })
    expect(result.prioritized_by).toBe('deterministic')
    expect(store.get(a.id)?.llm_rank).toBe(1)
  })

  test('LLM returns only out-of-domain ids → fallback (empty valid ranking)', async () => {
    const store = new TaskStore(db)
    const a = await store.create({ project_slug: 't1', title: 'A', priority: 1 })
    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: llmReturning(JSON.stringify({ ranking: [{ id: 'ghost', reason: 'x' }] })),
    })
    expect(result.prioritized_by).toBe('deterministic')
    expect(store.get(a.id)?.llm_rank).toBe(1)
  })

  test('empty backlog → scanned 0, nothing written', async () => {
    const result = await prioritizeTasksForProject({
      db,
      project_slug: 't1',
      llm: llmRankingIds([]),
    })
    expect(result.scanned).toBe(0)
    expect(result.ranked).toBe(0)
  })

  test('only open tasks are ranked; done tasks are skipped', async () => {
    const store = new TaskStore(db)
    const open = await store.create({ project_slug: 't1', title: 'open', priority: 1 })
    const done = await store.create({ project_slug: 't1', title: 'done', priority: 3 })
    await store.complete(done.id)

    const result = await prioritizeTasksForProject({ db, project_slug: 't1', llm: null })
    expect(result.scanned).toBe(1)
    expect(store.get(open.id)?.llm_rank).toBe(1)
    expect(store.get(done.id)?.llm_rank).toBeNull()
  })
})

describe('parseRanking', () => {
  const valid = new Set(['t1', 't2', 't3'])

  test('parses a clean JSON object', () => {
    const out = parseRanking(
      JSON.stringify({ ranking: [{ id: 't2', reason: 'a' }, { id: 't1', reason: 'b' }] }),
      valid,
    )
    expect(out).toEqual([
      { id: 't2', reason: 'a' },
      { id: 't1', reason: 'b' },
    ])
  })

  test('tolerates a ```json fence + trailing prose', () => {
    const raw = 'Sure:\n```json\n{"ranking":[{"id":"t1","reason":"go"}]}\n```\nDone.'
    expect(parseRanking(raw, valid)).toEqual([{ id: 't1', reason: 'go' }])
  })

  test('drops ids not in the valid set and de-dups (first wins)', () => {
    const raw = JSON.stringify({
      ranking: [
        { id: 't1', reason: 'first' },
        { id: 'ghost', reason: 'nope' },
        { id: 't1', reason: 'dupe' },
        { id: 't2' },
      ],
    })
    expect(parseRanking(raw, valid)).toEqual([
      { id: 't1', reason: 'first' },
      { id: 't2', reason: null },
    ])
  })

  test('returns [] for non-JSON / missing ranking array', () => {
    expect(parseRanking('not json', valid)).toEqual([])
    expect(parseRanking(JSON.stringify({ nope: [] }), valid)).toEqual([])
  })
})

describe('buildPrioritizeUserPrompt', () => {
  test('includes id/title/priority/due/focus_score and clamps description', () => {
    const prompt = buildPrioritizeUserPrompt([
      {
        id: 'x',
        title: 'Ship it',
        description: 'd'.repeat(400),
        priority: 3,
        due_date: '2026-07-01T00:00:00.000Z',
        focus_score: 21,
        created_at: '2026-06-20T00:00:00.000Z',
        updated_at: '2026-06-20T00:00:00.000Z',
      },
    ])
    expect(prompt).toContain('"id": "x"')
    expect(prompt).toContain('"priority": 3')
    expect(prompt).toContain('"focus_score": 21')
    // description clamped to 280 chars.
    expect(prompt).toContain('"description": "' + 'd'.repeat(280) + '"')
  })
})

describe('cron wiring', () => {
  test('registers the job + handler', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const handler = buildTaskPrioritizeHandler({ db, llm: null })
    const { job_name } = registerTaskPrioritizeCron({
      project_slug: 't1',
      jobs,
      handlers,
      handler,
    })
    expect(job_name).toBe('tasks-prioritize-t1')
    expect(jobs.get(job_name)?.handler).toBe(TASK_PRIORITIZE_HANDLER_NAME)
    expect(handlers.get(TASK_PRIORITIZE_HANDLER_NAME)).toBeDefined()
  })

  test('handler reports skipped on empty backlog, ok with detail otherwise', async () => {
    const store = new TaskStore(db)
    const handler = buildTaskPrioritizeHandler({ db, llm: null })
    const empty = await handler({
      job_name: 'tasks-prioritize-t1',
      owner_slug: 't1',
      fired_at: Date.now(),
    })
    expect(empty.status).toBe('skipped')

    await store.create({ project_slug: 't1', title: 'one', priority: 2 })
    const ok = await handler({
      job_name: 'tasks-prioritize-t1',
      owner_slug: 't1',
      fired_at: Date.now(),
    })
    expect(ok.status).toBe('ok')
    expect(ok.detail).toContain('by=deterministic')
  })
})

describe('DEFAULT_TASK_PRIORITIZE_MODEL — resolver reference', () => {
  test('DEFAULT_TASK_PRIORITIZE_MODEL equals FAST_MODEL from runtime/models.ts', () => {
    expect(DEFAULT_TASK_PRIORITIZE_MODEL).toBe(FAST_MODEL)
  })
})
