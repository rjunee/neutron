/**
 * @neutronai/app — pure task-filter chip row (P5.4).
 *
 * Three pill chips — Open / Done / All — at the top of the tasks
 * tab. Active chip uses the inverted dark-on-light treatment; the
 * inactive chips read as raised surface tiles with the
 * `THEME.hairline` border. Same chip rhythm as the launcher's
 * filter chips in P5.3.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, TYPOGRAPHY, type NeutronTheme } from '../lib/theme';
import { useThemedStyles } from '../lib/theme-context';
import { FILTER_CHOICES, type FilterChoice } from '../lib/task-state-reducer';

export interface TaskFilterChipsProps {
  active: FilterChoice;
  onSelect: (filter: FilterChoice) => void;
}

export function TaskFilterChips({ active, onSelect }: TaskFilterChipsProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row} testID="tasks-filter-row" accessibilityRole="tablist">
      {FILTER_CHOICES.map((choice) => {
        const isActive = choice.value === active;
        return (
          <Pressable
            key={choice.value}
            accessibilityRole="tab"
            accessibilityLabel={`Filter ${choice.label}`}
            accessibilityState={{ selected: isActive }}
            testID={`tasks-filter-${choice.value}`}
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

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
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
      backgroundColor: theme.surface,
      borderColor: theme.hairline,
    },
    chipActive: {
      backgroundColor: theme.text_primary,
      borderColor: theme.text_primary,
    },
    chipPressed: { opacity: 0.78 },
    chipText: {
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
    },
    chipTextInactive: { color: theme.text_secondary },
    chipTextActive: { color: theme.background },
  });
