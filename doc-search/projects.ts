/**
 * @neutronai/doc-search — project enumeration.
 *
 * Mirrors `gateway/projects/enumerate.ts` (kept local so this workspace
 * package doesn't take a dependency on `@neutronai/gateway`). Lists
 * project_ids by reading the immediate subdirectories of
 * `<owner_home>/Projects/`, validated against the shared project_id
 * grammar and sorted. A missing `Projects/` dir (fresh instance) yields
 * `[]`, not an error.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** alphanumeric leading char, then alnum / `.` / `_` / `-`, ≤ 64 chars. */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export async function enumerateProjects(ownerHome: string): Promise<string[]> {
  try {
    const root = join(ownerHome, 'Projects')
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
