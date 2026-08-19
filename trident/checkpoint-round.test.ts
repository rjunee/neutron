import { describe, expect, test } from 'bun:test'
import { checkpointRound } from './checkpoint-round.ts'

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
