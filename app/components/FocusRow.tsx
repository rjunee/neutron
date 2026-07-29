/**
 * @neutronai/app — pure single Focus row (P5.6).
 *
 * Cross-project focus row shape locked by brief § 4.4 + § 4.8:
 *
 *   [ • ]  Title text that may wrap to two lines.                  ›  (row)
 *          [ Task ] [ acme ] [ P1 ] [ in 2h ]                    (sub-meta)
 *
 * Left affordance is a 12×12 px bucket-tinted dot. Right affordance is
 * a `›` chevron. Tap-anywhere on the row → `onPress(item)` opens the
 * originating per-project tab (task → `/projects/<id>/tasks`;
 * reminder → `/projects/<id>/reminders`; owner-level →
 * `/projects`). Focus is a READ-ONLY projection — no per-row mutations
 * per brief § 4.5.
 *
 * Sub-meta row chips:
 *
 *   - Kind        `Task` / `Reminder`. surface_raised + text_muted.
 *   - Project     `item.project_id` for project-bound rows
 *                 (surface_raised + text_secondary) OR `Owner` with a
 *                 hairline border + transparent bg for owner-level
 *                 rows (`project_id === ''`). The visually-distinct
 *                 register lets the eye spot "no project home" at a
 *                 glance — the cross-project nature of Focus is the
 *                 WHOLE point.
 *   - Priority    P0 (danger-tint) → P1 (warning-tint) → P2/P3
 *                 (neutral). Only rendered when priority is non-null
 *                 per brief § 4.8.
 *   - Due         `formatDueRelative(due_at, now_ms)`. Bucket-tinted:
 *                 overdue → danger-tint; today → warning-tint; soon →
 *                 neutral. Only rendered when due_at is non-null.
 *
 * Every color / radius / spacing / typography / motion value sources
 * from `lib/theme.ts` tokens — no magic numbers. Reuses the alpha-
 * tint pattern P5.4 + P5.5 established (`THEME.danger + ALPHA_TINTS.panel`).
 */

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { FocusItem } from '../lib/focus-client';
import {
  bucketDotColor,
  dueChipKind,
  formatDueRelative,
  isInstanceLevel,
  kindChipLabel,
  priorityChipKind,
  projectChipLabel,
  type DueChipKind,
  type PriorityChipKind,
} from '../lib/focus-row-formatters';
import { ALPHA_TINTS } from '../lib/task-row-formatters';
import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

/**
 * Dot diameter in CSS px. Inline literal authorized by brief § 4.8 as
 * one of the optional `DENSITY.bucket_dot_size` token additions —
 * declined for parity with P5.4 + P5.5 (the MVP's `10` is already
 * documented in the brief's mapping table).
 */
const BUCKET_DOT_SIZE = 10;

/**
 * Chevron glyph at the right edge — `›` at body typography size. Kept
 * as a single magic char because the typography token drives the size;
 * the color comes from `THEME.text_muted`.
 */
const CHEVRON_GLYPH = '›';

/**
 * Row radius (12) — inline arithmetic on `DENSITY.bubble_radius - 2`.
 * One of the optional `DENSITY.list_row_radius` token additions per
 * brief § 4.8; declined for parity with P5.4 + P5.5.
 */
const ROW_RADIUS = DENSITY.bubble_radius - 2;

export interface FocusRowProps {
  item: FocusItem;
  /**
   * Optional clock-frozen `now` (ms) so the integration tests can
   * assert stable due-chip text. Defaults to live `Date.now()`.
   */
  nowMs?: number;
  /** Tap → opens the originating project tab via the route's `handleItemPress`. */
  onPress: (item: FocusItem) => void;
}

