/**
 * @neutronai/app — pure reminder-filter chip row (P5.5).
 *
 * Three pill chips — Today / Upcoming / All — at the top of the
 * reminders tab. Active chip uses the inverted dark-on-light
 * treatment; the inactive chips read as raised surface tiles with
 * the `THEME.hairline` border. Same chip rhythm as the tasks tab's
 * filter chips in P5.4 and the launcher's filter chips in P5.3.
 *
 * Filter switching is CLIENT-SIDE — `<ReminderList>` bucketizes the
 * server's canonical pending list at render time. Tapping a chip
 * does NOT trigger a re-fetch (brief § 4.2).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import {
  REMINDER_FILTER_CHOICES,
  type ReminderFilterChoice,
} from '../lib/reminder-state-reducer';

export interface ReminderFilterChipsProps {
  active: ReminderFilterChoice;
  onSelect: (filter: ReminderFilterChoice) => void;
}

export function ReminderFilterChips({ active, onSelect }: ReminderFilterChipsProps) {
  return (
    <View style={styles.row} testID="reminders-filter-row" accessibilityRole="tablist">
      {REMINDER_FILTER_CHOICES.map((choice) => {
        const isActive = choice.value === active;
        return (
          <Pressable
            key={choice.value}
            accessibilityRole="tab"
            accessibilityLabel={`Filter ${choice.label}`}
            accessibilityState={{ selected: isActive }}
            testID={`reminders-filter-${choice.value}`}
            onPress={() => onSelect(choice.value)}
            style={({ pressed }) => [
              styles.chip,
              isActive ? styles.chipActive : styles.chipInactive,
              pressed && styles.chipPressed,
            ]}
          >
            <Text
              style={[
                styles.chipText,
                isActive ? styles.chipTextActive : styles.chipTextInactive,
              ]}
            >
              {choice.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
    borderRadius: DENSITY.chip_radius,
    borderWidth: 1,
  },
  chipInactive: {
    backgroundColor: THEME.surface,
    borderColor: THEME.hairline,
  },
  chipActive: {
    backgroundColor: THEME.text_primary,
    borderColor: THEME.text_primary,
  },
  chipPressed: { opacity: 0.78 },
  chipText: {
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
  },
  chipTextInactive: { color: THEME.text_secondary },
  chipTextActive: { color: THEME.background },
});
