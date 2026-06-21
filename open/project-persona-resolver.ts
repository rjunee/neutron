/**
 * @neutronai/open — per-project persona resolver (WAVE 2 Track A, P0-4).
 *
 * gap-audit §(b) cat 2 (`docs/research/vajra-neutron-daily-driver-gap-audit-
 * 2026-06-20.md`): the `projects` table already carries a free-form `persona`
 * label (e.g. "Forge — pragmatic build agent"), written by the settings drawer
 * + onboarding, but NOTHING read it into a chat turn — every project topic
 * spoke with the same instance-wide persona. This builds the seam the live-agent
 * turn consults so each project topic's dedicated warm CC session adopts ITS
 * persona on top of the owner-wide SOUL/USER doctrine.
 *
 * The resolver is a closure over the live `ProjectDb`, re-run on every project
 * topic's FIRST turn (NOT a captured value), so a persona edited mid-session
 * lands on the next cold topic. Best-effort by contract: a transient SQLite
 * error logs + returns null so the turn degrades to the owner-wide persona
 * alone rather than failing — mirrors the persona-loader's never-hard-fail rule.
 */

import type { ProjectDb } from '../persistence/index.ts'

interface PersonaRow {
  persona: string | null
}

/**
 * Build a `(project_id) => string | null` resolver over the canonical
 * `projects.persona` column. Returns the trimmed persona label for a live
 * (non-soft-deleted) project, or null when the project is missing, the label
 * is NULL / empty / whitespace, or the read throws.
 */
export function buildProjectPersonaResolver(
  db: ProjectDb,
): (project_id: string) => string | null {
  return (project_id: string): string | null => {
    try {
      const row = db
        .prepare<PersonaRow, [string]>(
          `SELECT persona FROM projects WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(project_id)
      const persona = row?.persona ?? null
      if (persona === null) return null
      const trimmed = persona.trim()
      return trimmed.length > 0 ? trimmed : null
    } catch (err) {
      console.warn(
        `[open] project-persona read threw for project=${project_id} — falling back to owner-wide persona:`,
        err,
      )
      return null
    }
  }
}
