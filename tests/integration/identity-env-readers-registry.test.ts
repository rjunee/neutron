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
 *   - ANY new reader fails the test the day it lands, which is the failure the
 *     four rounds above kept discovering months late;
 *   - a registry row whose file stopped reading the variable ALSO fails, so the
 *     list cannot rot into a description of a tree that no longer exists — the
 *     precise way rounds 1 and 2 went wrong.
 *
 * WHAT THIS DOES NOT PROVE, stated first because a guard that oversells itself
 * is the defect it was built to stop. The notes in {@link KNOWN_READERS} are
 * PROSE and nothing evaluates them, so a PR CAN add an untrimmed reader plus a
 * row claiming it trims and stay green. What the guard removes is the SILENT
 * path: a new reader can no longer land unnoticed, and someone has to look at
 * it and write down what it does. That is a smaller claim than "every reader
 * trims", and it is the one this file can actually keep.
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
 * SCOPE, stated rather than implied. This walks TypeScript — `.ts`, `.tsx`,
 * `.mts`, `.cts` — so the shell entrypoints (`install.sh`, `neutron-service.sh`,
 * `neutron-backup.sh`) are outside it and remain deliberately unfixed, a
 * different blast radius written down in `config/index.ts`. And it is a TEXTUAL
 * scan, so it answers "which files are in scope", never "is this particular
 * predicate correct" — and never "is the note beside a registry row honest".
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * DELIBERATELY BROADER THAN THE COMMAND IT EXECUTES: the BARE NAME, anywhere in
 * non-comment code.
 *
 * The published grep matches access FORMS — `.NEUTRON_HOME`, `NEUTRON_HOME']`,
 * `OWNER_HOME_KEY`. Mirroring it here would inherit its blind spots and rebuild
 * round 3's bug in the guard against round 3's bug: a future reader written
 * `env["NEUTRON_HOME"]` (double quotes), `` env[`OWNER_HOME`] `` (template
 * literal), or `const { NEUTRON_HOME } = env` (destructured) matches NONE of
 * those forms and would land silently. I checked all three shapes against the
 * current tree and none exist today — which is exactly why this is the moment
 * to make them impossible rather than to note them as absent.
 *
 * The trade is deliberately asymmetric, because the two errors do not cost the
 * same. Matching the bare name also catches lines that merely NAME the variable
 * without reading it — a schema key, an error string, a template placeholder.
 * That false positive costs one registry line with a note saying what the file
 * actually does. A false negative costs a silent identity-resolution bug found
 * months later, which is the entire history of this claim. So the scan is
 * over-inclusive on purpose and the registry absorbs the difference.
 *
 * WHAT THIS STILL MISSES, stated rather than implied, and ASSERTED rather than
 * stated — both limits below have their own failing-by-design test, so if
 * either boundary ever moves the suite says so instead of quietly drifting:
 *   - a fully computed key (`env[someVariable]`) names nothing and is invisible
 *     to any textual scan; closing it needs a type-aware pass;
 *   - a `/*` inside a string literal opens a block comment as far as the regex
 *     stripper is concerned, so a read between it and the next marker is lost.
 * Neither is patched with a half-correct heuristic on purpose: a checker that
 * looks solved while still missing cases is the confidently-specific failure
 * this whole file exists to end.
 */
const READ_PATTERNS: ReadonlyArray<RegExp> = [
  /\bNEUTRON_HOME\b/,
  /\bOWNER_HOME\b/,
  /\bNEUTRON_DB_PATH\b/,
  /\bOWNER_HOME_KEY\b/,
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

  // --- NAMES the variable but does not READ it. These are the cost of scanning
  // --- the bare name (see READ_PATTERNS): each is one line here instead of a
  // --- blind spot a future reader could hide in.
  'gateway/boot-bind-policy.ts':
    'NOT a reader — names NEUTRON_HOME inside the wide-bind refusal message telling the operator which variable to fix. No env access.',
  'open/server.ts':
    'NOT a reader of its own — the boot banner interpolates the ALREADY-resolved home. The blank-is-unset predicate here is applyEnvShim, which takes the value from the frozen BootConfig rather than re-reading the env.',
  'runtime/system-prompt.ts':
    'NOT a reader — compactHomePath rewrites the literal {{OWNER_HOME}} TEMPLATE PLACEHOLDER to ~ for display. It never touches process.env.',
}

