import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-store-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('TridentRunStore', () => {
  test('migration applies — code_trident_runs table exists', () => {
    const row = db
      .prepare<{ name: string }, [string]>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get('code_trident_runs')
    expect(row?.name).toBe('code_trident_runs')
  })

  test('create + get round-trips every column with defaults', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'fix-reminder-api',
      project_slug: 't1',
      repo_path: '/home/x/repos/neutron',
      task: 'Run /slfg to fix the reminder API',
    })
    expect(run.phase).toBe('forge-init')
    expect(run.round).toBe(1)
    expect(run.max_rounds).toBe(8)
    expect(run.ralph).toBe(false)
    expect(run.max_ralph_rounds).toBe(20)
    expect(run.merge_mode).toBe('local')
    expect(run.pr).toBeNull()
    expect(run.subagent_status).toBeNull()
    // #317 — channel_kind defaults to telegram (migration 0081 column default).
    expect(run.channel_kind).toBe('telegram')

    const got = store.get(run.id)
    expect(got).not.toBeNull()
    expect(got?.slug).toBe('fix-reminder-api')
    expect(got?.task).toBe('Run /slfg to fix the reminder API')
    expect(got?.repo_path).toBe('/home/x/repos/neutron')
    expect(got?.started_at).toBe(run.started_at)
    expect(got?.channel_kind).toBe('telegram')
  })

  test('#317 create persists a non-telegram originating channel_kind', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'app-ws-build',
      project_slug: 't1',
      repo_path: '/r',
      task: 'build from the app',
      chat_id: 'web:u1',
      channel_kind: 'app_socket',
    })
    expect(run.channel_kind).toBe('app_socket')
    expect(store.get(run.id)?.channel_kind).toBe('app_socket')
  })

  test('#317 CHECK rejects an invalid channel_kind', async () => {
    const store = new TridentRunStore(db)
    await expect(
      store.create({
        slug: 'bad-ch',
        project_slug: 't1',
        repo_path: '/r',
        task: 't',
        // @ts-expect-error — exercising the DB CHECK with an out-of-enum value
        channel_kind: 'carrier-pigeon',
      }),
    ).rejects.toThrow()
  })

  test('create honours overrides (ralph, merge_mode, caps, routing)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'big-spec-build',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'build the whole spec',
      ralph: true,
      merge_mode: 'pr',
      max_rounds: 12,
      max_ralph_rounds: 30,
      branch: 'feature-x',
      worktree: '/wt/feature-x',
      chat_id: '-100',
      thread_id: '42',
    })
    const got = store.get(run.id)
    expect(got?.ralph).toBe(true)
    expect(got?.merge_mode).toBe('pr')
    expect(got?.max_rounds).toBe(12)
    expect(got?.max_ralph_rounds).toBe(30)
    expect(got?.branch).toBe('feature-x')
    expect(got?.worktree).toBe('/wt/feature-x')
    expect(got?.chat_id).toBe('-100')
    expect(got?.thread_id).toBe('42')
  })

  test('getBySlug is project-scoped + unique', async () => {
    const store = new TridentRunStore(db)
    await store.create({ slug: 'dup', project_slug: 't1', repo_path: '/r', task: 'a' })
    const found = store.getBySlug('t1', 'dup')
    expect(found?.slug).toBe('dup')
    expect(store.getBySlug('t2', 'dup')).toBeNull()
    // unique (project_slug, slug)
    await expect(
      store.create({ slug: 'dup', project_slug: 't1', repo_path: '/r', task: 'b' }),
    ).rejects.toThrow()
  })

  test('update applies a partial patch + re-stamps last_advanced_at', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    expect(run.last_advanced_at).toBe('2026-01-01T00:00:00.000Z')

    clock = '2026-01-01T00:05:00.000Z'
    const updated = await store.update(run.id, {
      phase: 'argus',
      pr: 42,
      branch: 'feat',
      subagent_run_id: 'argus-1',
      subagent_status: 'running',
    })
    expect(updated?.phase).toBe('argus')
    expect(updated?.pr).toBe(42)
    expect(updated?.branch).toBe('feat')
    expect(updated?.subagent_run_id).toBe('argus-1')
    expect(updated?.subagent_status).toBe('running')
    expect(updated?.last_advanced_at).toBe('2026-01-01T00:05:00.000Z')
    // untouched columns survive
    expect(updated?.task).toBe('t')
    expect(updated?.round).toBe(1)
  })

  test('save persists a full run snapshot', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.save({
      ...run,
      phase: 'forge-fix',
      round: 3,
      pr: 7,
      branch: 'b',
      subagent_status: 'completed',
      failure_reason: null,
    })
    const got = store.get(run.id)
    expect(got?.phase).toBe('forge-fix')
    expect(got?.round).toBe(3)
    expect(got?.pr).toBe(7)
  })

  test('listNonTerminal excludes done/failed/stopped, oldest-advanced first', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    clock = '2026-01-01T00:01:00.000Z'
    const b = await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })
    clock = '2026-01-01T00:02:00.000Z'
    const c = await store.create({ slug: 'c', project_slug: 't1', repo_path: '/r', task: 't' })

    // Move two into terminal states.
    await store.save({ ...a, phase: 'done' })
    await store.save({ ...b, phase: 'failed', failure_reason: 'boom' })

    const active = store.listNonTerminal()
    expect(active.map((r) => r.slug)).toEqual(['c'])

    // A 'stopped' run is also excluded.
    await store.save({ ...c, phase: 'stopped' })
    expect(store.listNonTerminal()).toEqual([])
  })

  test('latestByProjectScope returns the most-recently-advanced run, scoped', async () => {
    let clock = '2026-01-01T00:00:00.000Z'
    const store = new TridentRunStore(db, () => clock)
    // No run for a scope → null.
    expect(store.latestByProjectScope('t1')).toBeNull()

    const a = await store.create({ slug: 'a', project_slug: 't1', repo_path: '/r', task: 't' })
    clock = '2026-01-01T00:01:00.000Z'
    const b = await store.create({ slug: 'b', project_slug: 't1', repo_path: '/r', task: 't' })
    // A DIFFERENT scope's run must not leak in.
    await store.create({ slug: 'x', project_slug: 't2', repo_path: '/r', task: 't' })

    // b is newest for t1.
    expect(store.latestByProjectScope('t1')?.id).toBe(b.id)

    // Re-advancing a (a failed terminal) makes it the latest — the durable
    // failure signal the rail reads.
    clock = '2026-01-01T00:05:00.000Z'
    await store.save({ ...a, phase: 'failed', failure_reason: 'boom' })
    const latest = store.latestByProjectScope('t1')
    expect(latest?.id).toBe(a.id)
    expect(latest?.phase).toBe('failed')

    // Scope isolation holds.
    expect(store.latestByProjectScope('t2')?.slug).toBe('x')
    expect(store.latestByProjectScope('nope')).toBeNull()
  })

  test('delete removes a run', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.delete(run.id)
    expect(store.get(run.id)).toBeNull()
  })

  test('CHECK rejects an invalid phase', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await expect(
      db.run(`UPDATE code_trident_runs SET phase = ? WHERE id = ?`, ['bogus', run.id]),
    ).rejects.toThrow()
  })
})
