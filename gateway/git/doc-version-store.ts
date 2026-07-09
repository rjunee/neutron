/**
 * @neutronai/gateway/git — per-project git-backed doc-versioning store (P7.4 Phase 1).
 *
 * Per SPEC.md § Phases→Steps (P7.4 — git-backed
 * backup + versioning) + docs/plans/P7.4-git-backed-versioning-sprint-
 * brief.md. Phase 1 ships LOCAL-ONLY git: every successful `DocStore`
 * mutation produces a commit in a bare-style sibling repo so the editor
 * can browse, preview, and revert past versions of a doc.
 *
 * On-disk layout (per project):
 *
 *   <owner_home>/Projects/<project_id>/
 *   ├── docs/                          ← working tree (DocStore's anchor)
 *   │   ├── README.md
 *   │   └── notes/brainstorm.md
 *   └── .docs-versions/                ← THIS module owns the .git
 *       ├── HEAD
 *       ├── objects/
 *       ├── refs/heads/main
 *       └── index
 *
 * Why a sibling hidden dir and not `docs/.git`:
 *   1. `docs/.git` would force every `realpath` containment check in
 *      DocStore to special-case `.git`; the bare-repo-elsewhere layout
 *      removes the foot-gun entirely.
 *   2. `docs/.git` mixes VCS metadata with user content; the sibling
 *      layout keeps the working tree clean.
 *   3. The hidden-segment filter in DocStore (`startsWith('.')`) blocks
 *      `.docs-versions/` from the docs surface walk, and the realpath
 *      pin at `docs/` keeps it out of every read/write code path.
 *   4. The project-as-repo convention reserves `<project>/.git` for the
 *      project-level repo. `.docs-versions/` is a second, independent
 *      git repo owning only the docs subtree — commit-per-edit there
 *      doesn't churn the project-level history.
 *
 * Atomicity contract: the WRITE always wins. If the post-write
 * `git add && git commit` fails for any reason, the user's file is NOT
 * rolled back — the disk state already reflects the user's edit, only
 * the version row is lost. The failure is logged via the gateway's
 * structured-log sink as `docs.versioning.commit_failed` and the next
 * successful write picks up the missing changes via `git add -A`.
 *
 * Author identity: one synthetic identity per instance, set at init time:
 *     user.name  = "Neutron Agent"
 *     user.email = "neutron@<project_slug>.local"
 * Multi-author identity is a P7.2 inline-comments concern, not P7.4.
 *
 * Concurrency: the gateway holds a per-project async mutex gating the
 * entire `add → commit` step. Two writes to DIFFERENT paths can
 * interleave at the file level (each carries its own
 * `expected_modified_at`), but the commit step is serialized so
 * concurrent `git commit` invocations don't race on `.docs-versions/index`.
 *
 * Forbidden patterns (explicitly NOT to be implemented):
 *   - branch / merge support
 *   - per-commit user-customizable messages
 *   - history pruning / compaction
 *   - remote push / fetch (S2 of P7.4)
 *   - PlatformAdapter.getRemoteGitConfig() (S2 of P7.4)
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { createKeyedMutex } from '../http/keyed-mutex.ts'
import type { KeyedMutex } from '../http/keyed-mutex.ts'

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
 * Pre-seeded `.gitignore` contents. Binary handling lands in P7.5
 * (git-LFS); until then every binary extension is hard-ignored so a
 * stray `git add .` can never inflate `.docs-versions/objects/`.
 *
 * Forge: do not editorialize this list — the brief pins it verbatim so
 * P7.5 can swap it for a `.gitattributes` lfs filter without rewriting
 * any commit history.
 */
