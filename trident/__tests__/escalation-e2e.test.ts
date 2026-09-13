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
  /** Force this round's synthesis verdict. Default: REQUEST_CHANGES. Needed because the
   *  only other way to reach APPROVE here is the severity gate downgrading an
   *  all-non-blocking rejection, which cannot produce a round that REJECTED and was then
   *  followed by an approval — the shape the convergence ledger got wrong. */
  verdict?: 'APPROVE'
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
      // THE SEAT'S REPLY IS BUILT ONCE, AND `escalate` RIDES EVERY BRANCH. Two of the
      // three branches used to drop it — the explicit-APPROVE path and the
      // no-findings path — so the fixture removed the exact field under test and NO case
      // written against this harness could produce a contradictory
      // `{verdict:'APPROVE', escalate:{…}}` answer. `VERDICT_SCHEMA` permits it, a real
      // seat can return it, and it stopped a build a reviewer had approved.
      //
      // The lesson is the harness's, not the test's: a fixture that cannot express the
      // input cannot fail on it, and every assertion written against it is silently
      // scoped to the shapes the fixture happens to allow.
      //
      // An EXPLICIT approval is still available (`verdict: 'APPROVE'`). Without it the
      // only way to reach APPROVE here is the severity gate downgrading an
      // all-non-blocking rejection, which cannot produce a round that REJECTED first and
      // then approved — the shape the ledger got wrong.
      return {
        verdict: r.verdict === 'APPROVE' ? 'APPROVE' : 'REQUEST_CHANGES',
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
    expect(String(escalation.evidence)).toContain('no round left for the bounded re-plan')
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

describe('an APPROVE that also escalates is an INCONSISTENT answer — and MUST NOT MERGE', () => {
  test('HEADLINE: no merge-authorising APPROVE escapes, and the contradiction is recorded', async () => {
    // `VERDICT_SCHEMA` permits `escalate` independently of `verdict`, so a seat can
    // return an approval and a declaration in one answer. Honouring the claim stopped a
    // build the reviewer had APPROVED — the self-declared escape hatch overriding an
    // affirmative verdict, and in the OVER-FIRING direction, which is the costly one.
    //
    // THE HARNESS COULD NOT EXPRESS THIS UNTIL NOW: two of its three reply branches
    // dropped `escalate`, including the approval path, so the fixture removed the exact
    // field under test. Fourth time on this branch that a fixture could not produce the
    // input its suite claimed to cover.
    const { captured, logs, result } = await runWorkflow({
      maxRounds: 6,
      rounds: [
        {
          findings: [],
          verdict: 'APPROVE',
          escalate: { kind: 'missing-dependency', whatIsMissing: 'card X must land first' },
        },
      ],
    })

    // THE REFUSAL IS ASSERTED FIRST, and it is what makes the rest of this test mean
    // anything. "Approved, not stopped" is ALSO what happens when the claim never reaches
    // the gate at all — which is exactly what the old harness did — so without this the
    // test passes whether the contradiction was REFUSED or simply never delivered.
    // Mutation-checked: re-dropping `escalate` on the approval path reds this line and
    // nothing else.
    expect(logs.some((l) => l.includes('declaration REFUSED') && l.includes('cannot both be true'))).toBe(true)

    // NEITHER HALF IS USABLE, SO THE ANSWER MAY NOT APPROVE. An earlier cut refused the
    // claim and let the run "proceed on the verdict" — which reads as conservative and is
    // the opposite: proceeding on an APPROVE AUTHORISES AN IRREVERSIBLE MERGE on a reply
    // the code has just called self-contradictory. Refusing a bare complaint beside a
    // REQUEST_CHANGES costs nothing because the run stops anyway; beside an APPROVE it
    // costs the one thing that cannot be taken back.
    //
    // The asymmetry runs the other way from this file's usual one, too: elsewhere it
    // weighs stopping a converging run against failing to prove a repeat, both
    // recoverable. Here one side is a retry and the other is a bad merge.
    expect(result.verdict).not.toBe('APPROVE')
    expect(result.checkpoint).not.toBe('argus-approved')
    expect(result.blockKind).not.toBe('none')

    // NO TRIGGER FIRED EITHER — the refused claim buys no planner, and the run does not
    // report an escalation kind it never measured. The contradiction is not a design gap.
    expect(labels(captured, 'plan:fable')).toEqual([])
    expect(result.escalation).toBeUndefined()
  })

  test('it RETRIES while the cap allows, and never reports a cause it did not measure', async () => {
    // The contradictory round is downgraded, so the fix loop takes another one — the retry
    // is the loop's own (re-Forge, re-review, re-synthesise) rather than a new mechanism.
    // With a seat that keeps contradicting itself, the run exhausts its budget and ends
    // NOT-APPROVED, which is the fail-closed half.
    const { captured, result } = await runWorkflow({
      maxRounds: 3,
      rounds: [
        { findings: [], verdict: 'APPROVE', escalate: { kind: 'design-gap', whatIsMissing: 'x' } },
        { findings: [], verdict: 'APPROVE', escalate: { kind: 'design-gap', whatIsMissing: 'x' } },
        { findings: [], verdict: 'APPROVE', escalate: { kind: 'design-gap', whatIsMissing: 'x' } },
      ],
    })
    expect(result.verdict).not.toBe('APPROVE')
    expect(labels(captured, 'forge:fix-round-')).toEqual(['forge:fix-round-2', 'forge:fix-round-3'])

    // AND NOT `not-converging`. A contradictory round judged nothing, so it stays OUT of
    // the convergence ledger — otherwise a seat answering incoherently is reported as fix
    // rounds that stopped converging, blaming the fixes for a panel that never delivered a
    // usable verdict. Measured before the exclusion: `not-converging` with counts [0,0].
    expect(result.blockKind).not.toBe('not-converging')
    expect(result.escalation).toBeUndefined()
  })

  test('CONTROL: a seat that REJECTED is not called contradictory, even after the severity gate approves it', async () => {
    // THE CASE THAT PINS "the seat's OWN verdict, not the gated one". This seat is
    // CONSISTENT — it said REQUEST_CHANGES and attached a declaration — and
    // `enforceSeverityGate` then downgraded it to APPROVE over all-non-blocking findings.
    // Judging the contradiction on the GATED verdict would call that honest seat
    // incoherent, withhold the approval it earned, and spend the round budget re-Forging
    // code nobody objected to.
    //
    // The declaration here is MALFORMED (an unknown kind), so it is refused and fires no
    // trigger — which is what leaves the approval as the only thing on the table and makes
    // this test discriminating rather than a second copy of the stop cases above.
    const { captured, result } = await runWorkflow({
      maxRounds: 3,
      rounds: [
        {
          findings: [finding('a:b:c', 'minor'), finding('d:e:f', 'nit')],
          escalate: { kind: 'not-a-real-kind', whatIsMissing: 'x' },
        },
      ],
    })
    expect(result.verdict).toBe('APPROVE')
    expect(result.blockKind).toBe('none')
    expect(labels(captured, 'forge:fix-round-')).toEqual([])
    expect(result.escalation).toBeUndefined()
  })

  test('CONTROL: the SAME declaration on a REQUEST_CHANGES answer still stops the run', async () => {
    // Without this, "an approval is not overridden" is satisfied by an implementation
    // that stopped honouring declarations altogether — which is the trigger three rounds
    // of this card exist to make work.
    const { result } = await runWorkflow({
      maxRounds: 6,
      rounds: [
        {
          // A BLOCKER, so the severity gate leaves the REQUEST_CHANGES standing and the
          // round is genuinely recorded — which is what makes the ledger assertion below
          // discriminating. An all-minor round is downgraded to APPROVE by the gate and
          // legitimately never enters the series at all.
          findings: [finding('a:b:c')],
          escalate: { kind: 'missing-dependency', whatIsMissing: 'card X must land first' },
        },
      ],
    })
    expect(result.blockKind).toBe('missing-dependency')
    const esc = result.escalation as Record<string, unknown>
    expect(esc.triggers).toContain('missing-dependency')
    // AND THE ROUND WAS STILL COUNTED. A reply that REJECTED and declared is consistent, so
    // it belongs in the convergence ledger — only a CONTRADICTORY reply is excluded.
    // Without this the exclusion could widen to every declaration-bearing round and the
    // arithmetic would quietly stop seeing them: the evidence would read `counts []`.
    expect(String(esc.evidence)).toContain('counts [1]')
  })
})

describe('a DECLARATION is heard even when the code is fine — the fast trigger', () => {
  // "The code is fine, the dependency isn't there yet" is close to the canonical
  // missing-dependency, and it arrives precisely with SMALL findings. That combination
  // used to be the one the loop could not hear: `enforceSeverityGate` turns an
  // all-non-blocking REQUEST_CHANGES into APPROVE, `classifyBlock` calls the list
  // `advisory-only`, and the ledger recorder returned unless the round was `code` — so
  // the declaration never reached `decideEscalation` and the run proceeded AS APPROVED.
  //
  // A declaration is a claim about the WORK'S VIABILITY; severity is a claim about the
  // CODE'S QUALITY. Routing the first through a gate built for the second made the loop
  // deafest exactly when the reviewer was clearest.

  test('HEADLINE: `missing-dependency` declared with ONLY non-blocking findings STOPS at round 1', async () => {
    const { captured, result } = await runWorkflow({
      maxRounds: 6,
      rounds: [
        // Nothing a fix round could act on — which is the point. The reviewer is not
        // saying the code is bad; it is saying the work cannot proceed.
        {
          findings: [finding('a:b:c', 'minor'), finding('d:e:f', 'nit')],
          escalate: { kind: 'missing-dependency', whatIsMissing: 'card X must land first' },
        },
      ],
    })

    expect(result.blockKind).toBe('missing-dependency')
    const escalation = result.escalation as Record<string, unknown>
    expect(escalation.triggers).toContain('missing-dependency')
    expect(escalation.round).toBe(1)

    // AND IT MUST NOT ALSO MERGE. The terminal result reads `finalVerdict === 'APPROVE'`
    // BEFORE it reads the escalation, so an approved-and-escalated run would report
    // `blockKind: 'none'` and the outer loop would ship the branch — work a reviewer had
    // just declared unbuildable, silently.
    expect(result.verdict).not.toBe('APPROVE')
    expect(result.checkpoint).not.toBe('argus-approved')

    // A missing dependency buys NO re-plan: no plan of this card's can conjure the other
    // card, so there is nothing to re-plan against.
    expect(labels(captured, 'plan:fable')).toEqual([])
    expect(labels(captured, 'forge:fix-round-')).toEqual([])
    expect(result.round).toBe(1)
  })

  test('HEADLINE: `design-gap` with ONLY non-blocking findings still buys its ONE re-plan', async () => {
    // THE OTHER HALF, and it was wrong in the opposite direction. Hearing the declaration
    // was not enough: the LOOP was still gated on code-work severity, so a design gap
    // declared beside minor/nit findings authorised a re-plan that could never run —
    // `enforceSeverityGate` had turned the verdict into APPROVE and `classifyBlock` had
    // called the list `advisory-only`, so every clause of the `while` was false. The run
    // then reported `re-plan-unreachable` WITH FIVE ROUNDS STILL IN THE BUDGET, which is
    // a false diagnosis that sends the next reader after the cap instead of after the
    // gate. The spec item grants a design gap one bounded re-plan; this asserts it is
    // actually spent.
    const { captured, result } = await runWorkflow({
      maxRounds: 6,
      rounds: [
        {
          findings: [finding('a:b:c', 'minor'), finding('d:e:f', 'nit')],
          escalate: { kind: 'design-gap', whatIsMissing: 'the plan assumes an API that does not exist' },
        },
        { findings: [], verdict: 'APPROVE' },
      ],
    })

    // EXACTLY ONCE, in both directions: zero is the regression this test exists for, and
    // two is the unbounded re-planning the design forbids.
    expect(labels(captured, 'plan:fable')).toEqual(['plan:fable'])
    // …and its revised spec reached Forge, which is the whole point of re-planning.
    const fix = captured.find((c) => c.label === 'forge:fix-round-2')
    expect(fix).toBeDefined()
    expect(fix?.prompt).toContain(REPLAN_SPEC_MARKER)
    // The planner was briefed with what the reviewer said was missing.
    expect(captured.find((c) => c.label === 'plan:fable')?.prompt).toContain(
      'the plan assumes an API that does not exist',
    )

    // It re-planned, rebuilt, and the panel then approved — so the run converged rather
    // than escalating. NOT `re-plan-unreachable`, which is what it used to report.
    expect(result.verdict).toBe('APPROVE')
    expect(result.escalation).toBeUndefined()
    expect(result.round).toBe(2)
  })

  test('`re-plan-unreachable` is only reported when the CAP really leaves no round', async () => {
    // The false-diagnosis half, pinned from the other side: with rounds remaining the
    // re-plan RUNS (above), so this trigger must appear only when the cap is genuinely
    // exhausted. A reachability failure claimed while budget remains is the kind of wrong
    // answer that sends the next reader after the cap instead of after the gate.
    const { captured, result } = await runWorkflow({
      maxRounds: 1,
      rounds: [
        {
          findings: [finding('a:b:c', 'minor')],
          escalate: { kind: 'design-gap', whatIsMissing: 'the plan is wrong' },
        },
      ],
    })
    expect(result.blockKind).toBe('design-gap')
    const escalation = result.escalation as Record<string, unknown>
    expect(escalation.triggers).toContain('re-plan-unreachable')
    expect(String(escalation.evidence)).toContain('the last round the cap allows')
    expect(labels(captured, 'plan:fable')).toEqual([])
  })

  test('the stop does NOT attribute an arithmetic reading to a round that measured none', async () => {
    // The declaration arrives on round 3, AFTER two rounds that did judge the code. The
    // ledger already holds their counts — and re-reading it here would print
    // `blocker+major counts [2,1] → progress` in the evidence of a stop decided by a
    // round that never judged the code at all. The outcome is unchanged either way (the
    // ledger is identical to what it was when round 2 last decided on it, and that
    // decision was "continue"), so this is the ONLY place the neutralised inputs are
    // visible — and it is the place that matters, because the evidence is what the
    // operator reads to understand why the run stopped.
    const { result } = await runWorkflow({
      maxRounds: 6,
      rounds: [
        { findings: [finding('a:b:c'), finding('d:e:f')] },
        { findings: [finding('g:h:i')] },
        {
          findings: [finding('j:k:l', 'nit')],
          escalate: { kind: 'missing-dependency', whatIsMissing: 'card X must land first' },
        },
      ],
    })
    expect(result.blockKind).toBe('missing-dependency')
    const evidence = String((result.escalation as Record<string, unknown>).evidence)
    expect(evidence).toContain('counts [] → undecidable')
    // The arithmetic from the earlier rounds must not be quoted as this round's reading.
    expect(evidence).not.toContain('[2,1]')
    expect(evidence).toContain('reviewer declared missing-dependency')
  })

  test('CONTROL: the SAME non-blocking findings with NO declaration still approve', async () => {
    // Without this, a version that simply stopped honouring the severity gate — treating
    // every minor finding as a rejection — would pass both rows above.
    const { captured, result } = await runWorkflow({
      maxRounds: 6,
      rounds: [{ findings: [finding('a:b:c', 'minor'), finding('d:e:f', 'nit')] }],
    })
    expect(result.verdict).toBe('APPROVE')
    expect(result.escalation).toBeUndefined()
    expect(result.blockKind).toBe('none')
    expect(labels(captured, 'forge:fix-round-')).toEqual([])
  })
})

describe('an APPROVE round is CONVERGENCE, not a failure to converge', () => {
  test('HEADLINE: a rejection with no blocker/major followed by an APPROVE does NOT escalate', async () => {
    // A LATENT BUG THIS BRANCH SURFACED RATHER THAN INTRODUCED. The ledger measures
    // whether REJECTIONS are getting smaller. It was also recording the round that
    // APPROVED: round 1 rejects with no blocker/major findings and records a count of 0,
    // the approving round 2 records another 0, and `[0,0]` reads as "the count stopped
    // falling" — the fix rounds reported as not converging on the very round they
    // converged.
    //
    // It stayed invisible because the terminal result reads `finalVerdict === 'APPROVE'`
    // BEFORE it reads the escalation and reported `blockKind: 'none'`, discarding the
    // stop. It became visible the moment an escalation was made to force the verdict
    // (a run that stopped did not approve) — which is why a silently-discarded decision
    // is worth removing even while it is harmless: it is one edit away from being read.
    const { result } = await runWorkflow({
      maxRounds: 6,
      rounds: [
        // A severity outside the four the schema names. `isNonBlockingFinding` is false
        // for it, so the severity gate leaves the REQUEST_CHANGES standing and a fix
        // round IS bought; `blockingFindingCount` does not count it, so the round records
        // a count of 0. That combination is what produces the `[0,0]` series — an
        // all-minor round would simply have been approved at round 1 and never reached it.
        { findings: [{ severity: 'weird', title: 't', evidence: 'e', key: 'a:b:c' } as never] },
        { findings: [], verdict: 'APPROVE' },
      ],
    })
    expect(result.verdict).toBe('APPROVE')
    expect(result.escalation).toBeUndefined()
    expect(result.blockKind).toBe('none')
    // Specifically NOT the arithmetic kind, which is what `[0,0]` produced.
    expect(result.blockKind).not.toBe('not-converging')
  })
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
