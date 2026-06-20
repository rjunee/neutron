/**
 * @neutronai/gateway/git — per-project project-level backup store (P7.4 Phase 2).
 *
 * Per docs/plans/P7.4-phase2-project-backup-sprint-brief.md.
 * Phase 2 ships a SECOND, INDEPENDENT git repo per project at
 * `<project>/.project-backup/`, sibling-of-and-independent-of Phase 1's
 * `<project>/.docs-versions/`. Whereas Phase 1 commits per doc edit
 * scoped to `<project>/docs/`, Phase 2 snapshots the WHOLE project tree
 * every 6 hours (driven by `ProjectBackupScheduler`) and optionally
 * pushes to a remote.
 *
 * On-disk layout (per project):
 *
 *   <owner_home>/Projects/<project_id>/
 *   ├── docs/                            ← Phase 1 working tree
 *   ├── .docs-versions/                  ← Phase 1 git dir (excluded)
 *   ├── .project-backup/                 ← THIS module owns the git dir
 *   │   ├── HEAD
 *   │   ├── objects/
 *   │   ├── refs/heads/main
 *   │   ├── index
 *   │   └── .last-attempted.json         ← scheduler sidecar (NOT in working tree)
 *   ├── .gitignore                       ← seeded on init (filters .docs-versions/, node_modules/, etc.)
 *   ├── .project-backup-remote.json      ← OPTIONAL — written by the configure-remote endpoint
 *   ├── .secrets/                        ← (when present) project secrets, encrypted on disk
 *   ├── Cores/                           ← (when present) per-Core SQLite sidecar
 *   ├── README.md / STATUS.md / src/     ← (when present) arbitrary user content
 *   └── ...
 *
 * The working tree IS `<project>/`. Every git invocation passes
 * `--git-dir=<...>/.project-backup` and `--work-tree=<...>/<project>`
 * explicitly so the on-disk git config stays at the defaults.
 *
 * What's INCLUDED (excerpted from brief § 2.5):
 *   - Every user-edited file under `<project>/` not gitignored
 *   - Per-Core SQLite namespaces (`.db` + `.db-wal` + `.db-shm`)
 *   - Encrypted per-project secrets at `<project>/.secrets/`
 *   - Arbitrary user content (markdown, src/, binaries — for v1 no LFS)
 *
 * What's EXCLUDED (per the brief-pinned `.gitignore` block):
 *   - `.docs-versions/` (Phase 1's repo — backing it up would double doc storage)
 *   - `.project-backup/` (this repo's own metadata)
 *   - `node_modules/`, build outputs, IDE config, logs
 *   - The `.project-backup-remote.json` (per-project remote config — local-only)
 *
 * NOT backed up:
 *   - `<owner_home>/.neutron-aes-key` (lives outside the project tree; key-loss-on-restore is the user's problem).
 *
 * Snapshot pipeline (per brief § 2.6):
 *   1. ensureInit — idempotent (create dir, set config, write .gitignore, take baseline commit).
 *   2. `git add -A` — stage everything that's changed under the working tree.
 *   3. `git diff --cached --quiet` — exits 1 iff staged changes exist.
 *   4. When changed: `git commit -m "backup: <iso>"`; record SHA.
 *   5. When a `ProjectBackupRemoteConfig` exists: `git push origin main` over the per-project SSH key.
 *   6. Persist status to a sidecar JSON used by the admin /status route.
 *
 * Failure semantics (per brief § 2.8):
 *   - No transient retry inside `backupNow`. The 6-hour scheduler IS the retry.
 *   - Push failure is classified `auth | branch_protection | remote_not_empty | transient | unknown`.
 *   - Auth + branch_protection + remote_not_empty are surfaced as "user action needed".
 *
 * Concurrency (per brief § 2.9):
 *   - Per-project mutex serializes `backupNow(project_id)` across the
 *     scheduler tick AND the `/run-now` HTTP endpoint. Two callers in
 *     the same wall-clock second share one result; no double commit.
 *
 * Forbidden patterns (do NOT implement here):
 *   - Per-keystroke commit cadence (that's Phase 1's `DocVersionStore`).
 *   - Backing up the per-instance AES key.
 *   - Backing up `.docs-versions/` content.
 *   - Force-push or history rewrite (`+main`, `--force`).
 *   - Fetch / pull from the remote (push-only).
 *   - Branch / merge / multi-remote.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type {
  PlatformAdapter,
  ProjectBackupRemoteConfig,
} from '../../runtime/platform-adapter.ts'

const execFileAsync = promisify(execFile)

/**
 * Hard timeout per `git` invocation for non-push ops. Push gets a
 * longer ceiling — see `PUSH_TIMEOUT_MS`. A healthy commit on a small
 * repo runs in <100 ms; a runaway is most likely a wedge.
 */
const GIT_EXEC_TIMEOUT_MS = 30_000

/**
 * Push timeout — project backups can be larger than per-edit doc
 * commits (binaries, Cores SQLite). Brief § 2.7 pins 5 minutes.
 */
const PUSH_TIMEOUT_MS = 300_000

/** Sigil dir inside the project that owns the backup git repo. */
const BACKUP_GIT_DIR = '.project-backup'

/** Per-project remote config filename (sibling of .project-backup/). */
const REMOTE_CONFIG_FILENAME = '.project-backup-remote.json'

/** Scheduler sidecar — last-attempted-at timestamp. Stored INSIDE
 *  `.project-backup/` so it is NOT itself backed up. */
const LAST_ATTEMPTED_FILENAME = '.last-attempted.json'

/** Status sidecar — last backup result. Also stored INSIDE `.project-backup/`. */
const STATUS_FILENAME = '.last-status.json'

/**
 * Brief-pinned `.gitignore` body (committed at `<project>/.gitignore`
 * on first init). Forge: do not editorialize — the brief § 2.4 fixes
 * this verbatim.
 */
export const PROJECT_BACKUP_GITIGNORE = `# P7.4 Phase 2 project-backup. Snapshot is taken every 6 hours and pushed
# to an optional remote. The two git dirs (.docs-versions for the doc
# editor's per-edit history; .project-backup for THIS repo) are excluded
# so neither repo ever sees the other's metadata.

# Other git repos under this tree
.docs-versions/
.project-backup/
.git/

# Per-project remote config (local-only — has SSH key path inside)
.project-backup-remote.json

# Build artifacts / caches
node_modules/
.next/
dist/
build/
.cache/
.parcel-cache/
.turbo/
target/
.gradle/
.mvn/
.idea/
.vscode/
.DS_Store
Thumbs.db
*.tmp
*.bak
*.swp
*.swo

# Logs (project content lives in markdown / SQLite, not logs)
*.log
*.log.*

# Backup safety: never commit a runaway core dump or large blob
*.core
core.[0-9]*
`

/**
 * Structured-log sink. Defaults to `console.warn` so the gateway's
 * unified log capture picks it up; tests inject a custom sink to
 * assert specific events landed.
 */
export type ProjectBackupLogger = (
  event: string,
  fields: Record<string, unknown>,
) => void

