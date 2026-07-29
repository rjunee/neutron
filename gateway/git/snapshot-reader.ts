/**
 * @neutronai/gateway/git — project-backup snapshot READ surface (P7.4
 * restore UI), extracted VERBATIM from `project-backup-store.ts`
 * (refactor plan 2026-07-02 § D4).
 *
 * Owns everything the restore UI reads without mutating the repo:
 * snapshot listing (`git log`), per-snapshot preview (`git diff
 * --name-status` vs HEAD), file bodies at a sha (`git cat-file`) and
 * per-file unified diffs — plus the typed error classes and the
 * hostile-input sha/path validators every project-backup route shares.
 *
 * The `ProjectBackupStore` facade re-exports every public name here so
 * importers keep using `gateway/git/project-backup-store.ts`; nothing
 * outside `gateway/git/` should import this module directly.
 *
 * Layering: downward-only leaf — imports node builtins and
 * `./git-exec.ts` only. All git access goes through the narrow
 * `GitRepoContext` the facade passes in; this module holds NO state
 * and never touches the facade's concurrency maps.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { errMessage } from './git-exec.ts'
import type { GitRepoContext } from './git-exec.ts'

/** Cap on `git log`-derived snapshot pages exposed by `listSnapshots`. */
export const SNAPSHOT_DEFAULT_LIMIT = 60
export const SNAPSHOT_MAX_LIMIT = 200

/** Cap on the diff body returned by `previewSnapshot`. */
export const SNAPSHOT_DIFF_OUTPUT_CAP_BYTES = 200_000

/** Cap on the file body returned by `getSnapshotFileContent`. */
export const SNAPSHOT_FILE_OUTPUT_CAP_BYTES = 1_000_000

/** Per-snapshot metadata returned by `listSnapshots`. */
export interface SnapshotSummary {
  sha: string
  parent_sha: string | null
  message: string
  author_date: string
  /** `git diff --shortstat` summary against the parent (or null on
   *  the baseline commit). Cheap; lets the UI render a "12 files
   *  changed" hint without a second round-trip per row. */
  shortstat: { files_changed: number; insertions: number; deletions: number } | null
}

/** Per-file change classification at a snapshot, relative to the
 *  current working-tree HEAD (NOT the snapshot's parent — the UI cares
 *  about "what restoring this would change", which is HEAD↔sha). */
export type SnapshotFileStatus = 'added' | 'modified' | 'deleted' | 'unchanged'

export interface SnapshotFile {
  path: string
  status: SnapshotFileStatus
  /** Size in bytes at the snapshot SHA (null when `status === 'deleted'`). */
  size_bytes_at_sha: number | null
}

export interface SnapshotPreview {
  sha: string
  parent_sha: string | null
  message: string
  author_date: string
  files: SnapshotFile[]
}

/** UTF-8 file body at a snapshot SHA. Binary content is returned as a
 *  base64-encoded string (the surface client must decode); for v1
 *  we conservatively flag anything that fails UTF-8 round-trip as
 *  `binary: true` so the UI can decline to render it inline. */
export interface SnapshotFileContent {
  sha: string
  path: string
  content: string
  binary: boolean
  size_bytes: number
  truncated: boolean
}

/** Unified-diff body for one path at a snapshot SHA. */
export interface SnapshotFileDiff {
  sha: string
  path: string
  hunks: string
  truncated: boolean
}

/** Raised when a snapshot SHA can't be found in the project backup
 *  history. Surfaces as 404 with code `snapshot_not_found`. */
export class SnapshotNotFoundError extends Error {
  readonly code = 'snapshot_not_found' as const
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotNotFoundError'
  }
}

/** Raised when a path doesn't exist at the requested snapshot. Surfaces
 *  as 404 with code `snapshot_path_not_found`. */
export class SnapshotPathNotFoundError extends Error {
  readonly code = 'snapshot_path_not_found' as const
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotPathNotFoundError'
  }
}

/** Raised when the restore substrate isn't usable on this gateway
 *  (no git binary, repo never initialized). 503. */
export class RestoreUnavailableError extends Error {
  readonly code = 'restore_unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'RestoreUnavailableError'
  }
}

/** Raised when a path string fails the hostile-input checks shared by
 *  every project-backup file route (NUL bytes, absolute paths, `..`
 *  segments, hidden segments). 400. */
