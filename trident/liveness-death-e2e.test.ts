/** End-to-end pin for external launcher liveness → durable bounded recovery. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { createWorkBoardSurface } from '@neutronai/gateway/http/work-board-surface.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import {
  WorkBoardRunStillLiveError,
  WorkBoardStore,
} from '@neutronai/work-board/store.ts'
import {
  buildSubstrateWorkflowFire,
  buildWorkflowFirer,
  type InnerLoopInput,
} from './inner-loop.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentTickLoop, type LauncherLiveness } from './tick.ts'
import {
  registerTridentBuildToolSurface,
  WORK_BOARD_START_TOOL,
} from './work-board-build-tool.ts'

let scratchpad: string
let db: ProjectDb
let store: TridentRunStore
let board: WorkBoardStore

beforeEach(() => {
  scratchpad = mkdtempSync(join(tmpdir(), 'trident-liveness-death-e2e-'))
  seedMigratedDb(join(scratchpad, 'project.db'))
  db = ProjectDb.open(join(scratchpad, 'project.db'))
  store = new TridentRunStore(db)
  board = new WorkBoardStore(db, {
    isRunLive: (id) => {
      const run = store.get(id)
      return run !== null && !isTerminalPhase(run.phase)
    },
  })
})

afterEach(() => {
  db.close()
  rmSync(scratchpad, { recursive: true, force: true })
})

async function seedRunning(id: string, generation: string): Promise<TridentRun> {
  await store.create({ id, slug: id, project_slug: 'p', repo_path: '/repo', task: 'build' })
  return (await store.update(id, {
    phase: 'ralph-task',
    branch: 'trident/existing',
    pr: 312,
    inner_checkpoint: 'ralph-task-built',
    subagent_run_id: `workflow-${id}`,
    subagent_status: 'running',
    workflow_run_id: generation,
  }))!
}

function harness(
  answer: LauncherLiveness,
  fire: (input: InnerLoopInput) => Promise<{ status: 'fired'; error: null; launcher_session_key: string }>,
  opts: {
    maxCrashRecoveries?: number
    launchThrows?: boolean
    outcomes?: string[]
  } = {},
): TridentTickLoop {
  const orchestrator = buildTridentOrchestrator({
    fire_workflow: fire,
    db_path: join(scratchpad, 'project.db'),
    run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
    base_branch: 'main',
    ...(opts.launchThrows
      ? { mint_run_id: () => { throw new Error('persistent launch failure at mint_run_id') } }
      : {}),
    on_orphaned_session: 'wait',
    begin_crash_recovery: (id) => store.beginCrashRecovery(id),
    max_crash_recoveries: opts.maxCrashRecoveries ?? 2,
  })
  return new TridentTickLoop({
    store,
    step: async (run) => {
      const outcome = await orchestrator.step(run)
      opts.outcomes?.push(outcome.note)
      return outcome
    },
    probe_launcher_alive: async () => answer,
    latch_launcher_dead: (key, reason) => store.crashRunningByLauncher(key, reason),
  })
}

async function latchDeadRun(id: string): Promise<TridentRun> {
  await seedRunning(id, 'generation-dead')
  const loop = harness('dead', async () => ({
    status: 'fired',
    error: null,
    launcher_session_key: 'generation-live',
  }))
  await loop.runLivenessOnce()
  return store.get(id)!
}

const toolContext = {
  project_slug: 'p',
  project_id: null,
  topic_id: null,
  call_id: 'liveness-death-e2e',
  speaker_user_id: null,
}

describe('external launcher death reaches the real orchestrator without killing the build', () => {
  test('a latched-dead non-terminal run remains already_running at both start surfaces', async () => {
    const latched = await latchDeadRun('start-gate')
    const item = await board.create('p', { title: 'the existing build must remain the only build' })
    await board.attachRun('p', item.id, latched.id)
    let httpStarts = 0
    const surface = createWorkBoardSurface({
      store: board,
      auth: createAppWsAuthResolver({ project_slug: 'p', bypass: true }),
      trident_runs: store,
      start_build: async () => {
        httpStarts += 1
        return { ok: true, run_id: 'must-not-start' }
      },
    })
    const response = await surface.handler(new Request(
      `http://x/api/app/projects/general/work-board/${item.id}/start`,
      { method: 'POST', headers: { authorization: 'Bearer dev-token' } },
    ))
    expect(response?.status).toBe(409)
    expect(await response!.json()).toMatchObject({ ok: false, code: 'already_running' })
    expect(httpStarts).toBe(0)

    const registry = new ToolRegistry()
    registerTridentBuildToolSurface(registry, {
      store,
      work_board: board,
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      merge_mode_probe: {
        credential: {
          owner_handle: 'test-owner',
          source: 'liveness death e2e',
          load: async () => ({}),
        },
        hasGithubOrigin: async () => false,
        publisherAvailable: async () => ({ authenticated: true }),
      },
      resolveRalph: async () => false,
    })
    const output = await registry.get(WORK_BOARD_START_TOOL)!.handler(
      { board_item_id: item.id },
      toolContext,
    ) as Record<string, unknown>
    expect(output.ok).toBe(false)
    expect(String(output.error)).toContain('already has a live build')
    expect(store.listNonTerminal().map((run) => run.id)).toEqual(['start-gate'])
  })

  test('complete refuses a latched-dead non-terminal run by exact error type', async () => {
    const latched = await latchDeadRun('complete-gate')
    const item = await board.create('p', { title: 'cannot claim done while the build is latched' })
    await board.attachRun('p', item.id, latched.id)

    let caught: unknown = null
    try {
      await board.complete('p', item.id)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkBoardRunStillLiveError)
    expect((caught as Error).name).toBe('WorkBoardRunStillLiveError')
    expect((caught as WorkBoardRunStillLiveError).run_id).toBe(latched.id)
    expect(board.get('p', item.id)?.status).toBe('in_progress')
  })

  test('a positively dead generation gets a NEW builder launch — relaunch REQUESTED, not merely counted', async () => {
    await seedRunning('spent', 'generation-dead')
    const fires: InnerLoopInput[] = []
    const loop = harness(
      'dead',
      async (input) => {
        fires.push(input)
        return { status: 'fired', error: null, launcher_session_key: 'generation-live' }
      },
      { maxCrashRecoveries: 3 },
    )

    await loop.runLivenessOnce()
    const latched = store.get('spent')!
    expect(latched.phase).toBe('ralph-task')
    expect(latched.subagent_status).toBe('crashed')
    expect(latched.failure_reason).toContain('inner workflow launcher crashed:')
    expect(latched.failure_reason).toContain('generation-dead')

    for (let sweep = 0; sweep < 6; sweep++) await loop.runOnce()
    const continued = store.get('spent')!
    // Red mutation verified by hand: deleting the §1a-crash `launch(claimed)`
    // branch reaps the row terminal with zero fires, making these assertions fail.
    expect(fires.length).toBeGreaterThanOrEqual(1)
    expect(fires[0]!.resume_checkpoint).toBe('ralph-task-built')
    expect(fires[0]!.run.branch).toBe('trident/existing')
    expect(fires[0]!.run.pr).toBe(312)
    expect(isTerminalPhase(continued.phase)).toBe(false)
    expect(continued.subagent_status).toBe('running')
    expect(continued.workflow_run_id).toBe('generation-live')
    expect(continued.crash_recoveries).toBe(1)
    expect(continued.round).toBe(1)
    expect(continued.ralph_round).toBe(0)
  })

  test('persistent launch throws terminate the latched run within six sweeps with work preserved', async () => {
    await seedRunning('throwing-recovery', 'generation-dead')
    const outcomes: string[] = []
    const loop = harness(
      'dead',
      async () => ({ status: 'fired', error: null, launcher_session_key: 'must-not-fire' }),
      { maxCrashRecoveries: 3, launchThrows: true, outcomes },
    )

    await loop.runLivenessOnce()
    const latched = store.get('throwing-recovery')!
    expect(latched.phase).toBe('ralph-task')
    expect(latched.subagent_status).toBe('crashed')

    for (let sweep = 0; sweep < 6; sweep++) await loop.runOnce()

    const terminal = store.get('throwing-recovery')!
    expect(outcomes).toEqual([
      'launch threw (attempt 1 of 3): persistent launch failure at mint_run_id — retrying next tick',
      'launch threw (attempt 2 of 3): persistent launch failure at mint_run_id — retrying next tick',
      'ralph-task → failed (launch kept throwing)',
    ])
    expect(terminal.phase).toBe('failed')
    expect(terminal.failure_reason).toContain('persistent launch failure at mint_run_id')
    expect(terminal.failure_reason ?? '').not.toContain('exhausted')
    expect(terminal.crash_recoveries).toBe(1)
    expect(terminal.branch).toBe('trident/existing')
    expect(terminal.inner_checkpoint).toBe('ralph-task-built')
  })

  test('a slow but positively alive run is untouched by the liveness pass and one sweep', async () => {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString()
    const staleStore = new TridentRunStore(db, () => stale)
    await staleStore.create({
      id: 'slow-alive', slug: 'slow-alive', project_slug: 'p', repo_path: '/repo', task: 'build',
    })
    await staleStore.update('slow-alive', {
      phase: 'ralph-task',
      subagent_run_id: 'workflow-slow',
      subagent_status: 'running',
      workflow_run_id: 'generation-alive',
    })
    const before = store.get('slow-alive')!
    const loop = harness('alive', async () => ({
      status: 'fired',
      error: null,
      launcher_session_key: 'must-not-launch',
    }))

    await loop.runLivenessOnce()
    await loop.runOnce()

    expect(store.get('slow-alive')).toEqual(before)
  })
})

describe('a hung crash-recovery fire cannot wedge the lanes behind it', () => {
  test('a never-settling lane fails boundedly and the next crashed lane relaunches', async () => {
    const laneAStore = new TridentRunStore(db, () => '2026-08-17T19:42:56.000Z')
    const laneBStore = new TridentRunStore(db, () => '2026-08-17T19:42:57.000Z')
    await laneAStore.create({
      id: 'lane-a',
      slug: 'lane-a',
      project_slug: 'p',
      repo_path: '/repo-a',
      task: 'build A',
    })
    await laneAStore.update('lane-a', {
      phase: 'ralph-task',
      branch: 'trident/existing-a',
      pr: 312,
      inner_checkpoint: 'ralph-task-built',
      subagent_run_id: 'workflow-a',
      subagent_status: 'running',
      workflow_run_id: 'generation-dead-a',
    })
    await laneBStore.create({
      id: 'lane-b',
      slug: 'lane-b',
      project_slug: 'p',
      repo_path: '/repo-b',
      task: 'build B',
    })
    await laneBStore.update('lane-b', {
      phase: 'ralph-task',
      branch: 'trident/existing-b',
      pr: 313,
      inner_checkpoint: 'ralph-task-built',
      subagent_run_id: 'workflow-b',
      subagent_status: 'running',
      workflow_run_id: 'generation-dead-b',
    })
    const crashReason = 'inner workflow child crashed: pooled child exited'
    await laneAStore.crashRunningByLauncher('generation-dead-a', crashReason)
    await laneBStore.crashRunningByLauncher('generation-dead-b', crashReason)

    const hangingSubstrate: Substrate = {
      start(): SessionHandle {
        return {
          events: (async function* () {
            await new Promise<void>(() => {})
          })(),
          async respondToTool() {},
          async cancel() {},
          tool_resolution: 'internal',
        } as SessionHandle
      },
    }
    const completed: Event = {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 } as never,
      substrate_instance_id: 'cc-trident-fire-lane-b',
      launcher_session_key: 'generation-live-b',
    }
    const settlingSubstrate: Substrate = {
      start(): SessionHandle {
        return {
          events: (async function* () {
            yield completed
          })(),
          async respondToTool() {},
          async cancel() {},
          tool_resolution: 'internal',
        } as SessionHandle
      },
    }
    const fireWorkflow = buildWorkflowFirer({
      fire: buildSubstrateWorkflowFire({
        build_substrate: (cwd) =>
          cwd === '/repo-a' ? hangingSubstrate : settlingSubstrate,
      }),
      settle_timeout_ms: 50,
      write_brief_parts: () => null,
    })
    const orchestrator = buildTridentOrchestrator({
      fire_workflow: fireWorkflow,
      db_path: join(scratchpad, 'project.db'),
      run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
      base_branch: 'main',
      on_orphaned_session: 'wait',
      begin_crash_recovery: (id) => store.beginCrashRecovery(id),
    })
    const loop = new TridentTickLoop({
      store,
      step: (run) => orchestrator.step(run),
    })

    // Red mutation: without the unconditional fire race this first sweep hangs
    // on lane A, so lane B is never claimed or relaunched.
    const first = await loop.runOnce()
    expect(first.skipped_due_to_overlap).toBe(false)

    const laneB = store.get('lane-b')!
    expect(isTerminalPhase(laneB.phase)).toBe(false)
    expect(laneB.subagent_status).toBe('running')
    expect(laneB.workflow_run_id).toBe('generation-live-b')
    expect(laneB.crash_recoveries).toBe(1)
    expect(laneB.subagent_status).not.toBe('crashed')

    const laneA = store.get('lane-a')!
    expect(laneA.phase).toBe('failed')
    expect(laneA.failure_reason).toContain('inner workflow fire failed')
    expect(laneA.failure_reason).toContain('did not settle within the budget')
    expect(laneA.failure_reason ?? '').not.toContain('exhausted')
    expect(laneA.crash_recoveries).toBe(1)
    expect(laneA.branch).toBe('trident/existing-a')
    expect(laneA.inner_checkpoint).toBe('ralph-task-built')

    expect((await loop.runOnce()).skipped_due_to_overlap).toBe(false)
  })
})
