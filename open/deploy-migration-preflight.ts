/**
 * THE PER-SHA SAFETY CHECK A STANDING DEPLOY WINDOW MAY NEVER SKIP.
 *
 * `createHostDeployService`'s `check_preconditions` seam asks one question: if
 * this instance deployed `sha`, would it still boot? A standing window
 * authorises the owner's TAP, never the guard, so with no answer to that
 * question the service refuses to auto-deploy at all. This module is the
 * answer.
 *
 * It works by SIMULATED BOOT: `VACUUM INTO` a throwaway copy of the live
 * database, materialise the target sha's `migrations/` tree into a temp
 * directory, and replay the tree against the copy. Nothing real is written on
 * any path — not the live database, not the host checkout. The live database is
 * opened read-only, and every byte the replay produces lands in a temp
 * directory that is removed before this function returns.
 *
 * TWO INDEPENDENT ASSERTIONS, because each covers the other's blind spot:
 *
 *  1. THE REPLAY MUST NOT THROW. This reproduces the boot refusal itself. The
 *     runner's ordinal-identity guard refuses to migrate a database whose
 *     ledger has drifted from the tree (a duplicate ordinal is SILENTLY SKIPPED
 *     otherwise, which is how 2026-08-17 took the instance down and how ordinal
 *     125 was armed again on 2026-08-20). Replaying here surfaces that refusal
 *     BEFORE the deploy instead of at boot, when the gateway is already down.
 *
 *  2. EVERY SCHEMA OBJECT THE TARGET EXPECTS MUST EXIST AFTERWARDS. A replay
 *     that does not throw is not the same as a replay that is correct: a table
 *     rebuild copies only the columns it NAMES and drops every index on the old
 *     table, so a migration authored before a sibling `ALTER` deletes those
 *     columns and reports success. Nothing throws, and the failure surfaces
 *     arbitrarily later as a runtime `no such column`. Comparing the migrated
 *     copy against the target tree's own `expected-schema.txt` catches it.
 *
 * ASSERTION 2 IS DELIBERATELY ONE-DIRECTIONAL — present, not equal. This is
 * measured, not assumed. On a real instance the live schema is a strict
 * SUPERSET of the fresh-database snapshot: `_migration_repairs` exists only
 * where a repair was acknowledged, and this box additionally carries an orphan
 * `code_trident_dispatch_holds` table with a UNIQUE index that no migration in
 * the tree creates and that nothing in the repository references (a branch
 * deploy that was later reverted; the table outlives the code). A byte-equality
 * assertion would therefore refuse EVERY deploy here. A guard that always cries
 * wolf is switched off, which fails exactly as open as no guard at all — so
 * extras are tolerated and only ABSENCE blocks. Absence is the failure mode
 * that actually corresponds to a silent deletion.
 *
 * KNOWN AND ACCEPTED APPROXIMATION: the replay executes with the RUNNING
 * process's runner over the TARGET sha's migration files. A change to the
 * runner itself in the target sha is therefore not exercised. Simulating that
 * faithfully means executing the target's code, which is the deploy. The files
 * are where drift actually happens; the runner is not rewritten most weeks.
 * `repairs.json` IS read from the target tree, because the runner resolves it
 * from the directory it is handed rather than from its own location.
 */

import { Database } from 'bun:sqlite'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { serializeSchema } from '@neutronai/migrations/schema-serialize.ts'

/** What `check_preconditions` returns: a verdict plus the sentence shown to the owner. */
export interface DeployPreflightVerdict {
  ok: boolean
  reason: string
}

export interface DeployMigrationPreflightDeps {
  /** Absolute path to the LIVE database this instance boots against. Opened read-only. */
  db_path: string
  /**
   * A checkout that HOLDS THE TARGET SHA'S OBJECTS. `git archive` reads the
   * object store, so this need not be the host checkout and is never written
   * to — but a sha it has not fetched cannot be inspected, and that is a
   * refusal rather than a pass.
   */
  repo_path: string
  /** Seam for tests; defaults to the OS temp dir. */
  tmp_root?: string
  log?: (msg: string) => void
}

