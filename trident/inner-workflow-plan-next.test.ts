/**
 * `plan:next` — WHICH PLANNER A RALPH ITERATION ACTUALLY RUNS, asserted over the
 * REAL `inner-workflow.mjs` body.
 *
 * THE MEASURED WASTE: every Ralph iteration re-ran `plan:fable`, whose first two
 * steps are "read SPEC.md and survey the CURRENT code" — 287 s per task, eight
 * times on one card, to re-derive a document the PREVIOUS iteration's Forge had
 * already committed to the branch. The fix is a second, much smaller planner that
 * reads only that committed plan.
 *
 * WHY THESE TESTS RUN THE SCRIPT INSTEAD OF A HELPER. The selection is a predicate
 * over args + a probe's answer, sitting inside a script with no module resolution
 * and no importable surface. A unit test of an extracted helper would assert the
 * predicate and prove nothing about which agent the workflow DISPATCHES — and the
 * only failure that matters here is the workflow spending five minutes it did not
 * need to, or (far worse) skipping the survey on a resume where the code moved
 * underneath the plan. So the harness is `inner-workflow-assembly.test.ts`'s: read
 * the source, strip the single `export`, run the body as an AsyncFunction with
 * mocked runtime globals, and CAPTURE EVERY `agent()` call's `{label, prompt}`.
 * Every assertion below is about labels and prompt bytes.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

/** A 40-hex OID: `classifyResume` normalises anything else away, and an
 *  unnormalisable "head" would rebuild for the WRONG reason, quietly passing a
 *  test that meant to exercise the matching-head path. */
const HEAD = 'a1b2c3d4'.repeat(5)
const OTHER_HEAD = 'f9e8d7c6'.repeat(5)

/** The plan a previous iteration committed: task 1 done, two still open. */
const COMMITTED_PLAN = [
  '# IMPLEMENTATION_PLAN — the card',
  '',
  '- [x] T1 — the task the previous iteration built',
  '- [ ] T2 — the task THIS iteration must pick up',
  '- [ ] T3 — the one after that',
].join('\n')

interface Captured {
  label: string
  prompt: string
}

/** What the `plan:probe` seat reports — or `null` for a seat that died. */
type ProbeAnswer = { planFound: boolean; uncheckedCount: number; planBody: string } | null

interface Opts {
  ralph?: boolean
  /** Omitted entirely (not null) → a LEGACY launcher that threads no round. */
  ralphRound?: number
  resumeCheckpoint?: string | null
  resumeCheckpointHead?: string | null
  resumeLiveHead?: string
  prNumber?: number | null
  branch?: string | null
  /** Scripted `plan:probe` answer. `undefined` → a healthy 2-unchecked plan. */
  probe?: ProbeAnswer
  /** `true` → the `plan:next` seat returns nothing (planner terminal error). */
  planNextDead?: boolean
}

interface Out {
  captured: Captured[]
  labels: string[]
  logs: string[]
  result: { ok: boolean; verdict: string | null; checkpoint: string; remainingTasks: number }
}

