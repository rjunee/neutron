/**
 * @neutronai/gateway/http — Expo-app project-scoped docs surface (P7.0 + P7.1).
 *
 * Per SPEC.md § Phases→Steps (P7 — Doc interface,
 * Obsidian replacement). Mounts five routes under
 * `/api/app/projects/<project_id>/docs/`:
 *
 *   - GET    .../tree              → list every doc + folder
 *   - GET    .../file?path=...     → read a single markdown file
 *   - PUT    .../file              → write a markdown file (P7.1)
 *   - POST   .../file/move         → rename / relocate (P7.1)
 *   - DELETE .../file?path=...     → unlink (P7.1)
 *   - POST   .../folder            → create an empty folder (P7.1)
 *
 * Auth: bearer-resolved via the shared `AppWsAuthResolver`, identical to
 * P5.3 / P5.4 surfaces. The bearer's `project_slug` MUST match the
 * gateway's own slug; cross-instance probes return a 403 with a stable
 * code.
 *
 * Concurrency: every PUT optionally accepts `expected_modified_at`. The
 * store re-checks the current mtime on disk and raises
 * `DocConflictError` when they disagree; the surface returns a 409 so
 * the Expo client can render an inline "file changed elsewhere" alert
 * with a Reload button.
 *
 * Server-authoritative: every write returns the canonical
 * `{ path, size_bytes, modified_at }` so the client never has to follow
 * up with a GET to learn the new mtime. This keeps optimistic-concurrency
 * tokens honest across edit cycles.
 *
 * Path safety: every routing parameter (`project_id` from the URL,
 * `path` from query/body, `from_path` / `to_path` from move bodies) is
 * fed through the doc-store's path-validator. The store enforces
 * realpath containment under `<owner_home>/Projects/<project_id>/docs/`
 * so a symlink-escape, hidden segment, `..` segment, NUL byte, or any
 * unrelated extension is rejected BEFORE any filesystem syscall reaches
 * the target.
 */

import { readFile } from 'node:fs/promises'

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import type { WebChatSessionProjectRegistry } from './chat-bridge.ts'
import {
  CommentBodyTooLargeError,
  CommentNotFoundError,
  CommentStore,
  CommentStoreError,
  MAX_ANCHOR_CTX_BYTES,
  MAX_ANCHOR_EXCERPT_BYTES,
  MAX_COMMENT_BODY_BYTES,
  type AppendEventInput,
} from '../comments/comment-store.ts'
import {
  DocConflictError,
  DocNotFoundError,
  DocPathError,
  DocSizeError,
  DocStore,
  MAX_DOC_BYTES,
  isDocLeaf,
  type DocTreeNode,
  type ReadFileResult,
  type WriteFileResult,
} from './doc-store.ts'
import {
  InvalidShaError,
  UnknownShaError,
  VersionNotFoundError,
  VersioningUnavailableError,
  type CommitSummary,
  type DiffResult,
  type VersionContent,
} from '../git/doc-version-store.ts'
import {
  BINARY_MIME_WHITELIST,
  BinaryCorruptedError,
  BinaryNotFoundError,
  BinaryPathError,
  BinarySizeError,
  BinaryStorageError,
  BinaryTypeError,
  MAX_BINARY_BYTES,
} from '../storage/binary-types.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'

export interface AppDocsSurfaceOptions {
  store: DocStore
  auth: AppWsAuthResolver
  /** Per-instance slug; bearers with a different slug get a 403. */
  project_slug: string
  /**
   * P7.2 S1 — optional inline-comments store. When omitted (legacy
   * deployments / unit tests that don't exercise comments), the four
   * `/docs/comments...` routes 503 with `comments_unavailable`.
   */
  comments?: CommentStore
  /**
   * ISSUE #41 — per-instance chat-session project tracker. When set, a
   * successful `escalate_to_chat` event append pins the resolved
   * bearer's `user_id` to the URL's `project_id` so the very next
   * chat-composer LLM turn reads pending escalations from THAT
   * project's sidecar (not the hardcoded `default` project the chat
   * surface used pre-#41). Optional for legacy boot paths + unit tests
   * that exercise only the comments surface without the chat composer
   * wired through; when omitted, the surface behaves byte-identically
   * to the pre-#41 shape (escalate succeeds; chat composer keeps
   * reading from `default`).
   */
  chatSessionProjects?: WebChatSessionProjectRegistry
}

export interface AppDocsSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface so
   * `compose.ts` falls through to the downstream chain.
   */
  handler: (req: Request) => Promise<Response | null>
}

const PATH_PREFIX = '/api/app/projects/'
// Action whitelist accepts:
//   tree | file | file/move | folder                 (existing P7.0 / P7.1)
//   history | history/<sha>                          (P7.4)
//   revert | diff                                    (P7.4)
//   binary                                            (P7.5)
// The trailing component permits a 40-hex sha for the `history/<sha>`
// shape; everything else is a-z + dashes only so a hostile client can't
// hide a path traversal in the action segment.
const DOCS_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/docs(?:\/([a-z-]+(?:\/(?:[a-z-]+|[0-9a-f]{40}))?))?$/

/**
 * P7.2 S1 — separate regex for the comments surface. Five shapes:
 *   .../docs/comments                            (list + post)
 *   .../docs/comments/<event_id>/reply           (POST reply)
 *   .../docs/comments/<event_id>/thread          (GET thread tree)
 *   .../docs/comments/<event_id>/escalate        (POST escalate-to-chat, S3)
 *   .../docs/comments/<thread_root_id>/resolve   (POST resolve thread,   S3)
 *
 * `event_id` is a 26-char Crockford-base32 ULID. The brief calls this
 * out as a distinct regex from `DOCS_PATH_RE` because the comments
 * routes don't share the path-shape semantics of `file` / `folder` —
 * sharing one big regex would muddy both.
 *
 * P7.2 S3 — added `escalate` + `resolve` to the trailing alternation.
 */
const COMMENTS_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/docs\/comments(?:\/([0-9A-HJKMNP-TV-Z]{26})\/(reply|thread|escalate|resolve))?$/

const SHA_RE = /^[0-9a-f]{40}$/

