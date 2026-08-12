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
 * DRIVING the real chain (real migrations → real store → real launcher → the
 * loop's own predicate) rather than by restating a literal, and it pins the two
 * knobs to each other so they cannot drift apart again.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
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
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
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

  test('the fix loop ADMITS round 3 and every round up to nine, and REFUSES at ten', async () => {
    // The loop's own predicate is `round < maxRounds` (inner-workflow.mjs). Round
    // 3 is called out because the fallback used to be 3: under that value `3 < 3`
    // was false. This asserts admission/refusal, not the literal.
    const run = await createRun()
    const cap = run.max_rounds

    for (const round of [1, 2, 3, 4, 9]) {
      expect(round < cap).toBe(true)
    }
    // Still BOUNDED — a cap that stopped refusing would be the worse bug, because
    // a non-converging lane would spend forever instead of stopping and reporting.
    expect(10 < cap).toBe(false)
    expect(11 < cap).toBe(false)
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

  test('the loop still gates on `round < maxRounds`', () => {
    // If this predicate is ever rewritten (e.g. to `<=`), the admission and
    // refusal assertions above are describing a loop that no longer exists.
    expect(SRC).toMatch(/round < maxRounds/)
  })
})
