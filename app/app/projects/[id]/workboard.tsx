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
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The ROUTE gives a RAIL id, which for General is the `~general` sentinel — a
 * spelling the gateway's project-id alphabet rejects outright. It is collapsed to
 * the client scope (`railIdToScope`, General ⇒ `''`) ONCE, here at the route
 * boundary, and every layer below takes the scope: the HTTP client re-spells it
 * for the URL (`workBoardPathSegment`), the live socket needs `''` to match
 * General's untagged frames, and the activity tap re-spells it again for the
 * inspector. Three spellings, one conversion point — never an `id === '~general'`
 * check sprinkled at the call sites.
 *
 * ── Liveness ────────────────────────────────────────────────────────────────
 * A strip above the board reports whether the SCOPE is working, from the same
 * `/activity` snapshot + `activity_event` stream the Activity Inspector reads
 * (`work-board-activity.ts`). The per-item pulse only ever fired for a card bound
 * to a run, so an ordinary chat turn left this screen completely still.
 *
 * Structure mirrors `tasks.tsx`: a thin route reading `project_id`, an auth
 * guard, then the body. All sizing flows from `theme.ts` tokens.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { WorkBoardCompletedRow, WorkBoardRow } from '../../../components/WorkBoardRow';
import {
  AppActivityClient,
  mergeActivityRow,
  type ActivityRow,
  type ActivitySnapshot,
  type ActivityState,
} from '../../../lib/activity-client';
import { loadAppConfig } from '../../../lib/config';
import { railIdToScope } from '../../../lib/project-rail-view';
import { useAuthSession } from '../../../lib/session';
import { MOTION, SPACING, TYPOGRAPHY, type NeutronTheme } from '../../../lib/theme';
import { useTheme, useThemedStyles } from '../../../lib/theme-context';
import {
  ACTIVITY_POLL_MS,
  workActivityIndicator,
  workActivityState,
} from '../../../lib/work-board-activity';
import {
  WorkBoardClient,
  docPathFromDesignRef,
  type WorkBoardItem,
} from '../../../lib/work-board-client';
import { boardErrorCopy, dragReorderTarget, splitBoard } from '../../../lib/work-board-helpers';
import { startWorkBoardLive } from '../../../lib/work-board-live';

/** Live rows held for the state derivation. Small on purpose: only the newest
 *  few matter to `workActivityState`, and this screen is not a log viewer. */
const ACTIVITY_ROW_CAP = 40;

function makeDeviceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return `dev-${c.randomUUID()}`;
  return `dev-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export default function WorkBoardTab() {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const railId = typeof id === 'string' ? id : '';
  const { user } = useAuthSession();

  // The GUARD reads the RAIL id, the BODY takes the scope. They have to be
  // separate values: General's scope is legitimately `''`, so guarding on the
  // scope's length would spin forever on the one route that needed fixing.
  if (user === null || railId.length === 0) {
    return (
      <View style={[styles.container, styles.centered]} testID="workboard-bootstrapping">
        <ActivityIndicator color={theme.text_secondary} />
      </View>
    );
  }

  return <WorkBoardBody projectId={railIdToScope(railId)} railId={railId} token={user.token} />;
}

/**
 * `projectId` is the API SCOPE (General ⇒ `''`); `railId` is the ROUTE segment
 * (General ⇒ `~general`). Both are needed and they are not interchangeable: the
 * work-board client is scope-addressed, but a `router.push` built from the scope
 * would produce `/projects//docs` for General — a dead route on the one board
 * that most needed the link. `docs.tsx` builds its own self-links from the route
 * id for the same reason.
 */