/** Crockford-base32 character set (no I/L/O/U). Used to validate the
 *  `event_id` segment of the comments routes. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function createAppDocsSurface(opts: AppDocsSurfaceOptions): AppDocsSurface {
  const { store, auth, project_slug: gateway_project_slug } = opts
  const comments = opts.comments ?? null
  const chatSessionProjects = opts.chatSessionProjects ?? null
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_PREFIX)) return null

      // P7.2 S1 — try the comments surface first. The
      // event_id-shaped paths (`.../comments/<ulid>/reply` etc.)
      // don't fit the broader DOCS_PATH_RE alternation, so we
      // dispatch them via the dedicated regex BEFORE falling
      // through to the existing file/folder/history/binary surface.
      const commentsMatch = COMMENTS_PATH_RE.exec(pathname)
      if (commentsMatch !== null) {
        const raw_project_id = commentsMatch[1] ?? ''
        const project_id = sanitizeProjectId(raw_project_id)
        if (project_id === null) {
          return jsonError(
            400,
            'invalid_project_id',
            'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
          )
        }
        const resolved = await resolveBearer(req, auth)
        if ('code' in resolved) {
          return jsonError(401, resolved.code, resolved.message)
        }
        if (ownerSlugMismatch(resolved.project_slug, gateway_project_slug)) {
          return jsonError(
            403,
            'project_mismatch',
            `bearer project '${resolved.project_slug}' does not match gateway project '${gateway_project_slug}'`,
          )
        }
        if (comments === null) {
          return jsonError(
            503,
            'comments_unavailable',
            'comments substrate is not wired on this gateway',
          )
        }
        const event_id = commentsMatch[2] ?? null
        const sub_action = commentsMatch[3] ?? null
        try {
          return await dispatchComments(
            req,
            store,
            comments,
            project_id,
            resolved.user_id,
            event_id,
            sub_action,
            chatSessionProjects,
          )
        } catch (err) {
          return jsonForError(err)
        }
      }

      const match = DOCS_PATH_RE.exec(pathname)
      if (match === null) return null

      const raw_project_id = match[1] ?? ''
      const action = match[2] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonError(
          400,
          'invalid_project_id',
          'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        )
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonError(401, resolved.code, resolved.message)
      }
      if (ownerSlugMismatch(resolved.project_slug, gateway_project_slug)) {
        return jsonError(
          403,
          'project_mismatch',
          `bearer project '${resolved.project_slug}' does not match gateway project '${gateway_project_slug}'`,
        )
      }

      const method = req.method
      try {
        if (action === 'tree') {
          if (method !== 'GET') {
            return jsonError(
              405,
              'method_not_allowed',
              `method '${method}' not allowed on /docs/tree`,
            )
          }
          return await handleTree(store, project_id)
        }
        if (action === 'file') {
          if (method === 'GET') return await handleReadFile(req, store, project_id)
          if (method === 'PUT') return await handleWriteFile(req, store, project_id)
          if (method === 'DELETE') return await handleDeleteFile(req, store, project_id)
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /docs/file`,
          )
        }
        if (action === 'file/move') {
          if (method !== 'POST') {
            return jsonError(
              405,
              'method_not_allowed',
              `method '${method}' not allowed on /docs/file/move`,
            )
          }
          return await handleMoveFile(req, store, project_id)
        }
        if (action === 'folder') {
          if (method === 'POST') return await handleCreateFolder(req, store, project_id)
          if (method === 'DELETE') return await handleDeleteFolder(req, store, project_id)
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /docs/folder`,
          )
        }
        if (action === 'history') {
          if (method !== 'GET') {
            return jsonError(
              405,
              'method_not_allowed',
              `method '${method}' not allowed on /docs/history`,
            )
          }
          return await handleHistory(req, store, project_id)
        }
        if (action.startsWith('history/')) {
          if (method !== 'GET') {
            return jsonError(
              405,
              'method_not_allowed',
              `method '${method}' not allowed on /docs/history/<sha>`,
            )
          }
          const sha = action.slice('history/'.length)
          return await handleReadVersion(req, store, project_id, sha)
        }
        if (action === 'revert') {
          if (method !== 'POST') {
            return jsonError(
              405,
              'method_not_allowed',
              `method '${method}' not allowed on /docs/revert`,
            )
          }
          return await handleRevert(req, store, project_id)
        }
        if (action === 'diff') {
          if (method !== 'GET') {
            return jsonError(
              405,
              'method_not_allowed',
              `method '${method}' not allowed on /docs/diff`,
            )
          }
          return await handleDiff(req, store, project_id)
        }
        if (action === 'binary') {
          // P7.5 — content-addressed binary surface (PUT upload, GET
          // stream, DELETE remove). Refcount semantics are documented
          // in docs/plans/P7.5-binary-large-file-handling-sprint-brief.md
          // §§ 2.4 / 4.1-4.3.
          if (method === 'PUT') return await handlePutBinary(req, store, project_id)
          if (method === 'GET') return await handleGetBinary(req, store, project_id)
          if (method === 'DELETE') return await handleDeleteBinary(req, store, project_id)
          return jsonError(
            405,
            'method_not_allowed',
            `method '${method}' not allowed on /docs/binary`,
          )
        }
        return jsonError(404, 'unknown_docs_route', `no docs route at '${pathname}'`)
      } catch (err) {
        return jsonForError(err)
      }
    },
  }
}

async function handleTree(store: DocStore, project_id: string): Promise<Response> {
  const tree = await store.tree(project_id)
  const flat = countFiles(tree)
  return jsonOk({ tree, file_count: flat })
}

function countFiles(nodes: DocTreeNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.kind === 'file') n += 1
    else n += countFiles(node.children)
  }
  return n
}

async function handleReadFile(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  const file = await store.readDoc(project_id, path)
  return jsonOk({ file: file as ReadFileResult })
}

async function handleWriteFile(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const path = readStringField(fields['path'])
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected { path: string, content: string }')
  }
  const content = fields['content']
  if (typeof content !== 'string') {
    return jsonError(
      400,
      'missing_content',
      'expected { path: string, content: string }',
    )
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) {
    return jsonError(
      413,
      'doc_too_large',
      `content exceeds ${MAX_DOC_BYTES} bytes`,
    )
  }
  const expected_modified_at = readOptionalNumber(fields['expected_modified_at'])
  if (expected_modified_at === false) {
    return jsonError(
      400,
      'invalid_expected_modified_at',
      'expected_modified_at must be a finite number or null',
    )
  }
  const writeInput: Parameters<DocStore['writeDoc']>[0] = {
    project_id,
    path,
    content,
  }
  if (expected_modified_at !== null) {
    writeInput.expected_modified_at = expected_modified_at
  }
  const result = await store.writeDoc(writeInput)
  return jsonOk({ file: result as WriteFileResult })
}

async function handleDeleteFile(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  await store.deleteDoc(project_id, path)
  return jsonOk({ deleted_path: path })
}

async function handleMoveFile(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const from_path = readStringField(fields['from_path'])
  const to_path = readStringField(fields['to_path'])
  if (from_path === null || to_path === null) {
    return jsonError(
      400,
      'missing_paths',
      'expected { from_path: string, to_path: string }',
    )
  }
  if (from_path === to_path) {
    return jsonError(400, 'invalid_paths_same', 'from_path and to_path are identical')
  }
  const result = await store.moveDoc(project_id, from_path, to_path)
  return jsonOk({ file: result as WriteFileResult, from_path })
}

async function handleCreateFolder(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const path = readStringField(fields['path'])
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected { path: string }')
  }
  await store.createFolder(project_id, path)
  return jsonOk({ folder_path: path })
}

async function handleDeleteFolder(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  await store.deleteFolder(project_id, path)
  return jsonOk({ deleted_folder_path: path })
}

/* ─── P7.4 history / version / revert / diff ─────────────────────── */

/**
 * Walks the same path-safety surface as the existing routes by
 * round-tripping through `store.readDoc`-style validation indirectly.
 * The version store does NOT realpath the on-disk file (the content
 * lives in git's object database), so we add the same string-shape
 * checks here that the docs surface applies elsewhere.
 *
 * Throws `DocPathError` on a hostile path; the dispatcher's catch
 * surfaces it as a 400.
 */
