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
 * The assertion is exact in BOTH directions, and its unit is the FILE:
 *
 *   - a reader in a file NOT already in the registry fails the test the day it
 *     lands, which is the failure the four rounds above kept discovering months
 *     late;
 *   - a registry row whose file stopped reading the variable ALSO fails, so the
 *     list cannot rot into a description of a tree that no longer exists — the
 *     precise way rounds 1 and 2 went wrong.
 *
 * WHAT THIS DOES NOT PROVE, stated first because a guard that oversells itself
 * is the defect it was built to stop.
 *
 *   - The notes in {@link KNOWN_READERS} are PROSE and nothing evaluates them,
 *     so a PR CAN add an untrimmed reader plus a row claiming it trims and stay
 *     green. (What IS checked is that a note citing a pinning suite cites one
 *     that exists — see the test of that name.)
 *   - A SECOND read added inside an ALREADY-REGISTERED file does NOT fail
 *     anything: the file set is unchanged, and the file set is all this guard
 *     compares. Appending `export const p = process.env['NEUTRON_HOME']` to
 *     `migrations/db-path.ts` leaves the suite green, deliberately — that
 *     file's own suite owns its predicates. An earlier version of this
 *     paragraph said "ANY new reader fails", which the test named "the guard is
 *     FILE-level" disproves two hundred lines below; a cross-model reviewer
 *     pointed out that the file contradicted itself, and it did.
 *
 * What the guard removes is the SILENT path for a NEW FILE that spells the name
 * the ordinary way: it can no longer land unnoticed, and someone has to look at
 * it and write down what it does. That is a smaller claim than "every reader
 * trims", and it is the one this file can actually keep.
 *
 *   - It is smaller than "a new file can no longer land unnoticed", too, which
 *     is what this paragraph said until a cross-model reviewer supplied
 *     `process.env['NEUTRON' + '_HOME']` — a real read, in a new file, that this
 *     suite stays green on, because a concatenation puts the name in no single
 *     AST node. The class of such spellings is enumerated and pinned in the test
 *     'the spellings this detector CANNOT see are pinned'. What is proved is that
 *     no PARTICULAR FILE is blind: given the ordinary spelling, the answer never
 *     depends on which file the read landed in.
 *
 * This guard is about COMPLETENESS — which files are in scope. It deliberately
 * does not re-assert BEHAVIOUR: each reader's blank-is-unset semantics are
 * pinned per-reader, mutation-proved, in `open/__tests__/owner-slug-agreement.test.ts`,
 * `migrations/__tests__/db-path.test.ts`,
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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Repo root, derived from THIS FILE rather than from `process.cwd()`.
 *
 * The first version rooted the scan at `process.cwd()` and walked it with
 * `readdirSync`. Both halves were wrong in the same direction, and the guard
 * failed on the machine that matters most — the owner's own clone:
 *
 *   - `process.cwd()` is wherever `bun test` was invoked, so the set of files
 *     under audit depended on the caller's shell rather than on the repo;
 *   - a raw directory walk descends into sibling CHECKOUTS. `.worktrees/` and
 *     `.claude/worktrees/` hold full copies of this tree, and no `SKIP_DIRS`
 *     list enumerated them. Measured on the owner's clone: **62 phantom
 *     readers** (`.claude/worktrees/<id>/migrations/db-path.ts` and friends),
 *     every one of them this same repo seen twice, and **7111 ms** of wall
 *     clock — past bun's 5000 ms per-test timeout, so the test did not merely
 *     fail, it failed for a SECOND unrelated reason that masked the first. A
 *     clean worktree passed. A guard that only holds when you run it from an
 *     untouched checkout is a guard that gets deleted the first time someone
 *     runs it for real.
 *
 * `git ls-files` fixes both: it is the repo's own answer to "what is in this
 * tree", it excludes untracked and ignored paths (nested checkouts, build
 * output, `node_modules`) without a hand-maintained denylist that can fall
 * behind, and it is one process instead of a recursive stat storm. Same
 * approach, same reason, as `gbrain-memory/__tests__/raw-op-seam-ban.test.ts`.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Per-test budget for the three assertions that walk the whole tree.
 *
 * NOT A NUMBER PICKED TO MAKE A FAILURE GO AWAY. A reviewer's run of the
 * touched-suite set failed this file at **64056 ms against a 60000 ms budget**,
 * while the same commit on a quiet box runs the entire file in ~2.1 s. Both
 * measurements are real and they are not in conflict: `scripts/run-tests.sh`
 * loads ~100 test files into ONE process and runs them with `--max-concurrency`
 * at the physical core count, so a CPU-bound test shares the box with dozens of
 * others and its WALL CLOCK is a property of the machine's load, not of the
 * work it does. A 60 s budget was 20× the measured cost and still lost.
 *
 * Two things changed rather than one, because raising a timeout alone would be
 * exactly the "make the red go away" move this file exists to argue against:
 *
 *   1. the work itself dropped ~27% (see {@link couldNameIdentityVar}), and
 *   2. the budget went to 5 minutes — enough that a 30× contention factor over
 *      the measured cost still passes.
 *
 * The alternative was to SAMPLE the blind-file probe instead of running it over
 * every candidate. That is refused on purpose: this file's own history is four
 * rounds of a proof narrower than its claim, and a sampled probe is precisely
 * that trade made once more, for seconds.
 */
