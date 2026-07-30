/**
 * @neutronai/app — the ACTIVITY INSPECTOR drawer (SPEC § WAVE 3.5).
 *
 * The mobile half of the tmux replacement. Ryan cannot tell whether a project's
 * agent session is working or hung; in Vajra he attached to tmux, and Neutron's
 * server-side sessions offered no equivalent. Tapping the per-project activity dot
 * opens this, which streams the raw substrate + tool events for that scope live.
 *
 * ENTRY POINT IS THE EXISTING DOT (Ryan-locked) — no new icon was added. That is
 * the point: the dot is precisely the component that has LIED (ISSUES #386: pulsed
 * for days with nothing running), so making the untrustworthy indicator the doorway
 * to the ground truth puts the verification one tap away on the very element that
 * provoked the doubt.
 *
 * THE HEADLINE IS THE PRODUCT. The row list is secondary; what answers "hung or
 * working?" is the two clocks — last event (any, keepalives included ⇒ the process
 * is breathing) and last activity (keepalives excluded ⇒ work actually happened). A
 * session that is alive but doing nothing shows a recent "last event" and a stale
 * "last activity", the distinction a single pulsing dot cannot make.
 *
 * The chat surface keeps showing only its minimal curated messages — that terseness
 * is correct and stays. This is a separate surface.
 *
 * ANIMATION is locked to the same contract as `ProjectSettingsDrawer` /
 * `CommentsSidePane`: built-in `Animated.timing` only (Reanimated deliberately NOT
 * used), `MOTION.base` slide + `MOTION.fast` fade, `Easing.out/in(Easing.cubic)`,
 * backdrop tap / close button / Android hardware back all close.
 *
 * LIVE-ONLY: ~200 rows from the server's in-memory ring, no scrollback, nothing
 * persisted. A restart legitimately shows an empty drawer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MOTION, SPACING, THEME, TYPOGRAPHY } from '../lib/composer-constants';
import { PHASE } from '../lib/theme';
import {
  activityScopeKey,
  describeState,
  formatAge,
  liveAge,
  mergeActivityRow,
  type ActivityRow,
  type ActivitySnapshot,
  type ActivityState,
} from '../lib/activity-client';

/** Client row cap. Matches the server ring so the drawer never holds more history
 *  than a re-open would replay. */
const ROW_CAP = 200;

/** Header clocks re-render cadence. The clocks must keep counting UP even when no
 *  event arrives — a frozen "12s ago" on a wedged session would be the same lie as
 *  a frozen dot. */
const CLOCK_TICK_MS = 1000;

/**
 * Apple HIG's minimum tappable target. The close ✕ was a 16pt glyph with 4pt of
 * padding — a ~24pt target, jammed under a hard-coded 32pt top padding that put
 * it beneath the notch on every modern iPhone. Ryan: the X *"is too close to the
 * top of the screen to tap"*. Both halves of that are fixed below: the header
 * takes the real safe-area top inset, and the button is a full 44pt.
 */
export const MIN_TAP_TARGET_PT = 44;

const KIND_GLYPH: Record<ActivityRow['kind'], string> = {
  tool_start: '▸',
  tool_end: '✓',
  token: '💬',
  thinking: '·',
  status: 'ℹ',
  keepalive: '·',
  completion: '■',
  error: '✕',
  turn_start: '▶',
};

/** The data source, structural so tests inject a fake with no socket + no fetch. */
export interface ActivityDrawerSource {
  snapshot(project_id: string | null): Promise<ActivitySnapshot>;
  /** Subscribe to live rows for `scope_key`. Returns an unsubscribe. */
  subscribe(scope_key: string, onRow: (row: ActivityRow) => void): () => void;
}

/**
 * The verdict's colour matches the RAIL DOT's language so the drawer and the dot can
 * never contradict each other: build-blue = working (the same `PHASE.build.fg` the
 * pulsing dot uses), amber = stalled, red = not responding, muted = idle.
 */
function stateColor(state: ActivityState): string {
  switch (state) {
    case 'working':
      return PHASE.build.fg;
    case 'wedged':
      return THEME.attention;
    case 'dead':
      return THEME.danger;
    case 'idle':
      return THEME.text_muted;
  }
}

