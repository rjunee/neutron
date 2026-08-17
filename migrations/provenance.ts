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
 *
 * `resolveDeployedTree` answers the other half of the same question — not "which
 * build wrote this row" but "did that build know about this file at all" — from
 * the tracked-file list in `git-index.ts`. It degrades the same way and returns a
 * REASON rather than an empty answer, because "we cannot check" and "nothing is
 * tracked" have opposite consequences at the call site. What it can and cannot
 * prove is stated at the function, and argued in `git-index.ts`'s header: the
 * evidence is git's INDEX, so it is the staged tree rather than the committed
 * one.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { readGitIndex } from './git-index.ts'

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
 * The `name` in the deployed tree's root `package.json`.
 *
 * This is the OWNERSHIP TEST, and it is why the walk below cannot adopt a
 * stranger's repository. Neutron Open is self-hostable, so an install may be
 * unpacked ANYWHERE — including inside somebody else's checkout (`vendor/`, a
 * monorepo, a scratch clone). Walking up for the first `.git` and reading its
 * HEAD finds that enclosing repo and records its commit as the build that
 * applied the migration: a value that is well-formed, plausible, and wrong,
 * which is worse than the NULL this file promises. So a `.git` counts only when
 * it sits beside the root `package.json` of THIS tree.
 *
 * A name alone cannot carry that on its own, because the enclosing checkout may
 * be another copy of THIS package — two trees, both named `neutron`, one
 * vendored inside the other. `findGitDir` closes that by anchoring the walk at
 * the nearest root rather than at the nearest `.git`; see the note there.
 *
 * `provenance.test.ts` asserts the repo's own root `package.json` still carries
 * this name, so renaming the package fails a test instead of silently turning
 * provenance off everywhere.
 */
const ROOT_PACKAGE_NAME = 'neutron'

/**
 * Whether `dir` is the root of the deployed Neutron tree — i.e. carries a
 * `package.json` naming this package. Total: an unreadable or malformed
 * `package.json` is simply not a match.
 */
function isDeployedTreeRoot(dir: string): boolean {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return false
  try {
    const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof pkg !== 'object' || pkg === null) return false
    return (pkg as { name?: unknown }).name === ROOT_PACKAGE_NAME
  } catch {
    return false
  }
}

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
 * Resolve the `.git` at `dir`, or `null` if it is a shape we cannot read.
 *
 * Handles both forms `.git` takes: a directory (an ordinary clone) and a FILE
 * containing `gitdir: <path>` (a linked worktree or a submodule checkout).
 */
