#!/usr/bin/env bun
// Wall-clock timing-assertion gate (ISSUES #438).
//
// A test that compares REAL ELAPSED TIME against a constant is measuring the
// MACHINE, not the code. It reddens when the runner is loaded — which is exactly
// when CI is busiest — for a reason unrelated to the change under review, and a
// gate that reddens for unrelated reasons is a gate people learn to merge past.
// The tree was swept once (commit 4437e8c7: 9 such bounds deleted, 4 converted
// to a logical clock / an ordering, the rest kept with a written justification).
// THIS GATE EXISTS SO THE CLASS CANNOT REGROW — a new wall-clock bound fails CI
// here rather than being discovered later by a red shard on someone else's PR.
//
// ── WHAT IT FLAGS ─────────────────────────────────────────────────────
// One shape: **a real-wall-clock DELTA compared against a threshold inside an
// `expect(...)`**, however that delta is named or spelled.
//
//   expect(Date.now() - start).toBeLessThan(2000)            ← flagged (inline)
//   const elapsed = Date.now() - t0; expect(elapsed).toBeLessThan(100)
//                                                            ← flagged (bound)
//   expect(Math.abs(performance.now() - t0)).toBeGreaterThan(5)
//                                                            ← flagged (wrapped)
//   const ms = end - start; expect(ms / 2).toBeLessThan(50)  ← flagged (derived)
//
// ── WHY IT MATCHES THE EXPRESSION, NOT THE VARIABLE NAME ──────────────
// The ad-hoc grep that found the original violations keyed on variables named
// `elapsed` / `took` / `duration` / `ms`. That matcher was wrong in BOTH
// directions, and each way it was wrong is now a locked test here:
//
//   * FALSE NEGATIVE — `expect(Date.now() - start).toBeLessThan(2000)` is the
//     identical flake class but binds the delta to no name at all, so a
//     name-keyed matcher cannot see it. A real one of these survived the sweep.
//   * FALSE POSITIVE — a bound quoted in a COMMENT ("the bound that used to sit
//     here (`elapsed < 2000`)") is prose, not code. This gate parses the TS AST,
//     so a comment is never a node and can never be a hit.
//   * FALSE POSITIVE — `expect(Date.now() - started).toBe(900)` under
//     `installHarnessClock()` is a LOGICAL clock. Handled on principle rather
//     than by an allowlist: an EXACT-equality matcher (`toBe`/`toEqual`) on a
//     delta is only ever writable against a logical clock — real wall time is
//     never exactly N — so exact equality is out of scope and only the ORDERING
//     matchers (`toBeLessThan` & co.) are in it.
//   * FALSE POSITIVE — a fake-timer harness call, and every `waitFor` /
//     `while (Date.now() - start < timeoutMs)` POLLING loop in the repo (there
//     are ~40). None of them is an `expect(...)`, so none is a hit. Requiring
//     the delta to be an ASSERTION SUBJECT is what separates "the test waits for
//     something" from "the test asserts how fast the box is".
//   * FALSE POSITIVE — a past-timestamp FIXTURE (`last_event_at: Date.now() -
//     10 * 60_000`) is a clock read minus a CONSTANT, which is a point in time,
//     not an elapsed duration. A delta requires its subtrahend to be
//     non-constant.
//
// ── THE OPT-OUT ───────────────────────────────────────────────────────
// Some bounds have no deterministic substitute (see the survivors in
// docs/AS_BUILT.md). Those carry a marker on the assertion:
//
//   // WALL-CLOCK-BOUND-OK: <why no deterministic assertion can replace this,
//   // and what the measured margin is>
//   expect(elapsed).toBeGreaterThan(600)
//
// The marker REQUIRES a written justification — at least
// MIN_JUSTIFICATION_CHARS characters of prose after the colon (continuation
// `//` lines in the same comment block count). A bare `WALL-CLOCK-BOUND-OK:`
// with no argument is REJECTED as its own failure class, so an opt-out stays an
// argued exception rather than a silent one. This is also why the gate ships
// GREEN: a gate that starts red trains people to merge past it, which is
// precisely how a standing-red check in this repo hid a second, completely dead
// check for days.
//
// ── SCOPE: TEST FILES ONLY ────────────────────────────────────────────
// The inverse of void-promise-check.mjs, and deliberately so. Comparing elapsed
// time to a threshold in PRODUCTION code is not a smell — it is how a timeout,
// a watchdog, or a rate limiter is implemented. The flake class is specific to
// ASSERTIONS, so only test files are scanned.
//
// EXIT: 0 = no unmarked wall-clock bounds, 1 = at least one (printed).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import ts from 'typescript'

