/**
 * Restart-resume — the control-plane-restart recovery contract.
 *
 * On a gateway restart the in-memory `TridentSessionManager` map is empty,
 * but `code_trident_runs` still holds every in-flight run with its
 * persisted `subagent_run_id` / `subagent_status` (the PR-2 columns). A
 * fresh process must RESUME those runs from the row — re-dispatching the
 * lost phase exactly once — WITHOUT double-spawning a session, and drive
 * them through to a terminal phase.
 *
 * These tests simulate a restart by persisting a run mid-phase with a
 * STALE `subagent_run_id`, then building a BRAND-NEW orchestrator +
 * session manager (empty in-memory map, like a fresh boot) over the same
 * store and ticking. The stale id is never tracked by the new manager, so
 * the orchestrator's orphan-recovery (resume/reap) path fires.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import type { HostCommandResult } from './git-mode.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentSessionManager, type TridentDispatch } from './session.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type MergeMode, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-resume-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

interface DispatchSpy {
  dispatch: TridentDispatch
  byPhase: Map<string, number>
  total: () => number
}

/** Records a dispatch count per trident phase so a test can assert the
 *  RESUMED phase was launched exactly once and earlier phases never ran. */
function spyDispatch(handler: (input: Parameters<TridentDispatch>[0]) => string): DispatchSpy {
  const byPhase = new Map<string, number>()
  const dispatch: TridentDispatch = async (input) => {
    // Orchestrator-spawned forge/argus always carry a phase; the `?? phaseless`
    // key only guards the type (a phase-less dispatchAgent never hits this spy).
    const phaseKey = input.phase ?? 'phaseless'
    byPhase.set(phaseKey, (byPhase.get(phaseKey) ?? 0) + 1)
    return { result: handler(input), status: 'completed' }
  }
  return { dispatch, byPhase, total: () => [...byPhase.values()].reduce((a, b) => a + b, 0) }
}

/** Build a FRESH orchestrator + session manager (simulates a restart). */
function freshBoot(
  spy: DispatchSpy,
  opts: { numstat?: string; on_orphaned_session?: 'redispatch' | 'wait' | 'fail' } = {},
): { loop: TridentTickLoop; session: TridentSessionManager } {
  const host = async (cmd: string[]): Promise<HostCommandResult> => {
    if (cmd.includes('--numstat')) return ok(opts.numstat ?? '1\t1\tfile.ts')
    return ok()
  }
  const session = new TridentSessionManager({ dispatch: spy.dispatch })
  const orchestratorOpts: Parameters<typeof buildTridentOrchestrator>[0] = {
    session,
    run_host: host,
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
  }
  if (opts.on_orphaned_session !== undefined) {
    orchestratorOpts.on_orphaned_session = opts.on_orphaned_session
  }
  const { step } = buildTridentOrchestrator(orchestratorOpts)
  const loop = new TridentTickLoop({ store, step })
  return { loop, session }
}

async function runToTerminal(
  loop: TridentTickLoop,
  session: TridentSessionManager,
  run_id: string,
  max_ticks = 40,
): Promise<TridentRun> {
  for (let i = 0; i < max_ticks; i++) {
    await loop.runOnce()
    await session.drain()
    const r = store.get(run_id)
    if (r !== null && isTerminalPhase(r.phase)) return r
  }
  const r = store.get(run_id)
  throw new Error(`run did not terminate (last phase: ${r?.phase})`)
}

describe('restart-resume — a run mid-argus resumes without double-spawn', () => {
  test('fresh boot re-dispatches the lost Argus exactly once → APPROVE → merge → done', async () => {
    // A run that, before the restart, had Argus in flight under a stale id.
    const run = await store.create({
      slug: 'mid-argus',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'thing',
      branch: 'feat-x',
      merge_mode: 'pr' as MergeMode,
    })
    await store.update(run.id, {
      phase: 'argus',
      pr: 42,
      subagent_run_id: 'stale-argus-id-from-prior-process',
      subagent_status: 'running',
    })

    const spy = spyDispatch((input) => {
      if (input.kind === 'argus') return 'APPROVE'
      return 'PR_NUMBER=42\nBRANCH=feat-x\nWORKTREE=/repo'
    })
    const boot = freshBoot(spy)

    const final = await runToTerminal(boot.loop, boot.session, run.id)
    expect(final.phase).toBe('done')
    // The lost Argus was re-dispatched exactly ONCE; no forge ever re-ran.
    expect(spy.byPhase.get('argus')).toBe(1)
    expect(spy.byPhase.get('forge-init') ?? 0).toBe(0)
    expect(spy.byPhase.get('forge-fix') ?? 0).toBe(0)
  })

  test('the re-dispatch replaces the stale id with a fresh tracked session', async () => {
    const run = await store.create({
      slug: 'mid-argus-2',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'thing',
      branch: 'feat-x',
      merge_mode: 'pr' as MergeMode,
    })
    await store.update(run.id, {
      phase: 'argus',
      pr: 7,
      subagent_run_id: 'STALE',
      subagent_status: 'running',
    })
    // Gate the Argus dispatch so we can inspect the row mid-resume.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const session = new TridentSessionManager({
      dispatch: async (input) => {
        if (input.kind === 'argus') {
          await gate
          return { result: 'APPROVE', status: 'completed' }
        }
        return { result: 'PR_NUMBER=7\nBRANCH=feat-x\nWORKTREE=/repo', status: 'completed' }
      },
    })
    const { step } = buildTridentOrchestrator({
      session,
      run_host: async (cmd) => (cmd.includes('--numstat') ? ok('1\t1\tf') : ok()),
      base_branch: 'main',
      now: () => new Date(0).toISOString(),
    })
    const loop = new TridentTickLoop({ store, step })

    // Tick 1: orphan detected → re-dispatch Argus. The stale id is gone;
    // a fresh, tracked session id is persisted.
    await loop.runOnce()
    const mid = store.get(run.id)
    expect(mid?.phase).toBe('argus')
    expect(mid?.subagent_run_id).not.toBe('STALE')
    expect(mid?.subagent_run_id).not.toBeNull()
    expect(session.isTracked(mid!.subagent_run_id!)).toBe(true)
    expect(session.runningCount()).toBe(1) // exactly one live Argus, not two

    release()
    await session.drain()
    const final = await runToTerminal(loop, session, run.id)
    expect(final.phase).toBe('done')
  })
})