export function FocusRow({ item, nowMs, onPress }: FocusRowProps) {
  const now_ms = nowMs ?? Date.now();
  const dueText = useMemo(
    () => formatDueRelative(item.due_at, now_ms),
    [item.due_at, now_ms],
  );
  const instanceLevel = isInstanceLevel(item);
  const priorityKind = priorityChipKind(item.priority);
  const dueKind = dueChipKind(item.bucket);
  const dotColor = bucketDotColor(item.bucket);
  const kindLabel = kindChipLabel(item);
  const projectLabel = projectChipLabel(item);

  const accessibilityLabel = useMemo(() => {
    const parts: string[] = [kindLabel, item.title];
    if (item.priority !== null && item.priority >= 0) {
      parts.push(`priority P${item.priority}`);
    }
    if (dueText.length > 0) parts.push(dueText);
    parts.push(instanceLevel ? 'instance-level' : `project ${projectLabel}`);
    parts.push(`bucket ${item.bucket}`);
    return parts.join(', ');
  }, [item, kindLabel, dueText, instanceLevel, projectLabel]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={`focus-item-${item.source}-${item.id}`}
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View
        style={[styles.dot, { backgroundColor: dotColor }]}
        accessibilityElementsHidden
        importantForAccessibility="no"
        testID={`focus-item-${item.source}-${item.id}-dot`}
      />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={styles.meta}>
          {/* Kind chip */}
          <View style={[styles.chip, styles.chipNeutral]} testID="focus-row-kind">
            <Text style={[styles.chipText, styles.chipTextMuted]}>{kindLabel}</Text>
          </View>
          {/* Project chip — owner-level rows get a hairline border + transparent bg */}
          <View
            style={[
              styles.chip,
              instanceLevel ? styles.chipInstance : styles.chipProject,
            ]}
            testID={instanceLevel ? 'focus-row-project-instance' : 'focus-row-project'}
          >
            <Text
              style={[
                styles.chipText,
                instanceLevel ? styles.chipTextMuted : styles.chipTextSecondary,
              ]}
              numberOfLines={1}
            >
              {projectLabel}
            </Text>
          </View>
          {/* Priority chip — only when priority is non-null */}
          {priorityKind !== null ? (
            <View
              style={[styles.chip, priorityChipBg(priorityKind)]}
              testID="focus-row-priority"
            >
              <Text style={[styles.chipText, priorityChipText(priorityKind)]}>
                {`P${Math.max(0, item.priority ?? 0)}`}
              </Text>
            </View>
          ) : null}
          {/* Due chip — only when due_at is non-null AND format produced text */}
          {dueText.length > 0 ? (
            <View
              style={[styles.chip, dueChipBg(dueKind)]}
              testID="focus-row-due"
            >
              <Text style={[styles.chipText, dueChipText(dueKind)]}>
                {dueText}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      <Text style={styles.chevron}>{CHEVRON_GLYPH}</Text>
    </Pressable>
  );
}

function priorityChipBg(kind: PriorityChipKind) {
  if (kind === 'p0') {
    return { backgroundColor: THEME.danger + ALPHA_TINTS.panel };
  }
  if (kind === 'p1') {
    return { backgroundColor: THEME.warning + ALPHA_TINTS.panel };
  }
  return styles.chipNeutral;
}

function priorityChipText(kind: PriorityChipKind) {
  if (kind === 'p0') return styles.chipTextDanger;
  if (kind === 'p1') return styles.chipTextWarning;
  if (kind === 'p2') return styles.chipTextSecondary;
  return styles.chipTextMuted;
}

function dueChipBg(kind: DueChipKind) {
  if (kind === 'overdue') {
    return { backgroundColor: THEME.danger + ALPHA_TINTS.panel };
  }
  if (kind === 'today') {
    return { backgroundColor: THEME.warning + ALPHA_TINTS.panel };
  }
  return styles.chipNeutral;
}

function dueChipText(kind: DueChipKind) {
  if (kind === 'overdue') return styles.chipTextDanger;
  if (kind === 'today') return styles.chipTextWarning;
  return styles.chipTextMuted;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: ROW_RADIUS,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
  },
  rowPressed: {
    opacity: 0.78,
    borderColor: THEME.text_muted,
    backgroundColor: THEME.surface_raised,
  },
  dot: {
    width: BUCKET_DOT_SIZE,
    height: BUCKET_DOT_SIZE,
    borderRadius: BUCKET_DOT_SIZE / 2,
    marginTop: SPACING.xs + 2,
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
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.xs + 2,
    marginTop: SPACING.xs,
  },
  chip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: DENSITY.chip_radius,
    maxWidth: 200,
  },
  chipNeutral: { backgroundColor: THEME.surface_raised },
  chipProject: { backgroundColor: THEME.surface_raised },
  chipInstance: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: THEME.hairline,
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
  chevron: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    marginLeft: SPACING.xs,
    // The chevron glyph sits flush with the title baseline; the chevron
    // font has its own optical center so this aligns the visual center.
    marginTop: SPACING.xs / 2,
  },
});
