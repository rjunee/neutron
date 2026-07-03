/**
 * @neutronai/app — phone DOCS drill-down list (M1 UX redesign PR-5).
 *
 * The single-pane iOS-Files list for the phone Documents surface. ONE component
 * reused at every drill level (recursion happens via the router in `docs.tsx`):
 * the ROOT level renders Pinned → Recent → Files; a drilled-in folder renders
 * just that folder's contents (its `pinned`/`recent` arrays are empty). Tapping
 * a folder pushes a new scoped list; tapping a file pushes the full-screen
 * viewer. Purely presentational — scoping + ordering live in `lib/docs-drill.ts`.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { DocTreeNode } from '../lib/docs-client';
import { formatDocTime } from '../lib/docs-drill';

export interface DocsDrillListProps {
  /** The nodes at THIS drill level (root tree, or a folder's children). */
  nodes: DocTreeNode[];
  /** Pinned shortcuts — populated at the root level only. */
  pinned: DocTreeNode[];
  /** Recently-edited shortcuts — populated at the root level only. */
  recent: DocTreeNode[];
  /** Injected for deterministic Recent timestamps; defaults to `new Date()`. */
  now?: Date;
  onOpenFolder(path: string): void;
  onOpenFile(path: string): void;
  /** Long-press a row → the rename/move/delete action sheet (parity with the
   *  wide-viewport `TreeBranch`). Optional so unit callers can omit it. */
  onLongPress?(node: DocTreeNode): void;
}

/** The emoji glyph for a node — folders, markdown files, and binaries (by MIME),
 *  mirroring the wide `TreeBranch`'s `treeIconFor`. */
function iconFor(node: DocTreeNode): string {
  if (node.kind === 'folder') return '📁';
  if (node.kind === 'binary') {
    const ct = node.content_type ?? '';
    if (ct.startsWith('image/')) return '🖼️';
    if (ct === 'application/pdf') return '📕';
    if (ct.startsWith('audio/')) return '🎵';
    if (ct.startsWith('video/')) return '🎬';
    return '📎';
  }
  return '📄';
}

function DrillRow({
  icon,
  label,
  time,
  chevron,
  testID,
  onPress,
  onLongPress,
}: {
  icon: string;
  label: string;
  time?: string;
  chevron?: boolean;
  testID: string;
  onPress(): void;
  onLongPress?(): void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      {...(onLongPress !== undefined ? { onLongPress } : {})}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Text style={styles.icon}>{icon}</Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {time !== undefined && time.length > 0 ? <Text style={styles.time}>{time}</Text> : null}
      {chevron ? <Text style={styles.chev}>›</Text> : null}
    </Pressable>
  );
}

export function DocsDrillList({
  nodes,
  pinned,
  recent,
  now,
  onOpenFolder,
  onOpenFile,
  onLongPress,
}: DocsDrillListProps): React.JSX.Element {
  const clock = now ?? new Date();
  const folders = nodes.filter((n) => n.kind === 'folder');
  // Markdown files AND binaries (images/PDFs/…) are tappable leaves — dropping
  // binaries would strand attachments (and blank a binary-only folder).
  const leaves = nodes.filter((n) => n.kind === 'file' || n.kind === 'binary');
  const showFilesLabel = pinned.length > 0 || recent.length > 0;

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="docs-drill-list">
      {pinned.length > 0 ? (
        <>
          <Text style={styles.seclbl}>Pinned</Text>
          {pinned.map((f) => (
            <DrillRow
              key={`pin:${f.path}`}
              icon="📌"
              label={f.name}
              chevron
              testID={`docs-drill-file-${f.path}`}
              onPress={() => onOpenFile(f.path)}
              {...(onLongPress !== undefined ? { onLongPress: () => onLongPress(f) } : {})}
            />
          ))}
        </>
      ) : null}

      {recent.length > 0 ? (
        <>
          <Text style={styles.seclbl}>Recent</Text>
          {recent.map((f) => (
            <DrillRow
              key={`recent:${f.path}`}
              icon="📄"
              label={f.name}
              time={formatDocTime(f.modified_at, clock)}
              testID={`docs-drill-file-${f.path}`}
              onPress={() => onOpenFile(f.path)}
              {...(onLongPress !== undefined ? { onLongPress: () => onLongPress(f) } : {})}
            />
          ))}
        </>
      ) : null}

      {showFilesLabel ? <Text style={styles.seclbl}>Files</Text> : null}
      {nodes.length === 0 ? (
        <Text style={styles.empty}>This folder is empty.</Text>
      ) : null}
      {folders.map((n) => (
        <DrillRow
          key={`dir:${n.path}`}
          icon="📁"
          label={n.name}
          chevron
          testID={`docs-drill-folder-${n.path}`}
          onPress={() => onOpenFolder(n.path)}
          {...(onLongPress !== undefined ? { onLongPress: () => onLongPress(n) } : {})}
        />
      ))}
      {leaves.map((n) => (
        <DrillRow
          key={`leaf:${n.path}`}
          icon={iconFor(n)}
          label={n.name}
          time={formatDocTime(n.modified_at, clock)}
          testID={`docs-drill-file-${n.path}`}
          onPress={() => onOpenFile(n.path)}
          {...(onLongPress !== undefined ? { onLongPress: () => onLongPress(n) } : {})}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingVertical: 8, paddingHorizontal: 6 },
  seclbl: {
    color: '#8a8a8a',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: 10,
    paddingTop: 12,
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  pressed: { backgroundColor: '#1a1a1a' },
  icon: { fontSize: 15 },
  label: { color: '#cfcfcf', fontSize: 14, fontWeight: '500', flex: 1 },
  time: { color: '#6a6a6a', fontSize: 12, fontVariant: ['tabular-nums'] },
  chev: { color: '#6a6a6a', fontSize: 18, marginLeft: 2 },
  empty: { color: '#5a5a5a', fontSize: 13, padding: 16 },
});
