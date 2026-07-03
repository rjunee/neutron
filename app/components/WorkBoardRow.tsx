/**
 * @neutronai/app — WORK BOARD row (Work Board Phase 1b; M1 UX redesign).
 *
 * A FLAT one-line row (NOT a card — that's Tasks). Left-to-right: a status dot
 * that reflects the build lifecycle (tap to advance status), the one-line
 * title (tap to edit), a phase TAG capsule + a muted `round N` trail for a
 * bound run, then a drag grip / ▶-or-↻ / ✕ action cluster. The completed
 * variant is dimmed with a strikethrough title + a right-aligned "Merged · Jul
 * 2" datestamp.
 *
 * M1 REDESIGN (mirrors `landing/chat-react/WorkBoardTab.tsx`):
 *   - The old fork/inline activity glyph column is GONE — the dot + tag now
 *     carry that signal (color + pulse + tag text), so a second glyph was
 *     redundant noise.
 *   - The ▲▼ up/down buttons are GONE, replaced by a `⠿` drag grip: a real
 *     `PanResponder` pointer-drag (row-height-quantized, no extra deps) PLUS
 *     `accessibilityActions` increment/decrement for keyboard/VoiceOver parity
 *     (mirrors the web grip's arrow-key handler) — both paths persist through
 *     the SAME `onReorderTo(targetIndex)` callback, i.e. the same
 *     `client.reorder()` route the web tab uses.
 *   - Delete now confirms first (`Alert.alert`) — a linked-running item gets
 *     the "cancel the build" copy, matching the web confirm dialog.
 *
 * All sizing comes from `theme.ts` tokens + named module constants (no inline
 * magic numbers, mirroring `TaskRow`). Dot pulse honors
 * `AccessibilityInfo.isReduceMotionEnabled()` (same pattern as
 * `ProjectSettingsDrawer` / `CommentsSidePane` / `Toast`).
 */

