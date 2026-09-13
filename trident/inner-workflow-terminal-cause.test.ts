/**
 * EVERY TERMINAL PATH NAMES WHY IT IS TERMINAL (#520) — enforced over the SHIPPED
 * `inner-workflow.mjs`, not asserted in prose.
 *
 * WHY A SOURCE-LEVEL GUARD AND NOT A BEHAVIOURAL ONE. "Every terminal path emits a
 * cause" is an ABSENCE claim about the paths that do not, and the only honest way to
 * make one is to ENUMERATE the paths rather than sample them. The inner workflow is a
 * detached script with a top-level return and no exports, so its twelve terminal exits
 * cannot be reached one at a time from a test process; what CAN be enumerated is every
 * `writeTerminalResult(...)` call site, which is the definition of a terminal path in
 * this file. This scans them all and fails on the first that hands over a result with no
 * `terminalCauseKind`.
 *
 * AND EVERY SCAN HERE CARRIES A POSITIVE CONTROL. A scanner that finds nothing proves
 * nothing until the same scanner has been shown finding something, so each guard is run
 * a second time over a DOCTORED copy of the same source with the defect reintroduced,
 * and that run must fail. Without those, a regex that silently stopped matching would
 * read as a clean bill of health — which is precisely how the four paths this card is
 * about went years without one.
 *
 * THE DRIFT THIS IS REALLY AGAINST is the one the spec item documents under HOW IT GOT
 * THIS WAY: the catch-all sentence was TRUE when it was written, and every early exit
 * added afterwards landed in it without anyone adding a terminal branch. Not randomness
 * — one plausible commit at a time. So the guard is not "the twelve known paths are
 * fine"; it is "a thirteenth WRITTEN THE WAY THIS CODEBASE WRITES THEM cannot be added
 * silently."
 *
 * THAT QUALIFIER IS LOAD-BEARING AND IT WAS ADDED LATE. For four rounds this file claimed
 * the unqualified version, and each round found another spelling it did not recognise —
 * an inline literal argument, a property-access callee, a shadowed binding, a nested
 * return, a computed callee. The instrument was widened four times to meet the claim
 * before anyone checked whether the CLAIM was the wrong half. It was: no source scanner
 * can promise that a call cannot be obscured, because obscuring it is always one more
 * spelling away. What this guard promises instead is bounded and checkable — every call
 * whose NAME IS WRITTEN LITERALLY at the site is seen, and anything it cannot resolve is
 * reported rather than skipped. The residual is owned at runtime by `stampTerminalCause`,
 * and `a COMPUTED callee is a documented NON-GOAL` makes the edge executable.
 */
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TERMINAL_CAUSES, type TerminalCause } from './terminal-cause.ts'

const SRC = await Bun.file(new URL('./inner-workflow.mjs', import.meta.url)).text()
/** Where the shipped file ends. Anything the controls below append starts after this, so
 *  the thirteenth site is identifiable by LINE without needing a marker inside its own
 *  source — a marker would have to be something the scanner reads, and the scanner is the
 *  thing under test. */
const SRC_LINES = SRC.split('\n').length

/** Brace-match one function or object out of the workflow source, from `at`. */
function braceMatchFrom(src: string, at: number): string {
  let depth = 0
  let started = false
  for (let i = at; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error('could not brace-match from offset')
}

/**
 * WHAT ONE TERMINAL PATH LOOKS LIKE TO THE SCANNER.
 *
 * `stamped` is the verdict, and it has FOUR values rather than a boolean because two
 * different things go wrong and they are not the same finding:
 *
 *  - `'literal'`  — the object carries `terminalCauseKind: '<member>'`. The normal case.
 *  - `'computed'` — the property is there but its value is an expression, not a literal
 *                   (the main terminal result computes its kind at the exit and passes it
 *                   by shorthand). Present, and correctly so; just not checkable here.
 *  - `'absent'`   — the object was resolved and has no such property. A silent path.
 *  - `'unresolved'` — the CALL was found but its argument could not be resolved to an
 *                   object literal at all. NOT a pass: it is the scanner saying it could
 *                   not tell, which is a finding about this file's coverage and must fail
 *                   exactly as loudly as a missing property.
 *
 * THE LAST VALUE IS THE WHOLE POINT AND IT IS WHY THIS FILE WAS REWRITTEN. The first cut
 * recognised a call only when its argument was a bare IDENTIFIER — the shape all twelve
 * of today's sites happen to use. `writeTerminalResult({ checkpoint: 'new-exit' })` did
 * not match the recogniser at all, so it never became a site, the count still read 12,
 * and every per-site assertion below was silent about it. A thirteenth path added with an
 * inline literal was invisible to the entire file.
 *
 * That is this file's own stated failure mode, one level up from where it was applied:
 * the resolver reported what it could not parse, and the RECOGNISER dropped it. A scanner
 * that silently drops what it cannot parse is a scanner that passes by construction, and
 * a sweep inherits its own domain's blind spot unless something exercises the recogniser
 * rather than only the resolver.
 */
interface TerminalSite {
  /** How the site is named in a failure message — the identifier, or the shape. */
  label: string
  /** 1-based line of the call. */
  line: number
  stamped: 'literal' | 'computed' | 'absent' | 'unresolved'
  /** The stamped member, when it is a string literal. */
  kind: string | null
  /** Why it could not be resolved — empty unless `stamped` is `'unresolved'`. */
  why: string
  /** The resolved object's own direct property names. Carried so that claims ABOUT the
   *  terminal results — "N of the twelve carry a `blockKind`" — can be derived here
   *  instead of counted by hand into prose, where three rounds of this card proved they
   *  go stale. Empty for an unresolved site. */
  props: readonly string[]
}

/**
 * PARSE AND BIND the shipped workflow, and hand back the compiler's own resolver.
 *
 * A `Program`, NOT A BARE `SourceFile`, AND THAT IS THE WHOLE POINT OF THIS ROUND. This
 * scanner resolved names by hand, and the hand-rolled resolver needed five fixes: lexical
 * scope, nested returns, duplicate declarations, duplicate object keys, and loop bindings.
 * That is not five accidents — it is the shape of reimplementing JavaScript scope
 * resolution. After loops come `class` bodies, block-scoped function declarations,
 * parameter-scope-vs-body-scope for defaults, and `import` bindings; each is real, each is
 * rarer than the last, and the list does not end.
 *
 * So the enumeration of cases is gone and `checker.getSymbolAtLocation` answers instead —
 * correct for every construct in the language BY CONSTRUCTION, including the five already
 * fixed and the ones nobody has thought of. It deleted `introducesScope`, `bindingIn`,
 * `lookup` and `bindsInPattern` outright.
 *
 * THE COST, STATED HONESTLY. A Program is heavier than a SourceFile — measured at ~180ms
 * cold and ~100ms warm for this file. `noLib`/`noResolve` keep it to binding, which is all
 * this needs, and the results are memoised because the controls re-scan the same doctored
 * sources. `allowJs` is required: the subject is a `.mjs`.
 *
 * THE COMPLETENESS OF THE PARSE IS ASSERTED, NOT CLAIMED IN PROSE. This used to carry
 * "checked: 214 statements", a number that was true when written and silently false the
 * moment `main` moved under it. A truncated parse is the one failure that would make every
 * assertion in this file vacuous while looking clean, so the test below measures it.
 */
const ANALYSIS_FILE = '/inner-workflow.mjs'
const analysed = new Map<string, { sf: ts.SourceFile; checker: ts.TypeChecker }>()
function analyse(src: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const cached = analysed.get(src)
  if (cached !== undefined) return cached
  const parsed = ts.createSourceFile(ANALYSIS_FILE, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === ANALYSIS_FILE ? parsed : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === ANALYSIS_FILE,
    readFile: (name) => (name === ANALYSIS_FILE ? src : undefined),
  }
  const program = ts.createProgram({
    rootNames: [ANALYSIS_FILE],
    // Binding only. `noLib` and `noResolve` keep this off the filesystem and out of type
    // checking, which is the part that would actually be slow.
    options: { allowJs: true, noLib: true, noResolve: true, types: [] },
    host,
  })
  const out = { sf: program.getSourceFile(ANALYSIS_FILE)!, checker: program.getTypeChecker() }
  analysed.set(src, out)
  return out
}

/**
 * THE TWO TRAVERSALS, AND WHY THERE HAVE TO BE TWO.
 *
 * `walk` descends into everything. `walkOwnScope` stops at any nested function-like
 * boundary, so it sees only what belongs to the construct it was handed.
 *
 * THE AUDIT THAT PRODUCED THIS SPLIT. This scanner has been narrowed four times, and the
 * last two were the SAME bug in two different helpers: a traversal that did not stop where
 * the construct it was reasoning about stops. `nearestDeclarationBefore` ignored lexical
 * scope; `composerReturnLiteral` ignored function boundaries and returned a literal from a
 * NESTED function, classifying a site as stamped while the real result carried no cause.
 * Fixing one instance and not the class is how a fifth round happens.
 *
 * So every traversal in this file is accounted for, and each one states which it is:
 *
 *  | site                        | scope it reasons about        | traversal      |
 *  |-----------------------------|-------------------------------|----------------|
 *  | `terminalSites`             | the whole file (every call)   | `walk`         |
 *  | the traversal inventory     | the whole guard file          | `walk`         |
 *  | `composerReturnLiterals`    | one function body             | `walkOwnScope` |
 *
 * The two unrestricted walks are the only ones whose construct genuinely IS a whole file.
 * `bindsInPattern` used to be a third entry and `lookup` a fourth; both are gone, because
 * NAME RESOLUTION IS NO LONGER TRAVERSED AT ALL — the compiler's checker answers it. The
 * shortest row in this table is the one that stopped needing a row.
 *
 * AND THAT TABLE IS ITSELF A CLAIM OF COMPLETENESS, so it is pinned by a test rather than
 * left as prose — the lesson of the round that produced it. `the traversal inventory is
 * pinned` below counts the call sites in THIS file and fails when either number moves, so
 * a new traversal cannot be added without someone deciding, in the diff, which kind it is.
 * A table nobody is forced to update is a table that goes stale exactly like the counts in
 * the as-built did.
 */
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (c) => walk(c, visit))
}

