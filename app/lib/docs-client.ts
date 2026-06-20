/**
 * @neutronai/app — project-scoped docs API client (P7.0 + P7.1).
 *
 * Thin fetch wrapper for the gateway's
 * `/api/app/projects/<project_id>/docs/{tree,file,file/move,folder}`
 * surface. Mirrors the P5.4 TasksClient shape: pass the bearer token at
 * construction time, each call returns the canonical server view
 * (server-authoritative).
 *
 * Concurrency: `writeFile(..., { expected_modified_at })` propagates
 * the 409 from the gateway as a `DocsClientError` with `code:
 * 'doc_modified_conflict'` so the UI can prompt the user to reload.
 */

export type DocTreeKind = 'file' | 'folder' | 'binary';

/**
 * P7.5 round-2 IMPORTANT #5 — distinguishes folders that exist on disk
 * (`'markdown'`) from synthesised folders that only exist to host
 * binary leaves (`'binary'`). Phantom-binary folder deletes route
 * through `deleteBinariesUnderPrefix` instead of `deleteFolder` — the
 * latter would ENOENT against rmdir.
 */
export type DocTreeFolderOrigin = 'markdown' | 'binary';

export interface DocTreeNode {
  kind: DocTreeKind;
  path: string;
  name: string;
  size_bytes: number | null;
  modified_at: number | null;
  /** P7.5 — canonical MIME for binary leaves; null for markdown / folders. */
  content_type: string | null;
  /** P7.5 — count of markdown docs that link to this binary (binary leaves only). */
  referenced_by_count: number | null;
  /** P7.5 round-2 — only set on folders; null for files / binaries. */
  origin: DocTreeFolderOrigin | null;
  children: DocTreeNode[];
}

/* ─── P7.5 binary shapes ───────────────────────────────────────── */

export interface BinaryUploadResult {
  path: string;
  hash: string;
  size_bytes: number;
  content_type: string;
  modified_at: number;
}

export interface BinaryDeleteResult {
  deleted_path: string;
  still_referenced_by: string[];
}

/** Source descriptor for React Native's `<Image source={{ uri, headers }} />`. */
export interface BinarySource {
  uri: string;
  headers: Record<string, string>;
}

export interface DocFile {
  path: string;
  content: string;
  size_bytes: number;
  modified_at: number;
}

export interface WriteResult {
  path: string;
  size_bytes: number;
  modified_at: number;
}

/* ─── P7.4 history / version / revert / diff shapes ───────────── */

export interface CommitSummary {
  sha: string;
  parent_sha: string | null;
  message: string;
  author_date: string;
}

export interface HistoryPage {
  history: CommitSummary[];
  next_cursor: string | null;
}

export interface VersionContent {
  sha: string;
  path: string;
  content: string;
  size_bytes: number;
  author_date: string;
  message: string;
}

export interface DiffResult {
  path: string;
  from: string;
  to: string;
  hunks: string;
  truncated: boolean;
}

export interface DocsClientOptions {
  base_url: string;
  token: string;
}

/** Extensions the gateway accepts on the binary surface. Kept in sync
 *  with `gateway/storage/binary-types.ts` BINARY_EXTENSIONS so the
 *  client-side drag-drop handler can reject unsupported files before
 *  the round-trip. */
export const BINARY_EXTENSIONS = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.mp3',
  '.m4a',
  '.wav',
  '.mp4',
]) as readonly string[];

