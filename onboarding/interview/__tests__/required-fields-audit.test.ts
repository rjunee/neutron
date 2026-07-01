/**
 * P2 v2 § 4.2 / § 4.4 — required-fields audit unit tests.
 *
 * Priority order (Sam-locked 2026-05-15, agent_name dropped 2026-07-01):
 *   user_first_name → primary_projects (≥3) → non_work_interests (≥1) →
 *   agent_personality.
 *
 * 2026-07-01 (DROP the agent-NAME step): Neutron Open is an agent ORCHESTRATOR,
 * not a personal agent — onboarding never asks the owner to name it. `agent_name`
 * is therefore NO LONGER an audited required field: it never appears in
 * `filled`/`missing`, and a missing/empty `agent_name` can never gate finalize
 * (`next_to_collect` goes null once the 4 real required fields are filled).
 *
 * The audit returns `{filled, missing, next_to_collect}`; `next_to_collect`
 * is the highest-priority missing field (the field the gap-fill handler
 * should ask for next), or null when all four are filled.
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
}

describe('auditRequiredFields — happy path', () => {
  test('all four required filled → empty missing, next_to_collect null', () => {
    const audit = auditRequiredFields(FULL_STATE)
    expect(audit.filled).toEqual([
      'user_first_name',
      'primary_projects',
      'non_work_interests',
      'agent_personality',
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

  test('agent_personality missing → next_to_collect=agent_personality (lowest priority)', () => {
    const audit = auditRequiredFields({ ...FULL_STATE, agent_personality: '' })
    expect(audit.next_to_collect).toBe('agent_personality')
  })

  test('agent_personality is the LAST required field — filled → finalize-ready', () => {
    const audit = auditRequiredFields(FULL_STATE)
    expect(audit.next_to_collect).toBeNull()
    expect(audit.filled[audit.filled.length - 1]).toBe('agent_personality')
  })

  test('multiple missing → highest-priority field surfaces first', () => {
    const audit = auditRequiredFields({
      user_first_name: 'Casey',
      primary_projects: [],
      non_work_interests: ['yoga'],
      agent_personality: 'warm thinking-partner',
    })
    expect(audit.next_to_collect).toBe('primary_projects')
    expect(audit.missing).toEqual(['primary_projects'])
  })
})

describe('auditRequiredFields — agent_name is NOT required (DROP the agent-NAME step)', () => {
  test('missing agent_name never gates finalize — next_to_collect null with the 4 fields filled', () => {
    // No agent_name key at all — onboarding must still be finalize-ready.
    const audit = auditRequiredFields(FULL_STATE)
    expect(audit.next_to_collect).toBeNull()
    expect(audit.missing).not.toContain('agent_name')
    expect(audit.filled).not.toContain('agent_name')
  })

  test('an empty/whitespace agent_name is irrelevant — audit ignores it entirely', () => {
    const audit = auditRequiredFields({ ...FULL_STATE, agent_name: '   ' })
    expect(audit.next_to_collect).toBeNull()
    expect(audit.missing).toEqual([])
    expect(audit.filled).not.toContain('agent_name')
  })

  test('a set agent_name is still not reported as a required field', () => {
    const audit = auditRequiredFields({ ...FULL_STATE, agent_name: 'Sage' })
    expect(audit.filled).toEqual([
      'user_first_name',
      'primary_projects',
      'non_work_interests',
      'agent_personality',
    ])
    expect(audit.filled).not.toContain('agent_name')
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
    ])
    expect(audit.next_to_collect).toBe('user_first_name')
  })

  test('whitespace-only strings are NOT filled', () => {
    const audit = auditRequiredFields({
      user_first_name: '   ',
      primary_projects: ['A', 'B', 'C'],
      non_work_interests: ['yoga'],
      agent_personality: '\n\t',
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
    // Insertion order on the input object is personality-first; the audit
    // must still emit filled[] in priority order.
    const audit = auditRequiredFields({
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
      // agent_name is a legacy phase_state key — present but ignored by the audit
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
