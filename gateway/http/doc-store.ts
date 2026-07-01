/**
 * @neutronai/gateway/http — project-scoped markdown doc store (P7.0 + P7.1).
 *
 * Per SPEC.md § Phases→Steps (P7 — Doc interface,
 * Obsidian replacement). P7.0 ships the read side (tree + file read);
 * P7.1 ships the write side (PUT/move/delete/createFolder) with
 * optimistic concurrency via `expected_modified_at`.
 *
 * On disk layout (per docs/plans/project-folder-convention.md):
 *
 *   <owner_home>/Projects/<project_id>/docs/
 *     ├─ README.md
 *     ├─ notes/
 *     │   └─ brainstorm.md
 *     └─ references/
 *         └─ brand-style.md
 *
 * Every operation is path-safe by construction:
 *
 *   1. The raw `path` field is rejected if empty / absolute / containing
 *      `..` segments / containing hidden segments (any segment that starts
 *      with `.`, so a `.git` peek can't reach into the project metadata
 *      sitting next to docs/).
 *   2. The file extension MUST be `.md` (case-insensitive) for every
 *      `*File` operation. Folder operations don't have this requirement.
 *   3. After joining with the docs-root, the absolute path is realpathed
 *      and the result MUST still be a prefix-match of `realpath(docsRoot)`.
 *      This catches the symlink-escape case where a file inside docs/ is
 *      a symlink pointing at /etc/passwd or another instance's home.
 *   4. Writes go through a temp-file + rename atomic so a crash mid-write
 *      never leaves a half-written .md file at the destination.
 *   5. Optional `expected_modified_at` — when supplied, the current mtime
 *      is checked BEFORE the rename. A mismatch returns
 *      `DocConflictError` so the surface can render a 409 to the client.
 *
 * Single-writer per spec: the engineering plan locks the doc body to a
 * single-writer model (LLMs do most editing; one human writer at a time
 * is enough). Multi-writer concurrency lives in the comment threads in
 * P7.2. The 409-on-stale check above gives us per-file optimistic
 * concurrency without needing a CRDT.
 */

import { existsSync, lstatSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, normalize, relative, sep } from 'node:path'

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import type {
  CommitKind,
  DocVersionStore,
} from '../git/doc-version-store.ts'
import type { BinaryStore } from '../storage/binary-store.ts'

/**
 * Maximum byte size of a markdown file the surface will accept on
 * write. 5 MB matches the spec's "size cap 5MB". Reads aren't capped
 * — a file already on disk that exceeds this is still served (the cap
 * is a write-time guard against malicious payload bloat).
 */
export const MAX_DOC_BYTES = 5 * 1024 * 1024

/**
 * Accepted markdown extensions (case-insensitive). The P7.0 baseline
 * accepted both `.md` and `.markdown` so legacy Obsidian vaults
 * containing `.markdown` notes Just Worked when wired through a
 * symlinked docs root. The round-4 walker rewrite + the requireMd
 * check both narrowed to `/\.md$/i`, dropping `.markdown` from the
 * tree and the read/write surface entirely. Round-7 IMPORTANT #1
 * reinstates the original constant + uses it from both gates.
 */
export const MARKDOWN_EXTENSIONS = Object.freeze(['.md', '.markdown']) as readonly string[]

/** Lowercased regex sourced from `MARKDOWN_EXTENSIONS` for cheap leaf
 *  checks. Anchored at end-of-string and case-insensitive. */
const MARKDOWN_EXTENSION_RE = new RegExp(
  `\\.(?:${MARKDOWN_EXTENSIONS.map((e) => e.slice(1)).join('|')})$`,
  'i',
)

/**
 * True if `name` ends with one of the accepted markdown extensions
 * (case-insensitive). Single source of truth used by the tree walker
 * AND the `requireMd` leaf check inside `validateRelativePath`.
 */
export function isMarkdownLeaf(name: string): boolean {
  return MARKDOWN_EXTENSION_RE.test(name)
}

/**
 * Files that live at the PROJECT ROOT (`Projects/<id>/<name>`, a SIBLING of
 * `docs/`) but are surfaced into the Documents tree as top-level entries.
 *
 * Exactly `STATUS.md` today — the standard per-project state doc the
 * materializer writes to `Projects/<id>/STATUS.md`
 * (`onboarding/wow-moment/project-materializer.ts`), which sits OUTSIDE the
 * `docs/` root that the tree/read/write surface is otherwise confined to. Ryan
 * wants STATUS.md to be a first-class Document pinned to the top of the list,
 * so the store surfaces it here.
 *
 * The exception is deliberately a fixed, hard-coded BASENAME set with NO
 * user-supplied path component, NO subpaths, and NO `..`, so it cannot widen
 * path traversal: a redirect only ever resolves to `<project_root>/STATUS.md`,
 * one level above `docs/`, for the exact string `STATUS.md`.
 */
export const ROOT_SURFACED_DOCS = Object.freeze(['STATUS.md']) as readonly string[]

/** True when a validated (cleaned) relative path is a root-surfaced doc name. */
function isRootSurfacedDoc(cleanedRelPath: string): boolean {
  return ROOT_SURFACED_DOCS.includes(cleanedRelPath)
}

/**
 * True iff `abs` is a REGULAR file (NOT a symlink). Uses `lstatSync` so a
 * symlink resolves to `isFile() === false` — used to gate the project-root
 * STATUS.md surfacing + read/write redirect. A symlinked STATUS.md must NOT be
 * surfaced or routed to (it could point at another in-project file, letting a
 * `STATUS.md` read/write reach/overwrite it); such a symlink is left to normal
 * docs-root resolution (where realpath containment governs it).
 */
function isRealFileSync(abs: string): boolean {
  try {
    return lstatSync(abs).isFile()
  } catch {
    return false
  }
}

/** Maximum allowed relative path length (segments + separators). */
export const MAX_DOC_PATH_LEN = 1024

/** Single-segment cap so a malicious filename can't bloat OS calls. */
const MAX_DOC_SEGMENT_LEN = 256

/** Tree-walk recursion guard against pathological symlink loops. */
const MAX_TREE_DEPTH = 16

/** Tree-walk node-count guard so an enormous instance home can't OOM the
 *  gateway when a client hits `/tree`. The Expo client paginates by
 *  folder if it ever needs to render more than this. */
const MAX_TREE_NODES = 5_000

export type DocTreeKind = 'file' | 'folder' | 'binary'

