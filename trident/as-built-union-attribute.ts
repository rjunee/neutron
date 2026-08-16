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
 * replacing it would be the same class of mistake as the one above. But it does
 * DISTINGUISH them: another built-in driver is a preference, while a CUSTOM one
 * named in the tracked file is a defect the CI gate fails on — see
 * {@link BUILT_IN_MERGE_DRIVERS}.
 */

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
 * WHAT AN UNCONFIGURED CUSTOM DRIVER ACTUALLY DOES — measured, because the
 * previous version of this comment had it backwards and the error it quoted is
 * real but comes from somewhere else. On git 2.50.1, fresh repo, a TRACKED
 * attribute naming a driver with no `merge.<name>.*` config at all:
 *
 *     git merge --no-edit other   → CONFLICT (content) ...          exit 1
 *     git apply --3way --index    →                                 exit 0
 *
 * git FALLS BACK to its ordinary merge; it does not abort. The fatal form —
 *
 *     fatal: custom merge driver as-built-log lacks command line.   (exit 128)
 *
 * — requires `merge.<name>.name` to be set while `merge.<name>.driver` is not,
 * which is a half-written config an installer can leave behind, not a property
 * of tracking the attribute. So naming a custom driver in a committed
 * `.gitattributes` is safe for a fresh clone, an outside contributor and CI; it
 * is only pointless if the repo does not ship the driver, which is the
 * distinction `scripts/ci/check-governed-repo-attributes.ts` now draws.
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

/**
 * Does `attributes` already carry a merge rule for `logPath`?
 *
 * Returns the driver name, or `null` when no ACTIVE rule exists. A commented
 * line does not count — an entry that was deliberately disabled reads exactly
 * like an entry that is present, and treating the two the same is how a repo
 * ends up believing it has a guard it turned off.
 */
export function existingMergeDriver(attributes: string, logPath: string): string | null {
  for (const raw of attributes.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // A `.gitattributes` line is `<pattern> <attr>...`, whitespace-separated.
    const [pattern, ...attrs] = line.split(/\s+/)
    if (pattern !== logPath) continue
    for (const attr of attrs) {
      if (attr.startsWith('merge=')) return attr.slice('merge='.length)
    }
  }
  return null
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