const DEFAULT_LOGGER: ProjectBackupLogger = (event, fields) => {
  try {
    console.warn(`[project-backup] ${event} ${JSON.stringify(fields)}`)
  } catch {
    console.warn(`[project-backup] ${event}`)
  }
}

export interface ProjectBackupStoreOptions {
  /** Platform adapter — used to read per-project remote config + the
   *  `project_backup` capability flag + the Managed lazy-provisioning
   *  hook. */
  platform: PlatformAdapter
  /** Absolute path to the per-instance `<owner_home>` dir. */
  owner_home: string
  /** Instance slug — used to build the synthetic per-instance git identity. */
  project_slug: string
  /**
   * Override how the per-project root is resolved. Production uses
   * `<owner_home>/Projects/<project_id>`; tests can swap to a fixed
   * dir.
   */
  resolveProjectRoot?: (project_id: string) => string
  /** Structured-log sink. */
  logger?: ProjectBackupLogger
  /** Now-fn override for tests. */
  now?: () => number
  /** Override the `git` binary. */
  gitBinary?: string
}

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

/** Result of a successful restore op. The recovery commit lands in the
 *  project's `.project-backup/` history; the working tree is updated to
 *  match `snapshot_sha` (whole-project) or has a single file replaced
 *  (single-file). */
export interface RestoreResult {
  /** SHA of the snapshot the restore pulled from. */
  snapshot_sha: string
  /** Previous HEAD SHA (recorded in the recovery commit message). */
  prior_head_sha: string
  /** SHA of the new recovery commit. */
  recovery_commit_sha: string
  /** Path that was restored, or null when the restore covered the
   *  whole project. */
  file_path: string | null
  /** Wall-clock ms when the recovery commit landed. */
  completed_at_ms: number
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

/** Failure taxonomy for a push attempt (brief § 2.8). */
export type PushFailureKind =
  | 'auth'
  | 'branch_protection'
  | 'remote_not_empty'
  | 'transient'
  | 'unknown'

export interface PushError {
  code: PushFailureKind
  message: string
}

export interface BackupResult {
  ok: boolean
  /** sha of the snapshot commit, or null if nothing changed since the last commit. */
  commit_sha: string | null
  /** True iff a remote was configured AND the push succeeded. */
  pushed: boolean
  /** Populated when a push was attempted and failed. */
  push_error: PushError | null
  /** Wall-clock ms when this backup completed (success or partial). */
  completed_at_ms: number
}

/** Per-project backup state surface returned by `getStatus`. */
export interface ProjectBackupStatus {
  /**
   * `not_configured` — the backup substrate is unavailable (git binary
   *   missing).
   * `configured` — the local backup repo exists; no successful backup
   *   has landed yet.
   * `backing_up` — a backup is currently in-flight.
   * `ok` — last backup succeeded.
   * `error` — last backup or push failed.
   */
  state: 'not_configured' | 'configured' | 'backing_up' | 'ok' | 'error'
  last_backup_at: string | null
  last_check_at: string | null
  last_commit_sha: string | null
  last_push_at: string | null
  last_push_error: PushError | null
  remote_url: string | null
  is_managed_remote: boolean
  next_scheduled_at: string | null
}

interface PersistedStatus {
  last_backup_at_ms: number | null
  last_check_at_ms: number | null
  last_commit_sha: string | null
  last_push_at_ms: number | null
  last_push_error: PushError | null
  last_op_ok: boolean
}

const EMPTY_PERSISTED_STATUS: PersistedStatus = {
  last_backup_at_ms: null,
  last_check_at_ms: null,
  last_commit_sha: null,
  last_push_at_ms: null,
  last_push_error: null,
  last_op_ok: true,
}

/**
 * Per-project project-level backup store. One instance per gateway;
 * every project gets its own `.project-backup/` lazily on first
 * `backupNow`.
 */
export class ProjectBackupStore {
  private readonly platform: PlatformAdapter
  private readonly owner_home: string
  private readonly project_slug: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly logger: ProjectBackupLogger
  private readonly nowFn: () => number
  private readonly gitBinary: string

  /** Cached `git --version` probe. */
  private gitAvailableProbe: Promise<boolean> | null = null

  /** Per-project init guard so concurrent first-backups share one init. */
  private readonly initLocks = new Map<string, Promise<void>>()

  /** Per-project in-flight `backupNow` mutex — shares result across
   *  concurrent callers (scheduler tick + run-now HTTP). */
  private readonly inFlight = new Map<string, Promise<BackupResult>>()

  /** Per-project in-flight `restore` mutex — separate from `inFlight`
   *  so concurrent backupNow callers never receive a RestoreResult by
   *  accident (Argus r1 IMPORTANT — the previous cast-and-share pattern
   *  returned the wrong shape to backup callers, and worse, would
   *  deadlock the implicit backupNow we now fire before each restore).
   */
  private readonly inFlightRestore = new Map<string, Promise<RestoreResult>>()

  /** Per-project "currently backing up" flag for status surface. */
  private readonly backingUp = new Set<string>()

  /** Cached `nextScheduledAt` per project, set by the scheduler. */
  private readonly nextScheduled = new Map<string, number>()

  constructor(opts: ProjectBackupStoreOptions) {
    this.platform = opts.platform
    this.owner_home = opts.owner_home
    this.project_slug = opts.project_slug
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.logger = opts.logger ?? DEFAULT_LOGGER
    this.nowFn = opts.now ?? ((): number => Date.now())
    this.gitBinary = opts.gitBinary ?? 'git'
  }

