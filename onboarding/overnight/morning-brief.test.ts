import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { OvernightQueueStore } from './queue-store.ts'
import {
  composeGeneralSummary,
  composeProjectDetail,
  runMorningBrief,
  selectWindowTransitions,
  type MorningBriefDeliverInput,
} from './morning-brief.ts'

const WINDOW_DATE = '2026-06-19'
const REPORTER_TIME = Date.parse('2026-06-20T13:55:00Z') // 06:55 PDT → window 2026-06-19

let tmp: string
let db: ProjectDb
let queue: OvernightQueueStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-overnight-brief-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  queue = new OvernightQueueStore(db)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedTerminal(
  id: string,
  owner_slug: string,
  status: 'completed' | 'failed',
  result: string,
  window = WINDOW_DATE,
): Promise<void> {
  await queue.create({ id, owner_slug, description: `task ${id}`, context_relpath: 'docs/x.md' })
  await queue.update(id, {
    status,
    result,
    finished_at: '2026-06-20T06:00:00Z',
    window_date_local: window,
  })
}

describe('selectWindowTransitions', () => {
  test('selects only terminal items finished in the reported window', async () => {
    await seedTerminal('owk-20260619-001', 'acme', 'completed', 'PR#1')
    await seedTerminal('owk-20260619-002', 'acme', 'failed', 'failed: boom')
    // A different window — must be excluded.
    await seedTerminal('owk-20260619-003', 'acme', 'completed', 'PR#9', '2026-06-18')
    // Still queued — excluded.
    await queue.create({ id: 'owk-20260619-004', owner_slug: 'acme', description: 'q' })
    const sel = selectWindowTransitions(queue.list(), WINDOW_DATE)
    expect(sel.map((i) => i.id).sort()).toEqual(['owk-20260619-001', 'owk-20260619-002'])
  })
})

describe('compose (pure, real-results-only)', () => {
  test('general summary counts completed/failed per project', () => {
    const body = composeGeneralSummary(
      [
        {
          slug: 'acme',
          completed: [{ id: 'a' } as never],
          failed: [],
        },
        {
          slug: 'globex',
          completed: [],
          failed: [{ id: 'b' } as never],
        },
      ],
      WINDOW_DATE,
    )
    expect(body).toContain('1 completed, 1 failed across 2 projects')
    expect(body).toContain('- acme: 1 done')
    expect(body).toContain('- globex: 1 failed')
  })

  test('project detail surfaces the real result strings', () => {
    const detail = composeProjectDetail(
      {
        slug: 'acme',
        completed: [{ description: 'Build importer', result: 'PR#42' } as never],
        failed: [{ description: 'Risky', result: 'failed: max rounds' } as never],
      },
      WINDOW_DATE,
    )
    expect(detail).toContain('Build importer → PR#42')
    expect(detail).toContain('Risky → failed: max rounds')
  })

  test('project detail is null when nothing transitioned', () => {
    expect(composeProjectDetail({ slug: 'x', completed: [], failed: [] }, WINDOW_DATE)).toBeNull()
  })
})

describe('runMorningBrief routing', () => {
  test('General summary + per-project detail to bound topics', async () => {
    await seedTerminal('owk-20260619-001', 'acme', 'completed', 'PR#42')
    await seedTerminal('owk-20260619-002', 'globex', 'failed', 'failed: boom')
    const delivered: MorningBriefDeliverInput[] = []
    const res = await runMorningBrief({
      store: queue,
      deliver: (m) => {
        delivered.push(m)
        return true
      },
      general_topic_id: 'general',
      resolveProjectTopic: (slug) => `topic-${slug}`,
      now: () => REPORTER_TIME,
    })
    expect(res.status).toBe('reported')
    expect(res.projects_reported).toBe(2)
    expect(delivered.find((m) => m.topic_id === 'general')?.body).toContain('completed')
    expect(delivered.find((m) => m.topic_id === 'topic-acme')?.body).toContain('PR#42')
    expect(delivered.find((m) => m.topic_id === 'topic-globex')?.body).toContain('boom')
  })

  test('per-project detail falls back to General when no topic is bound', async () => {
    await seedTerminal('owk-20260619-001', 'acme', 'completed', 'PR#42')
    const delivered: MorningBriefDeliverInput[] = []
    await runMorningBrief({
      store: queue,
      deliver: (m) => {
        delivered.push(m)
        return true
      },
      general_topic_id: 'general',
      // no resolveProjectTopic
      now: () => REPORTER_TIME,
    })
    // Both the summary and the detail land on General.
    expect(delivered.filter((m) => m.topic_id === 'general').length).toBe(2)
  })

  test('quiet night: one honest line to General, never invents results', async () => {
    const delivered: MorningBriefDeliverInput[] = []
    const res = await runMorningBrief({
      store: queue,
      deliver: (m) => {
        delivered.push(m)
        return true
      },
      general_topic_id: 'general',
      now: () => REPORTER_TIME,
    })
    expect(res.status).toBe('quiet')
    expect(delivered.length).toBe(1)
    expect(delivered[0]!.topic_id).toBe('general')
    expect(delivered[0]!.body).toContain('quiet night')
    // No fabricated PR / result claims.
    expect(delivered[0]!.body).not.toMatch(/PR#/)
  })
})