async function run(opts: Opts = {}): Promise<Out> {
  const captured: Captured[] = []
  const logs: string[] = []

  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label ?? ''
    captured.push({ label, prompt })
    if (label === 'plan:probe') {
      const answer =
        opts.probe === undefined
          ? { planFound: true, uncheckedCount: 2, planBody: COMMITTED_PLAN }
          : opts.probe
      return answer
    }
    if (label === 'plan:next') {
      if (opts.planNextDead === true) return null
      // The contract the real prompt states: the committed body comes back
      // VERBATIM, so `ralphExecuteNote` hands Forge exactly what is on the branch.
      return {
        implementationPlan: COMMITTED_PLAN,
        topTask: 'T2 — the task THIS iteration must pick up',
        executionSpec: 'TARGET FILES: t2.ts',
        complexity: 'reasoning',
        // 0 so the iteration flows into forge:build + review instead of handing
        // straight back to the outer loop for a re-fire — the planner choice is
        // what is under test, and the re-fire path would cut the run short.
        remainingTasks: 0,
      }
    }
    if (label === 'plan:fable') {
      return {
        implementationPlan: COMMITTED_PLAN,
        topTask: 'T2 — the task THIS iteration must pick up',
        executionSpec: 'TARGET FILES: t2.ts',
        complexity: 'reasoning',
        remainingTasks: 0,
      }
    }
    if (label === 'forge:build' || label.startsWith('forge:fix-round-')) {
      return {
        prNumber: null,
        branch: opts.branch ?? 'trident/plan-next-run',
        diffFile: '/tmp/plan-next.diff',
        worktreePath: '/wt',
        commitSha: OTHER_HEAD,
        testsPassed: true,
      }
    }
    if (label.startsWith('head-probe-round-')) return { head: OTHER_HEAD }
    if (label === 'resume-diff') return { bytes: 4096 }
    if (label === 'argus:claude' || label === 'argus:adversarial') return { verdict: 'APPROVE', findings: [] }
    if (label === 'argus:synthesis') return { verdict: 'APPROVE', findings: [] }
    // checkpoint / terminal-result / cleanup Bash steps: recorded, never executed.
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
    task: 'Ship the multi-task card',
    baseBranch: 'main',
    slug: 'plan-next-run',
    maxRounds: 3,
    ralph: opts.ralph !== false,
    // local mode keeps the panel small and stops the run short of the pr-mode
    // publish handoff; the planner choice is git-mode independent.
    mergeMode: 'local',
    prNumber: opts.prNumber ?? null,
    branch: opts.branch ?? 'trident/plan-next-run',
    dbPath: null, // → checkpoint()/writeTerminalResult() no-op; the RETURN carries the result
    runId: null,
    resumeCheckpoint: opts.resumeCheckpoint ?? null,
    resumeCheckpointHead: opts.resumeCheckpointHead ?? null,
    resumeFindings: null,
    codexHome: null,
    checkpointScript: null,
    models: { fable: 'fable', opus: 'opus', sonnet: 'sonnet', fast: 'haiku' },
    reflectionGuidance: '',
  }
  // PRESENCE is the signal for both of these: a launcher that threads no round is
  // a different case from one that threads null, and the same is true of the
  // launcher-read live head. Spreading them conditionally is what lets the
  // legacy-launcher scenario be written at all.
  if (opts.ralphRound !== undefined) args.ralphRound = opts.ralphRound
  if (opts.resumeLiveHead !== undefined) args.resumeLiveHead = opts.resumeLiveHead

  const body = SRC.replace('export const meta', 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> {}).constructor as (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>
  const fn = AsyncFunction('agent', 'parallel', 'phase', 'log', 'budget', 'args', body)
  const result = (await fn(agent, parallel, phase, log, budget, args)) as Out['result']
  return { captured, labels: captured.map((c) => c.label), logs, result }
}

/** A CLEAN RALPH HANDOFF: the checkpoint the workflow itself writes after building
 *  one task, with the branch head unmoved since. This exact shape — and only this
 *  one — is what `classifyResume` reports as 'unknown-checkpoint' AFTER its
 *  recorded-vs-live head comparison has already passed. */
const cleanHandoff = (round: number, over: Opts = {}): Opts => ({
  ralph: true,
  ralphRound: round,
  resumeCheckpoint: 'ralph-task-built',
  resumeCheckpointHead: HEAD,
  resumeLiveHead: HEAD,
  ...over,
})

const promptFor = (out: Out, label: string): string =>
  out.captured.find((c) => c.label === label)?.prompt ?? ''

/** The survey instruction that IS the 287 s. Its presence or absence in a prompt is
 *  the whole claim this card makes about cost. */
const SURVEY_LINE = 'Read SPEC.md'
/** The first bytes of `planFablePrompt`'s resume note, which must survive verbatim
 *  on every genuine crash-resume. */
