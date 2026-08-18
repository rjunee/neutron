import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { changeSignatureEntries, COLS, TridentRunStore } from './store.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-store-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('claimAgentWake', () => {
  test('returns true exactly once for a terminal run', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'wake-failed', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { phase: 'failed' })

    expect(await store.claimAgentWake(run.id)).toBe(true)
    expect(await store.claimAgentWake(run.id)).toBe(false)
  })

  test('returns false for a non-terminal run', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'wake-active', project_slug: 't1', repo_path: '/r', task: 't' })
    expect(await store.claimAgentWake(run.id)).toBe(false)
  })

  test('returns false for an unknown id', async () => {
    const store = new TridentRunStore(db)
    expect(await store.claimAgentWake('missing')).toBe(false)
  })

  test('claim survives a full snapshot save', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'wake-save', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { phase: 'done' })
    expect(await store.claimAgentWake(run.id)).toBe(true)

    await store.save(store.get(run.id)!)
    expect(await store.claimAgentWake(run.id)).toBe(false)
  })
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
    expect(run.max_rounds).toBe(10)
    expect(run.ralph).toBe(false)
    expect(run.max_ralph_rounds).toBe(20)
    expect(run.merge_mode).toBe('local')
    expect(run.pr).toBeNull()
    expect(run.base_sha).toBeNull()
    expect(run.base_behind).toBeNull()
    expect(run.subagent_status).toBeNull()
    expect(run.infra_retries).toBe(0)
    // #317 — channel_kind defaults to telegram (migration 0081 column default).
    expect(run.channel_kind).toBe('telegram')

    const got = store.get(run.id)
    expect(got).not.toBeNull()
    expect(got?.slug).toBe('fix-reminder-api')
    expect(got?.task).toBe('Run /slfg to fix the reminder API')
    expect(got?.repo_path).toBe('/home/x/repos/neutron')
    expect(got?.started_at).toBe(run.started_at)
    expect(got?.channel_kind).toBe('telegram')
    expect(got?.infra_retries).toBe(0)
  })

  test('base pin columns round-trip through update, save, and saveIfActive', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'base-pin', project_slug: 't1', repo_path: '/r', task: 't' })
    const sha = 'b'.repeat(40)
    const updated = await store.update(run.id, { base_sha: sha, base_behind: 16 })
    expect(updated?.base_sha).toBe(sha)
    expect(updated?.base_behind).toBe(16)
    await store.save({ ...updated!, base_behind: 17 })
    expect(store.get(run.id)?.base_behind).toBe(17)
    expect(await store.saveIfActive({ ...store.get(run.id)!, base_behind: 18 })).toBe(true)
    expect(store.get(run.id)?.base_behind).toBe(18)
  })

  test('the checkpoint OID + findings start NULL and round-trip through update (0122)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({
      slug: 'resume-columns',
      project_slug: 't1',
      repo_path: '/r',
      task: 'build the thing',
    })
    // A fresh run has no checkpoint, so it has no commit to be about either.
    expect(run.inner_checkpoint_head).toBeNull()
    expect(run.inner_checkpoint_findings).toBeNull()

    const head = 'a'.repeat(40)
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_head: head,
      inner_checkpoint_findings: '[{"severity":"blocker"}]',
    })
    const got = store.get(run.id)
    expect(got?.inner_checkpoint_head).toBe(head)
    expect(got?.inner_checkpoint_findings).toBe('[{"severity":"blocker"}]')
  })

  test('save() leaves the checkpoint OID + findings alone (WORKFLOW-OWNED, like inner_result)', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'resume-save', project_slug: 't1', repo_path: '/r', task: 't' })
    const head = 'a'.repeat(40)
    await store.update(run.id, {
      inner_checkpoint: 'argus-request-changes',
      inner_checkpoint_head: head,
      inner_checkpoint_findings: '[{"severity":"blocker"}]',
    })

    // An outer-loop snapshot whose in-memory copy carries stale nulls must not
    // strip the OID off a checkpoint the detached workflow wrote — a name paired
    // with a MISSING (or, worse, a stale) OID is exactly what a resume reads to
    // decide whether prior review work may be trusted.
    const stale = { ...store.get(run.id)!, inner_checkpoint_head: null, inner_checkpoint_findings: null }
    await store.save(stale)

    const got = store.get(run.id)
    expect(got?.inner_checkpoint_head).toBe(head)
    expect(got?.inner_checkpoint_findings).toBe('[{"severity":"blocker"}]')
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

  describe('beginCrashRecovery — the atomic claim that recovers a killed launcher', () => {
    test('claims a crashed run: latch cleared, slot + dead generation released, budget spent', async () => {
      let clock = '2026-08-14T07:13:00.000Z'
      const store = new TridentRunStore(db, () => clock)
      const run = await store.create({ slug: 'claim', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(run.id, {
        subagent_status: 'running', subagent_run_id: 'wf-1', workflow_run_id: 'gen-dead',
      })
      await store.crashRunningByLauncher('gen-dead', 'pooled child exited')
      clock = '2026-08-14T07:14:32.000Z'

      const claimed = await store.beginCrashRecovery(run.id)

      expect(claimed).not.toBeNull()
      expect(claimed?.subagent_status).toBeNull()
      expect(claimed?.subagent_run_id).toBeNull()
      // Nulled so `launch()`'s `?? workflow_run_id` fallback cannot re-adopt a
      // generation that already carries a durable crash tombstone.
      expect(claimed?.workflow_run_id).toBeNull()
      expect(claimed?.crash_recoveries).toBe(1)
      expect(claimed?.last_advanced_at).toBe('2026-08-14T07:14:32.000Z')
    })

    test('a post-claim `running` save with a FRESH generation LANDS — the veto no longer blocks', async () => {
      // The whole point of clearing the latch out-of-band: with it still set,
      // `saveIfActive` vetoes every non-crashed write and the relaunch could never
      // persist. Mutation killed: drop `subagent_status = NULL` from the claim.
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 'relaunch', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(run.id, { subagent_status: 'running', workflow_run_id: 'gen-dead' })
      await store.crashRunningByLauncher('gen-dead', 'pooled child exited')
      const claimed = (await store.beginCrashRecovery(run.id))!

      const landed = await store.saveIfActive({
        ...claimed, subagent_status: 'running', subagent_run_id: 'wf-2', workflow_run_id: 'gen-fresh',
      })

      expect(landed).toBe(true)
      expect(store.get(run.id)?.subagent_status).toBe('running')
    })

    test('the claim LOSES on a terminal row and on a non-crashed row — no budget spent', async () => {
      const store = new TridentRunStore(db)
      // Terminal: a build cancelled between the crash latch and this tick.
      const dead = await store.create({ slug: 'dead', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(dead.id, { subagent_status: 'running', workflow_run_id: 'gen-a' })
      await store.crashRunningByLauncher('gen-a', 'pooled child exited')
      await store.terminalTransition(dead.id, { phase: 'stopped' })
      expect(await store.beginCrashRecovery(dead.id)).toBeNull()
      expect(store.get(dead.id)?.crash_recoveries).toBe(0)
      expect(store.get(dead.id)?.phase).toBe('stopped')

      // Not crashed: a healthy in-flight run must never be reset by a stray claim
      // (and a second tick racing the first loses cleanly, for the same reason).
      const live = await store.create({ slug: 'live', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(live.id, { subagent_status: 'running', workflow_run_id: 'gen-b' })
      expect(await store.beginCrashRecovery(live.id)).toBeNull()
      expect(store.get(live.id)?.crash_recoveries).toBe(0)
      expect(store.get(live.id)?.subagent_status).toBe('running')
      expect(store.get(live.id)?.workflow_run_id).toBe('gen-b')

      // A vanished row is not a claim either.
      expect(await store.beginCrashRecovery('no-such-run')).toBeNull()
    })
  })

  describe('beginInfraRetry — the single-writer executor/transport retry claim', () => {
    test('increments durably and clears result + every dispatch slot in one claim', async () => {
      let clock = '2026-08-14T20:10:00.000Z'
      const store = new TridentRunStore(db, () => clock)
      const run = await store.create({ slug: 'infra-claim', project_slug: 't1', repo_path: '/r', task: 't' })
      await store.update(run.id, {
        subagent_run_id: 'wf-1',
        subagent_status: 'completed',
        workflow_run_id: 'generation-1',
        inner_result: '{"verdict":"REQUEST_CHANGES"}',
      })
      clock = '2026-08-14T20:11:00.000Z'

      const claimed = await store.beginInfraRetry(run.id)

      expect(claimed).toMatchObject({
        infra_retries: 1,
        inner_result: null,
        subagent_run_id: null,
        subagent_status: null,
        workflow_run_id: null,
        last_advanced_at: clock,
      })
      expect(claimed?.round).toBe(1)
      expect(claimed?.ralph_round).toBe(0)
      expect(claimed?.harvested_at).toBeNull()
    })

    test('legacy NULL reads as zero and update() cannot write the owned counter', async () => {
      const store = new TridentRunStore(db)
      const run = await store.create({ slug: 'infra-owned', project_slug: 't1', repo_path: '/r', task: 't' })
      await db.run(`UPDATE code_trident_runs SET infra_retries = NULL WHERE id = ?`, [run.id])
      expect(store.get(run.id)?.infra_retries).toBe(0)

      await store.update(run.id, {
        // @ts-expect-error — the durable retry budget is deliberately not patchable.
        infra_retries: 99,
      })
      expect(store.get(run.id)?.infra_retries).toBe(0)
    })
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

describe('round persistence (canary)', () => {
  test('update() derives round from a fix checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-update', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, { inner_checkpoint: 'fix-round-3' })

    expect(store.get(run.id)?.round).toBe(3)
    expect(store.get(run.id)?.inner_checkpoint).toBe('fix-round-3')
  })

  test('update() keeps round monotonic while storing an older checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-monotonic', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(run.id, { inner_checkpoint: 'fix-round-3' })

    await store.update(run.id, { inner_checkpoint: 'fix-round-2' })

    expect(store.get(run.id)?.round).toBe(3)
    expect(store.get(run.id)?.inner_checkpoint).toBe('fix-round-2')
  })

  test('update() does not guess a round from an unrelated checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-no-guess', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, { inner_checkpoint: 'argus-approved' })

    expect(store.get(run.id)?.round).toBe(1)
  })

  test('update() lets an explicit round win without a duplicate SET', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-explicit', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, { round: 9, inner_checkpoint: 'fix-round-4' })

    expect(store.get(run.id)?.round).toBe(9)
  })

  test('update() persists outer-published group 3 as the round', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-published', project_slug: 't1', repo_path: '/r', task: 't' })

    await store.update(run.id, {
      inner_checkpoint: `outer-published:${'b'.repeat(40)}:2:6`,
    })

    expect(store.get(run.id)?.round).toBe(6)
  })

  test('saveIfActive() derives round from a fix checkpoint', async () => {
    const store = new TridentRunStore(db)
    const run = await store.create({ slug: 'round-save-active', project_slug: 't1', repo_path: '/r', task: 't' })

    expect(await store.saveIfActive({ ...store.get(run.id)!, inner_checkpoint: 'fix-round-5' })).toBe(true)

    expect(store.get(run.id)?.round).toBe(5)
  })

  test('save() derives round and never lowers the stored value from a stale snapshot', async () => {
    const store = new TridentRunStore(db)
    const staleRun = await store.create({ slug: 'round-save-stale', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.update(staleRun.id, { inner_checkpoint: 'fix-round-5' })

    await store.save({ ...staleRun, round: 1, inner_checkpoint: 'argus-approved' })

    expect(store.get(staleRun.id)?.round).toBe(5)

    const derivedRun = await store.create({ slug: 'round-save-derived', project_slug: 't1', repo_path: '/r', task: 't' })
    await store.save({ ...store.get(derivedRun.id)!, inner_checkpoint: 'fix-round-4' })
    expect(store.get(derivedRun.id)?.round).toBe(4)
  })
})

describe('terminalTransition retracts a stale in-flight claim', () => {
  // Observed live 2026-08-10: the owner cancelled a running build and the row sat at
  // `phase='stopped'` with `subagent_status='running'` — a finished run still
  // presenting itself as working. Whether the child process was still alive is a
  // separate question (usually it is — #177), and it is why the fix
  // needs a durability half in `trident/checkpoint.sh` as well as this write.
  //
  // Not cosmetic, but not for the reason it is tempting to write down either: #143's
  // harvest gate and orphan recovery never see a terminal row (`step()` returns early
  // on `isTerminalPhase`), and the hang watchdog keys on `last_advanced_at`. The
  // reader that IS load-bearing is the CRASH VETO on `update()` — the ONE writer
  // with no `phase NOT IN (terminal)` predicate, so its `AND subagent_status IS NOT
  // 'crashed'` is all that latches a crash on a terminal row (`saveIfActive()` has
  // the same veto but also the phase predicate, so on a terminal row it is
  // unreachable). Hence the 'crashed'-survives cases below must never regress.

  // Every value migration 0077's `subagent_status` CHECK admits, plus null. The
  // matrix below covers ALL of them: a case-by-case CASE is exactly the kind of
  // code where one unlisted value silently takes the wrong branch.
  async function runAt(status: 'running' | 'pending' | 'completed' | 'failed' | 'crashed' | null) {
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

  test("a PENDING claim is retracted too — 'pending' asserts a child just as 'running' does", async () => {
    // Not currently written by any production path (the orchestrator writes only
    // running/completed/failed/crashed/null), but it is in the type and in migration
    // 0077's CHECK, and it means "about to be in flight" — a claim, not an outcome. If
    // a writer ever appears, a cancelled run must not be left asserting it.
    const { store, id } = await runAt('pending')

    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'cancelled' })

    expect(store.get(id)?.subagent_status).toBeNull()
  })

  test('a CRASHED marker SURVIVES — this restriction is load-bearing, not incidental', async () => {
    // Nulling unconditionally would erase 'crashed' whenever anything terminated an
    // already-crashed run as 'failed', silently disarming `update()`'s crash veto while
    // looking like a cleanup. NOT `saveIfActive()`'s identical veto — that statement also
    // carries `phase NOT IN (terminal)`, so on the row this test produces it cannot land
    // at all and its veto is unreachable (see the docblock over `terminalTransition`).
    // 'running'/'pending' are live CLAIMS; the others are OUTCOMES.
    const { store, id } = await runAt('crashed')

    await store.terminalTransition(id, { phase: 'failed', failure_reason: 'reaped' })

    expect(store.get(id)?.subagent_status).toBe('crashed')
  })

  test('a COMPLETED outcome also survives', async () => {
    const { store, id } = await runAt('completed')

    await store.terminalTransition(id, { phase: 'done', failure_reason: null })

    expect(store.get(id)?.subagent_status).toBe('completed')
  })

  test("a FAILED outcome survives too — the last value the CHECK admits, and the one most easily forgotten", async () => {
    // 'failed' is the fifth and last value in migration 0077's subagent_status
    // CHECK, and the only one this matrix originally missed. Without it a mutant
    // that ALSO cleared 'failed' (`IN ('running','pending','failed')`) passed the
    // whole suite while erasing the subagent-level outcome of every failed build.
    const { store, id } = await runAt('failed')

    await store.terminalTransition(id, { phase: 'failed', failure_reason: 'the build failed' })

    expect(store.get(id)?.subagent_status).toBe('failed')
  })

  test('a run with no subagent status stays null', async () => {
    const { store, id } = await runAt(null)

    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'cancelled' })

    expect(store.get(id)?.subagent_status).toBeNull()
  })

  test('a LOSER transition writes NOTHING — not even a status the CASE would have cleared', async () => {
    // The atomic guard means a second terminate finds the row already terminal and
    // writes nothing at all. Pinning that with a 'crashed' status could not prove it:
    // the CASE preserves 'crashed' anyway, so the assertion would pass whether the
    // loser wrote nothing or wrote the preserving CASE. Put back the one value the
    // CASE *would* clear — if the loser's UPDATE landed, this goes null.
    const { store, id } = await runAt('running')
    await store.terminalTransition(id, { phase: 'stopped', failure_reason: 'first' })
    expect(store.get(id)?.subagent_status).toBeNull() // the winner retracted it
    await store.update(id, { subagent_status: 'running' })
    expect(store.get(id)?.subagent_status).toBe('running')

    const second = await store.terminalTransition(id, { phase: 'failed', failure_reason: 'second' })

    // Row state FIRST, deliberately: asserting `won` first would short-circuit the
    // failure and hide which part of the loser's write leaked.
    expect(store.get(id)?.subagent_status).toBe('running')
    expect(store.get(id)?.phase).toBe('stopped')
    expect(store.get(id)?.failure_reason).toBe('first')
    expect(second.won).toBe(false)
  })

  test('with NO failure_reason — the SHORT params branch — binding is still correct', async () => {
    // The CASE takes no bound parameter, so it sits in the SET list between two
    // clauses that DO. Omitting `failure_reason` makes `params` one shorter, and
    // this is not a rare shape: the board X-cancel (`work-board-surface.ts`) and
    // `/code stop` (`code-command.ts`) BOTH terminate without a reason, so two of
    // the four production callers take this branch. An off-by-one would either
    // fail LOUDLY (a timestamp bound to `phase` violates 0077's phase CHECK) or
    // land QUIETLY in a column nothing asserts on — `failure_reason` being the one
    // this shape would actually hit — so pin the columns individually rather than
    // trusting the status assertion plus the CHECK to catch every shift.
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
    // The tempting justification for keeping 'crashed' is #143's harvest gate, and it
    // is wrong: `step()` no-ops on an already-terminal phase
    // (`orchestrator.ts:678-683`), so that gate is unreachable once the row is
    // terminal. This is the path where preserving it still bites: of the writers that
    // can reach a terminal row, `update()` is the only one that both lacks a
    // `phase NOT IN (terminal)` guard and carries the `subagent_status IS NOT 'crashed'`
    // veto (`store.ts:447-449`), so that veto is all that latches a crash there.
    // (`saveIfActive` has the veto but also the phase predicate; `save` has neither, and
    // is inert only because nothing in production calls it.) Nulling unconditionally
    // would lift the veto — the real reason a future "simplify to NULL" must not land.
    const { store, id } = await runAt('crashed')

    await store.terminalTransition(id, { phase: 'failed' })
    expect(store.get(id)?.subagent_status).toBe('crashed')

    await store.update(id, { subagent_status: 'completed' })

    expect(store.get(id)?.subagent_status).toBe('crashed')
  })
})

