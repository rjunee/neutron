/**
 * @neutronai/onboarding/api — POST /onboarding/persona-edit (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 2.6 + § 4.8. Applies a single line
 * edit to one persona file in the owner's current draft. Re-runs cringe-
 * check on the edited file. Returns the updated draft + flag count.
 */

import type { PersonaComposer, PersonaDraft, LineEdit } from '../persona-gen/compose.ts'
import { PersonaError } from '../persona-gen/compose.ts'
import type { PersonaFile } from '../persona-gen/cringe-check.ts'

export interface PersonaEditStore {
  latest(owner_slug: string): Promise<PersonaDraft | null>
  put(draft: PersonaDraft): Promise<void>
}

export interface PersonaEditRequest {
  owner_slug: string
  file: PersonaFile
  edit: LineEdit
}

export type PersonaEditStatus = 'ok' | 'no_draft' | 'invalid' | 'error'

export interface PersonaEditResponse {
  status: PersonaEditStatus
  draft?: PersonaDraft
  reason?: string
}

export async function handlePersonaEdit(
  composer: PersonaComposer,
  store: PersonaEditStore,
  req: PersonaEditRequest,
): Promise<PersonaEditResponse> {
  const draft = await store.latest(req.owner_slug)
  if (draft === null) return { status: 'no_draft' }
  let next: PersonaDraft
  try {
    next = await composer.applyEdit({ draft, file: req.file, edit: req.edit })
  } catch (err) {
    if (err instanceof PersonaError && err.code === 'edit_invalid') {
      return { status: 'invalid', reason: err.message }
    }
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
  await store.put(next)
  return { status: 'ok', draft: next }
}