const RESUME_NOTE = 'RESUME — a prior run ALREADY committed progress on branch'

describe('plan:next — iteration 1 and every genuine crash-resume keep the full planner', () => {
  test('iteration 1 runs plan:fable, with the survey line intact and no resume note', async () => {
    const out = await run({ ralph: true, ralphRound: 0, resumeCheckpoint: null, prNumber: null })

    expect(out.labels).toContain('plan:fable')
    // Asserted as ABSENCES: the cheap path must not even be probed on a card's
    // first iteration, where there is nothing committed to plan from.
    expect(out.labels).not.toContain('plan:next')
    expect(out.labels).not.toContain('plan:probe')

    // BYTE-PRESERVATION CANARY. `plan:fable` is unchanged by this card; if either
    // of these two facts changes, the "unchanged behaviour, unchanged prompt"
    // acceptance criterion has been broken silently.
    const fable = promptFor(out, 'plan:fable')
    expect(fable).toContain(SURVEY_LINE)
    expect(fable).not.toContain(RESUME_NOTE)
  })

  test('the branch MOVED under a ralph-task-built checkpoint → full planner', async () => {
    // A head that moved in the crash window means code exists that the committed
    // plan was not derived against. That is precisely when re-deriving is worth
    // 287 s, and `classifyResume` reports it as 'head-moved', never
    // 'unknown-checkpoint'.
    const out = await run(cleanHandoff(2, { resumeLiveHead: OTHER_HEAD }))

    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:probe')
    expect(out.labels).not.toContain('plan:next')
    // The resume note is the part of that prompt a resume depends on — it is what
    // tells the planner to read the reused branch rather than only the base.
    expect(promptFor(out, 'plan:fable')).toContain(RESUME_NOTE)
  })

  test("a 'forge-done' resume in ralph mode → full planner", async () => {
    const out = await run(
      cleanHandoff(2, { resumeCheckpoint: 'forge-done' }),
    )

    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:probe')
    expect(out.labels).not.toContain('plan:next')
  })

  test('a launcher that threads NO ralphRound falls back to the full planner', async () => {
    // The fail-safe default, and the only thing standing between an older launcher
    // and a continuation planner running on an iteration nobody counted.
    const { ralphRound: _dropped, ...legacyArgs } = cleanHandoff(2)
    const out = await run(legacyArgs)

    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:probe')
    expect(out.labels).not.toContain('plan:next')
  })
})

describe('plan:next — a clean continuation plans from the committed plan', () => {
  test('probe then plan:next fire, plan:fable does not, and no survey is requested', async () => {
    const out = await run(cleanHandoff(2))

    expect(out.labels).toContain('plan:probe')
    expect(out.labels).toContain('plan:next')
    expect(out.labels).not.toContain('plan:fable')
    // ORDER MATTERS: the probe is what the decision is made from, so a `plan:next`
    // dispatched before it would be a planner chosen on no evidence.
    expect(out.labels.indexOf('plan:probe')).toBeLessThan(out.labels.indexOf('plan:next'))

    const next = promptFor(out, 'plan:next')
    // The committed plan is IN the prompt — that is the whole saving: the planner
    // is handed the document instead of re-deriving it.
    expect(next).toContain(COMMITTED_PLAN)
    // …and the expensive half is explicitly not requested.
    expect(next).not.toContain(SURVEY_LINE)
    expect(next).toContain('Do NOT read SPEC.md')

    // The probe reads ONE file on the branch and nothing else.
    const probe = promptFor(out, 'plan:probe')
    expect(probe).toContain('git show')
    expect(probe).toContain('IMPLEMENTATION_PLAN.md')
    expect(probe).toContain('Do NOT modify anything')

    // DOWNSTREAM IS UNTOUCHED: `ralphExecuteNote` still hands Forge the plan body
    // to persist, whichever planner produced it.
    const forge = promptFor(out, 'forge:build')
    expect(forge).toContain(COMMITTED_PLAN)
    expect(forge).toContain('Implement ONLY this one task: T2 — the task THIS iteration must pick up')
    expect(forge).toContain("write IMPLEMENTATION_PLAN.md at the repo root with EXACTLY this body")

    // The run completed normally on the cheap planner — not merely "did not crash".
    expect(out.labels).toContain('forge:build')
    expect(out.result.ok).toBe(true)
  })

  for (const round of [5, 10]) {
    test(`round ${round} takes the PERIODIC full re-plan regardless`, async () => {
      // DELIBERATE COST. Building task N can change what task N+1 should be, so the
      // plan is re-derived from the code every PLAN_REFRESH_EVERY rounds. This test
      // exists so that removing the refresh to improve the numbers turns CI red.
      const out = await run(cleanHandoff(round))

      expect(out.labels).toContain('plan:fable')
      expect(out.labels).not.toContain('plan:probe')
      expect(out.labels).not.toContain('plan:next')
    })
  }
})

