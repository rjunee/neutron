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
  /** What the bounded re-plan reports as its `complexity` tag. 'mechanical' is the case
   *  the guard exists for: `modelForTag` routes it to Sonnet, so adopting it wholesale
   *  would DOWNGRADE the executor on a run that just proved hard enough to need
   *  re-planning. */
  rePlanComplexity?: 'mechanical' | 'reasoning'
  /** Seats that return NOTHING — dispatched, and the agent died. The only way to make a
   *  real panel come back `infra-only` is to kill one of its seats. */
  deadSeats?: readonly string[]
  /** The first round the seats above die on (default 1). A round that JUDGED the code
   *  followed by one that did not is the only sequence in which the ledger's
   *  "record 'code' rounds only" guard has an observable consequence. */
  deadSeatsFromRound?: number
  /** What the bounded re-plan's `plan:fable` seat does. `throws` is the case a
   *  source read cannot distinguish from the others: `agent()` REJECTS on a transport
   *  error, a schema refusal or an exhausted retry, and an uncaught rejection leaves
   *  the fix loop entirely. */
  rePlan?: 'ok' | 'null' | 'no-spec' | 'throws'
}

interface Captured {
  label: string
  prompt: string
  /** The MODEL the seat was actually routed to. Captured because "the re-plan may raise
   *  the executor tag but never lower it" is a claim about routing, and routing is a
   *  behaviour — asserting the source line that sets `complexityTag` proves only that a
   *  string exists. */
  model: unknown
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

  const agent = async (prompt: string, o?: { label?: string; model?: unknown }): Promise<unknown> => {
    const label = String(o?.label ?? '')
    captured.push({ label, prompt, model: o?.model })
    if ((opts.deadSeats ?? []).includes(label) && synthCount + 1 >= (opts.deadSeatsFromRound ?? 1)) return null
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
      if (opts.rePlan === 'throws') throw new Error('plan:fable transport failed after 3 attempts')
      if (opts.rePlan === 'null') return null
      if (opts.rePlan === 'no-spec') {
        return { implementationPlan: '- [ ] t', topTask: 't', executionSpec: '   ', complexity: 'reasoning', remainingTasks: 0 }
      }
      return {
        implementationPlan: '- [ ] the revised task',
        topTask: 'the revised task',
        executionSpec: `TARGET FILES: x.ts — ${REPLAN_SPEC_MARKER}`,
        complexity: opts.rePlanComplexity ?? 'reasoning',
        remainingTasks: 0,
      }
    }
    if (label === 'argus:synthesis') {
      synthCount += 1
      const r = roundFor(synthCount)
      if (r.findings.length === 0) return { verdict: 'REQUEST_CHANGES', findings: [] }
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
    ['the planner THREW', 'throws' as const],
  ])('%s → the run ESCALATES and dispatches NO fix round on the old plan', async (_label, rePlan) => {
    // `false`, `threw` and `succeeded-with-impossible-output` are all UNKNOWN. Carrying
    // on would send Forge in with the ORIGINAL plan while the run's one re-plan is
    // recorded as spent — the worst of both.
    //
    // THE THROWN CASE IS THE ONE THAT USED TO ESCAPE. An uncaught rejection left the fix
    // loop, landed in the workflow's outer catch, and was persisted as
    // `checkpoint: 'inner-error'` with NO escalation — a reviewer having proved the plan
    // wrong, reported as an infrastructure death. This row is in the SAME `test.each` as
    // the other two on purpose: the three are one outcome, and a commentary that groups
    // them while the table covers only two is a comment asserting coverage that does not
    // exist (which is what it was).
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
    // NOT the workflow's crash shape: a thrown planner must not be reported as an
    // infrastructure death, which is what an escaped rejection produced.
    expect(result.checkpoint).not.toBe('inner-error')
    expect(result.ok).toBe(true)
    const escalation = result.escalation as Record<string, unknown>
    expect(escalation.triggers).toContain('re-plan-failed')
    expect(String(escalation.whatIsMissing)).toContain('no execution spec')
    // The three collapse to ONE outcome, and the evidence still says WHICH — a stop that
    // could not name what happened is the thing this whole card is about.
    expect(String(escalation.evidence)).toMatch(
      rePlan === 'throws' ? /threw: / : rePlan === 'null' ? /returned null/ : /returned no executionSpec/,
    )
  })
})

