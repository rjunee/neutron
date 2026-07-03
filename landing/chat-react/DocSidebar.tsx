/**
 * landing/chat-react — web DOCUMENTS left-nav sidebar (M1 UX redesign PR-5).
 *
 * Replaces the old FLAT file list (`.cdoc-list` + `flattenDocFiles`) with a
 * STRUCTURED left pane, top→bottom: **Pinned → Recent → folder tree**. The tree
 * endpoint already returns the hierarchy, so this consumes `DocTreeNode[]`
 * directly (no flatten step) and renders folders with standard disclosure
 * carets (▸ closed / ▾ open) — flat rows, indentation, no nested cards.
 *
 *   ┌── Documents (260px) ──┐
 *   │ PINNED                │
 *   │  📌 STATUS.md         │
 *   │ RECENT                │
 *   │  brand-guide.md   2m  │
 *   │  shortlist.md     1h  │
 *   │ FILES                 │
 *   │  ▾ 📁 research        │
 *   │      conflicts.md     │
 *   │  ▸ 📁 plans           │
 *   │  STATUS.md            │
 *   └───────────────────────┘
 *
 * The RIGHT-pane viewer/editor/comments machinery is UNCHANGED — this component
 * only restructures the left nav. Pure given its props (no fetching of its own):
 * the parent `DocumentsTab` owns the tree fetch + open-doc state.
 */

import { useMemo, useState } from 'react'

import { PINNED_DOC_PATHS, type DocTreeNode } from './docs-client.ts'

/** How many recently-edited docs to surface in the Recent section. */
const RECENT_LIMIT = 5

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/**
 * Format a doc's `modified_at` (epoch MILLISECONDS — the gateway emits
 * `Math.floor(st.mtimeMs)`) as a compact right-aligned Recent-list timestamp:
 * <1m → `now`, <1h → `Nm`, <24h → `Nh`, THIS WEEK → weekday (`Mon`), older →
 * `Mon D`. Pure — `now` is injected so it unit-tests deterministically. Returns
 * '' for a missing / unparseable time. Mirrors ChatApp's `formatRailTime`.
 */
export function formatDocTime(ms: number | null, now: Date): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  const then = new Date(ms)
  if (Number.isNaN(then.getTime())) return ''
  const diffMs = now.getTime() - then.getTime()
  if (diffMs < 60_000) return 'now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (dayDiff < 7) return WEEKDAYS[then.getDay()] ?? ''
  return `${MONTHS[then.getMonth()] ?? ''} ${then.getDate()}`
}

/** Depth-first walk yielding every markdown FILE leaf (folders recursed,
 *  binaries skipped — they aren't viewable as docs). */
function fileLeaves(nodes: readonly DocTreeNode[], out: DocTreeNode[] = []): DocTreeNode[] {
  for (const n of nodes) {
    if (n.kind === 'file') out.push(n)
    else if (n.kind === 'folder') fileLeaves(n.children, out)
  }
  return out
}

/** Pinned docs ({@link PINNED_DOC_PATHS}, i.e. STATUS.md) present in the tree,
 *  in pin order. */
export function collectPinned(tree: readonly DocTreeNode[]): DocTreeNode[] {
  const leaves = fileLeaves(tree)
  const out: DocTreeNode[] = []
  for (const p of PINNED_DOC_PATHS) {
    const hit = leaves.find((f) => f.path === p)
    if (hit !== undefined) out.push(hit)
  }
  return out
}

/** The `RECENT_LIMIT` most-recently-modified markdown docs, newest first,
 *  excluding the pinned docs (they already lead the list above). Ties + missing
 *  mtimes fall back to path order so the result is deterministic. */
export function collectRecent(tree: readonly DocTreeNode[]): DocTreeNode[] {
  const pinned = new Set(PINNED_DOC_PATHS)
  return fileLeaves(tree)
    .filter((f) => !pinned.has(f.path) && f.modified_at !== null)
    .sort((a, b) => {
      const d = (b.modified_at ?? 0) - (a.modified_at ?? 0)
      return d !== 0 ? d : a.path.localeCompare(b.path)
    })
    .slice(0, RECENT_LIMIT)
}

