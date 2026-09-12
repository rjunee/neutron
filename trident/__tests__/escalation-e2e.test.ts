/**
 * STOP AND ESCALATE — executed, not grepped.
 *
 * `trident/__tests__/escalation-gate.test.ts` proves the DECISION is right and pins the
 * call sites by source text. A source assertion proves a string exists; it cannot prove
 * a call happened with the right argument, which is the entire content of "wired". So
 * this file RUNS the shipped `inner-workflow.mjs` body — the same AsyncFunction harness
 * `inner-workflow-assembly.test.ts` uses — with scripted review seats, and asserts what
 * the run DID: which rounds happened, how many planner seats were dispatched, what
 * reached Forge, and what the terminal result says.
 *
 * Everything a real run measures is supplied by the MOCK AGENT, which is the boundary
 * this harness is allowed to own. Nothing in it decides, counts, compares, or stops:
 * the seats return findings and the workflow does the rest. If the escalation were
 * deleted, these runs would go to the round cap and every assertion below would fail —
 * which is the point, and is mutation-checked.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../inner-workflow.mjs', import.meta.url)), 'utf8')

interface Finding {
  severity: string
  title: string
  evidence: string
  key: string
}

/** One scripted review round: what the synthesis seat answers. */
interface ScriptedRound {
  findings: Finding[]
  /** The seat's self-declared escalation, verbatim (including malformed ones). */
  escalate?: unknown
}

interface RunOpts {
  rounds: ScriptedRound[]
  maxRounds?: number
  /** What the bounded re-plan's `plan:fable` seat returns. */
  rePlan?: 'ok' | 'null' | 'no-spec'
}

interface Captured {
  label: string
  prompt: string
}

/** The marker the re-plan puts in its execution spec, so "did it reach Forge?" is a
 *  measurement rather than a shape check. */
const REPLAN_SPEC_MARKER = 'REPLAN_SPEC_MARKER_7Q4Z'

const finding = (key: string, severity = 'blocker'): Finding => ({
  severity,
  title: `free-text title for ${key}, deliberately reworded between rounds`,
  evidence: 'x.ts:1',
  key,
})

/**
 * Execute the REAL workflow body with mocked runtime globals.
 *
 * The mock answers probes the way a healthy local-mode run would: each round's built
 * head and branch head are the SAME distinct sha, so `roundOutcome` sees the branch
 * move and the round LANDS — without that the fix loop breaks at `round-lost` before
 * the re-review, and no second round of findings would ever exist to compare.
 */
