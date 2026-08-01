/**
 * @neutronai/app — project detail shell (P5.2 refactor).
 *
 * Thin composer. Owns:
 *   - Mounting `<ProjectStateProvider>` per `project_id` so the
 *     gateway-backed settings doc loads exactly once + propagates to
 *     `<ProjectHeader>` / `<ProjectSettingsDrawer>` / future tab bodies.
 *   - Fetching the REGISTRY-DRIVEN tab set (`GET /api/app/projects/<id>/tabs`,
 *     WAVE 3 PR-3) and rendering it via `<ProjectTabBar>` — builtin
 *     Chat/Documents/Tasks ∪ installed Cores' `project_tab` surfaces. The
 *     legacy `PROJECT_TABS` const survives ONLY as the pre-fetch loading
 *     default. Core tabs route to the generic `cores/[slug]` webview.
 *   - The per-project last-tab persistence write path (the read path
 *     lives in `index.tsx`).
 *   - CREATE-PROJECT (`<CreateProjectSheet>`, opened by the rail's `+`). The
 *     projects-list screen owned this and is deleted (SPEC § Decisions Log
 *     2026-07-27); the sheet is now the only way to create a project on mobile.
 *   - The app-level entry in the header's left slot (`/settings` → server
 *     editor, Admin, sign out) — the list header used to be its only home.
 *   - Swapping `<Slot />` children behind a 150ms opacity fade so tab
 *     switches feel responsive without pulling in `react-native-pager-
 *     view`. Disabled under reduce-motion.
 *   - The Project-not-found + Loading shells.
 *
 * All visual styling sources from `lib/theme.ts` tokens.
 */

