/**
 * A GATEWAY RESTART MUST NOT KILL AN IN-FLIGHT BUILD.
 *
 * The inner Forge→Argus loop runs DETACHED inside a warm `cc-trident-fire-*` REPL
 * whose child dies with the gateway process. `onChildCrash` latches every run that
 * launcher owned `subagent_status='crashed'`, and `step()` §1a used to reap those
 * straight to `failed` — "a crashed launcher is a DEAD RUN".
 *
 * MEASURED 2026-08-14: three gateway boots (06:19:56, 06:26:51, 07:13:00 — a deploy
 * loop) each killed a healthy build ~90 s later. Run `8ddca917` had already pushed
 * `trident/the-build-brief-must-not-be-retyped` and opened PR #261 (+434/−17) NINE
 * MINUTES before its launcher died, and was failed anyway. A dead launcher is not a
 * dead build: the pushed branch, the PR and `inner_checkpoint` all survived.
 *
 * These cases pin the new routing and its bound. Each names the mutation that turns
 * it RED, because a test that only proves "a relaunch happens" is asserting that
 * relaunch works, not that recovery is correct or bounded.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { InnerLoopInput } from './inner-loop.ts'
import { buildBoardReconcileObserver, type TridentBoardReconciler } from './board-reconcile.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentRunStore } from './store.ts'
import { composeTerminalHook } from './terminal-observer.ts'
import { TridentTickLoop, type TridentTerminalHook } from './tick.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trident-crash-recovery-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** A firer that RECORDS what it was asked to launch and reports a clean fire. */
function recordingFirer(seen: InnerLoopInput[], generation = 'gen-healthy') {
  return async (input: InnerLoopInput) => {
    seen.push(input)
    return { status: 'fired' as const, launcher_session_key: generation }
  }
}

/**
 * A firer whose OWN launcher generation dies before the tick can persist the
 * launch — the live shape of a gateway restart (the tombstone vetoes the
 * `running` save, so the row comes back latched `crashed`). Counts real fires.
 */
function crashingFirer(counter: { fires: number }) {
  return async () => {
    counter.fires += 1
    const generation = `generation-${counter.fires}`
    await store.crashRunningByLauncher(generation, 'inner workflow child crashed: pooled child exited')
    return { status: 'fired' as const, launcher_session_key: generation }
  }
}

function orchestrator(
  fire: unknown,
  over: { max_crash_recoveries?: number } = {},
): ReturnType<typeof buildTridentOrchestrator> {
  return buildTridentOrchestrator({
    fire_workflow: fire as never,
    db_path: join(tmp, 'project.db'),
    run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
    begin_crash_recovery: (id) => store.beginCrashRecovery(id),
    ...over,
  })
}

/** Seed a run that is mid-build with a pushed branch + open PR, then kill its
 *  launcher exactly the way `onChildCrash` does. */
async function seedCrashedMidBuild(id: string): Promise<void> {
  await store.create({ id, slug: 'x', project_slug: 'p', repo_path: '/repo', task: 'build' })
  await store.update(id, {
    phase: 'ralph-task',
    branch: 'trident/x',
    pr: 61,
    inner_checkpoint: 'ralph-task-built',
    round: 2,
    ralph_round: 3,
    subagent_run_id: 'wf-1',
    subagent_status: 'running',
    workflow_run_id: 'gen-dead',
  })
  await store.crashRunningByLauncher('gen-dead', 'inner workflow child crashed: pooled child exited')
}

