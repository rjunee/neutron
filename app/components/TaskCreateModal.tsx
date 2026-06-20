/**
 * @neutronai/app — task create modal (P5.4).
 *
 * Centered Modal-overlay form with four inputs (title required;
 * description / due-date / priority optional). Submit calls
 * `onSubmit(input)`; the parent route hooks this to
 * `TaskStateProvider.create()` which closes the modal on success and
 * leaves it open on failure (server-authoritative).
 *
 * Per brief § 4.3:
 *   - Modal trigger is the header "+ New task" button (not inline).
 *   - In-flight ActivityIndicator on the Create button when
 *     `submitting === true`.
 *   - Cancel + Create buttons in the standard neutral-row layout.
 *   - Title trim > 0 chars enables Create; everything else is
 *     gateway-validated (Date.parse on due_date, integer 0..3 on
 *     priority — readDueDate in the surface is canonical).
 *
 * Theme-tokened across the board per § 4.8; modal backdrop alpha
 * stays inline per the brief.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import type { CreateTaskInput } from '../lib/tasks-client';
import { normalizeDueDate } from '../lib/task-formatters';

// Re-export so sibling components (TaskEditModal) can keep their
// import surface stable while the helper lives in lib/.
export { normalizeDueDate } from '../lib/task-formatters';

export interface TaskCreateModalProps {
  open: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (input: CreateTaskInput) => void;
}

export function TaskCreateModal({ open, submitting, onCancel, onSubmit }: TaskCreateModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState<string>('');

  useEffect(() => {
    if (!open) {
      setTitle('');
      setDescription('');
      setDueDate('');
      setPriority('');
    }
  }, [open]);

  if (!open) return null;

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    const input: CreateTaskInput = { title: trimmedTitle };
    const trimmedDescription = description.trim();
    if (trimmedDescription.length > 0) input.description = trimmedDescription;
    const trimmedDue = dueDate.trim();
    if (trimmedDue.length > 0) input.due_date = normalizeDueDate(trimmedDue);
    const trimmedPriority = priority.trim();
    if (trimmedPriority.length > 0) {
      const n = Number.parseInt(trimmedPriority, 10);
      if (Number.isInteger(n) && n >= 0 && n <= 3) input.priority = n;
    }
    onSubmit(input);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.panel} testID="tasks-create-modal">
          <Text style={styles.title} accessibilityRole="header">
            New task
          </Text>
          <Text style={styles.subtitle}>Title is required. Rest are optional.</Text>
          <TextInput
            accessibilityLabel="Task title"
            placeholder="What needs doing?"
            placeholderTextColor={THEME.text_muted}
            value={title}
            onChangeText={setTitle}
            style={styles.input}
            autoFocus
            maxLength={256}
            testID="tasks-create-title"
          />
          <TextInput
            accessibilityLabel="Description"
            placeholder="Description (optional)"
            placeholderTextColor={THEME.text_muted}
            value={description}
            onChangeText={setDescription}
            style={[styles.input, styles.inputMultiline]}
            multiline
            maxLength={4096}
            testID="tasks-create-description"
          />
          <TextInput
            accessibilityLabel="Due date"
            placeholder="Due date (YYYY-MM-DD, optional)"
            placeholderTextColor={THEME.text_muted}
            value={dueDate}
            onChangeText={setDueDate}
            style={styles.input}
            maxLength={32}
            autoCapitalize="none"
            autoCorrect={false}
            testID="tasks-create-due-date"
          />
          <TextInput
            accessibilityLabel="Priority"
            placeholder="Priority 0-3 (optional)"
            placeholderTextColor={THEME.text_muted}
            value={priority}
            onChangeText={setPriority}
            style={styles.input}
            maxLength={1}
            keyboardType="number-pad"
            testID="tasks-create-priority"
          />
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel create"
              onPress={onCancel}
              style={({ pressed }) => [styles.btn, styles.btnNeutral, pressed && styles.btnPressed]}
              testID="tasks-create-cancel"
            >
              <Text style={[styles.btnText, styles.btnTextNeutral]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create task"
              disabled={!canSubmit}
              onPress={submit}
              style={({ pressed }) => [
                styles.btn,
                styles.btnPrimary,
                !canSubmit && styles.btnDisabled,
                canSubmit && pressed && styles.btnPressed,
              ]}
              testID="tasks-create-submit"
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
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
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
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
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
