/**
 * @neutronai/app — mobile project-rail view helpers (M1 UX REDESIGN PR-6).
 *
 * Pure + RN-free (no `react-native` import) so the rail's derivation logic —
 * which activity-dot a project shows, whether a Work-tab badge renders — is
 * unit-testable under `bun test` without mounting the RN component (the app
 * suite never mounts RN; see `project-card-interactivity.test.ts`).
 *
 * Mirror of the web rail's `railDotClass` (PR-3, `landing/chat-react`): the
 * mobile rail consumes the SAME PR-1 `activity` / `live_runs` contract fanned
 * over the app-ws `projects_changed` frame, so the enum + precedence match the
 * web verbatim.
 */

/**
 * The one derived rail state (PR-1 `ProjectActivity`, mirrored from
 * `open/project-rail.ts`). `attention` wins (a failed-not-done Work-Board item
 * or a stalled live run) → else `working` (a live chat turn / live build /
 * inline action) → else `idle`. Optional/absent on the wire ⇒ treat as `idle`.
 */
export type ProjectActivity = 'idle' | 'working' | 'attention';

/**
 * The minimal project shape the rail renders — a structural subset of
 * `lib/projects.ts` `Project`. Narrowed so the rail component (and its tests)
 * depend only on the fields it draws, and the layout can seed it from either the
 * HTTP list or the in-hand current project without constructing a full
 * `Project`.
 */
export interface RailProjectView {
  id: string;
  name: string;
  emoji: string;
  unread_count: number;
  origin_instance: string;
}

/** Which corner dot a rail entry renders. `null` ⇒ no dot (idle / General). */
export type RailDotKind = 'work' | 'attention';

/**
 * The activity dot for one rail entry. General never shows a dot (it is the
 * catch-all topic, not a project with its own build state). `working` → the
 * pulsing `work` dot; `attention` → the static `attention` dot; `idle` /
 * absent → no dot.
 */
export function railDotKind(
  activity: ProjectActivity | undefined,
  isGeneral: boolean,
): RailDotKind | null {
  if (isGeneral) return null;
  if (activity === 'attention') return 'attention';
  if (activity === 'working') return 'work';
  return null;
}

/**
 * The count to show on the Work-tab live-run badge, or `null` when no badge
 * should render. A project with 0 (or absent) live runs shows no badge — the
 * badge is an honest live-build count, never a fabricated "0".
 */
export function workTabBadgeCount(live_runs: number | undefined): number | null {
  if (typeof live_runs !== 'number' || !Number.isFinite(live_runs)) return null;
  const n = Math.max(0, Math.trunc(live_runs));
  return n > 0 ? n : null;
}
