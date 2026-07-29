/**
 * @neutronai/app — launcher "Build me…" prompt modal (P5.3).
 *
 * Centered Modal-overlay prompt. Multiline TextInput + Cancel +
 * Send. The Send button shows an `ActivityIndicator` while
 * `submitting === true` so the user has feedback the chat-send is in
 * flight. Send is disabled when the trimmed draft is empty OR the
 * request is in flight.
 *
 * Submit fires the `onSubmit` callback the route hooks to
 * `LauncherStateProvider.sendBuildMe(prompt)` — the typed
 * `LauncherClient.sendBuildMePrompt` path the production-composer
 * guard test reaches end-to-end.
 *
 * Per § 4.4 + § 4.11 of the brief: theme tokens only, modal fade-in
 * via `animationType="fade"`, AA contrast on every text combination.
 */

import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

export interface LauncherBuildMeModalProps {
  open: boolean;
  draft: string;
  submitting: boolean;
  onDraftChange: (next: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function LauncherBuildMeModal({
  open,
  draft,
  submitting,
  onDraftChange,
  onCancel,
  onSubmit,
}: LauncherBuildMeModalProps) {
  if (!open) return null;
  const sendDisabled = submitting || draft.trim().length === 0;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalPanel} testID="launcher-build-me-modal">
          <Text style={styles.modalTitle}>Build me a Core that…</Text>
          <Text style={styles.modalSubtitle}>
            Describe what the new App should do. The agent picks up the prompt in chat — real
            Core scaffolding lands in a later sprint.
          </Text>
          <TextInput
            accessibilityLabel="Describe the Core"
            placeholder="…tracks my running mileage and writes a weekly summary."
            placeholderTextColor={THEME.text_muted}
            value={draft}
            onChangeText={onDraftChange}
            style={[styles.modalInput, styles.modalInputMultiline]}
            multiline
            autoFocus
            maxLength={1024}
          />
          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel build-me"
              onPress={onCancel}
              style={({ pressed }) => [styles.modalBtn, pressed && styles.pressed]}
            >
              <Text style={styles.modalBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send build-me prompt"
              testID="launcher-build-me-submit"
              disabled={sendDisabled}
              onPress={onSubmit}
              style={({ pressed }) => [
                styles.modalBtn,
                styles.modalBtnPrimary,
                sendDisabled && styles.modalBtnDisabled,
                !sendDisabled && pressed && styles.pressed,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={THEME.background} />
              ) : (
                <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>Send</Text>
              )}
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
    color: THEME.text_secondary,
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
  modalInputMultiline: { minHeight: 96, textAlignVertical: 'top' },
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
  modalBtnDisabled: { opacity: 0.5 },
  modalBtnText: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  modalBtnTextPrimary: { color: THEME.background },
  pressed: { opacity: 0.7 },
});
