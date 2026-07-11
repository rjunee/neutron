/**
 * @neutronai/app — shared pure helpers + types for the project-scoped
 * docs tab (P7).
 *
 * D7 (world-class refactor): `DocsTab` was a ~1500-line component with
 * 4 `RequestGate`s and 32 `useState`s. The per-cluster hooks
 * (`useDocTree`, `useDocFile`, `useDocHistory`, `useDocMutations`,
 * `useDeepLinkAnchor`) and the leaf components all lean on these
 * dependency-free helpers + constants. Kept RN-free so the hooks can
 * import them without pulling `react-native` into a pure test runtime.
 */

import { SPACING, TYPOGRAPHY } from '../../lib/theme';
import { DocsClientError, type DocTreeNode } from '../../lib/docs-client';

export type EditorMode = 'view' | 'edit';
export type MobilePane = 'editor' | 'preview' | 'comments';

// P7.3 — line-height + top-padding constants the highlight overlay
// + the deep-link / tap-to-scroll handlers share. Derived from theme
// tokens so a body-line-height tweak in `lib/theme.ts` keeps the
// overlay aligned with the rendered text. `MARKDOWN_SCROLL_PADDING_TOP`
// mirrors the `markdownScroll` style's `padding: SPACING.lg` value.
// Per `lib/theme.ts:TYPOGRAPHY.body.lineHeight = 22` + `SPACING.lg = 16`
// as of 2026-05-23 — when those tokens change, this code follows.
export const BODY_LINE_HEIGHT = TYPOGRAPHY.body.lineHeight;
export const MARKDOWN_SCROLL_PADDING_TOP = SPACING.lg;

export function treeIconFor(node: DocTreeNode): string {
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

export function findBinaryNode(
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

export function normalizeRel(p: string): string | null {
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Brief human-readable timestamp. Falls back to the raw ISO string
 *  when Date parsing fails. */
export function formatHistoryDate(iso: string): string {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const d = new Date(ts);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

export function formatError(err: unknown): string {
  if (err instanceof DocsClientError) {
    return `${err.code}: ${err.message.replace(`${err.code}: `, '')}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