import { Slot, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { projectTabRoute, projectTabRouteSync } from '../../../lib/project-tab-route';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { ProjectHeader } from '../../../components/ProjectHeader';
import { ProjectSettingsDrawer } from '../../../components/ProjectSettingsDrawer';
import { CreateProjectSheet } from '../../../components/CreateProjectSheet';
// ACTIVITY INSPECTOR (SPEC § WAVE 3.5) — the drawer behind the clickable rail dot.
import { ActivityInspectorDrawer } from '../../../components/ActivityInspectorDrawer';
import {
  activityScopeKey,
  AppActivityClient,
  startActivityLive,
  type ActivityRow,
} from '../../../lib/activity-client';
import { InviteModal, type InviteModalResult } from '../../../components/InviteModal';
import { copyToClipboard } from '../../../lib/clipboard';
import { canInviteToProject } from '../../../lib/invite-helpers';
import { PROJECT_TABS, ProjectTabBar } from '../../../components/ProjectTabBar';
import { useCredentialUsage } from '../../../lib/usage-client';
import {
  GENERAL_PROJECT_ID,
  ProjectRail,
  type RailOverlayEntry,
} from '../../../components/ProjectRail';
import { ComposerDock, ComposerDockProvider } from '../../../lib/composer-dock';
import { BREAKPOINTS, MOTION, SPACING, THEME, TYPOGRAPHY } from '../../../lib/composer-constants';
import { loadAppConfig } from '../../../lib/config';
import { createProjectErrorCopy } from '../../../lib/create-project-helpers';
import { chatRouteForProject, GENERAL_CHAT_ROUTE } from '../../../lib/entry-route';
import { lastTabStorage } from '../../../lib/last-tab-storage';
import {
  activeTabKeyFromSegments,
  descriptorsToResolvedTabs,
  ensureWorkTab,
  lastTabValueForLeaf,
  loadingTabsForProject,
  WORK_TAB_KEY,
  type ResolvedTab,
} from '../../../lib/project-tabs';
import {
  GENERAL_PROJECT_EMOJI,
  GENERAL_PROJECT_NAME,
  projectIdFromPathname,
  workTabBadgeCount,
  type RailProjectView,
} from '../../../lib/project-rail-view';
import {
  createProject,
  fetchProjects,
  projectCardInteractivity,
  sortProjectsByActivity,
  type Project,
} from '../../../lib/projects';
import { startProjectsRailLive, type RailProject } from '../../../lib/projects-rail-live';
import { projectShellContent } from '../../../lib/project-shell-content';
import { ProjectStateProvider, useProjectState } from '../../../lib/project-state';
import type { ProjectSettings } from '../../../lib/projects-client';
import { useAuthSession } from '../../../lib/session';
import { TabsClient, type TabDescriptor } from '../../../lib/tabs-client';
import { useTranscriptWarming } from '../../../lib/chat-core/use-transcript-warming';

/**
 * How many rail projects get their tab set fetched ahead of the tap.
 *
 * The rail is activity-sorted, so this is the window the owner actually
 * switches within; beyond it a first visit still resolves its own tabs on
 * arrival. Bounded because each entry is one small GET and a rail can be long.
 */
const TAB_PREFETCH_LIMIT = 12;

/** How long the prefetch waits, so it never contends with the first paint. */
const TAB_PREFETCH_DELAY_MS = 600;

/** Best-effort random device id for the rail's read-only app-ws socket. */
function makeRailDeviceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return `rail-${c.randomUUID()}`;
  return `rail-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * The identity the project shell needs in order to render the General scope.
 *
 * General is not a row in `projects` — it is the absence of one — so nothing
 * can be fetched for it. This is NOT a placeholder standing in for real data
 * that failed to load (the thing ISSUES #393 banned): every field here is
 * either the literal truth about General or deliberately inert, and the chrome
 * that would misrepresent it (invite, settings, members) is suppressed
 * separately.
 */
const GENERAL_SCOPE_PROJECT: ProjectSettings = {
  id: GENERAL_PROJECT_ID,
  name: GENERAL_PROJECT_NAME,
  description: '',
  persona: '',
  emoji: GENERAL_PROJECT_EMOJI,
  privacy_mode: 'private',
  billing_mode: 'personal',
  agent_engagement_mode: 'all_messages',
  members: [],
};

export default function ProjectLayout() {
  const router = useRouter();
  const { user, status: authStatus } = useAuthSession();
  // The URL is the authority for WHICH project the shell is showing.
  // `useLocalSearchParams` is sticky inside this layout — navigating
  // willow → general keeps the layout mounted, so it kept reporting the old
  // id while the child chat screen saw the new one. That is why tapping General
  // swapped the transcript but left the header and rail highlight on Willow.
  // The param stays as the fallback for a non-project path.
  const pathname = usePathname();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project_id = projectIdFromPathname(pathname) ?? (typeof id === 'string' ? id : '');

  useEffect(() => {
    if (authStatus === 'ready' && user === null) {
      router.replace('/login');
    }
  }, [router, user, authStatus]);

  if (authStatus !== 'ready' || user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  if (project_id.length === 0) {
    // There is no list to go back to any more — General is home.
    return (
      <ProjectNotFoundFallback
        id={project_id}
        onBack={() => router.replace(GENERAL_CHAT_ROUTE as Parameters<typeof router.replace>[0])}
      />
    );
  }

  return (
    <ProjectStateProvider project_id={project_id}>
      {/* The composer dock has to be in scope for BOTH the shell's bottom band
          and the chat surface deep inside `<Slot/>` that publishes into it. */}
      <ComposerDockProvider>
        <ProjectShell project_id={project_id} />
      </ComposerDockProvider>
    </ProjectStateProvider>
  );
}

function ProjectShell({ project_id }: { project_id: string }) {
  const router = useRouter();
  // CONCRETE path segments (`usePathname()` carries the real `<id>`/`<slug>`).
  // `useSegments()` would return the file-route TOKENS (`[id]`, `[slug]`) for
  // dynamic routes, which never match a Core tab's resolved route — see
  // `activeTabKeyFromSegments`.
  const pathname = usePathname();
  const segments = useMemo<readonly string[]>(
    () => (pathname.split('?')[0] ?? '').split('/').filter((p) => p.length > 0),
    [pathname],
  );
  const { user } = useAuthSession();
  const { project: fetchedProject, error, generateInvite, refresh } = useProjectState();
  // General is the NO-PROJECT scope: there is no settings row to fetch, no
  // members, no privacy mode and no Core tabs. Without this the shell 404s on
  // `getSettings('general')` and renders "project not found" for the scope that
  // holds the largest transcript. Synthesize the identity the chrome needs and
  // suppress the chrome that does not apply.
  const isGeneral = project_id === GENERAL_PROJECT_ID;
  const project = isGeneral ? GENERAL_SCOPE_PROJECT : fetchedProject;
  const config = useMemo(() => loadAppConfig(), []);

  // WAVE 3 PR-3 — the tab set is REGISTRY-DRIVEN. Fetch the engine-resolved
  // descriptors (`GET /api/app/projects/<id>/tabs`) and render whatever the
  // engine returns: builtin Chat/Documents/Tasks ∪ installed Cores'
  // `project_tab` surfaces. A scope with no answer yet shows the loading
  // default (the legacy `PROJECT_TABS`, resolved to native routes) — a graceful
  // fallback, NOT a feature-flag alt path.
  //
  // KEYED BY SCOPE, AND NEVER CLEARED (instant-switch, 2026-07-31). This used to
  // be one `ResolvedTab[] | null` that a switch reset to `null`, which made the
  // bar repaint TWICE on every rail tap: the loading default (Chat / Apps /
  // Tasks / Reminders / Docs) flashed in for the frames the fetch was in flight,
  // then the real set replaced it. Filmed on device at 30 fps, 2026-07-31 — the
  // wrong tab set was on screen for 3–4 frames of every single switch. Holding
  // the answers per scope removes both the reset and the reason for it: nothing
  // can render the previous project's routes if the lookup is by project id.
  // Each visit still REFETCHES (a Core installed since is a real change) — it
  // just merges the answer in instead of blanking first.
  const [tabsByScope, setTabsByScope] = useState<ReadonlyMap<string, readonly TabDescriptor[]>>(
    () => new Map(),
  );
  const mergeTabs = useCallback((id: string, descriptors: readonly TabDescriptor[]): void => {
    setTabsByScope((prev) => {
      const next = new Map(prev);
      next.set(id, descriptors);
      return next;
    });
  }, []);
  useEffect(() => {
    if (user === null) return;
    let cancelled = false;
    const client = new TabsClient({ base_url: config.base_url, token: user.token });
    client
      .listProjectTabs(project_id)
      .then((descriptors) => {
        if (!cancelled) mergeTabs(project_id, descriptors);
      })
      .catch(() => {
        // Endpoint absent / offline / auth — whatever this scope already had
        // stands, and a scope with nothing keeps the loading default.
      });
    return () => {
      cancelled = true;
    };
  }, [user, config.base_url, project_id, mergeTabs]);

  // The Work tab is not emitted by the tab registry, so the mobile shell always
  // injects it (after Chat) over BOTH the loading default and the fetched set —
  // one code path, idempotent. This is the tab the live-run badge lands on.
  const displayTabs = useMemo<ResolvedTab[]>(() => {
    const known = tabsByScope.get(project_id);
    const resolved =
      known === undefined
        ? loadingTabsForProject(project_id)
        : descriptorsToResolvedTabs(known, project_id);
    return ensureWorkTab(resolved, project_id);
  }, [tabsByScope, project_id]);

  // ── Project rail (M1 UX REDESIGN PR-6) ────────────────────────────────────
  // The rail's project SET comes from the HTTP list; its per-project rail state
  // (`activity` dot / `live_runs` badge) is overlaid live from the app-ws
  // `projects_changed` frame (PR-1 #180) — the composer is the single source of
  // truth, mirroring the web rail. `railProjects` is null until the first fetch.
  const [railProjects, setRailProjects] = useState<Project[] | null>(null);
  const [railOverlay, setRailOverlay] = useState<ReadonlyMap<string, RailOverlayEntry>>(
    () => new Map(),
  );
  const deviceId = useMemo(() => makeRailDeviceId(), []);

  useEffect(() => {
    if (user === null) return;
    let cancelled = false;
    fetchProjects({ base_url: config.base_url, token: user.token })
      .then(({ projects }) => {
        if (!cancelled) setRailProjects(projects);
      })
      .catch(() => {
        // Non-fatal: the rail falls back to the current project alone.
        if (!cancelled) setRailProjects(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user, config.base_url, project_id]);

  // ── WARM THE TAP (instant-switch, 2026-07-31) ─────────────────────────────
  // Everything a rail tap needs to render the destination is knowable BEFORE
  // the tap: which tabs that project shows, and which one this device left it
  // on. Resolving them on arrival is what produced the tab-bar flip and the
  // pause between finger-up and the first repaint. The rail already names every
  // project, so ask once, here, for the window the owner switches within.
  // Failures are silent by design — an un-warmed project simply resolves its
  // own on arrival, exactly as before.
  const railIds = useMemo(() => (railProjects ?? []).map((p) => p.id), [railProjects]);
  // A stable dependency for the effect below. The rail list refetches on every
  // switch and hands back a fresh array even when the projects are identical,
  // so keying the prefetch on the CONTENT is what keeps it a once-per-session
  // job rather than a once-per-tap one.
  const railIdsKey = railIds.join(',');
  useEffect(() => {
    if (user === null) return;
    const ids = railIds;
    if (ids.length === 0) return;
    let cancelled = false;
    void lastTabStorage().prime(ids);
    // Held off the first paint on purpose: this is work for a tap that has not
    // happened yet, and it must never compete with the transcript the owner is
    // waiting to read right now.
    const handle = setTimeout(() => {
      const client = new TabsClient({ base_url: config.base_url, token: user.token });
      const targets = ids.filter((id) => id !== project_id).slice(0, TAB_PREFETCH_LIMIT);
      void Promise.allSettled(
        targets.map(async (id) => {
          const descriptors = await client.listProjectTabs(id);
          if (!cancelled) mergeTabs(id, descriptors);
        }),
      );
    }, TAB_PREFETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // `project_id` is read only to skip the scope its own effect is already
    // fetching; re-running this whole prefetch on every switch would be pure
    // waste, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, config.base_url, railIdsKey, mergeTabs]);

  // ── PRE-CACHE THE REST (background warming, 2026-07-31) ───────────────────
  // The tap's other two inputs are already warm before it happens — the settings
  // doc (filed from the rail's own list, `projects.ts:185`) and the tab set (the
  // effect above). The TRANSCRIPT was the one still fetched on arrival, which is
  // why a scope this device has never visited still flashed an empty state
  // before its history landed (#20, reported and left open). This pulls it
  // ahead of the tap, active scope excluded, bounded and yielding — everything
  // about WHEN lives in `transcript-warmer.ts`, not here.
  // General leads: it is the default scope, the one the rail always offers, and
  // the largest transcript on a typical install.
  useTranscriptWarming({
    base_url: config.base_url,
    user: user === null ? null : { id: user.id, token: user.token },
    scopes: [GENERAL_PROJECT_ID, ...railIds],
    activeScope: project_id,
  });

  useEffect(() => {
    if (user === null) return;
    const live = startProjectsRailLive({
      base_url: config.base_url,
      token: user.token,
      device_id: deviceId,
      onSnapshot: (projects: RailProject[]) => {
        setRailOverlay(
          new Map(projects.map((p) => [p.id, { activity: p.activity, live_runs: p.live_runs }])),
        );
      },
    });
    return () => live.stop();
  }, [user, config.base_url, deviceId]);

  // ACTIVITY INSPECTOR data source: HTTP snapshot for the backlog + clocks, and a
  // dedicated read-only app-ws subscription for the live rows. Memoised on the
  // credential so the drawer's effect doesn't tear down and re-subscribe on every
  // layout render.
  const activitySource = useMemo(() => {
    const token = user?.token ?? '';
    const client = new AppActivityClient({ base_url: config.base_url, token });
    return {
      snapshot: (pid: string | null) => client.snapshot(pid),
      subscribe: (scope_key: string, onRow: (row: ActivityRow) => void): (() => void) => {
        const live = startActivityLive({
          base_url: config.base_url,
          token,
          scope_key,
          device_id: deviceId,
          onRow,
        });
        return () => live.stop();
      },
    };
  }, [config.base_url, user?.token, deviceId]);

  // USAGE METER — the tab band's bottom seam. Read here (rather than inside the
  // bar) so the bar stays pure presentation, matching every other datum it
  // renders. Unknown until the first response, which draws the plain hairline.
  const usage = useCredentialUsage({
    base_url: config.base_url,
    token: user?.token ?? null,
  });

  // `null` on a non-tab sub-route (chat-sync/notes/backups/bare cores) AND on a
  // legacy leaf no longer in the registry set: no tab is highlighted there and
  // `handleTabSelect` then lets every tab tap navigate. Route-driven against
  // the live `displayTabs`.
  const activeTab = activeTabKeyFromSegments(segments, displayTabs);
  // The slot fade keys off the actual route leaf (not the highlighted tab) so
  // it animates across non-tab routes too, and never receives a null key.
  const slotKey = segments[segments.length - 1] ?? 'chat';
  const [drawerOpen, setDrawerOpen] = useState(false);
  // ACTIVITY INSPECTOR (SPEC § WAVE 3.5) — the drawer opened by the rail's activity
  // dot. `activityOpen` is separate from `activityScope` because General is a real
  // scope, so no scope value can double as the closed sentinel.
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityScope, setActivityScope] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;

  // M2.4 — invite modal state. The shell owns the async
  // generateInvite() call; <InviteModal> stays presentational.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteModalResult | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Create-project sheet, opened from the rail's `+`. The affordance used to be
  // the bottom bar of the projects-list screen; that screen is deleted (SPEC §
  // Decisions Log 2026-07-27), so this IS create-project on mobile — without it
  // the rail button would be dead and nothing on the device could make a project.
  const [createOpen, setCreateOpen] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const openInvite = (): void => {
    setInviteResult(null);
    setInviteError(null);
    setInviteOpen(true);
  };
  const closeInvite = (): void => {
    setInviteOpen(false);
  };
  const submitInvite = (invitee_email: string): void => {
    setInviteSubmitting(true);
    setInviteError(null);
    generateInvite(invitee_email)
      .then((res) => {
        setInviteResult({ invite_url: res.invite_url, expires_at_ms: res.expires_at_ms });
      })
      .catch((err: unknown) => {
        setInviteError(inviteErrorCopy(err));
      })
      .finally(() => {
        setInviteSubmitting(false);
      });
  };

  useEffect(() => {
    // Persist only a real, persistable native tab. The route leaf is the
    // canonical last-tab value (`docs`, not the `documents` descriptor key);
    // Core webview tabs + non-tab sub-routes resolve to null and leave the
    // preference untouched. `index.tsx` redirects to this on a bare open.
    const persistable = lastTabValueForLeaf(slotKey);
    if (persistable !== null) void lastTabStorage().set(project_id, persistable);
  }, [project_id, slotKey]);

  // What the CONTENT PANE shows. There is NO early return here on purpose: the
  // rail, header and tab bar are persistent chrome and must stay mounted across a
  // project switch. Returning a bare spinner from the shell (what this file used
  // to do while the new scope's settings doc was in flight) tore all three down
  // and rebuilt them on every rail tap — that teardown, not slow rendering, is
  // why switching projects flickered. Rationale + the loading/not-found rules
  // live in `lib/project-shell-content.ts`.
  const content = projectShellContent({
    is_general: isGeneral,
    has_project: project !== null,
    error,
  });

  const handleTabSelect = (key: string): void => {
    if (key === activeTab) return;
    const target = displayTabs.find((t) => t.key === key);
    if (target === undefined) return;
    router.replace(target.route);
  };

  // The name the persistent chrome shows. `project` is null for the frames where
  // this scope's settings doc is still in flight, and the header must NOT
  // disappear (or show the previous project's name) in that window — so fall back
  // to the name the already-loaded rail list carries for this id. Both sources are
  // the real name; '' is the honest last resort, never a fabricated placeholder
  // (ISSUES #393).
  const railEntry = (railProjects ?? []).find((p) => p.id === project_id);
  const scopeName = project?.name ?? railEntry?.name ?? '';
  const scopeEmoji = (project?.emoji ?? railEntry?.emoji ?? '').length > 0
    ? (project?.emoji ?? railEntry?.emoji ?? '')
    : '📁';

  // Rail view list: the navigable (solo) projects, most-recent-first, mapped to
  // the minimal rail shape. Seed with the current project so the rail is never
  // empty on first paint (before the HTTP list resolves).
  const railList: RailProjectView[] = (() => {
    const navigable = (railProjects ?? []).filter((p) => projectCardInteractivity(p).navigable);
    const views: RailProjectView[] = sortProjectsByActivity(navigable).map((p) => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      unread_count: p.unread_count,
      origin_instance: p.origin_instance,
    }));
    if (!views.some((v) => v.id === project_id)) {
      views.unshift({
        id: project_id,
        name: scopeName,
        emoji: scopeEmoji,
        unread_count: 0,
        origin_instance: 'local',
      });
    }
    // ISSUES #403 — General is the NO-PROJECT scope, not a row in `projects`,
    // so it never arrives from the API and the mobile rail simply had no entry
    // for it. The web rail synthesizes one (`ChatApp.tsx` GENERAL_EMOJI /
    // isGeneral) and mobile must do the same, or General is unreachable — it
    // holds the largest single conversation on a typical install.
    // Pinned to the head: it is the default scope, and `railDotKind` already
    // knows never to show an activity dot for it.
    if (!views.some((v) => v.id === GENERAL_PROJECT_ID)) {
      views.unshift({
        id: GENERAL_PROJECT_ID,
        name: 'General',
        emoji: '💬',
        unread_count: 0,
        origin_instance: 'local',
      });
    }
    return views;
  })();

  // The Work-tab live-run badge = the current project's live_runs (overlay).
  const workBadge = workTabBadgeCount(railOverlay.get(project_id)?.live_runs);
  const tabBadges = workBadge !== null ? new Map([[WORK_TAB_KEY, workBadge]]) : undefined;

  const onRailSelect = (id: string): void => {
    if (id !== project_id) {
      // STRAIGHT TO THE DESTINATION — no `/projects/<id>` hop.
      //
      // The waypoint has to ask the ROUTER which project it is standing in, and
      // across an in-app switch the router can answer with the PREVIOUS one: the
      // shell is a single root-stack screen named `projects/[id]`, and
      // expo-router only treats a dynamic segment as diverging when the route
      // name is exactly `[id]` (`matchDynamicName`, `/^\[([^[\]]+?)\]$/` —
      // expo-router 6.0.24), so the switch is applied to the CHILD navigator and
      // the root route keeps the id you came FROM. Instrumented on device 2026-07-31 (project
      // names neutralised): `rail:tap=harbor:cur=willow; wp:mount=harbor;
      // wp:mount=willow; wp:go=willow/chat` — every rail tap landed on the
      // previously-active project, and the tapped one never loaded.
      //
      // A tap already carries the id, exactly and unambiguously. Resolving the
      // last tab HERE and replacing once means nothing downstream has to
      // re-derive a scope it can get wrong: the id travels in this closure, not
      // through the router. (General was the one scope that appeared to work,
      // because it needs no fetch and its handoff usually won the race — the
      // race is what is deleted here, for every scope alike.)
      //
      // AND IN THIS TICK, when the destination is already known. The `await`
      // below is an AsyncStorage bridge round-trip, and until it came back
      // NOTHING on screen had acknowledged the tap — the owner sat looking at
      // the project they had just left. The shell primes this device's last-tab
      // preference for every rail project when the list lands, so the common
      // case answers from memory; `null` means genuinely not-yet-known and we
      // wait for the real read rather than guessing a tab.
      const known = projectTabRouteSync(id);
      if (known !== null) {
        router.replace(known as Parameters<typeof router.replace>[0]);
        return;
      }
      void (async () => {
        router.replace(
          (await projectTabRoute(id)) as Parameters<typeof router.replace>[0],
        );
      })();
      return;
    }
    // ISSUES #401 — tapping the project you are ALREADY on must still do
    // something useful. Previously both the rail and this handler suppressed
    // it, so the first rail entry (active on mount) was unopenable: its chat
    // never loaded and the only workaround was switching to another tab and
    // back. Route to this project's chat explicitly — that is what the tap
    // means, and it is idempotent if the chat is already showing.
    router.replace(`/projects/${encodeURIComponent(id)}/chat`);
  };
  // The `+` affordance opens the create sheet OVER the chat — no navigation, no
  // separate screen (the list screen that used to own "+ Create Project" is gone).
  const onRailCreate = (): void => {
    setCreateError(null);
    setCreateOpen(true);
  };

  const submitCreate = (name: string): void => {
    if (user === null || createSubmitting) return;
    setCreateSubmitting(true);
    setCreateError(null);
    createProject({ base_url: config.base_url, token: user.token, name })
      .then((created) => {
        setCreateOpen(false);
        // Straight into the new project's CHAT. The rail list refetches on the
        // project_id change, so the new entry appears without a manual refresh.
        router.replace(
          chatRouteForProject(created.id) as Parameters<typeof router.replace>[0],
        );
      })
      .catch((err: unknown) => {
        setCreateError(createProjectErrorCopy(err));
      })
      .finally(() => {
        setCreateSubmitting(false);
      });
  };

  // Show the Invite pill only when the gateway can actually mint a link:
  // the caller is an owner/admin AND the project is a group (not
  // personal). Personal projects — ~100% of prod today — have no
  // workspace to host collaborators, so the mint path returns
  // `not_group`/`workspace_unavailable`; surfacing Invite there is a
  // guaranteed dead-end (Argus r1 BLOCKING). The predicate mirrors the
  // gateway resolver + handler authz; see `lib/invite-helpers.ts`.
  // Suppressed until this scope's doc has actually loaded: the predicate reads
  // `billing_mode` + `members`, and there is no honest answer without them.
  const canInvite = project !== null && canInviteToProject(project, user?.id ?? null);

  // What covers the content pane while this scope is not ready. `null` once it
  // is. Every one of these is drawn OVER the slot, never INSTEAD of it — see
  // below.
  const contentOverlay =
    content.kind === 'ready' ? null : content.kind === 'loading' ? (
      <View style={[styles.contentFill, styles.centered]} testID="project-content-loading">
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    ) : content.kind === 'unavailable' ? (
      // The server was asked and could not answer. NOT "project not found" — the
      // owner is looking at this project in the rail, and blaming the project for
      // a transport failure sends them hunting the wrong thing. Retry re-runs
      // THIS scope's fetch in place; the rail stays live either way.
      <ProjectLoadFailedPane
        message={content.message}
        onRetry={() => {
          void refresh();
        }}
      />
    ) : (
      <ProjectNotFoundFallback
        id={project_id}
        onBack={() => router.replace(GENERAL_CHAT_ROUTE as Parameters<typeof router.replace>[0])}
        {...(content.message !== undefined ? { message: content.message } : {})}
      />
    );

  // The content pane. THE SLOT IS MOUNTED IN EVERY STATE; the loading, offline
  // and not-found panes are drawn on top of it, opaque and full-bleed, instead
  // of replacing it.
  //
  // This is not a cosmetic choice. `<Slot/>` IS the `[id]` group's navigator:
  // unmounting it destroys that navigator's state, and remounting re-seeds it
  // from the PARENT route — which, across an in-app project switch, still says
  // the project you came FROM. (The shell is one root-stack screen named
  // `projects/[id]`, and expo-router only diverges on a dynamic segment whose
  // route name is exactly `[id]`; see `lib/project-tab-route.ts` for the full
  // trace.) The re-seeded navigator opens at its initial route — the
  // `/projects/<id>` waypoint — carrying the STALE id, and the waypoint's whole
  // job is to navigate, so the owner was thrown back to the previous project.
  //
  // Every real project switch went through `loading` (the new scope's settings
  // doc is always in flight for a frame), so every real project switch tore the
  // navigator down. General never does — it has no doc to fetch — which is the
  // entire reason General was the one scope the rail could reach.
  const contentPane = (
    <View style={styles.contentFill}>
      <SlotFader keyId={slotKey} scopeId={project_id}>
        <Slot />
      </SlotFader>
      {contentOverlay !== null ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="auto">
          {contentOverlay}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <ProjectHeader
        name={scopeName}
        // The left slot is the APP-level entry (server editor + Admin + sign
        // out), not a back arrow: there is no list to go back to, and this
        // header is now the only place either route is reachable from (#385).
        onOpenAppSettings={() => router.push('/settings')}
        onOpenSettings={() => setDrawerOpen(true)}
        {...(canInvite ? { onInvite: openInvite } : {})}
      />
      {wide ? (
        <View style={styles.wideBody}>
          <ProjectTabBar
            active={activeTab}
            onSelect={handleTabSelect}
            tabs={displayTabs}
            badges={tabBadges}
            usage={usage}
          />
          <View style={styles.wideContent}>{contentPane}</View>
        </View>
      ) : (
        // Mobile: Telegram-folder rail on the left, seated tabs + content on the
        // right (mirrors the signed-off mobile prototype's `body` grid).
        <View style={styles.railBody}>
          <ProjectRail
            projects={railList}
            overlay={railOverlay}
            activeProjectId={project_id}
            onSelect={onRailSelect}
            onCreate={onRailCreate}
            onOpenActivity={(railId) => {
              // The rail id is `'~general'` for General, `''`-free otherwise;
              // `activityScopeKey` normalises it to the SERVER's scope key ('general'
              // or the project id). See the three-representations note in
              // `lib/activity-client.ts`.
              setActivityScope(activityScopeKey(railId));
              setActivityOpen(true);
            }}
          />
          <View style={styles.railMain}>
            <ProjectTabBar
              active={activeTab}
              onSelect={handleTabSelect}
              tabs={displayTabs}
              badges={tabBadges}
              usage={usage}
            />
            <View style={styles.narrowContent}>{contentPane}</View>
          </View>
        </View>
      )}
      {/* THE COMPOSER BAND — full viewport width, under BOTH layouts, and the
          last thing in the column so its bottom edge is the window's. The rail
          row above is `flex: 1`, so the band takes its natural height out of the
          row rather than covering it: no rail entry can end up underneath the
          composer, and the rail's ScrollView simply gets shorter.
          See `lib/composer-dock.tsx` for why the composer moves in the TREE. */}
      <ComposerDock />
      <ProjectSettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <CreateProjectSheet
        open={createOpen}
        submitting={createSubmitting}
        errorText={createError}
        onCancel={() => setCreateOpen(false)}
        onSubmit={submitCreate}
      />
      {/* The Activity Inspector — the tmux replacement, opened by the rail's dot. */}
      <ActivityInspectorDrawer
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        source={activitySource}
        projectId={activityScope}
        label={
          activityScope === null || activityScope === 'general'
            ? 'General'
            : (railList.find((p) => p.id === activityScope)?.name ?? activityScope)
        }
      />
      <InviteModal
        open={inviteOpen}
        projectName={scopeName}
        submitting={inviteSubmitting}
        result={inviteResult}
        errorText={inviteError}
        onCancel={closeInvite}
        onSubmit={submitInvite}
        onCopy={(text) => {
          void copyToClipboard(text);
        }}
      />
    </View>
  );
}