const TREE_BUDGET_MS = 300_000

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
 * stated — the limit below has its own failing-by-design test, so if the
 * boundary ever moves the suite says so instead of quietly drifting:
 *   - a fully computed key (`env[someVariable]`) names nothing and is invisible
 *     to any textual scan; closing it needs a type-aware pass.
 *
 * It is not patched with a half-correct heuristic on purpose: a checker that
 * looks solved while still missing cases is the confidently-specific failure
 * this whole file exists to end.
 *
 * There used to be several more entries here — a block-comment marker inside a
 * string literal, a regex literal containing one, a carriage-return line
 * terminator, a unicode-escaped identifier. Every one of them was a limit of a
 * HAND-WRITTEN comment stripper, and every one of them vanished when
 * {@link namesIdentityVar} was rewritten onto TypeScript's own parser. Each had
 * a failing-by-design test; each went red on that rewrite and was replaced by
 * its positive case. That is the entire reason to write a limit as an assertion
 * rather than as a sentence — the sentences would still be sitting here,
 * describing a checker that no longer exists.
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
    'resolveNeutronHome (NEUTRON_HOME, OWNER_HOME) + resolveOpenDbPath (NEUTRON_DB_PATH) — all three predicates trim; returns verbatim. Pinned in migrations/__tests__/db-path.test.ts.',
  'gateway/boot-listener-registry.ts':
    'resolveRegistryDbPath (NEUTRON_HOME) + resolveOwnerHome (OWNER_HOME, NEUTRON_DB_PATH) — predicates trim; returns verbatim. BOTH resolvers pinned in gateway/__tests__/resolve-registry-db-path.test.ts.',
  'onboarding/overnight/register.ts':
    'resolveOwnerHomeFromEnv (OWNER_HOME, NEUTRON_DB_PATH) — predicates trim; blank resolves to null, which the caller already handles.',
  'onboarding/feedback/m2-week-4-collector.ts':
    'resolveM2FeedbackPath (NEUTRON_HOME) — predicate trims; blank falls back to process.cwd().',
  'gateway/wiring/build-phase-spec-resolver.ts':
    'resolveSkillsDir (NEUTRON_HOME) — predicate trims; blank falls back to the documented /srv/neutron rather than the filesystem root.',
  'runtime/adapters/claude-code/index.ts':
    'resolveReplCwdAndHome (NEUTRON_HOME) — predicate trims; blank cwd AND blank home means supervision is off, deliberately, and now says so via repl_supervision_disabled_no_home.',
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
  'migrations/runner.ts':
    'NOT a reader of its own — names NEUTRON_HOME in the migrate-owner refusal message (telling the operator which variable let a build workspace inherit the live home) and NEUTRON_HOME/NEUTRON_DB_PATH in comments describing which file the server opens. The resolution itself is delegated to migrations/db-path.ts, which is registered above.',
}

/**
 * Every TypeScript extension, not just `.ts`.
 *
 * The published grep is `--include='*.ts'`, so it never saw `.tsx` / `.mts` /
 * `.cts` — and the first walker inherited that while its prose claimed
 * "TypeScript". A claim wider than its check is the defect this whole file is
 * about, so the check is widened rather than the sentence narrowed: the repo
 * has 191 such files (the web client and the mobile app among them), and a
 * client that grows a read of one of these variables is exactly the kind of new
 * reader nobody would think to look for. None name the variables today, so
 * widening costs zero registry rows and closes the hole before it has anything
 * in it.
 */
const TS_PATHSPECS: ReadonlyArray<string> = ['*.ts', '*.tsx', '*.mts', '*.cts']

/** Repo-relative TypeScript files that are TRACKED — the repo's own file list. */
function trackedTsFiles(): ReadonlyArray<string> {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...TS_PATHSPECS], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return out.split('\0').filter((l) => l.length > 0)
}

/**
 * The SAME question asked without the pathspecs — every tracked path, filtered
 * by extension here instead of by `git`.
 *
 * This exists because the count assertions below cannot see a NARROWED SCOPE. A
 * reviewer put it exactly: drop `'*.tsx'` and `'*.mts'` from {@link
 * TS_PATHSPECS} and the guard stays green — `audited.length` is still far over
 * its floor and every registered reader is still found, because every one of
 * them happens to be a `.ts` file. 189 `.tsx` files and 2 `.mts` files would
 * simply stop being audited, silently, and the prose above would go on claiming
 * "every TypeScript extension". A threshold cannot catch that; only a
 * DIFFERENTLY-COMPUTED answer can.
 *
 * So the enumeration is checked against an independent one rather than against
 * a number. The two share no pathspec: one asks `git` to filter, the other asks
 * `git` for everything and filters in TypeScript. A dropped or mistyped pathspec
 * breaks the equality — that much is measured, and the failure names the missing
 * files.
 *
 * WHAT IT DOES NOT CATCH, since the first version of this paragraph claimed
 * more: deleting the `--` separator changes nothing here. A reviewer ran both
 * commands without it and the NUL-delimited output was byte-identical, because
 * none of these pathspecs is ambiguous with a ref. And both sides ask GIT'S
 * INDEX, so an untracked reader is invisible to each — intended (this guard is
 * scoped to tracked files) but not a property this comparison proves.
 */
function trackedTsFilesByExtension(): ReadonlyArray<string> {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return out
    .split('\0')
    .filter((l) => l.length > 0)
    .filter((l) => /\.(ts|tsx|mts|cts)$/.test(l))
}

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
 * Does this source NAME an identity variable in CODE — not in a comment?
 *
 * THE DETECTOR USES TYPESCRIPT'S OWN PARSER, and it does so because the two
 * hand-written versions before it were both wrong in the direction that costs
 * the most.
 *
 * Round 1 stripped block comments with a regex and then balanced quotes per
 * line. Round 2 replaced that with a cumulative `inTemplate` flag, which was
 * unbounded file-scope state: **24 of 1156 non-test files ended the scan
 * desynchronised**, two of them registered readers. Round 3 — this one — began
 * as a hand-rolled mode-stack lexer that claimed to FAIL OPEN, i.e. to be
 * incapable of losing a read. **A cross-model reviewer falsified that claim
 * three ways in one pass, and every one of them reproduced:**
 *
 *   - `const a = /[/*]/` … `const b = /a*​/` — a regex literal containing `/*`
 *     and a later one containing the closing marker. The lexer read the span
 *     between them as a block comment and deleted the live read inside it.
 *   - `'// prose\rconst h = process.env.NEUTRON_HOME'` — a CARRIAGE RETURN ends
 *     a line comment in JavaScript. The lexer scanned to the next `\n`, so the
 *     whole following statement vanished. U+2028 / U+2029 are the same class.
 *   - an identifier that spells one of the names with a UNICODE ESCAPE for a
 *     single character (the `_` written as its escape) is the same property to
 *     the language, and no regex over raw text can see it. Spelled out in words
 *     rather than shown, because the literal form of this example was silently
 *     normalised back into the plain letter once already — a reviewer found the
 *     escape missing from this very line, which made the illustration an
 *     illustration of nothing. The EXECUTABLE fixtures below keep the real
 *     bytes; a docblock cannot be trusted to.
 *
 * Each is legal TypeScript that Bun executes, and each produced a SILENT FALSE
 * NEGATIVE — precisely "a reader nobody registered, landing silently", which is
 * the failure this whole file exists to end, rebuilt inside the checker for the
 * third round running.
 *
 * The lesson is not "the lexer had bugs", it is that **a hand-written lexer for
 * a language this size will always have bugs, and the ones that matter are
 * invisible.** So the checker no longer has a lexer. `ts.createSourceFile`
 * parses the file and the walk reads only nodes that carry program text:
 * identifiers (whose `.text` is unicode-UNESCAPED for us), string and template
 * literals (whose `.text` is the COOKED value), and JSX text. Comments are
 * trivia and never appear in that walk, so they are excluded structurally
 * rather than by a pattern that has to be right. Regex literals, every line
 * terminator, nested templates and JSX are the parser's problem, and it is a
 * problem the parser has already solved. Same dependency and same reasoning as
 * `gbrain-memory/__tests__/raw-op-seam-ban.test.ts`, which parses rather than
 * greps for exactly this reason.
 *
 * IT STILL FAILS OPEN, and now the claim is one the implementation can keep:
 * if the parser reports ANY syntax error, the raw source is pattern-matched
 * instead. A file the checker cannot parse is over-reported (one annotated
 * registry row) rather than skipped (a silent hole).
 *
 * WHAT REMAINS UNCATCHABLE, stated rather than implied: a key that is genuinely
 * COMPUTED at runtime (`env[someAlias]`) names nothing in the program text, and
 * no syntactic pass can see it — that needs type-aware analysis. It has a
 * failing-by-design test below, so if it ever becomes detectable the assertion
 * breaks and this paragraph has to move with it.
 */
