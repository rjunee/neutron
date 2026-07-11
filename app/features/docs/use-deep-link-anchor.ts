/**
 * @neutronai/app — `useDeepLinkAnchor`: the P7.3 deep-link + anchor
 * cluster of the docs tab (D7 refactor). Parses the `?path` / `?line`
 * / `?range` / `?folder` query params, auto-selects the deep-linked
 * file once the tree lands, owns the `highlightSpan` overlay +
 * `viewerScrollRef`, and exposes the scroll-to-anchor + line-label
 * callbacks the comments side-pane consumes.
 *
 * The set/clear-highlight branches live in ONE effect so "set on
 * deep-link arrival" and "clear on file-switch / mode-switch" can
 * never race across separate effects with overlapping dep arrays.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView } from 'react-native';

import {
  computeAnchorLines,
  formatAnchorLineLabel,
  offsetToLine,
  parseRangeParam,
  type AnchorLineSpan,
} from '../../lib/anchor-lines';
import { isBinaryExtension, type AnchorRow, type DocFile } from '../../lib/docs-client';
import {
  BODY_LINE_HEIGHT,
  MARKDOWN_SCROLL_PADDING_TOP,
  type EditorMode,
} from './docs-shared';

export interface UseDeepLinkAnchor {
  folderPath: string | null;
  deepLinkPath: string | null;
  highlightSpan: AnchorLineSpan | null;
  viewerScrollRef: React.RefObject<ScrollView | null>;
  handleScrollToAnchor: (anchor: AnchorRow) => void;
  formatAnchorLineLabelForSidePane: (anchor: {
    current_start: number | null;
    current_end: number | null;
  }) => string | null;
}

export function useDeepLinkAnchor(params: {
  pathParam?: string;
  lineParam?: string;
  rangeParam?: string;
  folderParam?: string;
  file: DocFile | null;
  selectedPath: string | null;
  mode: EditorMode;
  loadingTree: boolean;
  setFile: React.Dispatch<React.SetStateAction<DocFile | null>>;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  fetchFile: (path: string) => Promise<void>;
}): UseDeepLinkAnchor {
  const {
    pathParam,
    lineParam,
    rangeParam,
    folderParam,
    file,
    selectedPath,
    mode,
    loadingTree,
    setFile,
    setSelectedPath,
    fetchFile,
  } = params;

  // PR-5 — phone DOCS drill-down: `?folder=<rel>` scopes the single-pane list to
  // a subfolder (a router push per level = the iOS Files pattern). Absent /
  // empty = the root level.
  const folderPath =
    typeof folderParam === 'string' && folderParam.length > 0 ? folderParam : null;
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

  const [highlightSpan, setHighlightSpan] = useState<AnchorLineSpan | null>(null);
  const viewerScrollRef = useRef<ScrollView>(null);

  // P7.3 — when the tab is opened via `neutron://docs/<project_id>/<path>`
  // (handled in `app/_layout.tsx`) the router routes here with `?path=…`.
  // Once the tree has finished loading, auto-select that file using the
  // same code path a manual tree tap takes. Re-runs on `deepLinkPath`
  // change so a second deep-link to the same tab resolves correctly.
  useEffect(() => {
    if (deepLinkPath === null) return;
    if (loadingTree) return;
    setSelectedPath(deepLinkPath);
    // A binary deep link (a phone drill-down tap on an image/PDF) renders via the
    // BinaryPreview branch (`file === null` + `selectedPath`) — never fetch it as
    // markdown, which would 4xx. Mirrors `handleSelect`'s binary arm.
    if (isBinaryExtension(deepLinkPath)) {
      setFile(null);
    } else {
      void fetchFile(deepLinkPath);
    }
  }, [deepLinkPath, loadingTree, fetchFile, setSelectedPath, setFile]);

  // P7.3 — line- AND range-anchor scroll. After the viewer's body
  // lands, scroll the rendered markdown to the deep-linked line (or
  // first line of the range) and paint the highlight overlay on the
  // referenced span. Strategy B (heuristic): `y ≈ lineHeight * (line-1)`
  // with the body line-height token. Gates: view mode, active file
  // matches the deep-link path, body loaded. 200 ms settle matches the
  // P5.1 chat-stream scroll convention so layout passes converge first.
  useEffect(() => {
    // P7.3 — consolidated deep-link span + clear logic. ONE effect
    // owns both arms so the "set highlight on deep-link arrival" and
    // "clear highlight on file-switch / mode-switch" branches can
    // never race against each other across separate effects.
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
  // side-pane invokes when the user taps a thread card. Maps the
  // anchor's byte offsets → line span via the doc content, paints the
  // highlight overlay, and scrolls to the first line (Strategy B).
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
  // pane. The side-pane has no doc-content access of its own, so the
  // parent computes the "Line 12" / "Lines 12–18" label here. Returns
  // `null` when the open file hasn't loaded yet OR the anchor offsets
  // are incomplete — the side-pane then suppresses the label row.
  const formatAnchorLineLabelForSidePane = useCallback(
    (anchor: { current_start: number | null; current_end: number | null }) => {
      if (file === null) return null;
      const span = computeAnchorLines(anchor, file.content);
      if (span === null) return null;
      return formatAnchorLineLabel(span);
    },
    [file],
  );

  return {
    folderPath,
    deepLinkPath,
    highlightSpan,
    viewerScrollRef,
    handleScrollToAnchor,
    formatAnchorLineLabelForSidePane,
  };
}
