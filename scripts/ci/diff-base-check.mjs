#!/usr/bin/env bun
// DIFF-BASE gate — a REGRESSION ALARM for #546's class, not a proof of its absence.
//
// The INVARIANT is "a base BRANCH NAME reaches a rev-range operand ONLY where
// `refs/remotes/origin/<base>` does not resolve to a commit". Not "never", and not "only
// with no remote" — both were earlier drafts of this sentence and both were wider than
// the code. `origin` can be configured while its base ref is missing, deleted or never
// fetched, and there `refs/heads/<base>` is the best available base. That case is
// legitimate, tested, and listed with the blind spots below. This file does not
// establish the invariant either way; it makes a relapse loud. What establishes it is
// structural, two sections down — read that before trusting a green run.
//
// ── THE BUG THIS GUARDS AGAINST ───────────────────────────────────────
// `git diff main..<head>` in a shared build checkout diffs against whatever
// `refs/heads/main` happens to hold, and that ref is only as fresh as the last
// time something on this box pulled it. Every commit merged into the base since
// then is then presented as this branch's own work. Git exits 0, the extra files
// are real code, and nothing downstream can tell the inflated diff from a
// genuinely large one — which is what makes this class silent rather than noisy.
//
// MEASURED TWICE, on this repo:
//   * Argus r4 / run 25b2327d — local `main` was 8 merges behind `origin/main`;
//     the published review artifact was 15,154 lines across ~100 files for a
//     branch whose own work was 20 files / 1,738 lines. A reviewer diffed the
//     stale base, vetoed the branch over bugs in files it does not touch, and
//     the round was lost. Recorded in `trident/orchestrator.ts` at the review
//     diff itself.
//   * #546 — reviewers read 149 files where the branch changed 30.
//
// ── WHAT ACTUALLY GUARANTEES THE INVARIANT — AND IT IS NOT THIS FILE ──
// What enforces it is STRUCTURAL, not textual. (This section used to open "the invariant
// is NO CODE PATH composes a rev-range from a base BRANCH NAME" — an absolute that the
// same file then contradicted by requiring the bare name as a fallback. The fallback is
// real; the absolute was not.):
//
//   * ONE BINDING PER BOUNDARY. `diffBase` in `trident/inner-workflow.mjs` and the
//     exported `diffBaseRef()` in `trident/merge.ts` are the only things that turn a
//     base BRANCH NAME into a range base. They are NOT the only producers of a range
//     base, and this comment used to say they were: `rebased.baseSha` (the observed
//     base tip), `localForkPoint()`, `seenPin` and `run.base_sha` all reach a range
//     operand directly in `orchestrator.ts` and `merge.ts`. Every one of those is a
//     SHA, which is the property that matters — a sha cannot go stale the way a branch
//     name can — so the narrower claim is the true one and the wider one was false.
//   * A RESOLUTION MADE AGAINST THE REPOSITORY, NOT THE MERGE MODE. `diffBase`'s
//     unpinned arm is a shell substitution that asks whether `refs/remotes/origin/<base>`
//     exists and prefers it when it does — in LOCAL mode exactly as in pr mode. It used
//     to hand local mode the bare name outright on the theory that a local-mode run has
//     no origin to be behind; `merge_mode: 'local'` means the outer loop merges locally
//     and says nothing about remotes, and the review-diff fixture measured that mistake
//     at five files where the branch changed one.
//   * AN ARGV BOUNDARY THAT CARRIES WHATEVER THE COMPOSING SIDE RESOLVED. `codex-build.sh`
//     takes the base as argv `$2` and holds no base-branch-name binding at all: its default
//     is EMPTY (`"${2:-}"`), and an empty value skips the last-resort diff entirely. So the
//     wrapper adds no way to INVENT a bare base — but it is not unconstructable there, and
//     this comment said it was. `diffBase`'s legitimate fallback (no resolving
//     `refs/remotes/origin/<base>`) is a bare NAME, it is passed as that argv, and it
//     reaches `git diff --end-of-options "${BASE_DIFF_REF}..HEAD"`. Measured through the
//     shipped line in `codex-wrapper-bare-base.test.ts`. What the wrapper guarantees is
//     narrower and still worth having: the base it ranges against is exactly what the
//     composing side decided, never a guess of its own.
//
//     `trident/codex-review.sh` IS WEAKER STILL. Its argv default is the literal `main`
//     (`BASE_REF="${1:-main}"`) — a bare base branch name, in scope — which the rev-parse
//     below promotes to `origin/main` WHEN THAT REF RESOLVES and leaves bare when it does
//     not. So: a resolved ref on the trident path, which always passes one, and merely
//     DEMOTED in a standalone invocation against a repo with no `origin/<base>`.
//
// THIS GATE IS DEFENCE IN DEPTH. It exists to make a regression LOUD, not to prove
// absence. Read the scope note below before relying on it for the latter.
//
// ── WHY A GATE AT ALL, AND NOT JUST CORRECT CALL SITES ────────────────
// Because call sites is exactly what was tried. When #546 was opened, `probeCiBase`
// and the plan-probe branch log in `trident/inner-workflow.mjs` were ALREADY
// resolving the base correctly, thirty and three thousand lines away from two
// sites in the same file that still composed the bare name — the fix had landed
// as a call site and not as a rule, and the next author had no way to know the
// rule existed. `docs/agent-legible-architecture.md` §1 names a boundary that
// depends on the next author remembering as the failure mode to design out.
//
// ── SCOPE: WHAT THIS GATE CANNOT CATCH ────────────────────────────────
// A TEXTUAL MATCHER OVER SOURCE CANNOT ENFORCE "EVERY REV-RANGE". It can only
// enforce "every rev-range whose spelling I enumerated". This file has been wrong
// about that twice, in the same shape both times, and both times it reported
// success while the defect was present:
//
//   1. the first draft required `${baseBranch}..` and could not see
//      `${shSingleQuote(baseBranch)}..` — the literal #546 line. Found by mutating
//      the fix and watching the gate stay green.
//   2. the second draft required the dots to follow the brace IMMEDIATELY and could
//      not see `"${BASE_BRANCH}"..HEAD`, which the shell evaluates as exactly
//      `main..HEAD`. Found by the review gate on the PR that added this file.
//
// Both are now matched (`RANGE_TAIL`, `RANGE_CONCAT`, `logicalLines`). What is
// STILL invisible, stated so a reader does not mistake a pass for a proof:
//
//   * A RANGE ASSEMBLED ACROSS STATEMENTS. `const r = base + '..'` on one line and
//     `` `${r}${head}` `` further down: the taint follows ALIASES to a fixpoint but
//     not arbitrary dataflow, so a partially-built range escapes.
//   * A COMPUTED OR INDIRECT NAME — `cfg[key]`, `args['base' + 'Branch']`, a value
//     read from JSON or the database at runtime. Nothing in the source says
//     "branch name".
//   * A HELPER THAT TAKES THE BASE AS A `string` PARAMETER and builds the range
//     inside itself. The range there is correct-by-parameter; the defect moves to
//     whatever the caller passes, which this gate only sees if the caller's own
//     expression happens to match.
//   * A NESTED INTERPOLATION. `RANGE_BRACED` reads the operand with `[^{}]*`, so
//     `` `${shSingleQuote(`${pfx}/${baseBranch}`)}..${head}` `` matches NOTHING —
//     measured, zero hits. A balanced-brace parse would close this; a character class
//     cannot, and this file previously asserted "every real site here is one call or
//     one ternary deep" instead of listing the gap.
//   * THE LEGITIMATE UNRESOLVABLE-REF FALLBACK. When `refs/remotes/origin/<base>` does
//     not resolve to a commit — no remote at all, OR an `origin` that is configured but
//     whose base ref is missing, deleted or unfetched — `refs/heads/<base>` is the best
//     available base and a bare name there is correct. The gate cannot tell that from the
//     defect by reading source and does not try. `inner-workflow.mjs` decides it in the
//     shell, per repository, at the moment the range is built, without fetching.
//   * ANY SPELLING NOT ENUMERATED ABOVE. That set is open, and the next member of
//     it will be found the same way the last two were — by mutating the fix and
//     checking the gate reddens, never by reading this list and feeling covered.
//
// The durable fix is not a better regex: it is to keep narrowing the SCOPE in which
// a base branch name exists at all, as the two shell wrappers already do. See the
// as-built record for why a branded `ResolvedRef` type was considered and rejected.
//
// ── WHAT IT FLAGS ─────────────────────────────────────────────────────
// A two- or three-dot rev-range whose LEFT operand is an interpolation of an
// identifier that holds a base BRANCH NAME, in the git-range surface
// (SCAN_ROOTS). "Holds a base branch name" is decided per file, two ways:
//   1. BY NAME — `baseBranch`, `base_branch`, `BASE_BRANCH`, `basebranch`, in
//      any case. This is the spelling the defect shipped in.
//   2. BY SOURCE — an identifier bound from `resolveBase(…)`,
//      `detectBaseBranch(…)`, or from a `base_branch` field/argument. Those are
//      the functions that PRODUCE the bare name, and `const base = await
//      resolveBase(run)` followed by `${base}..${head}` is the same defect
//      wearing a shorter name. Without this arm the gate would only catch the
//      spelling, not the class.
//
// ── WHAT IT DOES NOT FLAG ─────────────────────────────────────────────
//   * A QUALIFIED ref — `refs/heads/${base}..`, `refs/remotes/origin/${base}..`,
//     `origin/${base}..`. The author has said which ref they mean, and one real
//     site (the launch path's `base_behind` count,
//     `refs/heads/<base>..refs/remotes/origin/<base>`) exists precisely to
//     MEASURE how stale the local ref is — flagging it would be flagging the
//     measurement of the bug.
//   * A RESOLVED ref — `diffBase`, `diffBaseRef(…)`, `base_ref`, `BASE_REF`,
//     `base_sha`, a 40-hex literal. Naming a range operand `*_ref`/`*Ref` rather
//     than `*_branch`/`*Branch` is the convention this gate keeps honest.
//   * TESTS. A test of this class has to CONSTRUCT the broken form to prove the
//     fix — `trident/review-diff-base-realgit.test.ts` runs the bare-local range
//     deliberately, as the control that makes the correct answer meaningful. A
//     gate that forbade that would forbid the only test that can fail on the bug.
//   * An ARGUED exemption: `DIFF-BASE-OK:` plus at least
//     MIN_JUSTIFICATION_CHARS characters of reason, in a comment on the offending
//     line or the line directly above it. A bare `DIFF-BASE-OK` with no argument
//     is its own failure, so an exemption stays an argued exception.
//
// ── WHY THE CONTROLS AND THE TRIPWIRE ─────────────────────────────────
// This repo has been bitten by a check that matched nothing and reported success.
// So before it looks at the tree at all, every invocation runs a POSITIVE control
// (a fixture whose 5 offenses the matcher must reproduce exactly — it grew from 3 as new
// shapes were found) and a NEGATIVE
// control (a fixture of near-misses in which exactly the un-argued exemption must
// be the only hit). A scan that reaches ZERO files also exits 1: an absence
// proves nothing until the same matcher has been shown finding something.
//
// EXIT: 0 = clean, 1 = at least one unexcused hit (printed), or a broken matcher.
// A 0 means "none of the enumerated spellings is present", NEVER "no bare-base range
// exists". The structural half of the change is what licenses the stronger claim.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The git-range surface. `trident/` owns every range that decides what a reviewer
 * reads; `tools/` holds the hand-run review leg that answers the same question; and
 * `scripts/` holds the CI gates, one of which (`leak-gate.sh`) takes its own base
 * range — origin-first today, and there is no reason for the next one to be.
 */
