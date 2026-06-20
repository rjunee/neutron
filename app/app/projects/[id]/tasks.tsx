/**
 * @neutronai/app — production project-scoped tasks tab (P5.4).
 *
 * Thin route-composition layer. The previous 797-LOC monolith
 * was split per the brief into independently testable modules:
 *
 *   - `<TaskStateProvider>`   — fetch + mutation lifecycle, filter axis
 *   - `<TaskHeader>`          — Tasks title + subtitle + `+ New task`
 *   - `<TaskFilterChips>`     — Open / Done / All filter chips
 *   - `<TaskList>`            — error banner + loading + empty + rows
 *   - `<TaskRow>`             — checkbox + title + meta-row chips
 *   - `<TaskCreateModal>`     — centered create form
 *   - `<TaskEditModal>`       — centered edit form + destructive row
 *
 * Per the brief's § 5.1 layout the route file owns only:
 *   - Reading `project_id` from the route params.
 *   - Local UI-only state (which task the edit modal is open on +
 *     the create-modal open flag) — NOT data state.
 *   - Wiring `<TaskStateProvider>` actions to the children's
 *     handlers.
 *
 * Server-authoritative across every mutation — see provider for the
 * `mutating` lifecycle. The default sort is `?order=focus_score`
 * (P6 opt-in) so the P6 focus_score column becomes user-visible
 * without a UI gesture (brief § 4.2 — Atlas locked this call).
 *
 * Traditional task-management aesthetic per docs/engineering-plan.md
 * § B.P5 (locked answer #2): tap-to-complete checkbox + title +
 * meta-row chips (priority + due + focus_score); three-chip status
 * filter; modal create/edit; no kanban / Gantt / timeline.
 */

import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { TaskCreateModal } from '../../../components/TaskCreateModal';
import { TaskEditModal } from '../../../components/TaskEditModal';
import { TaskFilterChips } from '../../../components/TaskFilterChips';
import { TaskHeader } from '../../../components/TaskHeader';
import { TaskList } from '../../../components/TaskList';
import { useAuthSession } from '../../../lib/session';
import {
  TaskStateProvider,
  useTaskState,
} from '../../../lib/task-state';
import type { Task, UpdateTaskInput } from '../../../lib/tasks-client';
import { SPACING, THEME } from '../../../lib/theme';

export default function TasksTab() {
  // Argus r2 BLOCKER B2 (PR #276) — read both `id` (project segment)
  // and `task_id` (deep-link query param) here. The chat
  // `task:open:<id>` postback emits `/projects/<id>/tasks?task_id=<task_id>`;
  // `<ChatDeepLinkNavigator>` pushes that route + Expo Router decodes
  // the query string into `useLocalSearchParams()`. `TasksTabBody`
  // consumes the value to highlight + scroll the matching row.
  const { id, task_id } = useLocalSearchParams<{ id: string; task_id?: string }>();
  const project_id = typeof id === 'string' ? id : '';
  const highlightTaskId = typeof task_id === 'string' && task_id.length > 0 ? task_id : null;
  const { user } = useAuthSession();

  if (user === null || project_id.length === 0) {
    return (
      <View style={[styles.container, styles.centered]} testID="tasks-bootstrapping">
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return (
    <TaskStateProvider projectId={project_id}>
      <TasksTabBody highlightTaskId={highlightTaskId} />
    </TaskStateProvider>
  );
}

function TasksTabBody({ highlightTaskId }: { highlightTaskId: string | null }) {
  const {
    tasks,
    loading,
    mutating,
    error,
    filter,
    setFilter,
    create,
    update,
    complete,
    cancel,
    delete: deleteTask,
    toggleDone,
    dismissError,
  } = useTaskState();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Task | null>(null);

  const openCreate = useCallback(() => setCreateOpen(true), []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const openEdit = useCallback((task: Task) => setEditTarget(task), []);
  const closeEdit = useCallback(() => setEditTarget(null), []);

  const handleCreate = useCallback(
    async (input: Parameters<typeof create>[0]) => {
      const ok = await create(input);
      if (ok) setCreateOpen(false);
    },
    [create],
  );

  const handleSave = useCallback(
    async (task_id: string, patch: UpdateTaskInput) => {
      const ok = await update(task_id, patch);
      if (ok) setEditTarget(null);
    },
    [update],
  );

  const handleComplete = useCallback(
    async (task_id: string) => {
      const ok = await complete(task_id);
      if (ok) setEditTarget(null);
    },
    [complete],
  );

  const handleCancelTask = useCallback(
    async (task_id: string) => {
      const ok = await cancel(task_id);
      if (ok) setEditTarget(null);
    },
    [cancel],
  );

  const handleDelete = useCallback(
    async (task_id: string) => {
      const ok = await deleteTask(task_id);
      if (ok) setEditTarget(null);
    },
    [deleteTask],
  );

  return (
    <View style={styles.container}>
      <TaskHeader onCreatePress={openCreate} />
      <TaskFilterChips active={filter} onSelect={setFilter} />
      <TaskList
        tasks={tasks}
        loading={loading}
        mutating={mutating}
        error={error}
        onPressRow={openEdit}
        onToggleDone={toggleDone}
        onDismissError={dismissError}
        highlightTaskId={highlightTaskId}
      />
      <TaskCreateModal
        open={createOpen}
        submitting={mutating}
        onCancel={closeCreate}
        onSubmit={handleCreate}
      />
      <TaskEditModal
        task={editTarget}
        submitting={mutating}
        onCancel={closeEdit}
        onSave={handleSave}
        onComplete={handleComplete}
        onCancelTask={handleCancelTask}
        onDelete={handleDelete}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
    padding: SPACING.lg,
  },
  centered: { alignItems: 'center', justifyContent: 'center' },
});
