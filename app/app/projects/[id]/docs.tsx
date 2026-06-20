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
 *   │ ─ README   │  ┌──── view ────────────────────────────┐ │
 *   │ ─ notes/   │  │  Edit  | rendered markdown           │ │
 *   │   ├ a.md   │  │                                       │ │
 *   │   └ b.md   │  └───────────────────────────────────────┘ │
 *   │ ─ refs/    │                                            │
 *   │            │  ┌──── edit ────────────────────────────┐ │
 *   │            │  │  Save | TextInput  | Preview         │ │
 *   │            │  └───────────────────────────────────────┘ │
 *   └────────────┴───────────────────────────────────────────┘
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

import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { CommentsSidePane } from '../../../components/CommentsSidePane';
import {
  computeAnchorLines,
  formatAnchorLineLabel,
  offsetToLine,
  parseRangeParam,
  type AnchorLineSpan,
} from '../../../lib/anchor-lines';
import { CommentsProvider } from '../../../lib/comments-state';
import { loadAppConfig } from '../../../lib/config';
import { SPACING, THEME, TYPOGRAPHY } from '../../../lib/theme';
import { RenderMarkdown, type BinarySourceResolver } from '../../../lib/markdown-render';
import { useAuthSession } from '../../../lib/session';
import {
  DocsClient,
  DocsClientError,
  RequestGate,
  findNodeByPath,
  freshEditorState,
  isBinaryExtension,
  type AnchorRow,
  type CommitSummary,
  type DocFile,
  type DocTreeNode,
  type VersionContent,
} from '../../../lib/docs-client';

type EditorMode = 'view' | 'edit';
type MobilePane = 'editor' | 'preview' | 'comments';

// P7.3 — line-height + top-padding constants the highlight overlay
// + the deep-link / tap-to-scroll handlers share. Derived from theme
// tokens so a body-line-height tweak in `lib/theme.ts` keeps the
// overlay aligned with the rendered text. `MARKDOWN_SCROLL_PADDING_TOP`
// mirrors the `markdownScroll` style's `padding: SPACING.lg` value.
// Per `lib/theme.ts:TYPOGRAPHY.body.lineHeight = 22` + `SPACING.lg = 16`
// as of 2026-05-23 — when those tokens change, this code follows.
const BODY_LINE_HEIGHT = TYPOGRAPHY.body.lineHeight;
const MARKDOWN_SCROLL_PADDING_TOP = SPACING.lg;

// P7.3 range UI consumer — highlight overlay alpha levels. The fill
// uses 12% alpha; the 2 px left border uses 55% alpha (caller-visible
// "this is the line you came here for" affordance). Both derive from
// THEME.accent so a palette shift in `lib/theme.ts` follows by
// construction — `withAlpha` parses the hex once and rebuilds the
// rgba string.
const HIGHLIGHT_OVERLAY_FILL_ALPHA = 0.12;
const HIGHLIGHT_OVERLAY_BORDER_ALPHA = 0.55;

function withAlpha(hexColor: string, alpha: number): string {
  // `#rrggbb` only — every THEME color today is a 6-digit hex.
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor);
  if (m === null) return hexColor;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const HIGHLIGHT_OVERLAY_FILL = withAlpha(THEME.accent, HIGHLIGHT_OVERLAY_FILL_ALPHA);
const HIGHLIGHT_OVERLAY_BORDER = withAlpha(THEME.accent, HIGHLIGHT_OVERLAY_BORDER_ALPHA);

