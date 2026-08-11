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

  test('crash marker beats a stale running tick, then permits the crash-to-failed save (#514)', async () => {
    const store = new TridentRunStore(db)
    const created = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(created.id, {
      subagent_status: 'running',
      subagent_run_id: 'wf-1',
      workflow_run_id: 'launcher-a',
    })
    const staleTickSnapshot = store.get(created.id)!

    await store.crashRunningByLauncher('launcher-a', 'pooled child exited')
    // Mutation killed: removing the subagent_status guard lets this stale full
    // snapshot overwrite `crashed` back to `running`.
    expect(await store.saveIfActive(staleTickSnapshot)).toBe(false)
    expect(store.get(created.id)?.subagent_status).toBe('crashed')

    const crashSnapshot = store.get(created.id)!
    expect(await store.saveIfActive({ ...crashSnapshot, phase: 'failed' })).toBe(true)
    expect(store.get(created.id)?.phase).toBe('failed')
  })

  test('one stale launcher key cannot crash a healthy rotated-key run (#514)', async () => {
    const store = new TridentRunStore(db)
    const stale = await store.create({ slug: 'stale', project_slug: 't1', repo_path: '/same', task: 'old' })
    const healthy = await store.create({ slug: 'healthy', project_slug: 't1', repo_path: '/same', task: 'new' })
    await store.update(stale.id, { subagent_status: 'running', workflow_run_id: 'credential-a-key' })
    await store.update(healthy.id, { subagent_status: 'running', workflow_run_id: 'credential-b-key' })

    await store.crashRunningByLauncher('credential-a-key', 'old child exited')

    // Mutation killed: replacing launcher-key ownership with repo_path marks
    // both rows crashed and destroys the healthy rotated-key workflow.
    expect(store.get(stale.id)?.subagent_status).toBe('crashed')
    expect(store.get(healthy.id)?.subagent_status).toBe('running')
  })

  test('a crashed child generation does not poison the next generation in the same pool slot (#514)', async () => {
    const store = new TridentRunStore(db)
    await store.crashRunningByLauncher('pool-generation-1', 'old child exited')
    const fresh = await store.create({ slug: 'fresh', project_slug: 't1', repo_path: '/same', task: 'new' })
    const freshSnapshot = {
      ...fresh,
      subagent_status: 'running' as const,
      workflow_run_id: 'pool-generation-2',
    }

    // Mutation killed: using the stable pool key for both incarnations makes
    // this save lose forever and re-fire a new detached workflow every tick.
    expect(await store.saveIfActive(freshSnapshot)).toBe(true)
    expect(store.get(fresh.id)?.subagent_status).toBe('running')
  })

  test('update cannot resurrect a row after the crash sink wins (#514)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'update-race', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { subagent_status: 'running', workflow_run_id: 'generation-a' })
    await store.crashRunningByLauncher('generation-a', 'child exited')

    // Mutation killed: removing update's crashed-state predicate lets an
    // out-of-band partial writer resurrect the phantom running row.
    await store.update(run.id, { subagent_status: 'running' })
    expect(store.get(run.id)?.subagent_status).toBe('crashed')
  })

  test('a crash committed before launch persistence vetoes the racing running snapshot (#514)', async () => {
    const store = new TridentRunStore(db)
    const created = await store.create({ slug: 'race', project_slug: 't1', repo_path: '/r', task: 't' })
    const firedSnapshot = {
      ...created,
      subagent_status: 'running' as const,
      subagent_run_id: 'wf-race',
      workflow_run_id: 'dead-before-save',
    }

    await store.crashRunningByLauncher('dead-before-save', 'child exited before tick save')

    // Mutation killed: deleting the launcher-crash NOT EXISTS predicate lets
    // the detached workflow persist as running after its owning child died.
    expect(await store.saveIfActive(firedSnapshot)).toBe(false)
    expect(store.get(created.id)?.subagent_status).toBe('crashed')
    expect(store.get(created.id)?.failure_reason).toBe('child exited before tick save')
  })

  describe('terminalTransition — atomic conditional terminal write (§F6a race guard)', () => {
    test('wins on a non-terminal run: flips the phase + reason and reports won', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
      const res = await store.terminalTransition(run.id, { phase: 'stopped', failure_reason: 'user cancel' })
      expect(res.won).toBe(true)
      expect(res.run?.phase).toBe('stopped')
      expect(res.run?.failure_reason).toBe('user cancel')
      expect(store.get(run.id)?.phase).toBe('stopped')
    })

    test('LOSES against an already-terminal run: no clobber, no phantom win', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
      // Simulate the tick loop persisting a real `done` result + delivery.
      await store.save({ ...run, phase: 'done' })
      // A racing board delete tries to cancel the SAME run.
      const res = await store.terminalTransition(run.id, { phase: 'stopped', failure_reason: 'user cancel' })
      // The SQL `AND phase NOT IN (terminal)` predicate matched no row.
      expect(res.won).toBe(false)
      // The real result stands — NOT overwritten to `stopped`, reason untouched.
      expect(res.run?.phase).toBe('done')
      expect(res.run?.failure_reason).toBeNull()
      expect(store.get(run.id)?.phase).toBe('done')
    })

    test('two concurrent transitions on one run: exactly one wins', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 's', project_slug: 't1', repo_path: '/r', task: 't' })
      const [a, b] = await Promise.all([
        store.terminalTransition(run.id, { phase: 'stopped' }),
        store.terminalTransition(run.id, { phase: 'failed' }),
      ])
      expect([a.won, b.won].filter(Boolean).length).toBe(1)
      // The row is terminal at whichever phase the winner wrote (never a mix).
      const finalPhase = store.get(run.id)?.phase
      expect(finalPhase === 'stopped' || finalPhase === 'failed').toBe(true)
    })

    test('missing run → run null, not won', async () => {
      const store = new TridentRunStore(db)
      const res = await store.terminalTransition('does-not-exist', { phase: 'stopped' })
      expect(res.run).toBeNull()
      expect(res.won).toBe(false)
    })
  })
})

