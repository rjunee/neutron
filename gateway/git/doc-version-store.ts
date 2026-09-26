import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { ProjectBackupStore } from './project-backup-store.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('docs.versioning')

/** Coerce arbitrary log meta to the logger's primitive `LogValue` shape —
 *  non-primitives are JSON-stringified so the emitted `k=v` line stays single. */
const coerceLogFields = (
  fields?: Record<string, unknown>,
): Record<string, string | number | boolean | null | undefined> | undefined => {
  if (fields === undefined) return undefined
  const out: Record<string, string | number | boolean | null | undefined> = {}
  for (const [k, v] of Object.entries(fields)) {
    out[k] =
      v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
        ? (v as string | number | boolean | null | undefined)
        : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
  }
  return out
}

const execFileAsync = promisify(execFile)

/**
 * Hard timeout per `git` invocation. A healthy commit on a small repo
 * runs in <100 ms; if any call exceeds 30 s the runaway is most likely
 * a wedge (corrupt repo, fs hang) and the per-project mutex would
 * otherwise block every subsequent edit indefinitely.
 */
const GIT_EXEC_TIMEOUT_MS = 30_000

/** Cap on `git log`-derived history pages. */
export const HISTORY_DEFAULT_LIMIT = 50
export const HISTORY_MAX_LIMIT = 200

/** Cap on diff output size — returned with `truncated: true` past this. */
export const DIFF_OUTPUT_CAP_BYTES = 200_000

/**
 * Structured-log sink. Defaults to `console.warn` so the gateway's
 * unified log capture picks it up; tests inject a custom sink to assert
 * specific events landed.
 */
export type DocVersionLogger = (
  event: string,
  fields: Record<string, unknown>,
) => void

const DEFAULT_LOGGER: DocVersionLogger = (event, fields) => {
  moduleLog.warn(event, coerceLogFields(fields))
}

export interface DocVersionStoreOptions {
  /** Shared canonical vault writer; owns the backup/restore mutex. */
  backupStore: Pick<ProjectBackupStore, 'ensureInit' | 'commitDocument'>
  /** Absolute path to the per-instance `<owner_home>` dir. */
  owner_home: string
  /** Instance slug — used to build the synthetic per-instance git identity. */
  project_slug: string
  /**
   * Override how the per-project root is resolved. Production uses the
   * default (`<owner_home>/Projects/<project_id>`); the test harness
   * can swap this for a fixed dir without restructuring the tmp tree.
   * NB: this returns the PROJECT root, not the docs root — the version
   * store reads the canonical `.project-backup/` sibling of `docs/`.
   */
  resolveProjectRoot?: (project_id: string) => string
  /** Structured-log sink. Defaults to a `console.warn` wrapper. */
  logger?: DocVersionLogger
  /**
   * Override the `git` binary path. Defaults to `'git'` from PATH. Tests
   * supply a path that doesn't exist to simulate the missing-binary
   * failure mode without globally unsetting PATH.
   */
  gitBinary?: string
}

/** Per-commit metadata returned by `history`. */
export interface CommitSummary {
  sha: string
  parent_sha: string | null
  message: string
  author_date: string
}

/** Result shape for `read_at`. */
export interface VersionContent {
  sha: string
  path: string
  content: string
  size_bytes: number
  author_date: string
  message: string
}

/** Result shape for `diff`. */
export interface DiffResult {
  path: string
  from: string
  to: string
  hunks: string
  truncated: boolean
}

/**
 * Result shape for `revert` — the caller invokes DocStore.writeDoc and
 * threads the resulting WriteFileResult back through; the version
 * store exposes only the content lookup + commit shaping.
 *
 * Discriminated union on `deleted` so the surface can narrow without an
 * extra null-check on `content`. Codex r2 BLOCKING #1 — `deleted: true`
 * is the explicit "the path was a delete at that sha, route to the
 * delete branch" signal. A SHA that doesn't exist at all raises
 * `UnknownShaError` instead, never returning a `RevertContent`.
 */
export type RevertContent =
  | {
      /** UTF-8 file content at the target sha. */
      content: string
      deleted: false
      /** Short sha used in the auto-generated commit message. */
      target_short_sha: string
    }
  | {
      /** Path was deleted at the target sha — caller routes to delete. */
      content: null
      deleted: true
      target_short_sha: string
    }

/** `commit` mutation kinds — distinct messages per shape. */
export type CommitKind =
  | { op: 'create'; path: string }
  | { op: 'edit'; path: string }
  | { op: 'delete'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'revert'; path: string; target_sha: string }

