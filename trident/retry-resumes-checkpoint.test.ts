import { honourDiffOutput } from './testing/diff-output-host.ts'
/**
 * A RE-DISPATCH KEEPS THE CARD'S TASK COUNT (#519).
 *
 * The two halves are different widths, and this header said only the narrower one for
 * several rounds: the BUDGET carry covers any governed prior the card names, EXHAUSTED
 * included; COMPLETE CHECKPOINT RESUMPTION needs a review-capable checkpoint on an unmoved
 * tip.
 *
 * WHAT THIS CLOSES, exactly. A governed run that died at `fix-round-N` or
 * `outer-published:*` with iterations LEFT used to be re-dispatched onto a row at
 * `task_iteration: 0`. Two readers make that a real loss for that run:
 * `refireNextTask` (orchestrator.ts) bounds its remaining loop on
 * `nextTaskIteration > run.max_task_iterations`, and `buildWorkflowArgs` (inner-loop.ts)
 * threads the counter to the inner workflow as `taskIteration`, where the plan-refresh
 * cadence reads `taskIteration % PLAN_REFRESH_EVERY` — so the periodic full re-plan
 * landed on the wrong iteration of the same piece of work. The count and its cap now
 * travel together.
 *
 * AN EXHAUSTED RUN NO LONGER GETS A FRESH BUDGET, and an earlier version of this header
 * said it did — describing the behaviour this file's own "an EXHAUSTED execution_strategy run does keep
 * its spend" test asserts the opposite of. It was true when written: the carry was gated
 * on the commit seed, so an exhausted row (which dies at `inner_checkpoint =
 * 'task-built'`, not review-capable, therefore `died-before-build`) seeded nothing
 * and inherited nothing. Decoupling the budget from the seed made it false. A FIX
 * INVALIDATES THE EXPLANATIONS OF THE BUG IT FIXES.
 *
 * HISTORICAL BOUNDARY: these tests pin the prior-row compatibility carry that #629
 * supersedes once a card owns a budget snapshot. The old reset mechanisms were:
 *
 *   - THE LINK IS CLEARED BY ONE CLICK. `work-board/store.ts` NULLs `linked_run_id` when
 *     a card leaves the `failed` lane and again on `done → upcoming`, so
 *     `cardsPriorRun === ''` and the ladder takes `card_names_no_run`
 *     (`board-dispatch.ts:1282`) — no prior, no carry.
 *   - AN INTERVENING NON-GOVERNED RUN BECOMES THE PRIOR. Every successful dispatch
 *     rebinds the card to its new run (`board-dispatch.ts:1574`), so one execution_strategy-off
 *     dispatch makes THAT row what the link names; `carriedTaskBudget` then answers null
 *     on `run.execution_strategy !== 'task_sequence'` (`run-disposition.ts:298`). The spend is not lost to a
 *     lookup — it is lost because the card now points somewhere else.
 *   - A DISPATCH WITH NO CARD AT ALL. `onboarding/overnight/register.ts` creates governed
 *     runs with no board item, so there is never a link to inherit through.
 *
 * The card-owned tests in `board-dispatch.test.ts` now prove these link movements do
 * not reset a card whose snapshot exists.
 *
 * This file drives the REAL `dispatchBoardBoundBuild` against the REAL store and pins
 * both directions — the carry on proof, the fresh start (and its logged reason)
 * without it — plus the boundaries that make it safe: the cap travels WITH the round
 * so a tighter one cannot be raised, a task-text edit past the slug's 35th character
 * does not cost the card its budget, a live run is refused at the existing claim
 * chokepoint, and the launcher-CRASH relaunch (a different path, on the SAME row) is
 * untouched.
 *
 * Every case names the mutation that turns it RED.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFileSync } from 'node:fs'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  dispatchBoardBoundBuild,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from './board-dispatch.ts'
import {
  TridentRunStore,
  TridentInvalidTaskCapError,
  TridentInvalidTaskIterationError,
  TridentUnboundedCarriedRoundError,
  type MergeMode,
  type TridentRun,
} from './store.ts'
import { carriedTaskCap, carryableTaskIteration, DEFAULT_MAX_TASK_ITERATIONS } from './task-budget.ts'
import { computeTransition } from './state-machine.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentTickLoop } from './tick.ts'
import { buildWorkflowArgs, type InnerLoopInput } from './inner-loop.ts'
import { slugifyTask } from './slugify-task.ts'
import { fixtureDispatchAdmission } from './__tests__/dispatch-admission-fixture.ts'

const HEAD = 'a'.repeat(40)
const MOVED = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const TASK = 'rebuild the governed importer end to end with a full regression suite'
const BRANCH = `trident/${slugifyTask(TASK)}`

let tmp: string
let db: ProjectDb
let store: TridentRunStore
/** The card's board link, read lazily so a test can create its prior run first. */
let cardLink: string | null = null

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'trident-retry-resume-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  store = new TridentRunStore(db)
  cardLink = null
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const board: TridentBoardBinder = {
  get: () => ({
    id: 'ready',
    title: 'rebuild the governed importer end to end with a full regression suite',
    design_doc_ref: null,
    linked_run_id: cardLink,
  }),
  attachRun: async () => {},
}

/**
 * A finished GOVERNED prior attempt at this card, parked on a review-capable
 * checkpoint with a recorded head, a base pin and a spent re-fire counter.
 *
 * `fix-round-N` rather than `forge-done`, deliberately: `builtButNeverReviewedSeed`
 * refuses a bare `forge-done` under execution_strategy (the workflow rebuilds it —
 * 'execution_strategy-progress-unknown'), so `forge-done` could never exercise the carried round
 * at all. `fix-round-N` routes to review in BOTH modes.
 */
async function priorRun(
  over: {
    task?: string
    execution_strategy?: 'single' | 'task_sequence' | null
    task_iteration?: number
    task_total?: number | null
    max_task_iterations?: number
    checkpoint?: string | null
    phase?: 'done' | 'failed' | 'stopped'
  } = {},
): Promise<TridentRun> {
  const task = over.task ?? TASK
  const run = await store.create({
    slug: slugifyTask(task),
    project_slug: 'proj-1',
    repo_path: tmp,
    task,
    branch: `trident/${slugifyTask(task)}`,
    execution_strategy: over.execution_strategy ?? 'task_sequence',
    ...(over.max_task_iterations === undefined ? {} : { max_task_iterations: over.max_task_iterations }),
  })
  await store.update(run.id, {
    phase: over.phase ?? 'failed',
    inner_checkpoint: over.checkpoint === undefined ? 'fix-round-3' : over.checkpoint,
    inner_checkpoint_head: HEAD,
    inner_verdict: 'REVIEW_NOT_RUN',
    base_sha: BASE,
    task_iteration: over.task_iteration ?? 4,
    task_total: over.task_total ?? null,
  })
  cardLink = run.id
  return store.get(run.id)!
}

function deps(over: Partial<BoardBoundBuildDeps> = {}): BoardBoundBuildDeps {
  return {
    store,
    projectAdmission: fixtureDispatchAdmission(db),
    board,
    project_slug: 'proj-1',
    repo_path: tmp,
    resolveBuildRepo: async () => tmp,
    resolveMergeMode: async () => 'local',
    ...over,
  }
}

/**
 * Dispatch the card, recording the branch-tip reads AND the `[trident]` lines the
 * chokepoint emitted. Every refusal below falls back to a byte-identical FRESH
 * dispatch, so without the line the refusal leaves no trace anywhere — a card that
 * silently rebuilt finished work looks exactly like a card that was never built.
 *
 * WHAT THIS DOES *NOT* PROVE, stated so no future reader mistakes it (cross-model
 * review, BLOCKER 2). The spec item's first criterion wants a refusal stated
 * "plainly on the card", and a captured `console.log` is not that: it is a SERVER
 * LOG, and nobody looking at the board sees it. When these tests were written that
 * half of the criterion was NOT delivered — `work_board_items` has no free-text field
 * and `TridentBoardBinder` is `get`/`attachRun`/reconcile, so there was no board
 * surface to write to. It is now delivered on the RUN row instead:
 * `code_trident_runs.resume_note` (migration 0155), written once by the dispatch
 * (`resumeNote`, board-dispatch.ts), carried by `run_progress` to both front-ends and
 * pinned in cross-run-retry-checkpoint.test.ts. These assertions still pin the log,
 * which now also carries that sentence as `note`.
 */
async function dispatchRecording(
  tip: (repo: string, branch: string) => Promise<string>,
  over: Partial<BoardBoundBuildDeps> & { task?: string } = {},
) {
  const modes: MergeMode[] = []
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  }
  const { task, ...depOver } = over
  try {
    const result = await dispatchBoardBoundBuild(
      { task: task ?? TASK, board_item_id: 'ready' },
      deps({
        readBranchTip: async (repo, branch, merge_mode) => {
          modes.push(merge_mode)
          return tip(repo, branch)
        },
        ...depOver,
      }),
    )
    return { result, modes, seedLine: lines.find((l) => l.includes('event=dispatch_resume_seed')) ?? null }
  } finally {
    console.log = original
  }
}

