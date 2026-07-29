/**
 * @neutronai/cores-runtime — shared per-project sidecar resolver + the
 * UNIVERSAL path-traversal guard.
 *
 * Refactor X4 (item 2 — the `[BEHAVIOR]` security fix). Four bundled cores
 * (research, email, code-gen, calendar) turn a TOOL-SUPPLIED `project_id`
 * into a filesystem path under `<owner_home>/Projects/<project_id>/…` and
 * then `mkdir` / open a SQLite sidecar there. Before X4 only the Research
 * Core validated that path — `email`, `code-gen`, and `calendar` did a BARE
 * `join()` on the untrusted `project_id`, so a crafted value containing
 * `..`, a NUL byte, or an absolute path could read/write the sidecar (and
 * the rendered artifacts) ANYWHERE under — or above — `owner_home`.
 *
 * This module hoists the Research Core's `safeResolveProjectRoot` into ONE
 * shared guard that EVERY project_id→path site routes through, plus a
 * generic `ProjectSidecarResolver<H>` that collapses the ×3 byte-identical
 * lazy-init resolver classes (research / email / code-gen) into a single
 * cached, init-deduped base. The guard is now universal: legitimate slugs /
 * uuids / nested subpaths resolve exactly as before; only malicious
 * `project_id`s are newly rejected.
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import {
  dirname,
  isAbsolute,
  join,
  resolve as resolvePath,
  sep,
} from 'node:path'

/**
 * Thrown when a caller-supplied `project_id` resolves to a filesystem path
 * outside the owner's `<owner_home>/Projects/` boundary (traversal via
 * `..`, an embedded NUL byte, an absolute path, a value that resolves to
 * the `Projects/` dir itself, OR a path whose existing components symlink
 * outside the boundary). The guard throws BEFORE any FS operation runs
 * against the resolved path.
 *
 * `name` + `code` are constructor-overridable so a Core can preserve its
 * own historical error contract (e.g. the Research Core's
 * `ResearchPathTraversalError` / `research_path_traversal`) while still
 * being `instanceof CorePathTraversalError`.
 */
export class CorePathTraversalError extends Error {
  override readonly name: string
  readonly code: string
  readonly project_id: string
  readonly resolved_path: string
  readonly owner_projects_dir: string
  constructor(
    project_id: string,
    resolved_path: string,
    owner_projects_dir: string,
    name = 'CorePathTraversalError',
    code = 'core_path_traversal',
  ) {
    super(
      `project_id ${JSON.stringify(project_id)} resolves to ${resolved_path}, ` +
        `which escapes the project boundary ${owner_projects_dir}`,
    )
    this.name = name
    this.code = code
    this.project_id = project_id
    this.resolved_path = resolved_path
    this.owner_projects_dir = owner_projects_dir
  }
}

/** Factory a Core supplies to throw its own traversal-error subclass while
 *  keeping `instanceof CorePathTraversalError`. */
export type PathTraversalErrorFactory = (
  project_id: string,
  resolved_path: string,
  owner_projects_dir: string,
) => CorePathTraversalError

export interface SafeResolveProjectRootOptions {
  /** The owner's home dir; `<owner_home>/Projects/` is the boundary. */
  owner_home: string
  /** The (untrusted) tool-supplied project id. */
  project_id: string
  /** Override how a `project_id` maps to its project root (testing seam).
   *  The RESULT is still boundary-checked, so an override cannot defeat the
   *  guard. Defaults to `join(owner_home, 'Projects', project_id)`. */
  resolveProjectRoot?: (project_id: string) => string
  /** Throw a Core-specific traversal-error subclass instead of the default
   *  {@link CorePathTraversalError} (preserves per-Core error contracts). */
  makeError?: PathTraversalErrorFactory
}

/**
 * Resolve `project_id` to its absolute project root AFTER asserting the
 * result stays inside `<owner_home>/Projects/`. Throws
 * {@link CorePathTraversalError} (or the Core's `makeError` subclass) for any
 * `project_id` that is empty / non-string, contains an embedded NUL byte,
 * whose resolved path is not a STRICT subpath of `<owner_home>/Projects/`
 * (traversal, absolute escape, or the `Projects/` dir itself), OR whose
 * existing filesystem components symlink OUTSIDE the boundary.
 *
 * Legitimate nested subpaths (`nested/group/proj-7`) are allowed — the
 * boundary check is a directory-prefix check, not a segment-count check.
 */
