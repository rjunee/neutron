/**
 * @neutronai/trident — does a governed repo's build log resolve to `merge=union`?
 *
 * A governed repo (one with a `SPEC.md` at its git root) keeps an append-only
 * as-built log, and every change adds an entry at the TOP of it. So two open
 * PRs conflict by construction rather than by subject, and the resolution is
 * always the same mechanical "keep both". At the worst of it that cost five
 * rebases in one evening across four unrelated PRs, and it is what motivated
 * splitting the log into one file per entry — a split that bought merge quiet
 * and spent discoverability, and was reversed.
 *
 * `union` is git's built-in driver for exactly this shape: on a conflicting
 * hunk it takes BOTH sides instead of raising. `.gitattributes` is committed,
 * so the rule travels to every clone and every agent rather than living in one
 * machine's config.
 *
 * ⚠️ THE SCOPE LIMIT IS THE LOAD-BEARING PART. Union NEVER reports a conflict.
 * That is precisely right for a file whose changes only ever ADD, and precisely
 * wrong everywhere else: pointed at a file whose existing lines get rewritten,
 * it silently doubles the rewrite instead of flagging it. So the convention
 * covers the append-only log and NOTHING else — never `SPEC.md`, never
 * `ISSUES.md`, both of which are edited in place and want a real conflict.
 *
 * ⚠️ THE VERDICT COMES FROM GIT. `mergeRulesFor` below reads text, which
 * answers "what does this file SAY" — a different question from "what will git
 * DO", and the difference is not academic. It is used ONLY to compose
 * suggestion text that can point at a line number. The pass/fail answer comes
 * from {@link resolveTrackedMergeDrivers}, which runs `git check-attr`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

/**
 * Filenames a governed repo's append-only build log is known to use. Both
 * spellings and both locations are real: Managed keeps `AS-BUILT.md` at the
 * root, Open keeps `docs/AS_BUILT.md`.
 */
export const AS_BUILT_CANDIDATES = [
  'AS_BUILT.md',
  'AS-BUILT.md',
  'docs/AS_BUILT.md',
  'docs/AS-BUILT.md',
] as const

/** The `.gitattributes` line that marks one log union-merged. */
export function unionAttributeLine(logPath: string): string {
  return `${logPath} merge=union`
}

/**
 * The merge drivers git implements itself. Anything else must be defined by a
 * `merge.<name>.driver` config entry.
 *
 * WHAT GIT ACTUALLY DOES with a custom driver named in a TRACKED
 * `.gitattributes`, measured on git 2.50.1 (Apple Git-155) — a fresh repo with
 * `log.txt merge=as-built-log`, two branches editing the same region, merged:
 *
 *   - NO `merge.as-built-log.*` config at all → git falls back to the ordinary
 *     text merge: exit 1, `CONFLICT (content)`, conflict markers in the file.
 *   - `merge.as-built-log.name` set but `.driver` unset → THAT is the fatal one:
 *     `fatal: custom merge driver as-built-log lacks command line.` (exit 128).
 *   - both `.name` and `.driver` set → exit 0, the driver's output.
 *
 * An earlier revision of this file (and of the CI gate's remediation text)
 * claimed the exit-128 result for the first case too. It is wrong: a clone with
 * no config for the driver merges, it just merges the DEFAULT way. That is
 * still a reason a gate must not bless a custom driver in the tracked file —
 * the tracked rule is supposed to be the union floor and this is not union — but
 * it is a quieter failure than "nobody can merge at all", and the remediation
 * text has to say the true thing or the next reader debugs the wrong symptom.
 *
 * Both halves matter to `scripts/install-merge-drivers.sh`, which sets `.name`
 * AND `.driver` together and binds the path in the untracked
 * `$GIT_COMMON_DIR/info/attributes`: half-installed (name without driver) is the
 * exit-128 state, so the two config keys travel together or not at all.
 */
export const BUILT_IN_MERGE_DRIVERS = ['text', 'binary', 'union'] as const

/**
 * Values `git check-attr merge` reports that are attribute STATES rather than
 * driver names, so a diagnostic must not describe them as drivers or invent a
 * `merge.<value>.driver` remediation for them.
 *
 * Measured on git 2.50.1, each with the same two-branch conflicting merge:
 *
 *   - `<path> merge`  → check-attr says `set`. Ordinary text merge: exit 1,
 *     `CONFLICT (content)`, markers. Identical to having no rule at all.
 *   - `<path> -merge` → check-attr says `unset`. git treats the file as BINARY:
 *     `warning: Cannot merge binary files`, exit 1, ours kept whole, NO markers.
 *
 * Both fail the union property, and both used to be reported as
 * "'set' is a CUSTOM driver … no merge.set.* config", naming a config key that
 * does not exist.
 *
 * (`<path> !merge` reports `unspecified`, which this module already maps to
 * `null` — no rule reaches the path.)
 */
