/**
 * @neutronai/app — project list (P5.2 + ISSUES #9).
 *
 * Sprint roadmap § 4 / P5.2 originally scoped this as a dev-stub:
 *
 *   "For now, use a dev-bypass that lists a hardcoded set of 3 fake
 *    projects (since the production project list endpoint isn't wired
 *    in the gateway yet)."
 *
 * ISSUES #9 closes the gap. The canonical source is now
 * `GET /api/app/projects` on the per-instance gateway, served by the
 * `SqliteProjectSettingsStore` over the `projects` SQLite table
 * (migration 0038). `fetchProjects({ base_url, token })` is the new
 * async entry point — the project-list screen wires this through a
 * `useEffect` on mount and refreshes on focus.
 *
 * The demo fixtures and their sync accessor were removed (#393); an
 * fallback. It returns the same dev-stub trio so the project list
 * screen can render synchronously while the real fetch is in flight;
 * the first successful `fetchProjects` result replaces it. Tests +
 * web smoke that exercise the navigation without a live gateway
 * continue to hit the sync stub.
 */

import { rememberProjectSettings } from './project-settings-cache';
import {
  ProjectsClient,
  type PrivacyMode,
  type ProjectListItem,
  type ProjectOrigin,
  type ProjectSettings,
  type ProjectSourceError,
} from './projects-client';

export interface Project {
  /** Slug-ish id used as the route param + WS envelope project_id. */
  id: string;
  /** Display name shown on the card + project header. */
  name: string;
  /**
   * The name to RENDER — `name` after the server's one board-label rule. Equal
   * to `name` for every project whose name doesn't collide with the General
   * board, so every surface can render `label` unconditionally.
   *
   * `name` is kept raw alongside it because the settings drawer's rename field
   * round-trips it; seeding that field with the qualifier would persist it.
   */
  label: string;
  /** One-line tagline rendered under the name on the project card. */
  description: string;
  /** Short glyph shown at the start of the project card title row. */
  emoji: string;
  /** Wall-clock ms of the last activity for sort + "Last opened" label. */
  last_activity_ms: number;
  /** Unread item count for the current user; drives the card badge (0 = hidden). */
  unread_count: number;
  /** Stub members list — surfaced read-only in the project settings drawer. */
  members: ReadonlyArray<{ name: string; role: 'owner' | 'member' }>;
  /** Stub persona surfaced in the drawer. */
  persona: string;
  /** Stub privacy mode surfaced in the drawer (de-duped — single source of
   *  truth is `PrivacyMode` in ./projects-client). */
  privacy_mode: PrivacyMode;
  /** M2.3 — `solo` (the owner's own instance) | `shared` (a workspace the user
   *  belongs to). Drives the solo/shared pill on the project card. */
  kind: ProjectOrigin;
  /** Slug of the instance that owns this project. For shared items this is
   *  the workspace name shown on the pill. */
  origin_instance: string;
}

/** Re-export so the screen can type the source-error notice. */
export type { ProjectSourceError } from './projects-client';

/**
 * The "coming soon" hint shown on a non-navigable shared card. Single-
 * sourced here so the card render + its test assert the SAME string.
 */
export const SHARED_CARD_COMING_SOON_HINT =
  'Viewing shared projects is coming soon.';

/**
 * Interactive properties for a project card — pure derivation of the
 * M2.3 / Argus r1 BLOCKER #1 behavior so it's unit-testable without
 * mounting React Native (the app suite never mounts RN — see
 * `comments-side-pane.test.tsx`).
 *
 * Shared (cross-instance) projects have no working detail view yet (the
 * detail loader is local-only), so their cards are non-navigable:
 * `navigable: false`, `disabled: true`, `accessibilityState.disabled`,
 * an explanatory label + the "coming soon" hint. Solo projects open as
 * before. `handleOpen` consults `navigable`; the card consumes the rest.
 */
export interface ProjectCardInteractivity {
  navigable: boolean;
  disabled: boolean;
  accessibilityRole: 'button' | 'text';
  accessibilityLabel: string;
  accessibilityState: { disabled: boolean } | undefined;
  hint: string | null;
}

export function projectCardInteractivity(
  project: Pick<Project, 'kind' | 'name'>,
): ProjectCardInteractivity {
  const isShared = project.kind === 'shared';
  return {
    navigable: !isShared,
    disabled: isShared,
    accessibilityRole: isShared ? 'text' : 'button',
    accessibilityLabel: isShared
      ? `Shared project ${project.name} — viewing coming soon`
      : `Open project ${project.name}`,
    accessibilityState: isShared ? { disabled: true } : undefined,
    hint: isShared ? SHARED_CARD_COMING_SOON_HINT : null,
  };
}

/** What `fetchProjects` returns: the unified list plus any per-workspace
 *  fan-out failures (rendered as a non-blocking "unavailable" notice). */
export interface FetchProjectsResult {
  projects: Project[];
  sourceErrors: ProjectSourceError[];
}

