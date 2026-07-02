/**
 * @neutronai/app — WORK BOARD row (Work Board Phase 1b).
 *
 * A FLAT one-line row (NOT a card — that's Tasks). Left-to-right: a status dot
 * (tap to advance), an optional activity glyph (sub-agent ⑂ / inline ›), the
 * one-line title (tap to edit), then up/down/delete controls. The completed
 * variant is dimmed with a right-aligned monospace datestamp.
 *
 * Live-blue (`THEME.link`, #5fb6ff) marks "running" — NOT the gray `THEME.accent`
 * (per the master plan §6: never use the gray accent for the live state). All
 * sizing comes from `theme.ts` tokens + named module constants (no inline magic
 * numbers, mirroring `TaskRow`). Sub-agent vs inline is distinguished by glyph +
 * `accessibilityLabel`, never by color alone.
 */

import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SPACING, THEME, TYPOGRAPHY } from '../lib/theme';
import {
  activityFor,
  dotKind,
  formatCompletedDate,
  statusLabel,
} from '../lib/work-board-helpers';
import { docLinkLabel, type WorkBoardItem } from '../lib/work-board-client';

const DOT_SIZE = 10;
const DOT_BORDER = 1.5;
const ROW_MIN_HEIGHT = SPACING.xl + SPACING.md; // 36
const GLYPH_WIDTH = SPACING.md + SPACING.xs; // 16
const ICON_HIT = SPACING.xl + SPACING.md; // 36 — comfortable tap target

export interface WorkBoardRowProps {
  item: WorkBoardItem;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onAdvance: () => void;
  onRename: (title: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  /** ▶ — START/RETRY a build from the card's saved spec. */
  onPlay?: () => void;
  /** Open the card's linked spec-doc; undefined = no doc / no nav. */
  onOpenDoc?: () => void;
}

/**
 * True when the ▶ (play) control should render: NOT in_progress, NOT done, and
 * no bound run. On terminal reconcile a failed build clears the binding + moves
 * the card back to `upcoming`, so this covers both START and RETRY.
 */
function canPlay(item: WorkBoardItem): boolean {
  const linked = item.linked_run_id !== null && item.linked_run_id.length > 0;
  return item.status !== 'in_progress' && item.status !== 'done' && !linked;
}

function dotStyle(kind: ReturnType<typeof dotKind>) {
  if (kind === 'in_progress') return styles.dotActive;
  if (kind === 'done') return styles.dotDone;
  return styles.dotUpcoming;
}

function WorkBoardRowImpl({
  item,
  busy,
  canMoveUp,
  canMoveDown,
  onAdvance,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
  onPlay,
  onOpenDoc,
}: WorkBoardRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const activity = activityFor(item);
  const kind = dotKind(item.status);
  const docLabel = docLinkLabel(item.design_doc_ref);
  const showPlay = canPlay(item) && onPlay !== undefined;

  const commit = (): void => {
    const next = draft.trim();
    setEditing(false);
    if (next.length > 0 && next !== item.title) onRename(next);
    else setDraft(item.title);
  };

  return (
    <View style={styles.row} testID={`wb-row-${item.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${statusLabel(item.status)}. Advance status`}
        disabled={busy}
        onPress={onAdvance}
        style={styles.dotHit}
      >
        <View style={[styles.dot, dotStyle(kind)]} />
      </Pressable>

      {activity !== null ? (
        <Text
          style={styles.activity}
          accessibilityLabel={activity.label}
          accessible
        >
          {activity.glyph}
        </Text>
      ) : (
        <View style={styles.activitySpacer} />
      )}

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
        {showPlay ? (
          <IconButton
            label={item.linked_run_id !== null ? 'Retry build' : 'Start build'}
            glyph="▶"
            disabled={busy}
            onPress={onPlay ?? (() => {})}
          />
        ) : null}
        <IconButton label="Move up" glyph="▲" disabled={busy || !canMoveUp} onPress={onMoveUp} />
        <IconButton
          label="Move down"
          glyph="▼"
          disabled={busy || !canMoveDown}
          onPress={onMoveDown}
        />
        <IconButton label="Delete item" glyph="✕" disabled={busy} onPress={onDelete} />
      </View>
    </View>
  );
}

/** The dimmed completed-history row: dot + title + mono datestamp + delete. */
function WorkBoardCompletedRowImpl({
  item,
  busy,
  onDelete,
}: {
  item: WorkBoardItem;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <View style={[styles.row, styles.rowDone]} testID={`wb-done-${item.id}`}>
      <View style={styles.dotHit}>
        <View style={[styles.dot, styles.dotDone]} />
      </View>
      <Text style={[styles.title, styles.titleFill, styles.titleDone]} numberOfLines={1} ellipsizeMode="tail">
        {item.title}
      </Text>
      <Text style={styles.date} accessibilityLabel={`Completed ${formatCompletedDate(item.completed_at)}`}>
        {formatCompletedDate(item.completed_at)}
      </Text>
      <IconButton label="Delete item" glyph="✕" disabled={busy} onPress={onDelete} />
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    minHeight: ROW_MIN_HEIGHT,
    paddingHorizontal: SPACING.sm,
    borderRadius: SPACING.sm,
  },
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
  dotUpcoming: { borderColor: THEME.text_muted, backgroundColor: 'transparent' },
  dotActive: { borderColor: THEME.link, backgroundColor: THEME.link },
  dotDone: { borderColor: THEME.text_muted, backgroundColor: THEME.text_muted },
  activity: {
    width: GLYPH_WIDTH,
    textAlign: 'center',
    color: THEME.link,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
  },
  activitySpacer: { width: GLYPH_WIDTH },
  titleWrap: { flex: 1, justifyContent: 'center' },
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
