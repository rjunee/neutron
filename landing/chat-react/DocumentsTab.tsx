/**
 * landing/chat-react — web DOCUMENTS tab content (WAVE 3 PR-5).
 *
 * The Obsidian-replacement surface for the web project shell: a doc list →
 * open a doc → read / edit its markdown → comment on a selection. Renders as
 * the builtin `documents` tab inside `ProjectShell` (PR-4). At web↔mobile
 * parity (browse · open · read · edit · comment) as of WAVE 3 PR-6.
 *
 * ── Source of truth = the FILESYSTEM ───────────────────────────────────────
 * WAVE 3 adds NO `documents` table. This tab reads, edits + comments over the
 * existing gateway handlers (`/docs/tree`, `/docs/file` [GET+PUT],
 * `/docs/comments*`) via `WebDocsClient`. Edit (PR-6) writes the whole file
 * over `PUT /docs/file` with OCC against the open file's mtime.
 *
 * ── Anchored comments over RAW markdown ─────────────────────────────────────
 * Comment anchors are character offsets into the file's RAW content (the same
 * bytes the gateway re-anchors against). So the viewer presents SELECTABLE raw
 * markdown in a single text node and maps the DOM selection back to raw offsets
 * (`selectionOffsets`). Rendering "pretty" markdown would desync offsets from
 * the file, so v1 shows raw text — honest anchors beat pretty rendering for the
 * comment workflow.
 *
 * ── comments_unavailable degrades gracefully (plan §5 VERIFY) ───────────────
 * When the gateway has no comment substrate the comments routes 503; the client
 * surfaces `unavailable: true` and this tab still lists + views docs, hiding the
 * comment composer and showing a one-line "comments not available" note instead
 * of an error.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Markdown } from './Markdown.tsx'
import { HtmlDoc, isHtmlDoc } from './HtmlDoc.tsx'
import { DocSidebar } from './DocSidebar.tsx'
import type { BootstrapConfig } from './config.ts'
import {
  WebDocsClient,
  DocsClientError,
  buildAnchor,
  type DocFile,
  type DocTreeNode,
  type ThreadSummary,
  type ThreadTree,
} from './docs-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** Map the current window selection to char offsets within `container`. Returns
 *  null for a collapsed / cross-container selection. Range-based so it survives
 *  whatever node structure the browser splits the text into. Exported for unit
 *  testing the offset math in isolation. */
export function selectionOffsets(
  container: HTMLElement,
  sel: Selection | null,
): { start: number; end: number } | null {
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null
  }
  const pre = range.cloneRange()
  pre.selectNodeContents(container)
  try {
    pre.setEnd(range.startContainer, range.startOffset)
  } catch {
    return null
  }
  const start = pre.toString().length
  const end = start + range.toString().length
  if (end <= start) return null
  return { start, end }
}

/** True when the thread should render in the muted "Resolved" group. */
function isResolved(t: ThreadSummary): boolean {
  return t.latest_event_kind === 'comment_resolved'
}

function authorLabel(kind: string, id: string): string {
  if (kind === 'agent') return 'Agent'
  if (kind === 'system') return 'System'
  return id.length > 0 ? id : 'You'
}

/** P-A — a request to open a specific doc, e.g. from a tapped chat doc link.
 *  `nonce` changes on each request so re-tapping the same doc re-opens it. */
export interface DocOpenRequest {
  path: string
  nonce: number
}