describe('terminalTransition retracts a stale in-flight claim', () => {
  // Observed live 2026-08-10: the owner cancelled a running build and the row sat at
  // `phase='stopped'` with `subagent_status='running'`. The child was already dead and
  // the column still claimed it was working.
  //
  // Not cosmetic — gates key on this column. #143's fix widened the harvest/terminal
  // block on `subagent_status === 'crashed'`, and the hang-watchdog and orphan-recovery
  // read it too, so a terminal row reading `running` is exactly the stale field those
  // readers can act on.

  async function runAt(status: 'running' | 'crashed' | 'completed' | null) {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'email-core-p1',
      project_slug: 'neutron-open',
      repo_path: '/repos/neutron-open',
      task: 'build the email core',
    })
    if (status !== null) await store.update(run.id, { subagent_status: status })
    // Non-empty precondition: without this the assertions below could pass on a row
    // that never carried the claim in the first place.
    expect(store.get(run.id)?.subagent_status).toBe(status)
    return { store, id: run.id }
  }

  test('cancelling a RUNNING build clears the running claim, and keeps the reason', async () => {
    const { store, id } = await runAt('running')

    const { won } = await store.terminalTransition(id, {
      phase: 'stopped',
      failure_reason: 'cancelled via codegen_cancel',
    })

    expect(won).toBe(true)
    const after = store.get(id)
    expect(after?.phase).toBe('stopped')
    expect(after?.subagent_status).toBeNull()
    // The reason survives, so nulling the status loses no information.
    expect(after?.failure_reason).toBe('cancelled via codegen_cancel')
  })

  test('a CRASHED marker SURVIVES — this restriction is load-bearing, not incidental', async () => {
    // Nulling unconditionally would erase 'crashed' whenever anything terminated an
    // already-crashed run as 'failed', deleting the signal #143 added a gate for while
    // looking like a cleanup. Only 'running' is a live CLAIM; the others are OUTCOMES.
    const { store, id } = await runAt('crashed')

    await store.terminalTransition(id, { phase: 'failed', failure_reason: 'reaped' })

    expect(store.get(id)?.subagent_status).toBe('crashed')
  })

  test('a COMPLETED outcome also survives', async () => {
    const { store, id } = await runAt('completed')

    await store.terminalTransition(id, { phase: 'done', failure_reason: null })

    expect(store.get(id)?.subagent_status).toBe('completed')
  })

  test('a run with no subagent status stays null', async () => {
    const { store, id } = await runAt(null)

    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'cancelled' })

    expect(store.get(id)?.subagent_status).toBeNull()
  })

  test('a LOSER transition does not touch the status either', async () => {
    // The atomic guard means a second terminate finds the row already terminal and
    // writes nothing. It must not clear a status on the way past.
    const { store, id } = await runAt('running')
    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'first' })
    await store.update(id, { subagent_status: 'crashed' })

    const second = await store.terminalTransition(id, { phase: 'failed', failure_reason: 'second' })

    expect(second.won).toBe(false)
    expect(store.get(id)?.subagent_status).toBe('crashed')
    expect(store.get(id)?.failure_reason).toBe('first')
  })

  test('with NO failure_reason — the SHORT params branch — binding is still correct', async () => {
    // The CASE takes no bound parameter, so it sits in the SET list between two
    // clauses that DO. Omitting `failure_reason` makes `params` one shorter, and
    // this is not a rare shape: the board X-cancel (`work-board-surface.ts`) and
    // `/code stop` (`code-command.ts`) BOTH terminate without a reason, so two of
    // the four production callers take this branch. An off-by-one here would be
    // silent — the timestamp would land in `phase`, or the phase in a column
    // nothing asserts on — so pin the columns individually, not just the status.
    const { store, id } = await runAt('running')
    await store.update(id, { failure_reason: 'pre-existing reason' })
    const before = store.get(id)!.last_advanced_at

    const { won } = await store.terminalTransition(id, { phase: 'failed' })

    expect(won).toBe(true)
    const after = store.get(id)!
    expect(after.phase).toBe('failed') // not a timestamp
    expect(after.subagent_status).toBeNull()
    // An untouched column, so a stray bound value would show up here.
    expect(after.failure_reason).toBe('pre-existing reason')
    expect(Number.isFinite(Date.parse(after.last_advanced_at))).toBe(true)
    expect(after.last_advanced_at >= before).toBe(true)
  })

  test('a preserved CRASHED latch still vetoes a later update() — the restriction is load-bearing HERE', async () => {
    // The comment justifies keeping 'crashed' by #143's harvest gate, but `step()`
    // no-ops on an already-terminal phase (`orchestrator.ts:680-683`), so that gate
    // is unreachable once the row is terminal. This is the path where preserving it
    // still bites: `update()` is the ONE writer with no `phase NOT IN (terminal)`
    // guard, so its `subagent_status IS NOT 'crashed'` veto (`store.ts:447-449`) is
    // all that latches a crash on a terminal row. Nulling unconditionally would lift
    // that veto — which is the real reason a future "simplify to NULL" must not land.
    const { store, id } = await runAt('crashed')

    await store.terminalTransition(id, { phase: 'failed' })
    expect(store.get(id)?.subagent_status).toBe('crashed')

    await store.update(id, { subagent_status: 'completed' })

    expect(store.get(id)?.subagent_status).toBe('crashed')
  })
})
