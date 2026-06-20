/**
 * P2 v2 § 4.2 / § 4.4 — required-fields audit unit tests.
 *
 * Priority order (Sam-locked 2026-05-15):
 *   user_first_name → primary_projects (≥3) → non_work_interests (≥1) →
 *   agent_personality → agent_name.
 *
 * The audit returns `{filled, missing, next_to_collect}`; `next_to_collect`
 * is the highest-priority missing field (the field the gap-fill handler
 * should ask for next), or null when all five are filled.
 */

import { describe, expect, test } from 'bun:test'
import {
  auditRequiredFields,
  type RequiredField,
  type RequiredFieldsState,
} from '../required-fields-audit.ts'

const FULL_STATE: RequiredFieldsState = {
  user_first_name: 'Casey',
  primary_projects: ['Brand A', 'Brand B', 'Brand C'],
  non_work_interests: ['yoga'],
  agent_personality: 'warm thinking-partner',
  agent_name: 'Sage',
}

describe('auditRequiredFields — happy path', () => {
  test('all five filled → empty missing, next_to_collect null', () => {
    const audit = auditRequiredFields(FULL_STATE)
    expect(audit.filled).toEqual([
      'user_first_name',
      'primary_projects',
      'non_work_interests',
      'agent_personality',
      'agent_name',
    ])
    expect(audit.missing).toEqual([])
    expect(audit.next_to_collect).toBeNull()
  })
})

describe('auditRequiredFields — priority order', () => {
  test('user_first_name missing → next_to_collect=user_first_name (highest priority)', () => {
    const audit = auditRequiredFields({ ...FULL_STATE, user_first_name: null })
    expect(audit.next_to_collect).toBe('user_first_name')
    expect(audit.missing).toEqual(['user_first_name'])
    expect(audit.filled).toEqual([
      'primary_projects',
      'non_work_interests',
      'agent_personality',
      'agent_name',
    ])
  })

  test('primary_projects has 2 entries → still missing (≥3 floor)', () => {
    const audit = auditRequiredFields({
      ...FULL_STATE,
      primary_projects: ['Brand A', 'Brand B'],
    })
    expect(audit.next_to_collect).toBe('primary_projects')
  })

  test('primary_projects at exactly 3 → filled (boundary)', () => {
    const audit = auditRequiredFields({
      ...FULL_STATE,
      primary_projects: ['A', 'B', 'C'],
    })
    expect(audit.next_to_collect).toBeNull()
    expect(audit.filled).toContain('primary_projects')
  })

  test('primary_projects filled + non_work_interests empty → next_to_collect=non_work_interests', () => {
    const audit = auditRequiredFields({
      ...FULL_STATE,
      non_work_interests: [],
    })
    expect(audit.next_to_collect).toBe('non_work_interests')
    expect(audit.missing).toEqual(['non_work_interests'])
  })

  test('agent_personality missing only → next_to_collect=agent_personality', () => {
    const audit = auditRequiredFields({ ...FULL_STATE, agent_personality: '' })
    expect(audit.next_to_collect).toBe('agent_personality')
  })

  test('agent_name missing only → next_to_collect=agent_name (lowest priority)', () => {
    const audit = auditRequiredFields({ ...FULL_STATE, agent_name: '   ' })
    expect(audit.next_to_collect).toBe('agent_name')
  })

  test('multiple missing → highest-priority field surfaces first', () => {
    const audit = auditRequiredFields({
      // user_first_name filled, primary_projects empty, agent_name empty
      user_first_name: 'Casey',
      primary_projects: [],
      non_work_interests: ['yoga'],
      agent_personality: 'warm thinking-partner',
      agent_name: null,
    })
    expect(audit.next_to_collect).toBe('primary_projects')
    expect(audit.missing).toEqual(['primary_projects', 'agent_name'])
  })
})

describe('auditRequiredFields — empty / malformed state', () => {
  test('empty state → all missing, priority order preserved', () => {
    const audit = auditRequiredFields({})
    expect(audit.filled).toEqual([])
    expect(audit.missing).toEqual([
      'user_first_name',
      'primary_projects',
      'non_work_interests',
      'agent_personality',
      'agent_name',
    ])
    expect(audit.next_to_collect).toBe('user_first_name')
  })

  test('whitespace-only strings are NOT filled', () => {
    const audit = auditRequiredFields({
      user_first_name: '   ',
      primary_projects: ['A', 'B', 'C'],
      non_work_interests: ['yoga'],
      agent_personality: '\n\t',
      agent_name: 'Sage',
    })
    expect(audit.missing).toEqual(['user_first_name', 'agent_personality'])
    expect(audit.next_to_collect).toBe('user_first_name')
  })

  test('non-array primary_projects → missing', () => {
    // Caller may have written a stringified blob by accident; audit must
    // reject non-array shapes structurally.
    const audit = auditRequiredFields({
      ...FULL_STATE,
      primary_projects: 'A, B, C' as unknown as ReadonlyArray<string>,
    })
    expect(audit.next_to_collect).toBe('primary_projects')
  })

  test('result order matches PRIORITY, not insertion order on input', () => {
    // Insertion order on the input object is agent_name-first; the audit
    // must still emit filled[] in priority order.
    const audit = auditRequiredFields({
      agent_name: 'Sage',
      agent_personality: 'warm',
      non_work_interests: ['yoga'],
      primary_projects: ['A', 'B', 'C'],
      user_first_name: 'Casey',
    })
    expect(audit.filled).toEqual([
      'user_first_name',
      'primary_projects',
      'non_work_interests',
      'agent_personality',
      'agent_name',
    ])
  })
})

describe('auditRequiredFields — tolerant input shape', () => {
  test('plain Record<string, unknown> works (engine passes the phase_state blob)', () => {
    const blob: Record<string, unknown> = {
      user_first_name: 'Casey',
      primary_projects: ['A', 'B', 'C'],
      non_work_interests: ['yoga'],
      agent_personality: 'warm',
      agent_name: 'Sage',
      // unrelated keys ignored
      ai_substrate_used: 'chatgpt',
      attempt_count: 0,
    }
    const audit = auditRequiredFields(blob)
    expect(audit.next_to_collect).toBeNull()
  })

  test('RequiredField union type-checks at use sites', () => {
    const f: RequiredField = 'user_first_name'
    expect(f).toBe('user_first_name')
  })
})
