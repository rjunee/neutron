/**
 * @neutronai/app — create-project sheet, invoked from the rail's `+`.
 *
 * The projects-list screen owned "+ Create Project" as a bottom-pinned bar. That
 * screen is deleted (SPEC § Decisions Log 2026-07-27), so creation is a sheet
 * over the chat: one entry point, no separate screen, consistent with the
 * chat-first entry.
 *
 * Presentational. The parent (`app/app/projects/[id]/_layout.tsx`) owns the
 * `createProject` POST and feeds `submitting` / `errorText` back down, matching
 * `<InviteModal>`. The name rule is `checkProjectName` in
 * `lib/create-project-helpers.ts` so it can be unit-asserted.
 *
 * Tokens only, per `lib/theme.ts`'s anti-pattern guard.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import { checkProjectName } from '../lib/create-project-helpers';

export interface CreateProjectSheetProps {
  open: boolean;
  /** True while the parent's POST /api/app/projects is in flight. */
  submitting: boolean;
  /** Inline error copy (empty-name rule or a server reason); null when none. */
  errorText: string | null;
  onCancel: () => void;
  /** Receives the TRIMMED name — the sheet never submits raw input. */
  onSubmit: (name: string) => void;
}

export function CreateProjectSheet({
  open,
  submitting,
  errorText,
  onCancel,
  onSubmit,
}: CreateProjectSheetProps) {
  const [name, setName] = useState('');

  // Reset on close so a reopen starts clean (same rule as <InviteModal>).
  useEffect(() => {
    if (!open) setName('');
  }, [open]);

  if (!open) return null;

  const check = checkProjectName(name);
  const canSubmit = check.ok && !submitting;

  const submit = (): void => {
    if (!check.ok || submitting) return;
    onSubmit(check.name);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.panel} testID="create-project-sheet">
          <Text style={styles.title} accessibilityRole="header">
            New project
          </Text>
          <Text style={styles.subtitle}>
            It opens straight into its own chat, and joins the rail on the left.
          </Text>
          <TextInput
            accessibilityLabel="Project name"
            placeholder="Project name"
            placeholderTextColor={THEME.text_muted}
            value={name}
            onChangeText={setName}
            style={styles.input}
            autoFocus
            editable={!submitting}
            maxLength={120}
            returnKeyType="done"
            testID="create-project-input"
            onSubmitEditing={submit}
          />
          {errorText !== null ? (
            <Text style={styles.error} testID="create-project-error">
              {errorText}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel create project"
              disabled={submitting}
              onPress={onCancel}
              style={({ pressed }) => [
                styles.btn,
                styles.btnNeutral,
                pressed && styles.btnPressed,
              ]}
              testID="create-project-cancel"
            >
              <Text style={[styles.btnText, styles.btnTextNeutral]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm create project"
              disabled={!canSubmit}
              onPress={submit}
              style={({ pressed }) => [
                styles.btn,
                styles.btnPrimary,
                !canSubmit && styles.btnDisabled,
                canSubmit && pressed && styles.btnPressed,
              ]}
              testID="create-project-confirm"
            >
              {submitting ? (
                <ActivityIndicator color={THEME.background} />
              ) : (
                <Text style={[styles.btnText, styles.btnTextPrimary]}>Create</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  panel: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: THEME.surface,
    borderRadius: DENSITY.bubble_radius,
    borderWidth: 1,
    borderColor: THEME.hairline,
    padding: SPACING.lg,
    gap: SPACING.sm,
  },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h2.fontSize,
    lineHeight: TYPOGRAPHY.h2.lineHeight,
    fontWeight: TYPOGRAPHY.h2.fontWeight,
  },
  subtitle: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  input: {
    color: THEME.text_primary,
    backgroundColor: THEME.background,
    borderColor: THEME.hairline,
    borderWidth: 1,
    borderRadius: DENSITY.composer_radius,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm + 2,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  error: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  btn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm + 2,
    borderRadius: DENSITY.bubble_radius - 4,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: { opacity: 0.78 },
  btnDisabled: { opacity: 0.5 },
  btnNeutral: { backgroundColor: THEME.surface_raised },
  btnPrimary: { backgroundColor: THEME.text_primary },
  btnText: {
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  btnTextNeutral: { color: THEME.text_secondary },
  btnTextPrimary: { color: THEME.background },
});
