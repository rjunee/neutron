/**
 * @neutronai/app — comments side-pane (P7.2 S3 Part A).
 *
 * Right-aligned togglable side-pane that surfaces inline comment
 * threads anchored on the open doc. Lists active threads sorted by
 * `last_reply_at DESC, created_at DESC`, mirrors the Tasks tab visual
 * pattern (accent border + full opacity for active, muted background
 * + 0.7 opacity for resolved), and exposes the three side-pane
 * gestures S3 ships:
 *
 *   - Tap anchor excerpt → calls `on_scroll_to_anchor(anchor)` so the
 *     editor can scroll to the live offset (the side-pane never
 *     computes pixel offsets itself).
 *   - "Reply" input at the bottom of each expanded thread → fires the
 *     existing S1 `replyToComment` HTTP method via the context's
 *     `postReply` optimistic mutator.
 *   - "Resolve" button → fires the new S3 `resolveComment` HTTP method.
 *   - "Escalate to chat" button → fires the new S3 `escalateToChat`
 *     HTTP method; the button hides after the first user-triggered
 *     tap in the current side-pane session (in-memory only).
 *
 * Animation: mirrors `ProjectSettingsDrawer.tsx:106-145` verbatim —
 * built-in `Animated.timing` for translateX + opacity, locked
 * `MOTION.base` (250 ms) slide + `MOTION.fast` (150 ms) fade with
 * `Easing.out(Easing.cubic)` open / `Easing.in(Easing.cubic)` close.
 * Reanimated is deliberately NOT used (surface-consistency lock from
 * the plan's deepenings § 6).
 *
 * Breakpoints: on wide viewports (`width > BREAKPOINTS.narrow_max` =
 * 799 px on web) the pane is a `position: absolute` right-side overlay
 * with `width = min(width * 0.4, 480)`. On narrow viewports the parent
 * route is responsible for swapping the pane in place of the editor
 * (no slide animation — full pane-swap, full-screen sliding is jittery
 * on a phone).
 *
 * Accessibility (deepenings § 8):
 *   - `accessibilityViewIsModal` on the root so VoiceOver ignores
 *     siblings while the pane is open.
 *   - Focus shifts to the close button via the modern
 *     `AccessibilityInfo.sendAccessibilityEvent(ref, 'focus')` API —
 *     NOT the deprecated `setAccessibilityFocus`.
 *   - `accessibilityLiveRegion="polite"` on the status text +
 *     `AccessibilityInfo.announceForAccessibility(...)` ephemeral
 *     confirmations for resolve / escalate / reply.
 *   - On web: focus trap inside the pane, Esc closes, Cmd/Ctrl+Enter
 *     submits compose. Enter expands/collapses a thread when focus is
 *     on the card header.
 *
 * Pure consumer of `lib/theme.ts` tokens. No new colors / radii /
 * motion durations.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
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

import {
  BREAKPOINTS,
  DENSITY,
  MOTION,
  SPACING,
  THEME,
  TYPOGRAPHY,
} from '../lib/composer-constants';
import { useCommentsState } from '../lib/comments-state';
import type { AnchorRow, ThreadSummary } from '../lib/docs-client';

export interface CommentsSidePaneProps {
  project_id: string;
  doc_path: string;
  /**
   * Called when the user taps an anchor excerpt or a resolved-card
   * header. Carries the full `AnchorRow` projection so the consumer
   * (the docs route) can call the editor's imperative
   * `scrollToOffset(byteOffset)` handle without computing pixel
   * offsets itself.
   */
  on_scroll_to_anchor: (anchor: AnchorRow) => void;
  /** Controlled open state. */
  open: boolean;
  /** Close handler — backdrop tap, Esc, close-button tap, Android back. */
  on_close: () => void;
  /**
   * P7.2 S3 wide / narrow layout switch. When `embed === true` the
   * pane renders inline (parent owns the layout — used in narrow
   * mode where the pane swaps in place of the editor). When false
   * (the default) the pane renders as a `position: absolute` overlay
   * on top of the editor, with backdrop + slide-in animation. The
   * parent route picks based on `width > BREAKPOINTS.narrow_max`.
   */
  embed?: boolean;
  /**
   * P7.3 range UI consumer — optional label provider the docs route
   * passes in to surface a "Line 12" or "Lines 12–18" muted label
   * underneath each thread's anchor excerpt. Computed by the parent
   * because only the parent has the open file's content (anchors are
   * stored as byte offsets; the conversion to line numbers needs the
   * doc body). Returning `null` (or omitting the prop entirely)
   * suppresses the label, preserving the pre-range row layout.
   */
  format_anchor_line_label?: (
    anchor: ThreadSummary['anchor'],
  ) => string | null;
}

