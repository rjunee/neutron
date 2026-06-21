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
import type { TridentPhase, TridentRun } from './store.ts'

function makeRun(overrides: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'id-1',
    slug: 'slug-1',
    project_slug: 't1',
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: null,
    pr: null,
    merge_mode: 'local',
    subagent_run_id: 'agent-1',
    subagent_status: 'running',
    repo_path: '/r',
    worktree: null,
    task: 't',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

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
    for (const p of ['forge-init', 'ralph-plan', 'ralph-task', 'argus', 'forge-fix'] as TridentPhase[]) {
      expect(isTerminalPhase(p)).toBe(false)
    }
  })
})

describe('computeTransition — legacy (non-ralph) build', () => {
  test('forge-init → argus (one-shot)', () => {
    const t = computeTransition(makeRun({ phase: 'forge-init', ralph: false }), {})
    expect(t.phase).toBe('argus')
  })

  test('argus APPROVE → done', () => {
    const t = computeTransition(makeRun({ phase: 'argus' }), { approved: true })
    expect(t.phase).toBe('done')
  })

  test('argus REQUEST CHANGES → forge-fix, round increments', () => {
    const t = computeTransition(makeRun({ phase: 'argus', round: 1 }), { approved: false })
    expect(t.phase).toBe('forge-fix')
    expect(t.round).toBe(2)
  })

  test('argus REQUEST CHANGES at max_rounds → failed', () => {
    const t = computeTransition(makeRun({ phase: 'argus', round: 8, max_rounds: 8 }), { approved: false })
    expect(t.phase).toBe('failed')
    expect(t.round).toBe(8)
    expect(t.failure_reason).toContain('max_rounds')
  })

  test('forge-fix → argus (re-review)', () => {
    const t = computeTransition(makeRun({ phase: 'forge-fix', round: 2 }), {})
    expect(t.phase).toBe('argus')
    expect(t.round).toBe(2)
  })

  test('full legacy loop walks forge-init → argus → forge-fix → argus → done', () => {
    let run = makeRun({ phase: 'forge-init', ralph: false })
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

describe('computeTransition — ralph build', () => {
  test('forge-init with remaining>0 → ralph-plan, ralph_round increments', () => {
    const t = computeTransition(makeRun({ phase: 'forge-init', ralph: true, ralph_round: 0 }), { remaining: 3 })
    expect(t.phase).toBe('ralph-plan')
    expect(t.ralph_round).toBe(1)
  })

  test('forge-init with remaining=0 → argus', () => {
    const t = computeTransition(makeRun({ phase: 'forge-init', ralph: true }), { remaining: 0 })
    expect(t.phase).toBe('argus')
  })

  test('forge-init ralph with missing REMAINING → failed (loud)', () => {
    const t = computeTransition(makeRun({ phase: 'forge-init', ralph: true }), {})
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('REMAINING_TASKS')
  })

  test('ralph-plan remaining>0 → ralph-task (no ralph_round bump)', () => {
    const t = computeTransition(makeRun({ phase: 'ralph-plan', ralph: true, ralph_round: 2 }), { remaining: 5 })
    expect(t.phase).toBe('ralph-task')
    expect(t.ralph_round).toBe(2)
  })

  test('ralph-plan remaining=0 → argus', () => {
    const t = computeTransition(makeRun({ phase: 'ralph-plan', ralph: true }), { remaining: 0 })
    expect(t.phase).toBe('argus')
  })

  test('ralph-plan missing REMAINING → failed (loud)', () => {
    const t = computeTransition(makeRun({ phase: 'ralph-plan', ralph: true }), {})
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('REMAINING_TASKS')
  })

  test('ralph-task → ralph-plan, ralph_round increments', () => {
    const t = computeTransition(makeRun({ phase: 'ralph-task', ralph: true, ralph_round: 1 }), {})
    expect(t.phase).toBe('ralph-plan')
    expect(t.ralph_round).toBe(2)
  })

  test('ralph_round at cap → failed', () => {
    const t = computeTransition(
      makeRun({ phase: 'ralph-task', ralph: true, ralph_round: 20, max_ralph_rounds: 20 }),
      {},
    )
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('max_ralph_rounds')
  })
})

describe('advanceTridentRun', () => {
  test('terminal phase is a no-op', async () => {
    const run = makeRun({ phase: 'done' })
    const out = await advanceTridentRun(run, depsWith({ status: 'completed', result: {} }))
    expect(out.changed).toBe(false)
    expect(out.run.phase).toBe('done')
  })

  test('running sub-agent → waiting, no change', async () => {
    const run = makeRun({ phase: 'argus' })
    const out = await advanceTridentRun(run, depsWith({ status: 'running' }))
    expect(out.waiting).toBe(true)
    expect(out.changed).toBe(false)
    expect(out.run.phase).toBe('argus')
  })

  test('crashed sub-agent → failed with reason', async () => {
    const run = makeRun({ phase: 'argus' })
    const out = await advanceTridentRun(run, depsWith({ status: 'crashed', reason: 'pid gone' }))
    expect(out.changed).toBe(true)
    expect(out.run.phase).toBe('failed')
    expect(out.run.subagent_status).toBe('crashed')
    expect(out.run.failure_reason).toBe('pid gone')
  })

  test('completed transition advances phase, clears sub-agent slot, stamps clock', async () => {
    const run = makeRun({ phase: 'forge-init', ralph: false, subagent_run_id: 'forge-1', subagent_status: 'completed' })
    const out = await advanceTridentRun(run, depsWith({ status: 'completed', result: {} }))
    expect(out.changed).toBe(true)
    expect(out.run.phase).toBe('argus')
    expect(out.run.subagent_run_id).toBeNull()
    expect(out.run.subagent_status).toBeNull()
    expect(out.run.last_advanced_at).toBe(fixedNow)
  })

  test('terminal transition keeps the completing agent id for the audit trail', async () => {
    const run = makeRun({ phase: 'argus', subagent_run_id: 'argus-9', subagent_status: 'completed' })
    const out = await advanceTridentRun(run, depsWith({ status: 'completed', result: { approved: true } }))
    expect(out.run.phase).toBe('done')
    expect(out.run.subagent_run_id).toBe('argus-9')
    expect(out.run.subagent_status).toBe('completed')
  })

  test('stubAdvanceDeps never advances (always running)', async () => {
    const run = makeRun({ phase: 'argus' })
    const out = await advanceTridentRun(run, stubAdvanceDeps(() => fixedNow))
    expect(out.waiting).toBe(true)
    expect(out.changed).toBe(false)
  })
})