function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.mts')) return ts.ScriptKind.TS
  if (fileName.endsWith('.cts')) return ts.ScriptKind.TS
  return ts.ScriptKind.TS
}

/** True when any READ_PATTERN matches this piece of program text. */
function matchesIdentityName(text: string): boolean {
  return READ_PATTERNS.some((p) => p.test(text))
}

/**
 * The SHAPE of an HTML/JSX character reference — numeric, hex, or named.
 *
 * Deliberately matches every entity, including the ones {@link decodeJsxEntities}
 * does not translate, because {@link couldNameIdentityVar} uses it to decide
 * whether a file may be SKIPPED. A shape that matched only the entities we decode
 * would have to be right about that set to stay sound; this one does not.
 *
 * NOT global: a `g` regex carries `lastIndex` across `.test()` calls, so a shared
 * one answers differently on the same input depending on what it was asked
 * before. That is the sort of state a guard cannot afford.
 */
const JSX_ENTITY_SHAPE = /&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/

/**
 * Named entities that can spell a character appearing in one of the
 * {@link READ_PATTERNS} names.
 *
 * COMPLETE, not a sample, and that is checkable rather than hopeful: those names
 * are built from uppercase ASCII letters and `_`, HTML defines no named reference
 * for a bare ASCII letter, and `lowbar` / `UnderBar` are the only two it defines
 * for `_`. Every other named entity resolves to punctuation or a non-ASCII
 * character, and neither can appear INSIDE one of these names.
 *
 * WIDER THAN THIS COMPILER, on purpose, and that is worth stating because it
 * makes one assertion below look stronger than the toolchain warrants.
 * TypeScript's own JSX entity decoder (`typescript@5.9.3`) carries a 253-entry
 * table that does NOT include `lowbar` or `UnderBar`, and accepts only a
 * lowercase `x` in hex references — so `&lowbar;` and `&#X5F;` reach a real
 * `.tsx` build UNDECODED. This table decodes them anyway. The direction is
 * deliberate: this predicate exists to decide whether a file may be SKIPPED, so
 * over-reporting costs one annotated registry row and under-reporting is the
 * whole bug. A reader who follows the fixture for `&lowbar;` down to the
 * compiler and finds no such decoding has found this note, not a defect.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = { lowbar: '_', UnderBar: '_' }

/**
 * Decode the character references JSX itself decodes, for the two positions in
 * which it decodes them.
 *
 * TYPESCRIPT DOES NOT DO THIS FOR US, and that is the whole reason this exists.
 * A cross-model reviewer reported the opposite — that `JsxText.text` arrives
 * entity-DECODED, making {@link couldNameIdentityVar} a false negative that the
 * walk would otherwise have caught. Measured on this tree before writing a line
 * of fix: `<p>NEUTRON&#95;HOME</p>` parsed as TSX yields a `JsxText` whose
 * `.text` is the literal `NEUTRON&#95;HOME`, and a `title="NEUTRON&#95;HOME"`
 * attribute yields a `StringLiteral` with the same raw value. Controls in the
 * same measurement: plain `<p>NEUTRON_HOME</p>` and a unicode-escaped identifier
 * were both seen, so the probe could return a positive.
 *
 * So the prefilter was NOT out of step with the walk — the WALK could not see an
 * entity-spelled name either, and skipping the parse changed no answer. The hole
 * the report points at is real all the same, one level over: JSX decodes these
 * references when it emits, so a component rendering `NEUTRON&#95;HOME` names the
 * variable to every human who reads the UI and to nothing in this checker. Both
 * halves are fixed together, because fixing either alone is still a hole — the
 * walk now decodes, and {@link couldNameIdentityVar} stops skipping the files it
 * would have to decode.
 */
function decodeJsxEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(
    /&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g,
    (whole, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X'
        const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
        // An out-of-range or unparseable code point is left AS WRITTEN rather
        // than turned into a replacement character: the raw form still carries
        // the `&`/`;` delimiters, so it can only fail to match, never match
        // something it should not.
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole
        return String.fromCodePoint(code)
      }
      return NAMED_ENTITIES[body] ?? whole
    },
  )
}

