/**
 * @neutronai/open — live (non-deleted) project enumerator for doc-search.
 *
 * A project `delete` (agent-settings `delete_project`) is a metadata-only SOFT
 * delete: it sets `projects.deleted_at` and archives the topic, but never
 * touches the on-disk `<owner_home>/Projects/<id>/` folder. The doc-search
 * indexer enumerates projects by a bare disk scan (`doc-search/projects.ts`)
 * with no `deleted_at` awareness and only purges a project when its folder
 * "disappears from disk" — which delete never does. So `doc_search` keeps
 * returning a deleted project's documents indefinitely, contradicting the
 * user's "delete the X project" (M1 E2E Round 4, bug E).
 *
 * This wraps the disk scan and drops any id that has a `projects` row marked
 * `deleted_at IS NOT NULL` (folder name == `projects.id` == the project slug).
 * The indexer then purges the project on its next refresh. Conservative by
 * design:
 *   - a folder with NO `projects` row at all is left indexed (never purge an
 *     unknown — e.g. a hand-created docs folder), and
 *   - any DB probe failure falls back to the raw scan, so live docs can never
 *     silently disappear because of a transient query error.
 */
import { enumerateProjects as enumerateProjectDirs } from '@neutronai/doc-search/projects.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export function buildLiveProjectEnumerator(
  db: ProjectDb,
): (ownerHome: string) => Promise<string[]> {
  return async (ownerHome: string): Promise<string[]> => {
    const dirs = await enumerateProjectDirs(ownerHome)
    try {
      const deletedRows = db
        .raw()
        .query<{ id: string }, []>(`SELECT id FROM projects WHERE deleted_at IS NOT NULL`)
        .all()
      if (deletedRows.length === 0) return dirs
      const deleted = new Set(deletedRows.map((r) => r.id))
      return dirs.filter((id) => !deleted.has(id))
    } catch {
      // A probe failure must never hide live docs — fall back to the raw scan.
      return dirs
    }
  }
}
