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

/** What the `plan:probe` seat reports — or `null` for a seat that died.
 *  `planLines` is the probe's own `wc -l` measurement of the file it relayed; the
 *  workflow checks the relayed body against it, so a test can express "the model
 *  stopped copying half way" as a body that contradicts the count. */
type ProbeAnswer = {
  planFound: boolean
  uncheckedCount: number
  planBody: string
  planLines?: number
} | null

interface Opts {
  ralph?: boolean
  /** Omitted entirely (not null) → a LEGACY launcher that threads no round. */
  ralphRound?: number
  resumeCheckpoint?: string | null
  resumeCheckpointHead?: string | null
  resumeLiveHead?: string
  prNumber?: number | null
  branch?: string | null
  /** Scripted `plan:probe` answer. `undefined` → a healthy plan whose unchecked
   *  count AGREES with what the planner will report as remaining. */
  probe?: ProbeAnswer
  /** `true` → the `plan:probe` DISPATCH REJECTS (a 529, a killed session) rather
   *  than returning null. A returned null and a throw are different code paths and
   *  only one of them was ever covered. */
  probeThrows?: boolean
  /** `true` → the `plan:next` seat returns nothing (planner terminal error). */
  planNextDead?: boolean
  /** Overrides for what `plan:next` RELAYS BACK, so a test can express a planner
   *  that edited, truncated or miscounted the committed plan it was told to echo
   *  verbatim. Absent → a faithful relay. */
  planNextRelay?: { implementationPlan?: string; remainingTasks?: number }
  /** `true` → the mocked `forge:build` reports `deviatedFromSpec: true`, i.e. it
   *  materially built something other than what its exec spec described. */
  forgeDeviates?: boolean
  /** What BOTH planner seats report as still unchecked AFTER this task. `0` (the
   *  default) runs the iteration through to review; `>0` makes it hand back to the
   *  outer loop, which is the only path that writes a `ralph-task-built*`
   *  checkpoint. */
  remainingTasks?: number
  /** `'pr'` exercises the publish handoff (the build invocation exits early and the
   *  deviation must ride the result out); `'local'` (default) writes the checkpoint
   *  itself. */
  mergeMode?: 'local' | 'pr'
  /** `true` threads a dbPath/runId so `checkpoint()` actually dispatches its Bash
   *  seat — which is the only way the CHECKPOINT NAME (as opposed to the returned
   *  result field) shows up in the captured labels. */
  withDb?: boolean
}

interface Out {
  captured: Captured[]
  labels: string[]
  logs: string[]
  result: {
    ok: boolean
    verdict: string | null
    checkpoint: string
    remainingTasks: number
    deviatedFromSpec?: boolean
  }
}

