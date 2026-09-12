/**
 * A RE-DISPATCH MUST RESUME THE DEAD RUN, NOT START ITS CARD OVER (#519).
 *
 * The defect, measured in this tree: a re-dispatch creates a NEW `code_trident_runs`
 * row, and `create` wrote `ralph_round: 0` onto it unconditionally. Two consequences
 * follow, both from code in this repo rather than from a guess:
 *
 *   - `refireNextRalphTask` (trident/orchestrator.ts) bounds the WHOLE Ralph loop on
 *     `ralph_round + 1 > run.max_ralph_rounds`. A counter reset to 0 on every
 *     re-dispatch means the bound stopped applying to the CARD: press ▶ again and a
 *     non-converging planner gets another full 20 iterations, indefinitely.
 *   - `buildWorkflowArgs` (trident/inner-loop.ts) threads the counter to the inner
 *     workflow as `ralphRound`, where the planner-cadence gate reads
 *     `ralphRoundNum % PLAN_REFRESH_EVERY`. A reset counter restarts the periodic
 *     full re-plan on the wrong iteration, so the survey is re-paid off-cadence.
 *
 * The `inner_checkpoint` half of continuity already lands (the salvage-resume seed).
 * This file drives the REAL `dispatchBoardBoundBuild` against the REAL store and
 * pins both directions of the round half — it resumes on proof, it starts fresh
 * (and logs why) without it — plus the three boundaries that make resuming safe: an
 * EXHAUSTED round is carried so the cap still bites rather than being reset to a
 * fresh budget, a live run is refused at the existing claim chokepoint, and the
 * launcher-CRASH relaunch (a different path, on the SAME row) is untouched.
 *
 * Every case names the mutation that turns it RED.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import {
  dispatchBoardBoundBuild,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from './board-dispatch.ts'
import {
  TridentRunStore,
  TridentUnseededPinError,
  type MergeMode,
  type TridentRun,
} from './store.ts'
import { DEFAULT_MAX_RALPH_ROUNDS } from './ralph-budget.ts'
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

  test('THE BUDGET IS NOW THE CARD\'S: a second re-dispatch does not hand back a fresh 20', async () => {
    // The consequence the reset had: `refireNextRalphTask` refuses at
    // `ralph_round + 1 > max_ralph_rounds`, so a card could be resurrected forever by
    // re-pressing ▶ — each attempt believing it had spent nothing. RED-mutation: the
    // same as A above; the chain collapses to 0 at every link.
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

  test('THE WORKFLOW IS TOLD THE TRUE ROUND — the planner cadence is not restarted', async () => {
    // WHERE THE RE-SPENT PLANNING ACTUALLY LANDS. `buildWorkflowArgs` threads the
    // row's counter to the inner workflow as `ralphRound`, and the planner-cadence
    // gate reads `ralphRoundNum % PLAN_REFRESH_EVERY` to decide between the cheap
    // continuation planner and the full survey (inner-workflow.mjs). A row born at 0
    // tells the workflow this is iteration 1, so the cadence restarts and the full
    // re-plan lands on the wrong iteration — the governed plan regenerated from
    // scratch off-schedule, every time a card is retried.
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

  test('THE BRANCH TIP MOVED: nothing is carried, and the line names the moved tip', async () => {
    // THE EVIDENCE GATE. A 40-hex tip that is not the recorded one means the branch
    // moved under this lane — a force-push, or another card's commit. Resuming onto
    // it would build against a state that is gone, and would do it while carrying the
    // prior run's base pin, which is exactly what makes the launcher's
    // leftover-branch refusal exempt the adopted tip.
    // RED-mutation: replace the comparison with `if (candidate !== null) seed =
    // candidate` — it always resumes, and every assertion here fails.
    await priorRun({ ralph_round: 4 })

    const { result, seedLine } = await dispatchRecording(async () => MOVED)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.ralph_round).toBe(0)
    expect(result.run.inner_checkpoint).toBeNull()
    expect(result.run.inner_checkpoint_head).toBeNull()
    expect(result.run.base_sha).toBeNull()
    expect(store.get(result.run.id)!.ralph_round).toBe(0)
    expect(seedLine).toContain('reason=branch_tip_moved')
    expect(seedLine).toContain('ralph_round=0')
  })

  test('THE BRANCH IS ABSENT OR THE REF UNREADABLE: refused too, under its own reason', async () => {
    // `unknown` AUTHORISES NOTHING. An empty read is the branch being gone, or a ref
    // that could not be read at all (an uncredentialed remote, a probe that threw) —
    // the ABSENCE of evidence, not evidence of another lane. It refuses like a moved
    // tip, but under a different reason, because the sentence is what tells an
    // operator whether to look at the branch or at the credential.
    // RED-mutation: treat `''` as a match (`observed === candidate.head || observed
    // === ''`) and both arms below resume against a branch nobody can see.
    // PREFIX-DISTINCT TASKS. `slugifyTask` truncates at 35 characters, so two cards
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
      expect({ name, round: result.run.ralph_round }).toEqual({ name, round: 0 })
      expect({ name, cp: result.run.inner_checkpoint }).toEqual({ name, cp: null })
      expect(seedLine).toContain('reason=branch_tip_unreadable_or_absent')
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

  test('A PRIOR THAT BUILT NOTHING RESUMABLE: no round travels either', async () => {
    // `ralph-task-built` has a commit behind it but `resumeOnUnchangedHead` rebuilds
    // it by design, and a `stopped` run is work the OWNER discarded. Neither hands
    // anything forward — and the round must not sneak past a checkpoint that did not.
    // RED-mutation: carry `prior.ralph_round` outside the `candidate !== null` arm
    // and the round arrives on a row with no checkpoint, which `create` then refuses
    // (`TridentUnseededPinError`) — so the dispatch fails outright.
    // PREFIX-DISTINCT TASKS, for the same truncation reason as above.
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
      expect({ name, round: result.run.ralph_round }).toEqual({ name, round: 0 })
      expect({ name, cp: result.run.inner_checkpoint }).toEqual({ name, cp: null })
      expect(seedLine).toContain('reason=prior_run_has_no_resumable_build')
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

  test('AN EXHAUSTED PRIOR STAYS EXHAUSTED — the round is carried and the cap still bites', async () => {
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
  test('an UNSEEDED row may not carry one — the four seed columns are one seed', async () => {
    // "Do not put the check only in the caller." A round on a row with no checkpoint
    // is a FRESH build born partway through a budget it never spent, with its
    // plan-refresh cadence shifted. RED-mutation: delete the `seededCheckpoint === ''`
    // arm in `create` and this row is writable from any future path.
    await expect(
      store.create({
        slug: 'unseeded', project_slug: 'proj-1', repo_path: tmp, task: 'x', ralph: true, ralph_round: 4,
      }),
    ).rejects.toThrow(TridentUnseededPinError)
    // POSITIVE CONTROL: the identical row WITH the full seed is accepted, so the
    // refusal above is the missing checkpoint talking.
    const seeded = await store.create({
      slug: 'seeded', project_slug: 'proj-1', repo_path: tmp, task: 'x', ralph: true, ralph_round: 4,
      inner_checkpoint: 'fix-round-3', inner_checkpoint_head: HEAD, base_sha: BASE,
    })
    expect(seeded.ralph_round).toBe(4)
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

  test('a garbled round reads as 0 rather than failing the dispatch', async () => {
    // The counter reaches `create` from a stored INTEGER column and from caller
    // options. A non-integer is the fresh-budget case, not a reason to lose a build:
    // failing the dispatch would convert a salvageable card into an HTTP 500.
    for (const bad of [-3, 1.5, Number.NaN, '4', null, undefined]) {
      const run = await store.create({
        slug: `garbled-${String(bad)}`, project_slug: 'proj-1', repo_path: tmp, task: 'x', ralph: true,
        ralph_round: bad as unknown as number,
      })
      expect({ bad, round: run.ralph_round }).toEqual({ bad, round: 0 })
    }
  })
})