/**
 * Walk `root`'s subtree, but STOP at every nested function-like node — those belong to a
 * different scope and nothing inside them is evidence about `root`.
 *
 * `root` itself may be function-like (that is the point for `composerReturnLiteral`); the
 * boundary applies to its descendants.
 */
function walkOwnScope(root: ts.Node, visit: (n: ts.Node) => void): void {
  const step = (n: ts.Node): void => {
    visit(n)
    ts.forEachChild(n, (c) => {
      if (ts.isFunctionLike(c)) return
      step(c)
    })
  }
  step(root)
}

/**
 * EVERY CALL TO `writeTerminalResult`, MATCHED ON THE CALLEE AND NOTHING ELSE.
 *
 * The argument is then CLASSIFIED rather than filtered: whatever shape it is, the call is
 * already a site by the time we look at it, so no argument form can remove a path from
 * the enumeration. Three shapes resolve to an object literal — an inline literal, an
 * identifier bound to one, and an identifier bound to a composer call whose body returns
 * one (three of the twelve sites share `mergedTerminalResult`). An identifier is resolved
 * through the SCOPE CHAIN (`resolveName`), not by matching name text across the file, so a
 * shadowing binding refuses rather than being stepped over. Everything else is
 * `'unresolved'` and fails.
 */
function terminalSites(src: string): TerminalSite[] {
  const { sf, checker } = analyse(src)
  const sites: TerminalSite[] = []
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return
    if (!callsTerminalWrite(n)) return
    const arg = n.arguments[0]
    const line = lineOf(n)
    if (arg === undefined) {
      sites.push({ label: '(no argument)', line, stamped: 'unresolved', kind: null, why: 'called with no argument', props: [] })
      return
    }
    const label = ts.isIdentifier(arg) ? arg.text : ts.SyntaxKind[arg.kind]
    const resolved = resolveToObjectLiterals(checker, arg)
    if (resolved === null) {
      sites.push({
        label,
        line,
        stamped: 'unresolved',
        kind: null,
        // The shape is NAMED, not just refused — a guard that says only "no" leaves the
        // next author guessing which of the handled forms they missed.
        why: `argument is a ${ts.SyntaxKind[arg.kind]} the scanner cannot resolve to an object literal`,
        props: [],
      })
      return
    }
    // `props` describes the FIRST resolved object; it exists only so claims about the
    // results (how many carry a `blockKind`) can be derived rather than remembered, and
    // every real site resolves to exactly one object.
    sites.push({ label, line, ...readCause(resolved), props: ownPropertyNames(resolved[0]!) })
  })
  return sites
}

/**
 * IS THIS A CALL TO `writeTerminalResult`? Asked of the CALLEE and of nothing else.
 *
 * THE RULE, STATED SO IT HAS AN EDGE: **the name must be written literally at the call
 * site.** Three spellings satisfy that and all three are recognised — a bare identifier, a
 * property access, and an element access with a literal key. Everything else is outside
 * this instrument, and that is a decision rather than an oversight.
 *
 * WHY THE RULE IS BOUNDED, WHICH IS THE CORRECTION THIS FILE NEEDED MOST. Four times this
 * scanner was narrowed and four times it was widened to match; the fifth report was a
 * computed callee, and the honest answer is that widening cannot terminate. After element
 * access comes a name computed from a variable, then an alias, then a re-export, then
 * `eval`. Each is a real hole in a literal reading of "any spelling", each is less
 * reachable than the last, and NONE of them is how anyone adds a terminal path. Chasing
 * them buys nothing and costs the one thing a guard must have: a reader able to say what
 * it does and does not cover.
 *
 * SO THE CLAIM IS THE PART THAT MOVED. This guard does not promise that a thirteenth
 * terminal path cannot be added silently — no source scanner can promise that. It promises
 * that a path written the way this codebase writes them is SEEN, and that anything it
 * cannot resolve is REPORTED rather than skipped. The residual — a deliberately obscured
 * call site — has a different owner: `stampTerminalCause` stamps `'unknown'` at RUNTIME and
 * writes the gap to the run log, so an obscured path still cannot travel with a cause it
 * never earned. A guard with a stated boundary plus a runtime backstop is stronger than a
 * guard with an unbounded claim: the first tells a reader where to look, the second tells
 * them not to.
 *
 * `the computed callee is a documented NON-GOAL` below makes that boundary executable
 * rather than prose.
 */
function callsTerminalWrite(n: ts.CallExpression): boolean {
  const callee = n.expression
  if (ts.isIdentifier(callee)) return callee.text === 'writeTerminalResult'
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'writeTerminalResult'
  // An element access counts only when the key is a LITERAL — `obj['writeTerminalResult']`
  // still writes the name in the source, which is where this rule draws its edge. A
  // computed key does not, and is deliberately not chased.
  if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression
    return ts.isStringLiteralLike(key) && key.text === 'writeTerminalResult'
  }
  return false
}

/**
 * EVERY OBJECT LITERAL THIS ARGUMENT CAN BE, or `null` when it names none.
 *
 * A LIST, NOT ONE. A composer may return from more than one place, and taking the first
 * return was a real false pass: a branching composer is an ORDINARY thing to write —
 *
 *     function newExitResult(stamped) {
 *       if (stamped) return { terminalCauseKind: 'workflow-threw' }
 *       return { ok: false, checkpoint: 'new-exit' }      // ← the unstamped one
 *     }
 *
 * — and the scanner resolved the first, called the site stamped, and reported nothing. That
 * is inside the claim this guard makes, not outside it: nobody writes
 * `obj['writeTerminalResult'](…)`, but anyone might add that composer on a Tuesday.
 *
 * THE QUESTION THAT FOUND IT is one level up from the traversal audit. That audit asked
 * whether each walk STOPS at the right boundary; this asks whether each walk CONSIDERS
 * EVERYTHING inside it. Three resolvers answered for the first instance they found: this
 * one, `readCauseOf`, and the hand-rolled scope lookup — which no longer exists, because
 * the round after this one replaced it with the compiler's checker rather than fixing a
 * fourth case in it.
 */
function resolveToObjectLiterals(checker: ts.TypeChecker, arg: ts.Expression): ts.ObjectLiteralExpression[] | null {
  if (ts.isObjectLiteralExpression(arg)) return [arg]
  if (!ts.isIdentifier(arg)) return null
  const bound = lookup(checker, arg)
  // A FUNCTION DECLARATION IS NOT AN OBJECT, and neither is an opaque binding. Both refuse.
  if (bound === null || bound.kind !== 'value') return null
  if (ts.isObjectLiteralExpression(bound.init)) return [bound.init]
  // A composer call — follow it into that function's OWN returns, resolving the composer
  // name from the CALL's position so a shadowed composer refuses like any other name.
  if (ts.isCallExpression(bound.init) && ts.isIdentifier(bound.init.expression)) {
    return composerReturnLiterals(checker, bound.init.expression)
  }
  return null
}

/**
 * WHAT DOES THIS NAME MEAN, AT THIS USE SITE? — asked of the COMPILER, not reimplemented.
 *
 * `getSymbolAtLocation` gives the binding TypeScript itself resolves, which is the binding
 * the runtime uses. Everything the hand-rolled version got wrong one case at a time — a
 * shadowing parameter, a catch variable, a destructured name, a name declared twice, a
 * `for (const x of …)` head — is correct here because none of them is a case here; they are
 * all just scope, and the checker does scope.
 *
 * WHAT IS STILL THIS FILE'S JUDGEMENT is only which declarations it is willing to READ
 * THROUGH, and that stays deliberately narrow: a `const`/`let`/`var` WITH an initialiser,
 * or a function declaration. A parameter, a catch variable, a binding element, a loop head,
 * an import, a class — anything whose value is not a literal sitting in the declaration —
 * is `'opaque'`, and the caller turns that into `'unresolved'`, which fails the guard
 * loudly. It errs toward refusal, the only direction this guard may fail in.
 *
 * MORE THAN ONE DECLARATION IS AN AMBIGUITY, NOT A FIRST-ONE-WINS. A symbol with several
 * declarations (`var` twice, a `var` beside a function) has no single answer to "which
 * literal is this", so it refuses rather than picking.
 */
