/**
 * @neutronai/trident — every governed repo gets `merge=union` on its build log.
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
 * it silently doubles the rewrite instead of flagging it. So this module marks
 * the append-only log and NOTHING else — never `SPEC.md`, never `ISSUES.md`,
 * both of which are edited in place and want a real conflict.
 *
 * It also never overwrites an existing rule. If a repo already assigns some
 * other merge driver to its log, that is a decision someone made, and silently
 * replacing it would be the same class of mistake as the one above.
 *
 * ⚠️ NOTHING IN THIS FILE DECIDES A GATE. The parsing helpers below answer
 * "what does this text say", which is NOT the same question as "what will git
 * do", and the difference is not academic — see {@link existingMergeDriver}.
 * The pass/fail answer comes from git itself, via
 * {@link resolveTrackedMergeDrivers}.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** The comment block written above the rules the first time the file is created. */
const HEADER = [
  '# The as-built log is append-only: every change adds an entry at the top, so',
  '# two open PRs conflict by construction rather than by subject, and every',
  '# resolution is the same mechanical "keep both". `union` is git\'s built-in',
  '# driver for that shape — it takes both sides of a conflicting hunk.',
  '#',
  '# Scoped to the append-only log ON PURPOSE. Union never reports a conflict, so',
  '# pointing it at a file whose existing lines get rewritten (SPEC.md, ISSUES.md)',
  '# would silently double the rewrite instead of flagging it.',
]

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

/** Why a log path was left alone. */
export type UnionAttributeSkipReason =
  /** Already `merge=union` — nothing to do. */
  | 'already-union'
  /** Another BUILT-IN driver. Somebody's choice; safe, and not overwritten. */
  | 'builtin-driver'
  /**
   * A CUSTOM driver, in the tracked file. Not overwritten either — but this one
   * is a defect, not a preference, and the CI gate fails on it.
   */
  | 'custom-driver'

/** What one repo needs, if anything. */
export interface UnionAttributePlan {
  /** `noop` when nothing needs writing. */
  action: 'noop' | 'write'
  /** Full new `.gitattributes` content. Empty string when `action` is `noop`. */
  content: string
  /** Log paths this plan adds a rule for, in `asBuiltPaths` order. */
  added: string[]
  /** Log paths deliberately left alone, each with why. */
  skipped: Array<{ path: string; reason: UnionAttributeSkipReason }>
}

/** One `merge=` assignment found in `.gitattributes`, with where it was found. */
export interface MergeRule {
  /** 1-based line number in the file, for a diagnostic a human can act on. */
  line: number
  /** The line as written, trimmed. */
  text: string
  /** The driver named after `merge=`. */
  driver: string
}

/**
 * Every ACTIVE rule in `attributes` that assigns a merge driver to the EXACT
 * pattern `logPath`, in file order.
 *
 * A commented line does not count — an entry that was deliberately disabled
 * reads exactly like an entry that is present, and treating the two the same is
 * how a repo ends up believing it has a guard it turned off.
 *
 * Plural on purpose: a file may carry several, and which one wins is git's
 * business, not this function's.
 */
export function mergeRulesFor(attributes: string, logPath: string): MergeRule[] {
  const found: MergeRule[] = []
  const lines = attributes.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // A `.gitattributes` line is `<pattern> <attr>...`, whitespace-separated.
    const [pattern, ...attrs] = line.split(/\s+/)
    if (pattern !== logPath) continue
    for (const attr of attrs) {
      if (attr.startsWith('merge=')) {
        found.push({ line: i + 1, text: line, driver: attr.slice('merge='.length) })
        break
      }
    }
  }
  return found
}

