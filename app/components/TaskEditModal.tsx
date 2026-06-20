/**
 * @neutronai/app — task edit modal (P5.4).
 *
 * Centered Modal-overlay edit form. Two-row action layout per
 * brief § 4.11:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ [ Close ]                                  [ Save ]   │  neutral
 *   ├──────────────────────────────────────────────────────┤
 *   │ [ Mark done ] [ Cancel task ]              [ Delete ] │  destructive
 *   └──────────────────────────────────────────────────────┘
 *
 * Mark done is hidden when task.status === 'done'. Cancel task is
 * hidden when task.status === 'cancelled'. Delete is always
 * visible.
 *
 * Save submits a patch containing ONLY changed fields — empty patch
 * (no changes) treats Save as Cancel. The provider closes the modal
 * on success.
 *
 * Per § 4.11 the destructive row sits visually distinct from the
 * neutral row (own background panel, separator) so a Delete tap
 * never feels like a sibling of Save. Mark done + Cancel task ride
 * the same destructive row because their hesitation profile is
 * closer to Delete than Save (one tap, no undo at P5.4).
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import type { Task, UpdateTaskInput } from '../lib/tasks-client';
import { ALPHA_TINTS } from './TaskRow';
import { normalizeDueDate } from './TaskCreateModal';

export interface TaskEditModalProps {
  task: Task | null;
  submitting: boolean;
  onCancel: () => void;
  onSave: (task_id: string, patch: UpdateTaskInput) => void;
  onComplete: (task_id: string) => void;
  onCancelTask: (task_id: string) => void;
  onDelete: (task_id: string) => void;
}

export function TaskEditModal({
  task,
  submitting,
  onCancel,
  onSave,
  onComplete,
  onCancelTask,
  onDelete,
}: TaskEditModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState<string>('');

  useEffect(() => {
    if (task !== null) {
      setTitle(task.title);
      setDescription(task.description ?? '');
      setDueDate(task.due_date ?? '');
      setPriority(task.priority === null || task.priority === undefined ? '' : String(task.priority));
    }
  }, [task]);

  if (task === null) return null;

  const trimmedTitle = title.trim();
  const canSave = trimmedTitle.length > 0 && !submitting;

  const save = () => {
    if (!canSave) return;
    const patch: UpdateTaskInput = {};
    if (trimmedTitle !== task.title) patch.title = trimmedTitle;
    const newDescription = description.trim().length > 0 ? description.trim() : null;
    if (newDescription !== task.description) patch.description = newDescription;
    const newDueRaw = dueDate.trim();
    const newDue = newDueRaw.length > 0 ? normalizeDueDate(newDueRaw) : null;
    if (newDue !== task.due_date) patch.due_date = newDue;
    if (priority.trim().length === 0) {
      if (task.priority !== null && task.priority !== undefined) patch.priority = null;
    } else {
      const n = Number.parseInt(priority.trim(), 10);
      if (Number.isInteger(n) && n >= 0 && n <= 3 && n !== task.priority) patch.priority = n;
    }
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    onSave(task.id, patch);
  };

  const showMarkDone = task.status !== 'done';
  const showCancel = task.status !== 'cancelled';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          style={styles.scroll}
        >
          <View style={styles.panel} testID="tasks-edit-modal">
            <Text style={styles.title} accessibilityRole="header">
              Edit task
            </Text>
            <Text
              style={styles.subtitle}
              testID="tasks-edit-status-label"
              accessibilityHint={`Status: ${task.status}`}
            >
              {task.status.toUpperCase()}
            </Text>
            <TextInput
              accessibilityLabel="Task title"
              value={title}
              onChangeText={setTitle}
              style={styles.input}
              maxLength={256}
              testID="tasks-edit-title"
            />
            <TextInput
              accessibilityLabel="Description"
              placeholder="Description"
              placeholderTextColor={THEME.text_muted}
              value={description}
              onChangeText={setDescription}
              style={[styles.input, styles.inputMultiline]}
              multiline
              maxLength={4096}
              testID="tasks-edit-description"
            />
            <TextInput
              accessibilityLabel="Due date"
              placeholder="Due date (YYYY-MM-DD)"
              placeholderTextColor={THEME.text_muted}
              value={dueDate}
              onChangeText={setDueDate}
              style={styles.input}
              maxLength={32}
              autoCapitalize="none"
              autoCorrect={false}
              testID="tasks-edit-due-date"
            />
            <TextInput
              accessibilityLabel="Priority"
              placeholder="Priority 0-3"
              placeholderTextColor={THEME.text_muted}
              value={priority}
              onChangeText={setPriority}
              style={styles.input}
              maxLength={1}
              keyboardType="number-pad"
              testID="tasks-edit-priority"
            />

            <View style={styles.neutralRow} testID="tasks-edit-modal-neutral-row">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onCancel}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnNeutral,
                  pressed && styles.btnPressed,
                ]}
                testID="tasks-edit-cancel"
              >
                <Text style={[styles.btnText, styles.btnTextNeutral]}>Close</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save changes"
                disabled={!canSave}
                onPress={save}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnPrimary,
                  !canSave && styles.btnDisabled,
                  canSave && pressed && styles.btnPressed,
                ]}
                testID="tasks-edit-save"
              >
                <Text style={[styles.btnText, styles.btnTextPrimary]}>Save</Text>
              </Pressable>
            </View>

            <View style={styles.divider} />

            <View style={styles.destructiveRow} testID="tasks-edit-modal-destructive-row">
              {showMarkDone ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Mark done"
                  accessibilityHint="Marks the task complete"
                  onPress={() => onComplete(task.id)}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnNeutral,
                    pressed && styles.btnPressed,
                  ]}
                  testID="tasks-edit-complete"
                >
                  <Text style={[styles.btnText, styles.btnTextNeutral]}>Mark done</Text>
                </Pressable>
              ) : null}
              {showCancel ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel task"
                  accessibilityHint="Destructive action — cancels the task with no undo"
                  onPress={() => onCancelTask(task.id)}
                  style={({ pressed }) => [
                    styles.btn,
                    styles.btnNeutral,
                    pressed && styles.btnPressed,
                  ]}
                  testID="tasks-edit-cancel-task"
                >
                  <Text style={[styles.btnText, styles.btnTextNeutral]}>Cancel task</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete task"
                accessibilityHint="Destructive action — permanent delete with no undo"
                onPress={() => onDelete(task.id)}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnDestructive,
                  pressed && styles.btnPressed,
                ]}
                testID="tasks-edit-delete"
              >
                <Text style={[styles.btnText, styles.btnTextDestructive]}>Delete</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
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
  subtitle: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    letterSpacing: 0.8,
    fontWeight: '700',
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
    borderColor: THEME.danger + '5a',
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
