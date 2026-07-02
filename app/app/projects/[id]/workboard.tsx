/**
 * @neutronai/app — project-scoped WORK BOARD tab (Work Board Phase 1b).
 *
 * The live work-tracker tab: active+next at the top as flat one-line rows, the
 * completed history collapsed at the bottom. The owner can add / edit / advance
 * status / reorder / delete — every action hits the SAME canonical
 * `WorkBoardStore` the agent's `work_board_*` tools use (Phase 1a), so a human
 * write fires the same live push the agent's does.
 *
 * ── Live ────────────────────────────────────────────────────────────────────
 * Fetches the board on mount and subscribes to `work_board_changed` frames via a
 * lightweight read-only socket (`work-board-live.ts`) — the board surface has no
 * shared frame bus, so it opens its own. Each snapshot REPLACES the list (full
 * snapshot, idempotent). After any mutation we also refetch so the acting device
 * feels instant even before the push lands.
 *
 * Structure mirrors `tasks.tsx`: a thin route reading `project_id`, an auth
 * guard, then the body. All sizing flows from `theme.ts` tokens.
 */

import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { WorkBoardCompletedRow, WorkBoardRow } from '../../../components/WorkBoardRow';
import { loadAppConfig } from '../../../lib/config';
import { useAuthSession } from '../../../lib/session';
import { SPACING, THEME, TYPOGRAPHY } from '../../../lib/theme';
import { WorkBoardClient, type WorkBoardItem } from '../../../lib/work-board-client';
import { reorderTarget, splitBoard } from '../../../lib/work-board-helpers';
import { startWorkBoardLive } from '../../../lib/work-board-live';

function makeDeviceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return `dev-${c.randomUUID()}`;
  return `dev-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export default function WorkBoardTab() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const project_id = typeof id === 'string' ? id : '';
  const { user } = useAuthSession();

  if (user === null || project_id.length === 0) {
    return (
      <View style={[styles.container, styles.centered]} testID="workboard-bootstrapping">
        <ActivityIndicator color={THEME.text_secondary} />
      </View>
    );
  }

  return <WorkBoardBody projectId={project_id} token={user.token} />;
}

function WorkBoardBody({ projectId, token }: { projectId: string; token: string }) {
  const config = useMemo(() => loadAppConfig(), []);
  const deviceId = useMemo(() => makeDeviceId(), []);
  const client = useMemo(
    () => new WorkBoardClient({ base_url: config.base_url, token }),
    [config.base_url, token],
  );

  const [items, setItems] = useState<WorkBoardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Monotonic guard so a slow fetch can't land after a fresher live snapshot.
  const seq = useRef(0);

  const refresh = useCallback((): void => {
    const mine = (seq.current += 1);
    setLoading(true);
    setListError(null);
    client
      .list(projectId)
      .then((rows) => {
        if (mine !== seq.current) return;
        setItems(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setItems([]);
        setLoading(false);
        setListError(err instanceof Error ? err.message : 'failed to load the board');
      });
  }, [client, projectId]);

  useEffect(() => {
    setItems([]);
    setActionError(null);
    setNewTitle('');
    setBusyId(null);
    refresh();
  }, [refresh]);

  // Live snapshots — replace the list outright (full-snapshot, idempotent).
  useEffect(() => {
    const live = startWorkBoardLive({
      base_url: config.base_url,
      token,
      project_id: projectId,
      device_id: deviceId,
      onSnapshot: (rows) => {
        seq.current += 1; // a live snapshot supersedes any in-flight fetch
        setItems(rows);
        setLoading(false);
      },
    });
    return () => live.stop();
  }, [config.base_url, token, projectId, deviceId]);

  const runMutation = useCallback(
    (itemId: string | null, op: Promise<unknown>, failMsg: string): void => {
      if (itemId !== null) setBusyId(itemId);
      setActionError(null);
      op
        .then(() => {
          setBusyId(null);
          refresh();
        })
        .catch((err: unknown) => {
          setBusyId(null);
          setActionError(err instanceof Error ? err.message : failMsg);
        });
    },
    [refresh],
  );

  const addItem = useCallback((): void => {
    const title = newTitle.trim();
    if (title.length === 0 || adding) return;
    setAdding(true);
    setActionError(null);
    client
      .create(projectId, { title })
      .then(() => {
        setAdding(false);
        setNewTitle('');
        refresh();
      })
      .catch((err: unknown) => {
        setAdding(false);
        setActionError(err instanceof Error ? err.message : 'failed to add item');
      });
  }, [client, projectId, newTitle, adding, refresh]);

  const { active, completed } = splitBoard(items);

  return (
    <View style={styles.container}>
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="Add an item…"
          placeholderTextColor={THEME.text_muted}
          value={newTitle}
          onChangeText={setNewTitle}
          onSubmitEditing={addItem}
          accessibilityLabel="New work item title"
          testID="workboard-add-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add item"
          disabled={adding || newTitle.trim().length === 0}
          onPress={addItem}
          style={({ pressed }) => [
            styles.addBtn,
            pressed && styles.pressed,
            (adding || newTitle.trim().length === 0) && styles.addBtnDisabled,
          ]}
        >
          <Text style={styles.addBtnText}>{adding ? '…' : 'Add'}</Text>
        </Pressable>
      </View>

      {actionError !== null ? <Text style={styles.error}>{actionError}</Text> : null}

      {loading ? (
        <View style={[styles.centered, styles.grow]} testID="workboard-loading">
          <ActivityIndicator color={THEME.text_secondary} />
        </View>
      ) : listError !== null ? (
        <View style={[styles.centered, styles.grow]}>
          <Text style={styles.empty}>{listError}</Text>
        </View>
      ) : active.length === 0 && completed.length === 0 ? (
        <View style={[styles.centered, styles.grow]} testID="workboard-empty">
          <Text style={styles.empty}>
            No work tracked yet. Ask Neutron to start something, or add an item.
          </Text>
        </View>
      ) : (
        <ScrollView style={styles.grow} contentContainerStyle={styles.listContent}>
          {active.map((it, i) => (
            <WorkBoardRow
              key={it.id}
              item={it}
              busy={busyId === it.id}
              canMoveUp={i > 0}
              canMoveDown={i < active.length - 1}
              onAdvance={() =>
                runMutation(
                  it.id,
                  it.status === 'in_progress'
                    ? client.complete(projectId, it.id)
                    : client.update(projectId, it.id, { status: 'in_progress' }),
                  'failed to update item',
                )
              }
              onRename={(title) =>
                runMutation(it.id, client.update(projectId, it.id, { title }), 'failed to rename item')
              }
              onMoveUp={() => {
                const target = reorderTarget(active, i, -1);
                if (target !== null)
                  runMutation(it.id, client.reorder(projectId, it.id, target), 'failed to reorder');
              }}
              onMoveDown={() => {
                const target = reorderTarget(active, i, 1);
                if (target !== null)
                  runMutation(it.id, client.reorder(projectId, it.id, target), 'failed to reorder');
              }}
              onDelete={() =>
                runMutation(it.id, client.delete(projectId, it.id), 'failed to delete item')
              }
              onPlay={() =>
                runMutation(it.id, client.start(projectId, it.id), 'failed to start build')
              }
            />
          ))}

          {completed.length > 0 ? (
            <View style={styles.completed}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: completedOpen }}
                accessibilityLabel={`Completed, ${completed.length} items`}
                onPress={() => setCompletedOpen((v) => !v)}
                style={styles.completedToggle}
                testID="workboard-completed-toggle"
              >
                <Text style={styles.completedToggleText}>
                  {completedOpen ? '▾' : '▸'}  Completed · {completed.length}
                </Text>
              </Pressable>
              {completedOpen ? (
                <View style={styles.completedList}>
                  {completed.map((it) => (
                    <WorkBoardCompletedRow
                      key={it.id}
                      item={it}
                      busy={busyId === it.id}
                      onDelete={() =>
                        runMutation(it.id, client.delete(projectId, it.id), 'failed to delete item')
                      }
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: THEME.background, padding: SPACING.md },
  centered: { alignItems: 'center', justifyContent: 'center' },
  grow: { flex: 1 },
  listContent: { paddingBottom: SPACING.xl },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  addInput: {
    flex: 1,
    color: THEME.text_primary,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
    borderRadius: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  addBtn: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: SPACING.sm,
    backgroundColor: THEME.link,
  },
  addBtnDisabled: { opacity: 0.4 },
  addBtnText: { color: THEME.background, fontWeight: '600', fontSize: TYPOGRAPHY.body_small.fontSize },
  pressed: { opacity: 0.7 },
  error: {
    color: THEME.danger,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    marginBottom: SPACING.sm,
  },
  empty: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    textAlign: 'center',
    paddingHorizontal: SPACING.xl,
  },
  completed: { marginTop: SPACING.md, borderTopWidth: 1, borderTopColor: THEME.hairline, paddingTop: SPACING.sm },
  completedToggle: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm },
  completedToggleText: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  completedList: { maxHeight: SPACING.xxl * 8 },
});
