/**
 * @neutronai/trident — Ralph build-mode integration tests (PR-4).
 *
 * Drives the real orchestrator tick loop through the governed,
 * spec-driven, one-task-per-fresh-context path:
 *
 *   forge-init (bootstrap) → ralph-plan ⇄ ralph-task → … → (REMAINING=0)
 *   → argus → merge → done
 *
 * The "substrate" is a scripted `TridentDispatch` that performs the REAL
 * filesystem side-effects a live Forge/planner session would: it writes
 * IMPLEMENTATION_PLAN.md, checks one task off per ralph-task, and appends
 * AS-BUILT.md. Assertions are against those real artifacts + the run's
 * terminal transitions — never bookkeeping.
 *
 * Also covers the fail-loud guards (missing/garbled REMAINING_TASKS at the
 * bootstrap AND at a planner pass), the `max_ralph_rounds` bound on a
 * non-converging planner, and `detectRalphMode`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../migrations/runner.ts'
import { ProjectDb } from '../persistence/index.ts'
import { detectRalphMode, defaultRalphModeProbe, type HostCommandResult } from './git-mode.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentSessionManager, type TridentDispatch } from './session.ts'
import { isTerminalPhase } from './state-machine.ts'
import { TridentRunStore, type TridentRun } from './store.ts'
import { TridentTickLoop } from './tick.ts'

let tmp: string
let repo: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-ralph-'))
  // The governed repo dir the scripted dispatch writes real artifacts into.
  repo = join(tmp, 'repo')
  mkdirSync(repo, { recursive: true })
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
}

function buildHarness(dispatch: TridentDispatch): Harness {
  const hostCalls: string[][] = []
  const host = async (cmd: string[]): Promise<HostCommandResult> => {
    hostCalls.push(cmd)
    if (cmd.includes('--numstat')) return ok('1\t1\tfile.ts')
    return ok()
  }
  const session = new TridentSessionManager({ dispatch })
  const { step } = buildTridentOrchestrator({
    session,
    run_host: host,
    base_branch: 'main',
    now: () => new Date(0).toISOString(),
  })
  const loop = new TridentTickLoop({ store, step })
  return { loop, session, hostCalls }
}

async function runToTerminal(h: Harness, run_id: string, max_ticks = 60): Promise<TridentRun> {
  for (let i = 0; i < max_ticks; i++) {
    await h.loop.runOnce()
    await h.session.drain()
    const r = store.get(run_id)
    if (r !== null && isTerminalPhase(r.phase)) return r
  }
  const r = store.get(run_id)
  throw new Error(`run did not terminate (last phase: ${r?.phase})`)
}

function createGovernedRun(overrides: Partial<Parameters<TridentRunStore['create']>[0]> = {}) {
  return store.create({
    slug: 'govern-it',
    project_slug: 't1',
    repo_path: repo,
    task: 'Make the code match SPEC.md',
    branch: 'feat-governed',
    ralph: true,
    merge_mode: 'pr',
    ...overrides,
  })
}

const PLAN = (r: string) => join(r, 'IMPLEMENTATION_PLAN.md')
const ASBUILT = (r: string) => join(r, 'AS-BUILT.md')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A scripted "substrate" that performs the REAL artifact side-effects: it
 * tracks a task list in IMPLEMENTATION_PLAN.md on disk, checks exactly one
 * task off per ralph-task, and appends AS-BUILT.md — so the loop converges
 * through genuine file state, and the count each pass reports is DERIVED
 * from the file (not faked).
 */
