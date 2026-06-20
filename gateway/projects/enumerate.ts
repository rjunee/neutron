/**
 * Shared project enumerator — returns the list of project_ids for an
 * instance by reading subdirectories under `<owner_home>/Projects/`.
 *
 * Consumed by:
 *   - `gateway/index.ts` (P7.4 scheduler init)
 *   - `gateway/http/app-admin-surface.ts` (Backup sub-tab list endpoint)
 *
 * Both call sites previously inlined the same regex + readdir + sort
 * snippet (Argus r1 MINOR #5). Keeping it in one place ensures the
 * project_id grammar stays in lockstep with the rest of the codebase.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Matches the project_id grammar used by `DocStore` and friends —
 *  alphanumeric leading char, then alphanumeric / `.` / `_` / `-`,
 *  up to 64 chars total. */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Enumerate project_ids under `<owner_home>/Projects/`. Returns a
 * sorted, validated list. Returns `[]` if the Projects dir does not
 * exist or any I/O error occurs (no-Projects-dir is the steady-state
 * for a fresh instance — not an error).
 */
export async function enumerateOwnerProjects(owner_home: string): Promise<string[]> {
  try {
    const root = join(owner_home, 'Projects')
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => PROJECT_ID_RE.test(name))
      .sort()
  } catch {
    return []
  }
}

/** Curry the helper around a fixed `owner_home` for callers that
 *  expect a zero-arg `() => Promise<string[]>` (the scheduler and the
 *  app-admin-surface both take this shape). */
export function defaultEnumerateProjects(
  owner_home: string,
): () => Promise<string[]> {
  return (): Promise<string[]> => enumerateOwnerProjects(owner_home)
}
