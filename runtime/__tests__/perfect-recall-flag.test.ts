/**
 * RB1 / RC2 — the ONE canonical perfect-recall flag (`runtime/perfect-recall-flag.ts`).
 *
 * The whole R-behavior block (RB1 memory-index, RB2/3/4, RC2/RC3 nexus) flips on
 * a SINGLE opt-in var, `NEUTRON_PERFECT_RECALL`, parsed off the shared opt-in /
 * opt-out token vocabulary (`env-flag-tokens.ts`). This pins the full accepted /
 * rejected token boundary — including the whitespace-trim `'  true  '` case that
 * gives RC2 env-read parity — so the gate can never silently widen or narrow.
 *
 * `gateway/nexus/nexus-emit.ts` re-exports THIS predicate; that re-export is
 * covered against the identical matrix in `gateway/nexus/__tests__/nexus-emit.test.ts`.
 */
import { describe, expect, it } from 'bun:test'

import {
  PERFECT_RECALL_FLAG,
  isPerfectRecallEnabled,
} from '../perfect-recall-flag.ts'

/** Values that must OPT IN (→ true). */
const ACCEPTED = ['1', 'true', 'on', 'enabled', 'yes', 'all', '  true  '] as const
/** Values that must NOT opt in (→ false, the default-off contract). */
const REJECTED = ['', 'off', 'false', '0', 'no', 'none', 'disabled', '   '] as const

describe('isPerfectRecallEnabled — token boundary', () => {
  it('the var name is the canonical NEUTRON_PERFECT_RECALL', () => {
    expect(PERFECT_RECALL_FLAG).toBe('NEUTRON_PERFECT_RECALL')
  })

  it('unset / undefined → false (default off)', () => {
    expect(isPerfectRecallEnabled({})).toBe(false)
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: undefined })).toBe(false)
    // Default arg is process.env — call with no arg to prove it does not throw
    // and (in CI, where the flag is unset) resolves to the default-off state.
    expect(typeof isPerfectRecallEnabled()).toBe('boolean')
  })

  for (const raw of ACCEPTED) {
    it(`opt-in token ${JSON.stringify(raw)} → true`, () => {
      expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: raw })).toBe(true)
    })
  }

  for (const raw of REJECTED) {
    it(`opt-out / non-token ${JSON.stringify(raw)} → false`, () => {
      expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: raw })).toBe(false)
    })
  }

  it('is case-insensitive (folds before matching)', () => {
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: 'TRUE' })).toBe(true)
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: 'On' })).toBe(true)
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: 'OFF' })).toBe(false)
  })

  it('trims surrounding whitespace before matching (RC2 env-read parity)', () => {
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: '  true  ' })).toBe(true)
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: '\t1\n' })).toBe(true)
    // Whitespace-only trims to '' → the empty opt-out token → false.
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: '   ' })).toBe(false)
    // A non-token with surrounding space stays a non-token (→ false).
    expect(isPerfectRecallEnabled({ NEUTRON_PERFECT_RECALL: '  maybe  ' })).toBe(false)
  })
})