describe('a design gap with NO ROUND LEFT to re-plan in', () => {
  test('HEADLINE: maxRounds 1 — the declaration ESCALATES rather than being dropped', async () => {
    // The planner runs at the TOP of the next fix round, and `round < maxRounds` means
    // there is no next fix round. With a cap of 1 there is never one at all. The pending
    // flag used to be dropped and the run fell through as an ordinary code rejection: a
    // reviewer said the PLAN is wrong, proved it, and the run reported REQUEST_CHANGES
    // about the code. That is the silent drop this whole card exists to remove.
    const { captured, result } = await runWorkflow({
      maxRounds: 1,
      rounds: [
        {
          findings: [finding('a:b:c')],
          escalate: { kind: 'design-gap', whatIsMissing: 'the execution spec itself asked for the tautological test' },
        },
      ],
    })
    // No planner could run, and none was dispatched — the cap is still the cap.
    expect(labels(captured, 'plan:fable')).toEqual([])
    expect(labels(captured, 'forge:fix-round-')).toEqual([])
    // …and the run says what it is, rather than reporting a code rejection.
    expect(result.blockKind).toBe('design-gap')
    expect(result.blockKind).not.toBe('code')
    const escalation = result.escalation as Record<string, unknown>
    expect(escalation.triggers).toContain('re-plan-unreachable')
    expect(escalation.whatIsMissing).toBe('the execution spec itself asked for the tautological test')
    expect(String(escalation.evidence)).toContain('no round for the bounded re-plan')
  })

  test('a design gap declared on the LAST permitted round escalates the same way', async () => {
    // The same hole one round further in: the decision is made at the end of round 2 with
    // a cap of 2, so the `while` will not run a third round for the planner to open.
    const claim = { kind: 'design-gap', whatIsMissing: 'the plan asked for the thing being flagged' }
    const { captured, result } = await runWorkflow({
      maxRounds: 2,
      rounds: [
        { findings: [finding('a:b:c'), finding('d:e:f')] },
        { findings: [finding('g:h:i')], escalate: claim },
      ],
    })
    expect(labels(captured, 'forge:fix-round-')).toEqual(['forge:fix-round-2'])
    expect(labels(captured, 'plan:fable')).toEqual([])
    expect(result.blockKind).toBe('design-gap')
    expect((result.escalation as Record<string, unknown>).triggers).toContain('re-plan-unreachable')
  })

  test('CONTROL: with a round to spare the same declaration buys the re-plan, not a stop', async () => {
    // Without this, escalating on EVERY design gap would pass both tests above while
    // deleting the bounded re-plan entirely.
    const claim = { kind: 'design-gap', whatIsMissing: 'the plan asked for the thing being flagged' }
    const { captured, result } = await runWorkflow({
      maxRounds: 4,
      // One scripted round PER round the cap allows: `roundFor` clamps to the last
      // entry, so a short script silently repeats its final round's findings and the
      // repeat gate fires on the fixture rather than on the behaviour under test.
      rounds: [
        { findings: [finding('a:b:c'), finding('d:e:f'), finding('g:h:i'), finding('j:k:l')], escalate: claim },
        { findings: [finding('m:n:o'), finding('p:q:r'), finding('s:t:u')] },
        { findings: [finding('v:w:x'), finding('y:z:a')] },
        { findings: [finding('b:c:d')] },
      ],
    })
    expect(labels(captured, 'plan:fable')).toEqual(['plan:fable'])
    expect(result.escalation).toBeUndefined()
  })
})