function gitDirAt(dir: string): string | null {
  const candidate = join(dir, '.git')
  const stat = statSync(candidate)
  if (stat.isDirectory()) return candidate
  if (stat.isFile()) {
    const pointer = readFileSync(candidate, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (pointer === undefined || pointer.length === 0) return null
    return isAbsolute(pointer) ? pointer : resolve(dir, pointer)
  }
  return null
}

/**
 * Locate the git metadata directory for `startDir`, or `null` if there is none
 * within `GIT_SEARCH_DEPTH` parents that this tree actually owns.
 *
 * THE WALK IS ANCHORED AT OUR OWN ROOT, and that anchoring is the guard — not
 * a detail of it. Two conditions end it, and each returns NULL rather than
 * looking one directory higher:
 *
 *   a `.git` that is not ours — a repository boundary belonging to somebody
 *   else. We are nested inside their checkout, and nothing above them is ours.
 *
 *   OUR root, carrying no `.git` — a source export, an unpacked tarball, a
 *   `COPY` into an image. This tree HAS no repository, and the next one up the
 *   path is a different tree's.
 *
 * The second is not a symmetric restatement of the first, and dropping it is
 * the subtle version of the bug the ownership test exists for. Checking
 * ownership only where a `.git` happens to sit lets the walk sail straight past
 * our own root and keep climbing — so a copy of this tree unpacked inside
 * ANOTHER Neutron checkout (`vendor/`, a scratch clone, a monorepo that
 * vendors us) passes the ownership test against the HOST's `package.json` and
 * records the HOST's HEAD. Both trees are named `neutron`, so the name test
 * cannot tell them apart; the anchor can, because the copy's own root is
 * reached first. The recorded value would be well-formed, plausible, and about
 * the wrong build — the failure mode this whole file exists to refuse, arriving
 * through the door the check was standing next to.
 *
 * The bounded loop still matters — a tree with no root marker and no `.git` at
 * any depth walks to the filesystem root, and this runs on the boot path.
 */
function findCheckoutRoot(startDir: string): string | null {
  let dir = startDir
  for (let depth = 0; depth < GIT_SEARCH_DEPTH; depth++) {
    const isRoot = isDeployedTreeRoot(dir)
    if (existsSync(join(dir, '.git'))) return isRoot ? dir : null
    if (isRoot) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * The git metadata directory of the checkout `startDir` belongs to.
 *
 * Returns the ROOT's `.git`, never an ancestor's — the walk above is what
 * guarantees that, and both callers depend on it: one records the commit, the
 * other reads the tracked-file list. Recording either from the wrong repository
 * is the failure this file exists to refuse.
 */
function findGitDir(startDir: string): string | null {
  const root = findCheckoutRoot(startDir)
  return root === null ? null : gitDirAt(root)
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
 *   2. Git metadata on disk, read as files, and only from a checkout THIS tree
 *      owns (see `ROOT_PACKAGE_NAME`) — an install nested inside an unrelated
 *      repository resolves to NULL rather than recording that repository's
 *      HEAD. No subprocess: `git` may not be installed, and a subprocess on the
 *      boot path can hang.
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

/**
 * Whether a migration directory's files are tracked by the deployed checkout.
 *
 * `verified` carries the names of the files in that directory the checkout's
 * index tracks, so the caller can refuse one that is not among them.
 * `unverifiable` carries WHY, so the caller can record that provenance was not
 * established instead of pretending it was.
 *
 * THE TWO ARE NOT THE SAME STATE, and conflating them is why this check was
 * declined once. "No git metadata" is not "nothing is tracked": treating it as
 * an empty tracked-set would refuse every migration on every tarball install,
 * and treating a stray file as fine because SOME installs cannot check is how a
 * ledger ends up naming migrations that never existed. Each state gets its own
 * behaviour, and the one that cannot decide says so in the row it writes.
 *
 * WHAT `verified` PROVES, precisely: the path is in git's INDEX — the staged
 * tree. That is a superset of the committed tree, so a file `git add`ed and never
 * committed passes, and one `git add -N`'d does not (`git-index.ts` excludes
 * intent-to-add entries, which stage no content). The residual and the reason
 * HEAD-tree verification is out of scope are argued in that module's header; the
 * short version is that it would require a packfile reader on the boot path. The
 * naming here follows from it: the caller records `tracked-in-index`, which is
 * what was actually established, rather than a claim about a commit.
 */
export type DeployedTree =
  | { readonly kind: 'verified'; readonly dirPrefix: string; readonly tracked: ReadonlySet<string> }
  | { readonly kind: 'unverifiable'; readonly reason: string }

function unverifiable(reason: string): DeployedTree {
  return { kind: 'unverifiable', reason }
}

/**
 * `dir` as the deployed tree names it — `migrations/`, `migrations/comments/` —
 * or `null` when `dir` is not inside the tree at all.
 */
function dirPrefixIn(root: string, dir: string): string | null {
  const rel = relative(root, dir)
  if (rel.length === 0) return ''
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null
  return `${rel.split(sep).join('/')}/`
}

/**
 * Resolve which files in `dir` the deployed tree tracks.
 *
 * Total by construction, like everything else here: any I/O or parse failure
 * resolves to `unverifiable`, never a throw and never a partial list.
 */
export function resolveDeployedTree(dir: string): DeployedTree {
  try {
    const root = findCheckoutRoot(dir)
    if (root === null) return unverifiable('no-git-metadata')
    const gitDir = gitDirAt(root)
    if (gitDir === null) return unverifiable('no-git-metadata')
    const index = readGitIndex(gitDir)
    if (!index.ok) return unverifiable(index.reason)
    // NOT REACHABLE TODAY, and kept deliberately. `findCheckoutRoot` walks UP from
    // `dir`, so the root it returns is always a textual ancestor and `dirPrefixIn`
    // always answers — this is the total-function guard on that invariant, not a
    // path any caller can currently take. It stays because the alternative if the
    // invariant ever breaks is a prefix computed from an unrelated root, which
    // would silently mark tracked files untracked and refuse a correct boot; that
    // failure is much worse than an unverifiable row. `README.md` lists the reason
    // with the same caveat so the ledger's contract stays complete.
    const dirPrefix = dirPrefixIn(root, dir)
    if (dirPrefix === null) return unverifiable('outside-deployed-tree')

    const tracked = new Set<string>()
    for (const path of index.paths) {
      if (!path.startsWith(dirPrefix)) continue
      const name = path.slice(dirPrefix.length)
      if (name.length === 0 || name.includes('/')) continue
      tracked.add(name)
    }
    // A DIRECTORY THE TREE DOES NOT TRACK AT ALL CANNOT ANSWER THE QUESTION,
    // and this is the guard that keeps the check off installs it would wreck.
    // A migration tree can legitimately live somewhere git ignores — copied
    // into `node_modules/` by a package install, unpacked beside a checkout,
    // staged in a build directory. There every file is "untracked" and refusing
    // them all would take down an install that is perfectly correct. The
    // question is only answerable where the directory itself is demonstrably
    // part of the tree, and one tracked sibling is what demonstrates it.
    if (tracked.size === 0) return unverifiable('directory-not-tracked')
    return { kind: 'verified', dirPrefix, tracked }
  } catch {
    return unverifiable('unreadable-index')
  }
}
