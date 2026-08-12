/**
 * @neutronai/app — reminder create modal (P5.5).
 *
 * Centered Modal-overlay create form. Multiline message input
 * (autofocus, optional one-line subtitle) + five fire-at preset
 * chips (in 15m / in 1h / in 3h / tomorrow 9am / in 1w; per brief
 * § 4.3). Cancel + Create buttons; in-flight ActivityIndicator on
 * Create.
 *
 * Submit shape: `onSubmit({message, fire_at_seconds})`. The fire_at
 * value is computed at submit time from `Date.now() + offset_ms` so
 * a stale `tomorrow 9am` offset never drifts past midnight. The
 * preset list itself is rebuilt on every modal-open via the
 * `buildReminderPresets(now)` helper.
 *
 * Theme-tokened across the board per § 4.8; modal backdrop alpha
 * stays inline per the brief (alpha overlays are not a theme color).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  buildReminderPresets,
  DEFAULT_CREATE_PRESET_ID,
  type ReminderPreset,
} from '../lib/reminder-presets';
import { DENSITY, SPACING, TYPOGRAPHY, type NeutronTheme } from '../lib/theme';
import { useTheme, useThemedStyles } from '../lib/theme-context';

const MAX_MESSAGE_LEN = 4096;

export interface ReminderCreateModalProps {
  open: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (input: { message: string; fire_at_seconds: number }) => void;
}

export function ReminderCreateModal({
  open,
  submitting,
  onCancel,
  onSubmit,
}: ReminderCreateModalProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [message, setMessage] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    DEFAULT_CREATE_PRESET_ID,
  );

  // Recompute preset offsets on every modal open so "tomorrow 9am"
  // is always fresh. Memoized on `open` so re-renders inside the
  // open lifecycle don't re-stamp Date.now() on every keystroke.
  const presets = useMemo<ReminderPreset[]>(() => {
    if (!open) return [];
    return buildReminderPresets(new Date());
  }, [open]);

  useEffect(() => {
    if (!open) {
      setMessage('');
      setSelectedPresetId(DEFAULT_CREATE_PRESET_ID);
    }
  }, [open]);

  if (!open) return null;

  const trimmedMessage = message.trim();
  const canSubmit = trimmedMessage.length > 0 && !submitting;
  const selectedPreset = presets.find((p) => p.id === selectedPresetId) ?? presets[0];

  const submit = () => {
    if (!canSubmit) return;
    if (selectedPreset === undefined) return;
    const fire_at_seconds = Math.round((Date.now() + selectedPreset.offset_ms) / 1000);
    onSubmit({ message: trimmedMessage, fire_at_seconds });
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.panel} testID="reminders-create-modal">
          <Text style={styles.title} accessibilityRole="header">
            New reminder
          </Text>
          <Text style={styles.subtitle}>
            Fires once at the chosen time. Recurring reminders ship in a later sprint.
          </Text>
          <TextInput
            accessibilityLabel="Reminder message"
            placeholder="What should we remind you about?"
            placeholderTextColor={theme.text_muted}
            value={message}
            onChangeText={setMessage}
            style={[styles.input, styles.inputMultiline]}
            multiline
            autoFocus
            maxLength={MAX_MESSAGE_LEN}
            testID="reminders-create-message"
          />
          <Text style={styles.fieldLabel}>Fire at</Text>
          <View style={styles.presetRow}>
            {presets.map((preset) => {
              const isSelected = preset.id === selectedPresetId;
              return (
                <Pressable
                  key={preset.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Fire ${preset.label}`}
                  accessibilityState={{ selected: isSelected }}
                  testID={`reminders-create-preset-${preset.id}`}
                  onPress={() => setSelectedPresetId(preset.id)}
                  style={({ pressed }) => [
                    styles.presetChip,
                    isSelected ? styles.presetChipActive : styles.presetChipInactive,
                    pressed && styles.presetChipPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.presetChipText,
                      isSelected
                        ? styles.presetChipTextActive
                        : styles.presetChipTextInactive,
                    ]}
                  >
                    {preset.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel create"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.btn,
                styles.btnNeutral,
                pressed && styles.btnPressed,
              ]}
              testID="reminders-create-cancel"
            >
              <Text style={[styles.btnText, styles.btnTextNeutral]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create reminder"
              disabled={!canSubmit}
              onPress={submit}
              style={({ pressed }) => [
                styles.btn,
                styles.btnPrimary,
                !canSubmit && styles.btnDisabled,
                canSubmit && pressed && styles.btnPressed,
              ]}
              testID="reminders-create-submit"
            >
              {submitting ? (
                <ActivityIndicator color={theme.background} />
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

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: theme.scrim,
      alignItems: 'center',
      justifyContent: 'center',
      padding: SPACING.xl,
    },
    panel: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: theme.surface,
      borderRadius: DENSITY.bubble_radius,
      borderWidth: 1,
      borderColor: theme.hairline,
      padding: SPACING.lg,
      gap: SPACING.sm,
    },
    title: {
      color: theme.text_primary,
      fontSize: TYPOGRAPHY.h2.fontSize,
      lineHeight: TYPOGRAPHY.h2.lineHeight,
      fontWeight: TYPOGRAPHY.h2.fontWeight,
    },
    subtitle: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
    },
    fieldLabel: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
      marginTop: SPACING.xs,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    input: {
      color: theme.text_primary,
      backgroundColor: theme.background,
      borderColor: theme.hairline,
      borderWidth: 1,
      borderRadius: DENSITY.composer_radius,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm + 2,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
    },
    inputMultiline: { minHeight: 80, textAlignVertical: 'top' },
    presetRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: SPACING.sm,
    },
    presetChip: {
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.xs + 2,
      borderRadius: DENSITY.chip_radius,
      borderWidth: 1,
    },
    presetChipInactive: {
      backgroundColor: theme.surface_raised,
      borderColor: theme.hairline,
    },
    presetChipActive: {
      backgroundColor: theme.text_primary,
      borderColor: theme.text_primary,
    },
    presetChipPressed: { opacity: 0.78 },
    presetChipText: {
      fontSize: TYPOGRAPHY.caption.fontSize,
      lineHeight: TYPOGRAPHY.caption.lineHeight,
      fontWeight: '600',
    },
    presetChipTextInactive: { color: theme.text_secondary },
    presetChipTextActive: { color: theme.background },
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
      minWidth: 88,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnPressed: { opacity: 0.78 },
    btnDisabled: { opacity: 0.5 },
    btnNeutral: { backgroundColor: theme.surface_raised },
    btnPrimary: { backgroundColor: theme.text_primary },
    btnText: {
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
      fontWeight: '600',
    },
    btnTextNeutral: { color: theme.text_secondary },
    btnTextPrimary: { color: theme.background },
  });