function WorkBoardBody({
  projectId,
  railId,
  token,
}: {
  projectId: string;
  railId: string;
  token: string;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const config = useMemo(() => loadAppConfig(), []);
  const deviceId = useMemo(() => makeDeviceId(), []);
  const client = useMemo(
    () => new WorkBoardClient({ base_url: config.base_url, token }),
    [config.base_url, token],
  );
  const activityClient = useMemo(
    () => new AppActivityClient({ base_url: config.base_url, token }),
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

  // Scope liveness. All three pieces are REACT STATE, not refs or module
  // closures: `reactCompiler` memoizes render sub-expressions that have no
  // reactive dependency, so a signal delivered any other way would freeze at its
  // first value and the strip would be decoration rather than instrumentation.
  const [activitySnapshot, setActivitySnapshot] = useState<ActivitySnapshot | null>(null);
  const [activityRows, setActivityRows] = useState<readonly ActivityRow[]>([]);
  const [activityNow, setActivityNow] = useState(() => Date.now());

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
        // NEVER `err.message`. This screen used to paint the raw throw, which is
        // how a gateway validator string became the entire General pane.
        setListError(boardErrorCopy(err, 'load'));
      });
  }, [client, projectId]);

  useEffect(() => {
    setItems([]);
    setActionError(null);
    setNewTitle('');
    setBusyId(null);
    refresh();
  }, [refresh]);

  // Live snapshots — replace the list outright (full-snapshot, idempotent) — and
  // the activity rows behind the status strip, off the SAME socket.
  useEffect(() => {
    setActivityRows([]);
    setActivitySnapshot(null);
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
      onActivity: (row) => {
        setActivityRows((prev) => mergeActivityRow(prev, row, ACTIVITY_ROW_CAP));
      },
      // RE-FETCH ON EVERY (RE)CONNECT — not only on mount. A push-only board
      // permanently loses any item written while the socket was down: nothing
      // re-asks, so the pane stays empty until the owner reloads by hand. That
      // is not hypothetical — on 2026-08-11 his sessions all closed at 19:36:43
      // and the first of five items was written at 19:36:47, and the board sat
      // empty until he reloaded. The mount fetch cannot cover this, because a
      // reconnect is not a mount.
      onConnect: () => {
        refresh();
      },
    });
    return () => live.stop();
  }, [config.base_url, token, projectId, deviceId, refresh]);

  // The AUTHORITATIVE half of the liveness signal: only the server knows
  // `turns_in_flight`, and only a re-fetch can retire a turn whose `completion`
  // frame never arrived. Slow poll — the live rows already deliver start/stop
  // instantly; this just stops the strip lying if one goes missing.
  useEffect(() => {
    let alive = true;
    const fetchSnapshot = (): void => {
      activityClient
        .snapshot(projectId.length === 0 ? null : projectId)
        .then((snap) => {
          if (alive) setActivitySnapshot(snap);
        })
        .catch(() => {
          // The strip is decoration on a failure: a scope we cannot ask about
          // reports nothing rather than guessing. The board's own error state
          // owns telling the owner something is wrong.
        });
    };
    fetchSnapshot();
    const t = setInterval(fetchSnapshot, ACTIVITY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [activityClient, projectId]);

  const activityState: ActivityState = workActivityState({
    snapshot: activitySnapshot,
    rows: activityRows,
    now: activityNow,
  });

  // The client clock the wedge/dead thresholds are measured against. Without it
  // the strip would keep saying "Working" forever on a socket that went silent,
  // because nothing else would re-render it.
  //
  // Ticks ONLY while something is live. An idle scope needs no clock — its state
  // can change only via a live row or the poll, and both re-render on their own —
  // so a resting Work tab costs zero timers, and the interval tears down the
  // moment the turn ends. 5 s is well inside the 30 s / 90 s thresholds it exists
  // to cross.
  useEffect(() => {
    if (activityState === 'idle') return;
    const t = setInterval(() => setActivityNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [activityState]);

  const runMutation = useCallback(
    (itemId: string | null, op: Promise<unknown>): void => {
      if (itemId !== null) setBusyId(itemId);
      setActionError(null);
      op
        .then(() => {
          setBusyId(null);
          refresh();
        })
        .catch((err: unknown) => {
          setBusyId(null);
          setActionError(boardErrorCopy(err, 'action'));
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
        setActionError(boardErrorCopy(err, 'action'));
      });
  }, [client, projectId, newTitle, adding, refresh]);

  // A card's ▸ spec-doc chip opens that doc in this project's Documents tab.
  //
  // RETURNS `undefined`, NOT A NO-OP HANDLER, when the card has no in-app doc.
  // `WorkBoardRow` keys three things off `onOpenDoc === undefined` — the
  // accessibility role (`button` vs `text`), `disabled`, and the press handler —
  // so handing it a function that does nothing would announce a button to a
  // screen reader and give a sighted owner a chip that swallows taps. The
  // absence IS the signal.
  const openDoc = useCallback(
    (ref: string | null): (() => void) | undefined => {
      const path = docPathFromDesignRef(ref);
      if (path === null) return undefined;
      return () => {
        router.push(
          `/projects/${encodeURIComponent(railId)}/docs?path=${encodeURIComponent(path)}`,
        );
      };
    },
    [router, railId],
  );

  const { active, completed } = splitBoard(items);
  const indicator = workActivityIndicator(activityState);

  return (
    <View style={styles.container}>
      {indicator.visible ? (
        <WorkActivityStrip
          label={indicator.label}
          pulse={indicator.pulse}
          tone={activityState === 'working' ? theme.work : theme.attention}
        />
      ) : null}

      {actionError !== null ? <Text style={styles.error}>{actionError}</Text> : null}

      {loading ? (
        <View style={[styles.centered, styles.grow]} testID="workboard-loading">
          <ActivityIndicator color={theme.text_secondary} />
        </View>
      ) : listError !== null ? (
        <View style={[styles.centered, styles.grow]} testID="workboard-error">
          <Text style={styles.empty}>{listError}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading the work board"
            onPress={refresh}
            style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
            testID="workboard-retry"
          >
            <Text style={styles.retryBtnText}>Retry</Text>
          </Pressable>
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
              index={i}
              laneCount={active.length}
              onAdvance={() =>
                runMutation(
                  it.id,
                  it.status === 'in_progress'
                    ? client.complete(projectId, it.id)
                    : client.update(projectId, it.id, { status: 'in_progress' }),
                )
              }
              onRename={(title) =>
                runMutation(it.id, client.update(projectId, it.id, { title }))
              }
              onReorderTo={(targetIndex) => {
                const targetItem = active[targetIndex];
                if (targetItem === undefined) return;
                const target = dragReorderTarget(active, it.id, targetItem.id);
                if (target !== null)
                  runMutation(it.id, client.reorder(projectId, it.id, target));
              }}
              onDelete={() =>
                runMutation(it.id, client.delete(projectId, it.id))
              }
              onPlay={() =>
                runMutation(it.id, client.start(projectId, it.id))
              }
              onOpenDoc={openDoc(it.design_doc_ref)}
            />
          ))}

          {completed.length > 0 ? (
            <View style={styles.completed}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: completedOpen }}
                accessibilityLabel={`Done, ${completed.length} items`}
                onPress={() => setCompletedOpen((v) => !v)}
                style={styles.completedToggle}
                testID="workboard-completed-toggle"
              >
                <Text style={styles.completedToggleText}>
                  {completedOpen ? '▾' : '▸'}  Done · {completed.length}
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
                        runMutation(it.id, client.delete(projectId, it.id))
                      }
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      )}

      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="Add something to do…"
          placeholderTextColor={theme.text_muted}
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
    </View>
  );
}

