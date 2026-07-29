/**
 * @neutronai/gateway/git — project-backup RESTORE op (P7.4 restore UI),
 * extracted VERBATIM from `project-backup-store.ts` (refactor plan
 * 2026-07-02 § D4).
 *
 * Owns the two destructive restore granularities (whole-project
 * read-tree + clean, single-file checkout / staged removal) and the
 * append-only recovery-commit pipeline.
 *
 * What deliberately does NOT live here: the backup/restore mutex
 * interlock. The facade's `ProjectBackupStore.restore()` keeps the
 * combined `inFlight`/`inFlightRestore` wait-loop, installs the promise
 * returned by `performRestore` into `inFlightRestore`, and deletes it
 * when settled — those five concurrency maps must not distribute
 * (plan § D4: "the crown jewel"). `performRestore` is an async
 * function, so calling it runs its synchronous prefix — including the
 * implicit pre-restore `deps.backupNow` sync prefix — BEFORE the
 * facade's `inFlightRestore.set(...)` line runs; that exact ordering
 * carries the Argus r2 no-self-deadlock proof documented in the facade.
 *
 * Layering: downward-only leaf — imports node builtins, `./git-exec.ts`
 * and `./snapshot-reader.ts` only. Never imports the facade.
 */

import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { errMessage } from './git-exec.ts'
import type { GitRepoContext } from './git-exec.ts'
import {
  assertSnapshotExists,
  assertSnapshotPath,
  assertSnapshotSha,
  RestoreUnavailableError,
  SnapshotNotFoundError,
  SnapshotPathNotFoundError,
} from './snapshot-reader.ts'

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

/**
 * Facade-owned collaborators the restore op needs but must not own:
 * the backup mutex entry point (for the implicit pre-restore snapshot),
 * the `.gitignore` re-seeder, the structured-log sink and the clock.
 */
export interface RestoreDeps {
  /** The facade's `backupNow` — carries its own `inFlight` mutex. The
   *  result shape is irrelevant here; only completion is awaited. */
  backupNow(project_id: string): Promise<unknown>
  /** Re-write the brief-pinned `.gitignore` (idempotent bytes). */
  seedGitignore(project_id: string): Promise<void>
  logger: (event: string, fields: Record<string, unknown>) => void
  now(): number
}

/**
 * Validation + presence probe that runs BEFORE the facade enters the
 * backup/restore interlock. Throws the same typed errors the facade's
 * `restore()` always threw; returns the `snapshotHasPath`
 * classification the destructive op needs.
 */
export async function preflightRestore(
  ctx: GitRepoContext,
  project_id: string,
  snapshot_sha: string,
  file_path: string | null,
): Promise<{ snapshotHasPath: boolean }> {
  if (!(await ctx.isGitAvailable())) {
    throw new RestoreUnavailableError('git binary not available')
  }
  assertSnapshotSha(snapshot_sha)
  if (file_path !== null) {
    assertSnapshotPath(file_path)
  }
  if (!existsSync(join(ctx.gitDir(project_id), 'HEAD'))) {
    throw new SnapshotNotFoundError(`no backup repo for project=${project_id}`)
  }
  await assertSnapshotExists(ctx, project_id, snapshot_sha)
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
      await ctx.gitExec(
        ctx.gitDirArgs(project_id).concat([
          'cat-file',
          '-e',
          `${snapshot_sha}:${file_path}`,
        ]),
      )
    } catch {
      snapshotHasPath = false
    }
  }
  return { snapshotHasPath }
}

/**
 * The destructive restore op. The FACADE (and only the facade) may call
 * this — after its interlock loop has drained every in-flight backup and
 * restore — and must immediately install the returned promise into
 * `inFlightRestore`.
 */
export async function performRestore(
  ctx: GitRepoContext,
  deps: RestoreDeps,
  project_id: string,
  snapshot_sha: string,
  file_path: string | null,
  snapshotHasPath: boolean,
): Promise<RestoreResult> {
  const workTree = ctx.workTree(project_id)
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
    await deps.backupNow(project_id)
  } catch (err) {
    // A backup failure is loud but not fatal — proceed with the
    // restore using HEAD-as-prior-head and document the gap. The
    // alternative (abort restore on backup failure) would leave
    // the user unable to recover from a corrupt working tree.
    deps.logger('restore_pre_snapshot_failed', {
      project_id,
      error_message: errMessage(err),
    })
  }
  const priorHead = await ctx.gitExec(
    ctx.gitDirArgs(project_id).concat(['rev-parse', 'HEAD']),
  )
  const prior_head_sha = priorHead.stdout.trim()
  // Argus r3 BLOCKER #1 — the preflight `snapshotHasPath` probe says
  // the path is absent at the requested snapshot. That's a valid
  // restore request ONLY if the path actually exists somewhere in
  // the live tree / at HEAD — otherwise "restore <path> to its
  // state at <sha>" is a request to remove a path that is already
  // absent everywhere, which is nonsense and must surface as 404.
  // The HEAD probe happens INSIDE the op (rather than alongside
  // the preflight cat-file probe) because the implicit pre-restore
  // backupNow may have advanced HEAD: a file the user created
  // between 6h ticks now lives at the post-backupNow HEAD even
  // though it was not at the pre-restore HEAD the preflight probe
  // could have seen. Probing here uses the freshest possible HEAD.
  if (file_path !== null && !snapshotHasPath) {
    try {
      await ctx.gitExec(
        ctx.gitDirArgs(project_id).concat([
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
    await deps.seedGitignore(project_id)
  } catch {
    /* non-fatal — restore proceeds */
  }
  const completedAt = (): number => deps.now()
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
    await ctx.gitExec(
      ctx.workArgs(project_id).concat([
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
    await ctx.gitExec(
      ctx.workArgs(project_id).concat(['clean', '-f', '-d']),
      { cwd: workTree },
    )
  } else if (snapshotHasPath) {
    // Single-file restore — path present at snapshot. `checkout
    // sha -- <path>` writes the file at `path` from `sha`'s tree
    // into the working tree (replaces or creates as needed). The
    // user's other files stay untouched.
    await ctx.gitExec(
      ctx.workArgs(project_id).concat([
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
    await ctx.gitExec(ctx.workArgs(project_id).concat(['add', '-A']), {
      cwd: workTree,
    })
  } else if (snapshotHasPath) {
    await ctx.gitExec(
      ctx.workArgs(project_id).concat(['add', '--', file_path]),
      { cwd: workTree },
    )
  } else {
    // Argus r3 BLOCKER #1 — absent-at-snapshot single-file restore.
    // `add -u -- <path>` stages the index update for the path
    // (deletion if the file is now gone from disk, no-op if both
    // index and disk already lack it). `add -- <path>` would NOT
    // record a deletion — it only stages currently-present files.
    await ctx.gitExec(
      ctx.workArgs(project_id).concat(['add', '-u', '--', file_path]),
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
  await ctx.gitExec(
    ctx.workArgs(project_id).concat([
      'commit',
      '--allow-empty',
      '-m',
      message,
    ]),
    { cwd: workTree },
  )
  const recovery = await ctx.gitExec(
    ctx.gitDirArgs(project_id).concat(['rev-parse', 'HEAD']),
  )
  const recovery_commit_sha = recovery.stdout.trim()
  deps.logger('restore_completed', {
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
}
