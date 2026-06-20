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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-orch-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new TridentRunStore(db)
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

interface Harness {
  loop: TridentTickLoop
  session: TridentSessionManager
  hostCalls: string[][]
  dispatchCalls: number
}

interface HarnessOpts {
  dispatch: TridentDispatch
  numstat?: string
  hostResponder?: (cmd: string[]) => HostCommandResult
}

function buildHarness(opts: HarnessOpts): Harness {
  const hostCalls: string[][] = []
  const host = async (cmd: string[]): Promise<HostCommandResult> => {
    hostCalls.push(cmd)
    if (opts.hostResponder) return opts.hostResponder(cmd)
    if (cmd.includes('--numstat')) return ok(opts.numstat ?? '1\t1\tfile.ts')
    return ok()
  }
  const session = new TridentSessionManager({ dispatch: opts.dispatch })
  const { step } = buildTridentOrchestrator({
    session,
    run_host: host,
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
  })
  const loop = new TridentTickLoop({ store, step })
  return { loop, session, hostCalls, dispatchCalls: 0 }
}

/** Drive the loop tick-by-tick (draining background dispatches each tick)
 *  until the run reaches a terminal phase or the tick budget is spent. */
async function runToTerminal(
  h: Harness,
  run_id: string,
  max_ticks = 40,
): Promise<TridentRun> {
  for (let i = 0; i < max_ticks; i++) {
    await h.loop.runOnce()
    await h.session.drain()
    const r = store.get(run_id)
    if (r !== null && isTerminalPhase(r.phase)) return r
  }
  const r = store.get(run_id)
  throw new Error(`run did not terminate (last phase: ${r?.phase})`)
}

/** Scripted Forge/Argus dispatch: Forge emits the contract lines; Argus
 *  walks a verdict script. */
function scriptedDispatch(opts: {
  branch?: string
  pr?: number
  argus_verdicts: string[]
}): { dispatch: TridentDispatch; forgeCalls: () => number; argusCalls: () => number } {
  let argus = 0
  let forge = 0
  const branch = opts.branch ?? 'feat-x'
  const pr = opts.pr ?? 42
  const dispatch: TridentDispatch = async (input) => {
    if (input.kind === 'forge') {
      forge++
      return {
        result: `built it\nPR_NUMBER=${pr}\nBRANCH=${branch}\nWORKTREE=/repo`,
        status: 'completed',
      }
    }
    const verdict = opts.argus_verdicts[argus] ?? 'APPROVE'
    argus++
    return { result: verdict, status: 'completed' }
  }
  return { dispatch, forgeCalls: () => forge, argusCalls: () => argus }
}

async function createRun(overrides: Partial<Parameters<TridentRunStore['create']>[0]> = {}) {
  return store.create({
    slug: 'add-thing',
    project_slug: 't1',
    repo_path: '/repo',
    task: 'Add a thing',
    branch: 'feat-x',
    ...overrides,
  })
}