/**
 * The scope's live status strip — a dot and a word, above the board.
 *
 * The dot's pulse is driven ONLY by `pulse`, which `workActivityIndicator`
 * grants only to a genuinely working scope; a stalled or dead session gets the
 * same dot standing still. An animation that runs regardless of the underlying
 * state is worse than no animation, because it manufactures the exact reassurance
 * the owner is trying to verify.
 *
 * Same pulse mechanics as `WorkBoardRow`'s per-item dot (opacity loop, native
 * driver, honours Reduce Motion) so the two read as one system rather than two
 * different ideas of "busy".
 */
function WorkActivityStrip({
  label,
  pulse,
  tone,
}: {
  label: string;
  pulse: boolean;
  tone: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [reduceMotion, setReduceMotion] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((rm) => {
        if (!cancelled) setReduceMotion(rm);
      })
      .catch(() => {
        if (!cancelled) setReduceMotion(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pulse || reduceMotion) {
      pulseAnim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.3,
          duration: MOTION.pulse,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: MOTION.pulse,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion, pulseAnim]);

  return (
    <View
      style={styles.statusStrip}
      accessibilityRole="text"
      accessibilityLabel={`Agent status: ${label}`}
      testID="workboard-activity-strip"
    >
      <Animated.View
        style={[
          styles.statusDot,
          { backgroundColor: tone, opacity: pulse ? pulseAnim : 1 },
        ]}
        testID={pulse ? 'workboard-activity-dot-pulsing' : 'workboard-activity-dot'}
      />
      <Text style={[styles.statusText, { color: tone }]} testID="workboard-activity-label">
        {label}
      </Text>
    </View>
  );
}

const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background, padding: SPACING.md },
    statusStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      paddingBottom: SPACING.sm,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4 },
    statusText: {
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      letterSpacing: 0.3,
    },
    retryBtn: {
      marginTop: SPACING.md,
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.sm,
      borderRadius: SPACING.sm,
      borderWidth: 1,
      borderColor: theme.hairline,
      backgroundColor: theme.surface,
    },
    retryBtnText: {
      color: theme.text_secondary,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      fontWeight: '600',
    },
    centered: { alignItems: 'center', justifyContent: 'center' },
    grow: { flex: 1 },
    listContent: { paddingBottom: SPACING.xl },
    addRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: SPACING.sm },
    addInput: {
      flex: 1,
      color: theme.text_primary,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.hairline,
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
      backgroundColor: theme.link,
    },
    addBtnDisabled: { opacity: 0.4 },
    addBtnText: { color: theme.background, fontWeight: '600', fontSize: TYPOGRAPHY.body_small.fontSize },
    pressed: { opacity: 0.7 },
    error: {
      color: theme.danger,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      marginBottom: SPACING.sm,
    },
    empty: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body.fontSize,
      lineHeight: TYPOGRAPHY.body.lineHeight,
      textAlign: 'center',
      paddingHorizontal: SPACING.xl,
    },
    completed: { marginTop: SPACING.md, borderTopWidth: 1, borderTopColor: theme.hairline, paddingTop: SPACING.sm },
    completedToggle: { paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm },
    completedToggleText: {
      color: theme.text_muted,
      fontSize: TYPOGRAPHY.body_small.fontSize,
      lineHeight: TYPOGRAPHY.body_small.lineHeight,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    completedList: { maxHeight: SPACING.xxl * 8 },
  });