/** Roots that are excluded wholesale. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

/**
 * Test scaffolding is out of scope: `tests/support/test-isolation.ts` SETS all
 * three variables to point a suite at a tmpdir, which is a write, and every
 * `__tests__` file names them to drive the readers above.
 */
function isTestPath(relPath: string): boolean {
  // `.test.` rather than `.test.ts`, so a `.test.tsx` the widened walker now
  // reaches is excluded as scaffolding too — otherwise widening the extensions
  // would silently start demanding registry rows for test files.
  if (/\.test\.[cm]?tsx?$/.test(relPath)) return true
  if (relPath.includes('__tests__/')) return true
  if (relPath.startsWith('tests/')) return true
  return false
}

/**
 * Every TypeScript extension, not just `.ts`.
 *
 * The published grep is `--include='*.ts'`, so it never saw `.tsx` / `.mts` /
 * `.cts` — and this walker inherited that while its prose claimed "TypeScript".
 * A claim wider than its check is the defect this whole file is about, so the
 * check is widened rather than the sentence narrowed: the repo has 191 such
 * files (the web client and the mobile app among them), and a client that grows
 * a read of one of these variables is exactly the kind of new reader nobody
 * would think to look for. None name the variables today, so widening costs
 * zero registry rows and closes the hole before it has anything in it.
 */
const TS_EXTENSIONS: ReadonlyArray<string> = ['.ts', '.tsx', '.mts', '.cts']

