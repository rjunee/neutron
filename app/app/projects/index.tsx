/**
 * @neutronai/app — project list (P5.2 + ISSUES #9).
 *
 * Sprint roadmap § 4 / P5.2:
 *   "Project list screen (app/app/projects/index.tsx): top-level after
 *    login. Lists projects the user belongs to. Renders as cards with
 *    project name + last activity timestamp. Tap → /projects/<id>."
 *
 * ISSUES #9 wires the screen to the real `GET /api/app/projects`
 * endpoint. `loadProjects()` (sync stub) renders for the initial
 * paint so the screen never blanks; `fetchProjects()` then refreshes
 * with the canonical server list. Network failures keep the stub +
 * surface an inline footer warning.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  fetchProjects,
  formatLastActivity,
  loadProjects,
  projectCardInteractivity,
  type Project,
  type ProjectSourceError,
} from '../../lib/projects';
import { useAuthSession } from '../../lib/session';
import { signOut } from '../../lib/auth';
import { loadAppConfig } from '../../lib/config';
import { disablePushForUser } from '../../lib/push';
import { Toast } from '../../components/Toast';
import { joinedToastCopy, parseJoinedToast } from '../../lib/invite-helpers';

export default function ProjectListScreen() {
  const router = useRouter();
  const { user, clear } = useAuthSession();
  const [now, setNow] = useState(() => Date.now());
  const [serverProjects, setServerProjects] = useState<Project[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // M2.3 — per-workspace fan-out failures. Non-fatal: the rest of the
  // unified list still renders; these surface a quiet "unavailable" notice.
  const [sourceErrors, setSourceErrors] = useState<ProjectSourceError[]>([]);
  const [reloading, setReloading] = useState(false);
  // Stale-response guard: each fetch claims a sequence number; only the
  // newest claim is allowed to write state. A slow response from a prior
  // bearer (sign-out / account switch) or one that lands after unmount is
  // dropped — it can't overwrite the current user's list.
  const fetchSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // M2.4 — surface a "Joined <project> shared by <owner>" toast when
  // the post-accept redirect lands here with `?joined=…&by=…`. The
  // accept-redirect wiring that sets these params is S6/M2.1 scope;
  // the surfacing is in place now.
  const params = useLocalSearchParams();
  const joined = useMemo(() => parseJoinedToast(params), [params]);
  const [toastVisible, setToastVisible] = useState(false);
  useEffect(() => {
    if (joined !== null) setToastVisible(true);
  }, [joined]);

  useEffect(() => {
    if (user === null) {
      router.replace('/login');
    }
  }, [router, user]);

  // Re-tick once a minute so "12m ago" labels stay fresh while the
  // screen is open. No need to be precise — every minute is plenty.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // M2.3 / ISSUES #9 — pull the unified project list (solo + shared) from
  // the gateway. Falls back to `loadProjects()` (the sync stub) on the
  // first render so the screen never blanks; the fetched list replaces it
  // when the request resolves. Extracted to a callback so the degraded-
  // workspace "Retry" link can re-run it without remounting.
  const loadFromServer = useCallback(async (): Promise<void> => {
    if (user === null) return;
    const myReq = ++fetchSeq.current;
    // Only this fetch (the newest) may write state, and only while mounted.
    const isCurrent = (): boolean => mounted.current && fetchSeq.current === myReq;
    setReloading(true);
    try {
      const cfg = loadAppConfig();
      const { projects: list, sourceErrors: errs } = await fetchProjects({
        base_url: cfg.base_url,
        token: user.token,
      });
      if (!isCurrent()) return;
      setServerProjects(list);
      setSourceErrors(errs);
      setFetchError(null);
    } catch (err) {
      if (!isCurrent()) return;
      const msg = err instanceof Error ? err.message : 'fetch failed';
      setFetchError(msg);
    } finally {
      if (isCurrent()) setReloading(false);
    }
  }, [user]);

  useEffect(() => {
    // Bumping the sequence inside loadFromServer means a prior in-flight
    // fetch (e.g. the previous user's) is automatically superseded when
    // this effect re-fires on a user change.
    void loadFromServer();
  }, [loadFromServer]);

  const projects = useMemo(() => {
    if (serverProjects !== null) return serverProjects;
    return loadProjects(now);
  }, [now, serverProjects]);

  const handleOpen = useCallback(
    (project: Project) => {
      // M2.3 / Argus r1 BLOCKER #1 — shared (cross-instance) projects are NOT
      // navigable yet. The detail loader (`[id]/_layout.tsx` →
      // `project-state.tsx` → `client.getSettings(id)`) only ever reads the
      // LOCAL owner's project store; it has no notion of `origin`.
      // Pushing a shared project's id there silently opens a fake/empty
      // local project (the store auto-seeds a default for unknown ids) or,
      // on an id collision, the WRONG local project. The cross-instance
      // "project state by id" handler that a real shared-detail view needs
      // doesn't exist yet — only `GET /connect/v1/projects` (list) is
      // wired. Until that handler lands (ISSUES #82, deferred to P3), shared
      // cards are non-navigable: tapping is a no-op and the card renders a
      // "view coming soon" affordance. Solo projects open as before. The
      // navigability decision is single-sourced in `projectCardInteractivity`
      // so the card render + this guard can never drift.
      if (!projectCardInteractivity(project).navigable) return;
      router.push(`/projects/${project.id}`);
    },
    [router],
  );

  const handleSignOut = useCallback(async () => {
    // P5.6 — revoke the device push binding BEFORE clearing
    // auth state. The unregister POST is authenticated by the
    // current bearer token, so it has to happen while `user.token`
    // is still valid. `disablePushForUser` is best-effort and never
    // throws, so a permission-denied / gateway-unreachable failure
    // cannot block sign-out.
    if (user !== null) {
      try {
        const cfg = loadAppConfig();
        await disablePushForUser({ base_url: cfg.base_url, token: user.token });
      } catch (err) {
        console.warn('[push] unexpected error during disable', err);
      }
    }
    await signOut();
    clear();
    router.replace('/login');
  }, [clear, router, user]);

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  const joinedCopy = joined !== null ? joinedToastCopy(joined) : null;

  return (
    <View style={styles.container}>
      {joinedCopy !== null ? (
        <Toast
          message={joinedCopy.message}
          detail={joinedCopy.detail}
          visible={toastVisible}
          onDismiss={() => setToastVisible(false)}
        />
      ) : null}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerOverline}>Projects</Text>
          <Text style={styles.headerTitle}>{user.displayName}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open admin"
            testID="projects-admin-btn"
            onPress={() => router.push('/admin')}
            style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}
          >
            <Text style={styles.signOutText}>Admin</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={handleSignOut}
            style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={projects}
        // Composite key: a shared project from a workspace can share a
        // project_id with a local project (or another workspace's), so the
        // FlatList key MUST include the owning instance or React Native
        // collapses/drops the duplicate row.
        keyExtractor={(p) => `${p.origin_instance}:${p.id}`}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <ProjectCard project={item} now={now} onOpen={handleOpen} />
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No projects yet.</Text>
            <Text style={styles.emptyBody}>
              The "Create project" flow lands in a later P5.x sprint.
            </Text>
          </View>
        }
        ListFooterComponent={
          <ListFooter
            fetchError={fetchError}
            sourceErrors={sourceErrors}
            reloading={reloading}
            onRetry={loadFromServer}
          />
        }
      />
    </View>
  );
}

/**
 * M2.3 — quiet, non-blocking degradation footer. The unified list always
 * renders whatever it could fetch; this surfaces what it couldn't. Two
 * independent signals: a whole-fetch failure (cached list shown) and
 * per-workspace fan-out failures (the solo + healthy workspaces still
 * render). Neither blocks the screen. "Retry" re-runs the fetch in place.
 */