export const DOC_VERSION_GITIGNORE = `# P7.4 — commit markdown only. Binary handling lands in P7.5 (git-LFS).
# Until then every binary extension is hard-ignored so a \`git add .\` can
# never inflate the .docs-versions/objects/ tree with a 50 MB PDF.

# Images
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.svg
*.bmp
*.tiff
*.heic
*.ico

# Audio / video
*.mp3
*.m4a
*.wav
*.flac
*.ogg
*.mp4
*.mov
*.avi
*.webm
*.mkv

# Documents (non-markdown)
*.pdf
*.doc
*.docx
*.xls
*.xlsx
*.ppt
*.pptx
*.odt
*.ods
*.odp

# Archives
*.zip
*.tar
*.tar.gz
*.tgz
*.rar
*.7z

# Bin / temp
*.bin
*.exe
*.dll
*.so
*.dylib
*.tmp
.DS_Store
Thumbs.db
`

/** Sigil dir inside the project that owns the docs git repo. */
const DOCS_GIT_DIR = '.docs-versions'

/** Sigil dir inside the project that owns the docs working tree. */
const DOCS_WORK_TREE_DIR = 'docs'

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
  try {
    console.warn(`[docs.versioning] ${event} ${JSON.stringify(fields)}`)
  } catch {
    console.warn(`[docs.versioning] ${event}`)
  }
}

export interface DocVersionStoreOptions {
  /** Absolute path to the per-instance `<owner_home>` dir. */
  owner_home: string
  /** Instance slug — used to build the synthetic per-instance git identity. */
  project_slug: string
  /**
   * Override how the per-project root is resolved. Production uses the
   * default (`<owner_home>/Projects/<project_id>`); the test harness
   * can swap this for a fixed dir without restructuring the tmp tree.
   * NB: this returns the PROJECT root, not the docs root — the version
   * store owns the `.docs-versions/` sibling of `docs/`.
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
 * The git-backed docs version store. One instance per gateway; every
 * project gets its own `.docs-versions/` lazily on first write.
 */
export class DocVersionStore {
  private readonly owner_home: string
  private readonly project_slug: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly logger: DocVersionLogger
  private readonly gitBinary: string

  /** Cached result of the once-per-process git binary probe. */
  private gitAvailableProbe: Promise<boolean> | null = null

  /** Per-project init guard so concurrent first-writes share one init. */
  private readonly initLocks = new Map<string, Promise<void>>()

  /** Per-project commit mutex (shared keyed-mutex — D4 adoption). */
  private readonly commitMutex: KeyedMutex = createKeyedMutex()

  constructor(opts: DocVersionStoreOptions) {
    this.owner_home = opts.owner_home
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
    const existing = this.initLocks.get(project_id)
    if (existing !== undefined) {
      await existing
      return existsSync(join(this.gitDir(project_id), 'HEAD'))
    }
    const run = (async (): Promise<void> => {
      try {
        await this.doEnsureInit(project_id)
      } catch (err) {
        this.logger('docs.versioning.init_failed', {
          project_id,
          error_message: errMessage(err),
        })
        // On a corrupt-repo init failure, attempt the corruption-
        // recovery flow once and retry. If that ALSO fails, swallow —
        // the write that triggered this call will still have succeeded.
        if (await this.tryRecoverCorruption(project_id, err)) {
          try {
            await this.doEnsureInit(project_id)
          } catch (err2) {
            this.logger('docs.versioning.init_failed_after_recovery', {
              project_id,
              error_message: errMessage(err2),
            })
          }
        }
      }
    })()
    this.initLocks.set(project_id, run)
    try {
      await run
    } finally {
      this.initLocks.delete(project_id)
    }
    return existsSync(join(this.gitDir(project_id), 'HEAD'))
  }