describe('a re-dispatch after a DEAD run resumes from its checkpoint AND its execution_strategy round', () => {
  test('the carried round lands on the new row and is PERSISTED, alongside the checkpoint', async () => {
    // RED-mutation A: drop `task_iteration: seed.task_iteration` from the seeded spread in
    // board-dispatch.ts → the new row is born at 0 and the round assertions fail.
    // RED-mutation B: restore `task_iteration: 0` in `TridentRunStore.create` → same,
    // one layer down, which is why both layers are asserted.
    const prior = await priorRun({ task_iteration: 4, task_total: 12 })
    expect(prior.task_iteration).toBe(4) // precondition, asserted not assumed

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.id).not.toBe(prior.id) // a NEW row — this is not the crash path
    expect(result.run.task_iteration).toBe(4)
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    // Round 3's work, not round 1 over again (the checkpoint half, already landed —
    // pinned here so the two halves cannot drift apart).
    expect(result.run.round).toBe(3)
    expect(result.run.base_sha).toBe(BASE)
    // PERSISTED, not merely returned: `launch()` and `refireNextTask` both read
    // the ROW, never this object.
    const stored = store.get(result.run.id)!
    expect(stored.task_iteration).toBe(4)
    expect(stored.task_total).toBe(12)
    expect(stored.inner_checkpoint).toBe('fix-round-3')
    // AND IT SAYS SO, naming the prior run whose continuity was adopted.
    expect(seedLine).toContain('reason=resumed')
    expect(seedLine).toContain('task_iteration=4')
    expect(seedLine).toContain(`prior_run_id=${prior.id}`)
  })

  test('A CHAIN of mid-budget re-dispatches keeps accumulating, never restarting', async () => {
    // Each link in the chain inherits the spend of the one before it, so a card that
    // dies mid-budget twice has spent both times. This is NOT the same as bounding the
    // card — see THE LIMIT below for the case that still resets — it is the property
    // that the counter survives a re-dispatch at all, for as long as the runs keep
    // dying on a review-capable checkpoint.
    // RED-mutation: the same as A above; the chain collapses to 0 at every link.
    await priorRun({ task_iteration: 4 })

    const first = await dispatchRecording(async () => HEAD)
    expect(first.result.ok).toBe(true)
    if (!first.result.ok) return
    expect(first.result.run.task_iteration).toBe(4)

    // Terminalize it where it stands, exactly as the reconcile would, and re-dispatch.
    await store.update(first.result.run.id, {
      phase: 'failed',
      inner_checkpoint: 'fix-round-5',
      inner_checkpoint_head: HEAD,
      inner_verdict: 'REVIEW_NOT_RUN',
      base_sha: BASE,
      task_iteration: 6,
    })
    cardLink = first.result.run.id

    const second = await dispatchRecording(async () => HEAD)
    expect(second.result.ok).toBe(true)
    if (!second.result.ok) return
    expect(second.result.run.task_iteration).toBe(6)
    expect(second.result.run.inner_checkpoint).toBe('fix-round-5')
  })

  test('WIRING: the launcher threads the carried round into the workflow args', async () => {
    // WHAT THIS ASSERTS AND WHAT IT DOES NOT (adversarial review, P2). It asserts the
    // WIRING: the counter written on the row is what `buildWorkflowArgs` hands the
    // inner workflow as `taskIteration`, so the carry is not a column nothing reads.
    //
    // It does NOT show that any planner was skipped, and the "planning tokens are not
    // re-spent" acceptance box is UNTICKED because of that. The cadence gate
    // (`inner-workflow.mjs`, `cleanContinuation`) requires `resumeCheckpoint ===
    // 'task-built'` AND `taskIteration >= 1` AND `% PLAN_REFRESH_EVERY !== 0` — and
    // this change deliberately never resumes `task-built` (it is
    // `died-before-build`). So for every shape this change DOES resume, the full
    // `plan:fable` survey runs exactly as it did before; the carried round only
    // matters for the resumed run's own LATER iterations, whose cadence
    // `inner-workflow-plan-next.test.ts` already pins at rounds 1-4 versus 5 and 10.
    // Asserting an input to a gate no test here drives would be a proxy, and this
    // docblock exists so nobody mistakes it for more.
    // RED-mutation: mutation A or B — the args carry 0 and the assertion fails.
    await priorRun({ task_iteration: 4 })

    const { result } = await dispatchRecording(async () => HEAD)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const args = buildWorkflowArgs({
      run: store.get(result.run.id)!,
      base_branch: 'main',
      max_rounds: 10,
      db_path: join(tmp, 'project.db'),
    } as unknown as InnerLoopInput)
    expect(args['taskIteration']).toBe(4)
    expect(args['executionStrategy']).toBe('task_sequence')
  })

  test('LOCAL merge-mode is covered — the proof is the local ref, and no PR probe is involved', async () => {
    // THE CASE THE FIRE-TIME `detectExistingPr` PROBE CANNOT SERVE. That probe asks
    // GitHub for the branch's open PRs, which in `local` mode (no origin, no `gh`)
    // silently answers nothing — so a resume that depended on it degraded to zero
    // here and a test written only in `pr` mode would pass with the defect present.
    // This resume depends on the DURABLE ROW plus a `rev-parse` of the local ref, so
    // it is mode-independent. RED-mutation: mutation A again — in `local` mode there
    // is nothing else left to carry continuity, so the row comes back bare.
    await priorRun({ task_iteration: 4 })

    const { result, modes, seedLine } = await dispatchRecording(async () => HEAD, {
      resolveMergeMode: async () => 'local',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The proof was taken in LOCAL mode — the local ref, not `ls-remote`.
    expect(modes).toEqual(['local'])
    expect(result.run.merge_mode).toBe('local')
    expect(result.run.task_iteration).toBe(4)
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    // The PR is NOT inherited in either mode: `launch()` asks which PRs are OPEN.
    expect(result.run.pr).toBeNull()
    expect(seedLine).toContain('reason=resumed')
  })

  test('PR merge-mode carries the same two columns — the fix is not local-only', async () => {
    // The positive control for the case above: if the assertions there were passing
    // because `local` had been special-cased, this would red.
    await priorRun({ task_iteration: 7 })

    const { result, modes } = await dispatchRecording(async () => HEAD, {
      resolveMergeMode: async () => 'pr',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(modes).toEqual(['pr'])
    expect(result.run.task_iteration).toBe(7)
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
  })
})

describe('a re-dispatch with no provable prior state starts FRESH, and says why', () => {
  test('NO PRIOR RUN AT ALL: a fresh row, and nothing claimed about a run that does not exist', async () => {
    // The first dispatch of a card. RED-mutation: make the seed unconditional (seed
    // the candidate without the tip comparison) and this still passes — which is why
    // the three refusals below exist as well. What this pins is that a card with no
    // history is untouched by #519: 0 and null, and SILENCE rather than a line about
    // a prior run there is none of.
    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.task_iteration).toBe(0)
    expect(result.run.inner_checkpoint).toBeNull()
    expect(result.run.base_sha).toBeNull()
    expect(seedLine).toBeNull()
  })

  test('THE BRANCH TIP MOVED: the COMMIT is refused, and the line names the moved tip', async () => {
    // THE EVIDENCE GATE. A 40-hex tip that is not the recorded one means the branch
    // moved under this lane — a force-push, or another card's commit. Resuming onto it
    // would build against a state that is gone, and would do it while carrying the
    // prior run's base pin, which is exactly what makes the launcher's leftover-branch
    // refusal exempt the adopted tip.
    // RED-mutation: replace the comparison with `if (candidate !== null) seed =
    // candidate` — it always resumes, and the checkpoint assertions here fail.
    await priorRun({ task_iteration: 4 })

    const { result, seedLine } = await dispatchRecording(async () => MOVED)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull()
    expect(result.run.inner_checkpoint_head).toBeNull()
    expect(result.run.base_sha).toBeNull()
    expect(seedLine).toContain('reason=branch_tip_moved')
    // …AND THE BUDGET STILL TRAVELS, because the card named this run and a rebuild
    // does not un-spend iterations the card already paid for. The two carries have
    // different gates on purpose: the commit needs the tip proof, the counter needs
    // only identity, and `min` can never authorise work.
    expect(result.run.task_iteration).toBe(4)
    expect(store.get(result.run.id)!.task_iteration).toBe(4)
    expect(seedLine).toContain('budget_carried=true')
  })

  test('THE BRANCH IS ABSENT OR THE REF UNREADABLE: the commit is refused under its own reason', async () => {
    // `unknown` AUTHORISES NOTHING. An empty read is the branch being gone, or a ref
    // that could not be read at all (an uncredentialed remote, a probe that threw) —
    // the ABSENCE of evidence, not evidence of another lane. It refuses like a moved
    // tip, but under a different reason, because the sentence is what tells an operator
    // whether to look at the branch or at the credential.
    // RED-mutation: treat `''` as a match (`observed === candidate.head || observed ===
    // ''`) and both arms below resume against a branch nobody can see.
    // PREFIX-DISTINCT TASKS: `slugifyTask` truncates at 35 characters, so two cards
    // whose titles differ only in a suffix share a slug — and a branch.
    for (const [name, task, tip] of [
      ['absent / unreadable', 'absent ref card — rebuild the importer', async () => ''],
      [
        'a probe that THREW',
        'throwing probe card — rebuild the importer',
        async () => {
          throw new Error('ls-remote: exit 128')
        },
      ],
    ] as const) {
      cardLink = null
      await priorRun({ task, task_iteration: 4 })
      const { result, seedLine } = await dispatchRecording(tip, { task })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect({ name, cp: result.run.inner_checkpoint }).toEqual({ name, cp: null })
      expect(seedLine).toContain('reason=branch_tip_unreadable_or_absent')
      // The spend still travels — same reasoning as the moved-tip case above.
      expect({ name, round: result.run.task_iteration }).toEqual({ name, round: 4 })
    }
  })

  test('every fixture task in this file really does have a distinct slug', () => {
    // The precondition the loops and the positive controls rest on, asserted rather
    // than assumed: a shared slug would make one case read ANOTHER case's prior row,
    // and both would pass for the wrong reason. `slugifyTask` truncates at 35
    // characters, which is exactly how that happens by accident.
    const tasks = [
      'absent ref card — rebuild the importer',
      'throwing probe card — rebuild the importer',
      'handoff card — rebuild the importer',
      'stopped card — rebuild the importer',
      'no checkpoint card — rebuild the importer',
      'linked control card — rebuild the importer',
      TASK,
    ]
    expect(new Set(tasks.map(slugifyTask)).size).toBe(tasks.length)
  })

  test('A PRIOR THAT BUILT NOTHING RESUMABLE hands over no COMMIT — but its spend still counts', async () => {
    // `task-built` has a commit behind it but `resumeOnUnchangedHead` rebuilds it
    // by design; a `stopped` run is work the OWNER discarded; a null checkpoint built
    // nothing. None of them hands a commit forward.
    // RED-mutation: carry `prior.inner_checkpoint` outside the `candidate !== null` arm
    // and a row is seeded with a checkpoint the workflow will not review.
    for (const [name, task, over] of [
      ['task-built', 'handoff card — rebuild the importer', { checkpoint: 'task-built' as const }],
      ['a STOPPED prior', 'stopped card — rebuild the importer', { phase: 'stopped' as const }],
      ['no checkpoint at all', 'no checkpoint card — rebuild the importer', { checkpoint: null }],
    ] as const) {
      cardLink = null
      await priorRun({ task, task_iteration: 4, ...over })
      const { result, seedLine } = await dispatchRecording(async () => HEAD, { task })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect({ name, cp: result.run.inner_checkpoint }).toEqual({ name, cp: null })
      expect(seedLine).toContain('reason=prior_run_has_no_resumable_build')
      // AND THE SPEND TRAVELS ANYWAY. This arm matters most: the Task loop's own
      // exhaustion path parks on `task-built`, so a budget gated on the commit
      // seed would give the one shape that can actually exhaust a card the one thing it
      // must not get — a fresh budget. See THE LIMIT below.
      expect({ name, round: result.run.task_iteration }).toEqual({ name, round: 4 })
    }
  })

  test('A CARD THAT DOES NOT NAME THE RUN gets neither the checkpoint nor the round', async () => {
    // Task text is a PROXY for identity and two cards can carry the same text; the
    // board link is the real one. Its absence already refuses the checkpoint — this
    // pins that the round cannot arrive by a different door.
    // RED-mutation: let an absent/mismatched link fall back to the task text alone and
    // a card that cannot show it owns the run inherits its budget position.
    await priorRun({ task_iteration: 4 })
    cardLink = 'some-other-run' // an id no row carries

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.task_iteration).toBe(0)
    expect(result.run.inner_checkpoint).toBeNull()
    // Each unusable shape has its OWN reason: an id no row carries is not the same
    // operator situation as a run belonging to another project.
    expect(seedLine).toContain('reason=card_names_an_unknown_run')
    expect(seedLine).toContain('card_names=some-other-run')
    expect(seedLine).toContain('prior_run_id=null')

    // THE COMPLEMENT: a card naming a run that EXISTS but is genuinely not this
    // project's still refuses, under its own reason.
    cardLink = null
    const OTHER = 'other project card — rebuild the importer'
    const elsewhere = await store.create({
      slug: slugifyTask(OTHER), project_slug: 'some-other-project', repo_path: tmp,
      task: OTHER, execution_strategy: 'task_sequence', max_task_iterations: 20,
    })
    await store.update(elsewhere.id, { phase: 'failed', task_iteration: 9 })
    await priorRun({ task: OTHER, task_iteration: 4 })
    cardLink = elsewhere.id
    const crossProject = await dispatchRecording(async () => HEAD, { task: OTHER })
    expect(crossProject.result.ok).toBe(true)
    if (!crossProject.result.ok) return
    expect(crossProject.result.run.task_iteration).toBe(0)
    expect(crossProject.seedLine).toContain('reason=card_names_a_different_run')
    expect(crossProject.seedLine).toContain('prior_run_id=null')
    expect(crossProject.seedLine).toContain(`card_names=${elsewhere.id}`)

    // POSITIVE CONTROL — a SEPARATE card (its own slug, so its own branch and its own
    // prior row) with the same prior shape and the same tip, whose link is present: it
    // resumes. Without it the assertions above would pass on a seed that had simply
    // stopped working. It cannot reuse the card above: that dispatch left a live row
    // on this branch, which the liveness gate would refuse before any seed is read.
    const CONTROL = 'linked control card — rebuild the importer'
    const controlPrior = await priorRun({ task: CONTROL, task_iteration: 4 })
    cardLink = controlPrior.id
    const control = await dispatchRecording(async () => HEAD, { task: CONTROL })
    expect(control.result.ok).toBe(true)
    if (!control.result.ok) return
    expect(control.result.run.task_iteration).toBe(4)
    expect(control.result.run.inner_checkpoint).toBe('fix-round-3')
  })

  test('an exhausted review-capable retry is refused before creating a new run', async () => {
    const prior = await priorRun({ task_iteration: 20, max_task_iterations: 20 })
    const { result, seedLine } = await dispatchRecording(async () => HEAD)
    expect(result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
    expect(seedLine).toBeNull()
    expect(store.get(prior.id)!.task_iteration).toBe(20)
  })

  test('ONE BELOW THE CAP still has its re-fire — the bound bites at the cap, not before it', async () => {
    // The other side of the bound, so the test above cannot pass by refusing every
    // iteration. A card that had spent 19 of 20 resumes with 19 and gets its
    // twentieth; it is the twenty-first that is refused.
    // RED-mutation: make the carry unconditional AND off-by-one (carry `round + 1`)
    // and this row is already exhausted a round early.
    await priorRun({
      task_iteration: DEFAULT_MAX_TASK_ITERATIONS - 1,
      max_task_iterations: DEFAULT_MAX_TASK_ITERATIONS,
    })

    const { result } = await dispatchRecording(async () => HEAD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.task_iteration).toBe(DEFAULT_MAX_TASK_ITERATIONS - 1)

    const oneLeft = computeTransition({ ...store.get(result.run.id)!, phase: 'task-build' }, {})
    expect(oneLeft.phase).toBe('task-plan')
    expect(oneLeft.task_iteration).toBe(DEFAULT_MAX_TASK_ITERATIONS)
    expect(oneLeft.failure_reason).toBeNull()
  })

  test('a retry retains its selected strategy and iteration spend', async () => {
    await priorRun({ task_iteration: 4 })
    const { result } = await dispatchRecording(async () => HEAD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.execution_strategy).toBe('task_sequence')
    expect(result.run.task_iteration).toBe(4)
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
  })

})

describe('THE CAP TRAVELS WITH THE ROUND — a re-dispatch may tighten the budget, never loosen it', () => {
  // NO TEST ANYWHERE SET `deps.max_task_iterations` (adversarial review, P3: the mutant
  // that replaced `deps.max_task_iterations ?? DEFAULT_MAX_TASK_ITERATIONS` with
  // `prior.max_task_iterations` survived the whole suite). It is threaded in production
  // from `code-command.ts`, so a cap lowered between two attempts is a live path. Every
  // test below sets it explicitly, and the prior row's cap differs from BOTH the
  // default and the dispatch's value so the three cannot be confused.

  test('a tighter prior cap survives a dispatch carrying the ambient default', async () => {
    await priorRun({ task_iteration: 4, max_task_iterations: 5 })
    const { result } = await dispatchRecording(async () => HEAD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run).toMatchObject({ task_iteration: 4, max_task_iterations: 5 })
  })

  test('a cap LOWERED in configuration since the prior run applies immediately', async () => {
    // Tightening is always safe, so a config cut reaches a resumed card. Prior cap 20,
    // dispatch cap 5, carried round 4 → 4/5.
    // RED-mutation: pass `prior.max_task_iterations` instead of `deps.max_task_iterations` as
    // the ceiling — the exact mutant that survived — and the cap comes back 20.
    await priorRun({ task_iteration: 4, max_task_iterations: 20 })

    const { result } = await dispatchRecording(async () => HEAD, { max_task_iterations: 5 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.task_iteration, cap: result.run.max_task_iterations }).toEqual({
      round: 4,
      cap: 5,
    })
  })

  test('a cap RAISED in configuration does NOT reach a resumed card', async () => {
    // The load-bearing half. If a raise reached it, an exhausted card could be
    // resurrected by editing config and pressing ▶ — the unbounded-retry defect
    // re-entering through the cap instead of the counter. Prior cap 6, dispatch cap 30
    // → 6, because `min` only ever tightens.
    // RED-mutation: replace `Math.min(...)` with the dispatch ceiling and the cap
    // becomes 30, buying twenty-four iterations nobody authorised.
    await priorRun({ task_iteration: 5, max_task_iterations: 6 })

    const { result } = await dispatchRecording(async () => HEAD, { max_task_iterations: 30 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.task_iteration, cap: result.run.max_task_iterations }).toEqual({
      round: 5,
      cap: 6,
    })
  })

  test('an UNSEEDED dispatch still takes the configured cap, byte-identically', async () => {
    // The negative control for the three above: with no prior to inherit from, the
    // dispatch's own cap is written exactly as it was before any of this existed.
    // RED-mutation: make `effectiveMaxTaskIterations` prefer the carried value
    // unconditionally and this row loses its configured cap.
    const { result } = await dispatchRecording(async () => HEAD, { max_task_iterations: 7 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.task_iteration, cap: result.run.max_task_iterations }).toEqual({
      round: 0,
      cap: 7,
    })
  })
})

describe('AN EDGE-VALUE ROUND IS NOT AN UNSET ROUND — the counter, as a peer of the cap', () => {
  /**
   * THE FOURTH DEFECT OF ONE SHAPE IN THIS LANE, and the one that says the audit was
   * aimed too narrowly: the CAP got a three-way classification while the COUNTER beside
   * it still normalised anything it did not understand to `0`. Measured: a governed prior
   * at `{ task_iteration: NaN, max_task_iterations: 20 }` produced `{ 0, 20 }`, and
   * `computeTransition` authorised the next transition because `0 + 1 > 20` is false —
   * the budget reset, restored for malformed persisted data.
   *
   * The counter's `null` is the STRICT answer, not the permissive one, and that is the
   * asymmetry with the cap. For a cap, carrying nothing leaves the dispatch's own cap in
   * place and costs nothing. For a counter there is no such fallback: carrying nothing IS
   * the reset. So an unreadable counter REFUSES the dispatch.
   */
  test('UNIT: every edge value on the counter, with absent and zero as the controls', () => {
    // RED-mutation: restore `… ? round : 0` and the null rows below come back 0.
    // PRESENT AND READABLE is honoured, zero included.
    expect(carryableTaskIteration(0)).toBe(0)
    expect(carryableTaskIteration(1)).toBe(1)
    expect(carryableTaskIteration(19)).toBe(19)
    // ABSENT is absent — the only case that answers 0 without being 0.
    expect(carryableTaskIteration(undefined)).toBe(0)
    expect(carryableTaskIteration(null)).toBe(0)
    // PRESENT BUT UNREADABLE answers null, which callers must treat as a refusal.
    for (const bad of [-1, -20, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, 2 ** 53 + 2, '4', {}, true]) {
      expect({ bad, round: carryableTaskIteration(bad) }).toEqual({ bad, round: null })
    }
  })

  /**
   * WHICH CORRUPT VALUES CAN ACTUALLY BE PERSISTED — measured against bun:sqlite rather
   * than assumed, because it decides what the dispatch-level tests can even express.
   * `code_trident_runs` is STRICT with both columns `INTEGER NOT NULL`, so:
   *
   *   -1, -20              → stored verbatim (a real, reachable corruption)
   *   2**53 and beyond     → stored verbatim; read back as an UNSAFE integer
   *   2.5, ±Infinity       → REJECTED by sqlite ("cannot store REAL value in INTEGER")
   *   NaN                  → REJECTED by sqlite (binds as NULL → NOT NULL constraint)
   *
   * So the schema itself already blocks three of the shapes, and the persisted surface is
   * negatives and unsafe magnitudes. That is why the dispatch-level cases below use those
   * two, while `NaN`/`±Infinity`/fractional are covered at the unit and `create` levels,
   * where a caller CAN supply them in-process (a `create` input, arithmetic on an absent
   * field, a partially-built run object). Layered, not duplicated.
   */
  test('DISPATCH: a corrupt prior counter REFUSES the dispatch and writes no row', async () => {
    // `unknown` authorises nothing. While the card's spend cannot be read, nothing can
    // say whether its budget is exhausted, so nothing may authorise another iteration —
    // and "carry nothing" would authorise all of it.
    // RED-mutation: make `carriedTaskBudget` return `{ ok: true, budget: null }` for an
    // unreadable counter and each dispatch below succeeds at `task_iteration: 0` with a full
    // budget: defect four, exactly.
    for (const bad of [-1, -20, 2 ** 53]) {
      cardLink = null
      const task = `corrupt round ${String(bad)} — rebuild the importer`
      const prior = await priorRun({ task, task_iteration: 4 })
      // Corrupt the persisted counter the way a bad writer would.
      db.raw().run('UPDATE code_trident_runs SET task_iteration = ? WHERE id = ?', [bad, prior.id])
      const before = store.listNonTerminalByRepo(tmp).length

      const { result } = await dispatchRecording(async () => HEAD, { task })

      expect({ bad, ok: result.ok }).toEqual({ bad, ok: false })
      if (result.ok) return
      expect({ bad, code: result.code }).toEqual({ bad, code: 'backend_error' })
      // The message names the run and the column, so the repair is a one-line UPDATE.
      expect(result.message).toContain('task_iteration')
      expect(result.message).toContain(prior.id)
      // NOTHING was created — not a fresh row, and certainly not one with a full budget.
      expect(store.listNonTerminalByRepo(tmp).length).toBe(before)
    }
  })

  test('DISPATCH: NaN, ±Infinity and a fractional counter refuse through the REAL dispatch path', async () => {
    // The gate asked for all five shapes through the REDISPATCH path, not only at the
    // store. Three of them cannot be PERSISTED (the measurement above: sqlite's STRICT
    // INTEGER NOT NULL rejects them), so the row is supplied to the real
    // `dispatchBoardBoundBuild` through a store whose `latestTerminalBySlug` is
    // overridden — every other decision, including the refusal, is the production code.
    // Pretending sqlite could store them would be a worse test than this one.
    // RED-mutation: restore `carryableTaskIteration`'s `… ? round : 0` and each of these
    // dispatches succeeds at `task_iteration: 0` with a full budget.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.5, -0.5]) {
      cardLink = null
      const task = `in-memory corrupt ${String(bad)} — rebuild the importer`
      const prior = await priorRun({ task, task_iteration: 4 })
      // OVERRIDE `get`, NOT `latestTerminalBySlug` — dispatch resolves the prior by the
      // card's exact `linked_run_id` now, so the slug lookup is diagnostic only and
      // injecting there would silently stop reaching the decision. A fixture aimed at the
      // seam the code USED to use is the same class of stale as a comment.
      const corrupting = Object.create(store) as TridentRunStore
      const realGet = store.get.bind(store)
      ;(corrupting as unknown as Record<string, unknown>)['get'] = (id: string) => {
        const row = realGet(id)
        return row === null || id !== prior.id
          ? row
          : { ...row, task_iteration: bad as unknown as number }
      }

      // `log.warn` routes to console.WARN, not console.log — the refusal is a warning,
      // like the branch-liveness one. Capturing only console.log made this assertion
      // vacuous on the first attempt, which is the same trap as a test that reacts to
      // its subject rather than its claim.
      const lines: string[] = []
      const originalLog = console.log
      const originalWarn = console.warn
      const capture = (...args: unknown[]): void => {
        lines.push(args.map((a) => String(a)).join(' '))
      }
      console.log = capture
      console.warn = capture
      let result
      try {
        result = await dispatchBoardBoundBuild(
          { task, board_item_id: 'ready' },
          deps({ store: corrupting, readBranchTip: async () => HEAD }),
        )
      } finally {
        console.log = originalLog
        console.warn = originalWarn
      }

      expect({ bad, ok: result.ok }).toEqual({ bad, ok: false })
      if (result.ok) return
      expect({ bad, code: result.code }).toEqual({ bad, code: 'backend_error' })
      expect(result.message).toContain('task_iteration')
      expect(result.message).toContain(prior.id)
      // The refusal is not silent either — same discipline as the branch-liveness gate.
      expect(lines.some((l) => l.includes('event=dispatch_budget_unreadable'))).toBe(true)
    }

    // THE ADJACENT HONOURED VALUE, through the identical seam: a readable counter of 4
    // dispatches. Without this the loop above is satisfied by a store proxy that breaks
    // every dispatch, or by a refusal that fires on anything at all.
    cardLink = null
    const okTask = 'in-memory readable counter — rebuild the importer'
    await priorRun({ task: okTask, task_iteration: 4 })
    const passthrough = Object.create(store) as TridentRunStore
    const control = await dispatchBoardBoundBuild(
      { task: okTask, board_item_id: 'ready' },
      deps({ store: passthrough, readBranchTip: async () => HEAD }),
    )
    expect(control.ok).toBe(true)
    if (!control.ok) return
    expect(control.run.task_iteration).toBe(4)
  })

  test('DISPATCH: a corrupt prior CAP refuses too — the pair is refused as a pair', async () => {
    // The cap half of the same rule. An unreadable cap cannot degrade to "carry nothing"
    // either, because that discards a spend that may already be exhausted.
    // RED-mutation: drop the `isTaskCap(run.max_task_iterations)` arm and this dispatch
    // succeeds with a fresh budget.
    const task = 'corrupt cap card — rebuild the importer'
    const prior = await priorRun({ task, task_iteration: 12 })
    db.raw().run('UPDATE code_trident_runs SET max_task_iterations = ? WHERE id = ?', [-4, prior.id])

    const { result } = await dispatchRecording(async () => HEAD, { task })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('backend_error')
    expect(result.message).toContain('max_task_iterations')
  })

  test('DISPATCH: a readable large counter is exhausted, not corrupt or reset', async () => {
    const prior = await priorRun({ task_iteration: Number.MAX_SAFE_INTEGER, max_task_iterations: 20 })
    const { result } = await dispatchRecording(async () => HEAD)
    expect(result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
    expect(store.get(prior.id)!.task_iteration).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('THE DEFAULT CAP IS PINNED TO ITS LITERAL, not merely to its own name', () => {
    // #575's lesson, one dimension over: an assertion written against a CONSTANT is blind
    // to the constant moving. Every `expect(cap).toBe(DEFAULT_MAX_TASK_ITERATIONS)` in this
    // file keeps passing if someone changes 20 to 200, which would silently multiply
    // every card's budget tenfold — the exact class of change this PR exists to prevent.
    // So the literal is pinned ONCE, here, and the symbolic assertions elsewhere then
    // mean what they say.
    // RED-mutation: change `DEFAULT_MAX_TASK_ITERATIONS` in task-budget.ts and only this
    // test reds — which is the point: the change becomes a deliberate diff, not a silent one.
    expect(DEFAULT_MAX_TASK_ITERATIONS).toBe(20)
    // And the arithmetic the cap participates in, against literals on both sides of the
    // bound rather than against the constant.
    expect(carriedTaskCap(30, undefined)).toBe(20)
    expect(carriedTaskCap(19, undefined)).toBe(19)
  })

  test('DISPATCH: a prior counter of ZERO is not corrupt — it dispatches and carries zero', async () => {
    // THE CONTROL, and the reason the two refusals above are not just "refuse on
    // anything unusual": zero is the fresh-row value and a perfectly ordinary counter.
    // RED-mutation: widen the counter domain to `>= 1` (the cap's original mistake) and
    // this legitimate dispatch is refused as corrupt.
    const task = 'zero counter card — rebuild the importer'
    await priorRun({ task, task_iteration: 0, max_task_iterations: 20 })

    const { result } = await dispatchRecording(async () => HEAD, { task })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.task_iteration, cap: result.run.max_task_iterations }).toEqual({
      round: 0,
      cap: 20,
    })
  })
})

describe('AN EDGE-VALUE CAP IS NOT AN UNSET CAP', () => {
  /**
   * THE THIRD BOUNDARY DEFECT IN THIS LANE IN THE SAME SHAPE — after the at-cap reset
   * and the cap-not-carried — and all three were the code mistaking an EDGE value for an
   * UNSET one and reaching for the permissive default. Measured here:
   * `carriedTaskCap(30, 0)` answered 20, so a dispatch asking for ZERO iterations
   * authorised fifteen more on a run already at round 5.
   *
   * The rule now: only `undefined`/`null` are ABSENT and only they get a default. A
   * present value is honoured as given, zero included. A present-but-unreadable value
   * carries nothing and is REFUSED by name at the write site rather than replaced.
   */
  test('UNIT: every edge value, on both sides, and the absent case as the control', () => {
    // RED-mutation: restore `usable = v >= 1` plus the DEFAULT substitution and the
    // zero rows below come back 20 — the measured defect, exactly.
    // ZERO IS PRESERVED, not defaulted, from either side.
    expect(carriedTaskCap(30, 0)).toBe(0)
    expect(carriedTaskCap(0, 30)).toBe(0)
    expect(carriedTaskCap(0, 0)).toBe(0)
    // ABSENT is the ONLY case that gets the default — the control that stops this test
    // from passing by refusing everything.
    expect(carriedTaskCap(30, undefined)).toBe(DEFAULT_MAX_TASK_ITERATIONS)
    expect(carriedTaskCap(30, null)).toBe(DEFAULT_MAX_TASK_ITERATIONS)
    expect(carriedTaskCap(5, undefined)).toBe(5) // …and min() still applies to it
    // ORDINARY POSITIVES still take the tighter side, in both orders.
    expect(carriedTaskCap(30, 7)).toBe(7)
    expect(carriedTaskCap(7, 30)).toBe(7)
    // PRESENT BUT UNREADABLE carries NOTHING — never a substituted default. A `NaN` cap
    // is the worst of these: `round + 1 > NaN` is false forever, i.e. an unbounded loop.
    for (const bad of [-1, -20, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, '5', {}]) {
      expect({ bad, cap: carriedTaskCap(30, bad) }).toEqual({ bad, cap: null })
    }
    // …and an unreadable PRIOR cap carries nothing either: a round without the bound it
    // was spent against is the 5/20 shape this pair rule exists to prevent.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '5']) {
      expect({ bad, cap: carriedTaskCap(bad, 10) }).toEqual({ bad, cap: null })
    }
  })

  test('DISPATCH: tightening an inherited allowance to zero refuses the retry', async () => {
    await priorRun({ task_iteration: 5, max_task_iterations: 30 })
    const { result } = await dispatchRecording(async () => HEAD, { max_task_iterations: 0 })
    expect(result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
  })

  test('DISPATCH: a prior zero cap survives a permissive dispatch as a refusal', async () => {
    await priorRun({ task_iteration: 0, max_task_iterations: 0 })
    const { result } = await dispatchRecording(async () => HEAD, { max_task_iterations: 30 })
    expect(result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
  })

  test('DISPATCH: an INVALID cap is refused by name, never replaced with the default', async () => {
    // A config typo must not become the most permissive number in the file. `NaN` is the
    // one that matters most: `task_iteration + 1 > NaN` is false forever, so the loop would
    // be unbounded — the exact opposite of what a cap is for.
    // RED-mutation: delete the `isTaskCap` check in `create` and each of these
    // dispatches succeeds, writing an unchecked number into an INTEGER column.
    for (const bad of [Number.NaN, -5, 2.5, Number.POSITIVE_INFINITY]) {
      cardLink = null
      const task = `invalid cap ${String(bad)} — rebuild the importer`
      await priorRun({ task, task_iteration: 4 })
      const { result } = await dispatchRecording(async () => HEAD, { task, max_task_iterations: bad })
      expect({ bad, ok: result.ok }).toEqual({ bad, ok: false })
      if (result.ok) return
      expect({ bad, code: result.code }).toEqual({ bad, code: 'backend_error' })
      expect(result.message).toContain('max_task_iterations')
    }
  })

  test('STORE: zero is accepted, an unreadable cap is refused by name', async () => {
    // "Do not put the check only in the caller." The producer carries nothing for an
    // unreadable cap; this is the write site refusing the raw value it then sees.
    // RED-mutation: delete the `isTaskCap` guard and the rejections below stop.
    const zero = await store.create({
      slug: 'cap-zero', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', max_task_iterations: 0,
    })
    expect(zero.max_task_iterations).toBe(0)
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        store.create({
          slug: `cap-bad-${String(bad)}`, project_slug: 'proj-1', repo_path: tmp, task: 'x',
          execution_strategy: 'task_sequence', max_task_iterations: bad,
        }),
      ).rejects.toThrow(TridentInvalidTaskCapError)
    }
    // ABSENT still takes the default — the control.
    const absent = await store.create({
      slug: 'cap-absent', project_slug: 'proj-1', repo_path: tmp, task: 'x', execution_strategy: 'task_sequence',
    })
    expect(absent.max_task_iterations).toBe(DEFAULT_MAX_TASK_ITERATIONS)
  })

  test('NULL is ABSENT at the write site too — the producer and the store agree on it', async () => {
    // THE DIVERGENCE (adversarial review, item 4). `carriedTaskCap` treats `null` as
    // ABSENT while `create` treated it as INVALID, so one value meant two different things
    // in the two copies of a rule that `task-budget.ts`'s own docblock says the file
    // exists to keep identical — and `main` accepted a null cap, so this was also a
    // regression. The reachable path is a hold payload (`dispatch-holds.ts`
    // `parseJsonObject`, no field validation) forwarded on `!== undefined` and past a `??`
    // that does not filter null, ending in an HTTP 500 with the card not queued.
    // RED-mutation: `!== undefined` instead of `!= null` in `create` and this throws.
    const nulled = await store.create({
      slug: 'cap-null', project_slug: 'proj-1', repo_path: tmp, task: 'x', execution_strategy: 'task_sequence',
      max_task_iterations: null as unknown as number,
    })
    expect(nulled.max_task_iterations).toBe(DEFAULT_MAX_TASK_ITERATIONS)
    // BOTH COPIES, read against each other rather than each against itself — which is the
    // only way a divergence between them is observable.
    expect(carriedTaskCap(30, null)).toBe(DEFAULT_MAX_TASK_ITERATIONS)
    expect(carriedTaskCap(30, undefined)).toBe(DEFAULT_MAX_TASK_ITERATIONS)
  })

  test('a NULL cap WITH a carried round is refused — the COMBINATION was the gap', async () => {
    // THE HOLE MY OWN TESTS LEFT (final gate, blocker 1). They covered null-cap-defaults
    // (no round) and omitted-cap-rejects (with a round) SEPARATELY, and the combination
    // fell between them: the cap is resolved with `??`, which treats null and undefined
    // alike, while the pair guard checked only `=== undefined`. So
    // `{ task_iteration: 5, max_task_iterations: null }` passed the guard AND resolved to 20,
    // creating the unbounded half-pair 5/20 that `TridentUnboundedCarriedRoundError`
    // exists to refuse. Two spellings of ABSENT taking different branches, one layer
    // below where the same asymmetry was fixed a round earlier.
    // RED-mutation: `=== undefined` instead of `== null` in the pair guard and this row
    // is created at 5/20.
    await expect(
      store.create({
        slug: 'null-cap-with-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
        execution_strategy: 'task_sequence', task_iteration: 5, max_task_iterations: null as unknown as number,
      }),
    ).rejects.toThrow(TridentUnboundedCarriedRoundError)
    // …and `undefined` is refused identically, which is the point: the two spellings of
    // absent now take the SAME branch.
    await expect(
      store.create({
        slug: 'undef-cap-with-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
        execution_strategy: 'task_sequence', task_iteration: 5,
      }),
    ).rejects.toThrow(TridentUnboundedCarriedRoundError)
    // POSITIVE CONTROLS, so this cannot pass by refusing everything: a null cap with NO
    // carried round still defaults (nothing is half-paired), and a named cap with a round
    // is accepted at the value named.
    const noRound = await store.create({
      slug: 'null-cap-no-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', max_task_iterations: null as unknown as number,
    })
    expect({ round: noRound.task_iteration, cap: noRound.max_task_iterations }).toEqual({
      round: 0,
      cap: DEFAULT_MAX_TASK_ITERATIONS,
    })
    const paired = await store.create({
      slug: 'paired-cap-with-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', task_iteration: 5, max_task_iterations: 9,
    })
    expect({ round: paired.task_iteration, cap: paired.max_task_iterations }).toEqual({ round: 5, cap: 9 })
  })
})

describe("AN EDITED SPEC DOC MUST NOT COST THE CARD ITS BUDGET", () => {
  test('a task-text edit past the slug\'s 35th character keeps the spend, and says which fact differed', async () => {
    // THE MEASURED DEFECT (adversarial review, P2). The ▶ task text is the card's
    // design-doc BODY and `slugifyTask` truncates at 35 characters, so an owner
    // clarifying that doc between two presses keeps the same slug, the same branch and
    // the same card — while the full text differs. That used to be reported as
    // `prior_run_is_a_different_card` and reset the budget: same lane, same card, and a
    // diagnosis that was simply false. Clarifying a spec doc between two presses is the
    // most likely thing an owner does.
    // RED-mutation: move the `prior.task !== input.task` check back ABOVE the link
    // check (so it decides identity) and the round comes back 0 under the old reason.
    const PREFIX = 'rebuild the governed importer end to'
    const BEFORE = `${PREFIX} end with a full regression suite`
    const AFTER = `${PREFIX} end with a full regression suite, and note the CSV edge case`
    // Precondition, asserted rather than assumed: the edit really does keep the slug.
    expect(slugifyTask(AFTER)).toBe(slugifyTask(BEFORE))
    expect(AFTER).not.toBe(BEFORE)

    await priorRun({ task: BEFORE, task_iteration: 12, max_task_iterations: 20 })

    const { result, seedLine } = await dispatchRecording(async () => HEAD, { task: AFTER })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // THE SPEND SURVIVES: the card named this run, which is identity.
    expect(result.run.task_iteration).toBe(12)
    expect(result.run.max_task_iterations).toBe(20)
    expect(seedLine).toContain('budget_carried=true')
    // THE COMMIT STILL DOES NOT, and that asymmetry is deliberate: adopting the wrong
    // card's unreviewed commit sends code to review under another card's title, while a
    // wrong budget carry can only tighten a bound. Under-authorising is the safe side.
    expect(result.run.inner_checkpoint).toBeNull()
    expect(result.run.base_sha).toBeNull()
    // AND THE REASON IS TRUE. `prior_run_is_a_different_card` was a false statement
    // about the world; this names which of the two facts disagreed.
    expect(seedLine).toContain('reason=prior_run_task_text_differs')
    expect(seedLine).not.toContain('different_card')
  })
})

describe('LOCAL merge-mode over a REAL git repo, with the REAL branch-tip reader', () => {
  /**
   * WHY THIS IS NOT ANOTHER INJECTED PROBE (round 2 test gap). Every other test here
   * injects `readBranchTip`, so they verify the MODE reaches the seam and nothing more —
   * the real `rev-parse --verify` path was never executed, while the `local` acceptance
   * criterion was being claimed on the strength of it. These two dispatch with NO
   * injection at all, against a repo built on disk with no origin and with a `gh` that
   * records every invocation, so "works without gh or a remote" is measured rather than
   * assumed. That is the whole point of the criterion: a resume that leans on
   * `detectExistingPr` silently degrades to nothing exactly here.
   */
  function realRepo(name: string, branch: string | null): { dir: string; head: string } {
    const dir = join(tmp, name)
    mkdirSync(dir)
    const git = (...a: string[]): void => {
      const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a])
      expect(r.exitCode).toBe(0)
    }
    expect(Bun.spawnSync(['git', 'init', dir]).exitCode).toBe(0)
    git('commit', '--allow-empty', '-m', 'init')
    if (branch !== null) git('branch', branch)
    const rev = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--verify', 'HEAD'])
    // NO ORIGIN: `git remote` must be empty, or the "no remote" claim is untested.
    expect(Bun.spawnSync(['git', '-C', dir, 'remote']).stdout.toString().trim()).toBe('')
    return { dir, head: rev.stdout.toString().trim() }
  }

  /** A `gh` on PATH that RECORDS every call and fails, so any reliance on it shows up. */
  function recordingGh(): string {
    const shimDir = join(tmp, `gh-shim-${Math.random().toString(36).slice(2)}`)
    mkdirSync(shimDir)
    const log = join(shimDir, 'calls')
    writeFileSync(join(shimDir, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 1\n`)
    chmodSync(join(shimDir, 'gh'), 0o755)
    return shimDir
  }

  async function dispatchReal(repoDir: string, task: string) {
    const shim = recordingGh()
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shim}:${oldPath ?? ''}`
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '))
    }
    try {
      // NO `readBranchTip` — `defaultReadBranchTip` runs `git rev-parse --verify` for
      // real, against `refs/heads/<branch>` in this repo.
      const result = await dispatchBoardBoundBuild(
        { task, board_item_id: 'ready' },
        deps({ resolveBuildRepo: async () => repoDir }),
      )
      return {
        result,
        seedLine: lines.find((l) => l.includes('event=dispatch_resume_seed')) ?? null,
        ghCalls: (() => {
          try {
            return readFileSync(join(shim, 'calls'), 'utf8').trim()
          } catch {
            return ''
          }
        })(),
      }
    } finally {
      console.log = original
      process.env['PATH'] = oldPath ?? ''
    }
  }

  test('an EXISTING local ref is read by rev-parse and the commit is adopted', async () => {
    // RED-mutation: make `defaultReadBranchTip`'s local arm return '' (or point it at a
    // remote) and the seed is refused — the real reader is what this proves.
    const TASK_LOCAL = 'local real git card — rebuild the importer'
    const branch = `trident/${slugifyTask(TASK_LOCAL)}`
    const { dir, head } = realRepo('real-local-present', branch)
    const prior = await priorRun({ task: TASK_LOCAL, task_iteration: 4 })
    // The prior run recorded THIS repo's actual commit, which is what makes the
    // head-equality proof a real comparison rather than two fixtures agreeing.
    await store.update(prior.id, { inner_checkpoint_head: head, base_sha: head })

    const { result, seedLine, ghCalls } = await dispatchReal(dir, TASK_LOCAL)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.merge_mode).toBe('local')
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    expect(result.run.inner_checkpoint_head).toBe(head)
    expect(result.run.task_iteration).toBe(4)
    expect(seedLine).toContain('reason=resumed')
    // WITHOUT gh, AND WITHOUT A REMOTE. The resume leans on neither.
    expect(ghCalls).toBe('')
    expect(result.run.pr).toBeNull()
  })

  test('an ABSENT local ref reads empty and refuses the commit, keeping only the spend', async () => {
    // The other side: `rev-parse --verify --quiet` on a ref that does not exist exits
    // non-zero, which is `''` — the absence of evidence, not evidence of another lane.
    // RED-mutation: treat a non-zero rev-parse as a match and this dispatch adopts a
    // commit on a branch that does not exist.
    const TASK_GONE = 'local absent ref card — rebuild the importer'
    const { dir } = realRepo('real-local-absent', null) // the card's branch is NOT created
    const prior = await priorRun({ task: TASK_GONE, task_iteration: 4 })
    await store.update(prior.id, { inner_checkpoint_head: HEAD, base_sha: BASE })

    const { result, seedLine, ghCalls } = await dispatchReal(dir, TASK_GONE)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull()
    expect(seedLine).toContain('reason=branch_tip_unreadable_or_absent')
    expect(result.run.task_iteration).toBe(4) // identity is the link, not the branch
    expect(ghCalls).toBe('')
  })
})