export const MERGE_ATTRIBUTE_STATES = ['set', 'unset'] as const

/** One `merge=` assignment found in an attributes file, with where it was found. */
export interface MergeRule {
  /** The attributes file it came from, repo-relative (e.g. `docs/.gitattributes`). */
  file: string
  /** 1-based line number in that file, for a diagnostic a human can act on. */
  line: number
  /** The line as written, trimmed. */
  text: string
  /** The driver named after `merge=`. */
  driver: string
}

/** One tracked `.gitattributes`, and where in the tree it sits. */
export interface AttributesFile {
  /** Repo-relative POSIX path, e.g. `.gitattributes` or `docs/.gitattributes`. */
  path: string
  /** Its full contents. */
  content: string
}

/**
 * Every ACTIVE rule in `attributes` that assigns a merge driver to the EXACT
 * pattern `pattern`, in file order.
 *
 * A commented line does not count — an entry that was deliberately disabled
 * reads exactly like an entry that is present, and treating the two the same is
 * how a repo ends up believing it has a guard it turned off.
 *
 * Plural on purpose: a file may carry several, and which one wins is git's
 * business, not this function's.
 */
export function mergeRulesFor(attributes: string, pattern: string, file = '.gitattributes'): MergeRule[] {
  const found: MergeRule[] = []
  const lines = attributes.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // A `.gitattributes` line is `<pattern> <attr>...`, whitespace-separated.
    const [linePattern, ...attrs] = line.split(/\s+/)
    if (linePattern !== pattern) continue
    for (const attr of attrs) {
      if (attr.startsWith('merge=')) {
        found.push({ file, line: i + 1, text: line, driver: attr.slice('merge='.length) })
        break
      }
    }
  }
  return found
}

/**
 * Every exact-path merge rule for `logPath` across ALL the attributes files,
 * in git's own precedence order — shallowest file first, last rule wins.
 *
 * A rule in `docs/.gitattributes` is written RELATIVE to that directory, so the
 * pattern matched against is `logPath` with the file's directory stripped. A
 * root file spells the same rule `docs/AS_BUILT.md`; the one inside `docs/`
 * spells it `AS_BUILT.md`. Reading only the root spelling is how a subdirectory
 * override became invisible.
 */
export function mergeRulesAcross(files: readonly AttributesFile[], logPath: string): MergeRule[] {
  const found: MergeRule[] = []
  for (const file of orderedShallowestFirst(files)) {
    const dir = posix.dirname(file.path)
    const prefix = dir === '.' ? '' : `${dir}/`
    if (!logPath.startsWith(prefix)) continue
    found.push(...mergeRulesFor(file.content, logPath.slice(prefix.length), file.path))
  }
  return found
}

/** Shallowest directory first — the order git applies attributes files in. */
function orderedShallowestFirst(files: readonly AttributesFile[]): AttributesFile[] {
  const depth = (p: string) => p.split('/').length
  return [...files].sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
}

// ---------------------------------------------------------------------------
// Ask git. Everything above reads text; everything below asks the authority.
// ---------------------------------------------------------------------------

/**
 * Every attributes file that can possibly affect `paths`, repo-relative.
 *
 * git consults `.gitattributes` in the directory of the path being matched and
 * in each of its ANCESTORS up to the top level, and nowhere else. So the set of
 * files that can reach `docs/AS_BUILT.md` is exactly `.gitattributes` and
 * `docs/.gitattributes` — bounded, and provably complete without walking the
 * tree. (A repo-wide `git ls-files` over every `.gitattributes` would also work
 * and would additionally collect files that cannot match anything being asked
 * about; this is the same answer, smaller.)
 */
export function relevantAttributesPaths(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    // Drop the filename; every remaining prefix is a directory that can hold one.
    segments.pop()
    out.add('.gitattributes')
    let dir = ''
    for (const segment of segments) {
      dir = dir === '' ? segment : `${dir}/${segment}`
      out.add(`${dir}/.gitattributes`)
    }
  }
  return orderedShallowestFirst([...out].map((path) => ({ path, content: '' }))).map((f) => f.path)
}

/**
 * The attributes files a FRESH CLONE of `repoRoot` would get, for the subset
 * that can affect `paths`.
 *
 * In a git repository the content comes from the INDEX (`git show :<path>`),
 * not from disk, and that distinction is the point: an UNTRACKED
 * `docs/.gitattributes` sitting in someone's working tree changes what THEIR
 * git answers and reaches no clone at all, so it must not change the verdict.
 * A file that is absent from the index is simply absent here.
 *
 * Outside a repository — a governed tree checked before it is one, and the
 * fixtures the gate's own tests build — it falls back to reading the same paths
 * from disk, because there is no index to prefer and "what is on disk" is the
 * only available reading of "what would travel".
 */