describe('restart-resume — a run mid-ralph-task resumes the Ralph loop', () => {
  test('fresh boot re-dispatches the lost ralph-task, then re-plans → 0 remain → argus → done', async () => {
    const run = await store.create({
      slug: 'mid-ralph',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'spec build',
      branch: 'feat-x',
      ralph: true,
      merge_mode: 'pr' as MergeMode,
    })
    await store.update(run.id, {
      phase: 'ralph-task',
      pr: 9,
      subagent_run_id: 'stale-ralph-task-id',
      subagent_status: 'running',
    })
    // Manually bump ralph_round to mimic a loop already in progress.
    const reloaded = store.get(run.id)!
    await store.save({ ...reloaded, ralph_round: 1 })

    const spy = spyDispatch((input) => {
      if (input.kind === 'argus') return 'APPROVE'
      if (input.phase === 'ralph-plan') return 'REMAINING_TASKS=0\nNEXT_TASK=none'
      // ralph-task / forge-init forge turns
      return 'PR_NUMBER=9\nBRANCH=feat-x\nWORKTREE=/repo'
    })
    const boot = freshBoot(spy)

    const final = await runToTerminal(boot.loop, boot.session, run.id)
    expect(final.phase).toBe('done')
    // The lost ralph-task was re-dispatched exactly once; a planning pass
    // then ran (drift-catch) and reported 0 remaining → Argus → merge.
    expect(spy.byPhase.get('ralph-task')).toBe(1)
    expect(spy.byPhase.get('ralph-plan')).toBe(1)
    expect(spy.byPhase.get('argus')).toBe(1)
    // The bootstrap forge-init NEVER re-ran (resume, not restart-from-zero).
    expect(spy.byPhase.get('forge-init') ?? 0).toBe(0)
  })
})

describe('restart-resume — alternate orphan policies', () => {
  test("'wait' policy leaves the orphan untouched (no spawn, no advance)", async () => {
    const run = await store.create({
      slug: 'orphan-wait',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'thing',
      branch: 'feat-x',
      merge_mode: 'pr' as MergeMode,
    })
    await store.update(run.id, {
      phase: 'argus',
      pr: 1,
      subagent_run_id: 'STALE',
      subagent_status: 'running',
    })
    const spy = spyDispatch(() => 'APPROVE')
    const boot = freshBoot(spy, { on_orphaned_session: 'wait' })

    await boot.loop.runOnce()
    await boot.session.drain()
    const after = store.get(run.id)
    expect(after?.phase).toBe('argus') // unchanged
    expect(after?.subagent_run_id).toBe('STALE') // untouched
    expect(spy.total()).toBe(0) // nothing dispatched
  })

  test("'fail' policy reaps the orphan loudly", async () => {
    const run = await store.create({
      slug: 'orphan-fail',
      project_slug: 't1',
      repo_path: '/repo',
      task: 'thing',
      branch: 'feat-x',
      merge_mode: 'pr' as MergeMode,
    })
    await store.update(run.id, {
      phase: 'argus',
      pr: 1,
      subagent_run_id: 'STALE',
      subagent_status: 'running',
    })
    const spy = spyDispatch(() => 'APPROVE')
    const boot = freshBoot(spy, { on_orphaned_session: 'fail' })

    await boot.loop.runOnce()
    const after = store.get(run.id)
    expect(after?.phase).toBe('failed')
    expect(after?.subagent_status).toBe('crashed')
    expect(after?.failure_reason).toContain('orphaned')
    expect(spy.total()).toBe(0)
  })
})