describe('the routing the re-plan performs, executed rather than grepped', () => {
  test('HEADLINE: a re-plan tagged `mechanical` does NOT downgrade the fix round’s model', () => {
    // `modelForTag` routes 'mechanical' to Sonnet and everything else to Opus, so
    // adopting the re-plan's tag wholesale silently downgraded the executor on a run
    // that had just proved hard enough to need re-planning — and on the rounds whose
    // APPROVE ships the change. Asserted on the model the fix round was ACTUALLY routed
    // to: the source line that sets `complexityTag` proves only that a string exists.
    return runWorkflow({
      maxRounds: 4,
      rePlanComplexity: 'mechanical',
      rounds: [
        {
          findings: [finding('a:b:c'), finding('d:e:f'), finding('g:h:i')],
          escalate: { kind: 'design-gap', whatIsMissing: 'the plan asked for it' },
        },
        { findings: [finding('j:k:l'), finding('m:n:o')] },
        { findings: [finding('p:q:r')] },
        { findings: [finding('s:t:u')] },
      ],
    }).then(({ captured }) => {
      const fix = captured.find((c) => c.label === 'forge:fix-round-2')
      expect(fix).toBeDefined()
      // `models.opus` from the args below; `models.sonnet` is what a downgrade produces.
      expect(fix?.model).toBe('opus')
      expect(fix?.model).not.toBe('sonnet')
      // …and the re-plan DID run, so this is the guard holding and not the re-plan
      // having been skipped.
      expect(labels(captured, 'plan:fable')).toEqual(['plan:fable'])
      expect(fix?.prompt).toContain(REPLAN_SPEC_MARKER)
    })
  })

  // THERE IS NO USEFUL CONTROL FOR THE `reasoning` CASE, and saying so is better than
  // shipping one that looks like a control. `modelForTag` maps BOTH `null` (no tag) and
  // `'reasoning'` to the same model, so "the re-plan adopted reasoning" has no observable
  // consequence at all: a version that adopted nothing routes identically. The only
  // behaviour the tag can change is the `mechanical` downgrade, and that is exactly what
  // the test above asserts. (Mutation-checked: a production change that never adopts the
  // tag leaves every assertion here green, because there is nothing to see.)
})

describe('a round that did NOT judge the code is kept out of the ledger', () => {
  test('HEADLINE: a CODE round followed by a DEAD SEAT is reported as infra-only, not as a plan defect', async () => {
    // THE SEQUENCE IS THE TEST. A run that exits on its FIRST non-code round cannot tell
    // you whether the ledger recorded it — the loop leaves either way. The guard only
    // becomes observable when a round that JUDGED the code is followed by one that did
    // not: without it the dead seat's lane finding lands in the ledger, the arithmetic
    // reads it as a round that failed to converge, and the run reports `not-converging`
    // — a kind that asserts a DESIGN DEFECT — about a review that never happened.
    // Measured with the guard removed: `blockKind` becomes 'not-converging' and an
    // escalation appears, on a run whose second panel simply died.
    const { captured, result } = await runWorkflow({
      maxRounds: 6,
      deadSeats: ['argus:claude'],
      deadSeatsFromRound: 2,
      rounds: [
        // A severity outside the four the schema names: `isCodeWorkFinding` counts it as
        // code work (unknown severity is fail-closed) so round 1 is a genuine 'code'
        // round, while `blockingFindingCount` does not count it — which is what lets the
        // dead seat's own lane blocker raise the count on round 2.
        { findings: [{ severity: 'weird', title: 't', evidence: 'e', key: 'a:b:c' } as never] },
        { findings: [] },
      ],
    })
    expect(result.blockKind).toBe('infra-only')
    expect(result.blockKind).not.toBe('not-converging')
    expect(result.escalation).toBeUndefined()
    expect(result.round).toBe(2)
    expect(labels(captured, 'forge:fix-round-')).toEqual(['forge:fix-round-2'])
  })

  test('a dead review seat on round ONE exits infra-only and escalates NOTHING', async () => {
    // An infra-only round says nothing about whether the PLAN is wrong. Folding one into
    // the ledger would let a dead review seat look like a finding that failed to
    // converge, and report a lane outage under a kind that asserts a design defect.
    //
    // Reached the only way a real panel can reach it: kill a core seat and give the
    // synthesis no findings of its own, so the run exits with `infra-only` on round 1.
    const { captured, result } = await runWorkflow({
      maxRounds: 6,
      deadSeats: ['argus:claude'],
      rounds: [{ findings: [] }, { findings: [] }],
    })
    expect(result.blockKind).toBe('infra-only')
    // NOT an escalation kind — the run must not claim a design defect it did not measure.
    expect(result.escalation).toBeUndefined()
    expect(result.blockKind).not.toBe('not-converging')
    // …and it stopped at round 1 without spending a fix round, which is the pre-existing
    // infra-only exit doing its job unchanged.
    expect(labels(captured, 'forge:fix-round-')).toEqual([])
    expect(result.round).toBe(1)
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