describe('(a) a crashed launcher is RECOVERED as a continuation, not reaped', () => {
  test('one relaunch carries the checkpoint + branch + PR, and leaves the rounds alone', async () => {
    // RED-mutation: restore the §1a crashed→reap arm (drop the `begin_crash_recovery`
    // branch) and every assertion below fails — zero fires, phase 'failed'.
    const seen: InnerLoopInput[] = []
    const orch = orchestrator(recordingFirer(seen))
    const loop = new TridentTickLoop({ store, step: orch.step })
    await seedCrashedMidBuild('recover-1')

    await loop.runOnce()

    // EXACTLY ONE fire, and it is a CONTINUATION: same branch, same PR, resuming at
    // the checkpoint the dead workflow recorded. This is the "no work lost, no work
    // duplicated" property the orchestrator owns — it hands the workflow back the
    // artifacts that survived instead of starting a fresh build.
    expect(seen.length).toBe(1)
    expect(seen[0]?.resume_checkpoint).toBe('ralph-task-built')
    expect(seen[0]?.run.branch).toBe('trident/x')
    expect(seen[0]?.run.pr).toBe(61)

    const after = store.get('recover-1')!
    expect(after.phase).toBe('ralph-task')
    expect(after.subagent_status).toBe('running')
    // A launcher crash is not the AGENT's failure — it must not spend its rounds.
    expect(after.round).toBe(2)
    expect(after.ralph_round).toBe(3)
    // One unit of the durable budget spent, and nothing was harvested.
    expect(after.crash_recoveries).toBe(1)
    expect(after.harvested_at).toBeNull()

    // In flight now: a second tick must NOT fire a second detached build.
    await loop.runOnce()
    expect(seen.length).toBe(1)
  })

  test('the relaunch cannot re-adopt the TOMBSTONED launcher generation', async () => {
    // The fire seam here reports NO `launcher_session_key`, so `launch()` falls back
    // to `launchRun.workflow_run_id ?? id`. RED-mutation: drop `workflow_run_id = NULL`
    // from `beginCrashRecovery` and that fallback re-adopts the DEAD generation — its
    // durable tombstone then vetoes the launch save and `saveIfActive` re-latches the
    // row `crashed`, so the run is recovered into the exact state it was rescued from.
    const seen: InnerLoopInput[] = []
    const fire = async (input: InnerLoopInput) => {
      seen.push(input)
      return { status: 'fired' as const }
    }
    const orch = orchestrator(fire)
    const loop = new TridentTickLoop({ store, step: orch.step })
    await seedCrashedMidBuild('recover-2')

    await loop.runOnce()

    const after = store.get('recover-2')!
    expect(after.subagent_status).toBe('running')
    expect(after.workflow_run_id).not.toBe('gen-dead')
    expect(after.workflow_run_id).toBe(after.subagent_run_id)
  })
})

