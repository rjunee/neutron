/**
 * @neutronai/reminders — ritual-runs read/prune helpers + boot-reap driver
 * (plan task 5, T6 crash surfacing).
 *
 * Real migrated DB (mirrors store.test.ts). Covers:
 *   - `listRecentTerminal` excludes 'skipped'/'running', newest-first, limit;
 *   - `listOrphanRunning` returns only 'running';
 *   - `pruneOlderThan` deletes old terminal+skipped, keeps 'running' of any age
 *     and rows at/after the cutoff, returns the count;
 *   - `reapOrphanRitualRuns` flips a seeded orphan 'crashed' + posts one notice,
 *     and is idempotent on a second call.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'

import { createRitualRunStore, type RitualRunStore } from './ritual-runs.ts'
import { reapOrphanRitualRuns } from './ritual-delivery.ts'
import type { ReminderOutbound, ReminderOutboundInput } from './dispatcher.ts'
import type { RitualFireSkipReason } from './rituals.ts'

// DDL↔TS lockstep freeze: EVERY member of the RitualFireSkipReason union must be
// admissible by the real 0106 skip_reason CHECK. If a new member is added to the
// type without the migration + this list, the corresponding case throws
// 'CHECK constraint failed' here. (Blocker A — before the fix, 'gated_tool_surface'
// threw because the CHECK omitted it, wedging the executor into a 30s hot loop.)
const ALL_SKIP_REASONS: RitualFireSkipReason[] = [
  'unknown_ritual',
  'missing_prompt',
  'unapproved',
  'unsupported_scope',
  'gated_tool_surface',
]

let tmp: string
let db: ProjectDb
let runs: RitualRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ritual-runs-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  runs = createRitualRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Insert a live run then drive it terminal at a fixed started_at. */
async function terminalRow(
  run_id: string,
  ritual_id: string,
  started_at: number,
  status: 'finished' | 'failed' | 'timed_out' | 'crashed',
): Promise<void> {
  await runs.insertRunning({
    run_id,
    ritual_id,
    reminder_id: `rem-${run_id}`,
    project_slug: 'owner',
    subagent_run_id: run_id,
    content_hash: 'h',
    now_ms: started_at,
  })
  await runs.markTerminal({ run_id, status, ended_at_ms: started_at + 1 })
}

function recordingOutbound(): { posts: ReminderOutboundInput[]; outbound: ReminderOutbound } {
  const posts: ReminderOutboundInput[] = []
  return {
    posts,
    outbound: {
      post: async (i: ReminderOutboundInput): Promise<boolean> => {
        posts.push(i)
        return true
      },
    },
  }
}

describe('listRecentTerminal', () => {
  test('excludes skipped/running, newest-first, respects limit', async () => {
    await terminalRow('a', 'brief', 100, 'finished')
    await terminalRow('b', 'brief', 200, 'failed')
    await runs.insertSkipped({
      run_id: 'skip-1',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      skip_reason: 'unapproved',
      now_ms: 300,
    })
    await runs.insertRunning({
      run_id: 'live-1',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'live-1',
      content_hash: 'h',
      now_ms: 400,
    })
    await terminalRow('c', 'brief', 500, 'crashed')

    const recent = runs.listRecentTerminal({ ritual_id: 'brief', limit: 4 })
    expect(recent.map((r) => r.run_id)).toEqual(['c', 'b', 'a'])
    // limit respected
    expect(runs.listRecentTerminal({ ritual_id: 'brief', limit: 2 }).map((r) => r.run_id)).toEqual(['c', 'b'])
  })

  test('scoped to the ritual id', async () => {
    await terminalRow('a', 'brief', 100, 'finished')
    await terminalRow('x', 'wrap', 200, 'failed')
    expect(runs.listRecentTerminal({ ritual_id: 'brief', limit: 4 }).map((r) => r.run_id)).toEqual(['a'])
  })

  test('ordered by COMPLETION (ended_at), not start — Argus r1 minor', async () => {
    // Long run A starts FIRST (100) but ends LAST (500). Instant refusal B
    // starts later (200) and ends immediately (200). By start order the newest
    // is B; by completion order the newest is A. The escalation window must see
    // A as most-recent (it finished last).
    await runs.insertRunning({
      run_id: 'A',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'A',
      content_hash: 'h',
      now_ms: 100,
    })
    await runs.insertFailed({
      run_id: 'B',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      failure_reason: 'lane cap',
      now_ms: 200,
    })
    await runs.markTerminal({ run_id: 'A', status: 'failed', ended_at_ms: 500 })
    expect(runs.listRecentTerminal({ ritual_id: 'brief', limit: 4 }).map((r) => r.run_id)).toEqual(['A', 'B'])
  })

  test('includes cancelled terminals in the window — Argus r1 minor', async () => {
    await runs.insertRunning({
      run_id: 'c1',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'c1',
      content_hash: 'h',
      now_ms: 100,
    })
    await runs.markTerminal({ run_id: 'c1', status: 'cancelled', ended_at_ms: 101 })
    const recent = runs.listRecentTerminal({ ritual_id: 'brief', limit: 4 })
    expect(recent.map((r) => r.run_id)).toEqual(['c1'])
    expect(recent[0]!.status).toBe('cancelled')
  })
})

