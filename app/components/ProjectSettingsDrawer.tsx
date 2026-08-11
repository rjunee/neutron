/**
 * @neutronai/app — project settings drawer (P5.2).
 *
 * Right-aligned controlled side-sheet, overlay on top of the project
 * shell. Five sections in render order:
 *
 *   1. Description (read-only).
 *   2. Persona (read-only — editor lands in P5.7 admin).
 *   3. Privacy mode (EDITABLE — three-option segmented control;
 *      tap → optimistic flip + PATCH; failure reverts).
 *   4. Billing mode (read-only badge).
 *   5. Members (read-only list; owner first, then alphabetic).
 *
 * Mechanics:
 *   - `open=false` renders nothing.
 *   - `open=true` mounts the overlay (backdrop + panel) over
 *     `MOTION.base` slide + `MOTION.fast` fade. Reduce-motion
 *     accessibility preference disables the animation.
 *   - Backdrop tap, close-button tap, and Android hardware-back press
 *     all call onClose.
 *   - Reads project state from `useProjectState()`. The provider is
 *     mounted by the layout — passing the project data through props
 *     would force the layout to know about the drawer's data needs.
 *
 * Pure consumer of `lib/theme.ts` tokens. Every color / radius /
 * motion duration sources from the theme.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { copyToClipboard } from '../lib/clipboard';
import { BREAKPOINTS, DENSITY, MOTION, SPACING, TYPOGRAPHY, type NeutronTheme } from '../lib/composer-constants';
import { useTheme, useThemedStyles } from '../lib/theme-context';
import { loadAppConfig } from '../lib/config';
import {
  type ConnectBadgeTone,
  canManageConnectMembers,
  canRevokeConnectMember,
  connectBadge,
  connectMemberSort,
  outstandingConnectInvites,
  formatAcceptLinkExpiry,
} from '../lib/connect-member-helpers';
import {
  ConnectMembersClient,
  ConnectMembersClientError,
  type ConnectInviteDelivery,
  type ConnectInviteResult,
  type ConnectInviteScope,
  type ConnectInviteView,
  type ConnectMemberView,
} from '../lib/connect-members-client';
import { useProjectState } from '../lib/project-state';
import {
  ALL_PRIVACY_MODES,
  type BillingMode,
  type PrivacyMode,
  type ProjectMember,
  type ProjectSettings,
} from '../lib/projects-client';
import { useAuthSession } from '../lib/session';

export interface ProjectSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

const PRIVACY_LABELS: Record<PrivacyMode, string> = {
  private: 'Private',
  public: 'Public',
};

const PRIVACY_BLURBS: Record<PrivacyMode, string> = {
  private: 'Only the project owner sees the contents.',
  public: 'Anyone with the link can see the contents.',
};

const BILLING_LABELS: Record<BillingMode, string> = {
  personal: 'Personal',
};

const NARROW_PANEL_WIDTH = 360;
const WIDE_PANEL_WIDTH = 420;

interface ConnectMembersState {
  loading: boolean;
  members: ConnectMemberView[];
  /** Outstanding invites (ISSUES #421 residual) — the ones the owner can still
   *  withdraw, and the ones holding the Connect surface open. */
  invites: ConnectInviteView[];
  /** Honest error reason (e.g. connect_not_configured); null when ok. */
  error: { code: string; message: string } | null;
  /** True once a fetch has resolved at least once for this open cycle. */
  loaded: boolean;
}

const EMPTY_CONNECT_STATE: ConnectMembersState = {
  loading: false,
  members: [],
  invites: [],
  error: null,
  loaded: false,
};

/**
 * Lazily load + manage the Connect (cross-org) member roster for a
 * project. Fetches when `enabled` flips true (the drawer opens) so the
 * existing project-state load is never blocked. Exposes optimistic
 * `revoke` with revert-on-failure and an `issue` that returns the minted
 * accept link to the caller.
 */