import { memo, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { DENSITY, MOTION, PHASE, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import {
  canPlay,
  dotState,
  failureReasonText,
  formatCompletedShort,
  isLinkedRunning,
  isRetry,
  roundText,
  statusLabel,
  stepTag,
  type DotColorKey,
} from '../lib/work-board-helpers';
import { docLinkLabel, type WorkBoardItem } from '../lib/work-board-client';

const DOT_SIZE = 9;
const DOT_BORDER = 1.5;
const ROW_MIN_HEIGHT = SPACING.xl + SPACING.md; // 36
const ICON_HIT = SPACING.xl + SPACING.md; // 36 — comfortable tap target
// Line-2 indent so the phase tag/round align under the title (past the dot column
// + its gap): dotHit width (ICON_HIT - md) + its negative marginLeft (-xs) + gap (sm).
const META_INDENT = ICON_HIT - SPACING.md - SPACING.xs + SPACING.sm; // 28
const DRAG_ACTIVE_OPACITY = 0.85;

export interface WorkBoardRowProps {
  item: WorkBoardItem;
  busy: boolean;
  /** This row's position within the ACTIVE lane (drag/a11y-action math). */
  index: number;
  /** Total active-lane row count (drag/a11y-action bounds). */
  laneCount: number;
  onAdvance: () => void;
  onRename: (title: string) => void;
  /** Drag drop OR accessibility increment/decrement resolved to a target index. */
  onReorderTo: (targetIndex: number) => void;
  /** Fires only after the confirm dialog is accepted. */
  onDelete: () => void;
  /** ▶/↻ — START/RETRY a build from the card's saved spec. */
  onPlay?: () => void;
  /** Open the card's linked spec-doc; undefined = no doc / no nav. */
  onOpenDoc?: () => void;
}

/** Solid dot color for a phase bucket; the faint muted outline for 'upcoming'. */
function dotColor(colorKey: DotColorKey): string {
  return colorKey === 'upcoming' ? THEME.text_muted : PHASE[colorKey].fg;
}

/** Reduce-motion preference, live-updated. Same pattern as `ProjectSettingsDrawer`. */
function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((rm) => {
        if (!cancelled) setReduceMotion(rm);
      })
      .catch(() => {
        if (!cancelled) setReduceMotion(false);
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (rm: boolean) =>
      setReduceMotion(rm),
    );
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return reduceMotion;
}

function WorkBoardRowImpl({
  item,
  busy,
  index,
  laneCount,
  onAdvance,
  onRename,
  onReorderTo,
  onDelete,
  onPlay,
  onOpenDoc,
}: WorkBoardRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const [dragging, setDragging] = useState(false);

  const dot = dotState(item);
  const tag = stepTag(item.run_progress);
  const round = roundText(item.run_progress);
  const failReason = failureReasonText(item.run_progress);
  const docLabel = docLinkLabel(item.design_doc_ref);
  const showPlay = canPlay(item) && onPlay !== undefined;
  const retry = isRetry(item);

  const reduceMotion = useReduceMotion();
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!dot.pulse || reduceMotion) {
      pulseAnim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.4,
          duration: MOTION.pulse,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: MOTION.pulse,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [dot.pulse, reduceMotion, pulseAnim]);

  // Keep the latest index/laneCount/callback reachable from the PanResponder's
  // handlers without recreating the responder every render.
  const dragRef = useRef({ index, laneCount, onReorderTo });
  dragRef.current = { index, laneCount, onReorderTo };

  const dragY = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: (_e, gesture) => Math.abs(gesture.dy) > 2,
      onPanResponderGrant: () => {
        dragY.setValue(0);
        setDragging(true);
      },
      onPanResponderMove: Animated.event([null, { dy: dragY }], { useNativeDriver: false }),
      onPanResponderRelease: (_e, gesture) => {
        const { index: i, laneCount: n, onReorderTo: reorder } = dragRef.current;
        const delta = Math.round(gesture.dy / ROW_MIN_HEIGHT);
        const target = Math.min(Math.max(i + delta, 0), Math.max(n - 1, 0));
        Animated.timing(dragY, { toValue: 0, duration: MOTION.fast, useNativeDriver: false }).start();
        setDragging(false);
        if (target !== i) reorder(target);
      },
      onPanResponderTerminate: () => {
        Animated.timing(dragY, { toValue: 0, duration: MOTION.fast, useNativeDriver: false }).start();
        setDragging(false);
      },
    }),
  ).current;

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next.length > 0 && next !== item.title) onRename(next);
    else setDraft(item.title);
  };

  const requestDelete = (): void => {
    const linked = isLinkedRunning(item);
    Alert.alert(
      linked ? 'Cancel this build and remove it?' : 'Remove this item?',
      undefined,
      [
        { text: 'Keep', style: 'cancel' },
        { text: linked ? 'Cancel build & remove' : 'Remove', style: 'destructive', onPress: onDelete },
      ],
      { cancelable: true },
    );
  };

  // M1 polish (item 4) — mirror the web 2-line model: line 1 = dot + title +
  // actions; line 2 = the muted phase tag + round, rendered ONLY when the item has
  // a bound run to report (`tag !== null`). A bare queued card is single-line.
  const hasStatus = tag !== null;

  return (
    <Animated.View
      style={[
        styles.row,
        dragging && styles.rowDragging,
        { transform: [{ translateY: dragY }] },
      ]}
      testID={`wb-row-${item.id}`}
    >
      <View style={styles.line1}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${statusLabel(item.status)}. Advance status`}
          disabled={busy}
          onPress={onAdvance}
          style={styles.dotHit}
        >
          <Animated.View
            style={[
              styles.dot,
              {
                borderColor: dotColor(dot.colorKey),
                backgroundColor: dot.colorKey === 'upcoming' ? 'transparent' : dotColor(dot.colorKey),
                opacity: dot.pulse ? pulseAnim : 1,
              },
            ]}
          />
        </Pressable>

        {editing ? (
          <TextInput
            style={styles.editInput}
            value={draft}
            autoFocus
            onChangeText={setDraft}
            onBlur={commit}
            onSubmitEditing={commit}
            accessibilityLabel="Edit item title"
            testID={`wb-edit-${item.id}`}
          />
        ) : (
          <View style={styles.titleCol}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${item.title}`}
              onPress={() => {
                setDraft(item.title);
                setEditing(true);
              }}
            >
              <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
                {item.title}
              </Text>
            </Pressable>
            {docLabel !== null ? (
              <Pressable
                accessibilityRole={onOpenDoc !== undefined ? 'button' : 'text'}
                accessibilityLabel={`Spec doc: ${docLabel}`}
                disabled={onOpenDoc === undefined}
                onPress={onOpenDoc}
              >
                <Text style={styles.docLink} numberOfLines={1} ellipsizeMode="tail">
                  📄 {docLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}

        <View style={styles.actions}>
          <View
            {...panResponder.panHandlers}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={`Reorder ${item.title}. Item ${index + 1} of ${laneCount}.`}
            accessibilityActions={[
              { name: 'increment', label: 'Move down' },
              { name: 'decrement', label: 'Move up' },
            ]}
            onAccessibilityAction={(e) => {
              if (busy) return;
              if (e.nativeEvent.actionName === 'increment') onReorderTo(index + 1);
              else if (e.nativeEvent.actionName === 'decrement') onReorderTo(index - 1);
            }}
            style={styles.iconBtn}
          >
            <Text style={styles.iconGlyph}>⠿</Text>
          </View>
          {showPlay ? (
            <IconButton
              label={retry ? 'Retry build' : 'Start build'}
              glyph={retry ? '↻' : '▶'}
              disabled={busy}
              onPress={onPlay ?? (() => {})}
            />
          ) : null}
          <IconButton label="Delete item" glyph="✕" disabled={busy} onPress={requestDelete} />
        </View>
      </View>

      {hasStatus ? (
        <View style={styles.meta}>
          {tag !== null ? (
            <View style={[styles.tag, { backgroundColor: PHASE[tag.colorKey].bg }]}>
              <Text style={[styles.tagText, { color: PHASE[tag.colorKey].fg }]}>{tag.label}</Text>
            </View>
          ) : null}
          {round !== null ? <Text style={styles.round}>{round}</Text> : null}
          {failReason !== null ? (
            <Text style={styles.failReason} numberOfLines={1}>
              {failReason}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}

/** The dimmed completed-history row: green dot + strikethrough title + mono datestamp + delete. */
function WorkBoardCompletedRowImpl({
  item,
  busy,
  onDelete,
}: {
  item: WorkBoardItem;
  busy: boolean;
  onDelete: () => void;
}) {
  const requestDelete = (): void => {
    Alert.alert('Remove this item?', undefined, [
      { text: 'Keep', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: onDelete },
    ]);
  };
  return (
    <View style={[styles.row, styles.rowDone]} testID={`wb-done-${item.id}`}>
      <View style={styles.line1}>
        <View style={styles.dotHit}>
          <View style={[styles.dot, styles.dotDone]} />
        </View>
        <Text style={[styles.title, styles.titleFill, styles.titleDone]} numberOfLines={1} ellipsizeMode="tail">
          {item.title}
        </Text>
        <IconButton label="Delete item" glyph="✕" disabled={busy} onPress={requestDelete} />
      </View>
      {/* A completed row always carries its "Merged · <date>" on line 2. */}
      <View style={styles.meta}>
        <Text style={styles.date}>Merged · {formatCompletedShort(item.completed_at)}</Text>
      </View>
    </View>
  );
}

function IconButton({
  label,
  glyph,
  disabled,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, disabled && styles.iconDisabled]}
    >
      <Text style={styles.iconGlyph}>{glyph}</Text>
    </Pressable>
  );
}

export const WorkBoardRow = memo(WorkBoardRowImpl);
export const WorkBoardCompletedRow = memo(WorkBoardCompletedRowImpl);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'column',
    gap: 1,
    paddingHorizontal: SPACING.sm,
    borderRadius: SPACING.sm,
  },
  // Line 1 — dot + title + actions (the former single-line row layout).
  line1: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    minHeight: ROW_MIN_HEIGHT,
  },
  // Line 2 — muted phase tag + round (or the completed datestamp), indented under
  // the title. Renders only when the item has status to show (item 4).
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginLeft: META_INDENT,
    paddingBottom: SPACING.xs / 2,
  },
  rowDragging: { opacity: DRAG_ACTIVE_OPACITY, backgroundColor: THEME.surface_raised },
  rowDone: { opacity: 0.55 },
  dotHit: {
    width: ICON_HIT - SPACING.md,
    height: ROW_MIN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -SPACING.xs,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: DOT_BORDER,
  },
  dotDone: { borderColor: PHASE.merge.fg, backgroundColor: PHASE.merge.fg },
  titleCol: { flex: 1, justifyContent: 'center' },
  titleFill: { flex: 1 },
  title: {
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
  },
  docLink: {
    color: THEME.link,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  titleDone: { color: THEME.text_muted, textDecorationLine: 'line-through' },
  editInput: {
    flex: 1,
    color: THEME.text_primary,
    fontSize: TYPOGRAPHY.body.fontSize,
    lineHeight: TYPOGRAPHY.body.lineHeight,
    borderWidth: 1,
    borderColor: THEME.link,
    borderRadius: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  tag: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: DENSITY.chip_radius,
  },
  tagText: {
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
    fontWeight: '600',
  },
  round: {
    color: THEME.text_muted,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  // failure-reason one-liner (#340) — muted red, single-line, shrinks/truncates.
  failReason: {
    flexShrink: 1,
    color: PHASE.failed.fg,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  date: {
    color: THEME.text_muted,
    fontFamily: TYPOGRAPHY.mono.fontFamily,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  iconBtn: {
    width: ICON_HIT,
    height: ICON_HIT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: SPACING.xs,
  },
  iconGlyph: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.caption.fontSize,
    lineHeight: TYPOGRAPHY.caption.lineHeight,
  },
  iconDisabled: { opacity: 0.3 },
  pressed: { opacity: 0.6 },
});
