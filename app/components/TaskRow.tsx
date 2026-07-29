/**
 * @neutronai/app — pure single-task row (P5.4).
 *
 * The traditional task-management row shape locked by brief § 4.1:
 *
 *   [ ☐  ]  Title text that may wrap to two lines                       (row)
 *           [P0]  [2026-05-21]  [★ 7.5]                               (sub-meta)
 *
 * Left affordance is a tap-to-complete checkbox with a 44 × 44 hit
 * target (Apple HIG); tap → `onToggleDone(task)`. Tap anywhere else
 * on the row → `onPress(task)` opens the edit modal.
 *
 * Status-aware visuals:
 *
 *   - status='open'        title=text_primary, checkbox=empty outline
 *   - status='done'        title=text_muted + strikethrough,
 *                          checkbox filled with text_primary + ✓
 *   - status='cancelled'   title=text_muted + italic,
 *                          checkbox=muted outline + × (read-only;
 *                          tap is a no-op so the affordance isn't
 *                          misleading)
 *
 * Sub-meta chips render only when the underlying field is non-null:
 *
 *   - Priority   P0 (danger-tint) → P3 (text_muted/surface_raised)
 *   - Due-date   YYYY-MM-DD literal. Overdue→danger-tint,
 *                Today→warning-tint, Future→surface_raised muted.
 *   - Focus-score `★ 7.5` (one decimal). surface_raised + text_muted.
 *
 * Every color / radius / spacing / typography / motion value sources
 * from `lib/theme.ts` tokens — no magic numbers. Per brief § 4.8 the
 * alpha-tint pattern (`THEME.danger + '38'` for ~22% opacity) avoids
 * adding new color tokens.
 */

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import type { Task } from '../lib/tasks-client';
import {
  ALPHA_TINTS,
  computeDueKind,
  dueChipKind,
  formatDueDateLabel,
  formatFocusScore,
  priorityChipKind,
  type DueKind,
} from '../lib/task-row-formatters';

export interface TaskRowProps {
  task: Task;
  /** Surfaced from `useTaskState().mutating` — fades the checkbox while a mutation is in flight. */
  mutating?: boolean;
  /** Tap on the row body (not the checkbox) — opens the edit modal. */
  onPress: (task: Task) => void;
  /** Tap on the checkbox — provider dispatches complete / un-complete (or no-op when cancelled). */
  onToggleDone: (task: Task) => void;
}

// Re-export for backwards-compat with sibling components that
// already pull these names from TaskRow's surface.
export {
  ALPHA_TINTS,
  computeDueKind,
  formatDueDateLabel,
  formatFocusScore,
  localTodayString,
} from '../lib/task-row-formatters';
export type { DueKind } from '../lib/task-row-formatters';