describe('trident orchestrator — happy path (forge-init → argus APPROVE → merge → done)', () => {
  test('pr mode: walks to done and runs gh pr merge --squash', async () => {
    const s = scriptedDispatch({ argus_verdicts: ['APPROVE'] })
    const h = buildHarness({ dispatch: s.dispatch })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(final.pr).toBe(42)
    expect(final.branch).toBe('feat-x')

    const joined = h.hostCalls.map((c) => c.join(' '))
    expect(joined).toContain('gh pr merge 42 --squash')
    expect(joined.some((c) => c.includes('worktree'))).toBe(false)
    // exactly one forge build + one argus review.
    expect(s.forgeCalls()).toBe(1)
    expect(s.argusCalls()).toBe(1)
  })

  test('local mode: merges the branch into base locally, never calls gh', async () => {
    const s = scriptedDispatch({ argus_verdicts: ['APPROVE'] })
    const h = buildHarness({ dispatch: s.dispatch })
    const run = await createRun({ merge_mode: 'local' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')

    const joined = h.hostCalls.map((c) => c.join(' '))
    expect(joined).toContain('git -C /repo checkout main')
    expect(joined.some((c) => c.startsWith('git -C /repo merge --no-ff feat-x'))).toBe(true)
    expect(joined).toContain('git -C /repo branch -D feat-x')
    expect(joined.some((c) => c.startsWith('gh '))).toBe(false)
  })
})

describe('trident orchestrator — REQUEST CHANGES routes through forge-fix', () => {
  test('forge-init → argus(RC) → forge-fix → argus(APPROVE) → merge → done', async () => {
    const s = scriptedDispatch({ argus_verdicts: ['REQUEST CHANGES\n1. fix the bug', 'APPROVE'] })
    const h = buildHarness({ dispatch: s.dispatch })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(final.round).toBe(2) // one fix round happened
    // 2 forge runs (init + 1 fix), 2 argus rounds.
    expect(s.forgeCalls()).toBe(2)
    expect(s.argusCalls()).toBe(2)
    expect(h.hostCalls.map((c) => c.join(' '))).toContain('gh pr merge 42 --squash')
  })
})

describe('trident orchestrator — max rounds exhaustion → failed', () => {
  test('persistent REQUEST CHANGES hits the cap and fails without merging', async () => {
    const s = scriptedDispatch({ argus_verdicts: ['REQUEST CHANGES', 'REQUEST CHANGES', 'REQUEST CHANGES'] })
    const h = buildHarness({ dispatch: s.dispatch })
    const run = await createRun({ merge_mode: 'pr' as MergeMode, max_rounds: 2 })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('max_rounds')
    // never merged.
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})

describe('trident orchestrator — crash routes to failed', () => {
  test('a forge-init with no contract lines fails the run', async () => {
    const dispatch: TridentDispatch = async () => ({ result: 'no contract here', status: 'completed' })
    const h = buildHarness({ dispatch })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.subagent_status).toBe('crashed')
  })
})

describe('trident orchestrator — resume safety (no double-spawn)', () => {
  test('a re-entrant tick while the sub-agent is in flight does NOT spawn again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const dispatch: TridentDispatch = async (input) => {
      if (input.kind === 'argus') return { result: 'APPROVE', status: 'completed' }
      calls++
      await gate
      return { result: 'PR_NUMBER=1\nBRANCH=feat-x\nWORKTREE=/repo', status: 'completed' }
    }
    const h = buildHarness({ dispatch })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    // Tick 1 spawns forge-init (dispatch fired, pending on the gate).
    await h.loop.runOnce()
    const afterSpawn = store.get(run.id)
    expect(afterSpawn?.subagent_run_id).not.toBeNull()
    expect(afterSpawn?.phase).toBe('forge-init')
    expect(calls).toBe(1)

    // Tick 2 + 3 re-enter WITHOUT the dispatch having resolved — must poll,
    // not re-spawn.
    await h.loop.runOnce()
    await h.loop.runOnce()
    expect(calls).toBe(1)
    expect(h.session.runningCount()).toBe(1)
    expect(store.get(run.id)?.phase).toBe('forge-init')

    // Release + finish so the run can complete cleanly.
    release()
    await h.session.drain()
    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
  })
})

describe('trident orchestrator — oversized-diff guard at argus spawn', () => {
  test('a >3000-line branch diff steers Argus to the meaty-commits scope', async () => {
    // Capture the Argus prompt by spying through a dispatch that records it.
    let argusPrompt = ''
    const dispatch: TridentDispatch = async (input) => {
      if (input.kind === 'forge') {
        return { result: 'PR_NUMBER=42\nBRANCH=feat-x\nWORKTREE=/repo', status: 'completed' }
      }
      argusPrompt = input.user_message
      return { result: 'APPROVE', status: 'completed' }
    }
    // numstat sums to 5000 changed lines → over the 3000 ceiling.
    const h = buildHarness({ dispatch, numstat: '5000\t0\tbig.ts' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    expect(argusPrompt).toContain('OVER')
    expect(argusPrompt).toContain('git log --oneline main..HEAD')
    expect(argusPrompt).toContain('could not verify')
  })

  test('a small branch diff lets Argus read the full diff', async () => {
    let argusPrompt = ''
    const dispatch: TridentDispatch = async (input) => {
      if (input.kind === 'forge') {
        return { result: 'PR_NUMBER=42\nBRANCH=feat-x\nWORKTREE=/repo', status: 'completed' }
      }
      argusPrompt = input.user_message
      return { result: 'APPROVE', status: 'completed' }
    }
    const h = buildHarness({ dispatch, numstat: '10\t5\tsmall.ts' })
    const run = await createRun({ merge_mode: 'pr' as MergeMode })

    await runToTerminal(h, run.id)
    expect(argusPrompt).toContain('git diff main..HEAD')
    expect(argusPrompt).not.toContain('OVER')
  })
})
