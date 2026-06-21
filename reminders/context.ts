/**
 * @neutronai/reminders — fire-time context source.
 *
 * Gathers the live context a reminder is composed against. Vajra's reminder
 * agent shells weather / calendar / STATUS at fire time; Open's first-cut
 * source reads what is already on disk in the owner workspace — the project's
 * `STATUS.md` — which is the load-bearing one for "nag toward the goal" and
 * "what is the state of this project" nudges. It is degrade-safe: any missing
 * file or read error yields empty context (the composer then works from the
 * intent + clock alone), never a throw.
 *
 * Calendar / weather sources can be layered behind the same `gather` seam as
 * the corresponding Cores become reachable from the gateway (audit § 9).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sanitizeProjectId } from '../channels/adapters/app-ws/envelope.ts'
import type { ReminderContextSource } from './dispatcher.ts'
import type { Reminder } from './store.ts'

/** Cap STATUS.md context so a sprawling file can't blow the composition prompt. */
const STATUS_MD_CHAR_CAP = 4_000

export interface BuildStatusMdContextSourceInput {
  /** Owner workspace root — projects live under `<owner_home>/Projects/<slug>/`. */
  owner_home: string
  /** Override the per-char cap (tests). */
  char_cap?: number
  log?: (msg: string) => void
}

/**
 * Build a context source that reads
 * `<owner_home>/Projects/<destination_project_id>/STATUS.md` for the
 * reminder's DESTINATION project. The destination id is derived from the
 * reminder's `topic_id` upstream (`deriveReminderProjectId`) and passed in —
 * it is NOT `reminder.project_slug` (the fixed instance/owner slug), which for
 * project reminders would point at the wrong / empty STATUS.md.
 *
 * The id is sanitized (`sanitizeProjectId`) before it becomes a path segment
 * so a malformed/hostile project id can't traverse out of `Projects/`. Returns
 * an empty string when the id is unsafe, or the file is absent or unreadable.
 */
export function buildStatusMdContextSource(
  input: BuildStatusMdContextSourceInput,
): ReminderContextSource {
  const cap = input.char_cap ?? STATUS_MD_CHAR_CAP
  return {
    gather(_reminder: Reminder, project_id: string): string {
      const safe = sanitizeProjectId(project_id)
      if (safe === null) {
        input.log?.(`[reminder-context] unsafe project id ${JSON.stringify(project_id)} — skipping STATUS.md`)
        return ''
      }
      const path = join(input.owner_home, 'Projects', safe, 'STATUS.md')
      try {
        if (!existsSync(path)) return ''
        const body = readFileSync(path, 'utf8')
        const clipped = body.length > cap ? `${body.slice(0, cap)}\n…(truncated)` : body
        return `Project ${safe} STATUS.md:\n${clipped}`
      } catch (err) {
        input.log?.(`[reminder-context] STATUS.md read failed for ${safe}: ${String(err)}`)
        return ''
      }
    },
  }
}
