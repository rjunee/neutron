/**
 * THE REVIEW-ROUND CAP, END TO END — the value the fix loop actually bounds on.
 *
 * WHY THIS FILE EXISTS. The cap is written in two places and only ONE of them is
 * reachable by a real lane:
 *
 *   1. `trident/store.ts` `create()` — `max_rounds: input.max_rounds ?? 10`.
 *      Written onto the run row, threaded by `buildWorkflowArgs` as `maxRounds`,
 *      and gated on by `round < maxRounds` in `inner-workflow.mjs`. THIS is the
 *      cap the fleet runs on.
 *   2. `trident/inner-workflow.mjs` — the `maxRounds = 10` destructuring default.
 *      A FALLBACK only: `buildWorkflowArgs` always supplies the key, so this
 *      literal is never reached on the production path.
 *
 * A previous revision of this change raised (2) alone, from 3 to 10, and left (1)
 * at 8. That is a NO-OP for every real lane — the run row still said 8 — while
 * reading, in the diff and in the comment beside it, exactly like a cap change.
 * Nothing in the suite would have gone red. So this file asserts the cap by
 * DRIVING the real chain — real migrations → real store → real launcher — rather
 * than by restating a literal, and it pins the two knobs to each other so they
 * cannot drift apart again.
 *
 * WHAT IS AND IS NOT EXECUTED HERE. The store and the launcher are the real code.
 * The fix loop is NOT: `inner-workflow.mjs` cannot run under bun (its
 * `agent`/`parallel`/`phase` globals are injected by the Workflow runtime and it
 * ends in a top-level `return` — see the header of inner-workflow.test.ts). The
 * loop is therefore RE-EXECUTED as a model, and the model is pinned to the script
 * by source assertions on its three-clause predicate, its strict `<`, and its
 * `round++` step — so a script that drifts makes those red instead of leaving the
 * model quietly describing a loop that no longer exists.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'
import { buildWorkflowArgs } from './inner-loop.ts'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

/** The cap a lane gets when the caller names no preference — the fleet default. */
const EXPECTED_CAP = 10

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-trident-cap-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function createRun(over: Record<string, unknown> = {}) {
  const store = new TridentRunStore(db)
  return await store.create({
    slug: 'cap-probe',
    project_slug: 'proj',
    repo_path: '/repo',
    task: 'probe the round cap',
    ...over,
  } as Parameters<TridentRunStore['create']>[0])
}