function assertHistoryPath(path: string): void {
  // Reuse the doc-store's path validator by routing through the
  // store's read path: it raises DocPathError / DocNotFoundError with
  // the same codes the existing routes surface. We don't need the
  // file to actually exist on disk — the version store can return
  // history for a deleted file — so we pre-check the string shape
  // ourselves and only fall through to the store on the well-formed
  // ones.
  if (typeof path !== 'string' || path.length === 0) {
    throw new DocPathError('invalid_path', 'path must be a non-empty string')
  }
  if (path.length > 1024) {
    throw new DocPathError('invalid_path', 'path exceeds 1024 chars')
  }
  if (path.includes('\0')) {
    throw new DocPathError('invalid_path', 'path contains NUL byte')
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new DocPathError('invalid_path', 'path must be relative')
  }
  const posix = path.replace(/\\+/g, '/')
  if (/^[A-Za-z]:\//.test(posix)) {
    throw new DocPathError('invalid_path', 'path must be relative')
  }
  const segments = posix.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) {
    throw new DocPathError('invalid_path', 'path resolves to empty')
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new DocPathError('invalid_path', 'path may not contain . or ..')
    }
    if (seg.startsWith('.')) {
      throw new DocPathError(
        'hidden_segment',
        `path may not contain hidden segments (${seg})`,
      )
    }
    if (seg.length > 256) {
      throw new DocPathError('invalid_path', `segment '${seg}' exceeds 256 chars`)
    }
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      throw new DocPathError(
        'invalid_path',
        `segment '${seg}' contains a forbidden character`,
      )
    }
  }
  // History/version/diff routes accept the SAME doc extensions as the
  // read/write routes (markdown + HTML) — surfaces the same
  // `invalid_extension` code. Uses the shared `isDocLeaf` allowlist so an
  // `.html` doc opened in the Documents tab can also load its history/comments.
  const last = segments[segments.length - 1] ?? ''
  if (!isDocLeaf(last)) {
    throw new DocPathError(
      'invalid_extension',
      `path must end with .md, .markdown, .html or .htm (got '${last}')`,
    )
  }
}

async function handleHistory(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const version = store.versioning
  if (version === null) {
    return jsonError(
      503,
      'versioning_unavailable',
      'docs versioning is not wired on this gateway',
    )
  }
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  assertHistoryPath(path)
  const url = new URL(req.url)
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw === null ? undefined : Number(limitRaw)
  if (limitRaw !== null && (!Number.isFinite(limit as number) || (limit as number) <= 0)) {
    return jsonError(400, 'invalid_limit', 'limit must be a positive number')
  }
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null && !SHA_RE.test(cursor)) {
    return jsonError(400, 'invalid_cursor', 'cursor must be a 40-char hex sha')
  }
  const callOpts: { limit?: number; before_sha?: string } = {}
  if (limit !== undefined) callOpts.limit = limit
  if (cursor !== null) callOpts.before_sha = cursor
  const result = await version.history(project_id, path, callOpts)
  return jsonOk({
    history: result.entries as CommitSummary[],
    next_cursor: result.next_cursor,
  })
}

async function handleReadVersion(
  req: Request,
  store: DocStore,
  project_id: string,
  sha: string,
): Promise<Response> {
  const version = store.versioning
  if (version === null) {
    return jsonError(
      503,
      'versioning_unavailable',
      'docs versioning is not wired on this gateway',
    )
  }
  if (!SHA_RE.test(sha)) {
    return jsonError(400, 'invalid_sha', 'sha must be a 40-char hex string')
  }
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  assertHistoryPath(path)
  const result = await version.read_at(project_id, path, sha)
  return jsonOk({ version: result as VersionContent })
}

async function handleRevert(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const version = store.versioning
  if (version === null) {
    return jsonError(
      503,
      'versioning_unavailable',
      'docs versioning is not wired on this gateway',
    )
  }
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const path = readStringField(fields['path'])
  if (path === null) {
    return jsonError(
      400,
      'missing_path',
      'expected { path: string, target_sha: string }',
    )
  }
  const target_sha = readStringField(fields['target_sha'])
  if (target_sha === null) {
    return jsonError(
      400,
      'missing_target_sha',
      'expected { path: string, target_sha: string }',
    )
  }
  assertHistoryPath(path)
  if (!SHA_RE.test(target_sha)) {
    return jsonError(400, 'invalid_sha', 'target_sha must be a 40-char hex string')
  }
  // Optional optimistic-concurrency tag — when the client supplies it,
  // a concurrent edit that landed between the user opening the history
  // pane and clicking Revert surfaces the same 409 DocConflictError
  // that a stale Save would. The brief (§ 7.4) calls this out as the
  // exact protection that keeps a revert from silently clobbering a
  // newer edit on another tab/device. Codex r1 P1.
  const expected_modified_at = readOptionalNumber(fields['expected_modified_at'])
  if (expected_modified_at === false) {
    return jsonError(
      400,
      'invalid_expected_modified_at',
      'expected_modified_at must be a finite number or null',
    )
  }
  const lookup = await version.revertContent(project_id, path, target_sha)
  if (lookup.deleted) {
    // The target sha represents a state where this path was deleted.
    // Reverting to that state means deleting the current file, NOT
    // writing an empty string (Codex r1 P2 — empty-file shape was a
    // silent semantics drift from "restore the historical state").
    //
    // Codex r2 IMPORTANT #2 — thread `expected_modified_at` through
    // the delete branch too. The earlier fix threaded it through the
    // content-revert branch via writeDoc but the delete branch went
    // straight to deleteDoc without an OCC check, so a concurrent edit
    // that landed between the user opening history and clicking Revert
    // was silently clobbered. deleteDoc now raises DocConflictError on
    // a stale mtime — the outer jsonForError catches it and returns
    // 409. When `expected_modified_at` isn't supplied (no OCC), an
    // already-gone file stays idempotent.
    const deleteOpts: { expected_modified_at?: number } = {}
    if (expected_modified_at !== null) {
      deleteOpts.expected_modified_at = expected_modified_at
    }
    try {
      await store.deleteDoc(project_id, path, deleteOpts)
    } catch (err) {
      if (err instanceof DocNotFoundError && expected_modified_at === null) {
        // Already gone AND no OCC opt-in — the desired state IS no
        // file, so the delete is idempotent. With OCC opted in, the
        // file-already-gone case is surfaced as DocConflictError by
        // deleteDoc and propagates to the caller as 409.
      } else {
        throw err
      }
    }
    return jsonOk({ file: null, target_sha, deleted: true })
  }
  const writeInput: Parameters<DocStore['writeDoc']>[0] = {
    project_id,
    path,
    content: lookup.content,
    revert_target_sha: target_sha,
  }
  if (expected_modified_at !== null) {
    writeInput.expected_modified_at = expected_modified_at
  }
  const result = await store.writeDoc(writeInput)
  return jsonOk({ file: result as WriteFileResult, target_sha, deleted: false })
}

/* ─── P7.5 binary surface ─────────────────────────────────────────── */

