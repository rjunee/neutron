/**
 * Architectural fence-post — the identity-env "blank is unset" claim, executed.
 *
 * `config/index.ts` (§ "THE SCOPE OF THAT CLAIM IS A GREP, NOT A MEMORY")
 * asserts that every TypeScript read of `NEUTRON_HOME` / `OWNER_HOME` /
 * `NEUTRON_DB_PATH` treats a blank — empty OR whitespace-only — value as unset,
 * and bounds that claim with a grep anyone can re-run.
 *
 * NOBODY RAN IT. That sentence has been wrong on four separate occasions, each
 * time for the same reason: the claim was verified by hand, by a reader who
 * already believed it. Round 1 said "every sibling trims" while three did not.
 * Round 2 enumerated seven sites and called the list exhaustive while five more
 * sat outside it — and NAMED `open/server.ts` as trimming when that file
 * contained no `trim()` at all. Round 3 replaced the list with a grep whose
 * pattern could not match the constant-key form in `prompts/template.ts`. Round
 * 4 claimed each trim was mutation-proved when four of them were pinned by
 * nothing. Four rounds, one mechanism: **a claim whose proof is a command in a
 * comment decays to a claim with no proof at all, and it does so silently.**
 *
 * So the command runs here, on every CI run, as a REGISTRY. Every non-test
 * TypeScript file that reads one of the three variables must appear in
 * {@link KNOWN_READERS} with a one-line note saying how it honours the rule.
 * The assertion is exact in BOTH directions:
 *
 *   - a NEW reader that nobody trimmed fails the test the day it lands, which
 *     is the failure the four rounds above kept discovering months late;
 *   - a registry row whose file stopped reading the variable ALSO fails, so the
 *     list cannot rot into a description of a tree that no longer exists — the
 *     precise way rounds 1 and 2 went wrong.
 *
 * This guard is about COMPLETENESS — which files are in scope. It deliberately
 * does not re-assert BEHAVIOUR: each reader's blank-is-unset semantics are
 * pinned per-reader, mutation-proved, in `open/__tests__/owner-slug-agreement.test.ts`,
 * `gateway/__tests__/resolve-registry-db-path.test.ts`,
 * `gateway/wiring/__tests__/build-phase-spec-resolver.test.ts`,
 * `onboarding/feedback/__tests__/m2-week-4-collector.test.ts`,
 * `runtime/adapters/claude-code/__tests__/repl-home-normalization.test.ts`,
 * `scripts/__tests__/email-accounts-cli.test.ts`, `prompts/template.test.ts` and
 * `gbrain-memory/__tests__/gbrain-doctor.test.ts`. Behaviour was the covered
 * half; the set of things that needed the behaviour was not.
 *
 * SCOPE, stated rather than implied — the same boundary `config/index.ts`
 * publishes. This walks `.ts` only, so the shell entrypoints (`install.sh`,
 * `neutron-service.sh`, `neutron-backup.sh`) are outside it and remain
 * deliberately unfixed; and it is a TEXTUAL scan, so it answers "which files
 * are in scope", never "is this particular predicate correct".
 */

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The published scope command, as patterns. Mirrors the grep in
 * `config/index.ts` verbatim, including the constant-key form that round 3's
 * version could not match.
 */
const READ_PATTERNS: ReadonlyArray<RegExp> = [
  /NEUTRON_HOME'\]/,
  /\.NEUTRON_HOME\b/,
  /OWNER_HOME'\]/,
  /\.OWNER_HOME\b/,
  /NEUTRON_DB_PATH'\]/,
  /\.NEUTRON_DB_PATH\b/,
  /OWNER_HOME_KEY/,
]

/**
 * Every non-test TypeScript file that names one of the three identity
 * variables in CODE (not in a comment), and how it honours the rule.
 *
 * A new entry is not paperwork: adding one is the moment to write the
 * behavioural pin that makes the note true, because nothing else in this file
 * checks that the note is honest.
 */
const KNOWN_READERS: Readonly<Record<string, string>> = {
  // --- Predicate-trims readers (blank -> falls through to the next tier) ---
  'migrations/db-path.ts':
    'resolveNeutronHome (NEUTRON_HOME, OWNER_HOME) + resolveOpenDbPath (NEUTRON_DB_PATH) — all three predicates trim; returns verbatim.',
  'gateway/boot-listener-registry.ts':
    'resolveRegistryDbPath (NEUTRON_HOME) + resolveOwnerHome (OWNER_HOME, NEUTRON_DB_PATH) — predicates trim; returns verbatim.',
  'onboarding/overnight/register.ts':
    'resolveOwnerHomeFromEnv (OWNER_HOME, NEUTRON_DB_PATH) — predicates trim; blank resolves to null, which the caller already handles.',
  'onboarding/feedback/m2-week-4-collector.ts':
    'resolveM2FeedbackPath (NEUTRON_HOME) — predicate trims; blank falls back to process.cwd().',
  'gateway/wiring/build-phase-spec-resolver.ts':
    'resolveSkillsDir (NEUTRON_HOME) — predicate trims; blank falls back to the documented /srv/neutron rather than the filesystem root.',
  'runtime/adapters/claude-code/index.ts':
    'resolveReplCwdAndHome (NEUTRON_HOME) — predicate trims; blank cwd AND blank home means supervision is off, deliberately.',
  'scripts/email-accounts.ts':
    'main --home guard (OWNER_HOME) — predicate trims; a blank home is REFUSED rather than opened as a directory.',
  'prompts/template.ts':
    'buildPromptVars (OWNER_HOME, via the exported OWNER_HOME_KEY constant) — predicate trims. This is the reader round 3 grep could not match.',

  // --- Trims the PREDICATE, returns the value VERBATIM ---
  'gbrain-memory/gbrain-doctor.ts':
    'resolveStatePath (NEUTRON_HOME) — predicate trims and the RETURN keeps its bytes; trimming the return silently relocated a real space-padded POSIX path.',

  // --- The composer + its shim: reads, resolves, and writes back ---
  'config/index.ts':
    'bootEnvSchema / resolveIdentityConfig read all three; effectiveOwnerHome trims; envShimFromBootConfig WRITES the resolved values back. Home of the claim this test executes.',

  // --- Re-export only, no predicate of its own ---
  'prompts/index.ts': 're-exports OWNER_HOME_KEY from prompts/template.ts; no read of its own.',
}

