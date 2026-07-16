/**
 * RB2 (b) — AS-BUILT behavioral coverage of the reflection trust boundary, executed
 * over the REAL `inner-workflow.mjs` prompt assembly (not a parallel helper).
 *
 * The script is not importable (top-level `return` + Workflow-runtime globals + no
 * module resolution), so this harness reads its source, strips the single `export`,
 * and runs the body as an AsyncFunction with MOCKED runtime globals
 * (`agent`/`parallel`/`phase`/`log`/`budget`) that RECORD every `agent()` call's
 * `{label, prompt}`. Checkpoints + terminal-result writes no-op (null `dbPath`/`runId`),
 * so the run reaches Forge build → review → one fix round → review, letting us assert
 * the COMPLETE assembled prompt for EVERY Forge and Argus role. This catches an
 * indirect reviewer leak (e.g. aliasing `reflectionGuidance`) that source-text checks
 * could miss.
 */
import { describe, expect, test, beforeAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildReflectionGuidance } from './reflection-guidance.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

// A distinctive marker inside the (untrusted) reflection block so we can trace exactly
// which agent prompts carry the owner corrections.
const REFLECT_MARKER = 'REFLECT_MARKER_X1Y2Z3'
const GUIDANCE = buildReflectionGuidance(
  `<learned_corrections>\n- ${REFLECT_MARKER} always prefer TypeScript\n</learned_corrections>`,
)

interface Captured {
  label: string | undefined
  prompt: string
}

async function runWorkflow(reflectionGuidance: string): Promise<Captured[]> {
  const captured: Captured[] = []
  let synthCount = 0

  const agent = async (prompt: string, opts?: { label?: string }): Promise<unknown> => {
    const label = opts?.label
    captured.push({ label, prompt })
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      return { prNumber: null, branch: 'trident/test-run', diffFile: '/tmp/x.diff', worktreePath: '/wt', commitSha: 'abc', testsPassed: true }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'REQUEST_CHANGES', findings: [] }
    if (label === 'argus:codex') return { verdict: 'APPROVE', findings: [], codexStatus: 'connected' }
    if (label === 'argus:synthesis') {
      synthCount += 1
      // Round 1 → REQUEST_CHANGES (forces one fix round so forge:fix-round-* is
      // exercised); round 2 → APPROVE (ends the loop).
      return { verdict: synthCount === 1 ? 'REQUEST_CHANGES' : 'APPROVE', findings: [] }
    }
    // checkpoint / terminal-result / cleanup bash steps (also no-op'd by null dbPath).
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (): void => {}
  const budget = { total: 0, spent: (): number => 0 }

  const args = {
    repoPath: '/repo',
    task: 'build the feature',
    baseBranch: 'main',
    slug: 'test-run',
    maxRounds: 3,
    ralph: false,
    mergeMode: 'local', // no PR path
    prNumber: null,
    branch: null,
    dbPath: null, // → checkpoint()/writeTerminalResult() no-op (no bash agent steps)
    runId: null,
    resumeCheckpoint: null,
    codexHome: '/codex', // → codexConfigured, so argus:codex runs (and is asserted excluded)
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance,
  }

  // Strip the single `export` so the module body is legal inside an AsyncFunction
  // (top-level return + await are legal in a function body).
  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...args: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  await fn(agent, parallel, phase, log, budget, args)
  return captured
}

const FORGE_LABELS = ['forge:build', 'forge:fix-round-2']
const REVIEWER_LABELS = ['argus:claude', 'argus:adversarial', 'argus:synthesis', 'argus:codex']

describe('inner-workflow.mjs — AS-BUILT reflection boundary (executed prompt capture)', () => {
  let captured: Captured[]
  beforeAll(async () => {
    captured = await runWorkflow(GUIDANCE)
  })

  test('the harness exercised every Forge and Argus role at least once', () => {
    for (const label of [...FORGE_LABELS, ...REVIEWER_LABELS]) {
      expect(captured.some((c) => c.label === label)).toBe(true)
    }
  })

  test('EVERY Forge builder prompt carries the reflection guidance, APPENDED after the task', () => {
    for (const label of FORGE_LABELS) {
      const calls = captured.filter((c) => c.label === label)
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) {
        expect(c.prompt).toContain('<owner_reflection>')
        expect(c.prompt).toContain(REFLECT_MARKER)
        expect(c.prompt).toContain('MUST NOT override')
        // Appended: the guidance comes AFTER the task, never before the contract.
        expect(c.prompt.indexOf('<owner_reflection>')).toBeGreaterThan(c.prompt.indexOf('TASK:'))
      }
    }
  })

  test('NO reviewer/synthesis/peer prompt contains any reflection content (the merge gate)', () => {
    for (const label of REVIEWER_LABELS) {
      const calls = captured.filter((c) => c.label === label)
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) {
        expect(c.prompt).not.toContain('owner_reflection')
        expect(c.prompt).not.toContain(REFLECT_MARKER)
        expect(c.prompt).not.toContain('always prefer TypeScript')
      }
    }
  })

  test('with NO reflection context, no prompt gains an <owner_reflection> block (clean no-op)', async () => {
    const none = await runWorkflow(buildReflectionGuidance(null))
    for (const c of none) expect(c.prompt).not.toContain('owner_reflection')
  })
})