/** Hard ceiling on multipart wire size — 5% slack on top of the blob cap
 *  for multipart envelope overhead. Beyond this we refuse the body
 *  outright (BEFORE allocating an in-memory buffer for it). */
const MULTIPART_WIRE_LIMIT = Math.ceil(MAX_BINARY_BYTES * 1.05)

async function handlePutBinary(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const binary = store.binary
  if (binary === null) {
    return jsonError(
      503,
      'binary_unavailable',
      'binary storage is not wired on this gateway',
    )
  }
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  // Round-2 IMPORTANT #2 — REQUIRE Content-Length on every PUT. The
  // existing 413 guard fired only when CL was present; a chunked-transfer
  // PUT without Content-Length bypassed it, and `req.formData()` would
  // buffer the entire body into memory before the `file.size` check
  // kicked in — letting a hostile client drive OOM with a multi-GB
  // chunked stream. Rejecting with 411 (the canonical RFC-7230 code) is
  // simpler than streaming with a byte-cap counter; the gateway has no
  // legitimate clients that use chunked encoding.
  const contentLengthHeader = req.headers.get('content-length')
  if (contentLengthHeader === null) {
    return jsonError(
      411,
      'length_required',
      'Content-Length header is required on /docs/binary uploads (chunked transfer-encoding rejected)',
    )
  }
  const len = Number(contentLengthHeader)
  if (!Number.isFinite(len) || len < 0) {
    return jsonError(
      400,
      'invalid_content_length',
      `Content-Length must be a non-negative integer (got ${contentLengthHeader})`,
    )
  }
  if (len > MULTIPART_WIRE_LIMIT) {
    return jsonError(
      413,
      'binary_too_large',
      `multipart body exceeds ${MULTIPART_WIRE_LIMIT} bytes (got ${len})`,
    )
  }
  let form: Awaited<ReturnType<typeof req.formData>>
  try {
    form = await req.formData()
  } catch {
    return jsonError(
      400,
      'malformed_multipart',
      'expected multipart/form-data with a file part',
    )
  }
  const part = form.get('file')
  if (part === null || typeof part === 'string') {
    return jsonError(
      400,
      'missing_file_part',
      "expected a 'file' part in the multipart body",
    )
  }
  const file = part as File
  if (file.size > MAX_BINARY_BYTES) {
    return jsonError(
      413,
      'binary_too_large',
      `binary exceeds ${MAX_BINARY_BYTES} bytes (got ${file.size})`,
    )
  }
  const buffer = new Uint8Array(await file.arrayBuffer())
  if (buffer.length > MAX_BINARY_BYTES) {
    return jsonError(
      413,
      'binary_too_large',
      `binary exceeds ${MAX_BINARY_BYTES} bytes (got ${buffer.length})`,
    )
  }
  const declared =
    typeof file.type === 'string' && file.type.length > 0 ? file.type : null
  await binary.ensureInit(project_id)
  const result = await binary.put(project_id, path, buffer, declared)
  return jsonOk({ file: result })
}

async function handleGetBinary(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const binary = store.binary
  if (binary === null) {
    return jsonError(
      503,
      'binary_unavailable',
      'binary storage is not wired on this gateway',
    )
  }
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  await binary.ensureInit(project_id)
  const row = binary.get(project_id, path)
  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch !== null && ifNoneMatch.replace(/"/g, '') === row.hash) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: `"${row.hash}"`,
      },
    })
  }
  const bytes = await readFile(row.abs_path)
  const headers: Record<string, string> = {
    'Content-Type': row.content_type,
    'Content-Length': String(row.size_bytes),
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: `"${row.hash}"`,
  }
  if (row.content_type === 'image/svg+xml') {
    // Round-2 IMPORTANT #1 — Belt-and-suspenders defence against
    // script-in-SVG XSS. CSP `default-src 'none'; sandbox` blocks
    // inline / external scripts in modern browsers when the SVG is
    // navigated to directly, but coverage is patchy in older Safari /
    // WebKit and embedded webviews. Adding `Content-Disposition:
    // attachment` forces direct GETs to download rather than render,
    // closing the XSS window for legacy renderers. Embedding via
    // `<img src=...>` is unaffected — <img> never executes SVG
    // scripts regardless of headers.
    headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
    headers['X-Content-Type-Options'] = 'nosniff'
    headers['Content-Disposition'] = 'attachment'
  }
  return new Response(bytes, { status: 200, headers })
}

async function handleDeleteBinary(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const binary = store.binary
  if (binary === null) {
    return jsonError(
      503,
      'binary_unavailable',
      'binary storage is not wired on this gateway',
    )
  }
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  await binary.ensureInit(project_id)
  // Round-2 IMPORTANT #5 — `?recursive=true` deletes every binary
  // under the path prefix (used by the Expo client when the user
  // deletes a phantom-binary folder). Without this branch, the client
  // would route the delete through /docs/folder which would ENOENT
  // against `rmdir` because the folder only exists in the synthesised
  // tree view, not on disk.
  const url = new URL(req.url)
  const recursive = url.searchParams.get('recursive') === 'true'
  if (recursive) {
    const result = await binary.deletePrefix(project_id, path)
    return jsonOk({
      deleted_paths: result.deleted_paths,
      still_referenced_by: result.still_referenced_by,
    })
  }
  const result = await binary.delete(project_id, path)
  return jsonOk({
    deleted_path: result.deleted_path,
    still_referenced_by: result.still_referenced_by,
  })
}

/* ─── P7.2 S1 inline comments ─────────────────────────────────── */

/**
 * Dispatcher for the four S1 comments routes. Called only after the
 * caller has resolved auth + instance match + ensured `comments` is
 * non-null. The handlers below MUST NOT re-check those.
 *
 * Path shapes (per § 5.6):
 *   GET    /docs/comments?path=<rel>           → list
 *   POST   /docs/comments                      → post (root or reply via body)
 *   POST   /docs/comments/<event_id>/reply     → reply (shortcut)
 *   GET    /docs/comments/<event_id>/thread    → thread tree
 *
 * Escalate (.../<event_id>/escalate) is S3 work.
 */
async function dispatchComments(
  req: Request,
  store: DocStore,
  comments: CommentStore,
  project_id: string,
  resolved_user_id: string,
  event_id: string | null,
  sub_action: string | null,
  chatSessionProjects: WebChatSessionProjectRegistry | null,
): Promise<Response> {
  const method = req.method
  if (event_id === null) {
    if (method === 'GET') return await handleListComments(req, comments, project_id)
    if (method === 'POST') {
      return await handlePostComment(
        req,
        store,
        comments,
        project_id,
        resolved_user_id,
      )
    }
    return jsonError(
      405,
      'method_not_allowed',
      `method '${method}' not allowed on /docs/comments`,
    )
  }
  if (!ULID_RE.test(event_id)) {
    return jsonError(
      400,
      'invalid_event_id',
      'event_id must be a 26-char Crockford-base32 ULID',
    )
  }
  if (sub_action === 'reply') {
    if (method !== 'POST') {
      return jsonError(
        405,
        'method_not_allowed',
        `method '${method}' not allowed on /docs/comments/<id>/reply`,
      )
    }
    return await handleReplyComment(
      req,
      comments,
      project_id,
      event_id,
      resolved_user_id,
    )
  }
  if (sub_action === 'thread') {
    if (method !== 'GET') {
      return jsonError(
        405,
        'method_not_allowed',
        `method '${method}' not allowed on /docs/comments/<id>/thread`,
      )
    }
    return await handleGetThread(comments, project_id, event_id)
  }
  if (sub_action === 'escalate') {
    if (method !== 'POST') {
      return jsonError(
        405,
        'method_not_allowed',
        `method '${method}' not allowed on /docs/comments/<id>/escalate`,
      )
    }
    return await handleEscalateComment(
      req,
      comments,
      project_id,
      event_id,
      resolved_user_id,
      chatSessionProjects,
    )
  }
  if (sub_action === 'resolve') {
    if (method !== 'POST') {
      return jsonError(
        405,
        'method_not_allowed',
        `method '${method}' not allowed on /docs/comments/<id>/resolve`,
      )
    }
    return await handleResolveComment(
      req,
      comments,
      project_id,
      event_id,
      resolved_user_id,
    )
  }
  return jsonError(404, 'unknown_comments_route', `no comments route at this path`)
}

