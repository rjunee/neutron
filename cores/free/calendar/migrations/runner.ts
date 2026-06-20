/**
 * @neutronai/calendar-core — per-project sidecar migration runner.
 *
 * Thin adapter over the platform's `applyProjectScopedMigrations` so
 * the Core's migration tree owns its own `_migrations` bookkeeping
 * table (parallel namespace to the instance-wide migrations) and tests
 * can apply it against an in-memory Database without reaching into
 * the platform's globals.
 *
 * Mirrors `cores/free/reminders/migrations/runner.ts` byte-for-byte
 * (when that lands) — Notes / Reminders / Calendar Cores share this
 * pattern.
 */

import type { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyProjectScopedMigrations } from '../../../../migrations/runner.ts'

/** Directory holding `0001_*.sql` / `0002_*.sql` / ... migrations. */
export const MIGRATIONS_DIR: string = dirname(fileURLToPath(import.meta.url))

/**
 * Apply every Calendar Core sidecar migration not yet recorded in the
 * DB's `_migrations` table. Forward-only; safe to call repeatedly.
 */
export function applyCalendarSidecarMigrations(db: Database): {
  applied: number[]
  skipped: number[]
} {
  return applyProjectScopedMigrations(db, MIGRATIONS_DIR)
}
