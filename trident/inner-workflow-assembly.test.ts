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

interface RunOpts {
  /**
   * Labels whose agent returns NOTHING — the seat was DISPATCHED and its agent died.
   * This is the case the panel-completeness gate exists for, and the only way to
   * produce it against the REAL panel is to kill a seat by its label and let the
   * workflow assign the slots itself.
   */
  dead?: string[]
  /**
   * Every surviving seat APPROVEs, on round 1. Then the ONLY thing that can keep the
   * run from returning APPROVE is the completeness gate — nothing else is in the way.
   */
  approveAll?: boolean
  /**
   * Run in Ralph mode, which is the ONLY way `plan:fable` is dispatched — the planner
   * prompt is unreachable otherwise, so a rule spliced only into the non-Ralph path
   * would look covered while the planner never sees it.
   */
  ralph?: boolean
}

async function runWorkflow(
  reflectionGuidance: string,
  opts: RunOpts = {},
): Promise<{ captured: Captured[]; result: Record<string, unknown> }> {
  const captured: Captured[] = []
  let synthCount = 0
  const dead = new Set(opts.dead ?? [])

  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label
    captured.push({ label, prompt })
    // A DEAD SEAT: dispatched, returned nothing. Checked FIRST so it can kill any
    // label, including a retry lane ('argus:codex-retry').
    if (dead.has(String(label))) return null
    if (label === 'forge:build' || String(label).startsWith('forge:fix-round-')) {
      return { prNumber: null, branch: 'trident/test-run', diffFile: '/tmp/x.diff', worktreePath: '/wt', commitSha: 'abc', testsPassed: true }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') {
      return { verdict: opts.approveAll === true ? 'APPROVE' : 'REQUEST_CHANGES', findings: [] }
    }
    if (label === 'plan:fable') {
      // `remainingTasks: 0` so the run does NOT hand back to the outer loop for a
      // re-fire — it continues into forge:build + the full review panel.
      return {
        implementationPlan: '- [ ] the one task',
        topTask: 'the one task',
        executionSpec: 'TARGET FILES: x.ts',
        complexity: 'reasoning',
        remainingTasks: 0,
      }
    }
    if (label === 'argus:kimi' || label === 'argus:kimi-retry') {
      return { verdict: 'APPROVE', findings: [], kimiStatus: 'connected' }
    }
    if (label === 'argus:codex' || label === 'argus:codex-retry') {
      // `codexTruncated` included because CODEX_VERDICT_SCHEMA REQUIRES it — a mock
      // that omits it is a bridge that dropped it, which is a different case (and
      // deliberately reads as PARTIAL, SCOPE UNKNOWN).
      return { verdict: 'APPROVE', findings: [], codexStatus: 'connected', codexTruncated: false }
    }
    if (label === 'argus:synthesis') {
      synthCount += 1
      // Round 1 → REQUEST_CHANGES (forces one fix round so forge:fix-round-* is
      // exercised); round 2 → APPROVE (ends the loop). Under `approveAll` the
      // synthesis APPROVEs immediately, so the gate is the only remaining actor.
      return { verdict: opts.approveAll === true || synthCount > 1 ? 'APPROVE' : 'REQUEST_CHANGES', findings: [] }
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
    ralph: opts.ralph === true,
    mergeMode: 'local', // no PR path
    prNumber: null,
    branch: null,
    dbPath: null, // → checkpoint()/writeTerminalResult() no-op (no bash agent steps)
    runId: null,
    resumeCheckpoint: null,
    codexHome: '/codex', // → codexConfigured, so argus:codex runs (and is asserted excluded)
    kimiConfigured: true, // → the kimi cross-model seat runs too, so its prompt is captured
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
  const result = (await fn(agent, parallel, phase, log, budget, args)) as Record<string, unknown>
  return { captured, result }
}

const FORGE_LABELS = ['forge:build', 'forge:fix-round-2']
const REVIEWER_LABELS = ['argus:claude', 'argus:adversarial', 'argus:synthesis', 'argus:codex']

describe('inner-workflow.mjs — AS-BUILT reflection boundary (executed prompt capture)', () => {
  let captured: Captured[]
  beforeAll(async () => {
    captured = (await runWorkflow(GUIDANCE)).captured
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
    const { captured: none } = await runWorkflow(buildReflectionGuidance(null))
    for (const c of none) expect(c.prompt).not.toContain('owner_reflection')
  })
})

/**
 * PANEL COMPLETENESS, DRIVEN THROUGH THE REAL PANEL — the seat is killed by its LABEL
 * and the workflow assigns its own slot.
 *
 * The unit tests for `missingCoreReviewers` / `crossModelPeerStatus` hand them a
 * hand-built `verdicts` array, so they assert the predicates in isolation and CANNOT
 * see the one assumption the whole gate rests on: that `CORE_REVIEWER_SEATS`' hardcoded
 * slots 0 and 1 really are argus:claude and argus:adversarial in the assembled
 * `reviewers` array. Nothing else pins that. Insert a reviewer ahead of them — or
 * reorder the two — and the gate keys on the wrong seats while every unit test stays
 * green, which is the FAIL-OPEN direction: the moved seat's death stops being gated.
 * That is the same positional-indexing trap the source already calls out for codex
 * ("POSITIONAL INDEXING WAS A LATENT BUG"), and it deserves an executable guard rather
 * than a convention.
 *
 * So these run the REAL workflow body and assert on the RETURNED VERDICT: not that a
 * blocker was recorded somewhere, but that the run actually REFUSED to approve.
 */
describe('inner-workflow.mjs — AS-BUILT: a dead seat is REFUSED an APPROVE through the real panel', () => {
  test('CONTROL — every seat answers, so the run APPROVEs (the gate is not always-on)', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, { approveAll: true })
    expect(result['verdict']).toBe('APPROVE')
    expect(result['blockKind']).toBe('none')
    // …and no seat was described to the synthesis as dead.
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).not.toContain('DID NOT COMPLETE')
  })

  test('argus:claude DIED → the run REFUSES to APPROVE, and slot 0 really is that seat', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, { approveAll: true, dead: ['argus:claude'] })
    // THE BEHAVIOUR, not the bookkeeping: same inputs as the control, one dead seat,
    // and the answer flips from APPROVE to a refusal.
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    // …classified as a lane failure, so the fix loop does not re-Forge a dead agent —
    // and the loop exits immediately, on round 1.
    expect(result['blockKind']).toBe('infra-only')
    expect(result['round']).toBe(1)
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    // The dead seat is Verdict A, which is what pins slot 0 to argus:claude.
    expect(synth?.prompt).toContain('Verdict A (Claude rubric): DID NOT COMPLETE')
    // The exact regression: a verdict-shaped blank a synthesis model reads as
    // "this reviewer raised nothing".
    expect(synth?.prompt).not.toContain('Verdict A (Claude rubric): null')
    // The SURVIVING seat is still reported normally — the hedge is per-seat.
    expect(synth?.prompt).toContain('Verdict B (Claude adversarial): {')
  })

  test('argus:adversarial DIED → the run REFUSES to APPROVE, and slot 1 really is that seat', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, { approveAll: true, dead: ['argus:adversarial'] })
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    expect(result['blockKind']).toBe('infra-only')
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).toContain('Verdict B (Claude adversarial): DID NOT COMPLETE')
    expect(synth?.prompt).not.toContain('Verdict B (Claude adversarial): null')
    expect(synth?.prompt).toContain('Verdict A (Claude rubric): {')
  })

  test('BOTH core seats DIED → still refused, with a blocker for each', async () => {
    const { captured, result } = await runWorkflow(GUIDANCE, {
      approveAll: true,
      dead: ['argus:claude', 'argus:adversarial'],
    })
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).toContain('Verdict A (Claude rubric): DID NOT COMPLETE')
    expect(synth?.prompt).toContain('Verdict B (Claude adversarial): DID NOT COMPLETE')
  })

  test('a CONFIGURED codex that DIED (and whose retry died) is refused, not read as never-configured', async () => {
    // The cross-model half of the same fix, through the real slot assignment: codexHome
    // is set, so the seat exists and its emptiness is a review we did not get. The retry
    // lane is killed too, or the round would silently heal.
    const { captured, result } = await runWorkflow(GUIDANCE, {
      approveAll: true,
      dead: ['argus:codex', 'argus:codex-retry'],
    })
    expect(result['verdict']).toBe('REQUEST_CHANGES')
    expect(result['blockKind']).toBe('infra-only')
    const synth = captured.find((c) => c.label === 'argus:synthesis')
    expect(synth?.prompt).toContain('Verdict C (codex cross-model): DEFERRED')
    // NOT the graceful never-set-up path, which does not block.
    expect(synth?.prompt).not.toContain('Verdict C (codex cross-model): NOT CONNECTED')
    // The core seats answered, so only codex is hedged.
    expect(synth?.prompt).not.toContain('DID NOT COMPLETE')
  })
})

