/**
 * Staleness engine tests for the P6.1 nudge engine. Exercises the
 * skip-count bump + threshold-crossing demotion + reset cycle by
 * seeding a multi-day pick history.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'
import { TaskStore } from '../../../../tasks/store.ts'
import {
  parseTop3,
  previousDay,
  runStalenessPass,
} from '../staleness-engine.ts'

const OWNER = 'demo'

interface Harness {
  db: ProjectDb
  tasks: TaskStore
  close(): Promise<void>
}

function openHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-staleness-'))
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

async function seedPick(
  db: ProjectDb,
  owner: string,
  day: string,
  picked: string,
  top3: ReadonlyArray<string>,
): Promise<void> {
  await db.run(
    `INSERT INTO current_focus_pick
      (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at, llm_model, llm_request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      owner,
      day,
      picked,
      'because',
      JSON.stringify(top3),
      `${day}T12:00:00.000Z`,
      'test-model',
    ],
  )
}

describe('previousDay', () => {
  it('subtracts one day from a YYYY-MM-DD string', () => {
    expect(previousDay('2026-05-23')).toBe('2026-05-22')
    expect(previousDay('2026-03-01')).toBe('2026-02-28')
    expect(previousDay('2024-03-01')).toBe('2024-02-29') // leap
    expect(previousDay('2026-01-01')).toBe('2025-12-31')
  })
})

describe('parseTop3', () => {
  it('parses valid JSON array of strings', () => {
    expect(parseTop3('["a","b","c"]')).toEqual(['a', 'b', 'c'])
  })
  it('returns empty array on malformed JSON', () => {
    expect(parseTop3('not-json')).toEqual([])
    expect(parseTop3('')).toEqual([])
    expect(parseTop3('{}')).toEqual([])
  })
  it('filters non-string entries', () => {
    expect(parseTop3('["a",2,null,"c"]')).toEqual(['a', 'c'])
  })
})

describe('runStalenessPass', () => {
  let h: Harness

  beforeEach(() => {
    h = openHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('returns early when yesterday has no pick', async () => {
    const result = await runStalenessPass({
      db: h.db,
      project_slug: OWNER,
      today: '2026-05-23',
    })
    expect(result).toEqual({
      bumped: 0,
      demoted: 0,
      yesterday_pick_present: false,
    })
  })

  it('bumps top3_skip_count for unpicked-but-still-open tasks; skips resolved', async () => {
    const open1 = await h.tasks.create({
      project_slug: OWNER,
      title: 'Open task 1',
      priority: 2,
    })
    const open2 = await h.tasks.create({
      project_slug: OWNER,
      title: 'Open task 2',
      priority: 2,
    })
    const picked = await h.tasks.create({
      project_slug: OWNER,
      title: 'Picked task',
      priority: 3,
    })
    const doneTask = await h.tasks.create({
      project_slug: OWNER,
      title: 'Done task',
      priority: 1,
    })
    await h.tasks.complete(doneTask.id)

    await seedPick(h.db, OWNER, '2026-05-22', picked.id, [
      picked.id,
      open1.id,
      open2.id,
      doneTask.id,
    ])

    const result = await runStalenessPass({
      db: h.db,
      project_slug: OWNER,
      today: '2026-05-23',
    })
    expect(result.yesterday_pick_present).toBe(true)
    // open1 + open2 are unpicked-and-still-open → both bumped.
    // doneTask is unpicked-but-resolved → NOT bumped.
    // picked is the pick itself → NOT bumped.
    expect(result.bumped).toBe(2)
    expect(result.demoted).toBe(0)

    interface Row {
      id: string
      top3_skip_count: number
    }
    const rows = h.db
      .prepare<Row, [string]>(
        `SELECT id, top3_skip_count FROM tasks WHERE project_slug = ? ORDER BY title`,
      )
      .all(OWNER)
    const byId = new Map(rows.map((r) => [r.id, r.top3_skip_count]))
    expect(byId.get(open1.id)).toBe(1)
    expect(byId.get(open2.id)).toBe(1)
    expect(byId.get(picked.id)).toBe(0)
    expect(byId.get(doneTask.id)).toBe(0)
  })

  it('demotes tasks that cross the threshold; resets skip-count; bumps demotion-count', async () => {
    const stuck = await h.tasks.create({
      project_slug: OWNER,
      title: 'Always top-3 but never picked',
      priority: 3,
    })
    const picked = await h.tasks.create({
      project_slug: OWNER,
      title: 'Always picked',
      priority: 3,
    })

    // Manually stamp the initial focus_score so the demotion math has
    // something to halve.
    await h.db.run(
      `UPDATE tasks SET focus_score = 10 WHERE id = ?`,
      [stuck.id],
    )

    // Seed 3 days of pick history with `stuck` in top-3 but never picked.
    await seedPick(h.db, OWNER, '2026-05-20', picked.id, [picked.id, stuck.id])
    await seedPick(h.db, OWNER, '2026-05-21', picked.id, [picked.id, stuck.id])
    await seedPick(h.db, OWNER, '2026-05-22', picked.id, [picked.id, stuck.id])

    // Pass 1 (reads 05-20 → bumps stuck to 1)
    await runStalenessPass({ db: h.db, project_slug: OWNER, today: '2026-05-21' })
    // Pass 2 (reads 05-21 → bumps to 2)
    await runStalenessPass({ db: h.db, project_slug: OWNER, today: '2026-05-22' })
    // Pass 3 (reads 05-22 → bumps to 3, crosses threshold, demotes)
    const r3 = await runStalenessPass({
      db: h.db,
      project_slug: OWNER,
      today: '2026-05-23',
      demotion_threshold: 3,
      decay_factor: 0.5,
    })

    expect(r3.bumped).toBe(1)
    expect(r3.demoted).toBe(1)

    interface Row {
      focus_score: number | null
      staleness_demoted_at: string | null
      staleness_demotion_count: number
      top3_skip_count: number
    }
    const row = h.db
      .prepare<Row, [string]>(
        `SELECT focus_score, staleness_demoted_at, staleness_demotion_count, top3_skip_count
           FROM tasks WHERE id = ?`,
      )
      .get(stuck.id)
    expect(row).not.toBeNull()
    expect(row!.focus_score).toBe(5)
    expect(row!.staleness_demoted_at).not.toBeNull()
    expect(row!.staleness_demotion_count).toBe(1)
    expect(row!.top3_skip_count).toBe(0)
  })

  it('handles malformed top_3_task_ids gracefully', async () => {
    const picked = await h.tasks.create({
      project_slug: OWNER,
      title: 'Picked',
    })
    await h.db.run(
      `INSERT INTO current_focus_pick
         (project_slug, day, task_id, llm_rationale, top_3_task_ids, created_at, llm_model, llm_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        OWNER,
        '2026-05-22',
        picked.id,
        'r',
        'not-valid-json',
        '2026-05-22T12:00:00Z',
        'm',
      ],
    )

    const result = await runStalenessPass({
      db: h.db,
      project_slug: OWNER,
      today: '2026-05-23',
    })
    expect(result.yesterday_pick_present).toBe(true)
    expect(result.bumped).toBe(0)
    expect(result.demoted).toBe(0)
  })
})
