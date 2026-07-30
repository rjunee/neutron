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
/**
 * The id the General (catch-all) scope uses in the rail. Lives HERE, in the
 * pure view module, rather than in the RN component — the component cannot be
 * imported by a unit test (it pulls in react-native), and a constant that
 * cannot be asserted is how General silently went missing from the mobile rail
 * in the first place (ISSUES #403).
 */
/**
 * The rail id for the General (no-project) scope.
 *
 * **The leading `#` is load-bearing.** The gateway's `sanitizeProjectId`
 * (`channels/adapters/app-ws/envelope.ts`) accepts only `[A-Za-z0-9_.-]+`, so a
 * `#`-prefixed id can never be a real project id — which makes this sentinel
 * collision-proof by construction rather than by convention.
 *
 * ISSUES #410: it used to be the bare string `'general'`, which IS a legal
 * project id. On an instance that has a project literally called "General"
 * (Ryan's does — `GET /api/app/projects` returns `id: 'general'`), the scope and
 * that project became the same rail entry, and the real project's transcript
 * (`app:<user>:general`) was unreachable.
 *
 * **It must ALSO be safe as a URL PATH SEGMENT, which is where mobile differs
 * from web.** Web's `GENERAL_CONV_ID` is `#general`, but on web that value is
 * only ever a MAP KEY — it keys the conversation runtime host and the frozen-vm
 * cache, and never enters a URL. Mobile puts the rail id straight into the route
 * `/projects/[id]/chat`, so the constraint set is strictly larger.
 *
 * `#general` fails that extra constraint: it needs percent-encoding (`%23`), and
 * `#` is the URL fragment delimiter. Shipped in #460 and it broke on-device —
 * tapping the General tile landed on the projects list instead of the chat
 * (ISSUES #411). `~` is rejected by the same validator but is left ALONE by
 * `encodeURIComponent`, so the path is literally `/projects/~general/chat` with
 * no encoding at all.
 *
 * The lesson worth keeping: mirroring web was right in PRINCIPLE (#410) and
 * wrong in DETAIL, because I copied the value without checking that web's
 * constraints were the same as mobile's. A map key and a route segment are not
 * interchangeable.
 */
export const GENERAL_PROJECT_ID = '~general';

/**
 * Collapse a rail id to the CHAT SCOPE it names.
 *
 * General is the NO-PROJECT scope — its topic is `app:<user>`, with no project
 * segment — but the rail has to give it *some* id to be selectable, and the only
 * chat route is `/projects/[id]/chat`. So `GENERAL_PROJECT_ID` travels through
 * the router looking exactly like a project id, and anything that derives a
 * topic from it must undo that before it produces `app:<user>:general` — a topic
 * that has never existed and never will.
 *
 * Found on-device: the General rail entry opened a permanently empty chat,
 * because the sentinel reached `appWsProjectTopicId` unchanged. Every scope
 * derivation goes through HERE so there is one place to get it right, mirroring
 * the web client's `scope = input.project_id ?? 'general'` in the other
 * direction.
 *
 * @returns the project id, or `''` for the General (no-project) scope.
 */
/** Label + glyph for the synthetic General entry (mirrors the web client). */
export const GENERAL_PROJECT_NAME = 'General';
export const GENERAL_PROJECT_EMOJI = '\u{1F4AC}';

/**
 * The rail id the CURRENT URL names, read from the pathname.
 *
 * Why not `useLocalSearchParams`: inside the `[id]` LAYOUT those params are
 * sticky. Navigating `willow → general` keeps the layout mounted, so the
 * layout kept reporting `willow` while the freshly-rendered child chat screen
 * correctly saw `general`. Observed on-device: tapping General swapped the
 * transcript to General's messages but left the header reading "Willow" and
 * the rail highlight on Willow. The pathname always reflects where we
 * actually are, so the shell derives from it and the whole chrome follows the
 * rail in one place.
 *
 * @returns the id segment of `/projects/<id>[/...]`, or `null` if the path is
 * not a project route.
 */
export function projectIdFromPathname(pathname: string): string | null {
  const parts = (pathname.split('?')[0] ?? '').split('/').filter((p) => p.length > 0);
  if (parts[0] !== 'projects') return null;
  const id = parts[1];
  if (id === undefined || id.length === 0) return null;
  return decodeURIComponent(id);
}

export function railIdToScope(railId: string): string {
  return railId === GENERAL_PROJECT_ID ? '' : railId;
}

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

/** Which corner dot a rail entry renders. Always one of the three — see below. */
export type RailDotKind = 'work' | 'attention' | 'idle';

/**
 * The activity dot for one rail entry.
 *
 * ALWAYS RETURNS A KIND — never null (SPEC § WAVE 3.5). The dot is now the ENTRY
 * POINT to the Activity Inspector, and the acceptance is explicit that it stays
 * tappable when idle, because an idle session must be distinguishable from a
 * wedged one. A dot that disappears at rest cannot be tapped to learn which of the
 * two you are looking at, so the previous `idle → null` / `isGeneral → null`
 * behaviour is deliberately replaced by a quiet `idle` dot.
 *
 * General gets one too: it is a real chat scope with its own warm session, so it is
 * inspectable like any project. `isGeneral` stays in the signature because General
 * never shows ATTENTION (it has no bound runs).
 *
 * Exact mirror of the web `railDotClass` (`landing/chat-react/ChatApp.tsx`) — the
 * two must stay in lockstep.
 */
export function railDotKind(
  activity: ProjectActivity | undefined,
  isGeneral: boolean,
): RailDotKind {
  if (activity === 'working') return 'work';
  if (activity === 'attention' && !isGeneral) return 'attention';
  return 'idle';
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