function governedSubstrate(opts: { tasks: string[]; pr?: number; branch?: string; argus?: string[] }) {
  const pr = opts.pr ?? 55
  const branch = opts.branch ?? 'feat-governed'
  let argusIdx = 0
  const counts = { forgeInit: 0, plan: 0, task: 0, argus: 0 }

  const writePlan = (r: string, done: boolean[]): void => {
    const body = opts.tasks.map((t, i) => `- [${done[i] ? 'x' : ' '}] ${t}`).join('\n')
    writeFileSync(PLAN(r), `# Implementation Plan\n\n${body}\n`)
  }
  const readDone = (r: string): boolean[] => {
    if (!existsSync(PLAN(r))) return opts.tasks.map(() => false)
    const text = readFileSync(PLAN(r), 'utf8')
    return opts.tasks.map((t) => new RegExp(`- \\[x\\] ${esc(t)}`).test(text))
  }
  const firstUnchecked = (done: boolean[]): string | null => {
    const i = done.findIndex((d) => !d)
    return i === -1 ? null : (opts.tasks[i] ?? null)
  }
  const unchecked = (done: boolean[]): number => done.filter((d) => !d).length

  const dispatch: TridentDispatch = async (input) => {
    const r = input.repo_path
    if (input.kind === 'argus') {
      const v = opts.argus?.[argusIdx] ?? 'APPROVE'
      argusIdx++
      counts.argus++
      return { result: v, status: 'completed' }
    }
    if (input.phase === 'forge-init') {
      counts.forgeInit++
      const done = opts.tasks.map(() => false)
      done[0] = true // bootstrap implements ONLY the first task
      writePlan(r, done)
      appendFileSync(ASBUILT(r), `- built: ${opts.tasks[0]}\n`)
      return {
        result: `bootstrapped\nPR_NUMBER=${pr}\nBRANCH=${branch}\nWORKTREE=${r}\nREMAINING_TASKS=${unchecked(done)}`,
        status: 'completed',
      }
    }
    if (input.phase === 'ralph-plan') {
      counts.plan++
      const done = readDone(r)
      writePlan(r, done) // docs-only regenerate
      const next = firstUnchecked(done)
      const lines = [`replanned`, `REMAINING_TASKS=${unchecked(done)}`]
      if (next !== null) lines.push(`NEXT_TASK=${next}`)
      return { result: lines.join('\n'), status: 'completed' }
    }
    // ralph-task — implement ONLY the one next task, check it off.
    counts.task++
    const done = readDone(r)
    const next = firstUnchecked(done)
    if (next !== null) {
      done[opts.tasks.indexOf(next)] = true
      writePlan(r, done)
      appendFileSync(ASBUILT(r), `- built: ${next}\n`)
    }
    return {
      result: `did one task\nPR_NUMBER=${pr}\nBRANCH=${branch}\nWORKTREE=${r}`,
      status: 'completed',
    }
  }
  return { dispatch, counts }
}

describe('detectRalphMode', () => {
  const hostReturning = (root: string) => async (cmd: string[]): Promise<HostCommandResult> => {
    if (cmd.includes('rev-parse')) return ok(root)
    return ok()
  }

  test('explicit flag forces Ralph even without a SPEC.md', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/nope'), async () => false)
    expect(await detectRalphMode('/nope', probe, { explicit: true })).toBe(true)
  })

  test('governed repo (git root has SPEC.md) → Ralph', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/root'), async (p) => p === '/root/SPEC.md')
    expect(await detectRalphMode('/root/sub', probe)).toBe(true)
  })

  test('ungoverned repo (no SPEC.md) → legacy single-context', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/root'), async () => false)
    expect(await detectRalphMode('/root', probe)).toBe(false)
  })

  test('a throwing probe degrades to legacy (never errors run creation)', async () => {
    const probe = defaultRalphModeProbe(hostReturning('/root'), async () => {
      throw new Error('fs exploded')
    })
    expect(await detectRalphMode('/root', probe)).toBe(false)
  })

  test('default probe against a real temp dir with SPEC.md detects governed', async () => {
    writeFileSync(join(repo, 'SPEC.md'), '# spec')
    // No git root in the temp dir → rev-parse fails → falls back to repoPath.
    const probe = defaultRalphModeProbe(async () => ok(''))
    expect(await detectRalphMode(repo, probe)).toBe(true)
  })
})

describe('Ralph loop — governed build converges through real plan↔task iterations', () => {
  test('forge-init → plan ⇄ task → (0 remaining) → argus → merge → done, with real artifacts', async () => {
    const sub = governedSubstrate({ tasks: ['task A', 'task B', 'task C'], argus: ['APPROVE'] })
    const h = buildHarness(sub.dispatch)
    const run = await createGovernedRun()

    const final = await runToTerminal(h, run.id)

    // Terminal transition: a governed build only merges once the plan is empty.
    expect(final.phase).toBe('done')
    expect(final.ralph).toBe(true)
    expect(final.pr).toBe(55)

    // REAL artifact: the plan exists and EVERY task is checked off.
    const plan = readFileSync(PLAN(repo), 'utf8')
    expect(existsSync(PLAN(repo))).toBe(true)
    expect(plan).toContain('- [x] task A')
    expect(plan).toContain('- [x] task B')
    expect(plan).toContain('- [x] task C')
    expect(plan).not.toContain('- [ ]')

    // REAL artifact: AS-BUILT records every built task.
    const asBuilt = readFileSync(ASBUILT(repo), 'utf8')
    for (const t of ['task A', 'task B', 'task C']) expect(asBuilt).toContain(`built: ${t}`)

    // Granularity: bootstrap did task A; the two remaining tasks each got
    // ONE fresh ralph-task (one-task-per-fresh-context). Three planning
    // passes ran (after bootstrap, after each task) — the active drift-catch.
    expect(sub.counts.forgeInit).toBe(1)
    expect(sub.counts.task).toBe(2)
    expect(sub.counts.plan).toBe(3)
    expect(sub.counts.argus).toBe(1)

    // Merged via the PR-mode path; review only ran after convergence.
    expect(h.hostCalls.map((c) => c.join(' '))).toContain('gh pr merge 55 --squash')
  })

  test('bootstrap reporting 0 remaining short-circuits straight to review (no planner/task)', async () => {
    // A single-task spec the bootstrap fully satisfies: it writes the plan,
    // builds the one task, reports REMAINING_TASKS=0 → straight to argus.
    const sub = governedSubstrate({ tasks: ['only task'], argus: ['APPROVE'] })
    const h = buildHarness(sub.dispatch)
    const run = await createGovernedRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('done')
    // No extra planner/task passes — the bootstrap's count drove the exit.
    expect(sub.counts.forgeInit).toBe(1)
    expect(sub.counts.plan).toBe(0)
    expect(sub.counts.task).toBe(0)
    // The bootstrap still wrote a real plan with the task checked off.
    expect(existsSync(PLAN(repo))).toBe(true)
    expect(readFileSync(PLAN(repo), 'utf8')).toContain('- [x] only task')
  })
})

