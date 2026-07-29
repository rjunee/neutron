/**
 * @neutronai/app — launcher rename modal (P5.3).
 *
 * Centered Modal-overlay rename prompt. Single-line TextInput +
 * Cancel + Save. Empty draft on Save calls `onCancel` (the MVP
 * behavior — saving "" is conceptually a no-op).
 *
 * Per § 4.4 + § 4.11 of the brief: theme tokens only, modal
 * fade-in via `animationType="fade"`, AA contrast on every text
 * combination.
 */

import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LauncherEntry } from '../lib/launcher-client';
import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface LauncherRenameModalProps {
  entry: LauncherEntry | null;
  draft: string;
  onDraftChange: (next: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function LauncherRenameModal({
  entry,
  draft,
  onDraftChange,
  onCancel,
  onSubmit,
}: LauncherRenameModalProps) {
  if (entry === null) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalPanel} testID="launcher-rename-modal">
          <Text style={styles.modalTitle}>Rename App</Text>
          <Text style={styles.modalSubtitle}>{entry.slug}</Text>
          <TextInput
            accessibilityLabel="New display name"
            placeholder="New name"
            placeholderTextColor={THEME.text_muted}
            value={draft}
            onChangeText={onDraftChange}
            style={styles.modalInput}
            autoFocus
            maxLength={80}
          />
          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel rename"
              onPress={onCancel}
              style={({ pressed }) => [styles.modalBtn, pressed && styles.pressed]}
            >
              <Text style={styles.modalBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save rename"
              testID="launcher-rename-submit"
              onPress={onSubmit}
              style={({ pressed }) => [
                styles.modalBtn,
                styles.modalBtnPrimary,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  modalPanel: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: THEME.surface,
    borderRadius: DENSITY.bubble_radius,
    borderWidth: 1,
    borderColor: THEME.hairline,
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  modalTitle: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h4.fontSize,
    lineHeight: TYPOGRAPHY.h4.lineHeight,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  modalInput: {
    color: THEME.text_primary,
    backgroundColor: THEME.background,
    borderColor: THEME.hairline,
    borderWidth: 1,
    borderRadius: DENSITY.composer_radius,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  modalBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: DENSITY.composer_radius,
    backgroundColor: THEME.surface_raised,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnPrimary: { backgroundColor: THEME.text_primary },
  modalBtnText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  modalBtnTextPrimary: { color: THEME.background },
  pressed: { opacity: 0.7 },
});
