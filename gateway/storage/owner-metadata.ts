/**
 * @neutronai/gateway/storage — per-project `instance_metadata` reader.
 *
 * Closes ISSUES #40. The P6.1 nudge engine + current-focus surface had been
 * documenting "resolved from `instance_metadata.timezone` at engine invocation"
 * (see migrations/0045_p6_1_nudge_staleness.sql line 21) but neither call
 * site read the table — every instance fell back to `DEFAULT_OWNER_TIMEZONE`
 * regardless of the user's actual zone. This module supplies the missing read
 * so the wiring honours the spec.
 *
 * The `instance_metadata` table is per-project DB (one row per `project_slug`).
 * Migration 0050 creates it; future instance-level fields (locale, week-start,
 * etc.) land as additive columns on the same row.
 */

import type { ProjectDb } from '../../persistence/index.ts'

/**
 * Read the IANA timezone identifier for `project_slug` from `instance_metadata`.
 * Returns the column value (which may be `null` if the row exists but the
 * column was never written), or `null` when no row exists. Callers translate
 * `null` into their default — they DO NOT see the difference between
 * "no row" and "row with NULL timezone."
 */
export function readOwnerTimezone(
  db: ProjectDb,
  project_slug: string,
): string | null {
  const row = db
    .prepare<{ timezone: string | null }, [string]>(
      `SELECT timezone FROM instance_metadata WHERE instance_slug = ? LIMIT 1`,
    )
    .get(project_slug)
  if (row === null || row === undefined) return null
  if (typeof row.timezone !== 'string' || row.timezone.length === 0) {
    return null
  }
  return row.timezone
}

/**
 * Upsert the timezone for `project_slug`. Used by tests + future admin UI.
 * Preserves any other columns on the row by routing the timezone update
 * through `ON CONFLICT … DO UPDATE`.
 */
export async function writeOwnerTimezone(
  db: ProjectDb,
  project_slug: string,
  timezone: string,
): Promise<void> {
  await db.run(
    `INSERT INTO instance_metadata (instance_slug, timezone) VALUES (?, ?)
       ON CONFLICT(instance_slug) DO UPDATE SET timezone = excluded.timezone`,
    [project_slug, timezone],
  )
}
