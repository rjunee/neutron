/**
 * @neutronai/app — leaf components + StyleSheet for the docs tab (D7
 * refactor). Extracted verbatim from `docs.tsx` so the `DocsTab` shell
 * is composition + JSX only. Every component here is presentational
 * (no data fetching, no gates); the stateful clusters live in the
 * `use-doc-*` hooks.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { type NeutronTheme } from '../../lib/theme';
import { useTheme, useThemedStyles } from '../../lib/theme-context';
import { type CommitSummary, type DocTreeNode } from '../../lib/docs-client';
import { formatBytes, formatHistoryDate, treeIconFor } from './docs-shared';

// P7.3 range UI consumer — highlight overlay alpha levels. The fill
// uses 12% alpha; the 2 px left border uses 55% alpha (caller-visible
// "this is the line you came here for" affordance). Both derive from
// the ACTIVE `accent` so a palette shift — including the whole theme
// flipping to light — follows by construction; `withAlpha` parses the
// hex and rebuilds the rgba string.
//
// These were two module-scope constants, which is exactly the capture this
// refactor removes: `accent` is near-white in dark and near-black in light, so a
// tint computed once at import would have painted a white wash over a light page.
// They are now derived inside the sheet factory, per palette.
const HIGHLIGHT_OVERLAY_FILL_ALPHA = 0.12;
const HIGHLIGHT_OVERLAY_BORDER_ALPHA = 0.55;

function withAlpha(hexColor: string, alpha: number): string {
  // `#rrggbb` only — every palette color today is a 6-digit hex.
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor);
  if (m === null) return hexColor;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

interface BinaryPreviewProps {
  node: DocTreeNode;
  source: { uri: string; headers: Record<string, string> };
}

export function BinaryPreview({ node, source }: BinaryPreviewProps) {
  const styles = useThemedStyles(makeStyles);
  const ct = node.content_type ?? '';
  if (ct.startsWith('image/')) {
    return (
      <View style={styles.binaryPreviewWrap} testID="docs-binary-preview">
        <Image
          source={source}
          style={styles.binaryImage}
          resizeMode="contain"
          accessibilityLabel={node.path}
        />
        <Text style={styles.binaryMeta}>
          {node.path} · {ct} · {formatBytes(node.size_bytes ?? 0)}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.binaryPreviewWrap} testID="docs-binary-preview">
      <View style={styles.binaryDownloadCard}>
        <Text style={styles.binaryDownloadIcon}>{ct === 'application/pdf' ? '📕' : ct.startsWith('audio/') ? '🎵' : '🎬'}</Text>
        <Text style={styles.binaryDownloadName} numberOfLines={2}>{node.name}</Text>
        <Text style={styles.binaryDownloadMeta}>
          {ct} · {formatBytes(node.size_bytes ?? 0)}
        </Text>
        <Pressable
          testID="docs-binary-download-button"
          accessibilityRole="button"
          style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
          onPress={() => {
            Linking.openURL(source.uri).catch(() => undefined);
          }}
        >
          <Text style={styles.actionBtnText}>Open / Download</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface EditorDropTargetProps {
  onDropFile: (file: File) => void;
  dragOver: boolean;
  setDragOver: (next: boolean) => void;
  children: ReactNode;
}

/**
 * Round-2 MINOR #3 — web-only drag-drop wrapper for the editor
 * TextInput. On native, returns children unchanged (mobile drag-drop
 * follows up via expo-image-picker in a later sprint). On web, renders
 * a `<div>` that intercepts `dragover` / `dragleave` / `drop`, pulls
 * the first dropped File out of the DataTransfer, and forwards it to
 * `onDropFile`. The drop-target border lights up while the user is
 * mid-drag so it's obvious where the file will land.
 */
