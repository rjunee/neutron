import { describe, expect, test } from 'bun:test'
import {
  advanceTridentRun,
  computeTransition,
  isTerminalPhase,
  stubAdvanceDeps,
  TERMINAL_PHASES,
  type AdvanceDeps,
  type SubagentOutcome,
} from './state-machine.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'
import type { TridentPhase } from './store.ts'

const fixedNow = '2026-01-01T00:10:00.000Z'
function depsWith(outcome: SubagentOutcome): AdvanceDeps {
  return { now: () => fixedNow, classify: async () => outcome }
}

describe('isTerminalPhase / TERMINAL_PHASES', () => {
  test('done, failed, stopped are terminal; the rest are not', () => {
    expect([...TERMINAL_PHASES].sort()).toEqual(['done', 'failed', 'stopped'])
    for (const p of ['done', 'failed', 'stopped'] as TridentPhase[]) {
      expect(isTerminalPhase(p)).toBe(true)
    }
    for (const p of ['forge-init', 'task-plan', 'task-build', 'argus', 'forge-fix'] as TridentPhase[]) {
      expect(isTerminalPhase(p)).toBe(false)
    }
  })
})

describe('computeTransition — legacy (non-task-sequence) build', () => {
  test('forge-init → argus (one-shot)', () => {
    const t = computeTransition(makeTridentRun({ phase: 'forge-init', execution_strategy: 'single' }), {})
    expect(t.phase).toBe('argus')
  })

  test('argus APPROVE → done', () => {
    const t = computeTransition(makeTridentRun({ phase: 'argus' }), { approved: true })
    expect(t.phase).toBe('done')
  })

  test('argus REQUEST CHANGES → forge-fix, round increments', () => {
    const t = computeTransition(makeTridentRun({ phase: 'argus', round: 1 }), { approved: false })
    expect(t.phase).toBe('forge-fix')
    expect(t.round).toBe(2)
  })

  test('argus REQUEST CHANGES at max_rounds → failed', () => {
    const t = computeTransition(makeTridentRun({ phase: 'argus', round: 8, max_rounds: 8 }), { approved: false })
    expect(t.phase).toBe('failed')
    expect(t.round).toBe(8)
    expect(t.failure_reason).toContain('max_rounds')
  })

  test('forge-fix → argus (re-review)', () => {
    const t = computeTransition(makeTridentRun({ phase: 'forge-fix', round: 2 }), {})
    expect(t.phase).toBe('argus')
    expect(t.round).toBe(2)
  })

  test('full legacy loop walks forge-init → argus → forge-fix → argus → done', () => {
    let run = makeTridentRun({ phase: 'forge-init', execution_strategy: 'single' })
    run = { ...run, phase: computeTransition(run, {}).phase }
    expect(run.phase).toBe('argus')
    let t = computeTransition(run, { approved: false })
    run = { ...run, phase: t.phase, round: t.round }
    expect(run.phase).toBe('forge-fix')
    expect(run.round).toBe(2)
    t = computeTransition(run, {})
    run = { ...run, phase: t.phase, round: t.round }
    expect(run.phase).toBe('argus')
    t = computeTransition(run, { approved: true })
    expect(t.phase).toBe('done')
  })
})

