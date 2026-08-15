/**
 * PUBLISH HANDOFF (defect 2026-08-14, run `3d2696c3`) — AS-BUILT behavioral
 * coverage over the REAL `inner-workflow.mjs` body.
 *
 * The bug: a PR-mode build that succeeded, committed, and left the branch one
 * commit ahead of its remote was DISCARDED because the workflow threw
 * `forge:build completed without a full local commit OID for the outer publisher`
 * — the build agent had relayed no 40-char sha. A commit OID is READ from git by
 * the publisher (`rev-parse --verify` on the branch this workflow NAMES), never
 * reported by a model, so the shape of a model-relayed sha must never be able to
 * end a finished build.
 *
 * The fix: both publish handoffs (build + fix-round) write the
 * `publishRequested: true` terminal result unconditionally; `publishHead` is a
 * best-effort CROSS-CHECK — the trimmed claim when it is 7–40 hex, else null.
 *
 * Harness copied from `inner-workflow-ralph-refire.test.ts`: read the
 * un-importable script (top-level `return` + Workflow-runtime globals), strip the
 * single `export`, and run the body as an AsyncFunction with MOCKED runtime
 * globals that RECORD every `agent()` label. `dbPath`/`runId` are null so the
 * checkpoint + terminal-result Bash steps no-op — the workflow's top-level
 * `return` value is what `await fn(...)` yields, so we assert it directly.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

interface PublishRun {
  labels: string[]
  result: {
    ok: boolean
    verdict: string | null
    prNumber: number | null
    branch: string
    checkpoint: string
    publishRequested: boolean
    publishHead: string | null
  }
}

/** Drive the REAL inner-workflow body in PR mode, with forge:build reporting
 *  `commitSha` exactly as given (including the empty string = no sha at all). */
async function runPublish(commitSha: string): Promise<PublishRun> {
  const labels: string[] = []

  const agent = async (_prompt: string, opts?: { label?: string }): Promise<unknown> => {
    const label = opts?.label
    if (label !== undefined) labels.push(label)
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      return {
        prNumber: null,
        branch: 'trident/pub-run',
        diffFile: '/tmp/pub.diff',
        worktreePath: '/wt',
        commitSha,
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
    task: 'Ship the thing',
    baseBranch: 'main',
    slug: 'pub-run', // → forgeBranch === 'trident/pub-run'
    maxRounds: 3,
    ralph: false,
    mergeMode: 'pr', // ← isPr: the run returns at the forge-done publish handoff
    prNumber: null,
    branch: null,
    dbPath: null, // → checkpoint()/writeTerminalResult() no-op; the RETURN carries the result
    runId: null,
    resumeCheckpoint: null,
    codexHome: null,
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as PublishRun['result']
  return { labels, result }
}

describe('inner-workflow.mjs — publish handoff (defect 2026-08-14, executed over the real body)', () => {
  test('no sha at all → still hands off a publishRequested result with publishHead null', async () => {
    const { labels, result } = await runPublish('')

    expect(result.ok).toBe(true)
    expect(result.publishRequested).toBe(true)
    expect(result.publishHead).toBeNull()
    expect(result.checkpoint).toBe('forge-done')
    // The BRANCH NAME is the handoff — what the publisher rev-parses.
    expect(result.branch).toBe('trident/pub-run')
    expect(result.prNumber).toBeNull()
    // Not an approved/mergeable result — publication, not provenance.
    expect(result.verdict).not.toBe('APPROVE')
    // It returned AT the handoff: no review panel ran.
    expect(labels).toContain('forge:build')
    expect(labels.some((l) => l.startsWith('argus:'))).toBe(false)
  })

  test('abbreviated 7-char sha → carried VERBATIM as the claim', async () => {
    const { result } = await runPublish('abc1234')

    expect(result.publishHead).toBe('abc1234')
    expect(result.publishRequested).toBe(true)
  })

  test('full 40-hex sha → carried verbatim', async () => {
    const full = '9a46680'.padEnd(40, '0')
    const { result } = await runPublish(full)

    expect(result.publishHead).toBe(full)
    expect(result.publishRequested).toBe(true)
  })

  test('SOURCE: neither publish handoff can throw over sha shape any more', () => {
    // Covers BOTH sites — build and fix-round shared this message stem.
    expect(SRC).not.toContain('without a full local commit OID')
    // Both handoffs go through the best-effort claim helper (2 call sites,
    // excluding the `function oidClaim(` definition).
    const calls = SRC.split('oidClaim(').length - 1 - (SRC.split('function oidClaim(').length - 1)
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