export function safeResolveProjectRoot(
  opts: SafeResolveProjectRootOptions,
): string {
  const { owner_home, project_id } = opts
  const owner_projects_dir = resolvePath(owner_home, 'Projects')
  // Guard against prefix-collision (`/home/Projects-evil/...` matching
  // `/home/Projects`). `startsWith(prefix + sep)` enforces a true
  // directory-boundary check; the bare-prefix equality case is rejected
  // separately below.
  const owner_projects_dir_prefix = owner_projects_dir + sep
  const makeError: PathTraversalErrorFactory =
    opts.makeError ??
    ((pid, resolved_path, boundary) =>
      new CorePathTraversalError(pid, resolved_path, boundary))

  if (typeof project_id !== 'string' || project_id.length === 0) {
    throw makeError(String(project_id), '', owner_projects_dir)
  }
  if (project_id.includes('\0')) {
    throw makeError(project_id, '', owner_projects_dir)
  }
  // Reject an ABSOLUTE `project_id` outright. A legit id is a slug / uuid /
  // relative nested path; an absolute value is never valid input. (Left
  // implicit, `path.join` would flatten `/etc/passwd` UNDER Projects/ —
  // harmless but a contract violation vs the documented absolute-path
  // rejection, and a footgun if the mapping ever changes.)
  if (isAbsolute(project_id)) {
    throw makeError(project_id, resolvePath(project_id), owner_projects_dir)
  }
  const resolveRoot =
    opts.resolveProjectRoot ??
    ((pid: string) => join(owner_home, 'Projects', pid))
  const projectRoot = resolveRoot(project_id)
  const resolved = resolvePath(projectRoot)

  // (1) Lexical containment — cheap first line: the canonicalised
  //     dot-segment-free path must be a STRICT subpath of the boundary.
  const insideBoundary =
    resolved === owner_projects_dir ||
    resolved.startsWith(owner_projects_dir_prefix)
  if (!insideBoundary || resolved === owner_projects_dir) {
    throw makeError(project_id, resolved, owner_projects_dir)
  }

  // (2) Filesystem containment — defeat SYMLINK escapes that the lexical
  //     check can't see (e.g. `Projects/proj-a` is a symlink to /tmp/out).
  assertWithinProjectsBoundary({
    owner_home,
    target: resolved,
    project_id,
    makeError,
  })
  return resolved
}

export interface AssertWithinProjectsBoundaryOptions {
  /** The owner's home dir; `<owner_home>/Projects/` is the boundary. */
  owner_home: string
  /** The absolute path whose real location must stay inside the boundary. */
  target: string
  /** Carried into the thrown error for diagnostics. */
  project_id: string
  makeError?: PathTraversalErrorFactory
}

/**
 * Assert that `target` — after resolving symlinks in its EXISTING components
 * — stays inside `<owner_home>/Projects/`. This is the filesystem-level
 * companion to the lexical check: it defeats a symlink placed at ANY depth
 * (the project root OR a deeper `<root>/<sidecar>` / `<root>/code` dir) that
 * points outside the boundary. `realpath`s the nearest existing ancestor of
 * `target` and rejects when it escapes. If the boundary dir does not exist
 * yet there is no symlink target to escape into, so this is a no-op.
 *
 * Callers MUST run this on the FINAL directory they are about to write to
 * (after any `mkdir`, before opening a DB / invoking git) — not only on the
 * project root — because `mkdir -p` over a pre-existing symlinked component
 * silently follows it.
 */
export function assertWithinProjectsBoundary(
  opts: AssertWithinProjectsBoundaryOptions,
): void {
  const owner_projects_dir = resolvePath(opts.owner_home, 'Projects')
  const makeError: PathTraversalErrorFactory =
    opts.makeError ??
    ((pid, resolved_path, boundary) =>
      new CorePathTraversalError(pid, resolved_path, boundary))
  // Anchor the boundary to the REAL `<owner_home>/Projects` dir — WHEREVER it
  // really lives. `<owner_home>/Projects` may itself be a symlink, and that is
  // a legitimate OPERATOR relocation (e.g. `ln -s /Volumes/Data/Projects
  // ~/Projects` to keep projects on an external volume), NOT an attack: the
  // boundary dir is operator-controlled; only the components BELOW it come
  // from the (untrusted) tool-supplied `project_id`. So we canonicalise the
  // boundary ITSELF and require every target's realpath to stay under it.
  // This still rejects a genuine escape — a `..` / absolute `project_id`
  // (caught lexically upstream) or a symlink placed INSIDE Projects pointing
  // out, because THAT target's realpath leaves the real boundary. If Projects
  // doesn't exist yet there is no symlink to follow, so the lexical guard
  // alone is authoritative.
  let realBoundary: string
  try {
    realBoundary = realpathSync(owner_projects_dir)
  } catch {
    return
  }
  let probe = resolvePath(opts.target)
  while (!existsSync(probe) && dirname(probe) !== probe) {
    probe = dirname(probe)
  }
  let realProbe: string
  try {
    realProbe = realpathSync(probe)
  } catch {
    return
  }
  if (realProbe !== realBoundary && !realProbe.startsWith(realBoundary + sep)) {
    throw makeError(opts.project_id, realProbe, owner_projects_dir)
  }
}

/** The safe-resolved paths handed to a Core's `buildHandle`. */
export interface ProjectSidecarInit {
  /** The raw (validated) project id the handle is bound to. */
  project_id: string
  /** Absolute, boundary-checked project root. */
  project_root: string
  /** `<project_root>/<sidecar_dir>` — already `mkdir -p`'d (mode 0700). */
  sidecar_dir_path: string
  /** `<sidecar_dir_path>/<db_filename>`. */
  db_path: string
}