function ListFooter({
  fetchError,
  sourceErrors,
  reloading,
  onRetry,
}: {
  fetchError: string | null;
  sourceErrors: ProjectSourceError[];
  reloading: boolean;
  onRetry: () => void;
}) {
  const hasWorkspaceErrors = sourceErrors.length > 0;
  if (fetchError === null && !hasWorkspaceErrors) return null;
  const n = sourceErrors.length;
  return (
    <View style={styles.footer}>
      {fetchError !== null ? (
        <Text style={styles.footnote}>
          Could not refresh from gateway ({fetchError}). Showing cached list.
        </Text>
      ) : null}
      {hasWorkspaceErrors ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            {n} {n === 1 ? 'workspace' : 'workspaces'} unavailable
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading workspaces"
            testID="projects-retry-btn"
            disabled={reloading}
            onPress={onRetry}
            hitSlop={8}
          >
            <Text style={[styles.noticeRetry, reloading && styles.noticeRetryDisabled]}>
              {reloading ? 'Retrying…' : 'Retry'}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function ProjectCard({
  project,
  now,
  onOpen,
}: {
  project: Project;
  now: number;
  onOpen: (project: Project) => void;
}) {
  // M2.3 / Argus r1 BLOCKER #1 — shared (cross-instance) projects have no
  // working detail view yet (the detail loader is local-only). They
  // render as a non-interactive card with a quiet "view coming soon" hint
  // so the row never opens a fake/wrong local project. See `handleOpen`.
  // `projectCardInteractivity` single-sources the disabled/a11y/hint shape.
  const a11y = projectCardInteractivity(project);
  const isShared = project.kind === 'shared';
  return (
    <Pressable
      accessibilityRole={a11y.accessibilityRole}
      accessibilityLabel={a11y.accessibilityLabel}
      accessibilityState={a11y.accessibilityState}
      testID={`project-card-${project.origin_instance}:${project.id}`}
      disabled={a11y.disabled}
      onPress={() => onOpen(project)}
      style={({ pressed }) => [
        styles.card,
        isShared && styles.cardShared,
        pressed && !isShared && styles.cardPressed,
      ]}
    >
      <View style={styles.cardRow}>
        <Text style={styles.cardTitle}>{project.name}</Text>
        <Text style={styles.cardActivity}>{formatLastActivity(project.last_activity_ms, now)}</Text>
      </View>
      <Text style={styles.cardDescription}>{project.description}</Text>
      <View style={styles.cardMeta}>
        {isShared ? (
          <View style={styles.sharedPill} testID={`project-shared-pill-${project.id}`}>
            <Text style={styles.sharedPillText} numberOfLines={1}>
              Shared · {project.origin_instance}
            </Text>
          </View>
        ) : null}
        <Text style={styles.cardMetaText}>
          {project.members.length} {project.members.length === 1 ? 'member' : 'members'}
        </Text>
        <Text style={styles.cardMetaDot}>·</Text>
        <Text style={styles.cardMetaText}>{project.privacy_mode}</Text>
      </View>
      {a11y.hint !== null ? (
        <Text style={styles.sharedHint} testID={`project-shared-hint-${project.id}`}>
          {a11y.hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    paddingTop: 48,
  },
  centered: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  headerLeft: { flex: 1 },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerOverline: {
    color: '#7a7a7a',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 2 },
  signOut: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  signOutText: { color: '#ddd', fontSize: 12, fontWeight: '500' },
  pressed: { opacity: 0.7 },
  listContent: { padding: 16, gap: 12 },
  card: {
    backgroundColor: '#121212',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    gap: 6,
  },
  cardPressed: { opacity: 0.78, borderColor: '#2a2a2a' },
  // Shared cards are non-interactive (no working detail view yet). Slightly
  // recessed background + dashed-feel border so they read as "present but
  // not yet openable" rather than broken.
  cardShared: { backgroundColor: '#0f0f12', borderColor: '#23252e' },
  sharedHint: {
    color: '#6f7a93',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 8,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: { color: '#fafafa', fontSize: 17, fontWeight: '600', flex: 1 },
  cardActivity: { color: '#7a7a7a', fontSize: 12, fontWeight: '500' },
  cardDescription: { color: '#a0a0a0', fontSize: 13, lineHeight: 18 },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  cardMetaText: { color: '#7a7a7a', fontSize: 11, fontWeight: '500' },
  cardMetaDot: { color: '#3a3a3a', fontSize: 11 },
  // M2.3 — solo projects show no pill (absence is the default signal); a
  // shared workspace project gets ONE quiet blue-tinted pill naming its
  // workspace. Tinted neutrals (not pure gray), low contrast so it reads
  // as secondary metadata and never competes with the card title.
  sharedPill: {
    backgroundColor: '#1d2230',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    maxWidth: 180,
  },
  sharedPillText: {
    color: '#93a1c4',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  emptyState: { paddingTop: 64, alignItems: 'center', gap: 8 },
  emptyTitle: { color: '#ddd', fontSize: 18, fontWeight: '600' },
  emptyBody: { color: '#888', fontSize: 13, lineHeight: 18, textAlign: 'center' },
  footer: { marginTop: 24, gap: 12, paddingHorizontal: 16 },
  footnote: {
    color: '#5a5a5a',
    fontSize: 11,
    textAlign: 'center',
  },
  // Warm-tinted (not gray, not a loud alert), centered, with a ghost
  // Retry link. Quiet enough to ignore, present enough to act on.
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#1e1a12',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  noticeText: { color: '#c9a24b', fontSize: 12, fontWeight: '500' },
  noticeRetry: { color: '#e0bd6e', fontSize: 12, fontWeight: '700' },
  noticeRetryDisabled: { color: '#6a5d3a' },
});