describe('INSERT column/placeholder/bound-array alignment — the silent-corruption guard (BLOCKING addendum)', () => {
  test('COLS matches the 37 snapshot-writable table columns', () => {
    // The INSERT placeholder list is derived from COLS, so placeholder count =
    // column count by construction. What is NOT free is COLS agreeing with the
    // TABLE: a column added, dropped or renamed by a migration without touching
    // COLS corrupts every insert silently (STRICT only catches affinity, not
    // arity/order). The literal 37 is deliberate — adding a column must be a
    // conscious edit here, not an invisible drift.
    const cols = COLS.split(', ')
    const pragma = db
      .prepare<{ name: string }, []>(`PRAGMA table_info(code_trident_runs)`)
      .all()

    expect(cols).toHaveLength(37)
    // agent_waked_at is deliberately absent from COLS: claimAgentWake is its sole
    // writer, so a full snapshot can never clear an already-won delivery claim.
    // The table therefore has 38 columns and COLS has 37 — compare against the
    // snapshot-writable set, not the raw pragma count.
    const snapshotWritable = pragma.filter((c) => c.name !== 'agent_waked_at')
    expect(cols).toHaveLength(snapshotWritable.length)
    // Same members, order-independent: a rename or a drop goes red.
    expect([...cols].sort()).toEqual([...snapshotWritable.map((c) => c.name)].sort())
  })

  test('FIX-ROUND CONTRACT fields round-trip and default to unconstrained nulls', async () => {
    const store = new TridentRunStore(db)
    const reviewedHead = 'a'.repeat(40)
    const constrained = await store.create({
      slug: 'contract-set', project_slug: 't1', repo_path: '/r', task: 't',
      reviewed_head: reviewedHead, bound_pr: 289, fenced_paths: '["trident/tick.ts"]',
    })
    expect(store.get(constrained.id)).toMatchObject({
      reviewed_head: reviewedHead, bound_pr: 289, fenced_paths: '["trident/tick.ts"]',
    })
    const legacy = await store.create({ slug: 'contract-null', project_slug: 't1', repo_path: '/r', task: 't' })
    expect(store.get(legacy.id)).toMatchObject({ reviewed_head: null, bound_pr: null, fenced_paths: null })
  })

  test('bound-array order and length survive a distinct-value create()/get() round-trip', async () => {
    // WHY THIS IS MUTATION-RED: create() returns the JS object it INTENDED to
    // write; get() re-reads what the DB actually stored through COLS. Swapping
    // any two entries of the bound array — or shortening it — makes the two
    // disagree. STRICT typing catches cross-affinity swaps at insert time; the
    // distinct, non-default value for EVERY input field catches the same-affinity
    // swaps (slug/project_slug, chat_id/thread_id, repo_path/worktree/task)
    // that no type or constraint would ever notice.
    const store = new TridentRunStore(db)
    const run = await store.create({
      id: 'run-distinct-0001',
      slug: 'slug-distinct',
      project_slug: 'project-slug-distinct',
      phase: 'ralph-plan',
      max_rounds: 7,
      ralph: true,
      max_ralph_rounds: 13,
      branch: 'branch-distinct',
      merge_mode: 'pr',
      repo_path: '/repo/path/distinct',
      worktree: '/worktree/path/distinct',
      task: 'task text distinct',
      chat_id: 'chat-id-distinct',
      thread_id: 'thread-id-distinct',
      channel_kind: 'cli',
    })

    expect(store.get(run.id)).toEqual(run)
  })

  /**
   * `changeSignature()` is the wake-on-change watcher's ENTIRE detector: one query,
   * one `<stamp>\t<id>` line per non-terminal run, compared against the last
   * observation. Anything it cannot see waits out the 90 s backstop — which is the
   * latency the watcher exists to remove — so the cases below are about what MOVES
   * it, not about the string it happens to produce.
   */
  describe('changeSignature', () => {
    /** Write `last_advanced_at` directly: the point is the shape a foreign writer
     *  (trident/checkpoint.sh) puts in the column, which `update()` cannot express. */
    const stamp = (id: string, at: string): void => {
      db.raw().run(`UPDATE code_trident_runs SET last_advanced_at = ? WHERE id = ?`, [at, id])
    }

    test('a LATER millisecond stamp on one run is not masked by a whole-second stamp on another', async () => {
      // THE MIXED-PRECISION BUG, which needs TWO runs to show itself because the
      // first shape of this signature took MAX ACROSS the active set. `store.now()`
      // writes `…T03:15:45.900Z`; checkpoint.sh writes `…T03:15:45Z`. SQLite compares
      // them as TEXT and 'Z' (0x5A) sorts ABOVE '.' (0x2E), so run A's whole-second
      // stamp read as GREATER than run B's later millisecond one: the raw MAX never
      // moved, the watcher saw no change, and B's advance waited out the 90 s
      // backstop. Per-run equality has no ordering in it at all, so the case is now
      // structurally impossible — kept as the regression guard for the class.
      const store = new TridentRunStore(db)
      const a = await store.create({ slug: 'cs1a', project_slug: 't1', repo_path: '/r', task: 't' })
      const b = await store.create({ slug: 'cs1b', project_slug: 't1', repo_path: '/r', task: 't' })

      // A checkpointed at :45 (whole seconds); B is behind it.
      stamp(a.id, '2026-08-15T03:15:45Z')
      stamp(b.id, '2026-08-15T03:15:44.100Z')
      const before = store.changeSignature()

      // B then advances at :45.900 — LATER than A's stamp by 900 ms.
      stamp(b.id, '2026-08-15T03:15:45.900Z')

      expect(store.changeSignature()).not.toBe(before)
    })

    test('the count moves when a run is created and when one leaves the active set', async () => {
      const store = new TridentRunStore(db)
      const empty = store.changeSignature()
      const run = await store.create({ slug: 'cs2', project_slug: 't1', repo_path: '/r', task: 't' })
      const one = store.changeSignature()
      expect(one).not.toBe(empty)

      // A terminal run is not in the watched set at all, so its transition is itself
      // a change — the sweep needs to fire to drop it from the live rail.
      await store.save({ ...run, phase: 'done' })
      expect(store.changeSignature()).not.toBe(one)
    })

    test('an unchanged active set produces the SAME signature every call', async () => {
      // The other half of the contract: the detector must be quiet when nothing
      // happens, or it is just a 2 s tick loop wearing a disguise.
      const store = new TridentRunStore(db)
      await store.create({ slug: 'cs3', project_slug: 't1', repo_path: '/r', task: 't' })
      const a = store.changeSignature()
      expect(store.changeSignature()).toBe(a)
      expect(store.changeSignature()).toBe(a)
    })

    test('a re-stamp that does NOT move the newest stamp is still a change', async () => {
      // WHY THE DETECTOR IS PER-RUN (Argus r2). A checkpoint on run B while run A
      // already holds a later stamp moves neither COUNT nor MAX — the aggregate
      // signature was identical before and after, so the sweep's settle could not
      // tell that checkpoint apart from its own writes and the handoff fell back to
      // the 90 s backstop. Under the sweep's own timing (it stamps the run it
      // advanced LAST, after seconds of git/gh work) this is the ordinary case, not
      // a contrived one.
      const store = new TridentRunStore(db)
      const a = await store.create({ slug: 'cs4a', project_slug: 't1', repo_path: '/r', task: 't' })
      const b = await store.create({ slug: 'cs4b', project_slug: 't1', repo_path: '/r', task: 't' })
      stamp(a.id, '2026-08-15T03:15:50.000Z') // A is the newest — MAX is pinned here
      stamp(b.id, '2026-08-15T03:15:40.000Z')
      const before = store.changeSignature()

      stamp(b.id, '2026-08-15T03:15:45.000Z') // B advances, still behind A
      expect(store.changeSignature()).not.toBe(before)
    })

    test('changeSignatureEntries reads the signature back as run id → stamp', async () => {
      // The settle's ONE structural dependency on the format: it must be able to ask
      // WHICH run moved, not just whether something did.
      const store = new TridentRunStore(db)
      const a = await store.create({ slug: 'cs5a', project_slug: 't1', repo_path: '/r', task: 't' })
      const b = await store.create({ slug: 'cs5b', project_slug: 't1', repo_path: '/r', task: 't' })
      stamp(a.id, '2026-08-15T03:15:50.000Z')
      stamp(b.id, '2026-08-15T03:15:40Z') // checkpoint.sh's whole-second shape

      const entries = changeSignatureEntries(store.changeSignature())
      expect(entries.size).toBe(2)
      expect(entries.get(a.id)).toBe('2026-08-15T03:15:50.000Z')
      expect(entries.get(b.id)).toBe('2026-08-15T03:15:40Z')
      // The empty active set is the empty signature, and reads back as no entries.
      expect(changeSignatureEntries('').size).toBe(0)
    })
  })
})