/**
 * P7.5 round-2 IMPORTANT #5 — `origin` distinguishes a folder that
 * exists on disk (a real markdown folder created via `mkdir`) from a
 * synthesised folder that the binary-merge step generated to host a
 * binary leaf at a deep path. Phantom-binary folders MUST NOT route
 * through `rmdir` on delete — there's no on-disk dir for them — so the
 * Expo client switches `handleDelete` to a binary-recursive op when it
 * sees `origin === 'binary'`. `null` for files / binary leaves / real
 * folders (where `rmdir` is correct).
 */
export type DocTreeFolderOrigin = 'markdown' | 'binary'

export interface DocTreeNode {
  kind: DocTreeKind
  /** Relative path from the project's docs root. POSIX-style separators. */
  path: string
  /** Basename for rendering convenience — last segment of `path`. */
  name: string
  /** Bytes (files only). */
  size_bytes: number | null
  /** Last-modified ms-epoch (files only). */
  modified_at: number | null
  /**
   * P7.5 — canonical MIME for `kind: 'binary'` rows. `null` for markdown
   * files and folders. Existing JSON consumers that ignore unknown
   * fields continue to work.
   */
  content_type: string | null
  /** P7.5 — number of markdown docs that link to this binary (binary rows only). */
  referenced_by_count: number | null
  /**
   * P7.5 round-2 — only set on folders. `'markdown'` for folders that
   * exist on disk; `'binary'` for synthesised phantom folders that
   * only exist to host binary leaves. `null` for non-folder rows.
   */
  origin: DocTreeFolderOrigin | null
  /** Nested children (folders only). */
  children: DocTreeNode[]
}

export interface ReadFileResult {
  path: string
  content: string
  size_bytes: number
  modified_at: number
}

export interface WriteFileInput {
  project_id: string
  path: string
  content: string
  /** Optional optimistic-concurrency tag. */
  expected_modified_at?: number
  /**
   * P7.4 — when set, this write is a revert to the named target sha
   * and the versioning commit is shaped as `revert: <path> to <short-sha>`
   * instead of `edit:` / `create:`. The actual file content still comes
   * from `content`; the caller is responsible for reading it from the
   * version store first.
   */
  revert_target_sha?: string
}

export interface WriteFileResult {
  path: string
  size_bytes: number
  modified_at: number
}

export class DocPathError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DocPathError'
    this.code = code
  }
}

export class DocNotFoundError extends Error {
  readonly code = 'doc_not_found' as const
  constructor(message: string) {
    super(message)
    this.name = 'DocNotFoundError'
  }
}

export class DocConflictError extends Error {
  readonly code = 'doc_modified_conflict' as const
  /**
   * The mtime currently on disk, or `null` when the file no longer
   * exists. `null` is the explicit "concurrently deleted" signal the
   * client uses to switch from an Update-in-place flow to a
   * recreate-via-fresh-PUT flow (round-5 IMPORTANT #1) — without it,
   * the gateway silently RECREATED a deleted file when the caller
   * supplied `expected_modified_at`, which broke single-writer intent.
   */
  readonly current_modified_at: number | null
  constructor(message: string, current_modified_at: number | null) {
    super(message)
    this.name = 'DocConflictError'
    this.current_modified_at = current_modified_at
  }
}

export class DocSizeError extends Error {
  readonly code = 'doc_too_large' as const
  constructor(message: string) {
    super(message)
    this.name = 'DocSizeError'
  }
}

/**
 * P7.2 S2 — operation discriminator passed to `onMutationSuccess`.
 * The walker uses it to decide whether to read the new body, emit
 * `anchor_dead` for every anchor, or carry anchors across a rename.
 */
export type DocMutationOp = 'write' | 'delete' | 'move'

export interface DocMutationSuccess {
  op: DocMutationOp
  project_id: string
  /** The path that's NOW canonical — `to_path` on move, the touched
   *  path otherwise. */
  path: string
  /** Only set on `op === 'move'`. The source path before rename. */
  from_path?: string
  /** New mtime in ms-epoch. Null on delete. */
  new_modified_at: number | null
}

export type OnDocMutationSuccess = (input: DocMutationSuccess) => Promise<void>

export interface DocStoreOptions {
  /** Absolute path to the per-instance `<owner_home>` dir. */
  owner_home: string
  /**
   * Override how the per-project docs root is resolved. Production
   * uses the default (`<owner_home>/Projects/<project_id>/docs`); the
   * test harness can swap this for a fixed dir without restructuring
   * the tmp tree.
   */
  resolveProjectDocsRoot?: (project_id: string) => string
  /**
   * Optional version store. When supplied (P7.4 Phase 1), every
   * successful mutation triggers a best-effort git commit so the
   * editor can browse / preview / revert past versions. When omitted
   * (legacy tests, environments without git), writes succeed exactly
   * as before. The commit is BEST-EFFORT — failures are logged via
   * the version store's own structured-log sink and DO NOT roll back
   * the file write.
   */
  versionStore?: DocVersionStore
  /**
   * P7.5 — optional binary store. When supplied, `tree()` merges
   * binary rows into the markdown tree (sorted alongside .md leaves)
   * AND every `writeDoc`/`deleteDoc`/`moveDoc` syncs the
   * `markdown_link` refcount table so a binary's lifecycle stays in
   * step with the markdown that references it.
   */
  binaryStore?: BinaryStore
  /**
   * P7.2 S2 — optional re-anchor walker hook. When supplied, every
   * successful `writeDoc` / `deleteDoc` / `moveDoc` invocation fires
   * this callback AFTER the atomic write / unlink / rename succeeds.
   * The hook walks the affected anchors and appends `anchor_*` events
   * into the per-project comments sidecar. The hook is BEST-EFFORT —
   * failures are swallowed (the walker has its own structured-log
   * sink); the file mutation is the source of truth and stays intact
   * regardless.
   *
   * Wired by the boot composer to `AnchorWalker.handle` in
   * `gateway/comments/anchor-walker.ts`.
   */
  onMutationSuccess?: OnDocMutationSuccess
}

export class DocStore {
  private readonly owner_home: string
  private readonly resolveProjectDocsRoot: (project_id: string) => string
  private readonly versionStore: DocVersionStore | null
  private readonly binaryStore: BinaryStore | null
  private readonly onMutationSuccess: OnDocMutationSuccess | null