export function EditorDropTarget({
  onDropFile,
  dragOver,
  setDragOver,
  children,
}: EditorDropTargetProps) {
  const styles = useThemedStyles(makeStyles);
  if (Platform.OS !== 'web') {
    return <View style={styles.dropTarget}>{children}</View>;
  }
  return (
    // @ts-ignore — DOM-only div mounted on RN-web for native drag-drop events.
    <div
      data-testid="docs-editor-droptarget"
      style={{
        position: 'relative',
        flex: 1,
        outline: dragOver ? '2px dashed #5fb6ff' : 'none',
        outlineOffset: dragOver ? '-2px' : 0,
        transition: 'outline 80ms ease-out',
      }}
      onDragOver={(e: { preventDefault: () => void; dataTransfer?: { dropEffect?: string } }) => {
        e.preventDefault();
        if (e.dataTransfer !== undefined) e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => {
        if (dragOver) setDragOver(false);
      }}
      onDrop={(e: { preventDefault: () => void; dataTransfer?: { files?: ArrayLike<File> } }) => {
        e.preventDefault();
        setDragOver(false);
        const files = e.dataTransfer?.files;
        if (files === undefined || files.length === 0) return;
        const first = files[0];
        if (first === undefined) return;
        onDropFile(first);
      }}
    >
      {children}
    </div>
  );
}

interface BinaryUploadButtonProps {
  uploading: boolean;
  onUpload(file: File): void;
}

/**
 * Web-only hidden file input behind a Pressable. On mobile the button
 * is hidden by the Platform.OS check at the call-site (mobile picker
 * is a follow-up — expo-image-picker isn't a current dep).
 */
export function BinaryUploadButton({ uploading, onUpload }: BinaryUploadButtonProps) {
  const styles = useThemedStyles(makeStyles);
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <View style={styles.binaryUploadWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Upload binary"
        testID="docs-upload-binary-button"
        disabled={uploading}
        onPress={() => {
          if (inputRef.current !== null) inputRef.current.click();
        }}
        style={({ pressed }) => [
          styles.uploadBtn,
          pressed && styles.pressed,
          uploading && styles.disabled,
        ]}
      >
        <Text style={styles.uploadBtnText}>{uploading ? 'Uploading…' : '+ Upload'}</Text>
      </Pressable>
      {/* DOM-only input rendered via Platform.OS web gate. RN web maps to <input>. */}
      {/* @ts-ignore — DOM input only mounted under Platform.OS === 'web'. */}
      <input
        ref={(el) => {
          inputRef.current = el as HTMLInputElement | null;
        }}
        type="file"
        style={{ display: 'none' }}
        onChange={(e: { target: HTMLInputElement }) => {
          const file = e.target.files?.[0];
          if (file !== null && file !== undefined) {
            onUpload(file);
            e.target.value = '';
          }
        }}
      />
    </View>
  );
}

interface BinaryDeleteConfirmModalProps {
  node: DocTreeNode;
  onCancel(): void;
  onConfirm(): void;
}

export function BinaryDeleteConfirmModal({
  node,
  onCancel,
  onConfirm,
}: BinaryDeleteConfirmModalProps) {
  const styles = useThemedStyles(makeStyles);
  const count = node.referenced_by_count ?? 0;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} testID="docs-binary-delete-confirm">
          <Text style={styles.modalTitle}>Delete {node.name}?</Text>
          <Text style={styles.fileExistsBody}>
            {count === 1
              ? `1 markdown doc still links to this binary.`
              : `${count} markdown docs still link to this binary.`}
            {'\n'}Those links will become broken images / download cards
            until you remove them.
          </Text>
          <View style={styles.modalActions}>
            <Pressable
              onPress={onCancel}
              testID="docs-binary-delete-cancel"
              style={styles.modalCancel}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              testID="docs-binary-delete-confirm-button"
              style={styles.modalConfirm}
            >
              <Text style={styles.modalConfirmText}>Delete anyway</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface RevertConfirmModalProps {
  entry: CommitSummary;
  onCancel(): void;
  onConfirm(): void;
}

export function RevertConfirmModal({ entry, onCancel, onConfirm }: RevertConfirmModalProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} testID="docs-revert-confirm-modal">
          <Text style={styles.modalTitle}>Revert to this version?</Text>
          <Text style={styles.modalLabel}>{entry.sha.slice(0, 7)}</Text>
          <Text style={styles.fileExistsBody}>
            This will overwrite the current file with the content from
            {' '}{formatHistoryDate(entry.author_date)}. The current version
            stays in history — revert creates a new commit on top, it
            doesn’t delete anything.
          </Text>
          <View style={styles.modalActions}>
            <Pressable
              onPress={onCancel}
              testID="docs-revert-cancel"
              style={styles.modalCancel}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              testID="docs-revert-confirm"
              style={styles.modalConfirm}
            >
              <Text style={styles.modalConfirmText}>Revert</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface TreeBranchProps {
  nodes: DocTreeNode[];
  depth: number;
  selectedPath: string | null;
  onSelect(node: DocTreeNode): void;
  onLongPress(node: DocTreeNode): void;
}

export function TreeBranch({ nodes, depth, selectedPath, onSelect, onLongPress }: TreeBranchProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      {nodes.map((node) => {
        const isSelected = node.kind === 'file' && node.path === selectedPath;
        return (
          <View key={node.path}>
            <Pressable
              onPress={() => onSelect(node)}
              onLongPress={() => onLongPress(node)}
              accessibilityRole="button"
              accessibilityLabel={`${node.kind} ${node.path}`}
              testID={`docs-tree-${node.path}`}
              style={({ pressed }) => [
                styles.treeRow,
                isSelected && styles.treeRowSelected,
                pressed && styles.pressed,
                { paddingLeft: 12 + depth * 18 },
              ]}
            >
              <Text style={styles.treeIcon}>{treeIconFor(node)}</Text>
              <Text style={styles.treeLabel} numberOfLines={1}>
                {node.name}
              </Text>
            </Pressable>
            {node.kind === 'folder' && node.children.length > 0 && (
              <TreeBranch
                nodes={node.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onLongPress={onLongPress}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

interface NewFileModalProps {
  visible: boolean;
  onClose(): void;
  onCreate(input: { folder: string; filename: string }): void;
}

export function NewFileModal({ visible, onClose, onCreate }: NewFileModalProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [folder, setFolder] = useState('');
  const [filename, setFilename] = useState('');

  useEffect(() => {
    if (!visible) {
      setFolder('');
      setFilename('');
    }
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} testID="docs-new-file-modal">
          <Text style={styles.modalTitle}>New markdown file</Text>
          <Text style={styles.modalLabel}>Folder (optional)</Text>
          <TextInput
            style={styles.modalInput}
            value={folder}
            onChangeText={setFolder}
            placeholder="notes (leave blank for project root)"
            placeholderTextColor={theme.text_muted}
            testID="docs-new-file-folder"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.modalLabel}>Filename</Text>
          <TextInput
            style={styles.modalInput}
            value={filename}
            onChangeText={setFilename}
            placeholder="my-note (.md added automatically)"
            placeholderTextColor={theme.text_muted}
            testID="docs-new-file-filename"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} testID="docs-new-file-cancel" style={styles.modalCancel}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onCreate({ folder, filename })}
              testID="docs-new-file-confirm"
              style={styles.modalConfirm}
            >
              <Text style={styles.modalConfirmText}>Create</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface FileExistsModalProps {
  path: string;
  onOpen(): void;
  onCancel(): void;
}

export function FileExistsModal({ path, onOpen, onCancel }: FileExistsModalProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} testID="docs-file-exists-modal">
          <Text style={styles.modalTitle}>File already exists</Text>
          <Text style={styles.modalLabel}>{path}</Text>
          <Text style={styles.fileExistsBody}>
            A file with that name already exists. Open it, or cancel and pick a different name?
          </Text>
          <View style={styles.modalActions}>
            <Pressable
              onPress={onCancel}
              testID="docs-file-exists-cancel"
              style={styles.modalCancel}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onOpen}
              testID="docs-file-exists-open"
              style={styles.modalConfirm}
            >
              <Text style={styles.modalConfirmText}>Open existing</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface ActionSheetModalProps {
  node: DocTreeNode;
  onClose(): void;
  onRename(): void;
  onDelete(): void;
}

export function ActionSheetModal({ node, onClose, onRename, onDelete }: ActionSheetModalProps) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} testID="docs-action-sheet">
          <Text style={styles.modalTitle}>{node.path}</Text>
          {node.kind === 'file' && (
            <Pressable
              onPress={onRename}
              testID="docs-action-rename"
              style={({ pressed }) => [styles.actionSheetBtn, pressed && styles.pressed]}
            >
              <Text style={styles.actionSheetText}>Rename / Move</Text>
            </Pressable>
          )}
          <Pressable
            onPress={onDelete}
            testID="docs-action-delete"
            style={({ pressed }) => [
              styles.actionSheetBtn,
              styles.actionSheetDelete,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.actionSheetText, styles.actionSheetDeleteText]}>
              {node.kind === 'file' ? 'Delete file' : 'Delete folder (must be empty)'}
            </Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.actionSheetCancel}>
            <Text style={styles.actionSheetCancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

interface RenameModalProps {
  node: DocTreeNode;
  onClose(): void;
  onRename(to: string): void;
}

export function RenameModal({ node, onClose, onRename }: RenameModalProps) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [next, setNext] = useState(node.path);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} testID="docs-rename-modal">
          <Text style={styles.modalTitle}>Rename / move</Text>
          <Text style={styles.modalLabel}>New path</Text>
          <TextInput
            style={styles.modalInput}
            value={next}
            onChangeText={setNext}
            placeholder="folder/new-name.md"
            placeholderTextColor={theme.text_muted}
            testID="docs-rename-input"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} testID="docs-rename-cancel" style={styles.modalCancel}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onRename(next)}
              testID="docs-rename-confirm"
              style={styles.modalConfirm}
            >
              <Text style={styles.modalConfirmText}>Rename</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export const makeStyles = (theme: NeutronTheme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    centered: { alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
    },
    intro: { flexShrink: 1 },
    backRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    backChevron: { color: theme.text_secondary, fontSize: 26, marginTop: -2 },
    title: { color: theme.text_primary, fontSize: 20, fontWeight: '700' },
    subtitle: { color: theme.text_muted, fontSize: 12, lineHeight: 16 },
    headerActions: { flexDirection: 'row', gap: 8 },
    newBtn: {
      backgroundColor: theme.surface_raised,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    newBtnText: { color: theme.text_primary, fontWeight: '600', fontSize: 13 },
    binaryUploadWrap: { flexDirection: 'row', alignItems: 'center' },
    dropTarget: { flex: 1 },
    uploadBtn: {
      backgroundColor: theme.rail_selected,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: theme.info_border,
    },
    uploadBtnText: { color: theme.text_secondary, fontWeight: '600', fontSize: 13 },
    binaryPreviewWrap: {
      flex: 1,
      padding: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    binaryImage: {
      width: '100%',
      maxWidth: 800,
      aspectRatio: 4 / 3,
      backgroundColor: theme.surface,
      borderRadius: 8,
    },
    binaryMeta: {
      color: theme.text_muted,
      fontSize: 11,
      marginTop: 12,
    },
    binaryDownloadCard: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      padding: 24,
      alignItems: 'center',
      gap: 12,
      minWidth: 280,
    },
    binaryDownloadIcon: { fontSize: 40 },
    binaryDownloadName: { color: theme.text_primary, fontSize: 15, fontWeight: '600', textAlign: 'center' },
    binaryDownloadMeta: { color: theme.text_muted, fontSize: 11 },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.5 },

    body: { flex: 1 },
    centeredBody: { alignItems: 'center', justifyContent: 'center' },
    bodyWide: { flexDirection: 'row' },
    bodyNarrow: { flexDirection: 'column' },
    treePane: {
      backgroundColor: theme.background,
      borderRightWidth: 1,
      borderRightColor: theme.hairline,
    },
    treePaneWide: { width: 260, flexShrink: 0 },
    treePaneNarrow: { borderBottomWidth: 1, borderBottomColor: theme.hairline, maxHeight: 220 },
    treeScroll: { paddingVertical: 8 },
    treeEmpty: { color: theme.text_muted, fontSize: 12, padding: 16 },

    treeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingRight: 12,
      gap: 8,
    },
    treeRowSelected: { backgroundColor: theme.rail_selected },
    treeIcon: { fontSize: 14 },
    treeLabel: { color: theme.text_secondary, fontSize: 13, fontWeight: '500', flex: 1 },

    viewerPane: { backgroundColor: theme.background },
    viewerPaneWide: { flex: 1 },
    viewerPaneNarrow: { flex: 1 },
    viewerEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    viewerEmptyText: { color: theme.text_muted, fontSize: 13, textAlign: 'center' },
    viewerInner: { flex: 1 },
    viewerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
      gap: 12,
    },
    viewerPath: { color: theme.text_secondary, fontSize: 13, fontWeight: '600', flex: 1 },
    viewerActions: { flexDirection: 'row', gap: 8 },
    actionBtn: {
      backgroundColor: theme.surface_raised,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    actionBtnText: { color: theme.text_primary, fontWeight: '600', fontSize: 12 },
    actionBtnGhost: {
      backgroundColor: 'transparent',
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: theme.hairline,
    },
    actionBtnGhostText: { color: theme.text_secondary, fontWeight: '500', fontSize: 12 },

    markdownScroll: { padding: 16, paddingBottom: 32 },

    // P7.3 range UI consumer — single- OR multi-line highlight overlay
    // painted on top of the markdown viewer. Reuses theme.accent at
    // 12% alpha for the fill + 55% alpha for the 2 px left border (no
    // new shade per sprint design discipline). `left: 0` + `right: 0`
    // span the full viewer width; `top` + `height` are computed inline
    // from the current `highlightSpan`. `pointerEvents='none'` keeps
    // the markdown touch targets reachable through the overlay. The
    // alpha values + accent derivation live in the module-level
    // `HIGHLIGHT_OVERLAY_*` constants so a palette tweak in
    // `lib/theme.ts` rolls through by construction.
    highlightOverlay: {
      position: 'absolute',
      left: 0,
      right: 0,
      backgroundColor: withAlpha(theme.accent, HIGHLIGHT_OVERLAY_FILL_ALPHA),
      borderLeftWidth: 2,
      borderLeftColor: withAlpha(theme.accent, HIGHLIGHT_OVERLAY_BORDER_ALPHA),
    },

    editPanes: { flex: 1, flexDirection: 'row' },
    editStack: { flex: 1 },
    mobileToggle: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
    },
    mobileToggleBtn: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
    },
    mobileToggleBtnActive: {
      backgroundColor: theme.rail_selected,
    },
    mobileToggleText: { color: theme.text_secondary, fontSize: 12, fontWeight: '600' },

    editor: {
      flex: 1,
      color: theme.text_primary,
      backgroundColor: theme.background,
      fontSize: 13,
      lineHeight: 20,
      padding: 16,
      fontFamily: 'Menlo',
      textAlignVertical: 'top',
    },
    preview: {
      flex: 1,
      borderLeftWidth: 1,
      borderLeftColor: theme.hairline,
      backgroundColor: theme.background,
    },

    errorBanner: {
      backgroundColor: theme.danger_surface,
      borderColor: theme.danger_border,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 10,
      margin: 12,
      borderRadius: 8,
    },
    errorText: { color: theme.danger, flex: 1, fontSize: 12 },
    errorDismiss: { color: theme.danger, fontWeight: '600', fontSize: 12 },

    conflictBanner: {
      backgroundColor: theme.warning_surface,
      borderColor: theme.warning_border,
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 10,
      margin: 12,
      borderRadius: 8,
      gap: 12,
    },
    conflictText: { color: theme.warning, flex: 1, fontSize: 12, lineHeight: 16 },
    conflictBtn: {
      backgroundColor: theme.warning_border,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 6,
    },
    conflictBtnText: { color: theme.warning, fontWeight: '600', fontSize: 12 },

    modalBackdrop: {
      flex: 1,
      backgroundColor: theme.scrim,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
    },
    modalCard: {
      backgroundColor: theme.background,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.hairline,
      padding: 16,
      width: '100%',
      maxWidth: 480,
      gap: 8,
    },
    modalTitle: { color: theme.text_primary, fontSize: 16, fontWeight: '700', marginBottom: 4 },
    modalLabel: {
      color: theme.text_muted,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 4,
    },
    modalInput: {
      color: theme.text_primary,
      backgroundColor: theme.background,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: theme.hairline,
      fontSize: 13,
    },
    modalActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 12,
    },
    modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
    modalCancelText: { color: theme.text_secondary, fontSize: 13, fontWeight: '500' },
    modalConfirm: {
      backgroundColor: theme.surface_raised,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    modalConfirmText: { color: theme.text_primary, fontSize: 13, fontWeight: '600' },
    fileExistsBody: { color: theme.text_secondary, fontSize: 13, lineHeight: 18, marginTop: 6 },

    actionSheetBtn: {
      paddingVertical: 12,
      paddingHorizontal: 8,
      borderTopWidth: 1,
      borderTopColor: theme.hairline,
    },
    actionSheetText: { color: theme.text_secondary, fontSize: 14 },
    actionSheetDelete: { borderTopColor: theme.hairline },
    actionSheetDeleteText: { color: theme.danger },
    actionSheetCancel: {
      marginTop: 8,
      paddingVertical: 10,
      alignItems: 'center',
      backgroundColor: theme.surface_raised,
      borderRadius: 8,
    },
    actionSheetCancelText: { color: theme.text_primary, fontWeight: '600', fontSize: 13 },

    /* ─── P7.4 history pane + version badge + preview overlay ─── */
    actionBtnGhostActive: { backgroundColor: theme.rail_selected, borderColor: theme.info_border },
    versionBadge: { color: theme.text_muted, fontWeight: '500' },
    historyPane: { backgroundColor: theme.background },
    historyPaneWide: {
      width: 280,
      borderLeftWidth: 1,
      borderLeftColor: theme.hairline,
      flexShrink: 0,
    },
    historyPaneNarrow: {
      borderTopWidth: 1,
      borderTopColor: theme.hairline,
      maxHeight: 280,
    },
    historyHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
    },
    historyTitle: { color: theme.text_primary, fontSize: 14, fontWeight: '700' },
    historyEmpty: { color: theme.text_muted, fontSize: 12, padding: 16 },
    historyScroll: { padding: 8, paddingBottom: 32 },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
      gap: 8,
    },
    historyRowMain: { flex: 1 },
    historyMessage: { color: theme.text_secondary, fontSize: 13, fontWeight: '500' },
    historyMeta: { color: theme.text_muted, fontSize: 11, marginTop: 2 },
    historyRevertBtn: {
      backgroundColor: theme.surface_raised,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    historyRevertText: { color: theme.text_primary, fontWeight: '600', fontSize: 11 },
    historyLoadMore: {
      backgroundColor: theme.background,
      borderRadius: 8,
      paddingVertical: 10,
      marginTop: 8,
      alignItems: 'center',
    },
    historyLoadMoreText: { color: theme.text_secondary, fontSize: 12, fontWeight: '600' },

    previewOverlay: {
      flex: 1,
      backgroundColor: theme.background,
    },
    previewHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.hairline,
      backgroundColor: theme.info_surface,
      gap: 12,
    },
    previewTitle: { color: theme.text_secondary, fontSize: 12, fontWeight: '600', flex: 1 },
  });