/** Prose required after `WALL-CLOCK-BOUND-OK:` for the opt-out to count. Set so
 *  a real sentence clears it and a shrug ("flaky", "needed", "ok for now")
 *  does not. */
export const MIN_JUSTIFICATION_CHARS = 60

export const MARKER = 'WALL-CLOCK-BOUND-OK'

/** Matchers that compare a value against a THRESHOLD. Exact-equality matchers
 *  (`toBe`, `toEqual`, `toStrictEqual`) are deliberately absent: a delta can
 *  only be asserted exactly equal to a constant under a LOGICAL clock, so those
 *  are out of scope on principle rather than by allowlist. */
const ORDERING_MATCHERS = new Set([
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeCloseTo',
  'toBeWithin',
])

// ── Real-wall-clock reads ─────────────────────────────────────────────

/** True iff `node` READS the real wall clock. Covers every source in the repo
 *  plus the ones a future test might reach for. A LOGICAL clock
 *  (`harnessClockNow()`, a jest/bun fake timer) is deliberately NOT here — it
 *  is immune to machine load, which is the entire point. */
function isRealClockRead(node) {
  if (!node) return false
  // `new Date().getTime()` / `new Date().valueOf()`
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === 'getTime' || node.expression.name.text === 'valueOf') &&
    ts.isNewExpression(node.expression.expression) &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === 'Date'
  ) {
    return true
  }
  // `+new Date()` / `Number(new Date())`
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken) {
    const o = node.operand
    if (ts.isNewExpression(o) && ts.isIdentifier(o.expression) && o.expression.text === 'Date') return true
  }
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  // `process.hrtime.bigint()`
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'bigint' &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'hrtime'
  ) {
    return true
  }
  if (!ts.isPropertyAccessExpression(callee)) return false
  const obj = ts.isIdentifier(callee.expression) ? callee.expression.text : null
  const fn = callee.name.text
  return (
    (obj === 'Date' && fn === 'now') ||
    (obj === 'performance' && fn === 'now') ||
    (obj === 'Bun' && fn === 'nanoseconds') ||
    (obj === 'process' && fn === 'hrtime')
  )
}

/** Nearest-enclosing-scope `const`/`let` initializer for an identifier, or null.
 *  Unlike the void-promise gate this follows `let` too: a test's
 *  `let elapsed; ...; elapsed = Date.now() - t0` is the same flake class, and a
 *  binding reassigned to a clock delta is still a clock delta. Requires parent
 *  links (parse with `setParentNodes: true`). */
function findBindingInitializer(identNode) {
  const name = identNode.text
  let scope = identNode.parent
  while (scope) {
    const statements =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined
    if (statements) {
      for (const st of statements) {
        if (!ts.isVariableStatement(st)) continue
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer
        }
      }
    }
    scope = scope.parent
  }
  return null
}

/** True iff `node` is a compile-time NUMERIC constant (a literal, or arithmetic
 *  over literals — `10 * 60_000`, `-5`). An IDENTIFIER is never treated as
 *  constant: it may well be a captured clock read. This is what separates a
 *  past-timestamp FIXTURE (`Date.now() - 600_000`) from an elapsed DELTA. */
function isConstantNumeric(node) {
  if (!node) return false
  if (ts.isParenthesizedExpression(node)) return isConstantNumeric(node.expression)
  if (ts.isNumericLiteral(node)) return true
  if (ts.isPrefixUnaryExpression(node)) return isConstantNumeric(node.operand)
  if (ts.isBinaryExpression(node)) {
    return isConstantNumeric(node.left) && isConstantNumeric(node.right)
  }
  return false
}

/** True iff `node`'s value derives from a REAL clock read — directly, through a
 *  binding, or through arithmetic/`Math.abs`/`Number(...)` wrapping. Cycle- and
 *  depth-guarded. */
