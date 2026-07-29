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
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { InviteModal, type InviteModalResult } from '../../../components/InviteModal';
import { copyToClipboard } from '../../../lib/clipboard';
import { canInviteToProject } from '../../../lib/invite-helpers';
import { PROJECT_TABS, ProjectTabBar } from '../../../components/ProjectTabBar';
import {
  GENERAL_PROJECT_ID,
  ProjectRail,
  type RailOverlayEntry,
} from '../../../components/ProjectRail';
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
import { ProjectStateProvider, useProjectState } from '../../../lib/project-state';
import type { ProjectSettings } from '../../../lib/projects-client';
import { useAuthSession } from '../../../lib/session';
import { TabsClient } from '../../../lib/tabs-client';

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
      <ProjectShell project_id={project_id} />
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
  const { project: fetchedProject, loading, error, generateInvite } = useProjectState();
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
  // `project_tab` surfaces. `null` until the fetch resolves; on error it stays
  // null and the loading default (the legacy `PROJECT_TABS`, resolved to native
  // routes) keeps showing — a graceful fallback, NOT a feature-flag alt path.
  const [fetchedTabs, setFetchedTabs] = useState<ResolvedTab[] | null>(null);
  useEffect(() => {
    if (user === null) return;
    let cancelled = false;
    // Drop the previous project's tabs immediately on a project switch — this
    // layout instance is reused across `project_id` changes, so without the
    // reset `displayTabs` would briefly hold the OLD project's routes (whose
    // `<id>` is baked in) and a tab tap would navigate back to it.
    setFetchedTabs(null);
    const client = new TabsClient({ base_url: config.base_url, token: user.token });
    client
      .listProjectTabs(project_id)
      .then((descriptors) => {
        if (!cancelled) setFetchedTabs(descriptorsToResolvedTabs(descriptors, project_id));
      })
      .catch(() => {
        // Endpoint absent / offline / auth — keep the loading default visible.
        if (!cancelled) setFetchedTabs(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user, config.base_url, project_id]);

  // The Work tab is not emitted by the tab registry, so the mobile shell always
  // injects it (after Chat) over BOTH the loading default and the fetched set —
  // one code path, idempotent. This is the tab the live-run badge lands on.
  const displayTabs = useMemo<ResolvedTab[]>(
    () => ensureWorkTab(fetchedTabs ?? loadingTabsForProject(project_id), project_id),
    [fetchedTabs, project_id],
  );

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

  // `null` on a non-tab sub-route (chat-sync/notes/backups/bare cores) AND on a
  // legacy leaf no longer in the registry set: no tab is highlighted there and
  // `handleTabSelect` then lets every tab tap navigate. Route-driven against
  // the live `displayTabs`.
  const activeTab = activeTabKeyFromSegments(segments, displayTabs);
  // The slot fade keys off the actual route leaf (not the highlighted tab) so
  // it animates across non-tab routes too, and never receives a null key.
  const slotKey = segments[segments.length - 1] ?? 'chat';
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  // One gate, so `project` narrows to non-null for the rest of the render. For
  // General this can never fire (the synthetic scope above is never null); for a
  // real project it covers all three prior states — still loading, load failed,
  // and loaded-but-absent.
  if (project === null) {
    if (loading) {
      return (
        <View style={[styles.container, styles.centered]}>
          <ActivityIndicator color={THEME.text_secondary} />
        </View>
      );
    }
    return (
      <ProjectNotFoundFallback
        id={project_id}
        onBack={() => router.replace(GENERAL_CHAT_ROUTE as Parameters<typeof router.replace>[0])}
        {...(error !== null ? { message: error.message } : {})}
      />
    );
  }

  const handleTabSelect = (key: string): void => {
    if (key === activeTab) return;
    const target = displayTabs.find((t) => t.key === key);
    if (target === undefined) return;
    router.replace(target.route);
  };

  // Rail view list: the navigable (solo) projects, most-recent-first, mapped to
  // the minimal rail shape. Seed with the current project so the rail is never
  // empty on first paint (before the HTTP list resolves). Computed inline (not a
  // hook) — this runs only past the early returns above, where `project` is
  // guaranteed non-null.
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
        name: project.name,
        emoji: project.emoji.length > 0 ? project.emoji : '📁',
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
      router.replace(`/projects/${encodeURIComponent(id)}`);
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
  const canInvite = canInviteToProject(project, user?.id ?? null);

  return (
    <View style={styles.container}>
      <ProjectHeader
        name={project.name}
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
          />
          <View style={styles.wideContent}>
            <SlotFader keyId={slotKey}>
              <Slot />
            </SlotFader>
          </View>
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
          />
          <View style={styles.railMain}>
            <ProjectTabBar
              active={activeTab}
              onSelect={handleTabSelect}
              tabs={displayTabs}
              badges={tabBadges}
            />
            <View style={styles.narrowContent}>
              <SlotFader keyId={slotKey}>
                <Slot />
              </SlotFader>
            </View>
          </View>
        </View>
      )}
      <ProjectSettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <CreateProjectSheet
        open={createOpen}
        submitting={createSubmitting}
        errorText={createError}
        onCancel={() => setCreateOpen(false)}
        onSubmit={submitCreate}
      />
      <InviteModal
        open={inviteOpen}
        projectName={project.name}
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
 */
function SlotFader({ keyId, children }: { keyId: string; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const lastKey = useRef<string>(keyId);
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
  }, [keyId, opacity, reduceMotion]);

  return <Animated.View style={[styles.fader, { opacity }]}>{children}</Animated.View>;
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
    <View style={[styles.container, styles.centered]}>
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
