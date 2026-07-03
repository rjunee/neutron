/**
 * @neutronai/app — pure-helper tests for the phone DOCS drill-down (M1 UX
 * redesign PR-5).
 *
 * Convention note (matching `comments-side-pane.test.tsx`): the app's bun:test
 * suite does NOT mount React Native components. `DocsDrillList` render coverage
 * is left to the agent-browser smoke pass; here we lock the load-bearing pure
 * logic in `lib/docs-drill.ts`:
 *   - `scopeToFolder` root + nested descent + unresolvable → null;
 *   - `collectPinnedNodes` hoists STATUS.md; `collectRecentNodes` orders
 *     newest-first + drops the pinned doc;
 *   - `folderTitle` breadcrumb label; `formatDocTime` relative labels.
 *
 * Time-dependent test discipline (Neutron CLAUDE.md hard rule): all relative
 * timestamps are derived from an injected `now`, never a hardcoded ISO string.
 */

import { describe, expect, it } from 'bun:test';

import type { DocTreeNode } from '../lib/docs-client';
import {
  collectPinnedNodes,
  collectRecentNodes,
  folderTitle,
  formatDocTime,
  scopeToFolder,
} from '../lib/docs-drill';

function file(path: string, name: string, modified_at: number | null): DocTreeNode {
  return {
    kind: 'file',
    path,
    name,
    size_bytes: 10,
    modified_at,
    content_type: null,
    referenced_by_count: null,
    origin: null,
    children: [],
  };
}
function folder(path: string, name: string, children: DocTreeNode[]): DocTreeNode {
  return {
    kind: 'folder',
    path,
    name,
    size_bytes: null,
    modified_at: null,
    content_type: null,
    referenced_by_count: null,
    origin: 'markdown',
    children,
  };
}

const TREE: DocTreeNode[] = [
  folder('research', 'research', [
    file('research/conflicts.md', 'conflicts.md', 5_000),
    file('research/shortlist.md', 'shortlist.md', 4_000),
    folder('research/deep', 'deep', [file('research/deep/leaf.md', 'leaf.md', 1_000)]),
  ]),
  file('brand-guide.md', 'brand-guide.md', 3_000),
  file('STATUS.md', 'STATUS.md', 9_000),
];

describe('scopeToFolder', () => {
  it('returns the whole tree at the root level', () => {
    expect(scopeToFolder(TREE, null)?.map((n) => n.path)).toEqual([
      'research',
      'brand-guide.md',
      'STATUS.md',
    ]);
    expect(scopeToFolder(TREE, '')?.map((n) => n.path)).toEqual([
      'research',
      'brand-guide.md',
      'STATUS.md',
    ]);
  });

  it('descends into a nested folder', () => {
    expect(scopeToFolder(TREE, 'research')?.map((n) => n.path)).toEqual([
      'research/conflicts.md',
      'research/shortlist.md',
      'research/deep',
    ]);
    expect(scopeToFolder(TREE, 'research/deep')?.map((n) => n.path)).toEqual([
      'research/deep/leaf.md',
    ]);
  });

  it('returns null for an unresolvable folder path', () => {
    expect(scopeToFolder(TREE, 'nope')).toBeNull();
    expect(scopeToFolder(TREE, 'research/ghost')).toBeNull();
    // A file path is not a folder.
    expect(scopeToFolder(TREE, 'brand-guide.md')).toBeNull();
  });
});

describe('pinned + recent', () => {
  it('collectPinnedNodes hoists STATUS.md when present', () => {
    expect(collectPinnedNodes(TREE).map((n) => n.path)).toEqual(['STATUS.md']);
    expect(collectPinnedNodes([file('a.md', 'a.md', 1)])).toEqual([]);
  });

  it('collectRecentNodes orders newest-first and excludes the pinned doc', () => {
    expect(collectRecentNodes(TREE).map((n) => n.path)).toEqual([
      'research/conflicts.md',
      'research/shortlist.md',
      'brand-guide.md',
      'research/deep/leaf.md',
    ]);
  });
});

describe('folderTitle', () => {
  it('is the last path segment, or Docs at the root', () => {
    expect(folderTitle(null)).toBe('Docs');
    expect(folderTitle('')).toBe('Docs');
    expect(folderTitle('research')).toBe('research');
    expect(folderTitle('research/deep')).toBe('deep');
  });
});

describe('formatDocTime', () => {
  it('renders compact relative labels', () => {
    const now = new Date('2026-07-02T12:00:00Z');
    expect(formatDocTime(now.getTime() - 30_000, now)).toBe('now');
    expect(formatDocTime(now.getTime() - 5 * 60_000, now)).toBe('5m');
    expect(formatDocTime(now.getTime() - 3 * 3_600_000, now)).toBe('3h');
    expect(formatDocTime(null, now)).toBe('');
    expect(formatDocTime(Number.NaN, now)).toBe('');
  });
});
