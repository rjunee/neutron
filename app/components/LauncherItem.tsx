/**
 * @neutronai/app — single launcher tile (P5.3).
 *
 * Pure-props presentation. Long-press opens the action sheet; tap
 * routes the launch. Web targets additionally expose HTML5 drag-drop
 * props (`draggable` + `onDragStart` / `onDragOver` / `onDrop` /
 * `onDragEnd`); native targets receive the same props but RN ignores
 * them. The reorder mutation is server-authoritative (the gateway
 * returns the post-mutation ordered list and the state-provider
 * replaces state with it).
 *
 * Theme tokens only — no inline magic numbers. Per the brief's § 4.11
 * mapping the tile uses `THEME.surface` over `THEME.background` and
 * `THEME.surface_raised` for the pressed state.
 */

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { LauncherEntry, LauncherIcon } from '../lib/launcher-client';
import { DENSITY, MOTION, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

/** Long-press delay — sits inside Apple HIG's 250–500ms band. */
export const LONG_PRESS_DELAY = MOTION.fast * 2;
/** Tile-radius offset above bubble_radius gives the iPhone-paradigm rounded-rect feel. */
const TILE_RADIUS = DENSITY.bubble_radius + 4;
/** Emoji glyph size — readable thumb-target on phone. ~1.55× h1.fontSize keeps it tokenised. */
const TILE_EMOJI_FONT_SIZE = Math.round(TYPOGRAPHY.h1.fontSize * 1.55);

export interface LauncherItemDragHandlers {
  draggable: boolean;
  onDragStart: (event: unknown) => void;
  onDragOver: (event: unknown) => void;
  onDrop: (event: unknown) => void;
  onDragEnd: (event: unknown) => void;
}

export interface LauncherItemProps {
  entry: LauncherEntry;
  index: number;
  /** Edge length (square). Derived from `launcher-grid-layout.ts`. */
  size: number;
  onTap: () => void;
  onLongPress: () => void;
  /** Web drag-drop handlers passed by `<LauncherGrid>`; native ignores them. */
  dragHandlers: LauncherItemDragHandlers | null;
}

export function LauncherItem({
  entry,
  size,
  onTap,
  onLongPress,
  dragHandlers,
}: LauncherItemProps) {
  // RN-web translates `View` → `<div>`. HTML5 drag attributes aren't
  // in React Native's typed surface so we pass them via a
  // `Record<string, unknown>` cast that RN-web honours and native
  // renderers silently ignore. Native reorder uses long-press +
  // action-sheet's Move ← / Move → (the brief locks this — touch
  // drag-with-finger lands when prebuild-managed RN gesture libs are
  // adopted, separate sprint).
  const webDragProps: Record<string, unknown> =
    Platform.OS === 'web' && dragHandlers !== null
      ? {
          draggable: dragHandlers.draggable,
          onDragStart: dragHandlers.onDragStart,
          onDragOver: dragHandlers.onDragOver,
          onDrop: dragHandlers.onDrop,
          onDragEnd: dragHandlers.onDragEnd,
        }
      : {};
  return (
    <View
      {...webDragProps}
      style={[styles.tileWrap, { width: size }]}
      testID={`launcher-tile-${entry.slug}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${entry.display_name}. Long-press for options.`}
        delayLongPress={LONG_PRESS_DELAY}
        onLongPress={onLongPress}
        onPress={onTap}
        style={({ pressed }) => [
          styles.tile,
          { width: size, height: size },
          pressed && styles.tilePressed,
        ]}
      >
        <LauncherIconView icon={entry.launcher_icon} />
        <Text numberOfLines={1} style={styles.tileLabel}>
          {entry.display_name}
        </Text>
      </Pressable>
    </View>
  );
}

function LauncherIconView({ icon }: { icon: LauncherIcon }) {
  if (icon.kind === 'emoji') {
    return <Text style={styles.tileEmoji}>{icon.value}</Text>;
  }
  // URL icons decode (server returns the manifest as-is) but render
  // the fallback emoji at P5.3 — the icon-library sprint owns
  // progressive image loading + caching + decode-error fallback.
  return <Text style={styles.tileEmoji}>🧩</Text>;
}

const styles = StyleSheet.create({
  tileWrap: {
    // width is set per-instance from the `size` prop. The wrapper
    // exists so the inner Pressable's pressed-state border doesn't
    // shift the layout when the user taps.
  },
  tile: {
    borderRadius: TILE_RADIUS,
    backgroundColor: THEME.surface,
    borderWidth: 1,
    borderColor: THEME.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.sm,
  },
  tilePressed: {
    backgroundColor: THEME.surface_raised,
    borderColor: THEME.surface_raised,
  },
  tileEmoji: { fontSize: TILE_EMOJI_FONT_SIZE, lineHeight: TILE_EMOJI_FONT_SIZE + 4 },
  tileLabel: {
    color: THEME.text_secondary,
    fontSize: TYPOGRAPHY.body_small.fontSize,
    lineHeight: TYPOGRAPHY.body_small.lineHeight,
    fontWeight: '500',
    textAlign: 'center',
  },
});