/**
 * Raised when the version store cannot service a history-side request
 * because the git binary is unavailable on this gateway. Surfaces as a
 * 503 with `code: versioning_unavailable` on every history/version/
 * revert/diff route.
 */
export class VersioningUnavailableError extends Error {
  readonly code = 'versioning_unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'VersioningUnavailableError'
  }
}

/** Raised when a requested sha doesn't exist in the version store. */
export class VersionNotFoundError extends Error {
  readonly code = 'version_not_found' as const
  constructor(message: string) {
    super(message)
    this.name = 'VersionNotFoundError'
  }
}

/** Raised when a sha-shaped param is malformed. */
export class InvalidShaError extends Error {
  readonly code = 'invalid_sha' as const
  constructor(message: string) {
    super(message)
    this.name = 'InvalidShaError'
  }
}

/**
 * Raised when `revertContent` is asked about a sha that doesn't exist
 * in the version store at all (stale UI, mistyped, malicious). Distinct
 * from a sha that DOES exist but represents a delete-commit for the
 * given path — that returns `{deleted: true}` so the caller can revert
 * the live file to a deleted state. An unknown sha surfaces as 404 with
 * code `unknown_sha`; without this distinction, an unknown sha would
 * have looked identical to "file deleted at that sha" and the revert
 * handler would have silently destroyed the live doc. Codex r2 P1.
 */
export class UnknownShaError extends Error {
  readonly code = 'unknown_sha' as const
  constructor(message: string) {
    super(message)
    this.name = 'UnknownShaError'
  }
}

/**
 * The git-backed docs version store. One instance per gateway; reads legacy and current history from the
 * canonical `.project-backup/` repository. All writes use ProjectBackupStore.
 */
export class DocVersionStore {
  private readonly backupStore: DocVersionStoreOptions['backupStore']
  private readonly project_slug: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly logger: DocVersionLogger
  private readonly gitBinary: string

  /** Cached result of the once-per-process git binary probe. */
  private gitAvailableProbe: Promise<boolean> | null = null

  constructor(opts: DocVersionStoreOptions) {
    this.backupStore = opts.backupStore
    this.project_slug = opts.project_slug
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.logger = opts.logger ?? DEFAULT_LOGGER
    this.gitBinary = opts.gitBinary ?? 'git'
  }

  /** Instance slug — exposed for callers that need the synthetic identity. */
  get ownerSlug(): string {
    return this.project_slug
  }

  /**
   * True when the configured git binary responded to `git --version`
   * during boot or first use. Resolves to `false` for the entire
   * process lifetime when `git` is missing; the doc-store's write
   * surface becomes a no-op for versioning but writes still succeed.
   */
  async isGitAvailable(): Promise<boolean> {
    if (this.gitAvailableProbe === null) {
      this.gitAvailableProbe = this.probeGitBinary()
    }
    return this.gitAvailableProbe
  }

  private async probeGitBinary(): Promise<boolean> {
    try {
      await execFileAsync(this.gitBinary, ['--version'], {
        timeout: GIT_EXEC_TIMEOUT_MS,
      })
      return true
    } catch {
      this.logger('docs.versioning.unavailable', {
        reason: 'git_not_found',
        git_binary: this.gitBinary,
      })
      return false
    }
  }

  /**
   * Idempotent first-init for a project. Safe to call concurrently —
   * the second caller waits on the first. Skips when `docs/` doesn't
   * exist yet (deferred to the first real write). Returns `true` when
   * the repo is ready, `false` when init was skipped (git unavailable
   * or no docs/ yet) — callers can use that to decide whether to bother
   * recording subsequent ops.
   */
  async ensureInit(project_id: string): Promise<boolean> {
    if (!(await this.isGitAvailable())) return false
    if (!existsSync(join(this.resolveProjectRoot(project_id), 'docs'))) return false
    return this.backupStore.ensureInit(project_id)
  }

  /** The user's write wins; a failed snapshot is visible in the structured log. */
  async commit(project_id: string, kind: CommitKind): Promise<void> {
    if (!(await this.isGitAvailable())) return
    try {
      await this.backupStore.commitDocument(project_id, formatCommitMessage(kind))
    } catch (err) {
      this.logger('docs.versioning.commit_failed', {
        project_id, op: kind.op, error_message: errMessage(err),
      })
    }
  }