export class InvalidSnapshotPathError extends Error {
  readonly code = 'invalid_snapshot_path' as const
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSnapshotPathError'
  }
}

/** Raised when a sha-shaped param doesn't match `[0-9a-f]{40}`. 400. */
export class InvalidSnapshotShaError extends Error {
  readonly code = 'invalid_snapshot_sha' as const
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSnapshotShaError'
  }
}

const SNAPSHOT_SHA_RE = /^[0-9a-f]{40}$/

/** Throws `InvalidSnapshotShaError` when `sha` is not 40-char lowercase hex. */
export function assertSnapshotSha(sha: string): void {
  if (typeof sha !== 'string' || !SNAPSHOT_SHA_RE.test(sha)) {
    throw new InvalidSnapshotShaError(
      `sha must be a 40-char lowercase hex string (got '${sha}')`,
    )
  }
}

/**
 * Path-shape validator for snapshot file routes. Mirrors the doc-store's
 * hostile-input gates with one deliberate divergence (Argus r3 BLOCKER #2):
 * leading-dot segments are ALLOWED for ordinary config files because the
 * project-backup repo legitimately tracks `.gitignore`, `.eslintrc`,
 * `.husky/`, etc., and the preview surface lists them as restorable
 * diff rows. The doc-store route is markdown-only and never has reason
 * to address a dot-prefixed file, so its blanket leading-dot rejection
 * is the right policy there; the snapshot routes have to round-trip the
 * same set of paths the snapshot itself contains.
 *
 * Hard rejects retained: NUL bytes, absolute paths, Windows drive
 * prefixes, `.` / `..` segments, chars outside [<>:"|?*] / control
 * chars, segments > 256 chars. Plus an explicit reject of the three
 * operational sigil directories that share a parent with the snapshot:
 *
 *   - `.git`            — could overwrite the user project's real
 *                         git metadata if the user's project root
 *                         happens to also be a git repo
 *   - `.project-backup` — the snapshot's OWN git dir; restoring into
 *                         it would self-corrupt
 *   - `.docs-versions`  — Phase 1's per-edit history git dir
 *
 * The `.gitignore` excludes those three sigils from the snapshot in
 * the first place, so a user-supplied path that names any of them can
 * only ever miss (`SnapshotPathNotFoundError` for present-at-snapshot
 * reads, or a no-op deletion for absent-at-snapshot restores). Blocking
 * them here keeps the failure mode loud + uniform (400 instead of a
 * silently-no-op restore) and forecloses any future code path that
 * could accidentally permit a write under one of them.
 *
 * NOTE: deliberately does NOT enforce an `.md/.markdown` extension.
 * The project-backup repo accepts arbitrary user content (binaries,
 * SQLite sidecars, source files); the surface uses `binary: true` on
 * the response shape to signal "do not render inline".
 */
const SNAPSHOT_FORBIDDEN_SIGIL_SEGMENTS = new Set([
  '.git',
  '.project-backup',
  '.docs-versions',
])

export function assertSnapshotPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new InvalidSnapshotPathError('path must be a non-empty string')
  }
  if (path.length > 1024) {
    throw new InvalidSnapshotPathError('path exceeds 1024 chars')
  }
  if (path.includes('\u0000')) {
    throw new InvalidSnapshotPathError('path contains NUL byte')
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new InvalidSnapshotPathError('path must be relative')
  }
  const posix = path.replace(/\\+/g, '/')
  if (/^[A-Za-z]:\//.test(posix)) {
    throw new InvalidSnapshotPathError('path must be relative')
  }
  const segments = posix.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) {
    throw new InvalidSnapshotPathError('path resolves to empty')
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new InvalidSnapshotPathError('path may not contain . or ..')
    }
    if (SNAPSHOT_FORBIDDEN_SIGIL_SEGMENTS.has(seg)) {
      throw new InvalidSnapshotPathError(
        `path may not contain operational sigil segment (${seg})`,
      )
    }
    if (seg.length > 256) {
      throw new InvalidSnapshotPathError(
        `segment '${seg}' exceeds 256 chars`,
      )
    }
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      throw new InvalidSnapshotPathError(
        `segment '${seg}' contains a forbidden character`,
      )
    }
  }
}

