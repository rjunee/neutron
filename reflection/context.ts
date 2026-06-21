/**
 * @neutronai/reflection — context assembly.
 *
 * Turns the persisted diary + corrections-log into a compact prompt block the
 * live-agent turn splices into its FIRST-turn system context (where it adopts
 * persona, scope, and recent-conversation history). This is what makes the
 * layer a real feedback loop rather than a write-only sink: every fresh agent
 * session re-reads its accumulated corrections and recent reflections and
 * applies them SILENTLY.
 *
 * Returns `null` when there is nothing to inject (fresh instance) so the caller
 * can omit the fragment entirely.
 */

import { readRecentCorrections } from './corrections-store.ts'
import { readRecentDiary } from './diary-store.ts'

export interface BuildReflectionContextInput {
  ownerDataDir: string
  /** Max corrections to surface (newest-first). Defaults to 12. */
  corrections_limit?: number
  /** Trailing UTC days of diary to surface. Defaults to 3. */
  diary_days?: number
  /** Max diary entries to surface. Defaults to 8. */
  diary_limit?: number
  /** Override the wall clock (tests). */
  now?: number
}

/**
 * Build the `<learned_corrections>` + `<recent_diary>` block, or `null` if both
 * are empty. Best-effort: a read error in either store degrades that section to
 * empty rather than throwing into the turn.
 */
export function buildReflectionContext(input: BuildReflectionContextInput): string | null {
  let corrections: ReturnType<typeof readRecentCorrections> = []
  try {
    corrections = readRecentCorrections({
      ownerDataDir: input.ownerDataDir,
      limit: input.corrections_limit ?? 12,
    })
  } catch {
    corrections = []
  }

  let diary: ReturnType<typeof readRecentDiary> = []
  try {
    diary = readRecentDiary({
      ownerDataDir: input.ownerDataDir,
      days: input.diary_days ?? 3,
      limit: input.diary_limit ?? 8,
      ...(input.now !== undefined ? { now: input.now } : {}),
    })
  } catch {
    diary = []
  }

  if (corrections.length === 0 && diary.length === 0) return null

  const parts: string[] = []

  if (corrections.length > 0) {
    const lines = corrections.map((c) => {
      const was = c.wrong.length > 0 ? ` (was: ${c.wrong})` : ''
      const why = c.why.length > 0 ? ` — why: ${c.why}` : ''
      return `- ${c.right}${was}${why}`
    })
    parts.push(
      [
        '<learned_corrections>',
        'Things the owner has corrected you on before. Apply them SILENTLY going',
        'forward — do NOT announce that you remember or noted them:',
        ...lines,
        '</learned_corrections>',
      ].join('\n'),
    )
  }

  if (diary.length > 0) {
    const lines = diary.map((e) => `- ${e.date}: ${e.text}`)
    parts.push(
      [
        '<recent_diary>',
        'Your own recent short reflections, for continuity across sessions:',
        ...lines,
        '</recent_diary>',
      ].join('\n'),
    )
  }

  return parts.join('\n')
}