describe('review-round cap — the value a real lane actually gets', () => {
  test('a run created with no explicit cap is PERSISTED with ten', async () => {
    const run = await createRun()
    expect(run.max_rounds).toBe(EXPECTED_CAP)
  })

  test('the cap survives the round-trip THROUGH the database, not just the return value', async () => {
    // The in-memory object could be right while the column write is wrong; the
    // launcher reads a rehydrated row, so that is what has to say ten.
    const store = new TridentRunStore(db)
    const created = await createRun()
    const rehydrated = await store.get(created.id)
    expect(rehydrated?.max_rounds).toBe(EXPECTED_CAP)
  })

  test('an EXPLICIT cap still wins — the default did not become a floor or a clamp', async () => {
    const run = await createRun({ max_rounds: 2 })
    expect(run.max_rounds).toBe(2)
  })

  test('the launcher THREADS that cap to the workflow as maxRounds', async () => {
    const run = await createRun()
    const args = buildWorkflowArgs({
      run,
      base_branch: 'main',
      db_path: join(tmp, 'project.db'),
      max_rounds: run.max_rounds,
      resume_checkpoint: null,
    } as Parameters<typeof buildWorkflowArgs>[0])

    // Present AND ten. `toBe` on an absent key would read as `undefined` and the
    // assertion below about the fallback would then be the only thing left.
    expect(Object.hasOwn(args, 'maxRounds')).toBe(true)
    expect(args['maxRounds']).toBe(EXPECTED_CAP)
  })

  test('the fix loop runs rounds 2..10 and then REFUSES — nine fix rounds, no eleventh', async () => {
    // `inner-workflow.mjs` is NOT executable here — its `agent`/`parallel`/`phase`
    // globals are injected by the Workflow runtime and it ends in a top-level
    // `return` (see the header of inner-workflow.test.ts). So the loop is
    // RE-EXECUTED as a faithful model: the cap comes from the real store, and the
    // model's shape is pinned to the script by the source assertions in the
    // describe block below (the three-clause predicate AND the `round++` step).
    // Without that pinning this would only be arithmetic; with it, a script whose
    // predicate or step changed makes those tests red.
    const run = await createRun()
    const cap = run.max_rounds

    const visited: number[] = []
    let round = 1
    // Verbatim shape of the script's `while`: REQUEST_CHANGES (never converges,
    // the worst case) + `round < maxRounds` + not infra-only.
    // Typed as the script's runtime values (plain strings), not literals — the
    // point is to evaluate the predicate, not to have TS fold it to a constant.
    const verdict: string = 'REQUEST_CHANGES'
    const blockKind: string = 'code'
    while (verdict === 'REQUEST_CHANGES' && round < cap && blockKind !== 'infra-only') {
      round++ // the script's step — one round per iteration
      visited.push(round)
    }

    // The EXACT rounds a never-converging lane gets. Round 3 is the discriminating
    // one: under the old fallback of 3, `3 < 3` was false and the lane stopped
    // there. An off-by-one or a `round += 2` step changes this list.
    expect(visited).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(visited).toContain(3)
    // Nine fix rounds after the round-1 build, and the loop TERMINATES: a cap that
    // stopped refusing would be the worse bug, since a non-converging lane would
    // spend forever instead of stopping and reporting.
    expect(visited.length).toBe(9)
    expect(round).toBe(cap)
    expect(round < cap).toBe(false)
  })
})

describe('review-round cap — the two knobs may not drift apart', () => {
  // Read the fallback OUT of the script rather than restating it: a test that
  // wrote `10` of its own accord would pass against a script that still said 3.
  const declared = /^\s*maxRounds = (\d+),$/m.exec(SRC)

  test('the fallback literal was FOUND in inner-workflow.mjs (the read MATCHED)', () => {
    // Asserted first and alone. Every assertion below is vacuous if this regex
    // matched nothing — it would compare `NaN` and report a green suite about a
    // value it never read. This is the failure that has to be visible.
    expect(declared).not.toBeNull()
    expect(Number.isInteger(Number(declared?.[1]))).toBe(true)
  })

  test('the fallback equals the cap the store persists', async () => {
    const run = await createRun()
    expect(Number(declared?.[1])).toBe(run.max_rounds)
  })

  // These three pin the MODEL above to the real script. The script cannot be
  // executed under bun, so if its predicate or its step drifts, the model silently
  // stops describing it — that is the way a green suite stops meaning anything.
  test('the loop still gates on `round < maxRounds` — strictly less-than', () => {
    // A rewrite to `<=` would give an extra round past the cap while every
    // arithmetic assertion above still passed.
    expect(SRC).toMatch(/round < maxRounds/)
    expect(SRC).not.toMatch(/round <= maxRounds/)
  })

  test('the loop STEPS by exactly one round per iteration', () => {
    // The concrete drift this catches: `round++` -> `round += 2` would skip
    // rounds, so a lane would get five fix rounds instead of nine while the cap
    // literal still read 10.
    const loop = /while \(\s*\n\s*finalVerdict === 'REQUEST_CHANGES' &&\s*\n\s*round < maxRounds &&\s*\n\s*synthesis\.blockKind !== 'infra-only'\s*\n\s*\) \{\s*\n\s*round\+\+\s*\n/.exec(SRC)
    // Proved to have MATCHED before anything is concluded from it.
    expect(loop).not.toBeNull()
  })

  test('the loop guards all THREE clauses — verdict, cap, and infra-only', () => {
    // Dropping the infra-only clause would spend the (now larger) round budget
    // re-Forging against a review that never ran.
    expect(SRC).toContain("finalVerdict === 'REQUEST_CHANGES' &&")
    expect(SRC).toContain("synthesis.blockKind !== 'infra-only'")
  })
})