/**
 * P7.4 restore UI — list snapshots (commits) in the project's
 * `.project-backup/` history, newest first. The first commit
 * (`init: project-backup ...`) IS included so users can rewind to
 * the as-imported state.
 *
 * Returns `{ snapshots: [], next_cursor: null }` when the backup
 * repo hasn't been initialized yet (no snapshots to restore from).
 * Throws `RestoreUnavailableError` only when the git binary itself
 * is missing on this gateway.
 */
export async function listSnapshots(
  ctx: GitRepoContext,
  project_id: string,
  opts: { limit?: number; before_sha?: string } = {},
): Promise<{ snapshots: SnapshotSummary[]; next_cursor: string | null }> {
  if (!(await ctx.isGitAvailable())) {
    throw new RestoreUnavailableError('git binary not available')
  }
  if (!existsSync(join(ctx.gitDir(project_id), 'HEAD'))) {
    return { snapshots: [], next_cursor: null }
  }
  const limit = clampSnapshotLimit(opts.limit)
  const args = ctx.gitDirArgs(project_id).concat([
    'log',
    '--no-color',
    `--pretty=format:%H%x00%P%x00%aI%x00%s`,
    `--max-count=${limit + 1}`,
  ])
  if (opts.before_sha !== undefined) {
    assertSnapshotSha(opts.before_sha)
    args.push(`${opts.before_sha}~1`)
  }
  const { stdout } = await ctx.gitExec(args, { allowNonZero: true })
  if (stdout.length === 0) {
    return { snapshots: [], next_cursor: null }
  }
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  const all: Array<Omit<SnapshotSummary, 'shortstat'>> = []
  for (const line of lines) {
    const parts = line.split('\u0000')
    const [sha = '', parents = '', date = '', ...subjectParts] = parts
    if (sha.length === 0) continue
    const message = subjectParts.join('\u0000')
    const parentSha = parents.split(' ')[0] ?? ''
    all.push({
      sha,
      parent_sha: parentSha.length > 0 ? parentSha : null,
      message,
      author_date: date,
    })
  }
  const page = all.length <= limit ? all : all.slice(0, limit)
  // Per-row shortstat; parallelize with a small concurrency cap so a
  // page of 200 rows doesn't fan out 200 simultaneous git processes.
  const shortstats = await fetchShortstats(
    ctx,
    project_id,
    page.map((entry) => ({ sha: entry.sha, parent_sha: entry.parent_sha })),
  )
  const snapshots: SnapshotSummary[] = page.map((entry, idx) => ({
    ...entry,
    shortstat: shortstats[idx] ?? null,
  }))
  const cursor =
    all.length <= limit
      ? null
      : (page[page.length - 1]?.sha ?? null)
  return { snapshots, next_cursor: cursor }
}

/**
 * Compute per-row shortstats serially in small batches. `git diff
 * --shortstat <parent>..<sha>` is cheap on small commits but
 * cumulatively expensive — capping concurrency at 4 keeps the
 * cumulative wall-clock < 1s for a 60-row page even on cold cache.
 */
async function fetchShortstats(
  ctx: GitRepoContext,
  project_id: string,
  rows: Array<{ sha: string; parent_sha: string | null }>,
): Promise<Array<SnapshotSummary['shortstat']>> {
  const out: Array<SnapshotSummary['shortstat']> = new Array(rows.length).fill(null)
  const CONCURRENCY = 4
  let next = 0
  const workers: Array<Promise<void>> = []
  const run = async (): Promise<void> => {
    while (true) {
      const idx = next
      next += 1
      if (idx >= rows.length) return
      const row = rows[idx]!
      if (row.parent_sha === null) {
        out[idx] = null
        continue
      }
      try {
        const { stdout } = await ctx.gitExec(
          ctx.gitDirArgs(project_id).concat([
            'diff',
            '--shortstat',
            '--no-color',
            `${row.parent_sha}..${row.sha}`,
          ]),
          { allowNonZero: true },
        )
        out[idx] = parseShortstat(stdout)
      } catch {
        out[idx] = null
      }
    }
  }
  for (let i = 0; i < CONCURRENCY; i += 1) {
    workers.push(run())
  }
  await Promise.all(workers)
  return out
}