/** Roots that are excluded wholesale. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

/**
 * Test scaffolding is out of scope: `tests/support/test-isolation.ts` SETS all
 * three variables to point a suite at a tmpdir, which is a write, and every
 * `__tests__` file names them to drive the readers above.
 */
function isTestPath(relPath: string): boolean {
  if (relPath.endsWith('.test.ts')) return true
  if (relPath.includes('__tests__/')) return true
  if (relPath.startsWith('tests/')) return true
  return false
}

/** Recursively walk a directory, yielding repo-relative `.ts` paths. */
function* walkTsFiles(dir: string, base: string): Generator<string, void, void> {
  let entries: ReadonlyArray<string>
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    let s: import('node:fs').Stats
    try {
      s = statSync(abs)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      yield* walkTsFiles(abs, base)
      continue
    }
    if (!s.isFile()) continue
    if (!name.endsWith('.ts')) continue
    yield relative(base, abs).split(sep).join('/')
  }
}

/**
 * Strip block + line comments so a DOCBLOCK that merely discusses the variables
 * does not register as a reader.
 *
 * This is not a nicety — it is the round-3 defect in miniature. That round's
 * grep printed `prompts/template.ts` because a comment named the variable, the
 * file looked audited, and the untrimmed read below it was never opened. A hit
 * a checker cannot justify is as bad as a miss it cannot justify; it just wears
 * a tick instead of a cross. So comments do not count as reads here, and
 * `open/server.ts` — which discusses `OWNER_HOME` at length and names it
 * nowhere in code — is correctly absent from the registry.
 */
function stripComments(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      if (idx === -1) return line
      const before = line.slice(0, idx)
      const singles = (before.match(/'/g) ?? []).length
      const doubles = (before.match(/"/g) ?? []).length
      const ticks = (before.match(/`/g) ?? []).length
      if (singles % 2 !== 0 || doubles % 2 !== 0 || ticks % 2 !== 0) return line
      return line.slice(0, idx)
    })
    .join('\n')
}

function collectReaders(base: string): ReadonlyArray<string> {
  const found: string[] = []
  for (const relPath of walkTsFiles(base, base)) {
    if (isTestPath(relPath)) continue
    let body: string
    try {
      body = readFileSync(join(base, relPath), 'utf8')
    } catch {
      continue
    }
    const code = stripComments(body)
    if (READ_PATTERNS.some((p) => p.test(code))) found.push(relPath)
  }
  return found.sort()
}

test('every TypeScript reader of NEUTRON_HOME / OWNER_HOME / NEUTRON_DB_PATH is a registered, trimming reader', () => {
  const base = process.cwd()
  const actual = collectReaders(base)
  const registered = Object.keys(KNOWN_READERS).sort()

  const unregistered = actual.filter((f) => !(f in KNOWN_READERS))
  const stale = registered.filter((f) => !actual.includes(f))

  // Reported as two named arrays rather than one set-equality so the failure
  // tells the author WHICH direction broke and what to do about it. A bare
  // `toEqual` on sorted arrays prints a diff that reads identically for "you
  // added a reader" and "you deleted one", and those need opposite fixes.
  expect({ unregistered, stale }).toEqual({ unregistered: [], stale: [] })
})

test('the registry is not vacuous — the readers the four rounds missed are all in it', () => {
  // CONTROL. Without this, deleting the walker (or breaking every pattern)
  // would leave the assertion above passing on two empty arrays — a guard that
  // proves nothing while showing green, which is the exact failure shape this
  // file exists to end.
  const actual = collectReaders(process.cwd())
  expect(actual.length).toBeGreaterThanOrEqual(Object.keys(KNOWN_READERS).length)

  // Named individually because each one is a reader some earlier round's proof
  // could not see: the OTHER-two-variables pair, the constant-key form, and the
  // return-verbatim direction.
  for (const reader of [
    'migrations/db-path.ts',
    'gateway/boot-listener-registry.ts',
    'prompts/template.ts',
    'gbrain-memory/gbrain-doctor.ts',
  ]) {
    expect(actual).toContain(reader)
  }
})