describe('THE PRIOR IS THE RUN THE CARD NAMES, not the newest row sharing its slug', () => {
  /**
   * THE BOUNDARY EVERY FIXTURE IN THIS FILE DELIBERATELY AVOIDED. Each of them ensures
   * DISTINCT slugs — there is even a test asserting that they are distinct — so the
   * 35-character truncation this lane has cited repeatedly was the one thing nothing
   * exercised.
   *
   * It matters because the collision happens BEFORE any comparison. `latestTerminalBySlug`
   * orders by `started_at DESC LIMIT 1`, so a colliding card's NEWER terminal run was the
   * row selected, and the ladder then compared THAT row's id against `linked_run_id` and
   * took `card_names_a_different_run` — resetting the budget of a card whose own prior was
   * sitting in the table. The task-text comparison does not save it: that runs after the
   * row is chosen, and a guard downstream of a lossy lookup cannot recover what the lookup
   * discarded.
   */
  test('a colliding NEWER run from another card does not cost this card its budget', async () => {
    // RED-mutation: resolve the prior with `latestTerminalBySlug(project, slug)` again —
    // the budget comes back 0 with `reason=card_names_a_different_run`, which is the
    // measured defect.
    const PREFIX = 'throughput blocker trident dispatch'
    const CARD_A = `${PREFIX} keeps its own budget`
    const CARD_B = `${PREFIX} collides on the truncated slug`
    // Precondition, asserted rather than assumed: these really do collide.
    expect(slugifyTask(CARD_B)).toBe(slugifyTask(CARD_A))
    expect(CARD_B).not.toBe(CARD_A)

    // Card A's own prior, governed and mid-budget.
    const priorA = await priorRun({ task: CARD_A, task_iteration: 7, max_task_iterations: 20 })
    // Card B's prior lands LATER, so it is what the slug lookup returns.
    const priorB = await store.create({
      slug: slugifyTask(CARD_B), project_slug: 'proj-1', repo_path: tmp, task: CARD_B,
      branch: BRANCH, execution_strategy: 'task_sequence', max_task_iterations: 20,
    })
    await store.update(priorB.id, {
      phase: 'failed', inner_checkpoint: 'fix-round-9', inner_checkpoint_head: HEAD,
      inner_verdict: 'REVIEW_NOT_RUN', base_sha: BASE, task_iteration: 2,
    })
    // MAKE "LATER" TRUE INSTEAD OF LIKELY. `latestTerminalBySlug` orders by
    // `started_at DESC, id DESC` (`store.ts:1103`), and `store.ts:1087` already records WHY
    // the `id` tiebreak is there: "two rows can share a timestamp on a fast clock". These
    // two rows are created in the same tick, so the tiebreak decides — and ids are random
    // UUIDs, which made the precondition below a coin flip and this case fail on CI at
    // random. Stamping `started_at` is what the sentence above has always claimed.
    //
    // THE OBSERVED FAILURE, since the two kinds of evidence answer different questions.
    // The 491/1000 measurement against the `ORDER BY` establishes the RATE; this
    // establishes that the mechanism is the one that actually fired. On #654's CI the
    // assertion reported `expected a49ae3c5…, got e7e1fdb9…` — two random UUIDs, 'e' > 'a',
    // which is the id-tiebreak signature and not a timestamp comparison at all. The same
    // case passed five times running on a contended local box, where the clock is slow
    // enough for the two `started_at` reads to land in different milliseconds and the
    // tiebreak is never consulted. "Passes locally, fails on CI" is the operational tell
    // for this whole class: the faster machine is the one that loses the race.
    db.prepare<unknown, [string, string]>(
      'UPDATE code_trident_runs SET started_at = ? WHERE id = ?',
    ).run(new Date(Date.parse(priorA.started_at) + 1_000).toISOString(), priorB.id)
    // The precondition, now ASSERTED AND ESTABLISHED rather than asserted and hoped for.
    expect(store.latestTerminalBySlug('proj-1', slugifyTask(CARD_A))!.id).toBe(priorB.id)

    // Card A retries, naming ITS OWN run.
    cardLink = priorA.id
    const { result, seedLine } = await dispatchRecording(async () => HEAD, { task: CARD_A })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A's budget, not B's, and not a reset.
    expect(result.run.task_iteration).toBe(7)
    expect(seedLine).toContain(`prior_run_id=${priorA.id}`)
    expect(seedLine).toContain('reason=resumed')
    // …and the line SAYS another prior exists for this slug, which is the diagnostic the
    // old single-field log could not express.
    expect(seedLine).toContain(`other_prior_for_slug=${priorB.id}`)
    expect(seedLine).not.toContain('card_names_a_different_run')
  })

  test('and a card naming a run that is still LIVE inherits nothing, under its own reason', async () => {
    // The other thing an exact-key lookup must still refuse: the named run has not
    // finished, so its budget is not final and nothing may be inherited from it.
    // RED-mutation: drop the `isTerminalPhase(namedPrior.phase)` arm and a live run's
    // counter is adopted mid-flight.
    // THE LIVE RUN CARRIES A DIFFERENT SLUG, and that is the only way this arm is
    // reachable: `createIfClaimsAvailable`'s live-holder check matches on project+slug as
    // well as branch, so a live run under the DISPATCH's own slug is refused as
    // `branch_live` long before the prior is consulted. A card that was RE-TITLED while
    // its run was in flight is exactly this shape — the link still names the old run, whose
    // slug came from the old text.
    const task = 'live prior card — rebuild the importer'
    const live = await store.create({
      slug: slugifyTask('an older title this card used to have'),
      project_slug: 'proj-1', repo_path: tmp, task,
      branch: 'trident/live-prior-elsewhere', execution_strategy: 'task_sequence', max_task_iterations: 20,
    })
    await store.update(live.id, { phase: 'task-build', task_iteration: 6 })
    cardLink = live.id

    const { result, seedLine } = await dispatchRecording(async () => HEAD, { task })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.task_iteration).toBe(0)
    expect(seedLine).toContain('reason=card_names_a_live_run')
    // `prior_run_id` means "the row the decision USED" — nothing was, so it is null. This
    // is what makes the terminal check observable: without it, dropping the check left the
    // field pointing at a live run and no test noticed.
    expect(seedLine).toContain('prior_run_id=null')
    expect(seedLine).toContain(`card_names=${live.id}`)
  })
})