describe('computeTransition — task-sequence build', () => {
  test('forge-init with remaining>0 → task-plan, task_iteration increments', () => {
    const t = computeTransition(makeTridentRun({ phase: 'forge-init', execution_strategy: 'task_sequence', task_iteration: 0 }), { remaining: 3 })
    expect(t.phase).toBe('task-plan')
    expect(t.task_iteration).toBe(1)
  })

  test('forge-init with remaining=0 → argus', () => {
    const t = computeTransition(makeTridentRun({ phase: 'forge-init', execution_strategy: 'task_sequence' }), { remaining: 0 })
    expect(t.phase).toBe('argus')
  })

  test('forge-init task sequence with missing REMAINING → failed (loud)', () => {
    const t = computeTransition(makeTridentRun({ phase: 'forge-init', execution_strategy: 'task_sequence' }), {})
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('REMAINING_TASKS')
  })

  test('task-plan remaining>0 → task-build (no task_iteration bump)', () => {
    const t = computeTransition(makeTridentRun({ phase: 'task-plan', execution_strategy: 'task_sequence', task_iteration: 2 }), { remaining: 5 })
    expect(t.phase).toBe('task-build')
    expect(t.task_iteration).toBe(2)
  })

  test('task-plan remaining=0 → argus', () => {
    const t = computeTransition(makeTridentRun({ phase: 'task-plan', execution_strategy: 'task_sequence' }), { remaining: 0 })
    expect(t.phase).toBe('argus')
  })

  test('task-plan missing REMAINING → failed (loud)', () => {
    const t = computeTransition(makeTridentRun({ phase: 'task-plan', execution_strategy: 'task_sequence' }), {})
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('REMAINING_TASKS')
  })

  test('task-build → task-plan, task_iteration increments', () => {
    const t = computeTransition(makeTridentRun({ phase: 'task-build', execution_strategy: 'task_sequence', task_iteration: 1 }), {})
    expect(t.phase).toBe('task-plan')
    expect(t.task_iteration).toBe(2)
  })

  test('task_iteration at cap → failed', () => {
    const t = computeTransition(
      makeTridentRun({ phase: 'task-build', execution_strategy: 'task_sequence', task_iteration: 20, max_task_iterations: 20 }),
      {},
    )
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('max_task_iterations')
  })
})

describe('advanceTridentRun', () => {
  test('terminal phase is a no-op', async () => {
    const run = makeTridentRun({ phase: 'done' })
    const out = await advanceTridentRun(run, depsWith({ status: 'completed', result: {} }))
    expect(out.changed).toBe(false)
    expect(out.run.phase).toBe('done')
  })

  test('running sub-agent → waiting, no change', async () => {
    const run = makeTridentRun({ phase: 'argus' })
    const out = await advanceTridentRun(run, depsWith({ status: 'running' }))
    expect(out.waiting).toBe(true)
    expect(out.changed).toBe(false)
    expect(out.run.phase).toBe('argus')
  })

  test('crashed sub-agent → failed with reason', async () => {
    const run = makeTridentRun({ phase: 'argus' })
    const out = await advanceTridentRun(run, depsWith({ status: 'crashed', reason: 'pid gone' }))
    expect(out.changed).toBe(true)
    expect(out.run.phase).toBe('failed')
    expect(out.run.subagent_status).toBe('crashed')
    expect(out.run.failure_reason).toBe('pid gone')
  })

  test('completed transition advances phase, clears sub-agent slot, stamps clock', async () => {
    const run = makeTridentRun({
      phase: 'forge-init',
      execution_strategy: 'single',
      subagent_run_id: 'forge-1',
      subagent_status: 'completed',
    })
    const out = await advanceTridentRun(run, depsWith({ status: 'completed', result: {} }))
    expect(out.changed).toBe(true)
    expect(out.run.phase).toBe('argus')
    expect(out.run.subagent_run_id).toBeNull()
    expect(out.run.subagent_status).toBeNull()
    expect(out.run.last_advanced_at).toBe(fixedNow)
  })

  test('terminal transition keeps the completing agent id for the audit trail', async () => {
    const run = makeTridentRun({ phase: 'argus', subagent_run_id: 'argus-9', subagent_status: 'completed' })
    const out = await advanceTridentRun(run, depsWith({ status: 'completed', result: { approved: true } }))
    expect(out.run.phase).toBe('done')
    expect(out.run.subagent_run_id).toBe('argus-9')
    expect(out.run.subagent_status).toBe('completed')
  })

  test('stubAdvanceDeps never advances (always running)', async () => {
    const run = makeTridentRun({ phase: 'argus' })
    const out = await advanceTridentRun(run, stubAdvanceDeps(() => fixedNow))
    expect(out.waiting).toBe(true)
    expect(out.changed).toBe(false)
  })
})
