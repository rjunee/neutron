/**
 * @neutronai/app — composed panes for the docs tab (D7 refactor):
 * `DocViewerPane` (the reader / editor / binary-preview / version-
 * preview surface) and `DocHistoryPane` (the P7.4 history list). These
 * are the two large JSX blocks lifted out of `DocsTab` so the shell
 * stays composition-sized. They take the `use-doc-*` hook objects
 * whole (rather than 30 individual props) so the wiring is
 * type-checked against the hook contracts and can't drift.
 */

import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CommentsSidePane } from '../../components/CommentsSidePane';
import { CommentsProvider } from '../../lib/comments-state';
import { RenderMarkdown } from '../../lib/markdown-render';
import { DocsClient, type DocFile, type DocTreeNode } from '../../lib/docs-client';

import {
  BODY_LINE_HEIGHT,
  MARKDOWN_SCROLL_PADDING_TOP,
  findBinaryNode,
  formatHistoryDate,
  type MobilePane,
} from './docs-shared';
import { BinaryPreview, EditorDropTarget, styles } from './docs-ui';
import { type UseDocFile } from './use-doc-file';
import { type UseDocHistory } from './use-doc-history';
import { type UseDocMutations } from './use-doc-mutations';
import { type UseDeepLinkAnchor } from './use-deep-link-anchor';

interface DocViewerPaneProps {
  docFile: UseDocFile;
  docHistory: UseDocHistory;
  docMutations: UseDocMutations;
  anchor: UseDeepLinkAnchor;
  tree: DocTreeNode[];
  client: DocsClient | null;
  project_id: string;
  wideViewport: boolean;
  commentsPaneOpen: boolean;
  setCommentsPaneOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mobilePane: MobilePane;
  setMobilePane: React.Dispatch<React.SetStateAction<MobilePane>>;
}

