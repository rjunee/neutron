/**
 * @neutronai/app — pure Focus bucket section container (P5.6).
 *
 * Renders ONE bucket's worth of focus rows:
 *
 *   OVERDUE                                                          (overline)
 *   ----------------------------------------------------------
 *   • Item 1 ...
 *   • Item 2 ...
 *
 * Empty bucket sections are NOT rendered — the parent `<FocusList>`
 * already filters via `bucketizeSections` (brief § 4.1). The section
 * label uses `TYPOGRAPHY.caption` uppercase with `letterSpacing` —
 * same overline treatment the existing MVP used, token-ified.
 *
 * Pure-props: receives `bucket`, `label`, `items`, `onItemPress`. No
 * state, no fetch, no row-mutation surface. The optional `nowMs` is
 * threaded through to `<FocusRow>` so integration tests can pin time.
 */

import { StyleSheet, Text, View } from 'react-native';

import type { FocusBucket, FocusItem } from '../lib/focus-client';
import { SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import { FocusRow } from './FocusRow';

export interface FocusBucketSectionProps {
  bucket: FocusBucket;
  label: string;
  items: FocusItem[];
  /** Frozen `now` (ms) — threaded to FocusRow for deterministic due-chip text. */
  nowMs?: number;
  onItemPress: (item: FocusItem) => void;
}

export function FocusBucketSection({
  bucket,
  label,
  items,
  nowMs,
  onItemPress,
}: FocusBucketSectionProps) {
  return (
    <View
      style={styles.section}
      testID={`focus-section-${bucket}`}
    >
      <Text
        style={styles.label}
        accessibilityRole="header"
        testID={`focus-section-${bucket}-label`}
      >
        {label}
      </Text>
      <View style={styles.rows}>
        {items.map((item) => (
          <FocusRow
            key={`${item.source}-${item.id}`}
            item={item}
            nowMs={nowMs}
            onPress={onItemPress}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: SPACING.sm,
  },
  label: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    paddingHorizontal: SPACING.xs,
  },
  rows: {
    gap: SPACING.sm,
  },
});
