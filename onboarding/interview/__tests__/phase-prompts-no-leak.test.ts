/**
 * T11 (2026-05-15) — structural-drift catch for user-facing copy in
 * `STATIC_PHASE_SPECS`. Sam saw the `projects_proposed` body leak the
 * literal "SOUL.md, USER.md, and priority-map.md" filenames in a prod
 * walkthrough — that's the second time a static-fallback body had a
 * filename / implementation-detail leak (the `wow_fired` body was
 * scrubbed in a prior sprint and the audit missed `projects_proposed`).
 *
 * Per CLAUDE.md "Spec is the source of truth — HARD RULE": every
 * user-facing transit / status body in `STATIC_PHASE_SPECS` MUST read
 * like a person describing what they're doing. The persona artifacts
 * keep their canonical filenames on disk; user-visible copy never
 * references them.
 *
 * This test iterates every static spec body + option-label string and
 * rejects any occurrence of the forbidden substrings. A future spec
 * addition that re-introduces a leak will fail here at commit time.
 */

import { describe, expect, test } from 'bun:test'

import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'

// Substrings that are NEVER allowed in a user-visible static body /
// option label. The list is kept tight on purpose — a permissive
// regex would catch unrelated copy. Each entry is a literal substring
// match.
const FORBIDDEN_SUBSTRINGS: ReadonlyArray<string> = [
  'SOUL.md',
  'USER.md',
  'priority-map.md',
  // Path prefixes that name the on-disk persona dir directly.
  'persona/',
  // Catch the lower-cased + variant filename slip-ups too.
  'soul.md',
  'user.md',
]

describe('STATIC_PHASE_SPECS — no implementation-detail leaks (T11)', () => {
  for (const [phase, spec] of Object.entries(STATIC_PHASE_SPECS)) {
    test(`${phase}.body has no forbidden substrings`, () => {
      const body = spec.body
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        expect(body).not.toContain(needle)
      }
    })

    test(`${phase}.options labels + bodies have no forbidden substrings`, () => {
      for (const opt of spec.options) {
        for (const needle of FORBIDDEN_SUBSTRINGS) {
          expect(opt.body).not.toContain(needle)
          expect(opt.label).not.toContain(needle)
        }
      }
    })
  }

  test('every static body is non-empty', () => {
    // Defense-in-depth: a body that gets accidentally blanked out
    // during a future refactor would also be a user-facing failure.
    for (const [phase, spec] of Object.entries(STATIC_PHASE_SPECS)) {
      expect(spec.body.length).toBeGreaterThan(0)
      // No-op `phase` reference to keep the loop variable load-bearing
      // in the failure message that bun emits.
      expect(phase.length).toBeGreaterThan(0)
    }
  })
})