/**
 * Can this source POSSIBLY name an identity variable once the parser has cooked
 * it? A `false` here is a parse skipped, and it is the only reason this guard
 * fits inside a per-test budget on a contended box.
 *
 * SOUND, not heuristic, and the argument matters because a wrong prefilter is a
 * silent false negative — the exact defect class this file exists to end. The
 * walk in {@link namesIdentityVar} reads ONLY cooked program text: identifier
 * `.text`, string/template `.text`, JSX text, regex `.text`. Every one of those
 * is built from the source bytes, so there are exactly TWO ways a value the walk
 * matches can hold a character the source does not literally contain, and this
 * predicate has one arm for each:
 *
 *   1. A LANGUAGE ESCAPE — `\u`, `\u{…}`, `\x`, an octal escape, or a
 *      `\`-newline line continuation. Every one of them contains a BACKSLASH.
 *   2. A JSX CHARACTER REFERENCE in JSX text or a JSX attribute value, which
 *      {@link decodeJsxEntities} translates because TypeScript does not. Every
 *      one of them matches {@link JSX_ENTITY_SHAPE}. This arm was ADDED after a
 *      cross-model review; the fuller account, including what the report got
 *      wrong about it, is on {@link decodeJsxEntities}.
 *
 * So a file with no backslash, no entity shape, and none of the four names in its
 * raw bytes cannot produce a match under any parse, and skipping it changes no
 * answer.
 *
 * Two fixtures below are the pins that keep this honest rather than merely
 * argued — `a UNICODE-ESCAPED identifier is the same property` for arm 1 and
 * `a JSX CHARACTER REFERENCE spells the name` for arm 2. Drop either arm and the
 * matching test goes red rather than the audited tree quietly shrinking.
 *
 * MEASURED on this tree: 719 of the 1160 audited files (62%) skip the parser,
 * and the file's standalone wall clock goes from 2.85 / 2.93 / 3.80 s to
 * 2.10 / 2.13 / 2.28 s (three runs each, same box, same commit — measured when
 * arm 1 was the only arm). Adding arm 2 moved the skip count by FIVE files
 * (724 -> 719): four `.tsx` screens carrying one `&apos;` each in user-facing
 * copy, and one HTML-escaping helper holding the five standard escapes. That is
 * the whole cost of the soundness. The
 * remaining cost is the blind-file probe, which parses every candidate a second
 * time on purpose — see the note on its budget below.
 */
function couldNameIdentityVar(src: string): boolean {
  return matchesIdentityName(src) || src.includes('\\') || JSX_ENTITY_SHAPE.test(src)
}

export function namesIdentityVar(src: string, fileName = 'probe.ts'): boolean {
  if (!couldNameIdentityVar(src)) return false
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(fileName),
  )

  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    // Identifiers carry the UNESCAPED name, so `NEUTRON_HOME` arrives here
    // as `NEUTRON_HOME` without the checker knowing escapes exist.
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (matchesIdentityName(node.text)) found = true
      return
    }
    // String + template literals carry the COOKED value, which covers
    // `env["NEUTRON_HOME"]`, an error message that names the variable, and a
    // `{{OWNER_HOME}}` template placeholder alike.
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      if (matchesIdentityName(node.text)) found = true
      return
    }
    // JSX TEXT IS DECODED BEFORE MATCHING, because JSX decodes it before
    // rendering it and TypeScript does not decode it for us — see
    // {@link decodeJsxEntities}. Matched raw as well: the raw arm is what catches
    // a plain `<p>NEUTRON_HOME</p>`, and keeping both means the decode can only
    // add answers, never remove one.
    if (ts.isJsxText(node)) {
      if (matchesIdentityName(node.text) || matchesIdentityName(decodeJsxEntities(node.text)))
        found = true
      return
    }
    // A JSX ATTRIBUTE VALUE is the other position JSX decodes. Handled on the
    // ATTRIBUTE rather than on the string literal because `setParentNodes` is
    // false, so a `StringLiteral` cannot be asked whether it is in JSX — and
    // decoding every string literal in the program would invent matches the
    // language does not, in a file that asserts nothing is over-reported. No
    // early `return`: the attribute's name and any expression container still
    // need walking.
    if (ts.isJsxAttribute(node)) {
      const init = node.initializer
      if (
        init !== undefined &&
        ts.isStringLiteral(init) &&
        matchesIdentityName(decodeJsxEntities(init.text))
      )
        found = true
    }
    // REGEX LITERALS ARE PROGRAM TEXT TOO. Omitting them was a real false
    // negative on the very first run of the parser-based detector, and the
    // registry test caught it: `runtime/system-prompt.ts:130` matches the
    // `{{OWNER_HOME}}` placeholder with `/\{\{OWNER_HOME\}\}/g`, and dropping
    // it moved that file from `readers` into `stale`. A pattern naming an
    // identity variable is exactly the kind of reference this registry wants
    // annotated, and it is the shape a future reader could most easily hide in.
    if (ts.isRegularExpressionLiteral(node)) {
      if (matchesIdentityName(node.text)) found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (found) return true

  // FAIL OPEN, AND IT USED TO BE THE OTHER WAY ROUND — which made it a false
  // negative rather than a fallback.
  //
  // The previous shape returned `matchesIdentityName(src)` on any parse
  // diagnostic and NEVER WALKED THE TREE. The cross-model reviewer broke it in
  // one line: the parser RECOVERS from most syntax errors, so a file that both
  // fails to parse AND spells the name with an escape has a perfectly good
  // identifier node whose `.text` is the real name, while the raw text matches
  // nothing. Reproduced exactly as reported —
  // `const h = process.env.NEUTRON_HOME` followed by `function ((( {`
  // gave three diagnostics, a recovered identifier reading `NEUTRON_HOME`, and
  // a final answer of `false`. A silent miss, in the branch whose whole purpose
  // was to make silent misses impossible.
  //
  // So the walk runs FIRST and unconditionally: whatever tree the parser
  // recovered is inspected, and the raw match is an ADDITIONAL arm for the case
  // where recovery dropped the node entirely. Two chances to over-report, no
  // path that skips both. `parseDiagnostics` is not in the public typings, so it
  // is read defensively.
  const diagnostics = (sf as unknown as { parseDiagnostics?: ReadonlyArray<unknown> })
    .parseDiagnostics
  if (diagnostics !== undefined && diagnostics.length > 0) return matchesIdentityName(src)
  return false
}

/**
 * Every non-test tracked TypeScript file, as `[repoRelativePath, source]`.
 *
 * Memoised: four assertions below need the same ~1100 files, and re-reading
 * them per test put the suite within a few hundred milliseconds of bun's
 * 5000 ms per-test timeout. A guard that fails on a slow machine for a reason
 * unrelated to what it guards teaches people to re-run it until it is green.
 */