async function handleListComments(
  req: Request,
  comments: CommentStore,
  project_id: string,
): Promise<Response> {
  const url = new URL(req.url)
  const path = url.searchParams.get('path')
  if (path === null || path.length === 0) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  // Argus r1 BLOCKING #2 — same NUL / absolute / Windows / hidden /
  // .. / non-.md gates as the docs-history surface.
  assertHistoryPath(path)
  const include_dead = url.searchParams.get('include_dead') === 'true'
  const limitRaw = url.searchParams.get('limit')
  let limit: number | undefined
  if (limitRaw !== null) {
    const n = Number(limitRaw)
    if (!Number.isFinite(n) || n <= 0) {
      return jsonError(400, 'invalid_limit', 'limit must be a positive number')
    }
    limit = n
  }
  const cursorRaw = url.searchParams.get('cursor')
  // Argus r1 IMPORTANT — the cursor MUST carry both `last_reply_at`
  // and `thread_root_id` so two rows sharing a ms timestamp aren't
  // silently skipped across pages. Wire encoding is `<ms>_<ulid>`;
  // legacy numeric-only cursors are still accepted (we just lose
  // the tie-break, which is the pre-fix behaviour).
  let cursor_last_reply_at: number | undefined
  let cursor_thread_root_id: string | undefined
  if (cursorRaw !== null && cursorRaw.length > 0) {
    const usIx = cursorRaw.indexOf('_')
    if (usIx !== -1) {
      const tsPart = cursorRaw.slice(0, usIx)
      const idPart = cursorRaw.slice(usIx + 1)
      const n = Number(tsPart)
      if (!Number.isFinite(n) || n < 0) {
        return jsonError(400, 'invalid_cursor', 'cursor must be a <ms>_<ulid> tuple')
      }
      if (!ULID_RE.test(idPart)) {
        return jsonError(
          400,
          'invalid_cursor',
          'cursor thread_root_id segment must be a 26-char Crockford-base32 ULID',
        )
      }
      cursor_last_reply_at = n
      cursor_thread_root_id = idPart
    } else {
      const n = Number(cursorRaw)
      if (!Number.isFinite(n) || n < 0) {
        return jsonError(400, 'invalid_cursor', 'cursor must be a ms-epoch number')
      }
      cursor_last_reply_at = n
    }
  }
  const result = await comments.listThreads(project_id, {
    doc_path: path,
    include_dead,
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor_last_reply_at !== undefined ? { cursor_last_reply_at } : {}),
    ...(cursor_thread_root_id !== undefined ? { cursor_thread_root_id } : {}),
  })
  // Encode the composite cursor for the wire as `<ms>_<ulid>`. Older
  // clients that parse the cursor numerically will still get a sane
  // last_reply_at — they just lose the secondary key.
  const next_cursor =
    result.next_cursor === null
      ? null
      : `${result.next_cursor.last_reply_at}_${result.next_cursor.thread_root_id}`
  return jsonOk({
    threads: result.threads,
    next_cursor,
  })
}

