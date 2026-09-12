/**
 * A RE-DISPATCH OF A MID-BUDGET RUN KEEPS ITS RALPH COUNT (#519).
 *
 * WHAT THIS CLOSES, exactly. A governed run that died at `fix-round-N` or
 * `outer-published:*` with iterations LEFT used to be re-dispatched onto a row at
 * `ralph_round: 0`. Two readers make that a real loss for that run:
 * `refireNextRalphTask` (orchestrator.ts) bounds its remaining loop on
 * `nextRalphRound > run.max_ralph_rounds`, and `buildWorkflowArgs` (inner-loop.ts)
 * threads the counter to the inner workflow as `ralphRound`, where the plan-refresh
 * cadence reads `ralphRound % PLAN_REFRESH_EVERY` — so the periodic full re-plan
 * landed on the wrong iteration of the same piece of work. The count and its cap now
 * travel together.
 *
 * WHAT THIS DOES *NOT* CLOSE, pinned as a test rather than left in prose (see
 * "THE LIMIT" below). It does NOT make `max_ralph_rounds` a bound on the CARD. A run
 * that EXHAUSTS the loop dies with `inner_checkpoint = 'ralph-task-built'`
 * (`refireNextRalphTask`'s cap branch goes through `failedRun`, which does not touch
 * the checkpoint), that name is not review-capable, so the exhausted row classifies
 * `died-before-build` and seeds NOTHING — the next dispatch is a fresh build with a
 * fresh budget. Pressing ▶ repeatedly still buys iterations; it now costs one
 * exhaustion cycle per press instead of none. The row is recreated by every dispatch,
 * so any per-row counter is one reset away by construction; holding the spend on the
 * CARD is the durable fix and is a different change.
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
  TridentInvalidRalphCapError,
  TridentInvalidRalphRoundError,
  TridentUnboundedCarriedRoundError,
  TridentUngovernedRalphRoundError,
  type MergeMode,
  type TridentRun,
} from './store.ts'
import { carriedRalphCap, carryableRalphRound, DEFAULT_MAX_RALPH_ROUNDS } from './ralph-budget.ts'
import { computeTransition } from './state-machine.ts'
import { buildTridentOrchestrator } from './orchestrator.ts'
import { TridentTickLoop } from './tick.ts'
import { buildWorkflowArgs, type InnerLoopInput } from './inner-loop.ts'
import { slugifyTask } from './slugify-task.ts'

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
 * refuses a bare `forge-done` under ralph (the workflow rebuilds it —
 * 'ralph-progress-unknown'), so `forge-done` could never exercise the carried round
 * at all. `fix-round-N` routes to review in BOTH modes.
 */
async function priorRun(
  over: {
    task?: string
    ralph?: boolean
    ralph_round?: number
    max_ralph_rounds?: number
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
    ralph: over.ralph ?? true,
    ...(over.max_ralph_rounds === undefined ? {} : { max_ralph_rounds: over.max_ralph_rounds }),
  })
  await store.update(run.id, {
    phase: over.phase ?? 'failed',
    inner_checkpoint: over.checkpoint === undefined ? 'fix-round-3' : over.checkpoint,
    inner_checkpoint_head: HEAD,
    inner_verdict: 'REVIEW_NOT_RUN',
    base_sha: BASE,
    ralph_round: over.ralph_round ?? 4,
  })
  cardLink = run.id
  return store.get(run.id)!
}

