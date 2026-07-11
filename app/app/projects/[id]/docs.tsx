/**
 * @neutronai/app — project-scoped docs tab (P7.0 + P7.1).
 *
 * Per SPEC.md § Phases→Steps (P7 — Doc interface,
 * Obsidian replacement). P7.0 ships the file-tree + read-only viewer;
 * P7.1 adds the markdown editor + live preview + new-file modal +
 * rename/move/delete action sheet via long-press on the tree row.
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Docs                                       [+ New file] │
 *   ├────────────┬───────────────────────────────────────────┤
 *   │ tree pane  │  viewer / editor                          │
 *   └────────────┴───────────────────────────────────────────┘
 *
 * D7 (world-class refactor): this file is now the composition SHELL.
 * The 32-useState / 4-RequestGate state machine was carved into
 * per-cluster hooks under `app/features/docs/` —
 *   • `useDocTree`      — file tree + tree-fetch gate
 *   • `useDocFile`      — open file, editor mode, 409 draft-preserve
 *   • `useDocHistory`   — P7.4 version history pane
 *   • `useDocMutations` — save / create / rename / delete / upload /
 *                         revert, all on ONE mutate gate (the invariant
 *                         the P7.1 review history fixed 4×)
 *   • `useDeepLinkAnchor` — `?path`/`?line`/`?range`/`?folder` +
 *                           highlight overlay + scroll-to-anchor
 * all built on the `useProjectScopedAsync` race-guard primitive
 * (acquire-before-await, isLatest-before-setState, committed reset-on-
 * switch).
 * Leaf components + StyleSheet live in `app/features/docs/docs-ui.tsx`.
 *
 * Concurrency: every PUT carries `expected_modified_at`. A 409 from the
 * gateway surfaces as a banner with a "Reload" button so the user can
 * pull the canonical body without losing their edit (the unsaved draft
 * stays in local state until they click Reload).
 *
 * Layout: side-by-side editor + preview on wide viewports (web /
 * tablets), single-column with a toggle button on narrow viewports
 * (phones). The `useWindowDimensions` width drives the breakpoint at
 * 720 px.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { CommentsSidePane } from '../../../components/CommentsSidePane';
import { DocsDrillList } from '../../../components/DocsDrillList';
import {
  collectPinnedNodes,
  collectRecentNodes,
  folderTitle,
  scopeToFolder,
} from '../../../lib/docs-drill';
import { CommentsProvider } from '../../../lib/comments-state';
import { loadAppConfig } from '../../../lib/config';
import { useAuthSession } from '../../../lib/session';
import { DocsClient, type DocTreeNode } from '../../../lib/docs-client';

import { type MobilePane } from '../../../features/docs/docs-shared';
import {
  ActionSheetModal,
  BinaryDeleteConfirmModal,
  BinaryUploadButton,
  FileExistsModal,
  NewFileModal,
  RenameModal,
  RevertConfirmModal,
  TreeBranch,
  styles,
} from '../../../features/docs/docs-ui';
import { DocHistoryPane, DocViewerPane } from '../../../features/docs/docs-panes';
import { useDocTree } from '../../../features/docs/use-doc-tree';
import { useDocFile } from '../../../features/docs/use-doc-file';
import { useDocHistory } from '../../../features/docs/use-doc-history';
import { useDocMutations } from '../../../features/docs/use-doc-mutations';
import { useDeepLinkAnchor } from '../../../features/docs/use-deep-link-anchor';

export default function DocsTab() {
  const {
    id,
    path: pathParam,
    line: lineParam,
    range: rangeParam,
    folder: folderParam,
  } = useLocalSearchParams<{
    id: string;
    path?: string;
    line?: string;
    range?: string;
    folder?: string;
  }>();
  const project_id = typeof id === 'string' ? id : '';
  const router = useRouter();
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const client = useMemo(() => {
    if (user === null) return null;
    return new DocsClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const { width } = useWindowDimensions();
  const wideViewport = width >= 720;

  // ─── data clusters (see module header) ───
  const docFile = useDocFile({ client, project_id });
  const docTree = useDocTree({ client, project_id, setError: docFile.setError });
  const docHistory = useDocHistory({
    client,
    project_id,
    file: docFile.file,
    setError: docFile.setError,
  });
  const docMutations = useDocMutations({
    client,
    project_id,
    file: docFile.file,
    selectedPath: docFile.selectedPath,
    draftContent: docFile.draftContent,
    mode: docFile.mode,
    setFile: docFile.setFile,
    setSelectedPath: docFile.setSelectedPath,
    setDraftContent: docFile.setDraftContent,
    setMode: docFile.setMode,
    setConflict: docFile.setConflict,
    setError: docFile.setError,
    fetchFile: docFile.fetchFile,
    fetchTree: docTree.fetchTree,
    setTree: docTree.setTree,
    loadHistory: docHistory.loadHistory,
    setPreviewVersion: docHistory.setPreviewVersion,
    setHistoryEntries: docHistory.setHistoryEntries,
    setHistoryCursor: docHistory.setHistoryCursor,
    setHistoryOpen: docHistory.setHistoryOpen,
    setRevertConfirm: docHistory.setRevertConfirm,
    setRevertingSha: docHistory.setRevertingSha,
  });
  const anchor = useDeepLinkAnchor({
    pathParam,
    lineParam,
    rangeParam,
    folderParam,
    file: docFile.file,
    selectedPath: docFile.selectedPath,
    mode: docFile.mode,
    loadingTree: docTree.loadingTree,
    setFile: docFile.setFile,
    setSelectedPath: docFile.setSelectedPath,
    fetchFile: docFile.fetchFile,
  });

  // DocsTab renders the header, error banner, tree/drill panes, the
  // side pane, and the modals; the `docFile` / `docHistory` /
  // `docMutations` / `anchor` objects are handed whole to the extracted
  // panes. Only the fields the SHELL itself references are destructured.
  const { file, selectedPath, error, setError, setDraftContent, setMode, fetchFile } = docFile;
  const { tree, loadingTree } = docTree;
  const {
    historyOpen,
    loadHistoryRef,
    setHistoryOpen,
    setHistoryEntries,
    setHistoryCursor,
    setPreviewVersion,
    setHistoryUnavailable,
    revertConfirm,
    setRevertConfirm,
  } = docHistory;
  const {
    newFileOpen,
    setNewFileOpen,
    actionSheet,
    setActionSheet,
    renameTarget,
    setRenameTarget,
    existingFileConflict,
    setExistingFileConflict,
    binaryDeleteTarget,
    setBinaryDeleteTarget,
    uploadingBinary,
    handleUploadBinary,
    handleConfirmBinaryDelete,
    handleRevertConfirm,
    handleCreateFile,
    handleOpenExisting,
    handleDelete,
    handleRename,
  } = docMutations;
  const {
    folderPath,
    deepLinkPath,
    handleScrollToAnchor,
    formatAnchorLineLabelForSidePane,
  } = anchor;

  // P7.2 S3 — controlled open state for the comments side-pane + the
  // narrow-viewport pane selector. Pure view state (no gate / async),
  // so it stays in the composition rather than a data hook.
  const [mobilePane, setMobilePane] = useState<MobilePane>('editor');
  const [commentsPaneOpen, setCommentsPaneOpen] = useState(false);

  const handleSelect = useCallback(
    (node: DocTreeNode) => {
      if (node.kind === 'folder') return;
      if (node.kind === 'binary') {
        // P7.5 — binaries route to a read-only preview pane instead of
        // the editor. Clear the file body + history so the binary
        // preview can render without leaking the previous markdown's
        // edit state.
        docFile.setSelectedPath(node.path);
        docFile.setFile(null);
        setDraftContent('');
        setMode('view');
        setHistoryEntries([]);
        setHistoryCursor(null);
        setHistoryOpen(false);
        setPreviewVersion(null);
        return;
      }
      docFile.setSelectedPath(node.path);
      void fetchFile(node.path);
      // Selecting a new file invalidates any open preview / pending
      // history page; the next history toggle will re-fetch fresh.
      setPreviewVersion(null);
      setHistoryEntries([]);
      setHistoryCursor(null);
      setHistoryUnavailable(false);
      // If the history pane is open, load history for the newly-
      // selected file IMMEDIATELY rather than waiting for the user to
      // close + reopen the pane. Codex r1 P2.
      if (historyOpen) {
        void loadHistoryRef.current?.(node.path);
      }
    },
    // Setters (stable useState dispatchers) + loadHistoryRef (a ref) are
    // intentionally omitted, matching the pre-D7 handleSelect deps
    // `[fetchFile, historyOpen]` so its identity (and TreeBranch
    // re-renders) stay unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fetchFile, historyOpen],
  );

  // PR-5 — phone drill-down navigation. A folder tap pushes a scoped list; a
  // file tap pushes the full-screen viewer. Each push is a new screen so the
  // native back gesture / hardware back returns up the stack (the iOS Files
  // pattern). Wide/tablet keeps the inline 2-pane and never calls these.
  const openFolder = useCallback(
    (dirPath: string) => {
      router.push(
        `/projects/${encodeURIComponent(project_id)}/docs?folder=${encodeURIComponent(dirPath)}`,
      );
    },
    [router, project_id],
  );
  const openFileScreen = useCallback(
    (filePath: string) => {
      router.push(
        `/projects/${encodeURIComponent(project_id)}/docs?path=${encodeURIComponent(filePath)}`,
      );
    },
    [router, project_id],
  );
  // The node list at the current drill level: whole tree at root, a folder's
  // children when drilled in, or null for an unresolvable folder path.
  const scopedNodes = useMemo(() => scopeToFolder(tree, folderPath), [tree, folderPath]);

  // Phone shows EITHER the drill list (no open file) OR the full-screen viewer
  // (a file is open via `?path`). Wide/tablet always shows the inline 2-pane.
  const showDrillList = !wideViewport && deepLinkPath === null;
  const showBack = !wideViewport && (folderPath !== null || deepLinkPath !== null);

  if (user === null) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color="#cfcfcf" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.intro}>
          {showBack ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              testID="docs-drill-back"
              onPress={() => router.back()}
              style={({ pressed }) => [styles.backRow, pressed && styles.pressed]}
            >
              <Text style={styles.backChevron}>‹</Text>
              <Text style={styles.title} numberOfLines={1}>
                {folderPath !== null ? folderTitle(folderPath) : 'Docs'}
              </Text>
            </Pressable>
          ) : (
            <>
              <Text style={styles.title}>Docs</Text>
              {wideViewport ? (
                <Text style={styles.subtitle}>
                  Project-scoped markdown — edit lives in the right pane.
                </Text>
              ) : null}
            </>
          )}
        </View>
        <View style={styles.headerActions}>
          {Platform.OS === 'web' && (
            <BinaryUploadButton
              uploading={uploadingBinary}
              onUpload={handleUploadBinary}
            />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New file"
            testID="docs-new-file-button"
            onPress={() => setNewFileOpen(true)}
            style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
          >
            <Text style={styles.newBtnText}>+ New file</Text>
          </Pressable>
        </View>
      </View>

      {error !== null && (
        <View style={styles.errorBanner} testID="docs-error-banner">
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => setError(null)}>
            <Text style={styles.errorDismiss}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {showDrillList ? (
        loadingTree ? (
          <View style={[styles.body, styles.centeredBody]}>
            <ActivityIndicator color="#cfcfcf" />
          </View>
        ) : tree.length === 0 ? (
          <View style={styles.body}>
            <Text style={styles.treeEmpty}>No docs yet — tap “+ New file” to create one.</Text>
          </View>
        ) : scopedNodes === null ? (
          <View style={styles.body}>
            <Text style={styles.treeEmpty}>This folder isn’t here anymore.</Text>
          </View>
        ) : (
          <DocsDrillList
            nodes={scopedNodes}
            pinned={folderPath === null ? collectPinnedNodes(tree) : []}
            recent={folderPath === null ? collectRecentNodes(tree) : []}
            onOpenFolder={openFolder}
            onOpenFile={openFileScreen}
            onLongPress={(node) => setActionSheet(node)}
          />
        )
      ) : (
      <View style={[styles.body, wideViewport ? styles.bodyWide : styles.bodyNarrow]}>
        {wideViewport ? (
        <View style={[styles.treePane, styles.treePaneWide]}>
          {loadingTree ? (
            <ActivityIndicator color="#cfcfcf" />
          ) : (
            <ScrollView contentContainerStyle={styles.treeScroll}>
              {tree.length === 0 ? (
                <Text style={styles.treeEmpty}>
                  No docs yet — tap “+ New file” to create one.
                </Text>
              ) : (
                <TreeBranch
                  nodes={tree}
                  depth={0}
                  selectedPath={selectedPath}
                  onSelect={handleSelect}
                  onLongPress={(node) => setActionSheet(node)}
                />
              )}
            </ScrollView>
          )}
        </View>
        ) : null}

        <DocViewerPane
          docFile={docFile}
          docHistory={docHistory}
          docMutations={docMutations}
          anchor={anchor}
          tree={tree}
          client={client}
          project_id={project_id}
          wideViewport={wideViewport}
          commentsPaneOpen={commentsPaneOpen}
          setCommentsPaneOpen={setCommentsPaneOpen}
          mobilePane={mobilePane}
          setMobilePane={setMobilePane}
        />
        {historyOpen && file !== null && (
          <DocHistoryPane docHistory={docHistory} file={file} wideViewport={wideViewport} />
        )}
      </View>
      )}

      {wideViewport && file !== null && (
        <CommentsProvider project_id={project_id} doc_path={file.path}>
          <CommentsSidePane
            project_id={project_id}
            doc_path={file.path}
            on_scroll_to_anchor={handleScrollToAnchor}
            open={commentsPaneOpen}
            on_close={() => setCommentsPaneOpen(false)}
            format_anchor_line_label={formatAnchorLineLabelForSidePane}
          />
        </CommentsProvider>
      )}

      <NewFileModal
        visible={newFileOpen}
        onClose={() => setNewFileOpen(false)}
        onCreate={handleCreateFile}
      />

      {existingFileConflict !== null && (
        <FileExistsModal
          path={existingFileConflict}
          onOpen={handleOpenExisting}
          onCancel={() => setExistingFileConflict(null)}
        />
      )}

      {actionSheet !== null && renameTarget === null && (
        <ActionSheetModal
          node={actionSheet}
          onClose={() => setActionSheet(null)}
          onRename={() => setRenameTarget(actionSheet)}
          onDelete={() => handleDelete(actionSheet)}
        />
      )}

      {renameTarget !== null && (
        <RenameModal
          node={renameTarget}
          onClose={() => {
            setRenameTarget(null);
            setActionSheet(null);
          }}
          onRename={(toPath) => handleRename(renameTarget, toPath)}
        />
      )}

      {revertConfirm !== null && (
        <RevertConfirmModal
          entry={revertConfirm}
          onCancel={() => setRevertConfirm(null)}
          onConfirm={() => handleRevertConfirm(revertConfirm)}
        />
      )}

      {binaryDeleteTarget !== null && (
        <BinaryDeleteConfirmModal
          node={binaryDeleteTarget}
          onCancel={() => setBinaryDeleteTarget(null)}
          onConfirm={() => handleConfirmBinaryDelete(binaryDeleteTarget)}
        />
      )}
    </View>
  );
}
