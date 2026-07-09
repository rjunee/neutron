/**
 * @neutronai/tasks — post-onboarding history-import seeder (P6).
 *
 * Per the P6 brief § 4.12 / § 5.5, every entry in
 * `ImportResult.proposed_tasks` lands as a canonical task row with
 * `source='history-import'` once the onboarding interview reaches the
 * persona-synthesizing phase. Idempotent on rerun: a deterministic
 * hash on `(project_slug, project_id, title)` lets a re-seed of the
 * same ImportResult skip already-landed rows.
 *
 * The seeder is intentionally pure-data — no LLM, no chunking. The
 * proposed_tasks array IS already the LLM's output; turning it into
 * canonical rows is mechanical.
 */

import { createHash } from 'node:crypto'

import type { ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import { NO_PROJECT, TASK_SOURCE_HISTORY_IMPORT, type TaskStore } from './store.ts'

export interface SeedTasksFromImportResultInput {
  project_slug: string
  importResult: ImportResult
  store: TaskStore
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number
}

export interface SeedTasksFromImportResultResult {
  created: number
  skipped_dupe: number
  skipped_invalid: number
}

/**
 * Map the LLM's `priority_hint` enum (`'P0'..'P3'`) to the P6.0 0..3
 * storage scale (3 = most urgent). Unset hints land as `null`.
 */
export function priorityHintToInt(
  hint: 'P0' | 'P1' | 'P2' | 'P3' | undefined,
): number | null {
  if (hint === undefined) return null
  if (hint === 'P0') return 3
  if (hint === 'P1') return 2
  if (hint === 'P2') return 1
  if (hint === 'P3') return 0
  return null
}

/**
 * LOCKED hash-seed constants for `historyImportTaskHash`.
 *
 * These four byte-strings are the domain-separation labels + field
 * separator fed into the SHA-256 that mints every `hi_<sha256>` task id.
 * They are FROZEN: changing ANY byte here re-mints every history-import
 * task id in every existing project db, breaking the idempotent re-seed
 * guard (a re-seed would no longer find the already-landed row and would
 * duplicate it). Do NOT "tidy" these values.
 *
 * `HASH_SEED_SLUG` is the literal `tenant:` — frozen retired vocabulary
 * that PREDATES the tenant→owner purge. It is a hash-domain label, NOT
 * live multi-tenant surface, so it is exempt from the tenant→owner rename
 * and carried in the leak-gate allowlist by exact path
 * (tasks/history-import-seeder.ts:tenant-purged / tenant-word). It was
 * previously hidden from the gate because the field separator was a RAW
 * 0x00 NUL byte that made grep classify this whole file as binary and
 * skip it; the separator is now the byte-identical `\x00` escape so the
 * gate sees the file (proven id-stable by the hash-stability test).
 */
const HASH_SEED_SLUG = 'tenant:'
const HASH_SEED_ID = 'project:'
const HASH_SEED_TITLE = 'title:'
/** Field separator — a single NUL byte (`\x00`), byte-identical to the
 *  original raw 0x00. Unambiguous because it can never appear in a slug,
 *  id, or title, so it prevents `(a, bc)` colliding with `(ab, c)`. */
const HASH_FIELD_SEP = '\x00'

/**
 * Deterministic id derivation for history-import rows. Hashing on
 * `(project_slug, project_id, title)` gives us the idempotent guard:
 * re-seeding the same ImportResult finds the existing row by id and
 * skips the insert. The hash is also used as a synthetic `id` so the
 * row is reproducible across re-runs (no UUID churn).
 */
export function historyImportTaskHash(input: {
  project_slug: string
  project_id: string
  title: string
}): string {
  const h = createHash('sha256')
  h.update(`${HASH_SEED_SLUG}${input.project_slug}${HASH_FIELD_SEP}`)
  h.update(`${HASH_SEED_ID}${input.project_id}${HASH_FIELD_SEP}`)
  h.update(`${HASH_SEED_TITLE}${input.title}`)
  return `hi_${h.digest('hex').slice(0, 24)}`
}

export async function seedTasksFromImportResult(
  input: SeedTasksFromImportResultInput,
): Promise<SeedTasksFromImportResultResult> {
  const { store, importResult, project_slug } = input
  const proposed = Array.isArray(importResult.proposed_tasks)
    ? importResult.proposed_tasks
    : []
  let created = 0
  let skipped_dupe = 0
  let skipped_invalid = 0
  for (const entry of proposed) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.title !== 'string'
    ) {
      skipped_invalid += 1
      continue
    }
    const title = entry.title.trim()
    if (title.length === 0) {
      skipped_invalid += 1
      continue
    }
    const id = historyImportTaskHash({
      project_slug,
      project_id: NO_PROJECT,
      title,
    })
    const existing = store.get(id)
    if (existing !== null) {
      skipped_dupe += 1
      continue
    }
    const due_date =
      typeof entry.due_at === 'number' && Number.isFinite(entry.due_at)
        ? new Date(entry.due_at).toISOString()
        : null
    const priority = priorityHintToInt(entry.priority_hint)
    await store.create({
      id,
      project_slug,
      project_id: NO_PROJECT,
      title,
      priority,
      due_date,
      source: TASK_SOURCE_HISTORY_IMPORT,
    })
    created += 1
  }
  return { created, skipped_dupe, skipped_invalid }
}
