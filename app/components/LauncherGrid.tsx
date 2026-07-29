/**
 * @neutronai/app — iPhone-style adaptive launcher grid (P5.3).
 *
 * Reads `useWindowDimensions()` + `Platform.OS` to compute the
 * column count + tile size per `launcher-grid-layout.ts:columnsForWidth`.
 * Native targets always render the locked 4-column grid; web targets
 * adapt across the four bands (phone / tablet-portrait / wide-web /
 * very-wide).
 *
 * HTML5 drag-drop wiring on web: this component owns the
 * `dragSlugRef` and the per-tile drag handlers; native receives the
 * same handlers but RN ignores them. The reorder mutation is
 * server-authoritative (the gateway returns the post-mutation
 * ordered list).
 *
 * Renders the rows of `<LauncherItem>` + the trailing
 * `<LauncherBuildMeTile>` (always last; the iPhone-paradigm install
 * affordance).
 */

import { useCallback, useRef } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import type { LauncherEntry } from '../lib/launcher-client';
import { columnsForWidth, tileSizeFor } from '../lib/launcher-grid-layout';
import { SPACING } from '../lib/theme';
import { LauncherBuildMeTile } from './LauncherBuildMeTile';
import {
  LauncherItem,
  type LauncherItemDragHandlers,
} from './LauncherItem';

export interface LauncherGridProps {
  entries: LauncherEntry[];
  onLaunch: (entry: LauncherEntry) => void;
  onLongPress: (entry: LauncherEntry, index: number) => void;
  onReorderDrop: (slug: string, new_index: number) => void;
  onBuildMePress: () => void;
}

export function LauncherGrid({
  entries,
  onLaunch,
  onLongPress,
  onReorderDrop,
  onBuildMePress,
}: LauncherGridProps) {
  const { width: viewportWidth } = useWindowDimensions();
  const platformIsWeb = Platform.OS === 'web';
  const cols = columnsForWidth(viewportWidth, platformIsWeb);
  const tileSize = tileSizeFor(cols, viewportWidth);

  // Web-only: stash the slug of the tile currently being dragged.
  // Tracked in a ref so the drag handlers stay stable across
  // re-renders (HTML5 DnD doesn't carry payloads via dataTransfer
  // reliably across RN-web). The ref is initialised once and
  // mutated by `onDragStart` / `onDrop` / `onDragEnd`.
  const dragSlugRef = useRef<string | null>(null);

  const makeDragHandlers = useCallback(
    (entry: LauncherEntry, index: number): LauncherItemDragHandlers | null => {
      if (!platformIsWeb) return null;
      return {
        draggable: true,
        onDragStart: (e) => {
          dragSlugRef.current = entry.slug;
          const ev = e as { dataTransfer?: { effectAllowed?: string } };
          if (ev.dataTransfer !== undefined) ev.dataTransfer.effectAllowed = 'move';
        },
        onDragOver: (e) => {
          const ev = e as { preventDefault?: () => void };
          if (ev.preventDefault !== undefined) ev.preventDefault();
        },
        onDrop: (e) => {
          const ev = e as { preventDefault?: () => void };
          if (ev.preventDefault !== undefined) ev.preventDefault();
          const dragged = dragSlugRef.current;
          dragSlugRef.current = null;
          if (dragged !== null && dragged !== entry.slug) {
            onReorderDrop(dragged, index);
          }
        },
        onDragEnd: () => {
          dragSlugRef.current = null;
        },
      };
    },
    [platformIsWeb, onReorderDrop],
  );

  return (
    <View style={styles.grid} testID="launcher-grid">
      {entries.map((entry, index) => (
        <LauncherItem
          key={entry.slug}
          entry={entry}
          index={index}
          size={tileSize}
          onTap={() => onLaunch(entry)}
          onLongPress={() => onLongPress(entry, index)}
          dragHandlers={makeDragHandlers(entry, index)}
        />
      ))}
      <LauncherBuildMeTile size={tileSize} onPress={onBuildMePress} />
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
});