function useConnectMembers(projectId: string | null, enabled: boolean) {
  const { user } = useAuthSession();
  const [state, setState] = useState<ConnectMembersState>(EMPTY_CONNECT_STATE);

  const client = useMemo<ConnectMembersClient | null>(() => {
    if (user === null) return null;
    const cfg = loadAppConfig();
    return new ConnectMembersClient({ base_url: cfg.gateway_base_url, token: user.token });
  }, [user]);

  const reload = useCallback(async (): Promise<void> => {
    if (client === null || projectId === null) return;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      // Members and invites are two reads of the same subject; a drawer that
      // showed the roster but not the outstanding invites would still leave the
      // owner unable to see the thing holding their Connect surface open.
      // `allSettled`, not `all`: the roster is the primary content and must not
      // be lost because the ledger read failed.
      const [membersRes, invitesRes] = await Promise.allSettled([
        client.listMembers(projectId),
        client.listInvites(projectId),
      ]);
      if (membersRes.status === 'rejected') throw membersRes.reason;
      setState({
        loading: false,
        members: membersRes.value,
        invites: invitesRes.status === 'fulfilled' ? invitesRes.value : [],
        error: null,
        loaded: true,
      });
    } catch (err) {
      setState({
        loading: false,
        members: [],
        invites: [],
        error: toConnectError(err),
        loaded: true,
      });
    }
  }, [client, projectId]);

  // Fetch once per open cycle; reset to empty when the drawer closes so a
  // reopen re-fetches fresh (membership may have changed out-of-band).
  useEffect(() => {
    if (!enabled) {
      setState(EMPTY_CONNECT_STATE);
      return;
    }
    void reload();
  }, [enabled, reload]);

  const issue = useCallback(
    async (input: {
      delivery: ConnectInviteDelivery;
      scope: ConnectInviteScope;
      invitee_email?: string;
    }): Promise<ConnectInviteResult> => {
      if (client === null || projectId === null) {
        throw new ConnectMembersClientError({
          code: 'no_client',
          message: 'not signed in',
          status: 0,
        });
      }
      const result = await client.issueInvite(projectId, input);
      // The invite the owner just minted is outstanding from this moment; the
      // ledger must show it without waiting for a drawer reopen.
      void reload();
      return result;
    },
    [client, projectId, reload],
  );

  /**
   * Withdraw an outstanding invite (ISSUES #421 residual). Optimistic — the row
   * disappears immediately because `outstandingConnectInvites` only renders
   * `live` ones — and reverts on failure, the same contract as member revoke.
   */
  const revokeInvite = useCallback(
    async (inviteId: string): Promise<void> => {
      if (client === null || projectId === null) return;
      const prior = state.invites;
      setState((p) => ({
        ...p,
        invites: p.invites.map((i) =>
          i.invite_id === inviteId ? { ...i, state: 'revoked' as const } : i,
        ),
      }));
      try {
        await client.revokeInvite(projectId, inviteId);
      } catch {
        setState((p) => ({ ...p, invites: prior }));
      }
    },
    [client, projectId, state.invites],
  );

  const revoke = useCallback(
    async (localSlug: string): Promise<void> => {
      if (client === null || projectId === null) return;
      // Optimistic: flip the row to revoked immediately.
      const prior = state.members;
      setState((p) => ({
        ...p,
        members: p.members.map((m) =>
          m.local_slug === localSlug ? { ...m, status: 'revoked' as const } : m,
        ),
      }));
      try {
        await client.revokeMember(projectId, localSlug);
      } catch {
        // Revert on failure.
        setState((p) => ({ ...p, members: prior }));
      }
    },
    [client, projectId, state.members],
  );

  return { ...state, issue, revoke, revokeInvite } as const;
}

function toConnectError(err: unknown): { code: string; message: string } {
  if (err instanceof ConnectMembersClientError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) return { code: 'unknown', message: err.message };
  return { code: 'unknown', message: 'unknown error' };
}