/** Git object ids only. Anything else never reaches a command line. */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function gitArchiveMigrations(
  repo_path: string,
  sha: string,
  dest: string,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    // `git archive | tar -x` rather than a checkout: it cannot touch the
    // repository's working tree or index, so a preflight can never disturb a
    // checkout something else is using.
    execFile(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        'git -C "$1" archive "$2" migrations | tar -x -C "$3" --strip-components=1',
        'preflight',
        repo_path,
        sha,
        dest,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        resolve({ ok: error === null, detail: String(stderr).trim() || errText(error) })
      },
    )
  })
}

/**
 * The lines of `expected-schema.txt` that the migrated copy does NOT contain.
 * Line-set containment, not equality — see the one-directional note above.
 */
export function missingSchemaLines(observed: string, expected: string): string[] {
  const present = new Set(observed.split('\n'))
  return expected.split('\n').filter((line) => line.trim().length > 0 && !present.has(line))
}

/**
 * Build the `check_preconditions` seam. EVERY failure path returns `ok:false`
 * with the cause named — a crash in the check is a refusal, never a pass,
 * because treating a crash as a pass is how a guard becomes decoration.
 */
export function createDeployMigrationPreflight(
  deps: DeployMigrationPreflightDeps,
): (input: { ref: string; sha: string }) => Promise<DeployPreflightVerdict> {
  const log = deps.log ?? ((): void => {})

  return async ({ ref, sha }): Promise<DeployPreflightVerdict> => {
    if (!SHA_PATTERN.test(sha)) {
      return { ok: false, reason: `the deploy preflight refused a malformed target sha (${sha})` }
    }

    let workdir: string | null = null
    try {
      // `--strip-components=1` lands the tree's files DIRECTLY in workdir, so
      // workdir IS the migration directory handed to the runner. `copy.db` and
      // the `.migrate-owner` marker sit alongside them and are ignored:
      // `loadMigrations` filters on `/^\d{4}_.+\.sql$/`.
      workdir = mkdtempSync(join(deps.tmp_root ?? tmpdir(), 'deploy-preflight-'))
      const copy = join(workdir, 'copy.db')

      const archived = await gitArchiveMigrations(deps.repo_path, sha, workdir)
      if (!archived.ok) {
        return {
          ok: false,
          reason:
            `the deploy preflight could not read the migration tree at ${sha} ` +
            `(${archived.detail || 'git archive failed'}), so it cannot prove the deploy is safe`,
        }
      }

      let expected: string
      try {
        expected = readFileSync(join(workdir, 'expected-schema.txt'), 'utf8')
      } catch (err) {
        return {
          ok: false,
          reason: `the deploy preflight found no expected-schema.txt at ${sha}: ${errText(err)}`,
        }
      }

      // Read-only: the live database is never a write target of this path.
      const live = new Database(deps.db_path, { readonly: true })
      try {
        live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
      } finally {
        live.close()
      }

      const simulated = new Database(copy)
      try {
        try {
          applyMigrations(simulated, workdir)
        } catch (err) {
          return {
            ok: false,
            reason:
              `deploying ${ref} (${sha}) would fail to migrate this instance, so the ` +
              `gateway would not boot: ${errText(err)}`,
          }
        }

        const missing = missingSchemaLines(serializeSchema(simulated), expected)
        if (missing.length > 0) {
          return {
            ok: false,
            reason:
              `deploying ${ref} (${sha}) would migrate without error but leave ` +
              `${missing.length} schema object line(s) the target expects MISSING, which is how a ` +
              `table rebuild silently drops a column: ${missing.slice(0, 3).join(' / ')}`,
          }
        }
      } finally {
        simulated.close()
      }

      log(`deploy preflight PASSED for ${ref} (${sha}): simulated boot migrates and matches schema`)
      return { ok: true, reason: `simulated boot against a copy of the live database succeeded` }
    } catch (err) {
      return {
        ok: false,
        reason: `the deploy preflight could not be completed: ${errText(err)}`,
      }
    } finally {
      if (workdir !== null) rmSync(workdir, { recursive: true, force: true })
    }
  }
}