  constructor(opts: DocStoreOptions) {
    this.owner_home = opts.owner_home
    this.resolveProjectDocsRoot =
      opts.resolveProjectDocsRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id, 'docs'))
    this.versionStore = opts.versionStore ?? null
    this.binaryStore = opts.binaryStore ?? null
    this.onMutationSuccess = opts.onMutationSuccess ?? null
  }

  /**
   * P7.2 S2 — fire the optional re-anchor walker hook AFTER a
   * mutation has successfully landed on disk. Best-effort: swallow
   * any error so a walker failure can never roll back the user's
   * already-completed file mutation. The walker has its own
   * structured-log sink; logging here would just double-log.
   */
  private async invokeMutationHook(input: DocMutationSuccess): Promise<void> {
    if (this.onMutationSuccess === null) return
    try {
      await this.onMutationSuccess(input)
    } catch {
      /* swallow — walker is best-effort, mutation already landed */
    }
  }

  /**
   * Walk the tree under `<docs-root>` and return a nested
   * folder/file structure. Folders sort before files; both sort
   * case-insensitive ASC. Hidden entries (any segment starting with
   * `.`) are skipped — they're never reachable via the API and we
   * don't surface them in the tree either.
   */
  async tree(project_id: string): Promise<DocTreeNode[]> {
    const root = this.assertProjectId(project_id)
    const tree = await this.buildTreeUnderRoot(project_id, root)
    // P-B — surface the project-root STATUS.md (sibling of docs/) as a
    // top-level entry, LEADING the tree so it sits at the top of the Documents
    // list. The client also pins it in `flattenDocFiles` as defense-in-depth.
    return this.prependRootSurfacedDocs(root, tree)
  }

  /** Build the tree of markdown (+ binary) files strictly UNDER the docs
   *  root. `tree()` wraps this to prepend any surfaced project-root docs. */
  private async buildTreeUnderRoot(
    project_id: string,
    root: string,
  ): Promise<DocTreeNode[]> {
    let markdownTree: DocTreeNode[] = []
    if (existsSync(root)) {
      // Resolve the canonical docs root once and thread it through the
      // walker so each child can be realpath-checked for symlink escape.
      // Without this, an in-docs symlink (`docs/leak.md` → `/etc/passwd`)
      // appears in the tree with real size/mtime — leaking metadata about
      // an out-of-tree file. The reader still rejects content reads, but
      // the tree-side leak was a P7.0→P7.1 regression (P7.0's
      // `walkChildren` had this check; the new async walker dropped it).
      let canonicalRoot: string
      try {
        canonicalRoot = await realpath(root)
        let node_budget = MAX_TREE_NODES
        const decrementBudget = (): boolean => {
          node_budget -= 1
          return node_budget >= 0
        }
        markdownTree = await walkTree(
          canonicalRoot,
          '',
          0,
          decrementBudget,
          canonicalRoot,
        )
      } catch {
        markdownTree = []
      }
    }
    // P7.5 — merge binary rows into the same tree shape so the Expo
    // client renders markdown + binaries side-by-side. Sort folders
    // first, then files (markdown + binary intermixed) case-insensitive.
    if (this.binaryStore === null) return markdownTree
    // Round-2 IMPORTANT #3 — share the MAX_TREE_NODES budget between
    // markdown and binary tiers so an instance with many binaries can't DoS
    // the gateway by inflating the binary side. The markdown walker has
    // already consumed its share of the cap; the binary side gets the
    // remainder. When the remainder is 0, skip the query entirely.
    const markdownCount = countTreeNodes(markdownTree)
    const binaryBudget = Math.max(0, MAX_TREE_NODES - markdownCount)
    if (binaryBudget === 0) {
      logTreeCap(project_id, markdownCount, 0, 0)
      return markdownTree
    }
    let binaries
    try {
      binaries = this.binaryStore.listPaths(project_id, binaryBudget)
    } catch {
      return markdownTree
    }
    if (binaries.length === 0) return markdownTree
    if (binaries.length === binaryBudget) {
      // The binary side may have more rows on disk than we surfaced —
      // surface the cap in the structured log so ops sees the truncation
      // BEFORE the user reports a missing file.
      logTreeCap(project_id, markdownCount, binaries.length, binaryBudget)
    }
    return mergeBinariesIntoTree(markdownTree, binaries)
  }

  /**
   * P-B — prepend any {@link ROOT_SURFACED_DOCS} that live at the project root
   * (a sibling of `docs/`) so they appear at the TOP of the Documents tree.
   * Only surfaces a root copy when the tree has no top-level entry of that name
   * (a real `docs/STATUS.md` wins, keeping the read/write path unambiguous) and
   * the root file actually exists + is a regular file.
   */
  private async prependRootSurfacedDocs(
    docsRoot: string,
    tree: DocTreeNode[],
  ): Promise<DocTreeNode[]> {
    const projectRoot = dirname(docsRoot)
    const extra: DocTreeNode[] = []
    for (const name of ROOT_SURFACED_DOCS) {
      if (tree.some((n) => n.path === name)) continue
      if (existsSync(join(docsRoot, name))) continue
      const abs = join(projectRoot, name)
      let st
      try {
        // lstat (not stat) so a SYMLINK at the project root doesn't get
        // surfaced with its target's size/mtime — that would leak metadata
        // about an out-of-project file into the tree (the same leak the docs
        // walker guards against). A symlink fails the isFile() check below and
        // is skipped; reads of it are rejected by realpath containment anyway.
        st = await lstat(abs)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      extra.push({
        kind: 'file',
        path: name,
        name,
        size_bytes: st.size,
        modified_at: Math.floor(st.mtimeMs),
        content_type: null,
        referenced_by_count: null,
        origin: null,
        children: [],
      })
    }
    if (extra.length === 0) return tree
    return [...extra, ...tree]
  }

  /**
   * P-B — resolve the base directory a validated (cleaned) relative path is
   * contained against. Normally the project's `docs/` root. For a
   * {@link ROOT_SURFACED_DOCS} basename (exactly `STATUS.md`) that exists at the
   * project root and NOT under `docs/`, the base is the project root so the
   * surfaced top-level entry reads/writes the real state doc. The redirect only
   * ever fires for the exact fixed basename (no path component), so the
   * containment guarantee can't widen — `<project_root>/STATUS.md` is the only
   * reachable out-of-`docs/` target.
   */
  private baseDirForDoc(docsRoot: string, cleanedRelPath: string): string {
    if (
      isRootSurfacedDoc(cleanedRelPath) &&
      !existsSync(join(docsRoot, cleanedRelPath)) &&
      // Regular file only — a SYMLINK at the project root is NOT routed to (it
      // could point at another in-project file), matching the tree-surfacing
      // gate. Such a path falls back to docs-root resolution.
      isRealFileSync(join(dirname(docsRoot), cleanedRelPath))
    ) {
      return dirname(docsRoot)
    }
    return docsRoot
  }

  /**
   * Lightweight stat for a markdown file at `relPath`. Realpath-checks
   * the same way `readDoc` does, but skips the body read — used by the
   * P7.2 comments surface to OCC-check `based_on_modified_at` without
   * paying for an unnecessary file read. Returns `null` when the path
   * is well-formed and contained but the file no longer exists. Throws
   * `DocPathError` on a hostile path (NUL, ..,  absolute, etc.).
   */
  async statDoc(
    project_id: string,
    relPath: string,
  ): Promise<{ size_bytes: number; modified_at: number } | null> {
    const root = this.assertProjectId(project_id)
    const cleaned = validateRelativePath(relPath, { requireMd: true })
    const abs = await assertContainedFile(this.baseDirForDoc(root, cleaned), cleaned)
    let st
    try {
      st = await stat(abs)
    } catch {
      return null
    }
    if (!st.isFile()) return null
    return {
      size_bytes: st.size,
      modified_at: Math.floor(st.mtimeMs),
    }
  }

  /** Read a markdown file at `relPath`. */
  async readDoc(project_id: string, relPath: string): Promise<ReadFileResult> {
    const root = this.assertProjectId(project_id)
    const cleaned = validateRelativePath(relPath, { requireMd: true })
    const abs = await assertContainedFile(this.baseDirForDoc(root, cleaned), cleaned)
    let st
    try {
      st = await stat(abs)
    } catch {
      throw new DocNotFoundError(`no doc at path=${relPath}`)
    }
    if (!st.isFile()) {
      throw new DocNotFoundError(`path=${relPath} is not a file`)
    }
    const content = await readFile(abs, 'utf8')
    return {
      path: relPath,
      content,
      size_bytes: st.size,
      modified_at: Math.floor(st.mtimeMs),
    }
  }

  /**
   * Write `content` to `relPath`, creating parent dirs as needed.
   * Writes go through a sibling temp-file + rename atomic. When
   * `expected_modified_at` is supplied AND the target exists, the
   * current mtime is compared against the value and a mismatch raises
   * `DocConflictError` BEFORE any data is written.
   */
  async writeDoc(input: WriteFileInput): Promise<WriteFileResult> {
    const root = this.assertProjectId(input.project_id)
    if (typeof input.content !== 'string') {
      throw new DocPathError('invalid_content', 'content must be a string')
    }
    const byte_len = Buffer.byteLength(input.content, 'utf8')
    if (byte_len > MAX_DOC_BYTES) {
      throw new DocSizeError(
        `content exceeds ${MAX_DOC_BYTES} bytes (got ${byte_len})`,
      )
    }
    // P-B — route the exact top-level `STATUS.md` to the project root (where
    // the state doc lives) so an Edit of the surfaced doc overwrites the real
    // file in place, not a phantom `docs/STATUS.md`. Any other path stays under
    // the docs root.
    const cleanedWritePath = validateRelativePath(input.path, { requireMd: true })
    const writeBase = this.baseDirForDoc(root, cleanedWritePath)
    const abs = await assertContainedFileForWrite(writeBase, input.path)
    // A surfaced project-root doc (STATUS.md) lives outside the docs/ git
    // worktree + binary graph, so skip the version commit + binary-link sync
    // below (they'd `git add` a path not in the worktree — no usable history).
    const writeRootSurfaced = writeBase !== root
    // Record whether this is a create or overwrite BEFORE the rename so
    // the version store's commit message (`create:` vs `edit:` / `revert:`)
    // reflects the user's intent. The check is purely advisory — the
    // atomic write below proceeds either way.
    const was_create = !existsSync(abs)
    // Ensure the version store is initialized BEFORE the file mutation
    // so the init commit captures the pre-mutation state and the
    // subsequent commit captures the mutation as a distinct entry.
    // If ensureInit is deferred until after the write, the init
    // commit's auto-add would absorb the new file and the commit()
    // call below would find nothing to stage — losing the per-edit
    // history entry.
    await this.ensureVersioningInit(input.project_id)

    // Optimistic concurrency check — must happen before the temp write
    // so a stale client never overwrites a fresh value. Two failure
    // shapes:
    //   1. The file exists but its mtime differs from
    //      `expected_modified_at` → 409 with the current mtime so the
    //      client can render a Reload banner.
    //   2. The file no longer exists at all (concurrently deleted
    //      between the caller's read and this write) → 409 with
    //      `current_modified_at: null`. Round-5 IMPORTANT #1 — the
    //      previous code path silently RECREATED the file because the
    //      `current !== null` guard short-circuited the conflict
    //      check, breaking single-writer intent. A caller that means
    //      to recreate must re-issue the PUT without
    //      `expected_modified_at`.
    if (input.expected_modified_at !== undefined) {
      const current = await currentModifiedAt(abs)
      if (current === null) {
        throw new DocConflictError(
          `path=${input.path} no longer exists (expected_modified_at=${input.expected_modified_at}); re-issue PUT without expected_modified_at to recreate`,
          null,
        )
      }
      if (current !== input.expected_modified_at) {
        throw new DocConflictError(
          `path=${input.path} was modified elsewhere (current=${current}, expected=${input.expected_modified_at})`,
          current,
        )
      }
    }

    // Ensure parent dir exists. mkdir{recursive: true} no-ops when
    // the dir already exists, so this is idempotent across writes.
    await mkdir(parentDir(abs), { recursive: true })

    // Atomic write: temp file in the same dir (same filesystem ⇒ rename
    // is atomic), then rename over the target.
    const tempPath = `${abs}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await writeFile(tempPath, input.content, 'utf8')
    try {
      await rename(tempPath, abs)
    } catch (err) {
      // Clean up the temp file if the rename failed.
      try {
        await unlink(tempPath)
      } catch {
        /* ignore */
      }
      throw err
    }
    const st = await stat(abs)
    // P7.4 — best-effort versioning commit AFTER the atomic write
    // succeeds. Failures don't roll back the write; they're logged
    // and the next successful write picks up the staged changes.
    // Callers can opt in to a revert-shaped commit by passing
    // `input.revert_target_sha`.
    if (!writeRootSurfaced) {
      await this.recordCommit(input.project_id, {
        op: input.revert_target_sha !== undefined ? 'revert' : was_create ? 'create' : 'edit',
        path: input.path,
        ...(input.revert_target_sha !== undefined
          ? { target_sha: input.revert_target_sha }
          : {}),
      } as CommitKind)
    }
    // P7.5 — recompute the binary refcount table for this markdown
    // file. Best-effort; the markdown write has already landed atomically
    // so a binary-store hiccup must not roll it back. Round-2 IMPORTANT
    // #4 — wire the store's structured-event logger in so refcount drift
    // is observable in ops dashboards instead of vanishing silently.
    if (this.binaryStore !== null && !writeRootSurfaced) {
      try {
        this.binaryStore.syncMarkdownLinks(
          input.project_id,
          input.path,
          input.content,
        )
      } catch (err) {
        this.binaryStore.logEvent('docs.binary.sync_links_failed', {
          project_id: input.project_id,
          path: input.path,
          op: 'writeDoc',
          error: stringifyHookError(err),
        })
      }
    }
    // P7.2 S2 — fire the re-anchor walker after every successful
    // write. Best-effort; failures are swallowed (see
    // `invokeMutationHook` doc). Skipped for a surfaced project-root doc: the
    // walker resolves doc paths under the docs/ root, so it can't read the root
    // file — running it would misread the edit as a delete and mark any
    // STATUS.md comment anchors dead. STATUS.md is outside the docs/ comment
    // graph (comments on it stay at their prior offsets rather than re-anchor).
    if (!writeRootSurfaced) {
      await this.invokeMutationHook({
        op: 'write',
        project_id: input.project_id,
        path: input.path,
        new_modified_at: Math.floor(st.mtimeMs),
      })
    }
    return {
      path: input.path,
      size_bytes: st.size,
      modified_at: Math.floor(st.mtimeMs),
    }
  }

  async deleteDoc(
    project_id: string,
    relPath: string,
    opts: { expected_modified_at?: number } = {},
  ): Promise<void> {
    const root = this.assertProjectId(project_id)
    const cleaned = validateRelativePath(relPath, { requireMd: true })
    const base = this.baseDirForDoc(root, cleaned)
    const rootSurfaced = base !== root
    const abs = await assertContainedFile(base, cleaned)
    // Codex r2 IMPORTANT #2 — optimistic-concurrency check. Without
    // this, the `/docs/revert` delete branch silently clobbered any
    // concurrent edit that landed between the user opening the history
    // pane and clicking Revert. Mirrors writeDoc's semantics: a null
    // current mtime (file already gone) AND a mismatched mtime both
    // raise DocConflictError so the surface returns 409 with the
    // observed mtime and the client can render a Reload banner. The
    // versioning init is deferred until after this check so a stale
    // revert that's going to 409 doesn't side-effect an init.
    if (opts.expected_modified_at !== undefined) {
      const current = await currentModifiedAt(abs)
      if (current === null) {
        throw new DocConflictError(
          `path=${relPath} no longer exists (expected_modified_at=${opts.expected_modified_at})`,
          null,
        )
      }
      if (current !== opts.expected_modified_at) {
        throw new DocConflictError(
          `path=${relPath} was modified elsewhere (current=${current}, expected=${opts.expected_modified_at})`,
          current,
        )
      }
    }
    await this.ensureVersioningInit(project_id)
    try {
      await unlink(abs)
    } catch (err) {
      if (isENOENT(err)) {
        throw new DocNotFoundError(`no doc at path=${relPath}`)
      }
      throw err
    }
    // Argus r2 IMPORTANT — sample the delete time IMMEDIATELY after
    // unlink() returns, BEFORE the recordCommit() + dropMarkdownLinks()
    // awaits below. DocStore has no per-path mutex, so a concurrent
    // writeDoc on the same path can complete its rename + fstat between
    // the unlink and the hook invocation at the end of this method. If
    // we sampled Date.now() at the hook site, the deleter's stamp could
    // exceed the concurrent writer's fstat-captured mtime, and the
    // materialiser's max-mtime-wins fold would drop the writer's
    // `anchor_relocated` as stale — flipping the anchor dead despite
    // the file existing. Sampling here pins the deleter's stamp to
    // "just after unlink", so any writer that races its rename in
    // after our unlink will fstat a mtime > delete_time (same wall
    // clock on a sane host), and the writer's event wins.
    const delete_time = Date.now()
    // Skip version/binary side-effects for a surfaced project-root doc — it
    // lives outside the docs/ git worktree + binary graph.
    if (!rootSurfaced) {
      await this.recordCommit(project_id, { op: 'delete', path: relPath })
    }
    // P7.5 — drop the markdown_link rows for this file so the linked
    // binaries' refcounts reflect the deletion. Round-2 IMPORTANT #4 —
    // log instead of silently swallowing so silent refcount drift can't
    // hide a stuck blob from GC visibility.
    if (this.binaryStore !== null && !rootSurfaced) {
      try {
        this.binaryStore.dropMarkdownLinks(project_id, relPath)
      } catch (err) {
        this.binaryStore.logEvent('docs.binary.drop_links_failed', {
          project_id,
          path: relPath,
          op: 'deleteDoc',
          error: stringifyHookError(err),
        })
      }
    }
    // P7.2 S2 — fire the re-anchor walker; the walker emits an
    // `anchor_dead` event for every anchor on the deleted path.
    // Argus r1 IMPORTANT — pass a finite "delete time" instead of null
    // so the materialiser's stale-event filter participates in
    // delete-vs-write races. See `delete_time` sampling above and
    // anchor-walker.ts:handleDelete docblock. Skipped for a surfaced
    // project-root doc (outside the docs/ comment graph — see writeDoc).
    if (!rootSurfaced) {
      await this.invokeMutationHook({
        op: 'delete',
        project_id,
        path: relPath,
        new_modified_at: delete_time,
      })
    }
  }

  async moveDoc(
    project_id: string,
    from: string,
    to: string,
  ): Promise<WriteFileResult> {
    const root = this.assertProjectId(project_id)
    const cleanedFrom = validateRelativePath(from, { requireMd: true })
    const cleanedTo = validateRelativePath(to, { requireMd: true })
    const baseFrom = this.baseDirForDoc(root, cleanedFrom)
    const baseTo = this.baseDirForDoc(root, cleanedTo)
    // A move touching the surfaced project-root doc crosses the docs/ worktree
    // boundary, so skip the version commit + binary-link rename below.
    const moveRootSurfaced = baseFrom !== root || baseTo !== root
    const absFrom = await assertContainedFile(baseFrom, from)
    const absTo = await assertContainedFileForWrite(baseTo, to)
    // Guard against destination already existing — refuse to clobber
    // an unrelated file via a rename. Caller can DELETE the target
    // first if they really mean overwrite.
    if (existsSync(absTo) && absTo !== absFrom) {
      throw new DocPathError(
        'doc_destination_exists',
        `to_path=${to} already exists; delete it first if you mean to overwrite`,
      )
    }
    await this.ensureVersioningInit(project_id)
    await mkdir(parentDir(absTo), { recursive: true })
    try {
      await rename(absFrom, absTo)
    } catch (err) {
      if (isENOENT(err)) {
        throw new DocNotFoundError(`no doc at from_path=${from}`)
      }
      throw err
    }
    const st = await stat(absTo)
    if (!moveRootSurfaced) {
      await this.recordCommit(project_id, { op: 'rename', from, to })
    }
    // P7.5 — keep the markdown_link table aligned with the new path so
    // refcount-by-markdown-link stays correct after a rename. Round-2
    // IMPORTANT #4 — log on failure rather than swallowing silently.
    if (this.binaryStore !== null && !moveRootSurfaced) {
      try {
        this.binaryStore.renameMarkdownLinks(project_id, from, to)
      } catch (err) {
        this.binaryStore.logEvent('docs.binary.rename_links_failed', {
          project_id,
          from_path: from,
          to_path: to,
          op: 'moveDoc',
          error: stringifyHookError(err),
        })
      }
    }
    // P7.2 S2 — fire the re-anchor walker; the walker emits
    // `anchor_relocated` events on the destination path carrying
    // `to_doc_path` metadata so the materialised anchor row moves
    // with the file (brief § 9.9 / § 10.2 row 9). Skipped when the move
    // touches a surfaced project-root doc (outside the docs/ comment graph —
    // see writeDoc).
    if (!moveRootSurfaced) {
      await this.invokeMutationHook({
        op: 'move',
        project_id,
        path: to,
        from_path: from,
        new_modified_at: Math.floor(st.mtimeMs),
      })
    }
    return {
      path: to,
      size_bytes: st.size,
      modified_at: Math.floor(st.mtimeMs),
    }
  }

  async createFolder(project_id: string, relPath: string): Promise<void> {
    const root = this.assertProjectId(project_id)
    const abs = await assertContainedFolder(root, relPath)
    await mkdir(abs, { recursive: true })
  }

  /**
   * Delete an empty folder. Out-of-scope-for-P7.1 ergonomics
   * (recursive folder delete, drag-tree refactor) defer to later
   * sprints; this is here so the action-sheet can offer "delete
   * folder" on the (already-empty) folders the user just created.
   */
  async deleteFolder(project_id: string, relPath: string): Promise<void> {
    const root = this.assertProjectId(project_id)
    const abs = await assertContainedFolder(root, relPath)
    try {
      // `rmdir` (no recursive flag) raises ENOTEMPTY on non-empty
      // folders, which is what we want. (`rm` with recursive:false
      // hits a Bun-on-darwin EFAULT in some builds — rmdir is the
      // canonical empty-folder remove and avoids the issue.)
      await rmdir(abs)
    } catch (err) {
      if (isENOENT(err)) {
        throw new DocNotFoundError(`no folder at path=${relPath}`)
      }
      if (isENOTEMPTY(err)) {
        throw new DocPathError(
          'folder_not_empty',
          `path=${relPath} is not empty; delete children first`,
        )
      }
      throw err
    }
  }

  /**
   * Best-effort init of the per-project version store. Called BEFORE
   * every mutation so the init commit captures pre-mutation state.
   * Swallows every error — if init fails (git missing, permissions,
   * etc.), the caller's file mutation must still succeed.
   */
  private async ensureVersioningInit(project_id: string): Promise<void> {
    if (this.versionStore === null) return
    try {
      await this.versionStore.ensureInit(project_id)
    } catch {
      /* swallow — recordCommit will be a no-op or recover */
    }
  }

  /**
   * Best-effort versioning commit. Folder operations are NOT versioned
   * (git tracks files; empty dirs aren't versioned at all). The store
   * gracefully no-ops when no version store is wired, when the git
   * binary isn't available, or when the project's docs/ doesn't exist
   * yet — in every case the file write that came before this call
   * remains intact on disk.
   */
  private async recordCommit(
    project_id: string,
    kind: CommitKind,
  ): Promise<void> {
    if (this.versionStore === null) return
    try {
      await this.versionStore.commit(project_id, kind)
    } catch {
      // The version store already logs its own structured failures;
      // a thrown error here is the unusual case (e.g. assertion bug
      // inside the store). Swallow so the caller's write success is
      // preserved regardless. The next successful mutation picks up
      // the missed staged changes via `git add -A`.
    }
  }

  /** Forward access for surface modules that need to invoke versioning
   *  primitives (history, read_at, revert content lookup, diff). */
  get versioning(): DocVersionStore | null {
    return this.versionStore
  }

  /** P7.5 — forward access for the app-docs surface so the three new
   *  `/docs/binary` routes can call into the content-addressed store. */
  get binary(): BinaryStore | null {
    return this.binaryStore
  }

  /** Resolve the docs root for a project. Surface modules use this to
   *  pass the right work-tree path through to symlink-safety helpers. */
  resolveDocsRoot(project_id: string): string {
    return this.assertProjectId(project_id)
  }

  private assertProjectId(project_id: string): string {
    const cleaned = sanitizeProjectId(project_id)
    if (cleaned === null) {
      throw new DocPathError(
        'invalid_project_id',
        'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
      )
    }
    return this.resolveProjectDocsRoot(cleaned)
  }
}

/**
 * Common path-shape validation used by every file/folder operation.
 * Returns the normalised POSIX-style relative path on success; throws
 * `DocPathError` otherwise.
 */
function validateRelativePath(
  relPath: unknown,
  opts: { requireMd: boolean },
): string {
  if (typeof relPath !== 'string') {
    throw new DocPathError('invalid_path', 'path must be a string')
  }
  if (relPath.length === 0) {
    throw new DocPathError('invalid_path', 'path must be non-empty')
  }
  if (relPath.length > MAX_DOC_PATH_LEN) {
    throw new DocPathError(
      'invalid_path',
      `path exceeds ${MAX_DOC_PATH_LEN} chars`,
    )
  }
  if (relPath.includes('\0')) {
    throw new DocPathError('invalid_path', 'path contains NUL byte')
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new DocPathError('invalid_path', 'path must be relative')
  }
  // Normalize to forward slashes for the segment check; reject
  // Windows-style absolute drive markers defensively.
  const posix = relPath.replace(/\\+/g, '/')
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
    if (seg.length > MAX_DOC_SEGMENT_LEN) {
      throw new DocPathError(
        'invalid_path',
        `segment '${seg}' exceeds ${MAX_DOC_SEGMENT_LEN} chars`,
      )
    }
    // Forbid OS-disallowed characters universally so a Mac-only path
    // doesn't slip through to a future Linux deployment with broken
    // filesystem semantics.
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      throw new DocPathError(
        'invalid_path',
        `segment '${seg}' contains a forbidden character`,
      )
    }
    if (seg.endsWith(' ') || seg.endsWith('.')) {
      throw new DocPathError(
        'invalid_path',
        `segment '${seg}' may not end with a space or dot`,
      )
    }
  }
  if (opts.requireMd) {
    const last = segments[segments.length - 1] ?? ''
    if (!isMarkdownLeaf(last)) {
      throw new DocPathError(
        'invalid_extension',
        `path must end with .md or .markdown (got '${last}')`,
      )
    }
  }
  return segments.join('/')
}

/**
 * Resolve `relPath` against `docsRoot` and confirm the result is still
 * contained inside `docsRoot` AFTER realpath resolution. Used for
 * read-side operations (the file must already exist on disk).
 */
async function assertContainedFile(
  docsRoot: string,
  relPath: unknown,
): Promise<string> {
  const cleaned = validateRelativePath(relPath, { requireMd: true })
  const candidate = normalize(join(docsRoot, cleaned))
  if (!existsSync(candidate)) {
    // We still need to confirm the parent dir, when it exists, is
    // contained inside the docs root — otherwise an ENOENT branch
    // could leak through with an unsafe candidate path. The cheapest
    // check is to realpath the closest existing ancestor and ensure
    // it sits under the realpathed root.
    await assertAncestorContained(docsRoot, candidate)
    // The caller (read path) will detect ENOENT separately.
    throw new DocNotFoundError(`no doc at path=${cleaned}`)
  }
  return await assertRealpathContained(docsRoot, candidate)
}

/**
 * Resolve `relPath` against `docsRoot` for a write operation. The
 * target file may not exist yet — we walk up to the closest existing
 * ancestor, realpath it, and confirm the candidate target still sits
 * under the docs root. This catches the symlink-escape case where a
 * pre-existing intermediate dir is a symlink to outside the docs root.
 */
async function assertContainedFileForWrite(
  docsRoot: string,
  relPath: unknown,
): Promise<string> {
  const cleaned = validateRelativePath(relPath, { requireMd: true })
  const candidate = normalize(join(docsRoot, cleaned))
  await assertAncestorContained(docsRoot, candidate)
  // If the target already exists (overwrite path), reject the write
  // when the existing entry is a symlink — we don't want a malicious
  // pre-existing symlink to redirect writes outside the docs root.
  if (existsSync(candidate)) {
    return await assertRealpathContained(docsRoot, candidate)
  }
  return candidate
}

/**
 * Resolve `relPath` against `docsRoot` for a folder operation (create
 * or delete). The literal prefix check catches `..` traversal, and the
 * async ancestor walk realpaths the closest existing intermediate dir
 * to catch the case where a pre-existing dir along the candidate path
 * is a symlink pointing outside the docs root — without this,
 * `mkdir({ recursive: true })` would follow the symlink and create the
 * tree at the foreign location.
 *
 * For folder paths that already exist on disk we additionally realpath
 * the candidate itself, matching the read/write side.
 */
async function assertContainedFolder(
  docsRoot: string,
  relPath: unknown,
): Promise<string> {
  const cleaned = validateRelativePath(relPath, { requireMd: false })
  const candidate = normalize(join(docsRoot, cleaned))
  await assertAncestorContained(docsRoot, candidate)
  if (existsSync(candidate)) {
    return await assertRealpathContained(docsRoot, candidate)
  }
  return candidate
}

/**
 * Synchronous prefix containment guard. Confirms `candidate` lives
 * under `root` purely by string-prefix comparison after normalisation.
 * The full realpath check still runs for read/write operations; this
 * is the cheap pre-check that catches the obvious "../etc/passwd"
 * shape before any filesystem syscall.
 */
function assertPrefixContained(root: string, candidate: string): void {
  const normRoot = normalize(root)
  const rel = relative(normRoot, candidate)
  if (rel === '' || rel === '.') return
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
    throw new DocPathError('path_escape', 'resolved path escapes docs root')
  }
}

/**
 * Walk up from `candidate` until we hit an existing ancestor, realpath
 * it, and confirm the candidate (with the un-realpathed suffix appended)
 * still sits under the canonical (realpathed) docs root. Catches:
 *   - an existing intermediate dir is a symlink pointing outside the
 *     docs root (mkdir / write / read would otherwise follow it),
 *   - the docs root itself is a symlink — the canonical resolver below
 *     resolves it once so the containment compare uses matching shapes.
 */
async function assertAncestorContained(
  docsRoot: string,
  candidate: string,
): Promise<void> {
  assertPrefixContained(docsRoot, candidate)
  const realRoot = await resolveCanonicalDocRoot(docsRoot)
  // Walk up to find the closest existing ancestor.
  let cursor = candidate
  while (cursor !== parentDir(cursor)) {
    if (existsSync(cursor)) {
      const realCursor = await realpath(cursor)
      const rel = relative(realRoot, realCursor)
      if (rel !== '' && (rel.startsWith('..') || rel.startsWith(`..${sep}`))) {
        throw new DocPathError(
          'path_escape',
          'an intermediate ancestor symlinks outside the docs root',
        )
      }
      return
    }
    cursor = parentDir(cursor)
  }
}

/**
 * Confirm `candidate` exists and its realpathed location is still
 * inside the canonical (realpathed) docs root.
 */
async function assertRealpathContained(
  docsRoot: string,
  candidate: string,
): Promise<string> {
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    throw new DocNotFoundError('no doc at the resolved path')
  }
  const realRoot = await resolveCanonicalDocRoot(docsRoot)
  const rel = relative(realRoot, real)
  if (rel !== '' && (rel.startsWith('..') || rel.startsWith(`..${sep}`))) {
    throw new DocPathError(
      'path_escape',
      'doc path resolves outside the docs root (symlink escape rejected)',
    )
  }
  return real
}

/**
 * Resolve `docsRoot` to its canonical (realpath'd) form so containment
 * checks compare like-with-like. Two policies are at play:
 *
 *   - If `docsRoot` exists, we realpath it. A symlink docs root (e.g.
 *     an operator-wired legacy Obsidian vault) is accepted — the
 *     resolved target becomes the trust anchor for every subsequent
 *     containment compare.
 *   - If `docsRoot` doesn't exist yet (fresh project, mkdir on first
 *     write hasn't happened), we walk up to the closest existing
 *     ancestor, realpath that, and reconstruct the would-be canonical
 *     path. This keeps the trust anchor stable across the
 *     write/createFolder bootstrap path.
 *
 * Any other realpath failure (EACCES, ELOOP, EIO, …) is re-thrown so
 * the surface can return a real error rather than silently degrading
 * to a path-prefix compare against an unresolved trust anchor (which
 * caused PR #159 round-1 blocker #3 — a symlinked docs root would
 * fail-closed on every read and write).
 */
async function resolveCanonicalDocRoot(docsRoot: string): Promise<string> {
  try {
    return await realpath(docsRoot)
  } catch (err) {
    if (!isENOENT(err)) throw err
    const tail: string[] = []
    let cursor = docsRoot
    while (cursor !== parentDir(cursor)) {
      const parent = parentDir(cursor)
      const segment =
        parent === sep ? cursor.slice(1) : cursor.slice(parent.length + 1)
      tail.unshift(segment)
      cursor = parent
      try {
        const realParent = await realpath(cursor)
        return tail.length > 0 ? join(realParent, ...tail) : realParent
      } catch (e) {
        if (!isENOENT(e)) throw e
      }
    }
    return docsRoot
  }
}

async function currentModifiedAt(abs: string): Promise<number | null> {
  try {
    const st = await stat(abs)
    return Math.floor(st.mtimeMs)
  } catch (err) {
    if (isENOENT(err)) return null
    throw err
  }
}

async function walkTree(
  absRoot: string,
  relCursor: string,
  depth: number,
  decrementBudget: () => boolean,
  canonicalRoot: string,
): Promise<DocTreeNode[]> {
  if (depth > MAX_TREE_DEPTH) return []
  const here = relCursor === '' ? absRoot : join(absRoot, relCursor)
  let entries: { name: string; isDirectory: boolean }[] = []
  try {
    const raw = await readdir(here, { withFileTypes: true })
    entries = raw.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
  } catch {
    return []
  }
  entries.sort((a, b) => {
    // Folders first, then files; both case-insensitive.
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  const out: DocTreeNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!decrementBudget()) return out
    const relPath =
      relCursor === '' ? entry.name : `${relCursor}/${entry.name}`
    const abs = join(absRoot, relPath)
    // Symlink-escape filter: realpath the child and skip it if the
    // resolved location escapes the canonical docs root. Mirrors the
    // P7.0 `walkChildren` guard the new async walker had dropped.
    // ENOENT (dangling symlink) is treated as "skip silently" rather
    // than throwing — the tree walk continues for sibling entries.
    let realChild: string
    try {
      realChild = await realpath(abs)
    } catch {
      continue
    }
    if (!isInside(canonicalRoot, realChild)) continue

    if (entry.isDirectory) {
      const children = await walkTree(
        absRoot,
        relPath,
        depth + 1,
        decrementBudget,
        canonicalRoot,
      )
      out.push({
        kind: 'folder',
        path: relPath,
        name: entry.name,
        size_bytes: null,
        modified_at: null,
        content_type: null,
        referenced_by_count: null,
        // Real folder on disk — `rmdir` is the correct delete op.
        origin: 'markdown',
        children,
      })
      continue
    }
    if (!isMarkdownLeaf(entry.name)) continue
    let st
    try {
      st = await stat(abs)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    out.push({
      kind: 'file',
      path: relPath,
      name: entry.name,
      size_bytes: st.size,
      modified_at: Math.floor(st.mtimeMs),
      content_type: null,
      referenced_by_count: null,
      origin: null,
      children: [],
    })
  }
  return out
}

/**
 * P7.5 — merge binary rows into a markdown tree. Each binary path is
 * inserted at the right folder depth, with intermediate folders
 * created on the fly when missing.
 */
function mergeBinariesIntoTree(
  markdownTree: DocTreeNode[],
  binaries: ReadonlyArray<{
    path: string
    size_bytes: number
    content_type: string
    modified_at: number
    referenced_by_count: number
  }>,
): DocTreeNode[] {
  // We work on a defensive copy so the original markdown tree's
  // children arrays aren't mutated by repeated `tree()` calls.
  const tree = cloneTree(markdownTree)
  for (const bin of binaries) {
    const segments = bin.path.split('/').filter((s) => s.length > 0)
    if (segments.length === 0) continue
    let cursor = tree
    let prefix = ''
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i] ?? ''
      prefix = prefix === '' ? seg : `${prefix}/${seg}`
      let folder = cursor.find(
        (n) => n.kind === 'folder' && n.path === prefix,
      )
      if (folder === undefined) {
        folder = {
          kind: 'folder',
          path: prefix,
          name: seg,
          size_bytes: null,
          modified_at: null,
          content_type: null,
          referenced_by_count: null,
          // Round-2 IMPORTANT #5 — synthesised phantom folder. The
          // client routes its delete through the binary-recursive op
          // (DELETE /docs/binary?path=<prefix>&recursive=true) instead
          // of /docs/folder, which would ENOENT against rmdir.
          origin: 'binary',
          children: [],
        }
        cursor.push(folder)
      }
      cursor = folder.children
    }
    const leafName = segments[segments.length - 1] ?? ''
    cursor.push({
      kind: 'binary',
      path: bin.path,
      name: leafName,
      size_bytes: bin.size_bytes,
      modified_at: bin.modified_at,
      content_type: bin.content_type,
      referenced_by_count: bin.referenced_by_count,
      origin: null,
      children: [],
    })
  }
  sortTree(tree)
  return tree
}

function cloneTree(nodes: DocTreeNode[]): DocTreeNode[] {
  return nodes.map((n) => ({
    ...n,
    children: cloneTree(n.children),
  }))
}

/**
 * Total node count across the markdown side of a tree, including
 * folders. Mirrors the per-leaf decrement in `walkTree` so the binary
 * budget calc here lines up with what the walker actually counted.
 */
function countTreeNodes(nodes: DocTreeNode[]): number {
  let n = 0
  for (const node of nodes) {
    n += 1
    if (node.children.length > 0) n += countTreeNodes(node.children)
  }
  return n
}

function logTreeCap(
  project_id: string,
  markdownCount: number,
  binaryCount: number,
  binaryBudget: number,
): void {
  try {
    console.warn(
      `[docs.tree] tree budget exhausted ${JSON.stringify({
        project_id,
        markdown_nodes: markdownCount,
        binary_nodes: binaryCount,
        binary_budget: binaryBudget,
        cap: MAX_TREE_NODES,
      })}`,
    )
  } catch {
    /* ignore */
  }
}

function sortTree(nodes: DocTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      // Folders first, then everything else.
      if (a.kind === 'folder') return -1
      if (b.kind === 'folder') return 1
    }
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
  for (const n of nodes) {
    if (n.children.length > 0) sortTree(n.children)
  }
}

/**
 * Lexical-only containment check. Both `root` and `candidate` MUST be
 * absolute realpath-resolved paths so symlink escapes can't slip
 * through as a prefix-of-canonical-but-not-actually-inside string.
 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return candidate.startsWith(prefix)
}

function parentDir(p: string): string {
  // Equivalent to `path.dirname(p)` but with consistent behaviour on
  // root paths across platforms — we never want to return `'.'` for a
  // candidate that started absolute.
  const idx = p.lastIndexOf(sep)
  if (idx < 0) return p
  if (idx === 0) return sep
  return p.slice(0, idx)
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

function stringifyHookError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unstringifiable>'
  }
}

function isENOTEMPTY(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { code?: unknown }).code === 'ENOTEMPTY' ||
      (err as { code?: unknown }).code === 'EEXIST')
  )
}
