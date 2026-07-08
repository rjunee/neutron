/**
 * @neutronai/trident — task slugifier (node-free leaf).
 *
 * Extracted (L3, 2026-07) out of `code-command.ts` into its own leaf so the
 * `board-dispatch.ts` ↔ `code-command.ts` import cycle is cut: `board-dispatch`
 * needs `slugifyTask` but `code-command` needs `board-dispatch`, and pulling the
 * pure slugifier here lets both import it without importing each other.
 * `code-command.ts` re-exports it (test-policy §2.2 barrel rule) so existing
 * import specifiers stay valid.
 */

/**
 * Slugify the first 35 chars of a task — lowercase, non-alnum → `-`,
 * collapse runs, trim. Verbatim from Vajra's `/trident` SKILL.md Step 2 so
 * a run's slug is stable + human-legible.
 */
export function slugifyTask(task: string): string {
  const s = task
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
    .slice(0, 35)
    .replace(/-$/, '')
  return s.length > 0 ? s : 'code-task'
}