function deps(over: Partial<BoardBoundBuildDeps> = {}): BoardBoundBuildDeps {
  return {
    store,
    board,
    project_slug: 'proj-1',
    repo_path: tmp,
    resolveBuildRepo: async () => tmp,
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => true,
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
 * LOG, and nobody looking at the board sees it. That half of the criterion is NOT
 * delivered and its box is deliberately unticked — `work_board_items` has no
 * free-text field and `TridentBoardBinder` is `get`/`attachRun`/reconcile, so there
 * is no board surface to write to. These assertions pin the log because the log is
 * what exists, not because it answers the criterion.
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

describe('a re-dispatch after a DEAD run resumes from its checkpoint AND its ralph round', () => {
  test('the carried round lands on the new row and is PERSISTED, alongside the checkpoint', async () => {
    // RED-mutation A: drop `ralph_round: seed.ralph_round` from the seeded spread in
    // board-dispatch.ts → the new row is born at 0 and the round assertions fail.
    // RED-mutation B: restore `ralph_round: 0` in `TridentRunStore.create` → same,
    // one layer down, which is why both layers are asserted.
    const prior = await priorRun({ ralph_round: 4 })
    expect(prior.ralph_round).toBe(4) // precondition, asserted not assumed

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.id).not.toBe(prior.id) // a NEW row — this is not the crash path
    expect(result.run.ralph_round).toBe(4)
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    // Round 3's work, not round 1 over again (the checkpoint half, already landed —
    // pinned here so the two halves cannot drift apart).
    expect(result.run.round).toBe(3)
    expect(result.run.base_sha).toBe(BASE)
    // PERSISTED, not merely returned: `launch()` and `refireNextRalphTask` both read
    // the ROW, never this object.
    const stored = store.get(result.run.id)!
    expect(stored.ralph_round).toBe(4)
    expect(stored.inner_checkpoint).toBe('fix-round-3')
    // AND IT SAYS SO, naming the prior run whose continuity was adopted.
    expect(seedLine).toContain('reason=resumed')
    expect(seedLine).toContain('ralph_round=4')
    expect(seedLine).toContain(`prior_run_id=${prior.id}`)
  })

  test('A CHAIN of mid-budget re-dispatches keeps accumulating, never restarting', async () => {
    // Each link in the chain inherits the spend of the one before it, so a card that
    // dies mid-budget twice has spent both times. This is NOT the same as bounding the
    // card — see THE LIMIT below for the case that still resets — it is the property
    // that the counter survives a re-dispatch at all, for as long as the runs keep
    // dying on a review-capable checkpoint.
    // RED-mutation: the same as A above; the chain collapses to 0 at every link.
    await priorRun({ ralph_round: 4 })

    const first = await dispatchRecording(async () => HEAD)
    expect(first.result.ok).toBe(true)
    if (!first.result.ok) return
    expect(first.result.run.ralph_round).toBe(4)

    // Terminalize it where it stands, exactly as the reconcile would, and re-dispatch.
    await store.update(first.result.run.id, {
      phase: 'failed',
      inner_checkpoint: 'fix-round-5',
      inner_checkpoint_head: HEAD,
      inner_verdict: 'REVIEW_NOT_RUN',
      base_sha: BASE,
      ralph_round: 6,
    })
    cardLink = first.result.run.id

    const second = await dispatchRecording(async () => HEAD)
    expect(second.result.ok).toBe(true)
    if (!second.result.ok) return
    expect(second.result.run.ralph_round).toBe(6)
    expect(second.result.run.inner_checkpoint).toBe('fix-round-5')
  })

  test('WIRING: the launcher threads the carried round into the workflow args', async () => {
    // WHAT THIS ASSERTS AND WHAT IT DOES NOT (adversarial review, P2). It asserts the
    // WIRING: the counter written on the row is what `buildWorkflowArgs` hands the
    // inner workflow as `ralphRound`, so the carry is not a column nothing reads.
    //
    // It does NOT show that any planner was skipped, and the "planning tokens are not
    // re-spent" acceptance box is UNTICKED because of that. The cadence gate
    // (`inner-workflow.mjs`, `cleanContinuation`) requires `resumeCheckpoint ===
    // 'ralph-task-built'` AND `ralphRound >= 1` AND `% PLAN_REFRESH_EVERY !== 0` — and
    // this change deliberately never resumes `ralph-task-built` (it is
    // `died-before-build`). So for every shape this change DOES resume, the full
    // `plan:fable` survey runs exactly as it did before; the carried round only
    // matters for the resumed run's own LATER iterations, whose cadence
    // `inner-workflow-plan-next.test.ts` already pins at rounds 1-4 versus 5 and 10.
    // Asserting an input to a gate no test here drives would be a proxy, and this
    // docblock exists so nobody mistakes it for more.
    // RED-mutation: mutation A or B — the args carry 0 and the assertion fails.
    await priorRun({ ralph_round: 4 })

    const { result } = await dispatchRecording(async () => HEAD)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const args = buildWorkflowArgs({
      run: store.get(result.run.id)!,
      base_branch: 'main',
      max_rounds: 10,
      db_path: join(tmp, 'project.db'),
    } as unknown as InnerLoopInput)
    expect(args['ralphRound']).toBe(4)
    expect(args['ralph']).toBe(true)
  })

  test('LOCAL merge-mode is covered — the proof is the local ref, and no PR probe is involved', async () => {
    // THE CASE THE FIRE-TIME `detectExistingPr` PROBE CANNOT SERVE. That probe asks
    // GitHub for the branch's open PRs, which in `local` mode (no origin, no `gh`)
    // silently answers nothing — so a resume that depended on it degraded to zero
    // here and a test written only in `pr` mode would pass with the defect present.
    // This resume depends on the DURABLE ROW plus a `rev-parse` of the local ref, so
    // it is mode-independent. RED-mutation: mutation A again — in `local` mode there
    // is nothing else left to carry continuity, so the row comes back bare.
    await priorRun({ ralph_round: 4 })

    const { result, modes, seedLine } = await dispatchRecording(async () => HEAD, {
      resolveMergeMode: async () => 'local',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The proof was taken in LOCAL mode — the local ref, not `ls-remote`.
    expect(modes).toEqual(['local'])
    expect(result.run.merge_mode).toBe('local')
    expect(result.run.ralph_round).toBe(4)
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    // The PR is NOT inherited in either mode: `launch()` asks which PRs are OPEN.
    expect(result.run.pr).toBeNull()
    expect(seedLine).toContain('reason=resumed')
  })

  test('PR merge-mode carries the same two columns — the fix is not local-only', async () => {
    // The positive control for the case above: if the assertions there were passing
    // because `local` had been special-cased, this would red.
    await priorRun({ ralph_round: 7 })

    const { result, modes } = await dispatchRecording(async () => HEAD, {
      resolveMergeMode: async () => 'pr',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(modes).toEqual(['pr'])
    expect(result.run.ralph_round).toBe(7)
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
    expect(result.run.ralph_round).toBe(0)
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
    await priorRun({ ralph_round: 4 })

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
    expect(result.run.ralph_round).toBe(4)
    expect(store.get(result.run.id)!.ralph_round).toBe(4)
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
      await priorRun({ task, ralph_round: 4 })
      const { result, seedLine } = await dispatchRecording(tip, { task })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect({ name, cp: result.run.inner_checkpoint }).toEqual({ name, cp: null })
      expect(seedLine).toContain('reason=branch_tip_unreadable_or_absent')
      // The spend still travels — same reasoning as the moved-tip case above.
      expect({ name, round: result.run.ralph_round }).toEqual({ name, round: 4 })
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
    // `ralph-task-built` has a commit behind it but `resumeOnUnchangedHead` rebuilds it
    // by design; a `stopped` run is work the OWNER discarded; a null checkpoint built
    // nothing. None of them hands a commit forward.
    // RED-mutation: carry `prior.inner_checkpoint` outside the `candidate !== null` arm
    // and a row is seeded with a checkpoint the workflow will not review.
    for (const [name, task, over] of [
      ['ralph-task-built', 'handoff card — rebuild the importer', { checkpoint: 'ralph-task-built' as const }],
      ['a STOPPED prior', 'stopped card — rebuild the importer', { phase: 'stopped' as const }],
      ['no checkpoint at all', 'no checkpoint card — rebuild the importer', { checkpoint: null }],
    ] as const) {
      cardLink = null
      await priorRun({ task, ralph_round: 4, ...over })
      const { result, seedLine } = await dispatchRecording(async () => HEAD, { task })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect({ name, cp: result.run.inner_checkpoint }).toEqual({ name, cp: null })
      expect(seedLine).toContain('reason=prior_run_has_no_resumable_build')
      // AND THE SPEND TRAVELS ANYWAY. This arm matters most: the Ralph loop's own
      // exhaustion path parks on `ralph-task-built`, so a budget gated on the commit
      // seed would give the one shape that can actually exhaust a card the one thing it
      // must not get — a fresh budget. See THE LIMIT below.
      expect({ name, round: result.run.ralph_round }).toEqual({ name, round: 4 })
    }
  })

  test('A CARD THAT DOES NOT NAME THE RUN gets neither the checkpoint nor the round', async () => {
    // Task text is a PROXY for identity and two cards can carry the same text; the
    // board link is the real one. Its absence already refuses the checkpoint — this
    // pins that the round cannot arrive by a different door.
    // RED-mutation: let an absent/mismatched link fall back to the task text alone and
    // a card that cannot show it owns the run inherits its budget position.
    const prior = await priorRun({ ralph_round: 4 })
    cardLink = 'some-other-run'

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.ralph_round).toBe(0)
    expect(result.run.inner_checkpoint).toBeNull()
    expect(seedLine).toContain('reason=card_names_a_different_run')
    expect(seedLine).toContain(`prior_run_id=${prior.id}`)

    // POSITIVE CONTROL — a SEPARATE card (its own slug, so its own branch and its own
    // prior row) with the same prior shape and the same tip, whose link is present: it
    // resumes. Without it the assertions above would pass on a seed that had simply
    // stopped working. It cannot reuse the card above: that dispatch left a live row
    // on this branch, which the liveness gate would refuse before any seed is read.
    const CONTROL = 'linked control card — rebuild the importer'
    const controlPrior = await priorRun({ task: CONTROL, ralph_round: 4 })
    cardLink = controlPrior.id
    const control = await dispatchRecording(async () => HEAD, { task: CONTROL })
    expect(control.result.ok).toBe(true)
    if (!control.result.ok) return
    expect(control.result.run.ralph_round).toBe(4)
    expect(control.result.run.inner_checkpoint).toBe('fix-round-3')
  })

  test('a prior that spent its whole budget ON A REVIEW-CAPABLE CHECKPOINT stays exhausted', async () => {
    // THE BEHAVIOUR THIS TEST USED TO ASSERT AS CORRECT (cross-model review,
    // BLOCKER 1). It created a prior at the cap and asserted the resumed row came
    // back at `ralph_round: 0` with `max_ralph_rounds: 20` — a FULL budget. Trace it
    // forward: the next Ralph handoff computes `nextRalphRound = 1`, the only refusal
    // is `nextRalphRound > run.max_ralph_rounds`, and `1 > 20` is false — so another
    // iteration is authorised, and the nineteen after it. Re-dispatching a card AT
    // its cap restored the whole budget, which is the unbounded-retry defect this
    // change exists to close, and the test was blessing it.
    //
    // A refusal to carry has to be a refusal, not a reset. So the round travels
    // verbatim and the cap bites on the row that inherits it.
    //
    // THE SHAPE MATTERS AND IS NARROW: this is a run parked on `fix-round-3` that
    // happens to have spent every iteration. A run that actually exhausted the Ralph
    // LOOP dies on `ralph-task-built` and seeds nothing at all — see THE LIMIT.
    // RED-mutation: restore the `round < max` conjunct in `carryableRalphRound` and
    // this row comes back at 0 with a fresh budget — every assertion below fails.
    await priorRun({ ralph_round: DEFAULT_MAX_RALPH_ROUNDS, max_ralph_rounds: DEFAULT_MAX_RALPH_ROUNDS })

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The commit still travels — it is real and still on the branch.
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    // AND SO DOES THE SPENT BUDGET.
    expect(result.run.ralph_round).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(result.run.max_ralph_rounds).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(store.get(result.run.id)!.ralph_round).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(seedLine).toContain('reason=resumed')
    expect(seedLine).toContain(`ralph_round=${DEFAULT_MAX_RALPH_ROUNDS}`)

    // THE FORWARD TRACE, on the row the real dispatch actually produced. A NEW Ralph
    // iteration is refused, loudly, naming the cap — `computeTransition` is the state
    // machine's single ralph-counter site and `refireNextRalphTask` (orchestrator.ts)
    // applies the identical `+1 > max` test on the same two columns.
    const exhausted = computeTransition({ ...store.get(result.run.id)!, phase: 'ralph-task' }, {})
    expect(exhausted.phase).toBe('failed')
    expect(exhausted.failure_reason).toContain('max_ralph_rounds')
  })

  test('ONE BELOW THE CAP still has its re-fire — the bound bites at the cap, not before it', async () => {
    // The other side of the bound, so the test above cannot pass by refusing every
    // iteration. A card that had spent 19 of 20 resumes with 19 and gets its
    // twentieth; it is the twenty-first that is refused.
    // RED-mutation: make the carry unconditional AND off-by-one (carry `round + 1`)
    // and this row is already exhausted a round early.
    await priorRun({
      ralph_round: DEFAULT_MAX_RALPH_ROUNDS - 1,
      max_ralph_rounds: DEFAULT_MAX_RALPH_ROUNDS,
    })

    const { result } = await dispatchRecording(async () => HEAD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.ralph_round).toBe(DEFAULT_MAX_RALPH_ROUNDS - 1)

    const oneLeft = computeTransition({ ...store.get(result.run.id)!, phase: 'ralph-task' }, {})
    expect(oneLeft.phase).toBe('ralph-plan')
    expect(oneLeft.ralph_round).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(oneLeft.failure_reason).toBeNull()
  })

  test('A NON-GOVERNED re-dispatch carries no round, even from a governed prior', async () => {
    // A Ralph iteration count means nothing on a row that will not run a Ralph loop.
    // RED-mutation: drop the `opts.ralph !== true` arm of `carriedRalphRound` and a
    // plain build is born mid-budget.
    await priorRun({ ralph_round: 4 })

    const { result } = await dispatchRecording(async () => HEAD, { resolveRalph: async () => false })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.ralph).toBe(false)
    expect(result.run.ralph_round).toBe(0)
    // The checkpoint still travels: `fix-round-N` routes to review in both modes.
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
  })
})

describe('THE CAP TRAVELS WITH THE ROUND — a re-dispatch may tighten the budget, never loosen it', () => {
  // NO TEST ANYWHERE SET `deps.max_ralph_rounds` (adversarial review, P3: the mutant
  // that replaced `deps.max_ralph_rounds ?? DEFAULT_MAX_RALPH_ROUNDS` with
  // `prior.max_ralph_rounds` survived the whole suite). It is threaded in production
  // from `code-command.ts`, so a cap lowered between two attempts is a live path. Every
  // test below sets it explicitly, and the prior row's cap differs from BOTH the
  // default and the dispatch's value so the three cannot be confused.

  test('a TIGHTER prior cap survives a dispatch carrying the ambient default', async () => {
    // THE MEASURED DEFECT (round 2 BLOCKER): prior 5/5 + no explicit cap → 5/20, and
    // `5 + 1 > 20` is false, so a card someone deliberately capped at 5 got twenty.
    // RED-mutation: drop the `...(budget !== null ? { max_ralph_rounds } : {})` half of
    // the create call and the row is born at cap 20.
    await priorRun({ ralph_round: 5, max_ralph_rounds: 5 })

    const { result } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.ralph_round, cap: result.run.max_ralph_rounds }).toEqual({
      round: 5,
      cap: 5,
    })
    // AND THE CAP BITES: a card at 5/5 gets no further iteration.
    expect(computeTransition({ ...store.get(result.run.id)!, phase: 'ralph-task' }, {}).phase).toBe(
      'failed',
    )
  })

  test('a cap LOWERED in configuration since the prior run applies immediately', async () => {
    // Tightening is always safe, so a config cut reaches a resumed card. Prior cap 20,
    // dispatch cap 5, carried round 4 → 4/5.
    // RED-mutation: pass `prior.max_ralph_rounds` instead of `deps.max_ralph_rounds` as
    // the ceiling — the exact mutant that survived — and the cap comes back 20.
    await priorRun({ ralph_round: 4, max_ralph_rounds: 20 })

    const { result } = await dispatchRecording(async () => HEAD, { max_ralph_rounds: 5 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.ralph_round, cap: result.run.max_ralph_rounds }).toEqual({
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
    await priorRun({ ralph_round: 5, max_ralph_rounds: 6 })

    const { result } = await dispatchRecording(async () => HEAD, { max_ralph_rounds: 30 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.ralph_round, cap: result.run.max_ralph_rounds }).toEqual({
      round: 5,
      cap: 6,
    })
  })

  test('an UNSEEDED dispatch still takes the configured cap, byte-identically', async () => {
    // The negative control for the three above: with no prior to inherit from, the
    // dispatch's own cap is written exactly as it was before any of this existed.
    // RED-mutation: make `effectiveMaxRalphRounds` prefer the carried value
    // unconditionally and this row loses its configured cap.
    const { result } = await dispatchRecording(async () => HEAD, { max_ralph_rounds: 7 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.ralph_round, cap: result.run.max_ralph_rounds }).toEqual({
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
   * at `{ ralph_round: NaN, max_ralph_rounds: 20 }` produced `{ 0, 20 }`, and
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
    expect(carryableRalphRound(0)).toBe(0)
    expect(carryableRalphRound(1)).toBe(1)
    expect(carryableRalphRound(19)).toBe(19)
    // ABSENT is absent — the only case that answers 0 without being 0.
    expect(carryableRalphRound(undefined)).toBe(0)
    expect(carryableRalphRound(null)).toBe(0)
    // PRESENT BUT UNREADABLE answers null, which callers must treat as a refusal.
    for (const bad of [-1, -20, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, 2 ** 53 + 2, '4', {}, true]) {
      expect({ bad, round: carryableRalphRound(bad) }).toEqual({ bad, round: null })
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
    // RED-mutation: make `carriedRalphBudget` return `{ ok: true, budget: null }` for an
    // unreadable counter and each dispatch below succeeds at `ralph_round: 0` with a full
    // budget: defect four, exactly.
    for (const bad of [-1, -20, 2 ** 53]) {
      cardLink = null
      const task = `corrupt round ${String(bad)} — rebuild the importer`
      const prior = await priorRun({ task, ralph_round: 4 })
      // Corrupt the persisted counter the way a bad writer would.
      db.raw().run('UPDATE code_trident_runs SET ralph_round = ? WHERE id = ?', [bad, prior.id])
      const before = store.listNonTerminalByRepo(tmp).length

      const { result } = await dispatchRecording(async () => HEAD, { task })

      expect({ bad, ok: result.ok }).toEqual({ bad, ok: false })
      if (result.ok) return
      expect({ bad, code: result.code }).toEqual({ bad, code: 'backend_error' })
      // The message names the run and the column, so the repair is a one-line UPDATE.
      expect(result.message).toContain('ralph_round')
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
    // RED-mutation: restore `carryableRalphRound`'s `… ? round : 0` and each of these
    // dispatches succeeds at `ralph_round: 0` with a full budget.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.5, -0.5]) {
      cardLink = null
      const task = `in-memory corrupt ${String(bad)} — rebuild the importer`
      const prior = await priorRun({ task, ralph_round: 4 })
      const corrupting = Object.create(store) as TridentRunStore
      const real = store.latestTerminalBySlug.bind(store)
      ;(corrupting as unknown as Record<string, unknown>)['latestTerminalBySlug'] = (
        project: string,
        slug: string,
      ) => {
        const row = real(project, slug)
        return row === null ? null : { ...row, ralph_round: bad as unknown as number }
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
      expect(result.message).toContain('ralph_round')
      expect(result.message).toContain(prior.id)
      // The refusal is not silent either — same discipline as the branch-liveness gate.
      expect(lines.some((l) => l.includes('event=dispatch_budget_unreadable'))).toBe(true)
    }

    // THE ADJACENT HONOURED VALUE, through the identical seam: a readable counter of 4
    // dispatches. Without this the loop above is satisfied by a store proxy that breaks
    // every dispatch, or by a refusal that fires on anything at all.
    cardLink = null
    const okTask = 'in-memory readable counter — rebuild the importer'
    await priorRun({ task: okTask, ralph_round: 4 })
    const passthrough = Object.create(store) as TridentRunStore
    const control = await dispatchBoardBoundBuild(
      { task: okTask, board_item_id: 'ready' },
      deps({ store: passthrough, readBranchTip: async () => HEAD }),
    )
    expect(control.ok).toBe(true)
    if (!control.ok) return
    expect(control.run.ralph_round).toBe(4)
  })

  test('DISPATCH: a corrupt prior CAP refuses too — the pair is refused as a pair', async () => {
    // The cap half of the same rule. An unreadable cap cannot degrade to "carry nothing"
    // either, because that discards a spend that may already be exhausted.
    // RED-mutation: drop the `isRalphCap(run.max_ralph_rounds)` arm and this dispatch
    // succeeds with a fresh budget.
    const task = 'corrupt cap card — rebuild the importer'
    const prior = await priorRun({ task, ralph_round: 12 })
    db.raw().run('UPDATE code_trident_runs SET max_ralph_rounds = ? WHERE id = ?', [-4, prior.id])

    const { result } = await dispatchRecording(async () => HEAD, { task })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('backend_error')
    expect(result.message).toContain('max_ralph_rounds')
  })

  test('DISPATCH: the ADJACENT SAFE value is honoured — the guard is not "refuse anything large"', async () => {
    // "WHAT INPUT WOULD A WRONG IMPLEMENTATION GET RIGHT?" A test that feeds `2**53` and
    // asserts a refusal is satisfied by a function that refuses everything, so the
    // refusal is paired with the value one step below it, which MUST still be honoured.
    // `Number.MAX_SAFE_INTEGER` is `2**53 - 1`: the largest counter this repo can read.
    // RED-mutation: widen the refusal to `>= 2**53 - 1` (an off-by-one on the boundary)
    // and this legitimate dispatch is refused as corrupt.
    const task = 'max safe counter card — rebuild the importer'
    const prior = await priorRun({ task, ralph_round: 4, max_ralph_rounds: 20 })
    db.raw().run('UPDATE code_trident_runs SET ralph_round = ? WHERE id = ?', [
      Number.MAX_SAFE_INTEGER,
      prior.id,
    ])
    // Precondition, measured rather than assumed: sqlite really did store it, and it
    // really is the value on the readable side of the boundary.
    expect(store.get(prior.id)!.ralph_round).toBe(Number.MAX_SAFE_INTEGER)
    expect(Number.isSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(Number.isSafeInteger(2 ** 53)).toBe(false)

    const { result } = await dispatchRecording(async () => HEAD, { task })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.ralph_round).toBe(Number.MAX_SAFE_INTEGER)
    // …and the cap still tightens to the prior row's, so the card is exhausted rather
    // than authorised — the counter being readable does not make it spendable.
    expect(result.run.max_ralph_rounds).toBe(20)
    expect(computeTransition({ ...store.get(result.run.id)!, phase: 'ralph-task' }, {}).phase).toBe(
      'failed',
    )
  })

  test('THE DEFAULT CAP IS PINNED TO ITS LITERAL, not merely to its own name', () => {
    // #575's lesson, one dimension over: an assertion written against a CONSTANT is blind
    // to the constant moving. Every `expect(cap).toBe(DEFAULT_MAX_RALPH_ROUNDS)` in this
    // file keeps passing if someone changes 20 to 200, which would silently multiply
    // every card's budget tenfold — the exact class of change this PR exists to prevent.
    // So the literal is pinned ONCE, here, and the symbolic assertions elsewhere then
    // mean what they say.
    // RED-mutation: change `DEFAULT_MAX_RALPH_ROUNDS` in ralph-budget.ts and only this
    // test reds — which is the point: the change becomes a deliberate diff, not a silent one.
    expect(DEFAULT_MAX_RALPH_ROUNDS).toBe(20)
    // And the arithmetic the cap participates in, against literals on both sides of the
    // bound rather than against the constant.
    expect(carriedRalphCap(30, undefined)).toBe(20)
    expect(carriedRalphCap(19, undefined)).toBe(19)
  })

  test('DISPATCH: a prior counter of ZERO is not corrupt — it dispatches and carries zero', async () => {
    // THE CONTROL, and the reason the two refusals above are not just "refuse on
    // anything unusual": zero is the fresh-row value and a perfectly ordinary counter.
    // RED-mutation: widen the counter domain to `>= 1` (the cap's original mistake) and
    // this legitimate dispatch is refused as corrupt.
    const task = 'zero counter card — rebuild the importer'
    await priorRun({ task, ralph_round: 0, max_ralph_rounds: 20 })

    const { result } = await dispatchRecording(async () => HEAD, { task })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.ralph_round, cap: result.run.max_ralph_rounds }).toEqual({
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
   * `carriedRalphCap(30, 0)` answered 20, so a dispatch asking for ZERO iterations
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
    expect(carriedRalphCap(30, 0)).toBe(0)
    expect(carriedRalphCap(0, 30)).toBe(0)
    expect(carriedRalphCap(0, 0)).toBe(0)
    // ABSENT is the ONLY case that gets the default — the control that stops this test
    // from passing by refusing everything.
    expect(carriedRalphCap(30, undefined)).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(carriedRalphCap(30, null)).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(carriedRalphCap(5, undefined)).toBe(5) // …and min() still applies to it
    // ORDINARY POSITIVES still take the tighter side, in both orders.
    expect(carriedRalphCap(30, 7)).toBe(7)
    expect(carriedRalphCap(7, 30)).toBe(7)
    // PRESENT BUT UNREADABLE carries NOTHING — never a substituted default. A `NaN` cap
    // is the worst of these: `round + 1 > NaN` is false forever, i.e. an unbounded loop.
    for (const bad of [-1, -20, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, '5', {}]) {
      expect({ bad, cap: carriedRalphCap(30, bad) }).toEqual({ bad, cap: null })
    }
    // …and an unreadable PRIOR cap carries nothing either: a round without the bound it
    // was spent against is the 5/20 shape this pair rule exists to prevent.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '5']) {
      expect({ bad, cap: carriedRalphCap(bad, 10) }).toEqual({ bad, cap: null })
    }
  })

  test('DISPATCH: an explicit cap of ZERO is written as zero, and the loop refuses the first iteration', async () => {
    // The dispatch-level half of the row above. A card capped at zero gets no Ralph
    // iterations — a coherent request — and it must not be quietly re-read as twenty.
    // RED-mutation: the same as the unit test's; the row comes back at cap 20 and the
    // `computeTransition` assertion flips to `ralph-plan`.
    await priorRun({ ralph_round: 5, max_ralph_rounds: 30 })

    const { result } = await dispatchRecording(async () => HEAD, { max_ralph_rounds: 0 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect({ round: result.run.ralph_round, cap: result.run.max_ralph_rounds }).toEqual({
      round: 5,
      cap: 0,
    })
    expect(store.get(result.run.id)!.max_ralph_rounds).toBe(0)
    const next = computeTransition({ ...store.get(result.run.id)!, phase: 'ralph-task' }, {})
    expect(next.phase).toBe('failed')
    expect(next.failure_reason).toContain('max_ralph_rounds')
  })

  test('DISPATCH: a prior capped at ZERO keeps that cap under a permissive dispatch', async () => {
    // The other side: the tighter value is the prior row's, and `min` must take it.
    // RED-mutation: return the dispatch ceiling instead of `min()` and the cap is 30.
    await priorRun({ ralph_round: 0, max_ralph_rounds: 0 })

    const { result } = await dispatchRecording(async () => HEAD, { max_ralph_rounds: 30 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.max_ralph_rounds).toBe(0)
  })

  test('DISPATCH: an INVALID cap is refused by name, never replaced with the default', async () => {
    // A config typo must not become the most permissive number in the file. `NaN` is the
    // one that matters most: `ralph_round + 1 > NaN` is false forever, so the loop would
    // be unbounded — the exact opposite of what a cap is for.
    // RED-mutation: delete the `isRalphCap` check in `create` and each of these
    // dispatches succeeds, writing an unchecked number into an INTEGER column.
    for (const bad of [Number.NaN, -5, 2.5, Number.POSITIVE_INFINITY]) {
      cardLink = null
      const task = `invalid cap ${String(bad)} — rebuild the importer`
      await priorRun({ task, ralph_round: 4 })
      const { result } = await dispatchRecording(async () => HEAD, { task, max_ralph_rounds: bad })
      expect({ bad, ok: result.ok }).toEqual({ bad, ok: false })
      if (result.ok) return
      expect({ bad, code: result.code }).toEqual({ bad, code: 'backend_error' })
      expect(result.message).toContain('max_ralph_rounds')
    }
  })

  test('STORE: zero is accepted, an unreadable cap is refused by name', async () => {
    // "Do not put the check only in the caller." The producer carries nothing for an
    // unreadable cap; this is the write site refusing the raw value it then sees.
    // RED-mutation: delete the `isRalphCap` guard and the rejections below stop.
    const zero = await store.create({
      slug: 'cap-zero', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, max_ralph_rounds: 0,
    })
    expect(zero.max_ralph_rounds).toBe(0)
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        store.create({
          slug: `cap-bad-${String(bad)}`, project_slug: 'proj-1', repo_path: tmp, task: 'x',
          ralph: true, max_ralph_rounds: bad,
        }),
      ).rejects.toThrow(TridentInvalidRalphCapError)
    }
    // ABSENT still takes the default — the control.
    const absent = await store.create({
      slug: 'cap-absent', project_slug: 'proj-1', repo_path: tmp, task: 'x', ralph: true,
    })
    expect(absent.max_ralph_rounds).toBe(DEFAULT_MAX_RALPH_ROUNDS)
  })

  test('NULL is ABSENT at the write site too — the producer and the store agree on it', async () => {
    // THE DIVERGENCE (adversarial review, item 4). `carriedRalphCap` treats `null` as
    // ABSENT while `create` treated it as INVALID, so one value meant two different things
    // in the two copies of a rule that `ralph-budget.ts`'s own docblock says the file
    // exists to keep identical — and `main` accepted a null cap, so this was also a
    // regression. The reachable path is a hold payload (`dispatch-holds.ts`
    // `parseJsonObject`, no field validation) forwarded on `!== undefined` and past a `??`
    // that does not filter null, ending in an HTTP 500 with the card not queued.
    // RED-mutation: `!== undefined` instead of `!= null` in `create` and this throws.
    const nulled = await store.create({
      slug: 'cap-null', project_slug: 'proj-1', repo_path: tmp, task: 'x', ralph: true,
      max_ralph_rounds: null as unknown as number,
    })
    expect(nulled.max_ralph_rounds).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    // BOTH COPIES, read against each other rather than each against itself — which is the
    // only way a divergence between them is observable.
    expect(carriedRalphCap(30, null)).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(carriedRalphCap(30, undefined)).toBe(DEFAULT_MAX_RALPH_ROUNDS)
  })

  test('a NULL cap WITH a carried round is refused — the COMBINATION was the gap', async () => {
    // THE HOLE MY OWN TESTS LEFT (final gate, blocker 1). They covered null-cap-defaults
    // (no round) and omitted-cap-rejects (with a round) SEPARATELY, and the combination
    // fell between them: the cap is resolved with `??`, which treats null and undefined
    // alike, while the pair guard checked only `=== undefined`. So
    // `{ ralph_round: 5, max_ralph_rounds: null }` passed the guard AND resolved to 20,
    // creating the unbounded half-pair 5/20 that `TridentUnboundedCarriedRoundError`
    // exists to refuse. Two spellings of ABSENT taking different branches, one layer
    // below where the same asymmetry was fixed a round earlier.
    // RED-mutation: `=== undefined` instead of `== null` in the pair guard and this row
    // is created at 5/20.
    await expect(
      store.create({
        slug: 'null-cap-with-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
        ralph: true, ralph_round: 5, max_ralph_rounds: null as unknown as number,
      }),
    ).rejects.toThrow(TridentUnboundedCarriedRoundError)
    // …and `undefined` is refused identically, which is the point: the two spellings of
    // absent now take the SAME branch.
    await expect(
      store.create({
        slug: 'undef-cap-with-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
        ralph: true, ralph_round: 5,
      }),
    ).rejects.toThrow(TridentUnboundedCarriedRoundError)
    // POSITIVE CONTROLS, so this cannot pass by refusing everything: a null cap with NO
    // carried round still defaults (nothing is half-paired), and a named cap with a round
    // is accepted at the value named.
    const noRound = await store.create({
      slug: 'null-cap-no-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, max_ralph_rounds: null as unknown as number,
    })
    expect({ round: noRound.ralph_round, cap: noRound.max_ralph_rounds }).toEqual({
      round: 0,
      cap: DEFAULT_MAX_RALPH_ROUNDS,
    })
    const paired = await store.create({
      slug: 'paired-cap-with-round', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, ralph_round: 5, max_ralph_rounds: 9,
    })
    expect({ round: paired.ralph_round, cap: paired.max_ralph_rounds }).toEqual({ round: 5, cap: 9 })
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

    await priorRun({ task: BEFORE, ralph_round: 12, max_ralph_rounds: 20 })

    const { result, seedLine } = await dispatchRecording(async () => HEAD, { task: AFTER })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // THE SPEND SURVIVES: the card named this run, which is identity.
    expect(result.run.ralph_round).toBe(12)
    expect(result.run.max_ralph_rounds).toBe(20)
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
    const prior = await priorRun({ task: TASK_LOCAL, ralph_round: 4 })
    // The prior run recorded THIS repo's actual commit, which is what makes the
    // head-equality proof a real comparison rather than two fixtures agreeing.
    await store.update(prior.id, { inner_checkpoint_head: head, base_sha: head })

    const { result, seedLine, ghCalls } = await dispatchReal(dir, TASK_LOCAL)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.merge_mode).toBe('local')
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    expect(result.run.inner_checkpoint_head).toBe(head)
    expect(result.run.ralph_round).toBe(4)
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
    const prior = await priorRun({ task: TASK_GONE, ralph_round: 4 })
    await store.update(prior.id, { inner_checkpoint_head: HEAD, base_sha: BASE })

    const { result, seedLine, ghCalls } = await dispatchReal(dir, TASK_GONE)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull()
    expect(seedLine).toContain('reason=branch_tip_unreadable_or_absent')
    expect(result.run.ralph_round).toBe(4) // identity is the link, not the branch
    expect(ghCalls).toBe('')
  })
})

describe('THE LIMIT — what this change does NOT close, pinned so it cannot be forgotten', () => {
  test('a card with NO board link gets a fresh budget, however much it has spent', async () => {
    // THE HONEST BOUND ON EVERY CLAIM IN THIS FILE, and the cheapest way to reach it is
    // ONE CLICK — not a re-cut card, which two earlier drafts of this comment claimed.
    // `work-board/store.ts` NULLs `linked_run_id` when a card leaves the `failed` lane
    // (`nextStatus('failed') → 'upcoming'`, the ordinary status-dot advance) and again on
    // `done → upcoming`. So the same card, same slug, same title, same branch, nothing
    // re-cut, comes back to a full fresh budget. `onboarding/overnight/register.ts`
    // (governed runs, no card) and a genuinely re-cut card are the OTHER two doors, and
    // both need the slug lost — describing only those made the limit sound far narrower
    // than it is. The row is recreated by every dispatch and the link is one click from
    // gone, so a per-row counter is one reset away by construction; #629 holds the fix.
    // RED-mutation: let an absent link fall back to the task text and this row inherits
    // a budget the board cannot show anyone.
    await priorRun({ ralph_round: 12 })
    cardLink = null // the card no longer names the run it produced

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.ralph_round).toBe(0)
    expect(result.run.max_ralph_rounds).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(seedLine).toContain('reason=card_names_no_run')
    expect(seedLine).toContain('budget_carried=false')
  })

  test('a NON-GOVERNED run in between LAUNDERS the whole spend', async () => {
    // A SECOND DOOR, and it is not the "gap in the chain" #629 already names: the
    // intervening row is PRESENT, terminal and perfectly readable — it is simply not
    // governed, so `carriedRalphBudget` answers null on `run.ralph !== true` and the
    // spend is gone. Measured: a card at 20/20, one dispatch with ralph off (born at 0,
    // non-governed), that row dies, `latestTerminalBySlug` returns IT, and the next
    // governed dispatch starts at 0/20.
    // RED-mutation: none needed to make this fail — it asserts the CURRENT limit. It
    // reds if someone accumulates the spend over the card's history instead of reading
    // one prior row, which is exactly what #629 asks for; at that point this test should
    // be inverted deliberately rather than deleted in passing.
    const task = 'laundered budget card — rebuild the importer'
    const spent = await priorRun({ task, ralph_round: 20, max_ralph_rounds: 20 })
    expect(spent.ralph_round).toBe(20)

    // One non-governed dispatch of the same card, which becomes the latest terminal row.
    const plain = await dispatchRecording(async () => HEAD, { task, resolveRalph: async () => false })
    expect(plain.result.ok).toBe(true)
    if (!plain.result.ok) return
    expect(plain.result.run.ralph).toBe(false)
    expect(plain.result.run.ralph_round).toBe(0)
    await store.update(plain.result.run.id, { phase: 'failed', inner_verdict: 'REVIEW_NOT_RUN' })
    cardLink = plain.result.run.id

    // …and the next GOVERNED dispatch inherits nothing at all.
    const governed = await dispatchRecording(async () => HEAD, { task })
    expect(governed.result.ok).toBe(true)
    if (!governed.result.ok) return
    expect({ round: governed.result.run.ralph_round, cap: governed.result.run.max_ralph_rounds }).toEqual({
      round: 0,
      cap: 20,
    })
    expect(governed.seedLine).toContain('budget_carried=false')
  })

  test('an EXHAUSTED ralph run does keep its spend through the board link — the P1 row, measured', async () => {
    // The adversarial review measured this row as a fresh budget: a run that exhausts
    // the Ralph loop takes `refireNextRalphTask`'s cap branch, which builds its terminal
    // row through `failedRun` and so leaves `inner_checkpoint = 'ralph-task-built'` —
    // not review-capable, therefore `died-before-build`, therefore no seed, therefore
    // (when the budget was gated on the seed) `ralph_round: 0` and a full twenty again.
    //
    // Decoupling the budget from the commit seed closes that row FOR A LINKED CARD,
    // which is what this asserts. It does NOT make the bound card-level in general —
    // see the test above for the shapes that still reset.
    // RED-mutation: gate `carriedRalphBudget` on `seed !== null` and this row is born
    // at 0/20 with the whole budget back.
    await priorRun({
      checkpoint: 'ralph-task-built',
      ralph_round: DEFAULT_MAX_RALPH_ROUNDS,
      max_ralph_rounds: DEFAULT_MAX_RALPH_ROUNDS,
    })

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull() // no commit is adopted, correctly
    expect(result.run.ralph_round).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(result.run.max_ralph_rounds).toBe(DEFAULT_MAX_RALPH_ROUNDS)
    expect(seedLine).toContain('reason=prior_run_has_no_resumable_build')
    // And the loop refuses the next iteration rather than starting a twenty-first.
    const next = computeTransition({ ...store.get(result.run.id)!, phase: 'ralph-task' }, {})
    expect(next.phase).toBe('failed')
    expect(next.failure_reason).toContain('max_ralph_rounds')
  })
})

describe('THE SEED LINE REPORTS THE ROW, not what the dispatch intended', () => {
  /**
   * THE DEFECT THIS CLOSES IS THE DOMINANT ONE OF THE WHOLE BUILD PHASE, in its purest
   * form (adversarial review, item 5). The claim in the PR body was "the line now states
   * what was WRITTEN, not what was intended". C7 pinned the line's POSITION — that it is
   * emitted after the row exists — and nothing pinned the SOURCE of its values, so three
   * mutations survived the entire suite: `checkpoint: seed?.inner_checkpoint ?? null`,
   * `ralph_round: budget?.ralph_round ?? 0`, `max_ralph_rounds: budget?.max_ralph_rounds ?? 0`.
   *
   * A test that reacts to its subject while the claim is about something else is worth
   * less than no test, because it is read as coverage. These pin the values against
   * `store.get(run.id)` in the cases where the row and the intent DISAGREE — which is the
   * only place the distinction is observable.
   */
  test('when budget is NOT carried, the line still reports the ROW\'s cap — not 0', async () => {
    // THE CASE THAT CAUGHT THE MUTANT. `card_names_no_run` carries no budget, so
    // `budget?.max_ralph_rounds ?? 0` logs 0 while the ROW is at the configured cap. Read
    // the two against each other and the mutant cannot hide.
    // RED-mutation: `max_ralph_rounds: budget?.max_ralph_rounds ?? 0` — logs 0, row is 20.
    await priorRun({ ralph_round: 12 })
    cardLink = null

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = store.get(result.run.id)!
    expect(row.max_ralph_rounds).toBe(20)
    expect(seedLine).toContain(`max_ralph_rounds=${row.max_ralph_rounds}`)
    expect(seedLine).toContain(`ralph_round=${row.ralph_round}`)
    expect(seedLine).not.toContain('max_ralph_rounds=0')
  })

  test('when the COMMIT is refused, the line still reports the row\'s null checkpoint', async () => {
    // `seed?.inner_checkpoint ?? null` is indistinguishable from the row here — `seed` is
    // null and the row's checkpoint is null — so the discriminating case is the RESUMED
    // one below. This half pins that a refused commit is reported as such alongside a
    // CARRIED budget, which is the shape the two-gate split created and which no single
    // field can describe.
    await priorRun({ ralph_round: 4 })
    const { result, seedLine } = await dispatchRecording(async () => MOVED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = store.get(result.run.id)!
    expect(row.inner_checkpoint).toBeNull()
    expect(seedLine).toContain('checkpoint=null')
    expect(seedLine).toContain(`ralph_round=${row.ralph_round}`)
    expect(row.ralph_round).toBe(4)
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
    await priorRun({ ralph_round: 4, max_ralph_rounds: 20 })

    const { result, seedLine } = await dispatchRecording(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = store.get(result.run.id)!
    expect(seedLine).toContain(`checkpoint=${row.inner_checkpoint}`)
    expect(seedLine).toContain(`ralph_round=${row.ralph_round}`)
    expect(seedLine).toContain(`max_ralph_rounds=${row.max_ralph_rounds}`)
    expect(seedLine).toContain(`run=${row.id}`)
    // …and the literals, so the assertions above cannot all pass on a row of zeroes.
    expect({ cp: row.inner_checkpoint, round: row.ralph_round, cap: row.max_ralph_rounds }).toEqual({
      cp: 'fix-round-3',
      round: 4,
      cap: 20,
    })
  })
})

describe('THE TERMINAL REASON MUST SAY WHICH FAILURE HAPPENED', () => {
  /**
   * A consequence of inheriting a spend, and a real cost of it (adversarial review,
   * item 3). A row can now reach the Ralph cap having run NO iteration of its own — the
   * measured case: a prior at 20/20 whose spec doc was edited past the slug's 35th
   * character produces a fresh `forge-init` row at 20/20 with no checkpoint, which fails
   * at its first transition. "Ralph loop hit max_ralph_rounds (20) without converging" is
   * false for that row: nothing was attempted, so nothing failed to converge, and it sends
   * whoever reads it hunting a planner problem that does not exist.
   */
  test('a row that inherited a spent budget is not accused of failing to converge', async () => {
    // RED-mutation: `const neverRan = false` in `enterRalphPlan` — the inherited row is
    // blamed on the planner again.
    const PREFIX = 'reason wording card for the governed importer'
    const BEFORE = `${PREFIX} — first pass`
    const AFTER = `${PREFIX} — second pass with the CSV note`
    expect(slugifyTask(AFTER)).toBe(slugifyTask(BEFORE))
    await priorRun({ task: BEFORE, ralph_round: 20, max_ralph_rounds: 20 })

    const { result } = await dispatchRecording(async () => HEAD, { task: AFTER })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = store.get(result.run.id)!
    // The measured shape: a fresh build that inherited a spent budget.
    expect({ cp: row.inner_checkpoint, round: row.ralph_round, cap: row.max_ralph_rounds }).toEqual({
      cp: null,
      round: 20,
      cap: 20,
    })

    const t = computeTransition({ ...row, phase: 'ralph-task' }, {})
    expect(t.phase).toBe('failed')
    // The token every downstream reader keys on is still there…
    expect(t.failure_reason).toContain('max_ralph_rounds')
    // …and the explanation is now TRUE — which THIS ASSERTION ITSELF GOT WRONG ONCE.
    // It used to require the phrase "inherited a spent budget", pinning a claim the row
    // cannot support: `inner_checkpoint === null` does not establish that a predecessor
    // existed, so the same wording was handed to a brand-new run at its cap (see the
    // fresh-run boundary test below). A test asserting a claim is only as good as the
    // claim; this one made a lying message look verified.
    // BRANCH 3: the budget IS consumed — that much is certain whoever consumed it —
    // and only WHO is left open.
    expect(t.failure_reason).toContain('no build of its own')
    expect(t.failure_reason).toContain('the budget is consumed')
    expect(t.failure_reason).toContain('does not record WHO consumed it')
    // It may NAME the two possibilities; it may not assert either one…
    expect(t.failure_reason).not.toContain('inherited')
    // …it may not blame a planner that never ran…
    expect(t.failure_reason).not.toContain('without converging')
    // …and it must NOT claim nothing was allocated, which is branch 2's fact and is
    // false here. RED-mutation: collapse branch 3 into branch 2 and this fails.
    expect(t.failure_reason).not.toContain('no Ralph iteration was ever authorised')

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
      { ...row, phase: 'ralph-task', inner_checkpoint: 'ralph-task-built' },
      {},
    )
    expect(ran.phase).toBe('failed')
    expect(ran.failure_reason).toContain('A resumable build IS on this row')
    expect(ran.failure_reason).not.toContain('no build of its own')
    // AND IT CLAIMS NO AUTHORSHIP, for the same reason arm 3 claims none: the row does
    // not record it. RED-mutation: restore "without converging" to arm 1.
    expect(ran.failure_reason).not.toContain('without converging')
  })

  test('A BRAND-NEW run with NO budget allocated is told exactly that — branch 2 of 3', async () => {
    // THE SECOND CONTRADICTION IN THIS ONE SENTENCE, and the mirror of the first. Having
    // removed a claim that was not determinable (inheritance), the wording retreated to
    // the most general phrasing available — "the budget was spent before this run began"
    // — which is FALSE here: this run was configured `max_ralph_rounds: 0`, so nothing was
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
      ralph: true, max_ralph_rounds: 0,
    })
    expect({ round: fresh.ralph_round, cap: fresh.max_ralph_rounds, cp: fresh.inner_checkpoint }).toEqual(
      { round: 0, cap: 0, cp: null },
    )

    // `forge-init` in ralph mode needs a REMAINING_TASKS from the bootstrap before it
    // reaches the cap check at all, so this is the real path in for a brand-new run.
    const t = computeTransition({ ...fresh, phase: 'forge-init' }, { remaining: 1 })
    expect(t.phase).toBe('failed')
    expect(t.failure_reason).toContain('max_ralph_rounds')
    // IT SAYS WHAT IS TRUE: nothing was allocated, so nothing was spent.
    expect(t.failure_reason).toContain('no Ralph iteration was ever authorised')
    expect(t.failure_reason).toContain('Nothing has been spent')
    // AND CLAIMS NOTHING ELSE — no predecessor, no consumed budget, no planner.
    expect(t.failure_reason).not.toContain('inherited')
    expect(t.failure_reason).not.toContain('the budget is consumed')
    expect(t.failure_reason).not.toContain('without converging')
    expect(t.failure_reason).not.toContain('does not record')
  })

  test('A CARRIED ROUND UNDER A ZERO CAP is branch 3, not branch 2 — the counter decides, not the cap', async () => {
    // THE DISCRIMINATOR HAS TO BE THE COUNTER. Keying branch 2 on `max_ralph_rounds === 0`
    // reads identically on every row above EXCEPT this one, and this one is reachable:
    // a prior at 5/30 re-dispatched with an explicit cap of 0 produces 5/0 (the cap
    // tightens, the spend travels). Under the cap-keyed version that row is told "nothing
    // has been spent" while its counter says 5. The mutation survived the suite until
    // this case was written, which is what "what input would a wrong implementation get
    // right?" is for: both discriminators agree everywhere else.
    // RED-mutation: `nothingWasEverAllocated = !builtSomethingItself &&
    // run.max_ralph_rounds === 0` — the row below is told nothing was spent.
    const carriedUnderZero = await store.create({
      slug: 'carried-under-zero-cap', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, ralph_round: 5, max_ralph_rounds: 0,
    })
    expect({ round: carriedUnderZero.ralph_round, cap: carriedUnderZero.max_ralph_rounds, cp: carriedUnderZero.inner_checkpoint }).toEqual(
      { round: 5, cap: 0, cp: null },
    )

    const t = computeTransition({ ...carriedUnderZero, phase: 'ralph-task' }, {})
    expect(t.phase).toBe('failed')
    // BRANCH 3: a budget WAS consumed — five rounds of it — whoever consumed them.
    expect(t.failure_reason).toContain('the budget is consumed')
    expect(t.failure_reason).toContain('does not record WHO consumed it')
    // NOT branch 2: "nothing has been spent" is flatly false for a row at ralph_round 5.
    expect(t.failure_reason).not.toContain('Nothing has been spent')
    expect(t.failure_reason).not.toContain('no Ralph iteration was ever authorised')
  })

  test('THE THIRD COMBINATION IS UNREACHABLE, and that is why there are three arms not four', async () => {
    // Derived rather than assumed, because the arm count depends on it. The refusal fires
    // iff `ralph_round >= max_ralph_rounds`; `max_ralph_rounds` is written ONLY by
    // `create` (absent from `TridentRunUpdate`) and `create` refuses any cap that is not a
    // non-negative safe integer. So `ralph_round === 0` at the refusal implies `cap === 0`
    // — a round of 0 under a POSITIVE cap can never reach it.
    // RED-mutation: none applies; this asserts a property of the guard, and it reds if
    // someone widens the refusal condition (e.g. to `>=`) or lets a negative cap be
    // written, either of which would make a fourth arm reachable without anyone noticing.
    const positiveCap = await store.create({
      slug: 'round-zero-positive-cap', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, max_ralph_rounds: 3,
    })
    expect({ round: positiveCap.ralph_round, cap: positiveCap.max_ralph_rounds }).toEqual({
      round: 0,
      cap: 3,
    })
    // It does NOT fail — it advances, which is the whole content of the claim.
    const t = computeTransition({ ...positiveCap, phase: 'forge-init' }, { remaining: 1 })
    expect(t.phase).toBe('ralph-plan')
    expect(t.ralph_round).toBe(1)
    expect(t.failure_reason).toBeNull()
  })
})

describe('BOTH runs must be governed — both halves of the gate, pinned', () => {
  test('a NON-governed PRIOR hands nothing to a governed dispatch', async () => {
    // THE UNPINNED HALF (adversarial review, item 6). Dropping `run.ralph !== true` from
    // `carriedRalphBudget` survived the whole suite, because every existing test exercised
    // only the `opts.ralph` direction. A count of Ralph iterations on a non-Ralph row is
    // not a Ralph spend — the counter is whatever happened to be in the column.
    // RED-mutation: drop `run.ralph !== true` and this row inherits 9.
    const task = 'non governed prior card — rebuild the importer'
    const prior = await priorRun({ task, ralph: false, ralph_round: 0 })
    // Give the non-governed row a counter, the way `update` still permits.
    await store.update(prior.id, { ralph_round: 9 })
    expect(store.get(prior.id)!.ralph).toBe(false)
    expect(store.get(prior.id)!.ralph_round).toBe(9)

    const { result, seedLine } = await dispatchRecording(async () => HEAD, { task })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.ralph).toBe(true) // the NEW row is governed
    expect(result.run.ralph_round).toBe(0) // …and inherits nothing
    expect(seedLine).toContain('budget_carried=false')
    // POSITIVE CONTROL: the same shape with a GOVERNED prior carries 9.
    cardLink = null
    const okTask = 'governed prior control card — rebuild the importer'
    const ok = await priorRun({ task: okTask, ralph: true, ralph_round: 9 })
    expect(store.get(ok.id)!.ralph).toBe(true)
    const carried = await dispatchRecording(async () => HEAD, { task: okTask })
    expect(carried.result.ok).toBe(true)
    if (!carried.result.ok) return
    expect(carried.result.run.ralph_round).toBe(9)
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
      ralph: true,
    })
    await store.update(live.id, { phase: 'ralph-task', ralph_round: 4 })
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
    const prior = await priorRun({ ralph_round: 4 })
    // …and something live holds the branch, so the dispatch is refused outright.
    const live = await store.create({
      slug: `${slugifyTask(TASK)}`, project_slug: 'proj-1', repo_path: tmp,
      task: 'a competing lane', branch: BRANCH, ralph: true,
      id: 'live-holder-no-log',
    })
    await store.update(live.id, { phase: 'ralph-task' })
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
    const prior = await priorRun({ task: PATHY, ralph_round: 4 })
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
    const prior = await priorRun({ ralph_round: 4 })
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
      await store.update(racer.id, { phase: 'ralph-task' })
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
    // fail — a launcher crash would start spending the agent's Ralph budget.
    const run = await store.create({
      id: 'crash-1',
      slug: 'crashed-card',
      project_slug: 'proj-1',
      repo_path: tmp,
      task: 'build',
      ralph: true,
    })
    await store.update(run.id, {
      phase: 'ralph-task',
      branch: 'trident/crashed-card',
      pr: 61,
      inner_checkpoint: 'ralph-task-built',
      round: 2,
      ralph_round: 3,
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
      run_host: async () => ({ ok: true, stdout: '', stderr: '', exit_code: 0 }),
      base_branch: 'main',
      begin_crash_recovery: (id) => store.beginCrashRecovery(id),
    })
    await new TridentTickLoop({ store, step: orch.step }).runOnce()

    expect(creates).toBe(0) // the continuation path writes no new row at all
    expect(seen.length).toBe(1)
    expect(seen[0]?.resume_checkpoint).toBe('ralph-task-built')
    expect(seen[0]?.run.branch).toBe('trident/crashed-card')
    expect(seen[0]?.run.pr).toBe(61)
    // A launcher crash is not the AGENT's failure — it spends neither counter.
    const after = store.get(run.id)!
    expect(after.round).toBe(2)
    expect(after.ralph_round).toBe(3)
    expect(after.crash_recoveries).toBe(1)
    // …and the workflow is told the TRUE round, which is what the plan-refresh
    // cadence reads. This is the property a re-dispatch now shares with it.
    expect(seen[0]?.run.ralph_round).toBe(3)
  })
})

describe('the write site refuses a carried round it should never have been offered', () => {
  test('a NON-GOVERNED row may not carry a round', async () => {
    // "Do not put the check only in the caller" (adversarial review, P3). `create`
    // re-applied the unseeded and pair rules but never this one, so
    // `create({ ralph: false, ralph_round: 4 })` wrote a Ralph counter onto a row that
    // will never run a Ralph loop — and `buildWorkflowArgs` reads it regardless, so
    // the workflow would be told an iteration number for a loop that does not exist.
    // RED-mutation: delete the `input.ralph !== true` arm and this row is writable.
    await expect(
      store.create({
        slug: 'ungoverned', project_slug: 'proj-1', repo_path: tmp, task: 'x',
        ralph: false, ralph_round: 4, max_ralph_rounds: 20,
      }),
    ).rejects.toThrow(TridentUngovernedRalphRoundError)
    // POSITIVE CONTROL: the identical row with `ralph: true` is accepted.
    const governed = await store.create({
      slug: 'governed', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, ralph_round: 4, max_ralph_rounds: 20,
    })
    expect(governed.ralph_round).toBe(4)
  })

  test('a round with NO CAP NAMED is refused — the bound is a pair, not a counter', async () => {
    // THE MEASURED DEFECT (round 2 BLOCKER). `create` supplies
    // DEFAULT_MAX_RALPH_ROUNDS when the caller names no cap, so a row carrying a spent
    // round but no cap silently RAISES the bound of any card that had a tighter one: a
    // prior at 5/5 became 5/20, and `5 + 1 > 20` authorises fifteen more iterations.
    // RED-mutation: delete the `input.max_ralph_rounds === undefined` arm and the row
    // below is created at 5/20 — the exact shape the blocker measured.
    await expect(
      store.create({
        slug: 'no-cap', project_slug: 'proj-1', repo_path: tmp, task: 'x',
        ralph: true, ralph_round: 5,
      }),
    ).rejects.toThrow(TridentUnboundedCarriedRoundError)
    // POSITIVE CONTROL: name the cap and it is accepted, at the value named.
    const paired = await store.create({
      slug: 'paired', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, ralph_round: 5, max_ralph_rounds: 8,
    })
    expect({ round: paired.ralph_round, cap: paired.max_ralph_rounds }).toEqual({ round: 5, cap: 8 })
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
      ralph: true, ralph_round: 6, max_ralph_rounds: 20,
    })
    expect(unseeded.inner_checkpoint).toBeNull()
    expect(unseeded.ralph_round).toBe(6)
  })

  test('a round at or past the cap is stored VERBATIM — not refused, not clamped', async () => {
    // WHY THE WRITE SITE MUST ACCEPT IT (cross-model review, BLOCKER 1). An earlier
    // revision threw `TridentUnusableRalphRoundError` here. Two things were wrong
    // with that. It made the producer's matching refusal necessary, and that refusal
    // fell back to a fresh row at 0 — handing an exhausted card its whole budget
    // back. And throwing would turn an exhausted card's dispatch into a
    // `backend_error` (HTTP 500, nothing queued) when the honest outcome is a row
    // that reviews the commit it adopted and refuses only a NEW iteration.
    // Clamping was no better: it manufactures budget out of a number nobody asked for.
    // RED-mutation: reinstate a cap check in `create` and these rejections come back.
    const full = {
      project_slug: 'proj-1', repo_path: tmp, task: 'x', ralph: true,
      inner_checkpoint: 'fix-round-3', inner_checkpoint_head: HEAD, base_sha: BASE,
    }
    const atCap = await store.create({ ...full, slug: 'at-cap', ralph_round: 5, max_ralph_rounds: 5 })
    expect(atCap.ralph_round).toBe(5)
    expect(store.get(atCap.id)!.ralph_round).toBe(5)
    const pastCap = await store.create({ ...full, slug: 'past-cap', ralph_round: 9, max_ralph_rounds: 5 })
    expect(pastCap.ralph_round).toBe(9) // verbatim: NOT clamped to 5
    // BOTH SIDES OF THE BOUND, so this cannot pass by storing everything wrong.
    const underCap = await store.create({ ...full, slug: 'under-cap', ralph_round: 4, max_ralph_rounds: 5 })
    expect(underCap.ralph_round).toBe(4)
    // …and the cap bites on the rows that are at or past it, not on the one below.
    expect(computeTransition({ ...atCap, phase: 'ralph-task' }, {}).phase).toBe('failed')
    expect(computeTransition({ ...pastCap, phase: 'ralph-task' }, {}).phase).toBe('failed')
    expect(computeTransition({ ...underCap, phase: 'ralph-task' }, {}).phase).toBe('ralph-plan')
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
    // RED-mutation: restore `carryableRalphRound` to `… ? round : 0` and every rejection
    // below stops.
    for (const bad of [-3, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, '4', {}]) {
      await expect(
        store.create({
          slug: `garbled-${String(bad)}`, project_slug: 'proj-1', repo_path: tmp, task: 'x',
          ralph: true, max_ralph_rounds: 20, ralph_round: bad as unknown as number,
        }),
      ).rejects.toThrow(TridentInvalidRalphRoundError)
    }
    // ABSENT is absent: no counter named → 0, exactly as before this existed.
    const absent = await store.create({
      slug: 'round-absent', project_slug: 'proj-1', repo_path: tmp, task: 'x', ralph: true,
    })
    expect(absent.ralph_round).toBe(0)
    // …and an explicit ZERO is valid, not refused — the control that stops this test from
    // passing by rejecting everything.
    const zero = await store.create({
      slug: 'round-zero', project_slug: 'proj-1', repo_path: tmp, task: 'x',
      ralph: true, ralph_round: 0, max_ralph_rounds: 20,
    })
    expect(zero.ralph_round).toBe(0)
  })
})