function isClockDerived(node, seen = new Set(), depth = 0) {
  if (!node || depth > 24) return false
  if (isRealClockRead(node)) return true
  if (ts.isParenthesizedExpression(node)) return isClockDerived(node.expression, seen, depth + 1)
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return isClockDerived(node.expression, seen, depth + 1)
  }
  if (ts.isNonNullExpression(node)) return isClockDerived(node.expression, seen, depth + 1)
  if (ts.isPrefixUnaryExpression(node)) return isClockDerived(node.operand, seen, depth + 1)
  if (ts.isBinaryExpression(node)) {
    return (
      isClockDerived(node.left, seen, depth + 1) || isClockDerived(node.right, seen, depth + 1)
    )
  }
  // `Math.abs(x)` / `Number(x)` / `Math.round(x)` — pass-through wrappers.
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    const isWrapper =
      (ts.isIdentifier(callee) && callee.text === 'Number') ||
      (ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Math')
    if (isWrapper) return node.arguments.some((a) => isClockDerived(a, seen, depth + 1))
    return false
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return false
    seen.add(node.text)
    const init = findBindingInitializer(node)
    return init ? isClockDerived(init, seen, depth + 1) : false
  }
  return false
}

/** True iff `node` is a real ELAPSED-TIME subtraction: `<clock-derived> -
 *  <non-constant>`. The subtrahend must NOT be a numeric constant — subtracting
 *  a fixed duration from a clock read yields a past TIMESTAMP, not a duration. */
function isWallClockDelta(node) {
  if (!node || !ts.isBinaryExpression(node)) return false
  if (node.operatorToken.kind !== ts.SyntaxKind.MinusToken) return false
  if (!isClockDerived(node.left)) return false
  return !isConstantNumeric(node.right)
}

/** True iff the expression `subject` (an `expect(...)` argument) carries a
 *  wall-clock delta ANYWHERE in it — inline, via a binding, or wrapped in
 *  arithmetic. Resolves identifiers so `const elapsed = Date.now() - t0;
 *  expect(elapsed / 2)` is still a hit. */
function subjectCarriesWallClockDelta(subject, seen = new Set(), depth = 0) {
  if (!subject || depth > 24) return false
  let found = false
  const visit = (n) => {
    if (found) return
    if (isWallClockDelta(n)) {
      found = true
      return
    }
    if (ts.isIdentifier(n) && !seen.has(n.text)) {
      seen.add(n.text)
      const init = findBindingInitializer(n)
      if (init && subjectCarriesWallClockDelta(init, seen, depth + 1)) {
        found = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(subject)
  return found
}

// ── expect(...) chain recognition ─────────────────────────────────────

/** Walk back down an assertion chain (`expect(x).not.toBeLessThan(…)`,
 *  `expect(p).resolves.toBeGreaterThan(…)`) to the `expect(...)` call, and
 *  return its first argument — or null if this isn't an expect chain. */
function expectSubjectOf(receiver) {
  let node = receiver
  for (let i = 0; i < 12; i += 1) {
    if (ts.isParenthesizedExpression(node)) {
      node = node.expression
      continue
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
        return node.arguments[0] ?? null
      }
      return null
    }
    // `.not` / `.resolves` / `.rejects` modifier hop
    if (ts.isPropertyAccessExpression(node)) {
      node = node.expression
      continue
    }
    return null
  }
  return null
}

// ── The opt-out marker ────────────────────────────────────────────────

/** The statement a node sits in — the unit a marker comment attaches to. */
function enclosingStatement(node) {
  let n = node
  while (n && !ts.isStatement(n)) n = n.parent
  return n ?? node
}

/** All comment text attached to `stmt` (leading block + same-line trailing),
 *  concatenated in source order with newlines. */
function commentTextFor(sf, stmt) {
  const full = sf.getFullText()
  const ranges = [
    ...(ts.getLeadingCommentRanges(full, stmt.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(full, stmt.getEnd()) ?? []),
  ]
  return ranges.map((r) => full.slice(r.pos, r.end)).join('\n')
}

/**
 * Classify the opt-out on a statement.
 *   { state: 'none' }        — no marker
 *   { state: 'bare' }        — marker present, justification too short
 *   { state: 'justified' }   — marker + real prose
 *
 * The justification is everything after `WALL-CLOCK-BOUND-OK:` in the attached
 * comments, with comment punctuation stripped, so continuation `//` lines count
 * toward the length.
 */
export function classifyMarker(commentText) {
  const idx = commentText.indexOf(MARKER)
  if (idx === -1) return { state: 'none', justification: '' }
  let rest = commentText.slice(idx + MARKER.length)
  rest = rest.replace(/^\s*:/, '') // the required colon
  const prose = rest
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/|\/\*+|\*+\/?)/, '').trim())
    .join(' ')
    .replace(/\*\/\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    state: prose.length >= MIN_JUSTIFICATION_CHARS ? 'justified' : 'bare',
    justification: prose,
  }
}

