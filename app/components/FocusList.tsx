/**
 * @neutronai/app — pure global Focus list container (P5.6).
 *
 * Owns:
 *
 *   - Error banner (tap-to-dismiss; `THEME.danger`-tinted) + Retry button.
 *   - Initial-load ActivityIndicator (full-screen, only when `loading
 *     === true` AND the list is empty).
 *   - Empty-state copy when `sections.length === 0` (no overdue, no
 *     today, no soon items across all projects).
 *   - The mapped `<FocusBucketSection>` children.
 *   - Native pull-to-refresh via `<RefreshControl>` (RN provides no
 *     equivalent on web; the header's manual Refresh button is the web
 *     fallback per brief § 4.9).
 *   - Wide-web content-cap (720 CSS px centered on web ≥ 800 px).
 *   - The LLM-engine footnote ("LLM-driven one most important pick
 *     lands in P6.x") rendered below the list OR inside the empty-
 *     state container per brief § 4.13.
 *
 * No data-fetching, no reducer wiring — every value is passed in via
 * props. The route file wires `useFocusState()` to these props in one
 * place so the route stays a thin composer.
 *
 * Web responsive layout: `BREAKPOINTS.narrow_max` (799) gates the
 * 720 px content-cap. Mirrors P5.4 + P5.5 verbatim.
 */