export function DocViewerPane({
  docFile,
  docHistory,
  docMutations,
  anchor,
  tree,
  client,
  project_id,
  wideViewport,
  commentsPaneOpen,
  setCommentsPaneOpen,
  mobilePane,
  setMobilePane,
}: DocViewerPaneProps) {
  const { file, selectedPath, mode, draftContent, conflict, setDraftContent, setMode, handleReload, resolveBinary } =
    docFile;
  const { historyEntries, historyCursor, historyOpen, handleToggleHistory, previewVersion, handleExitPreview } =
    docHistory;
  const { saving, handleSave, handleEditorDrop, dragOver, setDragOver, setEditorSelection } = docMutations;
  const { handleScrollToAnchor, formatAnchorLineLabelForSidePane, viewerScrollRef, highlightSpan } = anchor;

  return (
    <View
      style={[
        styles.viewerPane,
        wideViewport ? styles.viewerPaneWide : styles.viewerPaneNarrow,
      ]}
    >
      {file === null ? (
        // P7.5 — if the selected node is a binary, render the
        // dedicated BinaryPreview instead of the "Loading…" empty
        // state (we never fetch a markdown body for binaries).
        (() => {
          const binaryNode =
            selectedPath !== null
              ? findBinaryNode(tree, selectedPath)
              : null;
          if (binaryNode !== null && client !== null) {
            return (
              <BinaryPreview
                node={binaryNode}
                source={client.binaryUrl(project_id, binaryNode.path)}
              />
            );
          }
          return (
            <View style={styles.viewerEmpty}>
              <Text style={styles.viewerEmptyText}>
                {selectedPath === null
                  ? 'Pick a doc from the tree to read or edit.'
                  : 'Loading…'}
              </Text>
            </View>
          );
        })()
      ) : (
        <View style={styles.viewerInner} testID="docs-viewer">
          <View style={styles.viewerHeader}>
            <Text style={styles.viewerPath} numberOfLines={1}>
              {file.path}
              {historyEntries.length > 0 && (
                <Text style={styles.versionBadge}>
                  {' · v'}
                  {historyEntries.length}
                  {historyCursor !== null ? '+' : ''}
                </Text>
              )}
            </Text>
            <View style={styles.viewerActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Toggle comments side pane"
                testID="docs-comments-toggle"
                onPress={() => {
                  const next = !commentsPaneOpen;
                  setCommentsPaneOpen(next);
                  if (next && !wideViewport) setMobilePane('comments');
                  else if (!next && !wideViewport && mobilePane === 'comments') {
                    setMobilePane('editor');
                  }
                }}
                style={({ pressed }) => [
                  styles.actionBtnGhost,
                  commentsPaneOpen && styles.actionBtnGhostActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.actionBtnGhostText}>💬 Comments</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Toggle history pane"
                testID="docs-history-toggle"
                onPress={handleToggleHistory}
                style={({ pressed }) => [
                  styles.actionBtnGhost,
                  historyOpen && styles.actionBtnGhostActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.actionBtnGhostText}>History</Text>
              </Pressable>
              {mode === 'view' ? (
                <Pressable
                  accessibilityRole="button"
                  testID="docs-edit-button"
                  onPress={() => {
                    setDraftContent(file.content);
                    setMode('edit');
                    setMobilePane('editor');
                  }}
                  style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.actionBtnText}>Edit</Text>
                </Pressable>
              ) : (
                <>
                  <Pressable
                    accessibilityRole="button"
                    testID="docs-cancel-button"
                    onPress={() => {
                      setDraftContent(file.content);
                      setMode('view');
                    }}
                    style={({ pressed }) => [styles.actionBtnGhost, pressed && styles.pressed]}
                  >
                    <Text style={styles.actionBtnGhostText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    testID="docs-save-button"
                    disabled={saving}
                    onPress={handleSave}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      pressed && styles.pressed,
                      saving && styles.disabled,
                    ]}
                  >
                    <Text style={styles.actionBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
          {conflict && (
            <View style={styles.conflictBanner} testID="docs-conflict-banner">
              <Text style={styles.conflictText}>
                File changed elsewhere — your edits are still in this box. Reload to see the
                latest, then merge by hand.
              </Text>
              <Pressable
                onPress={handleReload}
                testID="docs-reload-button"
                style={styles.conflictBtn}
              >
                <Text style={styles.conflictBtnText}>Reload</Text>
              </Pressable>
            </View>
          )}
          {!wideViewport && commentsPaneOpen && mobilePane === 'comments' ? (
            <CommentsProvider project_id={project_id} doc_path={file.path}>
              <CommentsSidePane
                project_id={project_id}
                doc_path={file.path}
                on_scroll_to_anchor={handleScrollToAnchor}
                open
                on_close={() => {
                  setCommentsPaneOpen(false);
                  setMobilePane('editor');
                }}
                embed
                format_anchor_line_label={formatAnchorLineLabelForSidePane}
              />
            </CommentsProvider>
          ) : mode === 'view' ? (
            <ScrollView
              ref={viewerScrollRef}
              contentContainerStyle={styles.markdownScroll}
              testID="docs-viewer-scroll"
            >
              {highlightSpan !== null && (
                <View
                  pointerEvents="none"
                  testID={
                    highlightSpan.startLine === highlightSpan.endLine
                      ? `docs-viewer-highlight-line-${highlightSpan.startLine}`
                      : `docs-viewer-highlight-range-${highlightSpan.startLine}-${highlightSpan.endLine}`
                  }
                  style={[
                    styles.highlightOverlay,
                    {
                      top:
                        MARKDOWN_SCROLL_PADDING_TOP +
                        (highlightSpan.startLine - 1) * BODY_LINE_HEIGHT,
                      height:
                        (highlightSpan.endLine - highlightSpan.startLine + 1) *
                        BODY_LINE_HEIGHT,
                    },
                  ]}
                />
              )}
              <RenderMarkdown source={file.content} binarySource={resolveBinary} />
            </ScrollView>
          ) : wideViewport ? (
            <View style={styles.editPanes}>
              <EditorDropTarget
                onDropFile={handleEditorDrop}
                dragOver={dragOver}
                setDragOver={setDragOver}
              >
                <TextInput
                  multiline
                  value={draftContent}
                  onChangeText={setDraftContent}
                  onSelectionChange={(e) =>
                    setEditorSelection(e.nativeEvent.selection)
                  }
                  style={styles.editor}
                  placeholder="Start writing markdown…"
                  placeholderTextColor="#5a5a5a"
                  testID="docs-editor-input"
                />
              </EditorDropTarget>
              <ScrollView
                style={styles.preview}
                contentContainerStyle={styles.markdownScroll}
              >
                <RenderMarkdown source={draftContent} binarySource={resolveBinary} />
              </ScrollView>
            </View>
          ) : (
            <View style={styles.editStack}>
              <View style={styles.mobileToggle}>
                <Pressable
                  onPress={() => setMobilePane('editor')}
                  style={[
                    styles.mobileToggleBtn,
                    mobilePane === 'editor' && styles.mobileToggleBtnActive,
                  ]}
                  testID="docs-mobile-toggle-editor"
                >
                  <Text style={styles.mobileToggleText}>Editor</Text>
                </Pressable>
                <Pressable
                  onPress={() => setMobilePane('preview')}
                  style={[
                    styles.mobileToggleBtn,
                    mobilePane === 'preview' && styles.mobileToggleBtnActive,
                  ]}
                  testID="docs-mobile-toggle-preview"
                >
                  <Text style={styles.mobileToggleText}>Preview</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setMobilePane('comments');
                    setCommentsPaneOpen(true);
                  }}
                  style={[
                    styles.mobileToggleBtn,
                    mobilePane === 'comments' && styles.mobileToggleBtnActive,
                  ]}
                  testID="docs-mobile-toggle-comments"
                >
                  <Text style={styles.mobileToggleText}>💬</Text>
                </Pressable>
              </View>
              {mobilePane === 'comments' ? (
                <CommentsProvider project_id={project_id} doc_path={file.path}>
                  <CommentsSidePane
                    project_id={project_id}
                    doc_path={file.path}
                    on_scroll_to_anchor={handleScrollToAnchor}
                    open
                    on_close={() => {
                      setCommentsPaneOpen(false);
                      setMobilePane('editor');
                    }}
                    embed
                  />
                </CommentsProvider>
              ) : mobilePane === 'editor' ? (
                <EditorDropTarget
                  onDropFile={handleEditorDrop}
                  dragOver={dragOver}
                  setDragOver={setDragOver}
                >
                  <TextInput
                    multiline
                    value={draftContent}
                    onChangeText={setDraftContent}
                    onSelectionChange={(e) =>
                      setEditorSelection(e.nativeEvent.selection)
                    }
                    style={styles.editor}
                    placeholder="Start writing markdown…"
                    placeholderTextColor="#5a5a5a"
                    testID="docs-editor-input"
                  />
                </EditorDropTarget>
              ) : (
                <ScrollView contentContainerStyle={styles.markdownScroll}>
                  <RenderMarkdown source={draftContent} binarySource={resolveBinary} />
                </ScrollView>
              )}
            </View>
          )}
          {previewVersion !== null && (
            <View style={styles.previewOverlay} testID="docs-version-preview">
              <View style={styles.previewHeader}>
                <Text style={styles.previewTitle} numberOfLines={1}>
                  Viewing {previewVersion.sha.slice(0, 7)} ·{' '}
                  {previewVersion.message}
                </Text>
                <Pressable
                  onPress={handleExitPreview}
                  testID="docs-version-preview-exit"
                  style={({ pressed }) => [
                    styles.actionBtnGhost,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.actionBtnGhostText}>Exit preview</Text>
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={styles.markdownScroll}>
                <RenderMarkdown source={previewVersion.content} binarySource={resolveBinary} />
              </ScrollView>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

interface DocHistoryPaneProps {
  docHistory: UseDocHistory;
  file: DocFile;
  wideViewport: boolean;
}

export function DocHistoryPane({ docHistory, file, wideViewport }: DocHistoryPaneProps) {
  const {
    historyUnavailable,
    historyLoading,
    historyEntries,
    historyCursor,
    revertingSha,
    handlePreviewVersion,
    setRevertConfirm,
    loadHistory,
    setHistoryOpen,
  } = docHistory;

  return (
    <View
      testID="docs-history-pane"
      style={[
        styles.historyPane,
        wideViewport ? styles.historyPaneWide : styles.historyPaneNarrow,
      ]}
    >
      <View style={styles.historyHeader}>
        <Text style={styles.historyTitle}>History</Text>
        <Pressable
          onPress={() => setHistoryOpen(false)}
          testID="docs-history-close"
          style={({ pressed }) => [
            styles.actionBtnGhost,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.actionBtnGhostText}>Close</Text>
        </Pressable>
      </View>
      {historyUnavailable ? (
        <Text style={styles.historyEmpty}>
          Versioning isn’t available on this gateway. Edits still save,
          but no history is kept.
        </Text>
      ) : historyLoading && historyEntries.length === 0 ? (
        <ActivityIndicator color="#cfcfcf" />
      ) : historyEntries.length === 0 ? (
        <Text style={styles.historyEmpty}>
          This file has no version history yet.
        </Text>
      ) : (
        <ScrollView contentContainerStyle={styles.historyScroll}>
          {historyEntries.map((entry, idx) => {
            const version = historyEntries.length - idx;
            const isReverting = revertingSha === entry.sha;
            return (
              <View
                key={entry.sha}
                style={styles.historyRow}
                testID={`docs-history-row-${entry.sha}`}
              >
                <Pressable
                  onPress={() => handlePreviewVersion(entry)}
                  testID={`docs-history-preview-${entry.sha}`}
                  style={({ pressed }) => [
                    styles.historyRowMain,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.historyMessage} numberOfLines={2}>
                    {entry.message}
                  </Text>
                  <Text style={styles.historyMeta}>
                    v{version} · {formatHistoryDate(entry.author_date)} ·{' '}
                    {entry.sha.slice(0, 7)}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setRevertConfirm(entry)}
                  disabled={isReverting}
                  testID={`docs-history-revert-${entry.sha}`}
                  style={({ pressed }) => [
                    styles.historyRevertBtn,
                    pressed && styles.pressed,
                    isReverting && styles.disabled,
                  ]}
                >
                  <Text style={styles.historyRevertText}>
                    {isReverting ? 'Reverting…' : 'Revert'}
                  </Text>
                </Pressable>
              </View>
            );
          })}
          {historyCursor !== null && (
            <Pressable
              onPress={() => void loadHistory(file.path, historyCursor)}
              testID="docs-history-load-more"
              disabled={historyLoading}
              style={({ pressed }) => [
                styles.historyLoadMore,
                pressed && styles.pressed,
                historyLoading && styles.disabled,
              ]}
            >
              <Text style={styles.historyLoadMoreText}>
                {historyLoading ? 'Loading…' : 'Load more'}
              </Text>
            </Pressable>
          )}
        </ScrollView>
      )}
    </View>
  );
}