type Binding =
  | { kind: 'value'; init: ts.Expression }
  | { kind: 'function'; decl: ts.FunctionDeclaration }
  | { kind: 'opaque' }

function lookup(checker: ts.TypeChecker, id: ts.Identifier): Binding | null {
  const symbol = checker.getSymbolAtLocation(id)
  const declarations = symbol?.declarations ?? []
  if (declarations.length === 0) return null
  if (declarations.length > 1) return { kind: 'opaque' }
  const decl = declarations[0]!
  if (ts.isFunctionDeclaration(decl)) return { kind: 'function', decl }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
    return { kind: 'value', init: decl.initializer }
  }
  return { kind: 'opaque' }
}

/**
 * EVERY OBJECT LITERAL A NAMED FUNCTION RETURNS FROM ITS OWN BODY, or `null`.
 *
 * TWO BOUNDARIES, AND BOTH WERE CROSSED ONCE. The function was looked up by walking the
 * WHOLE file for a matching name, and its `return` was found by walking its ENTIRE subtree
 * — so a literal inside a NESTED function was returned as the composer's own result. Both
 * are closed now: the name resolves through the shared scope chain, and the returns are
 * gathered with `walkOwnScope`.
 *
 * AND THEN THE COUNT WAS WRONG TOO. It took the FIRST own-scope return and ignored later
 * ones, so a composer that returns a stamped object on one branch and an unstamped one on
 * another read as stamped. Every own-scope return is collected now, and `readCause`
 * requires ALL of them to carry the field — a composer whose branches are all stamped is
 * genuinely fine, and one where any branch is not must fail.
 *
 * A RETURN THIS SCANNER CANNOT READ REFUSES THE WHOLE COMPOSER. `return someVariable` or
 * `return cond ? a : b` is a result object it cannot see, and a composer with one of those
 * is one whose stamping cannot be established — `'unresolved'`, which fails loudly, rather
 * than a verdict drawn from the returns that happen to be literals. Same for a composer
 * with no object-literal return at all.
 */
function composerReturnLiterals(checker: ts.TypeChecker, callee: ts.Identifier): ts.ObjectLiteralExpression[] | null {
  const bound = lookup(checker, callee)
  if (bound === null || bound.kind !== 'function') return null
  const literals: ts.ObjectLiteralExpression[] = []
  let unreadable = false
  walkOwnScope(bound.decl, (n) => {
    if (!ts.isReturnStatement(n)) return
    // A bare `return` yields undefined, which is not a terminal result this scanner can
    // judge; treat it like any other unreadable return rather than ignoring it.
    if (n.expression === undefined || !ts.isObjectLiteralExpression(n.expression)) {
      unreadable = true
      return
    }
    literals.push(n.expression)
  })
  if (unreadable || literals.length === 0) return null
  return literals
}

/**
 * IS `terminalCauseKind` AN ACTUAL PROPERTY OF THIS OBJECT?
 *
 * A PROPERTY, NOT A SUBSTRING. The first cut asked `literal.includes('terminalCauseKind')`
 * over the object's raw source, so a site passed if it merely mentioned the field in a
 * COMMENT — and this file's objects are heavily commented, so that is not a hypothetical
 * near-miss. Presence of a string is not presence of a property.
 *
 * A SPREAD DOES NOT COUNT, deliberately. `...(cond ? { terminalCauseKind: x } : {})` is a
 * property that arrives only sometimes, which is exactly the silence this guard exists to
 * refuse; only a direct assignment or shorthand is a promise the field is always there.
 */
function ownPropertyNames(obj: ts.ObjectLiteralExpression): string[] {
  const names: string[] = []
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) names.push(prop.name.text)
    else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      names.push(prop.name.text)
    }
  }
  return names
}

function readCauseOf(obj: ts.ObjectLiteralExpression): Pick<TerminalSite, 'stamped' | 'kind' | 'why'> {
  // LAST WINS, NOT FIRST — the other "first instance it finds" answer the audit turned up.
  // `{ terminalCauseKind: 'a', terminalCauseKind: 'b' }` is legal and evaluates to 'b', so
  // reading the first match reported a value no runtime would produce. Rare in hand-written
  // code and free to get right, which is the whole argument for getting it right.
  let found: Pick<TerminalSite, 'stamped' | 'kind' | 'why'> | null = null
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'terminalCauseKind') {
      found = { stamped: 'computed', kind: null, why: '' }
      continue
    }
    if (!ts.isPropertyAssignment(prop)) continue
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
    if (key !== 'terminalCauseKind') continue
    found = ts.isStringLiteralLike(prop.initializer)
      ? { stamped: 'literal', kind: prop.initializer.text, why: '' }
      : { stamped: 'computed', kind: null, why: '' }
  }
  return found ?? { stamped: 'absent', kind: null, why: 'the result object has no terminalCauseKind property' }
}

/**
 * THE VERDICT FOR A SITE, OVER EVERY OBJECT ITS ARGUMENT CAN BE.
 *
 * ALL, NOT ANY. A composer with several returns is stamped only when EVERY one of them
 * carries the field; one unstamped branch is an unstamped path, and it is reported with
 * the count so the failure says how many of how many were missing it. A guard that
 * accepted "some return was stamped" would pass the branching composer this was written
 * for.
 */
function readCause(objs: readonly ts.ObjectLiteralExpression[]): Pick<TerminalSite, 'stamped' | 'kind' | 'why'> {
  const read = objs.map(readCauseOf)
  const bare = read.filter((r) => r.stamped === 'absent')
  if (bare.length > 0) {
    return {
      stamped: 'absent',
      kind: null,
      why:
        objs.length === 1
          ? 'the result object has no terminalCauseKind property'
          : `${bare.length} of ${objs.length} returned objects have no terminalCauseKind property`,
    }
  }
  const kinds = new Set(read.map((r) => r.kind))
  // Every branch stamps, but not all with the same literal — present, and not a single
  // value this scanner can name. `'computed'` is the honest label for that.
  if (read.some((r) => r.stamped === 'computed') || kinds.size > 1) {
    return { stamped: 'computed', kind: null, why: '' }
  }
  return { stamped: 'literal', kind: read[0]!.kind, why: '' }
}

/** The sites this guard refuses: a silent path, and a path it could not read. */
function failingSites(src: string): string[] {
  return terminalSites(src)
    .filter((s) => s.stamped === 'absent' || s.stamped === 'unresolved')
    .map((s) => `${s.label} (line ${s.line}): ${s.why}`)
}

/** A thirteenth terminal path, appended in a named argument shape. Valid JS in every
 *  case, so the control tests the RECOGNISER rather than the parser's error recovery. */