  private async doEnsureInit(project_id: string): Promise<void> {
    const gitDir = this.gitDir(project_id)
    const workTree = this.workTree(project_id)
    if (existsSync(join(gitDir, 'HEAD'))) return
    if (!existsSync(workTree)) return
    await mkdir(gitDir, { recursive: true })
    // We want the .docs-versions/ directory itself to BE the git dir
    // (HEAD / objects / refs at the top level, no nested `.git/`). The
    // canonical way to get that layout is `git init --bare`. Then we
    // flip `core.bare` back to false in the config so subsequent
    // commands tolerate `--work-tree` overrides and produce normal
    // (non-bare) commits — every git call below threads `--work-tree`
    // explicitly so the working tree is always the sibling `docs/`.
    //
    // git 2.28+ supports `--initial-branch=main`; macOS ships 2.40+
    // and Linux deployment is on a similarly modern git. A hypothetical
    // antique git that rejects the flag falls back to plain init.
    try {
      await this.gitExec(['init', '--bare', '--initial-branch=main', gitDir])
    } catch {
      await this.gitExec(['init', '--bare', gitDir])
    }
    await this.gitExec(
      this.gitDirArgs(project_id).concat(['config', 'core.bare', 'false']),
    )
    await this.gitExec(
      this.gitDirArgs(project_id).concat([
        'config',
        'user.name',
        'Neutron Agent',
      ]),
    )
    await this.gitExec(
      this.gitDirArgs(project_id).concat([
        'config',
        'user.email',
        `neutron@${this.project_slug}.local`,
      ]),
    )
    await this.gitExec(
      this.gitDirArgs(project_id).concat([
        'config',
        'commit.gpgsign',
        'false',
      ]),
    )
    // core.worktree is intentionally NOT set in the git config — every
    // git invocation in this module supplies `--git-dir` AND
    // `--work-tree` explicitly. That keeps the on-disk config pinned to
    // the defaults and avoids surprises if a future move of either dir
    // would otherwise have to chase a stale config value.

    // Seed .gitignore so binary writes (P7.5 territory) can't bloat
    // the repo. The file lives under docs/ (working tree) and is
    // hidden from the doc-store tree walk by the existing hidden-
    // segment filter.
    const gitignorePath = join(workTree, '.gitignore')
    await writeFile(gitignorePath, DOC_VERSION_GITIGNORE, 'utf8')
    await this.gitExec(
      this.workArgs(project_id).concat(['add', '.gitignore']),
      { cwd: workTree },
    )
    // Stage any pre-existing tracked content (M2 onboarding, a manual
    // vault rsync, etc.) so the first commit captures the baseline.
    // Without this, the first edit's parent would be the empty tree
    // and reverting "to the version before the first edit" would mean
    // "to nothing" — surprising.
    await this.gitExec(this.workArgs(project_id).concat(['add', '-A']), {
      cwd: workTree,
    })
    await this.gitExec(
      this.workArgs(project_id).concat([
        'commit',
        '--allow-empty',
        '-m',
        'init: docs versioning',
      ]),
      { cwd: workTree },
    )
  }

