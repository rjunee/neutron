/**
 * @neutronai/app — pure single-reminder row (P5.5).
 *
 * Traditional reminder-app row shape locked by brief § 4.6:
 *
 *   [ ⏰ ]  Reminder message text that may wrap to two lines.       (row)
 *           [ in 2h ]  [ weekly ]  [ @neutronai/tasks ]              (sub-meta)
 *
 * Left affordance is a NON-INTERACTIVE 24×24 px clock-glyph in a
 * circular outline (hit target preserved at 44×44 for visual rhythm
 * with the P5.4 task-row checkbox). Tap row → `onPress(entry)` opens
 * the edit modal. Long-press row → `onPress(entry)` opens the same
 * edit modal (the brief collapses the MVP's action sheet INTO the
 * edit modal — one surface for snooze + cancel + convert; see brief
 * § 4.4).
 *
 * Sub-meta row chips:
 *
 *   - Fire-at chip   `formatFireAt(fire_at, now_ms)`. Bucket-tinted:
 *                     overdue → THEME.danger-tint;
 *                     today    → THEME.warning-tint;
 *                     future   → THEME.surface_raised muted.
 *   - Recurrence     literal cadence label when entry.recurrence is
 *                     non-null. surface_raised + text_muted.
 *   - Source         literal source tag, only when entry.source is
 *                     non-null AND not the self-tag
 *                     `'app:reminders-tab'`. surface_raised +
 *                     text_muted. Surfaces engine-organic + task-
 *                     auto-linked + Core-created rows distinctly.
 *
 * Every color / radius / spacing / typography / motion value sources
 * from `lib/theme.ts` tokens — no magic numbers. The alpha-tint
 * pattern (`THEME.danger + '38'` for ~22% opacity) avoids adding new
 * color tokens (mirrors P5.4 task row's chip ramp via ALPHA_TINTS).
 */

import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import { formatFireAt, type ReminderItem } from '../lib/reminders-client';
import {
  computeFireAtBucket,
  type FireAtBucket,
} from '../lib/reminder-state-reducer';
import { ALPHA_TINTS } from '../lib/task-row-formatters';

const SELF_SOURCE_TAG = 'app:reminders-tab' as const;
const LONG_PRESS_DELAY_MS = 350;

export interface ReminderRowProps {
  entry: ReminderItem;
  /** Surfaced from `useReminderState().mutating` — fades the clock-glyph while in flight. */
  mutating?: boolean;
  /** Tap or long-press the row → opens the unified edit modal. */
  onPress: (entry: ReminderItem) => void;
}

function fireAtChipStyle(bucket: FireAtBucket) {
  if (bucket === 'overdue') {
    return {
      backgroundColor: THEME.danger + ALPHA_TINTS.panel,
    };
  }
  if (bucket === 'today') {
    return {
      backgroundColor: THEME.warning + ALPHA_TINTS.panel,
    };
  }
  return styles.chipNeutral;
}

function fireAtChipTextStyle(bucket: FireAtBucket) {
  if (bucket === 'overdue') return styles.chipTextDanger;
  if (bucket === 'today') return styles.chipTextWarning;
  return styles.chipTextMuted;
}

export function ReminderRow({ entry, mutating = false, onPress }: ReminderRowProps) {
  const now_ms = Date.now();
  const fireBucket = useMemo(
    () => computeFireAtBucket(entry.fire_at, now_ms),
    [entry.fire_at, now_ms],
  );
  const fireLabel = useMemo(
    () => formatFireAt(entry.fire_at, now_ms),
    [entry.fire_at, now_ms],
  );

  const recurrenceLabel = entry.recurrence !== null ? entry.recurrence : null;
  const sourceLabel =
    typeof entry.source === 'string' &&
    entry.source.length > 0 &&
    entry.source !== SELF_SOURCE_TAG
      ? entry.source
      : null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Reminder: ${entry.message}. Fires ${fireLabel}. Tap or long-press for options.`}
      testID={`reminders-row-${entry.id}`}
      onPress={() => onPress(entry)}
      onLongPress={() => onPress(entry)}
      delayLongPress={LONG_PRESS_DELAY_MS}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View
        style={[styles.glyphHitTarget]}
        accessibilityElementsHidden
        importantForAccessibility="no"
        testID={`reminders-row-${entry.id}-glyph`}
      >
        <View
          style={[
            styles.glyph,
            mutating && styles.glyphMutating,
          ]}
        >
          <Text style={styles.glyphText}>⏰</Text>
        </View>
      </View>

      <View style={styles.body}>
        <Text
          style={styles.title}
          numberOfLines={2}
          testID={`reminders-row-${entry.id}-title`}
        >
          {entry.message}
        </Text>
        <View style={styles.meta} testID={`reminders-row-${entry.id}-meta`}>
          <View
            style={[styles.chip, fireAtChipStyle(fireBucket)]}
            testID={`reminders-row-${entry.id}-fire-at`}
            accessibilityLabel={`Fires ${fireLabel}`}
          >
            <Text style={[styles.chipText, fireAtChipTextStyle(fireBucket)]}>
              {fireLabel}
            </Text>
          </View>
          {recurrenceLabel !== null ? (
            <View
              style={[styles.chip, styles.chipNeutral]}
              testID={`reminders-row-${entry.id}-recurrence`}
              accessibilityLabel={`Repeats ${recurrenceLabel}`}
            >
              <Text style={[styles.chipText, styles.chipTextMuted]}>
                {recurrenceLabel}
              </Text>
            </View>
          ) : null}
          {sourceLabel !== null ? (
            <View
              style={[styles.chip, styles.chipNeutral]}
              testID={`reminders-row-${entry.id}-source`}
              accessibilityLabel={`Source ${sourceLabel}`}
            >
              <Text
                style={[styles.chipText, styles.chipTextMuted]}
                numberOfLines={1}
              >
                {sourceLabel}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const ROW_MIN_HEIGHT = SPACING.lg * 4;
const GLYPH_VISUAL = 24;
const GLYPH_HIT = 44;

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
  rowPressed: { backgroundColor: THEME.surface_raised },
  glyphHitTarget: {
    width: GLYPH_HIT,
    height: GLYPH_HIT,
    marginLeft: -SPACING.sm,
    marginVertical: -SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    width: GLYPH_VISUAL,
    height: GLYPH_VISUAL,
    borderRadius: GLYPH_VISUAL / 2,
    borderWidth: 1.5,
    borderColor: THEME.text_secondary,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphMutating: { opacity: 0.6 },
  glyphText: {
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    color: THEME.text_secondary,
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
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  chip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: DENSITY.chip_radius,
    maxWidth: 220,
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
  chipTextMuted: { color: THEME.text_muted },
});