  /** Probe + cache `git --version`. False = degraded (no backup). */
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
      this.logger('unavailable', {
        reason: 'git_not_found',
        git_binary: this.gitBinary,
      })
      return false
    }
  }

  /**
   * Idempotent first-init for a project. Safe to call concurrently.
   * Creates `.project-backup/`, writes the brief-pinned `.gitignore`
   * at `<project>/.gitignore` (only if absent — Phase 1's gitignore
   * lives at `<project>/docs/.gitignore` so the two don't collide),
   * and takes a baseline commit.
   */
  async ensureInit(project_id: string): Promise<boolean> {
    if (!(await this.isGitAvailable())) return false
    if (!existsSync(this.resolveProjectRoot(project_id))) return false
    const existing = this.initLocks.get(project_id)
    if (existing !== undefined) {
      await existing
      return existsSync(join(this.gitDir(project_id), 'HEAD'))
    }
    const run = (async (): Promise<void> => {
      try {
        await this.doEnsureInit(project_id)
      } catch (err) {
        this.logger('init_failed', {
          project_id,
          error_message: errMessage(err),
        })
        if (await this.tryRecoverCorruption(project_id, err)) {
          try {
            await this.doEnsureInit(project_id)
          } catch (err2) {
            this.logger('init_failed_after_recovery', {
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
    await mkdir(gitDir, { recursive: true })
    // Same bare-init-then-flip dance Phase 1 uses; see
    // `doc-version-store.ts:doEnsureInit` for the rationale.
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
        'Neutron Backup',
      ]),
    )
    await this.gitExec(
      this.gitDirArgs(project_id).concat([
        'config',
        'user.email',
        `backup@${this.project_slug}.local`,
      ]),
    )
    await this.gitExec(
      this.gitDirArgs(project_id).concat(['config', 'commit.gpgsign', 'false']),
    )
    await this.gitExec(
      this.gitDirArgs(project_id).concat(['config', 'gc.auto', '0']),
    )
    // Seed the brief-pinned `.gitignore` at the project root. Per
    // brief § 2.4 the body is verbatim — re-writing it is idempotent
    // (same bytes) AND self-healing: if a user (or rogue tooling)
    // edits it, the next backup tick rewrites it to spec. See
    // `seedGitignore` for the rewrite contract; `backupNow` also
    // calls it on every snapshot so already-initialized projects
    // converge to the canonical body.
    await this.seedGitignore(project_id)
    // Baseline commit captures whatever's already in the tree (docs/
    // content, README.md, etc.) so the first scheduled backup of an
    // unchanged tree doesn't produce a phantom "everything is new"
    // commit. Without this, a project that's been on disk for a year
    // would, at hour-0, produce a single huge "import" commit; we
    // want that import to be tagged "init" rather than "backup".
    await this.gitExec(this.workArgs(project_id).concat(['add', '-A']), {
      cwd: workTree,
    })
    await this.gitExec(
      this.workArgs(project_id).concat([
        'commit',
        '--allow-empty',
        '-m',
        `init: project-backup ${new Date(this.nowFn()).toISOString()}`,
      ]),
      { cwd: workTree },
    )
  }

  /**
   * Write the brief-pinned `.gitignore` body to `<project>/.gitignore`,
   * unconditionally overwriting whatever is there. Same bytes every
   * call so concurrent invocations cannot race in any meaningful way,
   * and an unchanged file produces no working-tree dirt for the next
   * `git add -A`. Argus r1 MINOR #6: the previous "if missing, write"
   * gate let user edits drift from spec forever.
   */
  private async seedGitignore(project_id: string): Promise<void> {
    const gitignorePath = join(this.workTree(project_id), '.gitignore')
    await writeFile(gitignorePath, PROJECT_BACKUP_GITIGNORE, 'utf8')
  }

  /**
   * Snapshot the whole project tree → commit (if changed) → push
   * (if remote configured). Used by the scheduler AND the run-now HTTP
   * endpoint. Per brief § 2.9: concurrent callers share the in-flight
   * promise, so two callers in the same wall-clock second get ONE
   * snapshot.
   */
  async backupNow(project_id: string): Promise<BackupResult> {
    const existing = this.inFlight.get(project_id)
    if (existing !== undefined) return existing
    // Argus r2 NEW BLOCKER — also serialize against an in-flight
    // restore. r2's map split correctly isolated backup vs restore
    // result shapes but left `backupNow` walking past `inFlightRestore`
    // entirely. Between restore()'s implicit pre-restore backupNow
    // clearing `inFlight` (line ~1374) and the recovery commit landing
    // (~line 1471), a scheduler tick / run-now HTTP would:
    //   (a) race on `.project-backup/index.lock` (visible as
    //       stage_failed / commit_failed; recovery commit may not land)
    //   (b) land a backup commit of the partial-restore tree, leaving
    //       the recovery commit parented on that racing commit instead
    //       of `prior_head_sha` — breaking the append-only undo-banner
    //       semantics (the banner's "walk back to prior_head" would
    //       jump two commits, not one).
    //
    // SAFE WITH THE IMPLICIT PRE-RESTORE backupNow: restore()'s IIFE
    // calls `await this.backupNow(...)` BEFORE the outer
    // `this.inFlightRestore.set(project_id, op)` runs (the IIFE yields
    // on the implicit backupNow's first await, and the set runs
    // synchronously after that yield) — so this check observes
    // `undefined` for the implicit call. No self-deadlock.
    // Loop pattern (not a single await) — with ISSUE #46's restore()
    // fix in place, multiple restores can legitimately stack up on
    // `inFlightRestore`. A single await would let backupNow slip
    // through between two queued restore ops and race their working
    // tree / index. Re-reading the map after each await drains the
    // entire queue before backupNow proceeds. ISSUE #46.
    let restoreInflight: Promise<RestoreResult> | undefined
    const sawRestoreInflight = this.inFlightRestore.get(project_id) !== undefined
    while (
      (restoreInflight = this.inFlightRestore.get(project_id)) !== undefined
    ) {
      try {
        await restoreInflight
      } catch {
        /* prior restore failure is its caller's problem */
      }
    }
    // Preserves the r2 coalesce: if we yielded at all (i.e. there was
    // at least one restore to wait on), another concurrent backupNow
    // may have already raced ahead, passed THIS check, and set
    // `inFlight`. Coalesce so two `doBackupNow` runs don't race on
    // `index.lock` themselves.
    if (sawRestoreInflight) {
      const racer = this.inFlight.get(project_id)
      if (racer !== undefined) return racer
    }
    const run = this.doBackupNow(project_id)
    this.inFlight.set(project_id, run)
    try {
      return await run
    } finally {
      this.inFlight.delete(project_id)
    }
  }

  private async doBackupNow(project_id: string): Promise<BackupResult> {
    const completed_at_ms = (): number => this.nowFn()
    if (!(await this.isGitAvailable())) {
      const err: PushError = {
        code: 'unknown',
        message: 'git binary not available',
      }
      const result: BackupResult = {
        ok: false,
        commit_sha: null,
        pushed: false,
        push_error: err,
        completed_at_ms: completed_at_ms(),
      }
      return result
    }
    this.backingUp.add(project_id)
    try {
      await this.ensureInit(project_id)
      if (!existsSync(join(this.gitDir(project_id), 'HEAD'))) {
        // Init never completed (deferred because project dir didn't
        // exist OR a corruption-recovery loop bailed). Surface as
        // not-ok with a clear error code.
        return {
          ok: false,
          commit_sha: null,
          pushed: false,
          push_error: { code: 'unknown', message: 'backup repo init failed' },
          completed_at_ms: completed_at_ms(),
        }
      }
      const workTree = this.workTree(project_id)
      // Re-seed the brief-pinned `.gitignore` BEFORE staging so a
      // user-edited file is reset to spec on every snapshot. The
      // write is idempotent (canonical bytes) so when the file is
      // already correct the working tree stays clean — `git add -A`
      // below sees nothing-to-stage. Argus r1 MINOR #6: previous
      // wiring only seeded on first init, which let user edits
      // diverge from the brief forever.
      try {
        await this.seedGitignore(project_id)
      } catch (err) {
        this.logger('gitignore_seed_failed', {
          project_id,
          error_message: errMessage(err),
        })
        // Non-fatal — fall through and let the snapshot run anyway.
      }
      // 1. Stage everything.
      try {
        await this.gitExec(this.workArgs(project_id).concat(['add', '-A']), {
          cwd: workTree,
        })
      } catch (err) {
        this.logger('stage_failed', {
          project_id,
          error_message: errMessage(err),
        })
        // Recover from corruption mid-stage if possible.
        await this.tryRecoverCorruption(project_id, err)
        return {
          ok: false,
          commit_sha: null,
          pushed: false,
          push_error: { code: 'unknown', message: errMessage(err) },
          completed_at_ms: completed_at_ms(),
        }
      }
      // 2. Detect staged changes via `diff --cached --quiet`.
      let commit_sha: string | null = null
      const hasChanges = await this.hasStagedChanges(project_id)
      if (hasChanges) {
        const msg = `backup: ${new Date(this.nowFn()).toISOString()}`
        try {
          await this.gitExec(
            this.workArgs(project_id).concat(['commit', '-m', msg]),
            { cwd: workTree },
          )
          const head = await this.gitExec(
            this.gitDirArgs(project_id).concat(['rev-parse', 'HEAD']),
          )
          commit_sha = head.stdout.trim()
        } catch (err) {
          this.logger('commit_failed', {
            project_id,
            error_message: errMessage(err),
          })
          // Unstage and report — write always wins, but the backup
          // commit was lost; next 6h tick re-stages cleanly.
          try {
            await this.gitExec(
              this.workArgs(project_id).concat(['reset']),
              { cwd: workTree },
            )
          } catch {
            /* swallow */
          }
          await this.recordBackupResult(project_id, {
            ok: false,
            commit_sha: null,
            pushed: false,
            push_error: { code: 'unknown', message: errMessage(err) },
            completed_at_ms: completed_at_ms(),
          })
          return {
            ok: false,
            commit_sha: null,
            pushed: false,
            push_error: { code: 'unknown', message: errMessage(err) },
            completed_at_ms: completed_at_ms(),
          }
        }
      }
      // 3. Optional push.
      let pushed = false
      let push_error: PushError | null = null
      let last_push_at_ms: number | null = null
      let remote = await this.platform.getProjectBackupRemoteConfig(project_id)
      // 3.a. Managed: lazy-provision a remote at first backup if the
      // adapter advertises `project_backup` and no remote exists yet.
      const tryAutoProvision =
        remote === null &&
        this.platform.capabilities.project_backup === true &&
        this.platform.autoProvisionProjectBackupRemote !== undefined
      if (tryAutoProvision) {
        try {
          remote = await this.platform.autoProvisionProjectBackupRemote!(
            project_id,
          )
        } catch (err) {
          this.logger('auto_provision_failed', {
            project_id,
            error_message: errMessage(err),
          })
          // Treat provisioning failure as a push failure so the
          // status surface can show "remote not yet available".
          push_error = { code: 'transient', message: errMessage(err) }
        }
      }
      if (remote !== null) {
        const pushResult = await this.doPush(project_id, remote)
        pushed = pushResult.ok
        if (!pushResult.ok) {
          push_error = pushResult.error
        } else {
          last_push_at_ms = this.nowFn()
        }
      }
      const ok = push_error === null || push_error.code === 'transient'
        ? commit_sha !== null || !hasChanges
        : false
      // Even when push failed, the commit lives in the local repo
      // (per brief § 8.1 "Push failure does not lose the local commit").
      // `ok` for the BackupResult reflects "did SOMETHING useful land":
      // a clean tree (commit_sha null) with no push error is ok=true;
      // a commit that landed locally even if push failed is ok=false
      // (the admin UI is told to surface the error so the user can
      // act). The completed_at_ms IS populated in both cases.
      const result: BackupResult = {
        ok: ok && push_error === null,
        commit_sha,
        pushed,
        push_error,
        completed_at_ms: completed_at_ms(),
      }
      await this.recordBackupResult(project_id, result, {
        last_push_at_ms,
      })
      return result
    } finally {
      this.backingUp.delete(project_id)
    }
  }

  /**
   * Push pipeline (brief § 2.7) — sets `origin` idempotently, builds
   * the `GIT_SSH_COMMAND` from the per-project key, runs
   * `git push origin main` with a 5 min cap. Auth / branch-protection /
   * remote-not-empty / transient classification per brief § 2.8.
   */
  private async doPush(
    project_id: string,
    remote: ProjectBackupRemoteConfig,
  ): Promise<{ ok: true } | { ok: false; error: PushError }> {
    try {
      await this.ensureRemote(project_id, remote.remote_url)
    } catch (err) {
      return {
        ok: false,
        error: { code: 'unknown', message: errMessage(err) },
      }
    }
    const env = {
      ...process.env,
      // Quoting the path: SSH does NOT shell-eval the value the way
      // a CLI invocation would, but a path with spaces would break
      // an unquoted IdentityFile line. `ssh -i` accepts a single
      // argv element so we don't need quoting if we hand argv to ssh
      // via OpenSSH's own parser — but here we're handing `ssh ...`
      // to git as a string that git re-parses (via /bin/sh -c style),
      // so quoting protects against spaces in the key path.
      GIT_SSH_COMMAND: `ssh -i ${shellQuote(remote.ssh_key_path)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o BatchMode=yes`,
      GIT_TERMINAL_PROMPT: '0',
    }
    try {
      await execFileAsync(
        this.gitBinary,
        this.gitDirArgs(project_id).concat(['push', 'origin', 'main']),
        {
          timeout: PUSH_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env,
        },
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, error: classifyPushFailure(err) }
    }
  }

  /** Idempotent `git remote set-url`/`git remote add origin`. */
  private async ensureRemote(
    project_id: string,
    remote_url: string,
  ): Promise<void> {
    try {
      await this.gitExec(
        this.gitDirArgs(project_id).concat([
          'remote',
          'set-url',
          'origin',
          remote_url,
        ]),
      )
    } catch {
      // `set-url` fails when no remote exists yet; `add` is the
      // create-or-fail path. Either way, the loop converges.
      await this.gitExec(
        this.gitDirArgs(project_id).concat([
          'remote',
          'add',
          'origin',
          remote_url,
        ]),
      )
    }
  }

  /** Read the persisted backup status for the admin /status route. */
  async getStatus(project_id: string): Promise<ProjectBackupStatus> {
    const remote = await this.platform.getProjectBackupRemoteConfig(project_id)
    const persisted = await this.readPersistedStatus(project_id)
    const ready =
      (await this.isGitAvailable()) &&
      existsSync(join(this.gitDir(project_id), 'HEAD'))
    const state: ProjectBackupStatus['state'] = !ready
      ? 'not_configured'
      : this.backingUp.has(project_id)
        ? 'backing_up'
        : persisted.last_push_error !== null && !isUserResolvableTransient(persisted.last_push_error.code)
          ? 'error'
          : persisted.last_op_ok && persisted.last_backup_at_ms !== null
            ? 'ok'
            : persisted.last_push_error !== null
              ? 'error'
              : persisted.last_backup_at_ms !== null
                ? 'ok'
                : 'configured'
    const next = this.nextScheduled.get(project_id) ?? null
    return {
      state,
      last_backup_at: tsToIso(persisted.last_backup_at_ms),
      last_check_at: tsToIso(persisted.last_check_at_ms),
      last_commit_sha: persisted.last_commit_sha,
      last_push_at: tsToIso(persisted.last_push_at_ms),
      last_push_error: persisted.last_push_error,
      remote_url: remote === null ? null : remote.remote_url,
      is_managed_remote: remote !== null && remote.source === 'managed_provisioned',
      next_scheduled_at: tsToIso(next),
    }
  }

  /**
   * Read the persisted last-attempted-at sidecar for the scheduler.
   * Returns `null` when nothing has been attempted yet.
   */
  async readLastAttemptedAt(project_id: string): Promise<number | null> {
    const path = join(this.gitDir(project_id), LAST_ATTEMPTED_FILENAME)
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as { last_attempted_at_ms?: number }
      if (typeof parsed.last_attempted_at_ms === 'number') {
        return parsed.last_attempted_at_ms
      }
      return null
    } catch {
      return null
    }
  }

  /** Persist the last-attempted-at sidecar (atomic via tmp+rename). */
  async writeLastAttemptedAt(
    project_id: string,
    at_ms: number,
  ): Promise<void> {
    const dir = this.gitDir(project_id)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const path = join(dir, LAST_ATTEMPTED_FILENAME)
    const tmp = `${path}.tmp`
    const body = JSON.stringify({ last_attempted_at_ms: at_ms }, null, 2) + '\n'
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
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
  async listSnapshots(
    project_id: string,
    opts: { limit?: number; before_sha?: string } = {},
  ): Promise<{ snapshots: SnapshotSummary[]; next_cursor: string | null }> {
    if (!(await this.isGitAvailable())) {
      throw new RestoreUnavailableError('git binary not available')
    }
    if (!existsSync(join(this.gitDir(project_id), 'HEAD'))) {
      return { snapshots: [], next_cursor: null }
    }
    const limit = clampSnapshotLimit(opts.limit)
    const args = this.gitDirArgs(project_id).concat([
      'log',
      '--no-color',
      `--pretty=format:%H%x00%P%x00%aI%x00%s`,
      `--max-count=${limit + 1}`,
    ])
    if (opts.before_sha !== undefined) {
      assertSnapshotSha(opts.before_sha)
      args.push(`${opts.before_sha}~1`)
    }
    const { stdout } = await this.gitExec(args, { allowNonZero: true })
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
    const shortstats = await this.fetchShortstats(
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
  private async fetchShortstats(
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
          const { stdout } = await this.gitExec(
            this.gitDirArgs(project_id).concat([
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
  async previewSnapshot(
    project_id: string,
    sha: string,
  ): Promise<SnapshotPreview> {
    if (!(await this.isGitAvailable())) {
      throw new RestoreUnavailableError('git binary not available')
    }
    assertSnapshotSha(sha)
    if (!existsSync(join(this.gitDir(project_id), 'HEAD'))) {
      throw new SnapshotNotFoundError(
        `no backup repo for project=${project_id}`,
      )
    }
    await this.assertSnapshotExists(project_id, sha)
    const meta = await this.readSnapshotMeta(project_id, sha)
    // `diff --name-status HEAD..sha` returns the per-path change
    // status — A / M / D / R<NN> / C<NN>. We collapse renames into
    // (deleted-source, added-target) for v1; restoring a rename is
    // legal but the UI doesn't need to render the source+target pair
    // as one row to ship the v1 surface.
    const { stdout } = await this.gitExec(
      this.gitDirArgs(project_id).concat([
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
    const sized = await this.fetchSnapshotFileSizes(project_id, sha, files)
    return {
      sha,
      parent_sha: meta.parent_sha,
      message: meta.message,
      author_date: meta.author_date,
      files: sized,
    }
  }

  private async fetchSnapshotFileSizes(
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
          const { stdout } = await this.gitExec(
            this.gitDirArgs(project_id).concat([
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
  async getSnapshotFileContent(
    project_id: string,
    sha: string,
    relPath: string,
  ): Promise<SnapshotFileContent> {
    if (!(await this.isGitAvailable())) {
      throw new RestoreUnavailableError('git binary not available')
    }
    assertSnapshotSha(sha)
    assertSnapshotPath(relPath)
    if (!existsSync(join(this.gitDir(project_id), 'HEAD'))) {
      throw new SnapshotNotFoundError(`no backup repo for project=${project_id}`)
    }
    await this.assertSnapshotExists(project_id, sha)
    let stdout: string
    try {
      const result = await this.gitExec(
        this.gitDirArgs(project_id).concat([
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
  async getSnapshotFileDiff(
    project_id: string,
    sha: string,
    relPath: string,
  ): Promise<SnapshotFileDiff> {
    if (!(await this.isGitAvailable())) {
      throw new RestoreUnavailableError('git binary not available')
    }
    assertSnapshotSha(sha)
    assertSnapshotPath(relPath)
    if (!existsSync(join(this.gitDir(project_id), 'HEAD'))) {
      throw new SnapshotNotFoundError(`no backup repo for project=${project_id}`)
    }
    await this.assertSnapshotExists(project_id, sha)
    const { stdout } = await this.gitExec(
      this.gitDirArgs(project_id).concat([
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

  /**
   * Restore the project tree to `snapshot_sha`. Two granularities,
   * gated on `file_path`:
   *
   *   - `file_path === null` (whole-project): the working tree is
   *     reset to the snapshot's tree, then a NEW commit lands on top
   *     referencing both the prior HEAD SHA and the snapshot SHA. The
   *     git history is APPEND-ONLY — no rebase / no rewrite — so the
   *     prior HEAD remains reachable and a user who picked the wrong
   *     snapshot can restore-from-the-restore-commit.
   *
   *   - `file_path === '<rel>'` (single-file): only the named path is
   *     touched. `git checkout snapshot_sha -- <path>` swaps that one
   *     blob into the working tree; a follow-up `git add -A && git
   *     commit` lands the recovery commit. Same append-only semantics.
   *
   * Path safety: `assertSnapshotPath` runs on `file_path` before any
   * filesystem syscall.
   *
   * Concurrency: serializes against both the scheduler's `backupNow`
   * (via the shared per-project `inFlight` map) AND any concurrent
   * restore (via the separate `inFlightRestore` map). The two maps
   * are intentionally distinct so a backupNow caller running in
   * parallel with this restore receives a `BackupResult`, not a
   * `RestoreResult` (Argus r1 IMPORTANT — the previous cast pattern
   * returned the wrong shape).
   *
   * Pre-restore implicit snapshot: before any destructive op, this
   * method fires `backupNow(project_id)` to land a snapshot of the
   * live (potentially dirty) working tree (Argus r1 BLOCKER #2).
   * Without that snapshot, `git rev-parse HEAD` (used to set
   * `prior_head_sha`) would point at the LAST BACKED-UP commit and
   * the undo banner would walk back to a stale tree rather than
   * the user's actual pre-restore working state.
   */
  async restore(
    project_id: string,
    snapshot_sha: string,
    file_path: string | null,
  ): Promise<RestoreResult> {
    if (!(await this.isGitAvailable())) {
      throw new RestoreUnavailableError('git binary not available')
    }
    assertSnapshotSha(snapshot_sha)
    if (file_path !== null) {
      assertSnapshotPath(file_path)
    }
    if (!existsSync(join(this.gitDir(project_id), 'HEAD'))) {
      throw new SnapshotNotFoundError(`no backup repo for project=${project_id}`)
    }
    await this.assertSnapshotExists(project_id, snapshot_sha)
    // Argus r3 BLOCKER #1 — the UI's per-row "Restore this file only"
    // button is offered for every diff row in the preview, including
    // rows with status='deleted' (path exists in the live tree / at
    // HEAD but not at the requested snapshot). A naive `cat-file -e`
    // preflight that rejects absent-at-snapshot paths would 404 every
    // single-file restore against a deleted row, which contradicts the
    // UX contract: "restore this file to its state at <snapshot>" —
    // and that state, for a deleted row, IS the file's absence.
    // The probe below classifies presence so the destructive op can
    // either run `checkout sha -- path` (path present at snapshot) or
    // stage a removal (path absent at snapshot) without bailing.
    let snapshotHasPath = true
    if (file_path !== null) {
      try {
        await this.gitExec(
          this.gitDirArgs(project_id).concat([
            'cat-file',
            '-e',
            `${snapshot_sha}:${file_path}`,
          ]),
        )
      } catch {
        snapshotHasPath = false
      }
    }
    // Serialize concurrent restores AND any in-flight backup on the
    // same project, both via the same LOOP that re-reads both maps
    // after every wakeup.
    //
    // ISSUE #46 (PR #307) fixed the inFlightRestore wait: when ≥3
    // restores queue behind one in-flight restore, the 2nd and 3rd
    // waiters resume from the same await simultaneously; without a
    // re-read after every wake both would install their own op into
    // `inFlightRestore` (last one wins) and race the working tree /
    // `.project-backup/index.lock`. The loop forces each waiter to
    // re-check after every wake so only one exits at a time.
    //
    // ISSUE #47 is the same-shape bug at the SECOND await site (the
    // wait against `inFlight`, the BACKUP mutex). A scheduler tick
    // (`project-backup-scheduler.ts` 6h cron) or admin `/run-now`
    // call sets `inFlight` without ever touching `inFlightRestore`,
    // so 2+ concurrent restores past the inFlightRestore loop above
    // would both fall through a single `await inflight` and race the
    // backup's destructive index-stage on the working tree. The fix
    // is the same shape: combine both waits into one loop that
    // re-reads BOTH maps after every wake. JS single-threadedness +
    // microtask FIFO guarantees only one waiter exits at a time and
    // installs the next restore op (synchronously, at line 1619).
    //
    // The implicit pre-restore backupNow at line ~1429 is SAFE — but
    // the temporal proof is subtle, so spelling it out:
    //
    //   (a) `op = (async () => { ... await this.backupNow ... })()` —
    //       the IIFE BEGINS executing synchronously on construction
    //       (ES spec: async function bodies run sync until the first
    //       `await`). So the IIFE's sync prefix runs FIRST, INCLUDING
    //       backupNow's own sync prefix.
    //   (b) backupNow's sync prefix (line 605-637) reads `inFlight`
    //       (undefined here — the combined loop above just confirmed
    //       both maps were empty before we got here) and then its own
    //       loop reads `inFlightRestore` (still undefined — `set` at
    //       line 1619 hasn't run yet, we're still inside the
    //       synchronous tail of the IIFE-construction expression).
    //       The loop exits cleanly; backupNow installs its `inFlight`
    //       entry, awaits `doBackupNow`, yields.
    //   (c) NOW the IIFE has yielded (at its `await this.backupNow`).
    //       Control returns to the caller. Line 1619
    //       `inFlightRestore.set(project_id, op)` runs.
    //
    // No self-deadlock: backupNow's loop check at (b) runs BEFORE
    // `inFlightRestore.set` at (c), so it cannot observe THIS
    // restore's own op. A concurrent unrelated restore arriving while
    // our IIFE is yielded WOULD see our op (correct cross-serialise
    // direction — that restore's outer combined loop would await us).
    while (true) {
      const r = this.inFlightRestore.get(project_id)
      const b = this.inFlight.get(project_id)
      if (r === undefined && b === undefined) break
      try {
        await (r ?? b)
      } catch {
        /* prior op's failure is its own caller's problem */
      }
    }
    const op = (async (): Promise<RestoreResult> => {
      const workTree = this.workTree(project_id)
      // Argus r1 BLOCKER #2 — capture the LIVE working tree before any
      // destructive op. Between 6h backup ticks the working tree carries
      // uncommitted user edits; `git rev-parse HEAD` points at the last
      // BACKED-UP commit, not the live state. Without this implicit
      // snapshot the destructive ops below (read-tree / clean for whole-
      // project, `checkout sha -- path` for single-file) would overwrite
      // those edits and the undo banner's `prior_head_sha` would walk
      // back to the stale snapshot rather than the user's actual
      // pre-restore tree. After `backupNow` lands, HEAD references a
      // commit that contains the live tree — so the recovery commit's
      // `prior_head_sha` (read below) captures the user's work as a
      // reachable git object, recoverable via the undo banner.
      //
      // `backupNow` is a no-op (returns `commit_sha: null`) when the
      // tree is clean, so the only on-disk cost when the user has
      // nothing dirty is one `git add -A` + `git diff --cached --quiet`
      // probe. Uses the (now-separate) `inFlight` backup mutex; the
      // restore's own `inFlightRestore` entry keeps a second restore
      // from racing.
      try {
        await this.backupNow(project_id)
      } catch (err) {
        // A backup failure is loud but not fatal — proceed with the
        // restore using HEAD-as-prior-head and document the gap. The
        // alternative (abort restore on backup failure) would leave
        // the user unable to recover from a corrupt working tree.
        this.logger('restore_pre_snapshot_failed', {
          project_id,
          error_message: errMessage(err),
        })
      }
      const priorHead = await this.gitExec(
        this.gitDirArgs(project_id).concat(['rev-parse', 'HEAD']),
      )
      const prior_head_sha = priorHead.stdout.trim()
      // Argus r3 BLOCKER #1 — the outer `snapshotHasPath` probe says
      // the path is absent at the requested snapshot. That's a valid
      // restore request ONLY if the path actually exists somewhere in
      // the live tree / at HEAD — otherwise "restore <path> to its
      // state at <sha>" is a request to remove a path that is already
      // absent everywhere, which is nonsense and must surface as 404.
      // The HEAD probe happens INSIDE the IIFE (rather than alongside
      // the outer cat-file probe) because the implicit pre-restore
      // backupNow may have advanced HEAD: a file the user created
      // between 6h ticks now lives at the post-backupNow HEAD even
      // though it was not at the pre-restore HEAD the outer probe
      // could have seen. Probing here uses the freshest possible HEAD.
      if (file_path !== null && !snapshotHasPath) {
        try {
          await this.gitExec(
            this.gitDirArgs(project_id).concat([
              'cat-file',
              '-e',
              `${prior_head_sha}:${file_path}`,
            ]),
          )
        } catch {
          throw new SnapshotPathNotFoundError(
            `path '${file_path}' not found at snapshot ${snapshot_sha}`,
          )
        }
      }
      // Re-seed the brief-pinned `.gitignore` so the restore can't
      // unstick the project's exclusion rules.
      try {
        await this.seedGitignore(project_id)
      } catch {
        /* non-fatal — restore proceeds */
      }
      const completedAt = (): number => this.nowFn()
      if (file_path === null) {
        // Whole-project restore. `git checkout sha -- :/` would copy
        // every path AT THE SNAPSHOT into the working tree, but it
        // would NOT remove paths that exist in the live tree and
        // didn't exist at the snapshot. The two-step pattern below
        // (read-tree + checkout-index + clean) produces exact-match
        // semantics: after it runs, the working tree matches the
        // snapshot's tree byte-for-byte (modulo files that the
        // `.gitignore` filters out, which we leave alone).
        //
        // 1) Update the index to match the snapshot tree.
        await this.gitExec(
          this.workArgs(project_id).concat([
            'read-tree',
            '--reset',
            '-u',
            snapshot_sha,
          ]),
          { cwd: workTree },
        )
        // 2) Remove any non-ignored, non-tracked files left in the
        // working tree (these are files that existed at HEAD but not
        // at the snapshot). `clean -f -d -x` would also wipe ignored
        // files which would nuke node_modules / build outputs the
        // user explicitly excluded — so we run WITHOUT `-x` so the
        // .gitignore body keeps everything it normally protects.
        await this.gitExec(
          this.workArgs(project_id).concat(['clean', '-f', '-d']),
          { cwd: workTree },
        )
      } else if (snapshotHasPath) {
        // Single-file restore — path present at snapshot. `checkout
        // sha -- <path>` writes the file at `path` from `sha`'s tree
        // into the working tree (replaces or creates as needed). The
        // user's other files stay untouched.
        await this.gitExec(
          this.workArgs(project_id).concat([
            'checkout',
            snapshot_sha,
            '--',
            file_path,
          ]),
          { cwd: workTree },
        )
      } else {
        // Argus r3 BLOCKER #1 — single-file restore against an absent-
        // at-snapshot path (preview row with status='deleted'). The
        // "restore to <snapshot>" semantic for an absent path is "the
        // path doesn't exist at <snapshot>, so remove it from the live
        // tree." We delete the path off disk best-effort here; the
        // staging block below uses `git add -u -- <path>` to record
        // the deletion against the index (works whether the path was
        // tracked-on-disk, tracked-but-missing-on-disk, or already
        // gone). Subdirectory cleanup is not attempted — git doesn't
        // track empty directories anyway, so a now-empty parent dir
        // is a no-op in the recovery commit.
        const absPath = join(workTree, file_path as string)
        if (existsSync(absPath)) {
          try {
            await unlink(absPath)
          } catch {
            // best-effort; if the unlink fails (e.g. it's actually a
            // directory we don't expect, or permission glitch), the
            // index-update below still tries to stage the deletion.
            // A genuinely impossible removal will surface as a no-op
            // recovery commit, which is acceptable: the user's view
            // of "restore failed" arrives via the file still being
            // present on disk after the call returns.
          }
        }
      }
      // Stage + commit the recovery snapshot on top of HEAD. The
      // commit message embeds BOTH the prior HEAD and the snapshot
      // SHA so the history is self-describing — a future "undo this
      // restore" surface only needs the prior_head_sha to walk back.
      //
      // Argus r1 IMPORTANT — single-file restore must stage ONLY the
      // restored path. `git add -A` would sweep any unrelated dirty
      // edits in the working tree into the recovery commit, which
      // contradicts the inline comment above ("user's other files
      // stay untouched") and (worse) makes the recovery commit lie
      // about what the restore actually did. The implicit backupNow
      // we ran above has already snapshotted those unrelated edits
      // into a separate commit, so they remain reachable via the undo
      // banner — they just don't belong inside THIS commit.
      if (file_path === null) {
        await this.gitExec(this.workArgs(project_id).concat(['add', '-A']), {
          cwd: workTree,
        })
      } else if (snapshotHasPath) {
        await this.gitExec(
          this.workArgs(project_id).concat(['add', '--', file_path]),
          { cwd: workTree },
        )
      } else {
        // Argus r3 BLOCKER #1 — absent-at-snapshot single-file restore.
        // `add -u -- <path>` stages the index update for the path
        // (deletion if the file is now gone from disk, no-op if both
        // index and disk already lack it). `add -- <path>` would NOT
        // record a deletion — it only stages currently-present files.
        await this.gitExec(
          this.workArgs(project_id).concat(['add', '-u', '--', file_path]),
          { cwd: workTree },
        )
      }
      // A genuine no-op restore (the working tree was already at the
      // snapshot) would have nothing staged; allow-empty so the
      // recovery commit STILL lands so the user-visible history
      // always reflects the restore action.
      const iso = new Date(completedAt()).toISOString()
      const target = file_path === null ? 'project' : file_path
      const message = `restore: ${target} from ${snapshot_sha.slice(0, 12)} at ${iso}\n\nprior-head: ${prior_head_sha}\nsnapshot: ${snapshot_sha}`
      await this.gitExec(
        this.workArgs(project_id).concat([
          'commit',
          '--allow-empty',
          '-m',
          message,
        ]),
        { cwd: workTree },
      )
      const recovery = await this.gitExec(
        this.gitDirArgs(project_id).concat(['rev-parse', 'HEAD']),
      )
      const recovery_commit_sha = recovery.stdout.trim()
      this.logger('restore_completed', {
        project_id,
        snapshot_sha,
        prior_head_sha,
        recovery_commit_sha,
        file_path,
      })
      return {
        snapshot_sha,
        prior_head_sha,
        recovery_commit_sha,
        file_path,
        completed_at_ms: completedAt(),
      }
    })()
    this.inFlightRestore.set(project_id, op)
    try {
      return await op
    } finally {
      this.inFlightRestore.delete(project_id)
    }
  }

  /** Throws `SnapshotNotFoundError` when `sha` doesn't resolve to a
   *  commit in the project-backup repo. */
  private async assertSnapshotExists(
    project_id: string,
    sha: string,
  ): Promise<void> {
    try {
      await this.gitExec(
        this.gitDirArgs(project_id).concat([
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

  private async readSnapshotMeta(
    project_id: string,
    sha: string,
  ): Promise<{ parent_sha: string | null; message: string; author_date: string }> {
    const { stdout } = await this.gitExec(
      this.gitDirArgs(project_id).concat([
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

  /** Record the per-project next-scheduled-tick wall clock for the
   *  admin status surface. */
  setNextScheduledAt(project_id: string, ts_ms: number | null): void {
    if (ts_ms === null) this.nextScheduled.delete(project_id)
    else this.nextScheduled.set(project_id, ts_ms)
  }

  /** Force-close any per-project state (graceful shutdown). */
  async drain(): Promise<void> {
    const inFlights: Promise<unknown>[] = [
      ...this.inFlight.values(),
      ...this.inFlightRestore.values(),
    ]
    await Promise.allSettled(inFlights)
  }

  private async readPersistedStatus(
    project_id: string,
  ): Promise<PersistedStatus> {
    const path = join(this.gitDir(project_id), STATUS_FILENAME)
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedStatus>
      return {
        last_backup_at_ms: typeof parsed.last_backup_at_ms === 'number' ? parsed.last_backup_at_ms : null,
        last_check_at_ms: typeof parsed.last_check_at_ms === 'number' ? parsed.last_check_at_ms : null,
        last_commit_sha: typeof parsed.last_commit_sha === 'string' ? parsed.last_commit_sha : null,
        last_push_at_ms: typeof parsed.last_push_at_ms === 'number' ? parsed.last_push_at_ms : null,
        last_push_error:
          parsed.last_push_error !== null && parsed.last_push_error !== undefined
            ? parsed.last_push_error
            : null,
        last_op_ok: typeof parsed.last_op_ok === 'boolean' ? parsed.last_op_ok : true,
      }
    } catch {
      return { ...EMPTY_PERSISTED_STATUS }
    }
  }

  private async recordBackupResult(
    project_id: string,
    result: BackupResult,
    extra: { last_push_at_ms?: number | null } = {},
  ): Promise<void> {
    const dir = this.gitDir(project_id)
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const prior = await this.readPersistedStatus(project_id)
    const now = result.completed_at_ms
    const next: PersistedStatus = {
      last_backup_at_ms:
        result.commit_sha !== null ? now : prior.last_backup_at_ms,
      last_check_at_ms: now,
      last_commit_sha: result.commit_sha ?? prior.last_commit_sha,
      last_push_at_ms:
        extra.last_push_at_ms !== undefined
          ? extra.last_push_at_ms
          : result.pushed
            ? now
            : prior.last_push_at_ms,
      last_push_error: result.push_error,
      last_op_ok: result.ok,
    }
    const path = join(dir, STATUS_FILENAME)
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(tmp, path)
  }

  /** Resolved `.project-backup/` for a project. */
  private gitDir(project_id: string): string {
    return join(this.resolveProjectRoot(project_id), BACKUP_GIT_DIR)
  }

  /** Resolved working tree (the project root). */
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

  /**
   * Repo-corruption recovery (same shape as `DocVersionStore`). On a
   * `fatal: ...` shape that looks like corruption, rename
   * `.project-backup/` aside with a timestamp suffix; the next
   * `ensureInit` rebuilds from the current tree.
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
      this.logger('recovered_from_corruption', {
        project_id,
        broken_dir: broken,
      })
      return true
    } catch (renameErr) {
      this.logger('recovery_failed', {
        project_id,
        error_message: errMessage(renameErr),
      })
      return false
    }
  }
}

/**
 * Classify a `git push` failure into the brief § 2.8 taxonomy. Looks
 * at stderr first (most-informative) then exit code + message.
 */
export function classifyPushFailure(err: unknown): PushError {
  const stderrRaw = errStderr(err)
  const stdoutRaw = errStdout(err)
  const messageRaw = errMessage(err)
  const lower = `${stderrRaw}\n${stdoutRaw}\n${messageRaw}`.toLowerCase()
  if (
    lower.includes('permission denied (publickey)') ||
    lower.includes('public key denied') ||
    lower.includes('publickey,password') ||
    lower.includes('fatal: could not read from remote repository')
  ) {
    return {
      code: 'auth',
      message: extractGitFatal(stderrRaw) ?? 'Permission denied (publickey)',
    }
  }
  if (lower.includes('gh013') || lower.includes('protected branch')) {
    return {
      code: 'branch_protection',
      message: extractGitFatal(stderrRaw) ?? 'Branch protection rejected push',
    }
  }
  if (
    lower.includes('non-fast-forward') ||
    lower.includes('updates were rejected because') ||
    lower.includes('failed to push some refs') ||
    lower.includes('refs/heads/main')
  ) {
    return {
      code: 'remote_not_empty',
      message:
        extractGitFatal(stderrRaw) ??
        'Remote rejected push (non-fast-forward)',
    }
  }
  if (
    lower.includes('etimedout') ||
    lower.includes('connection reset') ||
    lower.includes('temporary failure in name resolution') ||
    lower.includes('connection refused') ||
    lower.includes('connection timed out') ||
    lower.includes('network is unreachable')
  ) {
    return {
      code: 'transient',
      message: extractGitFatal(stderrRaw) ?? 'transient network failure',
    }
  }
  return {
    code: 'unknown',
    message: extractGitFatal(stderrRaw) ?? messageRaw,
  }
}

/**
 * True iff the given push-failure code is one the next 6h tick can
 * still retry transparently. `auth` / `branch_protection` /
 * `remote_not_empty` require user action; everything else (transient,
 * unknown) may resolve on its own.
 */
function isUserResolvableTransient(code: PushFailureKind): boolean {
  // Naming: "user-resolvable transient" → "the user needs to do
  // something". When true, the status is 'error' (loud). When false
  // (transient/unknown), the status may still be 'error' but it's
  // softer — next tick may clear it.
  return (
    code === 'auth' ||
    code === 'branch_protection' ||
    code === 'remote_not_empty'
  )
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

function errStderr(err: unknown): string {
  if (err instanceof Error) {
    const raw = (err as ExecChildError).stderr
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  }
  return ''
}

function errStdout(err: unknown): string {
  if (err instanceof Error) {
    const raw = (err as ExecChildError).stdout
    if (typeof raw === 'string') return raw
    if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  }
  return ''
}

/** Extract the FIRST `fatal: ...` line from git stderr if present. */
function extractGitFatal(stderr: string): string | null {
  if (stderr.length === 0) return null
  for (const line of stderr.split('\n')) {
    if (line.toLowerCase().startsWith('fatal:')) return line.trim()
  }
  return null
}

/** Convert a wall-clock ms number to an ISO string (or null). */
function tsToIso(ms: number | null): string | null {
  if (ms === null) return null
  return new Date(ms).toISOString()
}

/** Conservatively single-quote a value for the GIT_SSH_COMMAND shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Ensure the parent dir of `abs` exists. */
export async function ensureParentDir(abs: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true })
}

/** Promote the un-exported `REMOTE_CONFIG_FILENAME` for the platform adapters. */
export const PROJECT_BACKUP_REMOTE_CONFIG_FILENAME = REMOTE_CONFIG_FILENAME

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

/** Promote the unlink helper so the disconnect-remote endpoint can use it. */
export async function deleteIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* ignore */
  }
}