/**
 * The driver assigned to `logPath` by the LAST exact-path rule, or `null` when
 * no active rule exists.
 *
 * ⚠️ THIS IS NOT GIT'S ANSWER AND MUST NEVER DECIDE A GATE. It is a reading of
 * one file for composing suggestion text. Git resolves the effective attribute
 * over strictly more inputs than this sees:
 *
 *   - a LATER rule wins over an earlier one (that part is modelled here now; it
 *     was not, and returning the FIRST match is how the gate reported ✅ on a
 *     `.gitattributes` whose union line had been overridden two lines below);
 *   - a later WILDCARD wins over an earlier exact path — `docs/AS_BUILT.md
 *     merge=union` followed by `docs/*.md merge=binary` resolves to `binary`,
 *     and no exact-pattern matcher can see that;
 *   - `$GIT_COMMON_DIR/info/attributes` outranks the tracked file entirely;
 *   - `core.attributesFile` and the system file cover anything left unset;
 *   - `[attr]` macros can expand into a `merge=` nobody wrote literally.
 *
 * All five measured on git 2.50.1. For the effective answer ask git:
 * {@link resolveTrackedMergeDrivers}.
 */
export function existingMergeDriver(attributes: string, logPath: string): string | null {
  const rules = mergeRulesFor(attributes, logPath)
  return rules[rules.length - 1]?.driver ?? null
}

/**
 * Decide what a repo's `.gitattributes` should become. Pure: the caller does
 * the reading and the writing, so the decision is testable without a repo.
 *
 * @param attributes existing `.gitattributes`, or `null` when the file is absent
 * @param asBuiltPaths append-only logs actually PRESENT in the repo — a rule for
 *   a file that does not exist is noise, and it is how a stale convention
 *   outlives the layout it described
 */
export function planUnionAttribute(input: {
  attributes: string | null
  asBuiltPaths: readonly string[]
}): UnionAttributePlan {
  const existing = input.attributes ?? ''
  const added: string[] = []
  const skipped: UnionAttributePlan['skipped'] = []

  for (const path of input.asBuiltPaths) {
    const driver = existingMergeDriver(existing, path)
    if (driver === null) added.push(path)
    else if (driver === 'union') skipped.push({ path, reason: 'already-union' })
    else if ((BUILT_IN_MERGE_DRIVERS as readonly string[]).includes(driver))
      skipped.push({ path, reason: 'builtin-driver' })
    else skipped.push({ path, reason: 'custom-driver' })
  }

  if (added.length === 0) return { action: 'noop', content: '', added, skipped }

  const lines = added.map(unionAttributeLine)
  if (input.attributes === null || existing.trim().length === 0) {
    return { action: 'write', content: [...HEADER, ...lines, ''].join('\n'), added, skipped }
  }

  // Append. The existing content may or may not end in a newline, and getting
  // that wrong welds the first new rule onto whatever the last line was —
  // producing a pattern that matches nothing, silently.
  const base = existing.endsWith('\n') ? existing : `${existing}\n`
  return { action: 'write', content: `${base}\n${HEADER.join('\n')}\n${lines.join('\n')}\n`, added, skipped }
}

/** Filesystem seam. Tests inject a stub; production passes real fs calls. */
export interface UnionAttributeProbe {
  /** File contents, or `null` when the file does not exist. */
  read(path: string): Promise<string | null>
  /** Whether `path` exists. */
  exists(path: string): Promise<boolean>
  /** Write `content` to `path`, creating it if needed. */
  write(path: string, content: string): Promise<void>
}

/** What `ensureUnionAttribute` did, for logging by the caller. */
export interface EnsureUnionAttributeResult {
  /** True when `.gitattributes` was written. */
  changed: boolean
  added: string[]
  skipped: UnionAttributePlan['skipped']
}

/**
 * Idempotently ensure a governed repo's append-only logs are union-merged.
 *
 * Only ever ADDS a rule for a log that is actually present and has no merge
 * rule of its own, so a second call on the same repo writes nothing. Callers
 * treat a throw as non-fatal: a build must not fail because a convenience
 * convention could not be applied.
 */