export function isBinaryExtension(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

interface TreeResponse {
  ok: boolean;
  tree: DocTreeNode[];
  file_count: number;
}

interface FileResponse {
  ok: boolean;
  file: DocFile;
}

interface WriteResponse {
  ok: boolean;
  file: WriteResult;
}

interface OkResponse {
  ok: boolean;
}

interface HistoryResponse {
  ok: boolean;
  history: CommitSummary[];
  next_cursor: string | null;
}

interface VersionResponse {
  ok: boolean;
  version: VersionContent;
}

interface DiffResponse {
  ok: boolean;
  diff: DiffResult;
}

interface RevertResponse {
  ok: boolean;
  /** Null when the revert restored a deleted state (file removed). */
  file: WriteResult | null;
  target_sha: string;
  /** True when the revert removed the file (reverting to a delete sha). */
  deleted: boolean;
}

interface ErrorResponse {
  ok?: boolean;
  code?: string;
  message?: string;
  current_modified_at?: number;
}

/* ─── P7.2 S1 inline-comments shapes ──────────────────────────── */

export type CommentEventKind =
  | 'comment_posted'
  | 'anchor_relocated'
  | 'anchor_drifted'
  | 'anchor_dead'
  | 'escalate_to_chat'
  | 'agent_reply_skipped'
  | 'comment_resolved';

export type CommentAuthorKind = 'user' | 'agent' | 'system';

export type AnchorStatus = 'live' | 'drifted' | 'dead';

/** Mirror of `DocCommentEvent` on the gateway. */
export interface CommentEvent {
  event_id: string;
  event_kind: CommentEventKind;
  doc_path: string;
  thread_root_id: string | null;
  parent_event_id: string | null;
  anchor_start: number | null;
  anchor_end: number | null;
  anchor_text_excerpt: string | null;
  anchor_ctx_before: string | null;
  anchor_ctx_after: string | null;
  based_on_modified_at: number | null;
  author_kind: CommentAuthorKind;
  author_id: string;
  body: string | null;
  metadata_json: string | null;
  created_at: number;
}

/** Mirror of `AnchorRow` on the gateway. */
export interface AnchorRow {
  thread_root_id: string;
  doc_path: string;
  current_start: number | null;
  current_end: number | null;
  status: AnchorStatus;
  drift_hint_start: number | null;
  drift_hint_end: number | null;
  last_rebuilt_from: string;
  last_rebuilt_at: number;
  reply_count: number;
  last_reply_at: number;
}

export interface ThreadSummary {
  thread_root_id: string;
  doc_path: string;
  anchor: {
    current_start: number | null;
    current_end: number | null;
    status: AnchorStatus;
    drift_hint_start: number | null;
    drift_hint_end: number | null;
    excerpt: string | null;
  };
  root: CommentEvent;
  reply_count: number;
  last_reply_at: number;
  /**
   * P7.2 S3 — kind of the latest event in this thread (root + every
   * reply, including system events like `comment_resolved` and
   * `agent_reply_skipped`). The side-pane uses this to decide:
   *
   *   - `'comment_resolved'` → render in the collapsed "Resolved (N)"
   *     section with muted styling.
   *   - `'agent_reply_skipped'` → render a "Skipped" badge on the
   *     thread row.
   *   - anything else (including `null` / absent) → render as an
   *     active thread.
   *
   * Forward-compat: S1 / S2 gateways don't supply this field (absent);
   * S3 gateways always send it as either a kind or `null` (null on
   * rows materialised before the column existed). The side-pane treats
   * absent / null / unknown-kind identically as "active thread".
   */
  latest_event_kind?: CommentEventKind | null;
}

export interface ThreadTree {
  root: CommentEvent;
  anchor: AnchorRow;
  replies: CommentEvent[];
}

export interface PostCommentInput {
  path: string;
  anchor_start: number;
  anchor_end: number;
  anchor_text_excerpt: string;
  anchor_ctx_before: string;
  anchor_ctx_after: string;
  body: string;
  parent_event_id?: string | null;
  /**
   * OCC baseline for root posts (required). The gateway compares this
   * against the on-disk doc's `modified_at` and 409s if they differ
   * (`doc_changed_underfoot`). Per ISSUES #13 the field is required —
   * omitting or passing `null` on a root post returns 400
   * `missing_based_on_modified_at`. Reply posts (parent_event_id !==
   * null) inherit the parent thread's anchor and ignore this field;
   * `null` is still accepted there for ergonomic symmetry.
   */
  based_on_modified_at: number | null;
}

interface CommentsListResponse {
  ok: boolean;
  threads: ThreadSummary[];
  /** Composite cursor token `<ms>_<ulid>` from the gateway. Opaque to
   *  the client — echo it back via `opts.cursor` on the next page. */
  next_cursor: string | null;
}

interface CommentsPostResponse {
  ok: boolean;
  event: CommentEvent;
  thread_root_id: string;
}

interface CommentsThreadResponse {
  ok: boolean;
  thread: ThreadTree;
}

/* ─── P7.2 S3 escalate + resolve shapes ───────────────────────── */

interface CommentsEscalateResponse {
  ok: boolean;
  escalate_event_id: string;
  escalated_at: number;
}

interface CommentsResolveResponse {
  ok: boolean;
  resolve_event_id: string;
  resolved_at: number;
}

export class DocsClient {
  private readonly base_url: string;
  private readonly token: string;

  constructor(opts: DocsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
  }

  async tree(project_id: string): Promise<{ tree: DocTreeNode[]; file_count: number }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/tree`;
    const res = await this.req<TreeResponse>(path);
    return { tree: res.tree, file_count: res.file_count };
  }

  async readFile(project_id: string, relPath: string): Promise<DocFile> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/file?path=${encodeURIComponent(relPath)}`;
    const res = await this.req<FileResponse>(path);
    return res.file;
  }

  async writeFile(
    project_id: string,
    input: { path: string; content: string; expected_modified_at?: number },
  ): Promise<WriteResult> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/file`;
    const body: Record<string, unknown> = {
      path: input.path,
      content: input.content,
    };
    if (input.expected_modified_at !== undefined) {
      body.expected_modified_at = input.expected_modified_at;
    }
    const res = await this.req<WriteResponse>(path, { method: 'PUT', body });
    return res.file;
  }

  async moveFile(
    project_id: string,
    from_path: string,
    to_path: string,
  ): Promise<WriteResult> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/file/move`;
    const res = await this.req<WriteResponse>(path, {
      method: 'POST',
      body: { from_path, to_path },
    });
    return res.file;
  }

  async deleteFile(project_id: string, relPath: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/file?path=${encodeURIComponent(relPath)}`;
    await this.req<OkResponse>(path, { method: 'DELETE' });
  }

  async createFolder(project_id: string, relPath: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/folder`;
    await this.req<OkResponse>(path, { method: 'POST', body: { path: relPath } });
  }

  async deleteFolder(project_id: string, relPath: string): Promise<void> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/folder?path=${encodeURIComponent(relPath)}`;
    await this.req<OkResponse>(path, { method: 'DELETE' });
  }

  /* ─── P7.4 ─── */

  async history(
    project_id: string,
    relPath: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<HistoryPage> {
    const params = new URLSearchParams({ path: relPath });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor !== undefined && opts.cursor.length > 0) {
      params.set('cursor', opts.cursor);
    }
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/history?${params.toString()}`;
    const res = await this.req<HistoryResponse>(path);
    return { history: res.history, next_cursor: res.next_cursor };
  }

  async getVersion(
    project_id: string,
    sha: string,
    relPath: string,
  ): Promise<VersionContent> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/history/${encodeURIComponent(sha)}?path=${encodeURIComponent(relPath)}`;
    const res = await this.req<VersionResponse>(path);
    return res.version;
  }

  async revert(
    project_id: string,
    body: { path: string; target_sha: string; expected_modified_at?: number },
  ): Promise<{ file: WriteResult | null; deleted: boolean; target_sha: string }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/revert`;
    const res = await this.req<RevertResponse>(path, {
      method: 'POST',
      body,
    });
    return { file: res.file, deleted: res.deleted, target_sha: res.target_sha };
  }

  /* ─── P7.5 binary surface ─────────────────────────────────────── */

  async uploadBinary(
    project_id: string,
    rel_path: string,
    file: File | Blob,
    filename?: string,
  ): Promise<BinaryUploadResult> {
    const url = `${this.base_url}/api/app/projects/${encodeURIComponent(project_id)}/docs/binary?path=${encodeURIComponent(rel_path)}`;
    const form = new FormData();
    // FormData accepts (Blob, filename) so React Native's Blob-as-File
    // pattern (no separate File class) works too.
    const name = filename ?? (file instanceof File ? file.name : 'upload.bin');
    form.append('file', file as Blob, name);
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.token}`,
      },
      body: form,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* fall through */
    }
    if (!res.ok) {
      const err = (json ?? {}) as ErrorResponse;
      throw new DocsClientError(
        err.code ?? 'upload_failed',
        err.message ?? `HTTP ${res.status}`,
        res.status,
        null,
      );
    }
    const ok = (json ?? {}) as { ok?: boolean; file?: BinaryUploadResult };
    if (ok.file === undefined) {
      throw new DocsClientError('upload_failed', 'no file in response', res.status, null);
    }
    return ok.file;
  }

  /**
   * Pure URL builder for `<Image source={{ uri, headers }} />`. Returns
   * the canonical fetchable URL + the bearer header so React Native's
   * native Image fetcher can pull the bytes without bouncing through a
   * JS-land fetch first.
   */
  binaryUrl(project_id: string, rel_path: string): BinarySource {
    const uri = `${this.base_url}/api/app/projects/${encodeURIComponent(project_id)}/docs/binary?path=${encodeURIComponent(rel_path)}`;
    return {
      uri,
      headers: { authorization: `Bearer ${this.token}` },
    };
  }

  async deleteBinary(
    project_id: string,
    rel_path: string,
  ): Promise<BinaryDeleteResult> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/binary?path=${encodeURIComponent(rel_path)}`;
    const res = await this.req<{ ok: boolean; deleted_path: string; still_referenced_by: string[] }>(path, {
      method: 'DELETE',
    });
    return {
      deleted_path: res.deleted_path,
      still_referenced_by: res.still_referenced_by,
    };
  }

  /**
   * P7.5 round-2 IMPORTANT #5 — recursive binary delete under
   * `prefix`. Used by `docs.tsx` when the user deletes a phantom-binary
   * folder (a folder synthesised by the tree-merge step that doesn't
   * exist on disk). Routes to `DELETE /docs/binary?path=&recursive=true`
   * so the gateway unlinks every binary whose path starts with the
   * prefix in one transaction.
   */
  async deleteBinariesUnderPrefix(
    project_id: string,
    prefix: string,
  ): Promise<{ deleted_paths: string[]; still_referenced_by: string[] }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/binary?path=${encodeURIComponent(prefix)}&recursive=true`;
    const res = await this.req<{
      ok: boolean;
      deleted_paths: string[];
      still_referenced_by: string[];
    }>(path, { method: 'DELETE' });
    return {
      deleted_paths: res.deleted_paths,
      still_referenced_by: res.still_referenced_by,
    };
  }

  /* ─── P7.2 S1 inline comments ─────────────────────────────────── */

  async listComments(
    project_id: string,
    doc_path: string,
    opts: {
      include_dead?: boolean;
      limit?: number;
      /** Composite cursor token returned by the previous page's
       *  `next_cursor` (shape `<ms>_<ulid>`). Opaque to the client. */
      cursor?: string;
    } = {},
  ): Promise<{ threads: ThreadSummary[]; next_cursor: string | null }> {
    const params = new URLSearchParams({ path: doc_path });
    if (opts.include_dead === true) params.set('include_dead', 'true');
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor !== undefined && opts.cursor.length > 0) {
      params.set('cursor', opts.cursor);
    }
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments?${params.toString()}`;
    const res = await this.req<CommentsListResponse>(path);
    return { threads: res.threads, next_cursor: res.next_cursor };
  }

  async postComment(
    project_id: string,
    input: PostCommentInput,
  ): Promise<{ event: CommentEvent; thread_root_id: string }> {
    const url = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments`;
    const body: Record<string, unknown> = {
      path: input.path,
      body: input.body,
    };
    if (
      input.parent_event_id !== undefined &&
      input.parent_event_id !== null &&
      input.parent_event_id.length > 0
    ) {
      body.parent_event_id = input.parent_event_id;
    } else {
      body.anchor_start = input.anchor_start;
      body.anchor_end = input.anchor_end;
      body.anchor_text_excerpt = input.anchor_text_excerpt;
      body.anchor_ctx_before = input.anchor_ctx_before;
      body.anchor_ctx_after = input.anchor_ctx_after;
      // ISSUES #13 — gateway requires the OCC baseline on root posts.
      // We always supply the field; the type now marks it required so
      // a forgetful caller is caught at the TS boundary, but a defence-
      // in-depth check throws at the client edge with a clear message
      // rather than letting the gateway 400 land as an opaque toast.
      if (
        input.based_on_modified_at === undefined ||
        input.based_on_modified_at === null
      ) {
        throw new Error(
          'docs-client.postComment: based_on_modified_at is required on a root comment (the OCC baseline)',
        );
      }
      body.based_on_modified_at = input.based_on_modified_at;
    }
    const res = await this.req<CommentsPostResponse>(url, {
      method: 'POST',
      body,
    });
    return { event: res.event, thread_root_id: res.thread_root_id };
  }

  async replyToComment(
    project_id: string,
    event_id: string,
    body: string,
  ): Promise<{ event: CommentEvent; thread_root_id: string }> {
    const url = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(event_id)}/reply`;
    const requestBody: Record<string, unknown> = { body };
    const res = await this.req<CommentsPostResponse>(url, {
      method: 'POST',
      body: requestBody,
    });
    return { event: res.event, thread_root_id: res.thread_root_id };
  }

  async getThread(
    project_id: string,
    event_id: string,
  ): Promise<ThreadTree> {
    const url = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(event_id)}/thread`;
    const res = await this.req<CommentsThreadResponse>(url);
    return res.thread;
  }

  /* ─── P7.2 S3 escalate + resolve ───────────────────────────── */

  /**
   * P7.2 S3 — Escalate a thread into the project's chat surface. The
   * gateway appends an `escalate_to_chat` event whose
   * `metadata_json` carries the thread context; the chat composer's
   * `EscalationContextLoader` reads it on the next chat turn and
   * prepends the context above the persona block.
   *
   * `event_id` is the thread root event id (the side-pane button
   * passes `thread_root_id`). The gateway walks up to the root if a
   * reply id is passed instead — so passing either is safe.
   */
  async escalateToChat(
    project_id: string,
    event_id: string,
    note?: string,
  ): Promise<{ escalate_event_id: string; escalated_at: number }> {
    const url = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(event_id)}/escalate`;
    const body: Record<string, unknown> = {};
    if (note !== undefined && note.length > 0) body.note = note;
    const res = await this.req<CommentsEscalateResponse>(url, {
      method: 'POST',
      body,
    });
    return {
      escalate_event_id: res.escalate_event_id,
      escalated_at: res.escalated_at,
    };
  }

  /**
   * P7.2 S3 — Mark a thread resolved. The gateway appends a
   * `comment_resolved` event tied to the thread root; the side-pane
   * moves the thread into the collapsed "Resolved (N)" section on
   * next refetch. Pass the thread root id (typically what the
   * side-pane has on hand).
   *
   * The gateway 400s with `nothing_to_resolve` if the thread is
   * already resolved (latest event for the thread is already
   * `comment_resolved`) and 404s with `thread_not_found` if no
   * thread for the given root exists.
   */
  async resolveComment(
    project_id: string,
    thread_root_id: string,
    note?: string,
  ): Promise<{ resolve_event_id: string; resolved_at: number }> {
    const url = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(thread_root_id)}/resolve`;
    const body: Record<string, unknown> = {};
    if (note !== undefined && note.length > 0) body.note = note;
    const res = await this.req<CommentsResolveResponse>(url, {
      method: 'POST',
      body,
    });
    return {
      resolve_event_id: res.resolve_event_id,
      resolved_at: res.resolved_at,
    };
  }

  async getDiff(
    project_id: string,
    relPath: string,
    from_sha: string,
    to_sha?: string,
  ): Promise<DiffResult> {
    const params = new URLSearchParams({ path: relPath, from: from_sha });
    if (to_sha !== undefined && to_sha.length > 0) {
      params.set('to', to_sha);
    }
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/diff?${params.toString()}`;
    const res = await this.req<DiffResponse>(path);
    return res.diff;
  }

  private async req<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${this.base_url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // fall through to status-coded error below
    }
    if (!res.ok) {
      const err = (json ?? {}) as ErrorResponse;
      const code = err.code ?? 'request_failed';
      const message = err.message ?? `HTTP ${res.status}`;
      const current = typeof err.current_modified_at === 'number' ? err.current_modified_at : null;
      throw new DocsClientError(code, message, res.status, current);
    }
    return json as T;
  }
}