async function runWorkflow(
  opts: RunOpts,
): Promise<{ captured: Captured[]; result: Record<string, unknown>; logs: string[] }> {
  const captured: Captured[] = []
  const logs: string[] = []
  let synthCount = 0
  let forgeRound = 0

  const roundFor = (n: number): ScriptedRound =>
    opts.rounds[Math.min(n, opts.rounds.length) - 1] ?? { findings: [] }

  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = String(o?.label ?? '')
    captured.push({ label, prompt })
    // Each round's commit is DIFFERENT, so the branch visibly moves and the round lands.
    const shaFor = (n: number): string => String(n).padStart(2, '0').repeat(20)
    const built = /^head-probe-round-built-r(\d+)$/.exec(label)
    if (built !== null) return { head: shaFor(Number(built[1])) }
    const branch = /^head-probe-round-(\d+)$/.exec(label)
    if (branch !== null) return { head: shaFor(Number(branch[1])) }
    if (label === 'forge:build' || label.startsWith('forge:fix-round-')) {
      forgeRound += 1
      return {
        prNumber: null,
        branch: 'trident/test-run',
        diffFile: `/tmp/x${forgeRound}.diff`,
        worktreePath: '/wt',
        commitSha: 'abc',
        testsPassed: true,
      }
    }
    if (label === 'argus:claude' || label === 'argus:adversarial') {
      return { verdict: 'REQUEST_CHANGES', findings: [] }
    }
    if (label === 'plan:fable') {
      // This run is NOT Ralph, so the ONLY `plan:fable` seat reachable is the bounded
      // re-plan. Counting this label therefore counts re-plans exactly.
      if (opts.rePlan === 'null') return null
      if (opts.rePlan === 'no-spec') {
        return { implementationPlan: '- [ ] t', topTask: 't', executionSpec: '   ', complexity: 'reasoning', remainingTasks: 0 }
      }
      return {
        implementationPlan: '- [ ] the revised task',
        topTask: 'the revised task',
        executionSpec: `TARGET FILES: x.ts — ${REPLAN_SPEC_MARKER}`,
        complexity: 'reasoning',
        remainingTasks: 0,
      }
    }
    if (label === 'argus:synthesis') {
      synthCount += 1
      const r = roundFor(synthCount)
      return {
        verdict: 'REQUEST_CHANGES',
        findings: r.findings,
        ...(r.escalate === undefined ? {} : { escalate: r.escalate }),
      }
    }
    return ''
  }
  const parallel = async (fns: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    Promise.all(fns.map((f) => f()))
  const phase = (): void => {}
  const log = (...values: unknown[]): void => {
    logs.push(values.map(String).join(' '))
  }
  const budget = { total: 0, spent: (): number => 0 }

  const args: Record<string, unknown> = {
    repoPath: '/repo',
    task: 'build the feature',
    baseBranch: 'main',
    slug: 'test-run',
    // Deliberately generous: a run that stops at round 2 cannot have been stopped by
    // the cap, which is the whole claim.
    maxRounds: opts.maxRounds ?? 6,
    ralph: false,
    mergeMode: 'local',
    prNumber: null,
    branch: null,
    dbPath: null,
    runId: null,
    checkpointScript: null,
    stageStampScript: null,
    codexBuildScript: '/harness/trident/codex-build.sh',
    codexReviewScript: '/harness/trident/codex-review.sh',
    resumeCheckpoint: null,
    // Both cross-model seats OFF, so the panel is the two core seats plus synthesis and
    // nothing deferred — the block kind is decided by the findings alone.
    codexHome: null,
    kimiConfigured: false,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
    phaseModels: null,
    modelTiers: {
      none: { model_id: 'none', transport: 'agent', env_var: null, group: 'none' },
    },
  }

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as Record<string, unknown>
  return { captured, result, logs }
}

const labels = (captured: Captured[], prefix: string): string[] =>
  captured.map((c) => c.label).filter((l) => l.startsWith(prefix))

/** The three findings that recurred in all NINE rounds of run 36b95167. */
const RECURRING = [
  finding('app/rail.ts:rowRailLockstep:tautological-test'),
  finding('work-board/store.ts:inlineActive:out-of-spec-proxy'),
  finding('agent-dispatch/start.ts:research:untouched-path', 'major'),
]

