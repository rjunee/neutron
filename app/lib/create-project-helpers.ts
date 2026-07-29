/**
 * @neutronai/app — create-project rules, RN-free so they can be asserted.
 *
 * Create-project used to live at the bottom of the projects-list screen. That
 * screen is DELETED (SPEC § Decisions Log 2026-07-27 — the app opens straight
 * into chat with the rail), so the affordance moved to the rail's `+`, which
 * opens `<CreateProjectSheet>` over the chat instead of navigating anywhere.
 * Deleting the screen without moving the affordance would have left mobile with
 * no way to create a project at all, and a dead rail button.
 *
 * The name rule + the error copy live here rather than in the sheet because the
 * app suite cannot mount React Native components; the sheet is presentational
 * and the decisions are these two functions.
 */

/** Empty-name copy — single-sourced so the sheet and its test assert one string. */
export const EMPTY_NAME_ERROR = 'Enter a project name.';
/** Fallback copy when the server rejects the create for an unmapped reason. */
export const CREATE_FAILED_ERROR = 'Could not create project.';

export type ProjectNameCheck =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Trim + reject an empty name. Whitespace-only is empty — the server would
 * otherwise mint a project whose rail entry has no readable label.
 */
export function checkProjectName(raw: string): ProjectNameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: EMPTY_NAME_ERROR };
  return { ok: true, name };
}

/**
 * User-facing copy for a `createProject` rejection. `ProjectsClientError`
 * carries the server message; anything else falls back to a generic line.
 * Mirrors `inviteErrorCopy`'s shape in `projects/[id]/_layout.tsx`.
 */
export function createProjectErrorCopy(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  return CREATE_FAILED_ERROR;
}