  /**
   * List commits that touched `relPath`. Returns up to `limit` entries
   * (default 50, cap 200). `before_sha`, when set, paginates by walking
   * backwards from that sha.
   */
  async history(
    project_id: string,
    relPath: string,
    opts: { limit?: number; before_sha?: string } = {},
  ): Promise<{ entries: CommitSummary[]; next_cursor: string | null }> {
    if (!(await this.isGitAvailable())) {
      throw new VersioningUnavailableError('git binary not available')
    }
    const ready = await this.ensureInit(project_id)
    if (!ready) return { entries: [], next_cursor: null }
    const limit = clampHistoryLimit(opts.limit)
    if (opts.before_sha !== undefined) assertShaShape(opts.before_sha)
    // Keep the canonical timeline first and retain original doc-only SHAs.
    // --follow runs separately because legacy docs had a different tree root.
    const format = '--pretty=format:%H%x00%P%x00%aI%x00%s'
    const canonical = await this.gitExec(this.workArgs(project_id).concat([
      'log', '--no-color', '--follow', format, 'HEAD',
      '--glob=refs/vault-history/materializer/*', '--', `docs/${relPath}`,
    ]))
    const legacyRefs = await this.gitExec(this.gitDirArgs(project_id).concat([
      'for-each-ref', '--format=%(refname)', 'refs/vault-history/docs/',
    ]))
    const legacy = legacyRefs.stdout.trim() ? await this.gitExec(this.workArgs(project_id).concat([
      'log', '--no-color', '--follow', format, '--glob=refs/vault-history/docs/*',
      '--', relPath,
    ])) : { stdout: '' }
    const stdout = canonical.stdout + '\n' + legacy.stdout
    const lines = stdout.split('\n').filter((line) => line.length > 0)
    const all: CommitSummary[] = []
    for (const line of lines) {
      const parts = line.split('\u0000')
      const [sha = '', parent = '', date = '', ...subjectParts] = parts
      if (sha.length === 0 || all.some((entry) => entry.sha === sha)) continue
      const message = subjectParts.join('\u0000')
      const parentSha = parent.split(' ')[0] ?? ''
      all.push({
        sha,
        parent_sha: parentSha.length > 0 ? parentSha : null,
        message,
        author_date: date,
      })
    }
    const cursorIndex = opts.before_sha === undefined ? -1
      : all.findIndex((entry) => entry.sha === opts.before_sha)
    if (opts.before_sha !== undefined && cursorIndex < 0) {
      throw new VersionNotFoundError('history cursor is not present for this document')
    }
    const remaining = all.slice(cursorIndex + 1)
    const entries = remaining.slice(0, limit)
    return {
      entries,
      next_cursor: remaining.length > limit ? entries.at(-1)?.sha ?? null : null,
    }
  }

  /**
   * Read a file's content as it existed at `sha`. Throws
   * `VersionNotFoundError` when the sha doesn't exist or the path
   * didn't exist at that sha.
   */
  async read_at(
    project_id: string,
    relPath: string,
    sha: string,
  ): Promise<VersionContent> {
    if (!(await this.isGitAvailable())) {
      throw new VersioningUnavailableError('git binary not available')
    }
    assertShaShape(sha)
    const ready = await this.ensureInit(project_id)
    if (!ready) {
      throw new VersionNotFoundError(`no version store for project=${project_id}`)
    }
    const args = this.gitDirArgs(project_id).concat([
      'cat-file',
      'blob',
      `${sha}:${await this.pathAt(project_id, sha, relPath)}`,
    ])
    let stdout: string
    try {
      const result = await this.gitExec(args)
      stdout = result.stdout
    } catch (err) {
      throw new VersionNotFoundError(
        `no version at sha=${sha} path=${relPath} (${errMessage(err)})`,
      )
    }
    const meta = await this.readCommitMeta(project_id, sha)
    return {
      sha,
      path: relPath,
      content: stdout,
      size_bytes: Buffer.byteLength(stdout, 'utf8'),
      author_date: meta.author_date,
      message: meta.message,
    }
  }