/**
 * Build the file-level preview shape: every path touched between
 * `sha` and the current working tree, plus the snapshot's metadata.
 *
 * Status semantics are HEAD-relative (NOT parent-relative): the UI
 * cares about "what would restoring this snapshot do to the live
 * tree?", not "what did this snapshot add over the previous tick".
 *   `added`     — exists at sha but not at HEAD
 *   `deleted`   — exists at HEAD but not at sha
 *   `modified`  — exists at both, content differs
 *   (unchanged paths are NOT returned in v1 — they would balloon
 *   the response shape for a large repo with no UI value)
 */
export async function previewSnapshot(
  ctx: GitRepoContext,
  project_id: string,
  sha: string,
): Promise<SnapshotPreview> {
  if (!(await ctx.isGitAvailable())) {
    throw new RestoreUnavailableError('git binary not available')
  }
  assertSnapshotSha(sha)
  if (!existsSync(join(ctx.gitDir(project_id), 'HEAD'))) {
    throw new SnapshotNotFoundError(
      `no backup repo for project=${project_id}`,
    )
  }
  await assertSnapshotExists(ctx, project_id, sha)
  const meta = await readSnapshotMeta(ctx, project_id, sha)
  // `diff --name-status HEAD..sha` returns the per-path change
  // status — A / M / D / R<NN> / C<NN>. We collapse renames into
  // (deleted-source, added-target) for v1; restoring a rename is
  // legal but the UI doesn't need to render the source+target pair
  // as one row to ship the v1 surface.
  const { stdout } = await ctx.gitExec(
    ctx.gitDirArgs(project_id).concat([
      'diff',
      '--name-status',
      '--no-color',
      '-z',
      `HEAD..${sha}`,
    ]),
    { allowNonZero: true },
  )
  const files = parseNameStatusZ(stdout)
  // Fill in per-path sizes for the files-at-sha shape. `git cat-file
  // -s <sha>:<path>` is cheap and parallelizable.
  const sized = await fetchSnapshotFileSizes(ctx, project_id, sha, files)
  return {
    sha,
    parent_sha: meta.parent_sha,
    message: meta.message,
    author_date: meta.author_date,
    files: sized,
  }
}

async function fetchSnapshotFileSizes(
  ctx: GitRepoContext,
  project_id: string,
  sha: string,
  files: Array<{ path: string; status: SnapshotFileStatus }>,
): Promise<SnapshotFile[]> {
  const out: SnapshotFile[] = new Array(files.length)
  const CONCURRENCY = 4
  let next = 0
  const workers: Array<Promise<void>> = []
  const run = async (): Promise<void> => {
    while (true) {
      const idx = next
      next += 1
      if (idx >= files.length) return
      const f = files[idx]!
      if (f.status === 'deleted') {
        out[idx] = { path: f.path, status: f.status, size_bytes_at_sha: null }
        continue
      }
      try {
        const { stdout } = await ctx.gitExec(
          ctx.gitDirArgs(project_id).concat([
            'cat-file',
            '-s',
            `${sha}:${f.path}`,
          ]),
        )
        const size = Number(stdout.trim())
        out[idx] = {
          path: f.path,
          status: f.status,
          size_bytes_at_sha: Number.isFinite(size) ? size : null,
        }
      } catch {
        out[idx] = { path: f.path, status: f.status, size_bytes_at_sha: null }
      }
    }
  }
  for (let i = 0; i < CONCURRENCY; i += 1) {
    workers.push(run())
  }
  await Promise.all(workers)
  return out
}

/**
 * Read a single file's body at a snapshot SHA. Returns `binary: true`
 * (and an empty `content` body) when the bytes don't round-trip
 * cleanly through UTF-8. Truncates over the configured cap.
 *
 * Path safety: every input runs through `assertSnapshotPath` which
 * mirrors the doc-store's hostile-input checks (no `..`, no absolute
 * paths, no NUL bytes, no hidden segments).
 */
