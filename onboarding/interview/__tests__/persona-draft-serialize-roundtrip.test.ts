/**
 * N4 boundary regression — the persona draft serialize/read round-trip.
 *
 * `serializeDraft` writes the draft into the PERSISTED `phase_state`
 * (onboarding_state.phase_state_json) and `readPersonaDraft` reads it back
 * across turns. The persisted key stays the frozen `project_slug` while the
 * TS domain field is `owner_slug`; if the two sides disagree the draft silently
 * fails to read (returns null) and persona review breaks. This pins the
 * round-trip AND that the on-disk key is the frozen `project_slug`.
 */
import { expect, test } from 'bun:test'
import { readPersonaDraft, serializeDraft } from '../engine-internals.ts'
import type { PersonaDraft } from '../../persona-gen/compose.ts'

const validDraft: PersonaDraft = {
  owner_slug: 'acme',
  draft_id: 'd-1',
  soul_md: '# soul',
  user_md: '# user',
  priority_map_md: '# priority',
  cringe_check_flags: { soul: 0, user: 0, priority_map: 0 },
  regen_attempts: { soul: 0, user: 0, priority_map: 0 },
  status: 'draft',
}

test('serializeDraft → readPersonaDraft round-trips (owner_slug survives)', () => {
  const serialized = serializeDraft(validDraft)
  const back = readPersonaDraft({ persona_draft: serialized })
  expect(back).not.toBeNull()
  expect(back?.owner_slug).toBe('acme')
  expect(back?.draft_id).toBe('d-1')
})

test('the PERSISTED phase_state key is the frozen `project_slug`, not `owner_slug`', () => {
  const serialized = serializeDraft(validDraft) as Record<string, unknown>
  expect(serialized['project_slug']).toBe('acme')
  expect(serialized['owner_slug']).toBeUndefined()
})

test('a legacy persisted draft (project_slug key) still reads back', () => {
  // Existing onboarding_state rows persisted BEFORE this rename carry
  // `project_slug` — the reader must still accept them.
  const legacy = {
    project_slug: 'legacy-owner',
    draft_id: 'd-9',
    soul_md: 's',
    user_md: 'u',
    priority_map_md: 'p',
  }
  const back = readPersonaDraft({ persona_draft: legacy })
  expect(back?.owner_slug).toBe('legacy-owner')
})