/** Recursively walk a directory, yielding repo-relative TypeScript paths. */
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
    if (!TS_EXTENSIONS.some((ext) => name.endsWith(ext))) continue
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
export function stripComments(src: string): string {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '')

  // MULTI-LINE TEMPLATE LITERALS ARE TRACKED ACROSS LINES, because a per-line
  // quote count cannot see them and the miss is silent. A cross-model reviewer
  // demonstrated the exact failure on this function:
  //
  //     const rendered = `
  //     https://host/${env.NEUTRON_HOME}
  //     `
  //
  // The `//` in `https://` opens no comment — it is inside a template literal
  // that began on a PREVIOUS line — but a heuristic that only balances quotes
  // WITHIN a line has no way to know that, so it truncated the line and the
  // live read vanished. A false negative here is the one error this file cannot
  // afford: it is precisely "a reader nobody registered, landing silently".
  //
  // So backticks are counted cumulatively and nothing is stripped while inside
  // an unterminated template. Escaped backticks do not toggle.
  let inTemplate = false
  const out: string[] = []
  for (const line of withoutBlocks.split('\n')) {
    const startedInTemplate = inTemplate
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '\\') {
        i += 1
        continue
      }
      if (line[i] === '`') inTemplate = !inTemplate
    }

    // Inside a template on entry: keep the line verbatim. Any `//` on it is
    // string content, not a comment.
    if (startedInTemplate) {
      out.push(line)
      continue
    }

    const idx = line.indexOf('//')
    if (idx === -1) {
      out.push(line)
      continue
    }
    const before = line.slice(0, idx)
    const singles = (before.match(/'/g) ?? []).length
    const doubles = (before.match(/"/g) ?? []).length
    const ticks = (before.match(/`/g) ?? []).length
    out.push(singles % 2 !== 0 || doubles % 2 !== 0 || ticks % 2 !== 0 ? line : before)
  }
  return out.join('\n')
}

/** True when the source NAMES an identity variable in code (comments removed). */
export function namesIdentityVar(src: string): boolean {
  const code = stripComments(src)
  return READ_PATTERNS.some((p) => p.test(code))
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
    if (namesIdentityVar(body)) found.push(relPath)
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

describe('the detector itself, pinned against the forms that fooled earlier versions', () => {
  // THE DETECTOR IS THE GUARD. A registry test can only be as good as the
  // predicate that decides what a reader is, and every earlier round of this
  // claim failed at exactly that layer rather than at the layer above it. So
  // the predicate gets its own assertions, driven by fixtures rather than by
  // whatever the tree happens to contain today — the tree is evidence that a
  // form is ABSENT, never that the checker would catch it if it appeared.

  test('the access forms the published grep cannot match are all detected', () => {
    // Each of these is legal TypeScript that resolves an identity variable and
    // matches NONE of `.NEUTRON_HOME` / `NEUTRON_HOME']` / `OWNER_HOME_KEY`.
    expect(namesIdentityVar('const h = env["NEUTRON_HOME"]')).toBe(true)
    expect(namesIdentityVar('const h = env[`OWNER_HOME`]')).toBe(true)
    expect(namesIdentityVar('const { OWNER_HOME } = env')).toBe(true)
    expect(namesIdentityVar("const h = env[ 'NEUTRON_DB_PATH' ]")).toBe(true)
    expect(namesIdentityVar("const h = process.env['NEUTRON_HOME']")).toBe(true)
  })

  test('a read inside a MULTI-LINE template literal survives comment stripping', () => {
    // The cross-model reviewer's counterexample, verbatim. The `//` in the URL
    // is string content, but it sits on a line whose opening backtick is on a
    // PREVIOUS line — so a per-line quote-balance heuristic truncated here and
    // lost the read entirely. Silent, and in the one direction this file cannot
    // afford to be wrong.
    const src = ['const rendered = `', 'https://host/${env.NEUTRON_HOME}', '`'].join('\n')
    expect(namesIdentityVar(src)).toBe(true)

    // CONTROL — the stripper is still working, i.e. the assertion above passes
    // because the read survived and NOT because stripping stopped happening.
    expect(namesIdentityVar('// NEUTRON_HOME is discussed here\nconst x = 1')).toBe(false)
  })

  test('prose that merely names a variable is NOT a read', () => {
    // The round-3 defect: a docblock hit that makes a file look audited.
    expect(namesIdentityVar('/** talks about OWNER_HOME at length */\nconst x = 1')).toBe(false)
    expect(namesIdentityVar('// resolve NEUTRON_DB_PATH later\nconst x = 1')).toBe(false)
  })

  test('a block-comment marker inside a string literal is a KNOWN residual miss', () => {
    // The reviewer's second-order point about the same regex lexer: `/*` inside
    // a string opens a block comment as far as this stripper is concerned, and
    // everything to the next `*/` disappears — including a live read.
    //
    // NOT fixed, deliberately. Closing it properly needs a real lexer, and a
    // half-correct string-aware heuristic is the "confidently specific" failure
    // this repo keeps getting burned by — it would read as a solved problem
    // while still missing cases. So the limit is asserted instead of described,
    // which means it cannot rot into an unnoticed regression: if the stripper
    // ever becomes string-aware, this test fails and the documented boundary
    // has to be updated in the same change.
    const src = 'const s = "/*"\nconst h = env.NEUTRON_HOME\nconst t = "*/"'
    expect(namesIdentityVar(src)).toBe(false)

    // CONTROL — the identical read WITHOUT the string-literal markers is found,
    // so the assertion above pins the lexer limitation and not a broken pattern.
    expect(namesIdentityVar('const h = env.NEUTRON_HOME')).toBe(true)
  })

  test('a fully computed key is NOT detected, and that limit is asserted rather than assumed', () => {
    // Written as a FAILING-BY-DESIGN case so the boundary is visible in the
    // suite instead of only in prose. If a future change makes this detectable,
    // this assertion fails and the docblock's stated limit gets updated with
    // it — the claim and the check move together, which is the entire point of
    // this file.
    expect(namesIdentityVar('const key = someAlias\nconst h = env[key]')).toBe(false)
  })
})
