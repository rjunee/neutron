/**
 * @neutronai/app — pure helpers for the phone DOCS drill-down (M1 UX redesign
 * PR-5). The phone Documents surface follows the iOS Files pattern: a
 * single-pane list that drills into folders (each a router push) and opens files
 * full-screen. These helpers derive the Pinned / Recent shortcuts + the scoped
 * folder level from the hierarchical `/docs/tree` payload, and format the Recent
 * timestamps — kept out of the screen component so they unit-test without a
 * renderer. The web twin lives in `landing/chat-react/DocSidebar.tsx`.
 */

import type { DocTreeNode } from './docs-client';

/** Top-level docs pinned to the FRONT of the list, in order. Mirrors the web
 *  `PINNED_DOC_PATHS` — STATUS.md is the standard per-project state doc. */
export const PINNED_DOC_PATHS: readonly string[] = Object.freeze(['STATUS.md']);

/** How many recently-edited docs to surface in the Recent section. */
export const RECENT_LIMIT = 5;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Format a doc's `modified_at` (epoch MILLISECONDS — the gateway emits
 * `Math.floor(st.mtimeMs)`) as a compact Recent-list timestamp: <1m → `now`,
 * <1h → `Nm`, <24h → `Nh`, THIS WEEK → weekday (`Mon`), older → `Mon D`. Pure —
 * `now` is injected so it unit-tests deterministically.
 */
export function formatDocTime(ms: number | null, now: Date): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const then = new Date(ms);
  if (Number.isNaN(then.getTime())) return '';
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 60_000) return 'now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (dayDiff < 7) return WEEKDAYS[then.getDay()] ?? '';
  return `${MONTHS[then.getMonth()] ?? ''} ${then.getDate()}`;
}

/** Depth-first walk yielding every markdown FILE leaf (folders recursed,
 *  binaries skipped — they aren't viewable as docs). */
function fileLeaves(nodes: readonly DocTreeNode[], out: DocTreeNode[] = []): DocTreeNode[] {
  for (const n of nodes) {
    if (n.kind === 'file') out.push(n);
    else if (n.kind === 'folder') fileLeaves(n.children, out);
  }
  return out;
}

/** Pinned docs ({@link PINNED_DOC_PATHS}) present anywhere in the tree, in pin
 *  order. */
export function collectPinnedNodes(tree: readonly DocTreeNode[]): DocTreeNode[] {
  const leaves = fileLeaves(tree);
  const out: DocTreeNode[] = [];
  for (const p of PINNED_DOC_PATHS) {
    const hit = leaves.find((f) => f.path === p);
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

/** The `RECENT_LIMIT` most-recently-modified markdown docs, newest first,
 *  excluding the pinned docs. Ties + missing mtimes fall back to path order so
 *  the result is deterministic. */
export function collectRecentNodes(tree: readonly DocTreeNode[]): DocTreeNode[] {
  const pinned = new Set(PINNED_DOC_PATHS);
  return fileLeaves(tree)
    .filter((f) => !pinned.has(f.path) && f.modified_at !== null)
    .sort((a, b) => {
      const d = (b.modified_at ?? 0) - (a.modified_at ?? 0);
      return d !== 0 ? d : a.path.localeCompare(b.path);
    })
    .slice(0, RECENT_LIMIT);
}

/**
 * The node list at a drill level: the whole `tree` at root (`folderPath` null /
 * empty), or a folder's direct children when drilled in. Returns `null` when the
 * folder path doesn't resolve to a folder (e.g. a stale deep link) so the screen
 * can show a "folder not found" empty state instead of a blank list.
 */
export function scopeToFolder(
  tree: readonly DocTreeNode[],
  folderPath: string | null | undefined,
): DocTreeNode[] | null {
  if (folderPath === null || folderPath === undefined || folderPath.length === 0) {
    return tree.slice();
  }
  const segments = folderPath.split('/').filter((s) => s.length > 0);
  let level: readonly DocTreeNode[] = tree;
  let matched: DocTreeNode | null = null;
  for (const seg of segments) {
    const next = level.find((n) => n.kind === 'folder' && n.name === seg);
    if (next === undefined) return null;
    matched = next;
    level = next.children;
  }
  return matched === null ? null : matched.children.slice();
}

/** The display title for a drill level — the folder's last segment, or `Docs`
 *  at the root. */
export function folderTitle(folderPath: string | null | undefined): string {
  if (folderPath === null || folderPath === undefined || folderPath.length === 0) return 'Docs';
  const segments = folderPath.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? 'Docs';
}