let auditedCache: ReadonlyArray<readonly [string, string]> | null = null
/**
 * Tracked paths that could not be read, in audit order.
 *
 * SEPARATE FROM THE SKIP, and that separation is the fix for a real fail-open.
 * This loop used to `continue` on a read failure behind the comment "a tracked
 * path that cannot be read is a checkout race, not a reader" — which is an
 * assumption, not a measurement, and it is the exact shape of defect this file
 * exists to end: an unreadable file is one whose contents nobody looked at, so
 * calling it a non-reader is a guess that fails in the unsafe direction. The
 * audited set shrank by one and no assertion could tell, because the only
 * cardinality check here is a `> 500` floor that a single omission cannot trip.
 *
 * So the skip stays (a genuine mid-run checkout race must not turn the suite
 * red at a random file) but it is now RECORDED, and a test below asserts this
 * list is empty. A race gets a name and a path instead of silence.
 */
let unreadableCache: ReadonlyArray<string> | null = null
function auditedSources(): ReadonlyArray<readonly [string, string]> {
  if (auditedCache !== null) return auditedCache
  const out: Array<readonly [string, string]> = []
  const unreadable: Array<string> = []
  for (const relPath of trackedTsFiles()) {
    if (isTestPath(relPath)) continue
    let body: string
    try {
      body = readFileSync(join(ROOT, relPath), 'utf8')
    } catch (err) {
      // The repo-relative path plus the errno CODE, never the thrown message:
      // Node builds that message around the ABSOLUTE path, which embeds the
      // account name and would put it in CI output on the day this fires.
      const code = (err as { code?: string } | null)?.code
      unreadable.push(`${relPath} (${code ?? 'unknown'})`)
      continue
    }
    out.push([relPath, body])
  }
  auditedCache = out
  unreadableCache = unreadable
  return out
}

function unreadableSources(): ReadonlyArray<string> {
  auditedSources()
  return unreadableCache ?? []
}

/**
 * Memoised for the same reason as {@link auditedSources}, one layer up: three
 * assertions need this set, and PARSING ~1150 files is materially more work
 * than reading them. The first parser-based run spent 4810 ms inside a 5000 ms
 * per-test budget — a guard that trips its own timeout on a slow machine is a
 * guard people learn to re-run rather than read.
 */
let readersCache: ReadonlyArray<string> | null = null
function collectReaders(): ReadonlyArray<string> {
  if (readersCache !== null) return readersCache
  readersCache = auditedSources()
    .filter(([relPath, body]) => namesIdentityVar(body, relPath))
    .map(([relPath]) => relPath)
    .sort()
  return readersCache
}

test('every NON-TEST tracked TypeScript file was READ — an unreadable one is named, not skipped', () => {
  // NON-TEST, because {@link isTestPath} filters tracked test files out BEFORE
  // the read, so an unreadable test file never reaches this list and the word
  // "EVERY" was wider than the check. A cross-model reviewer caught that on the
  // very commit that added this test to fix the same defect elsewhere in the
  // file — which is the honest measure of how easily this class of overclaim is
  // written, and the reason it is worth a title rather than a comment.
  // The companion to the `> 500` floor below, and the reason it is a separate
  // test: that floor is a cardinality check coarse enough that dropping ONE file
  // cannot trip it, so a read failure used to shrink the audited set in silence.
  // See {@link unreadableCache} for the fail-open this closes.
  expect(unreadableSources()).toEqual([])

  // CONTROL — the reader actually ran, so an empty list above means "nothing
  // failed" and not "the loop never executed".
  expect(auditedSources().length).toBeGreaterThan(500)
})

test('every NON-TEST tracked TypeScript file that names NEUTRON_HOME / OWNER_HOME / NEUTRON_DB_PATH is in the registry', () => {
  // NON-TEST IS IN THE TITLE because it is in the body: {@link isTestPath}
  // excludes tracked test files from the audited set, and a title reading "every
  // TypeScript file" claimed a scope this check does not have. That is the same
  // defect as the one this test was already rewritten once to fix — a title
  // wider than its assertion — so it is fixed the same way, by narrowing the
  // words rather than stretching the check.
  //
  // THE TITLE IS THE ASSERTION, and it used to be wider than it. This test read
  // "…is a registered, TRIMMING reader" while its body compares two lists of
  // FILENAMES and never executes a predicate, so nothing here could tell a
  // trimming reader from an untrimmed one. A reviewer refused the word, and the
  // word is gone rather than the check being stretched to cover it: what this
  // guard owns is MEMBERSHIP — every file that touches these three variables is
  // named, with a note saying how it behaves. The behaviour behind each note is
  // pinned by that file's own suite, and the test below
  // ('every registry note that cites a pinning suite cites one that exists')
  // is what stops a note from citing a suite that is not there.
  const actual = collectReaders()
  const registered = Object.keys(KNOWN_READERS).sort()

  const unregistered = actual.filter((f) => !(f in KNOWN_READERS))
  const stale = registered.filter((f) => !actual.includes(f))

  // Reported as two named arrays rather than one set-equality so the failure
  // tells the author WHICH direction broke and what to do about it. A bare
  // `toEqual` on sorted arrays prints a diff that reads identically for "you
  // added a reader" and "you deleted one", and those need opposite fixes.
  expect({ unregistered, stale }).toEqual({ unregistered: [], stale: [] })
}, TREE_BUDGET_MS)

test('the registry is not vacuous — the readers the four rounds missed are all in it', () => {
  // CONTROL. Without this, deleting the walker (or breaking every pattern)
  // would leave the assertion above passing on two empty arrays — a guard that
  // proves nothing while showing green, which is the exact failure shape this
  // file exists to end.
  //
  // The file COUNT is asserted too, because the walker changed from a directory
  // crawl to `git ls-files` and the new failure mode is different in kind: a
  // pathspec typo, a wrong `cwd`, or a `git` that errors into an empty string
  // yields zero files rather than too many, and zero files is indistinguishable
  // from a clean tree at the assertion above.
  const audited = auditedSources()
  expect(audited.length).toBeGreaterThan(500)

  const actual = collectReaders()
  expect(actual.length).toBeGreaterThanOrEqual(Object.keys(KNOWN_READERS).length)

  // …AND THE SCOPE ITSELF, which no count above can see. Both assertions stay
  // green if `'*.tsx'` / `'*.mts'` are dropped from TS_PATHSPECS, because every
  // registered reader is a `.ts` file — 191 files would stop being audited and
  // nothing would say so. Compared against the independently-computed list
  // instead: same question, no shared pathspec.
  expect([...trackedTsFiles()].sort()).toEqual([...trackedTsFilesByExtension()].sort())

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
}, TREE_BUDGET_MS)