export const SCAN_ROOTS = ['trident', 'tools', 'scripts']

const EXTENSIONS = ['.ts', '.mts', '.mjs', '.js', '.sh']

/**
 * THIS FILE — by ABSOLUTE PATH, not by basename.
 *
 * It is excluded from its own scan because its controls ARE the offending shapes, a dozen
 * of them, deliberately: that is what makes the matcher provable, and scanning itself
 * would be a permanent self-report. The same exemption the console gate gives the logger
 * package whose sink IS `console.*`. The controls still run on every invocation, so
 * excluding this file from the SCAN does not leave its own matcher unchecked.
 *
 * THE COMPARISON USED TO BE `entry === 'diff-base-check.mjs'`, A BASENAME, and that is a
 * hole a gate cannot afford: an offender placed at `trident/diff-base-check.mjs` or
 * `tools/diff-base-check.mjs` was never scanned and the gate reported CLEAN. Measured.
 *
 * The test that was supposed to pin this exclusion could not catch it, and the reason is
 * worth keeping: it planted a DIFFERENTLY NAMED sibling and asserted that file was
 * caught. That proves other names are scanned; it says nothing about a file with the SAME
 * basename elsewhere, which is the actual property and was the actual bug. The test had
 * been written from the implementation's premise — "the exclusion is by basename" — so it
 * could not falsify that premise. A test that shares the code's mental model tests the
 * model, not the code.
 */
