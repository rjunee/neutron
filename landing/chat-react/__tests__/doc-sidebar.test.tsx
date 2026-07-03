/**
 * Component + unit test for the web DOCUMENTS left nav (M1 UX redesign PR-5).
 *
 * Covers `DocSidebar` (Pinned → Recent → folder tree) in happy-dom plus the pure
 * helpers:
 *   - the sections render top→bottom Pinned, Recent, Files with the STATUS.md
 *     pin hoisted and Recent ordered newest-first;
 *   - folders render a disclosure caret (▾ open) that toggles to ▸ (closed) and
 *     hides / re-shows the folder's children (no flat list remains);
 *   - clicking a file row calls onOpen with its path; the active row is marked;
 *   - collectPinned / collectRecent / formatDocTime behave deterministically.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { DocTreeNode } from '../docs-client.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

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
  }
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
  }
}

// A tree with a pinned STATUS.md at root, a research folder (2 files), and a
// couple of loose root files with varied mtimes.
const TREE: DocTreeNode[] = [
  folder('research', 'research', [
    file('research/conflicts.md', 'conflicts.md', 5_000),
    file('research/shortlist.md', 'shortlist.md', 4_000),
  ]),
  file('brand-guide.md', 'brand-guide.md', 3_000),
  file('STATUS.md', 'STATUS.md', 9_000),
]

async function render(
  tree: DocTreeNode[],
  onOpen: (p: string) => void,
  selectedPath: string | null = null,
): Promise<{ container: HTMLElement; root: { unmount: () => void }; act: (cb: () => void | Promise<void>) => Promise<void> }> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { DocSidebar } = await import('../DocSidebar.tsx')
  const React = await import('react')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <React.StrictMode>
        <DocSidebar tree={tree} selectedPath={selectedPath} onOpen={onOpen} treeError={null} />
      </React.StrictMode>,
    )
    await tick()
  })
  return {
    container,
    root: root as unknown as { unmount: () => void },
    act: act as unknown as (cb: () => void | Promise<void>) => Promise<void>,
  }
}

describe('DocSidebar helpers', () => {
  it('collectPinned hoists STATUS.md when present', async () => {
    const { collectPinned } = await import('../DocSidebar.tsx')
    expect(collectPinned(TREE).map((n) => n.path)).toEqual(['STATUS.md'])
    expect(collectPinned([file('a.md', 'a.md', 1)]).map((n) => n.path)).toEqual([])
  })

  it('collectRecent orders newest-first and excludes the pinned doc', async () => {
    const { collectRecent } = await import('../DocSidebar.tsx')
    // STATUS.md (pinned) excluded; rest by mtime desc.
    expect(collectRecent(TREE).map((n) => n.path)).toEqual([
      'research/conflicts.md',
      'research/shortlist.md',
      'brand-guide.md',
    ])
  })

  it('formatDocTime renders compact relative labels', async () => {
    const { formatDocTime } = await import('../DocSidebar.tsx')
    const now = new Date('2026-07-02T12:00:00Z')
    expect(formatDocTime(now.getTime() - 30_000, now)).toBe('now')
    expect(formatDocTime(now.getTime() - 5 * 60_000, now)).toBe('5m')
    expect(formatDocTime(now.getTime() - 3 * 3_600_000, now)).toBe('3h')
    expect(formatDocTime(null, now)).toBe('')
  })
})

describe('DocSidebar (happy-dom)', () => {
  it('renders Pinned → Recent → Files with a working folder disclosure', async () => {
    const opened: string[] = []
    const { container, root, act } = await render(TREE, (p) => opened.push(p))

    // Section labels present, in order.
    const labels = Array.from(container.querySelectorAll('.cdoc-seclbl')).map((n) => n.textContent)
    expect(labels).toEqual(['Pinned', 'Recent', 'Files'])

    // Folder defaults to expanded (▾) and its children are visible.
    const folderBtn = Array.from(container.querySelectorAll('.cdoc-drow-folder')).find((b) =>
      (b.textContent ?? '').includes('research'),
    ) as HTMLButtonElement
    expect(folderBtn.getAttribute('aria-expanded')).toBe('true')
    expect(folderBtn.querySelector('.cdoc-caret')?.textContent).toBe('▾')
    const visibleFiles = () =>
      Array.from(container.querySelectorAll('.cdoc-drow-file')).map((b) => b.textContent ?? '')
    expect(visibleFiles().some((t) => t.includes('conflicts.md'))).toBe(true)

    // Collapse it → caret flips to ▸ and the nested file disappears from the tree.
    await act(async () => {
      folderBtn.click()
      await tick()
    })
    expect(folderBtn.getAttribute('aria-expanded')).toBe('false')
    expect(folderBtn.querySelector('.cdoc-caret')?.textContent).toBe('▸')
    // conflicts.md still appears in Recent (a shortcut), but only ONCE now (the
    // nested tree copy is gone) — so the count drops by one.
    const collapsedConflicts = visibleFiles().filter((t) => t.includes('conflicts.md')).length
    expect(collapsedConflicts).toBe(1)

    // Re-expand.
    await act(async () => {
      folderBtn.click()
      await tick()
    })
    expect(folderBtn.querySelector('.cdoc-caret')?.textContent).toBe('▾')

    await act(async () => {
      root.unmount()
    })
  })

  it('opens a file when its row is clicked and marks the active row', async () => {
    const opened: string[] = []
    const { container, root, act } = await render(TREE, (p) => opened.push(p), 'STATUS.md')

    // The pinned STATUS.md row is active.
    const pinnedRow = Array.from(container.querySelectorAll('.cdoc-drow-file')).find((b) =>
      (b.textContent ?? '').includes('STATUS.md'),
    ) as HTMLButtonElement
    expect(pinnedRow.className).toContain('cdoc-drow-active')

    // Clicking a tree file row opens it by path.
    const brand = Array.from(container.querySelectorAll('.cdoc-drow-file')).find((b) =>
      (b.textContent ?? '').includes('brand-guide.md'),
    ) as HTMLButtonElement
    await act(async () => {
      brand.click()
      await tick()
    })
    expect(opened).toContain('brand-guide.md')

    await act(async () => {
      root.unmount()
    })
  })

  it('shows the empty state when there are no docs', async () => {
    const { container, root, act } = await render([], () => {})
    expect(container.textContent).toContain('No documents yet.')
    expect(container.querySelector('.cdoc-drow')).toBeNull()
    await act(async () => {
      root.unmount()
    })
  })
})