export interface ProjectSidecarResolverOptions<H> {
  owner_home: string
  /** Sidecar directory name under the project root (e.g. `'research'`). */
  sidecar_dir: string
  /** Sidecar SQLite filename (e.g. `'research.db'`). */
  db_filename: string
  /** Testing seam — overrides project-root resolution; the result is still
   *  boundary-checked by the guard. */
  resolveProjectRoot?: (project_id: string) => string
  /** Throw a Core-specific traversal-error subclass on a guard violation. */
  makeError?: PathTraversalErrorFactory
  /** Construct the Core-specific handle from the safe-resolved paths. Owns
   *  the DB open + migrations + meta bootstrap + store construction. If it
   *  throws it MUST close any DB it opened. */
  buildHandle: (init: ProjectSidecarInit) => Promise<H>
  /** Close a cached handle (called for every handle by `closeAll`). */
  closeHandle: (handle: H) => void
}

/**
 * Generic per-project sidecar resolver. One handle per `project_id`, cached
 * for the resolver's lifetime; init-promise dedup so two concurrent
 * first-resolves wait on the same init. EVERY FS-touching path is gated by
 * {@link safeResolveProjectRoot}.
 */
export class ProjectSidecarResolver<H> {
  private readonly owner_home: string
  private readonly sidecar_dir: string
  private readonly db_filename: string
  private readonly resolveProjectRoot:
    | ((project_id: string) => string)
    | undefined
  private readonly makeError: PathTraversalErrorFactory | undefined
  private readonly buildHandle: (init: ProjectSidecarInit) => Promise<H>
  private readonly closeHandle: (handle: H) => void
  private readonly handles = new Map<string, H>()
  private readonly initPromises = new Map<string, Promise<H>>()

  constructor(opts: ProjectSidecarResolverOptions<H>) {
    this.owner_home = opts.owner_home
    this.sidecar_dir = opts.sidecar_dir
    this.db_filename = opts.db_filename
    this.resolveProjectRoot = opts.resolveProjectRoot
    this.makeError = opts.makeError
    this.buildHandle = opts.buildHandle
    this.closeHandle = opts.closeHandle
  }

  /** Boundary-checked absolute project root for `project_id`. */
  private safeRoot(project_id: string): string {
    const opts: SafeResolveProjectRootOptions = {
      owner_home: this.owner_home,
      project_id,
    }
    if (this.resolveProjectRoot !== undefined) {
      opts.resolveProjectRoot = this.resolveProjectRoot
    }
    if (this.makeError !== undefined) {
      opts.makeError = this.makeError
    }
    return safeResolveProjectRoot(opts)
  }

  /** Absolute path to the sidecar DB (guarded). */
  pathFor(project_id: string): string {
    return join(this.safeRoot(project_id), this.sidecar_dir, this.db_filename)
  }

  /** Absolute path to the sidecar directory (guarded). */
  dirFor(project_id: string): string {
    return join(this.safeRoot(project_id), this.sidecar_dir)
  }

  closeAll(): void {
    for (const handle of this.handles.values()) {
      try {
        this.closeHandle(handle)
      } catch {
        /* ignore */
      }
    }
    this.handles.clear()
    this.initPromises.clear()
  }

  async resolve(project_id: string): Promise<H> {
    const cached = this.handles.get(project_id)
    if (cached !== undefined) return cached
    const pending = this.initPromises.get(project_id)
    if (pending !== undefined) return pending
    const init = this.doInit(project_id)
    this.initPromises.set(project_id, init)
    try {
      const handle = await init
      this.handles.set(project_id, handle)
      return handle
    } finally {
      this.initPromises.delete(project_id)
    }
  }

  private async doInit(project_id: string): Promise<H> {
    const project_root = this.safeRoot(project_id)
    const sidecar_dir_path = join(project_root, this.sidecar_dir)
    if (!existsSync(sidecar_dir_path)) {
      mkdirSync(sidecar_dir_path, { recursive: true, mode: 0o700 })
    }
    // Re-check the FINAL sidecar dir: a symlink at `<root>/<sidecar_dir>`
    // pointing outside the boundary passes the root-level guard, and
    // `mkdir -p` over a pre-existing symlink silently follows it. Reject
    // BEFORE `buildHandle` opens the DB through that path.
    const boundaryOpts: AssertWithinProjectsBoundaryOptions = {
      owner_home: this.owner_home,
      target: sidecar_dir_path,
      project_id,
    }
    if (this.makeError !== undefined) boundaryOpts.makeError = this.makeError
    assertWithinProjectsBoundary(boundaryOpts)
    const db_path = join(sidecar_dir_path, this.db_filename)
    return this.buildHandle({
      project_id,
      project_root,
      sidecar_dir_path,
      db_path,
    })
  }
}
