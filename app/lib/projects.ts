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
 * `loadProjects()` (sync) is retained as an SSR-safe initial-paint
 * fallback. It returns the same dev-stub trio so the project list
 * screen can render synchronously while the real fetch is in flight;
 * the first successful `fetchProjects` result replaces it. Tests +
 * web smoke that exercise the navigation without a live gateway
 * continue to hit the sync stub.
 */

import {
  ProjectsClient,
  type PrivacyMode,
  type ProjectListItem,
  type ProjectOrigin,
  type ProjectSourceError,
} from './projects-client';

export interface Project {
  /** Slug-ish id used as the route param + WS envelope project_id. */
  id: string;
  /** Display name shown on the card + project header. */
  name: string;
  /** One-line tagline rendered under the name on the project card. */
  description: string;
  /** Wall-clock ms of the last activity for sort + "Last opened" label. */
  last_activity_ms: number;
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
export function loadProjects(now: number = Date.now()): Project[] {
  return [
    {
      id: 'neutron',
      name: 'Neutron',
      description: 'Build Neutron itself — engineering, design, ops.',
      last_activity_ms: now - 12 * 60 * 1000,
      members: [
        { name: 'Sam', role: 'owner' },
        { name: 'Nova', role: 'member' },
      ],
      persona: 'Forge — pragmatic build agent',
      privacy_mode: 'private',
      kind: 'solo',
      origin_instance: 'neutron',
    },
    {
      id: 'acme',
      name: 'Acme',
      description: "Casey's brand and product work — campaigns, ops, launches.",
      last_activity_ms: now - 4 * ONE_HOUR_MS,
      members: [
        { name: 'Casey', role: 'owner' },
        { name: 'Sam', role: 'member' },
      ],
      persona: 'Atlas — research + brand voice',
      privacy_mode: 'private',
      // Stub: a shared project so the dev surface exercises the solo/shared
      // pill without a live cross-instance fan-out.
      kind: 'shared',
      origin_instance: 'acme-team',
    },
    {
      id: 'northwind',
      name: 'Northwind Labs',
      description: 'Northwind Labs — supplement formulation + brand assets.',
      last_activity_ms: now - 2 * ONE_DAY_MS,
      members: [{ name: 'Sam', role: 'owner' }],
      persona: 'Sentinel — review + QA',
      privacy_mode: 'private',
      kind: 'solo',
      origin_instance: 'northwind',
    },
  ];
}

export function findProject(id: string, now: number = Date.now()): Project | null {
  return loadProjects(now).find((p) => p.id === id) ?? null;
}

/**
 * Real fetch — ISSUES #9. Calls `GET /api/app/projects` and maps the
 * `ProjectSettings` server view onto the legacy `Project` shape the
 * project-list screen consumes.
 *
 * `last_activity_ms` is set to `now` for every project (the server
 * doesn't track last-activity timestamps yet; per-project activity
 * tracking is a later P5.x sprint). The UI still shows "just now" /
 * "Nm ago" labels — they're just all identical until the server
 * surfaces a real timestamp.
 *
 * Throws on network errors / non-2xx responses; the caller should
 * fall back to `loadProjects()` for the initial paint and surface
 * the error inline.
 */
export async function fetchProjects(opts: FetchProjectsOptions): Promise<FetchProjectsResult> {
  const client = new ProjectsClient({
    base_url: opts.base_url,
    token: opts.token,
  });
  const now = opts.now ?? Date.now();
  const { projects, source_errors } = await client.list();
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

function listItemToProject(p: ProjectListItem, now: number): Project {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    last_activity_ms: now,
    members: p.members.map((m) => ({ name: m.name, role: m.role })),
    persona: p.persona,
    privacy_mode: p.privacy_mode,
    kind: p.kind,
    origin_instance: p.origin_instance,
  };
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