export function ProjectSettingsDrawer({ open, onClose }: ProjectSettingsDrawerProps) {
  const styles = useThemedStyles(makeStyles);
  const { project, loading, error, pending_privacy, updatePrivacy } = useProjectState();
  const { user } = useAuthSession();
  const connect = useConnectMembers(project?.id ?? null, open && project !== null);
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;
  const panelWidthCap = wide ? WIDE_PANEL_WIDTH : NARROW_PANEL_WIDTH;
  const panelWidth = Math.min(panelWidthCap, width > 0 ? Math.floor(width * 0.9) : panelWidthCap);

  const translateX = useRef(new Animated.Value(panelWidth)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(open);
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
    if (open) {
      setMounted(true);
      const dur = reduceMotion ? 0 : MOTION.base;
      const fade = reduceMotion ? 0 : MOTION.fast;
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: dur,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: fade,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      const dur = reduceMotion ? 0 : MOTION.base;
      const fade = reduceMotion ? 0 : MOTION.fast;
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: panelWidth,
          duration: dur,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: fade,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [open, mounted, panelWidth, opacity, translateX, reduceMotion]);

  useEffect(() => {
    if (!open) return undefined;
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close settings drawer"
          testID="project-drawer-backdrop"
          onPress={onClose}
          style={styles.backdropPressable}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.panel,
          {
            width: panelWidth,
            transform: [{ translateX }],
          },
        ]}
        accessibilityViewIsModal
        testID="project-drawer-panel"
      >
        <ScrollView contentContainerStyle={styles.panelContent}>
          <PanelHeader projectName={project?.name ?? 'Project settings'} onClose={onClose} />
          {loading && project === null ? (
            <Text style={styles.loadingText}>Loading project settings…</Text>
          ) : project === null ? (
            <Text style={styles.errorText}>
              {error?.message ?? 'Project settings could not be loaded.'}
            </Text>
          ) : (
            <ProjectSections
              project={project}
              pendingPrivacy={pending_privacy}
              error={error}
              currentUserId={user?.id ?? null}
              connect={connect}
              onPrivacyChange={updatePrivacy}
              onOpenBackups={() => {
                onClose();
                router.push(`/projects/${project.id}/backups`);
              }}
            />
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function PanelHeader({ projectName, onClose }: { projectName: string; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.panelHeader}>
      <View style={styles.panelHeaderText}>
        <Text style={styles.overline}>Project settings</Text>
        <Text style={styles.panelTitle} numberOfLines={2}>
          {projectName}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close settings drawer"
        testID="project-drawer-close"
        onPress={onClose}
        style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
      >
        <Text style={styles.closeGlyph}>✕</Text>
      </Pressable>
    </View>
  );
}

type ConnectController = ReturnType<typeof useConnectMembers>;

interface SectionsProps {
  project: ProjectSettings;
  pendingPrivacy: PrivacyMode | null;
  error: { code: string; message: string; field?: string } | null;
  currentUserId: string | null;
  connect: ConnectController;
  onPrivacyChange: (mode: PrivacyMode) => void;
  onOpenBackups: () => void;
}

function ProjectSections({
  project,
  pendingPrivacy,
  error,
  currentUserId,
  connect,
  onPrivacyChange,
  onOpenBackups,
}: SectionsProps) {
  const styles = useThemedStyles(makeStyles);
  const sortedMembers = sortMembers(project.members);
  const privacyError = error !== null && pendingPrivacy === null ? error : null;
  return (
    <View style={styles.sections}>
      <Section label="Description">
        <Text style={styles.fieldValue}>{nonEmpty(project.description, 'Not configured')}</Text>
      </Section>

      <Section label="Persona">
        <Text style={styles.fieldValue}>{nonEmpty(project.persona, 'Not configured')}</Text>
        <Text style={styles.fieldHint}>Persona editing lands in P5.7 admin.</Text>
      </Section>

      <Section label="Privacy mode">
        <PrivacySegmentedControl
          value={project.privacy_mode}
          pending={pendingPrivacy}
          onChange={onPrivacyChange}
        />
        <Text style={styles.fieldHint}>{PRIVACY_BLURBS[project.privacy_mode]}</Text>
        {privacyError !== null ? (
          <Text style={styles.fieldError}>
            Could not change privacy: {privacyError.message}
          </Text>
        ) : null}
      </Section>

      <Section label="Billing mode">
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{BILLING_LABELS[project.billing_mode]}</Text>
        </View>
      </Section>

      <Section label="Members">
        {sortedMembers.length === 0 ? (
          <Text style={styles.fieldValue}>No members yet.</Text>
        ) : (
          <View style={styles.memberList}>
            {sortedMembers.map((m) => (
              <View key={m.user_id} style={styles.memberRow}>
                <Text style={styles.memberName}>{m.name}</Text>
                <Text style={styles.memberRole}>{m.role}</Text>
              </View>
            ))}
          </View>
        )}
      </Section>

      <ConnectSection
        project={project}
        currentUserId={currentUserId}
        connect={connect}
      />

      <Section label="Backups & restore">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open backups and restore"
          testID="project-drawer-backups-link"
          onPress={onOpenBackups}
          style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
        >
          <Text style={styles.linkRowLabel}>View snapshots & restore</Text>
          <Text style={styles.linkRowGlyph}>›</Text>
        </Pressable>
        <Text style={styles.fieldHint}>
          Browse the snapshots taken every six hours and roll the project (or a
          single file) back to any of them.
        </Text>
      </Section>
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

/** Glyph + colour per badge tone — the single place tone → visuals map. Two
 *  roles only: owner and collaborator. There is no guest-vs-trusted distinction;
 *  hosting shape is an auth mechanism, never a visible tier. A function of the
 *  active palette, because a badge painted from a captured one stayed dark. */
function badgeToneStyle(
  tone: ConnectBadgeTone,
  theme: NeutronTheme,
): { color: string; bg: string; border: string; glyph: string } {
  // Owner reads plain — neutral surface, no attention pull.
  if (tone === 'owner') {
    return {
      color: theme.text_secondary,
      bg: theme.surface_raised,
      border: theme.hairline,
      glyph: '\u2605',
    };
  }
  // Collaborator: one cool link-blue tint for everyone who isn't the owner,
  // regardless of how they're hosted or how they authenticated. The tints are
  // derived from the ACTIVE `link` rather than hardcoded rgba of the dark one —
  // the two hardcoded values here were the dark #5fb6ff and read as a blue haze
  // on a white card.
  return {
    color: theme.link,
    bg: withLinkAlpha(theme.link, 0.12),
    border: withLinkAlpha(theme.link, 0.32),
    glyph: '\u25c6',
  };
}

/** `#rrggbb` -> `rgba(r,g,b,a)`. Returns the input unchanged if it isn't a hex. */
function withLinkAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
}
function RoleBadge({ role }: { role: ConnectMemberView['role'] }) {
  const styles = useThemedStyles(makeStyles);
  const theme = useTheme();
  const { label, tone } = connectBadge(role);
  const t = badgeToneStyle(tone, theme);
  return (
    <View
      style={[styles.trustBadge, { backgroundColor: t.bg, borderColor: t.border }]}
      accessibilityLabel={`${label}`}
    >
      <Text style={[styles.trustBadgeGlyph, { color: t.color }]}>{t.glyph}</Text>
      <Text style={[styles.trustBadgeLabel, { color: t.color }]}>{label}</Text>
    </View>
  );
}

const SCOPE_OPTIONS: readonly ConnectInviteScope[] = ['write', 'read'];
// Delivery is a METHOD, not a tier — both land the same collaborator role.
const DELIVERY_OPTIONS: readonly ConnectInviteDelivery[] = ['link', 'email'];
const DELIVERY_LABEL: Record<ConnectInviteDelivery, string> = {
  link: 'By link',
  email: 'By email',
};
const DELIVERY_BLURB: Record<ConnectInviteDelivery, string> = {
  link: 'Share a link. Works for anyone — they join from their own instance.',
  email: 'Send to a Managed account so they can accept with one tap.',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ConnectSection({
  project,
  currentUserId,
  connect,
}: {
  project: ProjectSettings;
  currentUserId: string | null;
  connect: ConnectController;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const canManage = canManageConnectMembers(project, currentUserId);
  const canRevoke = canRevokeConnectMember(project, currentUserId);
  const sorted = useMemo(() => connectMemberSort(connect.members), [connect.members]);
  const outstanding = useMemo(
    () => outstandingConnectInvites(connect.invites),
    [connect.invites],
  );

  // Invite composer local state.
  const [composing, setComposing] = useState(false);
  const [delivery, setDelivery] = useState<ConnectInviteDelivery>('link');
  const [inviteeEmail, setInviteeEmail] = useState('');
  const [scope, setScope] = useState<ConnectInviteScope>('write');
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<ConnectInviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  const resetComposer = (): void => {
    setComposing(false);
    setIssuing(false);
    setIssueError(null);
    setIssued(null);
    setCopied(false);
    setDelivery('link');
    setInviteeEmail('');
    setScope('write');
  };

  const emailValid = EMAIL_RE.test(inviteeEmail.trim());
  const canSubmit = delivery === 'link' || emailValid;

  const submit = async (): Promise<void> => {
    if (issuing || !canSubmit) return;
    setIssuing(true);
    setIssueError(null);
    try {
      const result = await connect.issue({
        delivery,
        scope,
        ...(delivery === 'email' ? { invitee_email: inviteeEmail.trim() } : {}),
      });
      setIssued(result);
    } catch (err) {
      setIssueError(
        err instanceof ConnectMembersClientError
          ? err.message
          : 'Could not create the invite link.',
      );
    } finally {
      setIssuing(false);
    }
  };

  const copy = (): void => {
    if (issued === null) return;
    setCopied(true);
    void copyToClipboard(issued.accept_url);
  };

  // 501 connect_not_configured: render an honest disabled state, no action.
  if (connect.error !== null && connect.error.code === 'connect_not_configured') {
    return (
      <Section label="Neutron Connect">
        <Text style={styles.fieldValue}>Cross-org sharing isn&apos;t enabled on this server.</Text>
      </Section>
    );
  }

  return (
    <Section label="Neutron Connect">
      {connect.loading && !connect.loaded ? (
        <View style={styles.connectLoading}>
          <ActivityIndicator color={theme.text_muted} />
          <Text style={styles.fieldHint}>Loading connected members…</Text>
        </View>
      ) : connect.error !== null ? (
        <Text style={styles.fieldError}>
          Could not load connected members: {connect.error.message}
        </Text>
      ) : sorted.length === 0 ? (
        <Text style={styles.fieldValue}>
          No one outside your org has access yet.
        </Text>
      ) : (
        <View style={styles.memberList}>
          {sorted.map((m) => {
            const revoked = m.status === 'revoked';
            return (
              <View
                key={m.local_slug}
                style={[styles.connectRow, revoked && styles.connectRowRevoked]}
              >
                <View style={styles.connectRowMain}>
                  <Text
                    style={[styles.memberName, revoked && styles.connectTextRevoked]}
                    numberOfLines={1}
                  >
                    {m.display_name}
                  </Text>
                  <View style={styles.connectMeta}>
                    <RoleBadge role={m.role} />
                    {m.status === 'pending' ? (
                      <Text style={styles.connectStatus}>Pending</Text>
                    ) : revoked ? (
                      <Text style={[styles.connectStatus, styles.connectTextRevoked]}>Revoked</Text>
                    ) : null}
                  </View>
                </View>
                {canRevoke && !revoked && m.role !== 'owner' ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Revoke access for ${m.display_name}`}
                    testID={`connect-revoke-${m.local_slug}`}
                    onPress={() => void connect.revoke(m.local_slug)}
                    style={({ pressed }) => [styles.revokeBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.revokeBtnText}>Revoke</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {/* ISSUES #421 residual — outstanding invites, and the button that
          withdraws one. Gated on `canManage`, the SAME gate as issuing: taking
          back an invite is the inverse of sending it, so anyone trusted to open
          the door is trusted to close it. (Member revoke stays owner-only under
          `canRevoke`; that ejects a person, this cancels a piece of paper.) */}
      {canManage && outstanding.length > 0 ? (
        <View style={styles.memberList} testID="connect-outstanding-invites">
          <Text style={styles.composerLabel}>Outstanding invites</Text>
          <Text style={styles.fieldHint}>
            Anyone with one of these links can still join. Withdraw one to cancel it.
          </Text>
          {outstanding.map((inv: ConnectInviteView) => (
            <View key={inv.invite_id} style={styles.connectRow}>
              <View style={styles.connectRowMain}>
                <Text style={styles.memberName} numberOfLines={1}>
                  {inv.access === 'write' ? 'Invite link · can edit' : 'Invite link · read only'}
                </Text>
                <View style={styles.connectMeta}>
                  <Text style={styles.connectStatus}>
                    {formatAcceptLinkExpiry(inv.expires_at_ms, Date.now())}
                  </Text>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Withdraw this invite link"
                testID={`connect-invite-revoke-${inv.invite_id}`}
                onPress={() => void connect.revokeInvite(inv.invite_id)}
                style={({ pressed }) => [styles.revokeBtn, pressed && styles.pressed]}
              >
                <Text style={styles.revokeBtnText}>Withdraw</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {canManage ? (
        composing ? (
          <View style={styles.composer}>
            {issued === null ? (
              <>
                <Text style={styles.composerLabel}>How to invite</Text>
                <SmallSegmented
                  options={DELIVERY_OPTIONS}
                  value={delivery}
                  labelFor={(d) => DELIVERY_LABEL[d]}
                  onChange={(d) => setDelivery(d)}
                  disabled={issuing}
                  testIdPrefix="connect-delivery"
                />
                <Text style={styles.fieldHint}>{DELIVERY_BLURB[delivery]}</Text>

                {delivery === 'email' ? (
                  <TextInput
                    style={styles.composerInput}
                    value={inviteeEmail}
                    onChangeText={setInviteeEmail}
                    editable={!issuing}
                    placeholder="collaborator@example.com"
                    placeholderTextColor={theme.text_muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    accessibilityLabel="Invitee email address"
                    testID="connect-invitee-email"
                  />
                ) : null}

                <Text style={styles.composerLabel}>Permission</Text>
                <SmallSegmented
                  options={SCOPE_OPTIONS}
                  value={scope}
                  labelFor={(s) => (s === 'write' ? 'Can edit' : 'Read only')}
                  onChange={(s) => setScope(s)}
                  disabled={issuing}
                  testIdPrefix="connect-scope"
                />

                {issueError !== null ? (
                  <Text style={styles.fieldError} testID="connect-invite-error">
                    {issueError}
                  </Text>
                ) : null}

                <View style={styles.composerActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel invite"
                    testID="connect-invite-cancel"
                    onPress={resetComposer}
                    style={({ pressed }) => [styles.ghostBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.ghostBtnText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Create invite link"
                    testID="connect-invite-submit"
                    disabled={issuing || !canSubmit}
                    onPress={() => void submit()}
                    style={({ pressed }) => [
                      styles.primaryBtn,
                      (issuing || !canSubmit) && styles.btnDisabled,
                      !issuing && canSubmit && pressed && styles.pressed,
                    ]}
                  >
                    {issuing ? (
                      <ActivityIndicator color={theme.background} />
                    ) : (
                      <Text style={styles.primaryBtnText}>
                        {delivery === 'email' ? 'Send invite' : 'Create link'}
                      </Text>
                    )}
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.fieldHint}>
                  Share this link with your collaborator.
                </Text>
                <View style={styles.linkBox}>
                  <Text style={styles.linkText} selectable numberOfLines={3} testID="connect-accept-url">
                    {issued.accept_url}
                  </Text>
                </View>
                <Text style={styles.connectStatus} testID="connect-accept-expiry">
                  {formatAcceptLinkExpiry(issued.expires_at_ms, Date.now())}
                </Text>
                <View style={styles.composerActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Done"
                    testID="connect-invite-done"
                    onPress={resetComposer}
                    style={({ pressed }) => [styles.ghostBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.ghostBtnText}>Done</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Copy invite link"
                    testID="connect-invite-copy"
                    onPress={copy}
                    style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.primaryBtnText}>{copied ? 'Copied ✓' : 'Copy link'}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Invite someone to this project"
            testID="connect-invite-open"
            onPress={() => setComposing(true)}
            style={({ pressed }) => [styles.inviteCta, pressed && styles.pressed]}
          >
            <Text style={styles.inviteCtaGlyph}>+</Text>
            <Text style={styles.inviteCtaText}>Invite to project</Text>
          </Pressable>
        )
      ) : null}
    </Section>
  );
}

/**
 * Compact two/three-option segmented control for the invite composer.
 * Visually lighter than the privacy `PrivacySegmentedControl` (which is
 * a top-level setting) so it reads as a sub-control inside the composer.
 */
function SmallSegmented<T extends string>({
  options,
  value,
  labelFor,
  onChange,
  disabled,
  testIdPrefix,
}: {
  options: readonly T[];
  value: T;
  labelFor: (v: T) => string;
  onChange: (v: T) => void;
  disabled: boolean;
  testIdPrefix: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.smallSegmented} accessibilityRole="tablist">
      {options.map((opt) => {
        const active = opt === value;
        return (
          <Pressable
            key={opt}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled }}
            testID={`${testIdPrefix}-${opt}`}
            disabled={disabled}
            onPress={() => {
              if (!active) onChange(opt);
            }}
            style={({ pressed }) => [
              styles.smallSegment,
              active && styles.smallSegmentActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.smallSegmentLabel, active && styles.smallSegmentLabelActive]}>
              {labelFor(opt)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PrivacySegmentedControl({
  value,
  pending,
  onChange,
}: {
  value: PrivacyMode;
  pending: PrivacyMode | null;
  onChange: (mode: PrivacyMode) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {ALL_PRIVACY_MODES.map((mode) => {
        const active = mode === value;
        const isPending = pending === mode && !active;
        return (
          <Pressable
            key={mode}
            accessibilityRole="tab"
            accessibilityLabel={`${PRIVACY_LABELS[mode]} privacy`}
            accessibilityState={{ selected: active, disabled: pending !== null }}
            testID={`privacy-${mode}`}
            disabled={pending !== null}
            onPress={() => {
              if (active) return;
              onChange(mode);
            }}
            style={({ pressed }) => [
              styles.segment,
              active && styles.segmentActive,
              pressed && styles.pressed,
              pending !== null && !active ? styles.segmentDisabled : null,
            ]}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
              {PRIVACY_LABELS[mode]}
            </Text>
            {isPending ? <Text style={styles.segmentPending}>…</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function sortMembers(members: readonly ProjectMember[]): ProjectMember[] {
  return [...members].sort((a, b) => {
    if (a.role === 'owner' && b.role !== 'owner') return -1;
    if (b.role === 'owner' && a.role !== 'owner') return 1;
    return a.name.localeCompare(b.name);
  });
}

function nonEmpty(value: string | null | undefined, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row',
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.scrim,
    },
    backdropPressable: {
      ...StyleSheet.absoluteFillObject,
    },
    panel: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.surface,
      borderLeftWidth: 1,
      borderLeftColor: theme.hairline,
      shadowColor: theme.shadow,
      shadowOpacity: 0.35,
      shadowOffset: { width: -4, height: 0 },
      shadowRadius: 16,
      elevation: 12,
    },
    panelContent: {
      paddingHorizontal: SPACING.lg,
      paddingTop: SPACING.xxl + SPACING.md,
      paddingBottom: SPACING.xl,
      gap: SPACING.lg,
    },
    panelHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: SPACING.sm,
    },
    panelHeaderText: { flex: 1 },
    panelTitle: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.h2.fontSize,
      lineHeight: TYPOGRAPHY.h2.lineHeight,
      fontWeight: TYPOGRAPHY.h2.fontWeight,
      marginTop: SPACING.xs / 2,
    },
    overline: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: DENSITY.banner_radius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.surface_raised,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    closeGlyph: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
    },
    sections: { gap: SPACING.lg },
    section: { gap: SPACING.xs },
    sectionLabel: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    fieldValue: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    fieldHint: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontStyle: 'italic',
      marginTop: SPACING.xs / 2,
    },
    fieldError: {
      color: theme.danger,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      marginTop: SPACING.xs,
    },
    badge: {
      alignSelf: 'flex-start',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.xs,
      borderRadius: DENSITY.chip_radius,
      backgroundColor: theme.surface_raised,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    badgeText: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      fontWeight: '500',
    },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.md,
      backgroundColor: theme.surface_raised,
      borderRadius: DENSITY.banner_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    linkRowPressed: { opacity: 0.7 },
    linkRowLabel: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      fontWeight: '500',
    },
    linkRowGlyph: {
      color: theme.text_muted,
      fontSize: 18,
      fontWeight: '300',
    },
    memberList: { gap: SPACING.xs },
    memberRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.md,
      backgroundColor: theme.surface_raised,
      borderRadius: DENSITY.banner_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    memberName: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      fontWeight: '500',
    },
    memberRole: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    segmented: {
      flexDirection: 'row',
      backgroundColor: theme.surface_raised,
      borderRadius: DENSITY.composer_radius,
      padding: SPACING.xs / 2,
      borderWidth: 1,
      borderColor: theme.hairline,
      gap: SPACING.xs / 2,
    },
    segment: {
      flex: 1,
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.sm,
      borderRadius: DENSITY.composer_radius - 2,
      alignItems: 'center',
      backgroundColor: 'transparent',
    },
    segmentActive: {
      backgroundColor: theme.background,
    },
    segmentDisabled: {
      opacity: 0.6,
    },
    segmentLabel: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      fontWeight: '500',
    },
    segmentLabelActive: {
      color: theme.text_primary,
      fontWeight: '600',
    },
    segmentPending: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
    },
    connectLoading: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
    },
    connectRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.md,
      backgroundColor: theme.surface_raised,
      borderRadius: DENSITY.banner_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    connectRowRevoked: {
      opacity: 0.55,
    },
    connectRowMain: {
      flex: 1,
      gap: SPACING.xs,
    },
    connectMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
    },
    connectStatus: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      letterSpacing: 0.3,
    },
    connectTextRevoked: {
      textDecorationLine: 'line-through',
      color: theme.text_muted,
    },
    trustBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.xs,
      paddingHorizontal: SPACING.sm,
      paddingVertical: SPACING.xs / 2,
      borderRadius: DENSITY.chip_radius,
      borderWidth: 1,
    },
    trustBadgeGlyph: {
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
    },
    trustBadgeLabel: {
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
      letterSpacing: 0.4,
    },
    revokeBtn: {
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.xs + 1,
      borderRadius: DENSITY.banner_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: 'transparent',
    },
    revokeBtnText: {
      color: theme.danger,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
    },
    inviteCta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.md,
      borderRadius: DENSITY.banner_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.surface_raised,
      marginTop: SPACING.xs,
    },
    inviteCtaGlyph: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.h4.fontSize,
      fontWeight: '600',
    },
    inviteCtaText: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      fontWeight: '500',
    },
    composer: {
      gap: SPACING.sm,
      padding: SPACING.md,
      marginTop: SPACING.xs,
      borderRadius: DENSITY.composer_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.background,
    },
    composerLabel: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    composerInput: {
      borderWidth: 1,
      borderColor: theme.hairline,
      borderRadius: DENSITY.composer_radius,
      backgroundColor: theme.surface_raised,
      color: theme.text_primary,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    composerActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: SPACING.sm,
      marginTop: SPACING.xs,
    },
    ghostBtn: {
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.sm,
      borderRadius: DENSITY.banner_radius,
      backgroundColor: theme.surface_raised,
    },
    ghostBtnText: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      fontWeight: '600',
    },
    primaryBtn: {
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.sm,
      borderRadius: DENSITY.banner_radius,
      minWidth: 96,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.text_primary,
    },
    primaryBtnText: {
      color: theme.background,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      fontWeight: '600',
    },
    btnDisabled: { opacity: 0.5 },
    linkBox: {
      backgroundColor: theme.surface,
      borderColor: theme.hairline,
      borderWidth: 1,
      borderRadius: DENSITY.composer_radius,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      minHeight: 52,
      justifyContent: 'center',
    },
    linkText: {
      color: theme.link,
      fontSize: TYPOGRAPHY.mono.fontSize,
      lineHeight: TYPOGRAPHY.mono.lineHeight,
      fontFamily: TYPOGRAPHY.mono.fontFamily,
    },
    smallSegmented: {
      flexDirection: 'row',
      backgroundColor: theme.surface_raised,
      borderRadius: DENSITY.composer_radius,
      padding: SPACING.xs / 2,
      borderWidth: 1,
      borderColor: theme.hairline,
      gap: SPACING.xs / 2,
    },
    smallSegment: {
      flex: 1,
      paddingVertical: SPACING.xs + 2,
      paddingHorizontal: SPACING.sm,
      borderRadius: DENSITY.composer_radius - 2,
      alignItems: 'center',
      backgroundColor: 'transparent',
    },
    smallSegmentActive: {
      backgroundColor: theme.background,
    },
    smallSegmentLabel: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      fontWeight: '500',
    },
    smallSegmentLabelActive: {
      color: theme.text_primary,
      fontWeight: '600',
    },
    loadingText: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    errorText: {
      color: theme.danger,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    pressed: { opacity: 0.7 },
  });
