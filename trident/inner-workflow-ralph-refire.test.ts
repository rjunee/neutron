/**
 * RALPH RE-FIRE (#362) — AS-BUILT behavioral coverage of the inner loop's
 * one-task-per-fresh-context emit, executed over the REAL `inner-workflow.mjs`
 * body (not a parallel re-implementation).
 *
 * The bug: a multi-task Ralph build shipped after ONLY task 1 — the inner loop
 * built `plan.topTask`, logged `plan.remainingTasks`, and then went straight to
 * review→merge, never consuming the remaining count. The fix: in Ralph mode with
 * tasks still remaining after the one it builds, the iteration SKIPS review and
 * returns a typed intermediate result carrying `remainingTasks` so the OUTER loop
 * re-fires a fresh iteration for the next task; only the FINAL task (remaining 0)
 * runs the review→fix→merge path.
 *
 * Harness identical in spirit to `inner-workflow-assembly.test.ts`: read the
 * un-importable script (top-level `return` + Workflow-runtime globals), strip the
 * single `export`, and run the body as an AsyncFunction with MOCKED runtime
 * globals that RECORD every `agent()` label. `dbPath`/`runId` are null so the
 * checkpoint + terminal-result Bash steps no-op — the workflow's top-level
 * `return` value (the typed terminal result) is what `await fn(...)` yields, so we
 * assert it directly.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

interface RalphRun {
  labels: string[]
  result: {
    ok: boolean
    verdict: string | null
    prNumber: number | null
    branch: string
    checkpoint: string
    remainingTasks: number
  }
}

/** Drive the REAL inner-workflow body in Ralph mode with a plan that reports
 *  `remainingTasks` tasks still unchecked after the one this iteration builds. */
async function runRalph(remainingTasks: number): Promise<RalphRun> {
  const labels: string[] = []

  const agent = async (_prompt: string, opts?: { label?: string }): Promise<unknown> => {
    const label = opts?.label
    if (label !== undefined) labels.push(label)
    if (label === 'plan:fable') {
      return {
        implementationPlan: '- [ ] task A\n- [ ] task B\n- [ ] task C',
        topTask: 'task A',
        executionSpec: 'TARGET FILES: a.ts\nACCEPTANCE: does A\nTEST PLAN: a.test.ts',
        complexity: 'reasoning',
        remainingTasks,
      }
    }
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      return {
        prNumber: null,
        branch: 'trident/ralph-run',
        diffFile: '/tmp/ralph.diff',
        worktreePath: '/wt',
        commitSha: 'abc123',
        testsPassed: true,
      }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'APPROVE', findings: [] }
    if (label === 'argus:synthesis') return { verdict: 'APPROVE', findings: [] }
    // checkpoint / terminal-result / cleanup bash steps (checkpoint + terminal are
    // no-op'd by the null dbPath; cleanup still runs in finally).
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (): void => {}
  const budget = { total: 0, spent: (): number => 0 }

  const args = {
    repoPath: '/repo',
    task: 'Ship the multi-task feature',
    baseBranch: 'main',
    slug: 'ralph-run',
    maxRounds: 3,
    ralph: true, // ← Ralph mode
    mergeMode: 'local',
    prNumber: null,
    branch: null,
    dbPath: null, // → checkpoint()/writeTerminalResult() no-op; the RETURN carries the result
    runId: null,
    resumeCheckpoint: null,
    codexHome: null, // → argus:codex not run (simpler panel)
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as RalphRun['result']
  return { labels, result }
}

describe('inner-workflow.mjs — Ralph re-fire emit (#362, executed over the real body)', () => {
  test('tasks remain (2) → build ONE task, SKIP review, return an intermediate re-fire result', async () => {
    const { labels, result } = await runRalph(2)

    // It planned + built exactly one task.
    expect(labels).toContain('plan:fable')
    expect(labels).toContain('forge:build')
    // It did NOT review — the whole point of the fix (review is deferred to the
    // final task). No argus/synthesis/fix-round ran.
    expect(labels.some((l) => l.startsWith('argus:'))).toBe(false)
    expect(labels.some((l) => l.startsWith('forge:fix-round-'))).toBe(false)

    // The typed result is the outer loop's re-fire signal.
    expect(result.remainingTasks).toBe(2)
    expect(result.checkpoint).toBe('ralph-task-built')
    // NOT 'argus-approved' — the outer merge provenance gate can never fire on an
    // unreviewed intermediate.
    expect(result.verdict).not.toBe('APPROVE')
    expect(result.ok).toBe(true)
  })

  test('final task (0 remain) → review runs and the iteration returns an APPROVE terminal result', async () => {
    const { labels, result } = await runRalph(0)

    // The final iteration reviews the cumulative diff before merge.
    expect(labels).toContain('plan:fable')
    expect(labels).toContain('forge:build')
    expect(labels).toContain('argus:claude')
    expect(labels).toContain('argus:adversarial')
    expect(labels).toContain('argus:synthesis')

    // Terminal (mergeable) result — remaining 0 → no re-fire.
    expect(result.remainingTasks).toBe(0)
    expect(result.verdict).toBe('APPROVE')
    expect(result.checkpoint).toBe('argus-approved')
  })
})
