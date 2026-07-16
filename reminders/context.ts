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
import { join, resolve, sep } from 'node:path'

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { createLogger } from '@neutronai/logger'
import type { ReminderContextSource } from './dispatcher.ts'
import type { Reminder } from './store.ts'

const contextLog = createLogger('reminder-context')

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
 * it is NOT `reminder.owner_slug` (the fixed instance/owner slug), which for
 * project reminders would point at the wrong / empty STATUS.md.
 *
 * The id is sanitized (`sanitizeProjectId`) before it becomes a path segment,
 * AND the resolved path is verified to stay under `<owner_home>/Projects/` —
 * `sanitizeProjectId` permits dots, so a bare `..` segment passes the charset
 * check but would resolve to `<owner_home>/STATUS.md`; the containment check
 * rejects it. Returns an empty string when the id is unsafe, escapes the
 * projects root, or the file is absent or unreadable.
 */
export function buildStatusMdContextSource(
  input: BuildStatusMdContextSourceInput,
): ReminderContextSource {
  const cap = input.char_cap ?? STATUS_MD_CHAR_CAP
  const projectsRoot = resolve(input.owner_home, 'Projects')
  const log = input.log ?? ((msg: string): void => contextLog.debug(msg))
  return {
    gather(_reminder: Reminder, project_id: string): string {
      const safe = sanitizeProjectId(project_id)
      if (safe === null) {
        log(`[reminder-context] unsafe project id ${JSON.stringify(project_id)} — skipping STATUS.md`)
        return ''
      }
      // `sanitizeProjectId` allows dots, so a `.`/`..` segment slips the charset
      // gate. Reject dot-only ids outright, then verify the resolved path is
      // still strictly inside `Projects/` before any read (defense in depth).
      if (safe === '.' || safe === '..') {
        log(`[reminder-context] project id ${JSON.stringify(project_id)} is a dot segment — skipping STATUS.md`)
        return ''
      }
      const path = join(projectsRoot, safe, 'STATUS.md')
      if (!path.startsWith(projectsRoot + sep)) {
        log(`[reminder-context] project id ${JSON.stringify(project_id)} escapes Projects/ — skipping STATUS.md`)
        return ''
      }
      try {
        if (!existsSync(path)) return ''
        const body = readFileSync(path, 'utf8')
        const clipped = body.length > cap ? `${body.slice(0, cap)}\n…(truncated)` : body
        return `Project ${safe} STATUS.md:\n${clipped}`
      } catch (err) {
        log(`[reminder-context] STATUS.md read failed for ${safe}: ${String(err)}`)
        return ''
      }
    },
  }
}