export async function getSnapshotFileContent(
  ctx: GitRepoContext,
  project_id: string,
  sha: string,
  relPath: string,
): Promise<SnapshotFileContent> {
  if (!(await ctx.isGitAvailable())) {
    throw new RestoreUnavailableError('git binary not available')
  }
  assertSnapshotSha(sha)
  assertSnapshotPath(relPath)
  if (!existsSync(join(ctx.gitDir(project_id), 'HEAD'))) {
    throw new SnapshotNotFoundError(`no backup repo for project=${project_id}`)
  }
  await assertSnapshotExists(ctx, project_id, sha)
  let stdout: string
  try {
    const result = await ctx.gitExec(
      ctx.gitDirArgs(project_id).concat([
        'cat-file',
        'blob',
        `${sha}:${relPath}`,
      ]),
    )
    stdout = result.stdout
  } catch (err) {
    throw new SnapshotPathNotFoundError(
      `path '${relPath}' not found at snapshot ${sha} (${errMessage(err)})`,
    )
  }
  const bytes = Buffer.byteLength(stdout, 'utf8')
  // Cheap binary sniff: any 0x00 byte in the first 8 KB. The version
  // store's pre-write `Buffer.byteLength` round-trip already screens
  // text-files from binaries via the extension whitelist, but the
  // project-level repo accepts arbitrary files — so a PDF, SQLite db,
  // or PNG could land at a snapshot and the surface MUST flag those
  // as binary rather than emit a corrupt UTF-8 body to the client.
  const slice = stdout.slice(0, 8192)
  const looksBinary = slice.includes('\u0000')
  let truncated = false
  let body = looksBinary ? '' : stdout
  if (body.length > SNAPSHOT_FILE_OUTPUT_CAP_BYTES) {
    body = body.slice(0, SNAPSHOT_FILE_OUTPUT_CAP_BYTES)
    truncated = true
  }
  return {
    sha,
    path: relPath,
    content: body,
    binary: looksBinary,
    size_bytes: bytes,
    truncated,
  }
}

/**
 * Unified diff for a single file between the current working tree
 * (HEAD-as-of-snapshot-call) and `sha`. The diff direction is
 * `HEAD..sha` so the `+` lines are "what restoring this snapshot
 * would add" and `-` lines are "what it would remove". Truncates
 * at the configured cap.
 */
export async function getSnapshotFileDiff(
  ctx: GitRepoContext,
  project_id: string,
  sha: string,
  relPath: string,
): Promise<SnapshotFileDiff> {
  if (!(await ctx.isGitAvailable())) {
    throw new RestoreUnavailableError('git binary not available')
  }
  assertSnapshotSha(sha)
  assertSnapshotPath(relPath)
  if (!existsSync(join(ctx.gitDir(project_id), 'HEAD'))) {
    throw new SnapshotNotFoundError(`no backup repo for project=${project_id}`)
  }
  await assertSnapshotExists(ctx, project_id, sha)
  const { stdout } = await ctx.gitExec(
    ctx.gitDirArgs(project_id).concat([
      'diff',
      '--unified=3',
      '--no-color',
      `HEAD..${sha}`,
      '--',
      relPath,
    ]),
    { allowNonZero: true },
  )
  let hunks = extractProjectBackupDiffHunks(stdout)
  let truncated = false
  if (Buffer.byteLength(hunks, 'utf8') > SNAPSHOT_DIFF_OUTPUT_CAP_BYTES) {
    const sliced = Buffer.from(hunks, 'utf8').slice(
      0,
      SNAPSHOT_DIFF_OUTPUT_CAP_BYTES,
    )
    hunks = `${sliced.toString('utf8')}\n... (diff truncated at ${SNAPSHOT_DIFF_OUTPUT_CAP_BYTES} bytes) ...`
    truncated = true
  }
  return { sha, path: relPath, hunks, truncated }
}

/** Throws `SnapshotNotFoundError` when `sha` doesn't resolve to a
 *  commit in the project-backup repo. */
export async function assertSnapshotExists(
  ctx: GitRepoContext,
  project_id: string,
  sha: string,
): Promise<void> {
  try {
    await ctx.gitExec(
      ctx.gitDirArgs(project_id).concat([
        'cat-file',
        '-e',
        `${sha}^{commit}`,
      ]),
    )
  } catch {
    throw new SnapshotNotFoundError(
      `snapshot ${sha} does not exist in project ${project_id}`,
    )
  }
}

async function readSnapshotMeta(
  ctx: GitRepoContext,
  project_id: string,
  sha: string,
): Promise<{ parent_sha: string | null; message: string; author_date: string }> {
  const { stdout } = await ctx.gitExec(
    ctx.gitDirArgs(project_id).concat([
      'log',
      '-1',
      '--no-color',
      '--pretty=format:%P%x00%aI%x00%s',
      sha,
    ]),
  )
  const [parents = '', date = '', ...subjectParts] = stdout.split('\u0000')
  const parentSha = parents.split(' ')[0] ?? ''
  return {
    parent_sha: parentSha.length > 0 ? parentSha : null,
    message: subjectParts.join('\u0000'),
    author_date: date,
  }
}

function clampSnapshotLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return SNAPSHOT_DEFAULT_LIMIT
  if (!Number.isFinite(limit) || limit <= 0) return SNAPSHOT_DEFAULT_LIMIT
  const floor = Math.floor(limit)
  if (floor > SNAPSHOT_MAX_LIMIT) return SNAPSHOT_MAX_LIMIT
  return floor
}

/**
 * Parse a `git diff --shortstat` line. Shapes seen in the wild:
 *
 *   ` 3 files changed, 12 insertions(+), 5 deletions(-)`
 *   ` 1 file changed, 1 insertion(+)`
 *   ` 1 file changed, 0 insertions(+), 2 deletions(-)`
 *   `` (empty — no changes, returns zeroes)
 */
function parseShortstat(raw: string): SnapshotSummary['shortstat'] {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { files_changed: 0, insertions: 0, deletions: 0 }
  }
  const files = /(\d+) files? changed/.exec(trimmed)
  const inserts = /(\d+) insertions?\(\+\)/.exec(trimmed)
  const deletes = /(\d+) deletions?\(-\)/.exec(trimmed)
  return {
    files_changed: files !== null ? Number(files[1]) : 0,
    insertions: inserts !== null ? Number(inserts[1]) : 0,
    deletions: deletes !== null ? Number(deletes[1]) : 0,
  }
}

/**
 * Parse `git diff --name-status -z HEAD..sha` output. With `-z`,
 * fields are NUL-separated (NOT tab-separated as in the non-`-z`
 * mode). Entries look like:
 *
 *   - A / M / D / T:  `<status>\0<path>\0`
 *   - R<NN> / C<NN>:  `<status>\0<from>\0<to>\0`
 *
 * The leading character of the status code distinguishes two-field
 * vs three-field entries. v1 collapses rename/copy pairs into
 * (deleted-source, added-target) so the UI can show "this file
 * moved" as two rows; a unified rename row is a future polish.
 */
function parseNameStatusZ(
  raw: string,
): Array<{ path: string; status: SnapshotFileStatus }> {
  if (raw.length === 0) return []
  const fields = raw.split('\u0000').filter((t) => t.length > 0)
  const out: Array<{ path: string; status: SnapshotFileStatus }> = []
  let i = 0
  while (i < fields.length) {
    const statusCode = fields[i]!
    const head = statusCode.charAt(0)
    if (head === 'R' || head === 'C') {
      const from = fields[i + 1] ?? ''
      const to = fields[i + 2] ?? ''
      if (from.length > 0 && to.length > 0) {
        out.push({ path: from, status: 'deleted' })
        out.push({ path: to, status: 'added' })
      } else if (from.length > 0) {
        out.push({ path: from, status: 'modified' })
      }
      i += 3
      continue
    }
    const path = fields[i + 1] ?? ''
    if (path.length === 0) {
      i += 1
      continue
    }
    const status: SnapshotFileStatus =
      head === 'A'
        ? 'added'
        : head === 'D'
          ? 'deleted'
          : head === 'M'
            ? 'modified'
            : 'modified'
    out.push({ path, status })
    i += 2
  }
  return out
}

/** Same diff-header stripper used by `doc-version-store.ts`, copied
 *  here so the project-backup module stays self-contained. */
function extractProjectBackupDiffHunks(raw: string): string {
  if (raw.length === 0) return ''
  const lines = raw.split('\n')
  const out: string[] = []
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      out.push(line)
      continue
    }
    if (
      !inHunk &&
      (line.startsWith('diff --git ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('similarity index ') ||
        line.startsWith('rename from ') ||
        line.startsWith('rename to ') ||
        line.startsWith('new file mode ') ||
        line.startsWith('deleted file mode ') ||
        line.startsWith('old mode ') ||
        line.startsWith('new mode ') ||
        line.startsWith('Binary files '))
    ) {
      continue
    }
    if (!inHunk) continue
    out.push(line)
  }
  return out.join('\n')
}
