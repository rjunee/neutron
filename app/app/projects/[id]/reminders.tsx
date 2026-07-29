/**
 * @neutronai/app — production project-scoped reminders tab (P5.5).
 *
 * Thin route-composition layer. The previous 615-LOC exploratory MVP
 * was split per docs/plans/P5.5-reminders-tab-sprint-brief.md into
 * independently testable modules:
 *
 *   - `<ReminderStateProvider>` — fetch + mutation lifecycle, filter axis
 *   - `<ReminderHeader>`        — Reminders title + subtitle + `+ New reminder`
 *   - `<ReminderFilterChips>`   — Today / Upcoming / All filter chips
 *   - `<ReminderList>`          — error banner + loading + empty + per-filter bucketing
 *   - `<ReminderRow>`           — clock-glyph + title + meta-row chips
 *   - `<ReminderCreateModal>`   — centered create form
 *   - `<ReminderEditModal>`     — centered edit form (subsumes MVP action sheet)
 *
 * Per the brief's § 5.1 layout this route owns only:
 *   - Reading `project_id` from the route params.
 *   - Local UI-only state (which reminder the edit modal is open on +
 *     the create-modal open flag) — NOT data state.
 *   - Wiring `<ReminderStateProvider>` actions to the children's
 *     handlers.
 *
 * Server-authoritative across every mutation — see provider for the
 * `mutating` lifecycle. Filter chips bucket the canonical server list
 * client-side (no extra fetches).
 *
 * Traditional reminder-app aesthetic per docs/engineering-plan.md
 * § B.P5 (locked answer #2): non-interactive clock-glyph affordance +
 * title + meta-row chips (fire-at bucket-tinted + recurrence +
 * source); three-chip client-side filter; modal create/edit with
 * destructive-row separation; no kanban / Gantt / timeline.
 */

import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ReminderCreateModal } from '../../../components/ReminderCreateModal';
import { ReminderEditModal } from '../../../components/ReminderEditModal';
import { ReminderFilterChips } from '../../../components/ReminderFilterChips';
import { ReminderHeader } from '../../../components/ReminderHeader';
import { ReminderList } from '../../../components/ReminderList';
import {
  ReminderStateProvider,
  useReminderState,
} from '../../../lib/reminder-state';
import type { ReminderItem } from '../../../lib/reminders-client';
import { useAuthSession } from '../../../lib/session';
import { SPACING, THEME } from '../../../lib/theme';

export default function RemindersTab() {
  // ISSUE #38 — read both `id` (project segment) and `reminder_id`
  // (deep-link query param) here. The reminder push payload's
  // `resolvePushRoute` emits `/projects/<id>/reminders?reminder_id=<rid>`
  // (`app/lib/push-deep-link-dispatch.ts`); Expo Router decodes the
  // query string into `useLocalSearchParams()`. `RemindersTabBody`
  // forwards the value to `<ReminderList>` to highlight + scroll the
  // matching row. Mirrors the Tasks pattern from PR #276 ISSUE #18.
  const { id, reminder_id } = useLocalSearchParams<{ id: string; reminder_id?: string }>();
  const project_id = typeof id === 'string' ? id : '';
  const highlightReminderId =
    typeof reminder_id === 'string' && reminder_id.length > 0 ? reminder_id : null;
  const { user } = useAuthSession();

  if (user === null || project_id.length === 0) {
    return (
      <View
        style={[styles.container, styles.centered]}
        testID="reminders-bootstrapping"
      >
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return (
    <ReminderStateProvider
      projectId={project_id}
      highlightReminderId={highlightReminderId}
    >
      <RemindersTabBody highlightReminderId={highlightReminderId} />
    </ReminderStateProvider>
  );
}

function RemindersTabBody({ highlightReminderId }: { highlightReminderId: string | null }) {
  const {
    reminders,
    loading,
    mutating,
    error,
    filter,
    setFilter,
    create,
    snooze,
    cancel,
    convertToTask,
    dismissError,
  } = useReminderState();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ReminderItem | null>(null);

  const openCreate = useCallback(() => setCreateOpen(true), []);
  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const openEdit = useCallback((entry: ReminderItem) => setEditTarget(entry), []);
  const closeEdit = useCallback(() => setEditTarget(null), []);

  const handleCreate = useCallback(
    async (input: { message: string; fire_at_seconds: number }) => {
      const ok = await create(input);
      if (ok) setCreateOpen(false);
    },
    [create],
  );

  const handleReschedule = useCallback(
    async (reminder_id: string, new_fire_at: number) => {
      const ok = await snooze(reminder_id, new_fire_at);
      if (ok) setEditTarget(null);
    },
    [snooze],
  );

  const handleCancelReminder = useCallback(
    async (reminder_id: string) => {
      const ok = await cancel(reminder_id);
      if (ok) setEditTarget(null);
    },
    [cancel],
  );

  const handleConvertToTask = useCallback(
    async (reminder_id: string) => {
      const result = await convertToTask(reminder_id);
      if (result.ok) setEditTarget(null);
    },
    [convertToTask],
  );

  return (
    <View style={styles.container}>
      <ReminderHeader onCreatePress={openCreate} />
      <ReminderFilterChips active={filter} onSelect={setFilter} />
      <ReminderList
        reminders={reminders}
        loading={loading}
        mutating={mutating}
        error={error}
        filter={filter}
        onPressRow={openEdit}
        onDismissError={dismissError}
        highlightReminderId={highlightReminderId}
      />
      <ReminderCreateModal
        open={createOpen}
        submitting={mutating}
        onCancel={closeCreate}
        onSubmit={handleCreate}
      />
      <ReminderEditModal
        entry={editTarget}
        submitting={mutating}
        onCancel={closeEdit}
        onReschedule={handleReschedule}
        onCancelReminder={handleCancelReminder}
        onConvertToTask={handleConvertToTask}
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