  /**
   * Look up the content stored at `target_sha` for `relPath`. The
   * caller is responsible for writing the content back through
   * `DocStore.writeDoc` (which then triggers a normal `commit` of kind
   * `revert`). Returns `null` content when the path was a delete at
   * that sha — the caller can still re-create it from scratch.
   */
  async revertContent(
    project_id: string,
    relPath: string,
    target_sha: string,
  ): Promise<RevertContent> {
    if (!(await this.isGitAvailable())) {
      throw new VersioningUnavailableError('git binary not available')
    }
    assertShaShape(target_sha)
    const ready = await this.ensureInit(project_id)
    if (!ready) {
      throw new VersionNotFoundError(`no version store for project=${project_id}`)
    }
    // Codex r2 BLOCKING #1 — verify the sha exists as a commit BEFORE
    // attempting to read the path at that sha. Without this guard, a
    // stale-UI / mistyped / malicious 40-hex sha would short-circuit
    // through the cat-file-blob failure path below and return
    // `content: null`, which the `/docs/revert` handler interpreted as
    // "the file was deleted at that sha → delete the live doc". A
    // catastrophic data-loss bug for a versioning feature.
    //
    // `cat-file -e <sha>^{commit}` exits 0 only when the sha resolves to
    // an actual commit in the repo. Object-type mismatch (blob / tree
    // sha) AND missing-object both surface as non-zero, and both must
    // be treated as `unknown_sha` — neither shape should ever feed into
    // a deleteDoc call.
    const existsArgs = this.gitDirArgs(project_id).concat([
      'cat-file',
      '-e',
      `${target_sha}^{commit}`,
    ])
    try {
      await this.gitExec(existsArgs)
    } catch {
      throw new UnknownShaError(
        `sha=${target_sha} does not exist as a commit in the version store`,
      )
    }
    // SHA exists. Now read the file at that SHA. A failure here means
    // "this path was deleted at that commit" (legitimate revert-to-
    // delete) — return `deleted: true` so the surface routes to the
    // delete branch.
    const args = this.gitDirArgs(project_id).concat([
      'cat-file',
      'blob',
      `${target_sha}:${await this.pathAt(project_id, target_sha, relPath)}`,
    ])
    try {
      const { stdout } = await this.gitExec(args)
      return {
        content: stdout,
        deleted: false,
        target_short_sha: target_sha.slice(0, 7),
      }
    } catch {
      return {
        content: null,
        deleted: true,
        target_short_sha: target_sha.slice(0, 7),
      }
    }
  }

  /**
   * Text diff between two versions of one file. `to` accepts the
   * literal string `'head'` to compare against the current working
   * tree state. Truncates at 200 KB and sets `truncated: true`.
   */
  async diff(
    project_id: string,
    relPath: string,
    from: string,
    to: string,
  ): Promise<DiffResult> {
    if (relPath.startsWith('/') || relPath.split(/[\\/]/).some((part) => part === '..')) {
      throw new VersionNotFoundError('document path must remain inside docs')
    }
    if (!(await this.isGitAvailable())) {
      throw new VersioningUnavailableError('git binary not available')
    }
    assertShaShape(from)
    if (to !== 'head') assertShaShape(to)
    const ready = await this.ensureInit(project_id)
    if (!ready) {
      throw new VersionNotFoundError(`no version store for project=${project_id}`)
    }
    const contentAt = async (sha: string): Promise<string> => {
      const result = await this.revertContent(project_id, relPath, sha)
      return result.content ?? ''
    }
    const before = await contentAt(from)
    const after = to === 'head'
      ? await readFile(join(this.workTree(project_id), 'docs', relPath), 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return ''
        throw err
      })
      : await contentAt(to)
    const scratch = await mkdtemp(join(tmpdir(), 'vault-doc-diff-'))
    let stdout: string
    try {
      await writeFile(join(scratch, 'before'), before)
      await writeFile(join(scratch, 'after'), after)
      stdout = (await this.gitExec([
        'diff', '--no-index', '--unified=3', '--no-color', '--',
        join(scratch, 'before'), join(scratch, 'after'),
      ], { allowNonZero: true })).stdout
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    const hunks = extractDiffHunks(stdout)
    let truncated = false
    let output = hunks
    if (Buffer.byteLength(output, 'utf8') > DIFF_OUTPUT_CAP_BYTES) {
      const sliced = Buffer.from(output, 'utf8').slice(0, DIFF_OUTPUT_CAP_BYTES)
      output = `${sliced.toString('utf8')}\n... (diff truncated at ${DIFF_OUTPUT_CAP_BYTES} bytes) ...`
      truncated = true
    }
    return { path: relPath, from, to, hunks: output, truncated }
  }