/**
 * Map a generateInvite rejection to user-facing copy. The
 * ProjectsClientError carries a server `code` we translate; everything
 * else falls back to a generic line.
 */
function inviteErrorCopy(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'forbidden':
      return 'Only the project owner can invite members.';
    case 'not_group':
      return 'Promote this project to a group before inviting.';
    case 'workspace_unavailable':
      return 'Sharing isn’t available for this project yet.';
    case 'invalid_email':
      return 'That email doesn’t look right — check and try again.';
    case 'invite_not_configured':
      return 'Inviting isn’t enabled on this server yet.';
    default:
      return 'Couldn’t create the link. Try again in a moment.';
  }
}

/**
 * Wraps the Slot child in an Animated.View whose opacity briefly dips
 * when the active tab changes (1.0 → 0.4 → 1.0 over MOTION.fast). No
 * slide. Disabled under reduce-motion. The `keyId` prop drives the
 * fade — anything that re-renders with a new keyId triggers the dip.
 *
 * `scopeId` suppresses the dip across a PROJECT switch. `keyId` is the route
 * leaf, and a rail tap moves through `/projects/<id>` → `/projects/<id>/chat`,
 * so a switch changed the leaf twice and fired TWO opacity dips on top of the
 * content pane's own loading state — a visible flicker on the one interaction
 * that has to feel instant. The dip is for tab switches WITHIN a project; a
 * scope change re-baselines without animating.
 */
