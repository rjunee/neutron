/**
 * @neutronai/app — the settings doc this device has ALREADY been told, kept so a
 * project switch can paint from memory (instant-switch, 2026-07-31).
 *
 * WHY THIS EXISTS. `<ProjectStateProvider>` fetches
 * `GET /api/app/projects/<id>/settings` on every scope change, and the shell's
 * content pane shows a full-bleed spinner for as long as that is in flight
 * (`project-shell-content.ts` → `{ kind: 'loading' }`). Measured on device
 * (Android emulator, release APK, 2026-07-31, 8 rail taps): the content pane went
 * blank for 100–200 ms on every single switch before the chat surface underneath
 * it became visible again — one guaranteed repaint per tap, on the one
 * interaction the owner asked to feel instant.
 *
 * Nothing about that wait is necessary, because the answer is already on the
 * device. `GET /api/app/projects` — the call the rail itself makes — returns
 * `ProjectListEntry extends ProjectSettings` (`gateway/http/app-projects-surface.ts:110`),
 * read from the same `projects` table with the same `project_members` join that
 * the per-project settings GET uses (`gateway/projects/sqlite-store.ts:318`). The
 * shell was throwing that away and asking again.
 *
 * WHAT IS AND IS NOT HONEST HERE. Every entry is a real server response received
 * in THIS process — never a fabricated placeholder (ISSUES #393) and never
 * carried across a restart. A warm entry is a starting point, not a verdict: the
 * authoritative per-scope fetch still runs on every scope change and replaces it.
 *
 * SOLO ROWS ONLY. A `shared` list row's settings fields are DEFAULTS, not this
 * project's truth — the cross-instance `/projects` endpoint exposes only
 * id/name/owner and the gateway fills the rest in
 * (`app-projects-surface.ts` `sharedItemToListItem`). Caching one would be
 * exactly the fabrication above, so `projects.ts` warms solo rows only.
 */

import type { ProjectSettings } from './projects-client';

/**
 * How many scopes stay warm. Generously above any realistic rail (the cache is
 * a handful of small plain objects) but bounded, so a long-lived process that
 * has seen hundreds of projects cannot grow without limit.
 */
export const MAX_WARM_SETTINGS = 64;

/** Insertion-ordered, so the oldest key is the first one `keys()` yields. */
const cache = new Map<string, ProjectSettings>();

/**
 * Record a settings doc the server just gave us. Re-inserting an existing id
 * refreshes its position, making eviction least-recently-WRITTEN.
 */
export function rememberProjectSettings(project: ProjectSettings): void {
  const id = project.id;
  if (typeof id !== 'string' || id.length === 0) return;
  cache.delete(id);
  cache.set(id, project);
  while (cache.size > MAX_WARM_SETTINGS) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** The doc this device was last given for `project_id`, or null if none. */
export function warmProjectSettings(project_id: string): ProjectSettings | null {
  if (typeof project_id !== 'string' || project_id.length === 0) return null;
  return cache.get(project_id) ?? null;
}

/** Test-only — real builds never call this. */
export function __resetProjectSettingsCacheForTests(): void {
  cache.clear();
}
