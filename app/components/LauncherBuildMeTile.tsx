/**
 * @neutronai/app — "Build me…" launcher tile (P5.3).
 *
 * Renders as the LAST tile of the grid. Dashed border + ✨ glyph
 * signals the "add new" affordance — same visual register as the
 * other tiles, distinct enough to read as an install hand-off, not a
 * production Core. The iPhone paradigm has a single "add app"
 * affordance (drag to App Store icon); we don't have an App Store at
 * P5.3, so this tile IS the install affordance.
 *
 * Long-press disabled — there's nothing to rename / move / delete on
 * the build-me tile. Tap opens `<LauncherBuildMeModal>`.
 *
 * Per § 4.11 of the brief — all values from theme tokens.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DENSITY, SPACING, THEME, TYPOGRAPHY } from '../lib/theme';

const TILE_RADIUS = DENSITY.bubble_radius + 4;
const TILE_EMOJI_FONT_SIZE = Math.round(TYPOGRAPHY.h1.fontSize * 1.55);

export interface LauncherBuildMeTileProps {
  /** Edge length (square). Matches the sibling `<LauncherItem>` size. */
  size: number;
  onPress: () => void;
}

export function LauncherBuildMeTile({ size, onPress }: LauncherBuildMeTileProps) {
  return (
    <View style={[styles.tileWrap, { width: size }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Build me a new App"
        testID="launcher-tile-build-me"
        onPress={onPress}
        style={({ pressed }) => [
          styles.tile,
          { width: size, height: size },
          pressed && styles.tilePressed,
        ]}
      >
        <Text style={styles.tileEmoji}>✨</Text>
        <Text style={styles.tileLabel}>Build me…</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  tileWrap: {},
  tile: {
    borderRadius: TILE_RADIUS,
    backgroundColor: THEME.background,
    borderWidth: 1,
    borderColor: THEME.text_muted,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.sm,
  },
  tilePressed: {
    backgroundColor: THEME.surface_raised,
    borderColor: THEME.text_secondary,
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