describe('(b) recovery is BOUNDED, and the bound is DURABLE across restarts', () => {
  test('an always-crashing launcher stops after the budget, with an honest reason', async () => {
    // RED-mutation: remove the `run.crash_recoveries >= maxCrashRecoveries` check and
    // the fire count runs away (the deploy-loop case: a build re-fired forever).
    const counter = { fires: 0 }
    const orch = orchestrator(crashingFirer(counter), { max_crash_recoveries: 2 })
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'budget-1', slug: 'b', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    for (let i = 0; i < 8; i++) await loop.runOnce()

    // One legitimate first attempt + exactly `max_crash_recoveries` relaunches.
    expect(counter.fires).toBe(3)
    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.failure_reason ?? '').toContain('crash-recovery budget')
    // The MEASURED crash text is carried, not thrown away (#240's other half).
    expect(after.failure_reason ?? '').toContain('pooled child exited')
    // 'exhausted' is FORBIDDEN here: `delivery.ts` routes that token to the
    // review-unresolved class ("the reviewer still had blocking findings"), which
    // would be a confident lie about a build whose reviewer may never have run.
    expect((after.failure_reason ?? '').toLowerCase()).not.toContain('exhausted')
    expect(after.round).toBe(1)
    expect(after.ralph_round).toBe(0)
    // The terminal row still says WHAT died — the launcher, not the agent.
    expect(after.subagent_status).toBe('crashed')
  })

  test('a measured gateway boot timestamp latched onto a crash reason survives into the budget-capped terminal failure_reason', async () => {
    // #240 / T2 — `onChildCrash` (open/wiring/substrates.ts) composes the latched
    // crash reason with a measured gateway boot timestamp. RED-mutation: delete the
    // `Last crash: ${run.failure_reason ...}` embedding in orchestrator.ts (~line
    // 1146-1149) and this assertion fails even though the run still fails for a
    // budget reason.
    const sentinel =
      'inner workflow child crashed: pooled child exited (observed 2026-08-14T07:14:32.000Z; gateway process booted 2026-08-14T07:13:00.000Z)'
    const counter = { fires: 0 }
    const firer = async () => {
      counter.fires += 1
      const generation = `generation-${counter.fires}`
      await store.crashRunningByLauncher(generation, sentinel)
      return { status: 'fired' as const, launcher_session_key: generation }
    }
    const orch = orchestrator(firer, { max_crash_recoveries: 2 })
    const loop = new TridentTickLoop({ store, step: orch.step })
    const run = await store.create({
      id: 'budget-sentinel', slug: 'bs', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    for (let i = 0; i < 8; i++) await loop.runOnce()

    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.failure_reason ?? '').toContain('crash-recovery budget')
    expect(after.failure_reason ?? '').toContain('gateway process booted 2026-08-14T07:13:00.000Z')
  })

  test('the budget survives a process restart — a fresh orchestrator continues the count', async () => {
    // THE LIVE CAUSE IS A DEPLOY LOOP (three gateway restarts in 53 min), and every
    // boot wipes in-memory state. RED-mutation: make the counter in-process (a Map in
    // `buildTridentOrchestrator`) and the second orchestrator starts from zero — fires
    // exceed 1 + budget, exactly the runaway the bound exists to stop.
    const counter = { fires: 0 }
    const fire = crashingFirer(counter)
    const first = orchestrator(fire, { max_crash_recoveries: 2 })
    const loopA = new TridentTickLoop({ store, step: first.step })
    const run = await store.create({
      id: 'budget-durable', slug: 'bd', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    await loopA.runOnce() // fire 1 (the first attempt), latched crashed
    await loopA.runOnce() // recovery 1 → fire 2
    expect(store.get(run.id)!.crash_recoveries).toBe(1)

    // SIMULATED GATEWAY RESTART: a brand-new orchestrator + loop over the SAME store.
    const second = orchestrator(fire, { max_crash_recoveries: 2 })
    const loopB = new TridentTickLoop({ store, step: second.step })
    for (let i = 0; i < 6; i++) await loopB.runOnce()

    expect(counter.fires).toBe(3)
    const after = store.get(run.id)!
    expect(after.phase).toBe('failed')
    expect(after.crash_recoveries).toBe(2)
    expect(after.failure_reason ?? '').toContain('crash-recovery budget')
  })
})

describe('(c) harvest still wins over recovery', () => {
  test('a crashed row WITH a parseable result harvests — zero fires, no budget spent', async () => {
    // The ordering guarantee: a workflow that wrote its terminal result and only THEN
    // lost its launcher must be harvested, never relaunched (a relaunch would rebuild
    // work that is already finished). RED-mutation: move the crash branch above the
    // `parseInnerResult` harvest and this fires a build for a finished workflow.
    const seen: InnerLoopInput[] = []
    const orch = orchestrator(recordingFirer(seen))
    const loop = new TridentTickLoop({ store, step: orch.step })
    await seedCrashedMidBuild('harvest-wins')
    await store.update('harvest-wins', {
      inner_result: JSON.stringify({
        ok: false, verdict: 'REQUEST_CHANGES', prNumber: 61, branch: 'trident/x',
        round: 2, checkpoint: 'argus-request-changes',
      }),
    })

    await loop.runOnce()

    // Nothing was relaunched and NO budget was spent — the harvest short-circuits
    // ahead of the crash branch.
    expect(seen.length).toBe(0)
    expect(store.get('harvest-wins')!.crash_recoveries).toBe(0)

    // The step itself decides the run on the harvested result (the terminal COMMIT of
    // a crash-latched row is separately gated by `saveIfActive`'s crash veto — that is
    // pre-existing behaviour this task deliberately leaves alone, so the harvest
    // DECISION is what is asserted here).
    const outcome = await orch.step(store.get('harvest-wins')!)
    expect(outcome.run.phase).toBe('failed')
    expect(outcome.run.failure_reason ?? '').toContain('inner workflow ended at round')
    expect(seen.length).toBe(0)
  })
})

describe('(e) the board never reads FAILED while a recovery is in flight', () => {
  test('the terminal reconcile fires only once the budget is used up', async () => {
    // RED-mutation: reap-instead-of-recover calls `detachRun(..., 'failed')` on the
    // FIRST tick — the card goes red while the build is being re-supervised, which is
    // the user-visible half of this defect.
    const calls: Array<{ run_id: string; outcome: string }> = []
    const reconciler: TridentBoardReconciler = {
      async detachRun(_project, run_id, outcome) {
        calls.push({ run_id, outcome })
      },
    }
    const delivery: TridentTerminalHook = { onTerminal: async () => {} }
    const on_terminal = composeTerminalHook(delivery, [buildBoardReconcileObserver(reconciler)!])
    const counter = { fires: 0 }
    const orch = orchestrator(crashingFirer(counter), { max_crash_recoveries: 1 })
    const loop = new TridentTickLoop({ store, step: orch.step, on_terminal })
    const run = await store.create({
      id: 'board-1', slug: 'bd1', project_slug: 'p', repo_path: '/repo', task: 'build',
    })

    await loop.runOnce() // first attempt, launcher dies
    await loop.runOnce() // WITHIN BUDGET → relaunch, NOT a terminal transition
    expect(calls).toEqual([])
    expect(store.get(run.id)!.phase).not.toBe('failed')

    await loop.runOnce() // budget used up → terminal, exactly once
    expect(calls).toEqual([{ run_id: run.id, outcome: 'failed' }])
    expect(counter.fires).toBe(2)
  })
})