describe('absent evidence and exhausted evidence remain distinct', () => {
  test('a card with neither a prior-run link nor a durable snapshot starts fresh', async () => {
    // This structural board fake supplies no card-owned budget at all. The prior
    // shares task text but has no established identity link to this card, so its
    // spend cannot be adopted. This is not the production clear-link path: that
    // path retains the durable card snapshot, covered in board-reconcile/store.
    // Mutation: falling back to matching task text adopts unrelated evidence.
    await priorRun({ task_iteration: 12 })
    cardLink = null // the card no longer names the run it produced

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.task_iteration).toBe(0)
    expect(result.run.max_task_iterations).toBe(DEFAULT_MAX_TASK_ITERATIONS)
    expect(seedLine).toContain('reason=card_names_no_run')
    expect(seedLine).toContain('budget_carried=false')
  })

  test('an exhausted selected run cannot buy a new strategy or allowance on retry', async () => {
    const task = 'exhausted strategy card'
    await priorRun({ task, task_iteration: 20, max_task_iterations: 20 })
    const result = await dispatchRecording(async () => HEAD, { task })
    expect(result.result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
    const sibling = 'remaining budget sibling'
    await priorRun({ task: sibling, task_iteration: 19, max_task_iterations: 20 })
    const remaining = await dispatchRecording(async () => HEAD, { task: sibling })
    expect(remaining.result.ok).toBe(true)
    if (remaining.result.ok) expect(remaining.result.run).toMatchObject({ execution_strategy: 'task_sequence', task_iteration: 19 })
  })

  test('an exhausted continuation cannot reset its allowance through retry', async () => {
    await priorRun({ checkpoint: 'task-built', task_iteration: 20, max_task_iterations: 20 })
    const { result } = await dispatchRecording(async () => HEAD)
    expect(result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
  })

})

describe('THE SEED LINE REPORTS THE ROW, not what the dispatch intended', () => {
  /**
   * THE DEFECT THIS CLOSES IS THE DOMINANT ONE OF THE WHOLE BUILD PHASE, in its purest
   * form (adversarial review, item 5). The claim in the PR body was "the line now states
   * what was WRITTEN, not what was intended". C7 pinned the line's POSITION — that it is
   * emitted after the row exists — and nothing pinned the SOURCE of its values, so three
   * mutations survived the entire suite: `checkpoint: seed?.inner_checkpoint ?? null`,
   * `task_iteration: budget?.task_iteration ?? 0`, `max_task_iterations: budget?.max_task_iterations ?? 0`.
   *
   * A test that reacts to its subject while the claim is about something else is worth
   * less than no test, because it is read as coverage. These pin the values against
   * `store.get(run.id)` in the cases where the row and the intent DISAGREE — which is the
   * only place the distinction is observable.
   */
  test('when budget is NOT carried, the line still reports the ROW\'s cap — not 0', async () => {
    // THE CASE THAT CAUGHT THE MUTANT. `card_names_no_run` carries no budget, so
    // `budget?.max_task_iterations ?? 0` logs 0 while the ROW is at the configured cap. Read
    // the two against each other and the mutant cannot hide.
    // RED-mutation: `max_task_iterations: budget?.max_task_iterations ?? 0` — logs 0, row is 20.
    await priorRun({ task_iteration: 12 })
    cardLink = null

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = store.get(result.run.id)!
    expect(row.max_task_iterations).toBe(20)
    expect(seedLine).toContain(`max_task_iterations=${row.max_task_iterations}`)
    expect(seedLine).toContain(`task_iteration=${row.task_iteration}`)
    expect(seedLine).not.toContain('max_task_iterations=0')
  })

  test('when the COMMIT is refused, the line still reports the row\'s null checkpoint', async () => {
    // `seed?.inner_checkpoint ?? null` is indistinguishable from the row here — `seed` is
    // null and the row's checkpoint is null — so the discriminating case is the RESUMED
    // one below. This half pins that a refused commit is reported as such alongside a
    // CARRIED budget, which is the shape the two-gate split created and which no single
    // field can describe.
    await priorRun({ task_iteration: 4 })
    const { result, seedLine } = await dispatchRecording(async () => MOVED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = store.get(result.run.id)!
    expect(row.inner_checkpoint).toBeNull()
    expect(seedLine).toContain('checkpoint=null')
    expect(seedLine).toContain(`task_iteration=${row.task_iteration}`)
    expect(row.task_iteration).toBe(4)
    expect(seedLine).toContain('budget_carried=true')
  })

  test('on a RESUME every logged field equals the stored row, field by field', async () => {
    // The discriminating case for the checkpoint mutant: `seed.checkpoint` and
    // `run.inner_checkpoint` agree here, so the pin is that BOTH are read off the row and
    // that a reader can trust the line as a description of state. Paired with the two
    // above — where they disagree — the three together say the line's source is the row.
    // RED-mutation: `checkpoint: seed?.inner_checkpoint ?? null` — `seed` has no
    // `inner_checkpoint` field at all, so the line logs `checkpoint=null` for a row that
    // carries `fix-round-3`.
    await priorRun({ task_iteration: 4, max_task_iterations: 20 })

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = store.get(result.run.id)!
    expect(seedLine).toContain(`checkpoint=${row.inner_checkpoint}`)
    expect(seedLine).toContain(`task_iteration=${row.task_iteration}`)
    expect(seedLine).toContain(`max_task_iterations=${row.max_task_iterations}`)
    expect(seedLine).toContain(`run=${row.id}`)
    // …and the literals, so the assertions above cannot all pass on a row of zeroes.
    expect({ cp: row.inner_checkpoint, round: row.task_iteration, cap: row.max_task_iterations }).toEqual({
      cp: 'fix-round-3',
      round: 4,
      cap: 20,
    })
  })
})

describe('THE TERMINAL REASON MUST SAY WHICH FAILURE HAPPENED', () => {
  /**
   * A consequence of inheriting a spend, and a real cost of it (adversarial review,
   * item 3). A row can now reach the Task cap having run NO iteration of its own — the
   * measured case: a prior at 20/20 whose spec doc was edited past the slug's 35th
   * character produces a fresh `forge-init` row at 20/20 with no checkpoint, which fails
   * at its first transition. "Task loop hit max_task_iterations (20) without converging" is
   * false for that row: nothing was attempted, so nothing failed to converge, and it sends
   * whoever reads it hunting a planner problem that does not exist.
   */
  test('a row that inherited a spent budget is not accused of failing to converge', async () => {
    // RED-mutation: `const neverRan = false` in `enterTaskPlan` — the inherited row is
    // blamed on the planner again.
    const PREFIX = 'reason wording card for the governed importer'
    const BEFORE = `${PREFIX} — first pass`
    const AFTER = `${PREFIX} — second pass with the CSV note`
    expect(slugifyTask(AFTER)).toBe(slugifyTask(BEFORE))
    await priorRun({ task: BEFORE, task_iteration: 20, max_task_iterations: 20 })

    const { result } = await dispatchRecording(async () => HEAD, { task: AFTER })
    expect(result).toMatchObject({ ok: false, code: 'task_budget_exhausted' })
    const row = await store.create({ slug: 'terminal-diagnostic', project_slug: 'proj-1', repo_path: tmp, task: AFTER, execution_strategy: 'task_sequence', task_iteration: 20, max_task_iterations: 20 })
    // The measured shape: a fresh build that inherited a spent budget.
    expect({ cp: row.inner_checkpoint, round: row.task_iteration, cap: row.max_task_iterations }).toEqual({
      cp: null,
      round: 20,
      cap: 20,
    })

    const t = computeTransition({ ...row, phase: 'task-build' }, {})
    expect(t.phase).toBe('failed')
    // The token every downstream reader keys on is still there…
    expect(t.failure_reason).toContain('max_task_iterations')
    // …and the explanation is now TRUE — which THIS ASSERTION ITSELF GOT WRONG ONCE.
    // It used to require the phrase "inherited a spent budget", pinning a claim the row
    // cannot support: `inner_checkpoint === null` does not establish that a predecessor
    // existed, so the same wording was handed to a brand-new run at its cap (see the
    // fresh-run boundary test below). A test asserting a claim is only as good as the
    // claim; this one made a lying message look verified.
    // BRANCH 3: the budget IS consumed — that much is certain whoever consumed it —
    // and only WHO is left open.
    // ARM 3 claims only the two column values and the arithmetic. "no build of its own"
    // and "nothing was attempted" were removed: the phase graph advances this counter
    // WITHOUT writing a checkpoint, and the checkpoint is written out-of-process, so a
    // null one establishes neither — see the real-phase-graph boundary test below.
    expect(t.failure_reason).toContain('no inner_checkpoint on this row')
    expect(t.failure_reason).toContain('the budget is spent')
    expect(t.failure_reason).toContain('nor which run spent the rounds')
    expect(t.failure_reason).not.toContain('nothing was attempted')
    expect(t.failure_reason).not.toContain('no build of its own')
    // It may NAME the two possibilities; it may not assert either one…
    expect(t.failure_reason).not.toContain('inherited')
    // …it may not blame a planner that never ran…
    expect(t.failure_reason).not.toContain('without converging')
    // …and it must NOT claim nothing was allocated, which is branch 2's fact and is
    // false here. RED-mutation: collapse branch 3 into branch 2 and this fails.
    expect(t.failure_reason).not.toContain('no Task iteration was ever authorised')

    // CONTROL — a row that CARRIES a checkpoint takes the other arm. Note what this
    // control could NOT see, and did not, for three rounds: it INJECTS the checkpoint,
    // and the arm-3 case above WITHHOLDS one, so neither could distinguish a checkpoint
    // this run produced from one the dispatch seed copied forward. The discriminator and
    // its tests shared a blind spot, which is why the proxy in this arm survived every
    // round of narrowing. The real-dispatch case that CAN see it lives in
    // `orchestrator.test.ts` ("a SEEDED run at cap is not told it failed to converge").
    // So this control now asserts only what a constructed row can honestly establish:
    // which ARM is taken, never who authored the build.
    const ran = computeTransition(
      { ...row, phase: 'task-build', inner_checkpoint: 'task-built' },
      {},
    )
    expect(ran.phase).toBe('failed')
    // The WEAKEST TRUE STATEMENT: the checkpoint's NAME is present, and nothing is
    // claimed about it. `task-built` is the case that makes the difference —
    // `reviewCapableCheckpoint` (run-disposition.ts) DECLINES it, so the previous
    // wording's "a resumable build IS on this row" was flatly false for exactly the
    // checkpoint the execution_strategy handoff writes. Fifth proxy on one sentence.
    expect(ran.failure_reason).toContain("inner_checkpoint 'task-built'")
    expect(ran.failure_reason).not.toContain('no inner_checkpoint on this row')
    // AND IT CLAIMS NOTHING ELSE: not authorship, not resumability, not convergence.
    // RED-mutation: restore any of the five overclaims to arm 1.
    expect(ran.failure_reason).not.toContain('without converging')
    expect(ran.failure_reason).not.toContain('resumable build IS')
    expect(ran.failure_reason).not.toContain('inherited')
    // …and it says plainly that it does not know, which is the load-bearing half.
    expect(ran.failure_reason).toContain('are not recorded here')

    // THE REVIEW-CAPABLE NAME TAKES THE SAME ARM AND THE SAME WORDING — the boundary the
    // old claim stepped over. Both names reach arm 1; neither gets a resumability claim,
    // so the arm needs no fifth discriminator.
    const reviewable = computeTransition(
      { ...row, phase: 'task-build', inner_checkpoint: 'fix-round-3' },
      {},
    )
    expect(reviewable.failure_reason).toContain("inner_checkpoint 'fix-round-3'")
    expect(reviewable.failure_reason).toContain('are not recorded here')
    expect(reviewable.failure_reason).not.toContain('resumable build IS')
  })

  test('A BRAND-NEW run with NO budget allocated is told exactly that — branch 2 of 3', async () => {
    // THE SECOND CONTRADICTION IN THIS ONE SENTENCE, and the mirror of the first. Having
    // removed a claim that was not determinable (inheritance), the wording retreated to
    // the most general phrasing available — "the budget was spent before this run began"
    // — which is FALSE here: this run was configured `max_task_iterations: 0`, so nothing was
    // ever allocated and nothing was spent by anyone. The test that replaced the first
    // lying message only excluded the WORD "inherited", so it blessed the new
    // contradiction: the seventh test in this lane to document a defect as correct.
    //
    // Keying on a proxy asserts more than the row establishes; retreating to the most
    // general wording asserts something false about the cases that were never ambiguous.
    // Same error from opposite sides.
    // RED-mutation: collapse this branch into branch 3 (drop `nothingWasEverAllocated`)
    // and this row is told its budget was consumed when none existed.
    const fresh = await store.create({
      slug: 'fresh-at-cap', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', max_task_iterations: 0,
    })
    expect({ round: fresh.task_iteration, cap: fresh.max_task_iterations, cp: fresh.inner_checkpoint }).toEqual(
      { round: 0, cap: 0, cp: null },
    )

    // `forge-init` in execution_strategy mode needs a REMAINING_TASKS from the bootstrap before it
    // reaches the cap check at all, so this is the real path in for a brand-new run.
    const t = computeTransition({ ...fresh, phase: 'forge-init' }, { remaining: 1 })
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('max_task_iterations')
    // IT SAYS WHAT IS TRUE: nothing was allocated, so nothing was spent.
    // ARM 2 claims only the cap's consequence and the two column values. "this run built
    // nothing" and "no planner to investigate" were removed for the same reason arm 3's
    // claims were: a null checkpoint is written out-of-process, so its absence means "not
    // recorded", never "did not happen".
    expect(t.failure_reason).toContain('no Task iteration could be authorised')
    expect(t.failure_reason).toContain('records task_iteration 0 and no inner_checkpoint')
    expect(t.failure_reason).not.toContain('built nothing')
    expect(t.failure_reason).not.toContain('no planner to investigate')
    // AND CLAIMS NOTHING ELSE — no predecessor, no consumed budget, no planner.
    expect(t.failure_reason).not.toContain('inherited')
    expect(t.failure_reason).not.toContain('the budget is spent')
    expect(t.failure_reason).not.toContain('without converging')
    expect(t.failure_reason).not.toContain('does not record')
  })

  test('A COUNTER ADVANCED BY THE REAL PHASE GRAPH takes arm 3, and is not told nothing was attempted', async () => {
    // THE FIXTURE GAP, and it is the same one fixed for arm 1 one round earlier: every
    // arm-3 case here CONSTRUCTED its counter — inherited through dispatch, or preloaded
    // on the row — so none of them exercised a counter the PHASE GRAPH advanced. That is
    // the state the arm's own sentence described while denying it: `enterTaskPlan`
    // increments `task_iteration` and writes no checkpoint, so a row can have attempted
    // planning repeatedly and still show `inner_checkpoint === null`. The old wording said
    // "nothing was attempted" and then conceded in its next clause that the row may have
    // spent the rounds itself — a sentence contradicting itself inside one string.
    //
    // A test that constructs the state cannot see a defect in how the state is produced.
    // So this drives the real transitions and lets the graph move the counter.
    // RED-mutation: restore "nothing was attempted" (or "no build of its own") to arm 3
    // and this test fails while the constructed arm-3 cases above still pass.
    let row = await store.create({
      slug: 'graph-advanced-counter', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', max_task_iterations: 2,
    })
    expect({ round: row.task_iteration, cp: row.inner_checkpoint }).toEqual({ round: 0, cp: null })

    // Walk the REAL graph until the cap refuses. BOTH `forge-init` and `task-plan` need a
    // REMAINING_TASKS — a planning pass that reports none fails on its own reason and never
    // reaches the cap, which is how the first draft of this loop stopped at round 1 and
    // asserted nothing. `task-build` takes the empty result and is the hop that re-enters
    // `enterTaskPlan`, i.e. the hop that advances the counter.
    const seen: Array<{ phase: string; round: number }> = []
    let guard = 0
    for (;;) {
      if (guard++ > 12) throw new Error('the phase graph did not reach the cap')
      const needsRemaining = row.phase === 'forge-init' || row.phase === 'task-plan'
      const t = computeTransition(row, needsRemaining ? { remaining: 1 } : {})
      seen.push({ phase: t.phase, round: t.task_iteration })
      row = { ...row, phase: t.phase, task_iteration: t.task_iteration }
      if (t.phase === 'failed') {
        // THE COUNTER GOT HERE BY BEING ADVANCED, not by being written — asserted, since
        // that is the whole premise of the test.
        expect(row.task_iteration).toBe(2)
        expect(row.inner_checkpoint).toBeNull()
        expect(seen.filter((x) => x.phase === 'task-plan').length).toBeGreaterThan(1)

        expect(t.failure_reason).toContain('max_task_iterations')
        // ARM 3, and it claims nothing about attempts in either direction.
        expect(t.failure_reason).toContain('no inner_checkpoint on this row')
        expect(t.failure_reason).toContain('whether anything was attempted')
        expect(t.failure_reason).not.toContain('nothing was attempted')
        expect(t.failure_reason).not.toContain('no build of its own')
        // …nor that this run built anything, which is the mirror overclaim.
        expect(t.failure_reason).not.toContain('without converging')
        break
      }
    }
  })

  test('A CARRIED ROUND UNDER A ZERO CAP is branch 3, not branch 2 — the counter decides, not the cap', async () => {
    // THE DISCRIMINATOR HAS TO BE THE COUNTER. Keying branch 2 on `max_task_iterations === 0`
    // reads identically on every row above EXCEPT this one, and this one is reachable:
    // a prior at 5/30 re-dispatched with an explicit cap of 0 produces 5/0 (the cap
    // tightens, the spend travels). Under the cap-keyed version that row is told "nothing
    // has been spent" while its counter says 5. The mutation survived the suite until
    // this case was written, which is what "what input would a wrong implementation get
    // right?" is for: both discriminators agree everywhere else.
    // RED-mutation: `nothingWasEverAllocated = !builtSomethingItself &&
    // run.max_task_iterations === 0` — the row below is told nothing was spent.
    const carriedUnderZero = await store.create({
      slug: 'carried-under-zero-cap', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', task_iteration: 5, max_task_iterations: 0,
    })
    expect({ round: carriedUnderZero.task_iteration, cap: carriedUnderZero.max_task_iterations, cp: carriedUnderZero.inner_checkpoint }).toEqual(
      { round: 5, cap: 0, cp: null },
    )

    const t = computeTransition({ ...carriedUnderZero, phase: 'task-build' }, {})
    expect(t.phase).toBe('failed')
    // BRANCH 3: a budget WAS consumed — five rounds of it — whoever consumed them.
    expect(t.failure_reason).toContain('the budget is spent')
    expect(t.failure_reason).toContain('nor which run spent the rounds')
    // NOT branch 2: "nothing has been spent" is flatly false for a row at task_iteration 5.
    expect(t.failure_reason).not.toContain('records task_iteration 0')
    expect(t.failure_reason).not.toContain('no Task iteration could be authorised')
  })

  test('THE THIRD COMBINATION IS UNREACHABLE, and that is why there are three arms not four', async () => {
    // Derived rather than assumed, because the arm count depends on it. The refusal fires
    // iff `task_iteration >= max_task_iterations`; `max_task_iterations` is written ONLY by
    // `create` (absent from `TridentRunUpdate`) and `create` refuses any cap that is not a
    // non-negative safe integer. So `task_iteration === 0` at the refusal implies `cap === 0`
    // — a round of 0 under a POSITIVE cap can never reach it.
    // RED-mutation: none applies; this asserts a property of the guard, and it reds if
    // someone widens the refusal condition (e.g. to `>=`) or lets a negative cap be
    // written, either of which would make a fourth arm reachable without anyone noticing.
    const positiveCap = await store.create({
      slug: 'round-zero-positive-cap', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', max_task_iterations: 3,
    })
    expect({ round: positiveCap.task_iteration, cap: positiveCap.max_task_iterations }).toEqual({
      round: 0,
      cap: 3,
    })
    // It does NOT fail — it advances, which is the whole content of the claim.
    const t = computeTransition({ ...positiveCap, phase: 'forge-init' }, { remaining: 1 })
    expect(t.phase).toBe('task-plan')
    expect(t.task_iteration).toBe(1)
    expect(t.failure_reason).toBeNull()
  })
})

describe('BOTH runs must be governed — both halves of the gate, pinned', () => {
  test('single and task-sequence priors both preserve their strategy and spend', async () => {
    for (const strategy of ['single', 'task_sequence'] as const) {
      const task = 'retry strategy ' + strategy
      await priorRun({ task, execution_strategy: strategy, task_iteration: 9 })
      const { result, seedLine } = await dispatchRecording(async () => HEAD, { task })
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.run).toMatchObject({ execution_strategy: strategy, task_iteration: 9 })
      expect(seedLine).toContain('budget_carried=true')
    }
  })

})

describe('a re-dispatch is REFUSED while the previous run is still live', () => {
  test('a NON-TERMINAL run on this branch refuses the dispatch and writes no row', async () => {
    // Never resume into a run that is still going: the point of carrying continuity
    // is to continue ONE lane, and two lanes on one branch is the outcome the
    // liveness gate exists to prevent. RED-mutation: delete the
    // `listNonTerminalByRepo(...).find(...)` gate and a second row is created on a
    // branch a live run holds.
    const live = await store.create({
      slug: slugifyTask(TASK),
      project_slug: 'proj-1',
      repo_path: tmp,
      task: TASK,
      branch: BRANCH,
      execution_strategy: 'task_sequence',
    })
    await store.update(live.id, { phase: 'task-build', task_iteration: 4 })
    cardLink = live.id

    const before = store.listNonTerminalByRepo(tmp).length
    const { result } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    expect(result.message).toContain(live.id.slice(0, 8))
    // NOTHING was created — not a fresh row, and certainly not a second resumed one.
    expect(store.listNonTerminalByRepo(tmp).length).toBe(before)
  })

  test('A REFUSED dispatch emits NO seed line — a retry that never happened is not reported', async () => {
    // THE ORDERING DEFECT (adversarial review, P3). The line used to be emitted before
    // the plan-doc await and before three refusal returns, so a dispatch that created no
    // row still logged `reason=resumed`: the one line an operator greps to find out what
    // a retry inherited, describing a retry that did not occur. It is now emitted after
    // the row exists and reads its values off that row.
    // RED-mutation: move the `log.info('dispatch_resume_seed', …)` block back above the
    // `createIfClaimsAvailable` call and this assertion fails — the refusal below has a
    // perfectly seedable prior, so the early line would say `resumed`.
    const prior = await priorRun({ task_iteration: 4 })
    // …and something live holds the branch, so the dispatch is refused outright.
    const live = await store.create({
      slug: `${slugifyTask(TASK)}`, project_slug: 'proj-1', repo_path: tmp,
      task: 'a competing lane', branch: BRANCH, execution_strategy: 'task_sequence',
      id: 'live-holder-no-log',
    })
    await store.update(live.id, { phase: 'task-build' })
    cardLink = prior.id

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    // NO ROW, THEREFORE NO SEED LINE. Silence here is the honest answer: nothing
    // inherited anything, because nothing was created.
    expect(seedLine).toBeNull()
  })

  test('a PATH-CLAIM refusal — past the seed decision, still no row and still no line', async () => {
    // THE ARM THE BRANCH-LIVENESS TEST ABOVE CANNOT REACH, and the one the ordering
    // defect actually lived on. The old log position sat after the seed ladder but
    // BEFORE the file-contention block and its plan-doc await, so a dispatch refused by
    // a PATH claim — which happens inside the create transaction, after that point —
    // logged `reason=resumed` for a row that was never written.
    // RED-mutation: move the `log.info('dispatch_resume_seed', …)` block back to just
    // before `let createdRunId` and this assertion fails.
    const PATHY = 'edit trident/budget-carry.ts and keep the importer regression suite green'
    const prior = await priorRun({ task: PATHY, task_iteration: 4 })
    cardLink = prior.id
    // A live run in ANOTHER lane (different slug, different branch, so neither the
    // branch-liveness gate nor the slug index fires) that already claims this path.
    const holder = await store.create({
      slug: 'some-other-lane', project_slug: 'proj-1', repo_path: tmp,
      task: 'another lane', branch: 'trident/some-other-lane',
      claimed_paths: ['trident/budget-carry.ts'],
    })
    await store.update(holder.id, { phase: 'forge-init' })

    const { result, seedLine } = await dispatchRecording(async () => HEAD, { task: PATHY })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('held')
    expect(seedLine).toBeNull()
  })

  test('a run that goes live DURING the tip probe is still refused — by the store claim path', async () => {
    // THE RACE THE PRE-GATE CANNOT WIN: it reads the live rows, then awaits the
    // branch-tip probe. A competing lane that binds this branch inside that window is
    // invisible to it, and lands on `createIfClaimsAvailable`, which re-takes the same
    // liveness fact INSIDE the INSERT's transaction (the live-only unique index,
    // migration 0120/0138). The seeded resume uses that same chokepoint, so it cannot
    // slip past it. RED-mutation: drop the `liveBranchOrSlugHolder` check from
    // `createIfClaimsAvailable` and the insert either succeeds or surfaces as a raw
    // UNIQUE constraint failure (`backend_error`), queueing nothing.
    const prior = await priorRun({ task_iteration: 4 })
    let racer: TridentRun | null = null

    const { result } = await dispatchRecording(async () => {
      // Inside the await the pre-gate already cleared: bind the branch now.
      racer = await store.create({
        slug: `${slugifyTask(TASK)}-racer`,
        project_slug: 'proj-1',
        repo_path: tmp,
        task: 'a competing lane that won the branch',
        branch: BRANCH,
      })
      await store.update(racer.id, { phase: 'task-build' })
      return HEAD
    })

    expect(racer).not.toBeNull()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('branch_live')
    // Exactly the racer is live; the resumed row was never written.
    expect(store.listNonTerminalByRepo(tmp).map((r) => r.id)).toEqual([racer!.id])
    expect(store.get(prior.id)!.phase).toBe('failed')
  })
})

describe('THE LAUNCHER-CRASH RELAUNCH IS A DIFFERENT PATH, AND IS UNCHANGED', () => {
  test('a crashed launcher is relaunched on the SAME row, spending no round and creating nothing', async () => {
    // Conflating the two paths is the trap this card sits next to. A crash relaunch
    // already carries checkpoint + branch + PR, and it does so by re-firing the
    // EXISTING row — it never calls `create`, so nothing in #519 can reach it. Pinned
    // here so that stays true: `store.create` is counted, and it must be zero.
    // RED-mutation: route the crash recovery through a new `create` (a "re-dispatch"
    // instead of a continuation) and both the create count and the round assertion
    // fail — a launcher crash would start spending the agent's Task budget.
    const run = await store.create({
      id: 'crash-1',
      slug: 'crashed-card',
      project_slug: 'proj-1',
      repo_path: tmp,
      task: 'build',
      execution_strategy: 'task_sequence',
    })
    await store.update(run.id, {
      phase: 'task-build',
      branch: 'trident/crashed-card',
      pr: 61,
      inner_checkpoint: 'task-built',
      round: 2,
      task_iteration: 3,
      subagent_run_id: 'wf-1',
      subagent_status: 'running',
      workflow_run_id: 'gen-dead',
    })
    await store.crashRunningByLauncher('gen-dead', 'inner workflow child crashed: pooled child exited')

    let creates = 0
    const realCreate = store.create.bind(store)
    store.create = async (input) => {
      creates += 1
      return realCreate(input)
    }
    const seen: InnerLoopInput[] = []
    const orch = buildTridentOrchestrator({
      fire_workflow: (async (input: InnerLoopInput) => {
        seen.push(input)
        return { status: 'fired' as const, launcher_session_key: 'gen-healthy' }
      }) as never,
      db_path: join(tmp, 'project.db'),
      run_host: honourDiffOutput(async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 })),
      base_branch: 'main',
      begin_crash_recovery: (id) => store.beginCrashRecovery(id),
    })
    await new TridentTickLoop({ store, step: orch.step }).runOnce()

    expect(creates).toBe(0) // the continuation path writes no new row at all
    expect(seen.length).toBe(1)
    expect(seen[0]?.resume_checkpoint).toBe('task-built')
    expect(seen[0]?.run.branch).toBe('trident/crashed-card')
    expect(seen[0]?.run.pr).toBe(61)
    // A launcher crash is not the AGENT's failure — it spends neither counter.
    const after = store.get(run.id)!
    expect(after.round).toBe(2)
    expect(after.task_iteration).toBe(3)
    expect(after.crash_recoveries).toBe(1)
    // …and the workflow is told the TRUE round, which is what the plan-refresh
    // cadence reads. This is the property a re-dispatch now shares with it.
    expect(seen[0]?.run.task_iteration).toBe(3)
  })
})