function SlotFader({
  keyId,
  scopeId,
  children,
}: {
  keyId: string;
  scopeId: string;
  children: React.ReactNode;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  const lastKey = useRef<string>(keyId);
  const lastScope = useRef<string>(scopeId);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((rm) => {
        if (!cancelled) setReduceMotion(rm);
      })
      .catch(() => {
        if (!cancelled) setReduceMotion(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const scopeChanged = lastScope.current !== scopeId;
    lastScope.current = scopeId;
    if (scopeChanged) {
      // A project switch: adopt the new leaf silently, full opacity, no dip.
      lastKey.current = keyId;
      opacity.setValue(1);
      return;
    }
    if (lastKey.current === keyId) return;
    lastKey.current = keyId;
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    Animated.sequence([
      Animated.timing(opacity, {
        toValue: 0.4,
        duration: MOTION.fast / 2,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: MOTION.fast / 2,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [keyId, scopeId, opacity, reduceMotion]);

  return <Animated.View style={[styles.fader, { opacity }]}>{children}</Animated.View>;
}

/**
 * "We asked and could not get an answer" — the honest pane for a scope whose
 * settings load FAILED for a reason that is not absence.
 *
 * It exists because the alternative states are both lies: an indefinite spinner
 * claims the answer is still coming when nothing is coming, and "Project not
 * found" blames a project the owner can see in the rail for what is actually
 * this device's connection. Retry is first-class here — unlike a genuinely
 * missing project, this one is very likely to work on the next attempt.
 */
function ProjectLoadFailedPane({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View style={[styles.contentFill, styles.centered]} testID="project-load-failed">
      <Text style={styles.errorTitle}>Couldn’t load this project</Text>
      <Text style={styles.errorBody}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try loading this project again"
        testID="project-load-retry"
        onPress={onRetry}
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
      >
        <Text style={styles.backBtnText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function ProjectNotFoundFallback({
  id,
  onBack,
  message,
}: {
  id: string;
  onBack: () => void;
  message?: string;
}) {
  const safeId = typeof id === 'string' ? id : String(id ?? '');
  return (
    // `contentFill`, not `container`: this pane now renders INSIDE the persistent
    // chrome for a missing project (so the rail is still there to tap out of it),
    // and the outer full-screen use (`ProjectLayout`, no scope id at all) is
    // centred either way, so it does not need the shell's status-bar padding.
    <View style={[styles.contentFill, styles.centered]}>
      <Text style={styles.errorTitle}>Project not found</Text>
      <Text style={styles.errorBody}>
        {message ??
          (safeId.length === 0
            ? 'No project id was supplied in the route.'
            : `The project id "${safeId}" is not available.`)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go to General chat"
        testID="project-not-found-back"
        onPress={onBack}
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
      >
        <Text style={styles.backBtnText}>Go to General chat</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
    paddingTop: SPACING.xxl + SPACING.lg,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xxl,
  },
  // A pane that fills whatever region it is placed in — the content pane inside
  // the chrome, or the whole screen when there is no scope to build chrome for.
  contentFill: { flex: 1, backgroundColor: THEME.background },
  wideBody: {
    flex: 1,
    flexDirection: 'row',
  },
  wideContent: { flex: 1 },
  // Mobile: rail (fixed) + main column (tabs + content).
  railBody: {
    flex: 1,
    flexDirection: 'row',
  },
  railMain: { flex: 1 },
  narrowContent: { flex: 1 },
  fader: { flex: 1 },
  errorTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  errorBody: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  backBtn: {
    marginTop: SPACING.lg,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md - SPACING.xs / 2,
    borderRadius: SPACING.md - SPACING.xs / 2,
    backgroundColor: THEME.text_primary,
  },
  backBtnText: {
    color: THEME.background,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
});

// Re-export the locked tab set so external callers (tests, future
// surfaces that want to iterate over the canonical lens list) don't
// need to reach into `components/ProjectTabBar.tsx`.
export { PROJECT_TABS };