async function handlePostComment(
  req: Request,
  store: DocStore,
  comments: CommentStore,
  project_id: string,
  resolved_user_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const path = readStringField(fields['path'])
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected { path: string, ... }')
  }
  // Argus r1 BLOCKING #2 — same path safety as history/version/diff
  // before any comment row is written. NUL bytes, absolute / Windows
  // absolute paths, hidden segments, .. segments, and non-.md
  // extensions all 400 here.
  assertHistoryPath(path)
  const bodyText = readStringField(fields['body'])
  if (bodyText === null) {
    return jsonError(400, 'missing_body', 'expected { body: string }')
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_COMMENT_BODY_BYTES) {
    return jsonError(
      413,
      'comment_too_large',
      `body exceeds ${MAX_COMMENT_BODY_BYTES} bytes`,
    )
  }
  const parent_event_id_raw = fields['parent_event_id']
  let parent_event_id: string | null = null
  if (parent_event_id_raw !== null && parent_event_id_raw !== undefined) {
    if (typeof parent_event_id_raw !== 'string' || parent_event_id_raw.length === 0) {
      return jsonError(
        400,
        'invalid_parent_event_id',
        'parent_event_id must be a non-empty string or null',
      )
    }
    if (!ULID_RE.test(parent_event_id_raw)) {
      return jsonError(
        400,
        'invalid_parent_event_id',
        'parent_event_id must be a 26-char Crockford-base32 ULID',
      )
    }
    parent_event_id = parent_event_id_raw
  }
  // Anchor fields are required ONLY for root comments. Replies inherit
  // the parent's thread anchor; the client SHOULD pass null for every
  // anchor field on a reply, but we treat undefined/null as null
  // defensively.
  let anchor_start: number | null = null
  let anchor_end: number | null = null
  let anchor_text_excerpt: string | null = null
  let anchor_ctx_before: string | null = null
  let anchor_ctx_after: string | null = null
  let based_on_modified_at: number | null = null
  if (parent_event_id === null) {
    const startRaw = fields['anchor_start']
    const endRaw = fields['anchor_end']
    if (typeof startRaw !== 'number' || !Number.isFinite(startRaw) || startRaw < 0) {
      return jsonError(
        400,
        'invalid_anchor',
        'anchor_start must be a non-negative number on a root comment',
      )
    }
    if (typeof endRaw !== 'number' || !Number.isFinite(endRaw) || endRaw < startRaw) {
      return jsonError(
        400,
        'invalid_anchor',
        'anchor_end must be a number >= anchor_start on a root comment',
      )
    }
    anchor_start = startRaw
    anchor_end = endRaw
    anchor_text_excerpt = readStringField(fields['anchor_text_excerpt'])
    if (anchor_text_excerpt === null) {
      return jsonError(
        400,
        'invalid_anchor',
        'anchor_text_excerpt is required on a root comment',
      )
    }
    if (Buffer.byteLength(anchor_text_excerpt, 'utf8') > MAX_ANCHOR_EXCERPT_BYTES) {
      return jsonError(
        413,
        'anchor_excerpt_too_large',
        `anchor_text_excerpt exceeds ${MAX_ANCHOR_EXCERPT_BYTES} bytes`,
      )
    }
    if (anchor_text_excerpt.trim().length === 0) {
      return jsonError(
        400,
        'whitespace_only_excerpt',
        'anchor_text_excerpt must contain at least one non-whitespace character',
      )
    }
    const ctxBefore = fields['anchor_ctx_before']
    const ctxAfter = fields['anchor_ctx_after']
    anchor_ctx_before = typeof ctxBefore === 'string' ? ctxBefore : ''
    anchor_ctx_after = typeof ctxAfter === 'string' ? ctxAfter : ''
    if (Buffer.byteLength(anchor_ctx_before, 'utf8') > MAX_ANCHOR_CTX_BYTES) {
      return jsonError(
        413,
        'anchor_ctx_too_large',
        `anchor_ctx_before exceeds ${MAX_ANCHOR_CTX_BYTES} bytes`,
      )
    }
    if (Buffer.byteLength(anchor_ctx_after, 'utf8') > MAX_ANCHOR_CTX_BYTES) {
      return jsonError(
        413,
        'anchor_ctx_too_large',
        `anchor_ctx_after exceeds ${MAX_ANCHOR_CTX_BYTES} bytes`,
      )
    }
    const basedRaw = fields['based_on_modified_at']
    if (typeof basedRaw === 'number' && Number.isFinite(basedRaw)) {
      based_on_modified_at = basedRaw
    } else if (basedRaw !== null && basedRaw !== undefined) {
      return jsonError(
        400,
        'invalid_based_on_modified_at',
        'based_on_modified_at must be a finite number, null, or omitted',
      )
    }
    // ISSUES #13 — require `based_on_modified_at` on root comments. Spec
    // § 5.2 step 4 ("compare based_on_modified_at against current
    // modified_at; mismatch → 409") implies the field is required —
    // the prior wire DTO marked it optional, so any client could simply
    // omit it and bypass the doc_changed_underfoot OCC entirely,
    // landing a row with offsets computed against an unspecified
    // baseline. The reply path is safe (replies inherit the anchor
    // from the parent thread), so this 400 is scoped to root posts.
    if (based_on_modified_at === null) {
      return jsonError(
        400,
        'missing_based_on_modified_at',
        'based_on_modified_at is required on a root comment (the OCC baseline)',
      )
    }
  }
  // Argus r1 BLOCKING #1 — author identity comes from the resolved
  // bearer, NEVER from the client body. Hardcoded to 'user' on this
  // app-facing route; agent/system events land via a server-side
  // CommentStore.appendEvent path in S3 (S3 watcher), not via HTTP.
  const author_kind = 'user' as const
  const author_id = resolved_user_id

  // Argus r1 MINOR — doc_changed_underfoot OCC. When the client
  // anchors a root comment to a specific `based_on_modified_at` and
  // the doc on disk no longer matches, return 409 BEFORE writing the
  // event. The same shape as DocConflictError so the client's
  // existing 409 handler (Reload prompt) renders.
  if (parent_event_id === null && based_on_modified_at !== null) {
    const current = await statDocModifiedAt(store, project_id, path)
    if (current !== based_on_modified_at) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: 'doc_changed_underfoot',
          message:
            current === null
              ? `path=${path} no longer exists (based_on_modified_at=${based_on_modified_at}); refetch and retry`
              : `path=${path} was modified elsewhere (current=${current}, based_on=${based_on_modified_at})`,
          current_modified_at: current,
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      )
    }
  }

  // Argus r2 IMPORTANT #2 — when posting a reply via the body-supplied
  // `parent_event_id`, the canonical `doc_path` is the parent thread's
  // root doc_path, NOT whatever the client passed in `path`. The
  // `/comments/<id>/reply` shortcut already does this. If we trusted
  // the body `path`, the reply row would land with mismatched doc_path
  // (and a thread_root_id pointing into the actual root's doc), which
  // desyncs the materialised view: listThreads for doc B would show
  // the reply count under the wrong doc, and the thread tree on doc A
  // would either miss the reply or pull rows from doc B. The path
  // string the client sent has already been validated by
  // assertHistoryPath above; the canonical doc_path coming back from
  // the store was validated at the time the root was written, so we
  // don't re-validate it here.
  let doc_path_for_event = path
  if (parent_event_id !== null) {
    const thread = await comments.getThread(project_id, parent_event_id)
    doc_path_for_event = thread.root.doc_path
  }

  const input: AppendEventInput = {
    event_kind: 'comment_posted',
    doc_path: doc_path_for_event,
    thread_root_id: null,
    parent_event_id,
    anchor_start,
    anchor_end,
    anchor_text_excerpt,
    anchor_ctx_before,
    anchor_ctx_after,
    based_on_modified_at,
    author_kind,
    author_id,
    body: bodyText,
    metadata_json: null,
  }
  const result = await comments.appendEvent(project_id, input)
  return jsonOk({
    event: result.event,
    thread_root_id: result.thread_root_id,
  })
}

async function handleReplyComment(
  req: Request,
  comments: CommentStore,
  project_id: string,
  parent_event_id: string,
  resolved_user_id: string,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body')
  }
  const fields = body as Record<string, unknown>
  const bodyText = readStringField(fields['body'])
  if (bodyText === null) {
    return jsonError(400, 'missing_body', 'expected { body: string }')
  }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_COMMENT_BODY_BYTES) {
    return jsonError(
      413,
      'comment_too_large',
      `body exceeds ${MAX_COMMENT_BODY_BYTES} bytes`,
    )
  }
  // Argus r1 BLOCKING #1 — author identity comes from the resolved
  // bearer, NEVER from the client body. Hardcoded to 'user' on this
  // app-facing reply route.
  const author_kind = 'user' as const
  const author_id = resolved_user_id
  // The store fills doc_path / thread_root_id from the parent — but
  // appendEvent's input requires doc_path. Read it from the parent
  // BEFORE delegating so the store call has a complete row. The
  // CommentStore wouldn't strictly need this if it inferred doc_path
  // from the parent too; this keeps the input shape uniform across
  // the two POST flows.
  const thread = await comments.getThread(project_id, parent_event_id)
  const input: AppendEventInput = {
    event_kind: 'comment_posted',
    doc_path: thread.root.doc_path,
    thread_root_id: null,
    parent_event_id,
    anchor_start: null,
    anchor_end: null,
    anchor_text_excerpt: null,
    anchor_ctx_before: null,
    anchor_ctx_after: null,
    based_on_modified_at: null,
    author_kind,
    author_id,
    body: bodyText,
    metadata_json: null,
  }
  const result = await comments.appendEvent(project_id, input)
  return jsonOk({
    event: result.event,
    thread_root_id: result.thread_root_id,
  })
}

async function handleGetThread(
  comments: CommentStore,
  project_id: string,
  event_id: string,
): Promise<Response> {
  const thread = await comments.getThread(project_id, event_id)
  return jsonOk({
    thread: {
      root: thread.root,
      anchor: thread.anchor,
      replies: thread.replies,
    },
  })
}

/* ─── P7.2 S3 escalate-to-chat + resolve ──────────────────────────── */