export function TaskRow({ task, mutating = false, onPress, onToggleDone }: TaskRowProps) {
  const isDone = task.status === 'done';
  const isCancelled = task.status === 'cancelled';

  const dueLabel = useMemo(() => formatDueDateLabel(task.due_date), [task.due_date]);
  const dueKind = useMemo(() => computeDueKind(task.due_date), [task.due_date]);
  const priorityLabel = task.priority !== null && task.priority !== undefined
    ? `P${task.priority}`
    : null;
  const focusScoreLabel = useMemo(() => formatFocusScore(task.focus_score), [task.focus_score]);

  const hasMeta = priorityLabel !== null || dueLabel !== null || focusScoreLabel !== null;

  const checkboxState: 'open' | 'done' | 'cancelled' = isDone
    ? 'done'
    : isCancelled
      ? 'cancelled'
      : 'open';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Task ${task.title}, ${task.status}`}
      testID={`tasks-row-${task.id}`}
      onPress={() => onPress(task)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isDone, disabled: isCancelled }}
        accessibilityLabel={`Mark ${task.title} ${isDone ? 'not done' : 'done'}`}
        accessibilityHint={isCancelled ? 'Task is cancelled' : undefined}
        testID={`tasks-row-${task.id}-checkbox`}
        onPress={() => onToggleDone(task)}
        disabled={isCancelled}
        hitSlop={SPACING.sm}
        style={({ pressed }) => [
          styles.checkboxHitTarget,
          pressed && !isCancelled && styles.checkboxPressed,
        ]}
      >
        <View
          style={[
            styles.checkbox,
            checkboxState === 'done' && styles.checkboxDone,
            checkboxState === 'cancelled' && styles.checkboxCancelled,
            mutating && styles.checkboxMutating,
          ]}
        >
          {checkboxState === 'done' ? (
            <Text style={styles.checkboxGlyphDone} accessibilityElementsHidden>
              ✓
            </Text>
          ) : null}
          {checkboxState === 'cancelled' ? (
            <Text style={styles.checkboxGlyphCancelled} accessibilityElementsHidden>
              ×
            </Text>
          ) : null}
        </View>
      </Pressable>

      <View style={styles.body}>
        <Text
          style={[
            styles.title,
            isDone && styles.titleDone,
            isCancelled && styles.titleCancelled,
          ]}
          numberOfLines={2}
          testID={`tasks-row-${task.id}-title`}
        >
          {task.title}
        </Text>
        {hasMeta ? (
          <View style={styles.meta} testID={`tasks-row-${task.id}-meta`}>
            {priorityLabel !== null && task.priority !== null && task.priority !== undefined ? (
              <View
                style={[styles.chip, priorityChipStyle(task.priority)]}
                testID={`tasks-row-${task.id}-priority`}
              >
                <Text style={[styles.chipText, priorityChipTextStyle(task.priority)]}>
                  {priorityLabel}
                </Text>
              </View>
            ) : null}
            {dueLabel !== null ? (
              <View
                style={[styles.chip, dueChipStyle(dueKind)]}
                testID={`tasks-row-${task.id}-due`}
              >
                <Text style={[styles.chipText, dueChipTextStyle(dueKind)]}>{dueLabel}</Text>
              </View>
            ) : null}
            {focusScoreLabel !== null ? (
              <View
                style={[styles.chip, styles.chipNeutral]}
                testID={`tasks-row-${task.id}-focus`}
              >
                <Text style={[styles.chipText, styles.chipTextMuted]}>{focusScoreLabel}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function priorityChipStyle(priority: number) {
  const kind = priorityChipKind(priority);
  if (kind === 'danger') return { backgroundColor: THEME.danger + ALPHA_TINTS.panel };
  if (kind === 'warning') return { backgroundColor: THEME.warning + ALPHA_TINTS.panel };
  return styles.chipNeutral;
}

function priorityChipTextStyle(priority: number) {
  if (priority === 0) return styles.chipTextDanger;
  if (priority === 1) return styles.chipTextWarning;
  if (priority === 2) return styles.chipTextSecondary;
  return styles.chipTextMuted;
}

function dueChipStyle(kind: DueKind) {
  const chip = dueChipKind(kind);
  if (chip === 'danger') return { backgroundColor: THEME.danger + ALPHA_TINTS.panel };
  if (chip === 'warning') return { backgroundColor: THEME.warning + ALPHA_TINTS.panel };
  return styles.chipNeutral;
}

function dueChipTextStyle(kind: DueKind) {
  const chip = dueChipKind(kind);
  if (chip === 'danger') return styles.chipTextDanger;
  if (chip === 'warning') return styles.chipTextWarning;
  return styles.chipTextMuted;
}


const ROW_MIN_HEIGHT = SPACING.lg * 4;
const CHECKBOX_VISUAL = 24;
const CHECKBOX_HIT = 44;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    minHeight: ROW_MIN_HEIGHT,
    borderRadius: DENSITY.composer_radius,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  rowPressed: {
    backgroundColor: THEME.surface_raised,
  },
  checkboxHitTarget: {
    width: CHECKBOX_HIT,
    height: CHECKBOX_HIT,
    marginLeft: -SPACING.sm,
    marginVertical: -SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxPressed: { opacity: 0.78 },
  checkbox: {
    width: CHECKBOX_VISUAL,
    height: CHECKBOX_VISUAL,
    borderRadius: CHECKBOX_VISUAL / 2,
    borderWidth: 1.5,
    borderColor: THEME.text_secondary,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDone: {
    backgroundColor: THEME.text_primary,
    borderColor: THEME.text_primary,
  },
  checkboxCancelled: {
    borderColor: THEME.text_muted,
    backgroundColor: 'transparent',
  },
  checkboxMutating: { opacity: 0.6 },
  checkboxGlyphDone: {
    color: THEME.background,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '700',
  },
  checkboxGlyphCancelled: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  body: {
    flex: 1,
    gap: SPACING.xs,
  },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '500',
  },
  titleDone: {
    color: THEME.text_muted,
    textDecorationLine: 'line-through',
    fontWeight: '400',
  },
  titleCancelled: {
    color: THEME.text_muted,
    fontStyle: 'italic',
    fontWeight: '400',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  chip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: DENSITY.chip_radius,
  },
  chipNeutral: {
    backgroundColor: THEME.surface_raised,
  },
  chipText: {
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
  },
  chipTextDanger: { color: THEME.danger },
  chipTextWarning: { color: THEME.warning },
  chipTextSecondary: { color: THEME.text_secondary },
  chipTextMuted: { color: THEME.text_muted },
});
