#!/usr/bin/env bun
// DIFF-BASE gate — a base BRANCH NAME may never be a rev-range operand (#546).
//
// ── THE BUG THIS MAKES PERMANENT ──────────────────────────────────────
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
// ── WHY A GATE AND NOT THREE CORRECT CALL SITES ───────────────────────
// Because that is exactly what was tried. When #546 was opened, `probeCiBase`
// and the plan-probe branch log in `trident/inner-workflow.mjs` were ALREADY
// resolving the base correctly, thirty and three thousand lines away from two
// sites in the same file that still composed the bare name — the fix had landed
// as a call site and not as a rule, and the next author had no way to know the
// rule existed. `docs/agent-legible-architecture.md` §1 names a boundary that
// depends on the next author remembering as the failure mode to design out.
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
// (a fixture whose 3 offenses the matcher must reproduce exactly) and a NEGATIVE
// control (a fixture of near-misses in which exactly the un-argued exemption must
// be the only hit). A scan that reaches ZERO files also exits 1: an absence
// proves nothing until the same matcher has been shown finding something.
//
// EXIT: 0 = clean, 1 = at least one unexcused hit (printed), or a broken matcher.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The git-range surface. `trident/` owns every range that decides what a reviewer
 * reads; `tools/` holds the hand-run review leg that answers the same question; and
 * `scripts/` holds the CI gates, one of which (`leak-gate.sh`) takes its own base
 * range — origin-first today, and there is no reason for the next one to be.
 */
export const SCAN_ROOTS = ['trident', 'tools', 'scripts']

const EXTENSIONS = ['.ts', '.mts', '.mjs', '.js', '.sh']

/**
 * THIS FILE, excluded from its own scan. Its controls ARE the offending shapes —
 * twelve of them, deliberately, because that is what makes the matcher provable — so
 * scanning itself would be a permanent self-report. The same exemption the console gate
 * gives the logger package whose sink IS `console.*`. The controls still run on every
 * invocation, so this file's correctness is checked harder than any file it scans.
 */
const SELF = 'diff-base-check.mjs'

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
 * `${…}..`, `${…}...` — the JS/TS template form and the braced shell form.
 *
 * THE WHOLE INTERPOLATED EXPRESSION, not a bare identifier, and that is not a
 * generalisation for its own sake: the site #546 was filed against is
 * `git diff ${shSingleQuote(baseBranch)}..${shSingleQuote(headOid)}` — a CALL wrapping
 * the name. A matcher that required `${baseBranch}..` could not have failed on the
 * actual bug, which is the "a test that cannot fail on the bug proves nothing" failure
 * wearing a gate's clothes. Caught in review of this very gate, by mutating the fix and
 * watching the gate stay green.
 *
 * `[^{}]*` rather than a balanced-brace parse: every real site here is one call or one
 * ternary deep, and the identifier extraction below is what decides the verdict.
 */
const RANGE_BRACED = /\$\{([^{}]*)\}\.{2,3}/g

/** `$NAME..` — the unbraced shell form. */
const RANGE_BARE = /\$([A-Za-z_][\w]*)\.{2,3}/g

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
  return names
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rx of [RANGE_BRACED, RANGE_BARE]) {
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
        if (isExempt(lines, i)) continue
        out.push({ line: i + 1, name, text: line.trim().slice(0, 160) })
      }
    }
  }
  return out
}

// ── THE CONTROLS ──────────────────────────────────────────────────────
// Hard-coded, checked on every invocation, BEFORE the tree is touched.

/**
 * 5 offenses, at lines 4, 6, 11, 14 and 16 — EVERY shape #546 was actually composed
 * in, not the one that is easiest to match:
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
    if (entry === SELF) continue
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