test('NO FILE IS BLIND TO A PLAINLY-SPELLED READ — the answer cannot depend on which file', () => {
  // THE TITLE NAMES THE SPELLING, because the check uses ONE spelling and an
  // earlier title ("a new reader in any UNREGISTERED file is detected") promised
  // every spelling. A cross-model reviewer supplied the counterexample:
  //
  //   export const h = process.env['NEUTRON' + '_HOME']
  //
  // lands in an unregistered file and this suite stays green, because a
  // concatenation puts the name in no single AST node. That is a DETECTOR limit,
  // pinned as a failing-by-design fixture in 'the spellings this detector CANNOT
  // see are pinned', not a per-file blind spot — and the difference is the whole
  // content of this test. What is proved here is the property that would make the
  // guard worthless if it failed: FILE-INDEPENDENCE. Given a read spelled the
  // ordinary way, no audited file hides it.
  //
  // The claim this guard rests on is "a new reader fails the test the day it
  // lands". A reviewer challenged exactly that, reporting that a read appended
  // to one file was caught while the byte-identical read appended to another
  // was not — i.e. that the answer depended on which file you picked. If that
  // is ever true the guard is worthless, because the one file that hides a read
  // is the one a future reader will happen to edit.
  //
  // So it is measured, over the whole audited set, on every run: each currently
  // UNREGISTERED file is asked whether a reader landing in it tomorrow would be
  // seen. A single `false` names the file.
  //
  // THE BEFORE/AFTER DELTA IS ASSERTED PER FILE, not globally. An earlier
  // version of this test appended the probe to EVERY audited file including the
  // fifteen already in the registry — and for those, the "detected" answer was
  // already true before the probe was added, so they contributed nothing while
  // looking like coverage. A second reviewer caught that: the assertion held
  // vacuously for exactly the files whose membership the registry already
  // knows. Restricting to unregistered files makes every element of the set a
  // real false→true transition.
  const appended = "\nexport const probeOwnerHome = process.env['NEUTRON_HOME']\n"
  const candidates = auditedSources().filter(([relPath]) => !(relPath in KNOWN_READERS))

  const wronglyDetectedBefore = candidates
    .filter(([relPath, body]) => namesIdentityVar(body, relPath))
    .map(([relPath]) => relPath)
  // Every candidate must be a genuine false BEFORE, or the transition below is
  // not a transition. (This can only fire if the registry test is also failing.)
  expect(wronglyDetectedBefore).toEqual([])

  const blind = candidates
    .filter(([relPath, body]) => !namesIdentityVar(body + appended, relPath))
    .map(([relPath]) => relPath)
  expect(blind).toEqual([])

  // ANTI-VACUITY — the candidate set is the whole tree minus the registry, so
  // if the walker or the filter ever collapses it this assertion says so rather
  // than passing on an empty list.
  expect(candidates.length).toBeGreaterThan(500)
}, TREE_BUDGET_MS)

test('the guard is FILE-level, and that limit is asserted rather than assumed', () => {
  // A SECOND reader added to an ALREADY-REGISTERED file does NOT fail the
  // registry test: the set of reader FILES is unchanged, and the set of files
  // is the only thing this guard compares. A reviewer raised it as a hole in
  // the "any new reader fails" claim, and they were right about the mechanic —
  // so the claim is narrowed to what is true and the mechanic is pinned here,
  // where it cannot quietly become something else.
  //
  // It is the correct scope rather than a shortfall to fix. The registry's job
  // is to force every file that touches these variables to be SEEN and
  // described; the per-predicate behaviour inside a file already-known to be a
  // reader is pinned by that reader's own suite, which is where a second
  // predicate in the same file gets its coverage.
  const [firstRegistered] = Object.keys(KNOWN_READERS)
  const body = auditedSources().find(([relPath]) => relPath === firstRegistered)?.[1]
  expect(body).toBeDefined()

  // Already a reader before, still a reader after — no file-set change, so the
  // registry assertion is unaffected in BOTH directions.
  expect(namesIdentityVar(body as string, firstRegistered as string)).toBe(true)
  expect(
    namesIdentityVar(
      (body as string) + "\nexport const second = process.env['NEUTRON_HOME']\n",
      firstRegistered as string,
    ),
  ).toBe(true)
})