async function run(opts: Opts = {}): Promise<Out> {
  const captured: Captured[] = []
  const logs: string[] = []

  const agent = async (prompt: string, o?: { label?: string }): Promise<unknown> => {
    const label = o?.label ?? ''
    captured.push({ label, prompt })
    if (label === 'plan:probe') {
      // A DISPATCH THAT REJECTS, not a seat that answers null: the workflow must
      // survive this, and until the fix it did not.
      if (opts.probeThrows === true) throw new Error('API Error 529 (overloaded)')
      const answer =
        opts.probe === undefined
          ? {
              planFound: true,
              // The probe's `grep -c` count INCLUDES the task about to be built, so
              // the honest default is one more than what the planner then reports as
              // remaining. The workflow now enforces exactly that relationship, so a
              // harness that contradicted it would make every test exercise the
              // integrity-correction path instead of the path it names.
              uncheckedCount: (opts.remainingTasks ?? 0) + 1,
              planBody: COMMITTED_PLAN,
              planLines: COMMITTED_PLAN.split('\n').length,
            }
          : opts.probe
      return answer
    }
    if (label === 'plan:next') {
      if (opts.planNextDead === true) return null
      // The contract the real prompt states: the committed body comes back
      // VERBATIM, so `ralphExecuteNote` hands Forge exactly what is on the branch.
      return {
        implementationPlan: opts.planNextRelay?.implementationPlan ?? COMMITTED_PLAN,
        topTask: 'T2 — the task THIS iteration must pick up',
        executionSpec: 'TARGET FILES: t2.ts',
        complexity: 'reasoning',
        // 0 by default so the iteration flows into forge:build + review instead of
        // handing straight back to the outer loop for a re-fire — the planner choice
        // is what is under test, and the re-fire path would cut the run short. The
        // deviation tests set it >0, because the re-fire IS the path they exercise.
        remainingTasks: opts.planNextRelay?.remainingTasks ?? opts.remainingTasks ?? 0,
      }
    }
    if (label === 'plan:fable') {
      return {
        implementationPlan: COMMITTED_PLAN,
        topTask: 'T2 — the task THIS iteration must pick up',
        executionSpec: 'TARGET FILES: t2.ts',
        complexity: 'reasoning',
        remainingTasks: opts.remainingTasks ?? 0,
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
        // Absent unless the test asks for it — the field is OPTIONAL in FORGE_SCHEMA,
        // and the default path must behave exactly as it did before this card.
        ...(opts.forgeDeviates === true ? { deviatedFromSpec: true } : {}),
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
    mergeMode: opts.mergeMode ?? 'local',
    prNumber: opts.prNumber ?? null,
    branch: opts.branch ?? 'trident/plan-next-run',
    // null → checkpoint()/writeTerminalResult() no-op; the RETURN carries the result.
    dbPath: opts.withDb === true ? '/tmp/plan-next.db' : null,
    runId: opts.withDb === true ? 'run-plan-next' : null,
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

  test('ITERATION 2 — ralphRound 1 — takes the cheap path, which is the whole card', async () => {
    // THE OFF-BY-ONE THIS TEST EXISTS TO PIN. `ralph_round` is ZERO-BASED: the store
    // creates a run at 0 and the orchestrator bumps it once per re-fire, so the
    // SECOND iteration — the first one that has a committed plan to read, and the
    // first one the card's acceptance criteria name — arrives here as ralphRound 1.
    // A `>= 2` gate looks right and silently makes iteration 2 pay the full 287 s
    // survey; nothing in the old round list (0, 2, 3, 5, 10) could see it.
    const out = await run(cleanHandoff(1))

    expect(out.labels).toContain('plan:probe')
    expect(out.labels).toContain('plan:next')
    expect(out.labels).not.toContain('plan:fable')
    expect(promptFor(out, 'plan:next')).not.toContain(SURVEY_LINE)
  })

  for (const round of [1, 2, 3, 4]) {
    test(`round ${round} (iteration ${round + 1}) is inside the refresh window → cheap path`, async () => {
      // The whole window, end to end, so the boundary at either side is asserted
      // rather than inferred: 1..4 cheap, 5 full (below), 6..9 cheap again.
      const out = await run(cleanHandoff(round))
      expect(out.labels).toContain('plan:next')
      expect(out.labels).not.toContain('plan:fable')
    })
  }

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

  test('a probe whose DISPATCH THROWS does not end the lane — the build still happens', async () => {
    // THE DIFFERENCE BETWEEN A SEAT THAT ANSWERS `null` AND A SEAT THAT REJECTS, and
    // it is the whole finding: an unwrapped `await agent(...)` propagates the
    // rejection out of the Ralph block, past `forge:build`, into the terminal
    // handler — the card's ONE optimisation seat taking the lane down with it. The
    // probe is an accelerator; the only correct response to its death is to pay the
    // full price and build anyway.
    const out = await run(cleanHandoff(2, { probeThrows: true }))

    expect(out.labels).toContain('plan:probe')
    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:next')
    // The lane got its build and its verdict — not an `inner-error` checkpoint.
    expect(out.labels).toContain('forge:build')
    expect(out.result.ok).toBe(true)
    expect(out.result.checkpoint).not.toBe('inner-error')
    // …and the dead seat is NAMED on the transcript, so the operator can see the
    // accelerator failing rather than only a slow build.
    expect(out.logs.some((l) => l.includes('trident.seat-died') && l.includes('plan-probe-round-2'))).toBe(
      true,
    )
  })

  test('a TRUNCATED relay of the committed plan is caught by the probe’s own line count', async () => {
    // The probe runs on the cheapest tier and is asked to copy an arbitrarily long
    // file byte for byte. `wc -l` is the check that makes that safe: the body it
    // reported is three lines, the file it measured was five, so the body is not the
    // plan and the cheap path — whose output would be COMMITTED over
    // IMPLEMENTATION_PLAN.md — is abandoned.
    const out = await run(
      cleanHandoff(2, {
        probe: {
          planFound: true,
          uncheckedCount: 2,
          planBody: COMMITTED_PLAN.split('\n').slice(0, 3).join('\n'),
          planLines: 5,
        },
      }),
    )

    expect(out.labels).toContain('plan:probe')
    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:next')
    expect(out.logs.some((l) => l.includes('plan:next SKIPPED') && l.includes('truncated'))).toBe(true)
  })

  test('a probe that reports a MATCHING line count is trusted (the guard is not a veto on everything)', async () => {
    // The contrast that stops the guard from being a way to disable the feature: a
    // faithful relay that dropped only the file's trailing newline still passes.
    const out = await run(
      cleanHandoff(2, {
        probe: {
          planFound: true,
          uncheckedCount: 1,
          planBody: COMMITTED_PLAN,
          planLines: COMMITTED_PLAN.split('\n').length - 1,
        },
      }),
    )

    expect(out.labels).toContain('plan:next')
    expect(out.labels).not.toContain('plan:fable')
  })
})

/**
 * THE RELAYED PLAN IS VERIFIED AGAINST THE PROBE'S MEASUREMENTS, NOT TAKEN ON TRUST.
 *
 * `plan:next` is asked to do two mechanical things — echo the committed body
 * verbatim, and report the probe's unchecked count minus one — and the probe already
 * MEASURED both. Getting either wrong is silent and expensive: `ralphExecuteNote`
 * tells Forge to write "EXACTLY this body" and commit it, so a shortened echo deletes
 * tasks from the card's own plan; and `remainingTasks` is the re-fire gate, so a
 * hallucinated 0 declares a half-built card finished.
 */
describe('plan:next — the measurement beats the relay', () => {
  test('a planner that EDITED the body it was told to echo does not get to commit its edit', async () => {
    const rewritten = ['# rewritten by the planner', '- [ ] something else entirely'].join('\n')
    const out = await run(cleanHandoff(2, { planNextRelay: { implementationPlan: rewritten } }))

    expect(out.labels).toContain('plan:next')
    // WHAT FORGE IS TOLD TO PERSIST is the observable that matters — the committed
    // body, not the planner's version of it.
    const forge = promptFor(out, 'forge:build')
    expect(forge).toContain(COMMITTED_PLAN)
    expect(forge).not.toContain('# rewritten by the planner')
    expect(out.logs.some((l) => l.includes('plan:next INTEGRITY') && l.includes('COMMITTED body'))).toBe(
      true,
    )
  })

  test('a faithful relay is left exactly alone (no correction, no log)', async () => {
    const out = await run(cleanHandoff(2))

    expect(promptFor(out, 'forge:build')).toContain(COMMITTED_PLAN)
    expect(out.logs.some((l) => l.includes('plan:next INTEGRITY'))).toBe(false)
  })

  test('remainingTasks comes from the probe’s grep count, not the planner’s claim', async () => {
    // The dangerous direction: a planner reporting 0 on a plan with three unchecked
    // tasks left would end the card at the re-fire gate with two tasks unbuilt.
    const out = await run(
      cleanHandoff(2, {
        withDb: true,
        probe: {
          planFound: true,
          uncheckedCount: 4,
          planBody: COMMITTED_PLAN,
          planLines: COMMITTED_PLAN.split('\n').length,
        },
        planNextRelay: { remainingTasks: 0 },
      }),
    )

    // 4 unchecked, one of them built this iteration → 3 remain, and the run hands
    // back to the outer loop instead of declaring the card done.
    expect(out.result.remainingTasks).toBe(3)
    expect(out.result.checkpoint).toBe('ralph-task-built')
    expect(out.logs.some((l) => l.includes('plan:next INTEGRITY') && l.includes('measured count'))).toBe(
      true,
    )
  })

  test('an OVER-count is corrected too — the probe is the authority in both directions', async () => {
    const out = await run(
      cleanHandoff(2, {
        probe: {
          planFound: true,
          uncheckedCount: 1,
          planBody: COMMITTED_PLAN,
          planLines: COMMITTED_PLAN.split('\n').length,
        },
        planNextRelay: { remainingTasks: 9 },
      }),
    )

    // 1 unchecked, built this iteration → 0 remain: the card really is finished, and
    // a planner inventing nine more tasks must not buy itself nine more iterations.
    expect(out.result.remainingTasks).toBe(0)
  })
})

describe('plan:next — the probe reads the ref the resume gate judged', () => {
  test('pr mode probes origin/<branch>, matching resolveResumeLiveHead', async () => {
    // The resume gate that cleared this handoff read the REMOTE head
    // (`git ls-remote origin`). `git show <branch>:…` would resolve the LOCAL
    // refs/heads/<branch> first — and in pr mode Forge commits locally and is told
    // not to push, so the local ref can hold an unpublished, unreviewed commit. The
    // probe must read the same commit the gate cleared, or `plan:next` skips a task
    // nobody has seen.
    const out = await run(cleanHandoff(2, { mergeMode: 'pr', prNumber: 42 }))
    const probe = promptFor(out, 'plan:probe')

    expect(probe).toContain('origin/trident/plan-next-run:IMPLEMENTATION_PLAN.md')
  })

  test('local mode probes the local ref, which is the authority there', async () => {
    const out = await run(cleanHandoff(2))
    const probe = promptFor(out, 'plan:probe')

    expect(probe).toContain("git show 'trident/plan-next-run:IMPLEMENTATION_PLAN.md'")
    expect(probe).not.toContain('origin/trident/plan-next-run:IMPLEMENTATION_PLAN.md')
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

/**
 * A DEVIATED FORGE INVALIDATES THE COMMITTED PLAN. `plan:next`'s whole saving rests
 * on the assumption that the IMPLEMENTATION_PLAN.md the previous iteration committed
 * still describes the code. When Forge materially built something other than what its
 * exec spec said, that assumption is false and the cheap planner would hand the next
 * iteration a stale document. The mechanism is one checkpoint NAME: the deviated
 * variant fails T1's exact-name predicate and lands in `classifyResume`'s
 * unknown-checkpoint → rebuild, which is the full `plan:fable`.
 */
describe('deviatedFromSpec — a deviated iteration hands off a DIFFERENT checkpoint', () => {
  test('LOCAL mode: a deviating Forge writes ralph-task-built-deviated', async () => {
    const out = await run({
      ralph: true,
      ralphRound: 0,
      remainingTasks: 2,
      forgeDeviates: true,
      withDb: true,
    })

    expect(out.result.checkpoint).toBe('ralph-task-built-deviated')
    expect(out.result.remainingTasks).toBe(2)
    // The RECORDED name matters as much as the returned one: the next invocation
    // reads the row, not this object.
    expect(out.labels).toContain('checkpoint:ralph-task-built-deviated')
    expect(out.labels).not.toContain('checkpoint:ralph-task-built')
  })

  test('LOCAL mode: a Forge that did NOT deviate still writes ralph-task-built', async () => {
    // The default guard. Nothing about the handoff may change for the overwhelmingly
    // common case, or every iteration pays the survey and the card achieves nothing.
    const out = await run({ ralph: true, ralphRound: 0, remainingTasks: 2, withDb: true })

    expect(out.result.checkpoint).toBe('ralph-task-built')
    expect(out.labels).toContain('checkpoint:ralph-task-built')
    expect(out.labels).not.toContain('checkpoint:ralph-task-built-deviated')
  })

  test('the NEXT iteration after a deviated handoff pays for the full survey', async () => {
    // THE ACCEPTANCE CRITERION, asserted where it is observable: which planner seat
    // the following iteration dispatches. Everything else in this file is plumbing
    // that exists to make this line true.
    const out = await run({
      ralph: true,
      ralphRound: 3,
      resumeCheckpoint: 'ralph-task-built-deviated',
      resumeCheckpointHead: HEAD,
      resumeLiveHead: HEAD,
    })

    expect(out.labels).toContain('plan:fable')
    expect(out.labels).not.toContain('plan:probe')
    expect(out.labels).not.toContain('plan:next')
  })

  test('the same iteration after a CLEAN handoff still takes the cheap path', async () => {
    // The contrast that makes the test above mean something: identical round,
    // identical heads — only the checkpoint name differs.
    const out = await run(cleanHandoff(3))

    expect(out.labels).toContain('plan:next')
    expect(out.labels).not.toContain('plan:fable')
  })

  test('PR mode: the deviation rides the publish handoff out of the build invocation', async () => {
    // In pr mode this invocation EXITS at the publish handoff — it never reaches the
    // checkpoint that names the deviation. The result field is the only channel.
    const deviated = await run({
      ralph: true,
      ralphRound: 0,
      mergeMode: 'pr',
      remainingTasks: 2,
      forgeDeviates: true,
    })

    expect(deviated.result.checkpoint).toBe('forge-done')
    expect(deviated.result.deviatedFromSpec).toBe(true)

    const clean = await run({ ralph: true, ralphRound: 0, mergeMode: 'pr', remainingTasks: 2 })
    expect(clean.result.checkpoint).toBe('forge-done')
    expect(clean.result.deviatedFromSpec).toBe(false)
  })

  test('PR mode: an outer-published resume carrying :deviated writes the deviated checkpoint', async () => {
    // The SECOND invocation. It skips the build entirely (classifyResume must still
    // read the suffixed name as a review-eligible publish checkpoint), so the only
    // thing it knows about the deviation is the suffix the outer publisher appended.
    const out = await run({
      ralph: true,
      ralphRound: 2,
      mergeMode: 'pr',
      resumeCheckpoint: `outer-published:${HEAD}:2:1:deviated`,
      resumeLiveHead: HEAD,
      withDb: true,
    })

    expect(out.labels).not.toContain('forge:build')
    expect(out.result.checkpoint).toBe('ralph-task-built-deviated')
    expect(out.result.remainingTasks).toBe(2)
    expect(out.labels).toContain('checkpoint:ralph-task-built-deviated')
  })

  test('PR mode: an outer-published resume WITHOUT the suffix is unchanged', async () => {
    // The byte-identical-old-format guard: the suffix is optional, and its absence
    // must leave the existing publish→review→re-fire path exactly as it was.
    const out = await run({
      ralph: true,
      ralphRound: 2,
      mergeMode: 'pr',
      resumeCheckpoint: `outer-published:${HEAD}:2:1`,
      resumeLiveHead: HEAD,
      withDb: true,
    })

    expect(out.labels).not.toContain('forge:build')
    expect(out.result.checkpoint).toBe('ralph-task-built')
    expect(out.result.remainingTasks).toBe(2)
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