/** A single tappable file row (Recent / tree leaf / pinned). */
function FileRow({
  node,
  depth,
  active,
  icon,
  time,
  onOpen,
}: {
  node: DocTreeNode
  depth: number
  active: boolean
  icon?: string
  time?: string
  onOpen: (path: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`cdoc-drow cdoc-drow-file${active ? ' cdoc-drow-active' : ''}`}
      style={{ paddingLeft: 10 + depth * 18 }}
      onClick={() => onOpen(node.path)}
      title={node.path}
      aria-current={active ? 'true' : undefined}
    >
      {icon !== undefined ? <span className="cdoc-drow-icon" aria-hidden="true">{icon}</span> : null}
      <span className="cdoc-drow-name">{node.name}</span>
      {time !== undefined && time.length > 0 ? <span className="cdoc-drow-time">{time}</span> : null}
    </button>
  )
}

/** The recursive folder-tree body (Files section). Folders toggle their own
 *  disclosure; files open in the right pane. Folders default to EXPANDED — the
 *  `collapsed` set tracks the ones the user has closed, so a freshly-loaded tree
 *  reads top-to-bottom without a click. */
function TreeRows({
  nodes,
  depth,
  selectedPath,
  collapsed,
  onToggle,
  onOpen,
}: {
  nodes: readonly DocTreeNode[]
  depth: number
  selectedPath: string | null
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}): React.JSX.Element {
  return (
    <>
      {nodes.map((n) => {
        if (n.kind === 'folder') {
          const open = !collapsed.has(n.path)
          return (
            <div key={n.path}>
              <button
                type="button"
                className="cdoc-drow cdoc-drow-folder"
                style={{ paddingLeft: 10 + depth * 18 }}
                onClick={() => onToggle(n.path)}
                aria-expanded={open}
                title={n.path}
              >
                <span className="cdoc-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span className="cdoc-drow-icon" aria-hidden="true">📁</span>
                <span className="cdoc-drow-name">{n.name}</span>
              </button>
              {open && n.children.length > 0 ? (
                <TreeRows
                  nodes={n.children}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              ) : null}
            </div>
          )
        }
        if (n.kind === 'file') {
          return (
            <FileRow
              key={n.path}
              node={n}
              depth={depth}
              active={n.path === selectedPath}
              onOpen={onOpen}
            />
          )
        }
        // binary leaves aren't viewable as docs — skip
        return null
      })}
    </>
  )
}

/**
 * The structured Documents left nav: Pinned → Recent → folder tree. Consumes the
 * hierarchical `DocTreeNode[]` from `/docs/tree` directly (no flatten). Owns only
 * folder expand/collapse state; open-doc selection is lifted to the parent.
 */
export function DocSidebar({
  tree,
  selectedPath,
  onOpen,
  treeError,
}: {
  tree: DocTreeNode[]
  selectedPath: string | null
  onOpen: (path: string) => void
  treeError: string | null
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const now = useMemo(() => new Date(), [tree])
  const pinned = useMemo(() => collectPinned(tree), [tree])
  const recent = useMemo(() => collectRecent(tree), [tree])
  const hasFiles = useMemo(() => fileLeaves(tree).length > 0, [tree])

  return (
    <nav className="cdoc-side" aria-label="Documents">
      {treeError !== null ? (
        <div className="cdoc-empty">{treeError}</div>
      ) : !hasFiles ? (
        <div className="cdoc-empty">No documents yet.</div>
      ) : (
        <>
          {pinned.length > 0 ? (
            <div className="cdoc-sec" role="group" aria-label="Pinned">
              <div className="cdoc-seclbl">Pinned</div>
              {pinned.map((f) => (
                <FileRow
                  key={f.path}
                  node={f}
                  depth={0}
                  active={f.path === selectedPath}
                  icon="📌"
                  onOpen={onOpen}
                />
              ))}
            </div>
          ) : null}
          {recent.length > 0 ? (
            <div className="cdoc-sec" role="group" aria-label="Recent">
              <div className="cdoc-seclbl">Recent</div>
              {recent.map((f) => (
                <FileRow
                  key={f.path}
                  node={f}
                  depth={0}
                  active={f.path === selectedPath}
                  time={formatDocTime(f.modified_at, now)}
                  onOpen={onOpen}
                />
              ))}
            </div>
          ) : null}
          <div className="cdoc-sec" role="group" aria-label="Files">
            <div className="cdoc-seclbl">Files</div>
            <TreeRows
              nodes={tree}
              depth={0}
              selectedPath={selectedPath}
              collapsed={collapsed}
              onToggle={toggle}
              onOpen={onOpen}
            />
          </div>
        </>
      )}
    </nav>
  )
}