describe('the run STOPS — executed end to end', () => {
  test('HEADLINE: reviewers repeat a finding → the run stops at ROUND 2, far short of the cap', async () => {
    // Round 1 and round 2 report the SAME findings. Nothing else differs from a healthy
    // run: every seat answers, every round lands, the cap is 6.
    const { captured, result } = await runWorkflow({ rounds: [{ findings: RECURRING }, { findings: RECURRING }] })

    expect(result.round).toBe(2)
    expect(result.blockKind).toBe('not-converging')
    // The round budget was NOT what stopped it — four rounds were still available.
    expect(result.round as number).toBeLessThan(6)
    // …and the proof that it stopped rather than being reported as stopped: NO third
    // fix round was ever dispatched.
    expect(labels(captured, 'forge:fix-round-')).toEqual(['forge:fix-round-2'])
    // Two panels, not six.
    expect(labels(captured, 'argus:synthesis').length).toBe(2)

    const escalation = result.escalation as Record<string, unknown>
    expect(escalation).toBeDefined()
    expect(escalation.kind).toBe('not-converging')
    expect(escalation.triggers).toContain('repeat-finding')
    expect(escalation.round).toBe(2)
    expect(String(escalation.whatIsMissing)).toContain('survived a fix round')
    // The findings travel with it, so the orchestrator sees what was actually said.
    expect((result.findings as unknown[]).length).toBe(3)
  })

  test('CONTROL: a converging run is NOT stopped — it keeps its rounds', async () => {
    // Different findings every round and a falling blocker+major count. If the gate
    // fired here it would be stopping healthy builds, which is the expensive failure in
    // the other direction. This run reaches the cap, exactly as it did before the card.
    const { captured, result } = await runWorkflow({
      maxRounds: 4,
      rounds: [
        { findings: [finding('a:b:c'), finding('d:e:f'), finding('g:h:i'), finding('j:k:l')] },
        { findings: [finding('m:n:o'), finding('p:q:r'), finding('s:t:u')] },
        { findings: [finding('v:w:x'), finding('y:z:a')] },
        { findings: [finding('b:c:d')] },
      ],
    })
    expect(result.escalation).toBeUndefined()
    expect(result.blockKind).toBe('code')
    expect(result.round).toBe(4)
    expect(labels(captured, 'forge:fix-round-')).toEqual(['forge:fix-round-2', 'forge:fix-round-3', 'forge:fix-round-4'])
  })

  test('a REFUSED declaration leaves the run iterating — and buys no planner seat', async () => {
    // `whatIsMissing` absent. The run must neither honour it nor stop on it, and the
    // bounded re-plan must not be spent.
    // The findings also CHANGE and their count FALLS every round, so neither arithmetic
    // gate can fire — the only thing that could stop this run is the declaration, and it
    // must not.
    const { captured, logs, result } = await runWorkflow({
      maxRounds: 3,
      rounds: [
        { findings: [finding('a:b:c'), finding('d:e:f'), finding('g:h:i')], escalate: { kind: 'design-gap' } },
        { findings: [finding('j:k:l'), finding('m:n:o')] },
        { findings: [finding('p:q:r')] },
      ],
    })
    expect(labels(captured, 'plan:fable')).toEqual([])
    expect(result.escalation).toBeUndefined()
    expect(result.round).toBe(3)
    // …and it was reported rather than swallowed, which is the only way an agent (or a
    // reader of the journal) ever learns the declaration was rejected.
    expect(logs.some((l) => l.includes('declaration REFUSED') && l.includes('whatIsMissing'))).toBe(true)
  })
})

