/**
 * ONE CLOSED SET OF LANES, FOUR PLACES THAT STATE IT.
 *
 * `work_board_items.status` is declared in the SQL CHECK, in the store's type, in the
 * wire envelope, and in each of the two clients that decode a frame. They are separate
 * files by necessity — the wire module is dependency-free and the clients cannot import
 * the store — so the only thing keeping them one set is that somebody changes all of
 * them. Twice now somebody did not: 0130's `archived` and 0140's `blocked` widened some
 * and not others, and the client decoders then DROPPED those cards rather than
 * rendering them, which is worse than rendering them wrong.
 *
 * This is the test that makes the next omission loud. It compares the RUNTIME values
 * the clients actually gate on against the CHECK constraint in the committed schema
 * snapshot, which is the one statement of the set that a database will enforce.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// IT LIVES IN `app/` because that is the only package that can legally see both: the
// cross-workspace lint gate requires a package specifier for the other one, and `app`
// already depends on `@neutronai/landing`. Put the other way round it would need a
// dependency `landing` does not have.
import { WORK_BOARD_STATUSES as WEB_STATUSES } from '@neutronai/landing/chat-react/work-board-client.ts'
import { WORK_BOARD_STATUSES as APP_STATUSES } from '../lib/work-board-client';

/** The lanes the DATABASE will accept, read out of the committed schema snapshot. */
function statusesFromSchema(): string[] {
  // `fileURLToPath(new URL(...))` is the idiom elsewhere in the repo, but this package's
  // tsconfig types `URL` from the RN lib, where it is not the node one — so the path is
  // composed from this file's own directory instead.
  const here = dirname(fileURLToPath(import.meta.url))
  const schema = readFileSync(join(here, '..', '..', 'migrations', 'expected-schema.txt'), 'utf8')
  const at = schema.indexOf('[table] work_board_items')
  if (at === -1) throw new Error('work_board_items is not in the schema snapshot')
  const check = /CHECK \(status IN \(([^)]*)\)\)/.exec(schema.slice(at))
  if (check === null) throw new Error('the status CHECK constraint is not in the snapshot')
  return (check[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
}

describe('work_board_items.status — the four statements of one closed set', () => {
  test('the schema snapshot really does declare the CHECK (the read MATCHED)', () => {
    // Asserted first and alone: every comparison below is vacuous if this regex matched
    // nothing, and would then report a green suite about a list it never read.
    const fromSchema = statusesFromSchema()
    expect(fromSchema.length).toBeGreaterThan(1)
    expect(fromSchema).toContain('upcoming')
  })

  test('both client decoders accept exactly the lanes the database will store', () => {
    const fromSchema = statusesFromSchema().slice().sort()
    expect([...WEB_STATUSES].slice().sort()).toEqual(fromSchema as typeof WEB_STATUSES[number][])
    expect([...APP_STATUSES].slice().sort()).toEqual(fromSchema as typeof APP_STATUSES[number][])
  })

  test('`blocked` is in every one of them — the lane this test was written for', () => {
    // Named explicitly as well as compared, so the failure says WHICH lane went missing
    // rather than only that two sorted arrays differ.
    expect(statusesFromSchema()).toContain('blocked')
    expect(WEB_STATUSES as readonly string[]).toContain('blocked')
    expect(APP_STATUSES as readonly string[]).toContain('blocked')
  })

  test('so is `archived`, which is how we know this drift is a repeat and not a one-off', () => {
    expect(statusesFromSchema()).toContain('archived')
    expect(WEB_STATUSES as readonly string[]).toContain('archived')
    expect(APP_STATUSES as readonly string[]).toContain('archived')
  })
})