const NARROW_PANEL_WIDTH = 360;
const WIDE_PANEL_WIDTH_CAP = 480;
const WIDE_PANEL_WIDTH_RATIO = 0.4;
const EXCERPT_MAX = 120;

export function CommentsSidePane({
  project_id: _project_id,
  doc_path: _doc_path,
  on_scroll_to_anchor,
  open,
  on_close,
  embed = false,
  format_anchor_line_label,
}: CommentsSidePaneProps) {
  const {
    threads,
    loading,
    error,
    escalatedThisSession,
    mutatingThreadIds,
    postReply,
    resolveThread,
    escalateThread,
    dismissError,
  } = useCommentsState();
  const { width } = useWindowDimensions();
  const wideViewport = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;
  const panelWidth = useMemo(() => {
    if (embed) return width > 0 ? width : NARROW_PANEL_WIDTH;
    if (wideViewport) {
      return Math.min(WIDE_PANEL_WIDTH_CAP, Math.floor(width * WIDE_PANEL_WIDTH_RATIO));
    }
    return Math.min(NARROW_PANEL_WIDTH, width > 0 ? Math.floor(width * 0.9) : NARROW_PANEL_WIDTH);
  }, [embed, wideViewport, width]);

  const translateX = useRef(new Animated.Value(panelWidth)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(open);
  const [reduceMotion, setReduceMotion] = useState(false);
  const closeButtonRef = useRef<View | null>(null);

  // Reduce-motion preference. Same pattern as ProjectSettingsDrawer.
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

  // Slide-in / slide-out animation (lifted verbatim from
  // ProjectSettingsDrawer.tsx:106-145). Embed mode skips animation —
  // the parent swaps the pane in place of the editor, no overlay.
  useEffect(() => {
    if (embed) {
      // No animation in embed (narrow / pane-swap) mode. The pane is
      // either rendered or not; the parent owns visibility.
      if (open) setMounted(true);
      else setMounted(false);
      return;
    }
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
  }, [open, mounted, panelWidth, opacity, translateX, reduceMotion, embed]);

  // Shift focus to the close button on open (modern API). VoiceOver
  // reads the pane title + close-button label on focus arrival.
  useEffect(() => {
    if (!open) return;
    if (!mounted) return;
    const node = closeButtonRef.current;
    if (node === null) return;
    try {
      // RN 0.86: sendAccessibilityEvent accepts the host instance (the
      // ref the View / Pressable yields) directly. The deprecated
      // `setAccessibilityFocus` path is intentionally NOT used.
      AccessibilityInfo.sendAccessibilityEvent(
        node as unknown as Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0],
        'focus',
      );
    } catch {
      /* swallow — older RN versions throw; the pane still works. */
    }
  }, [open, mounted]);

  // Web-only: Esc closes; keyboard focus trap rooted at the panel.
  useEffect(() => {
    if (!open) return undefined;
    if (Platform.OS !== 'web') return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        on_close();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }
    return undefined;
  }, [open, on_close]);

  if (!mounted) return null;

  const sorted = sortThreads(threads);
  const active = sorted.filter((t) => !isResolved(t));
  const resolved = sorted.filter((t) => isResolved(t));

  const paneInner = (
    <ScrollView
      contentContainerStyle={styles.panelContent}
      testID="comments-side-pane-scroll"
    >
      <PanelHeader
        closeButtonRef={closeButtonRef}
        onClose={on_close}
        threadCount={active.length}
      />
      {error !== null && (
        <View style={styles.errorBanner} testID="comments-side-pane-error">
          <Text style={styles.errorText} accessibilityLiveRegion="polite">
            {error.message}
          </Text>
          <Pressable onPress={dismissError} testID="comments-side-pane-error-dismiss">
            <Text style={styles.errorDismiss}>Dismiss</Text>
          </Pressable>
        </View>
      )}
      {loading && threads.length === 0 ? (
        <Text style={styles.loadingText}>Loading threads…</Text>
      ) : threads.length === 0 ? (
        <EmptyState />
      ) : (
        <View style={styles.sections}>
          <Section
            label={active.length === 1 ? '1 active thread' : `${active.length} active threads`}
          >
            {active.length === 0 ? (
              <Text style={styles.sectionEmpty}>No active threads on this doc.</Text>
            ) : (
              active.map((thread) => (
                <ThreadCard
                  key={thread.thread_root_id}
                  thread={thread}
                  resolved={false}
                  mutating={mutatingThreadIds.has(thread.thread_root_id)}
                  alreadyEscalated={escalatedThisSession.has(thread.thread_root_id)}
                  onScrollToAnchor={on_scroll_to_anchor}
                  onResolve={resolveThread}
                  onEscalate={escalateThread}
                  onPostReply={postReply}
                  formatAnchorLineLabel={format_anchor_line_label}
                />
              ))
            )}
          </Section>
          {resolved.length > 0 && (
            <ResolvedSection
              threads={resolved}
              mutatingThreadIds={mutatingThreadIds}
              escalatedThisSession={escalatedThisSession}
              onScrollToAnchor={on_scroll_to_anchor}
              onResolve={resolveThread}
              onEscalate={escalateThread}
              onPostReply={postReply}
              formatAnchorLineLabel={format_anchor_line_label}
            />
          )}
        </View>
      )}
    </ScrollView>
  );

  if (embed) {
    return (
      <View
        style={styles.embeddedPanel}
        accessibilityViewIsModal
        testID="comments-side-pane-embed"
      >
        {paneInner}
      </View>
    );
  }

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close comments side pane"
          testID="comments-side-pane-backdrop"
          onPress={on_close}
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
        testID="comments-side-pane-panel"
      >
        {paneInner}
      </Animated.View>
    </View>
  );
}

