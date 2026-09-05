import { describe, expect, test } from 'bun:test'
import {
  checkpointRound,
  checkpointRoundField,
  MAX_CHECKPOINT_ROUND,
  OUTER_PUBLISHED_CHECKPOINT,
} from './checkpoint-round.ts'

const OID = 'a'.repeat(40)

describe('checkpointRound', () => {
  test.each([
    ['fix-round-2', 2],
    ['fix-round-7', 7],
    ['fix-round-12', 12],
  ])('parses %s', (checkpoint, round) => {
    expect(checkpointRound(checkpoint)).toBe(round)
  })

  test('reads the last numeric outer-published field, not remaining tasks', () => {
    expect(checkpointRound(`outer-published:${OID}:3:1`)).toBe(1)
    expect(checkpointRound(`outer-published:${OID}:0:4`)).toBe(4)
    expect(checkpointRound(`outer-published:${OID}:2:6:deviated`)).toBe(6)
  })

  test.each([
    null,
    '',
    'forge-done',
    'argus-approved',
    'argus-request-changes',
    'argus-request-changes-round-7',
    'pr-merged',
    'inner-error',
    'ralph-task-built',
    'fix-round-',
    'fix-round-x',
    'outer-published:nothex:3:1',
    `outer-published:${OID}:3`,
  ])('does not guess a round for %p', (checkpoint) => {
    expect(checkpointRound(checkpoint)).toBeNull()
  })
})

// ARGUS r10 (minor): `OUTER_PUBLISHED_CHECKPOINT` bounds the round at nine
// digits and the docblock claimed "no writer in this repo can emit such a
// round" — but the round on the write side comes from `parseInnerResult`, i.e.
// from substrate JSON, and the orchestrator interpolated it verbatim. The old
// safety argument ("both consumers fall back to the ordinary recoverable
// answer") predates the settle-timeout gate: "not published" now feeds
// TERMINALIZATION of a run that did publish. So the bound is enforced where the
// marker is written.
describe('checkpointRoundField — the writer cannot emit a round its readers reject', () => {
  test.each([
    [0, 0],
    [1, 1],
    [7, 7],
    [MAX_CHECKPOINT_ROUND, MAX_CHECKPOINT_ROUND],
  ])('passes an in-bound round through unchanged (%p)', (round, expected) => {
    expect(checkpointRoundField(round)).toBe(expected)
  })

  test.each([
    [MAX_CHECKPOINT_ROUND + 1, MAX_CHECKPOINT_ROUND],
    [10_000_000_000, MAX_CHECKPOINT_ROUND],
    [Number.MAX_SAFE_INTEGER, MAX_CHECKPOINT_ROUND],
  ])('clamps an over-bound round (%p)', (round, expected) => {
    expect(checkpointRoundField(round)).toBe(expected)
  })

  test.each([[-1], [-0.5], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [null], [undefined]])(
    'reads %p as no round at all',
    (round) => {
      expect(checkpointRoundField(round as number | null | undefined)).toBe(0)
    },
  )

  test('a non-integer round is floored rather than written with a dot', () => {
    expect(checkpointRoundField(3.9)).toBe(3)
  })

  // THE POINT OF THE CLAMP, end to end: whatever the substrate reported, the
  // marker this builds is one the gate reads back as PUBLISHED.
  test.each([[10_000_000_000], [Number.NaN], [-4], [2.5], [3]])(
    'the marker built from round %p is still parsed as published',
    (round) => {
      const checkpoint = `outer-published:${OID}:0:${checkpointRoundField(round)}`
      expect(OUTER_PUBLISHED_CHECKPOINT.test(checkpoint)).toBe(true)
      expect(checkpointRound(checkpoint)).not.toBeNull()
    },
  )
})