/**
 * P7.2 S3 — escalate an inline-comment thread to the project's chat
 * surface. Writes an `escalate_to_chat` event tied to the thread root;
 * the chat composer's `loadPendingEscalations` (see
 * `gateway/realmode-composer/escalation-loader.ts`) reads pending
 * escalate events on every chat turn and splices the rendered thread
 * history into the system prompt above the persona block.
 *
 * Per plan part C "New HTTP route" subsection:
 *   POST /api/app/projects/<id>/docs/comments/<event_id>/escalate
 *   Body:     { note?: string }
 *   Response: { ok: true, escalate_event_id, escalated_at }
 *
 * `event_id` may be the thread root OR any reply inside it — we walk
 * `comment_store.getThread` to find the canonical root. The whole
 * thread's reply chain is concatenated as `comment_body_history`
 * (each reply rendered as `author_kind:author_id\nbody`, joined by
 * `\n---\n`) and stored in `metadata_json` so the chat composer
 * doesn't need to re-walk the thread tree on its next turn.
 */
async function handleEscalateComment(
  req: Request,
  comments: CommentStore,
  project_id: string,
  event_id: string,
  resolved_user_id: string,
  chatSessionProjects: WebChatSessionProjectRegistry | null,
): Promise<Response> {
  // Body is optional — empty payload or `{}` both yield `note=null`.
  // A malformed JSON body (e.g. `{"note":}`) 400s; a missing body is
  // legal because escalate's metadata comes from the thread itself.
  const note = await readOptionalNoteField(req)
  if (note instanceof Response) return note

  // Walk to the canonical thread root. getThread accepts any event_id
  // in the thread (root or reply) and returns the root + every reply.
  let thread: Awaited<ReturnType<CommentStore['getThread']>>
  try {
    thread = await comments.getThread(project_id, event_id)
  } catch (err) {
    if (err instanceof CommentNotFoundError) {
      return jsonError(404, 'thread_not_found', err.message)
    }
    throw err
  }
  const root = thread.root
  const thread_root_id = root.thread_root_id ?? root.event_id

  // Concat the full thread reply chain into `comment_body_history`.
  // Format: each event rendered as `<author_kind>:<author_id>\n<body>`,
  // joined by the literal separator `\n---\n` (matches the plan part C
  // step 3 + the render-block convention in escalation-loader.ts).
  const ordered = [root, ...thread.replies]
  const body_segments: string[] = []
  for (const ev of ordered) {
    const body = ev.body ?? ''
    body_segments.push(`${ev.author_kind}:${ev.author_id}\n${body}`)
  }
  const comment_body_history = body_segments.join('\n---\n')

  // anchor_excerpt is the originating comment's highlighted excerpt
  // verbatim — chat composer renders it in the escalation block envelope
  // even when the anchor has since drifted/died so the user's "I'm
  // talking about THIS passage" intent survives intact.
  const metadata: Record<string, unknown> = {
    thread_root_id,
    doc_path: root.doc_path,
    anchor_excerpt: root.anchor_text_excerpt,
    comment_body_history,
    trigger: 'user_button',
  }
  if (note !== null) metadata['note'] = note

  const input: AppendEventInput = {
    event_kind: 'escalate_to_chat',
    doc_path: root.doc_path,
    thread_root_id: null,
    parent_event_id: thread_root_id,
    anchor_start: null,
    anchor_end: null,
    anchor_text_excerpt: null,
    anchor_ctx_before: null,
    anchor_ctx_after: null,
    based_on_modified_at: null,
    author_kind: 'user',
    author_id: resolved_user_id,
    body: null,
    metadata_json: JSON.stringify(metadata),
  }
  const result = await comments.appendEvent(project_id, input)
  // ISSUE #41 — pin the bearer's "current chat project_id" to the
  // project they just escalated from. The chat composer's per-turn
  // LLM wrapper reads this on the very next chat turn (via the
  // closure threaded into buildPhaseSpecResolver) so the rendered
  // <escalated_comment_threads> envelope sources from THIS sidecar,
  // not the hardcoded `default` project the pre-#41 wiring assumed.
  // When chatSessionProjects is null (legacy boot paths, tests that
  // exercise only the comments surface) the escalation event still
  // lands in the sidecar — same shape as before.
  if (chatSessionProjects !== null) {
    chatSessionProjects.setActive(resolved_user_id, project_id)
  }
  return jsonOk({
    escalate_event_id: result.event.event_id,
    escalated_at: result.event.created_at,
  })
}

/**
 * P7.2 S3 — mark a comment thread resolved. Writes a
 * `comment_resolved` event tied to the thread root. The side-pane
 * renders resolved threads as a muted "Resolved (N)" group below
 * active threads. Idempotent on already-resolved threads: returns
 * 400 `nothing_to_resolve` so the client can hide its Resolve button
 * after the first successful resolution.
 *
 * Body: `{}` or `{ note?: string }`. Note is reserved for future
 * "why was this resolved" annotation; the current side-pane doesn't
 * surface it but the event row carries it for audit.
 */
async function handleResolveComment(
  req: Request,
  comments: CommentStore,
  project_id: string,
  event_id: string,
  resolved_user_id: string,
): Promise<Response> {
  const note = await readOptionalNoteField(req)
  if (note instanceof Response) return note

  // Walk to the canonical thread root, same as escalate. Accepts a
  // reply event_id too — we always resolve at the root.
  let thread: Awaited<ReturnType<CommentStore['getThread']>>
  try {
    thread = await comments.getThread(project_id, event_id)
  } catch (err) {
    if (err instanceof CommentNotFoundError) {
      return jsonError(404, 'thread_not_found', err.message)
    }
    throw err
  }
  const root = thread.root
  const thread_root_id = root.thread_root_id ?? root.event_id

  // Idempotency — if the thread is ALREADY resolved (any event in the
  // reply chain has kind `comment_resolved`), 400 `nothing_to_resolve`.
  // The materialised anchor row doesn't yet carry a `resolved` column,
  // so we walk the in-memory thread replies; that's `O(replies)`,
  // bounded by the per-thread cap.
  for (const ev of thread.replies) {
    if (ev.event_kind === 'comment_resolved') {
      return jsonError(
        400,
        'nothing_to_resolve',
        `thread_root_id=${thread_root_id} is already resolved`,
      )
    }
  }

  const metadata: Record<string, unknown> = {
    thread_root_id,
    doc_path: root.doc_path,
  }
  if (note !== null) metadata['note'] = note

  const input: AppendEventInput = {
    event_kind: 'comment_resolved',
    doc_path: root.doc_path,
    thread_root_id: null,
    parent_event_id: thread_root_id,
    anchor_start: null,
    anchor_end: null,
    anchor_text_excerpt: null,
    anchor_ctx_before: null,
    anchor_ctx_after: null,
    based_on_modified_at: null,
    author_kind: 'user',
    author_id: resolved_user_id,
    body: null,
    metadata_json: JSON.stringify(metadata),
  }
  const result = await comments.appendEvent(project_id, input)
  return jsonOk({
    resolve_event_id: result.event.event_id,
    resolved_at: result.event.created_at,
  })
}

