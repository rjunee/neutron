/**
 * landing/chat-react — web DOCUMENTS tab content (WAVE 3 PR-5).
 *
 * The Obsidian-replacement reading surface for the web project shell: a doc
 * list → open a doc → view its markdown → comment on a selection. Renders as
 * the builtin `documents` tab inside `ProjectShell` (PR-4).
 *
 * ── Source of truth = the FILESYSTEM ───────────────────────────────────────
 * WAVE 3 adds NO `documents` table. This tab reads + comments over the existing
 * gateway handlers (`/docs/tree`, `/docs/file`, `/docs/comments*`) via
 * `WebDocsClient`. Editing is deferred to PR-6 — this is read + comment first.
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

import type { BootstrapConfig } from './config.ts'
import {
  WebDocsClient,
  DocsClientError,
  buildAnchor,
  flattenDocFiles,
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

export function DocumentsTab({
  projectId,
  config,
  fetchImpl,
}: {
  projectId: string
  config: BootstrapConfig
  /** Injected in tests; defaults to the global fetch inside WebDocsClient. */
  fetchImpl?: FetchImpl
}): React.JSX.Element {
  const client = useMemo(
    () =>
      new WebDocsClient(
        fetchImpl !== undefined
          ? { base_url: config.origin, token: config.token, fetchImpl }
          : { base_url: config.origin, token: config.token },
      ),
    [config.origin, config.token, fetchImpl],
  )

  const [files, setFiles] = useState<DocTreeNode[]>([])
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<DocFile | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)

  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [commentsUnavailable, setCommentsUnavailable] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)

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
  // Monotonic guards so a slow file/comments fetch can't land after a newer one.
  const fileSeq = useRef(0)
  const commentsSeq = useRef(0)

  // Reset everything when the project changes — a stale open doc from project A
  // must never linger under project B's id.
  useEffect(() => {
    setFiles([])
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
    let cancelled = false
    void client
      .tree(projectId)
      .then((res) => {
        if (cancelled) return
        setFiles(flattenDocFiles(res.tree))
      })
      .catch((err: unknown) => {
        if (cancelled) return
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
          if (seq !== commentsSeq.current) return
          setThreads(res.threads)
          setCommentsUnavailable(res.unavailable)
        })
        .catch((err: unknown) => {
          if (seq !== commentsSeq.current) return
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
      setLoadingFile(true)
      setFileError(null)
      const seq = (fileSeq.current += 1)
      void client
        .readFile(projectId, docPath)
        .then((f) => {
          if (seq !== fileSeq.current) return
          setFile(f)
          setLoadingFile(false)
        })
        .catch((err: unknown) => {
          if (seq !== fileSeq.current) return
          setFile(null)
          setLoadingFile(false)
          setFileError(err instanceof Error ? err.message : 'failed to open document')
        })
      loadComments(docPath)
    },
    [client, projectId, loadComments],
  )

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
        setPosting(false)
        setComposerOpen(false)
        setComposerBody('')
        setSelection(null)
        loadComments(file.path)
      })
      .catch((err: unknown) => {
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
        .then((tree) => setOpenThread(tree))
        .catch(() => setOpenThread(null))
    },
    [client, projectId, openThreadId],
  )

  const submitReply = useCallback(
    (threadRootId: string): void => {
      if (replyBody.trim().length === 0 || file === null) return
      void client
        .replyToComment(projectId, threadRootId, replyBody.trim())
        .then(() => {
          setReplyBody('')
          loadComments(file.path)
          // refresh the open thread tree
          void client.getThread(projectId, threadRootId).then((t) => setOpenThread(t))
        })
        .catch((err: unknown) => {
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
        .then(() => loadComments(file.path))
        .catch((err: unknown) => {
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
        .then(() => setCommentsError(null))
        .catch((err: unknown) => {
          setCommentsError(err instanceof Error ? err.message : 'failed to escalate')
        })
    },
    [client, projectId, file],
  )

  const activeThreads = threads.filter((t) => !isResolved(t))
  const resolvedThreads = threads.filter((t) => isResolved(t))

  return (
    <div className="cdoc">
      {/* ── doc list ── */}
      <aside className="cdoc-list" aria-label="Documents">
        {treeError !== null ? (
          <div className="cdoc-empty">{treeError}</div>
        ) : files.length === 0 ? (
          <div className="cdoc-empty">No documents yet.</div>
        ) : (
          <ul className="cdoc-list-ul">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className={`cdoc-list-item${f.path === selectedPath ? ' cdoc-list-item-active' : ''}`}
                  onClick={() => openDoc(f.path)}
                  title={f.path}
                >
                  <span className="cdoc-list-name">{f.name}</span>
                  {f.path.includes('/') ? (
                    <span className="cdoc-list-dir">{f.path.slice(0, f.path.lastIndexOf('/'))}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* ── viewer ── */}
      <section className="cdoc-view" aria-label="Document">
        {selectedPath === null ? (
          <div className="cdoc-empty cdoc-view-empty">Select a document to read.</div>
        ) : loadingFile ? (
          <div className="cdoc-empty cdoc-view-empty">Loading…</div>
        ) : fileError !== null ? (
          <div className="cdoc-empty cdoc-view-empty">{fileError}</div>
        ) : file !== null ? (
          <>
            <header className="cdoc-view-head">
              <span className="cdoc-view-path">{file.path}</span>
              {!commentsUnavailable ? (
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
            </header>
            <pre
              ref={contentRef}
              className="cdoc-content"
              onMouseUp={onSelect}
              onKeyUp={onSelect}
            >
              {file.content}
            </pre>
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
