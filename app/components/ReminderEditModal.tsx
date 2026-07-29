/**
 * @neutronai/app — reminder edit modal (P5.5).
 *
 * Centered Modal-overlay edit form. Two-row action layout per brief
 * § 4.4 + § 4.11. Subsumes the MVP's separate action sheet — one
 * surface for snooze (reschedule) + cancel + convert-to-task.
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Reminder message (read-only)                          │
 *   │ Current fire-at: in 2h (Mar 14, 11:30 AM)             │
 *   │ Reschedule:                                           │
 *   │ [+15m] [+1h] [+3h] [tomorrow 9am] [+1w]              │
 *   │ [ Close ]                          [ Reschedule ]    │ neutral
 *   ├──────────────────────────────────────────────────────┤
 *   │ [ Cancel reminder ]              [ Convert to task ] │ destructive
 *   └──────────────────────────────────────────────────────┘
 *
 * The substrate has NO PATCH for the message body, so the title is
 * read-only at P5.5 (a future substrate sprint may add a message
 * PATCH). The five reschedule presets share the create modal's
 * shape; NONE selected on open (so Reschedule is disabled until the
 * user picks one).
 *
 * Cancel + Convert-to-task share the destructive row visual register
 * per § 4.11 — both are one-way actions with no undo (cancel
 * permanently removes the row from pending; convert kills the
 * original reminder and creates a task + linked reminder, which the
 * user cannot reverse without manually deleting the task and
 * recreating a fresh reminder).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  buildReminderPresets,
  type ReminderPreset,
} from '../lib/reminder-presets';
import { formatFireAt, type ReminderItem } from '../lib/reminders-client';
import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import { ALPHA_TINTS } from '../lib/task-row-formatters';

export interface ReminderEditModalProps {
  entry: ReminderItem | null;
  submitting: boolean;
  onCancel: () => void;
  onReschedule: (reminder_id: string, new_fire_at_seconds: number) => void;
  onCancelReminder: (reminder_id: string) => void;
  onConvertToTask: (reminder_id: string) => void;
}

export function ReminderEditModal({
  entry,
  submitting,
  onCancel,
  onReschedule,
  onCancelReminder,
  onConvertToTask,
}: ReminderEditModalProps) {
  const isOpen = entry !== null;
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  // Recompute presets on each open so `tomorrow 9am` is fresh. Use a
  // boolean instead of `entry` as the dep so opening a different row
  // does NOT re-stamp the preset offsets (the user expects the chips
  // to feel anchored to the moment the modal opened, not the entry).
  const presets = useMemo<ReminderPreset[]>(() => {
    if (!isOpen) return [];
    return buildReminderPresets(new Date());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedPresetId(null);
    }
  }, [isOpen]);

  if (entry === null) return null;

  const fireLabel = formatFireAt(entry.fire_at, Date.now());
  const absoluteLabel = formatAbsolute(entry.fire_at);
  const selectedPreset = presets.find((p) => p.id === selectedPresetId) ?? null;
  const canReschedule = selectedPreset !== null && !submitting;

  const reschedule = () => {
    if (!canReschedule || selectedPreset === null) return;
    const new_fire_at = Math.round((Date.now() + selectedPreset.offset_ms) / 1000);
    onReschedule(entry.id, new_fire_at);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          style={styles.scroll}
        >
          <View style={styles.panel} testID="reminders-edit-modal">
            <Text style={styles.title} accessibilityRole="header">
              Edit reminder
            </Text>
            <Text style={styles.message} numberOfLines={4} testID="reminders-edit-message">
              {entry.message}
            </Text>
            <Text style={styles.meta} testID="reminders-edit-current-fire-at">
              Fires {fireLabel}
              {absoluteLabel.length > 0 ? ` · ${absoluteLabel}` : ''}
            </Text>

            <Text style={styles.fieldLabel}>Reschedule</Text>
            <View style={styles.presetRow}>
              {presets.map((preset) => {
                const isSelected = preset.id === selectedPresetId;
                return (
                  <Pressable
                    key={preset.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Reschedule ${preset.label}`}
                    accessibilityState={{ selected: isSelected }}
                    testID={`reminders-edit-preset-${preset.id}`}
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

            <View style={styles.neutralRow} testID="reminders-edit-modal-neutral-row">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onCancel}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnNeutral,
                  pressed && styles.btnPressed,
                ]}
                testID="reminders-edit-close"
              >
                <Text style={[styles.btnText, styles.btnTextNeutral]}>Close</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Reschedule reminder"
                accessibilityState={{ disabled: !canReschedule }}
                disabled={!canReschedule}
                onPress={reschedule}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnPrimary,
                  !canReschedule && styles.btnDisabled,
                  canReschedule && pressed && styles.btnPressed,
                ]}
                testID="reminders-edit-reschedule"
              >
                <Text style={[styles.btnText, styles.btnTextPrimary]}>Reschedule</Text>
              </Pressable>
            </View>

            <View style={styles.divider} />

            <View
              style={styles.destructiveRow}
              testID="reminders-edit-modal-destructive-row"
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel reminder"
                accessibilityHint="Destructive action — cancels the reminder with no undo"
                onPress={() => onCancelReminder(entry.id)}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnDestructive,
                  pressed && styles.btnPressed,
                ]}
                testID="reminders-edit-cancel-reminder"
              >
                <Text style={[styles.btnText, styles.btnTextDestructive]}>
                  Cancel reminder
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Convert to task"
                accessibilityHint="Destructive action — cancels this reminder and creates a linked task with no undo"
                onPress={() => onConvertToTask(entry.id)}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnDestructive,
                  pressed && styles.btnPressed,
                ]}
                testID="reminders-edit-convert-to-task"
              >
                <Text style={[styles.btnText, styles.btnTextDestructive]}>
                  Convert to task
                </Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function formatAbsolute(fire_at_seconds: number): string {
  const ms = fire_at_seconds * 1000;
  if (!Number.isFinite(ms)) return '';
  try {
    const d = new Date(ms);
    const datePart = d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    const timePart = d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${datePart}, ${timePart}`;
  } catch {
    return '';
  }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
  },
  scroll: { maxHeight: '100%', width: '100%' },
  scrollContent: { alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
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
  message: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '500',
  },
  meta: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  fieldLabel: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
    marginTop: SPACING.xs,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
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
    backgroundColor: THEME.surface_raised,
    borderColor: THEME.hairline,
  },
  presetChipActive: {
    backgroundColor: THEME.text_primary,
    borderColor: THEME.text_primary,
  },
  presetChipPressed: { opacity: 0.78 },
  presetChipText: {
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
  },
  presetChipTextInactive: { color: THEME.text_secondary },
  presetChipTextActive: { color: THEME.background },
  neutralRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  divider: {
    height: 1,
    backgroundColor: THEME.hairline,
    marginVertical: SPACING.sm,
  },
  destructiveRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    justifyContent: 'flex-start',
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
  btnNeutral: { backgroundColor: THEME.surface_raised },
  btnPrimary: { backgroundColor: THEME.text_primary },
  btnDestructive: {
    backgroundColor: THEME.danger + ALPHA_TINTS.light,
    borderWidth: 1,
    borderColor: THEME.danger + ALPHA_TINTS.border,
  },
  btnText: {
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    fontWeight: '600',
  },
  btnTextNeutral: { color: THEME.text_secondary },
  btnTextPrimary: { color: THEME.background },
  btnTextDestructive: { color: THEME.danger },
});