export default function DocsTab() {
  const {
    id,
    path: pathParam,
    line: lineParam,
    range: rangeParam,
  } = useLocalSearchParams<{
    id: string;
    path?: string;
    line?: string;
    range?: string;
  }>();
  const project_id = typeof id === 'string' ? id : '';
  // P7.3 — when the tab is opened via a `neutron://docs/<project_id>/<path>`
  // deep link, the deep-link handler in `app/_layout.tsx` routes here with
  // `?path=<encoded path>`. We auto-select the file on mount once the
  // tree is loaded so the reader pane lands on the referenced doc.
  const deepLinkPath = useMemo(() => {
    if (typeof pathParam !== 'string') return null;
    if (pathParam.length === 0) return null;
    return pathParam;
  }, [pathParam]);
  // P7.3 — line anchor (1-indexed) from `?line=<N>`. Expo's query
  // params are always string-typed; coerce and reject 0 / negative /
  // non-integer so a malformed param degrades to "land on file, no
  // scroll" instead of throwing.
  const deepLinkLine = useMemo(() => {
    if (typeof lineParam !== 'string') return null;
    if (lineParam.length === 0) return null;
    if (!/^[1-9][0-9]*$/.test(lineParam)) return null;
    const n = Number(lineParam);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return n;
  }, [lineParam]);
  // P7.3 range UI consumer — `?range=N-M` deep link. Same degrade-
  // to-no-scroll policy as `?line=`: a malformed param resolves to
  // `null` and the viewer behaves as if no anchor was supplied.
  // `line` wins when both are present (the parser shape in
  // `app/lib/doc-links.ts` already rejects same-URL `line` + `range`
  // pairings, but the docs route is defensive against URL-bar
  // shenanigans). 1-indexed, inclusive endpoints.
  const deepLinkRange = useMemo(() => {
    if (deepLinkLine !== null) return null;
    return parseRangeParam(rangeParam);
  }, [rangeParam, deepLinkLine]);
  const { user } = useAuthSession();
  const config = useMemo(() => loadAppConfig(), []);
  const client = useMemo(() => {
    if (user === null) return null;
    return new DocsClient({ base_url: config.base_url, token: user.token });
  }, [user, config.base_url]);

  const [binaryDeleteTarget, setBinaryDeleteTarget] = useState<DocTreeNode | null>(null);
  const [uploadingBinary, setUploadingBinary] = useState(false);
  // Round-2 MINOR #3 — track the editor TextInput's caret position so the
  // drag-drop handler can splice `![alt](filename)` at the current cursor
  // instead of always appending. Selection is `[start, end]`; we use
  // `start` as the insert point (overwrites the selected range when the
  // user is mid-selection at the time of drop).
  const [editorSelection, setEditorSelection] = useState<{ start: number; end: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const { width } = useWindowDimensions();
  const wideViewport = width >= 720;

  // Sequence gates for in-flight tree / file fetches AND in-flight
  // mutations (save / create / rename / delete). Each async op
  // acquires a token; the resolver checks `isLatest(token)` before
  // applying state. A fast A → B click (or project switch mid-load /
  // mid-mutate) bumps the seq so A's slower response can't land last
  // and leave the editor displaying B's content with A's open-file
  // state — and, critically, can't re-install A's `file` /
  // `selectedPath` / `mode='edit'` closures into B's now-reset
  // screen so the next Save writes A's content under project B's
  // path. Round-7 BLOCKING #1 — round-6 fixed this for handleSave
  // only; handleCreateFile / handleRename / handleDelete had the
  // SAME bug class (await then unconditional setSelectedPath /
  // fetchFile / setMode), and the mutateGate now covers all four.
  const treeGate = useMemo(() => new RequestGate(), []);
  const fileGate = useMemo(() => new RequestGate(), []);
  const mutateGate = useMemo(() => new RequestGate(), []);

  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<DocFile | null>(null);
  const [mode, setMode] = useState<EditorMode>('view');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<boolean>(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [actionSheet, setActionSheet] = useState<DocTreeNode | null>(null);
  const [renameTarget, setRenameTarget] = useState<DocTreeNode | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('editor');
  const [existingFileConflict, setExistingFileConflict] = useState<string | null>(null);
  // P7.2 S3 — controlled open state for the comments side-pane. On
  // wide viewport this mounts the pane as an absolute overlay on top
  // of the editor; on narrow viewport the parent flips
  // `mobilePane === 'comments'` and the pane swaps in place of the
  // editor (handled by the body render block below).
  const [commentsPaneOpen, setCommentsPaneOpen] = useState(false);
  // P7.3 range UI consumer — currently highlighted line span. Driven
  // by (a) deep-link `?line=` / `?range=` query params on tab open,
  // and (b) side-pane "tap thread card" → scroll-to-anchor. Rendered
  // as a subtle absolute-positioned accent overlay on top of the
  // markdown viewer (see the `highlightOverlay` style + the JSX
  // inside the viewer ScrollView). `null` = no highlight visible.
  const [highlightSpan, setHighlightSpan] = useState<AnchorLineSpan | null>(null);

  /**
   * P7.5 — resolve relative `![alt](file.png)` references in markdown
   * against `GET /docs/binary?path=...`. Threaded into `<RenderMarkdown
   * binarySource={resolveBinary} />` so the markdown preview renders
   * inline images served by the gateway with the same bearer token.
   * Resolution uses the active file's directory as the base; absolute
   * URLs (`https://...`) skip this resolver entirely.
   */
  const activeFilePath = file?.path ?? null;
  const resolveBinary: BinarySourceResolver | undefined = useMemo(() => {
    if (client === null) return undefined;
    return (relPath: string) => {
      if (/^[a-z]+:\/\//i.test(relPath)) return null;
      if (relPath.startsWith('#')) return null;
      const base = activeFilePath !== null && activeFilePath.includes('/')
        ? activeFilePath.slice(0, activeFilePath.lastIndexOf('/'))
        : '';
      const joined = base.length > 0 ? `${base}/${relPath}` : relPath;
      const normalized = normalizeRel(joined);
      if (normalized === null) return null;
      return client.binaryUrl(project_id, normalized);
    };
  }, [client, activeFilePath, project_id]);

  /* ─── P7.4 history pane state ─── */
  const historyGate = useMemo(() => new RequestGate(), []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<CommitSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<VersionContent | null>(null);
  const [revertingSha, setRevertingSha] = useState<string | null>(null);
  const [revertConfirm, setRevertConfirm] = useState<CommitSummary | null>(null);
  // Ref so handleSelect (declared above loadHistory in source order) can
  // refresh history when the user picks a different file with the
  // history pane open. Set at the bottom of loadHistory's effect.
  const loadHistoryRef = useRef<((rel: string, cursor?: string) => void) | null>(null);

  const fetchTree = useCallback(async () => {
    if (client === null || project_id.length === 0) return;
    const token = treeGate.acquire();
    setLoadingTree(true);
    try {
      const { tree: nextTree } = await client.tree(project_id);
      if (!treeGate.isLatest(token)) return;
      setTree(nextTree);
    } catch (err) {
      if (!treeGate.isLatest(token)) return;
      // Clear the tree on error so the user can't tap a row that maps
      // to a previous project's tree. Without this, an A → B project
      // switch where B's tree load errors leaves A's tree rendered
      // under B; tapping a row reads/writes B with A's relative paths.
      // Round-7 BLOCKING #2.
      setTree([]);
      setError(formatError(err));
    } finally {
      // Only clear the loading flag for the latest fetch — a superseded
      // call must not stomp the spinner the newer fetch just set.
      if (treeGate.isLatest(token)) setLoadingTree(false);
    }
  }, [client, project_id, treeGate]);

  const fetchFile = useCallback(
    async (path: string) => {
      if (client === null) return;
      const token = fileGate.acquire();
      setError(null);
      setConflict(false);
      try {
        const next = await client.readFile(project_id, path);
        if (!fileGate.isLatest(token)) return;
        setFile(next);
        setDraftContent(next.content);
        setMode('view');
      } catch (err) {
        if (!fileGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, fileGate],
  );

  useEffect(() => {
    // Project change: invalidate every in-flight tree/file fetch AND
    // every in-flight mutation from the previous project_id, then
    // reset every per-file state field BEFORE refetching. Without
    // this, navigating A → B leaves A's open file + selectedPath +
    // draftContent + mode + tree in state while `project_id` is now
    // B; pressing Save (or letting any mid-flight create/rename/
    // delete resolve) silently writes A's content / installs A's
    // tree row state under project B.
    treeGate.reset();
    fileGate.reset();
    mutateGate.reset();
    historyGate.reset();
    const fresh = freshEditorState();
    setFile(fresh.file);
    setSelectedPath(fresh.selectedPath);
    setDraftContent(fresh.draftContent);
    setMode(fresh.mode);
    setConflict(fresh.conflict);
    setError(fresh.error);
    setExistingFileConflict(fresh.existingFileConflict);
    setActionSheet(fresh.actionSheet);
    setRenameTarget(fresh.renameTarget);
    setNewFileOpen(fresh.newFileOpen);
    setHistoryOpen(false);
    setHistoryEntries([]);
    setHistoryCursor(null);
    setHistoryUnavailable(false);
    setPreviewVersion(null);
    setRevertConfirm(null);
    setRevertingSha(null);
    // Tree MUST reset before fetchTree() — without this, the tree
    // pane briefly renders A's tree under B's project_id (or, if
    // fetchTree() errors on B, indefinitely). Round-7 BLOCKING #2.
    setTree(fresh.tree);
    void fetchTree();
  }, [fetchTree, treeGate, fileGate, mutateGate, historyGate]);

  // P7.3 — when the tab is opened via `neutron://docs/<project_id>/<path>`
  // (handled in `app/_layout.tsx`) the router routes here with `?path=…`.
  // Once the tree has finished loading, auto-select that file using the
  // same code path a manual tree tap takes. Re-runs on `deepLinkPath`
  // change so a second deep-link to the same tab resolves correctly.
  useEffect(() => {
    if (deepLinkPath === null) return;
    if (loadingTree) return;
    setSelectedPath(deepLinkPath);
    void fetchFile(deepLinkPath);
  }, [deepLinkPath, loadingTree, fetchFile]);

  // P7.3 — line- AND range-anchor scroll. After the viewer's body
  // lands, scroll the rendered markdown to the deep-linked line (or
  // first line of the range) and paint the highlight overlay on the
  // referenced span.
  //
  // Strategy B (heuristic) from brief § 4.3: P7.1's markdown renderer
  // doesn't expose a per-line layout map (audited 2026-05-20), and
  // adding `onLineLayout` would require renderer-pass surgery beyond
  // this sprint's scope. We use `y_offset ≈ lineHeight * (line - 1)`
  // where `lineHeight` is the body token (22 px per `app/lib/theme.ts`).
  // Lands within a screen of the target line; the user sees the file
  // open near the referenced location instead of at the top.
  // Strategy A (line→y_offset map) is reserved for a P7.3-follow-up
  // sprint per brief § 4.3.
  //
  // P7.3 range UI consumer: same heuristic for the range case — scroll
  // targets the FIRST line (N) per the sprint brief, with the
  // highlight overlay spanning N..M. The viewer scrolls regardless of
  // the span's length; the overlay handles the visual span.
  //
  // Gates: only fires in 'view' mode (edit-mode cursor would lose its
  // position), only when the active file matches the deep-link path
  // (a manual tree tap mid-scroll mustn't trigger a stale scroll), and
  // only after the body has loaded. 200 ms settle delay matches the
  // P5.1 chat-stream scroll-to-bottom convention so image / table
  // layout passes converge first.
  const viewerScrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    // P7.3 — consolidated deep-link span + clear logic. ONE effect
    // owns both arms so the "set highlight on deep-link arrival" and
    // "clear highlight on file-switch / mode-switch" branches can
    // never race against each other across separate effects. Two
    // separate effects sharing `setHighlightSpan` with overlapping
    // dep arrays would commit non-deterministic final state when
    // both deps changed in the same React commit; consolidating
    // makes the precedence explicit.
    //
    // Gates: only paints + scrolls when we're in view mode on the
    // file the deep link points at AND the body has loaded. Any
    // other state nulls the highlight (file-switch via tree tap,
    // mode flip to edit, fresh navigation away from the deep-link
    // file) — that's the user "leaving the deep-linked location",
    // which is exactly when the overlay should disappear. Tap-set
    // highlights from the side-pane survive because this effect's
    // deps don't include them; only `handleScrollToAnchor` mutates
    // the span in that flow.
    if (mode !== 'view' || file === null || selectedPath === null || selectedPath !== deepLinkPath) {
      setHighlightSpan(null);
      return;
    }
    let span: AnchorLineSpan | null = null;
    if (deepLinkLine !== null) {
      span = { startLine: deepLinkLine, endLine: deepLinkLine };
    } else if (deepLinkRange !== null) {
      span = {
        startLine: deepLinkRange.range_start,
        endLine: deepLinkRange.range_end,
      };
    }
    if (span === null) {
      // Selected the deep-link file (or arrived here via tree tap
      // with no deep-link params at all) — no anchor to highlight.
      // Don't stomp a tap-set highlight if the user just clicked
      // a side-pane thread on this same file: `selectedPath` and
      // `mode` haven't changed since the tap, so the effect only
      // re-fires when `file`/`deepLink*` change. New file load
      // (selectedPath change) DOES nullify, which is correct.
      setHighlightSpan(null);
      return;
    }
    setHighlightSpan(span);
    const targetStart = span.startLine;
    const handle = setTimeout(() => {
      const ref = viewerScrollRef.current;
      if (ref === null) return;
      // Anchor 1-indexed. Body line-height + scroll padding come from
      // the module constants derived from `lib/theme.ts` tokens, so a
      // typography tweak follows by construction.
      const y = Math.max(
        0,
        MARKDOWN_SCROLL_PADDING_TOP + (targetStart - 1) * BODY_LINE_HEIGHT,
      );
      ref.scrollTo({ y, animated: true });
    }, 200);
    return () => clearTimeout(handle);
  }, [deepLinkLine, deepLinkRange, deepLinkPath, selectedPath, mode, file]);

  // P7.2 S3 / P7.3 range UI consumer — scroll-to-anchor handler the
  // side-pane invokes when the user taps a thread card. The side-pane
  // passes the `AnchorRow` it already has on hand; we (a) compute an
  // approximate y-offset from `current_start` using the body line-
  // height token (same heuristic the deep-link scroll uses —
  // Strategy B), and (b) compute the `[startLine, endLine]` span
  // from `[current_start, current_end]` so the highlight overlay
  // paints every line in the anchor range.
  //
  // Single-line anchors (offsets that don't span a newline) collapse
  // to `startLine === endLine` and render a single highlighted line.
  // Range anchors render a multi-line highlight. The viewer scrolls
  // to `startLine` either way.
  //
  // The full `useImperativeHandle(scrollToOffset)` editor seam is
  // reserved for a P7.3-follow-up sprint; until then, mapping
  // byte-offset → line-number → y-offset via the doc content lets us
  // ship the affordance without renderer surgery.
  const handleScrollToAnchor = useCallback(
    (anchor: AnchorRow) => {
      if (file === null) return;
      const ref = viewerScrollRef.current;
      if (ref === null) return;
      const fallbackStart =
        typeof anchor.current_start === 'number' && anchor.current_start >= 0
          ? anchor.current_start
          : typeof anchor.drift_hint_start === 'number'
            ? anchor.drift_hint_start
            : 0;
      const fallbackEnd =
        typeof anchor.current_end === 'number' && anchor.current_end >= 0
          ? anchor.current_end
          : typeof anchor.drift_hint_end === 'number'
            ? anchor.drift_hint_end
            : fallbackStart;
      const span = computeAnchorLines(
        {
          current_start: fallbackStart,
          current_end: fallbackEnd,
        },
        file.content,
      );
      const startLine =
        span !== null ? span.startLine : offsetToLine(file.content, fallbackStart);
      const endLine = span !== null ? span.endLine : startLine;
      setHighlightSpan({ startLine, endLine });
      const y = Math.max(
        0,
        MARKDOWN_SCROLL_PADDING_TOP + (startLine - 1) * BODY_LINE_HEIGHT,
      );
      ref.scrollTo({ y, animated: true });
    },
    [file],
  );

  // P7.3 range UI consumer — line-label provider passed to the side-
  // pane. The side-pane has no doc-content access of its own (it only
  // sees the `ThreadSummary` projection from the gateway), so the
  // parent computes the "Line 12" / "Lines 12–18" label here and
  // hands it down as a callback. Returns `null` when the open file
  // hasn't loaded yet OR when the anchor offsets are incomplete — the
  // side-pane then suppresses the label row entirely.
  const formatAnchorLineLabelForSidePane = useCallback(
    (anchor: { current_start: number | null; current_end: number | null }) => {
      if (file === null) return null;
      const span = computeAnchorLines(anchor, file.content);
      if (span === null) return null;
      return formatAnchorLineLabel(span);
    },
    [file],
  );

  // (Previously a separate `[selectedPath, mode]` clear effect lived
  // here. It was inlined into the consolidated deep-link useEffect
  // above so the two arms — set on deep-link arrival, clear on
  // file-switch / mode-switch — can never race against each other
  // across separate React effects with overlapping dep arrays. The
  // side-pane tap-to-scroll handler (`handleScrollToAnchor`) still
  // sets the highlight imperatively and survives across renders
  // because it doesn't mutate any of the consolidated effect's deps.)

  const handleSelect = useCallback(
    (node: DocTreeNode) => {
      if (node.kind === 'folder') return;
      if (node.kind === 'binary') {
        // P7.5 — binaries route to a read-only preview pane instead of
        // the editor. Clear the file body + history so the binary
        // preview can render without leaking the previous markdown's
        // edit state.
        setSelectedPath(node.path);
        setFile(null);
        setDraftContent('');
        setMode('view');
        setHistoryEntries([]);
        setHistoryCursor(null);
        setHistoryOpen(false);
        setPreviewVersion(null);
        return;
      }
      setSelectedPath(node.path);
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
    [fetchFile, historyOpen],
  );

  /**
   * P7.5 — upload a binary via the same client method an action-sheet
   * "Insert image" button (or a web drag-drop handler) would call. The
   * active markdown file's directory hosts the uploaded blob; the
   * markdown surface is updated by the caller if needed (drag-drop
   * also splices `![alt](filename)` into the editor, but the standalone
   * upload button just lands the blob in the tree).
   */
  const handleUploadBinary = useCallback(
    async (fileToUpload: File, opts: { insertAtCaret?: boolean } = {}) => {
      if (client === null) return;
      if (!isBinaryExtension(fileToUpload.name)) {
        setError(`Unsupported file type: ${fileToUpload.name}`);
        return;
      }
      const token = mutateGate.acquire();
      setUploadingBinary(true);
      try {
        const activeDir =
          file?.path !== undefined && file.path.includes('/')
            ? file.path.slice(0, file.path.lastIndexOf('/'))
            : '';
        const targetPath = activeDir.length > 0
          ? `${activeDir}/${fileToUpload.name}`
          : fileToUpload.name;
        await client.uploadBinary(project_id, targetPath, fileToUpload);
        if (!mutateGate.isLatest(token)) return;
        // If the editor is open in edit mode, splice the markdown link
        // into the buffer. Round-2 MINOR #3 — drag-drop with caret
        // tracking inserts at the cursor; the standalone upload button
        // (no caret context) appends at the end as before.
        if (mode === 'edit' && file !== null) {
          const insert = `![${fileToUpload.name}](${fileToUpload.name})`;
          if (opts.insertAtCaret && editorSelection !== null) {
            const { start, end } = editorSelection;
            setDraftContent((cur) => {
              const before = cur.slice(0, start);
              const after = cur.slice(end);
              return `${before}${insert}${after}`;
            });
            // Move the caret PAST the inserted markdown so a subsequent
            // edit lands after the image link, not inside the URL.
            setEditorSelection({
              start: start + insert.length,
              end: start + insert.length,
            });
          } else {
            setDraftContent((cur) => `${cur}\n${insert}\n`);
          }
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      } finally {
        setUploadingBinary(false);
      }
    },
    [client, project_id, file, mode, mutateGate, fetchTree, editorSelection],
  );

  /**
   * Round-2 MINOR #3 — web-only drag-drop handler for the editor pane.
   * Pulls the first dropped file out of `event.dataTransfer.files`,
   * validates the extension client-side, then routes through
   * `handleUploadBinary` with `insertAtCaret: true` so the markdown
   * image syntax lands at the user's current cursor position rather
   * than appended at the end of the buffer.
   */
  const handleEditorDrop = useCallback(
    (file: File) => {
      void handleUploadBinary(file, { insertAtCaret: true });
    },
    [handleUploadBinary],
  );

  const handleConfirmBinaryDelete = useCallback(
    async (node: DocTreeNode) => {
      if (client === null) return;
      const token = mutateGate.acquire();
      try {
        await client.deleteBinary(project_id, node.path);
        if (!mutateGate.isLatest(token)) return;
        setBinaryDeleteTarget(null);
        if (selectedPath === node.path) {
          setSelectedPath(null);
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, selectedPath, fetchTree, mutateGate],
  );

  /* ─── P7.4 history fetch + revert flow ─── */

  const loadHistory = useCallback(
    async (rel: string, cursor?: string) => {
      if (client === null) return;
      const token = historyGate.acquire();
      setHistoryLoading(true);
      try {
        const opts: { cursor?: string } = {};
        if (cursor !== undefined) opts.cursor = cursor;
        const page = await client.history(project_id, rel, opts);
        if (!historyGate.isLatest(token)) return;
        setHistoryUnavailable(false);
        setHistoryEntries((prev) =>
          cursor === undefined ? page.history : [...prev, ...page.history],
        );
        setHistoryCursor(page.next_cursor);
      } catch (err) {
        if (!historyGate.isLatest(token)) return;
        if (err instanceof DocsClientError && err.code === 'versioning_unavailable') {
          setHistoryUnavailable(true);
          setHistoryEntries([]);
          setHistoryCursor(null);
        } else {
          setError(formatError(err));
        }
      } finally {
        if (historyGate.isLatest(token)) setHistoryLoading(false);
      }
    },
    [client, project_id, historyGate],
  );

  // Keep the ref synced with the latest loadHistory closure so
  // handleSelect (declared earlier in source order) can call into the
  // current version without a stale-closure trap.
  useEffect(() => {
    loadHistoryRef.current = loadHistory;
  }, [loadHistory]);

  const handleToggleHistory = useCallback(() => {
    if (file === null) return;
    const next = !historyOpen;
    setHistoryOpen(next);
    setPreviewVersion(null);
    if (next) {
      void loadHistory(file.path);
    }
  }, [file, historyOpen, loadHistory]);

  const handlePreviewVersion = useCallback(
    async (entry: CommitSummary) => {
      if (client === null || file === null) return;
      const token = historyGate.acquire();
      try {
        const v = await client.getVersion(project_id, entry.sha, file.path);
        if (!historyGate.isLatest(token)) return;
        setPreviewVersion(v);
      } catch (err) {
        if (!historyGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, file, project_id, historyGate],
  );

  const handleExitPreview = useCallback(() => {
    setPreviewVersion(null);
  }, []);

  const handleRevertConfirm = useCallback(
    async (entry: CommitSummary) => {
      if (client === null || file === null) return;
      const token = mutateGate.acquire();
      setRevertingSha(entry.sha);
      setError(null);
      try {
        // Pass the current mtime so a concurrent edit (other tab /
        // device) surfaces the same 409 the normal Save path would.
        // Codex r1 P1.
        const result = await client.revert(project_id, {
          path: file.path,
          target_sha: entry.sha,
          expected_modified_at: file.modified_at,
        });
        if (!mutateGate.isLatest(token)) return;
        if (result.deleted) {
          // Revert restored a deletion state — clear the open file
          // surface, refresh the tree, and close the history pane.
          setFile(null);
          setSelectedPath(null);
          setDraftContent('');
          setMode('view');
          setHistoryEntries([]);
          setHistoryCursor(null);
          setHistoryOpen(false);
          await fetchTree();
        } else {
          // Reload the file body + re-fetch history so the new commit
          // appears at the top of the pane.
          await fetchFile(file.path);
          if (!mutateGate.isLatest(token)) return;
          await loadHistory(file.path);
        }
        if (!mutateGate.isLatest(token)) return;
        setPreviewVersion(null);
        setRevertConfirm(null);
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        if (err instanceof DocsClientError && err.code === 'doc_modified_conflict') {
          setConflict(true);
          setRevertConfirm(null);
        } else {
          setError(formatError(err));
        }
      } finally {
        setRevertingSha(null);
      }
    },
    [client, file, project_id, mutateGate, fetchFile, fetchTree, loadHistory],
  );

  const handleSave = useCallback(async () => {
    if (client === null || file === null) return;
    // Acquire a mutate token before the await. If the project_id
    // flips mid-save, the project-change effect calls
    // `mutateGate.reset()` and invalidates this token — the resolver
    // below bails BEFORE re-installing A's `file` closure (path +
    // content + mtime) into B's now-reset screen. Without this, the
    // next Save in B would writeFile(B, A.path, A.content) — exact
    // cross-project silent write that round-4 was supposed to close,
    // still live on the write path. Round-5 BLOCKING #1.
    const token = mutateGate.acquire();
    setSaving(true);
    setError(null);
    try {
      const result = await client.writeFile(project_id, {
        path: file.path,
        content: draftContent,
        expected_modified_at: file.modified_at,
      });
      if (!mutateGate.isLatest(token)) return;
      setFile({
        ...file,
        content: draftContent,
        size_bytes: result.size_bytes,
        modified_at: result.modified_at,
      });
      setMode('view');
      await fetchTree();
    } catch (err) {
      if (!mutateGate.isLatest(token)) return;
      if (err instanceof DocsClientError && err.code === 'doc_modified_conflict') {
        setConflict(true);
      } else {
        setError(formatError(err));
      }
    } finally {
      // Always clear the spinner — even if the token was invalidated
      // by a project switch, the surrounding component keeps living
      // and a stuck `saving=true` would disable the Save button the
      // next time the user enters edit mode in the new project.
      setSaving(false);
    }
  }, [client, file, draftContent, project_id, fetchTree, mutateGate]);

  const handleReload = useCallback(async () => {
    if (file === null) return;
    setConflict(false);
    await fetchFile(file.path);
  }, [file, fetchFile]);

  const handleCreateFile = useCallback(
    async (input: { folder: string; filename: string }) => {
      if (client === null) return;
      const filename = input.filename.trim();
      if (filename.length === 0) {
        setError('Filename is required.');
        return;
      }
      // Match the gateway's MARKDOWN_EXTENSIONS — `.md` and
      // `.markdown` both pass requireMd. Round-7 IMPORTANT #1.
      const withExt = /\.(md|markdown)$/i.test(filename) ? filename : `${filename}.md`;
      const folder = input.folder.replace(/^\/+|\/+$/g, '');
      const fullPath = folder.length > 0 ? `${folder}/${withExt}` : withExt;
      // Acquire a mutate token. If `project_id` flips mid-await, the
      // project-change effect invalidates this token and the resolver
      // bails BEFORE any state setter fires — without this guard,
      // A's newly-created path landed in B's editor and the next
      // Save silently wrote B with A's content (round-7 BLOCKING #1,
      // same bug class round-6 closed for handleSave only).
      const token = mutateGate.acquire();
      try {
        // Refetch tree first so the existence check sees the freshest
        // server view — PUT is create-or-overwrite, so a stale local
        // tree could let us silently truncate a file another client just
        // wrote.
        const { tree: latestTree } = await client.tree(project_id);
        if (!mutateGate.isLatest(token)) return;
        setTree(latestTree);
        if (findNodeByPath(latestTree, fullPath) !== null) {
          setExistingFileConflict(fullPath);
          return;
        }
        await client.writeFile(project_id, { path: fullPath, content: '' });
        if (!mutateGate.isLatest(token)) return;
        setNewFileOpen(false);
        await fetchTree();
        if (!mutateGate.isLatest(token)) return;
        setSelectedPath(fullPath);
        await fetchFile(fullPath);
        if (!mutateGate.isLatest(token)) return;
        setMode('edit');
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, fetchTree, fetchFile, mutateGate],
  );

  const handleOpenExisting = useCallback(async () => {
    if (existingFileConflict === null) return;
    const fullPath = existingFileConflict;
    setExistingFileConflict(null);
    setNewFileOpen(false);
    setSelectedPath(fullPath);
    await fetchFile(fullPath);
  }, [existingFileConflict, fetchFile]);

  const handleDelete = useCallback(
    async (node: DocTreeNode) => {
      if (client === null) return;
      // P7.5 — a binary with referenced_by_count > 0 routes through a
      // confirm dialog so the user can back out before the destructive
      // action; otherwise drop straight through to the delete.
      if (
        node.kind === 'binary' &&
        node.referenced_by_count !== null &&
        node.referenced_by_count > 0
      ) {
        setActionSheet(null);
        setBinaryDeleteTarget(node);
        return;
      }
      // Same mutateGate guard as handleSave / handleCreateFile —
      // without it, project A's delete resolving after the user
      // switches to project B would null out B's open file and
      // re-render A's tree. Round-7 BLOCKING #1.
      const token = mutateGate.acquire();
      try {
        if (node.kind === 'file') {
          await client.deleteFile(project_id, node.path);
        } else if (node.kind === 'binary') {
          await client.deleteBinary(project_id, node.path);
        } else if (node.kind === 'folder' && node.origin === 'binary') {
          // P7.5 round-2 IMPORTANT #5 — phantom-binary folder. The
          // folder doesn't exist on disk (the tree-merge step synthesised
          // it to host a binary leaf), so `deleteFolder` would ENOENT.
          // Route through the binary-recursive delete instead so every
          // binary under the prefix is unlinked in one txn.
          await client.deleteBinariesUnderPrefix(project_id, node.path);
        } else {
          await client.deleteFolder(project_id, node.path);
        }
        if (!mutateGate.isLatest(token)) return;
        setActionSheet(null);
        if (selectedPath === node.path) {
          setSelectedPath(null);
          setFile(null);
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, selectedPath, fetchTree, mutateGate],
  );

  const handleRename = useCallback(
    async (node: DocTreeNode, to_path: string) => {
      if (client === null) return;
      const cleaned = to_path.trim();
      if (cleaned.length === 0) {
        setError('New path is required.');
        return;
      }
      // Same mutateGate guard as handleSave / handleCreateFile /
      // handleDelete — without it, project A's rename resolving
      // after the user switches to project B would install A's
      // new path into B's editor and the next Save would write B
      // under A's renamed path. Round-7 BLOCKING #1.
      const token = mutateGate.acquire();
      try {
        if (node.kind === 'file') {
          await client.moveFile(project_id, node.path, cleaned);
        } else {
          throw new Error('Folder rename is not supported in P7.1.');
        }
        if (!mutateGate.isLatest(token)) return;
        setRenameTarget(null);
        setActionSheet(null);
        if (selectedPath === node.path) {
          setSelectedPath(cleaned);
          await fetchFile(cleaned);
          if (!mutateGate.isLatest(token)) return;
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, selectedPath, fetchTree, fetchFile, mutateGate],
  );

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
          <Text style={styles.title}>Docs</Text>
          <Text style={styles.subtitle}>
            Project-scoped markdown — edit lives in the right pane.
          </Text>
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

      <View style={[styles.body, wideViewport ? styles.bodyWide : styles.bodyNarrow]}>
        <View
          style={[
            styles.treePane,
            wideViewport ? styles.treePaneWide : styles.treePaneNarrow,
          ]}
        >
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
        {historyOpen && file !== null && (
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
        )}
      </View>

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

/* ─── P7.5 helpers ─────────────────────────────────────────────── */

function treeIconFor(node: DocTreeNode): string {
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

function findBinaryNode(
  nodes: DocTreeNode[],
  target: string,
): DocTreeNode | null {
  for (const n of nodes) {
    if (n.kind === 'binary' && n.path === target) return n;
    if (n.kind === 'folder' && n.children.length > 0) {
      const hit = findBinaryNode(n.children, target);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function normalizeRel(p: string): string | null {
  const parts = p.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

interface BinaryPreviewProps {
  node: DocTreeNode;
  source: { uri: string; headers: Record<string, string> };
}

function BinaryPreview({ node, source }: BinaryPreviewProps) {
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
function EditorDropTarget({
  onDropFile,
  dragOver,
  setDragOver,
  children,
}: EditorDropTargetProps) {
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
function BinaryUploadButton({ uploading, onUpload }: BinaryUploadButtonProps) {
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

function BinaryDeleteConfirmModal({
  node,
  onCancel,
  onConfirm,
}: BinaryDeleteConfirmModalProps) {
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

function RevertConfirmModal({ entry, onCancel, onConfirm }: RevertConfirmModalProps) {
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

/** Brief human-readable timestamp. Falls back to the raw ISO string
 *  when Date parsing fails. */
function formatHistoryDate(iso: string): string {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

interface TreeBranchProps {
  nodes: DocTreeNode[];
  depth: number;
  selectedPath: string | null;
  onSelect(node: DocTreeNode): void;
  onLongPress(node: DocTreeNode): void;
}

function TreeBranch({ nodes, depth, selectedPath, onSelect, onLongPress }: TreeBranchProps) {
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

function NewFileModal({ visible, onClose, onCreate }: NewFileModalProps) {
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
            placeholderTextColor="#5a5a5a"
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
            placeholderTextColor="#5a5a5a"
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

function FileExistsModal({ path, onOpen, onCancel }: FileExistsModalProps) {
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

function ActionSheetModal({ node, onClose, onRename, onDelete }: ActionSheetModalProps) {
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

function RenameModal({ node, onClose, onRename }: RenameModalProps) {
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
            placeholderTextColor="#5a5a5a"
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

function formatError(err: unknown): string {
  if (err instanceof DocsClientError) {
    return `${err.code}: ${err.message.replace(`${err.code}: `, '')}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  centered: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1c',
  },
  intro: { flexShrink: 1 },
  title: { color: '#fafafa', fontSize: 20, fontWeight: '700' },
  subtitle: { color: '#9a9a9a', fontSize: 12, lineHeight: 16 },
  headerActions: { flexDirection: 'row', gap: 8 },
  newBtn: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  newBtnText: { color: '#fafafa', fontWeight: '600', fontSize: 13 },
  binaryUploadWrap: { flexDirection: 'row', alignItems: 'center' },
  dropTarget: { flex: 1 },
  uploadBtn: {
    backgroundColor: '#1c2735',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#2c3e50',
  },
  uploadBtnText: { color: '#cfcfcf', fontWeight: '600', fontSize: 13 },
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
    backgroundColor: '#1c1c1c',
    borderRadius: 8,
  },
  binaryMeta: {
    color: '#7a7a7a',
    fontSize: 11,
    marginTop: 12,
  },
  binaryDownloadCard: {
    backgroundColor: '#1c1c1c',
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
    gap: 12,
    minWidth: 280,
  },
  binaryDownloadIcon: { fontSize: 40 },
  binaryDownloadName: { color: '#fafafa', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  binaryDownloadMeta: { color: '#7a7a7a', fontSize: 11 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },

  body: { flex: 1 },
  bodyWide: { flexDirection: 'row' },
  bodyNarrow: { flexDirection: 'column' },
  treePane: {
    backgroundColor: '#0d0d0d',
    borderRightWidth: 1,
    borderRightColor: '#1c1c1c',
  },
  treePaneWide: { width: 260, flexShrink: 0 },
  treePaneNarrow: { borderBottomWidth: 1, borderBottomColor: '#1c1c1c', maxHeight: 220 },
  treeScroll: { paddingVertical: 8 },
  treeEmpty: { color: '#5a5a5a', fontSize: 12, padding: 16 },

  treeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingRight: 12,
    gap: 8,
  },
  treeRowSelected: { backgroundColor: '#1c2735' },
  treeIcon: { fontSize: 14 },
  treeLabel: { color: '#cfcfcf', fontSize: 13, fontWeight: '500', flex: 1 },

  viewerPane: { backgroundColor: '#0a0a0a' },
  viewerPaneWide: { flex: 1 },
  viewerPaneNarrow: { flex: 1 },
  viewerEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  viewerEmptyText: { color: '#5a5a5a', fontSize: 13, textAlign: 'center' },
  viewerInner: { flex: 1 },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1c',
    gap: 12,
  },
  viewerPath: { color: '#cfcfcf', fontSize: 13, fontWeight: '600', flex: 1 },
  viewerActions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  actionBtnText: { color: '#fafafa', fontWeight: '600', fontSize: 12 },
  actionBtnGhost: {
    backgroundColor: 'transparent',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#2c2c2c',
  },
  actionBtnGhostText: { color: '#cfcfcf', fontWeight: '500', fontSize: 12 },

  markdownScroll: { padding: 16, paddingBottom: 32 },

  // P7.3 range UI consumer — single- OR multi-line highlight overlay
  // painted on top of the markdown viewer. Reuses THEME.accent at
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
    backgroundColor: HIGHLIGHT_OVERLAY_FILL,
    borderLeftWidth: 2,
    borderLeftColor: HIGHLIGHT_OVERLAY_BORDER,
  },

  editPanes: { flex: 1, flexDirection: 'row' },
  editStack: { flex: 1 },
  mobileToggle: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1c',
  },
  mobileToggleBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  mobileToggleBtnActive: {
    backgroundColor: '#1c2735',
  },
  mobileToggleText: { color: '#cfcfcf', fontSize: 12, fontWeight: '600' },

  editor: {
    flex: 1,
    color: '#fafafa',
    backgroundColor: '#0a0a0a',
    fontSize: 13,
    lineHeight: 20,
    padding: 16,
    fontFamily: 'Menlo',
    textAlignVertical: 'top',
  },
  preview: {
    flex: 1,
    borderLeftWidth: 1,
    borderLeftColor: '#1c1c1c',
    backgroundColor: '#0d0d0d',
  },

  errorBanner: {
    backgroundColor: '#3f1d1d',
    borderColor: '#7a2c2c',
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    margin: 12,
    borderRadius: 8,
  },
  errorText: { color: '#fca5a5', flex: 1, fontSize: 12 },
  errorDismiss: { color: '#fca5a5', fontWeight: '600', fontSize: 12 },

  conflictBanner: {
    backgroundColor: '#3a2a13',
    borderColor: '#7a5b1f',
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    margin: 12,
    borderRadius: 8,
    gap: 12,
  },
  conflictText: { color: '#fcd34d', flex: 1, fontSize: 12, lineHeight: 16 },
  conflictBtn: {
    backgroundColor: '#7a5b1f',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  conflictBtnText: { color: '#fff7ed', fontWeight: '600', fontSize: 12 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: '#0f0f0f',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2c2c2c',
    padding: 16,
    width: '100%',
    maxWidth: 480,
    gap: 8,
  },
  modalTitle: { color: '#fafafa', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  modalLabel: {
    color: '#9a9a9a',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  modalInput: {
    color: '#fafafa',
    backgroundColor: '#121212',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#2c2c2c',
    fontSize: 13,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
  },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
  modalCancelText: { color: '#cfcfcf', fontSize: 13, fontWeight: '500' },
  modalConfirm: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  modalConfirmText: { color: '#fafafa', fontSize: 13, fontWeight: '600' },
  fileExistsBody: { color: '#cfcfcf', fontSize: 13, lineHeight: 18, marginTop: 6 },

  actionSheetBtn: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderTopColor: '#1c1c1c',
  },
  actionSheetText: { color: '#cfcfcf', fontSize: 14 },
  actionSheetDelete: { borderTopColor: '#1c1c1c' },
  actionSheetDeleteText: { color: '#fca5a5' },
  actionSheetCancel: {
    marginTop: 8,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#1f2937',
    borderRadius: 8,
  },
  actionSheetCancelText: { color: '#fafafa', fontWeight: '600', fontSize: 13 },

  /* ─── P7.4 history pane + version badge + preview overlay ─── */
  actionBtnGhostActive: { backgroundColor: '#1c2735', borderColor: '#395071' },
  versionBadge: { color: '#9a9a9a', fontWeight: '500' },
  historyPane: { backgroundColor: '#0d0d0d' },
  historyPaneWide: {
    width: 280,
    borderLeftWidth: 1,
    borderLeftColor: '#1c1c1c',
    flexShrink: 0,
  },
  historyPaneNarrow: {
    borderTopWidth: 1,
    borderTopColor: '#1c1c1c',
    maxHeight: 280,
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1c',
  },
  historyTitle: { color: '#fafafa', fontSize: 14, fontWeight: '700' },
  historyEmpty: { color: '#5a5a5a', fontSize: 12, padding: 16 },
  historyScroll: { padding: 8, paddingBottom: 32 },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1c',
    gap: 8,
  },
  historyRowMain: { flex: 1 },
  historyMessage: { color: '#cfcfcf', fontSize: 13, fontWeight: '500' },
  historyMeta: { color: '#7a7a7a', fontSize: 11, marginTop: 2 },
  historyRevertBtn: {
    backgroundColor: '#1f2937',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  historyRevertText: { color: '#fafafa', fontWeight: '600', fontSize: 11 },
  historyLoadMore: {
    backgroundColor: '#121212',
    borderRadius: 8,
    paddingVertical: 10,
    marginTop: 8,
    alignItems: 'center',
  },
  historyLoadMoreText: { color: '#cfcfcf', fontSize: 12, fontWeight: '600' },

  previewOverlay: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1c',
    backgroundColor: '#0d1622',
    gap: 12,
  },
  previewTitle: { color: '#cfcfcf', fontSize: 12, fontWeight: '600', flex: 1 },
});
