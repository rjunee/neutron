/**
 * @neutronai/app — production project-scoped Apps launcher (P5.3).
 *
 * Thin route-composition layer. The previous 817-LOC monolith was
 * split per the brief into independently testable modules:
 *
 *   - `<LauncherStateProvider>`        — gateway fetch + mutation
 *                                        lifecycle + build-me submit
 *   - `<LauncherGrid>`                 — adaptive iPhone-style grid
 *                                        (4/5/6/7 columns by viewport)
 *   - `<LauncherItem>` / `<LauncherBuildMeTile>` — tile primitives
 *   - `<LauncherItemMenu>`             — long-press action sheet
 *   - `<LauncherRenameModal>`          — rename prompt
 *   - `<LauncherBuildMeModal>`         — build-me prompt
 *
 * Per the brief's § 5.1 layout the route file owns only:
 *   - Reading `project_id` from the route params.
 *   - Local UI-only state (which entry the action sheet is open on,
 *     the rename / build-me drafts) — NOT data state.
 *   - Wiring `<LauncherStateProvider>` actions to the children's
 *     handlers.
 *
 * Server-authoritative for every mutation per § 4.5 — no optimistic
 * reorder flip; the state-provider replaces state on `MUTATE_OK`.
 * The "Build me…" path goes through the typed
 * `LauncherClient.sendBuildMePrompt` so the production-composer
 * reachability guard test
 * (`gateway/__tests__/launcher-production-composer.test.ts`) covers
 * it end-to-end.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { LauncherBuildMeModal } from '../../../components/LauncherBuildMeModal';
import { LauncherGrid } from '../../../components/LauncherGrid';
import {
  LauncherItemMenu,
  type LauncherItemMenuTarget,
} from '../../../components/LauncherItemMenu';
import { LauncherRenameModal } from '../../../components/LauncherRenameModal';
import type {
  LauncherEntry,
  LauncherEntryLongPressEntry,
} from '../../../lib/launcher-client';
import { resolveLongPressDispatch } from '../../../lib/launcher-long-press-dispatch';
import {
  LauncherStateProvider,
  useLauncherState,
} from '../../../lib/launcher-state';
import { useAuthSession } from '../../../lib/session';
import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../../../lib/theme';

export default function LauncherTab() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project_id = typeof id === 'string' ? id : '';
  const { user } = useAuthSession();

  if (user === null || project_id.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return (
    <LauncherStateProvider projectId={project_id}>
      <LauncherTabBody projectId={project_id} />
    </LauncherStateProvider>
  );
}

interface LauncherTabBodyProps {
  projectId: string;
}

function LauncherTabBody({ projectId }: LauncherTabBodyProps) {
  const router = useRouter();
  const {
    entries,
    loading,
    error,
    building_me,
    reorder,
    rename,
    uninstall,
    sendBuildMe,
    dismissError,
  } = useLauncherState();

  const [menu, setMenu] = useState<LauncherItemMenuTarget | null>(null);
  const [renamingFor, setRenamingFor] = useState<LauncherEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [buildMeOpen, setBuildMeOpen] = useState(false);
  const [buildMeDraft, setBuildMeDraft] = useState('');

  const closeMenu = useCallback(() => setMenu(null), []);

  // Tap-to-launch — when the manifest declares `app_tab_path` (P5.3 +
  // ISSUE #17), use it verbatim (substituting `<project_id>`). Older
  // Cores without a route hint fall back to slug-derived inference:
  // `_core` suffixes are stripped because Tier 1 Cores like
  // `@neutronai/tasks-core` declare slug `tasks_core` while their
  // project tab lives at `/projects/<id>/tasks`. Long-press remains
  // the only action-sheet trigger.
  const launchEntry = useCallback(
    (entry: LauncherEntry) => {
      if (
        entry.primary_action === 'open_app_tab' &&
        typeof entry.app_tab_path === 'string' &&
        entry.app_tab_path.length > 0
      ) {
        const resolved = entry.app_tab_path.replace('<project_id>', projectId);
        router.push(resolved as Parameters<typeof router.push>[0]);
        return;
      }
      const route = entry.slug.replace(/_core$/, '');
      router.push(`/projects/${projectId}/${route}`);
    },
    [router, projectId],
  );

  // ISSUE #17 — dispatch one long-press menu entry per its `action`
  // verb. The Cores' manifests declare these at
  // `cores/free/<slug>/src/ui/launcher-icon.ts`. Pure router logic
  // lives in `resolveLongPressDispatch` so the dispatch rules are
  // unit-testable without a renderer. Routes:
  //   - 'open_app_tab'      → router.push(app_tab_path<projectId>)
  //   - 'chat_send_prefix'  → navigate to chat with ?prefill=<prefix>
  //   - 'chat_send'         → navigate to chat with ?autosend=<text>
  // The chat route reads the search params on mount and either
  // prefills the composer (prefix) or fires `send()` once (autosend).
  const dispatchLongPressEntry = useCallback(
    (parent: LauncherEntry, item: LauncherEntryLongPressEntry) => {
      const target = resolveLongPressDispatch(parent, item, projectId);
      if (target === null) return;
      router.push(target.path as Parameters<typeof router.push>[0]);
    },
    [router, projectId],
  );

  const onLongPress = useCallback(
    (entry: LauncherEntry, index: number) => setMenu({ entry, index }),
    [],
  );

  const onReorderDrop = useCallback(
    (slug: string, new_index: number) => {
      void reorder(slug, new_index);
    },
    [reorder],
  );

  const onBuildMePress = useCallback(() => setBuildMeOpen(true), []);

  const handleRenameSubmit = useCallback(async () => {
    if (renamingFor === null) return;
    const trimmed = renameDraft.trim();
    if (trimmed.length === 0) {
      setRenamingFor(null);
      setRenameDraft('');
      return;
    }
    await rename(renamingFor.slug, trimmed);
    setRenamingFor(null);
    setRenameDraft('');
  }, [renamingFor, renameDraft, rename]);

  const handleBuildMeSubmit = useCallback(async () => {
    const drafted = buildMeDraft.trim();
    if (drafted.length === 0) {
      setBuildMeOpen(false);
      return;
    }
    const ok = await sendBuildMe(drafted);
    if (ok) {
      setBuildMeDraft('');
      setBuildMeOpen(false);
      router.replace(`/projects/${projectId}/chat`);
    }
  }, [buildMeDraft, sendBuildMe, router, projectId]);

  return (
    <View style={styles.container}>
      <View style={styles.intro}>
        <Text style={styles.title}>Apps</Text>
        <Text style={styles.subtitle}>
          {Platform.OS === 'web'
            ? 'Tap to open. Drag to reorder. Long-press a tile for Rename / Delete. Tap “Build me…” to scaffold a new App.'
            : 'Tap to open. Long-press a tile for Rename / Delete / Move. Tap “Build me…” to scaffold a new App.'}
        </Text>
      </View>

      {error !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
          onPress={dismissError}
          style={styles.errorBanner}
          testID="launcher-error-banner"
        >
          <Text style={styles.errorText}>
            {error.code}: {error.message}
          </Text>
          <Text style={styles.errorDismiss}>tap to dismiss</Text>
        </Pressable>
      ) : null}

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={THEME.text_secondary} />
          <Text style={styles.loadingText}>Loading installed Cores…</Text>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={styles.gridContent}
        style={styles.gridScroll}
      >
        <LauncherGrid
          entries={entries}
          onLaunch={launchEntry}
          onLongPress={onLongPress}
          onReorderDrop={onReorderDrop}
          onBuildMePress={onBuildMePress}
        />

        {entries.length === 0 && !loading ? (
          <Text style={styles.emptyText}>
            No Apps installed for this project yet. Tap “Build me…” to ask the agent to scaffold one.
          </Text>
        ) : null}
      </ScrollView>

      <LauncherItemMenu
        menu={menu}
        total={entries.length}
        onClose={closeMenu}
        onRename={(entry) => {
          setRenamingFor(entry);
          setRenameDraft(entry.display_name);
          closeMenu();
        }}
        onDelete={async (entry) => {
          closeMenu();
          await uninstall(entry.slug);
        }}
        onMoveLeft={async (entry, index) => {
          closeMenu();
          await reorder(entry.slug, Math.max(0, index - 1));
        }}
        onMoveRight={async (entry, index) => {
          closeMenu();
          await reorder(entry.slug, Math.min(entries.length - 1, index + 1));
        }}
        onLongPressEntry={(entry, item) => {
          closeMenu();
          dispatchLongPressEntry(entry, item);
        }}
      />

      <LauncherRenameModal
        entry={renamingFor}
        draft={renameDraft}
        onDraftChange={setRenameDraft}
        onCancel={() => {
          setRenamingFor(null);
          setRenameDraft('');
        }}
        onSubmit={handleRenameSubmit}
      />

      <LauncherBuildMeModal
        open={buildMeOpen}
        draft={buildMeDraft}
        submitting={building_me}
        onDraftChange={setBuildMeDraft}
        onCancel={() => setBuildMeOpen(false)}
        onSubmit={handleBuildMeSubmit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, padding: SPACING.lg },
  centered: { alignItems: 'center', justifyContent: 'center' },
  intro: { gap: SPACING.xs, marginBottom: SPACING.md },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.h1.fontSize,
    lineHeight: TYPOGRAPHY.h1.lineHeight,
    fontWeight: '700',
  },
  subtitle: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  loadingText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  errorBanner: {
    marginBottom: SPACING.md,
    padding: SPACING.sm,
    borderRadius: DENSITY.banner_radius,
    backgroundColor: `${THEME.danger}1a` /* THEME.danger @ ~10% alpha */,
    borderWidth: 1,
    borderColor: THEME.danger,
  },
  errorText: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  errorDismiss: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    marginTop: SPACING.xs / 2,
    fontStyle: 'italic',
  },
  gridScroll: { flex: 1 },
  gridContent: { paddingBottom: SPACING.xl },
  emptyText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontStyle: 'italic',
    marginTop: SPACING.xl,
    textAlign: 'center',
  },
});
