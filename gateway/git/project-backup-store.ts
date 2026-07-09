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
 *
 * Module layout (refactor plan 2026-07-02 § D4 — THIS file is the
 * stable facade; the public export surface is unchanged):
 *   - `git-exec.ts`        — shared `git` process wrapper + child-error
 *                            introspection helpers (leaf; the same code
 *                            `doc-version-store.ts` still duplicates
 *                            privately — keep in sync).
 *   - `snapshot-reader.ts` — read-only snapshot surface (list / preview /
 *                            file body / file diff) + typed errors +
 *                            sha/path validators, re-exported below.
 *   - `restore.ts`         — the destructive restore op + preflight,
 *                            re-exported below.
 *   The facade keeps: ensureInit, backupNow (+ push pipeline + status
 *   sidecars) and ALL FIVE concurrency maps — the backup/restore mutex
 *   interlock stays HERE and must not distribute.
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
} from '@neutronai/runtime/platform-adapter.ts'

import {
  createGitExec,
  errMessage,
  errStderr,
  errStdout,
  extractGitFatal,
  GIT_EXEC_TIMEOUT_MS,
  hasStagedChanges as gitHasStagedChanges,
} from './git-exec.ts'
import type { GitExecFn, GitExecOptions, GitRepoContext } from './git-exec.ts'
import {
  getSnapshotFileContent as readSnapshotFileContent,
  getSnapshotFileDiff as readSnapshotFileDiff,
  listSnapshots as readSnapshotList,
  previewSnapshot as readSnapshotPreview,
} from './snapshot-reader.ts'
import type {
  SnapshotFileContent,
  SnapshotFileDiff,
  SnapshotPreview,
  SnapshotSummary,
} from './snapshot-reader.ts'
import { performRestore, preflightRestore } from './restore.ts'
import type { RestoreDeps, RestoreResult } from './restore.ts'

// Re-export the split-out public surface so every importer keeps using
// `gateway/git/project-backup-store.ts` (D4 facade contract: the export
// surface is byte-for-byte compatible; only the file layout changed).
export {
  SNAPSHOT_DEFAULT_LIMIT,
  SNAPSHOT_MAX_LIMIT,
  SNAPSHOT_DIFF_OUTPUT_CAP_BYTES,
  SNAPSHOT_FILE_OUTPUT_CAP_BYTES,
  SnapshotNotFoundError,
  SnapshotPathNotFoundError,
  RestoreUnavailableError,
  InvalidSnapshotPathError,
  InvalidSnapshotShaError,
  assertSnapshotSha,
  assertSnapshotPath,
} from './snapshot-reader.ts'
export type {
  SnapshotSummary,
  SnapshotFileStatus,
  SnapshotFile,
  SnapshotPreview,
  SnapshotFileContent,
  SnapshotFileDiff,
} from './snapshot-reader.ts'
export type { RestoreResult } from './restore.ts'

const execFileAsync = promisify(execFile)