const THIRTEENTH: Record<string, string> = {
  'inline object literal': `
async function newExitPath() {
  await writeTerminalResult({ ok: false, checkpoint: 'new-exit' })
}`,
  'identifier bound to an inline literal': `
async function newExitPath() {
  const newExit = { ok: false, checkpoint: 'new-exit' }
  await writeTerminalResult(newExit)
}`,
  'identifier bound to a composer call': `
function newExitResult() {
  return { ok: false, checkpoint: 'new-exit' }
}
async function newExitPath() {
  const newExit = newExitResult()
  await writeTerminalResult(newExit)
}`,
  'an object whose COMMENT mentions the field but has no such property': `
async function newExitPath() {
  await writeTerminalResult({
    ok: false,
    checkpoint: 'new-exit',
    // terminalCauseKind is stamped by whoever reads this result
  })
}`,
  'a shape the scanner does NOT handle': `
async function newExitPath() {
  await writeTerminalResult(Date.now() > 0 ? { ok: false } : null)
}`,
  'an inline conditional spread that only SOMETIMES carries the field': `
async function newExitPath() {
  await writeTerminalResult({
    ok: false,
    checkpoint: 'new-exit',
    ...(Date.now() > 0 ? { terminalCauseKind: 'workflow-threw' } : {}),
  })
}`,
  'no argument at all': `
async function newExitPath() {
  await writeTerminalResult()
}`,
  'a call reached through a literal element access': `
const terminal = { writeTerminalResult }
async function newExitPath() {
  await terminal['writeTerminalResult']({ ok: false, checkpoint: 'new-exit' })
}`,
  'a call reached through a property access': `
const terminal = { writeTerminalResult }
async function newExitPath() {
  await terminal.writeTerminalResult({ ok: false, checkpoint: 'new-exit' })
}`,
  // THE SHADOWING CASE. The outer `const` IS stamped, and a resolver that matches by name
  // text across the whole file answers from it — reporting a stamped site for a path that
  // hands over an unstamped parameter. The name is deliberately one this file already
  // uses at a real call site, because that is what makes the wrong answer available.
  'a parameter that shadows an outer stamped const': `
const stamped = { ok: false, terminalCauseKind: 'workflow-threw' }
async function newExitPath(stamped) {
  await writeTerminalResult(stamped)
}`,
  'a catch variable that shadows an outer stamped const': `
const caught = { ok: false, terminalCauseKind: 'workflow-threw' }
async function newExitPath() {
  try {
    throw new Error('x')
  } catch (caught) {
    await writeTerminalResult(caught)
  }
}`,
  'a destructured parameter that shadows an outer stamped const': `
const picked = { ok: false, terminalCauseKind: 'workflow-threw' }
async function newExitPath({ picked }) {
  await writeTerminalResult(picked)
}`,
  // THE DECOY. The composer's OWN result carries no cause; a NESTED function returns one.
  // A traversal that walks the whole subtree finds the decoy first and reports the site as
  // stamped — the same boundary-blindness as the shadowing cases above, one helper over.
  'a composer whose NESTED function returns the only stamped literal': `
function newExitResult() {
  function decoy() {
    return { terminalCauseKind: 'workflow-threw' }
  }
  return { ok: false, checkpoint: 'new-exit' }
}
async function newExitPath() {
  const newExit = newExitResult()
  await writeTerminalResult(newExit)
}`,
  // A LOOP HEAD THAT SHADOWS AN OUTER STAMPED CONST. The sixth construct the hand-rolled
  // resolver did not model, and the one that ended the enumeration: `introducesScope` had
  // no loop scopes and `bindingIn` read statements only from a SourceFile or a Block, so
  // the name resolved outward to the stamped literal.
  'a for-of binding that shadows an outer stamped const': `
const looped = { terminalCauseKind: 'workflow-threw' }
async function newExitPath() {
  for (const looped of [{ ok: false, checkpoint: 'new-exit' }]) {
    await writeTerminalResult(looped)
  }
}`,
  'a for-let binding that shadows an outer stamped const': `
const counted = { terminalCauseKind: 'workflow-threw' }
async function newExitPath() {
  for (let counted = 0; counted < 1; counted += 1) {
    await writeTerminalResult(counted)
  }
}`,
  // A BRANCHING COMPOSER WITH ONE UNSTAMPED RETURN. An ordinary thing to write, which is
  // what puts it inside this guard's claim rather than outside it. The stamped branch is
  // FIRST so that a scanner reading only the first return calls the site stamped.
  'a composer that returns a stamped object on one branch and an unstamped one on another': `
function newExitResult(stamped) {
  if (stamped) return { terminalCauseKind: 'workflow-threw' }
  return { ok: false, checkpoint: 'new-exit' }
}
async function newExitPath() {
  const newExit = newExitResult(false)
  await writeTerminalResult(newExit)
}`,
  // …and the unstamped branch LAST-but-one, so a scanner reading only the last return is
  // caught too. Neither end of the list is a safe place to look.
  'a composer whose unstamped return is not the last one': `
function newExitResult(mode) {
  if (mode === 'a') return { terminalCauseKind: 'workflow-threw' }
  if (mode === 'b') return { ok: false, checkpoint: 'new-exit' }
  return { terminalCauseKind: 'workflow-threw' }
}
async function newExitPath() {
  const newExit = newExitResult('b')
  await writeTerminalResult(newExit)
}`,
  // A RETURN THIS SCANNER CANNOT READ refuses the whole composer rather than judging it
  // from the returns that happen to be literals.
  'a composer with a return the scanner cannot read': `
const elsewhere = { ok: false, checkpoint: 'new-exit' }
function newExitResult(stamped) {
  if (stamped) return { terminalCauseKind: 'workflow-threw' }
  return elsewhere
}
async function newExitPath() {
  const newExit = newExitResult(false)
  await writeTerminalResult(newExit)
}`,
  // …AND THE COMPOSER NAME RESOLVED FROM THE WRONG SCOPE. The real composer is the one
  // declared beside the call; the two decoys are same-named declarations in unrelated
  // scopes, and they sit on BOTH sides of it in source order deliberately. A file-wide
  // search picks a decoy whether it keeps the first match or the last, so this control
  // cannot be satisfied by a traversal that merely happens to visit in a lucky order.
  'a composer name shadowed by same-named declarations on both sides': `
function newExitResult() {
  return { terminalCauseKind: 'workflow-threw' }
}
async function newExitPath() {
  function newExitResult() {
    return { ok: false, checkpoint: 'new-exit' }
  }
  const newExit = newExitResult()
  await writeTerminalResult(newExit)
}
function decoyHolder() {
  function newExitResult() {
    return { terminalCauseKind: 'workflow-threw' }
  }
  return newExitResult()
}`,
}

