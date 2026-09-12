/**
 * ONE CLOSED SET OF LANES, AND THIS SURFACE'S STATEMENT OF IT.
 *
 * `work_board_items.status` is declared in the SQL CHECK, in the store's type, in the
 * wire envelope, and in each of the two clients that decode a frame. They are separate
 * files by necessity — the wire module is dependency-free and the clients cannot import
 * the store — so the only thing keeping them one set is that somebody changes all of
 * them. Twice now somebody did not: 0130's `archived` and 0140's `blocked` widened some
 * and not others, and the client decoders then DROPPED those cards rather than rendering
 * them, which is worse than rendering them wrong.
 *
 * This pins THIS package's runtime list to the CHECK constraint in the committed schema
 * snapshot — the one statement of the set a database will actually enforce.
 *
 * WHY THIS IS TWO FILES AND NOT ONE. A single test importing both clients has to cross a
 * package boundary, and the cross-workspace lint gate requires a package specifier for
 * it. Measured: importing `@neutronai/landing/chat-react/work-board-client.ts` into a
 * `bun test` process makes a LATER lazy `Bun.build` of `landing/chat-react/main.tsx` in
 * that same process fail — so the landing server's own bundle tests 404'd whenever the
 * chunker put them in the same chunk. Each surface therefore pins itself to the same
 * third authority, independently. Nothing is lost: a lane missing from either list is
 * still caught, by whichever file names it.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORK_BOARD_STATUSES } from '../work-board-client.ts'

/** The lanes the DATABASE will accept, read out of the committed schema snapshot. */
function statusesFromSchema(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const schema = readFileSync(join(here, '..', '..', '..', 'migrations', 'expected-schema.txt'), 'utf8')
  const at = schema.indexOf('[table] work_board_items')
  if (at === -1) throw new Error('work_board_items is not in the schema snapshot')
  const check = /CHECK \(status IN \(([^)]*)\)\)/.exec(schema.slice(at))
  if (check === null) throw new Error('the status CHECK constraint is not in the snapshot')
  return (check[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
}

describe('work_board_items.status — the web client and the database agree', () => {
  test('the schema snapshot really does declare the CHECK (the read MATCHED)', () => {
    const fromSchema = statusesFromSchema()
    expect(fromSchema.length).toBeGreaterThan(1)
    expect(fromSchema).toContain('upcoming')
  })

  test('the decoder accepts exactly the lanes the database will store', () => {
    expect([...WORK_BOARD_STATUSES].slice().sort()).toEqual(
      statusesFromSchema().sort() as (typeof WORK_BOARD_STATUSES)[number][],
    )
  })

  test('`blocked` is in both — the lane this test was written for', () => {
    expect(statusesFromSchema()).toContain('blocked')
    expect(WORK_BOARD_STATUSES as readonly string[]).toContain('blocked')
  })

  test('so is `archived`, which is how we know this drift is a repeat and not a one-off', () => {
    expect(statusesFromSchema()).toContain('archived')
    expect(WORK_BOARD_STATUSES as readonly string[]).toContain('archived')
  })
})