/**
 * Push timeout — project backups can be larger than per-edit doc
 * commits (binaries, Cores SQLite). Brief § 2.7 pins 5 minutes.
 * (The 30s non-push ceiling lives in `git-exec.ts`.)
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

  /** Bound `git` runner (see `git-exec.ts`). */
  private readonly execGit: GitExecFn

  /** Narrow repo view handed to the snapshot-reader / restore leaves —
   *  path resolution + exec only, never the concurrency maps below. */
  private readonly repo: GitRepoContext

  /** Facade-owned collaborators `performRestore` needs (see `restore.ts`). */
  private readonly restoreDeps: RestoreDeps

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
    this.execGit = createGitExec(this.gitBinary)
    this.repo = {
      gitExec: (args, execOpts) => this.gitExec(args, execOpts),
      isGitAvailable: () => this.isGitAvailable(),
      gitDir: (project_id) => this.gitDir(project_id),
      workTree: (project_id) => this.workTree(project_id),
      gitDirArgs: (project_id) => this.gitDirArgs(project_id),
      workArgs: (project_id) => this.workArgs(project_id),
    }
    this.restoreDeps = {
      backupNow: (project_id) => this.backupNow(project_id),
      seedGitignore: (project_id) => this.seedGitignore(project_id),
      logger: (event, fields) => this.logger(event, fields),
      now: () => this.nowFn(),
    }
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
    // clearing `inFlight` (the `await deps.backupNow` at the top of
    // `performRestore` in restore.ts) and the recovery commit landing
    // (end of `performRestore`), a scheduler tick / run-now HTTP would:
    //   (a) race on `.project-backup/index.lock` (visible as
    //       stage_failed / commit_failed; recovery commit may not land)
    //   (b) land a backup commit of the partial-restore tree, leaving
    //       the recovery commit parented on that racing commit instead
    //       of `prior_head_sha` — breaking the append-only undo-banner
    //       semantics (the banner's "walk back to prior_head" would
    //       jump two commits, not one).
    //
    // SAFE WITH THE IMPLICIT PRE-RESTORE backupNow: restore() calls
    // `performRestore(...)` (an async function — its body runs
    // synchronously up to its first await, which IS the implicit
    // `await deps.backupNow(...)`) BEFORE the outer
    // `this.inFlightRestore.set(project_id, op)` runs (performRestore
    // yields on that implicit backupNow's first await, and the set runs
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
   * `.project-backup/` history, newest first. Delegates to
   * `snapshot-reader.ts` (see its doc comment for the full contract).
   */
  async listSnapshots(
    project_id: string,
    opts: { limit?: number; before_sha?: string } = {},
  ): Promise<{ snapshots: SnapshotSummary[]; next_cursor: string | null }> {
    return readSnapshotList(this.repo, project_id, opts)
  }

  /**
   * Build the file-level preview shape: every path touched between
   * `sha` and the current working tree, plus the snapshot's metadata.
   * Delegates to `snapshot-reader.ts` (HEAD-relative status semantics
   * documented there).
   */
  async previewSnapshot(
    project_id: string,
    sha: string,
  ): Promise<SnapshotPreview> {
    return readSnapshotPreview(this.repo, project_id, sha)
  }

  /**
   * Read a single file's body at a snapshot SHA. Delegates to
   * `snapshot-reader.ts` (binary sniff + truncation cap documented
   * there).
   */
  async getSnapshotFileContent(
    project_id: string,
    sha: string,
    relPath: string,
  ): Promise<SnapshotFileContent> {
    return readSnapshotFileContent(this.repo, project_id, sha, relPath)
  }

  /**
   * Unified diff for a single file between the current working tree
   * and `sha`. Delegates to `snapshot-reader.ts`.
   */
  async getSnapshotFileDiff(
    project_id: string,
    sha: string,
    relPath: string,
  ): Promise<SnapshotFileDiff> {
    return readSnapshotFileDiff(this.repo, project_id, sha, relPath)
  }

  /**
   * Restore the project tree to `snapshot_sha`. Two granularities,
   * gated on `file_path` — the destructive op itself lives in
   * `restore.ts:performRestore` (whole-project read-tree + clean vs
   * single-file checkout / staged removal, append-only recovery
   * commit, implicit pre-restore snapshot — all documented there).
   *
   * What stays HERE is the concurrency interlock (plan § D4 — the five
   * per-project maps must not distribute):
   *
   * Concurrency: serializes against both the scheduler's `backupNow`
   * (via the shared per-project `inFlight` map) AND any concurrent
   * restore (via the separate `inFlightRestore` map). The two maps
   * are intentionally distinct so a backupNow caller running in
   * parallel with this restore receives a `BackupResult`, not a
   * `RestoreResult` (Argus r1 IMPORTANT — the previous cast pattern
   * returned the wrong shape).
   */
  async restore(
    project_id: string,
    snapshot_sha: string,
    file_path: string | null,
  ): Promise<RestoreResult> {
    const { snapshotHasPath } = await preflightRestore(
      this.repo,
      project_id,
      snapshot_sha,
      file_path,
    )
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
    // installs the next restore op (synchronously, at the
    // `inFlightRestore.set` below).
    //
    // The implicit pre-restore backupNow (the first await inside
    // `performRestore`) is SAFE — but the temporal proof is subtle,
    // so spelling it out:
    //
    //   (a) `op = performRestore(...)` — an async function's body
    //       BEGINS executing synchronously on invocation (ES spec:
    //       async function bodies run sync until the first `await`).
    //       So performRestore's sync prefix runs FIRST, INCLUDING
    //       backupNow's own sync prefix.
    //   (b) backupNow's sync prefix (everything before it awaits the
    //       `doBackupNow` run it installs) reads `inFlight` (undefined
    //       here — the combined loop above just confirmed both maps
    //       were empty before we got here) and then its own loop reads
    //       `inFlightRestore` (still undefined — the `set` below
    //       hasn't run yet, we're still inside the synchronous tail of
    //       the performRestore invocation expression). The loop exits
    //       cleanly; backupNow installs its `inFlight` entry, awaits
    //       `doBackupNow`, yields.
    //   (c) NOW performRestore has yielded (at its `await
    //       deps.backupNow`). Control returns to the caller. The
    //       `inFlightRestore.set(project_id, op)` below runs.
    //
    // No self-deadlock: backupNow's loop check at (b) runs BEFORE
    // `inFlightRestore.set` at (c), so it cannot observe THIS
    // restore's own op. A concurrent unrelated restore arriving while
    // our op is yielded WOULD see our op (correct cross-serialise
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
    const op = performRestore(
      this.repo,
      this.restoreDeps,
      project_id,
      snapshot_sha,
      file_path,
      snapshotHasPath,
    )
    this.inFlightRestore.set(project_id, op)
    try {
      return await op
    } finally {
      this.inFlightRestore.delete(project_id)
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

  /** Timeout-capped `git` invocation — see `git-exec.ts:createGitExec`. */
  private async gitExec(
    args: string[],
    opts: GitExecOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return this.execGit(args, opts)
  }

  private async hasStagedChanges(project_id: string): Promise<boolean> {
    return gitHasStagedChanges(
      this.execGit,
      this.workArgs(project_id),
      this.workTree(project_id),
    )
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

/** Promote the unlink helper so the disconnect-remote endpoint can use it. */
export async function deleteIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* ignore */
  }
}