  /** An original doc-only commit has paths relative to docs, unlike vault commits. */
  private async pathAt(project_id: string, sha: string, relPath: string): Promise<string> {
    const { stdout } = await this.gitExec(this.gitDirArgs(project_id).concat([
      'for-each-ref', '--format=%(refname)', `--contains=${sha}`,
      'refs/vault-history/docs/',
    ]))
    return stdout.trim() ? relPath : `docs/${relPath}`
  }

  /** Resolved canonical vault git directory for a project. */
  private gitDir(project_id: string): string {
    return join(this.resolveProjectRoot(project_id), '.project-backup')
  }

  /** Resolved `docs/` for a project. */
  private workTree(project_id: string): string {
    return this.resolveProjectRoot(project_id)
  }

  /** `--git-dir=<...>` argv prefix. */
  private gitDirArgs(project_id: string): string[] {
    return [`--git-dir=${this.gitDir(project_id)}`]
  }

  /** `--git-dir=<...> --work-tree=<...>` argv prefix. */
  private workArgs(project_id: string): string[] {
    return [
      `--git-dir=${this.gitDir(project_id)}`,
      `--work-tree=${this.workTree(project_id)}`,
    ]
  }

  private async gitExec(
    args: string[],
    opts: { allowNonZero?: boolean; cwd?: string } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const execOpts: Parameters<typeof execFileAsync>[2] = {
        timeout: GIT_EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      }
      if (opts.cwd !== undefined) execOpts.cwd = opts.cwd
      const { stdout, stderr } = await execFileAsync(this.gitBinary, args, execOpts)
      // `encoding: 'utf8'` makes execFile return strings, but the
      // overload resolution via Parameters<...> still widens the
      // result type to `string | Buffer`. Coerce to string defensively.
      return {
        stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
        stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
      }
    } catch (err) {
      if (opts.allowNonZero === true && isExecChildError(err)) {
        return {
          stdout: typeof err.stdout === 'string' ? err.stdout : '',
          stderr: typeof err.stderr === 'string' ? err.stderr : '',
        }
      }
      throw err
    }
  }

  private async readCommitMeta(
    project_id: string,
    sha: string,
  ): Promise<{ author_date: string; message: string }> {
    const args = this.workArgs(project_id).concat([
      'log',
      '-1',
      '--no-color',
      '--pretty=format:%aI%x00%s',
      sha,
    ])
    try {
      const { stdout } = await this.gitExec(args)
      const [date = '', message = ''] = stdout.split('\u0000')
      return { author_date: date, message }
    } catch {
      return { author_date: '', message: '' }
    }
  }


}

/**
 * Render a commit message for the given mutation kind. Auto-generated;
 * user-customizable commit messages are explicitly out of scope for
 * Phase 1.
 */
export function formatCommitMessage(kind: CommitKind): string {
  switch (kind.op) {
    case 'create':
      return `create: ${kind.path}`
    case 'edit':
      return `edit: ${kind.path}`
    case 'delete':
      return `delete: ${kind.path}`
    case 'rename':
      return `rename: ${kind.from} -> ${kind.to}`
    case 'revert':
      return `revert: ${kind.path} to ${kind.target_sha.slice(0, 7)}`
  }
}

/** Strip the diff header lines (`diff --git ...`, `index ...`, `--- ...`,
 *  `+++ ...`) and return only the hunk bodies. */
function extractDiffHunks(raw: string): string {
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

const SHA_RE = /^[0-9a-f]{40}$/

/** Throws `InvalidShaError` when `sha` is not a 40-char lowercase hex. */
export function assertShaShape(sha: string): void {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new InvalidShaError(
      `sha must be a 40-char lowercase hex string (got '${sha}')`,
    )
  }
}

function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return HISTORY_DEFAULT_LIMIT
  if (!Number.isFinite(limit) || limit <= 0) return HISTORY_DEFAULT_LIMIT
  const floor = Math.floor(limit)
  if (floor > HISTORY_MAX_LIMIT) return HISTORY_MAX_LIMIT
  return floor
}

interface ExecChildError extends Error {
  code?: string | number
  stdout?: string | Buffer
  stderr?: string | Buffer
}

function isExecChildError(err: unknown): err is ExecChildError {
  return err instanceof Error
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function errCode(err: unknown): string {
  if (err instanceof Error && (err as ExecChildError).code !== undefined) {
    return String((err as ExecChildError).code)
  }
  return 'unknown'
}

function errStderr(err: unknown): string {
  if (err instanceof Error) {
    const raw = (err as ExecChildError).stderr
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  }
  return ''
}

/** Ensure the parent dir of `abs` exists. */
export async function ensureDir(abs: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true })
}