describe('plan:next — the cheap path escalates rather than guessing', () => {
  test('a committed plan with ZERO unchecked tasks falls through to the full planner', async () => {
    // Never build nothing. An exhausted plan is a question — "is this card done?" —
    // and only the full planner, which can look at the code, may answer it.
    const out = await run(
      cleanHandoff(2, { probe: { planFound: true, uncheckedCount: 0, planBody: '- [x] all done' } }),
    )

    expect(out.labels).toContain('plan:probe')
    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:next')
    expect(out.logs.some((l) => l.includes('plan:next SKIPPED') && l.includes('unchecked task'))).toBe(true)
  })

  test('a plan the branch does not carry falls through to the full planner', async () => {
    const out = await run(
      cleanHandoff(2, { probe: { planFound: false, uncheckedCount: 0, planBody: '' } }),
    )

    expect(out.labels).toContain('plan:probe')
    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:next')
  })

  test('a DEAD probe falls through to the full planner and the workflow still completes', async () => {
    const out = await run(cleanHandoff(2, { probe: null }))

    expect(out.labels).toContain('plan:probe')
    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:next')
    expect(out.labels).toContain('forge:build')
    expect(out.result.ok).toBe(true)
  })

  test('a DEAD plan:next is fatal BEFORE Forge, exactly as a dead plan:fable is', async () => {
    // The one thing the cheap path may not be is less safe. A null plan would send
    // Forge in with no task and no one-task discipline — an unplanned build.
    const out = await run(cleanHandoff(2, { planNextDead: true }))

    expect(out.labels).toContain('plan:next')
    expect(out.labels).not.toContain('forge:build')
    // The throw is harvested into a terminal FAILURE result (the detached
    // workflow's only way to report), not swallowed.
    expect(out.result.ok).toBe(false)
    expect(out.result.checkpoint).toBe('inner-error')
    expect(out.result.remainingTasks).toBe(0)
    expect(
      out.logs.some((l) => l.includes('plan:next returned null (planner terminal error)')),
    ).toBe(true)
  })
})

describe('plan:next — the constants and the seam are the ones the card specified', () => {
  test('the periodic full re-plan is a NAMED constant with the tradeoff written down', () => {
    // Source-level, because the value is the policy: a reader who finds the
    // selection code must find the reason the refresh is there next to it.
    expect(SRC).toContain('const PLAN_REFRESH_EVERY = 5')
    expect(SRC).toContain('DO NOT REMOVE THE PERIODIC FULL RE-PLAN TO MAKE THE NUMBERS LOOK BETTER.')
  })

  test('both planners return the SAME schema', () => {
    // `plan:next` differs from `plan:fable` in its INPUT, not its output — that is
    // what keeps `ralphExecuteNote`, the complexity routing and the re-fire count
    // working untouched.
    expect(SRC).toContain("label: 'plan:next', phase: 'Build', schema: PLAN_SCHEMA")
    expect(SRC).toContain("label: 'plan:fable', phase: 'Build', schema: PLAN_SCHEMA")
  })
})