describe('the bounded re-plan — executed end to end', () => {
  test('HEADLINE: a design-gap dispatches EXACTLY ONE planner, and its spec reaches Forge', async () => {
    // Round 1 declares a design gap. Rounds 2 and 3 declare it AGAIN — the pressure a
    // self-declared exit is under — and the run gets one re-plan, not three.
    const claim = { kind: 'design-gap', whatIsMissing: 'the execution spec itself asked for the tautological test' }
    const { captured, result } = await runWorkflow({
      maxRounds: 5,
      rounds: [
        { findings: [finding('a:b:c')], escalate: claim },
        { findings: [finding('d:e:f')], escalate: claim },
        { findings: [finding('g:h:i')], escalate: claim },
      ],
    })

    // ONE planner seat for the whole run.
    expect(labels(captured, 'plan:fable')).toEqual(['plan:fable'])

    // The planner was handed the reviewers' findings and what they said is missing —
    // the inputs the once-per-run planner never had.
    const planner = captured.find((c) => c.label === 'plan:fable')?.prompt ?? ''
    expect(planner).toContain('a:b:c')
    expect(planner).toContain(claim.whatIsMissing)

    // AND THE REVISED SPEC ACTUALLY REACHED FORGE. This is the assertion a source-text
    // check cannot make: the marker is produced by the planner seat at run time and
    // must appear in the NEXT fix round's prompt, or the re-plan was bought and thrown
    // away.
    const fix2 = captured.find((c) => c.label === 'forge:fix-round-2')?.prompt ?? ''
    expect(fix2).toContain(REPLAN_SPEC_MARKER)

    // The SECOND declaration is refused a planner and STOPS the run instead — at the
    // very next decision, which is the end of round 2. The re-plan got exactly one
    // chance to prove it changed something.
    expect(result.blockKind).toBe('design-gap')
    expect((result.escalation as Record<string, unknown>).whatIsMissing).toBe(claim.whatIsMissing)
    expect(result.round).toBe(2)
    // Round 3's declaration was never reached, which is the cost this saves.
    expect(labels(captured, 'argus:synthesis').length).toBe(2)
  })

  test('the re-plan runs ONCE and the fix rounds after it still carry its spec', async () => {
    // A design gap at round 1, then ordinary converging rounds. The spec must persist
    // across every later fix round — a fresh Forge agent that lost it would be building
    // the plan the reviewers rejected.
    const { captured } = await runWorkflow({
      maxRounds: 4,
      rounds: [
        {
          findings: [finding('a:b:c'), finding('d:e:f'), finding('g:h:i'), finding('j:k:l')],
          escalate: { kind: 'design-gap', whatIsMissing: 'the plan asked for it' },
        },
        // Different findings, and the count FALLS every round, so the run is converging
        // and neither arithmetic gate fires — it is the re-plan's persistence that is
        // under test here, not the stop.
        { findings: [finding('m:n:o'), finding('p:q:r'), finding('s:t:u')] },
        { findings: [finding('v:w:x'), finding('y:z:a')] },
        { findings: [finding('b:c:d')] },
      ],
    })
    expect(labels(captured, 'plan:fable')).toEqual(['plan:fable'])
    const fixes = captured.filter((c) => c.label.startsWith('forge:fix-round-'))
    expect(fixes.length).toBeGreaterThan(1)
    for (const f of fixes) expect(f.prompt).toContain(REPLAN_SPEC_MARKER)
  })

  test.each([
    ['the planner returned null', 'null' as const],
    ['the planner returned no execution spec', 'no-spec' as const],
  ])('%s → the run ESCALATES and dispatches NO fix round on the old plan', async (_label, rePlan) => {
    // `false`, `threw` and `succeeded-with-impossible-output` are all UNKNOWN. Carrying
    // on would send Forge in with the ORIGINAL plan while the run's one re-plan is
    // recorded as spent — the worst of both.
    const { captured, result } = await runWorkflow({
      maxRounds: 5,
      rePlan,
      rounds: [
        { findings: [finding('a:b:c')], escalate: { kind: 'design-gap', whatIsMissing: 'the plan asked for it' } },
        { findings: [finding('d:e:f')] },
      ],
    })
    expect(labels(captured, 'plan:fable')).toEqual(['plan:fable'])
    // No fix round ran on the plan the reviewers rejected.
    expect(labels(captured, 'forge:fix-round-')).toEqual([])
    expect(result.blockKind).toBe('design-gap')
    const escalation = result.escalation as Record<string, unknown>
    expect(escalation.triggers).toContain('re-plan-failed')
    expect(String(escalation.whatIsMissing)).toContain('no execution spec')
  })
})

describe('a missing-dependency stops immediately — executed end to end', () => {
  test('it fires at ROUND 1 and never dispatches a fix round or a planner', async () => {
    // Re-planning cannot conjure work that lives outside this card; only SEQUENCING can,
    // and that is the orchestrator's call.
    const { captured, result } = await runWorkflow({
      maxRounds: 5,
      rounds: [
        {
          findings: [finding('a:b:c')],
          escalate: { kind: 'missing-dependency', whatIsMissing: 'the dependency-aware dispatch card must land first' },
        },
      ],
    })
    expect(result.round).toBe(1)
    expect(result.blockKind).toBe('missing-dependency')
    expect(labels(captured, 'forge:fix-round-')).toEqual([])
    expect(labels(captured, 'plan:fable')).toEqual([])
    expect(String((result.escalation as Record<string, unknown>).whatIsMissing)).toContain('dependency-aware dispatch')
  })
})
