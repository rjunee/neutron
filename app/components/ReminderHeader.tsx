/**
 * @neutronai/app — pure reminders-tab header (P5.5).
 *
 * Renders:
 *
 *   Reminders                                [ + New reminder ]
 *   Project-scoped, sorted by next-firing.
 *
 * The "+ New reminder" button uses the dark-on-light primary
 * treatment (`THEME.text_primary` background, `THEME.background`
 * text) — same pattern P5.3 + P5.4 used for the launcher's primary
 * affordance + the tasks tab's "+ New task" button. Pressed state
 * fades to `MOTION.fast` opacity.
 *
 * No state lives here; the parent route owns the modal open/close.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface ReminderHeaderProps {
  onCreatePress: () => void;
}

export function ReminderHeader({ onCreatePress }: ReminderHeaderProps) {
  return (
    <View style={styles.header} testID="reminders-header">
      <View style={styles.intro}>
        <Text style={styles.title} accessibilityRole="header">
          Reminders
        </Text>
        <Text style={styles.subtitle}>
          Project-scoped, sorted by next-firing.
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New reminder"
        testID="reminders-new-button"
        onPress={onCreatePress}
        style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}
      >
        <Text style={styles.newBtnText}>+ New reminder</Text>
      </Pressable>
    </View>
  );
}

const BUTTON_RADIUS = DENSITY.bubble_radius - 4;

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
    marginBottom: SPACING.sm,
  },
  intro: { flex: 1, gap: SPACING.xs },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h1.fontSize,
    lineHeight: TYPOGRAPHY.h1.lineHeight,
    fontWeight: TYPOGRAPHY.h1.fontWeight,
  },
  subtitle: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  newBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BUTTON_RADIUS,
    backgroundColor: THEME.text_primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newBtnPressed: { opacity: 0.78 },
  newBtnText: {
    color: THEME.background,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '700',
  },
});