/**
 * Walk `tree` and return the first node whose `path` matches `target`
 * exactly. Used by the new-file modal to detect "this name is already
 * taken" before issuing a PUT (which would otherwise truncate the
 * existing file, since the gateway treats PUT as create-or-overwrite).
 */
export function findNodeByPath(
  tree: DocTreeNode[],
  target: string,
): DocTreeNode | null {
  for (const node of tree) {
    if (node.path === target) return node;
    if (node.kind === 'folder' && node.children.length > 0) {
      const hit = findNodeByPath(node.children, target);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * Shape returned by `freshEditorState()` — every per-file state field
 * the docs tab carries. Centralised so the project-change effect can't
 * forget a field. P7.1 round-4 BLOCKING #2 — before this helper, a
 * project switch left `file`/`draftContent`/`mode` from project A in
 * state while `project_id` was now B, and pressing Save silently wrote
 * A's content to the same relative path under project B.
 */
export interface EditorResetState {
  tree: DocTreeNode[];
  file: DocFile | null;
  selectedPath: string | null;
  draftContent: string;
  mode: 'view' | 'edit';
  conflict: boolean;
  error: string | null;
  existingFileConflict: string | null;
  actionSheet: DocTreeNode | null;
  renameTarget: DocTreeNode | null;
  newFileOpen: boolean;
}

/**
 * Initial / reset state for the docs editor. The project-change effect
 * applies every field via the matching setter so a freshly-loaded
 * project never inherits the previous project's open-file UI.
 *
 * P7.1 round-7 BLOCKING #2 — `tree` was previously omitted from this
 * helper. A → B project switch where B's fetchTree errored left A's
 * tree under B's project_id, and tapping a row read/wrote B with A's
 * relative paths. `tree: []` is now part of the reset surface.
 */
export function freshEditorState(): EditorResetState {
  return {
    tree: [],
    file: null,
    selectedPath: null,
    draftContent: '',
    mode: 'view',
    conflict: false,
    error: null,
    existingFileConflict: null,
    actionSheet: null,
    renameTarget: null,
    newFileOpen: false,
  };
}

/**
 * Monotonic request-sequence gate. Each in-flight fetch calls
 * `acquire()` to grab a token; before applying state, the resolver
 * calls `isLatest(token)` and bails out if a newer fetch was started
 * in the meantime.
 *
 * P7.1 round-4 IMPORTANT #3 — fetchTree / fetchFile previously
 * committed results unconditionally. A fast file-A → file-B click (or
 * a project switch mid-load) could let A's slower response land last
 * and leave the editor displaying B's content with A's open-file
 * state — subsequent Saves would target the wrong file.
 *
 * `reset()` invalidates every in-flight token at once and is used by
 * the project-change effect so a tree/file fetch from project A can
 * never apply once project_id has switched to B.
 */
export class RequestGate {
  private seq = 0;
  /** Grab a new sequence token. The latest token wins. */
  acquire(): number {
    this.seq += 1;
    return this.seq;
  }
  /** True when `token` is still the latest acquired token. */
  isLatest(token: number): boolean {
    return token === this.seq;
  }
  /** Invalidate every in-flight token. */
  reset(): void {
    this.seq += 1;
  }
}

export class DocsClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly current_modified_at: number | null;
  constructor(code: string, message: string, status: number, current_modified_at: number | null) {
    super(`${code}: ${message}`);
    this.name = 'DocsClientError';
    this.code = code;
    this.status = status;
    this.current_modified_at = current_modified_at;
  }
}

/**
 * P7.2 S3 — typed error codes the new escalate / resolve routes
 * surface. Existing S1+S2 codes (`doc_modified_conflict`,
 * `versioning_unavailable`, `upload_failed`, ...) continue to flow
 * through `DocsClientError.code` unchanged; these constants name the
 * S3-new shapes so call sites can match on them without stringly-
 * typed comparisons:
 *
 *   - `thread_not_found` (404) — `event_id` does not resolve to any
 *     thread in the sidecar (already deleted, never created, or
 *     across-project ID confusion).
 *   - `nothing_to_resolve` (400) — the thread root resolved fine but
 *     is already resolved (latest event in the thread is already
 *     `comment_resolved`). Idempotency hint: re-resolving is a no-op
 *     but the gateway is explicit so the side-pane can soften the
 *     UI ("Already resolved.") instead of toasting a generic error.
 */
export const DOCS_CLIENT_ERROR_CODES = Object.freeze({
  thread_not_found: 'thread_not_found',
  nothing_to_resolve: 'nothing_to_resolve',
}) as Readonly<Record<'thread_not_found' | 'nothing_to_resolve', string>>;