describe('listOrphanRunning', () => {
  test('returns only running rows', async () => {
    await terminalRow('a', 'brief', 100, 'finished')
    await runs.insertRunning({
      run_id: 'live-1',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'live-1',
      content_hash: 'h',
      now_ms: 200,
    })
    await runs.insertRunning({
      run_id: 'live-2',
      ritual_id: 'wrap',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'live-2',
      content_hash: 'h',
      now_ms: 50,
    })
    const orphans = runs.listOrphanRunning()
    // oldest first
    expect(orphans.map((r) => r.run_id)).toEqual(['live-2', 'live-1'])
    expect(orphans.every((r) => r.status === 'running')).toBe(true)
  })
})

describe('pruneOlderThan', () => {
  test('deletes old terminal + skipped rows, keeps running (any age) + rows at/after cutoff', async () => {
    await terminalRow('old-fin', 'brief', 100, 'finished')
    await runs.insertSkipped({
      run_id: 'old-skip',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      skip_reason: 'unapproved',
      now_ms: 150,
    })
    await runs.insertFailed({
      run_id: 'old-fail',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      failure_reason: 'x',
      now_ms: 199,
    })
    // Running row well OLDER than cutoff — must be kept.
    await runs.insertRunning({
      run_id: 'old-running',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'old-running',
      content_hash: 'h',
      now_ms: 10,
    })
    // At-cutoff and newer terminal rows — must be kept (strict <).
    await terminalRow('at-cutoff', 'brief', 200, 'finished')
    await terminalRow('new-fin', 'brief', 300, 'failed')

    const deleted = await runs.pruneOlderThan({ cutoff_ms: 200 })
    expect(deleted).toBe(3)

    const remaining = runs.listByRitual('brief').map((r) => r.run_id).sort()
    expect(remaining).toEqual(['at-cutoff', 'new-fin', 'old-running'].sort())
    // running row survived despite being the oldest of all
    expect(runs.get('old-running')!.status).toBe('running')
  })

  test('no matching rows → returns 0', async () => {
    await runs.insertRunning({
      run_id: 'live',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'live',
      content_hash: 'h',
      now_ms: 5,
    })
    expect(await runs.pruneOlderThan({ cutoff_ms: 1000 })).toBe(0)
  })
})

describe('reapOrphanRitualRuns — T6 crash surfacing', () => {
  test('seeded orphan flips crashed + one notice; idempotent on re-run', async () => {
    await runs.insertRunning({
      run_id: 'orphan-1',
      ritual_id: 'morning-brief',
      reminder_id: 'rem-7',
      project_slug: 'owner',
      subagent_run_id: 'orphan-1',
      content_hash: 'h',
      now_ms: 1000,
    })
    const { posts, outbound } = recordingOutbound()

    const reaped = await reapOrphanRitualRuns({
      runs,
      outbound,
      topic_id: 'app:owner',
      owner_slug: 'owner',
      now: () => 5000,
    })

    expect(reaped.map((r) => r.run_id)).toEqual(['orphan-1'])
    const row = runs.get('orphan-1')!
    expect(row.status).toBe('crashed')
    expect(row.failure_reason).toBe('orphaned by gateway restart (boot reap)')
    expect(row.ended_at).toBe(5000)

    expect(posts).toHaveLength(1)
    expect(posts[0]!.topic_id).toBe('app:owner')
    expect(posts[0]!.reminder_id).toBe('rem-7')
    expect(posts[0]!.body).toMatch(/Ritual '.+' crashed \(run .+\): the gateway restarted/)

    // Idempotent — a second reap sees no 'running' rows, posts nothing.
    const again = await reapOrphanRitualRuns({
      runs,
      outbound,
      topic_id: 'app:owner',
      owner_slug: 'owner',
    })
    expect(again).toHaveLength(0)
    expect(posts).toHaveLength(1)
  })

  test('reap notice failure is swallowed — row still crashed, never throws', async () => {
    await runs.insertRunning({
      run_id: 'orphan-2',
      ritual_id: 'brief',
      reminder_id: null,
      project_slug: 'owner',
      subagent_run_id: 'orphan-2',
      content_hash: 'h',
      now_ms: 1000,
    })
    const throwingOutbound: ReminderOutbound = {
      post: async () => {
        throw new Error('deliver down')
      },
    }
    const reaped = await reapOrphanRitualRuns({
      runs,
      outbound: throwingOutbound,
      topic_id: 'app:owner',
      owner_slug: 'owner',
    })
    expect(reaped).toHaveLength(1)
    expect(runs.get('orphan-2')!.status).toBe('crashed')
  })
})

describe('insertSkipped — DDL↔TS skip_reason lockstep (real 0106 CHECK)', () => {
  test.each(ALL_SKIP_REASONS)(
    'insertSkipped accepts every RitualFireSkipReason member against the real 0106 DDL (CHECK lockstep): %s',
    async (reason) => {
      await runs.insertSkipped({
        run_id: `skip-${reason}`,
        ritual_id: 'r1',
        reminder_id: 'rem-1',
        project_slug: 'owner',
        skip_reason: reason,
        now_ms: 1000,
      })
      const row = runs.get(`skip-${reason}`)!
      expect(row.status).toBe('skipped')
      expect(row.skip_reason).toBe(reason)
    },
  )
})