describe('#520 — every terminal path of the inner workflow names its cause', () => {
  /**
   * THE GUARD'S GUARD. Four narrowings of this scanner, and the last two were one bug —
   * a traversal that did not stop where its construct stops — in two different helpers.
   * The audit that followed is written as a table at `walk`, and a table nobody is forced
   * to update goes stale. So the inventory is COUNTED, from this file's own source.
   *
   * Failing here does not mean the new traversal is wrong. It means nobody has yet said
   * which kind it is, and that is exactly the decision the last two rounds were lost to.
   */
  /**
   * THE BOUNDARY, ASSERTED RATHER THAN DESCRIBED.
   *
   * This scanner sees a call whose NAME IS WRITTEN LITERALLY at the call site — a bare
   * identifier, a property access, or an element access with a literal key. A callee
   * computed at runtime is NOT seen, and that is a deliberate non-goal.
   *
   * WHY IT IS A NON-GOAL AND NOT A BUG. Four rounds widened this instrument to meet an
   * unbounded claim ("a thirteenth path cannot be added silently"), and the fifth report
   * showed why that cannot terminate: after a computed key comes an alias, then a
   * re-export, then `eval`. Each is a genuine hole in a literal reading of "any spelling",
   * each less reachable than the last, and none is how anyone adds a terminal path. The
   * claim was the wrong half — so it moved, and this test is where the new one is written
   * down in a form that fails if it stops being true.
   *
   * THE RESIDUAL HAS AN OWNER. A deliberately obscured call site still reaches
   * `writeTerminalResult` at runtime, where `stampTerminalCause` stamps `'unknown'` and
   * writes the gap to the run log (see its own describe below). So an obscured path cannot
   * travel carrying a cause it never earned; it can only travel carrying the honest
   * non-answer. That is the backstop this boundary is safe to have.
   */
  test('a COMPUTED callee is a documented NON-GOAL, and the runtime backstop is why that is safe', () => {
    const computed = `${SRC}
const key = 'writeTerminalResult'
const terminal = { writeTerminalResult }
async function newExitPath() {
  await terminal[key]({ ok: false, checkpoint: 'new-exit' })
}
`
    // NOT seen — stated as an equality against the shipped count so the boundary is a
    // measured fact rather than a sentence somebody believed.
    expect(terminalSites(computed).length).toBe(12)
    expect(failingSites(computed)).toEqual([])

    // …whereas the LITERAL key is inside the boundary and is both seen and refused.
    const literal = `${SRC}\n${THIRTEENTH['a call reached through a literal element access']}\n`
    expect(terminalSites(literal).length).toBe(13)
    expect(failingSites(literal).length).toBe(1)
  })

  /**
   * THE CLAIM THE VOCABULARY'S DESIGN RESTS ON, MADE EXECUTABLE.
   *
   * `terminal-cause.ts` argues that `terminalCauseKind` had to be a NEW field rather than a
   * widening of `blockKind`, and one leg of that argument is that most terminal paths are
   * not review verdicts and carry no `blockKind` at all. That leg was written as a number
   * in a docblock — and the number was WRONG WHEN WRITTEN, not merely stale: it said seven
   * of twelve, and the real figure is four. Nobody derived it, including me.
   *
   * So it is derived here. The argument survives (four of twelve carry nothing, and
   * `blockKind` is load-bearing precisely because it is narrow) but it now rests on a
   * measurement that fails if it stops being true.
   */
  test('the blockKind claim is derived, not remembered', () => {
    const sites = terminalSites(SRC)
    const withBlockKind = sites.filter((s) => s.props.includes('blockKind'))
    expect({ total: sites.length, withBlockKind: withBlockKind.length }).toEqual({ total: 12, withBlockKind: 8 })
    // …so four carry none, which is the figure `terminal-cause.ts` cites.
    expect(sites.length - withBlockKind.length).toBe(4)
  })

  test('the traversal inventory is pinned — a new walk forces the audit', () => {
    const self = ts.createSourceFile(
      'guard.test.ts',
      readFileSync(fileURLToPath(new URL('./inner-workflow-terminal-cause.test.ts', import.meta.url)), 'utf8'),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const calls = { walk: 0, walkOwnScope: 0 }
    walk(self, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return
      if (n.expression.text === 'walk') calls.walk += 1
      if (n.expression.text === 'walkOwnScope') calls.walkOwnScope += 1
    })
    // `walk`: its own recursive call, plus `terminalSites` — whose construct really is the
    // whole file — plus this inventory, which is also scanning a whole file.
    // `walkOwnScope`: `composerReturnLiterals` alone, the one traversal left that reasons
    // about a single construct and must stop at its edge. It was two until the checker
    // replaced hand-rolled name resolution and `bindsInPattern` stopped existing.
    expect(calls).toEqual({ walk: 3, walkOwnScope: 1 })
  })

  test('the parse is COMPLETE — a truncated tree would make every assertion below vacuous', () => {
    // The floor under the floor. A parse that stopped early would yield few statements and
    // few calls, and every "no failing sites" assertion would pass on a tree that never
    // contained the code. Measured against the file's real size rather than a number
    // copied into a comment, so `main` moving cannot make it quietly untrue.
    const { sf } = analyse(SRC)
    expect(sf.statements.length).toBeGreaterThan(100)
    // The tail of the file must be inside the tree, not past where a parse gave up.
    const lastStatement = sf.statements[sf.statements.length - 1]!
    const endLine = sf.getLineAndCharacterOfPosition(lastStatement.getEnd()).line + 1
    expect(endLine).toBeGreaterThan(SRC_LINES - 50)
  })

  test('the enumeration is the twelve calls main carries', () => {
    // THE SCANNER'S OWN FLOOR. If the recogniser stops matching, every assertion below
    // passes vacuously — so the count is pinned, and the shapes-controls further down
    // prove the recogniser can still GROW when a path is added.
    const sites = terminalSites(SRC)
    expect(sites.length).toBe(12)
    // …and none of them is a site the scanner merely guessed at.
    expect(sites.filter((s) => s.stamped === 'unresolved')).toEqual([])
  })

  test('every call site hands over an explicit terminalCauseKind', () => {
    // Named, not counted: the failure message has to say WHICH path went out silent, and
    // whether it went silent or was merely unreadable.
    expect(failingSites(SRC)).toEqual([])
  })

  test('eleven sites name a literal member; the review loop computes its own', () => {
    const sites = terminalSites(SRC)
    const literal = sites.filter((s) => s.stamped === 'literal')
    const computed = sites.filter((s) => s.stamped === 'computed')
    expect(computed.map((s) => s.label)).toEqual(['terminalResult'])
    expect(literal.length).toBe(11)
    for (const s of literal) expect(TERMINAL_CAUSES).toContain(s.kind as TerminalCause)
  })

  /**
   * THE CONTROL THE FIRST CUT WAS MISSING.
   *
   * Its positive controls deleted a known property line, which exercises the RESOLVER on
   * sites the recogniser had already found. Nothing exercised the recogniser. So a
   * thirteenth path written in a shape the regex did not know — an inline object literal,
   * the most obvious way anyone would add one — was invisible, and the guard reported a
   * clean tree.
   *
   * Each case below appends a real thirteenth call in a named argument shape and requires
   * the guard to go RED. The two halves are both asserted: the site must be SEEN (the
   * count grows to 13) and it must be REFUSED. A shape that is seen but silently passes
   * is the same defect wearing a different coat.
   */
  describe('POSITIVE CONTROL — a thirteenth path is refused in every argument shape', () => {
    for (const [shape, code] of Object.entries(THIRTEENTH)) {
      test(`a new terminal path written as ${shape} fails the guard`, () => {
        const doctored = `${SRC}\n${code}\n`
        const sites = terminalSites(doctored)
        // SEEN: the enumeration grew. This is the half the first cut could not do — an
        // inline literal never became a site at all and the count stayed at 12.
        expect(sites.length).toBe(13)
        const added = sites.filter((s) => s.line > SRC_LINES)
        expect(added.length).toBe(1)
        // REFUSED: and it is the new one that fails, not some pre-existing site.
        const failing = failingSites(doctored)
        expect(failing.length).toBe(1)
        expect(failing[0]).toContain(`line ${added[0]!.line}`)
      })
    }
  })

  test('POSITIVE CONTROL — the two refusals are told apart, not merged into one "no"', () => {
    // A path that says nothing and a path the scanner cannot read are different findings
    // with different fixes, and this file's own rule is that "could not establish" never
    // shares a branch with a determinate answer. The guard fails on both; the REPORT
    // still distinguishes them.
    const added = (code: string) => terminalSites(`${SRC}\n${code}\n`).find((s) => s.line > SRC_LINES)
    expect(added(THIRTEENTH['inline object literal']!)?.stamped).toBe('absent')
    expect(added(THIRTEENTH['a shape the scanner does NOT handle']!)?.stamped).toBe('unresolved')
    expect(added(THIRTEENTH['no argument at all']!)?.stamped).toBe('unresolved')
    // …and the report says WHICH, so the next author knows whether to add a stamp or to
    // teach this scanner a shape.
    const why = failingSites(`${SRC}\n${THIRTEENTH['a shape the scanner does NOT handle']}\n`)[0]!
    expect(why).toContain('cannot resolve to an object literal')
    expect(why).toContain('ConditionalExpression')
  })

  test('POSITIVE CONTROL — deleting a stamp from an existing site is still caught', () => {
    // The resolver control the first cut had. Kept, because it covers the other
    // direction: a path that exists today losing its cause, rather than a new one
    // arriving without one. Chosen for the catch path because its omission produced the
    // measured defect (run 3d2696c3, reported as "…without Argus APPROVE" on a path Argus
    // never reached).
    const doctored = SRC.replace("    terminalCauseKind: 'workflow-threw',\n", '')
    expect(doctored).not.toBe(SRC)
    expect(failingSites(doctored).map((f) => f.split(' ')[0])).toEqual(['failureResult'])
  })

  /**
   * THE OTHER HALF OF THE SHADOWING RULE, AND IT NEEDS ITS OWN TEST.
   *
   * "A shadowed name is unresolved" is satisfied by a resolver that resolves NOTHING, and
   * that resolver still fails the whole guard — N5 and N6 show it as a 13-case collapse,
   * so it would be noticed. But being noticed by collateral damage is not the same as
   * being asserted: this pins the INTENT, which is that the scope walk refuses a shadowed
   * binding WITHOUT losing the ordinary one it exists to read.
   */
  test('an ordinary binding still resolves — the scope walk refuses, it does not give up', () => {
    const ordinary = `${SRC}
const newExit = { ok: false, checkpoint: 'new-exit', terminalCauseKind: 'workflow-threw' }
async function newExitPath() {
  await writeTerminalResult(newExit)
}
`
    const sites = terminalSites(ordinary)
    expect(sites.length).toBe(13)
    const added = sites.find((s) => s.line > SRC_LINES)!
    // Resolved, read, and found stamped — so the guard stays SILENT on it, which is the
    // half a refuse-everything resolver could never produce.
    expect({ stamped: added.stamped, kind: added.kind }).toEqual({ stamped: 'literal', kind: 'workflow-threw' })
    expect(failingSites(ordinary)).toEqual([])
  })

  /**
   * THE CONTROL PAIR FOR LOOP SCOPES — and the argument for deleting the hand-rolled
   * resolver rather than adding a sixth case to it.
   *
   * `introducesScope` listed SourceFile, Block, CatchClause and FunctionLike; a `for` head
   * is none of those, so a loop binding was invisible exactly the way a parameter had been
   * two rounds earlier. Counting what the resolver had needed — lexical scope, nested
   * returns, duplicate declarations, duplicate keys, loop bindings — made the shape
   * obvious: that is not five accidents, it is reimplementing JavaScript scope resolution.
   * The checker does it correctly by construction, including the constructs neither of us
   * has thought of.
   *
   * The pair is both halves: a shadowing loop binding REFUSED, and an unshadowed outer
   * binding still RESOLVED — because "loop bindings are handled" is satisfied by a resolver
   * that resolves nothing.
   */
  test('a loop binding shadows, and is refused rather than resolved outward', () => {
    for (const shape of [
      'a for-of binding that shadows an outer stamped const',
      'a for-let binding that shadows an outer stamped const',
    ]) {
      const doctored = `${SRC}\n${THIRTEENTH[shape]}\n`
      const added = terminalSites(doctored).find((s) => s.line > SRC_LINES)!
      expect({ shape, stamped: added.stamped }).toEqual({ shape, stamped: 'unresolved' })
      expect(failingSites(doctored).length).toBe(1)
    }
  })

  test('a shadowed binding is refused by NAME, not by position — the nearest scope wins', () => {
    // Spelled as an equality against the ordinary case above, so the difference is
    // isolated to the shadowing and nothing else: identical outer const, identical call,
    // and the ONLY change is that a parameter in between binds the same name.
    const shadowed = `${SRC}\n${THIRTEENTH['a parameter that shadows an outer stamped const']}\n`
    const added = terminalSites(shadowed).find((s) => s.line > SRC_LINES)!
    expect(added.stamped).toBe('unresolved')
    expect(added.why).toContain('cannot resolve to an object literal')
  })

  /**
   * THE COMPOSER'S BODY IS A SCOPE, AND THE SCAN MUST STOP AT ITS EDGE.
   *
   * Asserted as a pair with the "sees through the shared composer" control below, because
   * the two pull in opposite directions and a fix for either one alone is wrong: the
   * scanner must follow a composer into its OWN return, and must not follow it into a
   * nested function's. A traversal that stops too early fails the second; one that does
   * not stop at all fails this.
   */
  /**
   * THE OVER-STRICT DIRECTION, which no false-pass control can reach.
   *
   * A default value may itself be a function, and the names in THAT function's parameters
   * belong to it, not to the enclosing pattern. The hand-rolled resolver walked the whole
   * pattern subtree and answered "yes, bound" for a name that was never in scope, refusing
   * a site it should have read.
   *
   * That direction fails SAFE — a false refusal, never a false pass — so no false-pass
   * control could have found it; the traversal audit did. The case is kept now that the
   * checker owns resolution, because it is precisely the kind of construct a hand-rolled
   * resolver gets wrong and the compiler does not, and a control that survives the fix is
   * the one worth keeping.
   */
  test('a name bound only inside a default-value function does not shadow the outer const', () => {
    const doctored = `${SRC}
const picked = { ok: false, checkpoint: 'new-exit', terminalCauseKind: 'workflow-threw' }
async function newExitPath({ other = ({ picked }) => picked }) {
  await writeTerminalResult(picked)
}
`
    const added = terminalSites(doctored).find((s) => s.line > SRC_LINES)!
    // The parameter pattern binds `other`, not `picked`. So the walk continues outward,
    // finds the outer const, reads it, and the guard stays SILENT — the half a
    // boundary-blind traversal turns into a spurious failure.
    expect({ stamped: added.stamped, kind: added.kind }).toEqual({ stamped: 'literal', kind: 'workflow-threw' })
    expect(failingSites(doctored)).toEqual([])
  })

  /**
   * A COMPOSER IS JUDGED ON ALL OF ITS RETURNS, AND BOTH DIRECTIONS ARE ASSERTED.
   *
   * "Multi-return is handled" is satisfied by a resolver that refuses EVERY composer — and
   * that resolver would red the three real sites which reach their cause through
   * `mergedTerminalResult`. So the pair is the test: a two-return composer where BOTH are
   * stamped must pass, and one where EITHER is not must fail. Neither half is the property
   * on its own.
   */
  test('a composer whose returns are ALL stamped is fine', () => {
    const ok = `${SRC}
function newExitResult(mode) {
  if (mode === 'a') return { ok: false, terminalCauseKind: 'workflow-threw' }
  return { ok: false, terminalCauseKind: 'workflow-threw' }
}
async function newExitPath() {
  const newExit = newExitResult('b')
  await writeTerminalResult(newExit)
}
`
    const added = terminalSites(ok).find((s) => s.line > SRC_LINES)!
    expect({ stamped: added.stamped, kind: added.kind }).toEqual({ stamped: 'literal', kind: 'workflow-threw' })
    expect(failingSites(ok)).toEqual([])
  })

  test('…and all-stamped-but-DIFFERENT is present without being a single value', () => {
    const differing = `${SRC}
function newExitResult(mode) {
  if (mode === 'a') return { ok: false, terminalCauseKind: 'workflow-threw' }
  return { ok: false, terminalCauseKind: 'ralph-task-built' }
}
async function newExitPath() {
  const newExit = newExitResult('b')
  await writeTerminalResult(newExit)
}
`
    const added = terminalSites(differing).find((s) => s.line > SRC_LINES)!
    // Stamped on every branch, so the guard is silent — but the scanner will not name a
    // single literal it cannot know, which is what `'computed'` is for.
    expect({ stamped: added.stamped, kind: added.kind }).toEqual({ stamped: 'computed', kind: null })
    expect(failingSites(differing)).toEqual([])
  })

  test('ONE unstamped return fails the site, wherever in the list it sits', () => {
    for (const shape of [
      'a composer that returns a stamped object on one branch and an unstamped one on another',
      'a composer whose unstamped return is not the last one',
    ]) {
      const doctored = `${SRC}\n${THIRTEENTH[shape]}\n`
      const added = terminalSites(doctored).find((s) => s.line > SRC_LINES)!
      expect({ shape, stamped: added.stamped }).toEqual({ shape, stamped: 'absent' })
      // The failure says how many of how many, so the reader knows it is a branch rather
      // than the whole composer.
      expect(failingSites(doctored)[0]).toContain('of')
      expect(failingSites(doctored).length).toBe(1)
    }
  })

  /**
   * THE OTHER TWO "FIRST INSTANCE" ANSWERS THE AUDIT FOUND, each with its own control —
   * both were fixed in the same change as the composer and both SURVIVED their first
   * mutation run, because a fix without a control is a fix nothing is holding.
   */
  test('a duplicated key reads LAST, which is what the runtime does', () => {
    // `{ a: 1, a: 2 }` is legal and evaluates to 2. Reading the first match reported a
    // value no runtime would ever produce.
    const dup = `${SRC}
async function newExitPath() {
  await writeTerminalResult({
    ok: false,
    checkpoint: 'new-exit',
    terminalCauseKind: 'workflow-threw',
    terminalCauseKind: 'ralph-task-built',
  })
}
`
    const added = terminalSites(dup).find((s) => s.line > SRC_LINES)!
    expect(added.kind).toBe('ralph-task-built')
  })

  test('a scope that binds one name TWICE is an ambiguity, not a first-one-wins', () => {
    // Legal with `var`. Taking whichever came first is a guess about which declaration the
    // use site means, and this scanner does not guess — it refuses, which fails loudly.
    const twice = `${SRC}
async function newExitPath() {
  var newExit = { ok: false, terminalCauseKind: 'workflow-threw' }
  var newExit = { ok: false, checkpoint: 'new-exit' }
  await writeTerminalResult(newExit)
}
`
    const added = terminalSites(twice).find((s) => s.line > SRC_LINES)!
    expect(added.stamped).toBe('unresolved')
    expect(failingSites(twice).length).toBe(1)
  })

  test('a return the scanner cannot read refuses the composer rather than judging it', () => {
    const doctored = `${SRC}\n${THIRTEENTH['a composer with a return the scanner cannot read']}\n`
    const added = terminalSites(doctored).find((s) => s.line > SRC_LINES)!
    expect(added.stamped).toBe('unresolved')
    expect(failingSites(doctored).length).toBe(1)
  })

  test('a composer resolved from the wrong scope is not this call\'s composer', () => {
    // Order-independent by construction: same-named declarations sit on both sides of the
    // real one, so a file-wide search is wrong whichever match it keeps.
    const doctored = `${SRC}\n${THIRTEENTH['a composer name shadowed by same-named declarations on both sides']}\n`
    const added = terminalSites(doctored).find((s) => s.line > SRC_LINES)!
    expect(added.stamped).toBe('absent')
    expect(failingSites(doctored).length).toBe(1)
  })

  test('a literal returned by a NESTED function is not the composer\'s result', () => {
    const doctored = `${SRC}\n${THIRTEENTH['a composer whose NESTED function returns the only stamped literal']}\n`
    const added = terminalSites(doctored).find((s) => s.line > SRC_LINES)!
    // The composer IS followed — so this is `absent` (its own return has no cause), not
    // `unresolved`. Reading the decoy would have made it `literal` and the guard silent.
    expect(added.stamped).toBe('absent')
    expect(failingSites(doctored).length).toBe(1)
  })

  test('POSITIVE CONTROL — the scan sees through the shared composer', () => {
    // Three of the twelve reach their cause through `mergedTerminalResult`, not through a
    // literal at the call site. A scanner that could not follow that would report three
    // false bares — or, later, three false CLEANS.
    const doctored = SRC.replace("    terminalCauseKind: 'pr-already-merged',\n", '')
    expect(doctored).not.toBe(SRC)
    expect(failingSites(doctored).length).toBe(3)
  })

  /**
   * THE MIRROR. `terminal-cause.ts` owns the vocabulary and the .mjs repeats it, because
   * a Workflow script cannot import TS — the same hand-mirroring `TERMINAL_CAUSE_MAX`
   * already has, and the same reason it needs a test: a drift is silent, and the .mjs
   * side is the one that WRITES the value while the .ts side is the one that DECODES it,
   * so a member added on one side only would be stamped and then decode to null.
   */
  test('the .mjs mirror of the vocabulary is the same list, in the same order', () => {
    const block = /const TERMINAL_CAUSE_KINDS = \[([\s\S]*?)\n\]/.exec(SRC)?.[1]
    expect(block).toBeDefined()
    const mirrored = [...block!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
    expect(mirrored).toEqual([...TERMINAL_CAUSES])
  })

  test("POSITIVE CONTROL — the mirror check sees a member the .ts side doesn't have", () => {
    const doctored = SRC.replace("  'unknown',\n]", "  'unknown',\n  'invented-cause',\n]")
    expect(doctored).not.toBe(SRC)
    const block = /const TERMINAL_CAUSE_KINDS = \[([\s\S]*?)\n\]/.exec(doctored)?.[1]
    const mirrored = [...block!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
    expect(mirrored).not.toEqual([...TERMINAL_CAUSES])
  })
})

/**
 * THE BACKSTOP, EXERCISED — `stampTerminalCause`, lifted out of the .mjs and run.
 *
 * The source scan above proves the twelve known paths name their exit. It cannot prove
 * anything about a result assembled where the scan cannot see it, and "a path it cannot
 * see" is exactly the shape of the drift the spec item records: every early exit added
 * since the initial commit landed in the catch-all one plausible commit at a time.
 *
 * SO THE RUNTIME REFUSES TO LET ONE TRAVEL BARE, and what it does instead is the tested
 * part. It stamps `'unknown'` — an answer, and the honest one — rather than throwing,
 * because throwing would trade a missing sentence for a LOST TERMINAL WRITE and leave the
 * run sitting `running` until the stall guard. And it SAYS SO on the run log, rather than
 * papering over the gap: `gateway-shutdown-kill.ts:774` makes the same choice for the
 * same reason, and that is the convention being followed rather than reinvented.
 */
describe('#520 — stampTerminalCause: a bare terminal result is answered, and said out loud', () => {
  interface Stamp {
    (result: Record<string, unknown> | null, report: (m: string) => void): unknown
  }
  /** Everything `stampTerminalCause` closes over, lifted from the SHIPPED source. Shared
   *  by the loader and the mutation below so the two cannot drift apart — the mutation
   *  once carried its own preamble and stopped compiling when the function gained a
   *  dependency, which reads as a failing guard rather than a stale test. */
  const preamble = (body: string): string =>
    [
      // STRICT, BECAUSE THE SHIPPED FILE IS. `new Function` bodies are SLOPPY by default,
      // and the difference is not cosmetic for this function: a write to a frozen or
      // write-refusing object silently no-ops in sloppy mode and THROWS in a module. Without
      // this line the frozen-result case passed here while the real code would have thrown —
      // a harness quietly kinder than production, which is a test that cannot see the bug it
      // is pointed at. Found by the Proxy round; it had been sloppy since the first extraction.
      "'use strict'",
      /const TERMINAL_CAUSE_KINDS = \[[\s\S]*?\n\]/.exec(SRC)![0],
      /const TERMINAL_CAUSE_DIAGNOSTIC_MAX = \d+/.exec(SRC)![0],
      braceMatchFrom(SRC, SRC.indexOf('function redactProbeText(')),
      braceMatchFrom(SRC, SRC.indexOf('function terminalCauseDiagnostic(')),
      braceMatchFrom(SRC, SRC.indexOf('function reportQuietly(')),
      body,
      'return stampTerminalCause',
    ].join('\n')
  const load = (): Stamp => {
    const at = SRC.indexOf('function stampTerminalCause(')
    expect(at).toBeGreaterThan(-1)
    return new Function(preamble(braceMatchFrom(SRC, at)))() as Stamp
  }

  test('a result that names a real kind is left alone, and nothing is reported', () => {
    const said: string[] = []
    const r = { checkpoint: 'argus-request-changes', terminalCauseKind: 'round-lost-work' }
    load()(r, (m) => said.push(m))
    expect(r.terminalCauseKind).toBe('round-lost-work')
    expect(said).toEqual([])
  })

  test("a result with NO kind is stamped 'unknown' AND reported", () => {
    const said: string[] = []
    const r: Record<string, unknown> = { checkpoint: 'forge-done' }
    load()(r, (m) => said.push(m))
    expect(r.terminalCauseKind).toBe('unknown')
    // The report names the checkpoint, because that is the one thing on a bare result
    // that says which path went out silent.
    expect(said.length).toBe(1)
    expect(said[0]).toContain('TERMINAL CAUSE MISSING')
    expect(said[0]).toContain('forge-done')
  })

  test('a kind OUTSIDE the vocabulary is also refused — and reported differently', () => {
    // Two different mistakes: one path forgot, the other invented a member. Neither may
    // travel, because `parseTerminalCause` decodes an invented kind to `null` and `null`
    // means "the field did not arrive" — so an invented kind reaching the row would be
    // indistinguishable from a legacy row that predates the field entirely.
    const said: string[] = []
    const r = { checkpoint: 'x', terminalCauseKind: 'round-lost' }
    load()(r, (m) => said.push(m))
    expect(r.terminalCauseKind).toBe('unknown')
    expect(said[0]).toContain('TERMINAL CAUSE UNRECOGNISED')
    expect(said[0]).toContain('round-lost')
  })

  test('MUTATION — with the stamp removed, a bare result travels bare and silently', () => {
    const at = SRC.indexOf('function stampTerminalCause(')
    const mutated = braceMatchFrom(SRC, at).replace("  result.terminalCauseKind = 'unknown'\n", '')
    expect(mutated).not.toBe(braceMatchFrom(SRC, at))
    const f = new Function(preamble(mutated))() as Stamp
    const r: Record<string, unknown> = { checkpoint: 'forge-done' }
    f(r, () => {})
    expect(r.terminalCauseKind).toBeUndefined()
  })

  test('a non-object is returned untouched rather than thrown over', () => {
    expect(() => load()(null, () => {})).not.toThrow()
  })

  /**
   * THE DIAGNOSTIC MAY NOT COST THE GUARANTEE IT IS DESCRIBING.
   *
   * `terminalCauseKind` arrives from a JSON payload the workflow did not author, so the
   * UNRECOGNISED branch interpolates an untrusted value into the run log. It used to do
   * that with a bare `String()`: no cap, no redaction, and — worse — a coercion that runs
   * user-reachable code. A value whose `toString` throws made `stampTerminalCause` itself
   * throw, which prevented the `writeTerminalResult` this backstop exists to protect. The
   * failure it was built to stop, arriving through the backstop.
   *
   * So the property under test is not "the log looks nice". It is: WHATEVER ARRIVES, the
   * stamp happens.
   */
  describe('the UNRECOGNISED diagnostic is capped, redacted, and cannot throw', () => {
    const stampOf = (kind: unknown): { stamped: unknown; said: string[] } => {
      const said: string[] = []
      const r: Record<string, unknown> = { checkpoint: 'forge-done', terminalCauseKind: kind }
      load()(r, (m) => said.push(m))
      return { stamped: r.terminalCauseKind, said }
    }

    test('a 10,000-character value is truncated, and says that it was', () => {
      const { stamped, said } = stampOf('x'.repeat(10_000))
      expect(stamped).toBe('unknown')
      expect(said[0]!.length).toBeLessThan(300)
      expect(said[0]).toContain('truncated')
      expect(said[0]).toContain('10000 chars')
    })

    test('a secret-shaped value is redacted before it reaches the log', () => {
      const { stamped, said } = stampOf('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
      expect(stamped).toBe('unknown')
      expect(said[0]).not.toContain('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
      expect(said[0]).toContain('ghp_***')
    })

    test('a credential embedded in a URL is redacted too', () => {
      const { said } = stampOf('https://user:s3cr3t@example.invalid/x')
      expect(said[0]).not.toContain('s3cr3t')
      expect(said[0]).toContain('***@')
    })

    test('a value whose coercion THROWS does not stop the stamp', () => {
      // The failure mode the bare `String()` had. The stamp is the guarantee; the
      // diagnostic is a courtesy, and a courtesy may not take the guarantee down with it.
      const hostile = {
        toString() {
          throw new Error('boom')
        },
      }
      let out: { stamped: unknown; said: string[] } | null = null
      expect(() => {
        out = stampOf(hostile)
      }).not.toThrow()
      expect(out!.stamped).toBe('unknown')
      expect(out!.said[0]).toContain('conversion to text threw')
    })

    test('a symbol does not throw either — a template literal would have', () => {
      const { stamped, said } = stampOf(Symbol('nope'))
      expect(stamped).toBe('unknown')
      expect(said[0]).toContain('Symbol(nope)')
    })

    test('a logger that throws does not cost the field its value', () => {
      // Reporting is best-effort. `report` raising — an EPIPE on a closed stdout is the
      // realistic one — must not unwind through the stamp.
      const r: Record<string, unknown> = { checkpoint: 'forge-done', terminalCauseKind: 'made-up' }
      expect(() => {
        load()(r, () => {
          throw new Error('EPIPE')
        })
      }).not.toThrow()
      expect(r.terminalCauseKind).toBe('unknown')
    })

    /**
     * THE HAZARD THE DIAGNOSTIC'S OWN COMMENT NAMED AND THE CODE DID NOT HANDLE.
     *
     * A Proxy can throw from `get`, `set`, `getPrototypeOf` and `ownKeys`. The coercion
     * hardening covered `toString`/`Symbol.toPrimitive` — the CASE that was reported — and
     * left the first property READ in `stampTerminalCause` unprotected, ahead of
     * everything, so the guarantee started one line after the throw.
     *
     * The contract is now closed rather than widened: the accepted value is a plain record,
     * and one that resists being read or written is REPORTED and left alone. For a plain
     * record the stamp always happens; for anything else no implementation could stamp it,
     * because the write is precisely what it refuses.
     */
    test('a value whose property READ throws does not take the function down', () => {
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error('boom')
          },
        },
      )
      const said: string[] = []
      expect(() => load()(hostile as Record<string, unknown>, (m) => said.push(m))).not.toThrow()
      // Not stamped — and it says so, rather than reporting a success it did not have.
      expect(said[0]).toContain('UNSTAMPABLE')
      expect(said[0]).toContain('not a plain record')
    })

    test('a value whose property WRITE throws does not take the function down either', () => {
      const hostile = new Proxy(
        { terminalCauseKind: 'made-up' },
        {
          set() {
            throw new Error('nope')
          },
        },
      )
      const said: string[] = []
      expect(() => load()(hostile as Record<string, unknown>, (m) => said.push(m))).not.toThrow()
      expect(said[0]).toContain('UNSTAMPABLE')
    })

    test('a FROZEN result is the same class of refusal, and is reported as one', () => {
      // The realistic instance of the hostile case: strict mode makes the write throw.
      const frozen = Object.freeze({ checkpoint: 'forge-done', terminalCauseKind: 'made-up' })
      const said: string[] = []
      expect(() => load()(frozen as Record<string, unknown>, (m) => said.push(m))).not.toThrow()
      expect(said[0]).toContain('UNSTAMPABLE')
    })

    test('a read that throws only AFTER the stamp keeps the stamp, and says which half got through', () => {
      // `checkpoint` is read for the diagnostic, after the field has been written. The two
      // outcomes are different facts — "no cause could be recorded" and "a cause was
      // recorded but could not be described" — and they do not share a branch.
      const target: Record<string, unknown> = { terminalCauseKind: 'made-up' }
      const hostile = new Proxy(target, {
        get(t, k, r) {
          if (k === 'checkpoint') throw new Error('boom')
          return Reflect.get(t, k, r)
        },
      })
      const said: string[] = []
      expect(() => load()(hostile as Record<string, unknown>, (m) => said.push(m))).not.toThrow()
      expect(target.terminalCauseKind).toBe('unknown')
      expect(said[0]).toContain('could not be composed')
      expect(said[0]).not.toContain('UNSTAMPABLE')
    })

    test('THE ORDERING the diagnostic docblock claims — the stamp precedes every diagnostic', () => {
      // Asserted, because this sentence has been written down twice before it was true. The
      // probe throws on the SECOND read (`checkpoint`), so the field can only be set if the
      // write happened before that call.
      const target: Record<string, unknown> = { terminalCauseKind: 'made-up' }
      let reads = 0
      const hostile = new Proxy(target, {
        get(t, k, r) {
          reads += 1
          if (reads > 1) throw new Error('no more reads')
          return Reflect.get(t, k, r)
        },
      })
      load()(hostile as Record<string, unknown>, () => {})
      expect(target.terminalCauseKind).toBe('unknown')
    })

    test('a hostile CHECKPOINT is handled the same way on the MISSING branch', () => {
      // The other interpolation. Same value class, same treatment — asserted separately
      // because it is a different branch and a fix to one is not a fix to the other.
      const r: Record<string, unknown> = {
        checkpoint: {
          toString() {
            throw new Error('boom')
          },
        },
      }
      const said: string[] = []
      expect(() => load()(r, (m: string) => said.push(m))).not.toThrow()
      expect(r.terminalCauseKind).toBe('unknown')
      expect(said[0]).toContain('TERMINAL CAUSE MISSING')
    })
  })
})

/**
 * THE REVIEW LOOP'S OWN EXIT, EXERCISED — the function that turns the loop's guard
 * variables into a cause, lifted out of the .mjs and run.
 *
 * THIS IS THE PART THAT COULD BE AN INFERENCE AND IS NOT. Two Codex review rounds killed
 * two attempts to deduce a cause from `(round, checkpoint)`, and the reason they were
 * right is that those two values are equally consistent with four different endings. The
 * inputs below are different in kind: they are the conditions in the `while (...)` head
 * and the two `break`s inside it, read at the moment the loop stopped. A test that only
 * confirmed the happy arms would not show that, so every arm is exercised INCLUDING the
 * fall-through, which is the one that proves the function can decline to answer.
 */
describe('#520 — reviewLoopTerminalCause: the exit is measured, and may be undecidable', () => {
  interface Exit {
    finalVerdict: string | null
    round: number
    maxRounds: number
    blockKind: string | null | undefined
    roundLostItsWork: unknown
    roundLostItsDiff: unknown
    escalation: unknown
  }
  const load = (): ((e: Exit) => string) => {
    const at = SRC.indexOf('function reviewLoopTerminalCause(')
    expect(at).toBeGreaterThan(-1)
    const body = braceMatchFrom(SRC, at)
    return new Function(`${body}\nreturn reviewLoopTerminalCause`)() as (e: Exit) => string
  }
  const exit = (over: Partial<Exit>): Exit => ({
    finalVerdict: 'REQUEST_CHANGES',
    round: 10,
    maxRounds: 10,
    blockKind: 'code',
    roundLostItsWork: null,
    roundLostItsDiff: null,
    escalation: null,
    ...over,
  })

  test("an APPROVE is 'review-approved'", () => {
    expect(load()(exit({ finalVerdict: 'APPROVE', blockKind: 'none' }))).toBe('review-approved')
  })

  test("a full budget with blocking findings is 'round-budget-exhausted' — the ONE true exhaustion", () => {
    expect(load()(exit({}))).toBe('round-budget-exhausted')
  })

  test("a lost round outranks the budget, because the budget did not end it", () => {
    // The break fires at round 2 of 10 — nothing ran out. If the budget arm were read
    // first this would read as exhaustion, which is the original defect's exact shape.
    const f = load()
    expect(f(exit({ round: 2, roundLostItsWork: { round: 2, head: 'abc' } }))).toBe('round-lost-work')
    expect(f(exit({ round: 2, roundLostItsDiff: 2 }))).toBe('round-lost-no-diff')
    // …and it outranks it AT the ceiling too, which is where the two can be confused.
    expect(f(exit({ round: 10, roundLostItsDiff: 10 }))).toBe('round-lost-no-diff')
  })

  /**
   * THE CLAUSE #654 ADDED, AND THE REASON THIS ARM EXISTS.
   *
   * `escalation === null` is the FIRST clause of the fix loop's `while` head, so an
   * escalation is a genuine terminal exit — and this function did not read it when #654
   * landed. An escalated run therefore reported `'unknown'`, which is this vocabulary's
   * word for "could not be established" about an exit sitting in a variable three lines
   * above the call. Saying "I cannot tell" when you CAN is the same defect as saying
   * something determinate when you cannot: both put a false value on the honest branch.
   */
  test("an escalation is its own exit, not 'unknown'", () => {
    const f = load()
    expect(f(exit({ round: 3, escalation: { kind: 'plan-wrong', round: 3 } }))).toBe('review-escalated')
    // BELOW the ceiling, which is the case that would otherwise fall through every arm.
    expect(f(exit({ round: 3 }))).toBe('unknown')
  })

  test('an escalation is read BEFORE the verdict, which it has already rewritten', () => {
    // `if (escalation !== null && finalVerdict === 'APPROVE') finalVerdict = 'REQUEST_CHANGES'`
    // runs just above the call, so by the time this function sees it an escalated run is
    // indistinguishable from an ordinary rejection by verdict alone.
    const f = load()
    expect(f(exit({ round: 10, escalation: { kind: 'plan-wrong', round: 3 } }))).toBe('review-escalated')
    // …and a lost round still outranks it: the break fires before that round's review
    // could declare anything.
    expect(f(exit({ round: 4, escalation: { kind: 'plan-wrong', round: 3 }, roundLostItsDiff: 4 }))).toBe(
      'round-lost-no-diff',
    )
  })

  test('MUTATION — without the escalation arm, a real escalation reports "could not establish"', () => {
    const at = SRC.indexOf('function reviewLoopTerminalCause(')
    const mutated = braceMatchFrom(SRC, at).replace(
      "  if (exit.escalation !== null && exit.escalation !== undefined) return 'review-escalated'",
      '',
    )
    const f = new Function(`${mutated}\nreturn reviewLoopTerminalCause`)() as (e: Exit) => string
    expect(f(exit({ round: 3, escalation: { kind: 'plan-wrong', round: 3 } }))).toBe('unknown')
    expect(load()(exit({ round: 3, escalation: { kind: 'plan-wrong', round: 3 } }))).toBe('review-escalated')
  })

  test('the two block kinds that exit the loop are told apart', () => {
    const f = load()
    expect(f(exit({ round: 1, blockKind: 'infra-only' }))).toBe('review-infra-only')
    expect(f(exit({ round: 1, blockKind: 'advisory-only' }))).toBe('review-advisory-only')
  })

  test('a REQUEST_CHANGES below the ceiling with no other reason is UNKNOWN, not a guess', () => {
    // Unreachable through the loop as written — which is exactly why it is here. The
    // honest answer to "the loop stopped and none of my conditions explain it" is that
    // it cannot be established, and `'unknown'` is a member of the vocabulary so that
    // this arm has somewhere truthful to go. A nearest-plausible-member default here
    // would reintroduce the whole defect by the back door.
    expect(load()(exit({ round: 3, maxRounds: 10, blockKind: 'code' }))).toBe('unknown')
  })

  test('a garbled verdict is UNKNOWN too — it is not quietly read as a rejection', () => {
    expect(load()(exit({ finalVerdict: null, round: 10, blockKind: 'code' }))).toBe('unknown')
  })

  test('MUTATION — dropping the budget guard turns a real exhaustion into unknown', () => {
    // The guard under test is `round >= maxRounds`. With it removed the one exit this
    // whole card was raised about stops being nameable, which is what makes the guard
    // load-bearing rather than decorative.
    const at = SRC.indexOf('function reviewLoopTerminalCause(')
    const mutated = braceMatchFrom(SRC, at).replace(
      "if (exit.finalVerdict === 'REQUEST_CHANGES' && exit.round >= exit.maxRounds) return 'round-budget-exhausted'",
      '',
    )
    const f = new Function(`${mutated}\nreturn reviewLoopTerminalCause`)() as (e: Exit) => string
    expect(f(exit({}))).toBe('unknown')
    expect(load()(exit({}))).toBe('round-budget-exhausted')
  })
})