export function collectTrackedAttributesFiles(repoRoot: string, paths: readonly string[]): AttributesFile[] {
  const candidates = relevantAttributesPaths(paths)
  const fromIndex = isGitRepository(repoRoot)
  const found: AttributesFile[] = []

  for (const path of candidates) {
    let content: string | null = null
    if (fromIndex) {
      try {
        content = execFileSync('git', ['-C', repoRoot, 'show', `:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      } catch {
        content = null // not tracked — it reaches no clone
      }
    } else {
      const onDisk = join(repoRoot, path)
      content = existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : null
    }
    if (content !== null) found.push({ path, content })
  }
  return found
}

function isGitRepository(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Values PINNED on every probe git process, so `git check-attr` answers from
 * the repository in front of it.
 *
 * Measured on git 2.50.1: with a global `core.attributesFile` naming a driver
 * for `docs/AS_BUILT.md`, a repo whose own `.gitattributes` says nothing about
 * that path resolves to the GLOBAL file's driver. So without this pin, one
 * maintainer's machine can answer "yes, union" for a repo that tracks no such
 * rule — a false PASS that travels nowhere and reproduces on nobody else's
 * machine. With the pin, the same probe reports `unspecified`.
 */
export const CHECK_ATTR_ISOLATION_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
} as const

/**
 * Variables REMOVED from every probe git process. Pinning the three above is
 * not enough, and each of these was measured defeating them on git 2.50.1, from
 * an attributes-free scratch repo whose control answer is `unspecified`:
 *
 *   - `GIT_CONFIG_PARAMETERS="'core.attributesFile=…'"` → `poisoned`. This is
 *     exactly what `git -c` exports to every child process, hook and alias, so
 *     it is present for free in a whole class of callers.
 *   - `GIT_CONFIG_COUNT=1` + `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` →
 *     `poisoned`. Same mechanism, the numbered spelling.
 *   - `GIT_DIR` pointing at another repo → that repo's
 *     `info/attributes` answered, `-C <scratch>` notwithstanding.
 *   - `GIT_ATTR_SOURCE=HEAD` → attributes read from a TREE rather than the
 *     working file that was just written, so the probe answers about the wrong
 *     content entirely.
 *
 * The gate's CI step runs from a clean runner env where none of these are set,
 * but this repo already runs `scripts/ci` gates from git hooks — where git has
 * exported `GIT_DIR` and friends into the environment itself — and the failure
 * mode is a silent PASS, so the isolation is made real rather than assumed.
 *
 * `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` are numbered and therefore
 * unbounded; {@link checkAttrEnv} strips them by shape.
 */
export const CHECK_ATTR_STRIPPED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_ATTR_SOURCE',
] as const

/**
 * `base` with everything that can redirect git's idea of "which repository" or
 * "which config" removed, then the pins applied.
 *
 * Exported so the isolation itself is testable: a test hands in an env that
 * WOULD poison the answer and asserts it does not, with an unpinned control
 * proving the poison was real.
 */
export function checkAttrEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of CHECK_ATTR_STRIPPED_ENV) delete env[key]
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key]
  }
  return { ...env, ...CHECK_ATTR_ISOLATION_ENV }
}

/**
 * Parse `git check-attr -z merge -- <paths>` output.
 *
 * The `-z` stream is a flat run of NUL-terminated fields, three per path:
 * `<path>\0merge\0<value>\0`. `unspecified` becomes `null` so callers do not
 * have to know git's spelling for "no rule".
 */
export function parseCheckAttrZ(stdout: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const fields = stdout.split('\0')
  // The trailing NUL leaves an empty final element; triples are exact otherwise.
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i]
    const value = fields[i + 2]
    if (path === undefined || value === undefined) continue
    out.set(path, value === 'unspecified' ? null : value)
  }
  return out
}

/**
 * What merge driver do the TRACKED attributes files assign to each path —
 * according to git, and as a FRESH CLONE would see it?
 *
 * Asks git rather than re-deriving its precedence, because re-deriving it is
 * what let a `.gitattributes` carrying `docs/AS_BUILT.md merge=union` followed
 * by `docs/AS_BUILT.md merge=as-built-log` report a healthy union floor while
 * git resolved `as-built-log`.
 *
 * The question is asked in a THROWAWAY repository seeded with the FULL
 * directory layout of `attributesFiles`, and both halves of that are load-
 * bearing:
 *
 *   - ALL the files, not just the root one. Measured on git 2.50.1: a root
 *     `docs/AS_BUILT.md merge=union` plus a tracked `docs/.gitattributes`
 *     saying `AS_BUILT.md merge=binary` resolves to `binary`, in the repo and
 *     in a fresh clone of it. Seeding only the root file answers `union` — a
 *     PASS over exactly the override this gate exists to catch.
 *   - Thrown away, rather than asking the real clone. The local clone may carry
 *     `$GIT_COMMON_DIR/info/attributes`, which is exactly where
 *     `scripts/install-merge-drivers.sh` binds the entry-aware driver,
 *     deliberately, because untracked outranks tracked. Asking the real clone
 *     would report `as-built-log` on every machine that ran the installer and
 *     answer a different question than the one being gated.
 *
 * The scratch repo's own `$GIT_DIR/info/attributes` is removed after `init` in
 * case a machine's `init.templateDir` ships one, and {@link checkAttrEnv} keeps
 * the caller's global/system config and repo redirection out of the answer.
 *
 * So this returns the floor every FRESH CLONE gets — measured, by cloning.
 * Whether THIS clone additionally has an upgrade installed is a separate
 * question with a separate function: {@link localEffectiveMergeDrivers}.
 */
export function resolveTrackedMergeDrivers(input: {
  attributesFiles: readonly AttributesFile[]
  paths: readonly string[]
  /**
   * Contents to place in the scratch repo's `$GIT_DIR/info/attributes`, which
   * outranks every tracked file.
   *
   * Used to ATTRIBUTE a divergence rather than assume one: re-asking with this
   * clone's real overlay layered on top answers "is the overlay what explains
   * the difference", and it answers it the same way the verdict is decided —
   * by git — so a wildcard rule in the overlay is credited correctly where a
   * substring check would have called it unexplained.
   */
  overlay?: string | null
  /**
   * Environment the probe's git processes inherit. Defaults to this process's.
   * Explicit so the isolation itself is testable. (Bun's `execFileSync` uses the
   * env snapshot taken at process start when `env` is omitted, so mutating
   * `process.env` inside a test reaches nothing — which is exactly how an
   * isolation test can pass while isolating nothing.)
   */
  env?: NodeJS.ProcessEnv
}): Map<string, string | null> {
  if (input.paths.length === 0) return new Map()

  const env = checkAttrEnv(input.env ?? process.env)
  const scratch = mkdtempSync(join(tmpdir(), 'neutron-attrs-'))
  try {
    execFileSync('git', ['init', '-q', scratch], { env, stdio: 'pipe' })
    const overlayPath = join(scratch, '.git', 'info', 'attributes')
    rmSync(overlayPath, { force: true })
    if (input.overlay != null) {
      mkdirSync(dirname(overlayPath), { recursive: true })
      writeFileSync(overlayPath, input.overlay)
    }
    for (const file of input.attributesFiles) {
      const target = join(scratch, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    // check-attr does NOT require the paths to exist on disk (measured), so the
    // scratch tree stays empty apart from the attributes files themselves.
    const stdout = execFileSync(
      'git',
      ['-C', scratch, 'check-attr', '-z', 'merge', '--', ...input.paths],
      { env, encoding: 'utf8' },
    )
    return parseCheckAttrZ(stdout)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * What merge driver does THIS clone actually use for each path — overlays and
 * all?
 *
 * Informational only, and it must stay that way: a clone that ran
 * `scripts/install-merge-drivers.sh` legitimately answers `as-built-log` here
 * while its tracked floor is intact, so a gate keying on this would fail every
 * machine that took the recommended upgrade.
 *
 * Returns `null` when `repoRoot` is not a git repository — a governed tree can
 * be checked before it is a repo (the CI script accepts any directory), and
 * "not a repo" is not a finding.
 */
export function localEffectiveMergeDrivers(
  repoRoot: string,
  paths: readonly string[],
): Map<string, string | null> | null {
  if (paths.length === 0) return new Map()
  try {
    const stdout = execFileSync(
      'git',
      ['-C', repoRoot, 'check-attr', '-z', 'merge', '--', ...paths],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return parseCheckAttrZ(stdout)
  } catch {
    return null
  }
}

/**
 * The UNTRACKED `$GIT_COMMON_DIR/info/attributes` of this clone, or `null` when
 * there is no repo or no such file.
 *
 * Read so that a divergence between this clone's answer and the tracked floor
 * can be ATTRIBUTED rather than assumed. The note used to say "this clone
 * additionally resolves, via an untracked overlay" for any divergence at all,
 * which named a file that might not exist and described a broken floor as a
 * harmless local upgrade.
 */
export function untrackedOverlayAttributes(repoRoot: string): { path: string; content: string } | null {
  let common: string
  try {
    common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
  if (common.length === 0) return null
  const path = join(common, 'info', 'attributes')
  if (!existsSync(path)) return null
  return { path, content: readFileSync(path, 'utf8') }
}