// ── Detector ──────────────────────────────────────────────────────────

/**
 * Find every wall-clock timing assertion in `source`.
 * @param {string} source     TS/TSX source text.
 * @param {string} [fileName] virtual file name (drives TSX parsing).
 * @returns {{line:number, text:string, marker:'none'|'bare'|'justified'}[]}
 */
export function findWallClockBounds(source, fileName = 'fixture.test.ts') {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text
      if (ORDERING_MATCHERS.has(matcher)) {
        const subject = expectSubjectOf(node.expression.expression)
        if (subject && subjectCarriesWallClockDelta(subject)) {
          const stmt = enclosingStatement(node)
          const { state } = classifyMarker(commentTextFor(sf, stmt))
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          out.push({ line: line + 1, text: node.getText(sf).split('\n')[0].trim(), marker: state })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ── CLI ───────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, '..', '..')
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.expo', '.claude', 'coverage', 'vendor'])

/** Test files only — see the SCOPE note in the header. */
export function isTestFile(rel) {
  if (!rel.endsWith('.test.ts') && !rel.endsWith('.test.tsx')) return false
  return true
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) out.push(full)
  }
}

/** Cheap pre-filter: a file can only carry a hit if it both asserts and reads a
 *  real clock. Conservative — the AST pass makes the actual decision. */
export function mightCarryBound(src) {
  if (!src.includes('expect(')) return false
  return /\bDate\s*\.\s*now\b|\bperformance\s*\.\s*now\b|\bBun\s*\.\s*nanoseconds\b|\bhrtime\b|new\s+Date\s*\(\s*\)/.test(
    src,
  )
}

if (import.meta.main) {
  const files = []
  walk(ROOT, files)

  const unmarked = []
  const bare = []
  let justified = 0

  for (const abs of files) {
    const rel = abs.slice(ROOT.length + 1).split(sep).join('/')
    if (!isTestFile(rel)) continue
    const src = readFileSync(abs, 'utf8')
    if (!mightCarryBound(src)) continue
    for (const hit of findWallClockBounds(src, abs)) {
      if (hit.marker === 'justified') justified += 1
      else if (hit.marker === 'bare') bare.push(`${rel}:${hit.line}  ${hit.text}`)
      else unmarked.push(`${rel}:${hit.line}  ${hit.text}`)
    }
  }

  let failed = false
  if (unmarked.length > 0) {
    failed = true
    console.error(
      'Wall-clock timing assertion found (ISSUES #438) — this compares REAL elapsed\n' +
        'time against a threshold, so it reddens when the runner is loaded rather than\n' +
        'when the code is wrong. Prefer, in this order: (1) delete it if a deterministic\n' +
        'assertion already covers the same contract; (2) convert it to a logical clock,\n' +
        'an ordering, or a discriminant; (3) if neither is possible, keep it with:\n' +
        `      // ${MARKER}: <why no deterministic assertion can replace this,\n` +
        '      // and what the measured margin is>\n' +
        'Offending assertions:',
    )
    for (const o of unmarked) console.error('  ' + o)
  }
  if (bare.length > 0) {
    failed = true
    console.error(
      `\nA \`${MARKER}\` marker with no real justification — an opt-out has to be an\n` +
        `ARGUED exception, not a silent one. Write at least ${MIN_JUSTIFICATION_CHARS} characters saying why no\n` +
        'deterministic assertion can replace this bound, and what the measured margin is:',
    )
    for (const o of bare) console.error('  ' + o)
  }

  if (failed) {
    console.error(`\nWALL-CLOCK-BOUND GATE: FAILED — ${unmarked.length} unmarked, ${bare.length} unjustified`)
    process.exit(1)
  }
  console.log(
    `WALL-CLOCK-BOUND GATE (no unmarked real-elapsed-time assertions): 0 found ✅` +
      ` (${justified} justified opt-out${justified === 1 ? '' : 's'})`,
  )
}