test('every registry note that cites a pinning suite cites one that exists', () => {
  // THE OTHER HALF OF NARROWING THE TITLE ABOVE. Membership is checked
  // mechanically; the BEHAVIOUR each note describes is pinned by the suite the
  // note names — and until now nothing checked that the named suite was real.
  // A note reading "Pinned in migrations/__tests__/db-path.test.ts" is a
  // citation, and an uncheckable citation is exactly the shape of claim this
  // whole file exists to stop trusting: it stays convincing after the file it
  // names is renamed, moved or deleted.
  //
  // Deliberately NOT a requirement that every row cite a suite. Four rows are
  // "NOT a reader" annotations with no behaviour to pin, and one is a
  // re-export; demanding a citation there would invite a fake one. What is
  // enforced is that a citation, once made, resolves.
  const cited: Array<[string, string]> = []
  for (const [file, note] of Object.entries(KNOWN_READERS)) {
    for (const m of note.matchAll(/[\w./-]+\.test\.[cm]?tsx?/g)) {
      cited.push([file, m[0]])
    }
  }

  // ANTI-VACUITY — if the notes ever stop citing suites, this test must say so
  // rather than pass on an empty list.
  expect(cited.length).toBeGreaterThanOrEqual(2)

  const missing = cited.filter(([, suite]) => !existsSync(join(ROOT, suite)))
  expect(missing).toEqual([])
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

  test('a block-comment marker inside a string literal no longer eats the read', () => {
    // This assertion USED to read `.toBe(false)`, written as a failing-by-design
    // pin on a known residual miss with the note "if the stripper ever becomes
    // string-aware, this test fails and the documented boundary has to be
    // updated in the same change". The stripper became string-aware; the test
    // failed; the boundary moved here. That is the mechanism working, and it is
    // worth more than the assertion it replaced.
    const src = 'const s = "/*"\nconst h = env.NEUTRON_HOME\nconst t = "*/"'
    expect(namesIdentityVar(src)).toBe(true)

    // CONTROL — a REAL block comment still strips, so the line above passes
    // because the lexer understands strings and NOT because stripping stopped.
    expect(namesIdentityVar('/* const h = env.NEUTRON_HOME */\nconst x = 1')).toBe(false)
  })

  test('file-scope state cannot desync: a stray backtick does not swallow later code', () => {
    // THE 24-OF-1156 DEFECT, in three lines. The old stripper toggled one
    // cumulative `inTemplate` boolean on every backtick it met — including ones
    // inside comments and inside quoted strings — and never resynchronised, so
    // a single stray tick changed how every following line was treated, to the
    // end of the file.
    expect(namesIdentityVar('// the ` character\nconst h = env.NEUTRON_HOME')).toBe(true)
    expect(namesIdentityVar('const tick = "`"\nconst h = env.OWNER_HOME')).toBe(true)
    expect(namesIdentityVar('/** a ` tick */\nconst h = env.NEUTRON_DB_PATH')).toBe(true)

    // ...and the same stray tick must not START counting comments as code
    // either — the other direction of the same desync.
    expect(namesIdentityVar('const tick = "`"\n// NEUTRON_HOME in prose\nconst x = 1')).toBe(false)
  })

  test('a template literal returns to CODE inside an interpolation, and to string outside it', () => {
    // An interpolation re-enters code, so a comment there is still a comment...
    expect(namesIdentityVar('const s = `a${/* NEUTRON_HOME */ 1}b`')).toBe(false)
    // ...while text in the template body is content, never a comment.
    expect(namesIdentityVar('const s = `// NEUTRON_HOME`\nconst x = 1')).toBe(true)
    // Nested braces inside an interpolation must not close it early.
    expect(namesIdentityVar('const s = `${ {a: 1} } // NEUTRON_HOME`')).toBe(true)
  })

  test('REGEX LITERALS do not open comments — the reviewer counterexample', () => {
    // The hand-written lexer's fatal case, kept as a fixture because it is the
    // reason there is no hand-written lexer any more. `/[/*]/` contains a raw
    // `/*` and `/a*​/` a raw `*​/`, so a lexer without regex support reads the
    // span between them as one block comment and DELETES the live read inside.
    // Measured on the previous implementation: stripped output was
    // `"const env = process.env\nconst a = /[\n\n"` and the answer was `false`.
    const src = [
      'const env = process.env',
      'const a = /[/*]/',
      'const h = env.NEUTRON_HOME',
      'const b = /a*/',
    ].join('\n')
    expect(namesIdentityVar(src)).toBe(true)

    // CONTROL — a REAL block comment around the same read is still excluded, so
    // the line above passes because regex literals are understood and NOT
    // because comment handling was abandoned.
    expect(namesIdentityVar('/* const h = env.NEUTRON_HOME */\nconst x = 1')).toBe(false)

    // The TSX shape of the same trap.
    expect(
      namesIdentityVar(
        'const x = <div>/*{process.env.NEUTRON_HOME}*/</div>\n',
        'probe.tsx',
      ),
    ).toBe(true)
  })

  test('EVERY legal line terminator ends a line comment, not just \\n', () => {
    // A CARRIAGE RETURN ends a line comment in JavaScript. The previous lexer
    // scanned to the next `\n`, so on a CR-terminated file the entire following
    // statement was swallowed — silently, and only on files nobody would think
    // to test. U+2028 / U+2029 are the same class.
    // LINE FEED FIRST, because "EVERY" in the title has to include the ordinary
    // one. It was the only terminator this body did not exercise, which left the
    // common case resting on the three exotic ones happening to pass.
    expect(namesIdentityVar('// prose\nconst h = process.env.NEUTRON_HOME')).toBe(true)
    expect(namesIdentityVar('// prose\r\nconst h = process.env.NEUTRON_HOME')).toBe(true)

    expect(namesIdentityVar('// prose\rconst h = process.env.NEUTRON_HOME')).toBe(true)
    expect(namesIdentityVar('// prose const h = process.env.NEUTRON_HOME')).toBe(true)
    expect(namesIdentityVar('// prose const h = process.env.NEUTRON_HOME')).toBe(true)

    // CONTROL — with no terminator at all it really is all comment.
    expect(namesIdentityVar('// prose const h = process.env.NEUTRON_HOME')).toBe(false)
  })

  test('a UNICODE-ESCAPED identifier is the same property, and is detected', () => {
    // `NEUTRON_HOME` IS `NEUTRON_HOME` to the language, and no pattern over
    // raw text can see it. The parser hands back the unescaped name, so this
    // needs no special case — which is the argument for the parser in one line.
    expect(namesIdentityVar('const h = process.env.NEUTRON\\u005fHOME')).toBe(true)
    expect(namesIdentityVar('const h = process.env["NEUTRON\\u005fHOME"]')).toBe(true)
  })

  test('a JSX CHARACTER REFERENCE spells the name, and is detected in TSX', () => {
    // ARM 2 OF {@link couldNameIdentityVar}, and the pin that makes it a
    // requirement rather than a paragraph. `&#95;` is `_` once JSX emits, so this
    // component renders the variable's name to every human who opens the page
    // while its raw bytes match no pattern and contain no backslash.
    //
    // The entity is CONCATENATED from its parts rather than written whole, for
    // the same reason the unicode escape above is: a literal `&#95;` in a `.tsx`
    // fixture is exactly the thing a formatter or a copy-paste normalises back
    // into `_`, which would turn this into a silent duplicate of a test that
    // already passes.
    const ref = '&' + '#95' + ';'
    const asText = `export const Doc = () => <p>NEUTRON${ref}HOME must be set</p>\n`
    const asAttr = `export const Doc = () => <p title="NEUTRON${ref}HOME" />\n`
    expect(namesIdentityVar(asText, 'probe.tsx')).toBe(true)
    expect(namesIdentityVar(asAttr, 'probe.tsx')).toBe(true)

    // The hex and named spellings of the same character, since the decoder
    // handles three forms and a test for one of them pins one of them.
    expect(namesIdentityVar(`export const D = () => <p>NEUTRON&#x5F;HOME</p>\n`, 'probe.tsx')).toBe(
      true,
    )
    expect(
      namesIdentityVar(`export const D = () => <p>NEUTRON&lowbar;HOME</p>\n`, 'probe.tsx'),
    ).toBe(true)

    // CONTROL — the fixture really does hide the name from the raw text, so a
    // pass above is the decoder working and not the pattern matching the source
    // directly. Without this the test would still be green with no decoder at
    // all, which is the shape of vacuity this file exists to refuse.
    expect(/\bNEUTRON_HOME\b/.test(asText)).toBe(false)
    expect(asText.includes('\\')).toBe(false)

    // CONTROL — the SAME entity outside JSX is NOT decoded, because the language
    // does not decode it there. `'NEUTRON&#95;HOME'` is a nine-character string
    // whose value is not the variable's name, and reporting it would be inventing
    // a reader. This is the assertion that keeps the decode scoped to the two
    // positions JSX actually decodes.
    expect(namesIdentityVar(`const s = 'NEUTRON${ref}HOME'\n`)).toBe(false)
    expect(namesIdentityVar(`const s = 'NEUTRON${ref}HOME'\n`, 'probe.tsx')).toBe(false)
  })

  test('an UNPARSEABLE input FAILS OPEN — it is pattern-matched raw', () => {
    // The asymmetry, made structural, and now with an implementation that can
    // keep the claim. A file the parser rejects is matched against its RAW text
    // rather than walked, because a tree the parser could not build may be
    // missing the very node the read lives in. Over-reporting costs one
    // annotated registry row; under-reporting is the entire bug.
    expect(namesIdentityVar('const h = env.NEUTRON_HOME\nfunction ((( {')).toBe(true)
    expect(namesIdentityVar('/* unclosed\nconst h = env.NEUTRON_HOME')).toBe(true)
    expect(namesIdentityVar('const s = `unclosed\nconst h = env.NEUTRON_HOME')).toBe(true)
  })

  test('UNPARSEABLE **AND** ESCAPED — the case where failing open to a raw match is not enough', () => {
    // THE CROSS-MODEL REVIEWER'S COUNTEREXAMPLE, and it was a real silent miss.
    // The previous implementation returned `matchesIdentityName(src)` the moment
    // the parser reported any diagnostic, and never walked the recovered tree.
    // But TypeScript RECOVERS from most syntax errors, so this input has a
    // perfectly good identifier node whose `.text` is `NEUTRON_HOME` while its
    // RAW text spells the name with an escape and matches no pattern. Measured
    // before the fix: three parse diagnostics, a recovered identifier reading
    // `NEUTRON_HOME`, and a final answer of **false** — a reader this guard
    // exists to catch, missed by the arm that exists to catch it.
    //
    // The escaped underscore is CONCATENATED from a lone backslash rather
    // than written as a literal escape, because a literal one is the single
    // easiest thing for an editor, a formatter or a copy-paste to normalise
    // back into the plain letter — which would silently turn this fixture into
    // a duplicate of the test above it. The reviewer caught exactly that
    // normalisation having already happened in a docblock in this file.
    const escapedName = 'NEUTRON' + '\\' + 'u005f' + 'HOME'
    expect(namesIdentityVar(`const h = process.env.${escapedName}\nfunction ((( {`)).toBe(true)
    // The same input WITHOUT the syntax error — proves the escape alone was
    // never the problem, so a failure above means the diagnostic path regressed.
    expect(namesIdentityVar(`const h = process.env.${escapedName}`)).toBe(true)
  })

  test('the spellings this detector CANNOT see are pinned, so the stated limit is a check', () => {
    // FAILING-BY-DESIGN, so the boundary lives in the suite instead of only in
    // prose. If a future change makes any of these detectable, the assertion
    // fails and the docblock's stated limit gets updated with it — the claim and
    // the check move together, which is the entire point of this file.
    //
    // The limit is a CLASS: the walk reads cooked text off ONE node at a time,
    // so a spelling no single node contains whole is invisible, however plainly
    // it names the variable at runtime. An earlier draft of the docblock in
    // `config/index.ts` called the computed key "the only residual limit left";
    // a reviewer measured four more, which is why they are all here.

    // 1. A COMPUTED key names nothing in the program text at all.
    expect(namesIdentityVar('const key = someAlias\nconst h = env[key]')).toBe(false)

    // 2. A CONCATENATION: two string literals, two nodes, neither holding the
    // name. Built from parts so a formatter cannot fold it into one literal and
    // silently turn this into a different (passing) test.
    const concat = "'NEUTRON' + '" + '_HOME' + "'"
    expect(namesIdentityVar(`const h = process.env[${concat}]\n`)).toBe(false)

    // 3. A REGEX whose PATTERN matches the name at runtime while the `.text` the
    // parser exposes does not contain it — a character class, and an escape.
    expect(namesIdentityVar('const r = /NEUTRON[_]HOME/\n')).toBe(false)
    expect(namesIdentityVar('const r = /NEUTRON' + '\\' + 'u005FHOME/\n')).toBe(false)

    // 4. A JSX name SPLIT across text and an expression container, which renders
    // as the variable's name and arrives as three separate nodes.
    expect(namesIdentityVar(`export const D = () => <p>NEUTRON{'_'}HOME</p>\n`, 'probe.tsx')).toBe(
      false,
    )

    // CONTROL — the detector is not simply answering `false` here. The plain
    // regex, whose raw pattern DOES contain the name, is detected; so is the
    // ordinary read. Without these two a broken detector that returned `false`
    // for everything would pass this test, which is the shape of vacuity this
    // file exists to refuse.
    expect(namesIdentityVar('const r = /NEUTRON_HOME/\n')).toBe(true)
    expect(namesIdentityVar('const h = process.env.NEUTRON_HOME\n')).toBe(true)
  })
})