/** hh:mm:ss for a row, in the device's locale/zone. */
function rowTime(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ActivityInspectorDrawer({
  open,
  onClose,
  source,
  projectId,
  label,
  reduceMotionOverride,
}: {
  open: boolean;
  onClose: () => void;
  source: ActivityDrawerSource;
  /** The scope: a project id, or null for General. */
  projectId: string | null;
  /** Human label for the header. */
  label: string;
  /** Test seam — overrides the async reduce-motion probe. */
  reduceMotionOverride?: boolean;
}) {
  const { width } = useWindowDimensions();
  const safeArea = useSafeAreaInsets();
  const panelWidth = useMemo(() => Math.min(width, 520), [width]);
  const translateX = useRef(new Animated.Value(panelWidth)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(reduceMotionOverride ?? false);

  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const scope = activityScopeKey(projectId);

  useEffect(() => {
    if (reduceMotionOverride !== undefined) return;
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
  }, [reduceMotionOverride]);

  // Data: SUBSCRIBE FIRST, THEN FETCH. The reverse would drop any row landing
  // between the response and the subscription. The two deliberately overlap, so the
  // same `seq` legitimately arrives twice — `mergeActivityRow` dedupes on `seq`,
  // which is what makes subscribe-first safe rather than duplicative.
  useEffect(() => {
    if (!open) {
      // Closing DISCARDS the rows. Correct for a live-only surface: the server ring
      // is the only history, and re-opening re-reads it.
      setRows([]);
      setSnapshot(null);
      setError(null);
      return;
    }
    let alive = true;
    setError(null);
    const unsub = source.subscribe(scope, (row) => {
      if (!alive) return;
      setRows((prev) => mergeActivityRow(prev, row, ROW_CAP));
    });
    void source
      .snapshot(projectId)
      .then((snap) => {
        if (!alive) return;
        setSnapshot(snap);
        setRows((prev) => {
          // Merge, not replace: live rows may already have arrived during the fetch
          // and they are newer than the snapshot.
          let next = snap.events;
          for (const r of prev) next = mergeActivityRow(next, r, ROW_CAP);
          return next;
        });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      unsub();
    };
  }, [open, source, projectId, scope]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const dur = reduceMotion ? 0 : MOTION.base;
      const fade = reduceMotion ? 0 : MOTION.fast;
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: 0,
          duration: dur,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: fade,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      const dur = reduceMotion ? 0 : MOTION.base;
      const fade = reduceMotion ? 0 : MOTION.fast;
      Animated.parallel([
        Animated.timing(translateX, {
          toValue: panelWidth,
          duration: dur,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: fade,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [open, mounted, panelWidth, opacity, translateX, reduceMotion]);

  useEffect(() => {
    if (!open) return undefined;
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const close = useCallback(() => onClose(), [onClose]);

  if (!mounted) return null;

  const eventAge = liveAge(rows, snapshot, now, { realOnly: false });
  const activityAge = liveAge(rows, snapshot, now, { realOnly: true });
  const state: ActivityState = snapshot?.state ?? 'idle';

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Animated.View style={[styles.backdrop, { opacity }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close activity"
          testID="activity-drawer-backdrop"
          onPress={close}
          style={styles.backdropPressable}
        />
      </Animated.View>
      <Animated.View
        style={[styles.panel, { width: panelWidth, transform: [{ translateX }] }]}
        accessibilityViewIsModal
        testID="activity-drawer-panel"
      >
        <View style={[styles.header, { paddingTop: safeArea.top + SPACING.sm }]}>
          <View style={styles.headerText}>
            <Text style={styles.scope} numberOfLines={1}>
              {label}
            </Text>
            <View style={styles.stateRow}>
              <View style={[styles.stateDot, { backgroundColor: stateColor(state) }]} />
              <Text style={[styles.state, { color: stateColor(state) }]} testID="activity-state">
                {describeState(state)}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close activity"
            testID="activity-drawer-close"
            onPress={close}
            hitSlop={SPACING.sm}
            style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
          >
            <Text style={styles.closeGlyph}>✕</Text>
          </Pressable>
        </View>
        {/* THE ANSWER. Two clocks, always visible, always counting. */}
        <View style={styles.clocks}>
          <View style={styles.clock}>
            <Text style={styles.clockKey}>LAST EVENT</Text>
            <Text style={styles.clockVal} testID="activity-last-event">
              {formatAge(eventAge)}
            </Text>
          </View>
          <View style={styles.clockDivider} />
          <View style={styles.clock}>
            <Text style={styles.clockKey}>LAST ACTIVITY</Text>
            <Text style={styles.clockVal} testID="activity-last-activity">
              {formatAge(activityAge)}
            </Text>
          </View>
        </View>
        <ScrollView
          contentContainerStyle={[
            styles.list,
            { paddingBottom: safeArea.bottom + SPACING.lg },
          ]}
        >
          {error !== null ? (
            <Text style={styles.empty} testID="activity-error">
              Could not read activity: {error}
            </Text>
          ) : rows.length === 0 ? (
            <Text style={styles.empty} testID="activity-empty">
              No activity buffered. This view is live-only, so it starts empty after a
              restart and fills as the session works.
            </Text>
          ) : (
            rows.map((r) => (
              <View
                key={r.seq}
                style={[styles.row, r.synthetic === true && styles.rowSynthetic]}
                testID={`activity-row-${r.seq}`}
              >
                <Text style={styles.rowTime}>{rowTime(r.at)}</Text>
                <Text style={styles.rowGlyph}>{KIND_GLYPH[r.kind]}</Text>
                <Text
                  style={[styles.rowLabel, r.kind === 'error' && styles.rowError]}
                  numberOfLines={1}
                >
                  {r.label}
                </Text>
                {r.detail !== undefined ? (
                  <Text
                    style={[styles.rowDetail, r.kind === 'error' && styles.rowError]}
                    numberOfLines={2}
                  >
                    {r.detail}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  backdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: THEME.surface,
    borderLeftWidth: 1,
    borderLeftColor: THEME.hairline,
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowOffset: { width: -4, height: 0 },
    shadowRadius: 16,
    elevation: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    // `paddingTop` is supplied per-render from the safe-area inset. A constant
    // here (it was `SPACING.xxl` = 32) is shorter than the notch on every modern
    // iPhone, which is what put the close button out of reach.
    paddingBottom: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: THEME.hairline,
  },
  headerText: { flex: 1, minWidth: 0, gap: SPACING.xs },
  scope: {
    fontSize: TYPOGRAPHY.h3.fontSize,
    lineHeight: TYPOGRAPHY.h3.lineHeight,
    fontWeight: '600',
    color: THEME.text_primary,
  },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs + 2 },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  state: {
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  // A full HIG-minimum target, not a 16pt glyph with 4pt of padding.
  closeBtn: {
    width: MIN_TAP_TARGET_PT,
    height: MIN_TAP_TARGET_PT,
    borderRadius: MIN_TAP_TARGET_PT / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: THEME.surface_raised,
  },
  closeBtnPressed: { opacity: 0.6 },
  closeGlyph: { fontSize: 18, lineHeight: 22, color: THEME.text_secondary },
  clocks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.lg,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: THEME.hairline,
  },
  clock: { gap: SPACING.xs },
  clockDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: THEME.hairline },
  clockKey: {
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    letterSpacing: 0.6,
    color: THEME.text_muted,
  },
  clockVal: {
    fontSize: TYPOGRAPHY.h4.fontSize,
    lineHeight: TYPOGRAPHY.h4.lineHeight,
    fontWeight: '600',
    color: THEME.text_primary,
    fontVariant: ['tabular-nums'],
  },
  list: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    gap: SPACING.xs + 2,
  },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: SPACING.sm },
  // A synthetic keepalive is NOT work — near-invisible so it never reads as
  // progress (that misreading is exactly ISSUES #386).
  rowSynthetic: { opacity: 0.38 },
  // 11pt monospace was unreadable on a phone. 13 is the smallest size in the
  // type scale (`TYPOGRAPHY.body_small`) and still fits a timestamp + a label.
  rowTime: {
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 19,
    color: THEME.text_muted,
    fontVariant: ['tabular-nums'],
  },
  rowGlyph: { fontFamily: MONO, fontSize: 13, lineHeight: 19, color: THEME.text_muted, width: 16 },
  rowLabel: {
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
    color: THEME.text_primary,
  },
  rowDetail: {
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 19,
    color: THEME.text_muted,
    flex: 1,
    minWidth: 0,
  },
  rowError: { color: THEME.danger },
  empty: {
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    color: THEME.text_muted,
  },
});