export interface FetchProjectsOptions {
  base_url: string;
  token: string;
  /** Optional override — defaults to `Date.now()`. */
  now?: number;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * Returns a stable list of 3 fake projects for the P5.2 dev surface.
 * `last_activity_ms` is computed relative to `now` so the "x ago"
 * labels stay sensible across days without rotting fixtures.
 */
// `loadProjects()` DELETED (ISSUES #393). It returned three hardcoded demo
// projects for a dev surface and was wired as the production fallback, so a
// failed fetch showed the owner FABRICATED data captioned "Showing cached
// list". Callers must render an empty state + the error instead. Do not
// reintroduce sample rows into a module the app imports at runtime; if a
// fixture is needed, put it in a test file.
// `findProject()` DELETED alongside it — its only purpose was looking up one of
// those fixtures by id, and it had ZERO callers in the app.

/**
 * Order the project list for display: most-recent activity first. Stable
 * tie-break by id so equal timestamps (e.g. a fresh list where several fall
 * back to `now`) keep a deterministic order across renders. Returns a new
 * array — never mutates the input.
 */
export function sortProjectsByActivity(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => {
    if (b.last_activity_ms !== a.last_activity_ms) {
      return b.last_activity_ms - a.last_activity_ms;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Real fetch — ISSUES #9. Calls `GET /api/app/projects` and maps the
 * `ProjectSettings` server view onto the legacy `Project` shape the
 * project-list screen consumes.
 *
 * `last_activity_ms` is parsed from the server's `last_activity_at`
 * ISO-8601 timestamp; when the server omits it (older gateway) or sends
 * '' we fall back to `now` so the "just now" / "Nm ago" labels stay
 * sensible. `emoji` and `unread_count` come straight off the list item,
 * defaulted for a pre-rail gateway.
 *
 * Throws on network errors / non-2xx responses; the caller should
 * render an empty list and surface
 * the error inline.
 */
export async function fetchProjects(opts: FetchProjectsOptions): Promise<FetchProjectsResult> {
  const client = new ProjectsClient({
    base_url: opts.base_url,
    token: opts.token,
  });
  const now = opts.now ?? Date.now();
  const { projects, source_errors } = await client.list();
  // The rail's own list call already carries every field the per-project
  // settings GET returns, for the owner's own projects — so warm the cache the
  // project shell paints from and stop making the owner wait for an answer this
  // response already contained. SOLO ONLY: a shared row's settings fields are
  // gateway-filled defaults, not that project's truth
  // (`project-settings-cache.ts`).
  for (const p of projects) {
    if (p.kind === 'solo') rememberProjectSettings(listItemToSettings(p));
  }
  return {
    projects: projects.map((p) => listItemToProject(p, now)),
    sourceErrors: source_errors,
  };
}

/**
 * Create a project from `name` via `POST /api/app/projects` and return its id +
 * label (the project-list "Create Project" affordance). Idempotent on the name.
 * Throws `ProjectsClientError` on any non-2xx so the caller can surface the
 * precise reason.
 */
export async function createProject(
  opts: FetchProjectsOptions & { name: string },
): Promise<{ id: string; label: string; created: boolean }> {
  const client = new ProjectsClient({ base_url: opts.base_url, token: opts.token });
  return client.create(opts.name);
}

/**
 * Narrow a list row to EXACTLY the settings doc, so nothing list-only
 * (`kind`, `unread_count`, activity) leaks into the cache the project shell
 * reads as `ProjectSettings`. Same emoji default as {@link listItemToProject}.
 */
function listItemToSettings(p: ProjectListItem): ProjectSettings {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    persona: p.persona,
    emoji: p.emoji !== undefined && p.emoji.length > 0 ? p.emoji : '📁',
    privacy_mode: p.privacy_mode,
    billing_mode: p.billing_mode,
    agent_engagement_mode: p.agent_engagement_mode,
    members: p.members,
  };
}

function listItemToProject(p: ProjectListItem, now: number): Project {
  return {
    id: p.id,
    name: p.name,
    // Fall back to the raw name when an older gateway omits `label`.
    label: p.label !== undefined && p.label.length > 0 ? p.label : p.name,
    description: p.description,
    // Default to a neutral folder glyph when an older gateway omits emoji.
    emoji: p.emoji !== undefined && p.emoji.length > 0 ? p.emoji : '📁',
    last_activity_ms: parseActivityMs(p.last_activity_at, now),
    unread_count: typeof p.unread_count === 'number' ? p.unread_count : 0,
    members: p.members.map((m) => ({ name: m.name, role: m.role })),
    persona: p.persona,
    privacy_mode: p.privacy_mode,
    kind: p.kind,
    origin_instance: p.origin_instance,
  };
}

/** Parse a server `last_activity_at` ISO-8601 string to wall-clock ms. Falls
 *  back to `now` when the field is missing/'' or otherwise unparseable so the
 *  card's relative-time label stays sensible. */
function parseActivityMs(iso: string | undefined, now: number): number {
  if (iso === undefined || iso.length === 0) return now;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : now;
}

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Format last-activity for a project card, e.g. "12m ago" / "4h ago" / "Apr 12 09:30". */
export function formatLastActivity(activity_ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - activity_ms);
  if (diff < 60 * 1000) return 'just now';
  if (diff < ONE_HOUR_MS) return `${Math.floor(diff / (60 * 1000))}m ago`;
  if (diff < ONE_DAY_MS) return `${Math.floor(diff / ONE_HOUR_MS)}h ago`;
  if (diff < 7 * ONE_DAY_MS) return `${Math.floor(diff / ONE_DAY_MS)}d ago`;
  return FORMATTER.format(new Date(activity_ms));
}
