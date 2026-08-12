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
  /**
   * Run the FULL production wiring: pr merge-mode plus a threaded dbPath/runId/
   * checkpointScript.
   *
   * Without this the harness never dispatches `checkpoint:*`, `terminal-result` or
   * `ci-probe-round-*` at all — a null dbPath no-ops the first two and `isPr === false`
   * short-circuits the third — so any claim made about those seats' prompts was
   * vacuously true over an empty call list. They are exempt seats, and an exemption
   * that is never re-proved against a real prompt is exactly the hole the exemption
   * list exists to prevent.
   */
  pr?: boolean
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
      // A PR number only in pr-mode — `probeCi` needs one or it returns early and the
      // `ci-probe-round-*` seat is never dispatched.
      return { prNumber: opts.pr === true ? 4242 : null, branch: 'trident/test-run', diffFile: '/tmp/x.diff', worktreePath: '/wt', commitSha: 'abc', testsPassed: true }
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
    if (String(label).startsWith('ci-probe-round-')) {
      // A GREEN board, in the shape `gh pr checks --json` really prints, so the pr-mode
      // run classifies CI as passing and reaches the end of the workflow (an unparseable
      // reply classifies 'unknown', which blocks and would cut the run short of the
      // `terminal-result` seat this run exists to dispatch).
      return { raw: '[{"name":"test","state":"SUCCESS","link":"https://example.invalid/1"}]', exit_code: 0 }
    }
    // A DISTINCT sha per round, so each fix round reads as having LANDED (an unchanged
    // head is classified "did not land" and stops the loop before forge:fix-round-2).
    if (String(label).startsWith('head-probe-round-')) return { head: `sha-${String(label)}` }
    // checkpoint / terminal-result / cleanup bash steps.
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
    // pr-mode ALSO threads a dbPath/runId/checkpointScript, because those two switches
    // are what gate the three bookkeeping seats between them: `isPr` gates ci-probe,
    // dbPath+runId gate checkpoint/terminal-result.
    mergeMode: opts.pr === true ? 'pr' : 'local',
    prNumber: null,
    branch: null,
    dbPath: opts.pr === true ? '/tmp/trident-test.db' : null,
    runId: opts.pr === true ? 'test-run-id' : null,
    resumeCheckpoint: null,
    codexHome: '/codex', // → codexConfigured, so argus:codex runs (and is asserted excluded)
    kimiConfigured: true, // → the kimi seat runs and its prompt is captured
    checkpointScript: opts.pr === true ? '/repo/trident/checkpoint.sh' : null,
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
// EVERY reviewer seat, cross-model ones included. `argus:kimi` was missing, so the
// reflection merge-gate below never read the kimi bridge's prompt at all — appending the
// owner corrections to `kimiReviewerPrompt` leaked them into a dispatched reviewer with
// both suites green.
const REVIEWER_LABELS = [
  'argus:claude',
  'argus:adversarial',
  'argus:synthesis',
  'argus:codex',
  'argus:kimi',
]

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
 * that can `pkill`. The covered set is DERIVED from the labels the workflow actually
 * dispatched, minus an explicit, reasoned exclusion list — NEVER hand-listed. A
 * hand-list is drift-blind: it silently passes while a newly added shell seat goes
 * uncovered, which is precisely how `cleanup:worktree` shipped without the rule.
 */
