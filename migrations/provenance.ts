/**
 * @neutronai/migrations — build provenance for applied migrations.
 *
 * WHY THIS EXISTS. A live instance crash-looped on boot because `_migrations`
 * recorded an ordinal under one name while the deployed code carried another,
 * and `applyMigrations` correctly refuses to guess (see `runner.ts`,
 * `migrationNameMismatch`). The investigation then hit a wall: at the moment
 * the offending row was written, the commit the instance was running contained
 * no migration file at that ordinal at all — so a migration that was not part
 * of the deployed build had been applied to the live database, and NOTHING on
 * disk recorded which build applied it. The forensic question was unanswerable
 * after the fact, which is why the same class recurred without ever being
 * closed.
 *
 * So every row now carries two identifiers of the build that wrote it:
 *
 *   content_sha256    — SHA-256 of the migration file's bytes. Always present.
 *                       Independent of the file's NAME, so it distinguishes
 *                       "the same migration, renamed" from "a genuinely
 *                       different migration that claimed this ordinal" — the
 *                       exact question the incident could not answer.
 *   applied_by_commit — the deployed commit SHA, when one is discoverable.
 *                       NULL otherwise, and NULL is a first-class answer.
 *
 * DEGRADING GRACEFULLY IS A HARD REQUIREMENT, NOT A NICETY. Neutron Open is
 * self-hostable, and a self-hosted install may be an unpacked tarball, a zip,
 * or a `COPY` into a container image — with no `.git` anywhere and no `git`
 * binary on PATH. Provenance is a diagnostic; the failure it diagnoses is a
 * boot crash loop. A resolver that could itself throw, hang, or block would be
 * a new way to fail the very boot path this work exists to protect. Hence:
 * every function here is total — it returns `null` rather than throwing, reads
 * git metadata as plain files instead of spawning a subprocess (a subprocess
 * on the boot path can hang on a slow mount or a held `index.lock`), and is
 * bounded in how far it will walk.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * A git object id as it appears in `HEAD`, a loose ref file, or `packed-refs`.
 * Short ids are accepted too, because `NEUTRON_COMMIT_SHA` is written by
 * whoever packages the build and an abbreviated id is still a usable forensic
 * handle.
 */
const OBJECT_ID_RE = /^[0-9a-f]{7,64}$/i

/** How many parent directories to search for a `.git` before giving up. */
const GIT_SEARCH_DEPTH = 24

/**
 * SHA-256 of a migration file's contents, hex-encoded.
 *
 * The runner reads migration files as utf8 (`readFileSync(..., 'utf8')`), so
 * hashing the decoded string with a utf8 encoding reproduces the file's bytes
 * for any valid utf8 input — which every `.sql` file in this tree is.
 */
export function migrationContentHash(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/**
 * Locate the git metadata directory for `startDir`, or `null` if there is none
 * within `GIT_SEARCH_DEPTH` parents.
 *
 * Handles both shapes `.git` takes: a directory (an ordinary clone) and a FILE
 * containing `gitdir: <path>` (a linked worktree or a submodule checkout). The
 * bounded loop matters — an unpacked tarball has no `.git` at any depth, and
 * this runs on the boot path.
 */
function findGitDir(startDir: string): string | null {
  let dir = startDir
  for (let depth = 0; depth < GIT_SEARCH_DEPTH; depth++) {
    const candidate = join(dir, '.git')
    if (existsSync(candidate)) {
      const stat = statSync(candidate)
      if (stat.isDirectory()) return candidate
      if (stat.isFile()) {
        const pointer = readFileSync(candidate, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
        if (pointer === undefined || pointer.length === 0) return null
        return isAbsolute(pointer) ? pointer : resolve(dir, pointer)
      }
      return null
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Read a loose ref file (`<gitDir>/refs/heads/main`), if it holds an object id. */
function readLooseRef(gitDir: string, ref: string): string | null {
  const path = join(gitDir, ref)
  if (!existsSync(path)) return null
  const contents = readFileSync(path, 'utf8').trim()
  return OBJECT_ID_RE.test(contents) ? contents.toLowerCase() : null
}

/**
 * Read a ref out of `<gitDir>/packed-refs`. Lines are `<oid> <refname>`;
 * `#` headers and `^<oid>` continuation lines (peeled annotated tags) fail the
 * match by shape and are skipped.
 */
function readPackedRef(gitDir: string, ref: string): string | null {
  const path = join(gitDir, 'packed-refs')
  if (!existsSync(path)) return null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([0-9a-f]{7,64})\s+(\S+)$/i)
    if (match !== null && match[2] === ref) return String(match[1]).toLowerCase()
  }
  return null
}

/**
 * Resolve a symbolic ref to an object id, checking this git dir's loose refs
 * and packed-refs, then the COMMON dir's if this is a linked worktree. A
 * worktree keeps its own `HEAD` but shares `refs/` and `packed-refs` with the
 * main checkout via the `commondir` pointer, so a worktree-only search finds
 * `HEAD` and then fails to resolve the branch it names.
 */
function resolveRef(gitDir: string, ref: string): string | null {
  const direct = readLooseRef(gitDir, ref) ?? readPackedRef(gitDir, ref)
  if (direct !== null) return direct

  const commonPath = join(gitDir, 'commondir')
  if (!existsSync(commonPath)) return null
  const pointer = readFileSync(commonPath, 'utf8').trim()
  if (pointer.length === 0) return null
  const common = isAbsolute(pointer) ? pointer : resolve(gitDir, pointer)
  return readLooseRef(common, ref) ?? readPackedRef(common, ref)
}

/** Resolve `<gitDir>/HEAD`, whether it is detached (a bare oid) or symbolic. */
function readHead(gitDir: string): string | null {
  const path = join(gitDir, 'HEAD')
  if (!existsSync(path)) return null
  const head = readFileSync(path, 'utf8').trim()
  if (OBJECT_ID_RE.test(head)) return head.toLowerCase()
  const ref = head.match(/^ref:\s*(\S+)$/)?.[1]
  return ref === undefined ? null : resolveRef(gitDir, ref)
}

/**
 * The commit SHA of the running build, or `null` when it is not discoverable.
 *
 * Precedence:
 *   1. `NEUTRON_COMMIT_SHA` — the escape hatch for builds that ship WITHOUT
 *      git metadata. A packager (tarball, zip, container image) bakes the id
 *      it built from, and provenance stays answerable for exactly the install
 *      shape that would otherwise have none.
 *   2. Git metadata on disk, read as files. No subprocess: `git` may not be
 *      installed, and a subprocess on the boot path can hang.
 *   3. `null`. Not an error — an install with no build identity is a supported
 *      install, and the column is nullable to say so honestly rather than
 *      record a fabricated value.
 *
 * Total by construction: any I/O or parse failure resolves to `null`.
 */
export function resolveDeployedCommit(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string | null {
  try {
    const declared = env['NEUTRON_COMMIT_SHA']?.trim()
    if (declared !== undefined && OBJECT_ID_RE.test(declared)) return declared.toLowerCase()
    const gitDir = findGitDir(startDir)
    return gitDir === null ? null : readHead(gitDir)
  } catch {
    // A malformed .git, a permissions error, a symlink loop — none of these
    // are worth a boot failure. Provenance is best-effort by design.
    return null
  }
}