  /**
   * Record a commit for a successful DocStore mutation. Best-effort —
   * a commit failure is logged but does NOT throw, so the caller's
   * write success is preserved.
   *
   * Folder operations are NOT versioned (git tracks files, not dirs).
   * The caller must skip this for `createFolder` / `deleteFolder`.
   */
  async commit(project_id: string, kind: CommitKind): Promise<void> {
    if (!(await this.isGitAvailable())) return
    const ready = await this.ensureInit(project_id)
    if (!ready) return
    await this.withCommitLock(project_id, async () => {
      try {
        const args = this.workArgs(project_id)
        const workTree = this.workTree(project_id)
        // CWD MUST be the working tree so `git add <pathspec>`
        // resolves the pathspec relative to docs/, not the gateway
        // process's CWD. Without this, every `git add notes.md`
        // becomes `git add <gateway-cwd>/notes.md` which doesn't
        // match any tracked file and silently stages nothing.
        if (kind.op === 'rename') {
          await this.gitExec(args.concat(['add', '--all', kind.from, kind.to]), {
            cwd: workTree,
          })
        } else if (kind.op === 'delete') {
          await this.gitExec(args.concat(['add', '--all', kind.path]), {
            cwd: workTree,
          })
        } else {
          await this.gitExec(args.concat(['add', '--all', kind.path]), {
            cwd: workTree,
          })
        }
        // Check whether anything is staged. `diff --cached --quiet`
        // exits 1 when there ARE staged changes, 0 when there are
        // none. Skipping the commit on a no-op staging keeps the
        // history honest (no empty commits when an "edit" sets the
        // file to its existing content, etc.).
        const hasStaged = await this.hasStagedChanges(project_id)
        if (!hasStaged) return
        const message = formatCommitMessage(kind)
        await this.gitExec(args.concat(['commit', '-m', message]), {
          cwd: workTree,
        })
      } catch (err) {
        this.logger('docs.versioning.commit_failed', {
          project_id,
          op: kind.op,
          path: kind.op === 'rename' ? kind.to : kind.path,
          error_code: errCode(err),
          error_message: errMessage(err),
        })
        // Defensive: unstage whatever's staged so the next commit
        // doesn't inherit a failed staging state. `git reset` (no
        // --hard) leaves the working tree alone — the user's edit
        // remains on disk.
        try {
          await this.gitExec(this.workArgs(project_id).concat(['reset']), {
            cwd: this.workTree(project_id),
          })
        } catch {
          /* swallow — already in a failure path */
        }
        // If the failure looks like repo corruption, rename the
        // broken dir aside and re-init a fresh repo so subsequent
        // writes can resume committing immediately.
        const recovered = await this.tryRecoverCorruption(project_id, err)
        if (recovered) {
          // Invalidate the cached init lock so the next ensureInit
          // rebuilds the repo. The current commit's changes are
          // captured in the fresh init's baseline.
          this.initLocks.delete(project_id)
          try {
            await this.doEnsureInit(project_id)
          } catch (initErr) {
            this.logger('docs.versioning.init_failed_after_recovery', {
              project_id,
              error_message: errMessage(initErr),
            })
          }
        }
      }
    })
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
    // `--follow` traces history across renames so a doc renamed via
    // moveDoc keeps its pre-rename commits visible in the editor's
    // history pane. Without it, `git log -- <path>` stops at the
    // rename and pre-rename versions silently drop off the list.
    // Codex r1 P2.
    const args = this.workArgs(project_id).concat([
      'log',
      '--no-color',
      '--follow',
      `--pretty=format:%H%x00%P%x00%aI%x00%s`,
      `--max-count=${limit + 1}`,
    ])
    if (opts.before_sha !== undefined) {
      assertShaShape(opts.before_sha)
      args.push(`${opts.before_sha}~1`)
    }
    args.push('--', relPath)
    const { stdout } = await this.gitExec(args, { allowNonZero: true })
    if (stdout.length === 0) {
      return { entries: [], next_cursor: null }
    }
    const lines = stdout.split('\n').filter((line) => line.length > 0)
    const all: CommitSummary[] = []
    for (const line of lines) {
      const parts = line.split('\u0000')
      const [sha = '', parent = '', date = '', ...subjectParts] = parts
      if (sha.length === 0) continue
      const message = subjectParts.join('\u0000')
      const parentSha = parent.split(' ')[0] ?? ''
      all.push({
        sha,
        parent_sha: parentSha.length > 0 ? parentSha : null,
        message,
        author_date: date,
      })
    }
    if (all.length <= limit) {
      return { entries: all, next_cursor: null }
    }
    // Codex r2 IMPORTANT #1 — `next_cursor` is the LAST commit returned
    // on this page, not the first commit NOT returned. The next page's
    // query uses `${cursor}~1`, which starts at cursor's parent. So if
    // we returned the first `limit` entries and set the cursor to the
    // entry at index `limit` (the first not-returned), the next page
    // would start from that entry's PARENT — dropping that entry
    // entirely. Setting the cursor to `all[limit-1]` (last returned)
    // makes `${cursor}~1` start exactly at `all[limit]`, the first
    // not-yet-paginated commit. No commits dropped.
    const entries = all.slice(0, limit)
    const cursorEntry = entries[entries.length - 1]
    const cursor = cursorEntry !== undefined ? cursorEntry.sha : null
    return { entries, next_cursor: cursor }
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
      `${sha}:${relPath}`,
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
      `${target_sha}:${relPath}`,
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
    if (!(await this.isGitAvailable())) {
      throw new VersioningUnavailableError('git binary not available')
    }
    assertShaShape(from)
    if (to !== 'head') assertShaShape(to)
    const ready = await this.ensureInit(project_id)
    if (!ready) {
      throw new VersionNotFoundError(`no version store for project=${project_id}`)
    }
    const args = this.workArgs(project_id).concat([
      'diff',
      '--unified=3',
      '--no-color',
    ])
    if (to === 'head') {
      args.push(from)
    } else {
      args.push(`${from}..${to}`)
    }
    args.push('--', relPath)
    let stdout: string
    try {
      const result = await this.gitExec(args, {
        allowNonZero: true,
        cwd: this.workTree(project_id),
      })
      stdout = result.stdout
    } catch (err) {
      throw new VersionNotFoundError(
        `no diff between ${from}..${to} path=${relPath} (${errMessage(err)})`,
      )
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

  /**
   * Per-project commit mutex. Serializes the entire `add → commit`
   * step so concurrent writes to different paths don't race on
   * `.docs-versions/index`.
   *
   * D4 (refactor plan 2026-07-02): the hand-rolled chained-promise map
   * that used to live here was the MODEL for the generic
   * `gateway/http/keyed-mutex.ts` (see that file's header); this now
   * delegates to the shared implementation. Semantics are identical —
   * per-`project_id` granularity, arrival-order FIFO, release-on-throw,
   * reference-equality map cleanup — pinned by the "D4 — commit lock"
   * tests in `gateway/__tests__/doc-version-store.test.ts`, which were
   * written against (and pass against) the pre-swap implementation.
   */
  private async withCommitLock<T>(
    project_id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.commitMutex.withLock(project_id, fn)
  }

  /** Resolved `.docs-versions/` for a project. */
  private gitDir(project_id: string): string {
    return join(this.resolveProjectRoot(project_id), DOCS_GIT_DIR)
  }

  /** Resolved `docs/` for a project. */
  private workTree(project_id: string): string {
    return join(this.resolveProjectRoot(project_id), DOCS_WORK_TREE_DIR)
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

  private async hasStagedChanges(project_id: string): Promise<boolean> {
    // `git diff --cached --quiet` exits 1 when there are staged
    // changes, 0 when there are none. We use the exit code to drive
    // the boolean; `allowNonZero` lets us read the code without
    // bubbling a throw.
    const args = this.workArgs(project_id).concat([
      'diff',
      '--cached',
      '--quiet',
    ])
    try {
      await this.gitExec(args, { cwd: this.workTree(project_id) })
      return false
    } catch (err) {
      if (isExecChildError(err) && (err.code === 1 || err.code === '1')) {
        return true
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

  /**
   * Repo-corruption recovery. Triggered when an init or commit fails
   * with a `fatal:` shape that doesn't match a known-benign error.
   * Renames the broken `.docs-versions/` aside with a timestamp suffix
   * and lets the next `ensureInit` rebuild from the current working
   * tree. Returns `true` when a rename happened.
   */
  private async tryRecoverCorruption(
    project_id: string,
    err: unknown,
  ): Promise<boolean> {
    const stderr = errStderr(err).toLowerCase()
    const message = errMessage(err).toLowerCase()
    const looksCorrupt =
      stderr.includes('fatal: not a git repository') ||
      stderr.includes('fatal: bad object') ||
      stderr.includes('fatal: invalid object') ||
      stderr.includes('fatal: index file corrupt') ||
      stderr.includes("fatal: couldn't find ref") ||
      stderr.includes('fatal: bad signature') ||
      message.includes('fatal: bad object') ||
      message.includes('fatal: index file corrupt')
    if (!looksCorrupt) return false
    const gitDir = this.gitDir(project_id)
    if (!existsSync(gitDir)) return false
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/Z$/, '')
    const broken = `${gitDir}.broken-${stamp}`
    try {
      await rename(gitDir, broken)
      this.logger('docs.versioning.recovered_from_corruption', {
        project_id,
        broken_dir: broken,
      })
      return true
    } catch (renameErr) {
      this.logger('docs.versioning.recovery_failed', {
        project_id,
        error_message: errMessage(renameErr),
      })
      return false
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
