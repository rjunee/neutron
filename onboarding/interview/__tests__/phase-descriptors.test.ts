/**
 * D9d — single-source per-phase descriptor collapse.
 *
 * Pins the exhaustiveness contract that makes the interview-engine table
 * split durable: `PHASE_DESCRIPTORS` is the ONE authored per-phase table,
 * and `PHASE_INTENTS` / `PHASE_KNOWLEDGE` are DERIVED VIEWS projected off it.
 * Adding a phase must touch exactly one place; these assertions (plus the
 * `Readonly<Record<OnboardingPhase, PhaseDescriptor>>` compile-time barrier
 * and the module-load runtime guard) enforce that.
 */
import { describe, expect, test } from 'bun:test'
import { ALL_PHASES } from '@neutronai/contracts/onboarding-phase.ts'
import {
  PHASE_DESCRIPTORS,
  PHASE_INTENTS,
  PHASE_KNOWLEDGE,
} from '../phase-spec-resolver.ts'

describe('PHASE_DESCRIPTORS — single-source exhaustiveness', () => {
  test('has exactly one descriptor per OnboardingPhase (no missing, no extra)', () => {
    const descriptorKeys = Object.keys(PHASE_DESCRIPTORS).sort()
    const phaseKeys = [...ALL_PHASES].sort()
    expect(descriptorKeys).toEqual(phaseKeys)
    // Every phase resolves to an object carrying both fields.
    for (const phase of ALL_PHASES) {
      const d = PHASE_DESCRIPTORS[phase]
      expect(d).toBeDefined()
      expect('intent' in d).toBe(true)
      expect('knowledge' in d).toBe(true)
    }
  })

  test('PHASE_INTENTS is the intent projection of PHASE_DESCRIPTORS', () => {
    expect(Object.keys(PHASE_INTENTS).sort()).toEqual(
      Object.keys(PHASE_DESCRIPTORS).sort(),
    )
    for (const phase of ALL_PHASES) {
      expect(PHASE_INTENTS[phase]).toBe(PHASE_DESCRIPTORS[phase].intent)
    }
  })

  test('PHASE_KNOWLEDGE is the knowledge projection of PHASE_DESCRIPTORS', () => {
    expect(Object.keys(PHASE_KNOWLEDGE).sort()).toEqual(
      Object.keys(PHASE_DESCRIPTORS).sort(),
    )
    for (const phase of ALL_PHASES) {
      expect(PHASE_KNOWLEDGE[phase]).toBe(PHASE_DESCRIPTORS[phase].knowledge)
    }
  })

  test('externally-driven phases carry null intent AND null knowledge', () => {
    const external = [
      'identity_oauth',
      'instance_provisioned',
      'import_running',
      'persona_synthesizing',
      'completed',
      'failed',
    ] as const
    for (const phase of external) {
      expect(PHASE_DESCRIPTORS[phase].intent).toBeNull()
      expect(PHASE_DESCRIPTORS[phase].knowledge).toBeNull()
    }
  })

  test('specially-cased phases (slug_chosen, projects_proposed) have null intent but a knowledge pack', () => {
    for (const phase of ['slug_chosen', 'projects_proposed'] as const) {
      expect(PHASE_DESCRIPTORS[phase].intent).toBeNull()
      expect(PHASE_DESCRIPTORS[phase].knowledge).not.toBeNull()
    }
  })
})
