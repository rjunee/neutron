/**
 * @neutronai/app — pure tasks list container (P5.4).
 *
 * Owns:
 *
 *   - Error banner (tap-to-dismiss; `THEME.danger`-tinted).
 *   - Loading indicator (initial fetch + refresh).
 *   - Empty state copy.
 *   - The mapped `<TaskRow>` children.
 *   - Wide-web content-cap (720 CSS px centered on web ≥ 800 px).
 *
 * No data-fetching, no reducer wiring — every value is passed in via
 * props. The route file (`tasks.tsx`) wires `useTaskState()` to these
 * props in one place so the route stays a thin composer.
 *
 * Web responsive layout: `BREAKPOINTS.narrow_max` (799) gates the
 * 720 px content-cap. On phone + native + narrow web the list fills
 * the parent width with default density. On wide web (≥ 800 CSS px),
 * the outer container fills the tab width and the inner content
 * container caps at 720 px centered horizontally — matches the chat
 * surface's reading-width heuristic from P5.1.
 */

import { useEffect, useRef } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';

import { BREAKPOINTS, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import type { Task } from '../lib/tasks-client';
import type { TaskStateError } from '../lib/task-state-reducer';
import { ALPHA_TINTS, TaskRow } from './TaskRow';

export interface TaskListProps {
  tasks: Task[];
  loading: boolean;
  mutating: boolean;
  error: TaskStateError | null;
  onPressRow: (task: Task) => void;
  onToggleDone: (task: Task) => void;
  onDismissError: () => void;
  /**
   * Argus r2 BLOCKER B2 (PR #276) — task to highlight + scroll-to.
   * Sourced from the `task_id` query param on the route
   * (`/projects/[id]/tasks?task_id=<id>`); the chat `task:open:<id>`
   * postback's deep_link drives this value. When the highlighted task
   * is in the rendered list, the row receives an accent border AND
   * the ScrollView auto-scrolls to its measured Y offset.
   */
  highlightTaskId?: string | null;
}

const CONTENT_MAX_WIDTH = 720;

export function TaskList({
  tasks,
  loading,
  mutating,
  error,
  onPressRow,
  onToggleDone,
  onDismissError,
  highlightTaskId = null,
}: TaskListProps) {
  const { width } = useWindowDimensions();
  const wideWeb = Platform.OS === 'web' && width > BREAKPOINTS.narrow_max;
  const contentStyle = wideWeb
    ? [styles.listContent, styles.listContentWide]
    : styles.listContent;

  // Track per-row Y offset (within the scroll container) so an inbound
  // `highlightTaskId` change can scroll into view. We rebuild the map
  // when tasks change so stale measurements don't survive a reorder.
  const scrollRef = useRef<ScrollView | null>(null);
  const rowYRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (highlightTaskId === null || highlightTaskId === undefined) return;
    const y = rowYRef.current.get(highlightTaskId);
    if (y === undefined) return;
    // Small leading margin so the highlighted row isn't flush with the
    // top edge of the scroll viewport.
    scrollRef.current?.scrollTo({ y: Math.max(0, y - SPACING.lg), animated: true });
  }, [highlightTaskId, tasks]);

  return (
    <View style={styles.listWrap}>
      {error !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
          onPress={onDismissError}
          style={styles.errorBanner}
          testID="tasks-error-banner"
        >
          <Text style={styles.errorText} testID="tasks-error-message">
            {error.code}: {error.message}
          </Text>
          <Text style={styles.errorDismiss}>tap to dismiss</Text>
        </Pressable>
      ) : null}

      {loading && tasks.length === 0 ? (
        <View style={styles.loadingRow} testID="tasks-loading-row">
          <ActivityIndicator color={THEME.text_secondary} />
          <Text style={styles.loadingText}>Loading tasks…</Text>
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={contentStyle}
        style={styles.listScroll}
        testID="tasks-list"
      >
        {tasks.map((task) => {
          const onLayout = (e: LayoutChangeEvent): void => {
            rowYRef.current.set(task.id, e.nativeEvent.layout.y);
          };
          const isHighlighted = highlightTaskId === task.id;
          return (
            <View
              key={task.id}
              onLayout={onLayout}
              style={isHighlighted ? styles.highlightedWrap : undefined}
              testID={isHighlighted ? `tasks-row-${task.id}-highlighted` : undefined}
            >
              <TaskRow
                task={task}
                mutating={mutating}
                onPress={onPressRow}
                onToggleDone={onToggleDone}
              />
            </View>
          );
        })}
        {!loading && tasks.length === 0 && error === null ? (
          <Text style={styles.emptyText} testID="tasks-empty-state">
            No tasks here yet. Tap “+ New task” to add one.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
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