export async function ensureUnionAttribute(
  repoRoot: string,
  probe: UnionAttributeProbe,
  candidates: readonly string[] = AS_BUILT_CANDIDATES,
): Promise<EnsureUnionAttributeResult> {
  const present: string[] = []
  for (const candidate of candidates) {
    if (await probe.exists(`${repoRoot}/${candidate}`)) present.push(candidate)
  }

  const attributesPath = `${repoRoot}/.gitattributes`
  const plan = planUnionAttribute({
    attributes: await probe.read(attributesPath),
    asBuiltPaths: present,
  })

  if (plan.action === 'noop') return { changed: false, added: [], skipped: plan.skipped }
  await probe.write(attributesPath, plan.content)
  return { changed: true, added: plan.added, skipped: plan.skipped }
}

// ---------------------------------------------------------------------------
// Ask git. Everything above reads text; everything below asks the authority.
// ---------------------------------------------------------------------------

/**
 * Environment that makes `git check-attr` answer from the repository in front of
 * it and NOTHING else.
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
 * What merge driver does the TRACKED `.gitattributes` assign to each path —
 * according to git, and as a FRESH CLONE would see it?
 *
 * Asks git rather than re-deriving its precedence, because re-deriving it is
 * what let a `.gitattributes` carrying `docs/AS_BUILT.md merge=union` followed
 * by `docs/AS_BUILT.md merge=as-built-log` report a healthy union floor while
 * git resolved `as-built-log`.
 *
 * The question is asked in a THROWAWAY repository seeded with only
 * `attributes`, and that isolation is the whole design:
 *
 *   - The local clone may carry `$GIT_COMMON_DIR/info/attributes` — which is
 *     exactly where `scripts/install-merge-drivers.sh` binds the entry-aware
 *     driver, deliberately, because untracked outranks tracked. Asking the real
 *     clone would report `as-built-log` on every machine that ran the installer
 *     and answer a different question than the one being gated.
 *   - The scratch repo's own `$GIT_DIR/info/attributes` is removed after `init`
 *     in case a machine's `init.templateDir` ships one.
 *   - {@link CHECK_ATTR_ISOLATION_ENV} keeps the developer's global and system
 *     attribute files out of the answer.
 *
 * So this returns "the floor every fresh clone and GitHub's own server-side
 * merge get", which is the property the gate exists to hold. Whether THIS clone
 * additionally has an upgrade installed is a separate question with a separate
 * function: {@link localEffectiveMergeDrivers}.
 */
export function resolveTrackedMergeDrivers(input: {
  attributes: string | null
  paths: readonly string[]
  /**
   * Environment the probe's git processes inherit. Defaults to this process's.
   * Explicit so the isolation itself is testable: a test hands in an env that
   * WOULD poison the answer and asserts it does not. (Bun's `execFileSync` uses
   * the env snapshot taken at process start when `env` is omitted, so mutating
   * `process.env` inside a test reaches nothing — which is exactly how an
   * isolation test can pass while isolating nothing.)
   */
  env?: NodeJS.ProcessEnv
}): Map<string, string | null> {
  if (input.paths.length === 0) return new Map()

  const env = { ...(input.env ?? process.env), ...CHECK_ATTR_ISOLATION_ENV }
  const scratch = mkdtempSync(join(tmpdir(), 'neutron-attrs-'))
  try {
    execFileSync('git', ['init', '-q', scratch], { env, stdio: 'pipe' })
    rmSync(join(scratch, '.git', 'info', 'attributes'), { force: true })
    writeFileSync(join(scratch, '.gitattributes'), input.attributes ?? '')
    // check-attr does NOT require the paths to exist on disk (measured), so the
    // scratch tree stays empty apart from the attributes file itself.
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

/** Production probe over the real filesystem. */
export function defaultUnionAttributeProbe(): UnionAttributeProbe {
  return {
    read: async (path) => {
      const file = Bun.file(path)
      return (await file.exists()) ? await file.text() : null
    },
    exists: (path) => Bun.file(path).exists(),
    write: async (path, content) => {
      await Bun.write(path, content)
    },
  }
}
