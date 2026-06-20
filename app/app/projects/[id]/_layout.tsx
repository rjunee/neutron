/**
 * @neutronai/app — project detail shell (P5.2 refactor).
 *
 * Thin composer. Owns:
 *   - Mounting `<ProjectStateProvider>` per `project_id` so the
 *     gateway-backed settings doc loads exactly once + propagates to
 *     `<ProjectHeader>` / `<ProjectSettingsDrawer>` / future tab bodies.
 *   - Rendering the locked 5-tab set (chat / launcher / tasks /
 *     reminders / docs) via `<ProjectTabBar>` — Notes is NOT a tab.
 *   - The per-project last-tab persistence write path (the read path
 *     lives in `index.tsx`).
 *   - Swapping `<Slot />` children behind a 150ms opacity fade so tab
 *     switches feel responsive without pulling in `react-native-pager-
 *     view`. Disabled under reduce-motion.
 *   - The Project-not-found + Loading shells.
 *
 * All visual styling sources from `lib/theme.ts` tokens.
 */

import { Slot, useLocalSearchParams, useRouter, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import { InviteModal, type InviteModalResult } from '../../../components/InviteModal';
import { copyToClipboard } from '../../../lib/clipboard';
import { canInviteToProject } from '../../../lib/invite-helpers';
import {
  PROJECT_TABS,
  ProjectTabBar,
  type ProjectTabKey,
} from '../../../components/ProjectTabBar';
import { BREAKPOINTS, MOTION, SPACING, THEME, TYPOGRAPHY } from '../../../lib/composer-constants';
import { isLegalTab, lastTabStorage } from '../../../lib/last-tab-storage';
import { ProjectStateProvider, useProjectState } from '../../../lib/project-state';
import { useAuthSession } from '../../../lib/session';

function activeTabFromSegments(segments: readonly string[]): ProjectTabKey {
  const last = segments[segments.length - 1];
  if (isLegalTab(last)) return last;
  return 'chat';
}

export default function ProjectLayout() {
  const router = useRouter();
  const { user, status: authStatus } = useAuthSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project_id = typeof id === 'string' ? id : '';

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
    return <ProjectNotFoundFallback id={project_id} onBack={() => router.replace('/projects')} />;
  }

  return (
    <ProjectStateProvider project_id={project_id}>
      <ProjectShell project_id={project_id} />
    </ProjectStateProvider>
  );
}

function ProjectShell({ project_id }: { project_id: string }) {
  const router = useRouter();
  const segments = useSegments() as readonly string[];
  const { user } = useAuthSession();
  const { project, loading, error, generateInvite } = useProjectState();
  const activeTab = activeTabFromSegments(segments);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;

  // M2.4 — invite modal state. The shell owns the async
  // generateInvite() call; <InviteModal> stays presentational.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteModalResult | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

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
    void lastTabStorage().set(project_id, activeTab);
  }, [project_id, activeTab]);

  if (loading && project === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  if (project === null && error !== null) {
    return (
      <ProjectNotFoundFallback
        id={project_id}
        onBack={() => router.replace('/projects')}
        message={error.message}
      />
    );
  }

  if (project === null) {
    return (
      <ProjectNotFoundFallback id={project_id} onBack={() => router.replace('/projects')} />
    );
  }

  const handleTabSelect = (key: ProjectTabKey): void => {
    if (key === activeTab) return;
    router.replace(`/projects/${project_id}/${key}`);
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
        onBack={() => router.replace('/projects')}
        onOpenSettings={() => setDrawerOpen(true)}
        {...(canInvite ? { onInvite: openInvite } : {})}
      />
      {wide ? (
        <View style={styles.wideBody}>
          <ProjectTabBar active={activeTab} onSelect={handleTabSelect} />
          <View style={styles.wideContent}>
            <SlotFader keyId={activeTab}>
              <Slot />
            </SlotFader>
          </View>
        </View>
      ) : (
        <>
          <ProjectTabBar active={activeTab} onSelect={handleTabSelect} />
          <View style={styles.narrowContent}>
            <SlotFader keyId={activeTab}>
              <Slot />
            </SlotFader>
          </View>
        </>
      )}
      <ProjectSettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
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
        accessibilityLabel="Back to projects"
        testID="project-not-found-back"
        onPress={onBack}
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
      >
        <Text style={styles.backBtnText}>Back to projects</Text>
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