describe('Ralph loop — fail-loud guards (never silently merge a partial governed build)', () => {
  test('bootstrap omits REMAINING_TASKS → failed, NOT merged', async () => {
    const dispatch: TridentDispatch = async (input) => {
      if (input.kind === 'argus') return { result: 'APPROVE', status: 'completed' }
      // PR contract present but NO REMAINING_TASKS line.
      return { result: `PR_NUMBER=9\nBRANCH=feat-governed\nWORKTREE=${input.repo_path}`, status: 'completed' }
    }
    const h = buildHarness(dispatch)
    const run = await createGovernedRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('REMAINING_TASKS')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })

  test('bootstrap emits a GARBLED REMAINING_TASKS → failed (strict ^[0-9]+$)', async () => {
    const dispatch: TridentDispatch = async (input) => {
      if (input.kind === 'argus') return { result: 'APPROVE', status: 'completed' }
      return {
        result: `PR_NUMBER=9\nBRANCH=feat-governed\nWORKTREE=${input.repo_path}\nREMAINING_TASKS=lots`,
        status: 'completed',
      }
    }
    const h = buildHarness(dispatch)
    const run = await createGovernedRun()

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('REMAINING_TASKS')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })

  test('a PLANNER pass omits REMAINING_TASKS → failed, NOT merged', async () => {
    let plans = 0
    const dispatch: TridentDispatch = async (input) => {
      if (input.kind === 'argus') return { result: 'APPROVE', status: 'completed' }
      if (input.phase === 'forge-init') {
        return {
          result: `PR_NUMBER=9\nBRANCH=feat-governed\nWORKTREE=${input.repo_path}\nREMAINING_TASKS=2`,
          status: 'completed',
        }
      }
      if (input.phase === 'ralph-plan') {
        plans++
        // The planner ran but forgot the count — must halt loudly.
        return { result: 'replanned but forgot the count', status: 'completed' }
      }
      return { result: `PR_NUMBER=9\nBRANCH=feat-governed\nWORKTREE=${input.repo_path}`, status: 'completed' }
    }
    const h = buildHarness(dispatch)
    const run = await createGovernedRun()

    const final = await runToTerminal(h, run.id)
    expect(plans).toBe(1)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('planner')
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})

describe('Ralph loop — max_ralph_rounds bounds a non-converging planner', () => {
  test('a planner that never reaches 0 fails loudly instead of spinning forever', async () => {
    // Planner ALWAYS reports work remaining; the cap must terminate the loop.
    const dispatch: TridentDispatch = async (input) => {
      if (input.kind === 'argus') return { result: 'APPROVE', status: 'completed' }
      if (input.phase === 'forge-init') {
        return {
          result: `PR_NUMBER=9\nBRANCH=feat-governed\nWORKTREE=${input.repo_path}\nREMAINING_TASKS=3`,
          status: 'completed',
        }
      }
      if (input.phase === 'ralph-plan') {
        return { result: `REMAINING_TASKS=3\nNEXT_TASK=never-ending`, status: 'completed' }
      }
      return { result: `PR_NUMBER=9\nBRANCH=feat-governed\nWORKTREE=${input.repo_path}`, status: 'completed' }
    }
    const h = buildHarness(dispatch)
    const run = await createGovernedRun({ max_ralph_rounds: 2 })

    const final = await runToTerminal(h, run.id)
    expect(final.phase).toBe('failed')
    expect(final.failure_reason).toContain('max_ralph_rounds')
    expect(final.ralph_round).toBeLessThanOrEqual(2)
    expect(h.hostCalls.map((c) => c.join(' ')).some((c) => c.includes('pr merge'))).toBe(false)
  })
})