describe('inner-workflow.mjs — AS-BUILT: every command-running agent is told not to pattern-kill', () => {
  // Verbatim fragments of the shipped rule. Retyped deliberately: reading the constant
  // out of the source and asserting the prompt contains it would pass even if the rule
  // were softened to "avoid pkill when convenient" — these pin the MEANING.
  const SHARED_BOX = 'YOU SHARE THIS MACHINE WITH OTHER BUILD LANES'
  const PROHIBITION = 'NEVER kill processes by pattern or by name'
  const CARVE_OUT = 'Kill ONLY a pid you started yourself and can name'
  /** The rule's LAST words — the far edge of the hedge-scan window. */
  const TAIL = 'work around it and say so in your report.'

  /**
   * The ONLY seats allowed to lack the rule, each with the reason it cannot pattern-kill.
   * Everything else the workflow dispatches is REQUIRED to carry it, so a new shell seat
   * fails this suite until it is either given the rule or consciously exempted here with
   * a justification. That inversion — deny-by-default instead of an allow-list of covered
   * labels — is the whole point of this rewrite.
   */
  /** A seat is handed ONE literal command and told to run exactly it — no room for a kill. */
  const isSingleCommandSeat = (p: string): boolean => p.includes('Run EXACTLY this single Bash command')

  const EXCLUDED: Array<{ match: (l: string) => boolean; why: string; proof: (prompt: string) => boolean }> = [
    // argus:synthesis USED TO BE EXEMPT HERE, as "toolless". That exemption was circular:
    // its only evidence was that the prompt omits the other shell rules, which is the
    // authoring choice the exemption was meant to justify, not evidence about the seat.
    // Nothing in inner-workflow.mjs grants or withholds tools — there is no allowedTools
    // plumbing at all — so argus:synthesis runs with the same default toolset as
    // argus:claude and can shell out. It now carries the rule and is covered like the rest.
    //
    // The probe/bookkeeping seats are each handed ONE literal command and told to run
    // EXACTLY it and nothing else, so there is no room in them for a kill of any shape.
    // `proof` is what keeps that claim HONEST: if one of these is ever loosened into a
    // free-form shell seat, the proof stops holding and this suite fails — the exclusion
    // cannot quietly rot into a hole.
    { match: (l) => l.startsWith('checkpoint:'), why: 'single fixed `bash checkpoint.sh …` command', proof: isSingleCommandSeat },
    { match: (l) => l === 'terminal-result', why: 'single fixed `printf … && bash checkpoint.sh …` command', proof: isSingleCommandSeat },
    { match: (l) => l.startsWith('head-probe-round-'), why: 'single fixed `git ls-remote`/`rev-parse` command', proof: isSingleCommandSeat },
    { match: (l) => l.startsWith('ci-probe-round-'), why: 'single fixed `gh pr checks` command', proof: isSingleCommandSeat },
  ]

  let captured: Captured[]
  let ralphCaptured: Captured[]
  let prCaptured: Captured[]
  let retryCaptured: Captured[]
  /** Every call from ALL modes — a rule spliced into only one path must not read as covered. */
  let allCalls: Captured[]
  /** Distinct dispatched labels that are NOT exempt → the set that must carry the rule. */
  let coveredLabels: string[]
  beforeAll(async () => {
    captured = (await runWorkflow(GUIDANCE)).captured
    ralphCaptured = (await runWorkflow(GUIDANCE, { ralph: true })).captured
    // THE PR PATH IS A SEPARATE DISPATCH SET, not a variation on the local one. Three
    // seats exist only here (checkpoint:*, terminal-result, ci-probe-round-*), so a
    // local-only harness derives `coveredLabels` from a panel that is missing them and
    // every claim about them — exemption proofs included — passes over an empty list.
    prCaptured = (await runWorkflow(GUIDANCE, { pr: true })).captured
    // THE RETRY LANES ARE ONLY REACHABLE THROUGH A DEAD PEER. With all mocks answering,
    // `argus:codex-retry`/`argus:kimi-retry` are never dispatched, so they never enter
    // `allCalls` and a shell seat added there would ship uncovered with the suite green.
    retryCaptured = (await runWorkflow(GUIDANCE, { dead: ['argus:codex', 'argus:kimi'] })).captured
    allCalls = [...captured, ...ralphCaptured, ...prCaptured, ...retryCaptured]
    coveredLabels = [...new Set(allCalls.map((c) => String(c.label)))]
      .filter((l) => !EXCLUDED.some((e) => e.match(l)))
      .sort()
  })

  test('the harness actually dispatched the seats this suite exists to cover', () => {
    // Pinned floor: if a refactor stops dispatching any of these, the derived set would
    // quietly shrink and the coverage test below would pass over a smaller panel.
    for (const label of [
      'forge:build',
      'forge:fix-round-2',
      'argus:claude',
      'argus:adversarial',
      'argus:codex',
      'argus:kimi',
      'argus:synthesis',
      // Reachable ONLY through a dead peer, and covered seats in their own right.
      'argus:codex-retry',
      'argus:kimi-retry',
      'cleanup:worktree',
    ]) {
      expect(coveredLabels).toContain(label)
    }
    // The planner exists ONLY in Ralph mode — assert the mode really produced it,
    // or its coverage test below would vacuously pass over an empty call list.
    expect(ralphCaptured.some((c) => c.label === 'plan:fable')).toBe(true)
  })

  test('the pr path dispatched the three seats that exist ONLY there', () => {
    // THE GUARD ON THE EXEMPTION PROOFS. Each of these is exempt, and an exemption is
    // only re-proved against prompts that were actually captured. If the pr-mode run
    // ever stops dispatching them, the proof loop below would silently iterate nothing
    // and the exclusion list would rot back into an unchecked allow-list.
    const prLabels = prCaptured.map((c) => String(c.label))
    expect(prLabels.some((l) => l.startsWith('checkpoint:'))).toBe(true)
    expect(prLabels.some((l) => l === 'terminal-result')).toBe(true)
    expect(prLabels.some((l) => l.startsWith('ci-probe-round-'))).toBe(true)
    expect(prLabels.some((l) => l.startsWith('head-probe-round-'))).toBe(true)
  })

  test('every EXEMPT seat still earns its exemption — no exclusion may rot into a hole', () => {
    // An exclusion list is only as trustworthy as the claim behind each entry. For every
    // seat that was actually dispatched AND exempted, re-prove the stated reason against
    // its real prompt. Loosening `head-probe` into a free-form shell seat, say, would keep
    // it exempt by label while making the exemption false — and this fails on that.
    const exempted = [...new Set(allCalls.map((c) => String(c.label)))].filter((l) =>
      EXCLUDED.some((e) => e.match(l)),
    )
    expect(exempted.length).toBeGreaterThan(0)
    for (const label of exempted) {
      const entry = EXCLUDED.find((e) => e.match(label))
      expect(entry).toBeDefined()
      expect(String(entry?.why).length).toBeGreaterThan(0)
      for (const c of allCalls.filter((x) => String(x.label) === label)) {
        // `${label}: ${why}` is no longer true of the real prompt if this fails.
        expect(entry?.proof(c.prompt)).toBe(true)
      }
    }
  })

  test('EVERY command-running prompt carries the rule, with the reason and the carve-out', () => {
    expect(coveredLabels.length).toBeGreaterThan(0)
    for (const label of coveredLabels) {
      const calls = allCalls.filter((c) => String(c.label) === label)
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

  test('it is stated as a PROHIBITION, never softened into advice — in EVERY covered prompt', () => {
    // SCANNED PER SEAT, not on forge:build alone. Every covered seat is only required to
    // CONTAIN the rule's fragments, which a hand-written hedged paraphrase spliced into
    // one seat would satisfy — while a single-prompt hedge scan never looked at it. The
    // coverage test above already iterates every covered label; so does this one now.
    expect(coveredLabels.length).toBeGreaterThan(0)
    for (const label of coveredLabels) {
      for (const c of allCalls.filter((x) => String(x.label) === label)) {
        const prompt = c.prompt
        // ANCHOR THE WINDOW BEFORE SLICING. `slice(indexOf(a), indexOf(b))` silently
        // yields '' when either anchor is missing (-1) or when they are reordered
        // (start > end), and an empty window passes every `not.toContain` below
        // vacuously — the scan would fail OPEN exactly when the rule had been mangled.
        // Prove the window is real first.
        const start = prompt.indexOf(SHARED_BOX)
        const carve = prompt.indexOf(CARVE_OUT)
        const tail = prompt.indexOf(TAIL)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(carve).toBeGreaterThan(start)
        expect(tail).toBeGreaterThan(carve)
        // Scan the ENTIRE rule — opening claim, prohibition, carve-out AND the closing
        // instruction. Stopping at the carve-out would miss a hedge bolted onto the end,
        // which softens the rule just as effectively as one in the first sentence.
        const rule = prompt.slice(start, tail + TAIL.length)
        expect(rule).toContain(PROHIBITION)
        expect(rule).toContain(CARVE_OUT)
        // NOTE: 'unless you' is deliberately NOT on this list. It is the natural phrasing
        // of the carve-out the rule itself requires ("do NOT kill it unless you started
        // it"), so banning it would fire on a strictly STRONGER rewording — a hedge scan
        // that blocks improvements is a worse guard than one that misses this phrase.
        for (const hedge of ['try to avoid', 'prefer not', 'should avoid', 'if possible', 'generally', 'where practical', 'when convenient', 'as a rule']) {
          expect(rule.toLowerCase()).not.toContain(hedge)
        }
        // And it tells the agent what to do INSTEAD, so "work around it" is the escape
        // hatch rather than killing a process it did not start.
        expect(prompt).toContain('do NOT kill it — work around it')
      }
    }
  })

  test('argus:synthesis carries the rule — nothing in the workflow withholds tools from it', () => {
    // The retired "toolless" exemption rested on a property the source does not have.
    // Pin the absence, so re-introducing that exemption requires first introducing the
    // tool plumbing that would make it true.
    // Comment lines stripped first — the source now DISCUSSES the absent plumbing in
    // prose, and matching that prose would make this assertion pass/fail on commentary.
    const code = SRC.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toMatch(/allowedTools|disallowedTools/)
    const synth = allCalls.filter((c) => c.label === 'argus:synthesis')
    expect(synth.length).toBeGreaterThan(0)
    for (const c of synth) {
      expect(c.prompt).toContain(SHARED_BOX)
      expect(c.prompt).toContain(PROHIBITION)
      expect(c.prompt).toContain(CARVE_OUT)
    }
  })
})