const SELF_PATH = resolve(fileURLToPath(import.meta.url))

/** Characters of reason an exemption must carry. A bare marker is not an argument. */
export const MIN_JUSTIFICATION_CHARS = 20

export const EXEMPT_MARKER = 'DIFF-BASE-OK:'

/** Identifier spellings that ARE a base branch name. */
const BRANCH_NAME = /^base_?branch$/i

/** Bindings that PRODUCE a base branch name. `const base = await resolveBase(run)`. */
const TAINT_FROM_CALL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:resolveBase|detectBaseBranch)\s*\(/g

/** `const base = opts.base_branch`, `const base = input.base_branch ?? …`. */
const TAINT_FROM_FIELD = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w.$?[\]'"]*\bbase_?branch\b/gi

/** Shell: `BASE="$BASE_BRANCH"`, `BASE=${BASE_BRANCH}`. */
const TAINT_FROM_SHELL = /^\s*([A-Za-z_][\w]*)=["']?\$\{?base_?branch\b/gim

/**
 * `const b = base`, `let b = await base`, `const b = base.trim()` — the binding's LHS
 * and the first identifier on its RHS, captured by ONE STATIC pattern.
 *
 * STATIC, AND THAT IS THE WHOLE POINT (CodeQL `js/useless-regexp-character-escape`,
 * high, found on this file's own first landing). This used to build a regex PER TAINTED
 * NAME by splicing the name in unescaped:
 *
 *     new RegExp(String.raw`…(?:await\s+)?` + name + String.raw`\b`)
 *
 * and the names come from `([A-Za-z_$][\w$]*)` captures — a class that INCLUDES `$`. A
 * source file binding `const $base = await resolveBase(run)` therefore spliced
 * `…(?:await\s+)?$base\b`, in which `$` is an END-OF-LINE ANCHOR, so the pattern could
 * never match and the alias hop SILENTLY did nothing: `const alias = $base` followed by
 * `git diff ${alias}..${head}` returned no hits at all, while the same shape spelled
 * `zbase` was caught. Measured both ways before the fix.
 *
 * That is this PR's own subject reappearing inside its verification: a matcher meaning
 * something other than its author believed. The fix is not to escape the splice — it is
 * to have no splice. Membership is a literal Set lookup below, so a `$` in an identifier
 * is just a character.
 */
const BINDING_FROM_IDENTIFIER = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)/g

/**
 * WHAT SITS BETWEEN THE OPERAND AND ITS DOTS. Three spellings, and the history of this
 * constant is the reason the gate's scope is stated honestly further down:
 *
 *   `${base}..`            nothing
 *   `${base}"..`           a CLOSING QUOTE — the shell evaluates `"${BASE}"..HEAD` as
 *                          exactly `main..HEAD`, and the first two drafts of this
 *                          matcher returned [] for it
 *   `` ${base}` + `.. ``   a CONCATENATION across the quote, which is also what a range
 *                          split over two source lines looks like once the continuation
 *                          is joined (see `logicalLines`)
 *
 * Deliberately NOT `[\s"'`+]*`: allowing bare whitespace would make `${baseBranch} …`
 * in ordinary prose a hit, and a gate that cries wolf gets muted.
 */
const RANGE_TAIL = String.raw`(?:["'\x60]\s*\+\s*["'\x60]|["'\x60])?\.{2,3}`

/**
 * `${…}..`, `${…}...` — the JS/TS template form and the braced shell form.
 *
 * THE WHOLE INTERPOLATED EXPRESSION, not a bare identifier, and that is not a
 * generalisation for its own sake: the site #546 was filed against is
 * `git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)}` — a CALL wrapping
 * the name. A matcher that required `${baseBranch}..` could not have failed on the
 * actual bug, which is the "a test that cannot fail on the bug proves nothing" failure
 * wearing a gate's clothes. Caught in review of this very gate, by mutating the fix and
 * watching the gate stay green — and then caught AGAIN, one spelling later, by the
 * review gate. That is the evidence for the scope note in the header.
 *
 * `[^{}]*` rather than a balanced-brace parse. That is a LIMIT, not a proof: it reads
 * one call or one ternary deep, and a NESTED interpolation escapes it entirely (see the
 * header's scope note — measured at zero hits). Every site in the tree today is within
 * that depth, which is a fact about the tree now and not a property of the matcher. The
 * identifier extraction below decides the verdict for what it does reach.
 */
const RANGE_BRACED = new RegExp(String.raw`\$\{([^{}]*)\}` + RANGE_TAIL, 'g')

/** `$NAME..`, `"$NAME"..` — the unbraced shell form. */
const RANGE_BARE = new RegExp(String.raw`\$([A-Za-z_][\w]*)` + RANGE_TAIL, 'g')

/**
 * `baseBranch + '..HEAD'` — the operand as a VALUE concatenated onto a literal that
 * opens with the dots, with no interpolation anywhere. `'git diff ' + base + '..' + head`
 * reaches git as the identical range and no `${…}` appears in the source at all.
 */
const RANGE_CONCAT = /([A-Za-z_$][\w$]*)\s*\+\s*["'\x60]\s*\.{2,3}/g

/** Every identifier mentioned in an interpolated expression. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g

/** Prefixes that make the operand an EXPLICIT ref rather than a bare branch name. */
const QUALIFIERS = ['refs/heads/', 'refs/remotes/', 'origin/']

/**
 * Every identifier in `source` that holds a base BRANCH name — by spelling or by
 * the binding it came from. Per file, deliberately: this is a shape check, not a
 * type system, and a name is only interesting where it was bound.
 */
export function taintedNames(source) {
  const names = new Set()
  for (const rx of [TAINT_FROM_CALL, TAINT_FROM_FIELD, TAINT_FROM_SHELL]) {
    rx.lastIndex = 0
    let m
    while ((m = rx.exec(source)) !== null) names.add(m[1])
  }
  // AND THROUGH ALIASES, TO AN ACTUAL FIXPOINT — the word is load-bearing and the third
  // claim on this branch to have outrun its instrument. This loop was capped at FOUR
  // rounds, which is a fixpoint only for a chain the scan happens to traverse in one
  // pass. `const b = base` propagates within a single scan when the bindings appear in
  // DEPENDENCY order, so a forward chain of any length is caught in round 1 — but a
  // REVERSE-ORDERED chain advances exactly one hop per round:
  //
  //     const e = d          ← round 4 reaches `d`, so `e` is never added
  //     const d = c
  //     const c = b
  //     const b = a
  //     const a = base
  //     const base = await resolveBase(run)
  //     const cmd = `git diff ${e}..${head}`   ← measured: ZERO hits at cap 4
  //
  // WHICH LINE DOES WHAT, because "it terminates" was itself a claim worth pinning:
  //   * `bindingCount` TERMINATES IT, and is the only thing that has to. `names` only
  //     ever grows, every name it can gain is some binding's left-hand side, and a
  //     reverse-ordered chain of N bindings advances one hop per round — so N rounds
  //     always suffice. That is a REAL bound derived from the input, not a number
  //     chosen for comfort, and unlike a fixed cap it cannot cut the fixpoint short.
  //   * the `names.size === before` break only ends it EARLY. Measured by deleting it:
  //     the suite stays green and the file's tests go from 0.9s to 4.6s. It is a
  //     performance guard, and calling it the termination guarantee would have been the
  //     same kind of overclaim as the cap it replaced.
  //
  // ONE STATIC PATTERN, matched once per round, with the name comparison done as a
  // literal `Set.has`. See `BINDING_FROM_IDENTIFIER` for what the per-name spliced
  // regex this replaces got silently wrong.
  const bindingCount = (source.match(BINDING_FROM_IDENTIFIER) ?? []).length
  for (let round = 0; round <= bindingCount; round++) {
    const before = names.size
    BINDING_FROM_IDENTIFIER.lastIndex = 0
    let m
    while ((m = BINDING_FROM_IDENTIFIER.exec(source)) !== null) {
      if (names.has(m[2])) names.add(m[1])
    }
    if (names.size === before) break
  }
  return names
}

/**
 * Source lines, with a `+`-continuation joined onto the line it continues into.
 *
 * A rev-range can straddle two source lines — `` `git diff ${base}` + `` then
 * `` `..${head}` `` on the next — and prettier will PUT it there for you as soon as the
 * line gets long. Matching per physical line returned [] for that, so the range is
 * matched against the joined text and reported at the FIRST of its lines.
 */
export function logicalLines(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]
    const start = i
    // Bounded: a chain longer than this is not a range being formatted, and an
    // unbounded join would let one runaway line swallow the file.
    for (let joins = 0; joins < 4 && /\+\s*$/.test(text) && i + 1 < lines.length; joins++) {
      i += 1
      text += ' ' + lines[i].trim()
    }
    out.push({ text, line: start + 1 })
  }
  return out
}

