/**
 * @neutronai/app — pure reminders list container (P5.5).
 *
 * Owns:
 *
 *   - Error banner (tap-to-dismiss; `THEME.danger`-tinted).
 *   - Loading indicator (initial fetch + refresh).
 *   - Empty state copy.
 *   - The per-filter client-side bucketing of the canonical pending
 *     list (Today / Upcoming / All).
 *   - The mapped `<ReminderRow>` children.
 *   - Wide-web content-cap (720 CSS px centered on web ≥ 800 px).
 *
 * No data-fetching, no reducer wiring — every value is passed in via
 * props. The route file (`reminders.tsx`) wires `useReminderState()`
 * to these props in one place so the route stays a thin composer.
 *
 * Web responsive layout: `BREAKPOINTS.narrow_max` (799) gates the
 * 720 px content-cap. Mirrors the P5.4 task-list pattern verbatim.
 */

import { useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { LayoutChangeEvent } from 'react-native';

import {
  applyReminderFilter,
  type ReminderFilterChoice,
  type ReminderStateError,
} from '../lib/reminder-state-reducer';
import type { ReminderItem } from '../lib/reminders-client';
import { BREAKPOINTS, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import { ALPHA_TINTS } from '../lib/task-row-formatters';
import { ReminderRow } from './ReminderRow';

const CONTENT_MAX_WIDTH = 720;
/** Quantize Date.now() to the minute so re-renders within a render pass agree on buckets. */
const MINUTE_MS = 60 * 1000;

export interface ReminderListProps {
  reminders: ReminderItem[];
  loading: boolean;
  mutating: boolean;
  error: ReminderStateError | null;
  filter: ReminderFilterChoice;
  onPressRow: (entry: ReminderItem) => void;
  onDismissError: () => void;
  /**
   * ISSUE #38 — reminder to highlight + scroll-to. Sourced from the
   * `reminder_id` query param on the route
   * (`/projects/[id]/reminders?reminder_id=<id>`); the reminder push
   * payload's `resolvePushRoute` (`app/lib/push-deep-link-dispatch.ts`)
   * drives this value. When the highlighted reminder is in the visible
   * (post-filter) list, the row receives an accent border AND the
   * ScrollView auto-scrolls to its measured Y offset. Mirrors the Tasks
   * pattern from PR #276 ISSUE #18.
   */
  highlightReminderId?: string | null;
}

export function ReminderList({
  reminders,
  loading,
  mutating,
  error,
  filter,
  onPressRow,
  onDismissError,
  highlightReminderId = null,
}: ReminderListProps) {
  const { width } = useWindowDimensions();
  const wideWeb = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;
  const contentStyle = wideWeb
    ? [styles.listContent, styles.listContentWide]
    : styles.listContent;

  const visible = useMemo(() => {
    const now_ms = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    return applyReminderFilter(reminders, filter, now_ms);
  }, [reminders, filter]);

  // Track per-row Y offset (within the scroll container) so an inbound
  // `highlightReminderId` change can scroll into view. Rebuild on every
  // filter / data change so stale measurements don't survive a reorder
  // (e.g. switching from All → Today re-renders a subset of rows).
  const scrollRef = useRef<ScrollView | null>(null);
  const rowYRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (highlightReminderId === null || highlightReminderId === undefined) return;
    const y = rowYRef.current.get(highlightReminderId);
    if (y === undefined) return;
    // Small leading margin so the highlighted row isn't flush with the
    // top edge of the scroll viewport.
    scrollRef.current?.scrollTo({ y: Math.max(0, y - SPACING.lg), animated: true });
  }, [highlightReminderId, visible]);

  const emptyCopy = emptyCopyForFilter(filter, reminders.length);

  return (
    <View style={styles.listWrap}>
      {error !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
          onPress={onDismissError}
          style={styles.errorBanner}
          testID="reminders-error-banner"
        >
          <Text style={styles.errorText} testID="reminders-error-message">
            {error.code}: {error.message}
          </Text>
          <Text style={styles.errorDismiss}>tap to dismiss</Text>
        </Pressable>
      ) : null}

      {loading && reminders.length === 0 ? (
        <View style={styles.loadingRow} testID="reminders-loading-row">
          <ActivityIndicator color={THEME.text_secondary} />
          <Text style={styles.loadingText}>Loading reminders…</Text>
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={contentStyle}
        style={styles.listScroll}
        testID="reminders-list"
      >
        {visible.map((entry) => {
          const onLayout = (e: LayoutChangeEvent): void => {
            rowYRef.current.set(entry.id, e.nativeEvent.layout.y);
          };
          const isHighlighted = highlightReminderId === entry.id;
          return (
            <View
              key={entry.id}
              onLayout={onLayout}
              style={isHighlighted ? styles.highlightedWrap : undefined}
              testID={
                isHighlighted ? `reminders-row-${entry.id}-highlighted` : undefined
              }
            >
              <ReminderRow
                entry={entry}
                mutating={mutating}
                onPress={onPressRow}
              />
            </View>
          );
        })}
        {!loading && visible.length === 0 && error === null ? (
          <Text style={styles.emptyText} testID="reminders-empty-state">
            {emptyCopy}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function emptyCopyForFilter(filter: ReminderFilterChoice, total: number): string {
  if (total === 0) {
    return 'No reminders yet for this project. Tap “+ New reminder” to add one.';
  }
  if (filter === 'today') {
    return 'Nothing firing today. Switch to Upcoming or All to see what is queued.';
  }
  if (filter === 'upcoming') {
    return 'Nothing queued for the next two weeks. Switch to All to see distant reminders.';
  }
  return 'No pending reminders. Tap “+ New reminder” to add one.';
}

const styles = StyleSheet.create({
  listWrap: { flex: 1 },
  listScroll: { flex: 1 },
  listContent: {
    gap: SPACING.sm,
    paddingBottom: SPACING.xl,
  },
  listContentWide: {
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    width: '100%',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  loadingText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  errorBanner: {
    marginBottom: SPACING.md,
    padding: SPACING.md,
    borderRadius: SPACING.sm,
    backgroundColor: THEME.danger + ALPHA_TINTS.panel,
    borderWidth: 1,
    borderColor: THEME.danger + '5a',
  },
  errorText: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '500',
  },
  errorDismiss: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    marginTop: SPACING.xs,
    fontStyle: 'italic',
    opacity: 0.75,
  },
  emptyText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontStyle: 'italic',
    marginTop: SPACING.xl,
    textAlign: 'center',
  },
  highlightedWrap: {
    borderRadius: SPACING.sm,
    borderWidth: 1,
    borderColor: THEME.text_secondary,
    backgroundColor: THEME.surface_raised,
  },
});
