/**
 * @neutronai/app — pure tasks-tab header (P5.4).
 *
 * Renders:
 *
 *   Tasks                              [ + New task ]
 *   Project-scoped, backed by canonical task DB.
 *
 * The "+ New task" button uses the dark-on-light primary treatment
 * (`THEME.text_primary` background, `THEME.background` text) — same
 * pattern P5.3 uses for the launcher's "Build me…" tile primary
 * affordance. Pressed-state fades to `MOTION.fast` opacity.
 *
 * No state lives here; the parent route owns the modal open/close.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface TaskHeaderProps {
  onCreatePress: () => void;
}

export function TaskHeader({ onCreatePress }: TaskHeaderProps) {
  return (
    <View style={styles.header} testID="tasks-header">
      <View style={styles.intro}>
        <Text style={styles.title} accessibilityRole="header">
          Tasks
        </Text>
        <Text style={styles.subtitle}>
          Project-scoped, backed by the canonical task DB.
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New task"
        testID="tasks-new-button"
        onPress={onCreatePress}
        style={({ pressed }) => [styles.newBtn, pressed && styles.newBtnPressed]}
      >
        <Text style={styles.newBtnText}>+ New task</Text>
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
