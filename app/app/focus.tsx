/**
 * @neutronai/app — global Focus view (P5.6).
 *
 * Per docs/engineering-plan.md § B.P5:
 *
 *   "Global 'Focus' view (cross-project). Top-level tab outside any
 *    project. Aggregates: today's most-important tasks across all
 *    projects (driven by the daily-nudge engine from P6), reminders
 *    firing today, the current-focus pick. Tap any item → jumps into
 *    the originating project at the relevant context."
 *
 * P5.6 ships the production refactor:
 *
 *   - Thin composer (≤ 140 LOC) wraps `<FocusStateProvider>` +
 *     `<FocusHeader>` + `<FocusList>` (which composes
 *     `<FocusBucketSection>` + `<FocusRow>`).
 *   - Tap-to-jump: tasks → `/projects/<id>/tasks`; reminders →
 *     `/projects/<id>/reminders`; owner-level → `/projects`.
 *   - State + load lifecycle + on-tab-focus auto-refresh live in
 *     `<FocusStateProvider>`. Bucket transformation lives in the pure
 *     `focus-state-reducer.ts`. Pure formatters live in
 *     `focus-row-formatters.ts`. Every visual sources from
 *     `lib/theme.ts` tokens.
 *
 * The LLM-driven daily nudge engine + "one most important pick"
 * surface is P6.1 follow-up; this route ships the projection over the
 * canonical TaskStore + ReminderStore today.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { FocusHeader } from '../components/FocusHeader';
import { FocusList } from '../components/FocusList';
import { signOut } from '../lib/auth';
import type { CurrentFocusPick, FocusItem } from '../lib/focus-client';
import {
  FocusStateProvider,
  useFocusState,
} from '../lib/focus-state';
import { useAuthSession } from '../lib/session';
import { SPACING, THEME } from '../lib/theme';

export default function FocusScreen() {
  const { user } = useAuthSession();
  const router = useRouter();

  // Auth gate — push to /login while we wait for the session resolver.
  // The `<FocusStateProvider>` doesn't fetch when user === null, so
  // the redirect is the only side effect we own here.
  useEffect(() => {
    if (user === null) router.replace('/login');
  }, [user, router]);

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return (
    <FocusStateProvider>
      <FocusScreenBody />
    </FocusStateProvider>
  );
}

function FocusScreenBody() {
  const router = useRouter();
  const { clear } = useAuthSession();
  const {
    sections,
    loading,
    refreshing,
    error,
    currentFocus,
    refresh,
    dismissError,
  } = useFocusState();

  const handleSignOut = useCallback(async () => {
    await signOut();
    clear();
    router.replace('/login');
  }, [clear, router]);

  const handleProjectsLink = useCallback(() => {
    router.push('/projects');
  }, [router]);

  const handleItemPress = useCallback(
    (item: FocusItem) => {
      // Owner-level items have no originating per-project tab; route
      // them to the project list so the user can drill in manually.
      if (item.project_id.length === 0) {
        router.push('/projects');
        return;
      }
      const tab = item.kind === 'reminder' ? 'reminders' : 'tasks';
      router.push(`/projects/${encodeURIComponent(item.project_id)}/${tab}`);
    },
    [router],
  );

  const handleHeroPress = useCallback(
    (pick: CurrentFocusPick) => {
      // Same routing semantics as a FocusRow: owner-level → project
      // list, per-project → the project's tasks tab.
      const pid = pick.task.project_id;
      if (pid.length === 0) {
        router.push('/projects');
        return;
      }
      router.push(`/projects/${encodeURIComponent(pid)}/tasks`);
    },
    [router],
  );

  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  return (
    <View style={styles.container}>
      <FocusHeader
        refreshing={refreshing}
        onRefresh={handleRefresh}
        onProjectsLink={handleProjectsLink}
        onSignOut={handleSignOut}
      />
      <FocusList
        sections={sections}
        loading={loading}
        refreshing={refreshing}
        error={error}
        currentFocus={currentFocus}
        onRefresh={handleRefresh}
        onRetry={handleRefresh}
        onItemPress={handleItemPress}
        onCurrentFocusPress={handleHeroPress}
        onDismissError={dismissError}
        onProjectsLink={handleProjectsLink}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
    paddingTop: SPACING.xxl + SPACING.lg,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