import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import type { CurrentFocusPick, FocusItem } from '../lib/focus-client';
import type {
  BucketSection,
  FocusStateError,
} from '../lib/focus-state-reducer';
import { ALPHA_TINTS } from '../lib/task-row-formatters';
import { BREAKPOINTS, DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import { FocusBucketSection } from './FocusBucketSection';
import { FocusHeroCard } from './FocusHeroCard';

/**
 * Inline literal authorized by brief § 4.8 as one of the optional
 * `BREAKPOINTS.content_max` token additions; declined for parity with
 * P5.4 + P5.5 (the 720 px width is documented in the brief's mapping
 * table).
 */
const CONTENT_MAX_WIDTH = 720;

const FOOTNOTE_COPY =
  'Cross-project projection. LLM-driven "one most important" pick lands in P6.x.';

const EMPTY_TITLE = 'Nothing urgent.';
const EMPTY_BODY = 'Touch a project to see its tabs.';

export interface FocusListProps {
  sections: BucketSection[];
  loading: boolean;
  refreshing: boolean;
  error: FocusStateError | null;
  /** Frozen `now` (ms) for deterministic due-chip text in tests; pass undefined for live. */
  nowMs?: number;
  /** P6.1 — LLM-picked "do this next." Null when no pick today. */
  currentFocus?: CurrentFocusPick | null;
  onRefresh: () => void;
  onRetry: () => void;
  onItemPress: (item: FocusItem) => void;
  /** Fires when the hero card is tapped. Required when `currentFocus` is non-null. */
  onCurrentFocusPress?: (pick: CurrentFocusPick) => void;
  onDismissError: () => void;
  onProjectsLink: () => void;
}

export function FocusList({
  sections,
  loading,
  refreshing,
  error,
  nowMs,
  currentFocus,
  onRefresh,
  onRetry,
  onItemPress,
  onCurrentFocusPress,
  onDismissError,
  onProjectsLink,
}: FocusListProps) {
  const { width } = useWindowDimensions();
  const wideWeb = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;
  const contentStyle = wideWeb
    ? [styles.listContent, styles.listContentWide]
    : styles.listContent;
  const isWeb = Platform.OS === 'web';

  // Full-screen ActivityIndicator only on the very first load (no
  // sections yet AND no error). Subsequent refreshes keep rows visible
  // and drive the inline spinner via `refreshing`.
  const showInitialLoader = loading && sections.length === 0 && error === null;

  if (showInitialLoader) {
    return (
      <View style={styles.centered} testID="focus-loading">
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  if (error !== null) {
    return (
      <View style={styles.errorWrap}>
        <View style={styles.errorBanner} testID="focus-error">
          <Text style={styles.errorTitle}>Focus list unavailable</Text>
          <Text style={styles.errorBody} testID="focus-error-message">
            {error.code}: {error.message}
          </Text>
          <View style={styles.errorActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry"
              testID="focus-retry-btn"
              onPress={onRetry}
              style={({ pressed }) => [styles.retryBtn, pressed && styles.btnPressed]}
            >
              <Text style={styles.retryBtnText}>Retry</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
              testID="focus-error-dismiss-btn"
              onPress={onDismissError}
              style={({ pressed }) => [styles.dismissBtn, pressed && styles.btnPressed]}
            >
              <Text style={styles.dismissBtnText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // P6.1 — when the bucket projection is empty but today's nudge pick
  // exists, render the hero card alone (the LLM may have selected a
  // task whose project_id / priority / due_date didn't satisfy the
  // bucket-list 24h-or-high-priority filter, so the bucket list is
  // empty while the pick is valid). Falls back to the standard empty
  // state when both are absent.
  if (sections.length === 0) {
    const heroAvailable =
      currentFocus !== undefined &&
      currentFocus !== null &&
      onCurrentFocusPress !== undefined;
    if (heroAvailable) {
      return (
        <ScrollView
          contentContainerStyle={contentStyle}
          style={styles.listScroll}
          testID="focus-list"
          refreshControl={
            isWeb ? undefined : (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={THEME.text_secondary}
              />
            )
          }
        >
          <FocusHeroCard pick={currentFocus} onPress={onCurrentFocusPress} />
          <Text style={styles.footnote} testID="focus-footnote">
            {FOOTNOTE_COPY}
          </Text>
        </ScrollView>
      );
    }
    return (
      <View style={styles.emptyWrap} testID="focus-empty">
        <Text
          accessibilityRole="header"
          style={styles.emptyTitle}
        >
          {EMPTY_TITLE}
        </Text>
        <Text style={styles.emptyBody}>{EMPTY_BODY}</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open projects"
          testID="focus-empty-projects-link"
          onPress={onProjectsLink}
          style={({ pressed }) => [styles.emptyLink, pressed && styles.btnPressed]}
        >
          <Text style={styles.emptyLinkText}>Open projects →</Text>
        </Pressable>
        <Text style={styles.footnote} testID="focus-footnote-empty">
          {FOOTNOTE_COPY}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={contentStyle}
      style={styles.listScroll}
      testID="focus-list"
      refreshControl={
        isWeb ? undefined : (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={THEME.text_secondary}
          />
        )
      }
    >
      {currentFocus !== undefined &&
        currentFocus !== null &&
        onCurrentFocusPress !== undefined && (
          <FocusHeroCard pick={currentFocus} onPress={onCurrentFocusPress} />
        )}
      {sections.map((section) => (
        <FocusBucketSection
          key={section.bucket}
          bucket={section.bucket}
          label={section.label}
          items={section.items}
          nowMs={nowMs}
          onItemPress={onItemPress}
        />
      ))}
      <Text style={styles.footnote} testID="focus-footnote">
        {FOOTNOTE_COPY}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  listScroll: { flex: 1 },
  listContent: {
    padding: SPACING.lg,
    gap: SPACING.lg,
    paddingBottom: SPACING.xxl,
  },
  listContentWide: {
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    width: '100%',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorWrap: {
    padding: SPACING.lg,
  },
  errorBanner: {
    padding: SPACING.lg,
    borderRadius: DENSITY.banner_radius,
    backgroundColor: THEME.danger + ALPHA_TINTS.light,
    borderWidth: 1,
    borderColor: THEME.danger + ALPHA_TINTS.border,
    gap: SPACING.sm,
  },
  errorTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h4.fontSize,
    lineHeight: TYPOGRAPHY.h4.lineHeight,
    fontWeight: TYPOGRAPHY.h4.fontWeight,
  },
  errorBody: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  errorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md + 2,
    paddingVertical: SPACING.xs + 2,
    backgroundColor: THEME.text_primary,
    borderRadius: DENSITY.banner_radius + 2,
  },
  retryBtnText: {
    color: THEME.background,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '700',
  },
  dismissBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.md + 2,
    paddingVertical: SPACING.xs + 2,
    borderRadius: DENSITY.banner_radius + 2,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  dismissBtnText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '600',
  },
  btnPressed: { opacity: 0.78 },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    padding: SPACING.xxl,
  },
  emptyTitle: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: TYPOGRAPHY.h3.fontWeight,
  },
  emptyBody: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    textAlign: 'center',
  },
  emptyLink: {
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
  },
  emptyLinkText: {
    color: THEME.link,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '600',
  },
  footnote: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    textAlign: 'center',
    marginTop: SPACING.lg,
    paddingHorizontal: SPACING.lg,
  },
});