async function handleDiff(
  req: Request,
  store: DocStore,
  project_id: string,
): Promise<Response> {
  const version = store.versioning
  if (version === null) {
    return jsonError(
      503,
      'versioning_unavailable',
      'docs versioning is not wired on this gateway',
    )
  }
  const path = readQueryPath(req)
  if (path === null) {
    return jsonError(400, 'missing_path', 'expected ?path=<relpath>')
  }
  assertHistoryPath(path)
  const url = new URL(req.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to') ?? 'head'
  if (from === null || from.length === 0) {
    return jsonError(400, 'missing_from', 'expected ?from=<sha>')
  }
  if (!SHA_RE.test(from)) {
    return jsonError(400, 'invalid_sha', 'from must be a 40-char hex string')
  }
  if (to !== 'head' && !SHA_RE.test(to)) {
    return jsonError(
      400,
      'invalid_sha',
      "to must be a 40-char hex string or the literal 'head'",
    )
  }
  const result = await version.diff(project_id, path, from, to)
  return jsonOk({ diff: result as DiffResult })
}

interface ResolvedAuth {
  user_id: string
  project_slug: string
}

interface AuthFailure {
  code: string
  message: string
}

async function resolveBearer(
  req: Request,
  auth: AppWsAuthResolver,
): Promise<ResolvedAuth | AuthFailure> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }
  }
  const token = header.slice('bearer '.length).trim()
  const resolved = await auth.resolve(token)
  if ('code' in resolved) return { code: resolved.code, message: resolved.message }
  return { user_id: resolved.user_id, project_slug: resolved.project_slug }
}

/**
 * Argus r1 MINOR — lightweight OCC stat for the comments
 * `doc_changed_underfoot` 409. Routes through `DocStore.statDoc` so
 * the path is realpath-checked against the project root; returns the
 * current mtime in ms-epoch or `null` if the doc is gone.
 *
 * Argus r2 IMPORTANT #1 — `statDoc` raises `DocNotFoundError` BEFORE
 * it tries to `stat()` whenever the candidate file doesn't exist
 * (`assertContainedFile` short-circuits with that error after the
 * `existsSync` check fails). Treat that case the same as a stat()
 * ENOENT — the doc is gone, return null so the caller's
 * `current === null` branch fires and a deleted-doc OCC mismatch
 * surfaces as the spec'd 409 `doc_changed_underfoot` with
 * `current_modified_at: null` rather than leaking out as a 404.
 */
async function statDocModifiedAt(
  store: DocStore,
  project_id: string,
  relPath: string,
): Promise<number | null> {
  try {
    const result = await store.statDoc(project_id, relPath)
    return result === null ? null : result.modified_at
  } catch (err) {
    if (err instanceof DocNotFoundError) return null
    throw err
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

/**
 * P7.2 S3 — body parser shared by `escalate` + `resolve`. Returns:
 *   - `null` when the body is missing / empty / `{}` (note absent),
 *   - a `string` when `note` is present and well-formed,
 *   - a `Response` carrying the 400 error when the body is malformed
 *     OR `note` is the wrong type.
 *
 * Empty bodies are explicitly legal — both routes derive their main
 * payload from the thread, not from the request body. Only a
 * malformed body or a non-string `note` returns an error.
 */
async function readOptionalNoteField(
  req: Request,
): Promise<string | null | Response> {
  const cl = req.headers.get('content-length')
  // Treat unset / zero / missing body as "no fields" rather than
  // routing through `req.json()` (which throws on empty bodies).
  if (cl === null || cl === '' || Number(cl) === 0) return null
  const raw = await readJsonBody(req)
  if (raw === null) {
    return jsonError(400, 'malformed_json', 'expected JSON body or empty body')
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonError(
      400,
      'malformed_json',
      'expected a JSON object body or empty body',
    )
  }
  const fields = raw as Record<string, unknown>
  const noteRaw = fields['note']
  if (noteRaw === undefined || noteRaw === null) return null
  if (typeof noteRaw !== 'string') {
    return jsonError(400, 'invalid_note', 'note must be a string when provided')
  }
  return noteRaw
}

function readQueryPath(req: Request): string | null {
  const path = new URL(req.url).searchParams.get('path')
  if (path === null || path.length === 0) return null
  return path
}

function readStringField(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw
}

function readOptionalNumber(raw: unknown): number | null | false {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return false
  return raw
}

function jsonForError(err: unknown): Response {
  if (err instanceof DocConflictError) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: err.code,
        message: err.message,
        current_modified_at: err.current_modified_at,
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )
  }
  if (err instanceof DocNotFoundError) {
    return jsonError(404, err.code, err.message)
  }
  if (err instanceof DocSizeError) {
    return jsonError(413, err.code, err.message)
  }
  if (err instanceof DocPathError) {
    return jsonError(400, err.code, err.message)
  }
  if (err instanceof VersionNotFoundError) {
    return jsonError(404, err.code, err.message)
  }
  if (err instanceof UnknownShaError) {
    // Codex r2 BLOCKING #1 — a stale-UI / mistyped / malicious sha
    // that doesn't exist as a commit MUST surface as 404 with code
    // `unknown_sha` so the revert handler bails BEFORE touching the
    // live doc. Without this branch, the surface fell through to the
    // generic 500 and the live file was destroyed in the
    // `lookup.deleted` path.
    return jsonError(404, err.code, err.message)
  }
  if (err instanceof InvalidShaError) {
    return jsonError(400, err.code, err.message)
  }
  if (err instanceof VersioningUnavailableError) {
    return jsonError(503, err.code, err.message)
  }
  if (err instanceof BinarySizeError) {
    return jsonError(413, err.code, err.message)
  }
  if (err instanceof BinaryTypeError) {
    const status = err.code === 'content_type_spoof' ? 400 : 415
    const body: Record<string, unknown> = {
      ok: false,
      code: err.code,
      message: err.message,
    }
    if (err.declared !== null) body.declared = err.declared
    if (err.sniffed !== null) body.sniffed = err.sniffed
    if (err.code === 'unsupported_type') body.allowed_types = BINARY_MIME_WHITELIST
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (err instanceof BinaryNotFoundError) {
    return jsonError(404, err.code, err.message)
  }
  if (err instanceof BinaryCorruptedError) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: err.code,
        message: err.message,
        path: err.path,
        hash: err.hash,
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  }
  if (err instanceof BinaryStorageError) {
    return jsonError(507, err.code, err.message)
  }
  if (err instanceof BinaryPathError) {
    return jsonError(400, err.code, err.message)
  }
  if (err instanceof CommentNotFoundError) {
    return jsonError(404, err.code, err.message)
  }
  if (err instanceof CommentBodyTooLargeError) {
    return jsonError(413, err.code, err.message)
  }
  if (err instanceof CommentStoreError) {
    if (err.code === 'comments_unavailable') {
      return jsonError(503, err.code, err.message)
    }
    if (err.code === 'invalid_project_id') {
      return jsonError(400, err.code, err.message)
    }
    if (
      err.code === 'anchor_excerpt_too_large' ||
      err.code === 'anchor_ctx_too_large'
    ) {
      return jsonError(413, err.code, err.message)
    }
    return jsonError(400, err.code, err.message)
  }
  throw err
}

function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