describe('the write site refuses a carried round it should never have been offered', () => {
  test('both selected strategies carry budget without inventing an allowance', async () => {
    for (const strategy of ['single', 'task_sequence'] as const) {
      const run = await store.create({ slug: strategy, project_slug: 'proj-1', repo_path: tmp,
        task: 'x', execution_strategy: strategy, task_iteration: 4, max_task_iterations: 20 })
      expect(run.task_iteration).toBe(4)
    }
  })

  test('a round with NO CAP NAMED is refused — the bound is a pair, not a counter', async () => {
    // THE MEASURED DEFECT (round 2 BLOCKER). `create` supplies
    // DEFAULT_MAX_TASK_ITERATIONS when the caller names no cap, so a row carrying a spent
    // round but no cap silently RAISES the bound of any card that had a tighter one: a
    // prior at 5/5 became 5/20, and `5 + 1 > 20` authorises fifteen more iterations.
    // RED-mutation: delete the `input.max_task_iterations === undefined` arm and the row
    // below is created at 5/20 — the exact shape the blocker measured.
    await expect(
      store.create({
        slug: 'no-cap', project_slug: 'proj-1', repo_path: tmp, task: 'x',
        execution_strategy: 'task_sequence', task_iteration: 5,
      }),
    ).rejects.toThrow(TridentUnboundedCarriedRoundError)
    // POSITIVE CONTROL: name the cap and it is accepted, at the value named.
    const paired = await store.create({
      slug: 'paired', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', task_iteration: 5, max_task_iterations: 8,
    })
    expect({ round: paired.task_iteration, cap: paired.max_task_iterations }).toEqual({ round: 5, cap: 8 })
  })

  test('a carried round needs NO seeded checkpoint — a rebuilt card has still spent it', async () => {
    // THE RULE THAT WAS REMOVED, and why (adversarial review, P2). An earlier revision
    // refused a round on a row with no `inner_checkpoint`, reasoning that a fresh build
    // has spent no iterations. But the row produced when a card's spec doc is edited
    // past the slug's 35th character is exactly that: the COMMIT is refused (the text
    // no longer matches) while the CARD has still spent those iterations. A rebuild
    // does not un-spend them, and charging them is the tightening direction.
    // RED-mutation: reinstate the `seededCheckpoint === ''` refusal and the
    // edited-spec-doc dispatch above fails outright instead of keeping its budget.
    const unseeded = await store.create({
      slug: 'unseeded-budget', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', task_iteration: 6, max_task_iterations: 20,
    })
    expect(unseeded.inner_checkpoint).toBeNull()
    expect(unseeded.task_iteration).toBe(6)
  })

  test('a round at or past the cap is stored VERBATIM — not refused, not clamped', async () => {
    // WHY THE WRITE SITE MUST ACCEPT IT (cross-model review, BLOCKER 1). An earlier
    // revision threw `TridentUnusableTaskIterationError` here. Two things were wrong
    // with that. It made the producer's matching refusal necessary, and that refusal
    // fell back to a fresh row at 0 — handing an exhausted card its whole budget
    // back. And throwing would turn an exhausted card's dispatch into a
    // `backend_error` (HTTP 500, nothing queued) when the honest outcome is a row
    // that reviews the commit it adopted and refuses only a NEW iteration.
    // Clamping was no better: it manufactures budget out of a number nobody asked for.
    // RED-mutation: reinstate a cap check in `create` and these rejections come back.
    const full = {
      project_slug: 'proj-1', repo_path: tmp, task: 'x', execution_strategy: 'task_sequence' as const,
      inner_checkpoint: 'fix-round-3', inner_checkpoint_head: HEAD, base_sha: BASE,
    }
    const atCap = await store.create({ ...full, slug: 'at-cap', task_iteration: 5, max_task_iterations: 5 })
    expect(atCap.task_iteration).toBe(5)
    expect(store.get(atCap.id)!.task_iteration).toBe(5)
    const pastCap = await store.create({ ...full, slug: 'past-cap', task_iteration: 9, max_task_iterations: 5 })
    expect(pastCap.task_iteration).toBe(9) // verbatim: NOT clamped to 5
    // BOTH SIDES OF THE BOUND, so this cannot pass by storing everything wrong.
    const underCap = await store.create({ ...full, slug: 'under-cap', task_iteration: 4, max_task_iterations: 5 })
    expect(underCap.task_iteration).toBe(4)
    // …and the cap bites on the rows that are at or past it, not on the one below.
    expect(computeTransition({ ...atCap, phase: 'task-build' }, {}).phase).toBe('failed')
    expect(computeTransition({ ...pastCap, phase: 'task-build' }, {}).phase).toBe('failed')
    expect(computeTransition({ ...underCap, phase: 'task-build' }, {}).phase).toBe('task-plan')
  })

  test('a garbled round is REFUSED, never normalised to 0', async () => {
    // THE TEST THAT USED TO BLESS DEFECT FOUR. It asserted that every unreadable counter
    // became `0` "rather than failing the dispatch" — and `0` is the most permissive
    // answer available, because a row at `{ 0, 20 }` is authorised for the entire budget
    // (`0 + 1 > 20` is false). So malformed persisted data restored exactly the budget
    // this change exists to preserve, and a test called it correct.
    //
    // There is no normalisation of a counter that is not MORE permissive than the truth,
    // so there is none. ABSENT still means 0 — a caller that named no counter is a fresh
    // row — and zero itself is valid.
    // RED-mutation: restore `carryableTaskIteration` to `… ? round : 0` and every rejection
    // below stops.
    for (const bad of [-3, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, '4', {}]) {
      await expect(
        store.create({
          slug: `garbled-${String(bad)}`, project_slug: 'proj-1', repo_path: tmp, task: 'x',
          execution_strategy: 'task_sequence', max_task_iterations: 20, task_iteration: bad as unknown as number,
        }),
      ).rejects.toThrow(TridentInvalidTaskIterationError)
    }
    // ABSENT is absent: no counter named → 0, exactly as before this existed.
    const absent = await store.create({
      slug: 'round-absent', project_slug: 'proj-1', repo_path: tmp, task: 'x', execution_strategy: 'task_sequence',
    })
    expect(absent.task_iteration).toBe(0)
    // …and an explicit ZERO is valid, not refused — the control that stops this test from
    // passing by rejecting everything.
    const zero = await store.create({
      slug: 'round-zero', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      execution_strategy: 'task_sequence', task_iteration: 0, max_task_iterations: 20,
    })
    expect(zero.task_iteration).toBe(0)
  })
})