/**
 * NO-PATTERN-KILL, ASSERTED ON THE COMPOSED PROMPT — not on the constant.
 *
 * A rule constant that nothing splices in is the same defect one layer up: the source
 * text `const NO_PATTERN_KILL_RULE = …` can be present and correct while a given agent
 * never receives a word of it. Only the ASSEMBLED prompt the agent is actually handed
 * proves coverage, so these run the real workflow body and assert on what `agent()`
 * was called with — the same technique the reflection-boundary suite above uses.
 *
 * This caught the real gap: argus:adversarial (a CORE reviewer seat) and both
 * cross-model bridges build their prompts INLINE rather than from `ARGUS_RUBRIC`, so
 * splicing the rule into the rubric left three command-running seats uncovered.
 *
 * Scope is "every agent that can run a shell command", because that is exactly the set
 * that can `pkill`. argus:synthesis is deliberately excluded and asserted excluded: it
 * merges verdict TEXT and is handed no tools, which is why it carries neither of the
 * two pre-existing rules either.
 */
describe('inner-workflow.mjs — AS-BUILT: every command-running agent is told not to pattern-kill', () => {
  // Verbatim fragments of the shipped rule. Retyped deliberately: reading the constant
  // out of the source and asserting the prompt contains it would pass even if the rule
  // were softened to "avoid pkill when convenient" — these pin the MEANING.
  const SHARED_BOX = 'YOU SHARE THIS MACHINE WITH OTHER BUILD LANES'
  const PROHIBITION = 'NEVER kill processes by pattern or by name'
  const CARVE_OUT = 'Kill ONLY a pid you started yourself and can name'

  /** Every seat that is handed a shell, in BOTH modes. `plan:fable` is Ralph-only. */
  const COMMAND_RUNNING_LABELS = [
    'forge:build',
    'forge:fix-round-2',
    'argus:claude',
    'argus:adversarial',
    'argus:codex',
    'argus:kimi',
  ]

  let captured: Captured[]
  let ralphCaptured: Captured[]
  beforeAll(async () => {
    captured = (await runWorkflow(GUIDANCE)).captured
    ralphCaptured = (await runWorkflow(GUIDANCE, { ralph: true })).captured
  })

  test('the harness actually dispatched every seat it claims to cover', () => {
    for (const label of COMMAND_RUNNING_LABELS) {
      expect(captured.some((c) => c.label === label)).toBe(true)
    }
    // The planner exists ONLY in Ralph mode — assert the mode really produced it,
    // or its coverage test below would vacuously pass over an empty call list.
    expect(ralphCaptured.some((c) => c.label === 'plan:fable')).toBe(true)
  })

  test('EVERY command-running prompt carries the rule, with the reason and the carve-out', () => {
    for (const label of COMMAND_RUNNING_LABELS) {
      const calls = captured.filter((c) => c.label === label)
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) {
        // The REASON is other lanes, not the agent's own safety.
        expect(c.prompt).toContain(SHARED_BOX)
        // An ABSOLUTE prohibition, and it names the binaries by hand.
        expect(c.prompt).toContain(PROHIBITION)
        expect(c.prompt).toContain('`pkill`')
        expect(c.prompt).toContain('`killall`')
        expect(c.prompt).toContain('kill $(pgrep')
        // …but a pid-scoped kill of something the agent started is still ALLOWED,
        // or agents would be unable to stop their own background processes.
        expect(c.prompt).toContain(CARVE_OUT)
        expect(c.prompt).toContain('`$!`')
      }
    }
  })

  test('the Ralph PLANNER gets it too — the planner spawns processes like any other seat', () => {
    const plan = ralphCaptured.filter((c) => c.label === 'plan:fable')
    expect(plan.length).toBeGreaterThan(0)
    for (const c of plan) {
      expect(c.prompt).toContain(SHARED_BOX)
      expect(c.prompt).toContain(PROHIBITION)
      expect(c.prompt).toContain(CARVE_OUT)
    }
    // …and Ralph's forge:build, which is assembled through a DIFFERENT path (it gets
    // the planner's execution note appended), keeps the rule.
    const forge = ralphCaptured.filter((c) => c.label === 'forge:build')
    expect(forge.length).toBeGreaterThan(0)
    for (const c of forge) expect(c.prompt).toContain(PROHIBITION)
  })

  test('it is stated as a PROHIBITION, never softened into advice', () => {
    const forge = captured.find((c) => c.label === 'forge:build')
    expect(forge).toBeDefined()
    const prompt = String(forge?.prompt)
    // No hedge anywhere in the sentence that carries the rule.
    const sentence = prompt.slice(prompt.indexOf(SHARED_BOX), prompt.indexOf(CARVE_OUT))
    for (const hedge of ['try to avoid', 'prefer not', 'should avoid', 'if possible', 'generally']) {
      expect(sentence.toLowerCase()).not.toContain(hedge)
    }
    // And it tells the agent what to do INSTEAD, so "work around it" is the escape
    // hatch rather than killing a process it did not start.
    expect(prompt).toContain('do NOT kill it — work around it')
  })

  test('argus:synthesis is toolless, so it gets none of the three shell rules (not an omission)', () => {
    const synth = captured.filter((c) => c.label === 'argus:synthesis')
    expect(synth.length).toBeGreaterThan(0)
    for (const c of synth) {
      expect(c.prompt).not.toContain(SHARED_BOX)
      // The pre-existing rules are absent for the same reason — this is the control
      // that shows exclusion is the file's convention for a toolless seat.
      expect(c.prompt).not.toContain('NEVER call AskUserQuestion')
      expect(c.prompt).not.toContain('redirect stdout+stderr to a log file')
    }
  })
})
