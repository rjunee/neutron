/**
 * @neutronai/app — D7 RENDER coverage for the extracted presentational
 * panes (`DocViewerPane`, `DocHistoryPane`).
 *
 * The panes are pure (no hooks) → we call them directly and walk the
 * returned React element tree (we never mount/invoke the host stubs), so
 * we get executable proof of WHICH branch renders for a given hook state,
 * not just that identifiers survive in the source.
 *
 * react-native can't be parsed by bun (Flow) and the heavy pane children
 * (RenderMarkdown / CommentsSidePane / CommentsProvider) pull Flow-typed
 * deps too — all are stubbed as trivial element TYPES. The RN stub is a
 * SUPERSET of every export the docs modules import. Crucially, the mocks
 * are registered AND `docs-panes` is imported inside `beforeAll`, so this
 * file's superset stub is guaranteed active when docs-panes/docs-ui link
 * — robust to the sibling diagnostics-pane-render suite (the only other
 * react-native mocker) winning the global registration under `bun test`.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';

const stub = (name: string) => {
  const C = () => null;
  Object.defineProperty(C, 'name', { value: name });
  return C;
};

let P: any;
beforeAll(async () => {
  mock.module('react-native', () => ({
    View: stub('View'),
    Text: stub('Text'),
    Pressable: stub('Pressable'),
    ScrollView: stub('ScrollView'),
    TextInput: stub('TextInput'),
    ActivityIndicator: stub('ActivityIndicator'),
    Image: stub('Image'),
    Modal: stub('Modal'),
    Linking: { openURL: () => Promise.resolve() },
    Platform: { OS: 'web' },
    StyleSheet: { create: (s: Record<string, unknown>) => s },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
  }));
  mock.module('../lib/markdown-render', () => ({ RenderMarkdown: stub('RenderMarkdown') }));
  mock.module('../lib/comments-state', () => ({ CommentsProvider: stub('CommentsProvider') }));
  mock.module('../components/CommentsSidePane', () => ({ CommentsSidePane: stub('CommentsSidePane') }));
  P = await import('../features/docs/docs-panes');
});

// Walk the element tree collecting testIDs, host types (by stub name), and
// string children.
function walk(node: unknown, out: { ids: string[]; types: string[]; texts: string[] }): void {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return; }
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return; }
  if (typeof node === 'object') {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === 'function' && (el.type as { name?: string }).name) {
      out.types.push((el.type as { name: string }).name);
    }
    if (el.props) {
      if (typeof el.props.testID === 'string') out.ids.push(el.props.testID);
      walk(el.props.children, out);
    }
  }
}
function render(el: unknown) {
  const out = { ids: [] as string[], types: [] as string[], texts: [] as string[] };
  walk(el, out);
  return out;
}

// ── shared prop scaffolding ───────────────────────────────────────────
const anchor = {
  handleScrollToAnchor: () => {},
  formatAnchorLineLabelForSidePane: () => null,
  viewerScrollRef: { current: null },
  highlightSpan: null,
};
const docHistoryBase = {
  historyEntries: [] as unknown[],
  historyCursor: null,
  historyOpen: false,
  handleToggleHistory: () => {},
  previewVersion: null,
  handleExitPreview: () => {},
};
const docMutations = {
  saving: false,
  handleSave: () => {},
  handleEditorDrop: () => {},
  dragOver: false,
  setDragOver: () => {},
  setEditorSelection: () => {},
};
const fileState = (over: Record<string, unknown>) => ({
  file: null,
  selectedPath: null,
  mode: 'view' as const,
  draftContent: '',
  conflict: false,
  setDraftContent: () => {},
  setMode: () => {},
  handleReload: () => {},
  resolveBinary: undefined,
  ...over,
});
const viewerProps = (over: Record<string, unknown>) => ({
  docFile: fileState({}),
  docHistory: docHistoryBase,
  docMutations,
  anchor,
  tree: [],
  client: null,
  project_id: 'P',
  wideViewport: true,
  commentsPaneOpen: false,
  setCommentsPaneOpen: () => {},
  mobilePane: 'editor' as const,
  setMobilePane: () => {},
  ...over,
});
const OPEN = { path: 'notes/a.md', content: '# hi', size_bytes: 4, modified_at: 1 };

describe('DocViewerPane — render branches (mount + walk)', () => {
  it('EMPTY: no file, nothing selected → the pick-a-doc prompt (no viewer)', () => {
    const { ids, texts } = render(P.DocViewerPane(viewerProps({ docFile: fileState({}) })));
    expect(ids).not.toContain('docs-viewer');
    expect(texts.join(' ')).toContain('Pick a doc from the tree');
  });

  it('LOADING: a markdown path selected but file not yet loaded → "Loading…"', () => {
    const { texts } = render(P.DocViewerPane(viewerProps({ docFile: fileState({ selectedPath: 'notes/a.md' }) })));
    expect(texts.join(' ')).toContain('Loading');
  });

  it('BINARY: file null + a binary node selected → BinaryPreview (never markdown)', () => {
    const binary = { kind: 'binary', path: 'img/a.png', name: 'a.png', content_type: 'image/png', size_bytes: 10 };
    const { types, texts } = render(P.DocViewerPane(viewerProps({
      docFile: fileState({ selectedPath: 'img/a.png' }),
      tree: [binary],
      client: { binaryUrl: () => ({ uri: 'u', headers: {} }) },
    })));
    // Remove the binary-node branch in DocViewerPane → falls to "Loading…" → red.
    expect(types).toContain('BinaryPreview');
    expect(texts.join(' ')).not.toContain('Loading');
  });

  it('VIEWER (view mode): renders docs-viewer + the file path + RenderMarkdown', () => {
    const { ids, types, texts } = render(P.DocViewerPane(viewerProps({ docFile: fileState({ file: OPEN, selectedPath: OPEN.path, mode: 'view', draftContent: OPEN.content }) })));
    // Wrap the file!==null viewer body in `false && (…)` → docs-viewer gone → red.
    expect(ids).toContain('docs-viewer');
    expect(texts.join(' ')).toContain('notes/a.md');
    expect(types).toContain('RenderMarkdown');
  });

  it('EDITOR (edit mode, wide): renders the editor input + side-by-side panes', () => {
    const { ids } = render(P.DocViewerPane(viewerProps({ wideViewport: true, docFile: fileState({ file: OPEN, selectedPath: OPEN.path, mode: 'edit', draftContent: OPEN.content }) })));
    // Remove the wideViewport edit branch → no editor input → red.
    expect(ids).toContain('docs-editor-input');
  });

  it('EDITOR (edit mode, narrow): renders the mobile editor/preview/comments toggle', () => {
    const { ids } = render(P.DocViewerPane(viewerProps({ wideViewport: false, docFile: fileState({ file: OPEN, selectedPath: OPEN.path, mode: 'edit', draftContent: OPEN.content }) })));
    // The narrow branch (editStack + mobileToggle) only renders when !wideViewport.
    expect(ids).toContain('docs-mobile-toggle-editor');
    expect(ids).toContain('docs-mobile-toggle-preview');
  });
});

describe('DocHistoryPane — render branches', () => {
  const file = { path: 'notes/a.md', content: '', size_bytes: 0, modified_at: 1 };
  const entry = (sha: string, message: string) => ({ sha, message, author_date: '2026-01-01T00:00:00Z' });

  it('ROWS: one row per historyEntries entry (+ the entry message text)', () => {
    const { ids, texts } = render(P.DocHistoryPane({
      docHistory: { ...docHistoryBase, historyEntries: [entry('abc1234', 'first commit')], loadHistory: () => {}, setHistoryOpen: () => {}, handlePreviewVersion: () => {}, setRevertConfirm: () => {}, revertingSha: null, historyLoading: false, historyUnavailable: false },
      file,
      wideViewport: true,
    }));
    // Stop mapping historyEntries → docs-history-row-* gone → red.
    expect(ids).toContain('docs-history-pane');
    expect(ids).toContain('docs-history-row-abc1234');
    expect(texts.join(' ')).toContain('first commit');
  });

  it('EMPTY: no entries → the "no version history yet" notice', () => {
    const { texts } = render(P.DocHistoryPane({
      docHistory: { ...docHistoryBase, historyEntries: [], loadHistory: () => {}, setHistoryOpen: () => {}, handlePreviewVersion: () => {}, setRevertConfirm: () => {}, revertingSha: null, historyLoading: false, historyUnavailable: false },
      file,
      wideViewport: true,
    }));
    expect(texts.join(' ')).toContain('no version history');
  });

  it('UNAVAILABLE: the hook flags it → the versioning-unavailable notice', () => {
    const { texts } = render(P.DocHistoryPane({
      docHistory: { ...docHistoryBase, historyUnavailable: true, historyEntries: [], loadHistory: () => {}, setHistoryOpen: () => {}, handlePreviewVersion: () => {}, setRevertConfirm: () => {}, revertingSha: null, historyLoading: false },
      file,
      wideViewport: true,
    }));
    expect(texts.join(' ')).toContain('Versioning isn’t available');
  });

  it('WIDE vs NARROW: the pane still renders its testID at both breakpoints', () => {
    const base = { ...docHistoryBase, historyEntries: [entry('s', 'm')], loadHistory: () => {}, setHistoryOpen: () => {}, handlePreviewVersion: () => {}, setRevertConfirm: () => {}, revertingSha: null, historyLoading: false, historyUnavailable: false };
    expect(render(P.DocHistoryPane({ docHistory: base, file, wideViewport: true })).ids).toContain('docs-history-pane');
    expect(render(P.DocHistoryPane({ docHistory: base, file, wideViewport: false })).ids).toContain('docs-history-pane');
  });
});