/** Is this offence argued for, on its own line or the one above it? */
function isExempt(lines, index) {
  for (const candidate of [lines[index], lines[index - 1]]) {
    if (typeof candidate !== 'string') continue
    const at = candidate.indexOf(EXEMPT_MARKER)
    if (at === -1) continue
    // The marker must be in a COMMENT, not in data: a marker inside a string
    // literal the code goes on to use is text, not an argument. `//`, `#` and
    // `*` (a jsdoc continuation line) are the three comment openers in scope.
    const before = candidate.slice(0, at)
    if (!/(^|\s)(\/\/|#|\*)/.test(before) && !/^\s*(\/\/|#|\*)/.test(candidate)) continue
    if (candidate.slice(at + EXEMPT_MARKER.length).trim().length >= MIN_JUSTIFICATION_CHARS) return true
  }
  return false
}

/**
 * Every unexcused base-branch rev-range in `source`.
 *
 * Exported so `diff-base-check.test.ts` can drive it over fixtures, which is also
 * how the controls below are expressed — the gate and its test share one matcher,
 * so the test cannot pass against a matcher the gate does not run.
 */
export function findBareBaseRanges(source) {
  const tainted = taintedNames(source)
  const lines = source.split('\n')
  const out = []
  const seen = new Set()
  for (const { text: line, line: lineNo } of logicalLines(lines)) {
    for (const rx of [RANGE_BRACED, RANGE_BARE, RANGE_CONCAT]) {
      rx.lastIndex = 0
      let m
      while ((m = rx.exec(line)) !== null) {
        // ANY base-branch name mentioned in the range's left operand condemns it,
        // wrapper calls included. `shSingleQuote(baseBranch)` is still the bare name
        // by the time git sees it.
        const mentioned = m[1].match(IDENTIFIER) ?? []
        const name = mentioned.find((n) => BRANCH_NAME.test(n) || tainted.has(n))
        if (name === undefined) continue
        const before = line.slice(0, m.index)
        if (QUALIFIERS.some((q) => before.endsWith(q))) continue
        if (isExempt(lines, lineNo - 1)) continue
        // One report per (line, name): a joined continuation is scanned as part of the
        // line above it AND on its own, so a range can otherwise be counted twice.
        const key = `${lineNo}:${name}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ line: lineNo, name, text: line.trim().slice(0, 160) })
      }
    }
  }
  return out
}

// ── THE CONTROLS ──────────────────────────────────────────────────────
// Hard-coded, checked on every invocation, BEFORE the tree is touched.

/**
 * 5 offenses, at lines 4, 6, 11, 14 and 16 — the two shapes #546 itself was composed in
 * plus the three this gate was later caught missing, rather than the one that is easiest
 * to match. NOT an enumeration of every possible shape; the header's scope note lists
 * what stays invisible:
 *   * the bare name in a template (line 4);
 *   * THE NAME WRAPPED IN A CALL (line 6) — `git diff ${shSingleQuote(baseBranch)}..`
 *     is the exact text `writeResumeDiff` shipped, and the first draft of this gate
 *     could not see it;
 *   * a ternary that falls back to the name (line 11) — the forge contract's
 *     `${pinnedBase ?? baseBranch}..HEAD`, wrong only on its fallback arm;
 *   * a `.ts` site where the name arrived from `resolveBase()` (line 14);
 *   * the shell form (line 16).
 */
export const POSITIVE_CONTROL = [
  '// a .mjs workflow prompt: the spelling the defect shipped in',
  'const out = `/tmp/x.diff`',
  'const cmd =',
  '  `git diff ${baseBranch}..${headOid} > ${out}`',
  '// the shape writeResumeDiff actually carried — the name inside a call',
  'const quoted = `git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)}`',
  '// the forge contract: right when pinned, stale when not',
  'const contract = `git diff ${pinnedBase ?? baseBranch}..HEAD`',
  '',
  '// a .ts call site: the same defect under a shorter name',
  'async function publish(run) {',
  '  const base = await resolveBase(run)',
  "  return run_host(['git', 'diff', `${base}..${head}`])",
  '}',
  '# a .sh call site',
  'git diff "${BASE_BRANCH}..HEAD" > "$f"',
].join('\n')

/** Exactly ONE hit — the un-argued exemption on the last line. Everything else is
 *  a near-miss the gate must stay quiet about, or CI becomes noise and gets muted. */
export const NEGATIVE_CONTROL = [
  'const diffBase = pinnedBase ?? `origin/${baseBranch}`',
  'const cmd = `git diff ${diffBase}..${headOid}`',
  'const q = `git diff ${shSingleQuote(diffBase)}..${shSingleQuote(headOid)}`',
  'const r = `git diff ${shSingleQuote(baseRef)}..${shSingleQuote(head)}`',
  'const named = `git diff ${base_ref}...${ref}`',
  'const pinned = `git diff ${base_sha}..${head}`',
  'const behind = `rev-list --count refs/heads/${base_branch}..${remoteRef}`',
  'const remote = `git diff refs/remotes/origin/${base_branch}..${head}`',
  'const short = `git diff origin/${baseBranch}..${head}`',
  '// DIFF-BASE-OK: the base here is a sha the caller already resolved upstream',
  'const argued = `git diff ${baseBranch}..${head}`',
  'const unargued = `git diff ${baseBranch}..${head}` // DIFF-BASE-OK',
].join('\n')

function runControls() {
  const positive = findBareBaseRanges(POSITIVE_CONTROL)
  const wantPositive = [
    { line: 4, name: 'baseBranch' },
    { line: 6, name: 'baseBranch' },
    { line: 8, name: 'baseBranch' },
    { line: 13, name: 'base' },
    { line: 16, name: 'BASE_BRANCH' },
  ]
  const gotPositive = positive.map((h) => ({ line: h.line, name: h.name }))
  if (JSON.stringify(gotPositive) !== JSON.stringify(wantPositive)) {
    console.error('diff-base-check: POSITIVE CONTROL FAILED — the matcher is broken, so a')
    console.error('  clean tree would prove nothing. expected', JSON.stringify(wantPositive))
    console.error('  got     ', JSON.stringify(gotPositive))
    return false
  }
  const negative = findBareBaseRanges(NEGATIVE_CONTROL)
  if (negative.length !== 1 || negative[0].line !== 12) {
    console.error('diff-base-check: NEGATIVE CONTROL FAILED — expected exactly the un-argued')
    console.error('  exemption at line 12, got', JSON.stringify(negative))
    return false
  }
  return true
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue
    const abs = join(dir, entry)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      // `__tests__/` is a test directory by convention, same exemption as `*.test.*`.
      if (entry === '__tests__') continue
      walk(abs, out)
      continue
    }
    if (!EXTENSIONS.some((e) => entry.endsWith(e))) continue
    if (/\.test\.(ts|mts|mjs|js)$/.test(entry)) continue
    if (resolve(abs) === SELF_PATH) continue
    out.push(abs)
  }
  return out
}

function main() {
  if (!runControls()) return 1
  const files = []
  for (const root of SCAN_ROOTS) walk(root, files)
  if (files.length === 0) {
    console.error(`diff-base-check: scanned ZERO files under ${SCAN_ROOTS.join(', ')} —`)
    console.error('  an empty scan is not a pass. Run this from the repository root.')
    return 1
  }
  const hits = []
  for (const abs of files) {
    let src
    try {
      src = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    for (const hit of findBareBaseRanges(src)) hits.push({ file: abs, ...hit })
  }
  if (hits.length > 0) {
    console.error(`DIFF-BASE (a base BRANCH NAME as a rev-range operand): FAILED — ${hits.length} found`)
    for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.name}]  ${h.text}`)
    console.error('')
    console.error('  A bare local branch name is the wrong left-hand side of a rev-range: a stale')
    console.error('  `refs/heads/<base>` silently presents every commit merged into the base since')
    console.error('  as this branch\'s own work (#546 — 149 files read where 30 changed).')
    console.error('  Resolve it first: `diffBaseRef(...)` in trident/merge.ts, or `diffBase` in')
    console.error('  trident/inner-workflow.mjs. If the bare name really is right here, say why:')
    console.error(`  a \`${EXEMPT_MARKER} <reason>\` comment on the line or the line above it.`)
    return 1
  }
  console.log(`DIFF-BASE (base branch name as a rev-range operand): 0 found in ${files.length} files ✅`)
  return 0
}

if (import.meta.main) process.exit(main())