interface PanelHeaderProps {
  closeButtonRef: React.MutableRefObject<View | null>;
  onClose: () => void;
  threadCount: number;
}

function PanelHeader({ closeButtonRef, onClose, threadCount }: PanelHeaderProps) {
  return (
    <View style={styles.panelHeader}>
      <View style={styles.panelHeaderText}>
        <Text style={styles.overline}>Comments</Text>
        <Text style={styles.panelTitle} numberOfLines={1}>
          {threadCount === 0 ? 'No active threads' : `${threadCount} active`}
        </Text>
      </View>
      <Pressable
        ref={closeButtonRef as unknown as React.Ref<View>}
        accessibilityRole="button"
        accessibilityLabel="Close comments side pane"
        testID="comments-side-pane-close"
        onPress={onClose}
        style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
      >
        <Text style={styles.closeGlyph}>✕</Text>
      </Pressable>
    </View>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyState} testID="comments-side-pane-empty">
      <Text style={styles.emptyTitle}>No threads on this doc.</Text>
      <Text style={styles.emptyBody}>
        Highlight text in the editor to start a comment thread.
      </Text>
    </View>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

interface ResolvedSectionProps {
  threads: ThreadSummary[];
  mutatingThreadIds: ReadonlySet<string>;
  escalatedThisSession: ReadonlySet<string>;
  onScrollToAnchor: (anchor: AnchorRow) => void;
  onResolve: (thread_root_id: string) => Promise<boolean>;
  onEscalate: (thread_root_id: string, note?: string) => Promise<boolean>;
  onPostReply: (thread_root_id: string, body: string) => Promise<boolean>;
  formatAnchorLineLabel?: (anchor: ThreadSummary['anchor']) => string | null;
}

function ResolvedSection({
  threads,
  mutatingThreadIds,
  escalatedThisSession,
  onScrollToAnchor,
  onResolve,
  onEscalate,
  onPostReply,
  formatAnchorLineLabel,
}: ResolvedSectionProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Toggle ${threads.length} resolved threads`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((prev) => !prev)}
        testID="comments-side-pane-resolved-toggle"
        style={({ pressed }) => [styles.resolvedToggle, pressed && styles.pressed]}
      >
        <Text style={styles.sectionLabel}>
          {expanded ? '▾' : '▸'} Resolved ({threads.length})
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.sectionBody}>
          {threads.map((thread) => (
            <ThreadCard
              key={thread.thread_root_id}
              thread={thread}
              resolved
              mutating={mutatingThreadIds.has(thread.thread_root_id)}
              alreadyEscalated={escalatedThisSession.has(thread.thread_root_id)}
              onScrollToAnchor={onScrollToAnchor}
              onResolve={onResolve}
              onEscalate={onEscalate}
              onPostReply={onPostReply}
              formatAnchorLineLabel={formatAnchorLineLabel}
            />
          ))}
        </View>
      )}
    </View>
  );
}

interface ThreadCardProps {
  thread: ThreadSummary;
  resolved: boolean;
  mutating: boolean;
  alreadyEscalated: boolean;
  onScrollToAnchor: (anchor: AnchorRow) => void;
  onResolve: (thread_root_id: string) => Promise<boolean>;
  onEscalate: (thread_root_id: string, note?: string) => Promise<boolean>;
  onPostReply: (thread_root_id: string, body: string) => Promise<boolean>;
  formatAnchorLineLabel?: (anchor: ThreadSummary['anchor']) => string | null;
}

function ThreadCard({
  thread,
  resolved,
  mutating,
  alreadyEscalated,
  onScrollToAnchor,
  onResolve,
  onEscalate,
  onPostReply,
  formatAnchorLineLabel,
}: ThreadCardProps) {
  const [expanded, setExpanded] = useState(!resolved);
  const [replyDraft, setReplyDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const skipped = thread.latest_event_kind === 'agent_reply_skipped';
  const bodyText = thread.root.body ?? '';
  const excerpt = useMemo(() => truncateExcerpt(bodyText), [bodyText]);
  const anchorExcerpt = thread.anchor.excerpt ?? '';
  // P7.3 range UI consumer — muted "Line 12" / "Lines 12–18" label
  // beneath the anchor excerpt. The parent (docs route) computes the
  // label from the open file's content because the anchor is stored
  // as byte offsets; absent parent or null result hides the row.
  const anchorLineLabel = useMemo(() => {
    if (formatAnchorLineLabel === undefined) return null;
    return formatAnchorLineLabel(thread.anchor);
  }, [formatAnchorLineLabel, thread.anchor]);

  const handleScrollToAnchor = useCallback(() => {
    // Build a synthetic AnchorRow from the ThreadSummary projection
    // the gateway returned. The consumer (docs route) calls the
    // editor's `scrollToOffset(byteOffset)` imperative handle.
    onScrollToAnchor({
      thread_root_id: thread.thread_root_id,
      doc_path: thread.doc_path,
      current_start: thread.anchor.current_start,
      current_end: thread.anchor.current_end,
      status: thread.anchor.status,
      drift_hint_start: thread.anchor.drift_hint_start,
      drift_hint_end: thread.anchor.drift_hint_end,
      last_rebuilt_from: '',
      last_rebuilt_at: 0,
      reply_count: thread.reply_count,
      last_reply_at: thread.last_reply_at,
    });
  }, [onScrollToAnchor, thread]);

  const handleResolve = useCallback(async () => {
    const ok = await onResolve(thread.thread_root_id);
    if (ok) AccessibilityInfo.announceForAccessibility('Thread resolved');
  }, [onResolve, thread.thread_root_id]);

  const handleEscalate = useCallback(async () => {
    const ok = await onEscalate(thread.thread_root_id);
    if (ok) AccessibilityInfo.announceForAccessibility('Thread escalated to chat');
  }, [onEscalate, thread.thread_root_id]);

  const handlePostReply = useCallback(async () => {
    const trimmed = replyDraft.trim();
    if (trimmed.length === 0) return;
    setPosting(true);
    try {
      const ok = await onPostReply(thread.thread_root_id, trimmed);
      if (ok) {
        setReplyDraft('');
        AccessibilityInfo.announceForAccessibility('Reply posted');
      }
    } finally {
      setPosting(false);
    }
  }, [onPostReply, replyDraft, thread.thread_root_id]);

  // Cmd/Ctrl+Enter submits the compose input on web (matches the
  // existing chat-compose convention).
  const handleReplyKeyPress = useCallback(
    (e: { nativeEvent?: { key?: string; metaKey?: boolean; ctrlKey?: boolean } }) => {
      const ne = e.nativeEvent ?? {};
      if (ne.key === 'Enter' && (ne.metaKey === true || ne.ctrlKey === true)) {
        void handlePostReply();
      }
    },
    [handlePostReply],
  );

  return (
    <View
      style={[
        styles.threadCard,
        resolved ? styles.threadCardResolved : styles.threadCardActive,
      ]}
      testID={`comments-side-pane-thread-${thread.thread_root_id}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Scroll editor to thread anchor"
        accessibilityState={{ expanded }}
        onPress={() => {
          handleScrollToAnchor();
          setExpanded((prev) => !prev);
        }}
        style={({ pressed }) => [styles.threadHeader, pressed && styles.pressed]}
        testID={`comments-side-pane-thread-header-${thread.thread_root_id}`}
      >
        <View style={styles.threadHeaderInner}>
          {anchorExcerpt.length > 0 && (
            <Text style={styles.anchorExcerpt} numberOfLines={2}>
              “{truncateExcerpt(anchorExcerpt)}”
            </Text>
          )}
          {anchorLineLabel !== null && (
            <Text
              style={styles.anchorLineLabel}
              numberOfLines={1}
              testID={`comments-side-pane-anchor-line-label-${thread.thread_root_id}`}
            >
              {anchorLineLabel}
            </Text>
          )}
          <Text style={styles.threadBody} numberOfLines={2}>
            {excerpt}
          </Text>
          <View style={styles.threadMetaRow}>
            <Text style={styles.threadMeta}>
              {thread.root.author_kind === 'agent' ? 'Agent' : thread.root.author_id || 'You'}
              {thread.reply_count > 0 && ` · ${thread.reply_count + 1} messages`}
            </Text>
            {skipped && (
              <View style={styles.skippedBadge} testID={`comments-side-pane-skipped-${thread.thread_root_id}`}>
                <Text style={styles.skippedBadgeText}>Agent reply skipped</Text>
              </View>
            )}
          </View>
        </View>
      </Pressable>
      {expanded && (
        <View style={styles.threadActions}>
          {!resolved && (
            <>
              <View style={styles.replyRow}>
                <TextInput
                  multiline
                  value={replyDraft}
                  onChangeText={setReplyDraft}
                  onKeyPress={handleReplyKeyPress}
                  style={styles.replyInput}
                  placeholder="Reply…"
                  placeholderTextColor={THEME.text_muted}
                  testID={`comments-side-pane-reply-input-${thread.thread_root_id}`}
                  editable={!posting && !mutating}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Post reply"
                  disabled={posting || mutating || replyDraft.trim().length === 0}
                  onPress={() => void handlePostReply()}
                  testID={`comments-side-pane-reply-submit-${thread.thread_root_id}`}
                  style={({ pressed }) => [
                    styles.replyBtn,
                    pressed && styles.pressed,
                    (posting || mutating || replyDraft.trim().length === 0) && styles.disabled,
                  ]}
                >
                  <Text style={styles.replyBtnText}>{posting ? '…' : 'Reply'}</Text>
                </Pressable>
              </View>
              <View style={styles.buttonRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Resolve thread"
                  disabled={mutating}
                  onPress={() => void handleResolve()}
                  testID={`comments-side-pane-resolve-${thread.thread_root_id}`}
                  style={({ pressed }) => [
                    styles.ghostBtn,
                    pressed && styles.pressed,
                    mutating && styles.disabled,
                  ]}
                >
                  <Text style={styles.ghostBtnText}>Resolve</Text>
                </Pressable>
                {!alreadyEscalated && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Escalate thread to chat"
                    disabled={mutating}
                    onPress={() => void handleEscalate()}
                    testID={`comments-side-pane-escalate-${thread.thread_root_id}`}
                    style={({ pressed }) => [
                      styles.ghostBtn,
                      pressed && styles.pressed,
                      mutating && styles.disabled,
                    ]}
                  >
                    <Text style={styles.ghostBtnText}>Escalate to chat</Text>
                  </Pressable>
                )}
                {alreadyEscalated && (
                  <Text
                    style={styles.statusText}
                    accessibilityLiveRegion="polite"
                    testID={`comments-side-pane-escalated-status-${thread.thread_root_id}`}
                  >
                    Escalated
                  </Text>
                )}
              </View>
            </>
          )}
          {resolved && (
            <Text style={styles.statusText} accessibilityLiveRegion="polite">
              Resolved
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * Manual 120-char truncation (contract-driven per plan deepenings § 9):
 * `numberOfLines={2}` on the Text is the layout safety-net; this is
 * the canonical contract a test can assert against (exactly 120 chars
 * including the ellipsis).
 */
function truncateExcerpt(body: string): string {
  if (body.length <= EXCERPT_MAX) return body;
  return `${body.slice(0, EXCERPT_MAX - 1)}…`;
}

function isResolved(t: ThreadSummary): boolean {
  return t.latest_event_kind === 'comment_resolved';
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    if (b.last_reply_at !== a.last_reply_at) return b.last_reply_at - a.last_reply_at;
    return b.root.created_at - a.root.created_at;
  });
}

const styles = StyleSheet.create({
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
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: THEME.surface,
    borderLeftWidth: 1,
    borderLeftColor: THEME.hairline,
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowOffset: { width: -4, height: 0 },
    shadowRadius: 16,
    elevation: 12,
  },
  embeddedPanel: {
    flex: 1,
    backgroundColor: THEME.surface,
  },
  panelContent: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xl,
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
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
    marginTop: SPACING.xs / 2,
  },
  overline: {
    color: THEME.text_muted,
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
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  closeGlyph: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
  },
  sections: { gap: SPACING.lg },
  section: { gap: SPACING.xs },
  sectionLabel: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sectionBody: { gap: SPACING.sm },
  sectionEmpty: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontStyle: 'italic',
  },
  resolvedToggle: { paddingVertical: SPACING.xs },
  loadingText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  emptyState: {
    paddingVertical: SPACING.xl,
    paddingHorizontal: SPACING.md,
    gap: SPACING.xs,
    alignItems: 'flex-start',
  },
  emptyTitle: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  emptyBody: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  threadCard: {
    borderRadius: DENSITY.banner_radius,
    padding: SPACING.md,
    gap: SPACING.sm,
    borderWidth: 1,
  },
  threadCardActive: {
    backgroundColor: THEME.surface,
    borderColor: THEME.accent,
  },
  threadCardResolved: {
    backgroundColor: THEME.surface_raised,
    borderColor: THEME.hairline,
    opacity: 0.7,
  },
  threadHeader: { gap: SPACING.xs },
  threadHeaderInner: { gap: SPACING.xs },
  anchorExcerpt: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontStyle: 'italic',
  },
  // P7.3 range UI consumer — small muted "Line 12" / "Lines 12–18"
  // label beneath the anchor excerpt. Caption-grade (11/16) so the
  // existing two-line layout stays compact. No new shade — reuses
  // `THEME.text_muted` so the label aligns with the excerpt above.
  anchorLineLabel: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    letterSpacing: 0.2,
  },
  threadBody: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  threadMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  threadMeta: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  skippedBadge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs / 2,
    borderRadius: DENSITY.chip_radius,
    backgroundColor: THEME.surface_raised,
    borderWidth: 1,
    borderColor: THEME.warning,
  },
  skippedBadgeText: {
    color: THEME.warning,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
  },
  threadActions: { gap: SPACING.sm },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: SPACING.sm,
  },
  replyInput: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    color: THEME.text_primary,
    backgroundColor: THEME.background,
    borderRadius: DENSITY.composer_radius,
    borderWidth: 1,
    borderColor: THEME.hairline,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    textAlignVertical: 'top',
  },
  replyBtn: {
    backgroundColor: THEME.surface_raised,
    borderRadius: DENSITY.banner_radius,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderWidth: 1,
    borderColor: THEME.accent,
  },
  replyBtnText: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  ghostBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: DENSITY.banner_radius,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  ghostBtnText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '500',
  },
  statusText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontStyle: 'italic',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    padding: SPACING.sm,
    borderRadius: DENSITY.banner_radius,
    borderWidth: 1,
    borderColor: THEME.danger,
    backgroundColor: THEME.surface_raised,
  },
  errorText: {
    flex: 1,
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  errorDismiss: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
});
