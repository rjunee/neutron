import { describe, expect, test } from 'bun:test'
import {
  TridentSessionManager,
  type ForgeMeta,
  type TridentDispatch,
  type TridentDispatchInput,
} from './session.ts'
import type { TridentPhase, TridentRun } from './store.ts'

function makeRun(overrides: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'run-1',
    slug: 's',
    project_slug: 't1',
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: 'b',
    pr: null,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/r',
    worktree: null,
    task: 't',
    chat_id: null,
    thread_id: null,
    failure_reason: null,
    started_at: '2026-01-01T00:00:00.000Z',
    last_advanced_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function dispatchReturning(
  fn: (input: TridentDispatchInput) => { result: string; status?: 'completed' | 'failed' | 'cancelled' | 'timed_out' },
): TridentDispatch {
  return async (input) => {
    const r = fn(input)
    return { result: r.result, status: r.status ?? 'completed' }
  }
}

let idSeq = 0
const mint = () => `agent-${++idSeq}`

function spawnInput(phase: TridentPhase, kind: 'forge' | 'argus' = 'forge'): TridentDispatchInput {
  return {
    kind,
    phase,
    system: 's',
    user_message: 'u',
    repo_path: '/r',
    trident_run_id: 'run-1',
    model: 'm',
    timeout_ms: 1000,
  }
}

describe('TridentSessionManager.spawn / classify lifecycle', () => {
  test('records running synchronously, then completed after drain', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: 'PR_NUMBER=5\nBRANCH=b\nWORKTREE=/r' })),
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('forge-init'))
    // Synchronously running — never a phantom poll (checked before any await
    // lets the immediate-resolving background dispatch settle).
    expect(mgr.runningCount()).toBe(1)
    expect(await mgr.classify(makeRun({ subagent_run_id: id }))).toEqual({ status: 'running' })

    await mgr.drain()
    const out = await mgr.classify(makeRun({ subagent_run_id: id }))
    expect(out.status).toBe('completed')
    expect(mgr.runningCount()).toBe(0)
  })

  test('forge meta is captured for the run id on a clean forge parse', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: 'PR_NUMBER=7\nBRANCH=feat\nWORKTREE=/wt' })),
      mint_run_id: mint,
    })
    mgr.spawn(spawnInput('forge-init'))
    await mgr.drain()
    const meta: ForgeMeta | null = mgr.forgeMetaFor('run-1')
    expect(meta).toEqual({ pr: 7, branch: 'feat', worktree: '/wt' })
  })

  test('forge-init with NO contract lines → crashed (no silent success)', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: 'I built it but forgot the contract' })),
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('forge-init'))
    await mgr.drain()
    const out = await mgr.classify(makeRun({ subagent_run_id: id }))
    expect(out.status).toBe('crashed')
  })

  test('ralph-plan with no REMAINING → completed{remaining:null} (state machine fails loud, NOT a crash)', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: 'planned some things, forgot the count' })),
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('ralph-plan'))
    await mgr.drain()
    const out = await mgr.classify(makeRun({ subagent_run_id: id }))
    expect(out).toEqual({ status: 'completed', result: { remaining: null } })
  })

  test('forge-fix with no contract lines → completed{} (transition ignores result)', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: 'fixed stuff' })),
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('forge-fix'))
    await mgr.drain()
    const out = await mgr.classify(makeRun({ subagent_run_id: id }))
    expect(out).toEqual({ status: 'completed', result: {} })
  })

  test('non-completed dispatch status → crashed', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: '', status: 'timed_out' })),
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('forge-init'))
    await mgr.drain()
    expect((await mgr.classify(makeRun({ subagent_run_id: id }))).status).toBe('crashed')
  })

  test('a throwing dispatch → crashed with the error message', async () => {
    const mgr = new TridentSessionManager({
      dispatch: async () => {
        throw new Error('substrate exploded')
      },
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('forge-init'))
    await mgr.drain()
    const out = await mgr.classify(makeRun({ subagent_run_id: id }))
    expect(out).toEqual({ status: 'crashed', reason: 'substrate exploded' })
  })
})

describe('TridentSessionManager — Argus verdict + findings', () => {
  test('APPROVE → completed{approved:true}, no findings', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: 'APPROVE' })),
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('argus', 'argus'))
    await mgr.drain()
    expect(await mgr.classify(makeRun({ subagent_run_id: id }))).toEqual({
      status: 'completed',
      result: { approved: true },
    })
    expect(mgr.findingsFor('run-1')).toEqual([])
  })

  test('REQUEST CHANGES → approved:false + findings captured for the run id', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: 'REQUEST CHANGES\n1. bug at a.ts:1\n2. missing test' })),
      mint_run_id: mint,
    })
    const id = mgr.spawn(spawnInput('argus', 'argus'))
    await mgr.drain()
    expect(await mgr.classify(makeRun({ subagent_run_id: id }))).toEqual({
      status: 'completed',
      result: { approved: false },
    })
    expect(mgr.findingsFor('run-1')).toEqual(['bug at a.ts:1', 'missing test'])
  })
})

describe('TridentSessionManager — guards', () => {
  test('classify with null subagent_run_id → running', async () => {
    const mgr = new TridentSessionManager({ dispatch: dispatchReturning(() => ({ result: '' })) })
    expect(await mgr.classify(makeRun({ subagent_run_id: null }))).toEqual({ status: 'running' })
  })

  test('unknown id defaults to running (no double-spawn, no false-fail)', async () => {
    const mgr = new TridentSessionManager({ dispatch: dispatchReturning(() => ({ result: '' })) })
    expect(await mgr.classify(makeRun({ subagent_run_id: 'never-seen' }))).toEqual({ status: 'running' })
  })

  test('unknown id can be configured to crash (orphan after restart)', async () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: '' })),
      unknown_session: 'crashed',
    })
    expect((await mgr.classify(makeRun({ subagent_run_id: 'orphan' }))).status).toBe('crashed')
  })

  test('an empty mint is rejected at spawn time (no phantom id)', () => {
    const mgr = new TridentSessionManager({
      dispatch: dispatchReturning(() => ({ result: '' })),
      mint_run_id: () => '',
    })
    expect(() => mgr.spawn(spawnInput('forge-init'))).toThrow(/empty id/)
  })
})