export function DocumentsTab({
  projectId,
  config,
  fetchImpl,
  openRequest,
}: {
  projectId: string
  config: BootstrapConfig
  /** Injected in tests; defaults to the global fetch inside WebDocsClient. */
  fetchImpl?: FetchImpl
  /** P-A — when this changes, open the requested doc (a tapped chat doc link). */
  openRequest?: DocOpenRequest
}): React.JSX.Element {
  // ── Unmount safety (live crash, Ryan 2026-07-20) ────────────────────────────
  // A doc/history fetch (`docs/file?path=…`) that SETTLES after this pane
  // unmounts — the reported path was a 503 on `starting-plan.md` / `history.md`
  // during a project switch — used to run its `.then`/`.catch` continuation and
  // call setState on a component that was already gone. React surfaces that as
  // "Tried to unmount a fiber that is already unmounted"; that invariant is
  // thrown from React's own commit/teardown (NOT a child render), so the
  // per-pane PaneErrorBoundary added in #408 could not catch it — it escaped to
  // the single app-level boundary in ChatApp, which blanked the WHOLE screen.
  //
  // #408 added the boundary (necessary) but never guarded the async continuations
  // (the missing half). Two guards close it: `mountedRef` bails every
  // continuation once unmounted (no setState-after-unmount → no invariant), and
  // `abortRef` cancels the in-flight request on unmount so the 503 never lands.
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  const client = useMemo(() => {
    const base: FetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
    // Thread the pane's abort signal into every docs request; unmount aborts it.
    const withSignal: FetchImpl = (input, init) => {
      const ctrl = abortRef.current
      return base(input, ctrl !== null ? { ...init, signal: ctrl.signal } : init)
    }
    return new WebDocsClient({ base_url: config.origin, token: config.token, fetchImpl: withSignal })
  }, [config.origin, config.token, fetchImpl])

  const [tree, setTree] = useState<DocTreeNode[]>([])
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<DocFile | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)

  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [commentsUnavailable, setCommentsUnavailable] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)

  // Viewer mode — RENDERED (pretty sanitized markdown, the default) vs SOURCE
  // (raw `<pre>`). Comment anchors are character offsets into the RAW content,
  // so a selection→offset map only works over the source `<pre>`; commenting is
  // therefore offered only in Source mode, while Rendered gives the readable
  // view. Resets to Rendered whenever a different doc opens.
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered')

  // Edit mode (PR-6) — swaps the read-only viewer for a textarea bound to a
  // draft of the raw markdown. Saving writes the whole file over the existing
  // `PUT /docs/file` handler with OCC against the open file's mtime.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Active text selection over the viewer (raw-content offsets) + composer.
  const [selection, setSelection] = useState<{ start: number; end: number; excerpt: string } | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerBody, setComposerBody] = useState('')
  const [posting, setPosting] = useState(false)

  // Expanded thread (reply view) + reply composer.
  const [openThread, setOpenThread] = useState<ThreadTree | null>(null)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')

  const contentRef = useRef<HTMLPreElement>(null)
  // Monotonic guards so a slow file/comments/save response can't land after a
  // newer one (e.g. a Save that resolves after the user opened another doc).
  const fileSeq = useRef(0)
  const commentsSeq = useRef(0)
  const saveSeq = useRef(0)

  // Mount lifecycle — declared BEFORE the fetching effects so the controller is
  // fresh before any request fires (incl. StrictMode's mount→unmount→remount,
  // where the first controller is aborted and a new one takes over cleanly).
  useEffect(() => {
    mountedRef.current = true
    abortRef.current = new AbortController()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // Reset everything when the project changes — a stale open doc from project A
  // must never linger under project B's id.
  useEffect(() => {
    setTree([])
    setTreeError(null)
    setSelectedPath(null)
    setFile(null)
    setFileError(null)
    setThreads([])
    setCommentsUnavailable(false)
    setCommentsError(null)
    setSelection(null)
    setComposerOpen(false)
    setOpenThread(null)
    setOpenThreadId(null)
    setEditing(false)
    setDraft('')
    setSaveError(null)
    // Invalidate any in-flight save so its continuation can't land under the
    // newly selected project; clear `saving` too since that continuation now
    // bails before its own setSaving(false) and would otherwise stick.
    saveSeq.current += 1
    setSaving(false)
    let cancelled = false
    void client
      .tree(projectId)
      .then((res) => {
        if (cancelled || !mountedRef.current) return
        setTree(res.tree)
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return
        setTreeError(err instanceof Error ? err.message : 'failed to load documents')
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId])

  const loadComments = useCallback(
    (docPath: string): void => {
      const seq = (commentsSeq.current += 1)
      setCommentsError(null)
      void client
        .listComments(projectId, docPath)
        .then((res) => {
          if (!mountedRef.current || seq !== commentsSeq.current) return
          setThreads(res.threads)
          setCommentsUnavailable(res.unavailable)
        })
        .catch((err: unknown) => {
          if (!mountedRef.current || seq !== commentsSeq.current) return
          setThreads([])
          setCommentsError(err instanceof Error ? err.message : 'failed to load comments')
        })
    },
    [client, projectId],
  )

  const openDoc = useCallback(
    (docPath: string): void => {
      setSelectedPath(docPath)
      setSelection(null)
      setComposerOpen(false)
      setOpenThread(null)
      setOpenThreadId(null)
      setEditing(false)
      setViewMode('rendered')
      setDraft('')
      setSaveError(null)
      // A new doc invalidates any in-flight save's continuation; clear `saving`
      // so the bailed continuation can't leave the controls stuck-disabled.
      saveSeq.current += 1
      setSaving(false)
      setLoadingFile(true)
      setFileError(null)
      const seq = (fileSeq.current += 1)
      void client
        .readFile(projectId, docPath)
        .then((f) => {
          if (!mountedRef.current || seq !== fileSeq.current) return
          setFile(f)
          setLoadingFile(false)
        })
        .catch((err: unknown) => {
          // Post-unmount guard FIRST: a 503/abort landing after the pane is gone
          // must not setState (the whole-screen-blank crash). Then the staleness
          // guard for a superseded open.
          if (!mountedRef.current || seq !== fileSeq.current) return
          setFile(null)
          setLoadingFile(false)
          setFileError(err instanceof Error ? err.message : 'failed to open document')
        })
      loadComments(docPath)
    },
    [client, projectId, loadComments],
  )

  // P-A — open the doc requested by a tapped chat doc link. Keyed on the
  // request's `nonce` so re-tapping the same doc (after navigating elsewhere)
  // re-opens it. Runs after the project-reset effect above, so a cross-project
  // link that first switches project still lands on the right doc.
  const openRequestNonce = openRequest?.nonce
  const openRequestPath = openRequest?.path
  useEffect(() => {
    if (openRequestPath === undefined || openRequestPath.length === 0) return
    openDoc(openRequestPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequestNonce, openRequestPath])

  // Track the live selection inside the viewer so the "Comment" affordance only
  // lights up for a real range over the raw content.
  const onSelect = useCallback((): void => {
    const el = contentRef.current
    if (el === null || file === null) return
    const offsets = selectionOffsets(el, window.getSelection())
    if (offsets === null) {
      setSelection(null)
      return
    }
    setSelection({
      start: offsets.start,
      end: offsets.end,
      excerpt: file.content.slice(offsets.start, offsets.end),
    })
  }, [file])

  const submitComment = useCallback((): void => {
    if (file === null || selection === null || composerBody.trim().length === 0) return
    const anchor = buildAnchor(file.content, selection.start, selection.end, file.modified_at)
    if (anchor === null) return
    setPosting(true)
    void client
      .postComment(projectId, file.path, composerBody.trim(), anchor)
      .then(() => {
        if (!mountedRef.current) return
        setPosting(false)
        setComposerOpen(false)
        setComposerBody('')
        setSelection(null)
        loadComments(file.path)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setPosting(false)
        const msg =
          err instanceof DocsClientError && err.code === 'doc_changed_underfoot'
            ? 'This document changed since you opened it — reopen it and try again.'
            : err instanceof Error
              ? err.message
              : 'failed to post comment'
        setCommentsError(msg)
      })
  }, [client, projectId, file, selection, composerBody, loadComments])

  // ── edit mode (PR-6) ──
  const startEdit = useCallback((): void => {
    if (file === null) return
    setDraft(file.content)
    setSaveError(null)
    setSelection(null)
    setComposerOpen(false)
    setEditing(true)
  }, [file])

  const cancelEdit = useCallback((): void => {
    setEditing(false)
    setDraft('')
    setSaveError(null)
  }, [])

  const saveEdit = useCallback((): void => {
    if (file === null || saving) return
    const next = draft
    const docPath = file.path
    // Capture the save token; a doc-open / project-switch bumps `saveSeq` and
    // invalidates this continuation so a slow PUT can't clobber the new view.
    const seq = saveSeq.current
    setSaving(true)
    setSaveError(null)
    void client
      .writeFile(projectId, {
        path: docPath,
        content: next,
        expected_modified_at: file.modified_at,
      })
      .then((res) => {
        if (!mountedRef.current || seq !== saveSeq.current) return
        setSaving(false)
        setEditing(false)
        // Adopt the server-authoritative stat as the next OCC baseline so an
        // immediate follow-up edit doesn't false-conflict against the old mtime.
        setFile({ path: res.path, content: next, size_bytes: res.size_bytes, modified_at: res.modified_at })
        setDraft('')
        // Anchors re-anchor server-side against the new bytes — refresh threads.
        loadComments(docPath)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || seq !== saveSeq.current) return
        setSaving(false)
        // PUT /docs/file surfaces a stale `expected_modified_at` as a 409
        // `doc_modified_conflict` (DocConflictError); accept the comment-flow's
        // `doc_changed_underfoot` too so either OCC shape maps to the prompt.
        const msg =
          err instanceof DocsClientError &&
          (err.code === 'doc_modified_conflict' || err.code === 'doc_changed_underfoot')
            ? 'This document changed since you opened it — Cancel, reopen it, and reapply your edit.'
            : err instanceof DocsClientError && err.code === 'doc_too_large'
              ? 'This document is too large to save (5 MB limit).'
              : err instanceof Error
                ? err.message
                : 'failed to save document'
        setSaveError(msg)
      })
  }, [client, projectId, file, draft, saving, loadComments])

  const expandThread = useCallback(
    (threadRootId: string): void => {
      if (openThreadId === threadRootId) {
        setOpenThread(null)
        setOpenThreadId(null)
        return
      }
      setOpenThreadId(threadRootId)
      setOpenThread(null)
      setReplyBody('')
      void client
        .getThread(projectId, threadRootId)
        .then((tree) => {
          if (!mountedRef.current) return
          setOpenThread(tree)
        })
        .catch(() => {
          if (!mountedRef.current) return
          setOpenThread(null)
        })
    },
    [client, projectId, openThreadId],
  )

  const submitReply = useCallback(
    (threadRootId: string): void => {
      if (replyBody.trim().length === 0 || file === null) return
      void client
        .replyToComment(projectId, threadRootId, replyBody.trim())
        .then(() => {
          if (!mountedRef.current) return
          setReplyBody('')
          loadComments(file.path)
          // refresh the open thread tree
          void client.getThread(projectId, threadRootId).then((t) => {
            if (!mountedRef.current) return
            setOpenThread(t)
          })
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setCommentsError(err instanceof Error ? err.message : 'failed to reply')
        })
    },
    [client, projectId, file, replyBody, loadComments],
  )

  const resolveThread = useCallback(
    (threadRootId: string): void => {
      if (file === null) return
      void client
        .resolveComment(projectId, threadRootId)
        .then(() => {
          if (!mountedRef.current) return
          loadComments(file.path)
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          if (err instanceof DocsClientError && err.code === 'nothing_to_resolve') {
            loadComments(file.path)
            return
          }
          setCommentsError(err instanceof Error ? err.message : 'failed to resolve')
        })
    },
    [client, projectId, file, loadComments],
  )

  const escalateThread = useCallback(
    (threadRootId: string): void => {
      if (file === null) return
      void client
        .escalateToChat(projectId, threadRootId)
        .then(() => {
          if (!mountedRef.current) return
          setCommentsError(null)
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setCommentsError(err instanceof Error ? err.message : 'failed to escalate')
        })
    },
    [client, projectId, file],
  )

  const activeThreads = threads.filter((t) => !isResolved(t))
  const resolvedThreads = threads.filter((t) => isResolved(t))

  return (
    <div className="cdoc">
      {/* ── structured left nav (Pinned → Recent → folder tree) ── */}
      <DocSidebar tree={tree} selectedPath={selectedPath} onOpen={openDoc} treeError={treeError} />

      {/* ── viewer ── */}
      <section className="cdoc-view" aria-label="Document">
        {selectedPath === null ? (
          <div className="cdoc-empty cdoc-view-empty">Select a document to read.</div>
        ) : loadingFile ? (
          <div className="cdoc-empty cdoc-view-empty">Loading…</div>
        ) : fileError !== null ? (
          <div className="cdoc-empty cdoc-view-empty" role="alert">
            <div className="cdoc-file-error">{fileError}</div>
            {selectedPath !== null ? (
              <button
                type="button"
                className="cdoc-file-retry"
                onClick={() => openDoc(selectedPath)}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : file !== null ? (
          <>
            <header className="cdoc-view-head">
              <span className="cdoc-view-path">{file.path}</span>
              {editing ? (
                <div className="cdoc-edit-actions">
                  <button
                    type="button"
                    className="cdoc-btn cdoc-btn-primary"
                    disabled={saving || draft === file.content}
                    onClick={saveEdit}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" className="cdoc-btn" disabled={saving} onClick={cancelEdit}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="cdoc-edit-actions">
                  {/* Rendered (pretty markdown) ↔ Source (raw, comment-able). */}
                  <button
                    type="button"
                    className="cdoc-view-toggle"
                    aria-pressed={viewMode === 'source'}
                    onClick={() => {
                      // Leaving Source drops any pending selection so the Comment
                      // affordance can't linger over the now-hidden raw text.
                      setSelection(null)
                      setViewMode((m) => (m === 'rendered' ? 'source' : 'rendered'))
                    }}
                    title={
                      viewMode === 'rendered'
                        ? 'Show the raw markdown source (needed to comment)'
                        : 'Show the rendered markdown'
                    }
                  >
                    {viewMode === 'rendered' ? 'Source' : 'Rendered'}
                  </button>
                  <button type="button" className="cdoc-edit-btn" onClick={startEdit}>
                    Edit
                  </button>
                  {/* Comment anchors map to RAW offsets, so commenting is only
                      offered over the Source view's selectable `<pre>`. */}
                  {!commentsUnavailable && viewMode === 'source' ? (
                    <button
                      type="button"
                      className="cdoc-comment-btn"
                      disabled={selection === null}
                      onClick={() => {
                        if (selection !== null) {
                          setComposerOpen(true)
                          setComposerBody('')
                        }
                      }}
                      title={selection === null ? 'Select text to comment on it' : 'Comment on selection'}
                    >
                      Comment
                    </button>
                  ) : null}
                </div>
              )}
            </header>
            {editing ? (
              <>
                <textarea
                  className="cdoc-editor"
                  aria-label="Edit document"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                />
                {saveError !== null ? <div className="cdoc-comments-error">{saveError}</div> : null}
              </>
            ) : viewMode === 'rendered' ? (
              // An `.html` / `.htm` doc renders as a STATIC styled HTML/CSS page
              // (script execution stripped); every other doc renders as
              // markdown. The Source toggle + Edit still show/edit the raw text.
              isHtmlDoc(file.path) ? (
                <HtmlDoc html={file.content} className="cdoc-md" />
              ) : (
                <Markdown text={file.content} className="cdoc-md" stripFrontmatter />
              )
            ) : (
              <pre
                ref={contentRef}
                className="cdoc-content"
                onMouseUp={onSelect}
                onKeyUp={onSelect}
              >
                {file.content}
              </pre>
            )}
            {composerOpen && selection !== null ? (
              <div className="cdoc-composer" role="form" aria-label="New comment">
                <div className="cdoc-composer-excerpt">“{selection.excerpt.slice(0, 140)}”</div>
                <textarea
                  className="cdoc-composer-input"
                  placeholder="Add a comment…"
                  value={composerBody}
                  onChange={(e) => setComposerBody(e.target.value)}
                  rows={3}
                />
                <div className="cdoc-composer-actions">
                  <button
                    type="button"
                    className="cdoc-btn cdoc-btn-primary"
                    disabled={posting || composerBody.trim().length === 0}
                    onClick={submitComment}
                  >
                    {posting ? 'Posting…' : 'Post comment'}
                  </button>
                  <button
                    type="button"
                    className="cdoc-btn"
                    onClick={() => {
                      setComposerOpen(false)
                      setComposerBody('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      {/* ── comments ── */}
      <aside className="cdoc-comments" aria-label="Comments">
        {selectedPath === null ? null : commentsUnavailable ? (
          <div className="cdoc-empty">Comments aren’t available on this server.</div>
        ) : (
          <>
            {commentsError !== null ? <div className="cdoc-comments-error">{commentsError}</div> : null}
            {activeThreads.length === 0 && resolvedThreads.length === 0 ? (
              <div className="cdoc-empty">
                No comments yet. Select text and press “Comment” to start a thread.
              </div>
            ) : null}
            {activeThreads.map((t) => (
              <ThreadCard
                key={t.thread_root_id}
                thread={t}
                expanded={openThreadId === t.thread_root_id}
                tree={openThreadId === t.thread_root_id ? openThread : null}
                replyBody={openThreadId === t.thread_root_id ? replyBody : ''}
                onToggle={() => expandThread(t.thread_root_id)}
                onReplyChange={setReplyBody}
                onReply={() => submitReply(t.thread_root_id)}
                onResolve={() => resolveThread(t.thread_root_id)}
                onEscalate={() => escalateThread(t.thread_root_id)}
              />
            ))}
            {resolvedThreads.length > 0 ? (
              <div className="cdoc-resolved-head">Resolved ({resolvedThreads.length})</div>
            ) : null}
            {resolvedThreads.map((t) => (
              <ThreadCard
                key={t.thread_root_id}
                thread={t}
                resolved
                expanded={openThreadId === t.thread_root_id}
                tree={openThreadId === t.thread_root_id ? openThread : null}
                replyBody={openThreadId === t.thread_root_id ? replyBody : ''}
                onToggle={() => expandThread(t.thread_root_id)}
                onReplyChange={setReplyBody}
                onReply={() => submitReply(t.thread_root_id)}
                onResolve={() => resolveThread(t.thread_root_id)}
                onEscalate={() => escalateThread(t.thread_root_id)}
              />
            ))}
          </>
        )}
      </aside>
    </div>
  )
}

function ThreadCard({
  thread,
  tree,
  expanded,
  replyBody,
  resolved = false,
  onToggle,
  onReplyChange,
  onReply,
  onResolve,
  onEscalate,
}: {
  thread: ThreadSummary
  tree: ThreadTree | null
  expanded: boolean
  replyBody: string
  resolved?: boolean
  onToggle: () => void
  onReplyChange: (v: string) => void
  onReply: () => void
  onResolve: () => void
  onEscalate: () => void
}): React.JSX.Element {
  const excerpt = thread.anchor.excerpt ?? thread.root.anchor_text_excerpt ?? ''
  return (
    <div className={`cdoc-thread${resolved ? ' cdoc-thread-resolved' : ''}`}>
      <button type="button" className="cdoc-thread-head" onClick={onToggle} aria-expanded={expanded}>
        {excerpt.length > 0 ? <div className="cdoc-thread-anchor">“{excerpt.slice(0, 80)}”</div> : null}
        <div className="cdoc-thread-root">
          <span className="cdoc-thread-author">{authorLabel(thread.root.author_kind, thread.root.author_id)}</span>
          <span className="cdoc-thread-body">{thread.root.body ?? ''}</span>
        </div>
        {thread.reply_count > 0 ? (
          <div className="cdoc-thread-count">
            {thread.reply_count} repl{thread.reply_count === 1 ? 'y' : 'ies'}
          </div>
        ) : null}
      </button>
      {expanded ? (
        <div className="cdoc-thread-detail">
          {tree === null ? (
            <div className="cdoc-empty">Loading…</div>
          ) : (
            tree.replies.map((r) => (
              <div key={r.event_id} className="cdoc-reply">
                <span className="cdoc-thread-author">{authorLabel(r.author_kind, r.author_id)}</span>
                <span className="cdoc-thread-body">{r.body ?? ''}</span>
              </div>
            ))
          )}
          {!resolved ? (
            <div className="cdoc-reply-box">
              <textarea
                className="cdoc-composer-input"
                placeholder="Reply…"
                value={replyBody}
                onChange={(e) => onReplyChange(e.target.value)}
                rows={2}
              />
              <div className="cdoc-composer-actions">
                <button
                  type="button"
                  className="cdoc-btn cdoc-btn-primary"
                  disabled={replyBody.trim().length === 0}
                  onClick={onReply}
                >
                  Reply
                </button>
                <button type="button" className="cdoc-btn" onClick={onResolve}>
                  Resolve
                </button>
                <button type="button" className="cdoc-btn" onClick={onEscalate}>
                  Escalate to chat
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
